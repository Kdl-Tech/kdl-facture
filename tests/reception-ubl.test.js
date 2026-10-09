'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { lireUBL } = require('../src/reception/ubl');
const { lireCII } = require('../src/reception/cii');
const { genererXML } = require('../src/facturx');

/**
 * Une facture UBL telle que Peppol en transporte. Les identités sont fictives —
 * mêmes chiffres que le jeu CII des autres tests, pour pouvoir comparer les
 * deux lectures.
 */
const UBL = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
  <cbc:ID>F2026-0001</cbc:ID>
  <cbc:IssueDate>2026-08-06</cbc:IssueDate>
  <cbc:DueDate>2026-09-05</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>BON-2026-14</cbc:BuyerReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cbc:EndpointID schemeID="0009">12345678200019</cbc:EndpointID>
      <cac:PartyName><cbc:Name>KDL TECH</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>1 rue des Palmiers</cbc:StreetName>
        <cbc:CityName>Basse-Terre</cbc:CityName>
        <cbc:PostalZone>97100</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>FR</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>FR11123456782</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>KDL TECH</cbc:RegistrationName>
        <cbc:CompanyID schemeID="0009">12345678200019</cbc:CompanyID>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>Boulangerie Le Fournil</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>5 avenue du Port</cbc:StreetName>
        <cbc:CityName>Pointe-à-Pitre</cbc:CityName>
        <cbc:PostalZone>97110</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>FR</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyLegalEntity>
        <cbc:CompanyID schemeID="0009">98765432400024</cbc:CompanyID>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>
    <cac:PayeeFinancialAccount><cbc:ID>FR7630001007941234567890185</cbc:ID></cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">27.00</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">135.00</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">27.00</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>20.00</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">135.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">135.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">162.00</cbc:TaxInclusiveAmount>
    <cbc:PrepaidAmount currencyID="EUR">0.00</cbc:PrepaidAmount>
    <cbc:PayableAmount currencyID="EUR">162.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="HUR">2</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">120.00</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>Dépannage informatique</cbc:Name>
      <cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>20.00</cbc:Percent></cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">60.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
  <cac:InvoiceLine>
    <cbc:ID>2</cbc:ID>
    <cbc:InvoicedQuantity unitCode="H87">1</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">15.00</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>Câble réseau</cbc:Name>
      <cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>20.00</cbc:Percent></cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">15.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;

test('une facture UBL se lit comme une facture', () => {
  const f = lireUBL(UBL);
  assert.strictEqual(f.format, 'UBL');
  assert.strictEqual(f.numero, 'F2026-0001');
  assert.strictEqual(f.type, 'facture');
  assert.strictEqual(f.date_emission, '2026-08-06');
  assert.strictEqual(f.date_echeance, '2026-09-05');
  assert.strictEqual(f.reference_commande, 'BON-2026-14');
  assert.strictEqual(f.fournisseur.nom, 'KDL TECH');
  assert.strictEqual(f.fournisseur.siret, '12345678200019');
  assert.strictEqual(f.fournisseur.siren, '123456782');
  assert.strictEqual(f.fournisseur.tva_intra, 'FR11123456782');
  assert.strictEqual(f.client.nom, 'Boulangerie Le Fournil');
  assert.strictEqual(f.paiement.iban, 'FR7630001007941234567890185');
  assert.strictEqual(f.lignes.length, 2);
  assert.strictEqual(f.lignes[0].unite, 'heure');
  assert.strictEqual(f.lignes[0].montant_ht, 120);
  assert.strictEqual(f.totaux.total_ttc, 162);
});

/**
 * Le vrai enjeu des deux formats : au-delà de la lecture, plus rien dans le
 * logiciel ne doit dépendre de celui qui est arrivé.
 */
test('la même facture en CII et en UBL donne la même chose', () => {
  const parUBL = lireUBL(UBL);
  const parCII = lireCII(genererXML({
    document: {
      type: 'facture', numero: 'F2026-0001', date_emission: '2026-08-06',
      date_echeance: '2026-09-05', categorie: 'mixte', mode_paiement: 'virement',
      reference_commande: 'BON-2026-14',
    },
    entreprise: {
      nom: 'KDL TECH', siren: '123456782', siret: '12345678200019',
      tva_intra: 'FR11123456782', adresse: '1 rue des Palmiers', code_postal: '97100',
      ville: 'Basse-Terre', pays: 'FR', iban: 'FR7630001007941234567890185',
      regime_tva: 'normal',
    },
    client: {
      type: 'entreprise', nom: 'Boulangerie Le Fournil', siren: '987654324',
      siret: '98765432400024', adresse: '5 avenue du Port', code_postal: '97110',
      ville: 'Pointe-à-Pitre', pays: 'FR',
    },
    lignes: [
      { designation: 'Dépannage informatique', quantite: 2, prix_ht: 60, tva_taux: 20, unite: 'heure' },
      { designation: 'Câble réseau', quantite: 1, prix_ht: 15, tva_taux: 20, unite: 'piece' },
    ],
  }));

  for (const champ of ['numero', 'type', 'date_emission', 'date_echeance', 'devise', 'reference_commande']) {
    assert.strictEqual(parUBL[champ], parCII[champ], `champ « ${champ} »`);
  }
  assert.deepStrictEqual(parUBL.totaux, parCII.totaux);
  assert.strictEqual(parUBL.fournisseur.siret, parCII.fournisseur.siret);
  assert.strictEqual(parUBL.lignes.length, parCII.lignes.length);
  assert.strictEqual(parUBL.lignes[0].designation, parCII.lignes[0].designation);
  assert.strictEqual(parUBL.lignes[0].montant_ht, parCII.lignes[0].montant_ht);
  assert.strictEqual(parUBL.ventilation_tva[0].montant_tva, parCII.ventilation_tva[0].montant_tva);
});

test('un avoir UBL est reconnu, avec ses lignes propres', () => {
  const avoir = UBL
    .replace(/Invoice-2/g, 'CreditNote-2')
    .replace(/<Invoice /, '<CreditNote ')
    .replace('</Invoice>', '</CreditNote>')
    .replace(/cbc:InvoiceTypeCode/g, 'cbc:CreditNoteTypeCode')
    .replace(/380/, '381')
    .replace(/cac:InvoiceLine/g, 'cac:CreditNoteLine')
    .replace(/cbc:InvoicedQuantity/g, 'cbc:CreditedQuantity');
  const f = lireUBL(avoir);
  assert.strictEqual(f.type, 'avoir');
  assert.strictEqual(f.type_code, '381');
  assert.strictEqual(f.lignes.length, 2);
  assert.strictEqual(f.lignes[0].quantite, 2);
});

test('un document qui nest pas un UBL est refusé', () => {
  assert.throws(() => lireUBL('<Facture><ID>1</ID></Facture>'), /pas une facture UBL/);
});
