#!/usr/bin/env node
/**
 * Fabrique les licences Pro de KDL Facture.
 *
 * Cet outil reste chez KDL TECH : il détient la clé privée, la seule chose qui
 * distingue une licence authentique d'une clé bricolée. L'application, elle, ne
 * connaît que la clé publique et ne peut donc rien signer.
 *
 * Créer la paire de clés, une fois pour toutes :
 *   node outils/licences.mjs creer-cles
 *
 * Émettre une licence :
 *   node outils/licences.mjs emettre "Jean Dupont" --mois 12 --reference CMD-001
 *
 * Vérifier une clé, comme le ferait le logiciel :
 *   node outils/licences.mjs verifier <clé>
 *
 * 🔴 `licence-privee.json` ne doit jamais être commité, ni copié sur un serveur,
 * ni envoyé par courriel. Sa perte n'invalide aucune licence déjà émise, mais
 * empêche d'en émettre de nouvelles : gardez-en une copie hors ligne.
 */

import { webcrypto as crypto } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVEE = join(RACINE, 'licence-privee.json');
const PUBLIQUE = join(RACINE, 'licence-publique.json');

const b64url = (octets) => Buffer.from(octets).toString('base64url');
const deB64url = (texte) => new Uint8Array(Buffer.from(texte, 'base64url'));

async function creerCles() {
  if (existsSync(PRIVEE)) {
    console.error(`Une clé privée existe déjà : ${PRIVEE}`);
    console.error('La remplacer invaliderait toutes les licences déjà émises.');
    process.exit(1);
  }

  const paire = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const privee = await crypto.subtle.exportKey('pkcs8', paire.privateKey);
  const publique = await crypto.subtle.exportKey('spki', paire.publicKey);

  writeFileSync(PRIVEE, `${JSON.stringify({ cle: b64url(privee) }, null, 2)}\n`);
  chmodSync(PRIVEE, 0o600);
  writeFileSync(PUBLIQUE, `${JSON.stringify({ cle: b64url(publique) }, null, 2)}\n`);

  console.log(`Clé privée : ${PRIVEE} (à garder, jamais à publier)`);
  console.log(`Clé publique : ${PUBLIQUE} (embarquée dans l'application)`);
}

async function emettre(titulaire, options) {
  if (!existsSync(PRIVEE)) {
    console.error('Aucune clé privée. Lancez d\'abord : node outils/licences.mjs creer-cles');
    process.exit(1);
  }
  if (!titulaire) {
    console.error('Nom du titulaire manquant.');
    process.exit(1);
  }

  const privee = await crypto.subtle.importKey(
    'pkcs8',
    deB64url(JSON.parse(readFileSync(PRIVEE, 'utf-8')).cle),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const emise = new Date();
  const expire = new Date(emise);
  expire.setMonth(expire.getMonth() + Number(options.mois || 12));

  const contenu = {
    edition: 'pro',
    titulaire,
    emise_le: emise.toISOString().slice(0, 10),
    expire_le: expire.toISOString().slice(0, 10),
    reference: options.reference || '',
  };

  const charge = b64url(new TextEncoder().encode(JSON.stringify(contenu)));
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privee,
    new TextEncoder().encode(charge),
  );

  console.log(`\nLicence Pro pour ${titulaire}`);
  console.log(`Valable du ${contenu.emise_le} au ${contenu.expire_le}`);
  if (contenu.reference) console.log(`Référence : ${contenu.reference}`);
  console.log(`\n${charge}.${b64url(signature)}\n`);
}

async function verifier(cle) {
  if (!existsSync(PUBLIQUE)) {
    console.error('Clé publique absente : impossible de vérifier.');
    process.exit(1);
  }
  const [charge, signature] = String(cle || '').split('.');
  if (!charge || !signature) {
    console.error('Clé incomplète.');
    process.exit(1);
  }

  const publique = await crypto.subtle.importKey(
    'spki',
    deB64url(JSON.parse(readFileSync(PUBLIQUE, 'utf-8')).cle),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const authentique = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publique,
    deB64url(signature),
    new TextEncoder().encode(charge),
  );

  console.log(authentique ? '✔ signature authentique' : '✘ signature invalide');
  if (authentique) {
    console.log(JSON.parse(Buffer.from(charge, 'base64url').toString('utf-8')));
  }
  process.exit(authentique ? 0 : 1);
}

const [commande, ...reste] = process.argv.slice(2);
const options = {};
const positionnels = [];
for (let i = 0; i < reste.length; i += 1) {
  if (reste[i].startsWith('--')) {
    options[reste[i].slice(2)] = reste[i + 1];
    i += 1;
  } else positionnels.push(reste[i]);
}

if (commande === 'creer-cles') await creerCles();
else if (commande === 'emettre') await emettre(positionnels[0], options);
else if (commande === 'verifier') await verifier(positionnels[0]);
else {
  console.log('Usage :');
  console.log('  node outils/licences.mjs creer-cles');
  console.log('  node outils/licences.mjs emettre "Nom du client" [--mois 12] [--reference CMD-001]');
  console.log('  node outils/licences.mjs verifier <clé>');
}
