'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recapitulerDevis, recapitulerParClient } = require('../src/pwa/recap-devis');
const devis = (id, prix, extra = {}) => ({ id, type: 'devis', statut: 'emis',
  numero: `D2026-${id}`, date_emission: '2026-09-09',
  lignes: [{ quantite: 1, prix_ht: prix, tva_taux: 0 }], ...extra });

test('le récap inclut toutes les années et exclut factures, avoirs et brouillons', () => {
  const docs = [devis(1, 100), devis(2, 50, { date_emission: '2025-01-01' }),
    devis(3, 900, { type: 'facture' }), devis(4, 900, { statut: 'brouillon' }),
    devis(5, -100, { type: 'avoir' })];
  const recap = recapitulerDevis(docs);
  assert.equal(recap.nombre, 2); assert.equal(recap.total_ttc, 150);
  assert.deepEqual(recap.devis.map(d => d.id), [1, 2]);
  assert.equal(docs.length, 5);
});

test('les totaux HT et TTC additionnent les arrondis de chaque devis au centime', () => {
  const recap = recapitulerDevis([devis(1, 0.1), devis(2, 0.2), devis(3, 100,
    { lignes: [{ quantite: 1, prix_ht: 100, tva_taux: 8.5 }] })]);
  assert.equal(recap.total_ht, 100.3); assert.equal(recap.total_ttc, 108.8);
});

test('un devis dont l’émission a été annulée sort du récap', () => {
  const d = devis(1, 40);
  assert.equal(recapitulerDevis([d]).nombre, 1);
  d.statut = 'brouillon'; delete d.numero;
  assert.equal(recapitulerDevis([d]).nombre, 0);
});

test('sans devis émis, le récap est vide et ses totaux sont nuls', () => {
  assert.deepEqual(recapitulerDevis([]), { devis: [], nombre: 0, total_ht: 0, total_ttc: 0 });
});

test('le récap regroupe les devis par identifiant client et calcule les sous-totaux', () => {
  const recap = recapitulerParClient([
    devis(1, 10, { client_id: 7 }), devis(2, 20, { client_id: 7 }),
    devis(3, 40, { client_id: 8 }), devis(4, 500, { client_id: 7, statut: 'brouillon' }),
  ], [{ id: 7, nom: 'Même nom' }, { id: 8, nom: 'Même nom' }]);
  assert.equal(recap.nombre, 3); assert.equal(recap.total_ttc, 70);
  assert.deepEqual(recap.clients.map(c => [c.client_id, c.nombre, c.total_ttc]), [[7, 2, 30], [8, 1, 40]]);
});

test('un client absent du carnet ne fait pas disparaître ses devis du récap', () => {
  const recap = recapitulerParClient([devis(1, 30, { client_id: 99 })], []);
  assert.equal(recap.clients[0].nom, 'Client introuvable');
  assert.equal(recap.total_ttc, 30);
});
