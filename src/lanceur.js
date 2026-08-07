'use strict';

/**
 * Point d'entrée de l'exécutable autonome.
 *
 * Quand l'application tourne empaquetée, l'interface web n'est plus sur le
 * disque : elle voyage dans le binaire. Ce fichier sert les deux cas — dossier
 * `public/` en développement, ressources embarquées en production — sans que
 * le reste du code ait à savoir lequel des deux s'applique.
 */

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { ouvrir, cheminParDefaut } = require('./db');
const { creerApi } = require('./api');

const PORT = Number(process.env.KDL_FACTURE_PORT) || 4310;
const HOTE = '127.0.0.1';

/** L'interface embarquée dans le code, présente uniquement dans l'exécutable.

    Le module est produit à la construction ; en développement il n'existe pas,
    et le dossier `public/` sert directement. */
function ressourceEmbarquee(nom) {
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    return require('./ressources-embarquees').lire(nom);
  } catch {
    return null;
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function servirInterface(app) {
  const dossier = path.join(__dirname, '..', 'public');
  const surDisque = fs.existsSync(dossier);

  if (surDisque) {
    app.use(express.static(dossier, { maxAge: '1h' }));
    return;
  }

  // Un middleware plutôt qu'une route à motif : la syntaxe des jokers a changé
  // entre Express 4 et 5, celle-ci fonctionne avec les deux.
  app.use((req, res, suite) => {
    if (req.method !== 'GET') return suite();
    const nom = req.path === '/' ? 'index.html' : req.path.replace(/^\//, '');
    const contenu = ressourceEmbarquee(`public/${nom}`);
    if (!contenu) return suite();
    res.setHeader('Content-Type', TYPES[path.extname(nom)] || 'application/octet-stream');
    return res.end(contenu);
  });
}

function demarrer(options = {}) {
  const db = ouvrir(options.base);
  const app = express();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'");
    next();
  });

  app.use('/api', creerApi(db));
  servirInterface(app);

  const serveur = app.listen(PORT, HOTE, () => {
    const url = `http://${HOTE}:${PORT}`;
    process.stdout.write(`\n  KDL Facture\n  ${url}\n  Données : ${options.base || cheminParDefaut()}\n\n  Laissez cette fenêtre ouverte. Fermez-la pour quitter.\n\n`);
    if (options.ouvrirNavigateur !== false) ouvrirNavigateur(url);
  });

  serveur.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      process.stderr.write(`  Le port ${PORT} est déjà pris : KDL Facture tourne peut-être déjà.\n`);
      process.exit(1);
    }
    throw e;
  });

  return { app, db, serveur };
}

function ouvrirNavigateur(url) {
  const { spawn } = require('node:child_process');
  try {
    if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* Sans navigateur, l'URL affichée suffit. */
  }
}

if (require.main === module || (() => { try { return require('node:sea').isSea(); } catch { return false; } })()) {
  demarrer();
}

module.exports = { demarrer, PORT };
