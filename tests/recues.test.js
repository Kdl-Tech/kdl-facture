'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ouvrir } = require('../src/db');
const { creer } = require('../src/recues');
const { genererXML } = require('../src/facturx');
const { genererPDF } = require('../src/pdf');

const FOURNISSEUR = {
  nom: 'Grossiste Antilles', siren: '123456782', siret: '12345678200019',
  tva_intra: 'FR11123456782', adresse: '3 zone artisanale', code_postal: '97122',
  ville: 'Baie-Mahault', pays: 'FR', iban: 'FR7630001007941234567890185', regime_tva: 'normal',
};
const MOI = {
  type: 'entreprise', nom: 'KDL TECH', siren: '987654324', siret: '98765432400024',
  adresse: '1 rue des Palmiers', code_postal: '97100', ville: 'Basse-Terre', pays: 'FR',
};

function factureFournisseur(surcharge = {}) {
  return genererXML({
    document: {
      type: 'facture', numero: 'FA-2026-114', date_emission: '2026-08-10',
      date_echeance: '2026-09-09', categorie: 'biens', mode_paiement: 'virement',
      ...(surcharge.document || {}),
    },
    entreprise: FOURNISSEUR,
    client: MOI,
    lignes: surcharge.lignes || [
      { designation: 'Cartouches encre', quantite: 4, prix_ht: 25, tva_taux: 8.5, unite: 'piece' },
    ],
  });
}

function preparer() {
  const db = ouvrir(':memory:');
  const entreprise = db.prepare(`
    INSERT INTO entreprises (nom, siren, siret, adresse, code_postal, ville, regime_tva)
    VALUES ('KDL TECH', '987654324', '98765432400024', '1 rue des Palmiers',
            '97100', 'Basse-Terre', 'franchise')
  `).run();
  return { db, recues: creer(db), entrepriseId: Number(entreprise.lastInsertRowid) };
}

const octets = (texte) => new TextEncoder().encode(texte);

test('une facture fournisseur reçue est enregistrée et lisible', async () => {
  const { recues, entrepriseId } = preparer();
  const r = await recues.enregistrer(entrepriseId, octets(factureFournisseur()), {
    nom: 'facture-grossiste.xml',
  });

  assert.strictEqual(r.enregistree, true);
  assert.strictEqual(r.controle.conforme, true);

  const fiche = recues.obtenir(r.id);
  assert.strictEqual(fiche.numero, 'FA-2026-114');
  assert.strictEqual(fiche.fournisseur_nom, 'Grossiste Antilles');
  assert.strictEqual(fiche.fournisseur_siret, '12345678200019');
  assert.strictEqual(fiche.total_ttc, 108.5);
  assert.strictEqual(fiche.statut, 'recue');
  assert.strictEqual(fiche.statut_libelle, 'Reçue');
  assert.strictEqual(fiche.historique.length, 1);
  assert.ok(fiche.xml.includes('CrossIndustryInvoice'));
});

test('le fichier reçu est conservé tel quel', async () => {
  const { recues, entrepriseId } = preparer();
  const pdf = await genererPDF({
    document: {
      type: 'facture', numero: 'FA-2026-115', date_emission: '2026-08-11',
      categorie: 'biens', mode_paiement: 'virement',
    },
    entreprise: FOURNISSEUR,
    client: MOI,
    lignes: [{ designation: 'Toner', quantite: 1, prix_ht: 80, tva_taux: 8.5, unite: 'piece' }],
    paiements: [],
  });
  const r = await recues.enregistrer(entrepriseId, new Uint8Array(pdf), { nom: 'facture.pdf' });

  const original = recues.fichierOriginal(r.id);
  assert.strictEqual(original.fichier_nom, 'facture.pdf');
  assert.strictEqual(original.fichier.length, pdf.length);
  assert.strictEqual(Buffer.from(original.fichier).subarray(0, 5).toString(), '%PDF-');
});

test('un renvoi du même fichier ne crée pas une deuxième dette', async () => {
  const { recues, entrepriseId } = preparer();
  const fichier = octets(factureFournisseur());
  const premiere = await recues.enregistrer(entrepriseId, fichier, { nom: 'f.xml' });
  const seconde = await recues.enregistrer(entrepriseId, fichier, { nom: 'f-copie.xml' });

  assert.strictEqual(seconde.enregistree, false);
  assert.strictEqual(seconde.doublon, 'identique');
  assert.strictEqual(seconde.ancienne_id, premiere.id);
  assert.strictEqual(recues.lister(entrepriseId).length, 1);
});

test('un même numéro avec un autre montant est signalé, et forçable en connaissance de cause', async () => {
  const { recues, entrepriseId } = preparer();
  await recues.enregistrer(entrepriseId, octets(factureFournisseur()), {});
  const modifiee = octets(factureFournisseur({
    lignes: [{ designation: 'Cartouches encre', quantite: 40, prix_ht: 25, tva_taux: 8.5, unite: 'piece' }],
  }));

  const alerte = await recues.enregistrer(entrepriseId, modifiee, {});
  assert.strictEqual(alerte.enregistree, false);
  assert.strictEqual(alerte.doublon, 'divergent');
  assert.match(alerte.message, /montant différent/);

  const forcee = await recues.enregistrer(entrepriseId, modifiee, { forcer: true });
  assert.strictEqual(forcee.enregistree, true);
  assert.strictEqual(recues.lister(entrepriseId).length, 2);
});

test('une facture fausse est enregistrée mais marquée non conforme, avec un motif tout prêt', async () => {
  const { recues, entrepriseId } = preparer();
  const fausse = factureFournisseur().replace(
    '<ram:GrandTotalAmount>108.50</ram:GrandTotalAmount>',
    '<ram:GrandTotalAmount>138.50</ram:GrandTotalAmount>',
  );
  const r = await recues.enregistrer(entrepriseId, octets(fausse), {});

  assert.strictEqual(r.enregistree, true);
  assert.strictEqual(r.controle.conforme, false);
  assert.match(r.motif_rejet_propose, /total TTC/);

  const fiche = recues.obtenir(r.id);
  assert.strictEqual(fiche.verdict, 'non conforme');
  assert.ok(fiche.anomalies.length >= 1);
});

test('le parcours complet dune facture se rejoue dans lhistorique', async () => {
  const { recues, entrepriseId } = preparer();
  const r = await recues.enregistrer(entrepriseId, octets(factureFournisseur()), {});

  recues.changer(r.id, 'approuvee', { par: 'Gérant' });
  recues.changer(r.id, 'en_paiement', { par: 'Gérant' });
  recues.changer(r.id, 'encaissee', { par: 'Gérant' });

  const fiche = recues.obtenir(r.id);
  assert.strictEqual(fiche.statut, 'encaissee');
  assert.deepStrictEqual(
    fiche.historique.map((h) => h.statut),
    ['recue', 'approuvee', 'en_paiement', 'encaissee'],
  );
});

test('un rejet garde son motif, et ne se rouvre pas', async () => {
  const { recues, entrepriseId } = preparer();
  const r = await recues.enregistrer(entrepriseId, octets(factureFournisseur()), {});

  assert.throws(() => recues.changer(r.id, 'rejetee'), /motivé/);
  recues.changer(r.id, 'rejetee', { motif: 'Marchandise jamais livrée.', par: 'Gérant' });

  const fiche = recues.obtenir(r.id);
  assert.strictEqual(fiche.statut, 'rejetee');
  assert.strictEqual(fiche.historique[1].motif, 'Marchandise jamais livrée.');
  assert.throws(() => recues.changer(r.id, 'approuvee'), /définitif/);
});

test('le résumé montre ce qui attend, ce qui est en retard et ce qui est douteux', async () => {
  const { recues, entrepriseId } = preparer();
  const aPayer = await recues.enregistrer(entrepriseId, octets(factureFournisseur()), {});
  await recues.enregistrer(entrepriseId, octets(factureFournisseur({
    document: { numero: 'FA-2026-200', date_emission: '2026-06-01', date_echeance: '2026-07-01' },
  })), {});
  recues.changer(aPayer.id, 'approuvee');

  const resume = recues.resume(entrepriseId, '2026-08-17');
  assert.strictEqual(resume.a_traiter.n, 1);
  assert.strictEqual(resume.a_payer.n, 1);
  assert.strictEqual(resume.a_payer.total, 108.5);
  assert.strictEqual(resume.en_retard.n, 1, 'la facture échue au 1er juillet est en retard');
  assert.strictEqual(resume.payees.n, 0);
});

test('la liste se filtre par statut et par fournisseur', async () => {
  const { recues, entrepriseId } = preparer();
  const a = await recues.enregistrer(entrepriseId, octets(factureFournisseur()), {});
  await recues.enregistrer(entrepriseId, octets(factureFournisseur({
    document: { numero: 'FA-2026-300' },
  })), {});
  recues.changer(a.id, 'approuvee');

  assert.strictEqual(recues.lister(entrepriseId, { statut: 'recue' }).length, 1);
  assert.strictEqual(recues.lister(entrepriseId, { statut: 'approuvee' }).length, 1);
  assert.strictEqual(recues.lister(entrepriseId, { fournisseur: 'Grossiste' }).length, 2);
  assert.strictEqual(recues.lister(entrepriseId, { fournisseur: 'Inconnu' }).length, 0);
});

test('changer le statut dune facture inexistante est refusé proprement', () => {
  const { recues } = preparer();
  assert.throws(() => recues.changer(999, 'approuvee'), /introuvable/);
});
