/**
 * Le service worker de KDL Facture.
 *
 * Il sert à une seule chose : que le logiciel s'ouvre et fonctionne sans réseau.
 * Les données, elles, n'y passent jamais — elles restent dans IndexedDB, sur la
 * machine de l'utilisateur.
 *
 * 🔴 `skipWaiting()` à l'installation n'est pas négociable. Sans lui, un
 * appareil garde l'ancienne version tant que tous les onglets ne sont pas
 * fermés — ce qui n'arrive jamais sur un logiciel qu'on laisse ouvert toute la
 * journée. Des appareils sont déjà restés bloqués des semaines sur une vieille
 * version pour cette seule raison.
 */

const VERSION = '__VERSION__';
const CACHE = `kdl-facture-${VERSION}`;

/*
 * Les mêmes URL que celles de la page : versionnées, donc jamais servies
 * périmées par un cache intermédiaire. Les entrées non versionnées ci-dessous
 * (polices, moteur PDF) ne changent pas d'une version à l'autre.
 */
const V = `?v=${VERSION}`;

const COQUILLE = [
  './',
  './index.html',
  `./app.js${V}`,
  `./style.css${V}`,
  `./kdl-theme.css${V}`,
  `./kdl-theme.js${V}`,
  `./manifest.webmanifest${V}`,
  './icone-192.png',
  './icone-512.png',
];

/**
 * Ce qu'il faut pour *émettre* une facture hors ligne : le moteur PDF, les
 * polices et le profil colorimétrique. Environ quatre mégaoctets, mis de côté
 * une seule fois — c'est le prix pour qu'une facture puisse être établie dans
 * un atelier sans réseau. Leur absence ne doit pas faire échouer l'installation
 * pour autant : sans eux, la consultation reste possible.
 */
const POUR_EMETTRE = [
  './pdfkit.standalone.js',
  './ressources/DejaVuSans.ttf',
  './ressources/DejaVuSans-Bold.ttf',
  './ressources/sRGB_IEC61966_2_1.icc',
  './ressources/logo-facture.png',
  `./kdl-promo.js${V}`,
  './fonts/bricolage.woff2',
  './fonts/onest.woff2',
];

self.addEventListener('install', (evenement) => {
  evenement.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // `reload` court-circuite le cache HTTP : sans cela, une mise à jour peut
    // réinstaller les anciens fichiers servis par le navigateur.
    await cache.addAll(COQUILLE.map((url) => new Request(url, { cache: 'reload' })));
    // Le nécessaire à l'émission est mis de côté sans bloquer l'installation.
    cache.addAll(POUR_EMETTRE.map((url) => new Request(url, { cache: 'reload' })))
      .catch(() => {});
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (evenement) => {
  evenement.waitUntil((async () => {
    const noms = await caches.keys();
    await Promise.all(noms.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

/**
 * Hors ligne d'abord : le logiciel doit s'ouvrir dans un atelier sans réseau,
 * dans un train, chez un client. Le réseau ne sert qu'à découvrir une mise à
 * jour, jamais à faire fonctionner l'application.
 */
self.addEventListener('fetch', (evenement) => {
  const requete = evenement.request;
  if (requete.method !== 'GET') return;
  const url = new URL(requete.url);
  if (url.origin !== self.location.origin) return;
  // Les données synchronisées ne doivent jamais venir du cache de la PWA.
  if (url.pathname.startsWith('/api/')) return;

  evenement.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const enCache = await cache.match(requete, { ignoreSearch: true });
    if (enCache) return enCache;

    try {
      const reponse = await fetch(requete);
      if (reponse && reponse.ok && reponse.type === 'basic') {
        cache.put(requete, reponse.clone());
      }
      return reponse;
    } catch (erreur) {
      // Une navigation hors ligne retombe sur la coquille : l'application
      // s'ouvre, et c'est elle qui expliquera ce qui manque, pas le navigateur.
      if (requete.mode === 'navigate') {
        const coquille = await cache.match('./index.html');
        if (coquille) return coquille;
      }
      throw erreur;
    }
  })());
});

/** L'interface peut demander la version installée, pour l'afficher. */
self.addEventListener('message', (evenement) => {
  if (evenement.data === 'version' && evenement.source) {
    evenement.source.postMessage({ version: VERSION });
  }
});
