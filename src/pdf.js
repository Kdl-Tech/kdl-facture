'use strict';

/**
 * Le PDF de la facture — et le XML agrafé dedans.
 *
 * C'est le principe de Factur-X : un seul fichier, deux lecteurs. L'humain
 * ouvre le PDF et lit une facture normale ; le logiciel du client va chercher
 * la pièce jointe `factur-x.xml` et récupère les données sans les ressaisir.
 * Rien n'est dupliqué à la main : les deux sortent des mêmes chiffres.
 *
 * Le PDF est produit en PDF/A-3, la variante d'archivage qui autorise
 * justement les fichiers embarqués.
 */

const PDFDocument = require('pdfkit');
const path = require('node:path');
const fs = require('node:fs');

/**
 * Les polices voyagent avec le logiciel.
 *
 * PDFKit, laissé à lui-même, va chercher les métriques des polices standard
 * (Helvetica et consorts) dans des fichiers `.afm` posés à côté de son code.
 * Dans un exécutable autonome, ces fichiers n'existent pas : la génération de
 * PDF échouait en production alors qu'elle passait en développement — le pire
 * des défauts, invisible depuis la machine du développeur.
 *
 * On embarque donc deux polices TrueType et on interdit à PDFKit de charger
 * quoi que ce soit d'autre (`font: null`). Aucun fichier externe, le même rendu
 * sur les trois systèmes, et les accents français correctement dessinés.
 */
const POLICES = { corps: 'DejaVuSans.ttf', gras: 'DejaVuSans-Bold.ttf' };

/**
 * Le profil colorimétrique exigé par PDF/A-3.
 *
 * PDFKit le lit à un chemin fixe, à côté de son propre code. Dans un exécutable
 * autonome, ce fichier n'existe pas et la génération échoue — exactement comme
 * pour les métriques de polices. On le dépose donc là où PDFKit ira le chercher,
 * une seule fois, au premier PDF.
 */
let profilInstalle = false;
function installerProfilCouleur() {
  if (profilInstalle) return;
  profilInstalle = true;
  const attendu = path.join(path.dirname(process.execPath), 'data', 'sRGB_IEC61966_2_1.icc');
  try {
    if (fs.existsSync(attendu)) return;
    const source = path.join(__dirname, 'polices', 'sRGB_IEC61966_2_1.icc');
    const contenu = fs.existsSync(source)
      ? fs.readFileSync(source)
      // eslint-disable-next-line global-require, import/no-unresolved
      : require('./ressources-embarquees').lire('polices/sRGB_IEC61966_2_1.icc');
    if (!contenu) return;
    fs.mkdirSync(path.dirname(attendu), { recursive: true });
    fs.writeFileSync(attendu, contenu);
  } catch {
    // Dossier en lecture seule : le PDF sortira sans marqueur PDF/A, ce qui
    // vaut mieux que pas de facture du tout.
  }
}

/** Le logo : celui de l'entreprise s'il en a un, sinon celui gravé dans le logiciel. */
function lireLogo(chemin) {
  if (chemin && fs.existsSync(chemin)) return fs.readFileSync(chemin);
  const surDisque = path.join(__dirname, 'logo-facture.png');
  if (fs.existsSync(surDisque)) return fs.readFileSync(surDisque);
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    return require('./ressources-embarquees').lire('logo-facture.png');
  } catch {
    return null;
  }
}

function lirePolice(fichier) {
  // En développement, les polices sont sur le disque ; dans l'exécutable, elles
  // sont gravées dans le binaire avec le reste de l'interface.
  const surDisque = path.join(__dirname, 'polices', fichier);
  if (fs.existsSync(surDisque)) return fs.readFileSync(surDisque);
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    return require('./ressources-embarquees').lire(`polices/${fichier}`);
  } catch {
    return null;
  }
}
const { calculerDocument, resteDu } = require('./calculs');
const { genererXML, categorieTva, motifExoneration } = require('./facturx');

const BLEU = '#1F5278';
const ENCRE = '#10161C';
const GRIS = '#5C6670';
const TRAIT = '#C9CFD4';

const eur = (v) => `${Number(v || 0).toFixed(2).replace('.', ',')} €`;
const jour = (iso) => (iso ? String(iso).split('-').reverse().join('/') : '');

const LIBELLES = {
  facture: 'FACTURE',
  avoir: 'AVOIR',
  acompte: "FACTURE D'ACOMPTE",
  devis: 'DEVIS',
};

/**
 * Construit le PDF et renvoie un Buffer.
 * @param {object} donnees { document, entreprise, client, lignes, paiements }
 */
function genererPDF(donnees) {
  return new Promise((resolve, reject) => {
    installerProfilCouleur();
    const { document, entreprise, client, lignes, paiements = [] } = donnees;
    const totaux = calculerDocument(lignes, { acompte: document.acompte });
    const doc = new PDFDocument({
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
    });

    for (const [nom, fichier] of Object.entries(POLICES)) {
      const police = lirePolice(fichier);
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

    dessiner(doc, { document, entreprise, client, lignes, paiements, totaux });

    // Le XML de la facture, agrafé au PDF. Le nom `factur-x.xml` et la relation
    // « Data » ne sont pas décoratifs : c'est ce que cherchent les logiciels
    // comptables du côté du client.
    if (document.type !== 'devis') {
      const xml = genererXML(donnees);
      doc.file(Buffer.from(xml, 'utf-8'), {
        name: 'factur-x.xml',
        type: 'text/xml',
        description: 'Facture électronique Factur-X (profil EN 16931)',
        relationship: 'Data',
      });
    }

    doc.end();
  });
}

function dessiner(doc, { document, entreprise, client, lignes, paiements, totaux }) {
  const G = doc.page.margins.left;
  const D = doc.page.width - doc.page.margins.right;
  const largeur = D - G;

  // — En-tête : logo et émetteur à gauche, nature du document à droite —
  // Le logo de l'entreprise s'il en a un, sinon celui de KDL TECH : le
  // logiciel sert aussi les clients de Karim, et leur facture porte leur nom.
  let decalageTitre = G;
  try {
    const logo = lireLogo(entreprise.logo_path);
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
  doc.fillColor(GRIS).fontSize(8.5).text(
    [`Émise le ${jour(document.date_emission)}`,
     document.date_echeance ? `Échéance : ${jour(document.date_echeance)}` : '',
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
  const categorie = categorieTva(document, entreprise, client);
  const motif = motifExoneration(categorie, entreprise);
  const mentions = [
    motif,
    franchise && String(entreprise.forme_juridique || '').toLowerCase().includes('micro')
      ? 'Dispensé d’immatriculation au registre du commerce et des sociétés (RCS) et au répertoire des métiers (RM).'
      : '',
    entreprise.assurance_pro ? `Assurance professionnelle : ${entreprise.assurance_pro}.` : '',
    document.mode_paiement === 'virement' && entreprise.iban
      ? `Paiement par virement — IBAN ${entreprise.iban}${entreprise.bic ? ` · BIC ${entreprise.bic}` : ''}`
      : `Mode de paiement : ${document.mode_paiement}`,
    `En cas de retard : pénalités au taux de ${Number(entreprise.penalites_taux || 10)} % l'an et indemnité forfaitaire de recouvrement de 40 € (art. L441-10 et D441-5 du code de commerce).`,
    entreprise.escompte,
    entreprise.tva_sur_debits ? "TVA acquittée d'après les débits." : '',
    document.document_lie_numero ? `Se rapporte à la facture ${document.document_lie_numero}.` : '',
    document.note,
  ].filter(Boolean);

  if (y > doc.page.height - 150) { doc.addPage(); y = doc.page.margins.top; }
  doc.moveTo(G, y).lineTo(D, y).lineWidth(0.4).strokeColor(TRAIT).stroke();
  y += 8;
  doc.font('corps').fontSize(7.5).fillColor(GRIS)
    .text(mentions.join('\n'), G, y, { width: largeur, lineGap: 2 });

  // — Pied de page —
  const pied = doc.page.height - 46;
  doc.moveTo(G, pied - 8).lineTo(D, pied - 8).lineWidth(0.4).strokeColor(TRAIT).stroke();
  doc.fontSize(7).fillColor(GRIS).text(
    `${entreprise.nom} · ${entreprise.siret ? `SIRET ${entreprise.siret}` : `SIREN ${entreprise.siren}`}${entreprise.capital ? ` · Capital ${entreprise.capital}` : ''}`,
    G, pied, { width: largeur * 0.6 });
  doc.text('Facture électronique Factur-X — profil EN 16931', G, pied, { width: largeur, align: 'right' });
}

module.exports = { genererPDF };
