'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { genererXML, verifier, categorieTva, uniteCEFACT } = require('../src/facturx');

const ENTREPRISE = {
  nom: 'KDL TECH', siren: '123456789', siret: '12345678900019',
  tva_intra: 'FR12123456789', adresse: '1 rue des Palmiers',
  code_postal: '97100', ville: 'Basse-Terre', pays: 'FR',
  email: 'contact@kdl-tech.fr', iban: 'FR7630001007941234567890185',
  regime_tva: 'normal',
};
const CLIENT = {
  type: 'entreprise', nom: 'Boulangerie Le Fournil', siren: '987654321',
  siret: '98765432100014', adresse: '5 avenue du Port',
  code_postal: '97110', ville: 'Pointe-à-Pitre', pays: 'FR',
  email: 'contact@fournil.fr',
};
const LIGNES = [
  { designation: 'Dépannage informatique', quantite: 2, prix_ht: 60, tva_taux: 20, unite: 'heure' },
  { designation: 'Câble réseau', quantite: 1, prix_ht: 15, tva_taux: 20, unite: 'piece' },
];
const DOCUMENT = {
  type: 'facture', numero: 'F2026-0001', date_emission: '2026-08-06',
  date_echeance: '2026-09-05', categorie: 'mixte', mode_paiement: 'virement',
};

test('le XML porte le profil EN 16931 et le bon type de document', () => {
  const xml = genererXML({ document: DOCUMENT, entreprise: ENTREPRISE, client: CLIENT, lignes: LIGNES });
  assert.match(xml, /urn:cen\.eu:en16931:2017/);
  assert.match(xml, /<ram:TypeCode>380<\/ram:TypeCode>/);
  assert.match(xml, /<ram:ID>F2026-0001<\/ram:ID>/);
});

test('les dates sont au format CII AAAAMMJJ', () => {
  const xml = genererXML({ document: DOCUMENT, entreprise: ENTREPRISE, client: CLIENT, lignes: LIGNES });
  assert.match(xml, /format="102">20260806</);
  assert.match(xml, /format="102">20260905</);
});

test('les totaux du XML sont ceux de la facture', () => {
  const xml = genererXML({ document: DOCUMENT, entreprise: ENTREPRISE, client: CLIENT, lignes: LIGNES });
  assert.match(xml, /<ram:LineTotalAmount>135\.00<\/ram:LineTotalAmount>/);
  assert.match(xml, /<ram:TaxTotalAmount currencyID="EUR">27\.00<\/ram:TaxTotalAmount>/);
  assert.match(xml, /<ram:GrandTotalAmount>162\.00<\/ram:GrandTotalAmount>/);
  assert.match(xml, /<ram:DuePayableAmount>162\.00<\/ram:DuePayableAmount>/);
});

test('un avoir porte le code 381', () => {
  const xml = genererXML({
    document: { ...DOCUMENT, type: 'avoir', document_lie_numero: 'F2026-0001' },
    entreprise: ENTREPRISE, client: CLIENT, lignes: LIGNES,
  });
  assert.match(xml, /<ram:TypeCode>381<\/ram:TypeCode>/);
  assert.match(xml, /<ram:InvoiceReferencedDocument>[\s\S]*F2026-0001/);
});

test('les caractères spéciaux ne cassent pas le XML', () => {
  const xml = genererXML({
    document: DOCUMENT, entreprise: ENTREPRISE, client: { ...CLIENT, nom: 'Dupont & Fils <SARL>' }, lignes: LIGNES,
  });
  assert.match(xml, /Dupont &amp; Fils &lt;SARL&gt;/);
  assert.doesNotMatch(xml, /Fils <SARL>/);
});

test('la franchise de TVA sort en catégorie E avec le bon article', () => {
  const franchise = { ...ENTREPRISE, regime_tva: 'franchise', tva_intra: '' };
  const lignes = [{ designation: 'Prestation', quantite: 1, prix_ht: 100, tva_taux: 0 }];
  const xml = genererXML({ document: DOCUMENT, entreprise: franchise, client: CLIENT, lignes });
  assert.strictEqual(categorieTva(DOCUMENT, franchise, CLIENT), 'E');
  assert.match(xml, /article 293 B du CGI/);
});

test('un client européen avec TVA intra passe en livraison intracommunautaire', () => {
  const belge = { ...CLIENT, pays: 'BE', tva_intra: 'BE0123456789' };
  assert.strictEqual(categorieTva(DOCUMENT, ENTREPRISE, belge), 'K');
});

test('un client hors UE passe en exportation', () => {
  assert.strictEqual(categorieTva(DOCUMENT, ENTREPRISE, { ...CLIENT, pays: 'US' }), 'G');
});

test('les unités sont traduites en codes CEFACT', () => {
  assert.strictEqual(uniteCEFACT('heure'), 'HUR');
  assert.strictEqual(uniteCEFACT('jour'), 'DAY');
  assert.strictEqual(uniteCEFACT('piece'), 'H87');
  assert.strictEqual(uniteCEFACT('inconnue'), 'C62');
});

test('le contrôle avant émission laisse passer une facture complète', () => {
  const r = verifier({ document: DOCUMENT, entreprise: ENTREPRISE, client: CLIENT, lignes: LIGNES });
  assert.strictEqual(r.valide, true, r.anomalies.join(' / '));
});

test('un SIREN absent chez un client professionnel bloque lémission', () => {
  const r = verifier({
    document: DOCUMENT, entreprise: ENTREPRISE,
    client: { ...CLIENT, siren: '', siret: '' }, lignes: LIGNES,
  });
  assert.strictEqual(r.valide, false);
  assert.ok(r.anomalies.some((a) => a.includes('SIREN')));
});

test('une facture sans ligne est refusée', () => {
  const r = verifier({ document: DOCUMENT, entreprise: ENTREPRISE, client: CLIENT, lignes: [] });
  assert.strictEqual(r.valide, false);
  assert.ok(r.anomalies.some((a) => a.includes('aucune ligne')));
});

test('la franchise de TVA interdit une ligne avec TVA', () => {
  const r = verifier({
    document: DOCUMENT, entreprise: { ...ENTREPRISE, regime_tva: 'franchise' },
    client: CLIENT, lignes: LIGNES,
  });
  assert.strictEqual(r.valide, false);
  assert.ok(r.anomalies.some((a) => a.includes('franchise')));
});

test('un client public sans code service est refusé', () => {
  const r = verifier({
    document: DOCUMENT, entreprise: ENTREPRISE,
    client: { ...CLIENT, type: 'public', code_service: '' }, lignes: LIGNES,
  });
  assert.strictEqual(r.valide, false);
  assert.ok(r.anomalies.some((a) => a.includes('code service')));
});

test('une catégorie dopération invalide est refusée', () => {
  const r = verifier({
    document: { ...DOCUMENT, categorie: 'autre' }, entreprise: ENTREPRISE, client: CLIENT, lignes: LIGNES,
  });
  assert.strictEqual(r.valide, false);
});
