'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { genererXML } = require('../src/facturx');
const { lireCII, dateDepuisCII } = require('../src/reception/cii');

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
  { designation: 'Dépannage informatique', quantite: 2, prix_ht: 60, tva_taux: 8.5, unite: 'heure' },
  { designation: 'Câble réseau', quantite: 1, prix_ht: 15, tva_taux: 8.5, unite: 'piece' },
];
const DOCUMENT = {
  type: 'facture', numero: 'F2026-0001', date_emission: '2026-08-06',
  date_echeance: '2026-09-05', categorie: 'mixte', mode_paiement: 'virement',
};
const JEU = {
  document: DOCUMENT, entreprise: ENTREPRISE, client: CLIENT, lignes: LIGNES,
};

/**
 * L'aller-retour est le meilleur contrôle qu'on puisse s'offrir : ce que le
 * logiciel émet, il doit savoir le relire à l'identique. Si un jour l'émission
 * change sans que la lecture suive, ce test tombe.
 */
test('une facture émise par KDL Facture se relit sans perte', () => {
  const recue = lireCII(genererXML(JEU));

  assert.strictEqual(recue.format, 'CII');
  assert.match(recue.profil, /en16931/);
  assert.strictEqual(recue.numero, 'F2026-0001');
  assert.strictEqual(recue.type, 'facture');
  assert.strictEqual(recue.date_emission, '2026-08-06');
  assert.strictEqual(recue.date_echeance, '2026-09-05');
  assert.strictEqual(recue.devise, 'EUR');

  assert.strictEqual(recue.fournisseur.nom, 'KDL TECH');
  assert.strictEqual(recue.fournisseur.siret, '12345678200019');
  assert.strictEqual(recue.fournisseur.siren, '123456782');
  assert.strictEqual(recue.fournisseur.tva_intra, 'FR11123456782');
  assert.strictEqual(recue.fournisseur.ville, 'Basse-Terre');
  assert.strictEqual(recue.client.nom, 'Boulangerie Le Fournil');
  assert.strictEqual(recue.client.siret, '98765432400024');
  assert.strictEqual(recue.paiement.iban, 'FR7630001007941234567890185');
});

test('les lignes reçues portent les mêmes chiffres que les lignes émises', () => {
  const recue = lireCII(genererXML(JEU));
  assert.strictEqual(recue.lignes.length, 2);

  const [premiere, seconde] = recue.lignes;
  assert.strictEqual(premiere.designation, 'Dépannage informatique');
  assert.strictEqual(premiere.quantite, 2);
  assert.strictEqual(premiere.unite, 'heure');
  assert.strictEqual(premiere.prix_ht, 60);
  assert.strictEqual(premiere.tva_taux, 8.5);
  assert.strictEqual(premiere.montant_ht, 120);

  assert.strictEqual(seconde.unite, 'piece');
  assert.strictEqual(seconde.montant_ht, 15);
});

test('les totaux et la ventilation de TVA sont relus exactement', () => {
  const recue = lireCII(genererXML(JEU));
  assert.strictEqual(recue.totaux.total_ht, 135);
  assert.strictEqual(recue.totaux.total_tva, 11.48);
  assert.strictEqual(recue.totaux.total_ttc, 146.48);
  assert.strictEqual(recue.totaux.net_a_payer, 146.48);
  assert.strictEqual(recue.totaux.acompte, 0);

  assert.strictEqual(recue.ventilation_tva.length, 1);
  assert.strictEqual(recue.ventilation_tva[0].taux, 8.5);
  assert.strictEqual(recue.ventilation_tva[0].base_ht, 135);
  assert.strictEqual(recue.ventilation_tva[0].montant_tva, 11.48);
});

test('un avoir est reconnu comme tel, pas comme une facture', () => {
  const recue = lireCII(genererXML({
    ...JEU,
    document: { ...DOCUMENT, type: 'avoir', numero: 'A2026-0001' },
    lignes: LIGNES.map((l) => ({ ...l, quantite: -l.quantite })),
  }));
  assert.strictEqual(recue.type, 'avoir');
  assert.strictEqual(recue.type_code, '381');
  assert.strictEqual(recue.lignes[0].quantite, -2);
});

test('une facture en franchise de TVA garde son motif dexonération', () => {
  const recue = lireCII(genererXML({
    ...JEU,
    entreprise: { ...ENTREPRISE, regime_tva: 'franchise', tva_intra: '' },
    lignes: LIGNES.map((l) => ({ ...l, tva_taux: 0 })),
  }));
  assert.strictEqual(recue.totaux.total_tva, 0);
  assert.strictEqual(recue.ventilation_tva[0].categorie, 'E');
  assert.match(recue.ventilation_tva[0].motif_exoneration, /293 B/);
});

test('les accents et les esperluettes survivent à laller-retour', () => {
  const recue = lireCII(genererXML({
    ...JEU,
    client: { ...CLIENT, nom: 'Café & Thé — Émile SARL' },
    lignes: [{ ...LIGNES[0], designation: 'Réparation « urgente » <atelier>' }],
  }));
  assert.strictEqual(recue.client.nom, 'Café & Thé — Émile SARL');
  assert.strictEqual(recue.lignes[0].designation, 'Réparation « urgente » <atelier>');
});

test('une date CII se convertit, et une date illisible ne devient jamais fausse', () => {
  assert.strictEqual(dateDepuisCII('20260806'), '2026-08-06');
  assert.strictEqual(dateDepuisCII('2026-08-06T10:00:00'), '2026-08-06');
  assert.strictEqual(dateDepuisCII('06/08/2026'), '');
  assert.strictEqual(dateDepuisCII(''), '');
});

test('un document qui nest pas un CII est refusé clairement', () => {
  assert.throws(() => lireCII('<Invoice><ID>1</ID></Invoice>'), /pas une facture CII/);
  assert.throws(() => lireCII('<rsm:CrossIndustryInvoice xmlns:rsm="urn:x"/>'), /incomplet/);
});
