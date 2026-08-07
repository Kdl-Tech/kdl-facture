'use strict';

/**
 * La TVA n'est pas la même partout en France.
 *
 * Un logiciel de facturation écrit depuis Paris se trompe en Guadeloupe : le
 * taux normal y est de 8,5 % et non 20 %. En Guyane et à Mayotte, la TVA n'est
 * tout simplement pas applicable. Ces règles ne sont pas des détails — facturer
 * 20 % de TVA à un client guadeloupéen est une erreur qui se paie.
 *
 * Les taux ci-dessous sont ceux en vigueur à la rédaction. Ils peuvent changer :
 * chaque territoire porte l'article du CGI qui le fonde, et l'onglet Références
 * renvoie aux sources officielles.
 */

const TERRITOIRES = {
  metropole: {
    nom: 'France métropolitaine',
    groupe: 'Métropole',
    taux: [20, 10, 5.5, 2.1],
    taux_normal: 20,
    tva: true,
    base: 'Articles 278 et suivants du CGI',
    impose: [
      'TVA aux taux de droit commun : 20 %, 10 %, 5,5 % et 2,1 %.',
    ],
    permet: [
      'Franchise en base sous les plafonds (article 293 B).',
    ],
  },
  corse: {
    nom: 'Corse',
    groupe: 'Métropole',
    taux: [20, 13, 10, 5.5, 2.1, 0.9],
    taux_normal: 20,
    tva: true,
    base: 'Article 297 du CGI',
    impose: [
      'Taux particuliers sur certaines opérations : 0,9 %, 2,1 %, 10 % et 13 %.',
    ],
    permet: [
      'Les taux de métropole restent applicables aux autres opérations.',
    ],
  },
  guadeloupe: {
    nom: 'Guadeloupe',
    groupe: "Départements d'outre-mer",
    taux: [8.5, 2.1, 1.75, 1.05],
    taux_normal: 8.5,
    tva: true,
    base: 'Article 296 du CGI',
    impose: [
      'Taux propres aux DOM : 8,5 % en taux normal, 2,1 % en taux réduit.',
      "Octroi de mer sur les importations et les productions locales — taxe distincte de la TVA, non gérée par ce logiciel.",
    ],
    permet: [
      'Franchise en base sous les plafonds applicables outre-mer.',
      "Taux particuliers de 1,75 % et 1,05 % sur des opérations limitativement énumérées.",
    ],
  },
  martinique: {
    nom: 'Martinique',
    groupe: "Départements d'outre-mer",
    taux: [8.5, 2.1, 1.75, 1.05],
    taux_normal: 8.5,
    tva: true,
    base: 'Article 296 du CGI',
    impose: [
      'Taux propres aux DOM : 8,5 % en taux normal, 2,1 % en taux réduit.',
      'Octroi de mer sur les importations et les productions locales.',
    ],
    permet: [
      'Franchise en base sous les plafonds applicables outre-mer.',
      'Taux particuliers de 1,75 % et 1,05 %.',
    ],
  },
  reunion: {
    nom: 'La Réunion',
    groupe: "Départements d'outre-mer",
    taux: [8.5, 2.1, 1.75, 1.05],
    taux_normal: 8.5,
    tva: true,
    base: 'Article 296 du CGI',
    impose: [
      'Taux propres aux DOM : 8,5 % en taux normal, 2,1 % en taux réduit.',
      'Octroi de mer sur les importations et les productions locales.',
    ],
    permet: [
      'Franchise en base sous les plafonds applicables outre-mer.',
      'Taux particuliers de 1,75 % et 1,05 %.',
    ],
  },
  guyane: {
    nom: 'Guyane',
    groupe: "Départements d'outre-mer",
    taux: [0],
    taux_normal: 0,
    tva: false,
    mention: 'TVA non applicable — article 294 du CGI',
    base: 'Article 294 du CGI',
    impose: [
      "TVA provisoirement non applicable : aucune facture ne doit en porter.",
      'Mention « TVA non applicable — article 294 du CGI » sur chaque facture.',
      'Octroi de mer sur les importations et les productions locales.',
    ],
    permet: [
      "Aucune déclaration de TVA à déposer au titre des opérations réalisées sur place.",
    ],
  },
  mayotte: {
    nom: 'Mayotte',
    groupe: "Départements d'outre-mer",
    taux: [0],
    taux_normal: 0,
    tva: false,
    mention: 'TVA non applicable — article 294 du CGI',
    base: 'Article 294 du CGI',
    impose: [
      'TVA provisoirement non applicable : aucune facture ne doit en porter.',
      'Mention « TVA non applicable — article 294 du CGI » sur chaque facture.',
      'Octroi de mer sur les importations et les productions locales.',
    ],
    permet: [
      'Aucune déclaration de TVA au titre des opérations réalisées sur place.',
    ],
  },
  saint_martin: {
    nom: 'Saint-Martin',
    groupe: "Collectivités d'outre-mer",
    taux: [0],
    taux_normal: 0,
    tva: false,
    mention: 'TVA française non applicable — collectivité à fiscalité propre',
    base: 'Code général des impôts de Saint-Martin',
    impose: [
      "Fiscalité propre à la collectivité : la TVA française ne s'y applique pas.",
      'Vérifier les règles locales auprès de la collectivité avant de facturer.',
    ],
    permet: [],
  },
  saint_barthelemy: {
    nom: 'Saint-Barthélemy',
    groupe: "Collectivités d'outre-mer",
    taux: [0],
    taux_normal: 0,
    tva: false,
    mention: 'TVA française non applicable — collectivité à fiscalité propre',
    base: 'Statut fiscal de la collectivité',
    impose: [
      "Aucune TVA : la collectivité dispose de sa propre fiscalité.",
    ],
    permet: [],
  },
  saint_pierre_miquelon: {
    nom: 'Saint-Pierre-et-Miquelon',
    groupe: "Collectivités d'outre-mer",
    taux: [0],
    taux_normal: 0,
    tva: false,
    mention: 'TVA française non applicable — collectivité à fiscalité propre',
    base: 'Statut fiscal de la collectivité',
    impose: ["Aucune TVA française : fiscalité locale propre."],
    permet: [],
  },
  polynesie: {
    nom: 'Polynésie française',
    groupe: 'Pacifique',
    taux: [0],
    taux_normal: 0,
    tva: false,
    mention: 'TVA française non applicable — fiscalité de la Polynésie française',
    base: 'Autonomie fiscale de la collectivité',
    impose: [
      "La TVA française ne s'applique pas ; la Polynésie a sa propre TVA locale.",
      'Les taux locaux ne sont pas gérés par ce logiciel : saisissez-les à la main si besoin.',
    ],
    permet: [],
  },
  nouvelle_caledonie: {
    nom: 'Nouvelle-Calédonie',
    groupe: 'Pacifique',
    taux: [0],
    taux_normal: 0,
    tva: false,
    mention: 'TVA française non applicable — fiscalité de la Nouvelle-Calédonie',
    base: 'Autonomie fiscale de la collectivité',
    impose: [
      "La TVA française ne s'applique pas ; taxes locales propres (TGC).",
    ],
    permet: [],
  },
  wallis_futuna: {
    nom: 'Wallis-et-Futuna',
    groupe: 'Pacifique',
    taux: [0],
    taux_normal: 0,
    tva: false,
    mention: 'TVA française non applicable — fiscalité de Wallis-et-Futuna',
    base: 'Autonomie fiscale de la collectivité',
    impose: ["La TVA française ne s'applique pas."],
    permet: [],
  },
};


/**
 * Les départements, pour nommer précisément où l'on est.
 *
 * Attention à ne pas laisser croire à une fiscalité départementale : la TVA est
 * la même dans tous les départements métropolitains. Seules la Corse (taux
 * particuliers) et l'outre-mer changent la donne. Cette table sert à
 * identifier, pas à décider — le régime, lui, vient de `TERRITOIRES`.
 */
const DEPARTEMENTS = {
  '01': "Ain",
  '02': "Aisne",
  '03': "Allier",
  '04': "Alpes-de-Haute-Provence",
  '05': "Hautes-Alpes",
  '06': "Alpes-Maritimes",
  '07': "Ardèche",
  '08': "Ardennes",
  '09': "Ariège",
  '10': "Aube",
  '11': "Aude",
  '12': "Aveyron",
  '13': "Bouches-du-Rhône",
  '14': "Calvados",
  '15': "Cantal",
  '16': "Charente",
  '17': "Charente-Maritime",
  '18': "Cher",
  '19': "Corrèze",
  '21': "Côte-d'Or",
  '22': "Côtes-d'Armor",
  '23': "Creuse",
  '24': "Dordogne",
  '25': "Doubs",
  '26': "Drôme",
  '27': "Eure",
  '28': "Eure-et-Loir",
  '29': "Finistère",
  '30': "Gard",
  '31': "Haute-Garonne",
  '32': "Gers",
  '33': "Gironde",
  '34': "Hérault",
  '35': "Ille-et-Vilaine",
  '36': "Indre",
  '37': "Indre-et-Loire",
  '38': "Isère",
  '39': "Jura",
  '40': "Landes",
  '41': "Loir-et-Cher",
  '42': "Loire",
  '43': "Haute-Loire",
  '44': "Loire-Atlantique",
  '45': "Loiret",
  '46': "Lot",
  '47': "Lot-et-Garonne",
  '48': "Lozère",
  '49': "Maine-et-Loire",
  '50': "Manche",
  '51': "Marne",
  '52': "Haute-Marne",
  '53': "Mayenne",
  '54': "Meurthe-et-Moselle",
  '55': "Meuse",
  '56': "Morbihan",
  '57': "Moselle",
  '58': "Nièvre",
  '59': "Nord",
  '60': "Oise",
  '61': "Orne",
  '62': "Pas-de-Calais",
  '63': "Puy-de-Dôme",
  '64': "Pyrénées-Atlantiques",
  '65': "Hautes-Pyrénées",
  '66': "Pyrénées-Orientales",
  '67': "Bas-Rhin",
  '68': "Haut-Rhin",
  '69': "Rhône",
  '70': "Haute-Saône",
  '71': "Saône-et-Loire",
  '72': "Sarthe",
  '73': "Savoie",
  '74': "Haute-Savoie",
  '75': "Paris",
  '76': "Seine-Maritime",
  '77': "Seine-et-Marne",
  '78': "Yvelines",
  '79': "Deux-Sèvres",
  '80': "Somme",
  '81': "Tarn",
  '82': "Tarn-et-Garonne",
  '83': "Var",
  '84': "Vaucluse",
  '85': "Vendée",
  '86': "Vienne",
  '87': "Haute-Vienne",
  '88': "Vosges",
  '89': "Yonne",
  '90': "Territoire de Belfort",
  '91': "Essonne",
  '92': "Hauts-de-Seine",
  '93': "Seine-Saint-Denis",
  '94': "Val-de-Marne",
  '95': "Val-d'Oise",
  '2A': 'Corse-du-Sud',
  '2B': 'Haute-Corse',
  '971': 'Guadeloupe',
  '972': 'Martinique',
  '973': 'Guyane',
  '974': 'La Réunion',
  '975': 'Saint-Pierre-et-Miquelon',
  '976': 'Mayotte',
  '977': 'Saint-Barthélemy',
  '978': 'Saint-Martin',
  '986': 'Wallis-et-Futuna',
  '987': 'Polynésie française',
  '988': 'Nouvelle-Calédonie',
};

/** Le département correspondant à un code postal, nom compris. */
function departement(codePostal) {
  const cp = String(codePostal || '').trim();
  if (!/^\d{2}/.test(cp)) return null;
  if (/^97150/.test(cp)) return { code: '978', nom: DEPARTEMENTS['978'] };
  if (/^97133/.test(cp)) return { code: '977', nom: DEPARTEMENTS['977'] };
  if (/^9[78]/.test(cp)) {
    const code = cp.slice(0, 3);
    return DEPARTEMENTS[code] ? { code, nom: DEPARTEMENTS[code] } : null;
  }
  if (/^20/.test(cp)) {
    // La Corse se lit sur trois chiffres : 200xx et 201xx au sud, 202xx au nord.
    const code = Number(cp.slice(0, 3)) >= 202 ? '2B' : '2A';
    return { code, nom: DEPARTEMENTS[code] };
  }
  const code = cp.slice(0, 2);
  return DEPARTEMENTS[code] ? { code, nom: DEPARTEMENTS[code] } : null;
}

/** Le territoire d'une entreprise, avec un repli sûr sur la métropole. */
function territoire(entreprise) {
  const cle = String(entreprise && entreprise.territoire || 'metropole').toLowerCase();
  return TERRITOIRES[cle] ? { cle, ...TERRITOIRES[cle] } : { cle: 'metropole', ...TERRITOIRES.metropole };
}

/**
 * Devine le territoire d'après le code postal, pour proposer le bon réglage
 * sans que personne ait à le chercher. Une proposition, jamais une décision.
 */
function devinerPrecis(codePostal) {
  const cp = String(codePostal || '').trim();
  // Saint-Martin et Saint-Barthélemy partagent le préfixe 97 de la Guadeloupe :
  // leurs codes propres passent en premier, sinon on les rangerait à tort.
  if (/^97150/.test(cp)) return 'saint_martin';
  if (/^97133/.test(cp)) return 'saint_barthelemy';
  if (/^971/.test(cp)) return 'guadeloupe';
  if (/^972/.test(cp)) return 'martinique';
  if (/^973/.test(cp)) return 'guyane';
  if (/^974/.test(cp)) return 'reunion';
  if (/^975/.test(cp)) return 'saint_pierre_miquelon';
  if (/^976/.test(cp)) return 'mayotte';
  if (/^986/.test(cp)) return 'wallis_futuna';
  if (/^987/.test(cp)) return 'polynesie';
  if (/^988/.test(cp)) return 'nouvelle_caledonie';
  if (/^20[012]/.test(cp)) return 'corse';
  return 'metropole';
}

const deviner = devinerPrecis;

/** Les taux à proposer, selon le territoire et le régime. */
function tauxDisponibles(entreprise) {
  if (entreprise && entreprise.regime_tva === 'franchise') return [0];
  return territoire(entreprise).taux;
}

module.exports = {
  TERRITOIRES, DEPARTEMENTS, territoire, departement,
  deviner, devinerPrecis, tauxDisponibles,
};
