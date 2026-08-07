'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ouvrir } = require('../src/db');
const { Service, ErreurMetier } = require('../src/factures');

function preparer() {
  const db = ouvrir(':memory:');
  const service = new Service(db);
  const ent = db.prepare(`
    INSERT INTO entreprises (nom, siren, siret, tva_intra, adresse, code_postal, ville, iban)
    VALUES ('KDL TECH', '123456789', '12345678900019', 'FR12123456789',
            '1 rue des Palmiers', '97100', 'Basse-Terre', 'FR7630001007941234567890185')
  `).run();
  const cli = db.prepare(`
    INSERT INTO clients (entreprise_id, type, nom, siren, siret, adresse, code_postal, ville, delai_paiement_jours)
    VALUES (?, 'entreprise', 'Boulangerie Le Fournil', '987654321', '98765432100014',
            '5 avenue du Port', '97110', 'Pointe-à-Pitre', 30)
  `).run(ent.lastInsertRowid);
  return { db, service, entrepriseId: ent.lastInsertRowid, clientId: cli.lastInsertRowid };
}

const LIGNES = [
  { designation: 'Dépannage', quantite: 2, prix_ht: 60, tva_taux: 20, unite: 'heure' },
  { designation: 'Câble', quantite: 1, prix_ht: 15, tva_taux: 20, unite: 'piece' },
];

test('un brouillon na pas de numéro', () => {
  const { service, entrepriseId, clientId } = preparer();
  const d = service.creer(entrepriseId, { client_id: clientId, lignes: LIGNES, categorie: 'mixte' });
  assert.strictEqual(d.document.numero, null);
  assert.strictEqual(d.document.statut, 'brouillon');
  assert.strictEqual(d.totaux.total_ttc, 162);
});

test("l'échéance découle du délai convenu avec le client", () => {
  const { service, entrepriseId, clientId } = preparer();
  const d = service.creer(entrepriseId, { client_id: clientId, lignes: LIGNES, date_emission: '2026-08-06' });
  assert.strictEqual(d.document.date_echeance, '2026-09-05');
});

test('émettre attribue un numéro et fige le document', () => {
  const { service, entrepriseId, clientId } = preparer();
  const d = service.creer(entrepriseId, { client_id: clientId, lignes: LIGNES, categorie: 'mixte', date_emission: '2026-08-06' });
  const emise = service.emettre(d.document.id);
  assert.strictEqual(emise.document.numero, 'F2026-0001');
  assert.strictEqual(emise.document.statut, 'emis');
  assert.ok(emise.document.empreinte.length === 64);
  assert.ok(emise.document.emis_le);
});

test('la numérotation est continue, sans trou', () => {
  const { service, entrepriseId, clientId } = preparer();
  for (let i = 1; i <= 3; i += 1) {
    const d = service.creer(entrepriseId, { client_id: clientId, lignes: LIGNES, categorie: 'mixte', date_emission: '2026-08-06' });
    const e = service.emettre(d.document.id);
    assert.strictEqual(e.document.numero, `F2026-000${i}`);
  }
});

test('un brouillon abandonné ne consomme aucun numéro', () => {
  const { service, entrepriseId, clientId } = preparer();
  const jete = service.creer(entrepriseId, { client_id: clientId, lignes: LIGNES, categorie: 'mixte' });
  service.supprimerBrouillon(jete.document.id);
  const garde = service.creer(entrepriseId, { client_id: clientId, lignes: LIGNES, categorie: 'mixte', date_emission: '2026-08-06' });
  assert.strictEqual(service.emettre(garde.document.id).document.numero, 'F2026-0001');
});

test('une facture émise ne se modifie plus', () => {
  const { service, entrepriseId, clientId } = preparer();
  const d = service.creer(entrepriseId, { client_id: clientId, lignes: LIGNES, categorie: 'mixte', date_emission: '2026-08-06' });
  service.emettre(d.document.id);
  assert.throws(() => service.modifier(d.document.id, { note: 'oups' }), ErreurMetier);
  assert.throws(() => service.remplacerLignes(d.document.id, []), ErreurMetier);
});

test('une facture émise ne se supprime pas', () => {
  const { service, entrepriseId, clientId } = preparer();
  const d = service.creer(entrepriseId, { client_id: clientId, lignes: LIGNES, categorie: 'mixte', date_emission: '2026-08-06' });
  service.emettre(d.document.id);
  assert.throws(() => service.supprimerBrouillon(d.document.id), /avoir/);
});

test('une facture non conforme est refusée à lémission, avec le motif', () => {
  const { db, service, entrepriseId } = preparer();
  const sansSiren = db.prepare(`
    INSERT INTO clients (entreprise_id, type, nom, adresse, code_postal, ville)
    VALUES (?, 'entreprise', 'Client sans SIREN', '2 rue X', '97100', 'Basse-Terre')
  `).run(entrepriseId);
  const d = service.creer(entrepriseId, { client_id: sansSiren.lastInsertRowid, lignes: LIGNES, categorie: 'mixte' });
  try {
    service.emettre(d.document.id);
    assert.fail('lémission aurait dû être refusée');
  } catch (e) {
    assert.ok(e instanceof ErreurMetier);
    assert.ok(e.anomalies.some((a) => a.includes('SIREN')));
  }
});

test('un encaissement partiel laisse la facture ouverte, le solde la clôt', () => {
  const { service, entrepriseId, clientId } = preparer();
  const d = service.creer(entrepriseId, { client_id: clientId, lignes: LIGNES, categorie: 'mixte', date_emission: '2026-08-06' });
  const e = service.emettre(d.document.id);
  let apres = service.encaisser(e.document.id, { montant: 100 });
  assert.strictEqual(apres.reste_du, 62);
  assert.strictEqual(apres.document.statut, 'emis');
  apres = service.encaisser(e.document.id, { montant: 62 });
  assert.strictEqual(apres.reste_du, 0);
  assert.strictEqual(apres.document.statut, 'paye');
});

test('on nencaisse pas un brouillon', () => {
  const { service, entrepriseId, clientId } = preparer();
  const d = service.creer(entrepriseId, { client_id: clientId, lignes: LIGNES, categorie: 'mixte' });
  assert.throws(() => service.encaisser(d.document.id, { montant: 50 }), /émise/);
});

test("l'avoir reprend les lignes en négatif et cite la facture d'origine", () => {
  const { service, entrepriseId, clientId } = preparer();
  const d = service.creer(entrepriseId, { client_id: clientId, lignes: LIGNES, categorie: 'mixte', date_emission: '2026-08-06' });
  const facture = service.emettre(d.document.id);
  const avoir = service.creerAvoir(facture.document.id, { motif: 'prestation annulée' });
  assert.strictEqual(avoir.document.type, 'avoir');
  assert.strictEqual(avoir.totaux.total_ttc, -162);
  assert.match(avoir.document.note, /F2026-0001/);
  const emis = service.emettre(avoir.document.id);
  assert.strictEqual(emis.document.numero, 'A2026-0001');
});

test('on nétablit pas un avoir sur un avoir', () => {
  const { service, entrepriseId, clientId } = preparer();
  const d = service.creer(entrepriseId, { client_id: clientId, lignes: LIGNES, categorie: 'mixte', date_emission: '2026-08-06' });
  const f = service.emettre(d.document.id);
  const a = service.emettre(service.creerAvoir(f.document.id).document.id);
  assert.throws(() => service.creerAvoir(a.document.id), /avoir sur un avoir/);
});

test('le journal est chaîné et se vérifie', () => {
  const { service, db, entrepriseId, clientId } = preparer();
  const d = service.creer(entrepriseId, { client_id: clientId, lignes: LIGNES, categorie: 'mixte', date_emission: '2026-08-06' });
  service.emettre(d.document.id);
  assert.strictEqual(service.verifierJournal().intact, true);

  // Quelqu'un retouche une ligne du journal : la chaîne doit le révéler.
  db.prepare("UPDATE journal SET detail = 'trafiqué' WHERE id = 1").run();
  db.prepare("UPDATE journal SET empreinte = 'faux' WHERE id = 1").run();
  assert.strictEqual(service.verifierJournal().intact, false);
});

test('le tableau de bord sépare ce qui est encaissé de ce qui est dû', () => {
  const { service, entrepriseId, clientId } = preparer();
  const a = service.emettre(service.creer(entrepriseId, { client_id: clientId, lignes: LIGNES, categorie: 'mixte', date_emission: '2026-08-06' }).document.id);
  service.creer(entrepriseId, { client_id: clientId, lignes: LIGNES, categorie: 'mixte', date_emission: '2026-08-06' });
  service.encaisser(a.document.id, { montant: 62 });

  const s = service.statistiques(entrepriseId);
  assert.strictEqual(s.emises, 1);
  assert.strictEqual(s.brouillons, 1);
  assert.strictEqual(s.chiffre_affaires_ttc, 162);
  assert.strictEqual(s.encaisse, 62);
  assert.strictEqual(s.reste_du, 100);
});

test('les impayés remontent les factures échues et non soldées', () => {
  const { service, entrepriseId, clientId } = preparer();
  const vieille = service.creer(entrepriseId, {
    client_id: clientId, lignes: LIGNES, categorie: 'mixte',
    date_emission: '2026-01-05', date_echeance: '2026-02-04',
  });
  service.emettre(vieille.document.id);
  const recente = service.creer(entrepriseId, {
    client_id: clientId, lignes: LIGNES, categorie: 'mixte',
    date_emission: '2026-08-06', date_echeance: '2099-01-01',
  });
  service.emettre(recente.document.id);

  const impayes = service.impayes(entrepriseId);
  assert.strictEqual(impayes.length, 1);
  assert.strictEqual(impayes[0].numero, 'F2026-0001');
  assert.strictEqual(impayes[0].reste_du, 162);
});

test('deux entreprises ne voient pas les documents de lautre', () => {
  const { db, service, entrepriseId, clientId } = preparer();
  const autre = db.prepare(`
    INSERT INTO entreprises (nom, siren, adresse, code_postal, ville)
    VALUES ('Autre SARL', '999888777', '9 rue Y', '75001', 'Paris')
  `).run();
  service.creer(entrepriseId, { client_id: clientId, lignes: LIGNES, categorie: 'mixte' });
  assert.strictEqual(service.liste(entrepriseId).length, 1);
  assert.strictEqual(service.liste(autre.lastInsertRowid).length, 0);
  assert.throws(() => service.creer(autre.lastInsertRowid, { client_id: clientId, lignes: LIGNES }), /n'existe pas/);
});
