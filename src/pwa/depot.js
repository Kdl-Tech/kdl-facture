'use strict';

/**
 * Le stockage de la version installable.
 *
 * Dans la PWA, les données vivent chez l'utilisateur, dans son navigateur. Cela
 * évite tout serveur, toute inscription, tout envoi de facture à un tiers — et
 * cela impose deux devoirs : ne jamais perdre ce qui a été écrit, et savoir tout
 * ressortir en un clic. La sauvegarde n'est pas une option de confort ici, c'est
 * la contrepartie du choix « chez vous ».
 *
 * Le dépôt ne parle pas directement à IndexedDB : il passe par un magasin
 * abstrait. Cela permet de tester toute la logique sous Node sans navigateur, et
 * de changer de stockage plus tard sans réécrire les règles métier.
 *
 * Une TPE reçoit quelques centaines de factures par an. Le dépôt charge donc ce
 * dont il a besoin et calcule en mémoire, plutôt que de bâtir des index qui ne
 * serviraient jamais.
 */

const { chercherDoublon } = require('../reception');
const { changerStatut, STATUTS } = require('../reception/journal');
const {
  composerNumero, rangDuNumero, verifierNumerotation, sceller,
  peutAnnulerEmission, preparerAvoir, verifierModifiable,
} = require('../emission');
const { verifier } = require('../facturx');
const { verifierLicence, etatQuota, editionLibre } = require('../licence-portable');

const VERSION_DONNEES = 1;

/** Un magasin en mémoire : sert aux tests, et de repli si IndexedDB est refusé. */
function magasinMemoire(contenu = {}) {
  const tables = new Map();
  for (const [nom, elements] of Object.entries(contenu)) tables.set(nom, [...elements]);
  const table = (nom) => {
    if (!tables.has(nom)) tables.set(nom, []);
    return tables.get(nom);
  };
  return {
    async tous(nom) { return table(nom).map((o) => ({ ...o })); },
    async ajouter(nom, objet) {
      const liste = table(nom);
      const id = liste.reduce((max, o) => Math.max(max, o.id || 0), 0) + 1;
      liste.push({ ...objet, id });
      return id;
    },
    async remplacer(nom, objet) {
      const liste = table(nom);
      const i = liste.findIndex((o) => o.id === objet.id);
      if (i === -1) throw new Error('Élément introuvable.');
      liste[i] = { ...objet };
    },
    async vider(nom) { tables.set(nom, []); },
    async restaurer(contenu, attendu) {
      if (attendu && Object.entries(attendu).some(([nom, elements]) =>
        JSON.stringify(table(nom)) !== JSON.stringify(elements))) {
        throw new Error('Les données locales ont changé pendant la synchronisation. Réessayez.');
      }
      for (const [nom, elements] of Object.entries(contenu)) {
        tables.set(nom, structuredClone(elements));
      }
    },
  };
}

/**
 * @param {object} magasin le stockage (IndexedDB en vrai, mémoire pour les tests)
 * @param {{clePublique?: string, aujourdhui?: string}} [config] la clé qui valide
 *        les licences ; elle appartient au dépôt et non à chaque appel, sinon un
 *        seul oubli ferait silencieusement retomber un client payant en gratuit.
 */
function creerDepot(magasin, config = {}) {
  /**
   * Enregistre une facture reçue déjà lue et contrôlée.
   * Le doublon est refusé par défaut : c'est le seul garde-fou contre le
   * paiement en double, et il doit se franchir sciemment.
   */
  async function ajouterRecue(recue, options = {}) {
    const anciennes = await magasin.tous('recues');
    const doublon = chercherDoublon(recue, anciennes);
    if (doublon && !options.forcer) {
      return {
        enregistree: false,
        doublon: doublon.niveau,
        message: doublon.message,
        ancienne_id: doublon.ancienne.id,
      };
    }

    const maintenant = options.date || new Date().toISOString();
    const id = await magasin.ajouter('recues', {
      ...recue,
      version: VERSION_DONNEES,
      recue_le: maintenant,
      statut: 'recue',
      historique: [{ statut: 'recue', date: maintenant, motif: '', par: options.par || '' }],
    });
    return { enregistree: true, id, doublon: doublon ? doublon.niveau : null };
  }

  async function listerRecues(filtres = {}) {
    const toutes = await magasin.tous('recues');
    return toutes
      .filter((r) => (!filtres.statut || r.statut === filtres.statut))
      .filter((r) => (!filtres.verdict || r.controle.verdict === filtres.verdict))
      .filter((r) => (!filtres.fournisseur
        || (r.facture.fournisseur.nom || '').toLowerCase()
          .includes(String(filtres.fournisseur).toLowerCase())))
      .map((r) => ({ ...r, statut_libelle: (STATUTS[r.statut] || {}).libelle || r.statut }))
      .sort((a, b) => String(b.facture.date_emission).localeCompare(String(a.facture.date_emission)));
  }

  async function obtenirRecue(id) {
    const toutes = await magasin.tous('recues');
    return toutes.find((r) => r.id === id) || null;
  }

  async function changerStatutRecue(id, nouveau, details = {}) {
    const recue = await obtenirRecue(id);
    if (!recue) throw new Error('Cette facture reçue est introuvable.');
    const suite = changerStatut(recue, nouveau, details);
    await magasin.remplacer('recues', { ...recue, ...suite });
    return { id, statut: suite.statut, libelle: STATUTS[suite.statut].libelle };
  }

  /** Ce qu'on veut voir en ouvrant le logiciel : ce qui attend, ce qui presse. */
  async function resumeRecues(aujourdhui) {
    const jour = aujourdhui || new Date().toISOString().slice(0, 10);
    const toutes = await magasin.tous('recues');
    const cumul = (liste) => ({
      n: liste.length,
      total: Math.round(liste.reduce((s, r) => s + Number(r.facture.totaux.net_a_payer || 0), 0) * 100) / 100,
    });
    const enCours = toutes.filter((r) => ['recue', 'approuvee', 'en_paiement'].includes(r.statut));
    return {
      a_traiter: cumul(toutes.filter((r) => r.statut === 'recue')),
      a_payer: cumul(toutes.filter((r) => ['approuvee', 'en_paiement'].includes(r.statut))),
      en_retard: cumul(enCours.filter((r) => r.facture.date_echeance
        && r.facture.date_echeance < jour)),
      non_conformes: cumul(toutes.filter((r) => r.controle.verdict === 'non conforme')),
      payees: cumul(toutes.filter((r) => r.statut === 'encaissee')),
    };
  }

  /**
   * Toutes les données, dans un seul objet exportable.
   *
   * Quand les données vivent dans un navigateur, un « vider les données du
   * site » suffit à tout effacer. La sauvegarde doit donc être immédiate,
   * complète, et lisible sans le logiciel : c'est du JSON, pas un format maison.
   */
  async function exporter(magasins = ['recues', 'reglages', 'entreprises', 'clients', 'documents']) {
    const contenu = {};
    for (const nom of magasins) {
      // eslint-disable-next-line no-await-in-loop
      contenu[nom] = await magasin.tous(nom);
    }
    return {
      logiciel: 'KDL Facture',
      version_donnees: VERSION_DONNEES,
      exporte_le: new Date().toISOString(),
      contenu,
    };
  }

  /**
   * Restaure une sauvegarde. Le remplacement est total et annoncé comme tel :
   * une restauration partielle laisserait un mélange de deux états, pire que
   * les deux.
   */
  async function importer(sauvegarde, { attendu } = {}) {
    if (!sauvegarde || sauvegarde.logiciel !== 'KDL Facture' || !sauvegarde.contenu
      || typeof sauvegarde.contenu !== 'object' || Array.isArray(sauvegarde.contenu)) {
      throw new Error("Ce fichier n'est pas une sauvegarde de KDL Facture.");
    }
    if (Number(sauvegarde.version_donnees) > VERSION_DONNEES) {
      throw new Error(
        `Cette sauvegarde vient d'une version plus récente du logiciel `
        + `(données v${sauvegarde.version_donnees}). Mettez KDL Facture à jour avant de la relire.`,
      );
    }
    let rétablis = 0;
    for (const [nom, elements] of Object.entries(sauvegarde.contenu)) {
      if (!['recues', 'reglages', 'entreprises', 'clients', 'documents'].includes(nom)
        || !Array.isArray(elements)) throw new Error('Table de sauvegarde invalide.');
      const ids = new Set();
      for (const element of elements) {
        if (!element || !Number.isSafeInteger(element.id) || element.id <= 0 || ids.has(element.id)) {
          throw new Error('Identifiant de sauvegarde invalide ou dupliqué.');
        }
        ids.add(element.id);
        rétablis += 1;
      }
    }
    if (!magasin.restaurer) throw new Error('Ce stockage ne permet pas une restauration atomique.');
    await magasin.restaurer(sauvegarde.contenu, attendu);
    return { rétablis };
  }

  /* ---------- Licence ---------- */

  async function lireReglage(nom) {
    const tous = await magasin.tous('reglages');
    const trouve = tous.find((r) => r.nom === nom);
    return trouve ? trouve.valeur : null;
  }

  async function ecrireReglage(nom, valeur) {
    const tous = await magasin.tous('reglages');
    const trouve = tous.find((r) => r.nom === nom);
    if (trouve) return magasin.remplacer('reglages', { ...trouve, valeur });
    return magasin.ajouter('reglages', { nom, valeur });
  }

  /** L'édition en cours : Pro si une clé valide est enregistrée, Découverte sinon. */
  async function licence(options = {}) {
    const cle = await lireReglage('licence');
    if (!cle) return editionLibre('');
    return verifierLicence(cle, { ...config, ...options });
  }

  /**
   * Enregistre une clé de licence après l'avoir vérifiée.
   * Une clé refusée n'est pas conservée : mieux vaut un message clair tout de
   * suite qu'une édition qui retombe mystérieusement à Découverte plus tard.
   */
  async function enregistrerLicence(cle, options = {}) {
    const verdict = await verifierLicence(cle, { ...config, ...options });
    if (!verdict.valide) {
      const erreur = new Error(verdict.refus || "Cette clé de licence n'est pas valable.");
      erreur.refus = verdict.refus;
      throw erreur;
    }
    await ecrireReglage('licence', String(cle).trim());
    return verdict;
  }

  async function retirerLicence() {
    await ecrireReglage('licence', '');
    return editionLibre('');
  }

  /** Où en est-on du plafond de l'édition en cours ? */
  async function quota(annee) {
    return etatQuota(await licence(), await magasin.tous('documents'), annee);
  }

  /* ---------- Émission ---------- */

  async function enregistrerEntreprise(fiche) {
    const existantes = await magasin.tous('entreprises');
    if (fiche.id) {
      await magasin.remplacer('entreprises', fiche);
      return fiche.id;
    }
    if (existantes.length) {
      await magasin.remplacer('entreprises', { ...existantes[0], ...fiche, id: existantes[0].id });
      return existantes[0].id;
    }
    return magasin.ajouter('entreprises', fiche);
  }

  async function monEntreprise() {
    const toutes = await magasin.tous('entreprises');
    return toutes[0] || null;
  }

  async function enregistrerClient(fiche) {
    if (fiche.id) {
      await magasin.remplacer('clients', fiche);
      return fiche.id;
    }
    return magasin.ajouter('clients', fiche);
  }

  async function listerClients() {
    return (await magasin.tous('clients'))
      .sort((a, b) => String(a.nom).localeCompare(String(b.nom), 'fr'));
  }

  async function listerDocuments(filtres = {}) {
    const tous = await magasin.tous('documents');
    return tous
      .filter((d) => (!filtres.type || d.type === filtres.type))
      .filter((d) => (!filtres.statut || d.statut === filtres.statut))
      .sort((a, b) => String(b.date_emission || '').localeCompare(String(a.date_emission || ''))
        || b.id - a.id);
  }

  async function obtenirDocument(id) {
    return (await magasin.tous('documents')).find((d) => d.id === id) || null;
  }

  async function enregistrerBrouillon(document) {
    verifierModifiable(document.id ? await obtenirDocument(document.id) : null);
    const fiche = { ...document, statut: 'brouillon' };
    if (fiche.id) {
      await magasin.remplacer('documents', fiche);
      return fiche.id;
    }
    return magasin.ajouter('documents', fiche);
  }

  /**
   * Le numéro suivant se déduit des documents déjà émis, sans compteur séparé.
   *
   * Un compteur tenu à part finit toujours par se désynchroniser — après une
   * restauration de sauvegarde, par exemple, il rendrait un numéro déjà pris.
   * Le lire dans la suite elle-même supprime cette classe entière de pannes.
   */
  async function numeroSuivant(type, annee) {
    const tous = await magasin.tous('documents');
    const rangs = tous
      .filter((d) => d.type === type && d.numero && String(d.numero).includes(String(annee)))
      .map((d) => rangDuNumero(d.numero))
      .filter((r) => r !== null);
    return composerNumero(type, annee, (rangs.length ? Math.max(...rangs) : 0) + 1);
  }

  /**
   * Émet un document : il reçoit son numéro, son sceau, et devient intouchable.
   */
  async function emettre(id, options = {}) {
    const document = await obtenirDocument(id);
    if (!document) throw new Error('Ce document est introuvable.');
    if (document.statut === 'emis') {
      throw new Error(`Ce document est déjà émis sous le numéro ${document.numero}.`);
    }

    const entreprise = await monEntreprise();
    if (!entreprise) throw new Error("Renseignez d'abord votre entreprise.");
    const client = (await magasin.tous('clients')).find((c) => c.id === document.client_id);
    if (!client) throw new Error('Le client de ce document est introuvable.');

    const date = document.date_emission || options.date || new Date().toISOString().slice(0, 10);
    const annee = Number(String(date).slice(0, 4));
    const numero = await numeroSuivant(document.type, annee);
    const donnees = {
      document: { ...document, numero, date_emission: date },
      entreprise,
      client,
      lignes: document.lignes || [],
    };

    // Le plafond de l'édition gratuite s'applique à l'émission, jamais à ce qui
    // est déjà émis : les factures passées restent lisibles et exportables.
    const compteur = await quota(annee);
    if (compteur.atteint && !options.ignorerQuota) {
      const erreur = new Error(
        `L'édition Découverte permet ${compteur.plafond} factures par année civile, et vous les `
        + `avez émises pour ${compteur.annee}. Vos factures restent accessibles et la réception `
        + "continue de fonctionner : c'est l'émission d'une nouvelle facture qui attend l'édition Pro.",
      );
      erreur.quota = compteur;
      throw erreur;
    }

    const verdict = verifier(donnees);
    if (!verdict.valide && !options.forcer) {
      const erreur = new Error(verdict.anomalies.join(' ; '));
      erreur.anomalies = verdict.anomalies;
      throw erreur;
    }

    const emis = {
      ...document,
      numero,
      date_emission: date,
      statut: 'emis',
      empreinte: await sceller(donnees),
      emis_le: new Date().toISOString(),
    };
    await magasin.remplacer('documents', emis);
    return emis;
  }

  /**
   * Annule une émission — seulement si le document ferme sa suite.
   * Les conditions sont décidées par `emission.js` ; ici on ne fait que réunir
   * les faits qu'il demande, puis écrire.
   */
  async function annulerEmission(id) {
    const document = await obtenirDocument(id);
    if (!document) throw new Error('Ce document est introuvable.');

    const tous = await magasin.tous('documents');
    const annee = Number(String(document.date_emission || '').slice(0, 4));
    const rangs = tous
      .filter((d) => d.type === document.type && d.numero && String(d.numero).includes(String(annee)))
      .map((d) => rangDuNumero(d.numero))
      .filter((r) => r !== null);
    const verdict = peutAnnulerEmission(document, {
      estDernier: rangDuNumero(document.numero) === Math.max(...rangs),
      encaissements: (document.paiements || []).length,
      avoirs: tous.filter((d) => d.document_lie_numero === document.numero).length,
    });
    if (!verdict.possible) throw new Error(verdict.motif);

    const brouillon = { ...document, statut: 'brouillon', numero: '', empreinte: '' };
    delete brouillon.emis_le;
    await magasin.remplacer('documents', brouillon);
    return brouillon;
  }

  /** Établit l'avoir qui annule une facture émise. */
  async function creerAvoir(id, options = {}) {
    const facture = await obtenirDocument(id);
    if (!facture) throw new Error('Cette facture est introuvable.');
    if (facture.statut !== 'emis') {
      throw new Error("Une facture non émise n'a pas besoin d'avoir : modifiez-la.");
    }
    const entreprise = await monEntreprise();
    const client = (await magasin.tous('clients')).find((c) => c.id === facture.client_id);
    const modele = preparerAvoir(
      { document: facture, entreprise, client, lignes: facture.lignes || [] },
      options,
    );
    return magasin.ajouter('documents', {
      ...modele.document,
      client_id: facture.client_id,
      lignes: modele.lignes,
      statut: 'brouillon',
    });
  }

  /** L'état de la numérotation : trous et doublons, sur tous les documents émis. */
  async function etatNumerotation() {
    const tous = await magasin.tous('documents');
    return verifierNumerotation(tous.filter((d) => d.statut === 'emis'));
  }

  return {
    ajouterRecue,
    listerRecues,
    obtenirRecue,
    changerStatutRecue,
    resumeRecues,
    exporter,
    importer,
    licence,
    enregistrerLicence,
    retirerLicence,
    quota,
    lireReglage,
    ecrireReglage,
    enregistrerEntreprise,
    monEntreprise,
    enregistrerClient,
    listerClients,
    listerDocuments,
    obtenirDocument,
    enregistrerBrouillon,
    numeroSuivant,
    emettre,
    annulerEmission,
    creerAvoir,
    etatNumerotation,
  };
}

module.exports = { creerDepot, magasinMemoire, VERSION_DONNEES };
