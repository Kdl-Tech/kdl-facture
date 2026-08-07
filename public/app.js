'use strict';

/* KDL Facture — l'interface.
   Le principe : l'application ouvre sur un brief, pas sur un tableau vide.
   Elle dit ce qui compte ce soir, propose de le régler, puis s'efface. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const eur = (v) => `${Number(v || 0).toFixed(2).replace('.', ',')} €`;
const jour = (iso) => (iso ? String(iso).split('-').reverse().join('/') : '—');
const aujourdhui = () => new Date().toISOString().slice(0, 10);
const echapper = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let etat = { entreprise: null, clients: [], articles: [], filtre: '', territoires: null };

/* ─── Réseau ─── */
async function api(chemin, options = {}) {
  const r = await fetch(`/api${chemin}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const type = r.headers.get('content-type') || '';
  const donnees = type.includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    const e = new Error(donnees.erreur || 'Erreur');
    e.anomalies = donnees.anomalies || [];
    throw e;
  }
  return donnees;
}

function noter(message, genre = '') {
  const n = document.createElement('div');
  n.className = `note ${genre}`;
  n.textContent = message;
  $('#notes').append(n);
  setTimeout(() => n.remove(), 5200);
}

/* ─── Navigation ─── */
function aller(vue) {
  $$('.vue').forEach((v) => v.classList.toggle('active', v.id === `vue-${vue}`));
  $$('.onglet').forEach((o) => o.classList.toggle('actif', o.dataset.vue === vue));
  const chargeurs = {
    brief: chargerBrief, documents: chargerDocuments, clients: chargerClients,
    articles: chargerArticles, entreprise: chargerEntreprise, journal: chargerJournal,
    references: chargerReferences, edition: chargerEdition,
  };
  (chargeurs[vue] || (() => {}))();
}

/* ─── Brief ─── */
function salutation() {
  const h = new Date().getHours();
  if (h < 6) return 'Bonne nuit.';
  if (h < 12) return 'Bonjour.';
  if (h < 18) return 'Bon après-midi.';
  return 'Bonsoir.';
}

async function chargerBrief() {
  const d = await api('/tableau-de-bord');
  $('#brief-date').textContent = new Date().toLocaleDateString('fr-FR',
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('#brief-titre').textContent = salutation();

  if (d.entreprise_absente) {
    ecrire($('#brief-texte'), "Avant tout, il me faut votre entreprise : nom, SIREN, adresse. C'est ce qui figure sur chaque facture et dans le fichier que lira votre client.");
    $('#compteurs').innerHTML = '';
    $('#pile-actions').innerHTML = `<div class="carte k-ambre"><div class="corps"><div class="titre">Votre entreprise n'est pas renseignée</div><div class="detail">Rien ne peut être facturé tant que ces informations manquent.</div></div><div class="actions"><button class="bouton primaire" data-vue="entreprise">Renseigner</button></div></div>`;
    $('#orbe-zone').hidden = true;
    return;
  }

  const { stats, impayes, brouillons } = d;
  etat.entreprise = d.entreprise;
  const phrases = [];
  if (impayes.length) {
    const total = impayes.reduce((s, i) => s + i.reste_du, 0);
    phrases.push(`<span class="fort">${impayes.length} facture${impayes.length > 1 ? 's' : ''} en retard</span> pour ${eur(total)}`);
  }
  if (brouillons.length) {
    phrases.push(`<span class="fort">${brouillons.length} brouillon${brouillons.length > 1 ? 's' : ''}</span> qui n'${brouillons.length > 1 ? 'ont' : 'a'} pas encore été émis`);
  }
  if (stats.reste_du > 0) phrases.push(`${eur(stats.reste_du)} attendus au total`);

  const texte = phrases.length
    ? `Ce soir : ${phrases.join(', ')}. ${impayes.length ? 'Je vous propose de commencer par les retards.' : 'Rien d’urgent.'}`
    : `Tout est à jour : aucune facture en retard, aucun brouillon en attente. ${stats.emises ? `${stats.emises} facture${stats.emises > 1 ? 's' : ''} émise${stats.emises > 1 ? 's' : ''} à ce jour.` : 'Prêt à facturer.'}`;
  ecrire($('#brief-texte'), texte, true);

  const franchise = d.entreprise.regime_tva === 'franchise';
  const f = d.franchise;

  // Un seul compteur d'encaissement, pas deux. En franchise, celui qui compte
  // est l'encaissé de l'année civile — c'est lui qui sert à l'URSSAF et au
  // suivi du plafond ; le cumul de tous les temps n'apprend rien.
  const encaisse = f
    ? {
      v: eur(f.encaisse),
      e: f.renseigne
        ? `Encaissé en ${f.annee} — ${f.pourcentage} % du plafond`
        : `Encaissé en ${f.annee}`,
      c: f.alerte === 'depasse' ? 'c-rouge' : (f.alerte === 'proche' ? 'c-ambre' : 'c-vert'),
    }
    : { v: eur(stats.encaisse), e: 'Encaissé', c: 'c-vert' };

  const compteurs = [
    encaisse,
    { v: eur(stats.chiffre_affaires_ttc), e: franchise ? 'Facturé' : 'Facturé TTC', c: '' },
    { v: eur(stats.reste_du), e: 'Reste à encaisser', c: stats.reste_du > 0 ? 'c-ambre' : '' },
    { v: eur(stats.en_retard), e: 'En retard', c: stats.en_retard > 0 ? 'c-rouge' : '' },
  ];
  $('#compteurs').innerHTML = compteurs
    .map((c) => `<div class="compteur ${c.c}"><div class="valeur">${c.v}</div><div class="etiquette">${c.e}</div></div>`).join('');

  const cartes = [];
  for (const i of impayes.slice(0, 4)) {
    const retard = Math.round((Date.now() - new Date(`${i.date_echeance}T12:00:00`)) / 86400000);
    cartes.push(`<div class="carte k-rouge">
      <span class="badge b-rouge">${retard} j</span>
      <div class="corps">
        <div class="titre">${echapper(i.client_nom)} — ${eur(i.reste_du)}</div>
        <div class="detail">Facture ${echapper(i.numero)}, échue le ${jour(i.date_echeance)}</div>
      </div>
      <div class="actions">
        <button class="bouton" data-ouvrir="${i.id}">Ouvrir</button>
        <button class="bouton primaire" data-encaisser="${i.id}" data-montant="${i.reste_du}">Encaisser</button>
      </div></div>`);
  }
  for (const b of brouillons.slice(0, 3)) {
    cartes.push(`<div class="carte k-ambre">
      <span class="badge b-ambre">brouillon</span>
      <div class="corps">
        <div class="titre">${echapper(b.client_nom)}</div>
        <div class="detail">Créé le ${jour(b.date_emission)} — pas encore émis</div>
      </div>
      <div class="actions"><button class="bouton" data-ouvrir="${b.id}">Reprendre</button></div></div>`);
  }
  if (d.franchise && d.franchise.alerte) {
    const f = d.franchise;
    cartes.unshift(f.alerte === 'depasse'
      ? `<div class="carte k-rouge"><span class="badge b-rouge">plafond dépassé</span>
        <div class="corps"><div class="titre">Vous avez dépassé le plafond de franchise de TVA</div>
        <div class="detail">${eur(f.encaisse)} encaissés en ${f.annee}, pour un plafond de ${eur(f.seuil)}. La TVA devient exigible — rapprochez-vous de votre comptable ou du service des impôts.</div></div>
        <div class="actions"><button class="bouton" data-vue="entreprise">Réglages</button></div></div>`
      : `<div class="carte k-ambre"><span class="badge b-ambre">${f.pourcentage} % du plafond</span>
        <div class="corps"><div class="titre">Vous approchez du plafond de franchise de TVA</div>
        <div class="detail">${eur(f.encaisse)} encaissés en ${f.annee}. Il reste ${eur(f.restant)} avant de devoir facturer la TVA.</div></div>
        <div class="actions"><button class="bouton" data-vue="entreprise">Réglages</button></div></div>`);
  }
  if (!d.journal.intact) {
    cartes.unshift(`<div class="carte k-rouge"><span class="badge b-rouge">alerte</span>
      <div class="corps"><div class="titre">Le journal a été modifié</div>
      <div class="detail">La chaîne est rompue à la ligne ${d.journal.rompu_a}. Vos écritures ne sont plus prouvables.</div></div>
      <div class="actions"><button class="bouton" data-vue="journal">Examiner</button></div></div>`);
  }
  $('#pile-actions').innerHTML = cartes.join('');
  $('#orbe-zone').hidden = cartes.length > 0;
}

/** Le brief s'écrit, il ne s'affiche pas d'un bloc : on a le temps de le lire. */
function ecrire(cible, texte, html = false) {
  cible.innerHTML = '';
  const curseur = document.createElement('span');
  curseur.className = 'curseur';
  cible.append(curseur);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    cible.innerHTML = html ? texte : echapper(texte);
    return;
  }
  const morceaux = texte.split(/(<[^>]+>)/);
  let i = 0; let tampon = '';
  const suite = () => {
    if (i >= morceaux.length) { curseur.remove(); return; }
    const m = morceaux[i];
    if (m.startsWith('<')) { tampon += m; i += 1; return suite(); }
    let j = 0;
    const taper = () => {
      if (j >= m.length) { i += 1; return suite(); }
      tampon += m[j]; j += 1;
      cible.innerHTML = tampon;
      cible.append(curseur);
      return setTimeout(taper, 9);
    };
    return taper();
  };
  suite();
}

/* ─── Documents ─── */
async function chargerDocuments() {
  const docs = await api(`/documents${etat.filtre ? `?statut=${etat.filtre}` : ''}`);
  const t = $('#table-documents');
  if (!docs.length) {
    t.innerHTML = `<tr><td class="vide">Aucun document. Créez votre première facture.</td></tr>`;
    return;
  }
  t.innerHTML = `<thead><tr>
      <th>Numéro</th><th>Client</th><th>Date</th><th>Échéance</th>
      <th class="num">Total TTC</th><th>État</th><th></th>
    </tr></thead><tbody>${docs.map((d) => {
      const enRetard = d.statut !== 'paye' && d.date_echeance && d.date_echeance < aujourdhui();
      const etats = {
        brouillon: '<span class="badge b-gris">brouillon</span>',
        emis: enRetard ? '<span class="badge b-rouge">en retard</span>' : '<span class="badge b-cyan">à encaisser</span>',
        envoye: '<span class="badge b-cyan">envoyée</span>',
        paye: '<span class="badge b-vert">payée</span>',
        annule: '<span class="badge b-gris">annulée</span>',
      };
      return `<tr>
        <td><strong>${echapper(d.numero || '—')}</strong>${d.type !== 'facture' ? ` <span class="badge b-gris">${d.type}</span>` : ''}</td>
        <td>${echapper(d.client_nom)}</td>
        <td>${jour(d.date_emission)}</td>
        <td>${jour(d.date_echeance)}</td>
        <td class="num">${eur(d.total_ttc ?? 0)}</td>
        <td>${etats[d.statut] || d.statut}</td>
        <td class="actions-cellule">
          <button class="bouton discret" data-ouvrir="${d.id}">Ouvrir</button>
          ${d.numero ? `<button class="bouton discret" data-pdf="${d.id}">PDF</button>` : ''}
        </td></tr>`;
    }).join('')}</tbody>`;

  // Les totaux ne sont pas dans la liste : on les complète sans bloquer l'affichage.
  for (const d of docs) {
    api(`/documents/${d.id}`).then((c) => {
      const cellule = t.querySelector(`[data-ouvrir="${d.id}"]`)?.closest('tr')?.children[4];
      if (cellule) cellule.textContent = eur(c.totaux.total_ttc);
    }).catch(() => {});
  }
}

/* ─── Clients ─── */
async function chargerClients() {
  etat.clients = await api('/clients');
  const t = $('#table-clients');
  if (!etat.clients.length) {
    t.innerHTML = `<tr><td class="vide">Aucun client pour l'instant.</td></tr>`;
    return;
  }
  t.innerHTML = `<thead><tr><th>Nom</th><th>Type</th><th>SIRET</th><th>Ville</th><th>Délai</th><th></th></tr></thead>
    <tbody>${etat.clients.map((c) => `<tr>
      <td><strong>${echapper(c.nom)}</strong>${c.contact ? `<br><span class="detail">${echapper(c.contact)}</span>` : ''}</td>
      <td><span class="badge b-gris">${c.type}</span></td>
      <td>${echapper(c.siret || c.siren || '—')}</td>
      <td>${echapper(c.ville || '—')}</td>
      <td>${c.delai_paiement_jours} j</td>
      <td class="actions-cellule">
        <button class="bouton discret" data-client="${c.id}">Modifier</button>
        <button class="bouton discret" data-facturer="${c.id}">Facturer</button>
      </td></tr>`).join('')}</tbody>`;
}

/* ─── Articles ─── */
async function chargerArticles() {
  etat.articles = await api('/articles');
  const t = $('#table-articles');
  if (!etat.articles.length) {
    t.innerHTML = `<tr><td class="vide">Le catalogue est vide. Ajoutez vos prestations habituelles : elles se saisiront en un clic.</td></tr>`;
    return;
  }
  t.innerHTML = `<thead><tr><th>Désignation</th><th>Réf.</th><th>Unité</th><th class="num">Prix HT</th><th class="num">TVA</th><th></th></tr></thead>
    <tbody>${etat.articles.map((a) => `<tr>
      <td><strong>${echapper(a.designation)}</strong></td>
      <td>${echapper(a.reference || '—')}</td>
      <td>${echapper(a.unite)}</td>
      <td class="num">${eur(a.prix_ht)}</td>
      <td class="num">${a.tva_taux} %</td>
      <td class="actions-cellule"><button class="bouton discret danger" data-suppr-article="${a.id}">Retirer</button></td>
    </tr>`).join('')}</tbody>`;
}

/* ─── Entreprise ─── */
async function chargerEntreprise() {
  const e = await api('/entreprise');
  etat.entreprise = e;
  const champ = (nom, libelle, valeur, options = {}) => `
    <div class="champ ${options.large ? 'large' : ''}">
      <label for="e-${nom}">${libelle}</label>
      ${options.choix
        ? `<select id="e-${nom}" name="${nom}">${options.choix.map(([v, t]) =>
            `<option value="${v}" ${String(valeur) === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`
        : `<input id="e-${nom}" name="${nom}" value="${echapper(valeur ?? '')}" ${options.type ? `type="${options.type}"` : ''} ${options.placeholder ? `placeholder="${options.placeholder}"` : ''}>`}
      ${options.indice ? `<span class="indice">${options.indice}</span>` : ''}
    </div>`;

  const enFranchise = (e.regime_tva || 'franchise') === 'franchise';
  if (!etat.territoires) etat.territoires = await api('/territoires');
  const zones = etat.territoires.liste;
  const zoneActuelle = e.territoire || 'metropole';
  const suggestion = etat.territoires.suggestion;
  const dep = etat.territoires.departement;
  const zoneDetail = zones.find((z) => z.cle === zoneActuelle);
  const groupes = [...zones.reduce((carte, z) => {
    if (!carte.has(z.groupe)) carte.set(z.groupe, []);
    carte.get(z.groupe).push(z);
    return carte;
  }, new Map())];
  $('#bandeau-regime').innerHTML = `
    <div class="regime">
      <div class="regime-question">
        <strong>Où votre entreprise est-elle établie</strong>
        <span>La TVA n'est pas la même partout en France : 8,5 % aux Antilles et à La Réunion, 20 % en métropole, et pas de TVA du tout en Guyane ni à Mayotte.</span>
      </div>
      ${dep ? `<p class="indice">D'après votre code postal : <strong>${echapper(dep.nom)} (${echapper(dep.code)})</strong>${suggestion !== zoneActuelle ? ` — territoire fiscal <strong>${echapper((zones.find((z) => z.cle === suggestion) || {}).nom || suggestion)}</strong>, <button type="button" class="lien-inline" data-territoire="${suggestion}">appliquer</button>` : ''}</p>` : ''}
      ${groupes.map(([groupe, membres]) => `
        <div class="zone-groupe">
          <h3 class="zone-titre">${echapper(groupe)}</h3>
          <div class="zone-grille">
            ${membres.map((z) => `
              <button type="button" class="zone-carte ${z.cle === zoneActuelle ? 'actif' : ''}" data-territoire="${z.cle}">
                <span class="zone-nom">${echapper(z.nom)}</span>
                <span class="zone-taux ${z.tva ? '' : 'sans'}">${z.tva ? `${String(z.taux_normal).replace('.', ',')} % · ${z.taux.map((x) => String(x).replace('.', ',')).join(' / ')}` : 'TVA non applicable'}</span>
              </button>`).join('')}
          </div>
        </div>`).join('')}
      ${zoneDetail ? `
        <div class="zone-fiche">
          <div class="zone-fiche-tete"><strong>${echapper(zoneDetail.nom)}</strong><span class="badge b-gris">${echapper(zoneDetail.base)}</span></div>
          ${zoneDetail.impose.length ? `<div class="zone-liste"><span class="zone-liste-titre">Ce que ce territoire impose</span><ul>${zoneDetail.impose.map((x) => `<li>${echapper(x)}</li>`).join('')}</ul></div>` : ''}
          ${zoneDetail.permet.length ? `<div class="zone-liste"><span class="zone-liste-titre">Ce qu'il permet</span><ul>${zoneDetail.permet.map((x) => `<li>${echapper(x)}</li>`).join('')}</ul></div>` : ''}
        </div>` : ''}
    </div>

    <div class="regime">
      <div class="regime-question">
        <strong>Votre régime de TVA</strong>
        <span>Il commande tout le reste : ce qui s'affiche sur vos factures, les mentions légales, et les totaux.</span>
      </div>
      <div class="regime-choix">
        <button type="button" class="regime-carte ${enFranchise ? 'actif' : ''}" data-regime="franchise">
          <span class="regime-titre">Je ne facture pas la TVA</span>
          <span class="regime-detail">Micro-entreprise, auto-entrepreneur, franchise en base — article 293 B du CGI. Vos factures ne portent aucune TVA.</span>
        </button>
        <button type="button" class="regime-carte ${enFranchise ? '' : 'actif'}" data-regime="normal">
          <span class="regime-titre">Je facture la TVA</span>
          <span class="regime-detail">Société ou entreprise assujettie. Chaque ligne porte son taux, la ventilation apparaît sur la facture.</span>
        </button>
      </div>
    </div>`;

  $('#form-entreprise').innerHTML = [
    champ('nom', 'Nom de l’entreprise', e.nom),
    champ('forme_juridique', 'Forme juridique', e.forme_juridique, { placeholder: 'EI, SASU, SARL…' }),
    champ('siren', 'SIREN', e.siren, { indice: '9 chiffres — obligatoire' }),
    champ('siret', 'SIRET', e.siret, { indice: '14 chiffres' }),
    champ('tva_intra', 'N° TVA intracommunautaire', e.tva_intra),
    champ('rcs', 'RCS', e.rcs),
    champ('adresse', 'Adresse', e.adresse, { large: true }),
    champ('code_postal', 'Code postal', e.code_postal),
    champ('ville', 'Ville', e.ville),
    champ('email', 'Courriel', e.email, { type: 'email' }),
    champ('telephone', 'Téléphone', e.telephone),
    champ('iban', 'IBAN', e.iban, { indice: 'Figure sur la facture pour le virement' }),
    champ('bic', 'BIC', e.bic),
    `<input type="hidden" name="regime_tva" id="e-regime_tva" value="${enFranchise ? 'franchise' : 'normal'}">`,
    `<input type="hidden" name="territoire" id="e-territoire" value="${echapper(zoneActuelle)}">`,
    enFranchise
      ? champ('seuil_franchise', 'Plafond de franchise (€)', e.seuil_franchise || '', {
        type: 'number',
        indice: 'Le montant change avec les lois de finances — voir l’onglet Références. Laissez vide pour ne pas suivre.',
      })
      : champ('tva_taux_defaut', 'Taux de TVA habituel', String(e.tva_taux_defaut ?? 20), {
        choix: (zones.find((z) => z.cle === zoneActuelle) || { taux: [20] }).taux
          .map((taux) => [String(taux), `${String(taux).replace('.', ',')} %`]),
        indice: 'Proposé sur chaque nouvelle ligne — modifiable ligne par ligne',
      }),
    champ('activite', 'Nature de l’activité', e.activite, {
      choix: [['services', 'Prestations de services'], ['vente', 'Vente de marchandises'], ['mixte', 'Les deux']],
    }),
    champ('assurance_pro', 'Assurance professionnelle', e.assurance_pro, {
      large: true,
      indice: 'Assureur et n° de contrat — obligatoire pour une activité réglementée',
    }),
    champ('tva_sur_debits', 'TVA d’après les débits', String(e.tva_sur_debits || 0), {
      choix: [['0', 'Non'], ['1', 'Oui — mention ajoutée']],
    }),
    champ('penalites_taux', 'Taux de pénalités de retard (%)', e.penalites_taux ?? 10, { type: 'number' }),
    champ('escompte', 'Mention d’escompte', e.escompte, { large: true }),
    `<div class="champ large"><button class="bouton primaire" type="submit">Enregistrer</button></div>`,
  ].join('');
}

/* ─── Éditions ─── */
async function chargerEdition() {
  const e = await api('/edition');
  const pro = e.edition === 'pro';
  const bouton = $('#btn-edition');
  if (bouton) bouton.textContent = `Édition ${e.nom}`;

  $('#edition-etat').innerHTML = pro
    ? `<div class="carte k-vert"><span class="badge b-vert">Pro</span>
        <div class="corps"><div class="titre">Édition Pro active</div>
        <div class="detail">Licence au nom de ${echapper(e.titulaire)}. Factures illimitées, catalogue, devis, export comptable et suivi du plafond.</div></div>
        <div class="actions"><button class="bouton discret" id="btn-retirer-licence">Retirer la licence</button></div></div>`
    : `<div class="carte k-ambre"><span class="badge b-ambre">Découverte</span>
        <div class="corps"><div class="titre">Édition Découverte — ${e.factures_cette_annee} facture(s) sur ${e.plafond} cette année</div>
        <div class="detail">${e.refus ? `${echapper(e.refus)} ` : ''}Vos factures sont pleinement conformes : Factur-X, journal inaltérable et avoirs sont inclus, sans filigrane ni limite de validité.</div></div></div>`;

  const ligne = (ok, texte) => `<li class="${ok ? 'oui' : 'non'}">${echapper(texte)}</li>`;
  $('#edition-offres').innerHTML = `
    <div class="offres">
      <div class="offre ${pro ? '' : 'actuelle'}">
        <div class="offre-tete"><strong>Découverte</strong><span class="offre-prix">Gratuit</span></div>
        <ul class="offre-liste">
          ${ligne(true, 'Factures électroniques Factur-X, entièrement conformes')}
          ${ligne(true, 'Journal inaltérable et avoirs')}
          ${ligne(true, 'Tous les territoires et régimes de TVA')}
          ${ligne(true, '15 factures par année civile')}
          ${ligne(false, 'Catalogue de prestations, devis, acomptes')}
          ${ligne(false, 'Export comptable et suivi du plafond')}
        </ul>
      </div>
      <div class="offre ${pro ? 'actuelle' : 'phare'}">
        <div class="offre-tete"><strong>Pro</strong><span class="offre-prix">49 € <small>une fois</small></span></div>
        <ul class="offre-liste">
          ${ligne(true, 'Tout ce que fait Découverte')}
          ${ligne(true, 'Factures illimitées')}
          ${ligne(true, 'Catalogue de prestations, devis, acomptes')}
          ${ligne(true, 'Export comptable et suivi du plafond de franchise')}
          ${ligne(true, 'Plusieurs entreprises dans la même base')}
          ${ligne(true, 'Mises à jour de conformité incluses')}
        </ul>
        ${pro ? '' : `
        <form id="form-licence" class="offre-form">
          <div class="champ"><label>Votre courriel (titulaire de la licence)</label><input name="titulaire" type="email" required></div>
          <div class="champ"><label>Clé de licence</label><input name="cle" placeholder="PRO-XXXXX-XXXXX-XXXXX-XXXXX" required></div>
          <button class="bouton primaire" type="submit">Activer</button>
        </form>`}
      </div>
    </div>
    <p class="aide" style="margin-top:16px">Licence perpétuelle, sans abonnement : elle vaut pour cette machine et ne demande aucune connexion. Vos données vous appartiennent — elles restent dans un fichier que vous pouvez copier, sauvegarder et emporter.</p>`;
}

/* ─── Références officielles ───
   Un logiciel de facturation applique des règles qui ne lui appartiennent pas.
   Autant dire d'où elles viennent, et laisser vérifier. */
const REFERENCES = [
  {
    theme: 'La réforme de la facturation électronique',
    liens: [
      {
        titre: 'La facturation électronique — ce que ça change pour vous',
        url: 'https://www.impots.gouv.fr/facturation-electronique-qu-est-ce-que-ca-change-pour-moi',
        source: 'impots.gouv.fr',
        note: "Le calendrier par taille d'entreprise, les formats acceptés, le rôle des plateformes.",
      },
      {
        titre: 'Guide pratique de démarrage',
        url: 'https://www.impots.gouv.fr/sites/default/files/media/1_metier/2_professionnel/EV/2_gestion/290_facturation_electronique/guide_pratique_facturation_electronique.pdf',
        source: 'impots.gouv.fr — PDF',
        note: "Document de référence de l'administration, y compris sur la tolérance annoncée au démarrage.",
      },
      {
        titre: 'Décret n° 2026-677 du 27 juillet 2026',
        url: 'https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000054499487',
        source: 'Légifrance',
        note: "Cadre finalisé des plateformes agréées — le terme officiel qui remplace « PDP ».",
      },
    ],
  },
  {
    theme: 'Les mentions obligatoires sur une facture',
    liens: [
      {
        titre: 'Article 242 nonies A, annexe II du CGI',
        url: 'https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000050811276',
        source: 'Légifrance',
        note: "La liste qui fait foi. C'est elle qui impose le SIREN du client, l'adresse de livraison et la catégorie d'opération.",
      },
      {
        titre: 'Facturation entre professionnels : règles et mentions',
        url: 'https://entreprendre.service-public.fr/vosdroits/F31808',
        source: 'entreprendre.service-public.fr',
        note: 'La même chose en français courant, délais de paiement et pénalités compris.',
      },
    ],
  },
  {
    theme: 'Micro-entreprise et franchise de TVA',
    liens: [
      {
        titre: 'La franchise en base de TVA',
        url: 'https://entreprendre.service-public.fr/vosdroits/F21746',
        source: 'entreprendre.service-public.fr',
        note: "Les plafonds en vigueur et la mention à porter sur les factures. À consulter avant de renseigner le plafond dans les réglages : il change avec les lois de finances.",
      },
      {
        titre: 'Espace auto-entrepreneur',
        url: 'https://www.autoentrepreneur.urssaf.fr/portail/accueil.html',
        source: 'URSSAF',
        note: 'Déclaration du chiffre d’affaires encaissé — le montant que suit le brief de ce logiciel.',
      },
      {
        titre: 'Obligations comptables du micro-entrepreneur',
        url: 'https://entreprendre.service-public.fr/vosdroits/F23266',
        source: 'entreprendre.service-public.fr',
        note: 'Livre des recettes, conservation des pièces, registre des achats.',
      },
    ],
  },
  {
    theme: 'Les plateformes agréées',
    liens: [
      {
        titre: 'Les plateformes de dématérialisation — fiche officielle',
        url: 'https://www.impots.gouv.fr/sites/default/files/media/1_metier/2_professionnel/EV/2_gestion/290_facturation_electronique/fiches_reforme/fiche-pdp.pdf',
        source: 'impots.gouv.fr — PDF',
        note: "Leur rôle et comment en choisir une. Ce logiciel produit le fichier conforme ; la transmission passe obligatoirement par l'une d'elles (article 289 bis du CGI).",
      },
    ],
  },
];

function chargerReferences() {
  $('#references').innerHTML = REFERENCES.map((bloc) => `
    <section class="ref-bloc">
      <h2 class="ref-theme">${echapper(bloc.theme)}</h2>
      <div class="pile">
        ${bloc.liens.map((l) => `
          <a class="carte ref-carte" href="${l.url}" target="_blank" rel="noopener noreferrer">
            <div class="corps">
              <div class="titre">${echapper(l.titre)}</div>
              <div class="detail">${echapper(l.note)}</div>
            </div>
            <span class="badge b-cyan">${echapper(l.source)}</span>
          </a>`).join('')}
      </div>
    </section>`).join('');
}

/* ─── Journal ─── */
async function chargerJournal() {
  const [lignes, tdb] = await Promise.all([api('/journal'), api('/tableau-de-bord')]);
  const j = tdb.journal || { intact: true, lignes: 0 };
  $('#etat-journal').innerHTML = j.intact
    ? `<div class="carte k-vert"><span class="badge b-vert">intact</span><div class="corps"><div class="titre">La chaîne est complète</div><div class="detail">${j.lignes} écriture${j.lignes > 1 ? 's' : ''} vérifiée${j.lignes > 1 ? 's' : ''}, aucune rupture.</div></div></div>`
    : `<div class="carte k-rouge"><span class="badge b-rouge">rompue</span><div class="corps"><div class="titre">Le journal a été modifié</div><div class="detail">Rupture détectée à la ligne ${j.rompu_a}.</div></div></div>`;

  $('#table-journal').innerHTML = `<thead><tr><th>Quand</th><th>Acte</th><th>Détail</th></tr></thead>
    <tbody>${lignes.map((l) => `<tr>
      <td>${echapper(l.horodatage)}</td>
      <td><span class="badge b-gris">${echapper(l.acte)}</span></td>
      <td>${echapper(l.detail)}</td></tr>`).join('')}</tbody>`;
}

/** Le taux proposé sur une nouvelle ligne : zéro en franchise, sinon celui
    des réglages. Personne ne devrait avoir à corriger « 20 » à chaque ligne. */
function tauxHabituel() {
  if (!etat.entreprise || etat.entreprise.regime_tva === 'franchise') return 0;
  return Number(etat.entreprise.tva_taux_defaut) || 20;
}

/* ─── Tiroir : édition d'une facture ─── */
let brouillon = null;

function ouvrirTiroir(titre) {
  $('#tiroir-titre').textContent = titre;
  $('#tiroir').hidden = false;
  $('#voile').hidden = false;
}
function fermerTiroir() {
  $('#tiroir').hidden = true;
  $('#voile').hidden = true;
  brouillon = null;
}

async function nouvelleFacture(clientId = null) {
  if (!etat.entreprise) etat.entreprise = await api('/entreprise');
  if (!etat.clients.length) etat.clients = await api('/clients');
  if (!etat.clients.length) { noter('Ajoutez d’abord un client.', 'erreur'); return aller('clients'); }
  if (!etat.articles.length) etat.articles = await api('/articles').catch(() => []);

  brouillon = {
    id: null,
    client_id: clientId || etat.clients[0].id,
    date_emission: aujourdhui(),
    categorie: 'services',
    mode_paiement: 'virement',
    reference_commande: '',
    note: '',
    lignes: [{ designation: '', quantite: 1, prix_ht: 0, tva_taux: tauxHabituel(), unite: 'heure', remise_pct: 0 }],
  };
  ouvrirTiroir('Nouvelle facture');
  dessinerEditeur();
  return undefined;
}

async function ouvrirDocument(id) {
  const c = await api(`/documents/${id}`);
  if (c.document.statut === 'brouillon') {
    if (!etat.entreprise) etat.entreprise = await api('/entreprise');
    if (!etat.clients.length) etat.clients = await api('/clients');
    if (!etat.articles.length) etat.articles = await api('/articles').catch(() => []);
    brouillon = {
      id: c.document.id,
      client_id: c.document.client_id,
      date_emission: c.document.date_emission,
      categorie: c.document.categorie,
      mode_paiement: c.document.mode_paiement,
      reference_commande: c.document.reference_commande,
      note: c.document.note,
      lignes: c.lignes.map((l) => ({ ...l })),
    };
    ouvrirTiroir('Brouillon');
    dessinerEditeur();
  } else {
    ouvrirTiroir(`${c.document.type === 'avoir' ? 'Avoir' : 'Facture'} ${c.document.numero}`);
    dessinerFiche(c);
  }
}

function dessinerEditeur() {
  const b = brouillon;
  const franchise = !etat.entreprise || etat.entreprise.regime_tva === 'franchise';
  const corps = $('#tiroir-corps');
  corps.innerHTML = `
    <div class="formulaire" style="margin-bottom:22px">
      <div class="champ"><label>Client</label>
        <select id="f-client">${etat.clients.map((c) =>
          `<option value="${c.id}" ${c.id === b.client_id ? 'selected' : ''}>${echapper(c.nom)}</option>`).join('')}</select></div>
      <div class="champ"><label>Date d’émission</label><input type="date" id="f-date" value="${b.date_emission}"></div>
      <div class="champ"><label>Nature de l’opération</label>
        <select id="f-categorie">
          <option value="services" ${b.categorie === 'services' ? 'selected' : ''}>Prestations de services</option>
          <option value="biens" ${b.categorie === 'biens' ? 'selected' : ''}>Livraison de biens</option>
          <option value="mixte" ${b.categorie === 'mixte' ? 'selected' : ''}>Les deux</option>
        </select><span class="indice">Exigé par la facturation électronique</span></div>
      <div class="champ"><label>Paiement</label>
        <select id="f-paiement">${[['virement', 'Virement'], ['carte', 'Carte'], ['cheque', 'Chèque'], ['especes', 'Espèces'], ['prelevement', 'Prélèvement']]
          .map(([v, t]) => `<option value="${v}" ${b.mode_paiement === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="champ large"><label>Référence de commande (facultatif)</label>
        <input id="f-commande" value="${echapper(b.reference_commande)}"></div>
    </div>

    <div class="lignes-tete ${franchise ? 'sans-tva' : ''}">
      <div>Désignation</div><div>Qté</div><div>${franchise ? 'Prix' : 'Prix HT'}</div>
      ${franchise ? '' : '<div>TVA %</div>'}<div style="text-align:right">Total</div><div></div>
    </div>
    <div id="lignes"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="bouton" id="ajouter-ligne">+ Ligne</button>
      ${etat.articles.length ? `<select id="depuis-catalogue" style="max-width:280px">
        <option value="">Depuis le catalogue…</option>
        ${etat.articles.map((a) => `<option value="${a.id}">${echapper(a.designation)} — ${eur(a.prix_ht)}</option>`).join('')}
      </select>` : ''}
    </div>

    <div class="champ large" style="margin-top:18px">
      <label>Note sur la facture (facultatif)</label>
      <textarea id="f-note" rows="2">${echapper(b.note)}</textarea>
    </div>

    <div class="recap" id="recap"></div>`;

  $('#tiroir-pied').innerHTML = `
    <button class="bouton discret" id="btn-annuler">Fermer</button>
    <button class="bouton" id="btn-enregistrer">Enregistrer le brouillon</button>
    <button class="bouton primaire" id="btn-emettre">Émettre la facture</button>`;

  dessinerLignes();
  rafraichirRecap();
}

function dessinerLignes() {
  const franchise = !etat.entreprise || etat.entreprise.regime_tva === 'franchise';
  $('#lignes').innerHTML = brouillon.lignes.map((l, i) => `
    <div class="ligne-saisie ${franchise ? 'sans-tva' : ''}" data-i="${i}">
      <input class="l-designation" value="${echapper(l.designation)}" placeholder="Prestation ou produit">
      <input class="l-quantite" type="number" step="0.25" value="${l.quantite}">
      <input class="l-prix" type="number" step="0.01" value="${l.prix_ht}">
      ${franchise
        ? `<input class="l-tva" type="hidden" value="0">`
        : `<input class="l-tva" type="number" step="0.1" value="${l.tva_taux}">`}
      <div class="ligne-total" data-total="${i}">—</div>
      <button class="icone" data-suppr-ligne="${i}" title="Retirer">✕</button>
    </div>`).join('');
}

async function rafraichirRecap() {
  lireLignes();
  const t = await api('/apercu', { method: 'POST', body: { lignes: brouillon.lignes } });
  t.lignes.forEach((l, i) => {
    const c = $(`[data-total="${i}"]`);
    if (c) c.textContent = eur(l.montant_ht);
  });
  const franchise = !etat.entreprise || etat.entreprise.regime_tva === 'franchise';
  $('#recap').innerHTML = franchise
    ? `<div class="recap-ligne total"><span>Total</span><span>${eur(t.total_ht)}</span></div>
       <div class="recap-ligne"><span class="sourdine">TVA non applicable, article 293 B du CGI</span><span></span></div>`
    : `<div class="recap-ligne"><span class="sourdine">Total HT</span><span>${eur(t.total_ht)}</span></div>
       ${t.ventilation_tva.map((v) => `<div class="recap-ligne"><span class="sourdine">TVA ${v.taux} % sur ${eur(v.base_ht)}</span><span>${eur(v.montant_tva)}</span></div>`).join('')}
       <div class="recap-ligne total"><span>Total TTC</span><span>${eur(t.total_ttc)}</span></div>`;
}

function lireLignes() {
  brouillon.lignes = $$('.ligne-saisie').map((n) => ({
    designation: $('.l-designation', n).value,
    quantite: Number($('.l-quantite', n).value) || 0,
    prix_ht: Number($('.l-prix', n).value) || 0,
    tva_taux: Number($('.l-tva', n).value) || 0,
    unite: 'heure',
    remise_pct: 0,
  }));
}

function lireEnTete() {
  brouillon.client_id = Number($('#f-client').value);
  brouillon.date_emission = $('#f-date').value;
  brouillon.categorie = $('#f-categorie').value;
  brouillon.mode_paiement = $('#f-paiement').value;
  brouillon.reference_commande = $('#f-commande').value;
  brouillon.note = $('#f-note').value;
  lireLignes();
}

async function enregistrerBrouillon() {
  lireEnTete();
  const corps = { ...brouillon };
  const r = brouillon.id
    ? await api(`/documents/${brouillon.id}`, { method: 'PUT', body: corps })
    : await api('/documents', { method: 'POST', body: corps });
  brouillon.id = r.document.id;
  return r;
}

async function dessinerFiche(c) {
  const d = c.document;
  const corps = $('#tiroir-corps');
  corps.innerHTML = `
    <div class="compteurs" style="margin-bottom:20px">
      <div class="compteur"><div class="valeur">${eur(c.totaux.total_ttc)}</div><div class="etiquette">Total TTC</div></div>
      <div class="compteur ${c.reste_du > 0 ? 'c-ambre' : 'c-vert'}"><div class="valeur">${eur(c.reste_du)}</div><div class="etiquette">Reste dû</div></div>
      <div class="compteur"><div class="valeur">${jour(d.date_echeance)}</div><div class="etiquette">Échéance</div></div>
    </div>
    <div class="tableau-enveloppe" style="margin-bottom:18px"><table class="tableau">
      <thead><tr><th>Désignation</th><th class="num">Qté</th><th class="num">P.U.</th><th class="num">TVA</th><th class="num">Total HT</th></tr></thead>
      <tbody>${c.totaux.lignes.map((l) => `<tr>
        <td>${echapper(l.designation)}</td><td class="num">${l.quantite}</td>
        <td class="num">${eur(l.prix_ht)}</td><td class="num">${l.tva_taux} %</td>
        <td class="num">${eur(l.montant_ht)}</td></tr>`).join('')}</tbody>
    </table></div>
    ${c.paiements.length ? `<h3 style="font-size:13px;color:var(--sourdine)">Encaissements</h3>
      <div class="tableau-enveloppe"><table class="tableau"><tbody>${c.paiements.map((p) =>
        `<tr><td>${jour(p.date)}</td><td>${echapper(p.moyen)}</td><td class="num">${eur(p.montant)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <p class="aide" style="margin-top:18px">Empreinte : <code style="font-size:11px">${echapper((d.empreinte || '').slice(0, 32))}…</code></p>`;

  $('#tiroir-pied').innerHTML = `
    <button class="bouton discret" id="btn-annuler">Fermer</button>
    <button class="bouton" data-pdf="${d.id}">PDF Factur-X</button>
    <button class="bouton" data-xml="${d.id}">XML seul</button>
    ${c.reste_du > 0 ? `<button class="bouton primaire" data-encaisser="${d.id}" data-montant="${c.reste_du}">Encaisser</button>` : ''}
    ${d.type === 'facture' ? `<button class="bouton danger" data-avoir="${d.id}">Avoir</button>` : ''}`;
}

/* ─── Actions globales ─── */
document.addEventListener('click', async (ev) => {
  const c = ev.target.closest('[data-vue],[data-action],[data-ouvrir],[data-pdf],[data-xml],[data-encaisser],[data-avoir],[data-client],[data-facturer],[data-suppr-ligne],[data-suppr-article],[data-filtre]');
  if (!c) return;

  try {
    if (c.dataset.vue) return aller(c.dataset.vue);
    if (c.dataset.action === 'nouvelle-facture') return nouvelleFacture();
    if (c.dataset.action === 'nouveau-client') return formulaireClient();
    if (c.dataset.action === 'nouvel-article') return formulaireArticle();
    if (c.dataset.ouvrir) return ouvrirDocument(c.dataset.ouvrir);
    if (c.dataset.facturer) return nouvelleFacture(Number(c.dataset.facturer));
    if (c.dataset.client) return formulaireClient(Number(c.dataset.client));
    if (c.dataset.pdf) { window.open(`/api/documents/${c.dataset.pdf}/pdf`, '_blank'); return undefined; }
    if (c.dataset.xml) { window.location = `/api/documents/${c.dataset.xml}/xml`; return undefined; }

    if (c.dataset.filtre !== undefined) {
      etat.filtre = c.dataset.filtre;
      $$('#filtres-documents .puce').forEach((p) => p.classList.toggle('actif', p === c));
      return chargerDocuments();
    }

    if (c.dataset.encaisser) {
      const propose = c.dataset.montant;
      const saisi = prompt('Montant encaissé (€)', propose);
      if (saisi === null) return undefined;
      await api(`/documents/${c.dataset.encaisser}/paiements`, { method: 'POST', body: { montant: Number(saisi.replace(',', '.')) } });
      noter('Encaissement enregistré.', 'succes');
      fermerTiroir();
      return aller($('.onglet.actif').dataset.vue);
    }

    if (c.dataset.avoir) {
      if (!confirm("Établir un avoir sur cette facture ? Elle sera annulée par un document séparé, comme l'exige la comptabilité.")) return undefined;
      const motif = prompt('Motif de l’avoir', 'Erreur de facturation') || '';
      const r = await api(`/documents/${c.dataset.avoir}/avoir`, { method: 'POST', body: { motif } });
      noter('Avoir créé en brouillon.', 'succes');
      return ouvrirDocument(r.document.id);
    }

    if (c.dataset.supprLigne !== undefined) {
      lireLignes();
      brouillon.lignes.splice(Number(c.dataset.supprLigne), 1);
      if (!brouillon.lignes.length) brouillon.lignes.push({ designation: '', quantite: 1, prix_ht: 0, tva_taux: tauxHabituel() });
      dessinerLignes();
      return rafraichirRecap();
    }

    if (c.dataset.supprArticle) {
      await api(`/articles/${c.dataset.supprArticle}`, { method: 'DELETE' });
      return chargerArticles();
    }
  } catch (e) {
    noter(e.message, 'erreur');
    if (e.anomalies?.length) {
      const zone = $('#tiroir-corps');
      if (zone) {
        const bloc = document.createElement('div');
        bloc.className = 'anomalies';
        bloc.innerHTML = `<h3>À corriger avant d’émettre</h3><ul>${e.anomalies.map((a) => `<li>${echapper(a)}</li>`).join('')}</ul>`;
        zone.prepend(bloc);
        zone.scrollTop = 0;
      }
    }
  }
  return undefined;
});

document.addEventListener('input', (ev) => {
  if (ev.target.closest('.ligne-saisie')) rafraichirRecap();
});

document.addEventListener('change', async (ev) => {
  if (ev.target.id === 'depuis-catalogue' && ev.target.value) {
    const a = etat.articles.find((x) => String(x.id) === ev.target.value);
    lireLignes();
    if (brouillon.lignes.length === 1 && !brouillon.lignes[0].designation) brouillon.lignes = [];
    brouillon.lignes.push({ designation: a.designation, quantite: 1, prix_ht: a.prix_ht, tva_taux: a.tva_taux, unite: a.unite, remise_pct: 0 });
    dessinerLignes();
    rafraichirRecap();
    ev.target.value = '';
  }
});

document.addEventListener('change', async (ev) => {
  if (ev.target.id !== 'e-territoire-select') return;
  try {
    await api('/entreprise', { method: 'PUT', body: { territoire: ev.target.value } });
    etat.territoires = null;
    etat.entreprise = null;
    noter('Territoire enregistré : les taux proposés suivent.', 'succes');
    chargerEntreprise();
  } catch (e) { noter(e.message, 'erreur'); }
});

document.addEventListener('click', async (ev) => {
  const applique = ev.target.closest('[data-territoire]');
  if (applique) {
    await api('/entreprise', { method: 'PUT', body: { territoire: applique.dataset.territoire } });
    etat.territoires = null;
    etat.entreprise = null;
    noter('Territoire appliqué.', 'succes');
    return chargerEntreprise();
  }
  const carte = ev.target.closest('[data-regime]');
  if (!carte) return;
  const champRegime = $('#e-regime_tva');
  if (champRegime) champRegime.value = carte.dataset.regime;
  try {
    await api('/entreprise', { method: 'PUT', body: { regime_tva: carte.dataset.regime } });
    etat.entreprise = null;
    noter(carte.dataset.regime === 'franchise'
      ? 'Régime enregistré : vos factures ne porteront pas de TVA.'
      : 'Régime enregistré : la TVA apparaîtra sur vos factures.', 'succes');
    chargerEntreprise();
  } catch (e) { noter(e.message, 'erreur'); }
  return undefined;
});

document.addEventListener('submit', async (ev) => {
  if (ev.target.id === 'form-licence') {
    ev.preventDefault();
    const corps = Object.fromEntries(new FormData(ev.target));
    try {
      await api('/edition/licence', { method: 'POST', body: corps });
      noter('Édition Pro activée. Merci.', 'succes');
      chargerEdition();
    } catch (e) { noter(e.message, 'erreur'); }
    return;
  }
  if (ev.target.id === 'form-entreprise') {
    ev.preventDefault();
    const corps = Object.fromEntries(new FormData(ev.target));
    await api('/entreprise', { method: 'PUT', body: corps });
    noter('Entreprise enregistrée.', 'succes');
    chargerEntreprise();
  }
});

document.addEventListener('click', async (ev) => {
  if (ev.target.id === 'ajouter-ligne') {
    lireLignes();
    brouillon.lignes.push({ designation: '', quantite: 1, prix_ht: 0, tva_taux: tauxHabituel() });
    dessinerLignes();
    rafraichirRecap();
  }
  if (ev.target.id === 'btn-annuler' || ev.target.id === 'tiroir-fermer' || ev.target.id === 'voile') fermerTiroir();
  if (ev.target.id === 'btn-enregistrer') {
    try { await enregistrerBrouillon(); noter('Brouillon enregistré.', 'succes'); chargerDocuments(); }
    catch (e) { noter(e.message, 'erreur'); }
  }
  if (ev.target.id === 'btn-emettre') {
    try {
      const r = await enregistrerBrouillon();
      await api(`/documents/${r.document.id}/emettre`, { method: 'POST' });
      noter('Facture émise. Le PDF Factur-X est prêt.', 'succes');
      fermerTiroir();
      aller('documents');
    } catch (e) {
      noter(e.message, 'erreur');
      if (e.anomalies?.length) {
        const bloc = document.createElement('div');
        bloc.className = 'anomalies';
        bloc.innerHTML = `<h3>À corriger avant d’émettre</h3><ul>${e.anomalies.map((a) => `<li>${echapper(a)}</li>`).join('')}</ul>`;
        $('#tiroir-corps').prepend(bloc);
        $('#tiroir-corps').scrollTop = 0;
      }
    }
  }
  if (ev.target.id === 'btn-export') window.location = '/api/export/ventes.csv';
  if (ev.target.id === 'btn-retirer-licence') {
    try {
      await api('/edition/licence', { method: 'DELETE' });
      noter('Licence retirée : retour à l’édition Découverte.');
      chargerEdition();
    } catch (e) { noter(e.message, 'erreur'); }
  }
});

/* ─── Formulaires client et article ─── */
function formulaireClient(id = null) {
  const c = id ? etat.clients.find((x) => x.id === id) : {};
  ouvrirTiroir(id ? 'Modifier le client' : 'Nouveau client');
  const ch = (n, l, v = '', o = {}) => `
    <div class="champ ${o.large ? 'large' : ''}"><label>${l}</label>
    ${o.choix ? `<select name="${n}">${o.choix.map(([val, t]) => `<option value="${val}" ${String(v) === val ? 'selected' : ''}>${t}</option>`).join('')}</select>`
      : `<input name="${n}" value="${echapper(v ?? '')}" ${o.type ? `type="${o.type}"` : ''}>`}
    ${o.indice ? `<span class="indice">${o.indice}</span>` : ''}</div>`;
  $('#tiroir-corps').innerHTML = `<form id="form-client" class="formulaire">
    ${ch('type', 'Type', c.type || 'entreprise', { choix: [['entreprise', 'Entreprise'], ['particulier', 'Particulier'], ['public', 'Secteur public']] })}
    ${ch('nom', 'Nom / raison sociale', c.nom)}
    ${ch('contact', 'Contact', c.contact)}
    ${ch('siren', 'SIREN', c.siren, { indice: 'Obligatoire pour un professionnel' })}
    ${ch('siret', 'SIRET', c.siret)}
    ${ch('tva_intra', 'TVA intracommunautaire', c.tva_intra)}
    ${ch('code_service', 'Code service exécutant', c.code_service, { indice: 'Secteur public uniquement' })}
    ${ch('adresse', 'Adresse', c.adresse, { large: true })}
    ${ch('code_postal', 'Code postal', c.code_postal)}
    ${ch('ville', 'Ville', c.ville)}
    ${ch('pays', 'Pays', c.pays || 'FR')}
    ${ch('email', 'Courriel', c.email, { type: 'email' })}
    ${ch('telephone', 'Téléphone', c.telephone)}
    ${ch('livraison_adresse', 'Adresse de livraison si différente', c.livraison_adresse, { large: true })}
    ${ch('delai_paiement_jours', 'Délai de paiement (jours)', c.delai_paiement_jours ?? 30, { type: 'number', indice: '60 jours maximum' })}
  </form>`;
  $('#tiroir-pied').innerHTML = `<button class="bouton discret" id="btn-annuler">Annuler</button>
    <button class="bouton primaire" id="btn-client-ok">${id ? 'Enregistrer' : 'Créer'}</button>`;
  $('#btn-client-ok').onclick = async () => {
    const corps = Object.fromEntries(new FormData($('#form-client')));
    try {
      if (id) await api(`/clients/${id}`, { method: 'PUT', body: corps });
      else await api('/clients', { method: 'POST', body: corps });
      noter('Client enregistré.', 'succes');
      fermerTiroir();
      chargerClients();
    } catch (e) { noter(e.message, 'erreur'); }
  };
}

function formulaireArticle() {
  ouvrirTiroir('Nouvelle prestation');
  $('#tiroir-corps').innerHTML = `<form id="form-article" class="formulaire">
    <div class="champ large"><label>Désignation</label><input name="designation" required></div>
    <div class="champ"><label>Référence</label><input name="reference"></div>
    <div class="champ"><label>Unité</label>
      <select name="unite">${['heure', 'jour', 'forfait', 'piece', 'mois'].map((u) => `<option>${u}</option>`).join('')}</select></div>
    <div class="champ"><label>Prix HT</label><input name="prix_ht" type="number" step="0.01" value="0"></div>
    ${tauxHabituel() === 0
      ? '<input type="hidden" name="tva_taux" value="0">'
      : `<div class="champ"><label>TVA %</label><input name="tva_taux" type="number" step="0.1" value="${tauxHabituel()}"></div>`}
  </form>`;
  $('#tiroir-pied').innerHTML = `<button class="bouton discret" id="btn-annuler">Annuler</button>
    <button class="bouton primaire" id="btn-article-ok">Ajouter</button>`;
  $('#btn-article-ok').onclick = async () => {
    const corps = Object.fromEntries(new FormData($('#form-article')));
    try {
      await api('/articles', { method: 'POST', body: corps });
      noter('Ajouté au catalogue.', 'succes');
      fermerTiroir();
      chargerArticles();
    } catch (e) { noter(e.message, 'erreur'); }
  };
}

/* ─── Démarrage ─── */
aller('brief');
api('/edition').then((e) => {
  const bouton = $('#btn-edition');
  if (bouton) bouton.textContent = `Édition ${e.nom}`;
}).catch(() => {});
