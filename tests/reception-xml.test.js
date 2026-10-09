'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  analyserXML, tous, trouver, valeur, nombre,
} = require('../src/reception/xml');

test('un document simple se lit avec ses attributs et son texte', () => {
  const r = analyserXML('<a x="1"><b>bonjour</b><b>salut</b></a>');
  assert.strictEqual(r.local, 'a');
  assert.strictEqual(r.attributs.x, '1');
  assert.strictEqual(tous(r, 'b').length, 2);
  assert.strictEqual(valeur(r, 'b'), 'bonjour');
});

test('les espaces de noms ne gênent pas la lecture', () => {
  const r = analyserXML(
    '<rsm:Invoice xmlns:rsm="urn:x" xmlns:ram="urn:y"><ram:ID>F2026-0001</ram:ID></rsm:Invoice>',
  );
  assert.strictEqual(r.prefixe, 'rsm');
  assert.strictEqual(r.local, 'Invoice');
  assert.strictEqual(valeur(r, 'ID'), 'F2026-0001');
});

test('les entités et les accents sont restitués', () => {
  const r = analyserXML('<a><b>Caf&#233; &amp; Th&#233; &lt;pro&gt;</b></a>');
  assert.strictEqual(valeur(r, 'b'), 'Café & Thé <pro>');
});

test('une balise auto-fermante est un élément vide, pas une erreur', () => {
  const r = analyserXML('<a><b/><c>x</c></a>');
  assert.ok(trouver(r, 'b'));
  assert.strictEqual(valeur(r, 'b'), '');
  assert.strictEqual(valeur(r, 'c'), 'x');
});

test('commentaires et CDATA traversent sans polluer le texte', () => {
  const r = analyserXML('<a><!-- note --><b><![CDATA[3 < 4 & 5]]></b></a>');
  assert.strictEqual(valeur(r, 'b'), '3 < 4 & 5');
});

test('un nombre se lit avec le point comme avec la virgule', () => {
  const r = analyserXML('<a><m>150.50</m><n>150,50</n><o>rien</o></a>');
  assert.strictEqual(nombre(r, 'm'), 150.5);
  assert.strictEqual(nombre(r, 'n'), 150.5);
  assert.strictEqual(nombre(r, 'o'), null);
  assert.strictEqual(nombre(r, 'absent'), null);
});

test('un chemin absent rend une liste vide, jamais une exception', () => {
  const r = analyserXML('<a><b>x</b></a>');
  assert.deepStrictEqual(tous(r, 'z/y'), []);
  assert.strictEqual(trouver(r, 'z'), null);
  assert.strictEqual(valeur(r, 'z'), '');
});

/**
 * Les documents malformés doivent être refusés, pas devinés : une facture à
 * moitié lue est plus dangereuse qu'une facture rejetée.
 */
test('un document malformé est refusé avec un motif lisible', () => {
  assert.throws(() => analyserXML('<a><b></a>'), /« b »|« a »/);
  assert.throws(() => analyserXML('<a>'), /jamais fermée/);
  assert.throws(() => analyserXML(''), /vide/);
  assert.throws(() => analyserXML('<a/><b/>'), /plusieurs racines/);
});

/**
 * La bombe à entités et l'inclusion de fichier local sont les deux attaques
 * classiques du XML. On refuse la DTD en bloc plutôt que d'essayer de la
 * traiter : une facture n'en a aucun besoin.
 */
test('une DTD ou une entité déclarée fait rejeter le document', () => {
  assert.throws(
    () => analyserXML('<!DOCTYPE a [<!ENTITY x "boum">]><a>&x;</a>'),
    /DTD ou des entités/,
  );
  assert.throws(
    () => analyserXML('<!DOCTYPE a SYSTEM "file:///etc/passwd"><a/>'),
    /DTD ou des entités/,
  );
});

test('la déclaration XML et le BOM ne gênent pas', () => {
  const r = analyserXML('﻿<?xml version="1.0" encoding="UTF-8"?>\n<a><b>ok</b></a>');
  assert.strictEqual(valeur(r, 'b'), 'ok');
});
