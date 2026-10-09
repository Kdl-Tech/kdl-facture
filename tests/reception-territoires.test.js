'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { controler } = require('../src/reception/controles');

/**
 * La TVA d'outre-mer n'est pas celle de la métropole : 8,5 % en taux normal aux
 * Antilles et à La Réunion, et pas de TVA du tout en Guyane ni à Mayotte.
 *
 * L'erreur qu'on cherche ici est sournoise : un fournisseur local dont le
 * logiciel est resté réglé sur la métropole émet une facture arithmétiquement
 * juste — 20 % de la base font bien le montant annoncé — mais fiscalement
 * fausse. Aucun contrôle de calcul ne la voit. Le client paie une TVA indue
 * qu'il ne pourra pas déduire.
 */

function facture(codePostal, taux, base = 100) {
  const tva = Math.round(base * taux) / 100;
  return {
    numero: 'F1',
    date_emission: '2026-08-10',
    devise: 'EUR',
    type: 'facture',
    fournisseur: {
      nom: 'Fournisseur', siret: '12345678200019', code_postal: codePostal, pays: 'FR',
    },
    client: { nom: 'KDL TECH' },
    lignes: [{
      designation: 'Prestation', quantite: 1, prix_ht: base, montant_ht: base,
    }],
    ventilation_tva: [{ taux, base_ht: base, montant_tva: tva }],
    totaux: {
      total_ht: base,
      total_tva: tva,
      total_ttc: base + tva,
      acompte: 0,
      net_a_payer: base + tva,
    },
  };
}

test('une facture guadeloupéenne à 8,5 % ne déclenche aucune réserve', () => {
  const r = controler(facture('97100', 8.5));
  assert.strictEqual(r.conforme, true, r.anomalies.join(' / '));
  assert.deepStrictEqual(r.avertissements, [], r.avertissements.join(' / '));
});

test('les taux réduits propres aux DOM passent aussi', () => {
  for (const taux of [2.1, 1.75, 1.05]) {
    const r = controler(facture('97122', taux));
    assert.deepStrictEqual(r.avertissements, [], `taux ${taux} % : ${r.avertissements.join(' / ')}`);
  }
});

test('un fournisseur guadeloupéen qui facture à 20 % est signalé', () => {
  const r = controler(facture('97110', 20));
  // Le calcul est juste : rien ne doit être refusé, mais tout doit être dit.
  assert.strictEqual(r.conforme, true);
  assert.strictEqual(r.verdict, 'à vérifier');
  const avis = r.avertissements.join(' ');
  assert.match(avis, /Guadeloupe/);
  // Écriture française attendue : « 8,5 % », jamais « 8.5 % ».
  assert.match(avis, /8,5 %/);
  assert.doesNotMatch(avis, /8\.5/);
  assert.match(avis, /réglé sur la métropole/);
});

test('la Martinique et La Réunion suivent la même règle', () => {
  assert.match(controler(facture('97200', 20)).avertissements.join(' '), /Martinique/);
  assert.match(controler(facture('97400', 20)).avertissements.join(' '), /Réunion/);
});

/**
 * En Guyane et à Mayotte, la TVA n'est pas applicable du tout : une facture qui
 * en porte une annonce une taxe que le client ne récupérera jamais.
 */
test('une TVA facturée depuis la Guyane ou Mayotte est signalée comme non déductible', () => {
  for (const cp of ['97300', '97600']) {
    const avis = controler(facture(cp, 20)).avertissements.join(' ');
    assert.match(avis, /294/);
    assert.match(avis, /pas déductible/);
    assert.match(avis, /rectificative/);
  }
});

test('une facture métropolitaine à 20 % reste normale', () => {
  const r = controler(facture('75001', 20));
  assert.deepStrictEqual(r.avertissements, []);
});

test('Saint-Martin et Saint-Barthélemy ne sont pas pris pour la Guadeloupe', () => {
  // Leurs codes postaux commencent par 971 : les ranger avec la Guadeloupe
  // produirait un avertissement faux sur chacune de leurs factures.
  const saintMartin = controler(facture('97150', 0)).avertissements.join(' ');
  assert.doesNotMatch(saintMartin, /Guadeloupe/);
});

test('sans code postal ou hors de France, aucune supposition n est faite', () => {
  const sansCP = facture('', 20);
  assert.deepStrictEqual(controler(sansCP).avertissements, []);

  const etranger = facture('97100', 20);
  etranger.fournisseur.pays = 'BE';
  assert.deepStrictEqual(controler(etranger).avertissements, []);
});

test('une facture sans TVA ne déclenche pas de contrôle de taux', () => {
  const franchise = facture('97100', 0);
  assert.deepStrictEqual(controler(franchise).avertissements, []);
});
