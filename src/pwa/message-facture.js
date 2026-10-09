'use strict';

/*
 * Le message qui accompagne une facture envoyée par courriel.
 *
 * Séparé de l'interface pour une raison simple : c'est du texte remis à un
 * client, il doit être juste (bon numéro, bon montant, bonne échéance) et il se
 * vérifie donc par des tests, pas à l'œil dans un navigateur.
 *
 * Le logiciel n'envoie rien lui-même — il prépare le message et le remet à
 * l'application de courrier de l'appareil. Aucune donnée ne part vers un
 * serveur, ce qui vaut aussi pour la transmission légale : celle-ci passe par
 * une plateforme agréée, pas par ici.
 */

function euros(montant) {
  // Séparateur de milliers, mais des espaces ordinaires : un courriel en texte
  // brut traverse trop de logiciels pour parier sur l'espace fine insécable.
  const nombre = Number(montant || 0).toFixed(2).replace('.', ',');
  return `${nombre.replace(/\B(?=(\d{3})+(?!\d),)/g, ' ')} €`;
}

function dateFr(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

function montantDu(doc) {
  const t = doc.totaux || {};
  const valeur = t.net_a_payer != null ? t.net_a_payer : t.total_ttc;
  return valeur == null ? null : Math.abs(Number(valeur));
}

/**
 * Nom du fichier joint. Le numéro suffit à l'identifier ; on le nettoie des
 * caractères qu'un système de fichiers ou une pièce jointe refusent.
 */
function nomFichier(doc) {
  const base = String(doc.numero || '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${base || 'brouillon'}.pdf`;
}

/**
 * Compose l'objet et le corps du courriel. Un avoir n'est pas une facture : il
 * ne se paie pas, il ne porte pas d'échéance. Un devis n'en est pas une non
 * plus : rien n'est dû, sa date associée est une validité, pas un règlement —
 * le dire autrement serait une erreur vis-à-vis du client.
 */
function composerMessage({ document: doc = {}, entreprise = {}, client = {} } = {}) {
  const avoir = doc.type === 'avoir';
  const devis = doc.type === 'devis';
  const piece = avoir ? 'avoir' : (devis ? 'devis' : 'facture');
  const numero = doc.numero || '';
  const emetteur = entreprise.nom || '';

  const objet = [
    avoir ? 'Avoir' : (devis ? 'Devis' : 'Facture'),
    numero && `n° ${numero}`,
    emetteur && `— ${emetteur}`,
  ].filter(Boolean).join(' ');

  const montant = montantDu(doc);
  const phrases = [];

  phrases.push('Bonjour,');

  const emise = dateFr(doc.date_emission);
  const article = avoir ? "l'avoir" : (devis ? 'le devis' : 'la facture');
  let annonce = `Veuillez trouver ci-joint ${article}`;
  if (numero) annonce += ` n° ${numero}`;
  if (emise) annonce += ` du ${emise}`;
  if (montant != null) {
    annonce += avoir
      ? `, d'un montant de ${euros(montant)} en votre faveur`
      : `, d'un montant de ${euros(montant)} TTC`;
  }
  phrases.push(`${annonce}.`);

  const echeance = dateFr(doc.date_echeance);
  if (devis && echeance) phrases.push(`Ce devis est valable jusqu'au ${echeance}.`);
  if (!avoir && !devis && echeance) phrases.push(`Le règlement est attendu pour le ${echeance}.`);

  phrases.push('Je reste à votre disposition pour toute question.');

  const signature = ['Cordialement,', emetteur, entreprise.email].filter(Boolean).join('\n');
  const corps = `${phrases.join('\n\n')}\n\n${signature}\n`;

  return {
    destinataire: (client.email || '').trim(),
    objet,
    corps,
    nomFichier: nomFichier(doc),
    piece,
  };
}

/**
 * Le lien `mailto:` ouvre l'application de courrier avec tout de pré-rempli
 * sauf la pièce jointe : aucun navigateur ne permet d'en attacher une par ce
 * moyen. C'est pourquoi le PDF est enregistré à côté quand on passe par là.
 */
function lienMailto(message) {
  const parametres = [];
  if (message.objet) parametres.push(`subject=${encodeURIComponent(message.objet)}`);
  if (message.corps) parametres.push(`body=${encodeURIComponent(message.corps)}`);
  const cible = encodeURIComponent(message.destinataire || '').replace(/%40/g, '@');
  return `mailto:${cible}${parametres.length ? `?${parametres.join('&')}` : ''}`;
}

module.exports = { composerMessage, lienMailto, nomFichier, euros, dateFr };
