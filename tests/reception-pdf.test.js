'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { genererPDF } = require('../src/pdf');
const { extrairePieceJointe } = require('../src/reception/pdf-piece-jointe');
const { lireCII } = require('../src/reception/cii');

const JEU = {
  entreprise: {
    nom: 'KDL TECH', siren: '123456782', siret: '12345678200019',
    tva_intra: 'FR11123456782', adresse: '1 rue des Palmiers',
    code_postal: '97100', ville: 'Basse-Terre', pays: 'FR',
    email: 'contact@kdl-tech.fr', iban: 'FR7630001007941234567890185', regime_tva: 'normal',
  },
  client: {
    type: 'entreprise', nom: 'Boulangerie Le Fournil', siren: '987654324',
    siret: '98765432400024', adresse: '5 avenue du Port', code_postal: '97110',
    ville: 'Pointe-à-Pitre', pays: 'FR', email: 'contact@fournil.fr',
  },
  document: {
    type: 'facture', numero: 'F2026-0001', date_emission: '2026-08-06',
    date_echeance: '2026-09-05', categorie: 'mixte', mode_paiement: 'virement',
  },
  lignes: [
    { designation: 'Dépannage informatique', quantite: 2, prix_ht: 60, tva_taux: 20, unite: 'heure' },
    { designation: 'Câble réseau', quantite: 1, prix_ht: 15, tva_taux: 20, unite: 'piece' },
  ],
  paiements: [],
};

/**
 * La chaîne complète, celle qu'un client vivra vraiment : une facture émise,
 * enregistrée en PDF, puis reçue et relue par le logiciel d'en face.
 */
test('le XML se récupère dans un PDF Factur-X, et se relit', async () => {
  const pdf = await genererPDF(JEU);
  const { nom, xml } = await extrairePieceJointe(new Uint8Array(pdf));

  assert.strictEqual(nom, 'factur-x.xml');
  assert.match(xml, /CrossIndustryInvoice/);

  const recue = lireCII(xml);
  assert.strictEqual(recue.numero, 'F2026-0001');
  assert.strictEqual(recue.fournisseur.siret, '12345678200019');
  assert.strictEqual(recue.totaux.total_ttc, 162);
  assert.strictEqual(recue.lignes.length, 2);
});

test('un devis na pas de pièce jointe, et le motif le dit clairement', async () => {
  const pdf = await genererPDF({
    ...JEU,
    document: { ...JEU.document, type: 'devis', numero: 'D2026-0001' },
  });
  await assert.rejects(
    () => extrairePieceJointe(new Uint8Array(pdf)),
    /aucun fichier embarqué/,
  );
});

test('un fichier qui nest pas un PDF est refusé avant toute lecture', async () => {
  await assert.rejects(
    () => extrairePieceJointe(new TextEncoder().encode('<?xml version="1.0"?><a/>')),
    /pas un PDF/,
  );
  await assert.rejects(() => extrairePieceJointe(new Uint8Array(0)), /vide/);
});

test('les accents traversent le PDF sans se perdre', async () => {
  const pdf = await genererPDF({
    ...JEU,
    client: { ...JEU.client, nom: 'Café & Thé — Émile SARL' },
  });
  const { xml } = await extrairePieceJointe(new Uint8Array(pdf));
  assert.strictEqual(lireCII(xml).client.nom, 'Café & Thé — Émile SARL');
});
