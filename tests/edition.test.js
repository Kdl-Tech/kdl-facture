'use strict';

/**
 * Les deux éditions.
 *
 * La règle qui gouverne ces tests : **ce qui rend une facture conforme n'est
 * jamais bridé**. On limite le volume et le confort, jamais la validité
 * juridique de ce qui sort du logiciel.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ouvrir } = require('../src/db');
const { Service, ErreurMetier } = require('../src/factures');
const {
  DECOUVERTE, PRO, capacites, creerCle, cleValide,
  lireLicence, poserLicence, retirerLicence,
} = require('../src/edition');

function preparer(licence = null) {
  const db = ouvrir(':memory:');
  const service = new Service(db, licence);
  const ent = db.prepare(`
    INSERT INTO entreprises (nom, siren, siret, tva_intra, adresse, code_postal, ville, iban, regime_tva)
    VALUES ('KDL TECH', '123456789', '12345678900019', 'FR12123456789',
            '1 rue X', '75001', 'Paris', 'FR7630001007941234567890185', 'normal')
  `).run();
  const cli = db.prepare(`
    INSERT INTO clients (entreprise_id, type, nom, siren, siret, adresse, code_postal, ville)
    VALUES (?, 'entreprise', 'Client SARL', '987654321', '98765432100014', '5 rue Y', '75002', 'Paris')
  `).run(ent.lastInsertRowid);
  return { db, service, entrepriseId: ent.lastInsertRowid, clientId: cli.lastInsertRowid };
}

const LIGNES = [{ designation: 'Prestation', quantite: 1, prix_ht: 100, tva_taux: 20 }];

test('sans licence, on est en édition Découverte', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'kdl-'));
  const licence = lireLicence(path.join(dossier, 'facture.db'));
  assert.strictEqual(licence.edition, DECOUVERTE);
  assert.strictEqual(capacites(licence).nom, 'Découverte');
});

test('la conformité n’est jamais bridée', () => {
  // Factur-X, journal inaltérable et avoirs restent disponibles gratuitement :
  // personne ne doit payer pour respecter la loi.
  for (const edition of [DECOUVERTE, PRO]) {
    const capa = capacites({ edition });
    assert.strictEqual(capa.facturx, true, `${edition} doit produire du Factur-X`);
    assert.strictEqual(capa.journal, true, `${edition} doit tenir son journal`);
    assert.strictEqual(capa.avoirs, true, `${edition} doit pouvoir corriger par avoir`);
  }
});

test('une clé valide ouvre le Pro, une clé au hasard non', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'kdl-'));
  const base = path.join(dossier, 'facture.db');
  const cle = creerCle('boulangerie@exemple.fr');

  assert.ok(cleValide(cle, 'boulangerie@exemple.fr'));
  assert.ok(!cleValide('PRO-AAAAA-BBBBB-CCCCC-DDDDD', 'boulangerie@exemple.fr'));
  // Une clé authentique ne vaut que pour son titulaire.
  assert.ok(!cleValide(cle, 'quelquun.dautre@exemple.fr'));

  assert.strictEqual(poserLicence(base, 'boulangerie@exemple.fr', cle).ok, true);
  assert.strictEqual(lireLicence(base).edition, PRO);
  assert.strictEqual(poserLicence(base, 'autre@exemple.fr', cle).ok, false);
});

test('retirer la licence ramène à Découverte', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'kdl-'));
  const base = path.join(dossier, 'facture.db');
  poserLicence(base, 'client@exemple.fr', creerCle('client@exemple.fr'));
  assert.strictEqual(lireLicence(base).edition, PRO);
  retirerLicence(base);
  assert.strictEqual(lireLicence(base).edition, DECOUVERTE);
});

test('la casse et les espaces ne font pas échouer une clé', () => {
  const cle = creerCle('  Client@Exemple.FR  ');
  assert.ok(cleValide(cle.toLowerCase(), 'client@exemple.fr'));
});

test('Découverte bute sur son quinzième anniversaire, Pro non', () => {
  const { service, entrepriseId, clientId } = preparer({ edition: DECOUVERTE });
  const emettreUne = (s) => {
    const d = s.creer(entrepriseId, {
      client_id: clientId, lignes: LIGNES, categorie: 'services', date_emission: '2026-08-06',
    });
    return s.emettre(d.document.id);
  };

  for (let i = 0; i < 15; i += 1) emettreUne(service);
  assert.strictEqual(service.facturesEmisesCetteAnnee(entrepriseId, 2026), 15);

  try {
    emettreUne(service);
    assert.fail('la seizième aurait dû être refusée');
  } catch (e) {
    assert.ok(e instanceof ErreurMetier);
    assert.match(e.message, /Découverte permet 15 factures/);
    // Le refus doit rassurer : rien n'est perdu.
    assert.match(e.message, /restent intactes/);
  }

  // La même base, avec une licence Pro, repart sans limite.
  service.licence = { edition: PRO };
  assert.ok(emettreUne(service).document.numero);
});

test('un avoir ne consomme pas le quota', () => {
  // Corriger une erreur ne doit jamais coûter une facture au client.
  const { service, entrepriseId, clientId } = preparer({ edition: DECOUVERTE });
  const f = service.emettre(service.creer(entrepriseId, {
    client_id: clientId, lignes: LIGNES, categorie: 'services', date_emission: '2026-08-06',
  }).document.id);
  const avant = service.facturesEmisesCetteAnnee(entrepriseId, 2026);
  service.emettre(service.creerAvoir(f.document.id).document.id);
  assert.strictEqual(service.facturesEmisesCetteAnnee(entrepriseId, 2026), avant);
});

test('le quota se remet à zéro chaque année civile', () => {
  const { service, entrepriseId, clientId } = preparer({ edition: DECOUVERTE });
  for (let i = 0; i < 15; i += 1) {
    service.emettre(service.creer(entrepriseId, {
      client_id: clientId, lignes: LIGNES, categorie: 'services', date_emission: '2026-08-06',
    }).document.id);
  }
  // Une facture datée de l'année suivante passe : le compteur est annuel.
  const suivante = service.creer(entrepriseId, {
    client_id: clientId, lignes: LIGNES, categorie: 'services', date_emission: '2027-01-05',
  });
  assert.ok(service.emettre(suivante.document.id).document.numero.startsWith('F2027-'));
});
