'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { creerDepot, magasinMemoire } = require('../src/pwa/depot');
const { lireFichierRecu } = require('../src/reception');
const { genererXML } = require('../src/facturx');

const FOURNISSEUR = {
  nom: 'Grossiste Antilles', siren: '123456782', siret: '12345678200019',
  tva_intra: 'FR11123456782', adresse: '3 zone artisanale', code_postal: '97122',
  ville: 'Baie-Mahault', pays: 'FR', iban: 'FR7630001007941234567890185', regime_tva: 'normal',
};
const MOI = {
  type: 'entreprise', nom: 'KDL TECH', siren: '987654324', siret: '98765432400024',
  adresse: '1 rue des Palmiers', code_postal: '97100', ville: 'Basse-Terre', pays: 'FR',
};

function xmlFournisseur(document = {}, lignes) {
  return genererXML({
    document: {
      type: 'facture', numero: 'FA-2026-114', date_emission: '2026-08-10',
      date_echeance: '2026-09-09', categorie: 'biens', mode_paiement: 'virement', ...document,
    },
    entreprise: FOURNISSEUR,
    client: MOI,
    lignes: lignes || [
      { designation: 'Cartouches encre', quantite: 4, prix_ht: 25, tva_taux: 8.5, unite: 'piece' },
    ],
  });
}

const recevoir = (xml) => lireFichierRecu(new TextEncoder().encode(xml));

test('une facture reçue est rangée avec son statut et sa trace', async () => {
  const depot = creerDepot(magasinMemoire());
  const r = await depot.ajouterRecue(await recevoir(xmlFournisseur()));

  assert.strictEqual(r.enregistree, true);
  const fiche = await depot.obtenirRecue(r.id);
  assert.strictEqual(fiche.statut, 'recue');
  assert.strictEqual(fiche.facture.numero, 'FA-2026-114');
  assert.strictEqual(fiche.historique.length, 1);
});

test('le doublon est refusé, sauf à le forcer sciemment', async () => {
  const depot = creerDepot(magasinMemoire());
  const xml = xmlFournisseur();
  await depot.ajouterRecue(await recevoir(xml));

  const seconde = await depot.ajouterRecue(await recevoir(xml));
  assert.strictEqual(seconde.enregistree, false);
  assert.strictEqual(seconde.doublon, 'identique');
  assert.strictEqual((await depot.listerRecues()).length, 1);

  const forcee = await depot.ajouterRecue(await recevoir(xml), { forcer: true });
  assert.strictEqual(forcee.enregistree, true);
  assert.strictEqual((await depot.listerRecues()).length, 2);
});

test('les factures se trient par date et se filtrent', async () => {
  const depot = creerDepot(magasinMemoire());
  await depot.ajouterRecue(await recevoir(xmlFournisseur({ numero: 'A', date_emission: '2026-01-05' })));
  await depot.ajouterRecue(await recevoir(xmlFournisseur({ numero: 'B', date_emission: '2026-08-05' })));

  const liste = await depot.listerRecues();
  assert.deepStrictEqual(liste.map((r) => r.facture.numero), ['B', 'A']);
  assert.strictEqual((await depot.listerRecues({ statut: 'recue' })).length, 2);
  assert.strictEqual((await depot.listerRecues({ fournisseur: 'grossiste' })).length, 2);
  assert.strictEqual((await depot.listerRecues({ fournisseur: 'autre' })).length, 0);
});

test('le suivi dune facture se rejoue depuis son historique', async () => {
  const depot = creerDepot(magasinMemoire());
  const r = await depot.ajouterRecue(await recevoir(xmlFournisseur()));

  await depot.changerStatutRecue(r.id, 'approuvee', { par: 'Gérant' });
  await depot.changerStatutRecue(r.id, 'encaissee', { par: 'Gérant' });

  const fiche = await depot.obtenirRecue(r.id);
  assert.strictEqual(fiche.statut, 'encaissee');
  assert.deepStrictEqual(fiche.historique.map((h) => h.statut), ['recue', 'approuvee', 'encaissee']);
  await assert.rejects(() => depot.changerStatutRecue(r.id, 'approuvee'), /définitif/);
});

test('le résumé distingue ce qui attend, ce qui presse et ce qui est douteux', async () => {
  const depot = creerDepot(magasinMemoire());
  const aPayer = await depot.ajouterRecue(await recevoir(xmlFournisseur()));
  await depot.ajouterRecue(await recevoir(xmlFournisseur({
    numero: 'FA-2026-200', date_emission: '2026-06-01', date_echeance: '2026-07-01',
  })));
  await depot.changerStatutRecue(aPayer.id, 'approuvee');

  const resume = await depot.resumeRecues('2026-08-17');
  assert.strictEqual(resume.a_traiter.n, 1);
  assert.strictEqual(resume.a_payer.n, 1);
  assert.strictEqual(resume.a_payer.total, 108.5);
  assert.strictEqual(resume.en_retard.n, 1);
  assert.strictEqual(resume.payees.n, 0);
});

/**
 * Quand les données vivent dans le navigateur, un « vider les données du site »
 * suffit à tout effacer. La sauvegarde doit donc être complète et relisible.
 */
test('une sauvegarde se relit et rétablit tout', async () => {
  const depot = creerDepot(magasinMemoire());
  const r = await depot.ajouterRecue(await recevoir(xmlFournisseur()));
  await depot.changerStatutRecue(r.id, 'approuvee');

  const sauvegarde = await depot.exporter();
  assert.strictEqual(sauvegarde.logiciel, 'KDL Facture');
  assert.strictEqual(sauvegarde.contenu.recues.length, 1);

  const neuf = creerDepot(magasinMemoire());
  const { rétablis } = await neuf.importer(JSON.parse(JSON.stringify(sauvegarde)));
  assert.strictEqual(rétablis, 1);

  const liste = await neuf.listerRecues();
  assert.strictEqual(liste.length, 1);
  assert.strictEqual(liste[0].statut, 'approuvee');
  assert.strictEqual(liste[0].facture.numero, 'FA-2026-114');
});

/**
 * La sauvegarde par défaut ne portait que les factures reçues : un reliquat
 * du tout premier périmètre de l'app, jamais élargi quand l'émission, les
 * clients et l'entreprise sont arrivés. Le bouton « Enregistrer une
 * sauvegarde » de la PWA appelle `exporter()` sans argument — s'il oublie les
 * clients ou les devis, ils sont perdus au premier « vider les données du
 * site », sans que rien ne le signale.
 */
test('la sauvegarde par défaut (sans argument) porte aussi les clients, les devis et l’entreprise', async () => {
  const depot = creerDepot(magasinMemoire());
  await depot.enregistrerEntreprise({ nom: 'KDL TECH', regime_tva: 'franchise' });
  const idClient = await depot.enregistrerClient({ nom: 'Jean Pierre', telephone: '0690123456' });
  await depot.enregistrerBrouillon({
    type: 'devis', client_id: idClient, date_emission: '2026-09-09',
    lignes: [{ designation: 'Configuration imprimante', quantite: 1, prix_ht: 49, tva_taux: 0 }],
  });

  const sauvegarde = await depot.exporter();
  assert.strictEqual(sauvegarde.contenu.entreprises.length, 1);
  assert.strictEqual(sauvegarde.contenu.clients.length, 1);
  assert.strictEqual(sauvegarde.contenu.documents.length, 1);

  const neuf = creerDepot(magasinMemoire());
  await neuf.importer(JSON.parse(JSON.stringify(sauvegarde)));
  assert.strictEqual((await neuf.listerClients()).length, 1);
  assert.strictEqual((await neuf.listerDocuments()).length, 1);
  assert.strictEqual((await neuf.monEntreprise()).nom, 'KDL TECH');
});

test('une restauration remplace tout, elle ne mélange pas deux états', async () => {
  const depot = creerDepot(magasinMemoire());
  await depot.ajouterRecue(await recevoir(xmlFournisseur({ numero: 'ANCIENNE' })));
  const sauvegarde = await depot.exporter();

  await depot.ajouterRecue(await recevoir(xmlFournisseur({ numero: 'PLUS-RECENTE' })));
  assert.strictEqual((await depot.listerRecues()).length, 2);

  await depot.importer(JSON.parse(JSON.stringify(sauvegarde)));
  const apres = await depot.listerRecues();
  assert.strictEqual(apres.length, 1);
  assert.strictEqual(apres[0].facture.numero, 'ANCIENNE');
});

test('un fichier qui nest pas une sauvegarde est refusé', async () => {
  const depot = creerDepot(magasinMemoire());
  await assert.rejects(() => depot.importer({ quelque: 'chose' }), /pas une sauvegarde/);
  await assert.rejects(() => depot.importer(null), /pas une sauvegarde/);
});

/**
 * Relire une sauvegarde plus récente que le logiciel perdrait silencieusement
 * les champs inconnus. Mieux vaut refuser et demander la mise à jour.
 */
test('une sauvegarde venue dune version plus récente est refusée avec la marche à suivre', async () => {
  const depot = creerDepot(magasinMemoire());
  await assert.rejects(
    () => depot.importer({ logiciel: 'KDL Facture', version_donnees: 99, contenu: { recues: [] } }),
    /Mettez KDL Facture à jour/,
  );
});
