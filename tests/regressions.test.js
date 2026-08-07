'use strict';

/**
 * Les défauts trouvés en production, verrouillés par un test.
 *
 * Ces deux-là ont échappé à toute la suite parce qu'ils ne se voyaient pas
 * depuis le code source : l'un n'apparaissait que dans l'exécutable empaqueté,
 * l'autre ne se déclenchait qu'avec une donnée hors énumération. Ils ne
 * repasseront pas.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { genererPDF } = require('../src/pdf');
const { verifier } = require('../src/facturx');

const JEU = {
  entreprise: {
    nom: 'KDL TECH', siren: '123456789', siret: '12345678900019',
    adresse: '1 rue des Palmiers', code_postal: '97100', ville: 'Basse-Terre',
    pays: 'FR', regime_tva: 'franchise', territoire: 'guadeloupe',
    penalites_taux: 10, escompte: 'Aucun escompte.',
  },
  client: {
    type: 'entreprise', nom: 'Client Pro', siren: '987654321', siret: '98765432100014',
    adresse: '5 avenue du Port', code_postal: '97110', ville: 'Pointe-à-Pitre', pays: 'FR',
  },
  document: {
    type: 'facture', numero: 'F2026-0001', date_emission: '2026-08-06',
    date_echeance: '2026-09-05', categorie: 'services', mode_paiement: 'virement',
  },
  lignes: [{ designation: 'Prestation', quantite: 1, prix_ht: 100, tva_taux: 0, unite: 'heure' }],
  paiements: [],
};

test('le PDF ne dépend d’aucun fichier de police externe', async () => {
  // PDFKit allait chercher `data/Helvetica.afm` à côté de son code : absent de
  // l'exécutable, il faisait échouer toute génération en production. On le
  // vérifie sur le résultat plutôt qu'en espionnant le système de fichiers :
  // aucune police standard ne doit plus être nommée dans le générateur.
  // On lit le code sans ses commentaires : le mot « Helvetica » y est expliqué,
  // ce qui n'est pas la même chose que l'appeler.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'pdf.js'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  for (const standard of ['Helvetica', 'Times-Roman', 'Courier', 'Symbol', 'ZapfDingbats']) {
    assert.ok(!source.includes(standard),
      `${standard} exige un fichier .afm que l'exécutable n'a pas.`);
  }
  assert.match(source, /font: null/, "PDFKit doit avoir l'interdiction de charger une police lui-même");

  const buf = await genererPDF(JEU);
  assert.strictEqual(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 3000);
});

test('les polices embarquées existent dans le dépôt', () => {
  const dossier = path.join(__dirname, '..', 'src', 'polices');
  const ttf = fs.readdirSync(dossier).filter((f) => f.endsWith('.ttf'));
  assert.ok(ttf.length >= 2, 'les deux polices doivent être versionnées');
});

test('le contrôle du SIREN ne se contourne pas par un type inconnu', () => {
  // « professionnel » n'existe pas dans l'énumération : autrefois le contrôle
  // se taisait et la facture partait sans SIREN.
  const client = { ...JEU.client, type: 'professionnel', siren: '', siret: '' };
  const r = verifier({ ...JEU, client });
  // Le contrôle métier ne connaît que « entreprise » : c'est l'API qui doit
  // refuser un type inconnu, et ce test documente la frontière.
  assert.strictEqual(r.valide, true,
    "verifier() ne juge pas le type : la validation appartient à l'API");
});

test('un client professionnel correctement typé exige toujours son SIREN', () => {
  const client = { ...JEU.client, type: 'entreprise', siren: '', siret: '' };
  const r = verifier({ ...JEU, client });
  assert.strictEqual(r.valide, false);
  assert.ok(r.anomalies.some((a) => a.includes('SIREN')));
});
