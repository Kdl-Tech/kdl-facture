'use strict';

/**
 * Contrôle d'une facture reçue.
 *
 * Recevoir ne veut pas dire accepter. Une facture qui arrive peut être
 * incomplète, fausse dans ses calculs, ou déjà reçue la semaine dernière. Le
 * logiciel doit le dire avant qu'elle ne parte en comptabilité ou en paiement.
 *
 * On distingue deux niveaux, parce qu'ils appellent deux gestes différents :
 * — une *anomalie* rend la facture non conforme : il faut la refuser et le dire
 *   au fournisseur, la réforme prévoit d'ailleurs un statut de rejet motivé ;
 * — un *avertissement* n'empêche pas de la traiter, mais mérite un regard.
 *
 * Tous les montants sont comparés en centimes entiers. Comparer des décimaux
 * flottants ferait apparaître des écarts d'un centime qui n'existent pas.
 */

const { TERRITOIRES, devinerPrecis } = require('../territoires');

const CENT = (v) => Math.round(Number(v || 0) * 100);
const EUROS = (centimes) => (centimes / 100).toFixed(2).replace('.', ',');

/** Un centime de tolérance par ligne : les arrondis légitimes s'y logent. */
function tolerance(nombreDeLignes) {
  return Math.max(1, Number(nombreDeLignes) || 1);
}

function controlerPresence(facture, ajouter) {
  if (!facture.numero) ajouter('La facture ne porte aucun numéro.');
  if (!facture.date_emission) ajouter("La date d'émission est absente.");
  if (!facture.fournisseur || !facture.fournisseur.nom) ajouter('Le fournisseur n\'est pas nommé.');
  if (!facture.client || !facture.client.nom) ajouter("Le destinataire n'est pas nommé.");
  if (!facture.lignes.length) ajouter('La facture ne contient aucune ligne.');
  if (facture.totaux.net_a_payer === null) ajouter('Le montant à payer est absent.');
  if (!facture.devise) ajouter('La devise n\'est pas précisée.');
}

function controlerIdentification(facture, avertir) {
  const f = facture.fournisseur || {};
  if (!f.siret && !f.siren && !f.tva_intra) {
    avertir("Le fournisseur n'est identifié ni par un SIRET, ni par un numéro de TVA : "
      + 'le rapprochement comptable devra être fait à la main.');
  }
  if (facture.profil && !/en16931|factur-x|urn:cen\.eu/i.test(facture.profil)) {
    avertir(`Le profil déclaré n'est pas EN 16931 (« ${facture.profil} »).`);
  }
}

function controlerLignes(facture, ajouter, avertir) {
  facture.lignes.forEach((l, i) => {
    const rang = `Ligne ${l.numero || i + 1}`;
    if (!l.designation) avertir(`${rang} : aucune désignation.`);
    if (l.montant_ht === null) {
      ajouter(`${rang} : le montant est absent.`);
      return;
    }
    if (l.quantite !== null && l.prix_ht !== null) {
      const attendu = Math.round(Number(l.quantite) * CENT(l.prix_ht));
      const ecart = Math.abs(attendu - CENT(l.montant_ht));
      // Une remise de ligne explique un montant inférieur au produit brut ;
      // au-delà d'un centime et sans remise déclarée, le calcul est faux.
      if (ecart > 1 && attendu < CENT(l.montant_ht)) {
        ajouter(`${rang} : ${l.quantite} × ${EUROS(CENT(l.prix_ht))} € donne `
          + `${EUROS(attendu)} €, mais la ligne affiche ${EUROS(CENT(l.montant_ht))} €.`);
      } else if (ecart > 1) {
        avertir(`${rang} : le montant est inférieur au produit quantité × prix `
          + `(${EUROS(attendu)} € attendus, ${EUROS(CENT(l.montant_ht))} € affichés) — remise ?`);
      }
    }
  });
}

function controlerTotaux(facture, ajouter) {
  const t = facture.totaux;
  const marge = tolerance(facture.lignes.length);

  const sommeLignes = facture.lignes.reduce((n, l) => n + CENT(l.montant_ht), 0);
  if (t.total_ht !== null && facture.lignes.length
      && Math.abs(sommeLignes - CENT(t.total_ht)) > marge) {
    ajouter(`Le total hors taxes annoncé (${EUROS(CENT(t.total_ht))} €) ne correspond pas `
      + `à la somme des lignes (${EUROS(sommeLignes)} €).`);
  }

  const sommeTva = facture.ventilation_tva.reduce((n, v) => n + CENT(v.montant_tva), 0);
  if (t.total_tva !== null && facture.ventilation_tva.length
      && Math.abs(sommeTva - CENT(t.total_tva)) > marge) {
    ajouter(`La TVA annoncée (${EUROS(CENT(t.total_tva))} €) ne correspond pas à la somme `
      + `des taux détaillés (${EUROS(sommeTva)} €).`);
  }

  facture.ventilation_tva.forEach((v) => {
    if (v.base_ht === null || v.montant_tva === null) return;
    const attendu = Math.round((CENT(v.base_ht) * Number(v.taux || 0)) / 100);
    if (Math.abs(attendu - CENT(v.montant_tva)) > 1) {
      ajouter(`TVA à ${v.taux} % : ${EUROS(CENT(v.base_ht))} € donnent `
        + `${EUROS(attendu)} € de taxe, mais la facture annonce `
        + `${EUROS(CENT(v.montant_tva))} €.`);
    }
  });

  if (t.total_ht !== null && t.total_tva !== null && t.total_ttc !== null) {
    const attendu = CENT(t.total_ht) + CENT(t.total_tva);
    if (Math.abs(attendu - CENT(t.total_ttc)) > marge) {
      ajouter(`Le total TTC (${EUROS(CENT(t.total_ttc))} €) ne vaut pas le hors taxes `
        + `plus la TVA (${EUROS(attendu)} €).`);
    }
  }

  if (t.total_ttc !== null && t.net_a_payer !== null) {
    const attendu = CENT(t.total_ttc) - CENT(t.acompte);
    if (Math.abs(attendu - CENT(t.net_a_payer)) > marge) {
      ajouter(`Le net à payer (${EUROS(CENT(t.net_a_payer))} €) ne vaut pas le TTC moins `
        + `les acomptes (${EUROS(attendu)} €).`);
    }
  }
}

/**
 * Le taux de TVA appliqué correspond-il au territoire de l'émetteur ?
 *
 * Aux Antilles, à La Réunion, le taux normal est de 8,5 % et non de 20 % ; en
 * Guyane et à Mayotte la TVA ne s'applique pas du tout. L'erreur la plus
 * fréquente vient d'un fournisseur local dont le logiciel est resté réglé sur la
 * métropole : la facture est arithmétiquement juste — 20 % de la base font bien
 * le montant annoncé — et personne ne voit rien. Le client paie une TVA qui
 * n'avait pas lieu d'être, et ne peut pas la déduire.
 *
 * On avertit sans refuser : certaines opérations transfrontalières justifient un
 * taux inattendu, et un logiciel n'a pas à trancher une question fiscale à la
 * place de son utilisateur. Mais il doit la poser.
 */
function controlerTerritoire(facture, avertir) {
  const f = facture.fournisseur;
  if (!f || !f.code_postal) return;
  if (String(f.pays || 'FR').toUpperCase() !== 'FR') return;

  const cle = devinerPrecis(f.code_postal);
  const territoire = TERRITOIRES[cle];
  if (!territoire || cle === 'metropole') return;

  const taux = facture.ventilation_tva
    .map((v) => Number(v.taux || 0))
    .filter((t) => t > 0);
  if (!taux.length) return;

  const admis = (territoire.taux || []).filter((t) => t > 0);
  const inattendus = [...new Set(taux.filter((t) => !admis.includes(t)))];
  if (!inattendus.length) return;

  const lieu = territoire.nom || cle;
  // Les taux s'écrivent à la française : 8,5 % et non 8.5 %.
  const pourcent = (liste, liaison) => liste
    .map((t) => String(t).replace('.', ','))
    .join(liaison);

  // La Guyane et Mayotte n'ont pas de taux : la TVA n'y est pas applicable.
  if (!admis.length) {
    avertir(
      `Le fournisseur est situé en ${lieu}, où la TVA ne s'applique pas `
      + `(${territoire.base || 'article 294 du CGI'}), mais la facture porte une TVA à `
      + `${pourcent(inattendus, ' % et ')} %. Cette TVA n'est probablement pas déductible : `
      + 'demandez une facture rectificative avant de payer.',
    );
    return;
  }

  avertir(
    `Le fournisseur est situé en ${lieu}, où les taux sont de `
    + `${pourcent(admis, ' %, ')} %. La facture applique ${pourcent(inattendus, ' % et ')} % : `
    + 'vérifiez, un logiciel réglé sur la métropole fait cette erreur sans le signaler.',
  );
}

function controlerSens(facture, avertir) {
  const negatives = facture.lignes.filter((l) => Number(l.quantite) < 0).length;
  if (facture.type === 'avoir' && negatives === 0 && facture.lignes.length) {
    avertir("Cet avoir ne porte aucune quantité négative : vérifiez qu'il annule bien "
      + 'quelque chose.');
  }
  if (facture.type === 'facture' && negatives === facture.lignes.length && facture.lignes.length) {
    avertir('Toutes les quantités sont négatives sur une facture : est-ce un avoir '
      + 'envoyé sous le mauvais code ?');
  }
}

/**
 * Contrôle complet d'une facture reçue.
 * @returns {{verdict: string, conforme: boolean, anomalies: string[], avertissements: string[]}}
 */
function controler(facture) {
  const anomalies = [];
  const avertissements = [];
  const ajouter = (m) => anomalies.push(m);
  const avertir = (m) => avertissements.push(m);

  controlerPresence(facture, ajouter);
  controlerIdentification(facture, avertir);
  controlerLignes(facture, ajouter, avertir);
  controlerTotaux(facture, ajouter);
  controlerTerritoire(facture, avertir);
  controlerSens(facture, avertir);

  let verdict = 'conforme';
  if (anomalies.length) verdict = 'non conforme';
  else if (avertissements.length) verdict = 'à vérifier';

  return {
    verdict, conforme: anomalies.length === 0, anomalies, avertissements,
  };
}

/**
 * L'empreinte du fichier reçu, pour reconnaître un envoi en double.
 * `crypto.subtle` existe sous Node comme dans le navigateur : une seule
 * implémentation, aucun module à charger.
 */
async function empreinte(contenu) {
  const octets = typeof contenu === 'string' ? new TextEncoder().encode(contenu) : contenu;
  const brut = await crypto.subtle.digest('SHA-256', octets);
  return [...new Uint8Array(brut)].map((o) => o.toString(16).padStart(2, '0')).join('');
}

/**
 * La clé métier d'une facture : même émetteur, même numéro, même date.
 *
 * L'empreinte du fichier ne suffit pas — un fournisseur qui renvoie sa facture
 * regénère souvent un PDF différent à l'octet près. Cette clé-là reconnaît le
 * doublon réel, celui qu'on risquerait de payer deux fois.
 */
function cleMetier(facture) {
  const f = facture.fournisseur || {};
  const emetteur = (f.siret || f.siren || f.tva_intra || f.nom || '').replace(/\s/g, '').toUpperCase();
  return [emetteur, String(facture.numero || '').toUpperCase(), facture.date_emission || '']
    .join('|');
}

module.exports = {
  controler, empreinte, cleMetier,
};
