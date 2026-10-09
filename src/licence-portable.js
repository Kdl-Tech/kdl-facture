'use strict';

/**
 * La licence, vérifiable partout — poste comme navigateur.
 *
 * La version de bureau signait ses clés avec un secret partagé : le même secret
 * servait à créer la licence et à la vérifier. Ce choix tenait tant que le code
 * vivait dans un exécutable ; dans un navigateur, il ne tient plus du tout —
 * tout le code y est lisible, donc le secret aussi, donc n'importe qui pourrait
 * fabriquer ses propres clés en trois minutes.
 *
 * La signature est donc asymétrique. La clé privée reste chez KDL TECH et ne
 * sort jamais du poste qui émet les licences ; l'application n'embarque que la
 * clé publique, dont la lecture n'apprend rien à personne.
 *
 * Le reste du principe ne change pas, et c'est le plus important :
 * — aucune activation en ligne, aucun serveur à interroger, rien qui puisse
 *   cesser de fonctionner le jour où une machine s'arrête ;
 * — ce qui rend une facture conforme reste gratuit. On limite le volume et le
 *   confort, jamais la validité juridique de ce qui sort. Un logiciel qui
 *   rançonnerait le respect de la loi ne mérite pas ses clients.
 */

const DECOUVERTE = 'decouverte';
const PRO = 'pro';

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
    reception: true,
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
    reception: true,
  },
};

/**
 * La clé publique qui valide les licences Pro.
 *
 * Elle est publique au sens propre : la publier ne permet pas de forger une
 * licence, seulement d'en vérifier une. Elle est remplacée à la construction
 * par la clé réelle de KDL TECH ; la valeur ci-dessous, vide, fait que toute
 * licence est refusée plutôt qu'acceptée par défaut — un défaut de
 * configuration doit fermer la porte, pas l'ouvrir.
 */
const CLE_PUBLIQUE = typeof __CLE_LICENCE__ === 'string' ? __CLE_LICENCE__ : '';

function base64urlVersOctets(texte) {
  const base64 = String(texte).replace(/-/g, '+').replace(/_/g, '/');
  const complet = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binaire = atob(complet);
  const octets = new Uint8Array(binaire.length);
  for (let i = 0; i < binaire.length; i += 1) octets[i] = binaire.charCodeAt(i);
  return octets;
}

function octetsVersBase64url(octets) {
  let binaire = '';
  for (const o of octets) binaire += String.fromCharCode(o);
  return btoa(binaire).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** L'édition gratuite, celle qui s'applique quand il n'y a pas de licence. */
function editionLibre(motif = '') {
  return {
    edition: DECOUVERTE,
    titulaire: '',
    valide: false,
    refus: motif,
    ...CAPACITES[DECOUVERTE],
  };
}

/**
 * Vérifie une clé de licence et rend l'édition qu'elle ouvre.
 *
 * Une clé illisible, expirée ou mal signée ne fait jamais échouer le logiciel :
 * elle ramène simplement à l'édition Découverte, avec un motif affichable. Un
 * artisan qui a payé et dont la clé expire ne doit pas se retrouver devant un
 * logiciel muet le jour où il facture.
 */
async function verifierLicence(cle, options = {}) {
  const texte = String(cle || '').trim();
  if (!texte) return editionLibre('');

  const [charge, signature] = texte.split('.');
  if (!charge || !signature) return editionLibre('Cette clé de licence est incomplète.');
  // La clé publique est normalement gravée à la construction ; l'option existe
  // pour les tests et pour le poste, qui la lit à côté du logiciel.
  const clePublique = options.clePublique || CLE_PUBLIQUE;
  if (!clePublique) return editionLibre('Ce logiciel ne sait pas vérifier les licences.');

  let contenu;
  try {
    contenu = JSON.parse(new TextDecoder().decode(base64urlVersOctets(charge)));
  } catch {
    return editionLibre('Cette clé de licence est illisible.');
  }

  let authentique = false;
  try {
    const publique = await crypto.subtle.importKey(
      'spki',
      base64urlVersOctets(clePublique),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    authentique = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publique,
      base64urlVersOctets(signature),
      new TextEncoder().encode(charge),
    );
  } catch {
    authentique = false;
  }

  if (!authentique) {
    return editionLibre("Cette clé de licence n'est pas authentique.");
  }

  const jour = options.aujourdhui || new Date().toISOString().slice(0, 10);
  if (contenu.expire_le && contenu.expire_le < jour) {
    return {
      ...editionLibre(`Cette licence a expiré le ${contenu.expire_le.split('-').reverse().join('/')}.`),
      titulaire: contenu.titulaire || '',
      expiree: true,
    };
  }

  const edition = CAPACITES[contenu.edition] ? contenu.edition : DECOUVERTE;
  return {
    edition,
    titulaire: contenu.titulaire || '',
    emise_le: contenu.emise_le || '',
    expire_le: contenu.expire_le || '',
    reference: contenu.reference || '',
    valide: true,
    refus: '',
    ...CAPACITES[edition],
  };
}

/**
 * Ce qu'il reste avant d'atteindre la limite de l'édition.
 *
 * Le quota porte sur les factures **émises** dans l'année civile : un brouillon
 * ne consomme rien, et une facture annulée puis réémise ne compte qu'une fois,
 * puisqu'elle garde son numéro.
 */
function etatQuota(licence, documentsEmis, annee) {
  const an = annee || new Date().getFullYear();
  const emises = documentsEmis.filter((d) => d.statut === 'emis'
    && String(d.date_emission || '').startsWith(String(an))
    && d.type !== 'devis').length;

  const plafond = licence.factures_par_an;
  const illimite = plafond === Infinity || plafond === null;
  return {
    annee: an,
    emises,
    plafond: illimite ? null : plafond,
    restantes: illimite ? null : Math.max(0, plafond - emises),
    atteint: !illimite && emises >= plafond,
    proche: !illimite && plafond - emises <= 3 && emises < plafond,
  };
}

/** Le message à montrer quand le plafond est atteint. Sans culpabiliser. */
function messageQuota(quota) {
  if (quota.plafond === null) return '';
  if (quota.atteint) {
    return `Vous avez émis les ${quota.plafond} factures de l'édition Découverte pour ${quota.annee}. `
      + 'Vos factures restent lisibles et exportables, et la réception continue de fonctionner. '
      + "Pour continuer à émettre, l'édition Pro lève la limite.";
  }
  if (quota.proche) {
    return `Il vous reste ${quota.restantes} facture${quota.restantes > 1 ? 's' : ''} `
      + `sur les ${quota.plafond} de l'édition Découverte pour ${quota.annee}.`;
  }
  return '';
}

module.exports = {
  DECOUVERTE, PRO, CAPACITES, CLE_PUBLIQUE,
  verifierLicence, editionLibre, etatQuota, messageQuota,
  base64urlVersOctets, octetsVersBase64url,
};
