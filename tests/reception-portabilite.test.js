'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * La réception doit tourner dans un navigateur autant que sous Node : c'est ce
 * qui permet à la version PWA d'être la même application partout, sans serveur.
 *
 * Cette garantie est facile à perdre sans s'en apercevoir — il suffit d'un
 * `require('node:zlib')` ajouté un jour de fatigue, et le code continue de
 * passer tous les autres tests. D'où ce garde-fou : il échoue à l'écriture, pas
 * six mois plus tard chez un utilisateur.
 */

const DOSSIERS = [
  path.join(__dirname, '..', 'src', 'reception'),
  path.join(__dirname, '..', 'src', 'pwa'),
];
// Fichiers isolés qui doivent rester portables : le dessin du PDF est partagé
// entre la version de bureau et la version installable.
const FICHIERS_PORTABLES = [
  path.join(__dirname, '..', 'src', 'rendu-pdf.js'),
  path.join(__dirname, '..', 'src', 'calculs.js'),
  path.join(__dirname, '..', 'src', 'facturx.js'),
  path.join(__dirname, '..', 'src', 'territoires.js'),
];
const MODULES_INTERDITS = /require\(\s*['"](node:)?(fs|path|zlib|crypto|buffer|stream|os|child_process|http|https|url)['"]\s*\)/;

test('aucun module de réception ni de PWA ne dépend de Node', () => {
  const fichiers = DOSSIERS.flatMap((dossier) => fs.readdirSync(dossier)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(dossier, f)))
    .concat(FICHIERS_PORTABLES);
  assert.ok(fichiers.length >= 11, 'les modules portables doivent être présents');

  for (const chemin of fichiers) {
    const fichier = path.basename(chemin);
    const code = fs.readFileSync(chemin, 'utf-8');
    const trouve = code.match(MODULES_INTERDITS);
    assert.strictEqual(
      trouve, null,
      `${fichier} charge ${trouve && trouve[0]} : la réception ne tournerait plus dans un navigateur.`,
    );
    assert.doesNotMatch(code, /\bprocess\.(env|execPath|cwd)/,
      `${fichier} lit process : absent d'un navigateur.`);
    assert.doesNotMatch(code, /\b__dirname\b/,
      `${fichier} utilise __dirname : absent d'un navigateur.`);
  }
});

/**
 * Les trois interfaces du Web sur lesquelles la réception s'appuie. Node les
 * fournit depuis la version 18 ; les vérifier ici documente la dépendance
 * réelle, à défaut de pouvoir lancer un navigateur dans les tests.
 */
test('les interfaces web utilisées existent des deux côtés', () => {
  assert.strictEqual(typeof DecompressionStream, 'function', 'décompression des pièces jointes');
  assert.strictEqual(typeof TextDecoder, 'function', 'décodage UTF-8');
  assert.strictEqual(typeof crypto.subtle.digest, 'function', 'empreinte des fichiers reçus');
});
