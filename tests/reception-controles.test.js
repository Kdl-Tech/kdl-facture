'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { genererXML } = require('../src/facturx');
const { genererPDF } = require('../src/pdf');
const { controler, cleMetier } = require('../src/reception/controles');
const { lireFichierRecu, chercherDoublon, formatDuXML } = require('../src/reception');

const ENTREPRISE = {
  nom: 'KDL TECH', siren: '123456782', siret: '12345678200019',
  tva_intra: 'FR11123456782', adresse: '1 rue des Palmiers', code_postal: '97100',
  ville: 'Basse-Terre', pays: 'FR', iban: 'FR7630001007941234567890185', regime_tva: 'normal',
};
const CLIENT = {
  type: 'entreprise', nom: 'Boulangerie Le Fournil', siren: '987654324',
  siret: '98765432400024', adresse: '5 avenue du Port', code_postal: '97110',
  ville: 'Pointe-à-Pitre', pays: 'FR',
};
const JEU = {
  document: {
    type: 'facture', numero: 'F2026-0001', date_emission: '2026-08-06',
    date_echeance: '2026-09-05', categorie: 'mixte', mode_paiement: 'virement',
  },
  entreprise: ENTREPRISE,
  client: CLIENT,
  lignes: [
    { designation: 'Dépannage informatique', quantite: 2, prix_ht: 60, tva_taux: 8.5, unite: 'heure' },
    { designation: 'Câble réseau', quantite: 1, prix_ht: 15, tva_taux: 8.5, unite: 'piece' },
  ],
  paiements: [],
};

const recevoirXML = (xml) => lireFichierRecu(new TextEncoder().encode(xml));

test('une facture correcte passe le contrôle sans réserve', async () => {
  const recue = await recevoirXML(genererXML(JEU));
  assert.strictEqual(recue.controle.verdict, 'conforme', recue.controle.anomalies.join(' / '));
  assert.strictEqual(recue.controle.conforme, true);
  assert.deepStrictEqual(recue.controle.avertissements, []);
  assert.strictEqual(recue.source, 'XML');
  assert.strictEqual(recue.statut, 'recue');
});

test('un PDF Factur-X est reconnu, lu et contrôlé en un seul geste', async () => {
  const pdf = await genererPDF(JEU);
  const recue = await lireFichierRecu(new Uint8Array(pdf), { nom: 'facture-fournisseur.pdf' });
  assert.match(recue.source, /^PDF/);
  assert.strictEqual(recue.fichier, 'facture-fournisseur.pdf');
  assert.strictEqual(recue.facture.numero, 'F2026-0001');
  assert.strictEqual(recue.controle.conforme, true);
  assert.strictEqual(recue.empreinte_fichier.length, 64);
});

/**
 * Le cas qui justifie tout le module : une facture dont les chiffres ne
 * tombent pas juste. Elle doit être refusée avec un motif exploitable, celui
 * qu'on recopiera dans le rejet envoyé au fournisseur.
 */
test('un total TTC faux est détecté et expliqué', async () => {
  const xml = genererXML(JEU).replace(
    '<ram:GrandTotalAmount>146.48</ram:GrandTotalAmount>',
    '<ram:GrandTotalAmount>156.48</ram:GrandTotalAmount>',
  );
  const recue = await recevoirXML(xml);
  assert.strictEqual(recue.controle.conforme, false);
  assert.strictEqual(recue.controle.verdict, 'non conforme');
  assert.ok(recue.controle.anomalies.some((a) => a.includes('total TTC')),
    recue.controle.anomalies.join(' / '));
});

test('une TVA qui ne correspond pas à son taux est détectée', async () => {
  const xml = genererXML(JEU).replace(
    '<ram:CalculatedAmount>11.48</ram:CalculatedAmount>',
    '<ram:CalculatedAmount>15.48</ram:CalculatedAmount>',
  );
  const recue = await recevoirXML(xml);
  assert.strictEqual(recue.controle.conforme, false);
  assert.ok(recue.controle.anomalies.some((a) => a.includes('TVA à 8.5')),
    recue.controle.anomalies.join(' / '));
});

test('une somme de lignes qui ne fait pas le total est détectée', () => {
  const controle = controler({
    numero: 'F1', date_emission: '2026-08-06', devise: 'EUR',
    fournisseur: { nom: 'A', siret: '12345678200019' }, client: { nom: 'B' },
    lignes: [{ designation: 'x', quantite: 1, prix_ht: 100, montant_ht: 100, tva_taux: 8.5 }],
    ventilation_tva: [{ taux: 20, base_ht: 200, montant_tva: 40 }],
    totaux: {
      total_ht: 200, total_tva: 40, total_ttc: 240, acompte: 0, net_a_payer: 240,
    },
    type: 'facture',
  });
  assert.strictEqual(controle.conforme, false);
  assert.ok(controle.anomalies.some((a) => a.includes('somme des lignes')),
    controle.anomalies.join(' / '));
});

test('les centimes darrondi ne déclenchent pas de fausse alerte', () => {
  const controle = controler({
    numero: 'F1', date_emission: '2026-08-06', devise: 'EUR',
    fournisseur: { nom: 'A', siret: '12345678200019' }, client: { nom: 'B' },
    lignes: [
      { designation: 'x', quantite: 3, prix_ht: 33.333, montant_ht: 100 },
      { designation: 'y', quantite: 1, prix_ht: 0.01, montant_ht: 0.01 },
    ],
    ventilation_tva: [{ taux: 20, base_ht: 100.01, montant_tva: 20 }],
    totaux: {
      total_ht: 100.01, total_tva: 20, total_ttc: 120.01, acompte: 0, net_a_payer: 120.01,
    },
    type: 'facture',
  });
  assert.strictEqual(controle.conforme, true, controle.anomalies.join(' / '));
});

test('une facture sans numéro ni fournisseur est refusée point par point', () => {
  const controle = controler({
    numero: '', date_emission: '', devise: '',
    fournisseur: { nom: '' }, client: { nom: '' },
    lignes: [], ventilation_tva: [],
    totaux: { net_a_payer: null, acompte: 0 },
    type: 'facture',
  });
  assert.strictEqual(controle.anomalies.length >= 6, true, controle.anomalies.join(' / '));
  assert.ok(controle.anomalies.some((a) => a.includes('numéro')));
  assert.ok(controle.anomalies.some((a) => a.includes('fournisseur')));
});

test('un avoir sans quantité négative reçoit un avertissement, pas un refus', () => {
  const controle = controler({
    numero: 'A1', date_emission: '2026-08-06', devise: 'EUR',
    fournisseur: { nom: 'A', siret: '12345678200019' }, client: { nom: 'B' },
    lignes: [{ designation: 'x', quantite: 1, prix_ht: 10, montant_ht: 10 }],
    ventilation_tva: [{ taux: 0, base_ht: 10, montant_tva: 0 }],
    totaux: {
      total_ht: 10, total_tva: 0, total_ttc: 10, acompte: 0, net_a_payer: 10,
    },
    type: 'avoir',
  });
  assert.strictEqual(controle.conforme, true);
  assert.strictEqual(controle.verdict, 'à vérifier');
  assert.ok(controle.avertissements.some((a) => a.includes('quantité négative')));
});

/**
 * Payer deux fois la même facture est l'accident le plus banal d'une petite
 * entreprise. Trois cas se distinguent, et ils n'appellent pas la même réaction.
 */
test('un fichier reçu deux fois est reconnu comme identique', async () => {
  const xml = genererXML(JEU);
  const premiere = await recevoirXML(xml);
  const seconde = await recevoirXML(xml);
  const doublon = chercherDoublon(seconde, [premiere]);
  assert.strictEqual(doublon.niveau, 'identique');
});

test('la même facture renvoyée dans un autre fichier est reconnue', async () => {
  const premiere = await recevoirXML(genererXML(JEU));
  const seconde = await recevoirXML(`${genererXML(JEU)}<!-- renvoi -->`);
  const doublon = chercherDoublon(seconde, [premiere]);
  assert.strictEqual(doublon.niveau, 'renvoi');
  assert.match(doublon.message, /déjà été reçue/);
});

test('un même numéro avec un montant différent est signalé comme divergent', async () => {
  const premiere = await recevoirXML(genererXML(JEU));
  const seconde = await recevoirXML(genererXML({
    ...JEU,
    lignes: [{ ...JEU.lignes[0], prix_ht: 600 }],
  }));
  const doublon = chercherDoublon(seconde, [premiere]);
  assert.strictEqual(doublon.niveau, 'divergent');
  assert.match(doublon.message, /montant différent/);
});

test('une facture inconnue nest pas prise pour un doublon', async () => {
  const premiere = await recevoirXML(genererXML(JEU));
  const autre = await recevoirXML(genererXML({
    ...JEU, document: { ...JEU.document, numero: 'F2026-0002' },
  }));
  assert.strictEqual(chercherDoublon(autre, [premiere]), null);
});

test('la clé métier tient au trio émetteur, numéro et date', () => {
  const facture = {
    fournisseur: { siret: '12345678200019' }, numero: 'f2026-0001', date_emission: '2026-08-06',
  };
  assert.strictEqual(cleMetier(facture), '12345678200019|F2026-0001|2026-08-06');
});

test('le format dun XML est reconnu sans le lire en entier', () => {
  assert.strictEqual(formatDuXML('<rsm:CrossIndustryInvoice/>'), 'CII');
  assert.strictEqual(formatDuXML('<Invoice xmlns="urn:oasis"/>'), 'UBL');
  assert.strictEqual(formatDuXML('<cn:CreditNote xmlns:cn="urn:oasis"/>'), 'UBL');
  assert.strictEqual(formatDuXML('<html><body/></html>'), null);
});

test('un fichier qui nest pas une facture est refusé avec un motif clair', async () => {
  await assert.rejects(
    () => recevoirXML('<html><body>bonjour</body></html>'),
    /pas une facture électronique/,
  );
  await assert.rejects(() => lireFichierRecu(new Uint8Array(0)), /vide/);
});
