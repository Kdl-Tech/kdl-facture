'use strict';

/**
 * Un lecteur XML minimal, mais portable.
 *
 * Recevoir une facture, c'est d'abord lire du XML. Le navigateur a `DOMParser`,
 * Node ne l'a pas, et aucune bibliothèque ne tourne des deux côtés sans
 * dépendance supplémentaire — or une dépendance de plus sur un logiciel qui
 * manipule des factures, c'est une surface d'attaque de plus.
 *
 * Ce lecteur ne prétend pas être conforme à toute la norme XML : il traite ce
 * qu'un CII ou un UBL contient réellement — des éléments, des attributs, du
 * texte, des espaces de noms, des commentaires et des sections CDATA. Il refuse
 * tout le reste au lieu de deviner : sur une facture, une lecture approximative
 * est pire qu'un refus.
 *
 * Ce qu'il ne fait volontairement pas : les entités personnalisées (`<!ENTITY>`)
 * et les DTD externes. Les ignorer n'est pas une paresse, c'est la protection
 * contre l'attaque classique du XML — une entité qui se réplique ou qui pointe
 * vers un fichier local. Un document qui en contient est rejeté.
 */

const ENTITES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

function decoder(texte) {
  return String(texte).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entier, corps) => {
    if (corps[0] === '#') {
      const code = corps[1] === 'x' || corps[1] === 'X'
        ? parseInt(corps.slice(2), 16)
        : parseInt(corps.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entier;
    }
    const connue = ENTITES[corps];
    return connue === undefined ? entier : connue;
  });
}

function nouvelElement(nomComplet, attributs) {
  const [prefixe, local] = nomComplet.includes(':')
    ? nomComplet.split(':')
    : ['', nomComplet];
  return {
    nom: nomComplet, prefixe, local, attributs, enfants: [], texte: '',
  };
}

function lireAttributs(brut) {
  const attributs = {};
  const motif = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m = motif.exec(brut);
  while (m) {
    const nom = m[1];
    const local = nom.includes(':') ? nom.split(':')[1] : nom;
    attributs[local] = decoder(m[3] !== undefined ? m[3] : m[4]);
    m = motif.exec(brut);
  }
  return attributs;
}

/**
 * Analyse un document et renvoie sa racine.
 * @throws {Error} si le document est malformé, vide, ou porte une DTD.
 */
function analyserXML(source) {
  const texte = String(source || '').replace(/^﻿/, '');
  if (!texte.trim()) throw new Error('Le document XML est vide.');
  if (/<!DOCTYPE/i.test(texte) || /<!ENTITY/i.test(texte)) {
    throw new Error('Le document déclare une DTD ou des entités : refusé par précaution.');
  }

  const pile = [];
  let racine = null;
  let i = 0;

  while (i < texte.length) {
    const debut = texte.indexOf('<', i);
    if (debut === -1) break;

    if (debut > i && pile.length) {
      pile[pile.length - 1].texte += decoder(texte.slice(i, debut));
    }

    if (texte.startsWith('<!--', debut)) {
      const fin = texte.indexOf('-->', debut);
      if (fin === -1) throw new Error('Commentaire XML non refermé.');
      i = fin + 3;
    } else if (texte.startsWith('<![CDATA[', debut)) {
      const fin = texte.indexOf(']]>', debut);
      if (fin === -1) throw new Error('Section CDATA non refermée.');
      if (pile.length) pile[pile.length - 1].texte += texte.slice(debut + 9, fin);
      i = fin + 3;
    } else if (texte.startsWith('<?', debut)) {
      const fin = texte.indexOf('?>', debut);
      if (fin === -1) throw new Error('Instruction de traitement non refermée.');
      i = fin + 2;
    } else {
      const fin = texte.indexOf('>', debut);
      if (fin === -1) throw new Error('Balise non refermée.');
      const contenu = texte.slice(debut + 1, fin);

      if (contenu[0] === '/') {
        const nom = contenu.slice(1).trim();
        const ouvert = pile.pop();
        if (!ouvert) throw new Error(`Fermeture inattendue de « ${nom} ».`);
        if (ouvert.nom !== nom) {
          throw new Error(`La balise « ${ouvert.nom} » est fermée par « ${nom} ».`);
        }
        ouvert.texte = ouvert.texte.trim();
      } else {
        const seule = contenu.endsWith('/');
        const corps = seule ? contenu.slice(0, -1) : contenu;
        const espace = corps.search(/\s/);
        const nomComplet = (espace === -1 ? corps : corps.slice(0, espace)).trim();
        if (!nomComplet) throw new Error('Balise sans nom.');
        const element = nouvelElement(
          nomComplet,
          espace === -1 ? {} : lireAttributs(corps.slice(espace)),
        );
        if (pile.length) pile[pile.length - 1].enfants.push(element);
        else if (racine) throw new Error('Le document porte plusieurs racines.');
        else racine = element;
        if (!seule) pile.push(element);
      }
      i = fin + 1;
    }
  }

  if (pile.length) throw new Error(`La balise « ${pile[pile.length - 1].nom} » n'est jamais fermée.`);
  if (!racine) throw new Error('Aucun élément dans le document.');
  return racine;
}

/**
 * Descend un chemin de noms locaux, séparés par des `/`.
 * Les espaces de noms sont ignorés : `ram:ID` et `cbc:ID` répondent tous deux à
 * `ID`. C'est voulu — CII et UBL nomment les mêmes choses avec des préfixes
 * différents, et c'est le seul point qui les sépare vraiment à la lecture.
 */
function tous(noeud, chemin) {
  if (!noeud) return [];
  const etapes = String(chemin).split('/').filter(Boolean);
  let niveau = [noeud];
  for (const etape of etapes) {
    const suivant = [];
    for (const n of niveau) {
      for (const enfant of n.enfants) {
        if (enfant.local === etape) suivant.push(enfant);
      }
    }
    niveau = suivant;
    if (!niveau.length) return [];
  }
  return niveau;
}

/** Le premier élément trouvé, ou null. */
function trouver(noeud, chemin) {
  return tous(noeud, chemin)[0] || null;
}

/** Le texte du premier élément trouvé, ou ''. */
function valeur(noeud, chemin) {
  const t = trouver(noeud, chemin);
  return t ? t.texte : '';
}

/** Le texte du premier élément trouvé, lu comme un nombre. */
function nombre(noeud, chemin) {
  const brut = valeur(noeud, chemin).replace(',', '.').trim();
  if (!brut) return null;
  const n = Number(brut);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  analyserXML, tous, trouver, valeur, nombre, decoder,
};
