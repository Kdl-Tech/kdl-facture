'use strict';

/**
 * Le métier : créer, émettre, encaisser, corriger.
 *
 * Deux règles gouvernent tout ce fichier.
 *
 * 1. Une facture émise ne bouge plus. Pas de correction discrète, pas de
 *    renumérotation : une erreur se répare par un avoir, qui laisse la trace
 *    des deux documents. C'est ce que l'administration attend, et c'est aussi
 *    ce qui protège l'éditeur en cas de contrôle.
 * 2. La numérotation est continue et sans trou. Le numéro n'est attribué qu'à
 *    l'émission — un brouillon abandonné ne consomme rien.
 */

const crypto = require('node:crypto');
const { calculerDocument, resteDu, calculerEcheance } = require('./calculs');
const { verifier } = require('./facturx');
const { capacites } = require('./edition');

const PREFIXES = { facture: 'F', avoir: 'A', acompte: 'AC', devis: 'D' };

class ErreurMetier extends Error {
  constructor(message, anomalies = []) {
    super(message);
    this.nom = 'ErreurMetier';
    this.anomalies = anomalies;
  }
}

/** Empreinte du contenu : deux factures identiques donnent la même, une modification la change. */
function empreinte(contenu) {
  return crypto.createHash('sha256').update(JSON.stringify(contenu)).digest('hex');
}

class Service {
  constructor(db, licence = null) {
    this.db = db;
    this.licence = licence;
  }

  /** Ce que l'édition en cours autorise. */
  peut(quoi) {
    return capacites(this.licence)[quoi];
  }

  /** Combien de factures ont déjà été émises cette année. */
  facturesEmisesCetteAnnee(entrepriseId, annee) {
    const an = annee || new Date().getFullYear();
    return this.db.prepare(`
      SELECT COUNT(*) AS n FROM documents
      WHERE entreprise_id = ? AND statut != 'brouillon'
        AND type IN ('facture', 'acompte')
        AND substr(date_emission, 1, 4) = ?
    `).get(entrepriseId, String(an)).n;
  }

  // — Lecture —————————————————————————————————————————————

  entreprise(id) {
    return this.db.prepare('SELECT * FROM entreprises WHERE id = ?').get(id);
  }

  client(id) {
    return this.db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  }

  lignes(documentId) {
    return this.db.prepare('SELECT * FROM lignes WHERE document_id = ? ORDER BY position, id').all(documentId);
  }

  paiements(documentId) {
    return this.db.prepare('SELECT * FROM paiements WHERE document_id = ? ORDER BY date, id').all(documentId);
  }

  /** Un document complet, prêt pour le PDF ou le XML. */
  document(id) {
    const doc = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    if (!doc) return null;
    const lignes = this.lignes(id);
    const paiements = this.paiements(id);
    const totaux = calculerDocument(lignes, { acompte: doc.acompte });
    if (doc.document_lie_id) {
      const lie = this.db.prepare('SELECT numero FROM documents WHERE id = ?').get(doc.document_lie_id);
      doc.document_lie_numero = lie ? lie.numero : '';
    }
    return {
      document: doc,
      entreprise: this.entreprise(doc.entreprise_id),
      client: this.client(doc.client_id),
      lignes,
      paiements,
      totaux,
      reste_du: resteDu(totaux.net_a_payer, paiements),
    };
  }

  liste(entrepriseId, filtres = {}) {
    const conditions = ['d.entreprise_id = ?'];
    const valeurs = [entrepriseId];
    if (filtres.type) { conditions.push('d.type = ?'); valeurs.push(filtres.type); }
    if (filtres.statut) { conditions.push('d.statut = ?'); valeurs.push(filtres.statut); }
    if (filtres.client_id) { conditions.push('d.client_id = ?'); valeurs.push(filtres.client_id); }
    return this.db.prepare(`
      SELECT d.*, c.nom AS client_nom,
             (SELECT COALESCE(SUM(p.montant), 0) FROM paiements p WHERE p.document_id = d.id) AS verse
      FROM documents d JOIN clients c ON c.id = d.client_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY d.date_emission DESC, d.id DESC
    `).all(...valeurs);
  }

  // — Écriture ————————————————————————————————————————————

  creer(entrepriseId, donnees) {
    const client = this.client(donnees.client_id);
    if (!client || client.entreprise_id !== entrepriseId) {
      throw new ErreurMetier("Ce client n'existe pas dans votre entreprise.");
    }
    const type = donnees.type || 'facture';
    if (!Object.prototype.hasOwnProperty.call(PREFIXES, type)) {
      throw new ErreurMetier(
        `Type de document inconnu : « ${type} ». Valeurs acceptées : ${Object.keys(PREFIXES).join(', ')}.`);
    }
    const dateEmission = donnees.date_emission || new Date().toISOString().slice(0, 10);
    const echeance = donnees.date_echeance
      || calculerEcheance(dateEmission, client.delai_paiement_jours);

    const info = this.db.prepare(`
      INSERT INTO documents (entreprise_id, client_id, type, statut, date_emission, date_echeance,
                             date_livraison, categorie, mode_paiement, reference_commande,
                             document_lie_id, acompte, note)
      VALUES (?, ?, ?, 'brouillon', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entrepriseId, donnees.client_id, type, dateEmission, echeance,
      donnees.date_livraison || '', donnees.categorie || 'services',
      donnees.mode_paiement || 'virement', donnees.reference_commande || '',
      donnees.document_lie_id || null, Number(donnees.acompte) || 0, donnees.note || '');

    this.remplacerLignes(info.lastInsertRowid, donnees.lignes || []);
    this.tracer(entrepriseId, info.lastInsertRowid, 'creation', `${type} en brouillon`);
    return this.document(info.lastInsertRowid);
  }

  remplacerLignes(documentId, lignes) {
    const doc = this.db.prepare('SELECT statut FROM documents WHERE id = ?').get(documentId);
    if (!doc) throw new ErreurMetier("Document introuvable.");
    if (doc.statut !== 'brouillon') {
      throw new ErreurMetier("Ce document est émis : son contenu ne peut plus changer. Émettez un avoir pour le corriger.");
    }
    const supprimer = this.db.prepare('DELETE FROM lignes WHERE document_id = ?');
    const inserer = this.db.prepare(`
      INSERT INTO lignes (document_id, position, designation, nature, unite, quantite, prix_ht, remise_pct, tva_taux)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      supprimer.run(documentId);
      lignes.forEach((l, i) => inserer.run(
        documentId, i + 1, l.designation || '', l.nature || 'service', l.unite || 'heure',
        Number(l.quantite) || 0, Number(l.prix_ht) || 0, Number(l.remise_pct) || 0,
        Number(l.tva_taux) || 0));
    })();
  }

  modifier(documentId, donnees) {
    const doc = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
    if (!doc) throw new ErreurMetier("Document introuvable.");
    if (doc.statut !== 'brouillon') {
      throw new ErreurMetier("Ce document est émis : il ne se modifie plus.");
    }
    const champs = ['client_id', 'date_emission', 'date_echeance', 'date_livraison',
      'categorie', 'mode_paiement', 'reference_commande', 'acompte', 'note'];
    const majs = champs.filter((c) => donnees[c] !== undefined);
    if (majs.length) {
      this.db.prepare(`UPDATE documents SET ${majs.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...majs.map((c) => donnees[c]), documentId);
    }
    if (donnees.lignes) this.remplacerLignes(documentId, donnees.lignes);
    return this.document(documentId);
  }

  /**
   * Le numéro suivant, dans une séquence continue par année et par type.
   * Réservé dans la même transaction que l'émission : deux factures émises en
   * même temps ne peuvent pas recevoir le même numéro.
   */
  numeroSuivant(entrepriseId, type, annee) {
    const prefixe = PREFIXES[type] || 'F';
    this.db.prepare(`
      INSERT INTO compteurs (entreprise_id, type, annee, dernier) VALUES (?, ?, ?, 0)
      ON CONFLICT (entreprise_id, type, annee) DO NOTHING
    `).run(entrepriseId, type, annee);
    this.db.prepare('UPDATE compteurs SET dernier = dernier + 1 WHERE entreprise_id = ? AND type = ? AND annee = ?')
      .run(entrepriseId, type, annee);
    const { dernier } = this.db.prepare('SELECT dernier FROM compteurs WHERE entreprise_id = ? AND type = ? AND annee = ?')
      .get(entrepriseId, type, annee);
    return `${prefixe}${annee}-${String(dernier).padStart(4, '0')}`;
  }

  /**
   * Émission : le document reçoit son numéro, son empreinte, et devient
   * définitif. Rien n'est émis qui ne passerait pas le contrôle de conformité.
   */
  emettre(documentId) {
    const complet = this.document(documentId);
    if (!complet) throw new ErreurMetier("Document introuvable.");
    if (complet.document.statut !== 'brouillon') {
      throw new ErreurMetier(`Ce document est déjà émis sous le numéro ${complet.document.numero}.`);
    }

    // La limite de volume se vérifie ici, à l'émission, et pas à la saisie :
    // on ne bloque jamais quelqu'un en plein travail, seulement au moment de
    // rendre la facture définitive.
    const plafond = this.peut('factures_par_an');
    if (Number.isFinite(plafond) && complet.document.type !== 'avoir') {
      const annee = Number(complet.document.date_emission.slice(0, 4));
      const deja = this.facturesEmisesCetteAnnee(complet.document.entreprise_id, annee);
      if (deja >= plafond) {
        throw new ErreurMetier(
          `L'édition Découverte permet ${plafond} factures par an, et ${deja} ont déjà été émises en ${annee}. `
          + "L'édition Pro les rend illimitées — vos factures déjà émises restent intactes et lisibles.");
      }
    }

    const controle = verifier(complet);
    if (!controle.valide) {
      throw new ErreurMetier(
        "La facture n'est pas conforme : elle serait rejetée par votre client.",
        controle.anomalies);
    }

    const annee = Number(complet.document.date_emission.slice(0, 4));
    return this.db.transaction(() => {
      const numero = this.numeroSuivant(complet.document.entreprise_id, complet.document.type, annee);
      const sceau = empreinte({
        numero,
        client: complet.client.nom,
        lignes: complet.lignes.map((l) => ({ d: l.designation, q: l.quantite, p: l.prix_ht, t: l.tva_taux })),
        total: complet.totaux.total_ttc,
      });
      this.db.prepare(`
        UPDATE documents SET numero = ?, statut = 'emis', empreinte = ?,
                             emis_le = datetime('now','localtime')
        WHERE id = ?
      `).run(numero, sceau, documentId);
      this.tracer(complet.document.entreprise_id, documentId, 'emission',
        `${complet.document.type} ${numero} — ${complet.totaux.total_ttc} € TTC`, sceau);
      return this.document(documentId);
    })();
  }

  /** Encaissement. Le statut suit l'argent réellement reçu, pas une intention. */
  encaisser(documentId, paiement) {
    const complet = this.document(documentId);
    if (!complet) throw new ErreurMetier("Document introuvable.");
    if (complet.document.statut === 'brouillon') {
      throw new ErreurMetier("Une facture doit être émise avant d'être encaissée.");
    }
    const montant = Number(paiement.montant);
    if (!(montant > 0)) throw new ErreurMetier("Le montant encaissé doit être positif.");

    this.db.prepare(`
      INSERT INTO paiements (document_id, date, montant, moyen, reference, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(documentId, paiement.date || new Date().toISOString().slice(0, 10), montant,
      paiement.moyen || 'virement', paiement.reference || '', paiement.note || '');

    const apres = this.document(documentId);
    if (apres.reste_du <= 0) {
      this.db.prepare("UPDATE documents SET statut = 'paye' WHERE id = ?").run(documentId);
    }
    this.tracer(complet.document.entreprise_id, documentId, 'encaissement', `${montant} €`);
    return this.document(documentId);
  }

  /**
   * L'avoir : la seule façon correcte d'annuler ou de corriger une facture
   * émise. Il reprend les lignes en négatif et cite la facture d'origine.
   */
  creerAvoir(documentId, options = {}) {
    const source = this.document(documentId);
    if (!source) throw new ErreurMetier("Facture introuvable.");
    if (source.document.statut === 'brouillon') {
      throw new ErreurMetier("Un brouillon se supprime, il n'a pas besoin d'avoir.");
    }
    if (source.document.type === 'avoir') {
      throw new ErreurMetier("On n'établit pas un avoir sur un avoir.");
    }

    const lignes = (options.lignes || source.lignes).map((l) => ({
      designation: l.designation,
      nature: l.nature,
      unite: l.unite,
      quantite: -Math.abs(Number(l.quantite)),
      prix_ht: l.prix_ht,
      remise_pct: l.remise_pct,
      tva_taux: l.tva_taux,
    }));

    const avoir = this.creer(source.document.entreprise_id, {
      client_id: source.document.client_id,
      type: 'avoir',
      categorie: source.document.categorie,
      mode_paiement: source.document.mode_paiement,
      document_lie_id: documentId,
      note: options.motif
        ? `Avoir sur facture ${source.document.numero} — ${options.motif}`
        : `Avoir sur facture ${source.document.numero}`,
      lignes,
    });
    return avoir;
  }

  supprimerBrouillon(documentId) {
    const doc = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
    if (!doc) throw new ErreurMetier("Document introuvable.");
    if (doc.statut !== 'brouillon') {
      throw new ErreurMetier("Un document émis ne se supprime pas. Établissez un avoir.");
    }
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);
    this.tracer(doc.entreprise_id, null, 'suppression_brouillon', `document ${documentId}`);
    return { supprime: true };
  }

  /**
   * Journal chaîné : chaque écriture porte l'empreinte de la précédente. Une
   * ligne retirée ou modifiée après coup casse la chaîne, et se voit.
   */
  tracer(entrepriseId, documentId, acte, detail = '', sceau = '') {
    const precedent = this.db.prepare('SELECT empreinte FROM journal ORDER BY id DESC LIMIT 1').get();
    const chaine = precedent ? precedent.empreinte : '';
    const ligne = empreinte({ entrepriseId, documentId, acte, detail, sceau, chaine });
    this.db.prepare(`
      INSERT INTO journal (entreprise_id, document_id, acte, detail, empreinte, empreinte_precedente)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(entrepriseId, documentId, acte, detail, ligne, chaine);
  }

  /** Vérifie que le journal n'a pas été retouché. */
  verifierJournal() {
    const lignes = this.db.prepare('SELECT * FROM journal ORDER BY id').all();
    let precedente = '';
    for (const l of lignes) {
      if (l.empreinte_precedente !== precedente) {
        return { intact: false, rompu_a: l.id, motif: 'chaînage rompu' };
      }
      precedente = l.empreinte;
    }
    return { intact: true, lignes: lignes.length };
  }

  // — Tableau de bord ——————————————————————————————————————

  statistiques(entrepriseId) {
    // Les avoirs comptent : ils portent des totaux négatifs, et les exclure
    // laissait le chiffre d'affaires gonflé d'une facture pourtant annulée.
    const base = `FROM documents d WHERE d.entreprise_id = ? AND d.statut != 'brouillon' AND d.type IN ('facture','acompte','avoir')`;
    const total = (statut) => this.db.prepare(`
      SELECT COUNT(*) AS n FROM documents WHERE entreprise_id = ? AND statut = ?
    `).get(entrepriseId, statut).n;

    const factures = this.db.prepare(`SELECT d.id ${base}`).all(entrepriseId);
    let encaisse = 0;
    let attendu = 0;
    let enRetard = 0;
    const aujourdhui = new Date().toISOString().slice(0, 10);

    for (const f of factures) {
      const c = this.document(f.id);
      const verse = c.paiements.reduce((s, p) => s + Number(p.montant), 0);
      encaisse += verse;
      attendu += c.totaux.net_a_payer;
      if (c.reste_du > 0 && c.document.date_echeance && c.document.date_echeance < aujourdhui) {
        enRetard += c.reste_du;
      }
    }

    return {
      brouillons: total('brouillon'),
      emises: factures.length,
      chiffre_affaires_ttc: Math.round(attendu * 100) / 100,
      encaisse: Math.round(encaisse * 100) / 100,
      reste_du: Math.round((attendu - encaisse) * 100) / 100,
      en_retard: Math.round(enRetard * 100) / 100,
    };
  }

  /**
   * Chiffre d'affaires encaissé sur l'année civile.
   *
   * En micro-entreprise, ce qui compte est l'argent **encaissé**, pas facturé :
   * c'est lui qui sert à la déclaration URSSAF et au suivi du plafond de
   * franchise de TVA. Une facture émise en décembre et payée en janvier
   * appartient à l'année du paiement.
   */
  chiffreAffairesEncaisse(entrepriseId, annee) {
    const an = annee || new Date().getFullYear();
    const ligne = this.db.prepare(`
      SELECT COALESCE(SUM(p.montant), 0) AS total
      FROM paiements p
      JOIN documents d ON d.id = p.document_id
      WHERE d.entreprise_id = ? AND d.type != 'avoir'
        AND substr(p.date, 1, 4) = ?
    `).get(entrepriseId, String(an));
    const avoirs = this.db.prepare(`
      SELECT COALESCE(SUM(p.montant), 0) AS total
      FROM paiements p
      JOIN documents d ON d.id = p.document_id
      WHERE d.entreprise_id = ? AND d.type = 'avoir'
        AND substr(p.date, 1, 4) = ?
    `).get(entrepriseId, String(an));
    return Math.round((ligne.total - avoirs.total) * 100) / 100;
  }

  /**
   * Où en est-on du plafond de franchise de TVA.
   *
   * Le montant du plafond n'est pas inscrit en dur : il change au gré des lois
   * de finances, et un chiffre faux serait pire que pas de chiffre du tout.
   * Il se renseigne dans les réglages ; tant qu'il vaut zéro, on se contente
   * d'afficher le chiffre d'affaires sans jugement.
   */
  suiviFranchise(entrepriseId) {
    const entreprise = this.entreprise(entrepriseId);
    if (!entreprise || entreprise.regime_tva !== 'franchise') return null;
    const annee = new Date().getFullYear();
    const encaisse = this.chiffreAffairesEncaisse(entrepriseId, annee);
    const seuil = Number(entreprise.seuil_franchise) || 0;
    if (!seuil) {
      return { annee, encaisse, seuil: 0, renseigne: false };
    }
    const part = encaisse / seuil;
    return {
      annee,
      encaisse,
      seuil,
      restant: Math.round((seuil - encaisse) * 100) / 100,
      pourcentage: Math.round(part * 1000) / 10,
      renseigne: true,
      alerte: part >= 1 ? 'depasse' : (part >= 0.8 ? 'proche' : null),
    };
  }

  /** Les factures échues et non soldées, les plus anciennes d'abord. */
  impayes(entrepriseId) {
    const aujourdhui = new Date().toISOString().slice(0, 10);
    return this.liste(entrepriseId, { type: 'facture' })
      .filter((d) => d.statut === 'emis' || d.statut === 'envoye')
      .map((d) => {
        const c = this.document(d.id);
        return { ...d, reste_du: c.reste_du, total_ttc: c.totaux.total_ttc };
      })
      .filter((d) => d.reste_du > 0 && d.date_echeance && d.date_echeance < aujourdhui)
      .sort((a, b) => a.date_echeance.localeCompare(b.date_echeance));
  }
}

module.exports = { Service, ErreurMetier, empreinte, PREFIXES };
