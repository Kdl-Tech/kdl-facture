'use strict';

/**
 * Le serveur doit démarrer.
 *
 * Évident, et pourtant : le 2026-08-07, `server.js` appelait `cheminParDefaut()`
 * sans l'importer depuis `db.js`. L'application plantait au lancement avec un
 * ReferenceError — et les 68 tests passaient tous, parce qu'aucun ne démarrait
 * réellement le serveur. Ils testaient les pièces, jamais l'assemblage.
 *
 * Ce test comble ce trou : il monte l'application complète et l'interroge.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Port dédié au test : sans cela il échouerait dès qu'une instance tourne déjà
// sur 4310. À définir avant de charger le module, qui lit PORT au chargement.
// (Le port 0 serait plus élégant, mais `Number('0') || 4310` le rejette.)
process.env.KDL_FACTURE_PORT = '45310';
const { demarrer } = require('../src/server');

test('le serveur démarre et sert son API', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'kdl-facture-test-'));
  const base = path.join(dossier, 'facture.db');
  let lance;

  try {
    // ouvrirNavigateur: false — un test ne doit pas ouvrir de fenêtre.
    lance = demarrer({ base, ouvrirNavigateur: false });
    assert.ok(lance && lance.app, 'demarrer() doit renvoyer l’application');
    assert.ok(lance.serveur, 'demarrer() doit renvoyer le serveur HTTP');

    // Le serveur écoute réellement, et l'API répond.
    await new Promise((ok) => lance.serveur.once('listening', ok));
    const port = lance.serveur.address().port;
    const rep = await fetch(`http://127.0.0.1:${port}/api/territoires`);
    assert.strictEqual(rep.status, 200, 'l’API doit répondre 200');
  } finally {
    if (lance) {
      if (lance.serveur) lance.serveur.close();
      if (lance.db && typeof lance.db.close === 'function') lance.db.close();
    }
    fs.rmSync(dossier, { recursive: true, force: true });
  }
});
