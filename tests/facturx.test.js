'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  genererXML, verifier, categorieTva, uniteCEFACT, luhnValide,
} = require('../src/facturx');

const ENTREPRISE = {
  nom: 'KDL TECH', siren: '123456782', siret: '12345678200019',
  tva_intra: 'FR11123456782', adresse: '1 rue des Palmiers',
  code_postal: '97100', ville: 'Basse-Terre', pays: 'FR',
  email: 'contact@kdl-tech.fr', iban: 'FR7630001007941234567890185',
  regime_tva: 'normal',
};
const CLIENT = {
  type: 'entreprise', nom: 'Boulangerie Le Fournil', siren: '987654324',
  siret: '98765432400024', adresse: '5 avenue du Port',
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

/**
 * Un devis se chiffre parfois avant même de connaître l'adresse du client —
 * sur le pas de la porte, avec juste un nom. La réforme Factur-X (SIREN,
 * adresse, TVA intracommunautaire, IBAN...) ne s'applique qu'à la facture.
 */
test('un devis sans adresse ni SIREN, côté client comme entreprise, est accepté', () => {
  const r = verifier({
    document: { type: 'devis', numero: 'D2026-0001', date_emission: '2026-09-09' },
    entreprise: { nom: 'KDL TECH', regime_tva: 'franchise' },
    client: { nom: 'Jean Pierre' },
    lignes: [{ designation: 'Configuration imprimante', quantite: 1, prix_ht: 49, tva_taux: 0 }],
  });
  assert.strictEqual(r.valide, true, r.anomalies.join(' / '));
});

test('un devis garde les contrôles de base : nom du client et au moins une ligne', () => {
  const sansClient = verifier({
    document: { type: 'devis', numero: 'D2026-0001', date_emission: '2026-09-09' },
    entreprise: { nom: 'KDL TECH' }, client: { nom: '' }, lignes: LIGNES,
  });
  assert.strictEqual(sansClient.valide, false);
  assert.ok(sansClient.anomalies.some((a) => a.includes('client')));

  const sansLigne = verifier({
    document: { type: 'devis', numero: 'D2026-0001', date_emission: '2026-09-09' },
    entreprise: { nom: 'KDL TECH' }, client: { nom: 'Jean Pierre' }, lignes: [],
  });
  assert.strictEqual(sansLigne.valide, false);
  assert.ok(sansLigne.anomalies.some((a) => a.includes('aucune ligne')));
});

/**
 * La clé de contrôle attrape l'erreur que la longueur laisse passer : deux
 * chiffres inversés en recopiant un numéro. Une facture émise étant figée, elle
 * ne se répare que par un avoir — le contrôle doit donc bloquer avant.
 */
test('un SIREN dont la clé ne tombe pas juste est refusé', () => {
  const r = verifier({
    document: DOCUMENT, entreprise: { ...ENTREPRISE, siren: '123456789', siret: '' },
    client: CLIENT, lignes: LIGNES,
  });
  assert.strictEqual(r.valide, false);
  assert.ok(r.anomalies.some((a) => a.includes('clé de contrôle')), r.anomalies.join(' / '));
});

test('deux chiffres inversés dans le SIRET de lentreprise sont détectés', () => {
  const r = verifier({
    document: DOCUMENT, entreprise: { ...ENTREPRISE, siret: '12345678200091' },
    client: CLIENT, lignes: LIGNES,
  });
  assert.strictEqual(r.valide, false);
  assert.ok(r.anomalies.some((a) => a.includes('SIRET de votre entreprise')), r.anomalies.join(' / '));
});

test('un SIRET client faux bloque lémission et nomme le numéro en cause', () => {
  const r = verifier({
    document: DOCUMENT, entreprise: ENTREPRISE,
    client: { ...CLIENT, siren: '', siret: '98765432400025' }, lignes: LIGNES,
  });
  assert.strictEqual(r.valide, false);
  assert.ok(r.anomalies.some((a) => a.includes('98765432400025')), r.anomalies.join(' / '));
});

test('un client étranger nest pas soumis à la clé française', () => {
  const r = verifier({
    document: DOCUMENT, entreprise: ENTREPRISE,
    client: {
      ...CLIENT, pays: 'BE', tva_intra: 'BE0123456789',
      siren: '123456789', siret: '',
    },
    lignes: LIGNES,
  });
  assert.ok(!r.anomalies.some((a) => a.includes('clé de contrôle')), r.anomalies.join(' / '));
});

/**
 * Les établissements de La Poste (SIREN 356000000) échappent à Luhn : leur
 * validité tient à une somme de chiffres divisible par 5. Le numéro ci-dessous
 * est construit pour exercer la règle, ce n'est pas l'identifiant d'un
 * établissement réel.
 */
test('la règle propre à La Poste est appliquée au lieu de Luhn', () => {
  assert.strictEqual(luhnValide('35600000000042'), true, 'somme 20, multiple de 5');
  assert.strictEqual(luhnValide('35600000000043'), false, 'somme 21, non multiple de 5');
});

test('la clé de contrôle rejette tout ce qui nest pas un nombre', () => {
  assert.strictEqual(luhnValide(''), false);
  assert.strictEqual(luhnValide('12345678A'), false);
  assert.strictEqual(luhnValide(null), false);
});
