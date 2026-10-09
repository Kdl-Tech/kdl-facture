'use strict';

/**
 * Point d'entrée de la réception : un fichier entre, une facture contrôlée sort.
 *
 * L'utilisateur ne doit jamais avoir à savoir s'il tient un PDF Factur-X, un
 * CII nu ou un UBL Peppol — il dépose ce qu'il a reçu par courriel, et le
 * logiciel se débrouille. C'est tout l'objet de ce module : reconnaître le
 * format, lire, contrôler, et rendre un verdict en français.
 */

const { extrairePieceJointe } = require('./pdf-piece-jointe');
const { lireCII } = require('./cii');
const { lireUBL } = require('./ubl');
const { controler, empreinte, cleMetier } = require('./controles');

const STATUTS = {
  recue: 'Reçue',
  approuvee: 'Approuvée',
  rejetee: 'Rejetée',
  en_paiement: 'Mise en paiement',
  encaissee: 'Encaissée',
};

function estPDF(octets) {
  return octets.length > 4 && octets[0] === 0x25 && octets[1] === 0x50
    && octets[2] === 0x44 && octets[3] === 0x46;
}

/** Reconnaît le format d'un XML sans le lire entièrement. */
function formatDuXML(texte) {
  const debut = texte.slice(0, 4000);
  if (/CrossIndustryInvoice/.test(debut)) return 'CII';
  if (/<([a-zA-Z]+:)?(Invoice|CreditNote)[\s>]/.test(debut)) return 'UBL';
  return null;
}

/**
 * Lit un fichier reçu, quel que soit son format.
 *
 * @param {Uint8Array|string} fichier le contenu reçu
 * @param {{nom?: string}} [contexte] le nom d'origine, pour les messages
 * @returns {Promise<object>} la facture, son contrôle et ses empreintes
 */
async function lireFichierRecu(fichier, contexte = {}) {
  const octets = typeof fichier === 'string' ? new TextEncoder().encode(fichier) : fichier;
  if (!octets || !octets.length) throw new Error('Le fichier est vide.');

  let xml;
  let source;
  if (estPDF(octets)) {
    const piece = await extrairePieceJointe(octets);
    xml = piece.xml;
    source = `PDF (pièce jointe « ${piece.nom} »)`;
  } else {
    xml = new TextDecoder('utf-8').decode(octets).replace(/^﻿/, '').trim();
    source = 'XML';
  }

  const format = formatDuXML(xml);
  if (!format) {
    throw new Error("Le contenu n'est ni un CII (Factur-X) ni un UBL : "
      + "ce fichier n'est pas une facture électronique.");
  }

  const facture = format === 'CII' ? lireCII(xml) : lireUBL(xml);
  const controle = controler(facture);

  return {
    fichier: contexte.nom || '',
    source,
    format,
    xml,
    facture,
    controle,
    empreinte_fichier: await empreinte(octets),
    empreinte_xml: await empreinte(xml),
    cle_metier: cleMetier(facture),
    statut: 'recue',
  };
}

/**
 * Repère un doublon parmi les factures déjà reçues.
 *
 * Deux niveaux, parce qu'ils ne se traitent pas pareil : un fichier strictement
 * identique est un renvoi sans conséquence ; un même numéro du même émetteur
 * avec un contenu différent est un cas à regarder de près — c'est là que se
 * logent les factures modifiées après coup.
 */
function chercherDoublon(recue, dejaRecues) {
  for (const ancienne of dejaRecues || []) {
    if (ancienne.empreinte_fichier === recue.empreinte_fichier) {
      return { niveau: 'identique', ancienne, message: 'Ce fichier a déjà été reçu à l\'identique.' };
    }
  }
  for (const ancienne of dejaRecues || []) {
    if (ancienne.cle_metier === recue.cle_metier) {
      const memeMontant = ancienne.facture.totaux.net_a_payer === recue.facture.totaux.net_a_payer;
      return {
        niveau: memeMontant ? 'renvoi' : 'divergent',
        ancienne,
        message: memeMontant
          ? 'Cette facture a déjà été reçue : même émetteur, même numéro, même montant.'
          : `Attention : la facture ${recue.facture.numero} a déjà été reçue avec un montant `
            + `différent (${ancienne.facture.totaux.net_a_payer} € puis `
            + `${recue.facture.totaux.net_a_payer} €).`,
      };
    }
  }
  return null;
}

module.exports = {
  lireFichierRecu, chercherDoublon, formatDuXML, STATUTS,
};
