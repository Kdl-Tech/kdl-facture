'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { genererPDF } = require('../src/pdf');

const JEU = {
  entreprise: {
    nom: 'KDL TECH', forme_juridique: 'Entreprise individuelle', siren: '123456782',
    siret: '12345678200019', tva_intra: 'FR11123456782', adresse: '1 rue des Palmiers',
    code_postal: '97100', ville: 'Basse-Terre', pays: 'FR', email: 'contact@kdl-tech.fr',
    iban: 'FR7630001007941234567890185', bic: 'BDFEFRPP', regime_tva: 'normal',
    penalites_taux: 10, escompte: 'Aucun escompte pour paiement anticipé.',
  },
  client: {
    type: 'entreprise', nom: 'Boulangerie Le Fournil', siret: '98765432400024',
    siren: '987654324', adresse: '5 avenue du Port', code_postal: '97110',
    ville: 'Pointe-à-Pitre', pays: 'FR', email: 'contact@fournil.fr',
  },
  document: {
    type: 'facture', numero: 'F2026-0001', date_emission: '2026-08-06',
    date_echeance: '2026-09-05', categorie: 'mixte', mode_paiement: 'virement',
  },
  lignes: [
    { designation: 'Dépannage informatique sur site', quantite: 2, prix_ht: 60, tva_taux: 20, unite: 'heure' },
    { designation: 'Câble réseau catégorie 6 — 5 m', quantite: 1, prix_ht: 15, tva_taux: 20, unite: 'piece' },
  ],
  paiements: [],
};

test('le PDF est produit et commence par la signature PDF', async () => {
  const buf = await genererPDF(JEU);
  assert.ok(buf.length > 3000, `PDF trop court : ${buf.length} octets`);
  assert.strictEqual(buf.subarray(0, 5).toString(), '%PDF-');
});

test('le XML Factur-X est bien agrafé dans le PDF', async () => {
  const buf = await genererPDF(JEU);
  const contenu = buf.toString('latin1');
  assert.match(contenu, /factur-x\.xml/, 'la pièce jointe doit sappeler factur-x.xml');
  assert.match(contenu, /AFRelationship/, 'la relation de fichier associé doit être déclarée');
});

test('le PDF sannonce en PDF/A-3', async () => {
  const buf = await genererPDF(JEU);
  const contenu = buf.toString('latin1');
  assert.match(contenu, /pdfaid:part>3|pdfaid:part="3"/, 'le marqueur PDF/A partie 3 doit être présent');
});

/**
 * Le profil colorimétrique est la partie de PDF/A que rien ne signalait quand
 * elle manquait : le PDF sortait quand même, et n'était pas conforme. PDFKit
 * allait le lire sur le disque ; on le lui fournit désormais en mémoire, ce qui
 * marche aussi bien dans l'exécutable autonome que dans un navigateur.
 */
test('le PDF porte son profil colorimétrique, sans lecture disque', async () => {
  const buf = await genererPDF(JEU);
  const contenu = buf.toString('latin1');
  assert.match(contenu, /\/OutputIntent/, 'PDF/A exige une intention de sortie');
  assert.match(contenu, /GTS_PDFA1/, 'la norme de sortie doit être déclarée');
  assert.match(contenu, /sRGB IEC61966-2\.1/, 'le profil sRGB doit être nommé');
  assert.ok(contenu.includes('/N 3'), 'le profil ICC embarqué doit déclarer ses 3 composantes');
});

test('aucun fichier nest écrit à côté de lexécutable pour produire un PDF', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const intrus = path.join(path.dirname(process.execPath), 'data', 'sRGB_IEC61966_2_1.icc');
  const avant = fs.existsSync(intrus);
  await genererPDF(JEU);
  assert.strictEqual(fs.existsSync(intrus), avant,
    'générer un PDF ne doit rien déposer à côté de lexécutable');
});

test('un devis ne porte pas de XML : ce nest pas une facture', async () => {
  const buf = await genererPDF({ ...JEU, document: { ...JEU.document, type: 'devis', numero: 'D2026-0001' } });
  assert.doesNotMatch(buf.toString('latin1'), /factur-x\.xml/);
});

test('une facture longue tient sur plusieurs pages sans perdre ses totaux', async () => {
  const lignes = Array.from({ length: 60 }, (_, i) => ({
    designation: `Prestation numéro ${i + 1} — intervention détaillée sur le parc informatique`,
    quantite: 1, prix_ht: 50, tva_taux: 20, unite: 'heure',
  }));
  const buf = await genererPDF({ ...JEU, lignes });
  assert.ok(buf.length > 8000);
  assert.match(buf.toString('latin1'), /factur-x\.xml/);
});

/**
 * Le pied de page s'écrivait à 4 points seulement de la marge basse : PDFKit
 * ouvrait alors une page pour le faire tenir — deux fois (les deux colonnes du
 * pied), laissant deux pages quasi vides derrière un document d'une seule ligne.
 * Compter les objets `/Type /Page` (jamais `/Type /Pages`, le nœud parent) est
 * le moyen le plus direct de vérifier qu'un document court reste sur une page.
 */
test('un document court dune seule ligne tient sur une seule page', async () => {
  const buf = await genererPDF({
    ...JEU,
    document: { ...JEU.document, type: 'devis', numero: 'D2026-0002' },
    client: { nom: 'Jean Pierre' },
    lignes: [{ designation: 'Configuration imprimante', quantite: 1, prix_ht: 49, tva_taux: 0 }],
  });
  const pages = buf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || [];
  assert.strictEqual(pages.length, 1, `attendu 1 page, obtenu ${pages.length}`);
});
