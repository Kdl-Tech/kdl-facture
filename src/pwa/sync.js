'use strict';

/** Synchronisation personnelle, activée uniquement par appairage.
 * Les sauvegardes restent locales tant que l'appareil n'est pas appairé.
 * Chaque écriture exige la révision serveur lue juste avant (ETag / If-Match).
 * Deux copies modifiées indépendamment provoquent un conflit sans écrasement.
 */
const CLE_ID = 'sync_id';
const CLE_BASE = 'sync_base_empreinte';
const ID_VALIDE = /^[a-f0-9]{64}$/;
const TABLES = ['recues', 'reglages', 'entreprises', 'clients', 'documents'];

function contenuPartage(sauvegarde) {
  const contenu = structuredClone(sauvegarde.contenu);
  contenu.reglages = (contenu.reglages || []).filter(r => !r.nom.startsWith('sync_'));
  return contenu;
}
function canonique(valeur) {
  if (Array.isArray(valeur)) return valeur.map(canonique);
  if (valeur && typeof valeur === 'object') return Object.fromEntries(
    Object.keys(valeur).sort().map(k => [k, canonique(valeur[k])]),
  );
  return valeur;
}
async function empreinte(contenu) {
  const normalise = structuredClone(contenu);
  normalise.reglages = normalise.reglages.map(({ id, ...r }) => r).sort((a, b) => a.nom.localeCompare(b.nom));
  const octets = new TextEncoder().encode(JSON.stringify(canonique(normalise)));
  const brut = await crypto.subtle.digest('SHA-256', octets);
  return Array.from(new Uint8Array(brut), b => b.toString(16).padStart(2, '0')).join('');
}
const conflit = () => ({ fait: false, conflit: true,
  erreur: 'Les deux appareils ont des modifications différentes. Aucune donnée écrasée. Exportez une sauvegarde sur chacun avant de choisir la copie à conserver.' });

function creerSync({ depot, base = '/api/facture-sync', fetchImpl, delaiMs = 12000,
  peutImporter = () => true }) {
  const appelerFetch = fetchImpl !== undefined ? fetchImpl : (typeof fetch === 'function' ? fetch : null);
  let file = Promise.resolve();
  const serialiser = action => {
    const resultat = file.then(() => globalThis.navigator?.locks
      ? navigator.locks.request('kdl-facture-sync', action) : action());
    file = resultat.catch(() => {});
    return resultat;
  };
  const idActuel = async () => (await depot.lireReglage(CLE_ID)) || '';
  const estActive = async () => ID_VALIDE.test(await idActuel());
  async function activer(nouvelId) {
    const propre = String(nouvelId || '').trim().toLowerCase();
    if (!ID_VALIDE.test(propre)) throw new Error('Identifiant de synchro invalide.');
    if (await idActuel() === propre) return;
    if (await estActive()) throw new Error('Désactivez la synchronisation actuelle avant de changer d’appairage.');
    await depot.ecrireReglage(CLE_ID, propre);
    await depot.ecrireReglage(CLE_BASE, '');
  }
  async function desactiver() {
    await depot.ecrireReglage(CLE_ID, '');
    await depot.ecrireReglage(CLE_BASE, '');
  }
  async function requete(id, options = {}) {
    const controleur = new AbortController();
    const timer = setTimeout(() => controleur.abort(), delaiMs);
    try {
      const reponse = await appelerFetch(`${base}/${id}`, {
        ...options, cache: 'no-store', signal: controleur.signal,
        headers: { ...options.headers, 'X-KDL-Sync-Protocol': '2' },
      });
      // Lire le corps sous le même délai : les en-têtes seuls ne suffisent pas.
      const donnees = reponse.ok && (!options.method || options.method === 'GET')
        ? await reponse.json() : null;
      return { reponse, donnees };
    } finally { clearTimeout(timer); }
  }
  async function executer(envoi) {
    let tirage = { fait: false };
    const finir = poussee => ({ tirage, poussee: poussee || { fait: false } });
    try {
      const id = await idActuel();
      if (!ID_VALIDE.test(id) || !appelerFetch) return finir();
      const localAvant = await depot.exporter();
      const local = contenuPartage(localAvant);
      const hashLocal = await empreinte(local);
      const baseConnue = await depot.lireReglage(CLE_BASE);
      const { reponse, donnees: distante } = await requete(id);
      if (await idActuel() !== id) return finir();
      if ((reponse.ok || reponse.status === 404) && reponse.headers?.get('x-kdl-sync-protocol') !== '2') {
        throw new Error('Serveur de synchronisation à mettre à jour avant tout échange.');
      }
      if (reponse.status === 404 && TABLES.every(t => local[t].length === 0)) {
        tirage = { fait: false, attente: true }; return finir();
      }
      let revision = null;
      if (reponse.status !== 404) {
        if (!reponse.ok) { tirage = { fait: false, erreur: `HTTP ${reponse.status}` }; return finir(); }
        revision = reponse.headers?.get('etag');
        if (!revision) throw new Error('Serveur de synchronisation à mettre à jour avant tout échange.');
        if (!distante || distante.logiciel !== 'KDL Facture' || distante.version_donnees !== 1
          || !TABLES.every(t => Array.isArray(distante.contenu?.[t]))) {
          throw new Error('Sauvegarde distante invalide ou incompatible. Aucune donnée remplacée.');
        }
        const partage = contenuPartage(distante);
        const hashDistant = await empreinte(partage);
        if (hashDistant === hashLocal) {
          await depot.ecrireReglage(CLE_BASE, hashLocal);
          tirage = { fait: false, dejaAJour: true };
          return finir();
        }
        if (hashDistant !== baseConnue) {
          const localVide = TABLES.filter(t => t !== 'reglages').every(t => local[t].length === 0)
            && local.reglages.every(r => partage.reglages.some(d => d.nom === r.nom
              && JSON.stringify(d.valeur) === JSON.stringify(r.valeur)));
          if ((baseConnue && hashLocal !== baseConnue) || (!baseConnue && !localVide)) {
            tirage = conflit(); return finir();
          }
          if (!peutImporter()) { tirage = { fait: false, differee: true }; return finir(); }
          // Les réglages d'appairage restent propres à l'appareil.
          const reglages = partage.reglages;
          let prochain = Math.max(0, ...reglages.map(r => r.id)) + 1;
          for (const r of localAvant.contenu.reglages.filter(r => r.nom.startsWith('sync_'))) {
            reglages.push({ ...r, id: prochain++ });
          }
          const { rétablis } = await depot.importer({ ...distante, contenu: partage },
            { attendu: localAvant.contenu });
          await depot.ecrireReglage(CLE_BASE, hashDistant);
          tirage = { fait: true, rétablis };
          return finir(); // Une lecture ne crée jamais une nouvelle version serveur.
        }
        tirage = { fait: false, dejaAJour: true };
      }
      if (!envoi) return finir();
      const sauvegarde = await depot.exporter();
      sauvegarde.contenu = contenuPartage(sauvegarde);
      const hashEnvoye = await empreinte(sauvegarde.contenu);
      if (await idActuel() !== id) return finir();
      const { reponse: put } = await requete(id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json',
          ...(revision ? { 'If-Match': revision } : { 'If-None-Match': '*' }) },
        body: JSON.stringify(sauvegarde),
      });
      if (put.status === 412) return finir(conflit());
      if (!put.ok) return finir({ fait: false, erreur: `HTTP ${put.status}` });
      if (await idActuel() === id) await depot.ecrireReglage(CLE_BASE, hashEnvoye);
      return finir({ fait: true });
    } catch (erreur) {
      tirage = { fait: false, erreur: erreur.name === 'AbortError'
        ? 'Synchronisation indisponible : délai dépassé. Données conservées sur cet appareil.' : erreur.message };
      return finir();
    }
  }
  return { idActuel, estActive,
    activer: id => serialiser(() => activer(id)), desactiver: () => serialiser(desactiver),
    tirer: () => serialiser(async () => (await executer(false)).tirage),
    pousser: () => serialiser(async () => {
      const r = await executer(true);
      return r.tirage.erreur ? r.tirage : r.poussee;
    }),
    synchroniser: () => serialiser(() => executer(true)),
  };
}
module.exports = { creerSync };
