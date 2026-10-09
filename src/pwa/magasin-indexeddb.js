'use strict';

/**
 * Le magasin réel de la version installable : IndexedDB.
 *
 * C'est le seul stockage du navigateur qui tienne des milliers d'objets, résiste
 * à la fermeture de l'onglet et fonctionne hors ligne. Son interface, en
 * revanche, date d'avant les promesses — d'où cette enveloppe, qui la ramène à
 * quatre opérations et laisse le reste du logiciel l'ignorer.
 *
 * Ce fichier ne s'exécute que dans un navigateur ; sous Node, les tests
 * utilisent le magasin en mémoire, qui respecte le même contrat.
 */

const MAGASINS = ['recues', 'reglages', 'documents', 'entreprises', 'clients'];

function promesse(requete) {
  return new Promise((tenir, rejeter) => {
    requete.onsuccess = () => tenir(requete.result);
    requete.onerror = () => rejeter(requete.error || new Error('Écriture refusée.'));
  });
}

/**
 * Ouvre la base locale.
 * @param {string} nom nom de la base, un par entreprise si besoin
 * @param {number} version à incrémenter quand la structure change
 */
async function ouvrirMagasin(nom = 'kdl-facture', version = 1) {
  if (typeof indexedDB === 'undefined') {
    throw new Error("Ce navigateur n'autorise pas le stockage local : la navigation privée "
      + 'de certains navigateurs le refuse. Vos factures ne pourraient pas être conservées.');
  }

  const base = await new Promise((tenir, rejeter) => {
    const demande = indexedDB.open(nom, version);
    demande.onupgradeneeded = () => {
      const bd = demande.result;
      for (const magasin of MAGASINS) {
        if (!bd.objectStoreNames.contains(magasin)) {
          bd.createObjectStore(magasin, { keyPath: 'id', autoIncrement: true });
        }
      }
    };
    demande.onsuccess = () => tenir(demande.result);
    demande.onerror = () => rejeter(demande.error || new Error('Base locale inaccessible.'));
    demande.onblocked = () => rejeter(new Error(
      'Une autre fenêtre de KDL Facture est ouverte sur une version différente. '
      + 'Fermez-la puis réessayez.',
    ));
  });

  const transaction = (magasin, mode) => base.transaction(magasin, mode).objectStore(magasin);

  return {
    async tous(magasin) {
      return promesse(transaction(magasin, 'readonly').getAll());
    },
    async ajouter(magasin, objet) {
      const { id, ...reste } = objet;
      return promesse(transaction(magasin, 'readwrite').add(reste));
    },
    async remplacer(magasin, objet) {
      if (objet.id === undefined) throw new Error('Objet sans identifiant.');
      return promesse(transaction(magasin, 'readwrite').put(objet));
    },
    async vider(magasin) {
      return promesse(transaction(magasin, 'readwrite').clear());
    },
    async restaurer(contenu, attendu) {
      const noms = [...new Set([...Object.keys(contenu), ...Object.keys(attendu || {})])];
      if (!noms.length) return;
      await new Promise((resolve, reject) => {
        const tx = base.transaction(noms, 'readwrite');
        let conflit = false;
        tx.oncomplete = resolve;
        tx.onabort = () => reject(conflit
          ? new Error('Les données locales ont changé pendant la synchronisation. Réessayez.')
          : tx.error || new Error('Restauration annulée : données précédentes conservées.'));
        const ecrire = () => {
          for (const [nom, elements] of Object.entries(contenu)) {
            const table = tx.objectStore(nom);
            table.clear();
            for (const element of elements) table.put(element);
          }
        };
        const controles = Object.entries(attendu || {});
        if (!controles.length) { ecrire(); return; }
        let restants = controles.length;
        for (const [nom, elements] of controles) {
          const lecture = tx.objectStore(nom).getAll();
          lecture.onsuccess = () => {
            if (conflit) return;
            if (JSON.stringify(lecture.result) !== JSON.stringify(elements)) {
              conflit = true; tx.abort(); return;
            }
            if (--restants === 0) ecrire();
          };
        }
      });
    },
    fermer() { base.close(); },
  };
}

/**
 * Demande au navigateur de ne pas effacer les données en cas de manque de place.
 * Sans cela, un navigateur qui manque d'espace peut vider le stockage d'un site
 * sans prévenir — inacceptable pour des factures. La demande peut être refusée :
 * on renvoie ce qui a été obtenu, à charge pour l'interface de le dire.
 */
async function demanderConservationDurable() {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.persist) {
    return { durable: false, connu: false };
  }
  const dejaDurable = await navigator.storage.persisted();
  const durable = dejaDurable || await navigator.storage.persist();
  return { durable, connu: true };
}

module.exports = { ouvrirMagasin, demanderConservationDurable, MAGASINS };
