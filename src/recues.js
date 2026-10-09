'use strict';

/**
 * Les factures reçues, côté poste : lecture, contrôle et conservation.
 *
 * Ce module fait le lien entre la réception — qui ne connaît que des octets et
 * ne dépend d'aucun système — et la base du logiciel. Il reste volontairement
 * du côté Node : `src/reception/` doit pouvoir tourner dans un navigateur, et
 * un test veille à ce que rien n'y importe de module système.
 *
 * Le fichier reçu est conservé tel quel. C'est lui qui fait foi devant
 * l'administration ou devant le fournisseur, pas la lecture qu'on en fait.
 */

const { lireFichierRecu, chercherDoublon } = require('./reception');
const { changerStatut, motifDepuisControle, STATUTS } = require('./reception/journal');

function versLigne(recue, entrepriseId, contexte) {
  const f = recue.facture;
  return {
    entreprise_id: entrepriseId,
    fichier_nom: contexte.nom || '',
    fichier_type: recue.source,
    format: f.format,
    empreinte_fichier: recue.empreinte_fichier,
    empreinte_xml: recue.empreinte_xml,
    cle_metier: recue.cle_metier,
    numero: f.numero || '',
    type: f.type || 'facture',
    date_emission: f.date_emission || '',
    date_echeance: f.date_echeance || '',
    fournisseur_nom: (f.fournisseur && f.fournisseur.nom) || '',
    fournisseur_siret: (f.fournisseur && f.fournisseur.siret) || '',
    fournisseur_siren: (f.fournisseur && f.fournisseur.siren) || '',
    devise: f.devise || 'EUR',
    total_ht: Number(f.totaux.total_ht || 0),
    total_tva: Number(f.totaux.total_tva || 0),
    total_ttc: Number(f.totaux.total_ttc || 0),
    net_a_payer: Number(f.totaux.net_a_payer || 0),
    statut: 'recue',
    verdict: recue.controle.verdict,
    anomalies: JSON.stringify(recue.controle.anomalies),
    avertissements: JSON.stringify(recue.controle.avertissements),
    facture_json: JSON.stringify(f),
    xml: recue.xml || '',
  };
}

function relire(ligne) {
  if (!ligne) return null;
  return {
    ...ligne,
    anomalies: JSON.parse(ligne.anomalies || '[]'),
    avertissements: JSON.parse(ligne.avertissements || '[]'),
    facture: JSON.parse(ligne.facture_json || 'null'),
    statut_libelle: (STATUTS[ligne.statut] || {}).libelle || ligne.statut,
  };
}

function creer(db) {
  /**
   * Enregistre un fichier reçu.
   *
   * Un doublon strictement identique n'est pas une erreur : c'est un renvoi. On
   * le signale et on n'enregistre rien de plus, plutôt que de laisser deux
   * lignes pour une seule facture — c'est ainsi qu'on paie deux fois.
   *
   * @param {number} entrepriseId destinataire
   * @param {Uint8Array} octets le fichier reçu, tel qu'il est arrivé
   * @param {{nom?: string, forcer?: boolean}} [contexte]
   */
  async function enregistrer(entrepriseId, octets, contexte = {}) {
    const recue = await lireFichierRecu(octets, contexte);
    recue.xml = recue.xml || '';

    const anciennes = db.prepare(
      `SELECT id, numero, empreinte_fichier, cle_metier, net_a_payer, facture_json
       FROM factures_recues WHERE entreprise_id = ? AND (empreinte_fichier = ? OR cle_metier = ?)`,
    ).all(entrepriseId, recue.empreinte_fichier, recue.cle_metier)
      .map((l) => ({ ...l, facture: JSON.parse(l.facture_json || 'null') }));

    const doublon = chercherDoublon(recue, anciennes);
    if (doublon && !contexte.forcer) {
      return {
        enregistree: false, doublon: doublon.niveau, message: doublon.message,
        ancienne_id: doublon.ancienne.id, controle: recue.controle, facture: recue.facture,
      };
    }

    const ligne = versLigne(recue, entrepriseId, contexte);
    const colonnes = Object.keys(ligne);
    const info = db.prepare(
      `INSERT INTO factures_recues (${colonnes.join(', ')}, fichier)
       VALUES (${colonnes.map(() => '?').join(', ')}, ?)`,
    ).run(...colonnes.map((c) => ligne[c]), octets);

    const id = Number(info.lastInsertRowid);
    db.prepare('INSERT INTO recues_historique (recue_id, statut, motif, par) VALUES (?, ?, ?, ?)')
      .run(id, 'recue', '', contexte.par || '');

    return {
      enregistree: true,
      id,
      doublon: doublon ? doublon.niveau : null,
      controle: recue.controle,
      facture: recue.facture,
      motif_rejet_propose: motifDepuisControle(recue.controle),
    };
  }

  function lister(entrepriseId, filtres = {}) {
    const conditions = ['entreprise_id = ?'];
    const valeurs = [entrepriseId];
    if (filtres.statut) { conditions.push('statut = ?'); valeurs.push(filtres.statut); }
    if (filtres.fournisseur) {
      conditions.push('fournisseur_nom LIKE ?');
      valeurs.push(`%${filtres.fournisseur}%`);
    }
    if (filtres.verdict) { conditions.push('verdict = ?'); valeurs.push(filtres.verdict); }
    return db.prepare(
      `SELECT id, recue_le, numero, type, format, date_emission, date_echeance,
              fournisseur_nom, fournisseur_siret, total_ht, total_tva, total_ttc,
              net_a_payer, statut, verdict, anomalies, avertissements, fichier_nom
       FROM factures_recues WHERE ${conditions.join(' AND ')}
       ORDER BY date_emission DESC, id DESC`,
    ).all(...valeurs).map((l) => ({
      ...l,
      anomalies: JSON.parse(l.anomalies || '[]'),
      avertissements: JSON.parse(l.avertissements || '[]'),
      statut_libelle: (STATUTS[l.statut] || {}).libelle || l.statut,
    }));
  }

  function obtenir(id) {
    const ligne = relire(db.prepare(
      `SELECT id, entreprise_id, recue_le, fichier_nom, fichier_type, format, numero, type,
              date_emission, date_echeance, fournisseur_nom, fournisseur_siret, devise,
              total_ht, total_tva, total_ttc, net_a_payer, statut, verdict, anomalies,
              avertissements, facture_json, xml, note
       FROM factures_recues WHERE id = ?`,
    ).get(id));
    if (!ligne) return null;
    ligne.historique = db.prepare(
      'SELECT horodatage, statut, motif, par FROM recues_historique WHERE recue_id = ? ORDER BY id',
    ).all(id);
    return ligne;
  }

  /** Le fichier d'origine, pour le relire ou le transmettre. */
  function fichierOriginal(id) {
    const ligne = db.prepare('SELECT fichier_nom, fichier FROM factures_recues WHERE id = ?').get(id);
    return ligne && ligne.fichier ? ligne : null;
  }

  /**
   * Fait passer une facture reçue à un nouveau statut.
   * Les passages permis et le motif obligatoire sont décidés par le journal ;
   * ici on ne fait qu'écrire ce qu'il autorise.
   */
  function changer(id, nouveau, details = {}) {
    const ligne = db.prepare('SELECT id, statut FROM factures_recues WHERE id = ?').get(id);
    if (!ligne) throw new Error('Cette facture reçue est introuvable.');

    const resultat = changerStatut({ statut: ligne.statut }, nouveau, details);
    const entree = resultat.historique[resultat.historique.length - 1];

    db.transaction(() => {
      db.prepare('UPDATE factures_recues SET statut = ? WHERE id = ?').run(nouveau, id);
      db.prepare('INSERT INTO recues_historique (recue_id, statut, motif, par) VALUES (?, ?, ?, ?)')
        .run(id, nouveau, entree.motif, entree.par);
    })();

    return { id, statut: nouveau, libelle: STATUTS[nouveau].libelle };
  }

  /** De quoi remplir un tableau de bord : ce qui attend, ce qui est en retard. */
  function resume(entrepriseId, aujourdhui) {
    const jour = aujourdhui || new Date().toISOString().slice(0, 10);
    const compte = (condition, ...valeurs) => db.prepare(
      `SELECT COUNT(*) n, COALESCE(SUM(net_a_payer), 0) total
       FROM factures_recues WHERE entreprise_id = ? AND ${condition}`,
    ).get(entrepriseId, ...valeurs);

    return {
      a_traiter: compte("statut = 'recue'"),
      a_payer: compte("statut IN ('approuvee','en_paiement')"),
      en_retard: compte(
        "statut IN ('recue','approuvee','en_paiement') AND date_echeance <> '' AND date_echeance < ?",
        jour,
      ),
      non_conformes: compte("verdict = 'non conforme'"),
      payees: compte("statut = 'encaissee'"),
    };
  }

  return {
    enregistrer, lister, obtenir, changer, resume, fichierOriginal,
  };
}

module.exports = { creer };
