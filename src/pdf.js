'use strict';

/**
 * Le PDF de la facture, côté poste — et le XML agrafé dedans.
 *
 * C'est le principe de Factur-X : un seul fichier, deux lecteurs. L'humain
 * ouvre le PDF et lit une facture normale ; le logiciel du client va chercher
 * la pièce jointe `factur-x.xml` et récupère les données sans les ressaisir.
 * Rien n'est dupliqué à la main : les deux sortent des mêmes chiffres.
 *
 * Le dessin lui-même vit dans `rendu-pdf.js`, qui ne connaît ni fichier ni
 * système : la version installable s'en sert telle quelle. Ici on ne fait que
 * fournir ce qui dépend de la machine — les polices, le logo, le profil
 * colorimétrique — et rendre un Buffer.
 */

const PDFDocument = require('pdfkit');
const path = require('node:path');
const fs = require('node:fs');

const {
  dessiner, optionsDocument, fournirProfilCouleur, agraferXML, POLICES, calculerDocument,
} = require('./rendu-pdf');

/**
 * Les ressources voyagent avec le logiciel : sur le disque en développement,
 * gravées dans le binaire pour l'exécutable autonome. Sans elles, pas d'accents
 * dessinés correctement ni de PDF/A conforme.
 */
function lireRessource(chemin) {
  const surDisque = path.join(__dirname, chemin);
  if (fs.existsSync(surDisque)) return fs.readFileSync(surDisque);
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    return require('./ressources-embarquees').lire(chemin);
  } catch {
    return null;
  }
}

let iccCache;
function lireICC() {
  if (iccCache === undefined) iccCache = lireRessource('polices/sRGB_IEC61966_2_1.icc');
  return iccCache;
}

/** Le logo de l'entreprise s'il en a un, sinon celui gravé dans le logiciel. */
function lireLogo(chemin) {
  if (chemin && fs.existsSync(chemin)) return fs.readFileSync(chemin);
  return lireRessource('logo-facture.png');
}

/**
 * Construit le PDF et renvoie un Buffer.
 * @param {object} donnees { document, entreprise, client, lignes, paiements }
 */
function genererPDF(donnees) {
  return new Promise((resolve, reject) => {
    const {
      document, entreprise, client, lignes, paiements = [],
    } = donnees;
    const totaux = calculerDocument(lignes, { acompte: document.acompte });
    const doc = new PDFDocument(optionsDocument(donnees));

    fournirProfilCouleur(doc, lireICC());

    for (const [nom, fichier] of Object.entries(POLICES)) {
      const police = lireRessource(path.join('polices', fichier));
      if (!police) {
        reject(new Error(`Police introuvable : ${fichier}. Le PDF ne peut pas être produit.`));
        return;
      }
      doc.registerFont(nom, police);
    }
    doc.font('corps');

    const morceaux = [];
    doc.on('data', (c) => morceaux.push(c));
    doc.on('end', () => resolve(Buffer.concat(morceaux)));
    doc.on('error', reject);

    dessiner(doc, {
      document,
      entreprise,
      client,
      lignes,
      paiements,
      totaux,
      logo: lireLogo(entreprise.logo_path),
    });

    agraferXML(doc, donnees);
    doc.end();
  });
}

module.exports = { genererPDF };
