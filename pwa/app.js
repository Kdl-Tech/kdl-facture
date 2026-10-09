/**
 * KDL Facture — version installable.
 *
 * L'application entière tient dans cette page : lecture des factures reçues,
 * contrôle de conformité, suivi. Le moteur métier est celui du logiciel de
 * bureau, empaqueté pour le navigateur, pas une réécriture — ce qui garantit
 * qu'une facture est lue de la même façon des deux côtés.
 *
 * Les données restent locales, sauf appairage explicite de la synchronisation
 * personnelle PC / téléphone.
 */

import { lireFichierRecu } from '../src/reception/index.js';
import { creerDepot, magasinMemoire } from '../src/pwa/depot.js';
import { ouvrirMagasin, demanderConservationDurable } from '../src/pwa/magasin-indexeddb.js';
import { suivantsPossibles, STATUTS, motifDepuisControle } from '../src/reception/journal.js';
import { creerEcranEmission } from './emission-ui.js';
import { creerEcranClients } from './clients-ui.js';
import { messageQuota } from '../src/licence-portable.js';
import { creerSync } from '../src/pwa/sync.js';
import { creerEcranRecap } from './recap-ui.js';

const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'développement';

const $ = (selecteur) => document.querySelector(selecteur);
const euros = (v) => `${Number(v || 0).toFixed(2).replace('.', ',')} €`;
const jour = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—');
const aujourdhui = () => new Date().toISOString().slice(0, 10);

let depot;
let stockageDurable = { durable: false, connu: false };
let selection = null;
let ecranEmission = null;
let ecranClients = null;
let ecranRecap = null;

/*
 * L'apparence (clair/sombre) est gérée par le kit commun KDL TECH
 * (kdl-theme.js, chargé avant ce fichier) : bouton soleil/lune posé dans
 * `[data-kdl-theme-btn]`, choix mémorisé dans localStorage 'kdl-theme'.
 */

/* ---------- Messages ---------- */

function dire(texte, genre = 'info', duree = 5200) {
  const boite = document.createElement('div');
  boite.className = `message ${genre}`;
  boite.textContent = texte;
  $('#messages').append(boite);
  setTimeout(() => boite.remove(), duree);
}

/* ---------- Affichage ---------- */

function classeVerdict(verdict) {
  if (verdict === 'non conforme') return 'nonconforme';
  if (verdict === 'à vérifier') return 'avérifier';
  return 'conforme';
}

async function dessinerResume() {
  const r = await depot.resumeRecues(aujourdhui());
  $('#resume').innerHTML = `
    <div class="carte">
      <div class="titre">À traiter</div>
      <div class="chiffre">${r.a_traiter.n}</div>
      <div class="montant">${euros(r.a_traiter.total)}</div>
    </div>
    <div class="carte">
      <div class="titre">À payer</div>
      <div class="chiffre">${r.a_payer.n}</div>
      <div class="montant">${euros(r.a_payer.total)}</div>
    </div>
    <div class="carte ${r.en_retard.n ? 'presse' : ''}">
      <div class="titre">En retard</div>
      <div class="chiffre">${r.en_retard.n}</div>
      <div class="montant">${euros(r.en_retard.total)}</div>
    </div>
    <div class="carte ${r.non_conformes.n ? 'douteux' : ''}">
      <div class="titre">Non conformes</div>
      <div class="chiffre">${r.non_conformes.n}</div>
      <div class="montant">à contester</div>
    </div>`;
}

async function dessinerListe() {
  const factures = await depot.listerRecues({
    statut: $('#filtre-statut').value || undefined,
    fournisseur: $('#recherche').value.trim() || undefined,
  });

  if (!factures.length) {
    $('#liste').innerHTML = `
      <div class="vide">
        <div class="grand">Aucune facture reçue pour l'instant</div>
        <p>Déposez le PDF ou le XML que votre fournisseur vous a envoyé :<br>
        KDL Facture le lit, vérifie ses calculs et vous dit s'il est conforme.</p>
      </div>`;
    return;
  }

  const lignes = factures.map((r) => {
    const f = r.facture;
    const enRetard = f.date_echeance && f.date_echeance < aujourdhui()
      && ['recue', 'approuvee', 'en_paiement'].includes(r.statut);
    return `
      <tr data-id="${r.id}" tabindex="0">
        <td>
          <div class="principal">${echapper(f.fournisseur.nom || 'Fournisseur inconnu')}</div>
          <div class="secondaire">${echapper(f.numero || 'sans numéro')}${f.type === 'avoir' ? ' · avoir' : ''}</div>
        </td>
        <td class="masquable secondaire">${jour(f.date_emission)}</td>
        <td class="masquable">
          ${jour(f.date_echeance)}
          ${enRetard ? '<span class="pastille retard">en retard</span>' : ''}
        </td>
        <td class="nombre principal">${euros(f.totaux.net_a_payer)}</td>
        <td><span class="pastille ${classeVerdict(r.controle.verdict)}">${r.controle.verdict}</span></td>
        <td><span class="pastille statut">${r.statut_libelle}</span></td>
      </tr>`;
  }).join('');

  $('#liste').innerHTML = `
    <table class="tableau">
      <thead>
        <tr>
          <th>Fournisseur</th>
          <th class="masquable">Émise le</th>
          <th class="masquable">Échéance</th>
          <th class="nombre">À payer</th>
          <th>Contrôle</th>
          <th>Statut</th>
        </tr>
      </thead>
      <tbody>${lignes}</tbody>
    </table>`;

  $('#liste').querySelectorAll('tr[data-id]').forEach((ligne) => {
    const ouvrir = () => ouvrirDetail(Number(ligne.dataset.id));
    ligne.addEventListener('click', ouvrir);
    ligne.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ouvrir(); }
    });
  });
}

function echapper(texte) {
  return String(texte ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/* ---------- Détail ---------- */

async function ouvrirDetail(id) {
  const r = await depot.obtenirRecue(id);
  if (!r) return;
  selection = r;
  const f = r.facture;

  const anomalies = r.controle.anomalies.map((a) => `<div class="anomalie">${echapper(a)}</div>`).join('');
  const avertissements = r.controle.avertissements
    .map((a) => `<div class="avertissement">${echapper(a)}</div>`).join('');

  const lignes = f.lignes.map((l) => `
    <div class="paire">
      <dt>${echapper(l.designation || '—')}<br>
        <span class="secondaire">${l.quantite} × ${euros(l.prix_ht)}${l.tva_taux ? ` · TVA ${l.tva_taux} %` : ''}</span>
      </dt>
      <dd>${euros(l.montant_ht)}</dd>
    </div>`).join('');

  const chrono = (r.historique || []).map((h) => `
    <li>
      <strong>${(STATUTS[h.statut] || {}).libelle || h.statut}</strong>
      <span class="quand">— ${new Date(h.date).toLocaleString('fr-FR')}</span>
      ${h.motif ? `<div class="pourquoi">${echapper(h.motif)}</div>` : ''}
    </li>`).join('');

  const suites = suivantsPossibles(r.statut).map((s) => `
    <button class="${s === 'rejetee' ? 'danger' : 'premier'}" data-statut="${s}">
      ${STATUTS[s].libelle}
    </button>`).join('');

  const voile = document.createElement('div');
  voile.className = 'voile';
  const tiroir = document.createElement('aside');
  tiroir.className = 'tiroir';
  tiroir.innerHTML = `
    <button class="discret fermer" id="fermer-tiroir" aria-label="Fermer">✕</button>
    <h2>${echapper(f.fournisseur.nom || 'Fournisseur inconnu')}</h2>
    <div class="sous-titre">
      ${echapper(f.numero)} · émise le ${jour(f.date_emission)} ·
      <span class="pastille ${classeVerdict(r.controle.verdict)}">${r.controle.verdict}</span>
    </div>

    ${anomalies ? `<div class="bloc"><h3>Ce qui ne va pas</h3>${anomalies}</div>` : ''}
    ${avertissements ? `<div class="bloc"><h3>À vérifier</h3>${avertissements}</div>` : ''}

    <div class="bloc">
      <h3>Détail</h3>
      ${lignes}
      <div class="paire"><dt>Total hors taxes</dt><dd>${euros(f.totaux.total_ht)}</dd></div>
      <div class="paire"><dt>TVA</dt><dd>${euros(f.totaux.total_tva)}</dd></div>
      ${f.totaux.acompte ? `<div class="paire"><dt>Acompte déjà versé</dt><dd>− ${euros(f.totaux.acompte)}</dd></div>` : ''}
      <div class="paire fort"><dt>À payer</dt><dd>${euros(f.totaux.net_a_payer)}</dd></div>
    </div>

    <div class="bloc">
      <h3>Émetteur</h3>
      <div class="paire"><dt>SIRET</dt><dd>${echapper(f.fournisseur.siret || f.fournisseur.siren || '—')}</dd></div>
      <div class="paire"><dt>TVA intracommunautaire</dt><dd>${echapper(f.fournisseur.tva_intra || '—')}</dd></div>
      <div class="paire"><dt>Échéance</dt><dd>${jour(f.date_echeance)}</dd></div>
      <div class="paire"><dt>IBAN</dt><dd>${echapper(f.paiement.iban || '—')}</dd></div>
      <div class="paire"><dt>Format reçu</dt><dd>${echapper(f.format)} · ${echapper(r.source)}</dd></div>
    </div>

    <div class="bloc">
      <h3>Décision</h3>
      <div class="suite">${suites || '<span class="secondaire">Ce statut est définitif.</span>'}</div>
    </div>

    <div class="bloc">
      <h3>Ce qui a été décidé</h3>
      <ul class="chrono">${chrono}</ul>
    </div>`;

  document.body.append(voile, tiroir);
  const fermer = () => { voile.remove(); tiroir.remove(); selection = null; };
  voile.addEventListener('click', fermer);
  tiroir.querySelector('#fermer-tiroir').addEventListener('click', fermer);
  document.addEventListener('keydown', function echap(e) {
    if (e.key === 'Escape') { fermer(); document.removeEventListener('keydown', echap); }
  });

  tiroir.querySelectorAll('button[data-statut]').forEach((bouton) => {
    bouton.addEventListener('click', async () => {
      const vise = bouton.dataset.statut;
      let motif = '';
      if (vise === 'rejetee') {
        const propose = motifDepuisControle(r.controle);
        motif = window.prompt(
          'Pourquoi rejetez-vous cette facture ?\nLe motif sera transmis au fournisseur.',
          propose,
        ) || '';
        if (!motif.trim()) { dire('Rejet abandonné : un motif est nécessaire.', 'attention'); return; }
      }
      try {
        await depot.changerStatutRecue(r.id, vise, { motif, par: '' });
        fermer();
        await rafraichir();
        dire(`Facture ${f.numero} : ${STATUTS[vise].libelle.toLowerCase()}.`, 'reussite');
      } catch (erreur) {
        dire(erreur.message, 'erreur');
      }
    });
  });
}

/* ---------- Réception de fichiers ---------- */

async function recevoirFichiers(fichiers) {
  let acceptees = 0;
  for (const fichier of fichiers) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const octets = new Uint8Array(await fichier.arrayBuffer());
      // eslint-disable-next-line no-await-in-loop
      const recue = await lireFichierRecu(octets, { nom: fichier.name });
      // eslint-disable-next-line no-await-in-loop
      const resultat = await depot.ajouterRecue(recue);

      if (!resultat.enregistree) {
        const forcer = window.confirm(`${resultat.message}\n\nL'enregistrer quand même ?`);
        // eslint-disable-next-line no-await-in-loop
        if (forcer) await depot.ajouterRecue(recue, { forcer: true });
        else { dire(resultat.message, 'attention', 7000); continue; }
      }

      acceptees += 1;
      if (!recue.controle.conforme) {
        dire(`${fichier.name} : ${recue.controle.anomalies.length} anomalie(s) — `
          + 'la facture est enregistrée mais marquée non conforme.', 'attention', 8000);
      }
    } catch (erreur) {
      dire(`${fichier.name} : ${erreur.message}`, 'erreur', 9000);
    }
  }

  if (acceptees) {
    dire(`${acceptees} facture${acceptees > 1 ? 's' : ''} reçue${acceptees > 1 ? 's' : ''}.`, 'reussite');
    await rafraichir();
  }
}

/* ---------- Sauvegarde ---------- */

async function exporterSauvegarde() {
  const sauvegarde = await depot.exporter();
  const blob = new Blob([JSON.stringify(sauvegarde, null, 2)], { type: 'application/json' });
  const lien = document.createElement('a');
  lien.href = URL.createObjectURL(blob);
  lien.download = `kdl-facture-sauvegarde-${aujourdhui()}.json`;
  lien.click();
  URL.revokeObjectURL(lien.href);
  dire('Sauvegarde enregistrée. Rangez-la ailleurs que sur cet appareil.', 'reussite', 8000);
}

async function importerSauvegarde(fichier) {
  if (!window.confirm(
    'Restaurer remplacera toutes les données de cet appareil par celles de la sauvegarde.\n\n'
    + 'Continuer ?',
  )) return;
  try {
    const { rétablis } = await depot.importer(JSON.parse(await fichier.text()));
    await rafraichir();
    dire(`${rétablis} élément(s) rétabli(s).`, 'reussite');
  } catch (erreur) {
    dire(erreur.message, 'erreur', 9000);
  }
}

/* ---------- Mise en place ---------- */

async function rafraichir() {
  await dessinerResume();
  await dessinerListe();
}

function brancherOnglets() {
  document.querySelectorAll('.onglet').forEach((onglet) => {
    onglet.addEventListener('click', async () => {
      document.querySelectorAll('.onglet').forEach((o) => o.setAttribute('aria-selected', 'false'));
      onglet.setAttribute('aria-selected', 'true');
      for (const vue of ['reception', 'emission', 'clients', 'recap', 'donnees']) {
        $(`#vue-${vue}`).hidden = vue !== onglet.dataset.vue;
      }
      // Les écrans d'émission et de clients se redessinent à chaque venue :
      // les données ont pu changer depuis la dernière fois, et une liste
      // périmée induit en erreur.
      if (onglet.dataset.vue === 'emission' && ecranEmission) await ecranEmission.dessiner();
      if (onglet.dataset.vue === 'clients' && ecranClients) await ecranClients.dessiner();
      if (onglet.dataset.vue === 'recap' && ecranRecap) await ecranRecap.dessiner();
    });
  });
}

function brancherDepot() {
  const zone = $('#depot');
  const champ = $('#fichiers');

  zone.addEventListener('click', () => champ.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); champ.click(); }
  });
  champ.addEventListener('change', () => {
    recevoirFichiers([...champ.files]);
    champ.value = '';
  });

  for (const evenement of ['dragenter', 'dragover']) {
    zone.addEventListener(evenement, (e) => { e.preventDefault(); zone.classList.add('survol'); });
  }
  for (const evenement of ['dragleave', 'drop']) {
    zone.addEventListener(evenement, (e) => { e.preventDefault(); zone.classList.remove('survol'); });
  }
  zone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) recevoirFichiers([...e.dataTransfer.files]);
  });

  // Le glisser-déposer n'importe où sur la page, parce que c'est ce que les gens
  // font — la zone dessinée n'est pas toujours celle qu'on vise.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.target.closest('#depot')) return;
    if (e.dataTransfer && e.dataTransfer.files.length) recevoirFichiers([...e.dataTransfer.files]);
  });
}

function brancherDonnees() {
  $('#exporter').addEventListener('click', exporterSauvegarde);
  $('#importer').addEventListener('click', () => $('#fichier-sauvegarde').click());
  $('#fichier-sauvegarde').addEventListener('change', (e) => {
    if (e.target.files[0]) importerSauvegarde(e.target.files[0]);
    e.target.value = '';
  });
  $('#chercher-maj').addEventListener('click', async () => {
    if (!navigator.serviceWorker) { dire('Ce navigateur ne gère pas les mises à jour hors ligne.', 'attention'); return; }
    const enregistrement = await navigator.serviceWorker.getRegistration();
    if (!enregistrement) { dire('Application non installée : rien à mettre à jour.', 'info'); return; }
    await enregistrement.update();
    dire('Recherche lancée. Une nouvelle version s\'installera au prochain démarrage.', 'info');
  });
}

async function ouvrirStockage() {
  try {
    const magasin = await ouvrirMagasin();
    stockageDurable = await demanderConservationDurable();
    return creerDepot(magasin);
  } catch (erreur) {
    dire(`${erreur.message} Les factures déposées ne seront pas conservées après fermeture.`,
      'erreur', 12000);
    return creerDepot(magasinMemoire());
  }
}

/* ---------- Édition et licence ---------- */

async function afficherLicence() {
  const licence = await depot.licence();
  const quota = await depot.quota();
  const zone = $('#etat-licence');

  if (licence.edition === 'pro') {
    zone.innerHTML = `<strong>Édition Pro</strong>${licence.titulaire ? ` — ${licence.titulaire}` : ''}`
      + (licence.expire_le ? `<br>Valable jusqu'au ${jour(licence.expire_le)}.` : '')
      + '<br>Factures illimitées, devis, acomptes et export comptable.';
    return;
  }

  const rappel = messageQuota(quota);
  zone.innerHTML = '<strong>Édition Découverte</strong> — gratuite, sans inscription.<br>'
    + `${quota.emises} facture${quota.emises > 1 ? 's' : ''} émise${quota.emises > 1 ? 's' : ''} `
    + `sur ${quota.plafond} pour ${quota.annee}. `
    + 'La réception des factures et la conformité Factur-X ne sont jamais limitées.'
    + (rappel ? `<br><span style="color:var(--attention)">${rappel}</span>` : '')
    + (licence.refus ? `<br><span style="color:var(--alerte)">${licence.refus}</span>` : '');
}

function brancherLicence() {
  $('#activer-licence').addEventListener('click', async () => {
    const cle = $('#cle-licence').value.trim();
    if (!cle) { dire('Collez la clé reçue à l\'achat.', 'attention'); return; }
    try {
      const verdict = await depot.enregistrerLicence(cle);
      $('#cle-licence').value = '';
      await afficherLicence();
      dire(`Édition Pro activée${verdict.titulaire ? ` pour ${verdict.titulaire}` : ''}.`, 'reussite');
    } catch (erreur) {
      dire(erreur.message, 'erreur', 10000);
    }
  });

  $('#retirer-licence').addEventListener('click', async () => {
    if (!window.confirm('Retirer la licence de cet appareil ? Vos factures restent intactes.')) return;
    await depot.retirerLicence();
    await afficherLicence();
    dire('Licence retirée : retour à l\'édition Découverte.', 'info');
  });
}

function afficherEtat() {
  $('#version').textContent = `version ${VERSION}`;
  $('#etat-version').textContent = `Version installée : ${VERSION}`;
  $('#etat-stockage').textContent = stockageDurable.durable
    ? 'Le navigateur conserve durablement vos données sur cet appareil.'
    : 'Le navigateur n\'a pas accordé de conservation durable : il pourrait effacer '
      + 'les données s\'il manque d\'espace. Gardez une sauvegarde récente.';
}

async function demarrer() {
  brancherOnglets();
  brancherDepot();
  brancherDonnees();
  brancherLicence();
  $('#recherche').addEventListener('input', dessinerListe);
  $('#filtre-statut').addEventListener('change', dessinerListe);

  depot = await ouvrirStockage();
  ecranEmission = creerEcranEmission({ depot, dire, racine: $('#vue-emission') });
  ecranClients = creerEcranClients({ depot, dire, racine: $('#vue-clients') });
  ecranRecap = creerEcranRecap({ depot, racine: $('#vue-recap'),
    ouvrirDocument: id => ecranEmission.consulterDocument(id) });

  // Ne pas remplacer les données derrière un formulaire encore ouvert.
  const formulaireOuvert = () => Boolean(document.querySelector('#f-enregistrer, #c-enregistrer'))
    || Boolean($('#e-enregistrer') && !$('#vue-emission').hidden);
  const sync = creerSync({ depot, peutImporter: () => !formulaireOuvert() });
  const lien = new URL(location.href);
  const fragment = new URLSearchParams(lien.hash.slice(1));
  const idLien = fragment.get('sync') || lien.searchParams.get('sync');
  if (idLien) {
    lien.searchParams.delete('sync');
    fragment.delete('sync');
    lien.hash = fragment.toString();
    history.replaceState({}, '', lien.pathname + lien.search + lien.hash);
    try {
      await sync.activer(idLien);
    } catch (erreur) { dire(erreur.message, 'attention'); }
  }
  if (await sync.estActive()) {
    const panneau = document.createElement('div');
    panneau.className = 'carte';
    panneau.innerHTML = '<h3>Synchronisation PC / téléphone</h3>'
      + '<p id="sync-etat" role="status" aria-live="polite">Vérification…</p>'
      + '<button id="sync-maintenant">Synchroniser maintenant</button>';
    $('#vue-donnees').prepend(panneau);
    let enCours = false;
    let dernierMessage = '';
    const actualiserSync = async () => {
      if (enCours) return;
      enCours = true;
      try {
        const r = await sync.synchroniser();
        const erreur = r.tirage.erreur || r.poussee.erreur;
        $('#sync-etat').textContent = erreur || (r.tirage.attente
          ? 'En attente de la première fiche enregistrée sur un appareil.' : r.tirage.differee
          ? 'Réception en attente : enregistrez ou fermez le formulaire ouvert.'
          : `Données enregistrées synchronisées à ${new Date().toLocaleTimeString('fr-FR')}.`);
        if (erreur && erreur !== dernierMessage) dire(erreur, 'attention', 10000);
        dernierMessage = erreur || '';
        if (r.tirage.fait) {
          await rafraichir();
          await afficherLicence();
          if (!$('#vue-recap').hidden) await ecranRecap.dessiner();
          if (!formulaireOuvert()) {
            await ecranEmission.dessiner();
            await ecranClients.dessiner();
          }
        }
      } finally { enCours = false; }
    };
    $('#sync-maintenant').addEventListener('click', actualiserSync);
    await actualiserSync();
    let envoiProgramme;
    // Publier rapidement après un enregistrement réussi, sans attendre le timer.
    for (const nom of ['enregistrerEntreprise', 'enregistrerClient', 'enregistrerBrouillon',
      'emettre', 'annulerEmission', 'creerAvoir', 'ajouterRecue', 'changerStatutRecue',
      'enregistrerLicence', 'retirerLicence']) {
      const operation = depot[nom];
      depot[nom] = async (...args) => {
        const resultat = await operation(...args);
        clearTimeout(envoiProgramme);
        envoiProgramme = setTimeout(actualiserSync, 500);
        return resultat;
      };
    }
    setInterval(() => {
      if (document.visibilityState === 'visible') actualiserSync();
    }, 15000);
    document.addEventListener('visibilitychange', () => {
      actualiserSync();
    });
    window.addEventListener('online', actualiserSync);
    // Les deux onglets d'un même navigateur doivent sérialiser leurs échanges.
    // La révision distante protège également les appareils distincts.
    if (!navigator.locks) {
      $('#sync-etat').textContent += ' Gardez une seule fenêtre de KDL Facture ouverte sur cet appareil.';
    }
  }

  afficherEtat();
  await afficherLicence();
  await rafraichir();
  await ecranEmission.dessiner();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      dire("L'installation hors ligne n'a pas pu se faire.", 'attention');
    });
    // Une nouvelle version prend la main immédiatement (skipWaiting) : on
    // recharge une fois pour que la page affichée corresponde au code servi.
    let dejaRecharge = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (dejaRecharge) return;
      dejaRecharge = true;
      location.reload();
    });
  }

  // Ouverture directe sur un onglet, depuis les raccourcis du manifeste.
  const vue = new URLSearchParams(location.search).get('vue');
  if (vue) {
    const onglet = document.querySelector(`.onglet[data-vue="${vue}"]`);
    if (onglet) onglet.click();
  }
}

demarrer();
