'use strict';

/**
 * Supprimer une facture sans casser la suite des numéros.
 *
 * La règle française : la numérotation est chronologique, continue et sans
 * trou. On ne renumérote donc jamais des factures déjà remises. Le seul geste
 * possible est de reprendre la dernière émission, tant que rien n'en dépend.
 */

const test = require('node:test');
const assert = require('node:assert');
const { ouvrir } = require('../src/db');
const { Service, ErreurMetier } = require('../src/factures');

function preparer() {
  const db = ouvrir(':memory:');
  const service = new Service(db);
  const ent = db.prepare(`
    INSERT INTO entreprises (nom, siren, siret, tva_intra, adresse, code_postal, ville, iban, regime_tva)
    VALUES ('KDL TECH', '123456782', '12345678200019', 'FR11123456782',
            '1 rue des Palmiers', '97100', 'Basse-Terre',
            'FR7630001007941234567890185', 'normal')
  `).run();
  const cli = db.prepare(`
    INSERT INTO clients (entreprise_id, type, nom, siren, siret, adresse, code_postal, ville, delai_paiement_jours)
    VALUES (?, 'entreprise', 'Boulangerie Le Fournil', '987654324', '98765432400024',
            '5 avenue du Port', '97110', 'Pointe-à-Pitre', 30)
  `).run(ent.lastInsertRowid);
  return { db, service, entrepriseId: ent.lastInsertRowid, clientId: cli.lastInsertRowid };
}

const LIGNES = [{ designation: 'Dépannage', quantite: 2, prix_ht: 60, tva_taux: 20, unite: 'heure' }];

const emettre = (service, entrepriseId, clientId) => {
  const d = service.creer(entrepriseId, { client_id: clientId, lignes: LIGNES, categorie: 'services' });
  return service.emettre(d.document.id);
};

test('annuler la dernière émission rend le numéro au compteur', () => {
  const { service, entrepriseId, clientId } = preparer();
  const un = emettre(service, entrepriseId, clientId);
  const deux = emettre(service, entrepriseId, clientId);
  assert.match(deux.document.numero, /-0002$/);

  const apres = service.annulerEmission(deux.document.id);
  assert.strictEqual(apres.document.statut, 'brouillon');
  assert.strictEqual(apres.document.numero, null);
  assert.strictEqual(apres.document.empreinte, '');

  // Le numéro libéré revient à la facture suivante : aucun trou.
  const trois = emettre(service, entrepriseId, clientId);
  assert.match(trois.document.numero, /-0002$/);
  assert.match(un.document.numero, /-0001$/);
});

test('un brouillon redevenu modifiable se supprime', () => {
  const { service, entrepriseId, clientId } = preparer();
  const f = emettre(service, entrepriseId, clientId);
  service.annulerEmission(f.document.id);
  assert.deepStrictEqual(service.supprimerBrouillon(f.document.id), { supprime: true });
  assert.strictEqual(service.document(f.document.id), null);
});

test('une facture au milieu de la suite ne peut pas être annulée', () => {
  const { service, entrepriseId, clientId } = preparer();
  const un = emettre(service, entrepriseId, clientId);
  emettre(service, entrepriseId, clientId);
  assert.throws(() => service.annulerEmission(un.document.id), ErreurMetier);
  // Elle reste émise, intacte, avec son numéro.
  assert.strictEqual(service.document(un.document.id).document.statut, 'emis');
});

test('une facture encaissée ne peut pas être annulée', () => {
  const { service, entrepriseId, clientId } = preparer();
  const f = emettre(service, entrepriseId, clientId);
  service.encaisser(f.document.id, { montant: 10 });
  assert.throws(() => service.annulerEmission(f.document.id), ErreurMetier);
});

test('une facture déjà corrigée par un avoir ne peut pas être annulée', () => {
  const { service, entrepriseId, clientId } = preparer();
  const f = emettre(service, entrepriseId, clientId);
  service.creerAvoir(f.document.id, { motif: 'erreur' });
  assert.throws(() => service.annulerEmission(f.document.id), ErreurMetier);
});

test("supprimer directement une facture émise reste refusé, avec la marche à suivre", () => {
  const { service, entrepriseId, clientId } = preparer();
  const f = emettre(service, entrepriseId, clientId);
  assert.throws(() => service.supprimerBrouillon(f.document.id), (e) => {
    assert.ok(e instanceof ErreurMetier);
    assert.match(e.message, /annuler l'émission|avoir/i);
    return true;
  });
});

test('le contrôle de numérotation voit une suite continue', () => {
  const { service, entrepriseId, clientId } = preparer();
  emettre(service, entrepriseId, clientId);
  emettre(service, entrepriseId, clientId);
  const etat = service.verifierNumerotation(entrepriseId);
  assert.strictEqual(etat.continue, true);
  const suite = etat.suites.find((s) => s.type === 'facture');
  assert.strictEqual(suite.dernier, 2);
  assert.strictEqual(suite.emis, 2);
  assert.deepStrictEqual(suite.manquants, []);
});

test('le contrôle de numérotation dénonce un trou creusé hors du logiciel', () => {
  const { db, service, entrepriseId, clientId } = preparer();
  emettre(service, entrepriseId, clientId);
  const deux = emettre(service, entrepriseId, clientId);
  emettre(service, entrepriseId, clientId);
  // Suppression sauvage en base, comme le ferait une main extérieure.
  db.prepare('DELETE FROM documents WHERE id = ?').run(deux.document.id);

  const etat = service.verifierNumerotation(entrepriseId);
  assert.strictEqual(etat.continue, false);
  assert.deepStrictEqual(etat.suites.find((s) => s.type === 'facture').manquants, [2]);
});
