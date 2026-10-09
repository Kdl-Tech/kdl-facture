'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  verifierLicence, etatQuota, messageQuota, editionLibre, CAPACITES, DECOUVERTE, PRO,
} = require('../src/licence-portable');

const b64url = (octets) => Buffer.from(octets).toString('base64url');

/** Une paire de clés jetable, pour éprouver la vérification sans la vraie clé. */
async function atelier() {
  const paire = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const clePublique = b64url(await crypto.subtle.exportKey('spki', paire.publicKey));

  const signer = async (contenu) => {
    const charge = b64url(new TextEncoder().encode(JSON.stringify(contenu)));
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      paire.privateKey,
      new TextEncoder().encode(charge),
    );
    return `${charge}.${b64url(signature)}`;
  };

  return { clePublique, signer };
}

const PRO_2027 = {
  edition: 'pro', titulaire: 'Boulangerie Le Fournil',
  emise_le: '2026-08-17', expire_le: '2027-08-17', reference: 'CMD-001',
};

test('sans licence, on est en édition Découverte', async () => {
  const l = await verifierLicence('');
  assert.strictEqual(l.edition, DECOUVERTE);
  assert.strictEqual(l.valide, false);
  assert.strictEqual(l.refus, '', 'ne pas accuser quelqu un qui n a rien saisi');
  assert.strictEqual(l.factures_par_an, 15);
});

test('une licence authentique ouvre l édition Pro', async () => {
  const { clePublique, signer } = await atelier();
  const l = await verifierLicence(await signer(PRO_2027), {
    clePublique, aujourdhui: '2026-08-17',
  });
  assert.strictEqual(l.edition, PRO);
  assert.strictEqual(l.valide, true);
  assert.strictEqual(l.titulaire, 'Boulangerie Le Fournil');
  assert.strictEqual(l.factures_par_an, Infinity);
  assert.strictEqual(l.export_comptable, true);
});

/**
 * Le cœur du dispositif : sans la clé privée, on ne doit pas pouvoir fabriquer
 * une licence, même en connaissant parfaitement le format et la clé publique.
 */
test('une licence signée par quelqu un d autre est refusée', async () => {
  const vrai = await atelier();
  const faussaire = await atelier();
  const l = await verifierLicence(await faussaire.signer(PRO_2027), {
    clePublique: vrai.clePublique, aujourdhui: '2026-08-17',
  });
  assert.strictEqual(l.edition, DECOUVERTE);
  assert.match(l.refus, /n'est pas authentique/);
});

test('modifier le contenu d une licence invalide sa signature', async () => {
  const { clePublique, signer } = await atelier();
  const cle = await signer({ ...PRO_2027, expire_le: '2027-08-17' });
  const [, signature] = cle.split('.');
  const trafique = `${b64url(new TextEncoder().encode(JSON.stringify({
    ...PRO_2027, expire_le: '2099-01-01',
  })))}.${signature}`;

  const l = await verifierLicence(trafique, { clePublique, aujourdhui: '2026-08-17' });
  assert.strictEqual(l.edition, DECOUVERTE);
  assert.match(l.refus, /n'est pas authentique/);
});

/**
 * Une licence expirée ne doit pas laisser un artisan devant un logiciel muet le
 * jour où il facture : on retombe sur la gratuite, en disant pourquoi.
 */
test('une licence expirée ramène à Découverte, avec la date en clair', async () => {
  const { clePublique, signer } = await atelier();
  const l = await verifierLicence(await signer(PRO_2027), {
    clePublique, aujourdhui: '2027-09-01',
  });
  assert.strictEqual(l.edition, DECOUVERTE);
  assert.strictEqual(l.expiree, true);
  assert.match(l.refus, /17\/08\/2027/);
  assert.strictEqual(l.titulaire, 'Boulangerie Le Fournil', 'le titulaire reste affichable');
});

test('une clé abîmée ou tronquée est refusée sans planter', async () => {
  const { clePublique } = await atelier();
  for (const mauvaise of ['n importe quoi', 'abc.def', 'a.b.c', '....']) {
    // eslint-disable-next-line no-await-in-loop
    const l = await verifierLicence(mauvaise, { clePublique });
    assert.strictEqual(l.edition, DECOUVERTE, `« ${mauvaise} » doit être refusée`);
    assert.ok(l.refus, 'le refus doit être expliqué');
  }
});

/**
 * Sans clé publique embarquée, un défaut de construction doit fermer la porte,
 * jamais l'ouvrir.
 */
test('un logiciel construit sans clé publique refuse toutes les licences', async () => {
  const { signer } = await atelier();
  const l = await verifierLicence(await signer(PRO_2027));
  assert.strictEqual(l.edition, DECOUVERTE);
  assert.match(l.refus, /ne sait pas vérifier/);
});

/* ---------- Quotas ---------- */

const emises = (n, annee = 2026) => Array.from({ length: n }, (_, i) => ({
  statut: 'emis', type: 'facture', date_emission: `${annee}-03-${String(i + 1).padStart(2, '0')}`,
}));

test('le quota compte les factures émises de l année', () => {
  const q = etatQuota(editionLibre(), emises(4), 2026);
  assert.strictEqual(q.emises, 4);
  assert.strictEqual(q.plafond, 15);
  assert.strictEqual(q.restantes, 11);
  assert.strictEqual(q.atteint, false);
});

test('les brouillons, les devis et les autres années ne consomment rien', () => {
  const documents = [
    ...emises(2),
    { statut: 'brouillon', type: 'facture', date_emission: '2026-04-01' },
    { statut: 'emis', type: 'devis', date_emission: '2026-04-02' },
    ...emises(5, 2025),
  ];
  assert.strictEqual(etatQuota(editionLibre(), documents, 2026).emises, 2);
});

test('le plafond atteint est annoncé sans culpabiliser, en rappelant ce qui continue', () => {
  const q = etatQuota(editionLibre(), emises(15), 2026);
  assert.strictEqual(q.atteint, true);
  assert.strictEqual(q.restantes, 0);
  const message = messageQuota(q);
  assert.match(message, /restent lisibles/);
  assert.match(message, /réception continue/);
});

test('l approche du plafond est signalée à trois factures près', () => {
  assert.strictEqual(etatQuota(editionLibre(), emises(11), 2026).proche, false);
  assert.strictEqual(etatQuota(editionLibre(), emises(12), 2026).proche, true);
  assert.match(messageQuota(etatQuota(editionLibre(), emises(14), 2026)), /reste 1 facture /);
});

test('en Pro, il n y a ni plafond ni message', () => {
  const pro = { ...CAPACITES[PRO], edition: PRO };
  const q = etatQuota(pro, emises(400), 2026);
  assert.strictEqual(q.plafond, null);
  assert.strictEqual(q.atteint, false);
  assert.strictEqual(messageQuota(q), '');
});

/**
 * Le principe qui tient tout : la conformité n'est jamais monnayée. Si ce test
 * tombe un jour, c'est que le produit a changé de nature.
 */
test('l édition gratuite garde tout ce qui rend une facture conforme', () => {
  const gratuit = CAPACITES[DECOUVERTE];
  assert.strictEqual(gratuit.facturx, true, 'le Factur-X conforme n est jamais payant');
  assert.strictEqual(gratuit.journal, true, 'le journal des actes n est jamais payant');
  assert.strictEqual(gratuit.avoirs, true, 'corriger une erreur n est jamais payant');
  assert.strictEqual(gratuit.reception, true, "recevoir est une obligation légale, pas une option");
});
