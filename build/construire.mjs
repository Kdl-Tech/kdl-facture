/**
 * Construit les trois exécutables : Linux, Windows, macOS.
 *
 * Le principe : Node sait, depuis la version 20, se transformer en exécutable
 * autonome. On prend le runtime officiel de chaque système, on y injecte
 * l'application compilée en un seul fichier, et le résultat se lance sans
 * rien installer — ni Node, ni npm, ni compilateur.
 *
 * C'est possible parce que la base de données passe par `node:sqlite`, intégré
 * au runtime : aucun module natif à recompiler par plateforme.
 */

import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRAVAIL = path.join(RACINE, 'build', 'travail');
const RUNTIMES = process.env.KDL_RUNTIMES || path.join(RACINE, 'build', 'runtimes');

const CIBLES = [
  { nom: 'linux', binaire: 'KDL-Facture', source: 'node-v22.21.1-linux-x64/bin/node' },
  { nom: 'windows', binaire: 'KDL-Facture.exe', source: 'node-v22.21.1-win-x64/node.exe' },
  { nom: 'macos', binaire: 'KDL-Facture-mac', source: 'node-v22.21.1-darwin-arm64/bin/node' },
];

const dire = (m) => process.stdout.write(`${m}\n`);

/** Étape 0 — l'interface web, transformée en module JavaScript.

    Le mécanisme d'« assets » de Node fait planter l'exécutable dès qu'on y met
    des fichiers binaires. On contourne en embarquant l'interface dans le code
    lui-même : chaque fichier devient une chaîne base64 que le serveur décode à
    la volée. Un seul artefact, aucun chargement externe. */
function graverRessources() {
  fs.mkdirSync(TRAVAIL, { recursive: true });
  const fichiers = {};
  for (const nom of fs.readdirSync(path.join(RACINE, 'public'))) {
    fichiers[`public/${nom}`] = fs.readFileSync(path.join(RACINE, 'public', nom)).toString('base64');
  }
  fichiers['logo-facture.png'] = fs.readFileSync(path.join(RACINE, 'src', 'logo-facture.png')).toString('base64');
  // Les polices : sans elles, PDFKit cherche des fichiers de métriques qui
  // n'existent pas dans un exécutable, et aucune facture ne sort.
  for (const nom of fs.readdirSync(path.join(RACINE, 'src', 'polices'))) {
    if (!nom.endsWith('.ttf') && !nom.endsWith('.icc')) continue;
    fichiers[`polices/${nom}`] = fs.readFileSync(path.join(RACINE, 'src', 'polices', nom)).toString('base64');
  }

  const module = `'use strict';\n\n`
    + `/* Fichier produit par build/construire.mjs — ne pas modifier à la main. */\n\n`
    + `const RESSOURCES = ${JSON.stringify(fichiers)};\n\n`
    + `module.exports = {\n`
    + `  lire(nom) {\n`
    + `    const brut = RESSOURCES[nom];\n`
    + `    return brut ? Buffer.from(brut, 'base64') : null;\n`
    + `  },\n`
    + `};\n`;
  fs.writeFileSync(path.join(RACINE, 'src', 'ressources-embarquees.js'), module);
  const poids = Math.round(Buffer.byteLength(module) / 1024);
  dire(`  interface gravée dans le code — ${Object.keys(fichiers).length} fichiers, ${poids} ko`);
}

/** Étape 1 — tout le code applicatif en un seul fichier. */
async function empaqueter() {
  fs.mkdirSync(TRAVAIL, { recursive: true });
  await build({
    entryPoints: [path.join(RACINE, 'src', 'lanceur.js')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: path.join(TRAVAIL, 'application.js'),
    // better-sqlite3 n'est là que pour les vieux Node : l'exécutable embarque
    // node:sqlite, donc on écarte le module natif du paquet.
    external: ['better-sqlite3', 'node:sqlite'],
    loader: { '.png': 'binary' },
    minify: false,
    logLevel: 'warning',
  });
  const taille = Math.round(fs.statSync(path.join(TRAVAIL, 'application.js')).size / 1024);
  dire(`  application empaquetée — ${taille} ko`);
}

/** Étape 2 — le blob que Node saura exécuter au démarrage. */
function preparerBlob() {
  const config = {
    main: path.join(TRAVAIL, 'application.js'),
    output: path.join(TRAVAIL, 'application.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
  fs.writeFileSync(path.join(TRAVAIL, 'sea-config.json'), JSON.stringify(config, null, 2));
  // Le blob doit être préparé par le MÊME Node que celui qui l'exécutera :
  // son format évolue d'une version à l'autre, et un blob de Node 20 injecté
  // dans un binaire Node 22 fait planter l'exécutable au démarrage.
  const nodeCible = path.join(RUNTIMES, 'node-v22.21.1-linux-x64', 'bin', 'node');
  const prepareur = fs.existsSync(nodeCible) ? nodeCible : process.execPath;
  execFileSync(prepareur, ['--experimental-sea-config', path.join(TRAVAIL, 'sea-config.json')],
    { stdio: 'pipe' });
  dire(`  blob préparé — ${Math.round(fs.statSync(config.output).size / 1024)} ko`);
}

/** Étape 3 — injecter le blob dans le runtime de chaque système. */
async function injecter(cible) {
  const source = path.join(RUNTIMES, cible.source);
  if (!fs.existsSync(source)) {
    dire(`  ${cible.nom} : runtime absent (${cible.source}) — ignoré`);
    return null;
  }
  const sortie = path.join(TRAVAIL, cible.binaire);
  fs.copyFileSync(source, sortie);
  fs.chmodSync(sortie, 0o755);

  // postject écrit directement dans le fichier cible ; il ne rend pas de buffer.
  const { inject } = await import('postject');
  const blob = fs.readFileSync(path.join(TRAVAIL, 'application.blob'));
  await inject(sortie, 'NODE_SEA_BLOB', blob, {
    machoSegmentName: cible.nom === 'macos' ? 'NODE_SEA' : undefined,
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    overwrite: true,
  });
  fs.chmodSync(sortie, 0o755);
  dire(`  ${cible.nom} : ${cible.binaire} — ${Math.round(fs.statSync(sortie).size / 1048576)} Mo`);
  return sortie;
}

async function principal() {
  dire('KDL Facture — construction des exécutables');
  graverRessources();
  await empaqueter();
  preparerBlob();
  const produits = [];
  for (const cible of CIBLES) {
    const r = await injecter(cible);
    if (r) produits.push(r);
  }
  dire(`${produits.length} exécutable(s) construit(s) dans ${TRAVAIL}`);
}

principal().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
