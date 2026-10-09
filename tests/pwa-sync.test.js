'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { creerDepot, magasinMemoire } = require('../src/pwa/depot');
const { creerSync } = require('../src/pwa/sync');

const ID = 'a'.repeat(64);

/** Un faux service de synchro en mémoire : mêmes règles que kdl-facture-sync. */
function fauxServeur() {
  const stockage = new Map();
  return async (url, options = {}) => {
    const id = url.split('/').pop();
    if (!/^[a-f0-9]{64}$/.test(id)) return { ok: false, status: 400 };
    if (!options.method || options.method === 'GET') {
      if (!stockage.has(id)) return { ok: false, status: 404, headers: { get: () => '2' } };
      return { ok: true, status: 200,
        headers: { get: nom => nom === 'etag' ? JSON.stringify(stockage.get(id)) : '2' },
        json: async () => stockage.get(id) };
    }
    if (options.method === 'PUT') {
      if ((options.headers['If-None-Match'] === '*' && stockage.has(id))
        || (options.headers['If-Match'] && options.headers['If-Match'] !== JSON.stringify(stockage.get(id)))) {
        return { ok: false, status: 412 };
      }
      const donnees = JSON.parse(options.body);
      stockage.set(id, donnees);
      return { ok: true, status: 200, json: async () => ({ enregistre: true }) };
    }
    return { ok: false, status: 405 };
  };
}

test('sans identifiant configuré, pousser/tirer ne font rien', async () => {
  const depot = creerDepot(magasinMemoire());
  const sync = creerSync({ depot, fetchImpl: fauxServeur() });
  assert.strictEqual(await sync.estActive(), false);
  assert.deepStrictEqual(await sync.pousser(), { fait: false });
  assert.deepStrictEqual(await sync.tirer(), { fait: false });
});

test('activer refuse un identifiant qui n’a pas la bonne forme', async () => {
  const depot = creerDepot(magasinMemoire());
  const sync = creerSync({ depot, fetchImpl: fauxServeur() });
  await assert.rejects(() => sync.activer('trop-court'), /invalide/);
  await assert.rejects(() => sync.activer('../../etc/passwd'), /invalide/);
});

test('un appareil pousse, l’autre tire et retrouve le même client', async () => {
  const serveur = fauxServeur();
  const pc = creerDepot(magasinMemoire());
  const telephone = creerDepot(magasinMemoire());
  const syncPc = creerSync({ depot: pc, fetchImpl: serveur });
  const syncTel = creerSync({ depot: telephone, fetchImpl: serveur });

  await syncPc.activer(ID);
  await syncTel.activer(ID);

  await pc.enregistrerEntreprise({ nom: 'KDL TECH', regime_tva: 'franchise' });
  await pc.enregistrerClient({ nom: 'Jean Pierre', telephone: '0690123456' });
  const p = await syncPc.pousser();
  assert.strictEqual(p.fait, true);

  const t = await syncTel.tirer();
  assert.strictEqual(t.fait, true);
  const clients = await telephone.listerClients();
  assert.strictEqual(clients.length, 1);
  assert.strictEqual(clients[0].nom, 'Jean Pierre');
});

test('un tirage qui n’apporte rien de neuf n’écrase pas une saisie locale pas encore poussée', async () => {
  const serveur = fauxServeur();
  const pc = creerDepot(magasinMemoire());
  const telephone = creerDepot(magasinMemoire());
  const syncPc = creerSync({ depot: pc, fetchImpl: serveur });
  const syncTel = creerSync({ depot: telephone, fetchImpl: serveur });
  await syncPc.activer(ID);
  await syncTel.activer(ID);

  await pc.enregistrerClient({ nom: 'Ancien client' });
  await syncPc.pousser();
  await syncTel.tirer();

  // Le téléphone ajoute un client SANS le pousser tout de suite.
  await telephone.enregistrerClient({ nom: 'Nouveau client, saisi sur place' });

  // Un tirage de routine sur le téléphone ne doit rien changer : le serveur
  // n'a rien de plus récent que ce que le téléphone connaît déjà.
  const t = await syncTel.tirer();
  assert.strictEqual(t.fait, false);
  const clients = await telephone.listerClients();
  assert.strictEqual(clients.length, 2, 'le client saisi localement doit rester');
});

test('désactiver oublie l’identifiant : pousser/tirer redeviennent des no-op', async () => {
  const depot = creerDepot(magasinMemoire());
  const sync = creerSync({ depot, fetchImpl: fauxServeur() });
  await sync.activer(ID);
  assert.strictEqual(await sync.estActive(), true);
  await sync.desactiver();
  assert.strictEqual(await sync.estActive(), false);
  assert.deepStrictEqual(await sync.pousser(), { fait: false });
});

test('sans fetch disponible, pousser/tirer échouent silencieusement plutôt que de planter', async () => {
  const depot = creerDepot(magasinMemoire());
  const sync = creerSync({ depot, fetchImpl: null });
  await sync.activer(ID);
  assert.deepStrictEqual(await sync.pousser(), { fait: false });
  assert.deepStrictEqual(await sync.tirer(), { fait: false });
});

test('une erreur de lecture interdit de pousser une copie potentiellement périmée', async () => {
  const depot = creerDepot(magasinMemoire());
  const methodes = [];
  const sync = creerSync({ depot, fetchImpl: async (_, options = {}) => {
    methodes.push(options.method || 'GET');
    return { ok: false, status: 503 };
  } });
  await sync.activer(ID);
  await sync.synchroniser();
  assert.deepStrictEqual(methodes, ['GET']);
});

test('deux appareils modifiés indépendamment conservent leurs données en cas de conflit', async () => {
  const serveur = fauxServeur();
  const pc = creerDepot(magasinMemoire());
  const tel = creerDepot(magasinMemoire());
  const a = creerSync({ depot: pc, fetchImpl: serveur });
  const b = creerSync({ depot: tel, fetchImpl: serveur });
  await a.activer(ID); await b.activer(ID);
  await pc.enregistrerClient({ nom: 'Client initial' });
  await a.synchroniser(); await b.synchroniser();
  await pc.enregistrerClient({ nom: 'Ajout PC' });
  await tel.enregistrerClient({ nom: 'Ajout téléphone hors ligne' });
  await a.synchroniser();
  const resultat = await b.synchroniser();
  assert.ok(resultat.tirage.conflit);
  assert.deepStrictEqual((await tel.listerClients()).map(c => c.nom).sort(),
    ['Ajout téléphone hors ligne', 'Client initial']);
  assert.deepStrictEqual((await pc.listerClients()).map(c => c.nom).sort(), ['Ajout PC', 'Client initial']);
});

test('une restauration conserve les identifiants et les liens entre documents et clients', async () => {
  const depot = creerDepot(magasinMemoire());
  const sauvegarde = await depot.exporter();
  sauvegarde.contenu.clients = [{ id: 17, nom: 'Client lié' }];
  sauvegarde.contenu.documents = [{ id: 42, client_id: 17, avoir_de: 31 }];
  await depot.importer(sauvegarde);
  assert.strictEqual((await depot.listerClients())[0].id, 17);
  assert.strictEqual((await depot.obtenirDocument(42)).client_id, 17);
});

test('une sauvegarde invalide ne vide aucune table avant de signaler son erreur', async () => {
  const depot = creerDepot(magasinMemoire());
  await depot.enregistrerClient({ nom: 'À conserver' });
  const sauvegarde = await depot.exporter();
  sauvegarde.contenu.clients = { invalide: true };
  await assert.rejects(() => depot.importer(sauvegarde));
  assert.strictEqual((await depot.listerClients())[0].nom, 'À conserver');
});

test('un appareil inchangé ne republie pas sa copie à chaque passage', async () => {
  const serveur = fauxServeur();
  let envois = 0;
  const fetchImpl = async (url, options) => {
    if (options.method === 'PUT') envois++;
    return serveur(url, options);
  };
  const depot = creerDepot(magasinMemoire());
  const sync = creerSync({ depot, fetchImpl });
  await sync.activer(ID);
  await depot.enregistrerClient({ nom: 'Client stable' });
  await sync.synchroniser(); await sync.synchroniser(); await sync.synchroniser();
  assert.strictEqual(envois, 1);
});

test('réouvrir le lien d’appairage conserve la référence des modifications locales', async () => {
  const serveur = fauxServeur();
  const depot = creerDepot(magasinMemoire());
  const sync = creerSync({ depot, fetchImpl: serveur });
  await sync.activer(ID); await sync.synchroniser();
  await depot.enregistrerClient({ nom: 'Ajout après appairage' });
  await sync.activer(ID);
  assert.strictEqual((await sync.synchroniser()).poussee.fait, true);
});

test('une saisie enregistrée pendant une lecture distante empêche sa restauration', async () => {
  const serveur = fauxServeur();
  const pc = creerDepot(magasinMemoire());
  const tel = creerDepot(magasinMemoire());
  const a = creerSync({ depot: pc, fetchImpl: serveur });
  await a.activer(ID); await pc.enregistrerClient({ nom: 'Version distante' }); await a.synchroniser();
  const b = creerSync({ depot: tel, fetchImpl: async (url, options) => {
    const resultat = await serveur(url, options);
    await tel.enregistrerClient({ nom: 'Saisie pendant la requête' });
    return resultat;
  } });
  await b.activer(ID);
  const resultat = await b.synchroniser();
  assert.match(resultat.tirage.erreur, /changé/);
  assert.deepStrictEqual((await tel.listerClients()).map(c => c.nom), ['Saisie pendant la requête']);
});

test('un formulaire ouvert diffère la réception sans republier la copie locale', async () => {
  const serveur = fauxServeur();
  const pc = creerDepot(magasinMemoire());
  const tel = creerDepot(magasinMemoire());
  const a = creerSync({ depot: pc, fetchImpl: serveur });
  const b = creerSync({ depot: tel, fetchImpl: serveur, peutImporter: () => false });
  await a.activer(ID); await b.activer(ID);
  await pc.enregistrerClient({ nom: 'À recevoir' }); await a.synchroniser();
  const resultat = await b.synchroniser();
  assert.strictEqual(resultat.tirage.differee, true);
  assert.strictEqual(resultat.poussee.fait, false);
  assert.strictEqual((await tel.listerClients()).length, 0);
});

test('une coupure réseau laisse la copie locale intacte puis la reprise l’envoie', async () => {
  const serveur = fauxServeur();
  let horsLigne = true;
  const depot = creerDepot(magasinMemoire());
  const sync = creerSync({ depot, fetchImpl: (...args) => {
    if (horsLigne) throw new Error('Hors ligne');
    return serveur(...args);
  } });
  await sync.activer(ID); await depot.enregistrerClient({ nom: 'En attente' });
  assert.match((await sync.synchroniser()).tirage.erreur, /Hors ligne/);
  assert.strictEqual((await depot.listerClients()).length, 1);
  horsLigne = false;
  assert.strictEqual((await sync.synchroniser()).poussee.fait, true);
});

test('un serveur ancien est refusé même si aucune sauvegarde ne s’y trouve', async () => {
  let appels = 0;
  const depot = creerDepot(magasinMemoire());
  const sync = creerSync({ depot, fetchImpl: async () => { appels++; return { ok: false, status: 404 }; } });
  await sync.activer(ID);
  assert.match((await sync.synchroniser()).tirage.erreur, /mettre à jour/);
  assert.strictEqual(appels, 1);
});

test('un serveur qui ne répond plus est interrompu après le délai prévu', async () => {
  const depot = creerDepot(magasinMemoire());
  const sync = creerSync({ depot, delaiMs: 10, fetchImpl: (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Timeout', 'AbortError')));
  }) });
  await sync.activer(ID);
  assert.match((await sync.synchroniser()).tirage.erreur, /délai dépassé/);
});

test('un premier appairage de deux copies remplies ne choisit pas arbitrairement un gagnant', async () => {
  const serveur = fauxServeur();
  const pc = creerDepot(magasinMemoire()); const tel = creerDepot(magasinMemoire());
  const a = creerSync({ depot: pc, fetchImpl: serveur }); const b = creerSync({ depot: tel, fetchImpl: serveur });
  await a.activer(ID); await b.activer(ID);
  await pc.enregistrerClient({ nom: 'PC' }); await tel.enregistrerClient({ nom: 'Téléphone' });
  await a.synchroniser();
  assert.strictEqual((await b.synchroniser()).tirage.conflit, true);
  assert.strictEqual((await tel.listerClients())[0].nom, 'Téléphone');
});

test('le worker laisse toutes les requêtes API au réseau, sans consultation du cache', () => {
  const vm = require('node:vm'); const fs = require('node:fs');
  const evenements = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../pwa/sw.js'), 'utf8'), {
    self: { location: { origin: 'https://exemple.test' }, addEventListener: (nom, callback) => { evenements[nom] = callback; } }, URL,
  });
  let intercepte = false;
  evenements.fetch({ request: { method: 'GET', url: 'https://exemple.test/api/facture-sync/test' }, respondWith: () => { intercepte = true; } });
  assert.strictEqual(intercepte, false);
});

test('le téléphone vide appairé en premier ne crée pas une sauvegarde vide sur le serveur', async () => {
  const serveur = fauxServeur();
  const tel = creerDepot(magasinMemoire()); const pc = creerDepot(magasinMemoire());
  const b = creerSync({ depot: tel, fetchImpl: serveur }); const a = creerSync({ depot: pc, fetchImpl: serveur });
  await a.activer(ID); await b.activer(ID);
  assert.strictEqual((await b.synchroniser()).tirage.attente, true);
  await pc.enregistrerClient({ nom: 'Carnet PC' });
  assert.strictEqual((await a.synchroniser()).poussee.fait, true);
  assert.strictEqual((await b.synchroniser()).tirage.fait, true);
});
