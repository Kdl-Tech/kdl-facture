'use strict';

/**
 * Les règles d'émission d'un document, sans base de données.
 *
 * Ce qui distingue un logiciel de facturation d'un tableur tient en trois
 * règles : les numéros se suivent sans trou, un document émis ne change plus,
 * et une erreur se corrige par un avoir. Elles sont écrites ici, une fois, en
 * logique pure — la version de bureau les applique sur SQLite, la version
 * installable sur le stockage du navigateur, et aucune des deux ne peut les
 * réinterpréter à sa façon.
 */

const PREFIXES = {
  facture: 'F', avoir: 'A', acompte: 'AC', devis: 'D',
};

/** `F` + année + rang sur quatre chiffres : lisible, triable, sans ambiguïté. */
function composerNumero(type, annee, rang) {
  const prefixe = PREFIXES[type] || 'F';
  return `${prefixe}${annee}-${String(rang).padStart(4, '0')}`;
}

/** Le rang d'un numéro, pour savoir s'il ferme la suite. */
function rangDuNumero(numero) {
  const m = /-(\d+)$/.exec(String(numero || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Vérifie la suite des numéros émis : trous et doublons.
 *
 * Un trou n'est pas toujours une faute — mais il doit pouvoir s'expliquer, et
 * c'est la première chose que regarde un contrôle. Autant le voir avant.
 */
function verifierNumerotation(documents) {
  const parSuite = new Map();
  for (const doc of documents) {
    if (!doc.numero) continue;
    const rang = rangDuNumero(doc.numero);
    if (rang === null) continue;
    const cle = String(doc.numero).replace(/-\d+$/, '');
    if (!parSuite.has(cle)) parSuite.set(cle, []);
    parSuite.get(cle).push({ rang, numero: doc.numero });
  }

  const trous = [];
  const doublons = [];
  for (const [cle, entrees] of parSuite) {
    const rangs = entrees.map((e) => e.rang).sort((a, b) => a - b);
    const vus = new Set();
    for (const rang of rangs) {
      if (vus.has(rang)) doublons.push(`${cle}-${String(rang).padStart(4, '0')}`);
      vus.add(rang);
    }
    for (let r = 1; r <= rangs[rangs.length - 1]; r += 1) {
      if (!vus.has(r)) trous.push(`${cle}-${String(r).padStart(4, '0')}`);
    }
  }

  return { valide: !trous.length && !doublons.length, trous, doublons };
}

/**
 * L'empreinte qui scelle un document émis.
 *
 * Elle porte sur ce qui engage : le numéro, les dates, les parties, les lignes
 * et les totaux. Deux documents identiques donnent la même empreinte, et le
 * moindre centime modifié la change — c'est ce qui permet de prouver, des
 * années plus tard, que la facture remise est bien celle qu'on a gardée.
 */
async function sceller(donnees) {
  const { document, entreprise, client, lignes } = donnees;
  const matiere = JSON.stringify({
    numero: document.numero,
    type: document.type,
    date_emission: document.date_emission,
    date_echeance: document.date_echeance || '',
    emetteur: entreprise.siret || entreprise.siren || entreprise.nom,
    destinataire: client.siret || client.siren || client.nom,
    lignes: lignes.map((l) => [
      l.designation, Number(l.quantite), Number(l.prix_ht),
      Number(l.tva_taux || 0), Number(l.remise_pct || 0),
    ]),
    acompte: Number(document.acompte || 0),
  });
  const brut = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(matiere));
  return [...new Uint8Array(brut)].map((o) => o.toString(16).padStart(2, '0')).join('');
}

/**
 * Un document émis peut-il redevenir un brouillon ?
 *
 * Uniquement s'il ferme sa suite, qu'il n'a reçu aucun encaissement et qu'aucun
 * avoir ne le vise. Au milieu d'une suite, la réponse est non : renuméroter des
 * factures déjà remises est interdit, et laisser un trou n'est pas mieux. C'est
 * le point précis où la loi et l'envie divergent — le refus doit donc expliquer
 * la sortie, qui est l'avoir.
 */
function peutAnnulerEmission(document, contexte = {}) {
  if (!document || document.statut !== 'emis') {
    return { possible: false, motif: "Ce document n'est pas émis." };
  }
  if (contexte.encaissements) {
    return {
      possible: false,
      motif: `La facture ${document.numero} a déjà reçu un encaissement. Une facture payée `
        + "ne s'annule pas : établissez un avoir.",
    };
  }
  if (contexte.avoirs) {
    return {
      possible: false,
      motif: `Un avoir vise déjà la facture ${document.numero} : son annulation ferait `
        + 'disparaître la facture que cet avoir corrige.',
    };
  }
  if (!contexte.estDernier) {
    return {
      possible: false,
      motif: `Le numéro ${document.numero} n'est pas le dernier attribué. L'annuler laisserait `
        + 'un trou dans la suite, et renuméroter les suivantes est interdit : '
        + 'corrigez par un avoir.',
    };
  }
  return { possible: true, motif: '' };
}

/**
 * Prépare l'avoir qui annule une facture : mêmes lignes, quantités inversées.
 * On ne recopie pas les montants, on inverse les quantités — ainsi les totaux
 * sont recalculés par le même chemin que la facture d'origine et ne peuvent pas
 * en différer d'un centime.
 */
function preparerAvoir(source, options = {}) {
  return {
    document: {
      type: 'avoir',
      date_emission: options.date || new Date().toISOString().slice(0, 10),
      categorie: source.document.categorie,
      mode_paiement: source.document.mode_paiement,
      document_lie_numero: source.document.numero,
      note: options.motif
        ? `Avoir sur facture ${source.document.numero} — ${options.motif}`
        : `Avoir sur facture ${source.document.numero}`,
    },
    entreprise: source.entreprise,
    client: source.client,
    lignes: source.lignes.map((l) => ({ ...l, quantite: -Math.abs(Number(l.quantite)) })),
  };
}

/**
 * Ce qui interdit de modifier un document.
 * Un brouillon se retouche librement ; un document émis, jamais.
 */
function verifierModifiable(document) {
  if (document && document.statut === 'emis') {
    throw new Error(
      `La facture ${document.numero} est émise : elle ne peut plus être modifiée. `
      + 'Établissez un avoir, ou annulez son émission si elle ferme la suite.',
    );
  }
}

module.exports = {
  PREFIXES,
  composerNumero,
  rangDuNumero,
  verifierNumerotation,
  sceller,
  peutAnnulerEmission,
  preparerAvoir,
  verifierModifiable,
};
