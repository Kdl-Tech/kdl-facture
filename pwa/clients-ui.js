/**
 * L'écran « Clients » de la version installable.
 *
 * Un carnet d'adresses, pas un CRM : le nom, comment le joindre, où il est.
 * De quoi retrouver un client en deux secondes avant d'établir un devis ou
 * une facture — les mêmes fiches servent aux deux, via `depot.listerClients`
 * et `depot.enregistrerClient`, déjà utilisés par l'écran d'émission.
 *
 * Les données restent sur cet appareil (voir « Mes données » pour la
 * sauvegarde/restauration manuelle) : un client ajouté sur le téléphone
 * n'apparaît pas tout seul sur l'ordinateur.
 */

const $ = (s, racine = document) => racine.querySelector(s);

function echapper(texte) {
  return String(texte ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export function creerEcranClients({ depot, dire, racine }) {
  let clients = [];
  let brouillon = null;
  let recherche = '';

  function correspond(c, terme) {
    if (!terme) return true;
    const cle = terme.toLowerCase();
    return [c.nom, c.telephone, c.email, c.ville].some(
      (v) => String(v || '').toLowerCase().includes(cle),
    );
  }

  function formulaireClient() {
    const c = brouillon;
    const pro = c.type === 'entreprise';
    return `
      <div class="carte" style="margin-bottom:16px">
        <div class="titre">${c.id ? 'Modifier le client' : 'Nouveau client'}</div>
        <div class="grille">
          <label class="large">Nom<input id="c-nom" value="${echapper(c.nom)}" placeholder="Nom et prénom, ou raison sociale"></label>
          <label>Téléphone<input id="c-telephone" value="${echapper(c.telephone || '')}" type="tel" inputmode="tel"></label>
          <label>Courriel<input id="c-email" value="${echapper(c.email || '')}" type="email"></label>
          <label class="large">Adresse<input id="c-adresse" value="${echapper(c.adresse || '')}"></label>
          <label>Code postal<input id="c-cp" value="${echapper(c.code_postal || '')}"></label>
          <label>Ville<input id="c-ville" value="${echapper(c.ville || '')}"></label>
          <label>Type
            <select id="c-type">
              <option value="particulier" ${!pro ? 'selected' : ''}>Particulier</option>
              <option value="entreprise" ${pro ? 'selected' : ''}>Entreprise</option>
            </select>
          </label>
        </div>
        ${pro ? `
        <div class="grille" style="margin-top:10px">
          <label>SIRET<input id="c-siret" value="${echapper(c.siret || '')}" inputmode="numeric" placeholder="14 chiffres"></label>
          <label>SIREN<input id="c-siren" value="${echapper(c.siren || '')}" inputmode="numeric" placeholder="9 chiffres"></label>
        </div>
        <p class="secondaire" style="color:var(--texte-doux);margin:8px 0 0">
          Requis pour une facture (pas pour un devis) : la réforme l'exige pour l'acheminement.
        </p>` : ''}
        <label style="display:block;margin-top:10px">Notes
          <textarea id="c-note" rows="2" style="width:100%" placeholder="Repères utiles : accès, matériel connu…">${echapper(c.note || '')}</textarea>
        </label>
        <div class="suite" style="margin-top:16px">
          <button class="premier" id="c-enregistrer">Enregistrer</button>
          <button class="discret" id="c-abandonner">Abandonner</button>
        </div>
      </div>`;
  }

  function lireFormulaire() {
    brouillon.nom = $('#c-nom').value.trim();
    brouillon.telephone = $('#c-telephone').value.trim();
    brouillon.email = $('#c-email').value.trim();
    brouillon.adresse = $('#c-adresse').value.trim();
    brouillon.code_postal = $('#c-cp').value.trim();
    brouillon.ville = $('#c-ville').value.trim();
    brouillon.type = $('#c-type').value;
    brouillon.note = $('#c-note').value.trim();
    const siret = $('#c-siret');
    const siren = $('#c-siren');
    if (siret) brouillon.siret = siret.value.replace(/\s/g, '');
    if (siren) brouillon.siren = siren.value.replace(/\s/g, '');
    if (brouillon.type !== 'entreprise') { brouillon.siret = ''; brouillon.siren = ''; }
    if (!brouillon.siren && /^\d{14}$/.test(brouillon.siret || '')) {
      brouillon.siren = brouillon.siret.slice(0, 9);
    }
    brouillon.pays = brouillon.pays || 'FR';
  }

  function listeClients() {
    const filtres = clients.filter((c) => correspond(c, recherche));
    if (!clients.length) {
      return `
        <div class="vide">
          <div class="grand">Aucun client pour l'instant</div>
          <p>Ajoutez votre premier client : il sera proposé au moment<br>
          d'établir un devis ou une facture.</p>
        </div>`;
    }
    if (!filtres.length) {
      return `<div class="vide"><p>Aucun client ne correspond à « ${echapper(recherche)} ».</p></div>`;
    }
    const lignes = filtres.map((c) => `
      <tr data-client="${c.id}" tabindex="0">
        <td>
          <div class="principal">${echapper(c.nom) || '—'}</div>
          <div class="secondaire">${echapper([c.code_postal, c.ville].filter(Boolean).join(' ')) || '—'}</div>
        </td>
        <td class="masquable secondaire">${echapper(c.telephone || '—')}</td>
        <td class="masquable secondaire">${echapper(c.email || '—')}</td>
        <td><span class="pastille ${c.type === 'entreprise' ? 'conforme' : 'statut'}">${c.type === 'entreprise' ? 'Entreprise' : 'Particulier'}</span></td>
      </tr>`).join('');
    return `
      <table class="tableau">
        <thead>
          <tr><th>Client</th><th class="masquable">Téléphone</th><th class="masquable">Courriel</th><th>Type</th></tr>
        </thead>
        <tbody>${lignes}</tbody>
      </table>`;
  }

  async function dessiner() {
    clients = (await depot.listerClients()).slice();

    if (brouillon) {
      racine.innerHTML = formulaireClient();
      brancherFormulaire();
      return;
    }

    racine.innerHTML = `
      <div class="barre-liste">
        <h2>Mes clients</h2>
        <div class="espace"></div>
        <input type="search" id="c-recherche" placeholder="Chercher un client…"
          aria-label="Chercher un client" value="${echapper(recherche)}">
        <button class="premier" id="c-nouveau">Nouveau client</button>
      </div>
      <p class="secondaire">${clients.length} client${clients.length === 1 ? '' : 's'} enregistré${clients.length === 1 ? '' : 's'}.
      Ajoutez une fiche avec « Nouveau client », puis cliquez sur son nom pour la compléter au fil des interventions.</p>
      ${listeClients()}`;

    $('#c-recherche').addEventListener('input', async (e) => {
      recherche = e.target.value;
      const zone = racine.querySelector('.tableau, .vide');
      if (zone) zone.outerHTML = listeClients();
      racine.querySelectorAll('tr[data-client]').forEach(brancherLigne);
    });

    $('#c-nouveau').addEventListener('click', async () => {
      brouillon = {
        nom: '', telephone: '', email: '', adresse: '', code_postal: '', ville: '',
        type: 'particulier', note: '', pays: 'FR',
      };
      await dessiner();
    });

    racine.querySelectorAll('tr[data-client]').forEach(brancherLigne);
  }

  function brancherLigne(tr) {
    const ouvrir = async () => {
      const c = clients.find((x) => x.id === Number(tr.dataset.client));
      if (!c) return;
      brouillon = { ...c };
      await dessiner();
    };
    tr.addEventListener('click', ouvrir);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') ouvrir(); });
  }

  function brancherFormulaire() {
    // Lié à ce select précis (recréé à chaque rendu par innerHTML), pas délégué
    // sur `racine` : une délégation s'accumulerait à chaque re-rendu du formulaire.
    $('#c-type').addEventListener('change', () => { lireFormulaire(); dessiner(); });

    $('#c-enregistrer').addEventListener('click', async () => {
      lireFormulaire();
      if (!brouillon.nom) { dire('Le nom du client est nécessaire.', 'attention'); return; }
      await depot.enregistrerClient(brouillon);
      brouillon = null;
      await dessiner();
      dire('Client enregistré.', 'reussite');
    });

    $('#c-abandonner').addEventListener('click', async () => {
      brouillon = null;
      await dessiner();
    });
  }

  return { dessiner };
}
