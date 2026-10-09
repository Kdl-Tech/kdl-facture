'use strict';

/**
 * Les défauts remontés par la revue de code du 6 août 2026.
 *
 * Chacun avait un scénario d'entrée précis et une conséquence réelle : facture
 * rejetée chez le client, chiffre d'affaires faux, base illisible, ou pire,
 * écriture arbitraire dans la base. Ils sont corrigés ; ces tests les
 * empêchent de revenir.
 */

const test = require('node:test');
const assert = require('node:assert');
const { ouvrir } = require('../src/db');
const { Service, ErreurMetier } = require('../src/factures');
const { verifier, genererXML } = require('../src/facturx');
const { centimes, calculerDocument } = require('../src/calculs');

const ENTREPRISE = {
  nom: 'KDL TECH', siren: '123456782', siret: '12345678200019',
  tva_intra: 'FR11123456782', adresse: '1 rue des Palmiers',
  code_postal: '75001', ville: 'Paris', pays: 'FR',
  iban: 'FR7630001007941234567890185', regime_tva: 'normal', territoire: 'metropole',
};
const CLIENT = {
  type: 'entreprise', nom: 'Client SARL', siren: '987654324', siret: '98765432400024',
  adresse: '5 rue du Port', code_postal: '75002', ville: 'Paris', pays: 'FR',
};
const DOCUMENT = {
  type: 'facture', numero: 'F2026-0001', date_emission: '2026-08-06',
  date_echeance: '2026-09-05', categorie: 'services', mode_paiement: 'virement',
};

/* ─── Arrondi ─── */

test('un avoir annule exactement sa facture, au centime', () => {
  // 0,5 × 1,01 € donnait 0,51 € à la facture et −0,50 € à l'avoir : il restait
  // un centime dû pour toujours, et la facture ne passait jamais à « payée ».
  assert.strictEqual(centimes(0.505), 51);
  assert.strictEqual(centimes(-0.505), -51);
  assert.strictEqual(centimes(8.245), 825);
  assert.strictEqual(centimes(2.675), 268);
  assert.strictEqual(centimes(-2.675), -268);
});

/* ─── Cohérence TVA ─── */

test('une exonération interdit tout taux de TVA sur les lignes', () => {
  // Client belge avec TVA intra : catégorie K. Le XML annonçait l'exonération
  // et 20 % de TVA en même temps, et le PDF se contredisait.
  const belge = { ...CLIENT, pays: 'BE', tva_intra: 'BE0123456789' };
  const r = verifier({
    document: DOCUMENT, entreprise: ENTREPRISE, client: belge,
    lignes: [{ designation: 'Prestation', quantite: 1, prix_ht: 100, tva_taux: 20 }],
  });
  assert.strictEqual(r.valide, false);
  assert.ok(r.anomalies.some((a) => a.includes('aucune ligne ne peut porter de TVA')));
});

test('facturer la TVA exige le numéro de TVA du vendeur', () => {
  const sansTva = { ...ENTREPRISE, tva_intra: '' };
  const r = verifier({
    document: DOCUMENT, entreprise: sansTva, client: CLIENT,
    lignes: [{ designation: 'Prestation', quantite: 1, prix_ht: 100, tva_taux: 20 }],
  });
  assert.strictEqual(r.valide, false);
  assert.ok(r.anomalies.some((a) => a.includes('TVA intracommunautaire')));
});

test('un paiement par virement exige un IBAN', () => {
  const sansIban = { ...ENTREPRISE, iban: '' };
  const r = verifier({
    document: DOCUMENT, entreprise: sansIban, client: CLIENT,
    lignes: [{ designation: 'Prestation', quantite: 1, prix_ht: 100, tva_taux: 20 }],
  });
  assert.strictEqual(r.valide, false);
  assert.ok(r.anomalies.some((a) => a.includes('IBAN')));
});

/* ─── Dates ─── */

test('une date mal écrite est refusée avant lémission', () => {
  // « 2026/08/06 » ressortait tronqué en « 2026/08/ » dans le XML, et la
  // facture, une fois figée, ne se réparait que par un avoir.
  for (const mauvaise of ['2026/08/06', '06/08/2026', '2026-8-6', 'demain']) {
    const r = verifier({
      document: { ...DOCUMENT, date_emission: mauvaise },
      entreprise: ENTREPRISE, client: CLIENT,
      lignes: [{ designation: 'X', quantite: 1, prix_ht: 10, tva_taux: 20 }],
    });
    assert.strictEqual(r.valide, false, `${mauvaise} aurait dû être refusée`);
  }
});

/* ─── Remise ─── */

test('une remise supérieure à 100 % est refusée', () => {
  const r = verifier({
    document: DOCUMENT, entreprise: ENTREPRISE, client: CLIENT,
    lignes: [{ designation: 'X', quantite: 1, prix_ht: 100, remise_pct: 150, tva_taux: 20 }],
  });
  assert.strictEqual(r.valide, false);
  assert.ok(r.anomalies.some((a) => a.includes('remise')));
});

test('le XML dune ligne remisée est cohérent : prix net × quantité = total', () => {
  const xml = genererXML({
    document: DOCUMENT, entreprise: ENTREPRISE, client: CLIENT,
    lignes: [{ designation: 'Prestation', quantite: 1, prix_ht: 100, remise_pct: 20, tva_taux: 20 }],
  });
  // Le prix net annoncé doit valoir 80, pas 100, sinon 100 × 1 ≠ 80.
  assert.match(xml, /<ram:NetPriceProductTradePrice><ram:ChargeAmount>80\.00</);
  assert.match(xml, /<ram:LineTotalAmount>80\.00<\/ram:LineTotalAmount>/);
  // Et la remise est justifiée explicitement.
  assert.match(xml, /<ram:AppliedTradeAllowanceCharge>/);
  assert.match(xml, /<ram:ActualAmount>20\.00<\/ram:ActualAmount>/);
});

/* ─── Base de données ─── */

test('une base ancienne retrouve toutes ses colonnes', () => {
  const { migrer } = require('../src/db');
  const db = ouvrir(':memory:');
  db.exec('DROP TABLE entreprises');
  db.exec('CREATE TABLE entreprises (id INTEGER PRIMARY KEY AUTOINCREMENT, nom TEXT NOT NULL, siren TEXT NOT NULL)');
  db.prepare('INSERT INTO entreprises (nom, siren) VALUES (?, ?)').run('Ancienne', '111222333');
  migrer(db);
  const colonnes = db.prepare('PRAGMA table_info(entreprises)').all().map((c) => c.name);
  for (const attendu of ['adresse', 'ville', 'iban', 'tva_sur_debits', 'penalites_taux',
    'escompte', 'territoire', 'seuil_franchise', 'tva_taux_defaut', 'activite']) {
    assert.ok(colonnes.includes(attendu), `colonne manquante après migration : ${attendu}`);
  }
  assert.strictEqual(db.prepare('SELECT nom FROM entreprises').get().nom, 'Ancienne');
});

/* ─── Métier ─── */

function preparer() {
  const db = ouvrir(':memory:');
  const service = new Service(db);
  const ent = db.prepare(`
    INSERT INTO entreprises (nom, siren, siret, tva_intra, adresse, code_postal, ville, iban, regime_tva)
    VALUES ('KDL TECH', '123456782', '12345678200019', 'FR11123456782',
            '1 rue X', '75001', 'Paris', 'FR7630001007941234567890185', 'normal')
  `).run();
  const cli = db.prepare(`
    INSERT INTO clients (entreprise_id, type, nom, siren, siret, adresse, code_postal, ville)
    VALUES (?, 'entreprise', 'Client SARL', '987654324', '98765432400024', '5 rue Y', '75002', 'Paris')
  `).run(ent.lastInsertRowid);
  return { db, service, entrepriseId: ent.lastInsertRowid, clientId: cli.lastInsertRowid };
}

const LIGNES = [{ designation: 'Prestation', quantite: 1, prix_ht: 1000, tva_taux: 20 }];

test('un avoir réduit le chiffre daffaires', () => {
  const { service, entrepriseId, clientId } = preparer();
  const f = service.emettre(service.creer(entrepriseId, {
    client_id: clientId, lignes: LIGNES, categorie: 'services', date_emission: '2026-08-06',
  }).document.id);
  assert.strictEqual(service.statistiques(entrepriseId).chiffre_affaires_ttc, 1200);

  service.emettre(service.creerAvoir(f.document.id).document.id);
  // La facture est intégralement annulée : le chiffre d'affaires doit retomber
  // à zéro, sans quoi le suivi du plafond de franchise serait faussé.
  assert.strictEqual(service.statistiques(entrepriseId).chiffre_affaires_ttc, 0);
});

test('un acompte se déduit vraiment du net à payer', () => {
  const { service, entrepriseId, clientId } = preparer();
  const d = service.creer(entrepriseId, {
    client_id: clientId, lignes: LIGNES, categorie: 'services',
    date_emission: '2026-08-06', acompte: 300,
  });
  assert.strictEqual(d.document.acompte, 300);
  assert.strictEqual(d.totaux.total_ttc, 1200);
  assert.strictEqual(d.totaux.net_a_payer, 900);
});

test('un type de document inconnu est refusé', () => {
  const { service, entrepriseId, clientId } = preparer();
  assert.throws(
    () => service.creer(entrepriseId, { client_id: clientId, type: 'Facture', lignes: LIGNES }),
    /Type de document inconnu/,
  );
});

/* ─── Montants de ligne ─── */

test('les montants de TVA par ligne sont nommés « indicatif »', () => {
  // Trois lignes à 33,33 € donnaient 40,00 € de TTC chacune, soit 120,00 €,
  // quand la facture affiche 119,99 €. Le nom du champ dit désormais qu'on ne
  // doit pas les additionner.
  const r = calculerDocument([
    { quantite: 1, prix_ht: 33.33, tva_taux: 20 },
    { quantite: 1, prix_ht: 33.33, tva_taux: 20 },
    { quantite: 1, prix_ht: 33.33, tva_taux: 20 },
  ]);
  assert.strictEqual(r.total_ttc, 119.99);
  assert.ok('montant_tva_indicatif' in r.lignes[0]);
  assert.ok(!('montant_tva' in r.lignes[0]));
});
