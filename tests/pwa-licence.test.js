'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { creerDepot, magasinMemoire } = require('../src/pwa/depot');

const b64url = (octets) => Buffer.from(octets).toString('base64url');

async function atelier() {
  const paire = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const clePublique = b64url(await crypto.subtle.exportKey('spki', paire.publicKey));
  const signer = async (contenu) => {
    const charge = b64url(new TextEncoder().encode(JSON.stringify(contenu)));
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, paire.privateKey, new TextEncoder().encode(charge),
    );
    return `${charge}.${b64url(signature)}`;
  };
  return { clePublique, signer };
}

const ENTREPRISE = {
  nom: 'KDL TECH', siren: '123456782', siret: '12345678200019',
  adresse: '1 rue des Palmiers', code_postal: '97100', ville: 'Basse-Terre',
  pays: 'FR', regime_tva: 'franchise', territoire: 'guadeloupe',
};
const CLIENT = {
  type: 'entreprise', nom: 'Boulangerie Le Fournil', siren: '987654324',
  siret: '98765432400024', adresse: '5 avenue du Port', code_postal: '97110',
  ville: 'Pointe-à-Pitre', pays: 'FR',
};

async function preparer(config = {}) {
  const depot = creerDepot(magasinMemoire(), config);
  await depot.enregistrerEntreprise(ENTREPRISE);
  const clientId = await depot.enregistrerClient(CLIENT);
  return { depot, clientId };
}

async function emettreUne(depot, clientId, jour) {
  const id = await depot.enregistrerBrouillon({
    type: 'facture',
    client_id: clientId,
    date_emission: `2026-03-${String(jour).padStart(2, '0')}`,
    categorie: 'services',
    mode_paiement: 'virement',
    lignes: [{ designation: 'Dépannage', quantite: 1, prix_ht: 60, tva_taux: 0, unite: 'heure' }],
  });
  return depot.emettre(id);
}

test('sans licence, le logiciel démarre en édition Découverte', async () => {
  const { depot } = await preparer();
  const licence = await depot.licence();
  assert.strictEqual(licence.edition, 'decouverte');
  assert.strictEqual((await depot.quota(2026)).plafond, 15);
});

test('une clé valable enregistre l édition Pro et lève le plafond', async () => {
  const { clePublique, signer } = await atelier();
  const { depot } = await preparer({ clePublique, aujourdhui: '2026-08-17' });
  const cle = await signer({
    edition: 'pro', titulaire: 'KDL TECH', emise_le: '2026-08-17', expire_le: '2027-08-17',
  });

  const verdict = await depot.enregistrerLicence(cle);
  assert.strictEqual(verdict.edition, 'pro');

  const relue = await depot.licence();
  assert.strictEqual(relue.edition, 'pro');
  assert.strictEqual(relue.titulaire, 'KDL TECH');
  assert.strictEqual((await depot.quota(2026)).plafond, null);
});

/**
 * Une clé refusée ne doit pas être conservée : sinon l'utilisateur croit avoir
 * activé son logiciel, et découvre la vérité des semaines plus tard.
 */
test('une clé refusée n est pas enregistrée, et le motif est donné', async () => {
  const { depot } = await preparer();
  const vrai = await atelier();
  const faussaire = await atelier();
  const fausse = await faussaire.signer({ edition: 'pro', titulaire: 'Pirate' });

  await assert.rejects(
    () => depot.enregistrerLicence(fausse, { clePublique: vrai.clePublique }),
    /n'est pas authentique/,
  );
  assert.strictEqual((await depot.licence()).edition, 'decouverte');
});

test('le quota se remplit au fil des émissions', async () => {
  const { depot, clientId } = await preparer();
  for (let i = 1; i <= 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await emettreUne(depot, clientId, i);
  }
  const q = await depot.quota(2026);
  assert.strictEqual(q.emises, 3);
  assert.strictEqual(q.restantes, 12);
});

/**
 * Le moment délicat : le plafond atteint. L'émission s'arrête, mais le reste
 * doit continuer — sans quoi le logiciel prendrait les données de l'utilisateur
 * en otage.
 */
test('au plafond, l émission s arrête mais tout le reste continue', async () => {
  const { depot, clientId } = await preparer();
  for (let i = 1; i <= 15; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await emettreUne(depot, clientId, i);
  }

  const id = await depot.enregistrerBrouillon({
    type: 'facture',
    client_id: clientId,
    date_emission: '2026-03-16',
    categorie: 'services',
    mode_paiement: 'virement',
    lignes: [{ designation: 'Dépannage', quantite: 1, prix_ht: 60, tva_taux: 0, unite: 'heure' }],
  });

  await assert.rejects(() => depot.emettre(id), /édition Découverte permet 15 factures/);

  // Ce qui doit continuer de fonctionner malgré le plafond :
  const documents = await depot.listerDocuments();
  assert.strictEqual(documents.filter((d) => d.statut === 'emis').length, 15,
    'les factures déjà émises restent consultables');
  const sauvegarde = await depot.exporter(['documents', 'entreprises', 'clients']);
  assert.strictEqual(sauvegarde.contenu.documents.length, 16, 'la sauvegarde reste complète');
  assert.ok(await depot.enregistrerBrouillon({
    type: 'facture', client_id: clientId, date_emission: '2026-03-17', lignes: [],
  }), 'préparer un brouillon reste possible');
});

test('une licence Pro enregistrée débloque l émission au-delà du plafond', async () => {
  const { clePublique, signer } = await atelier();
  const { depot, clientId } = await preparer({ clePublique, aujourdhui: '2026-08-17' });
  for (let i = 1; i <= 15; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await emettreUne(depot, clientId, i);
  }
  await depot.enregistrerLicence(
    await signer({ edition: 'pro', titulaire: 'KDL TECH', expire_le: '2027-08-17' }),
  );

  const seizieme = await emettreUne(depot, clientId, 16);
  assert.strictEqual(seizieme.numero, 'F2026-0016');
});

test('retirer sa licence ramène proprement à Découverte', async () => {
  const { depot } = await preparer();
  const { clePublique, signer } = await atelier();
  await depot.enregistrerLicence(
    await signer({ edition: 'pro', titulaire: 'KDL TECH', expire_le: '2027-08-17' }),
    { clePublique, aujourdhui: '2026-08-17' },
  );
  await depot.retirerLicence();
  assert.strictEqual((await depot.licence()).edition, 'decouverte');
});

/**
 * Une licence voyage avec la sauvegarde : changer d'ordinateur ne doit pas
 * obliger à retrouver son courriel d'achat.
 */
test('la licence suit la sauvegarde', async () => {
  const { depot } = await preparer();
  const { clePublique, signer } = await atelier();
  const cle = await signer({ edition: 'pro', titulaire: 'KDL TECH', expire_le: '2027-08-17' });
  await depot.enregistrerLicence(cle, { clePublique, aujourdhui: '2026-08-17' });

  const sauvegarde = await depot.exporter(['reglages']);
  const neuf = creerDepot(magasinMemoire());
  await neuf.importer(JSON.parse(JSON.stringify(sauvegarde)));

  const relue = await neuf.licence({ clePublique, aujourdhui: '2026-08-17' });
  assert.strictEqual(relue.edition, 'pro');
});
