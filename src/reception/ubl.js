'use strict';

/**
 * Lecture d'une facture reçue au format UBL.
 *
 * Le socle réglementaire admet trois formats : le CII de Factur-X, l'UBL, et
 * le mixte. Un logiciel qui ne lirait que Factur-X refuserait les factures des
 * entreprises passées par Peppol — c'est-à-dire une bonne partie de celles qui
 * facturent déjà des administrations européennes.
 *
 * Le résultat suit exactement le même modèle que `cii.js` : au-delà de ce
 * module, plus personne n'a besoin de savoir dans quel format la facture est
 * arrivée.
 */

const {
  analyserXML, tous, trouver, valeur, nombre,
} = require('./xml');
const { TYPES_LUS } = require('./cii');

const UNITES_LUES = {
  HUR: 'heure', DAY: 'jour', MON: 'mois', C62: 'unite', H87: 'piece',
  KMT: 'km', KGM: 'kg', LTR: 'litre', MTR: 'metre',
};

function lirePartie(noeud) {
  if (!noeud) return null;
  const partie = trouver(noeud, 'Party');
  if (!partie) return null;
  const identifiant = (valeur(partie, 'PartyLegalEntity/CompanyID')
    || valeur(partie, 'EndpointID')).replace(/\s/g, '');
  return {
    nom: valeur(partie, 'PartyName/Name') || valeur(partie, 'PartyLegalEntity/RegistrationName'),
    siret: /^\d{14}$/.test(identifiant) ? identifiant : '',
    siren: /^\d{9}$/.test(identifiant)
      ? identifiant
      : (/^\d{14}$/.test(identifiant) ? identifiant.slice(0, 9) : ''),
    tva_intra: valeur(partie, 'PartyTaxScheme/CompanyID'),
    email: valeur(partie, 'Contact/ElectronicMail'),
    adresse: [
      valeur(partie, 'PostalAddress/StreetName'),
      valeur(partie, 'PostalAddress/AdditionalStreetName'),
    ].filter(Boolean).join(' '),
    code_postal: valeur(partie, 'PostalAddress/PostalZone'),
    ville: valeur(partie, 'PostalAddress/CityName'),
    pays: valeur(partie, 'PostalAddress/Country/IdentificationCode') || 'FR',
  };
}

function lireLignes(racine, avoir) {
  const chemin = avoir ? 'CreditNoteLine' : 'InvoiceLine';
  const champQuantite = avoir ? 'CreditedQuantity' : 'InvoicedQuantity';
  return tous(racine, chemin).map((l, i) => {
    const quantite = trouver(l, champQuantite);
    const unitCode = quantite ? quantite.attributs.unitCode : '';
    return {
      numero: valeur(l, 'ID') || String(i + 1),
      designation: valeur(l, 'Item/Name'),
      quantite: nombre(l, champQuantite),
      unite: UNITES_LUES[unitCode] || (unitCode ? unitCode.toLowerCase() : 'unite'),
      prix_ht: nombre(l, 'Price/PriceAmount'),
      tva_taux: nombre(l, 'Item/ClassifiedTaxCategory/Percent') || 0,
      tva_categorie: valeur(l, 'Item/ClassifiedTaxCategory/ID'),
      montant_ht: nombre(l, 'LineExtensionAmount'),
    };
  });
}

/**
 * Lit un XML UBL (facture ou avoir) et renvoie une facture reçue.
 * @throws {Error} si le document n'est pas un UBL lisible.
 */
function lireUBL(source) {
  const racine = analyserXML(source);
  const avoir = racine.local === 'CreditNote';
  if (racine.local !== 'Invoice' && !avoir) {
    throw new Error(`Ce document n'est pas une facture UBL (racine « ${racine.nom} »).`);
  }

  const typeCode = valeur(racine, avoir ? 'CreditNoteTypeCode' : 'InvoiceTypeCode')
    || (avoir ? '381' : '380');
  const totaux = trouver(racine, 'LegalMonetaryTotal');
  const taxes = trouver(racine, 'TaxTotal');

  return {
    format: 'UBL',
    profil: valeur(racine, 'CustomizationID'),
    numero: valeur(racine, 'ID'),
    type: TYPES_LUS[typeCode] || `inconnu(${typeCode})`,
    type_code: typeCode,
    note: valeur(racine, 'Note'),
    date_emission: valeur(racine, 'IssueDate'),
    date_echeance: valeur(racine, 'DueDate')
      || valeur(racine, 'PaymentMeans/PaymentDueDate'),
    date_livraison: valeur(racine, 'Delivery/ActualDeliveryDate'),
    devise: valeur(racine, 'DocumentCurrencyCode') || 'EUR',
    fournisseur: lirePartie(trouver(racine, 'AccountingSupplierParty')),
    client: lirePartie(trouver(racine, 'AccountingCustomerParty')),
    reference_commande: valeur(racine, 'BuyerReference')
      || valeur(racine, 'OrderReference/ID'),
    document_lie: valeur(racine, 'BillingReference/InvoiceDocumentReference/ID'),
    lignes: lireLignes(racine, avoir),
    ventilation_tva: tous(taxes, 'TaxSubtotal').map((t) => ({
      taux: nombre(t, 'TaxCategory/Percent') || 0,
      base_ht: nombre(t, 'TaxableAmount'),
      montant_tva: nombre(t, 'TaxAmount'),
      categorie: valeur(t, 'TaxCategory/ID'),
      motif_exoneration: valeur(t, 'TaxCategory/TaxExemptionReason'),
    })),
    paiement: {
      moyen_code: valeur(racine, 'PaymentMeans/PaymentMeansCode'),
      iban: valeur(racine, 'PaymentMeans/PayeeFinancialAccount/ID'),
    },
    totaux: {
      total_ht: nombre(totaux, 'LineExtensionAmount'),
      base_tva: nombre(totaux, 'TaxExclusiveAmount'),
      total_tva: nombre(taxes, 'TaxAmount'),
      total_ttc: nombre(totaux, 'TaxInclusiveAmount'),
      acompte: nombre(totaux, 'PrepaidAmount') || 0,
      net_a_payer: nombre(totaux, 'PayableAmount'),
    },
  };
}

module.exports = { lireUBL };
