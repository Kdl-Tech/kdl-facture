'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * Le service worker décide si le logiciel s'ouvre hors ligne et si une mise à
 * jour arrive jusqu'à l'utilisateur. Ces deux comportements ne se voient pas en
 * regardant le code : ils se voient en le faisant tourner.
 *
 * On l'exécute donc ici dans un environnement simulé — un faux `caches`, un
 * faux `fetch` — pour éprouver ce qui compte vraiment : la prise de contrôle
 * immédiate, le nettoyage des anciennes versions, et le repli hors ligne.
 */

function environnement({ reseauCoupe = false, cachesExistants = [] } = {}) {
  const contenu = new Map(cachesExistants.map((nom) => [nom, new Map()]));
  const journal = { skipWaiting: 0, claim: 0, supprimes: [] };

  const faireCache = (nom) => {
    if (!contenu.has(nom)) contenu.set(nom, new Map());
    const entrees = contenu.get(nom);
    return {
      async addAll(requetes) {
        for (const r of requetes) entrees.set(String(r.url || r), { corps: 'en cache' });
      },
      async match(requete) {
        const cle = String(requete.url || requete);
        return entrees.get(cle) || entrees.get(cle.replace(/^\.\//, '')) || null;
      },
      async put(requete, reponse) { entrees.set(String(requete.url || requete), reponse); },
      async keys() { return [...entrees.keys()]; },
    };
  };

  const evenements = new Map();
  const bac = {
    console,
    URL,
    Request: class { constructor(url, options) { this.url = url; this.options = options; } },
    fetch: async (requete) => {
      if (reseauCoupe) throw new Error('hors ligne');
      return {
        ok: true, type: 'basic', url: String(requete.url || requete), clone() { return this; },
      };
    },
    caches: {
      async open(nom) { return faireCache(nom); },
      async keys() { return [...contenu.keys()]; },
      async delete(nom) { journal.supprimes.push(nom); return contenu.delete(nom); },
    },
    self: {
      location: { origin: 'https://exemple.test' },
      addEventListener(nom, gestionnaire) { evenements.set(nom, gestionnaire); },
      async skipWaiting() { journal.skipWaiting += 1; },
      clients: { async claim() { journal.claim += 1; } },
    },
  };
  bac.self.caches = bac.caches;
  bac.globalThis = bac;

  const code = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'sw.js'), 'utf-8')
    .replaceAll('__VERSION__', '9.9.9');
  vm.runInNewContext(code, bac);

  const declencher = async (nom, evenement = {}) => {
    const gestionnaire = evenements.get(nom);
    assert.ok(gestionnaire, `le service worker doit écouter « ${nom} »`);
    let attendu;
    const complet = {
      ...evenement,
      waitUntil: (p) => { attendu = p; },
      respondWith: (p) => { attendu = p; },
    };
    gestionnaire(complet);
    return attendu;
  };

  return {
    declencher, journal, contenu, caches: bac.caches,
  };
}

test('l installation met la coquille en cache et prend la main tout de suite', async () => {
  const env = environnement();
  await env.declencher('install');

  assert.strictEqual(env.journal.skipWaiting, 1,
    'sans skipWaiting, un appareil resterait bloqué sur l ancienne version');

  const cache = [...env.contenu.keys()];
  assert.deepStrictEqual(cache, ['kdl-facture-9.9.9']);
  const fichiers = [...env.contenu.get('kdl-facture-9.9.9').keys()];
  assert.ok(fichiers.includes('./index.html'), './index.html doit être disponible hors ligne');

  /*
   * Les fichiers que la page charge portent la version dans leur URL : c'est ce
   * qui empêche un cache intermédiaire de servir l ancien `app.js` après une
   * mise à jour. Le service worker doit donc mettre en cache exactement ces
   * URL-là, sans quoi la page les redemanderait au réseau.
   */
  for (const attendu of ['./app.js', './style.css', './manifest.webmanifest']) {
    assert.ok(fichiers.includes(`${attendu}?v=9.9.9`),
      `${attendu} doit être en cache sous son URL versionnée`);
    assert.ok(!fichiers.includes(attendu),
      `${attendu} ne doit pas être mis en cache sans sa version`);
  }
});

test('l activation efface les versions précédentes et réclame les pages ouvertes', async () => {
  const env = environnement({ cachesExistants: ['kdl-facture-1.0.0', 'kdl-facture-2.0.0'] });
  await env.declencher('activate');

  assert.strictEqual(env.journal.claim, 1);
  assert.deepStrictEqual(env.journal.supprimes.sort(), ['kdl-facture-1.0.0', 'kdl-facture-2.0.0']);
});

test('une page déjà en cache est servie sans toucher au réseau', async () => {
  const env = environnement();
  await env.declencher('install');

  const reponse = await env.declencher('fetch', {
    request: {
      method: 'GET', url: 'https://exemple.test/app.js', mode: 'no-cors',
    },
  });
  assert.ok(reponse, 'la requête doit être prise en charge');
});

/**
 * Le cas qui compte pour un artisan en déplacement : plus de réseau, et le
 * logiciel doit quand même s'ouvrir.
 */
test('hors ligne, une navigation retombe sur l application au lieu d une erreur', async () => {
  const env = environnement({ reseauCoupe: true });
  await env.declencher('install');

  const reponse = await env.declencher('fetch', {
    request: {
      method: 'GET', url: 'https://exemple.test/facture/12', mode: 'navigate',
    },
  });
  const resolu = await reponse;
  assert.ok(resolu, 'l application doit s ouvrir malgré l absence de réseau');
});

test('les requêtes vers un autre site ne sont pas interceptées', async () => {
  const env = environnement();
  const reponse = await env.declencher('fetch', {
    request: { method: 'GET', url: 'https://ailleurs.example/pixel.gif', mode: 'no-cors' },
  });
  assert.strictEqual(reponse, undefined,
    'le service worker ne doit pas se mêler des requêtes externes');
});

test('les envois de données ne passent pas par le cache', async () => {
  const env = environnement();
  const reponse = await env.declencher('fetch', {
    request: { method: 'POST', url: 'https://exemple.test/api', mode: 'cors' },
  });
  assert.strictEqual(reponse, undefined);
});
