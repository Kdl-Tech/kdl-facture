'use strict';

/**
 * Extraction du XML agrafé dans un PDF Factur-X.
 *
 * En pratique, une facture électronique arrive sous forme de PDF : l'humain y
 * voit une facture, le logiciel doit y trouver la pièce jointe. Sans cette
 * extraction, « recevoir une facture » se réduit à la regarder.
 *
 * Deux contraintes ont dicté l'écriture de ce module :
 * — il doit tourner dans un navigateur autant que sous Node, donc aucune
 *   dépendance et aucun module natif : la décompression passe par
 *   `DecompressionStream`, présent des deux côtés ;
 * — il ne doit rien exécuter de ce qu'il lit. On cherche des flux, on les
 *   décompresse, on vérifie que le résultat ressemble à une facture. Rien
 *   d'autre n'est interprété du PDF.
 */

const TAILLE_MAX = 40 * 1024 * 1024; // Un PDF de facture qui dépasse 40 Mo est suspect.

/** Octets → chaîne d'un octet par caractère, pour indexer sans décoder l'UTF-8. */
function versLatin1(octets) {
  let sortie = '';
  const pas = 8192;
  for (let i = 0; i < octets.length; i += pas) {
    sortie += String.fromCharCode(...octets.subarray(i, Math.min(i + pas, octets.length)));
  }
  return sortie;
}

async function inflater(octets, brut) {
  const flux = new DecompressionStream(brut ? 'deflate-raw' : 'deflate');
  const auteur = flux.writable.getWriter();
  // Les erreurs du flux remontent par la lecture ; sans ces `catch`, l'écriture
  // laisse une promesse rejetée derrière elle et le processus s'en plaint.
  auteur.write(octets).catch(() => {});
  auteur.close().catch(() => {});
  const morceaux = [];
  const lecteur = flux.readable.getReader();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await lecteur.read();
    if (done) break;
    morceaux.push(value);
  }
  const total = morceaux.reduce((n, m) => n + m.length, 0);
  const sortie = new Uint8Array(total);
  let position = 0;
  for (const m of morceaux) { sortie.set(m, position); position += m.length; }
  return sortie;
}

async function decompresser(octets, dictionnaire) {
  if (!/\/Fl(ate)?Decode/.test(dictionnaire)) return octets;
  try {
    return await inflater(octets, false);
  } catch {
    // Certains producteurs écrivent du deflate sans en-tête zlib.
    return inflater(octets, true);
  }
}

function ressembleAUneFacture(texte) {
  return /CrossIndustryInvoice|<([a-zA-Z]+:)?Invoice[\s>]|<([a-zA-Z]+:)?CreditNote[\s>]/.test(texte);
}

/**
 * Cherche les fichiers embarqués d'un PDF et rend celui qui est une facture.
 *
 * @param {Uint8Array} octets le PDF entier
 * @returns {Promise<{nom: string, xml: string, tous: string[]}>}
 * @throws {Error} si le PDF ne contient aucune facture lisible.
 */
async function extrairePieceJointe(octets) {
  const donnees = octets instanceof Uint8Array ? octets : new Uint8Array(octets);
  if (donnees.length === 0) throw new Error('Le fichier est vide.');
  if (donnees.length > TAILLE_MAX) throw new Error('Le fichier dépasse la taille admise (40 Mo).');
  const entete = versLatin1(donnees.subarray(0, 5));
  if (entete !== '%PDF-') throw new Error("Ce fichier n'est pas un PDF.");

  const texte = versLatin1(donnees);
  const noms = [...texte.matchAll(/\/U?F\s*\(([^)]{1,255})\)/g)]
    .map((m) => m[1])
    .filter((n) => /\.(xml)$/i.test(n));

  const candidats = [];
  // « endstream » se termine par « stream » : sans cette précaution, la
  // recherche se cale sur la fin d'un flux et lit le suivant de travers.
  // Le test se fait à la main plutôt qu'avec un `(?<!end)`, que les vieux
  // navigateurs ne connaissent pas.
  const motif = /stream\r?\n/g;
  let m = motif.exec(texte);
  while (m) {
    const precede = texte.slice(Math.max(0, m.index - 3), m.index) === 'end';
    if (!precede) {
      const debut = m.index + m[0].length;
      const marque = texte.indexOf('endstream', debut);
      if (marque > debut) {
        // Le saut de ligne qui précède « endstream » n'appartient pas au flux :
        // laissé en place, il fait échouer la décompression sur un octet en trop.
        let fin = marque;
        if (texte[fin - 1] === '\n') fin -= 1;
        if (texte[fin - 1] === '\r') fin -= 1;
        const dictionnaire = texte.slice(Math.max(0, m.index - 600), m.index);
        // Tout PDF/A porte un flux XMP « /Type /Metadata /Subtype /XML » : c'est
        // du XML, mais ce n'est pas une pièce jointe. Le confondre avec une
        // facture ferait dire « pièce jointe illisible » là où il n'y en a pas.
        const embarque = /\/EmbeddedFile|text#2Fxml|text\/xml/.test(dictionnaire)
          && !/\/Type\s*\/Metadata/.test(dictionnaire);
        if (embarque) candidats.push({ debut, fin, dictionnaire });
        motif.lastIndex = marque + 9;
      }
    }
    m = motif.exec(texte);
  }

  if (!candidats.length) {
    throw new Error(
      "Ce PDF ne contient aucun fichier embarqué : ce n'est pas une facture électronique, "
      + "seulement un PDF ordinaire.",
    );
  }

  for (const candidat of candidats) {
    let contenu;
    try {
      // eslint-disable-next-line no-await-in-loop
      contenu = await decompresser(
        donnees.subarray(candidat.debut, candidat.fin),
        candidat.dictionnaire,
      );
    } catch {
      contenu = null;
    }
    if (contenu) {
      const xml = new TextDecoder('utf-8').decode(contenu).replace(/\0+$/, '').trim();
      if (ressembleAUneFacture(xml)) {
        return { nom: noms[0] || 'facture.xml', xml, tous: noms };
      }
    }
  }

  throw new Error(
    'Ce PDF porte une pièce jointe, mais elle ne contient pas de facture lisible '
    + '(ni CII, ni UBL).',
  );
}

module.exports = { extrairePieceJointe, versLatin1 };
