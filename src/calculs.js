'use strict';

/**
 * Les calculs d'une facture, au centime près.
 *
 * L'argent ne se calcule pas en virgule flottante : 0.1 + 0.2 ne fait pas 0.3,
 * et sur une facture cet écart devient un litige. Tout est calculé en centimes
 * entiers, arrondi une seule fois par ligne puis par taux de TVA, comme
 * l'exige l'administration — et non sur le total général.
 */

/**
 * Arrondi commercial au centime, symétrique.
 *
 * `Math.round(x * 100)` seul se trompe sur les valeurs que la virgule flottante
 * représente juste en dessous : 8,245 devient 824 au lieu de 825. Et il arrondit
 * vers le haut y compris pour les négatifs, si bien que −2,675 donnait −267 quand
 * 2,675 donnait 268 — un avoir n'annulait alors pas exactement sa facture, et il
 * restait un centime dû pour toujours.
 *
 * On arrondit donc la valeur absolue, avec une marge minuscule pour rattraper la
 * représentation binaire, puis on remet le signe.
 */
function centimes(montantEuros) {
  const nombre = Number(montantEuros) || 0;
  const signe = nombre < 0 ? -1 : 1;
  const v = signe * Math.round(Math.abs(nombre) * 100 + 1e-9);
  return Object.is(v, -0) ? 0 : v;
}

function euros(cts) {
  return Math.round(cts) / 100;
}

/**
 * Une ligne : quantité × prix, remise éventuelle, puis TVA.
 * La remise s'applique avant la TVA, jamais après.
 */
function calculerLigne(ligne) {
  const brut = Number(ligne.quantite) * Number(ligne.prix_ht);
  const remise = brut * (Number(ligne.remise_pct || 0) / 100);
  const htCts = centimes(brut - remise);
  const tvaCts = Math.round((htCts * Number(ligne.tva_taux || 0)) / 100);
  return {
    ...ligne,
    montant_ht: euros(htCts),
    // La TVA d'une ligne est indicative : la TVA due se calcule sur la base
    // totale de chaque taux, jamais en additionnant les arrondis de lignes.
    // Additionner ces deux champs donnerait un total différent de celui de la
    // facture — ils sont là pour l'affichage, pas pour le calcul.
    montant_tva_indicatif: euros(tvaCts),
    montant_ttc_indicatif: euros(htCts + tvaCts),
    _ht_cts: htCts,
    _tva_cts: tvaCts,
  };
}

/**
 * Le total d'un document. La TVA est regroupée par taux : c'est cette
 * ventilation que réclame le format Factur-X, et c'est elle qui doit tomber
 * juste, pas une somme de sommes.
 */
function calculerDocument(lignes, options = {}) {
  const detail = (lignes || []).map(calculerLigne);
  const parTaux = new Map();

  for (const l of detail) {
    const taux = Number(l.tva_taux || 0);
    const cumul = parTaux.get(taux) || { taux, base_cts: 0 };
    cumul.base_cts += l._ht_cts;
    parTaux.set(taux, cumul);
  }

  const ventilation = [...parTaux.values()]
    .sort((a, b) => b.taux - a.taux)
    .map((v) => {
      // La TVA se calcule sur la base totale du taux, pas en additionnant
      // les arrondis de chaque ligne : l'écart d'un centime vient de là.
      const tvaCts = Math.round((v.base_cts * v.taux) / 100);
      return { taux: v.taux, base_ht: euros(v.base_cts), montant_tva: euros(tvaCts), _tva_cts: tvaCts };
    });

  const totalHtCts = detail.reduce((s, l) => s + l._ht_cts, 0);
  const totalTvaCts = ventilation.reduce((s, v) => s + v._tva_cts, 0);
  const acompteCts = centimes(options.acompte || 0);
  const totalTtcCts = totalHtCts + totalTvaCts;

  return {
    lignes: detail.map(({ _ht_cts, _tva_cts, ...reste }) => reste),
    ventilation_tva: ventilation.map(({ _tva_cts, ...reste }) => reste),
    total_ht: euros(totalHtCts),
    total_tva: euros(totalTvaCts),
    total_ttc: euros(totalTtcCts),
    acompte: euros(acompteCts),
    net_a_payer: euros(totalTtcCts - acompteCts),
  };
}

/** Reste dû après imputation des paiements encaissés. */
function resteDu(totalTtc, paiements = []) {
  const versesCts = paiements.reduce((s, p) => s + centimes(p.montant), 0);
  return euros(centimes(totalTtc) - versesCts);
}

/** Échéance : date d'émission + délai convenu, sans dépasser les plafonds légaux. */
function calculerEcheance(dateEmission, delaiJours = 30) {
  // Le code de commerce plafonne à 60 jours date de facture (ou 45 jours fin de
  // mois). Au-delà, on ramène au plafond plutôt que d'écrire une clause nulle.
  const jours = Math.min(Math.max(Number(delaiJours) || 0, 0), 60);
  const d = new Date(`${dateEmission}T12:00:00`);
  d.setDate(d.getDate() + jours);
  return d.toISOString().slice(0, 10);
}

module.exports = { centimes, euros, calculerLigne, calculerDocument, resteDu, calculerEcheance };
