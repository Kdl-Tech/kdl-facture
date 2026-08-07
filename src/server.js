'use strict';

/**
 * Serveur local de KDL Facture.
 *
 * Il n'écoute que sur 127.0.0.1 : les données comptables restent sur la
 * machine, et aucune autre machine du réseau ne peut les lire. C'est un choix,
 * pas une limite — une TPE n'a pas à exposer sa facturation sur Internet.
 */

const express = require('express');
const path = require('node:path');
const { ouvrir, cheminParDefaut } = require('./db');
const { creerApi } = require('./api');

const PORT = Number(process.env.KDL_FACTURE_PORT) || 4310;
const HOTE = '127.0.0.1';

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

  app.use('/api', creerApi(db, { base: options.base || cheminParDefaut() }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

  const serveur = app.listen(PORT, HOTE, () => {
    const url = `http://${HOTE}:${PORT}`;
    process.stdout.write(`KDL Facture — ${url}\n`);
    if (options.ouvrirNavigateur !== false) ouvrirNavigateur(url);
  });

  serveur.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      process.stderr.write(`Le port ${PORT} est déjà pris : KDL Facture tourne peut-être déjà.\n`);
      process.exit(1);
    }
    // Toute autre erreur est signalée, jamais fatale : perdre le serveur en
    // pleine saisie coûterait le travail en cours.
    process.stderr.write(`  Erreur réseau : ${e.message}\n`);
  });

  return { app, db, serveur };
}

function ouvrirNavigateur(url) {
  const { spawn } = require('node:child_process');
  const commande = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(commande, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* Pas de navigateur : l'URL est affichée, cela suffit. */
  }
}

if (require.main === module) demarrer();

module.exports = { demarrer, PORT };
