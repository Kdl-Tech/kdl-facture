'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  changerStatut, suivantsPossibles, motifDepuisControle, STATUTS,
} = require('../src/reception/journal');

test('une facture reçue peut être approuvée ou rejetée, rien d autre', () => {
  assert.deepStrictEqual(suivantsPossibles('recue'), ['approuvee', 'rejetee']);
  assert.deepStrictEqual(suivantsPossibles('rejetee'), []);
  assert.deepStrictEqual(suivantsPossibles('encaissee'), []);
});

test('approuver une facture reçue inscrit la date et garde la trace', () => {
  const avant = { statut: 'recue', historique: [] };
  const apres = changerStatut(avant, 'approuvee', { par: 'Gérant', date: '2026-08-17T10:00:00.000Z' });

  assert.strictEqual(apres.statut, 'approuvee');
  assert.strictEqual(apres.historique.length, 1);
  assert.strictEqual(apres.historique[0].date, '2026-08-17T10:00:00.000Z');
  assert.strictEqual(apres.historique[0].par, 'Gérant');
  // L'objet de départ n'est pas modifié : l'appelant décide quand écrire.
  assert.strictEqual(avant.statut, 'recue');
  assert.strictEqual(avant.historique.length, 0);
});

test('l historique s empile au fil des passages', () => {
  let etat = { statut: 'recue', historique: [] };
  etat = changerStatut(etat, 'approuvee', { date: '2026-08-17T10:00:00.000Z' });
  etat = changerStatut(etat, 'en_paiement', { date: '2026-08-18T10:00:00.000Z' });
  etat = changerStatut(etat, 'encaissee', { date: '2026-08-25T10:00:00.000Z' });

  assert.strictEqual(etat.statut, 'encaissee');
  assert.deepStrictEqual(
    etat.historique.map((h) => h.statut),
    ['approuvee', 'en_paiement', 'encaissee'],
  );
});

/**
 * Un rejet sans motif est inexploitable pour le fournisseur : il ne sait pas
 * quoi corriger, et la facture revient à l'identique.
 */
test('un rejet sans motif est refusé', () => {
  assert.throws(
    () => changerStatut({ statut: 'recue' }, 'rejetee'),
    /doit être motivé/,
  );
  assert.throws(
    () => changerStatut({ statut: 'recue' }, 'rejetee', { motif: '  ' }),
    /doit être motivé/,
  );
  const rejet = changerStatut({ statut: 'recue' }, 'rejetee', {
    motif: 'Le total TTC ne correspond pas à la somme des lignes.',
  });
  assert.strictEqual(rejet.statut, 'rejetee');
  assert.match(rejet.historique[0].motif, /total TTC/);
});

test('un statut définitif ne se rouvre pas', () => {
  assert.throws(
    () => changerStatut({ statut: 'rejetee' }, 'approuvee'),
    /définitif/,
  );
  assert.throws(
    () => changerStatut({ statut: 'encaissee' }, 'en_paiement'),
    /définitif/,
  );
});

/**
 * Un litige se découvre souvent après l'approbation. Tant que rien n'est
 * encaissé, le rejet doit rester possible.
 */
test('une facture approuvée ou en paiement peut encore être rejetée', () => {
  const a = changerStatut({ statut: 'approuvee' }, 'rejetee', { motif: 'Prestation non faite.' });
  assert.strictEqual(a.statut, 'rejetee');
  const b = changerStatut({ statut: 'en_paiement' }, 'rejetee', { motif: 'Doublon repéré.' });
  assert.strictEqual(b.statut, 'rejetee');
});

test('un passage impossible explique ce qui est possible', () => {
  assert.throws(
    () => changerStatut({ statut: 'recue' }, 'encaissee'),
    /Possible : approuvée, rejetée/,
  );
});

test('repasser au même statut est refusé sans ambiguïté', () => {
  assert.throws(() => changerStatut({ statut: 'approuvee' }, 'approuvee'), /déjà/);
});

test('un statut inventé est refusé', () => {
  assert.throws(() => changerStatut({ statut: 'recue' }, 'archivee'), /Statut inconnu/);
  assert.throws(() => changerStatut({ statut: 'perdue' }, 'approuvee'), /Statut de départ inconnu/);
});

test('les anomalies du contrôle servent de motif de rejet tout prêt', () => {
  assert.strictEqual(motifDepuisControle({ anomalies: [] }), '');
  assert.strictEqual(motifDepuisControle(null), '');
  assert.strictEqual(motifDepuisControle({ anomalies: ['Le numéro manque.'] }), 'Le numéro manque.');
  assert.match(
    motifDepuisControle({ anomalies: ['A manque.', 'B est faux.'] }),
    /^2 anomalies : A manque\. ; B est faux\.$/,
  );
});

test('chaque statut porte un libellé lisible par un humain', () => {
  for (const [cle, valeur] of Object.entries(STATUTS)) {
    assert.ok(valeur.libelle && valeur.description, `le statut ${cle} doit être décrit`);
  }
});
