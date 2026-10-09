'use strict';

/**
 * Lecture d'une facture reçue au format CII — le XML de Factur-X.
 *
 * C'est la moitié du logiciel dont on a besoin en premier : à partir de
 * septembre 2026, toute entreprise doit savoir *recevoir* une facture
 * électronique, même celles qui n'ont pas encore l'obligation d'en émettre.
 *
 * Le résultat est un objet neutre, commun au CII et à l'UBL, pour que le reste
 * du logiciel n'ait jamais à savoir dans quel format la facture est arrivée.
 */

const {
  analyserXML, tous, trouver, valeur, nombre,
} = require('./xml');

const TYPES_LUS = {
  380: 'facture',
  381: 'avoir',
  386: 'acompte',
  384: 'rectificative',
  389: 'autofacturation',
};

const UNITES_LUES = {
  HUR: 'heure', DAY: 'jour', MON: 'mois', C62: 'unite', H87: 'piece',
  KMT: 'km', KGM: 'kg', LTR: 'litre', MTR: 'metre',
};

/** `20260806` → `2026-08-06`. Une date illisible ressort vide, jamais fausse. */
function dateDepuisCII(brut) {
  const t = String(brut || '').trim();
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  return '';
}

function lirePartie(noeud) {
  if (!noeud) return null;
  const identifiant = valeur(noeud, 'SpecifiedLegalOrganization/ID');
  const nu = identifiant.replace(/\s/g, '');
  return {
    nom: valeur(noeud, 'Name'),
    siret: /^\d{14}$/.test(nu) ? nu : '',
    siren: /^\d{9}$/.test(nu) ? nu : (/^\d{14}$/.test(nu) ? nu.slice(0, 9) : ''),
    tva_intra: valeur(noeud, 'SpecifiedTaxRegistration/ID'),
    email: valeur(noeud, 'URIUniversalCommunication/URIID'),
    adresse: valeur(noeud, 'PostalTradeAddress/LineOne'),
    code_postal: valeur(noeud, 'PostalTradeAddress/PostcodeCode'),
    ville: valeur(noeud, 'PostalTradeAddress/CityName'),
    pays: valeur(noeud, 'PostalTradeAddress/CountryID') || 'FR',
  };
}

function lireLignes(transaction) {
  return tous(transaction, 'IncludedSupplyChainTradeLineItem').map((l, i) => {
    const quantite = trouver(l, 'SpecifiedLineTradeDelivery/BilledQuantity');
    const unitCode = quantite ? quantite.attributs.unitCode : '';
    return {
      numero: valeur(l, 'AssociatedDocumentLineDocument/LineID') || String(i + 1),
      designation: valeur(l, 'SpecifiedTradeProduct/Name'),
      quantite: nombre(l, 'SpecifiedLineTradeDelivery/BilledQuantity'),
      unite: UNITES_LUES[unitCode] || (unitCode ? unitCode.toLowerCase() : 'unite'),
      prix_ht: nombre(l, 'SpecifiedLineTradeAgreement/NetPriceProductTradePrice/ChargeAmount'),
      tva_taux: nombre(l, 'SpecifiedLineTradeSettlement/ApplicableTradeTax/RateApplicablePercent') || 0,
      tva_categorie: valeur(l, 'SpecifiedLineTradeSettlement/ApplicableTradeTax/CategoryCode'),
      montant_ht: nombre(
        l,
        'SpecifiedLineTradeSettlement/SpecifiedTradeSettlementLineMonetarySummation/LineTotalAmount',
      ),
    };
  });
}

/**
 * Lit un XML CII et renvoie une facture reçue.
 * @throws {Error} si le document n'est pas un CII lisible.
 */
function lireCII(source) {
  const racine = analyserXML(source);
  if (racine.local !== 'CrossIndustryInvoice') {
    throw new Error(`Ce document n'est pas une facture CII (racine « ${racine.nom} »).`);
  }

  const entete = trouver(racine, 'ExchangedDocument');
  const transaction = trouver(racine, 'SupplyChainTradeTransaction');
  if (!entete || !transaction) {
    throw new Error("Le document CII est incomplet : en-tête ou transaction absente.");
  }

  const accord = trouver(transaction, 'ApplicableHeaderTradeAgreement');
  const reglement = trouver(transaction, 'ApplicableHeaderTradeSettlement');
  const somme = trouver(reglement, 'SpecifiedTradeSettlementHeaderMonetarySummation');
  const typeCode = valeur(entete, 'TypeCode');

  return {
    format: 'CII',
    profil: valeur(racine, 'ExchangedDocumentContext/GuidelineSpecifiedDocumentContextParameter/ID'),
    numero: valeur(entete, 'ID'),
    type: TYPES_LUS[typeCode] || `inconnu(${typeCode})`,
    type_code: typeCode,
    note: valeur(entete, 'IncludedNote/Content'),
    date_emission: dateDepuisCII(valeur(entete, 'IssueDateTime/DateTimeString')),
    date_echeance: dateDepuisCII(
      valeur(reglement, 'SpecifiedTradePaymentTerms/DueDateDateTime/DateTimeString'),
    ),
    date_livraison: dateDepuisCII(valeur(
      transaction,
      'ApplicableHeaderTradeDelivery/ActualDeliverySupplyChainEvent/OccurrenceDateTime/DateTimeString',
    )),
    devise: valeur(reglement, 'InvoiceCurrencyCode') || 'EUR',
    fournisseur: lirePartie(trouver(accord, 'SellerTradeParty')),
    client: lirePartie(trouver(accord, 'BuyerTradeParty')),
    reference_commande: valeur(accord, 'BuyerReference')
      || valeur(accord, 'BuyerOrderReferencedDocument/IssuerAssignedID'),
    document_lie: valeur(reglement, 'InvoiceReferencedDocument/IssuerAssignedID'),
    lignes: lireLignes(transaction),
    ventilation_tva: tous(reglement, 'ApplicableTradeTax').map((t) => ({
      taux: nombre(t, 'RateApplicablePercent') || 0,
      base_ht: nombre(t, 'BasisAmount'),
      montant_tva: nombre(t, 'CalculatedAmount'),
      categorie: valeur(t, 'CategoryCode'),
      motif_exoneration: valeur(t, 'ExemptionReason'),
    })),
    paiement: {
      moyen_code: valeur(reglement, 'SpecifiedTradeSettlementPaymentMeans/TypeCode'),
      iban: valeur(
        reglement,
        'SpecifiedTradeSettlementPaymentMeans/PayeePartyCreditorFinancialAccount/IBANID',
      ),
    },
    totaux: {
      total_ht: nombre(somme, 'LineTotalAmount'),
      base_tva: nombre(somme, 'TaxBasisTotalAmount'),
      total_tva: nombre(somme, 'TaxTotalAmount'),
      total_ttc: nombre(somme, 'GrandTotalAmount'),
      acompte: nombre(somme, 'TotalPrepaidAmount') || 0,
      net_a_payer: nombre(somme, 'DuePayableAmount'),
    },
  };
}

module.exports = { lireCII, dateDepuisCII, TYPES_LUS };
