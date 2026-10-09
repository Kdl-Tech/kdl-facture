'use strict';

/**
 * La fabrication du PDF Factur-X dans le navigateur.
 *
 * C'est le morceau qui rend la version installable vraiment autonome : la
 * facture est produite sur la machine de l'utilisateur, sans serveur, sans
 * envoi, et hors ligne. Le dessin vient de `rendu-pdf.js`, exactement celui de
 * la version de bureau — une facture émise depuis un navigateur et la même
 * facture émise depuis le poste sortent identiques.
 *
 * Deux pièges ont dicté l'écriture de ce module, tous deux invisibles à la
 * lecture du code de PDFKit :
 *
 * 1. Le bundle navigateur embarque son propre `Buffer`. Les octets doivent lui
 *    arriver en `ArrayBuffer` ou en `Uint8Array`, jamais dans un Buffer de Node.
 * 2. PDFKit lit son profil colorimétrique sur le disque au moment de fermer le
 *    document. Dans un navigateur, il n'y a pas de disque : le profil est donc
 *    fourni en mémoire, sans quoi le PDF sort sans marqueur PDF/A — et donc non
 *    conforme, silencieusement.
 */

const {
  dessiner, optionsDocument, fournirProfilCouleur, agraferXML, POLICES, calculerDocument,
} = require('../rendu-pdf');

const RESSOURCES = './ressources/';
const MOTEUR = './pdfkit.standalone.js';

let moteur = null;
const ressources = new Map();

/**
 * Charge PDFKit à la demande.
 *
 * Le moteur pèse quelques mégaoctets : le charger au démarrage ralentirait
 * l'ouverture de tout le monde, y compris de ceux qui ne font que consulter
 * leurs factures reçues. Il n'arrive qu'au moment d'émettre, et le service
 * worker le garde ensuite pour l'usage hors ligne.
 */
async function chargerMoteur() {
  if (moteur) return moteur;
  if (typeof window !== 'undefined' && window.PDFDocument) {
    moteur = window.PDFDocument;
    return moteur;
  }

  await new Promise((tenir, rejeter) => {
    const balise = document.createElement('script');
    balise.src = MOTEUR;
    balise.onload = tenir;
    balise.onerror = () => rejeter(new Error(
      "Le moteur PDF n'a pas pu être chargé. Si vous êtes hors ligne pour la première "
      + 'fois depuis l\'installation, reconnectez-vous une fois : il sera ensuite conservé.',
    ));
    document.head.append(balise);
  });

  moteur = window.PDFDocument;
  if (!moteur) throw new Error('Le moteur PDF est introuvable après chargement.');
  return moteur;
}

async function lireRessource(nom) {
  if (ressources.has(nom)) return ressources.get(nom);
  const reponse = await fetch(RESSOURCES + nom);
  if (!reponse.ok) throw new Error(`Ressource manquante : ${nom}.`);
  const octets = new Uint8Array(await reponse.arrayBuffer());
  ressources.set(nom, octets);
  return octets;
}

/** Le logo de l'entreprise s'il en a chargé un, sinon celui du logiciel. */
async function lireLogo(entreprise) {
  if (entreprise && entreprise.logo_data) {
    // Le logo choisi par l'utilisateur est conservé en base64 dans sa fiche :
    // il doit survivre à une sauvegarde et à une restauration, donc pas de blob.
    const binaire = atob(String(entreprise.logo_data).replace(/^data:[^,]+,/, ''));
    const octets = new Uint8Array(binaire.length);
    for (let i = 0; i < binaire.length; i += 1) octets[i] = binaire.charCodeAt(i);
    return octets;
  }
  try {
    return await lireRessource('logo-facture.png');
  } catch {
    return null; // Une facture sans logo reste une facture valable.
  }
}

/**
 * Produit le PDF d'un document.
 *
 * @param {object} donnees { document, entreprise, client, lignes, paiements }
 * @returns {Promise<Blob>} le PDF, prêt à enregistrer ou à joindre
 */
async function genererPDFNavigateur(donnees) {
  const PDFDocument = await chargerMoteur();
  const {
    document: doc0, entreprise, client, lignes, paiements = [],
  } = donnees;

  const [corps, gras, icc, logo] = await Promise.all([
    lireRessource('DejaVuSans.ttf'),
    lireRessource('DejaVuSans-Bold.ttf'),
    lireRessource('sRGB_IEC61966_2_1.icc').catch(() => null),
    lireLogo(entreprise),
  ]);

  const totaux = calculerDocument(lignes, { acompte: doc0.acompte });
  const pdf = new PDFDocument(optionsDocument(donnees));

  fournirProfilCouleur(pdf, icc);
  pdf.registerFont('corps', corps);
  pdf.registerFont('gras', gras);
  pdf.font('corps');

  const morceaux = [];
  const termine = new Promise((tenir, rejeter) => {
    pdf.on('data', (c) => morceaux.push(c));
    pdf.on('end', () => tenir(new Blob(morceaux, { type: 'application/pdf' })));
    pdf.on('error', rejeter);
  });

  dessiner(pdf, {
    document: doc0, entreprise, client, lignes, paiements, totaux, logo,
  });
  agraferXML(pdf, donnees);
  pdf.end();

  return termine;
}

/** Le PDF en octets, pour l'enregistrer dans la base locale à côté du document. */
async function genererOctets(donnees) {
  const blob = await genererPDFNavigateur(donnees);
  return new Uint8Array(await blob.arrayBuffer());
}

module.exports = { genererPDFNavigateur, genererOctets, chargerMoteur };
