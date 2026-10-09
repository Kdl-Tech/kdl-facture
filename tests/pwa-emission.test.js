'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { creerDepot, magasinMemoire } = require('../src/pwa/depot');

const ENTREPRISE = {
  nom: 'KDL TECH', siren: '123456782', siret: '12345678200019',
  adresse: '1 rue des Palmiers', code_postal: '97100', ville: 'Basse-Terre',
  pays: 'FR', regime_tva: 'franchise', territoire: 'guadeloupe',
  iban: 'FR7630001007941234567890185',
};
const CLIENT = {
  type: 'entreprise', nom: 'Boulangerie Le Fournil', siren: '987654324',
  siret: '98765432400024', adresse: '5 avenue du Port', code_postal: '97110',
  ville: 'Pointe-à-Pitre', pays: 'FR',
};
const LIGNES = [
  { designation: 'Dépannage informatique', quantite: 2, prix_ht: 60, tva_taux: 0, unite: 'heure' },
];

async function preparer() {
  const depot = creerDepot(magasinMemoire());
  await depot.enregistrerEntreprise(ENTREPRISE);
  const clientId = await depot.enregistrerClient(CLIENT);
  return { depot, clientId };
}

async function brouillon(depot, clientId, surcharge = {}) {
  return depot.enregistrerBrouillon({
    type: 'facture',
    client_id: clientId,
    date_emission: '2026-08-17',
    date_echeance: '2026-09-16',
    categorie: 'services',
    mode_paiement: 'virement',
    lignes: LIGNES,
    ...surcharge,
  });
}

test('un brouillon s enregistre sans numéro, puis s émet', async () => {
  const { depot, clientId } = await preparer();
  const id = await brouillon(depot, clientId);

  const avant = await depot.obtenirDocument(id);
  assert.strictEqual(avant.statut, 'brouillon');
  assert.ok(!avant.numero);

  const emis = await depot.emettre(id);
  assert.strictEqual(emis.statut, 'emis');
  assert.strictEqual(emis.numero, 'F2026-0001');
  assert.strictEqual(emis.empreinte.length, 64);
});

test('les numéros se suivent sans trou', async () => {
  const { depot, clientId } = await preparer();
  const numeros = [];
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const id = await brouillon(depot, clientId);
    // eslint-disable-next-line no-await-in-loop
    numeros.push((await depot.emettre(id)).numero);
  }
  assert.deepStrictEqual(numeros, ['F2026-0001', 'F2026-0002', 'F2026-0003']);

  const etat = await depot.etatNumerotation();
  assert.strictEqual(etat.valide, true, etat.trous.join(', '));
});

test('un document émis ne se modifie plus', async () => {
  const { depot, clientId } = await preparer();
  const id = await brouillon(depot, clientId);
  await depot.emettre(id);

  await assert.rejects(
    () => depot.enregistrerBrouillon({ id, type: 'facture', client_id: clientId, lignes: LIGNES }),
    /ne peut plus être modifiée/,
  );
  await assert.rejects(() => depot.emettre(id), /déjà émis/);
});

/**
 * Le cas que l'éditeur avait demandé en V1 : pouvoir revenir en arrière sur la
 * dernière facture, sans jamais laisser de trou dans la suite.
 */
test('la dernière facture émise peut redevenir un brouillon, et son numéro repart', async () => {
  const { depot, clientId } = await preparer();
  const premier = await brouillon(depot, clientId);
  await depot.emettre(premier);
  const second = await brouillon(depot, clientId);
  const emis = await depot.emettre(second);
  assert.strictEqual(emis.numero, 'F2026-0002');

  await depot.annulerEmission(second);
  const revenu = await depot.obtenirDocument(second);
  assert.strictEqual(revenu.statut, 'brouillon');
  assert.strictEqual(revenu.numero, '');

  // Le numéro libéré est réattribué : la suite reste sans trou.
  const troisieme = await depot.emettre(second);
  assert.strictEqual(troisieme.numero, 'F2026-0002');
  assert.strictEqual((await depot.etatNumerotation()).valide, true);
});

test('une facture au milieu de la suite ne s annule pas', async () => {
  const { depot, clientId } = await preparer();
  const premier = await brouillon(depot, clientId);
  await depot.emettre(premier);
  await depot.emettre(await brouillon(depot, clientId));

  await assert.rejects(() => depot.annulerEmission(premier), /trou dans la suite/);
});

test('une facture visée par un avoir ne s annule plus', async () => {
  const { depot, clientId } = await preparer();
  const id = await brouillon(depot, clientId);
  const facture = await depot.emettre(id);

  const avoirId = await depot.creerAvoir(id, { motif: 'Prestation annulée' });
  const avoir = await depot.obtenirDocument(avoirId);
  assert.strictEqual(avoir.type, 'avoir');
  assert.strictEqual(avoir.document_lie_numero, facture.numero);
  assert.strictEqual(avoir.lignes[0].quantite, -2);

  await assert.rejects(() => depot.annulerEmission(id), /avoir vise déjà/);
});

test('un avoir prend sa propre suite de numéros', async () => {
  const { depot, clientId } = await preparer();
  const id = await brouillon(depot, clientId);
  await depot.emettre(id);
  const avoirId = await depot.creerAvoir(id);
  const avoir = await depot.emettre(avoirId);
  assert.strictEqual(avoir.numero, 'A2026-0001');
});

/**
 * Le contrôle d'émission est celui du moteur commun : une facture incomplète ne
 * doit pas partir, ici comme sur le poste.
 */
test('une facture incomplète est refusée à l émission, avec le motif', async () => {
  const { depot } = await preparer();
  const clientSansIdentifiant = await depot.enregistrerClient({
    type: 'entreprise', nom: 'Client sans SIREN', adresse: '1 rue', code_postal: '97100', ville: 'B',
  });
  const id = await brouillon(depot, clientSansIdentifiant, { client_id: clientSansIdentifiant });

  await assert.rejects(() => depot.emettre(id), /SIREN|SIRET/);
});

test('émettre sans avoir renseigné son entreprise est refusé clairement', async () => {
  const depot = creerDepot(magasinMemoire());
  const clientId = await depot.enregistrerClient(CLIENT);
  const id = await brouillon(depot, clientId);
  await assert.rejects(() => depot.emettre(id), /Renseignez d'abord votre entreprise/);
});

/**
 * Une restauration de sauvegarde réattribue de nouveaux identifiants internes.
 * Un compteur tenu à part rendrait alors un numéro déjà pris ; le déduire de la
 * suite elle-même évite cette panne.
 */
test('après restauration d une sauvegarde, la numérotation reprend au bon rang', async () => {
  const { depot, clientId } = await preparer();
  await depot.emettre(await brouillon(depot, clientId));
  await depot.emettre(await brouillon(depot, clientId));
  const sauvegarde = await depot.exporter(['entreprises', 'clients', 'documents']);

  const neuf = creerDepot(magasinMemoire());
  await neuf.importer(JSON.parse(JSON.stringify(sauvegarde)));

  const clients = await neuf.listerClients();
  const id = await neuf.enregistrerBrouillon({
    type: 'facture', client_id: clients[0].id, date_emission: '2026-08-17',
    categorie: 'services', mode_paiement: 'virement', lignes: LIGNES,
  });
  assert.strictEqual((await neuf.emettre(id)).numero, 'F2026-0003');
});
