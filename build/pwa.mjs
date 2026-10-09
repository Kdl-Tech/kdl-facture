/**
 * Construit la version installable (PWA) dans `dist-pwa/`.
 *
 * Le principe : un seul bundle, aucune ressource externe, tout hors ligne.
 * Le moteur métier — calculs, Factur-X, réception — est le même que celui du
 * logiciel de bureau ; il n'est pas réécrit, il est simplement empaqueté pour
 * le navigateur. Un test du dépôt vérifie qu'il n'y entre jamais de dépendance
 * à Node, sans quoi cette construction se mettrait à échouer.
 *
 *   node build/pwa.mjs
 */

import { build } from 'esbuild';
import {
  mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(RACINE, 'pwa');
const SORTIE = join(RACINE, 'dist-pwa');
const VERSION = JSON.parse(readFileSync(join(RACINE, 'package.json'), 'utf-8')).version;

/**
 * La clé publique des licences est gravée dans le bundle. Son absence n'est pas
 * une erreur de construction : le logiciel se construit sans, et refuse alors
 * toutes les licences plutôt que d'en accepter n'importe laquelle.
 */
function clePublique() {
  const fichier = join(RACINE, 'licence-publique.json');
  if (!existsSync(fichier)) {
    console.warn('⚠ licence-publique.json absent : les licences Pro seront toutes refusées.');
    return '';
  }
  return JSON.parse(readFileSync(fichier, 'utf-8')).cle;
}

function icones() {
  const logo = join(RACINE, 'src', 'logo-facture.png');
  // Pillow est déjà présent sur le poste ; aucune bibliothèque n'est ajoutée au
  // projet pour trois images. Le logo n'est jamais redessiné ni recoloré : il
  // est redimensionné, et posé tel quel au centre de l'icône masquable.
  const script = `
import sys
from PIL import Image
source = Image.open(${JSON.stringify(logo)}).convert('RGBA')
for taille in (192, 512):
    source.resize((taille, taille), Image.LANCZOS).save(
        ${JSON.stringify(SORTIE)} + f'/icone-{taille}.png')
# Icône masquable : le système en rogne les bords, le logo doit donc tenir dans
# les 80 % centraux, sur le bleu KDL.
fond = Image.new('RGBA', (512, 512), (31, 82, 120, 255))
logo = source.resize((360, 360), Image.LANCZOS)
fond.paste(logo, (76, 76), logo)
fond.save(${JSON.stringify(SORTIE)} + '/icone-maskable-512.png')
print('icônes générées')
`;
  try {
    execFileSync('python3', ['-c', script], { stdio: 'pipe' });
    return true;
  } catch (erreur) {
    console.warn('⚠ icônes non générées :', String(erreur.stderr || erreur.message).trim());
    return false;
  }
}

async function construire() {
  if (existsSync(SORTIE)) rmSync(SORTIE, { recursive: true, force: true });
  mkdirSync(SORTIE, { recursive: true });

  const resultat = await build({
    entryPoints: [join(SOURCE, 'app.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome100', 'firefox100', 'safari16'],
    minify: true,
    sourcemap: false,
    outfile: join(SORTIE, 'app.js'),
    define: {
      __VERSION__: JSON.stringify(VERSION),
      __CLE_LICENCE__: JSON.stringify(clePublique()),
    },
    metafile: true,
  });

  /*
   * Les fichiers chargés par la page portent la version dans leur URL.
   * Sans cela, un intermédiaire (Cloudflare met le statique en cache quatre
   * heures) continue de servir l'ancien `app.js` après une mise à jour, et le
   * correctif n'atteint personne. `index.html` et `sw.js`, eux, ne sont jamais
   * mis en cache : ce sont les deux points d'entrée fiables.
   */
  const versionnes = [
    'app.js', 'style.css', 'manifest.webmanifest', 'kdl-theme.css', 'kdl-theme.js', 'kdl-promo.js',
  ];
  let page = readFileSync(join(SOURCE, 'index.html'), 'utf-8');
  for (const fichier of versionnes) {
    page = page.replaceAll(`"./${fichier}"`, `"./${fichier}?v=${VERSION}"`);
  }
  writeFileSync(join(SORTIE, 'index.html'), page);
  copyFileSync(join(SOURCE, 'style.css'), join(SORTIE, 'style.css'));
  copyFileSync(join(SOURCE, 'manifest.webmanifest'), join(SORTIE, 'manifest.webmanifest'));

  // Kit thème « Lagon » commun aux apps KDL (~/KDL_STANDARDS/theme-lagon) :
  // copié tel quel, l'app reste 100 % locale et fonctionne hors ligne.
  copyFileSync(join(SOURCE, 'kdl-theme.css'), join(SORTIE, 'kdl-theme.css'));
  copyFileSync(join(SOURCE, 'kdl-theme.js'), join(SORTIE, 'kdl-theme.js'));
  copyFileSync(join(SOURCE, 'kdl-promo.js'), join(SORTIE, 'kdl-promo.js'));
  mkdirSync(join(SORTIE, 'fonts'), { recursive: true });
  for (const fichier of readdirSync(join(SOURCE, 'fonts'))) {
    copyFileSync(join(SOURCE, 'fonts', fichier), join(SORTIE, 'fonts', fichier));
  }

  // La version est gravée dans le service worker : c'est elle qui déclenche le
  // renouvellement du cache. Sans elle, une mise à jour passerait inaperçue.
  const sw = readFileSync(join(SOURCE, 'sw.js'), 'utf-8').replaceAll('__VERSION__', VERSION);
  writeFileSync(join(SORTIE, 'sw.js'), sw);

  // Les polices du PDF et le profil colorimétrique voyagent avec l'application :
  // sans eux, pas de PDF/A-3 conforme dans le navigateur.
  mkdirSync(join(SORTIE, 'ressources'), { recursive: true });
  for (const fichier of ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf', 'sRGB_IEC61966_2_1.icc']) {
    copyFileSync(join(RACINE, 'src', 'polices', fichier), join(SORTIE, 'ressources', fichier));
  }
  copyFileSync(join(RACINE, 'src', 'logo-facture.png'), join(SORTIE, 'ressources', 'logo-facture.png'));

  // Le moteur PDF reste un fichier à part, chargé seulement au moment d'émettre :
  // il pèse quelques mégaoctets, et la plupart des ouvertures ne servent qu'à
  // consulter des factures reçues.
  copyFileSync(
    join(RACINE, 'node_modules', 'pdfkit', 'js', 'pdfkit.standalone.js'),
    join(SORTIE, 'pdfkit.standalone.js'),
  );

  icones();

  const poids = Object.entries(resultat.metafile.outputs)
    .map(([nom, o]) => `${nom.split('/').pop()} ${(o.bytes / 1024).toFixed(0)} Ko`)
    .join(', ');
  console.log(`KDL Facture ${VERSION} → ${SORTIE}`);
  console.log(`bundle : ${poids}`);
}

construire().catch((erreur) => {
  console.error('Construction impossible :', erreur.message);
  process.exit(1);
});
