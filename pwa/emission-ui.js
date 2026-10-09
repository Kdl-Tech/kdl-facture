/**
 * L'écran d'émission de la version installable.
 *
 * Une facture se saisit vite ou ne se saisit pas : un artisan la fait le soir,
 * fatigué, entre deux chantiers. D'où le parti pris — une seule page, le client
 * et les lignes sous les yeux, le total qui se met à jour à chaque frappe, et
 * aucune étape qui ne serve qu'à rassurer le logiciel.
 *
 * Les règles, elles, ne sont pas ici : la numérotation, le scellement et le
 * refus de modifier un document émis viennent de `emission.js`, partagé avec la
 * version de bureau. Cet écran ne fait que les rendre visibles.
 */

import { tauxDisponibles, devinerPrecis, TERRITOIRES } from '../src/territoires.js';
import { calculerDocument } from '../src/calculs.js';
import { genererPDFNavigateur } from '../src/pwa/pdf-navigateur.js';
import { composerMessage, lienMailto } from '../src/pwa/message-facture.js';
import { recapitulerDevis } from '../src/pwa/recap-devis.js';

const $ = (s, racine = document) => racine.querySelector(s);
const euros = (v) => `${Number(v || 0).toFixed(2).replace('.', ',')} €`;
const jour = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—');
const aujourdhui = () => new Date().toISOString().slice(0, 10);

function echapper(texte) {
  return String(texte ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/**
 * Les prestations et tarifs affichés sur kdl-tech.fr — un point de départ,
 * pas une contrainte. Choisir une ligne du catalogue préremplit la
 * désignation et le prix ; les deux restent des champs normaux, modifiables
 * comme n'importe quelle ligne saisie à la main quand le cas diffère.
 */
const CATALOGUE = [
  { designation: 'Diagnostic', prix_ht: 30, unite: 'forfait' },
  { designation: 'Diagnostic du support (récupération de données)', prix_ht: 30, unite: 'forfait' },
  { designation: 'Récupération de données', prix_ht: 60, unite: 'forfait' },
  { designation: 'Assistance à distance (jusqu\'à 30 min)', prix_ht: 29, unite: 'forfait' },
  { designation: 'Assistance à distance (jusqu\'à 1h)', prix_ht: 49, unite: 'forfait' },
  { designation: 'Intervention à domicile (jusqu\'à 1h)', prix_ht: 49, unite: 'forfait' },
  { designation: 'Réinstallation système + pilotes', prix_ht: 90, unite: 'forfait' },
  { designation: 'Nettoyage virus / lenteurs', prix_ht: 70, unite: 'forfait' },
  { designation: 'Dépoussiérage + pâte thermique', prix_ht: 60, unite: 'forfait' },
  { designation: 'Assemblage PC (gamer ou bureau)', prix_ht: 95, unite: 'forfait' },
  { designation: 'Frais de déplacement', prix_ht: 0, unite: 'forfait' },
];

export function creerEcranEmission({ depot, dire, racine }) {
  let entreprise = null;
  let clients = [];
  let brouillon = null;
  let vueDocuments = 'tous';

  /* ---------- Mon entreprise ---------- */

  function formulaireEntreprise() {
    const e = entreprise || {};
    return `
      <div class="carte">
        <div class="titre">Mon entreprise</div>
        <p class="secondaire" style="margin:.3em 0 1em;color:var(--texte-doux)">
          Ces informations apparaissent sur chaque facture. Le SIRET et le régime de TVA
          déterminent ce que la loi vous impose d'y faire figurer.
        </p>
        <div class="grille">
          <label>Nom ou raison sociale<input id="e-nom" value="${echapper(e.nom || '')}"></label>
          <label>SIRET<input id="e-siret" value="${echapper(e.siret || '')}" inputmode="numeric"
            placeholder="14 chiffres"></label>
          <label>SIREN<input id="e-siren" value="${echapper(e.siren || '')}" inputmode="numeric"
            placeholder="9 chiffres"></label>
          <label>N° TVA intracommunautaire<input id="e-tva" value="${echapper(e.tva_intra || '')}"
            placeholder="laisser vide en franchise"></label>
          <label class="large">Adresse<input id="e-adresse" value="${echapper(e.adresse || '')}"></label>
          <label>Code postal<input id="e-cp" value="${echapper(e.code_postal || '')}"></label>
          <label>Ville<input id="e-ville" value="${echapper(e.ville || '')}"></label>
          <label>IBAN<input id="e-iban" value="${echapper(e.iban || '')}"></label>
          <label>Courriel<input id="e-email" value="${echapper(e.email || '')}" type="email"></label>
          <label>Régime de TVA
            <select id="e-regime">
              <option value="franchise" ${e.regime_tva === 'franchise' ? 'selected' : ''}>
                Franchise en base (auto-entrepreneur)
              </option>
              <option value="normal" ${e.regime_tva === 'normal' ? 'selected' : ''}>
                Assujetti à la TVA
              </option>
            </select>
          </label>
        </div>
        <p id="e-territoire" class="secondaire" style="color:var(--texte-doux);margin:12px 0 0"></p>
        <div class="suite" style="margin-top:14px">
          <button class="premier" id="e-enregistrer">Enregistrer</button>
        </div>
      </div>`;
  }

  function direTerritoire() {
    const cp = $('#e-cp').value;
    const cle = devinerPrecis(cp);
    const t = TERRITOIRES[cle];
    const zone = $('#e-territoire');
    if (!t || !cp) { zone.textContent = ''; return; }
    const taux = (t.taux || []).filter((x) => x > 0);
    zone.textContent = taux.length
      ? `${t.nom} — taux applicables : ${taux.map((x) => String(x).replace('.', ',')).join(' %, ')} %.`
      : `${t.nom} — TVA non applicable (${t.base}).`;
  }

  async function enregistrerEntreprise() {
    const fiche = {
      ...(entreprise || {}),
      nom: $('#e-nom').value.trim(),
      siret: $('#e-siret').value.replace(/\s/g, ''),
      siren: $('#e-siren').value.replace(/\s/g, ''),
      tva_intra: $('#e-tva').value.trim(),
      adresse: $('#e-adresse').value.trim(),
      code_postal: $('#e-cp').value.trim(),
      ville: $('#e-ville').value.trim(),
      iban: $('#e-iban').value.replace(/\s/g, ''),
      email: $('#e-email').value.trim(),
      regime_tva: $('#e-regime').value,
      pays: 'FR',
    };
    if (!fiche.siren && /^\d{14}$/.test(fiche.siret)) fiche.siren = fiche.siret.slice(0, 9);
    fiche.territoire = devinerPrecis(fiche.code_postal);

    if (!fiche.nom) { dire('Le nom de votre entreprise est nécessaire.', 'attention'); return; }
    await depot.enregistrerEntreprise(fiche);
    entreprise = await depot.monEntreprise();
    dire('Entreprise enregistrée.', 'reussite');
    await dessiner();
  }

  /* ---------- Saisie d'une facture ---------- */

  function ligneVide() {
    return {
      designation: '', quantite: 1, prix_ht: 0, tva_taux: tauxParDefaut(), unite: 'unite',
    };
  }

  function tauxParDefaut() {
    const taux = tauxDisponibles(entreprise || {});
    return taux[0] || 0;
  }

  function formulaireFacture() {
    const d = brouillon;
    const taux = tauxDisponibles(entreprise);
    const franchise = entreprise.regime_tva === 'franchise';

    const lignes = d.lignes.map((l, i) => `
      <tr data-ligne="${i}">
        <td><input class="l-designation" value="${echapper(l.designation)}" placeholder="Prestation ou article"></td>
        <td><input class="l-quantite nombre" value="${l.quantite}" inputmode="decimal" size="5"></td>
        <td>
          <select class="l-unite">
            ${['heure', 'jour', 'unite', 'piece', 'forfait', 'km'].map((u) => `<option value="${u}" ${l.unite === u ? 'selected' : ''}>${u}</option>`).join('')}
          </select>
        </td>
        <td><input class="l-prix nombre" value="${l.prix_ht}" inputmode="decimal" size="8"></td>
        <td>
          <select class="l-taux" ${franchise ? 'disabled' : ''}>
            ${taux.map((t) => `<option value="${t}" ${Number(l.tva_taux) === t ? 'selected' : ''}>${String(t).replace('.', ',')} %</option>`).join('')}
          </select>
        </td>
        <td class="nombre" data-total="${i}">—</td>
        <td><button class="discret l-retirer" title="Retirer">✕</button></td>
      </tr>`).join('');

    const titreFormulaire = d.type === 'avoir' ? 'Nouvel avoir'
      : (d.type === 'devis' ? 'Nouveau devis' : 'Nouvelle facture');

    return `
      <div class="carte" style="margin-bottom:16px">
        <div class="titre">${titreFormulaire}</div>
        <div class="grille">
          <label>Client
            <select id="f-client">
              <option value="">— choisir —</option>
              ${clients.map((c) => `<option value="${c.id}" ${d.client_id === c.id ? 'selected' : ''}>${echapper(c.nom)}</option>`).join('')}
            </select>
          </label>
          <label>&nbsp;<button id="f-nouveau-client">Nouveau client</button></label>
          <label>Date d'émission<input type="date" id="f-date" value="${d.date_emission}"></label>
          <label>${d.type === 'devis' ? 'Valable jusqu\'au' : 'Échéance'}<input type="date" id="f-echeance" value="${d.date_echeance || ''}"></label>
          ${d.type === 'devis' ? '' : `
          <label>Nature
            <select id="f-categorie">
              <option value="services" ${d.categorie === 'services' ? 'selected' : ''}>Services</option>
              <option value="biens" ${d.categorie === 'biens' ? 'selected' : ''}>Biens</option>
              <option value="mixte" ${d.categorie === 'mixte' ? 'selected' : ''}>Les deux</option>
            </select>
          </label>
          <label>Paiement
            <select id="f-paiement">
              <option value="virement" ${d.mode_paiement === 'virement' ? 'selected' : ''}>Virement</option>
              <option value="especes" ${d.mode_paiement === 'especes' ? 'selected' : ''}>Espèces</option>
              <option value="carte" ${d.mode_paiement === 'carte' ? 'selected' : ''}>Carte</option>
              <option value="cheque" ${d.mode_paiement === 'cheque' ? 'selected' : ''}>Chèque</option>
            </select>
          </label>`}
        </div>
      </div>

      <table class="tableau" style="margin-bottom:14px">
        <thead>
          <tr>
            <th>Désignation</th><th>Qté</th><th>Unité</th><th>Prix HT</th>
            <th>TVA</th><th class="nombre">Total HT</th><th></th>
          </tr>
        </thead>
        <tbody id="f-lignes">${lignes}</tbody>
      </table>

      <div class="suite" style="margin-bottom:18px">
        <button id="f-ajouter">+ Ligne vide</button>
        <select id="f-catalogue" aria-label="Ajouter une prestation du catalogue">
          <option value="">+ Depuis le catalogue…</option>
          ${CATALOGUE.map((p, i) => `<option value="${i}">${echapper(p.designation)} — ${euros(p.prix_ht)}</option>`).join('')}
        </select>
      </div>

      <div class="carte">
        <div id="f-totaux"></div>
        ${franchise ? '<p class="secondaire" style="color:var(--texte-doux);margin:10px 0 0">Franchise en base : « TVA non applicable, article 293 B du CGI » sera portée sur la facture.</p>' : ''}
        <div class="suite" style="margin-top:16px">
          <button id="f-enregistrer">Enregistrer le brouillon</button>
          <button class="premier" id="f-emettre">${d.type === 'devis' ? 'Émettre le devis' : 'Émettre la facture'}</button>
          <button class="discret" id="f-abandonner">Abandonner</button>
        </div>
      </div>`;
  }

  function lireFormulaire() {
    brouillon.client_id = Number($('#f-client').value) || null;
    brouillon.date_emission = $('#f-date').value;
    brouillon.date_echeance = $('#f-echeance').value;
    const categorie = $('#f-categorie');
    const paiement = $('#f-paiement');
    if (categorie) brouillon.categorie = categorie.value;
    if (paiement) brouillon.mode_paiement = paiement.value;
    brouillon.lignes = [...racine.querySelectorAll('#f-lignes tr')].map((tr) => ({
      designation: $('.l-designation', tr).value,
      quantite: Number(String($('.l-quantite', tr).value).replace(',', '.')) || 0,
      unite: $('.l-unite', tr).value,
      prix_ht: Number(String($('.l-prix', tr).value).replace(',', '.')) || 0,
      tva_taux: Number($('.l-taux', tr).value) || 0,
    }));
  }

  function actualiserTotaux() {
    const totaux = calculerDocument(brouillon.lignes, {});
    totaux.lignes.forEach((l, i) => {
      const cellule = racine.querySelector(`[data-total="${i}"]`);
      if (cellule) cellule.textContent = euros(l.montant_ht);
    });
    const ventilation = totaux.ventilation_tva
      .filter((v) => v.montant_tva)
      .map((v) => `<div class="paire"><dt>TVA ${String(v.taux).replace('.', ',')} %</dt><dd>${euros(v.montant_tva)}</dd></div>`)
      .join('');
    $('#f-totaux').innerHTML = `
      <div class="paire"><dt>Total hors taxes</dt><dd>${euros(totaux.total_ht)}</dd></div>
      ${ventilation}
      <div class="paire fort"><dt>Total à payer</dt><dd>${euros(totaux.total_ttc)}</dd></div>`;
  }

  /* ---------- Liste des documents ---------- */

  const LIBELLES_TYPE = {
    facture: 'Facture', avoir: 'Avoir', acompte: "Facture d'acompte", devis: 'Devis',
  };

  async function listeDocuments() {
    const tous = await depot.listerDocuments();
    const recap = recapitulerDevis(tous);
    const documents = vueDocuments === 'devis' ? recap.devis : tous;
    const bilan = vueDocuments === 'devis' ? `
      <div class="carte" id="recap-devis" style="margin-bottom:16px">
        <h3>Récapitulatif des devis émis</h3>
        <p>Toutes années confondues · ${recap.nombre} devis émis</p>
        <div class="paire"><dt>Montant total HT</dt><dd>${euros(recap.total_ht)}</dd></div>
        <div class="paire fort"><dt>Montant total TTC</dt><dd>${euros(recap.total_ttc)}</dd></div>
        <p class="secondaire">Ces montants correspondent aux devis établis, pas à du chiffre d’affaires encaissé.
        Ouvrez une ligne pour consulter le devis ou enregistrer son PDF.</p>
      </div>` : '';
    if (!documents.length) {
      if (vueDocuments === 'devis') return bilan + '<div class="vide"><p>Aucun devis émis pour le moment.</p></div>';
      return `
        <div class="vide">
          <div class="grand">Aucun document pour l'instant</div>
          <p>Établissez votre premier devis ou votre première facture : le PDF sort<br>
          à la même adresse, conforme Factur-X pour une facture, prêt à envoyer pour un devis.</p>
        </div>`;
    }

    const clientsParId = new Map(clients.map((c) => [c.id, c.nom]));
    const lignes = documents.map((d) => {
      const totaux = calculerDocument(d.lignes || [], { acompte: d.acompte });
      const typeLabel = LIBELLES_TYPE[d.type] || 'Facture';
      return `
        <tr data-document="${d.id}" tabindex="0">
          <td>
            <div class="principal">${d.numero ? echapper(d.numero) : `${typeLabel} — brouillon`}</div>
            <div class="secondaire">${echapper(clientsParId.get(d.client_id) || '—')}${d.numero ? ` · ${typeLabel}` : ''}</div>
          </td>
          <td class="masquable secondaire">${jour(d.date_emission)}</td>
          <td class="nombre principal">${euros(totaux.total_ttc)}</td>
          <td>
            <span class="pastille ${d.statut === 'emis' ? 'conforme' : 'statut'}">
              ${d.statut === 'emis' ? (d.type === 'devis' ? 'Émis' : 'Émise') : 'Brouillon'}
            </span>
          </td>
        </tr>`;
    }).join('');

    return bilan + `
      <table class="tableau">
        <thead>
          <tr><th>Numéro</th><th class="masquable">Date</th><th class="nombre">Total TTC</th><th>État</th></tr>
        </thead>
        <tbody>${lignes}</tbody>
      </table>`;
  }

  /* ---------- Actions ---------- */

  async function telecharger(document_) {
    const client = clients.find((c) => c.id === document_.client_id);
    const blob = await genererPDFNavigateur({
      document: document_, entreprise, client, lignes: document_.lignes || [], paiements: [],
    });
    const lien = window.document.createElement('a');
    lien.href = URL.createObjectURL(blob);
    lien.download = `${document_.numero || 'brouillon'}.pdf`;
    lien.click();
    URL.revokeObjectURL(lien.href);
  }

  /**
   * Remet la facture à l'application de courrier de l'appareil.
   *
   * Sur téléphone, le partage natif attache vraiment le PDF : c'est le seul
   * chemin qui donne un envoi complet en un geste. Ailleurs, aucun navigateur
   * ne permet de joindre un fichier à un `mailto:` — le PDF est alors
   * enregistré et le message ouvert pré-rempli, à charge de l'y glisser.
   *
   * Le logiciel n'envoie rien lui-même et ne connaît aucun serveur de courrier :
   * c'est le compte de messagerie de l'appareil qui expédie.
   */
  async function envoyerParMail(document_) {
    const client = clients.find((c) => c.id === document_.client_id);
    if (!client) throw new Error('Cette facture n\'a pas de client : impossible de l\'adresser.');

    let destinataire = (client.email || '').trim();
    if (!destinataire) {
      const saisi = window.prompt(`Courriel de ${client.nom} :`, '');
      if (saisi === null) return 'abandon';
      destinataire = saisi.trim();
      if (!destinataire) throw new Error('Sans adresse, la facture ne peut pas être envoyée.');
      // Retenu pour les prochaines factures : on ne redemande pas deux fois.
      await depot.enregistrerClient({ ...client, email: destinataire });
      client.email = destinataire;
    }

    const message = composerMessage({
      document: document_, entreprise, client: { ...client, email: destinataire },
    });
    const blob = await genererPDFNavigateur({
      document: document_, entreprise, client, lignes: document_.lignes || [], paiements: [],
    });

    const fichier = new File([blob], message.nomFichier, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [fichier] })) {
      try {
        await navigator.share({ files: [fichier], title: message.objet, text: message.corps });
        return 'partage';
      } catch (erreur) {
        // Refermer la feuille de partage n'est pas une panne.
        if (erreur && erreur.name === 'AbortError') return 'abandon';
        // Activation expirée ou partage refusé : on continue par le courrier.
      }
    }

    const lien = window.document.createElement('a');
    lien.href = URL.createObjectURL(blob);
    lien.download = message.nomFichier;
    lien.click();
    URL.revokeObjectURL(lien.href);
    window.location.href = lienMailto(message);
    return 'courrier';
  }

  function direEnvoi(resultat, numero) {
    if (resultat === 'abandon') return;
    if (resultat === 'partage') dire(`${numero} transmise à votre application de courrier.`, 'reussite');
    else dire(`${numero} enregistrée : joignez le PDF au message qui vient de s'ouvrir.`,
      'reussite', 10000);
  }

  async function ouvrirDocument(id) {
    const d = await depot.obtenirDocument(id);
    if (!d) return;
    if (d.statut !== 'emis') {
      brouillon = { ...d, lignes: d.lignes || [ligneVide()] };
      await dessiner();
      return;
    }

    const client = clients.find((c) => c.id === d.client_id);
    const totaux = calculerDocument(d.lignes || [], { acompte: d.acompte });
    const estDevis = d.type === 'devis';
    const typeLabel = LIBELLES_TYPE[d.type] || 'Facture';
    const voile = window.document.createElement('div');
    voile.className = 'voile';
    const tiroir = window.document.createElement('aside');
    tiroir.className = 'tiroir';
    tiroir.innerHTML = `
      <button class="discret fermer" id="fermer-doc" aria-label="Fermer">✕</button>
      <h2>${echapper(d.numero)}</h2>
      <div class="sous-titre">
        ${echapper(client ? client.nom : '—')} · ${typeLabel.toLowerCase()} ${estDevis ? 'établi' : 'émise'} le ${jour(d.date_emission)}
      </div>
      <div class="bloc">
        <h3>Montants</h3>
        <div class="paire"><dt>Total hors taxes</dt><dd>${euros(totaux.total_ht)}</dd></div>
        <div class="paire"><dt>TVA</dt><dd>${euros(totaux.total_tva)}</dd></div>
        <div class="paire fort"><dt>${estDevis ? 'Total' : 'À payer'}</dt><dd>${euros(totaux.total_ttc)}</dd></div>
      </div>
      <div class="bloc">
        <h3>Sceau</h3>
        <p class="secondaire" style="color:var(--texte-doux);word-break:break-all;font-size:12.5px">
          ${echapper(d.empreinte || '—')}
        </p>
        <p class="secondaire" style="color:var(--texte-doux)">
          Cette empreinte change au moindre centime modifié : elle prouve que ${estDevis ? 'le devis remis est bien celui' : 'la facture remise est bien celle'} que vous avez conservé${estDevis ? '' : 'e'}.
        </p>
      </div>
      <div class="bloc">
        <h3>Actions</h3>
        <div class="suite">
          <button class="premier" id="doc-mail">Envoyer par mail</button>
          <button id="doc-pdf">Enregistrer le PDF</button>
          ${estDevis ? '<button id="doc-facturer">Transformer en facture</button>' : '<button id="doc-avoir">Établir un avoir</button>'}
          <button class="danger" id="doc-annuler">Annuler l'émission</button>
        </div>
      </div>`;

    window.document.body.append(voile, tiroir);
    const fermer = () => { voile.remove(); tiroir.remove(); };
    voile.addEventListener('click', fermer);
    $('#fermer-doc', tiroir).addEventListener('click', fermer);

    $('#doc-mail', tiroir).addEventListener('click', async () => {
      try {
        direEnvoi(await envoyerParMail(d), d.numero);
      } catch (erreur) {
        dire(erreur.message, 'erreur', 9000);
      }
    });

    $('#doc-pdf', tiroir).addEventListener('click', async () => {
      try {
        await telecharger(d);
        dire(`PDF de ${d.numero} enregistré.`, 'reussite');
      } catch (erreur) {
        dire(erreur.message, 'erreur', 9000);
      }
    });

    const boutonAvoir = $('#doc-avoir', tiroir);
    if (boutonAvoir) {
      boutonAvoir.addEventListener('click', async () => {
        const motif = window.prompt(`Motif de l'avoir sur ${d.numero} :`, '');
        if (motif === null) return;
        await depot.creerAvoir(d.id, { motif });
        fermer();
        await dessiner();
        dire('Avoir créé en brouillon : vérifiez-le puis émettez-le.', 'reussite');
      });
    }

    const boutonFacturer = $('#doc-facturer', tiroir);
    if (boutonFacturer) {
      boutonFacturer.addEventListener('click', async () => {
        fermer();
        brouillon = {
          type: 'facture',
          client_id: d.client_id,
          date_emission: aujourdhui(),
          date_echeance: '',
          categorie: 'services',
          mode_paiement: 'virement',
          note: d.numero ? `Devis ${d.numero} accepté.` : '',
          lignes: (d.lignes || []).map((l) => ({ ...l })),
        };
        await dessiner();
        dire(`Facture préremplie depuis le devis ${d.numero} : vérifiez-la avant d'émettre.`, 'reussite', 8000);
      });
    }

    $('#doc-annuler', tiroir).addEventListener('click', async () => {
      try {
        await depot.annulerEmission(d.id);
        fermer();
        await dessiner();
        dire(`${d.numero} est redevenue un brouillon, son numéro repart dans la suite.`, 'reussite');
      } catch (erreur) {
        dire(erreur.message, 'erreur', 11000);
      }
    });
  }

  /* ---------- Assemblage ---------- */

  async function dessiner() {
    racine.oninput = null;
    racine.onchange = null;
    entreprise = await depot.monEntreprise();
    clients = await depot.listerClients();

    if (!entreprise) {
      racine.innerHTML = formulaireEntreprise();
      $('#e-enregistrer').addEventListener('click', enregistrerEntreprise);
      $('#e-cp').addEventListener('input', direTerritoire);
      direTerritoire();
      return;
    }

    if (brouillon) {
      racine.innerHTML = formulaireFacture();
      brancherFormulaire();
      actualiserTotaux();
      return;
    }

    racine.innerHTML = `
      <div class="barre-liste">
        <h2>Mes devis et factures</h2>
        <div class="espace"></div>
        <button id="d-entreprise">Mon entreprise</button>
        <button id="d-nouveau-devis">Nouveau devis</button>
        <button class="premier" id="d-nouvelle">Nouvelle facture</button>
      </div>
      <div class="suite" role="group" aria-label="Documents affichés" style="margin-bottom:16px">
        <button id="d-tous" aria-pressed="${vueDocuments === 'tous'}">Tous les documents</button>
        <button id="d-devis-emis" aria-pressed="${vueDocuments === 'devis'}">Devis émis</button>
      </div>
      ${await listeDocuments()}`;

    $('#d-tous').addEventListener('click', async () => { vueDocuments = 'tous'; await dessiner(); });
    $('#d-devis-emis').addEventListener('click', async () => { vueDocuments = 'devis'; await dessiner(); });

    const nouveauBrouillon = (type) => ({
      type,
      client_id: clients.length === 1 ? clients[0].id : null,
      date_emission: aujourdhui(),
      date_echeance: '',
      ...(type === 'devis' ? {} : { categorie: 'services', mode_paiement: 'virement' }),
      lignes: [ligneVide()],
    });

    $('#d-nouvelle').addEventListener('click', async () => {
      brouillon = nouveauBrouillon('facture');
      await dessiner();
    });

    $('#d-nouveau-devis').addEventListener('click', async () => {
      brouillon = nouveauBrouillon('devis');
      await dessiner();
    });

    $('#d-entreprise').addEventListener('click', () => {
      racine.innerHTML = formulaireEntreprise();
      $('#e-enregistrer').addEventListener('click', enregistrerEntreprise);
      $('#e-cp').addEventListener('input', direTerritoire);
      direTerritoire();
    });

    racine.querySelectorAll('tr[data-document]').forEach((tr) => {
      const ouvrir = () => ouvrirDocument(Number(tr.dataset.document));
      tr.addEventListener('click', ouvrir);
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') ouvrir();
      });
    });
  }

  function brancherFormulaire() {
    racine.oninput = () => { lireFormulaire(); actualiserTotaux(); };
    racine.onchange = () => { lireFormulaire(); actualiserTotaux(); };

    $('#f-ajouter').addEventListener('click', async () => {
      lireFormulaire();
      brouillon.lignes.push(ligneVide());
      await dessiner();
    });

    $('#f-catalogue').addEventListener('change', async (e) => {
      // La resynchronisation générique (racine → brouillon, plus bas) partirait
      // relire le DOM pas encore à jour et effacerait la ligne qu'on ajoute ici.
      e.stopPropagation();
      const item = CATALOGUE[Number(e.target.value)];
      if (!item) return;
      lireFormulaire();
      // Une ligne blanche laissée par la première saisie ne sert à rien une
      // fois qu'une prestation du catalogue arrive : on la remplace plutôt
      // que d'empiler une ligne vide dessous.
      const derniere = brouillon.lignes[brouillon.lignes.length - 1];
      const cible = (derniere && !derniere.designation && Number(derniere.prix_ht) === 0)
        ? derniere : null;
      const ligne = {
        designation: item.designation, quantite: 1, unite: item.unite,
        prix_ht: item.prix_ht, tva_taux: tauxParDefaut(),
      };
      if (cible) Object.assign(cible, ligne); else brouillon.lignes.push(ligne);
      await dessiner();
    });

    racine.querySelectorAll('.l-retirer').forEach((bouton, i) => {
      bouton.addEventListener('click', async () => {
        lireFormulaire();
        if (brouillon.lignes.length === 1) { dire('Une facture a au moins une ligne.', 'attention'); return; }
        brouillon.lignes.splice(i, 1);
        await dessiner();
      });
    });

    $('#f-nouveau-client').addEventListener('click', async () => {
      const nom = window.prompt('Nom du client :');
      if (!nom) return;
      const siret = window.prompt('SIRET du client (14 chiffres, obligatoire entre professionnels) :', '') || '';
      const adresse = window.prompt('Adresse :', '') || '';
      const cp = window.prompt('Code postal :', '') || '';
      const ville = window.prompt('Ville :', '') || '';
      const email = window.prompt('Courriel (pour lui envoyer ses factures) :', '') || '';
      lireFormulaire();
      const id = await depot.enregistrerClient({
        type: 'entreprise',
        nom,
        siret: siret.replace(/\s/g, ''),
        siren: /^\d{14}$/.test(siret.replace(/\s/g, '')) ? siret.replace(/\s/g, '').slice(0, 9) : '',
        adresse,
        code_postal: cp,
        ville,
        email: email.trim(),
        pays: 'FR',
      });
      brouillon.client_id = id;
      await dessiner();
    });

    $('#f-enregistrer').addEventListener('click', async () => {
      lireFormulaire();
      const id = await depot.enregistrerBrouillon(brouillon);
      brouillon = null;
      await dessiner();
      dire(`Brouillon enregistré (n° interne ${id}).`, 'reussite');
    });

    $('#f-abandonner').addEventListener('click', async () => {
      brouillon = null;
      await dessiner();
    });

    $('#f-emettre').addEventListener('click', async () => {
      lireFormulaire();
      try {
        const id = await depot.enregistrerBrouillon(brouillon);
        const emis = await depot.emettre(id);
        brouillon = null;
        await dessiner();
        const typeEmisLabel = LIBELLES_TYPE[emis.type] || 'Facture';
        dire(`${typeEmisLabel} ${emis.numero} émis${emis.type === 'devis' ? '' : 'e'}. Il${emis.type === 'devis' ? '' : 'le'} ne peut plus être modifié${emis.type === 'devis' ? '' : 'e'}.`, 'reussite', 7000);

        // Le moment naturel pour l'envoyer, c'est maintenant — mais sans forcer :
        // une facture s'imprime aussi, ou s'envoie plus tard depuis sa fiche.
        const destinataire = clients.find((c) => c.id === emis.client_id);
        if (destinataire
            && window.confirm(`Envoyer ${emis.numero} par mail à ${destinataire.nom} ?`)) {
          direEnvoi(await envoyerParMail(emis), emis.numero);
        } else {
          await telecharger(emis);
        }
      } catch (erreur) {
        dire(erreur.message, 'erreur', 12000);
      }
    });
  }

  return { dessiner, consulterDocument: async id => {
    entreprise = await depot.monEntreprise();
    clients = await depot.listerClients();
    await ouvrirDocument(id);
  } };
}
