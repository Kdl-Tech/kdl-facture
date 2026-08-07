'use strict';

/**
 * Génération du XML Factur-X (norme EN 16931, syntaxe UN/CEFACT CII D16B).
 *
 * Une facture électronique n'est pas un PDF envoyé par mail : c'est un jeu de
 * données structurées que la machine du client lit sans intervention humaine.
 * Factur-X met les deux dans le même fichier — un PDF lisible par l'humain,
 * avec le XML agrafé dedans. Le lecteur choisit ce qu'il regarde.
 *
 * Profil retenu : EN 16931 (dit « COMFORT »), le plus riche des profils
 * couramment acceptés. Il porte le détail des lignes, la ventilation de TVA et
 * les références de commande — de quoi automatiser un rapprochement complet
 * chez le client.
 *
 * Ce module produit un XML conforme au format. Il ne transmet rien : l'envoi
 * vers une plateforme agréée est une étape distincte, hors de ce logiciel.
 */

const { calculerDocument } = require('./calculs');
const { territoire } = require('./territoires');

const PROFIL_EN16931 = 'urn:cen.eu:en16931:2017';

/** Codes de moyen de paiement UNTDID 4461, ceux qui servent réellement. */
const MOYENS_PAIEMENT = {
  virement: '30',
  prelevement: '49',
  carte: '48',
  cheque: '20',
  especes: '10',
  autre: '97',
};

/** Codes de type de document UNTDID 1001. */
const TYPES_DOCUMENT = {
  facture: '380',
  avoir: '381',
  acompte: '386',
};

function echapper(valeur) {
  return String(valeur ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Une date CII s'écrit AAAAMMJJ, format 102. */
function dateCII(iso) {
  return String(iso || '').replace(/-/g, '').slice(0, 8);
}

function montant(valeur) {
  return Number(valeur || 0).toFixed(2);
}

/**
 * Le prix unitaire après remise.
 *
 * La norme veut que le montant de la ligne soit exactement le prix net
 * multiplié par la quantité. Sans cette conversion, une ligne remisée
 * annonçait 100 € de prix pour 80 € de total, et tout validateur la rejetait.
 */
function prixNet(ligne) {
  const brut = Number(ligne.prix_ht) || 0;
  const remise = Number(ligne.remise_pct) || 0;
  return brut * (1 - remise / 100);
}

/**
 * Catégorie de TVA (UNTDID 5305) :
 *   S  — taux normal ou réduit
 *   E  — exonéré
 *   AE — autoliquidation par le preneur
 *   K  — livraison intracommunautaire
 *   G  — exportation hors UE
 */
function categorieTva(document, entreprise, client) {
  // La Guyane et Mayotte sont hors champ de la TVA : cela prime sur le régime
  // déclaré, parce que c'est le territoire qui décide, pas l'entreprise.
  if (!territoire(entreprise).tva) return 'E';
  if (entreprise.regime_tva === 'franchise') return 'E';
  if (document.autoliquidation) return 'AE';
  const paysClient = (client.pays || 'FR').toUpperCase();
  if (paysClient !== 'FR') {
    const UE = ['AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','GR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK'];
    if (UE.includes(paysClient) && client.tva_intra) return 'K';
    if (!UE.includes(paysClient)) return 'G';
  }
  return 'S';
}

/** La mention qui doit accompagner une facture sans TVA. */
function motifExoneration(categorie, entreprise) {
  switch (categorie) {
    case 'E': {
      const zone = territoire(entreprise);
      if (!zone.tva) return zone.mention;
      return entreprise.regime_tva === 'franchise'
        ? 'TVA non applicable, article 293 B du CGI'
        : 'Opération exonérée de TVA';
    }
    case 'AE':
      return 'Autoliquidation — article 283-2 du CGI';
    case 'K':
      return 'Exonération de TVA — article 262 ter I du CGI (livraison intracommunautaire)';
    case 'G':
      return 'Exonération de TVA — article 262 I du CGI (exportation)';
    default:
      return '';
  }
}

function bloc(nom, valeur) {
  return valeur === '' || valeur === null || valeur === undefined
    ? ''
    : `<${nom}>${echapper(valeur)}</${nom}>`;
}

function adresse(prefixe, e) {
  return [
    bloc('ram:PostcodeCode', e[`${prefixe}code_postal`] || e.code_postal),
    bloc('ram:LineOne', e[`${prefixe}adresse`] || e.adresse),
    bloc('ram:CityName', e[`${prefixe}ville`] || e.ville),
    bloc('ram:CountryID', (e[`${prefixe}pays`] || e.pays || 'FR').toUpperCase()),
  ].filter(Boolean).join('');
}

/**
 * Construit le XML CII d'un document.
 *
 * @param {object} donnees { document, entreprise, client, lignes, paiements }
 * @returns {string} XML complet, prêt à être agrafé au PDF.
 */
function genererXML({ document, entreprise, client, lignes }) {
  const totaux = calculerDocument(lignes, { acompte: document.acompte });
  const categorie = categorieTva(document, entreprise, client);
  const motif = motifExoneration(categorie, entreprise);
  const typeCode = TYPES_DOCUMENT[document.type] || TYPES_DOCUMENT.facture;
  const moyenCode = MOYENS_PAIEMENT[document.mode_paiement] || MOYENS_PAIEMENT.autre;

  const lignesXML = totaux.lignes.map((l, i) => `
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>${i + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>${bloc('ram:Name', l.designation)}</ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>${Number(l.remise_pct || 0) > 0 ? `
        <ram:GrossPriceProductTradePrice>
          <ram:ChargeAmount>${montant(l.prix_ht)}</ram:ChargeAmount>
          <ram:AppliedTradeAllowanceCharge>
            <ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator>
            <ram:ActualAmount>${montant(Number(l.prix_ht) * Number(l.remise_pct) / 100)}</ram:ActualAmount>
          </ram:AppliedTradeAllowanceCharge>
        </ram:GrossPriceProductTradePrice>` : ''}
        <ram:NetPriceProductTradePrice><ram:ChargeAmount>${montant(prixNet(l))}</ram:ChargeAmount></ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="${echapper(uniteCEFACT(l.unite))}">${Number(l.quantite).toFixed(4)}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${categorie}</ram:CategoryCode>
          <ram:RateApplicablePercent>${Number(l.tva_taux || 0).toFixed(2)}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${montant(l.montant_ht)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`).join('');

  const ventilationXML = totaux.ventilation_tva.map((v) => `
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${montant(v.montant_tva)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        ${motif ? bloc('ram:ExemptionReason', motif) : ''}
        <ram:BasisAmount>${montant(v.base_ht)}</ram:BasisAmount>
        <ram:CategoryCode>${categorie}</ram:CategoryCode>
        <ram:RateApplicablePercent>${Number(v.taux).toFixed(2)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>${PROFIL_EN16931}</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${echapper(document.numero)}</ram:ID>
    <ram:TypeCode>${typeCode}</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">${dateCII(document.date_emission)}</udt:DateTimeString></ram:IssueDateTime>
    ${document.note ? `<ram:IncludedNote><ram:Content>${echapper(document.note)}</ram:Content></ram:IncludedNote>` : ''}
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>${lignesXML}
    <ram:ApplicableHeaderTradeAgreement>
      ${document.reference_commande ? `<ram:BuyerReference>${echapper(document.reference_commande)}</ram:BuyerReference>` : ''}
      <ram:SellerTradeParty>
        ${bloc('ram:Name', entreprise.nom)}
        ${entreprise.siret ? `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0009">${echapper(entreprise.siret)}</ram:ID></ram:SpecifiedLegalOrganization>` : ''}
        <ram:PostalTradeAddress>${adresse('', entreprise)}</ram:PostalTradeAddress>
        ${entreprise.email ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${echapper(entreprise.email)}</ram:URIID></ram:URIUniversalCommunication>` : ''}
        ${entreprise.tva_intra ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${echapper(entreprise.tva_intra)}</ram:ID></ram:SpecifiedTaxRegistration>` : ''}
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        ${bloc('ram:Name', client.nom)}
        ${client.siret ? `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0009">${echapper(client.siret)}</ram:ID></ram:SpecifiedLegalOrganization>` : ''}
        <ram:PostalTradeAddress>${adresse('', client)}</ram:PostalTradeAddress>
        ${client.email ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${echapper(client.email)}</ram:URIID></ram:URIUniversalCommunication>` : ''}
        ${client.tva_intra ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${echapper(client.tva_intra)}</ram:ID></ram:SpecifiedTaxRegistration>` : ''}
      </ram:BuyerTradeParty>
      ${document.reference_commande ? `<ram:BuyerOrderReferencedDocument><ram:IssuerAssignedID>${echapper(document.reference_commande)}</ram:IssuerAssignedID></ram:BuyerOrderReferencedDocument>` : ''}
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>
      ${client.livraison_adresse ? `<ram:ShipToTradeParty><ram:PostalTradeAddress>${adresse('livraison_', client)}</ram:PostalTradeAddress></ram:ShipToTradeParty>` : ''}
      ${document.date_livraison ? `<ram:ActualDeliverySupplyChainEvent><ram:OccurrenceDateTime><udt:DateTimeString format="102">${dateCII(document.date_livraison)}</udt:DateTimeString></ram:OccurrenceDateTime></ram:ActualDeliverySupplyChainEvent>` : ''}
    </ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>${moyenCode}</ram:TypeCode>
        ${entreprise.iban ? `<ram:PayeePartyCreditorFinancialAccount><ram:IBANID>${echapper(entreprise.iban)}</ram:IBANID></ram:PayeePartyCreditorFinancialAccount>` : ''}
      </ram:SpecifiedTradeSettlementPaymentMeans>${ventilationXML}
      ${document.date_echeance ? `<ram:SpecifiedTradePaymentTerms><ram:DueDateDateTime><udt:DateTimeString format="102">${dateCII(document.date_echeance)}</udt:DateTimeString></ram:DueDateDateTime></ram:SpecifiedTradePaymentTerms>` : ''}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${montant(totaux.total_ht)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${montant(totaux.total_ht)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">${montant(totaux.total_tva)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${montant(totaux.total_ttc)}</ram:GrandTotalAmount>
        <ram:TotalPrepaidAmount>${montant(totaux.acompte)}</ram:TotalPrepaidAmount>
        <ram:DuePayableAmount>${montant(totaux.net_a_payer)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
      ${document.document_lie_numero ? `<ram:InvoiceReferencedDocument><ram:IssuerAssignedID>${echapper(document.document_lie_numero)}</ram:IssuerAssignedID></ram:InvoiceReferencedDocument>` : ''}
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
}

/** Unités CEFACT (rec. 20) pour les cas courants d'une TPE de services. */
function uniteCEFACT(unite) {
  const table = {
    heure: 'HUR', jour: 'DAY', mois: 'MON', unite: 'C62', piece: 'H87',
    forfait: 'C62', km: 'KMT', kg: 'KGM', litre: 'LTR', metre: 'MTR',
  };
  return table[String(unite || '').toLowerCase()] || 'C62';
}

/**
 * Contrôle métier avant émission : ce qui bloquerait une facture chez le client.
 * Mieux vaut refuser d'émettre que d'envoyer une facture qui sera rejetée.
 */
function verifier({ document, entreprise, client, lignes }) {
  const anomalies = [];
  const exiger = (condition, message) => { if (!condition) anomalies.push(message); };

  exiger(entreprise.nom, "Le nom de votre entreprise est vide.");
  exiger(/^\d{9}$/.test(String(entreprise.siren || '').replace(/\s/g, '')),
    "Le SIREN de votre entreprise doit comporter 9 chiffres.");
  exiger(entreprise.adresse && entreprise.ville, "L'adresse de votre entreprise est incomplète.");
  exiger(client.nom, "Le nom du client est vide.");
  exiger(client.adresse && client.ville, "L'adresse du client est incomplète.");
  exiger((lignes || []).length > 0, "La facture ne contient aucune ligne.");
  exiger(document.date_emission, "La date d'émission est absente.");
  // Une date au mauvais format traverse tout et ressort tronquée dans le XML :
  // « 2026/08/06 » devient « 2026/08/ », et la facture est rejetée à l'arrivée.
  // Comme elle est figée à l'émission, l'erreur ne se répare que par un avoir.
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  for (const champ of ['date_emission', 'date_echeance', 'date_livraison']) {
    const valeur = document[champ];
    if (valeur) {
      exiger(DATE.test(valeur) && !Number.isNaN(Date.parse(valeur)),
        `La ${champ.replace('date_', 'date d’').replace('_', ' ')} doit s'écrire AAAA-MM-JJ.`);
    }
  }
  exiger(['biens', 'services', 'mixte'].includes(document.categorie),
    "La catégorie d'opération doit être « biens », « services » ou « mixte ».");

  if (client.type === 'entreprise') {
    exiger(/^\d{9}$/.test(String(client.siren || '').replace(/\s/g, '')) ||
           /^\d{14}$/.test(String(client.siret || '').replace(/\s/g, '')),
      "Un client professionnel doit avoir un SIREN ou un SIRET : la réforme l'exige pour l'acheminement.");
  }
  if (client.type === 'public') {
    exiger(client.code_service, "Un client du secteur public exige un code service exécutant.");
  }

  // Un avoir porte des quantités négatives : c'est ainsi qu'il annule la
  // facture d'origine. Exiger du positif partout le rendrait inémissible.
  const avoir = document.type === 'avoir';
  for (const [i, l] of (lignes || []).entries()) {
    exiger(l.designation, `Ligne ${i + 1} : la désignation est vide.`);
    exiger(Number(l.quantite) !== 0, `Ligne ${i + 1} : la quantité ne peut pas être nulle.`);
    exiger(avoir ? Number(l.quantite) < 0 : Number(l.quantite) > 0,
      avoir
        ? `Ligne ${i + 1} : sur un avoir, la quantité doit être négative.`
        : `Ligne ${i + 1} : la quantité doit être positive.`);
    exiger(Number(l.prix_ht) >= 0, `Ligne ${i + 1} : le prix ne peut pas être négatif.`);
    const remise = Number(l.remise_pct || 0);
    exiger(remise >= 0 && remise <= 100,
      `Ligne ${i + 1} : la remise doit être comprise entre 0 et 100 %.`);
  }

  // Hors du régime normal, la facture ne peut porter aucune TVA : une catégorie
  // « exonéré », « autoliquidation », « intracommunautaire » ou « exportation »
  // accompagnée d'un taux non nul produit un XML contradictoire, rejeté par tout
  // validateur, et un PDF qui affiche à la fois l'exonération et le montant.
  const categorie = categorieTva(document, entreprise, client);
  if (categorie !== 'S') {
    const avecTaux = (lignes || []).filter((l) => Number(l.tva_taux) > 0);
    exiger(avecTaux.length === 0,
      `${motifExoneration(categorie, entreprise)} : aucune ligne ne peut porter de TVA.`);
  } else {
    // Une facture avec TVA doit porter le numéro de TVA du vendeur, et un
    // virement doit indiquer où payer. Les deux sont exigés par la norme.
    exiger(entreprise.tva_intra,
      "Votre numéro de TVA intracommunautaire est obligatoire dès lors que vous facturez de la TVA.");
    if (document.mode_paiement === 'virement') {
      exiger(entreprise.iban, "Un paiement par virement exige votre IBAN sur la facture.");
    }
  }

  if (entreprise.regime_tva === 'franchise') {
    const avecTva = (lignes || []).some((l) => Number(l.tva_taux) > 0);
    exiger(!avecTva, "Vous êtes en franchise de TVA : aucune ligne ne peut porter de TVA.");
  }

  const zone = territoire(entreprise);
  if (!zone.tva) {
    const avecTva = (lignes || []).some((l) => Number(l.tva_taux) > 0);
    exiger(!avecTva, `La TVA n'est pas applicable en ${zone.nom} (article 294 du CGI) : aucune ligne ne peut en porter.`);
  } else if (entreprise.regime_tva !== 'franchise') {
    // Un taux hors barème du territoire est presque toujours une erreur de
    // saisie — 20 % facturés depuis la Guadeloupe, par exemple.
    for (const [i, l] of (lignes || []).entries()) {
      const taux = Number(l.tva_taux);
      exiger(taux === 0 || zone.taux.includes(taux),
        `Ligne ${i + 1} : le taux de ${taux} % n'existe pas en ${zone.nom}. Taux applicables : ${zone.taux.join(' %, ')} %.`);
    }
  }

  return { valide: anomalies.length === 0, anomalies };
}

module.exports = {
  genererXML, verifier, categorieTva, motifExoneration, uniteCEFACT,
  PROFIL_EN16931, MOYENS_PAIEMENT, TYPES_DOCUMENT,
};
