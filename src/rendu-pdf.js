'use strict';

/**
 * Le dessin de la facture — la seule et unique implémentation.
 *
 * Ce module ne connaît ni fichier ni système : il reçoit un document PDFKit déjà
 * ouvert et le remplit. C'est ce qui permet à la version de bureau et à la
 * version installable de produire des factures rigoureusement identiques, au
 * lieu de deux rendus qui divergeraient au fil des retouches.
 *
 * Ce qui dépend de la machine — lire une police, un logo, le profil
 * colorimétrique — est fourni par l'appelant.
 */

const { calculerDocument, resteDu } = require('./calculs');
const { genererXML, categorieTva, motifExoneration } = require('./facturx');

const BLEU = '#1F5278';
const ENCRE = '#10161C';
const GRIS = '#5C6670';
const TRAIT = '#C9CFD4';

const POLICES = { corps: 'DejaVuSans.ttf', gras: 'DejaVuSans-Bold.ttf' };

const eur = (v) => `${Number(v || 0).toFixed(2).replace('.', ',')} €`;
const jour = (iso) => (iso ? String(iso).split('-').reverse().join('/') : '');

const LIBELLES = {
  facture: 'FACTURE',
  avoir: 'AVOIR',
  acompte: "FACTURE D'ACOMPTE",
  devis: 'DEVIS',
};

/**
 * Les réglages du document, communs aux deux plateformes.
 * PDF/A-3b est ce qui autorise la pièce jointe ; le reste est imposé par la norme.
 */
function optionsDocument({ document, entreprise, client }) {
  return {
    size: 'A4',
    margin: 42,
    font: null,
    subset: 'PDF/A-3b',
    pdfVersion: '1.7',
    tagged: true,
    lang: 'fr-FR',
    info: {
      Title: `${LIBELLES[document.type] || 'FACTURE'} ${document.numero || ''}`.trim(),
      Author: entreprise.nom,
      Subject: `Facture électronique Factur-X — ${client.nom}`,
      Keywords: 'facture, Factur-X, EN 16931',
      Creator: 'KDL Facture',
    },
  };
}

/**
 * Donne à PDFKit son profil colorimétrique sans passer par le disque.
 *
 * PDFKit va le chercher dans son propre dossier avec `fs.readFileSync`. Cette
 * lecture n'a lieu qu'à la fermeture du document, et elle échoue partout où le
 * code ne vit pas dans un `node_modules` : exécutable autonome, et surtout
 * navigateur. On remplace la méthode par une version qui écrit le profil déjà
 * en mémoire — le PDF sort identique, sans aucun accès au système de fichiers.
 */
function fournirProfilCouleur(doc, icc) {
  if (typeof doc._addColorOutputIntent !== 'function' || !icc) return;
  doc._addColorOutputIntent = function remplacant() {
    const profil = this.ref({ Length: icc.length, N: 3 });
    profil.write(icc);
    profil.end();
    const intent = this.ref({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      // eslint-disable-next-line no-new-wrappers
      Info: new String('sRGB IEC61966-2.1'),
      // eslint-disable-next-line no-new-wrappers
      OutputConditionIdentifier: new String('sRGB IEC61966-2.1'),
      DestOutputProfile: profil,
    });
    intent.end();
    this._root.data.OutputIntents = [intent];
  };
}

/**
 * Agrafe le XML Factur-X au PDF.
 *
 * 🔴 Le contenu doit être passé en ArrayBuffer et non en Buffer : le bundle
 * navigateur de PDFKit embarque son propre Buffer, `Buffer.isBuffer` y répond
 * faux sur un Buffer de Node, et le code retombe alors sur une lecture disque
 * qui n'existe pas.
 */
function agraferXML(doc, donnees) {
  if (donnees.document.type === 'devis') return null;
  const xml = genererXML(donnees);
  const octets = new TextEncoder().encode(xml);
  doc.file(
    octets.buffer.slice(octets.byteOffset, octets.byteOffset + octets.byteLength),
    {
      name: 'factur-x.xml',
      type: 'text/xml',
      description: 'Facture électronique Factur-X (profil EN 16931)',
      relationship: 'Data',
    },
  );
  return xml;
}

function dessiner(doc, {
  document, entreprise, client, lignes, paiements, totaux, logo,
}) {
  const G = doc.page.margins.left;
  const D = doc.page.width - doc.page.margins.right;
  const largeur = D - G;

  // — En-tête : logo et émetteur à gauche, nature du document à droite —
  // Le logo de l'entreprise s'il en a un, sinon celui de KDL TECH : le
  // logiciel sert aussi les clients de l'éditeur, et leur facture porte leur nom.
  let decalageTitre = G;
  try {
    // Le logo est fourni par l'appelant : le lire est un geste propre à la machine.
    if (logo) {
      doc.image(logo, G, 42, { fit: [40, 40] });
      decalageTitre = G + 50;
    }
  } catch { /* Un logo illisible ne doit pas empêcher de facturer. */ }

  doc.fillColor(BLEU).font('gras').fontSize(16).text(entreprise.nom, decalageTitre, 46);
  doc.fillColor(GRIS).font('corps').fontSize(8.5);
  const identite = [
    entreprise.forme_juridique,
    entreprise.adresse,
    `${entreprise.code_postal} ${entreprise.ville}`.trim(),
    entreprise.siret ? `SIRET ${entreprise.siret}` : `SIREN ${entreprise.siren}`,
    entreprise.tva_intra ? `TVA ${entreprise.tva_intra}` : '',
    entreprise.rcs ? `RCS ${entreprise.rcs}` : '',
    [entreprise.email, entreprise.telephone].filter(Boolean).join(' · '),
  ].filter(Boolean);
  doc.text(identite.join('\n'), decalageTitre, 68, { width: largeur * 0.5 - 50, lineGap: 1.5 });

  const titre = LIBELLES[document.type] || 'FACTURE';
  doc.fillColor(ENCRE).font('gras').fontSize(22)
    .text(titre, D - 220, 46, { width: 220, align: 'right' });
  doc.font('corps').fontSize(10).fillColor(BLEU)
    .text(`N° ${document.numero || '(brouillon)'}`, D - 220, 74, { width: 220, align: 'right' });
  const estDevisEntete = document.type === 'devis';
  const libelleEcheance = estDevisEntete ? 'Valable jusqu\'au' : 'Échéance';
  doc.fillColor(GRIS).fontSize(8.5).text(
    [`${estDevisEntete ? 'Émis' : 'Émise'} le ${jour(document.date_emission)}`,
     document.date_echeance ? `${libelleEcheance} : ${jour(document.date_echeance)}` : '',
     document.date_livraison ? `Livraison : ${jour(document.date_livraison)}` : '',
    ].filter(Boolean).join('\n'),
    D - 220, 92, { width: 220, align: 'right', lineGap: 1.5 });

  let y = Math.max(doc.y, 150) + 6;
  doc.moveTo(G, y).lineTo(D, y).lineWidth(1.5).strokeColor(BLEU).stroke();
  y += 16;

  // — Destinataire —
  doc.fillColor(GRIS).font('gras').fontSize(7.5)
    .text('FACTURÉ À', D - 250, y, { width: 250, align: 'right', characterSpacing: 0.8 });
  doc.fillColor(ENCRE).font('gras').fontSize(10.5)
    .text(client.nom, D - 250, y + 12, { width: 250, align: 'right' });
  doc.font('corps').fontSize(8.5).fillColor(GRIS);
  const dest = [
    client.contact,
    client.adresse,
    `${client.code_postal} ${client.ville}`.trim(),
    client.pays && client.pays !== 'FR' ? client.pays : '',
    client.telephone ? `Tél. ${client.telephone}` : '',
    client.siret ? `SIRET ${client.siret}` : (client.siren ? `SIREN ${client.siren}` : ''),
    client.tva_intra ? `TVA ${client.tva_intra}` : '',
    client.code_service ? `Code service : ${client.code_service}` : '',
  ].filter(Boolean);
  doc.text(dest.join('\n'), D - 250, y + 27, { width: 250, align: 'right', lineGap: 1.5 });

  if (client.livraison_adresse) {
    doc.fillColor(GRIS).font('gras').fontSize(7.5)
      .text('LIVRÉ À', G, y, { characterSpacing: 0.8 });
    doc.font('corps').fontSize(8.5).text(
      [client.livraison_adresse, `${client.livraison_code_postal} ${client.livraison_ville}`.trim()]
        .filter(Boolean).join('\n'),
      G, y + 12, { width: 220, lineGap: 1.5 });
  }
  if (document.reference_commande) {
    doc.fillColor(GRIS).font('corps').fontSize(8.5)
      .text(`Référence commande : ${document.reference_commande}`, G, y + 56, { width: 240 });
  }

  y = doc.y + 22;

  // — Tableau des lignes —
  // En franchise de TVA, la colonne du taux disparaît : afficher « 0 % »
  // partout n'informe personne et laisse croire à un oubli. Les montants
  // s'écrivent alors sans mention « HT », qui n'a plus de sens.
  const franchise = entreprise.regime_tva === 'franchise';
  const colonnes = franchise ? [
    { titre: 'DÉSIGNATION', x: G, w: largeur - 260, align: 'left' },
    { titre: 'QTÉ', x: D - 260, w: 54, align: 'right' },
    { titre: 'PRIX UNITAIRE', x: D - 206, w: 96, align: 'right' },
    { titre: 'TOTAL', x: D - 110, w: 110, align: 'right' },
  ] : [
    { titre: 'DÉSIGNATION', x: G, w: largeur - 300, align: 'left' },
    { titre: 'QTÉ', x: D - 300, w: 44, align: 'right' },
    { titre: 'P.U. HT', x: D - 252, w: 62, align: 'right' },
    { titre: 'TVA', x: D - 186, w: 40, align: 'right' },
    { titre: 'TOTAL HT', x: D - 142, w: 142, align: 'right' },
  ];

  const enTete = (yy) => {
    doc.rect(G, yy, largeur, 17).fill(BLEU);
    doc.fillColor('#FFFFFF').font('gras').fontSize(7.5);
    for (const c of colonnes) {
      doc.text(c.titre, c.x + 4, yy + 5, { width: c.w - 8, align: c.align, characterSpacing: 0.6 });
    }
    return yy + 17;
  };

  y = enTete(y);
  doc.font('corps').fontSize(9);

  for (const [i, l] of totaux.lignes.entries()) {
    const hauteurTexte = doc.heightOfString(l.designation, { width: colonnes[0].w - 8 });
    const h = Math.max(hauteurTexte + 9, 20);

    if (y + h > doc.page.height - 190) {
      doc.addPage();
      y = doc.page.margins.top;
      y = enTete(y);
      doc.font('corps').fontSize(9);
    }
    if (i % 2 === 1) doc.rect(G, y, largeur, h).fill('#F5F7F9');

    doc.fillColor(ENCRE);
    doc.text(l.designation, colonnes[0].x + 4, y + 5, { width: colonnes[0].w - 8 });
    doc.text(`${Number(l.quantite)} ${l.unite || ''}`.trim(), colonnes[1].x + 4, y + 5, { width: colonnes[1].w - 8, align: 'right' });
    doc.text(eur(l.prix_ht), colonnes[2].x + 4, y + 5, { width: colonnes[2].w - 8, align: 'right' });
    if (!franchise) {
      doc.text(`${Number(l.tva_taux)} %`, colonnes[3].x + 4, y + 5, { width: colonnes[3].w - 8, align: 'right' });
    }
    const colTotal = colonnes[colonnes.length - 1];
    doc.font('gras').text(eur(l.montant_ht), colTotal.x + 4, y + 5, { width: colTotal.w - 8, align: 'right' });
    doc.font('corps');

    if (l.remise_pct > 0) {
      doc.fillColor(GRIS).fontSize(7.5)
        .text(`remise ${Number(l.remise_pct)} %`, colonnes[0].x + 4, y + 5 + hauteurTexte, { width: colonnes[0].w - 8 });
      doc.fontSize(9).fillColor(ENCRE);
    }

    y += h;
    doc.moveTo(G, y).lineTo(D, y).lineWidth(0.4).strokeColor(TRAIT).stroke();
  }

  // — Totaux —
  y += 12;
  if (y > doc.page.height - 200) { doc.addPage(); y = doc.page.margins.top; }

  const xTot = D - 230;
  const ligneTotal = (libelle, valeur, gras = false, couleur = ENCRE) => {
    doc.font(gras ? 'gras' : 'corps').fontSize(gras ? 10 : 9).fillColor(couleur);
    doc.text(libelle, xTot, y, { width: 130 });
    doc.text(valeur, xTot + 130, y, { width: 100, align: 'right' });
    y += gras ? 16 : 14;
  };

  if (franchise) {
    ligneTotal('Total', eur(totaux.total_ht), true);
  } else {
    ligneTotal('Total HT', eur(totaux.total_ht));
    for (const v of totaux.ventilation_tva) {
      ligneTotal(`TVA ${Number(v.taux)} % sur ${eur(v.base_ht)}`, eur(v.montant_tva), false, GRIS);
    }
    doc.moveTo(xTot, y).lineTo(D, y).lineWidth(0.6).strokeColor(TRAIT).stroke();
    y += 6;
    ligneTotal('Total TTC', eur(totaux.total_ttc), true);
  }

  if (totaux.acompte > 0) {
    ligneTotal('Acompte déjà versé', `− ${eur(totaux.acompte)}`, false, GRIS);
  }
  const verse = paiements.reduce((s, p) => s + Number(p.montant), 0);
  if (verse > 0) {
    ligneTotal('Déjà réglé', `− ${eur(verse)}`, false, GRIS);
  }

  const du = resteDu(totaux.net_a_payer, paiements);
  doc.rect(xTot, y, 230, 24).fill(BLEU);
  doc.fillColor('#FFFFFF').font('gras').fontSize(11);
  doc.text(du <= 0 ? 'SOLDÉE' : 'NET À PAYER', xTot + 8, y + 7, { width: 120 });
  doc.text(du <= 0 ? eur(0) : eur(du), xTot + 122, y + 7, { width: 100, align: 'right' });
  y += 40;

  // — Mentions légales : ce qui rend la facture opposable —
  // Un devis n'engage pas de paiement : pas de mode de règlement, pas de
  // pénalité de retard à afficher — ce serait une mention fausse.
  const categorie = categorieTva(document, entreprise, client);
  const motif = motifExoneration(categorie, entreprise);
  const estDevisMentions = document.type === 'devis';
  const mentions = [
    motif,
    franchise && String(entreprise.forme_juridique || '').toLowerCase().includes('micro')
      ? 'Dispensé d’immatriculation au registre du commerce et des sociétés (RCS) et au répertoire des métiers (RM).'
      : '',
    entreprise.assurance_pro ? `Assurance professionnelle : ${entreprise.assurance_pro}.` : '',
    estDevisMentions ? '' : (document.mode_paiement === 'virement' && entreprise.iban
      ? `Paiement par virement — IBAN ${entreprise.iban}${entreprise.bic ? ` · BIC ${entreprise.bic}` : ''}`
      : (document.mode_paiement ? `Mode de paiement : ${document.mode_paiement}` : '')),
    estDevisMentions ? ''
      : `En cas de retard : pénalités au taux de ${Number(entreprise.penalites_taux || 10)} % l'an et indemnité forfaitaire de recouvrement de 40 € (art. L441-10 et D441-5 du code de commerce).`,
    estDevisMentions ? '' : entreprise.escompte,
    estDevisMentions ? '' : (entreprise.tva_sur_debits ? "TVA acquittée d'après les débits." : ''),
    estDevisMentions ? '' : (document.document_lie_numero ? `Se rapporte à la facture ${document.document_lie_numero}.` : ''),
    estDevisMentions ? 'Devis établi sous réserve de disponibilité. Bon pour accord daté et signé avant toute intervention facturable.' : '',
    document.note,
  ].filter(Boolean);

  if (y > doc.page.height - 150) { doc.addPage(); y = doc.page.margins.top; }
  doc.moveTo(G, y).lineTo(D, y).lineWidth(0.4).strokeColor(TRAIT).stroke();
  y += 8;
  doc.font('corps').fontSize(7.5).fillColor(GRIS)
    .text(mentions.join('\n'), G, y, { width: largeur, lineGap: 2 });

  // — Pied de page —
  // La ligne de texte doit tenir entièrement au-dessus de la marge basse
  // (page.height - margins.bottom) : au-delà, PDFKit ouvre silencieusement
  // une page suivante pour la faire tenir, laissant une page vide derrière.
  const pied = doc.page.height - doc.page.margins.bottom - 12;
  doc.moveTo(G, pied - 8).lineTo(D, pied - 8).lineWidth(0.4).strokeColor(TRAIT).stroke();
  doc.fontSize(7).fillColor(GRIS).text(
    `${entreprise.nom} · ${entreprise.siret ? `SIRET ${entreprise.siret}` : `SIREN ${entreprise.siren}`}${entreprise.capital ? ` · Capital ${entreprise.capital}` : ''}`,
    G, pied, { width: largeur * 0.6, lineBreak: false });
  doc.text(
    document.type === 'devis' ? 'Devis — sans valeur de facture' : 'Facture électronique Factur-X — profil EN 16931',
    G, pied, { width: largeur, align: 'right', lineBreak: false },
  );
}

module.exports = {
  dessiner, optionsDocument, fournirProfilCouleur, agraferXML,
  POLICES, LIBELLES, calculerDocument,
};
