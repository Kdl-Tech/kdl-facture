'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { composerMessage, lienMailto, nomFichier } = require('../src/pwa/message-facture');

const ENTREPRISE = { nom: 'KDL TECH', email: 'contact@kdl-tech.fr' };
const CLIENT = { nom: 'Cabinet Duval', email: 'contact@duval.fr' };

const FACTURE = {
  type: 'facture',
  numero: 'F-2026-0001',
  date_emission: '2026-08-25',
  date_echeance: '2026-09-24',
  totaux: { net_a_payer: 1234.5 },
};

test('le message porte le numéro, la date, le montant et l échéance', () => {
  const m = composerMessage({ document: FACTURE, entreprise: ENTREPRISE, client: CLIENT });

  assert.strictEqual(m.destinataire, 'contact@duval.fr');
  assert.strictEqual(m.objet, 'Facture n° F-2026-0001 — KDL TECH');
  assert.match(m.corps, /F-2026-0001/);
  assert.match(m.corps, /25\/08\/2026/);
  assert.match(m.corps, /1 234,50 € TTC/);
  assert.match(m.corps, /24\/09\/2026/);
  assert.match(m.corps, /KDL TECH/);
  assert.strictEqual(m.nomFichier, 'F-2026-0001.pdf');
});

test('un avoir ne se réclame pas : ni « TTC à payer », ni échéance', () => {
  const m = composerMessage({
    document: { ...FACTURE, type: 'avoir', numero: 'A-2026-0003', totaux: { net_a_payer: -80 } },
    entreprise: ENTREPRISE,
    client: CLIENT,
  });

  assert.match(m.objet, /^Avoir n° A-2026-0003/);
  assert.match(m.corps, /80,00 € en votre faveur/);
  assert.doesNotMatch(m.corps, /règlement/i,
    'un avoir n appelle aucun paiement du client');
  assert.doesNotMatch(m.corps, /TTC/);
});

test('le montant négatif d un avoir est présenté en positif', () => {
  const m = composerMessage({
    document: { type: 'avoir', numero: 'A-1', totaux: { net_a_payer: -1234.5 } },
    entreprise: ENTREPRISE, client: CLIENT,
  });
  assert.match(m.corps, /1 234,50 €/);
  assert.doesNotMatch(m.corps, /-1 234/);
});

test('une facture incomplète ne produit jamais de mention fausse', () => {
  const m = composerMessage({ document: { type: 'facture' } });

  assert.strictEqual(m.destinataire, '');
  assert.strictEqual(m.objet, 'Facture');
  assert.doesNotMatch(m.corps, /undefined|NaN|null/);
  assert.doesNotMatch(m.corps, /n° \./, 'pas de numéro vide annoncé');
  assert.doesNotMatch(m.corps, /montant de/, 'sans total, on n annonce aucun montant');
  assert.strictEqual(m.nomFichier, 'brouillon.pdf');
});

test('sans échéance, aucune date de règlement n est inventée', () => {
  const m = composerMessage({
    document: { ...FACTURE, date_echeance: '' }, entreprise: ENTREPRISE, client: CLIENT,
  });
  assert.doesNotMatch(m.corps, /règlement/i);
});

test('le lien mailto garde le destinataire lisible et encode le reste', () => {
  const m = composerMessage({ document: FACTURE, entreprise: ENTREPRISE, client: CLIENT });
  const lien = lienMailto(m);

  assert.ok(lien.startsWith('mailto:contact@duval.fr?'));
  assert.match(lien, /subject=Facture%20n%C2%B0%20F-2026-0001/);
  assert.match(lien, /&body=Bonjour%2C/);
  assert.ok(!/\n/.test(lien), 'un lien ne contient jamais de retour à la ligne brut');
});

test('un devis ne se réclame pas : « valable jusqu au », jamais « règlement »', () => {
  const m = composerMessage({
    document: {
      type: 'devis', numero: 'D-2026-0001', date_emission: '2026-09-09',
      date_echeance: '2026-10-09', totaux: { net_a_payer: 49 },
    },
    entreprise: ENTREPRISE,
    client: CLIENT,
  });

  assert.strictEqual(m.objet, 'Devis n° D-2026-0001 — KDL TECH');
  assert.match(m.corps, /le devis n° D-2026-0001/);
  assert.match(m.corps, /49,00 € TTC/);
  assert.match(m.corps, /valable jusqu'au 09\/10\/2026/);
  assert.doesNotMatch(m.corps, /règlement/i, 'un devis n appelle aucun paiement du client');
});

test('un numéro exotique ne fabrique pas un nom de fichier dangereux', () => {
  assert.strictEqual(nomFichier({ numero: 'F 2026/0001' }), 'F-2026-0001.pdf');
  assert.strictEqual(nomFichier({ numero: '../../etc/passwd' }), 'etc-passwd.pdf');
  assert.strictEqual(nomFichier({}), 'brouillon.pdf');
});
