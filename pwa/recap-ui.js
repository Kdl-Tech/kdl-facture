import { recapitulerParClient } from '../src/pwa/recap-devis.js';
import { calculerDocument } from '../src/calculs.js';

const echapper = texte => String(texte ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const euros = valeur => Number(valeur || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const jour = date => date ? String(date).slice(0, 10).split('-').reverse().join('/') : '—';

export function creerEcranRecap({ depot, racine, ouvrirDocument }) {
  async function dessiner() {
    const recap = recapitulerParClient(await depot.listerDocuments(), await depot.listerClients());
    racine.innerHTML = `
      <h2>Récapitulatif des devis par client</h2>
      <div class="carte" style="margin-bottom:16px">
        <p>Toutes années confondues · ${recap.nombre} devis émis · ${recap.clients.length} client${recap.clients.length === 1 ? '' : 's'}</p>
        <div class="paire"><dt>Total HT</dt><dd>${euros(recap.total_ht)}</dd></div>
        <div class="paire fort"><dt>Total TTC</dt><dd>${euros(recap.total_ttc)}</dd></div>
        <p class="secondaire">Seuls les devis émis sont comptabilisés. Ces montants ne correspondent pas à des encaissements.</p>
      </div>
      ${recap.clients.map(client => `
        <section class="carte" style="margin-bottom:16px">
          <h3>${echapper(client.nom)}</h3>
          <p>${client.nombre} devis émis · ${euros(client.total_ht)} HT · ${euros(client.total_ttc)} TTC</p>
          <table class="tableau">
            <thead><tr><th>Devis</th><th>Date</th><th class="nombre">Total TTC</th></tr></thead>
            <tbody>${client.devis.map(devis => `
              <tr>
                <td><button class="discret" data-ouvrir-devis="${Number(devis.id)}"
                  aria-label="Ouvrir le devis ${echapper(devis.numero || '')}">${echapper(devis.numero || 'Sans numéro')}</button></td>
                <td>${echapper(jour(devis.date_emission))}</td>
                <td class="nombre">${euros(calculerDocument(devis.lignes || []).total_ttc)}</td>
              </tr>`).join('')}</tbody>
          </table>
        </section>`).join('') || '<div class="vide"><p>Aucun devis émis pour le moment. Les devis apparaîtront ici après leur émission.</p></div>'}`;
    racine.querySelectorAll('[data-ouvrir-devis]').forEach(bouton => {
      bouton.addEventListener('click', () => ouvrirDocument(Number(bouton.dataset.ouvrirDevis)));
    });
  }
  return { dessiner };
}
