'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { calculerDocument, calculerLigne, resteDu, calculerEcheance } = require('../src/calculs');

test('un centime ne se perd pas dans la virgule flottante', () => {
  const l = calculerLigne({ quantite: 3, prix_ht: 0.1, tva_taux: 20 });
  assert.strictEqual(l.montant_ht, 0.3);
  assert.strictEqual(l.montant_tva, 0.06);
  assert.strictEqual(l.montant_ttc, 0.36);
});

test('la remise sapplique avant la TVA', () => {
  const l = calculerLigne({ quantite: 1, prix_ht: 100, remise_pct: 10, tva_taux: 20 });
  assert.strictEqual(l.montant_ht, 90);
  assert.strictEqual(l.montant_tva, 18);
});

test('la TVA se calcule par taux, pas en additionnant les arrondis de lignes', () => {
  // Trois lignes à 0,105 € : chacune arrondie donnerait 0,02 € de TVA (0,06 au
  // total), alors que la base réelle 0,32 € en donne 0,06. Le regroupement par
  // taux est ce qui garantit le total juste.
  const r = calculerDocument([
    { quantite: 1, prix_ht: 0.105, tva_taux: 20 },
    { quantite: 1, prix_ht: 0.105, tva_taux: 20 },
    { quantite: 1, prix_ht: 0.105, tva_taux: 20 },
  ]);
  assert.strictEqual(r.total_ht, 0.33);
  assert.strictEqual(r.ventilation_tva.length, 1);
  assert.strictEqual(r.total_tva, 0.07);
  assert.strictEqual(r.total_ttc, 0.4);
});

test('plusieurs taux de TVA sont ventilés séparément', () => {
  const r = calculerDocument([
    { quantite: 2, prix_ht: 50, tva_taux: 20 },
    { quantite: 1, prix_ht: 30, tva_taux: 5.5 },
    { quantite: 1, prix_ht: 10, tva_taux: 0 },
  ]);
  assert.strictEqual(r.total_ht, 140);
  const taux = r.ventilation_tva.map((v) => v.taux);
  assert.deepStrictEqual(taux, [20, 5.5, 0]);
  assert.strictEqual(r.ventilation_tva[0].montant_tva, 20);
  assert.strictEqual(r.ventilation_tva[1].montant_tva, 1.65);
  assert.strictEqual(r.total_ttc, 161.65);
});

test('un acompte se déduit du net à payer sans toucher aux totaux', () => {
  const r = calculerDocument([{ quantite: 1, prix_ht: 1000, tva_taux: 20 }], { acompte: 300 });
  assert.strictEqual(r.total_ttc, 1200);
  assert.strictEqual(r.acompte, 300);
  assert.strictEqual(r.net_a_payer, 900);
});

test('le reste dû tient compte des paiements encaissés', () => {
  assert.strictEqual(resteDu(1200, [{ montant: 500 }, { montant: 200.5 }]), 499.5);
  assert.strictEqual(resteDu(1200, []), 1200);
});

test('un délai de paiement ne peut pas dépasser le plafond légal', () => {
  assert.strictEqual(calculerEcheance('2026-08-06', 30), '2026-09-05');
  // 90 jours seraient une clause nulle : on ramène aux 60 jours du code de commerce.
  assert.strictEqual(calculerEcheance('2026-08-06', 90), '2026-10-05');
});

test('le paiement comptant donne une échéance au jour même', () => {
  assert.strictEqual(calculerEcheance('2026-08-06', 0), '2026-08-06');
});
