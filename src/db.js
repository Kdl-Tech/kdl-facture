'use strict';

/**
 * Base de KDL Facture.
 *
 * Une facture est un acte juridique : une fois émise, elle ne se modifie plus.
 * Le schéma le reflète — les factures émises sont figées, et une erreur se
 * corrige par un avoir, jamais par une réécriture. Les brouillons, eux, vivent
 * librement tant qu'ils n'ont pas de numéro.
 *
 * Multi-entreprises dès le départ : Karim facture pour KDL TECH, et chacun de
 * ses clients qui installe le logiciel facture pour la sienne. Rien n'est
 * codé en dur au nom d'une société.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

/**
 * SQLite, sans dépendance native quand c'est possible.
 *
 * Node embarque SQLite depuis la version 22 (`node:sqlite`). C'est ce qui
 * permet de livrer un exécutable unique pour Linux, Windows et macOS : aucun
 * module à compiler chez celui qui installe. Sur un Node plus ancien, on
 * retombe sur better-sqlite3, avec la même surface d'API.
 */
function moteur() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    return { nom: 'node:sqlite', ouvrir: (c) => adapter(new DatabaseSync(c)) };
  } catch {
    const Database = require('better-sqlite3');
    return { nom: 'better-sqlite3', ouvrir: (c) => new Database(c) };
  }
}

/** node:sqlite ne connaît ni `pragma()` ni `transaction()` : on les ajoute. */
function adapter(db) {
  if (typeof db.pragma !== 'function') {
    db.pragma = (instruction) => db.exec(`PRAGMA ${instruction};`);
  }
  if (typeof db.transaction !== 'function') {
    db.transaction = (fn) => (...args) => {
      db.exec('BEGIN');
      try {
        const r = fn(...args);
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    };
  }
  return db;
}

/** Où vivent les données, selon le système. */
function cheminParDefaut() {
  const base = process.platform === 'win32'
    ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
  return path.join(base, 'kdl-facture', 'facture.db');
}

function ouvrir(cheminBase) {
  const chemin = cheminBase || cheminParDefaut();
  if (chemin !== ':memory:') {
    fs.mkdirSync(path.dirname(chemin), { recursive: true });
  }
  const db = moteur().ouvrir(chemin);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  creerSchema(db);
  migrer(db);
  return db;
}

/**
 * Migration douce des bases existantes.
 *
 * `CREATE TABLE IF NOT EXISTS` ne touche pas une table déjà là : une base
 * ouverte avec une version antérieure garderait ses anciennes colonnes, et le
 * logiciel planterait sur la première écriture. On ajoute donc ce qui manque,
 * sans jamais rien supprimer — les données de facturation ne se perdent pas.
 */
function migrer(db) {
  const AJOUTS = {
    entreprises: {
      seuil_franchise: 'REAL NOT NULL DEFAULT 0',
      tva_taux_defaut: 'REAL NOT NULL DEFAULT 20',
      territoire: "TEXT NOT NULL DEFAULT 'metropole'",
      activite: "TEXT NOT NULL DEFAULT 'services'",
      assurance_pro: "TEXT NOT NULL DEFAULT ''",
      logo_path: "TEXT NOT NULL DEFAULT ''",
    },
  };
  for (const [table, colonnes] of Object.entries(AJOUTS)) {
    let existantes;
    try {
      existantes = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    } catch {
      continue;
    }
    for (const [nom, definition] of Object.entries(colonnes)) {
      if (!existantes.includes(nom)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${nom} ${definition}`);
      }
    }
  }
}

function creerSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS entreprises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  forme_juridique TEXT NOT NULL DEFAULT '',
  siren TEXT NOT NULL,
  siret TEXT NOT NULL DEFAULT '',
  tva_intra TEXT NOT NULL DEFAULT '',
  rcs TEXT NOT NULL DEFAULT '',
  capital TEXT NOT NULL DEFAULT '',
  adresse TEXT NOT NULL DEFAULT '',
  code_postal TEXT NOT NULL DEFAULT '',
  ville TEXT NOT NULL DEFAULT '',
  pays TEXT NOT NULL DEFAULT 'FR',
  email TEXT NOT NULL DEFAULT '',
  telephone TEXT NOT NULL DEFAULT '',
  iban TEXT NOT NULL DEFAULT '',
  bic TEXT NOT NULL DEFAULT '',
  -- Régime de TVA : 'franchise' (art. 293 B du CGI) ou 'normal'.
  -- La franchise est le défaut : c'est le régime d'une entreprise qui démarre,
  -- et forcer quelqu'un à décocher la TVA qu'il ne facture pas est une faute
  -- d'ergonomie autant qu'un risque d'erreur.
  regime_tva TEXT NOT NULL DEFAULT 'franchise',
  -- Suivi du plafond de franchise : montant paramétrable, jamais deviné.
  seuil_franchise REAL NOT NULL DEFAULT 0,
  -- Taux appliqué d'office aux nouvelles lignes quand la TVA s'applique.
  tva_taux_defaut REAL NOT NULL DEFAULT 20,
  -- Territoire fiscal : la TVA n'est pas la même partout en France.
  -- metropole | guadeloupe | martinique | reunion | guyane | mayotte | corse
  territoire TEXT NOT NULL DEFAULT 'metropole',
  -- Activité : sert aux mentions propres aux micro-entrepreneurs.
  activite TEXT NOT NULL DEFAULT 'services',
  assurance_pro TEXT NOT NULL DEFAULT '',
  -- Option pour le paiement de la TVA d'après les débits : mention obligatoire.
  tva_sur_debits INTEGER NOT NULL DEFAULT 0,
  penalites_taux REAL NOT NULL DEFAULT 10.0,
  escompte TEXT NOT NULL DEFAULT 'Aucun escompte pour paiement anticipé.',
  logo_path TEXT NOT NULL DEFAULT '',
  cree_le TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entreprise_id INTEGER NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'entreprise',      -- entreprise | particulier | public
  nom TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  siren TEXT NOT NULL DEFAULT '',
  siret TEXT NOT NULL DEFAULT '',
  tva_intra TEXT NOT NULL DEFAULT '',
  -- Code service exécutant : obligatoire pour le secteur public (Chorus Pro).
  code_service TEXT NOT NULL DEFAULT '',
  numero_engagement TEXT NOT NULL DEFAULT '',
  adresse TEXT NOT NULL DEFAULT '',
  code_postal TEXT NOT NULL DEFAULT '',
  ville TEXT NOT NULL DEFAULT '',
  pays TEXT NOT NULL DEFAULT 'FR',
  email TEXT NOT NULL DEFAULT '',
  telephone TEXT NOT NULL DEFAULT '',
  -- Adresse de livraison : mention devenue obligatoire avec la réforme.
  livraison_adresse TEXT NOT NULL DEFAULT '',
  livraison_code_postal TEXT NOT NULL DEFAULT '',
  livraison_ville TEXT NOT NULL DEFAULT '',
  livraison_pays TEXT NOT NULL DEFAULT '',
  delai_paiement_jours INTEGER NOT NULL DEFAULT 30,
  notes TEXT NOT NULL DEFAULT '',
  actif INTEGER NOT NULL DEFAULT 1,
  cree_le TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entreprise_id INTEGER NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  reference TEXT NOT NULL DEFAULT '',
  designation TEXT NOT NULL,
  nature TEXT NOT NULL DEFAULT 'service',        -- service | bien
  unite TEXT NOT NULL DEFAULT 'heure',
  prix_ht REAL NOT NULL DEFAULT 0,
  tva_taux REAL NOT NULL DEFAULT 0,
  actif INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entreprise_id INTEGER NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  -- devis | facture | avoir | acompte
  type TEXT NOT NULL DEFAULT 'facture',
  numero TEXT,
  statut TEXT NOT NULL DEFAULT 'brouillon',      -- brouillon | emis | envoye | paye | annule
  date_emission TEXT NOT NULL DEFAULT (date('now','localtime')),
  date_echeance TEXT NOT NULL DEFAULT '',
  date_livraison TEXT NOT NULL DEFAULT '',
  -- Catégorie d'opération, exigée par la réforme : biens | services | mixte
  categorie TEXT NOT NULL DEFAULT 'services',
  mode_paiement TEXT NOT NULL DEFAULT 'virement',
  reference_commande TEXT NOT NULL DEFAULT '',
  document_lie_id INTEGER REFERENCES documents(id),
  note TEXT NOT NULL DEFAULT '',
  -- Empreinte du contenu au moment de l'émission : preuve d'inaltérabilité.
  empreinte TEXT NOT NULL DEFAULT '',
  emis_le TEXT,
  cree_le TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (entreprise_id, numero)
);

CREATE TABLE IF NOT EXISTS lignes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 1,
  designation TEXT NOT NULL,
  nature TEXT NOT NULL DEFAULT 'service',
  unite TEXT NOT NULL DEFAULT 'heure',
  quantite REAL NOT NULL DEFAULT 1,
  prix_ht REAL NOT NULL DEFAULT 0,
  remise_pct REAL NOT NULL DEFAULT 0,
  tva_taux REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS paiements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  date TEXT NOT NULL DEFAULT (date('now','localtime')),
  montant REAL NOT NULL,
  moyen TEXT NOT NULL DEFAULT 'virement',
  reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);

-- Journal inaltérable : chaque acte est écrit et jamais repris. C'est ce qui
-- distingue un logiciel de facturation d'un tableur.
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  horodatage TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  entreprise_id INTEGER,
  document_id INTEGER,
  acte TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  empreinte TEXT NOT NULL DEFAULT '',
  empreinte_precedente TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS compteurs (
  entreprise_id INTEGER NOT NULL REFERENCES entreprises(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  annee INTEGER NOT NULL,
  dernier INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entreprise_id, type, annee)
);

CREATE INDEX IF NOT EXISTS idx_documents_client ON documents(client_id);
CREATE INDEX IF NOT EXISTS idx_documents_statut ON documents(entreprise_id, statut);
CREATE INDEX IF NOT EXISTS idx_lignes_document ON lignes(document_id);
CREATE INDEX IF NOT EXISTS idx_paiements_document ON paiements(document_id);
`);
}

module.exports = { ouvrir, creerSchema, migrer, cheminParDefaut, moteur };
