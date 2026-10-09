'use strict';

/**
 * Le cycle de vie d'une facture reçue.
 *
 * La réforme ne demande pas seulement de recevoir : elle attend que le
 * destinataire dise ce qu'il fait de la facture. Un rejet doit être motivé, un
 * encaissement doit être daté, et l'ensemble doit pouvoir se relire plus tard —
 * c'est ce qui permet de prouver qu'une facture contestée l'a été à temps.
 *
 * Ce module ne connaît ni base de données ni interface : il dit seulement quels
 * passages sont permis et ce qu'ils exigent. Le stockage vient par-dessus, et
 * peut être SQLite sur un poste comme IndexedDB dans le navigateur.
 */

const STATUTS = {
  recue: { libelle: 'Reçue', description: 'La facture est arrivée, rien n\'a encore été décidé.' },
  approuvee: { libelle: 'Approuvée', description: 'Le bien ou le service est reconnu, la facture est bonne à payer.' },
  rejetee: { libelle: 'Rejetée', description: 'La facture est refusée : le motif est transmis au fournisseur.' },
  en_paiement: { libelle: 'Mise en paiement', description: 'Le règlement est lancé.' },
  encaissee: { libelle: 'Payée', description: 'Le fournisseur a été réglé.' },
};

/**
 * Ce qui peut suivre quoi.
 *
 * Une facture rejetée est un point final : le fournisseur doit en émettre une
 * nouvelle, ou passer par un avoir. La rouvrir donnerait deux vérités sur le
 * même numéro. En revanche une facture approuvée peut encore être rejetée —
 * un litige se découvre souvent après coup, tant que rien n'est payé.
 */
const TRANSITIONS = {
  recue: ['approuvee', 'rejetee'],
  approuvee: ['en_paiement', 'rejetee', 'encaissee'],
  rejetee: [],
  en_paiement: ['encaissee', 'rejetee'],
  encaissee: [],
};

const MOTIF_OBLIGATOIRE = new Set(['rejetee']);

function estStatut(valeur) {
  return Object.prototype.hasOwnProperty.call(STATUTS, valeur);
}

/** Les suites possibles d'un statut, pour n'afficher que des boutons utiles. */
function suivantsPossibles(statut) {
  return TRANSITIONS[statut] ? [...TRANSITIONS[statut]] : [];
}

/**
 * Prépare le passage d'une facture reçue à un nouveau statut.
 *
 * @param {object} recue la facture reçue, avec son statut et son historique
 * @param {string} nouveau le statut visé
 * @param {{motif?: string, date?: string, par?: string}} [details]
 * @returns {{statut: string, historique: object[]}} l'état qui remplace l'ancien
 * @throws {Error} si le passage n'est pas permis ou si le motif manque
 */
function changerStatut(recue, nouveau, details = {}) {
  const actuel = recue.statut || 'recue';
  if (!estStatut(actuel)) throw new Error(`Statut de départ inconnu : « ${actuel} ».`);
  if (!estStatut(nouveau)) throw new Error(`Statut inconnu : « ${nouveau} ».`);

  if (actuel === nouveau) {
    throw new Error(`La facture est déjà « ${STATUTS[actuel].libelle.toLowerCase()} ».`);
  }
  if (!suivantsPossibles(actuel).includes(nouveau)) {
    const possibles = suivantsPossibles(actuel);
    throw new Error(
      `Une facture « ${STATUTS[actuel].libelle.toLowerCase()} » ne peut pas passer à `
      + `« ${STATUTS[nouveau].libelle.toLowerCase()} ». `
      + (possibles.length
        ? `Possible : ${possibles.map((s) => STATUTS[s].libelle.toLowerCase()).join(', ')}.`
        : 'Ce statut est définitif.'),
    );
  }

  const motif = String(details.motif || '').trim();
  if (MOTIF_OBLIGATOIRE.has(nouveau) && motif.length < 3) {
    throw new Error('Un rejet doit être motivé : le fournisseur doit savoir quoi corriger.');
  }

  const entree = {
    statut: nouveau,
    date: details.date || new Date().toISOString(),
    motif: motif || '',
    par: details.par || '',
  };

  return {
    statut: nouveau,
    historique: [...(recue.historique || []), entree],
  };
}

/**
 * Le motif de rejet à transmettre, tel qu'on peut le recopier au fournisseur.
 * Les anomalies relevées au contrôle valent motif : autant les reprendre plutôt
 * que de demander à l'utilisateur de les réécrire.
 */
function motifDepuisControle(controle) {
  if (!controle || !controle.anomalies || !controle.anomalies.length) return '';
  return controle.anomalies.length === 1
    ? controle.anomalies[0]
    : `${controle.anomalies.length} anomalies : ${controle.anomalies.join(' ; ')}`;
}

module.exports = {
  STATUTS, TRANSITIONS, changerStatut, suivantsPossibles, estStatut, motifDepuisControle,
};
