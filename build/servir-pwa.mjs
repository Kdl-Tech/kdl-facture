/**
 * Sert la version installable en local, pour l'essayer ou l'installer.
 *
 * Écoute sur la boucle locale seulement : rien n'est exposé au réseau. Un
 * navigateur n'accepte d'installer une application et d'activer son mode hors
 * ligne que sur une origine sûre — `127.0.0.1` en est une, contrairement à un
 * fichier ouvert depuis le disque.
 *
 *   npm run pwa
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist-pwa');
const PORT = Number(process.env.PORT_PWA || 4311);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.icc': 'application/vnd.iccprofile',
  '.xml': 'application/xml',
};

if (!existsSync(join(RACINE, 'index.html'))) {
  console.error('Rien à servir : lancez d\'abord « node build/pwa.mjs ».');
  process.exit(1);
}

createServer((requete, reponse) => {
  const chemin = decodeURIComponent(requete.url.split('?')[0]);
  const fichier = join(RACINE, normalize(chemin === '/' ? '/index.html' : chemin));

  if (!fichier.startsWith(RACINE) || !existsSync(fichier) || !statSync(fichier).isFile()) {
    reponse.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    reponse.end('Introuvable');
    return;
  }

  reponse.writeHead(200, {
    'Content-Type': TYPES[extname(fichier)] || 'application/octet-stream',
    // Le service worker doit toujours être relu : c'est lui qui porte la version.
    'Cache-Control': extname(fichier) === '.js' && fichier.endsWith('sw.js')
      ? 'no-cache' : 'no-store',
  });
  createReadStream(fichier).pipe(reponse);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`KDL Facture : http://127.0.0.1:${PORT}`);
  console.log('Pour l\'installer : menu du navigateur → « Installer KDL Facture ».');
});
