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

let etat = { entreprise: null, clients: [], articles: [], filtre: '' };

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

  $('#compteurs').innerHTML = [
    { v: eur(stats.chiffre_affaires_ttc), e: 'Facturé TTC', c: '' },
    { v: eur(stats.encaisse), e: 'Encaissé', c: 'c-vert' },
    { v: eur(stats.reste_du), e: 'Reste à encaisser', c: stats.reste_du > 0 ? 'c-ambre' : '' },
    { v: eur(stats.en_retard), e: 'En retard', c: stats.en_retard > 0 ? 'c-rouge' : '' },
  ].map((c) => `<div class="compteur ${c.c}"><div class="valeur">${c.v}</div><div class="etiquette">${c.e}</div></div>`).join('');

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
    champ('regime_tva', 'Régime de TVA', e.regime_tva, {
      choix: [['normal', 'TVA applicable'], ['franchise', 'Franchise en base (art. 293 B)']],
      indice: 'En franchise, aucune ligne ne peut porter de TVA',
    }),
    champ('tva_sur_debits', 'TVA d’après les débits', String(e.tva_sur_debits || 0), {
      choix: [['0', 'Non'], ['1', 'Oui — mention ajoutée']],
    }),
    champ('penalites_taux', 'Taux de pénalités de retard (%)', e.penalites_taux ?? 10, { type: 'number' }),
    champ('escompte', 'Mention d’escompte', e.escompte, { large: true }),
    `<div class="champ large"><button class="bouton primaire" type="submit">Enregistrer</button></div>`,
  ].join('');
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
    lignes: [{ designation: '', quantite: 1, prix_ht: 0, tva_taux: 20, unite: 'heure', remise_pct: 0 }],
  };
  ouvrirTiroir('Nouvelle facture');
  dessinerEditeur();
  return undefined;
}

async function ouvrirDocument(id) {
  const c = await api(`/documents/${id}`);
  if (c.document.statut === 'brouillon') {
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

    <div class="lignes-tete">
      <div>Désignation</div><div>Qté</div><div>Prix HT</div><div>TVA %</div><div style="text-align:right">Total</div><div></div>
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
  $('#lignes').innerHTML = brouillon.lignes.map((l, i) => `
    <div class="ligne-saisie" data-i="${i}">
      <input class="l-designation" value="${echapper(l.designation)}" placeholder="Prestation ou produit">
      <input class="l-quantite" type="number" step="0.25" value="${l.quantite}">
      <input class="l-prix" type="number" step="0.01" value="${l.prix_ht}">
      <input class="l-tva" type="number" step="0.1" value="${l.tva_taux}">
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
  $('#recap').innerHTML = `
    <div class="recap-ligne"><span class="sourdine">Total HT</span><span>${eur(t.total_ht)}</span></div>
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
      if (!brouillon.lignes.length) brouillon.lignes.push({ designation: '', quantite: 1, prix_ht: 0, tva_taux: 20 });
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

document.addEventListener('submit', async (ev) => {
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
    brouillon.lignes.push({ designation: '', quantite: 1, prix_ht: 0, tva_taux: 20 });
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
    <div class="champ"><label>TVA %</label><input name="tva_taux" type="number" step="0.1" value="20"></div>
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
