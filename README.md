# KDL Facture

Facturation électronique française, conforme à la réforme. Un exécutable par
système, aucune installation, les données restent sur la machine.

Développé par **KDL TECH** — maintenance informatique, développement web,
cybersécurité.

---

## Ce que ça fait

**Des factures électroniques Factur-X**, profil EN 16931 : un PDF/A-3 lisible à
l'œil, avec le XML structuré agrafé dedans. Le logiciel comptable du client y
récupère les données sans aucune ressaisie.

**Les mentions exigées par la réforme** — SIREN du client, adresse de livraison
quand elle diffère, catégorie d'opération, option de TVA sur les débits.

**Treize territoires fiscaux**, parce que la TVA n'est pas la même partout en
France : 20 % en métropole, taux particuliers en Corse, 8,5 % aux Antilles et à
La Réunion, aucune TVA en Guyane ni à Mayotte, collectivités à fiscalité propre.
Le territoire est proposé d'après le code postal et reste corrigeable.

**La franchise en base par défaut** — le régime d'une entreprise qui démarre. Les
factures ne portent alors aucune TVA, la mention de l'article 293 B est ajoutée,
et le tableau de bord suit le chiffre d'affaires encaissé de l'année avec alerte
à l'approche du plafond. Les entreprises assujetties basculent en un clic.

**Des calculs exacts au centime** : tout en centimes entiers, TVA regroupée par
taux et jamais additionnée ligne à ligne.

**Une facture émise ne bouge plus** : numérotation continue attribuée à
l'émission seulement, empreinte SHA-256, correction par avoir uniquement. Un
journal chaîné enregistre chaque acte — modifier une ligne casse la chaîne, et
le logiciel le signale.

**Un contrôle de conformité** refuse d'émettre une facture qui serait rejetée
chez le client, en disant précisément ce qui manque.

Également : devis, avoirs, acomptes, encaissements partiels, suivi des impayés,
export comptable CSV, plusieurs entreprises dans la même base.

## Ce que ça ne fait pas

**La transmission.** L'article 289 bis du CGI impose le passage par une
plateforme agréée. KDL Facture produit le fichier conforme ; le dépôt sur la
plateforme est une étape distincte.

**L'e-reporting** des ventes aux particuliers — obligation applicable au
1er septembre 2027.

---

## Installation

Aucune. Téléchargez l'exécutable de votre système et lancez-le : l'interface
s'ouvre dans le navigateur sur `http://127.0.0.1:4310`, en loopback seul.

| Système | Fichier |
|---|---|
| Linux x64 | `KDL-Facture` |
| Windows x64 | `KDL-Facture.exe` |
| macOS Apple Silicon | `KDL-Facture-mac` — clic droit → Ouvrir au premier lancement |

Les données vivent dans un seul fichier SQLite, à sauvegarder :

- Linux `~/.local/share/kdl-facture/facture.db`
- Windows `%APPDATA%\kdl-facture\facture.db`
- macOS `~/Library/Application Support/kdl-facture/facture.db`

---

## Développement

```bash
npm install          # dépendances
npm test             # 44 tests, sans réseau ni base sur disque
npm start            # serveur local sur le port 4310
node build/construire.mjs   # les trois exécutables
```

La construction attend les runtimes Node officiels dans `build/runtimes/`.
Deux pièges à connaître : le blob doit être préparé par la **même version de
Node** que celle injectée, et le mécanisme d'assets du format SEA ne supporte
pas les fichiers binaires — l'interface est donc gravée en base64 dans le
bundle.

### Architecture

| Fichier | Rôle |
|---|---|
| `src/calculs.js` | Arithmétique en centimes, ventilation de TVA par taux |
| `src/territoires.js` | Les treize territoires fiscaux et les 107 départements |
| `src/facturx.js` | XML CII EN 16931 et contrôle de conformité |
| `src/pdf.js` | PDF/A-3 avec le XML embarqué |
| `src/factures.js` | Émission, numérotation, avoirs, journal chaîné |
| `src/api.js` | API HTTP, loopback seul |
| `src/db.js` | SQLite via `node:sqlite`, migrations douces |

---

## Éditions

| | Découverte | Pro |
|---|---|---|
| Prix | gratuit | 49 € une fois |
| Factures Factur-X conformes | ✓ | ✓ |
| Journal inaltérable, avoirs | ✓ | ✓ |
| Tous les territoires et régimes de TVA | ✓ | ✓ |
| Factures par année civile | 15 | illimitées |
| Catalogue, devis, acomptes | — | ✓ |
| Export comptable, suivi du plafond | — | ✓ |
| Plusieurs entreprises | — | ✓ |

**Ce qui rend une facture conforme reste gratuit.** Une TPE ne doit pas payer
pour respecter la loi : Découverte produit des factures pleinement valides, sans
filigrane ni mention publicitaire. Ce qui se paie, c'est le volume et le confort.

La licence est un fichier signé posé à côté des données. Aucune activation en
ligne, aucun abonnement : le logiciel tourne sur une machine sans Internet.

## Licence

Source visible — voir [LICENCE.md](LICENCE.md). Vous pouvez lire, auditer,
compiler et utiliser ; vous ne pouvez pas revendre. Le code d'un logiciel qui
calcule vos factures ne devrait pas être une boîte noire.

## Sources

Les règles appliquées viennent des textes officiels, listés dans l'onglet
**Références** du logiciel : impots.gouv.fr, Légifrance, service-public.fr,
URSSAF. En cas de doute, la source officielle fait foi — pas ce logiciel.
