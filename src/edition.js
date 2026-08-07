'use strict';

/**
 * Deux éditions : Découverte et Pro.
 *
 * Le principe retenu : **ce qui rend la facture conforme reste gratuit**. Une
 * TPE ne doit pas payer pour respecter la loi, et un logiciel qui rançonnerait
 * la conformité se ferait détester. On limite le volume et le confort, jamais
 * la validité juridique de ce qui sort.
 *
 * Édition Découverte, gratuite et sans inscription :
 *   - 15 factures par année civile,
 *   - un seul client au catalogue... non : autant de clients qu'on veut, mais
 *     le catalogue de prestations est réservé au Pro,
 *   - PDF Factur-X complet, conforme, sans filigrane ni mention publicitaire,
 *   - une seule entreprise.
 *
 * Édition Pro :
 *   - factures illimitées,
 *   - catalogue de prestations, devis, acomptes,
 *   - export comptable, suivi du plafond de franchise, relances,
 *   - plusieurs entreprises dans la même base (utile à un comptable ou à
 *     quelqu'un qui gère la facturation de plusieurs structures).
 *
 * La licence est un fichier posé à côté des données. Aucun appel réseau, aucune
 * activation en ligne : le logiciel doit fonctionner sur une machine sans
 * Internet, et personne ne doit dépendre d'un serveur qui pourrait disparaître.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const DECOUVERTE = 'decouverte';
const PRO = 'pro';

/** Ce que chaque édition autorise. */
const CAPACITES = {
  [DECOUVERTE]: {
    nom: 'Découverte',
    factures_par_an: 15,
    entreprises: 1,
    catalogue: false,
    devis: false,
    acomptes: false,
    export_comptable: false,
    suivi_plafond: false,
    // La conformité n'est jamais bridée : c'est le principe.
    facturx: true,
    journal: true,
    avoirs: true,
  },
  [PRO]: {
    nom: 'Pro',
    factures_par_an: Infinity,
    entreprises: Infinity,
    catalogue: true,
    devis: true,
    acomptes: true,
    export_comptable: true,
    suivi_plafond: true,
    facturx: true,
    journal: true,
    avoirs: true,
  },
};

/**
 * Le secret qui signe les licences.
 *
 * Il est dans le binaire : quelqu'un de déterminé le trouvera. Ce n'est pas un
 * système anticopie — c'en serait un mauvais — mais une barrière honnête, qui
 * empêche de fabriquer une clé au hasard sans empêcher un client légitime de
 * réinstaller son logiciel.
 */
const SEL = 'KDL-FACTURE-2026';

/** Fabrique une clé de licence pour un titulaire donné. */
function creerCle(titulaire, edition = PRO) {
  const base = `${edition}|${String(titulaire || '').trim().toLowerCase()}`;
  const signature = crypto.createHmac('sha256', SEL).update(base).digest('hex')
    .slice(0, 20).toUpperCase();
  return `${edition === PRO ? 'PRO' : 'DEC'}-${signature.match(/.{1,5}/g).join('-')}`;
}

/** Vérifie qu'une clé correspond bien à son titulaire. */
function cleValide(cle, titulaire) {
  if (!cle || !titulaire) return false;
  const propre = String(cle).trim().toUpperCase();
  return propre === creerCle(titulaire, PRO) || propre === creerCle(titulaire, DECOUVERTE);
}

function cheminLicence(base) {
  return path.join(path.dirname(base || ''), 'licence.json');
}

/** Lit la licence posée à côté des données. Sans elle, édition Découverte. */
function lireLicence(cheminBase) {
  try {
    const fichier = cheminLicence(cheminBase);
    if (!fs.existsSync(fichier)) return { edition: DECOUVERTE };
    const contenu = JSON.parse(fs.readFileSync(fichier, 'utf-8'));
    if (!cleValide(contenu.cle, contenu.titulaire)) {
      return { edition: DECOUVERTE, refus: 'Clé de licence invalide.' };
    }
    return { edition: PRO, titulaire: contenu.titulaire, cle: contenu.cle };
  } catch {
    return { edition: DECOUVERTE, refus: 'Fichier de licence illisible.' };
  }
}

/** Enregistre une licence après l'avoir vérifiée. */
function poserLicence(cheminBase, titulaire, cle) {
  if (!cleValide(cle, titulaire)) {
    return { ok: false, message: "Cette clé ne correspond pas à ce titulaire." };
  }
  const fichier = cheminLicence(cheminBase);
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  fs.writeFileSync(fichier, JSON.stringify({ titulaire, cle, pose_le: new Date().toISOString() }, null, 2));
  return { ok: true, edition: PRO, titulaire };
}

function retirerLicence(cheminBase) {
  const fichier = cheminLicence(cheminBase);
  if (fs.existsSync(fichier)) fs.rmSync(fichier);
  return { ok: true, edition: DECOUVERTE };
}

/** Les capacités de l'édition en cours. */
function capacites(licence) {
  return CAPACITES[licence && licence.edition === PRO ? PRO : DECOUVERTE];
}

module.exports = {
  DECOUVERTE, PRO, CAPACITES, capacites,
  creerCle, cleValide, lireLicence, poserLicence, retirerLicence, cheminLicence,
};
