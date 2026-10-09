'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  composerNumero, rangDuNumero, verifierNumerotation, sceller,
  peutAnnulerEmission, preparerAvoir, verifierModifiable,
} = require('../src/emission');

const JEU = {
  document: {
    type: 'facture', numero: 'F2026-0007', date_emission: '2026-08-17',
    date_echeance: '2026-09-16', categorie: 'services',
  },
  entreprise: { nom: 'KDL TECH', siret: '12345678200019' },
  client: { nom: 'Boulangerie Le Fournil', siret: '98765432400024' },
  lignes: [
    { designation: 'Dépannage', quantite: 2, prix_ht: 60, tva_taux: 8.5 },
  ],
};

test('un numéro se compose du type, de l année et du rang', () => {
  assert.strictEqual(composerNumero('facture', 2026, 7), 'F2026-0007');
  assert.strictEqual(composerNumero('avoir', 2026, 1), 'A2026-0001');
  assert.strictEqual(composerNumero('acompte', 2026, 42), 'AC2026-0042');
  assert.strictEqual(composerNumero('devis', 2027, 128), 'D2027-0128');
  assert.strictEqual(composerNumero('inconnu', 2026, 3), 'F2026-0003');
});

test('le rang se relit depuis le numéro', () => {
  assert.strictEqual(rangDuNumero('F2026-0007'), 7);
  assert.strictEqual(rangDuNumero('AC2026-0042'), 42);
  assert.strictEqual(rangDuNumero('sans rang'), null);
  assert.strictEqual(rangDuNumero(''), null);
});

/**
 * Un trou dans la numérotation est la première chose que regarde un contrôle.
 * Mieux vaut le voir soi-même.
 */
test('une suite continue est déclarée valide', () => {
  const r = verifierNumerotation([
    { numero: 'F2026-0001' }, { numero: 'F2026-0002' }, { numero: 'F2026-0003' },
  ]);
  assert.strictEqual(r.valide, true);
  assert.deepStrictEqual(r.trous, []);
});

test('un trou est repéré et nommé', () => {
  const r = verifierNumerotation([
    { numero: 'F2026-0001' }, { numero: 'F2026-0003' },
  ]);
  assert.strictEqual(r.valide, false);
  assert.deepStrictEqual(r.trous, ['F2026-0002']);
});

test('un doublon est repéré', () => {
  const r = verifierNumerotation([
    { numero: 'F2026-0001' }, { numero: 'F2026-0001' },
  ]);
  assert.strictEqual(r.valide, false);
  assert.deepStrictEqual(r.doublons, ['F2026-0001']);
});

test('les suites de types et d années différents ne se mélangent pas', () => {
  const r = verifierNumerotation([
    { numero: 'F2026-0001' }, { numero: 'A2026-0001' },
    { numero: 'F2025-0001' }, { numero: 'D2026-0001' },
  ]);
  assert.strictEqual(r.valide, true, `${r.trous.join(', ')} / ${r.doublons.join(', ')}`);
});

test('les brouillons sans numéro sont ignorés', () => {
  const r = verifierNumerotation([{ numero: 'F2026-0001' }, { numero: '' }, {}]);
  assert.strictEqual(r.valide, true);
});

/**
 * Le sceau doit être stable dans le temps et sensible au moindre centime :
 * c'est ce qui permet de prouver qu'une facture n'a pas bougé depuis son
 * émission.
 */
test('deux fois le même document donnent la même empreinte', async () => {
  const a = await sceller(JEU);
  const b = await sceller(JSON.parse(JSON.stringify(JEU)));
  assert.strictEqual(a, b);
  assert.strictEqual(a.length, 64);
});

test('un centime de différence change l empreinte', async () => {
  const avant = await sceller(JEU);
  const apres = await sceller({
    ...JEU,
    lignes: [{ ...JEU.lignes[0], prix_ht: 60.01 }],
  });
  assert.notStrictEqual(avant, apres);
});

test('le sceau suit aussi le numéro, les dates et les parties', async () => {
  const base = await sceller(JEU);
  const autreNumero = await sceller({ ...JEU, document: { ...JEU.document, numero: 'F2026-0008' } });
  const autreClient = await sceller({ ...JEU, client: { ...JEU.client, siret: '11111111111111' } });
  assert.notStrictEqual(base, autreNumero);
  assert.notStrictEqual(base, autreClient);
});

/**
 * Annuler une émission n'est possible qu'au bout de la suite. Ailleurs, la
 * réponse est non — et elle doit indiquer la sortie, qui est l'avoir.
 */
test('la dernière facture émise, intacte, peut redevenir un brouillon', () => {
  const r = peutAnnulerEmission({ statut: 'emis', numero: 'F2026-0007' }, { estDernier: true });
  assert.strictEqual(r.possible, true);
});

test('une facture au milieu de la suite ne s annule pas, et le refus explique pourquoi', () => {
  const r = peutAnnulerEmission({ statut: 'emis', numero: 'F2026-0003' }, { estDernier: false });
  assert.strictEqual(r.possible, false);
  assert.match(r.motif, /trou dans la suite/);
  assert.match(r.motif, /avoir/);
});

test('une facture déjà encaissée ne s annule pas', () => {
  const r = peutAnnulerEmission(
    { statut: 'emis', numero: 'F2026-0007' },
    { estDernier: true, encaissements: 1 },
  );
  assert.strictEqual(r.possible, false);
  assert.match(r.motif, /encaissement/);
});

test('une facture visée par un avoir ne s annule pas', () => {
  const r = peutAnnulerEmission(
    { statut: 'emis', numero: 'F2026-0007' },
    { estDernier: true, avoirs: 1 },
  );
  assert.strictEqual(r.possible, false);
  assert.match(r.motif, /avoir vise déjà/);
});

test('un brouillon n a pas d émission à annuler', () => {
  const r = peutAnnulerEmission({ statut: 'brouillon', numero: '' }, { estDernier: true });
  assert.strictEqual(r.possible, false);
  assert.match(r.motif, /n'est pas émis/);
});

/**
 * L'avoir inverse les quantités plutôt que de recopier les montants : les
 * totaux repassent par le même calcul que la facture d'origine et ne peuvent
 * donc pas en différer d'un centime.
 */
test('un avoir reprend la facture avec des quantités négatives', () => {
  const avoir = preparerAvoir(JEU, { motif: 'Prestation annulée', date: '2026-08-20' });
  assert.strictEqual(avoir.document.type, 'avoir');
  assert.strictEqual(avoir.document.document_lie_numero, 'F2026-0007');
  assert.strictEqual(avoir.document.date_emission, '2026-08-20');
  assert.match(avoir.document.note, /Prestation annulée/);
  assert.strictEqual(avoir.lignes[0].quantite, -2);
  assert.strictEqual(avoir.lignes[0].prix_ht, 60);
});

test('un avoir sur un avoir ne redevient pas une facture', () => {
  const avoir = preparerAvoir(JEU);
  const second = preparerAvoir({ ...JEU, lignes: avoir.lignes });
  assert.strictEqual(second.lignes[0].quantite, -2, 'les quantités restent négatives');
});

test('un document émis refuse toute modification', () => {
  assert.throws(
    () => verifierModifiable({ statut: 'emis', numero: 'F2026-0007' }),
    /ne peut plus être modifiée/,
  );
  assert.doesNotThrow(() => verifierModifiable({ statut: 'brouillon' }));
  assert.doesNotThrow(() => verifierModifiable(null));
});
