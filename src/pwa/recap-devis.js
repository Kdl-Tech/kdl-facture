'use strict';

const { calculerDocument, centimes } = require('../calculs');

/** Tous les devis actuellement émis, toutes années confondues. */
function recapitulerDevis(documents) {
  const devis = documents.filter(d => d.type === 'devis' && d.statut === 'emis')
    .sort((a, b) => String(b.date_emission || '').localeCompare(String(a.date_emission || ''))
      || b.id - a.id);
  let ht = 0; let ttc = 0;
  for (const d of devis) {
    const totaux = calculerDocument(d.lignes || []);
    ht += centimes(totaux.total_ht);
    ttc += centimes(totaux.total_ttc);
  }
  return { devis, nombre: devis.length, total_ht: ht / 100, total_ttc: ttc / 100 };
}

function recapitulerParClient(documents, clients) {
  const recap = recapitulerDevis(documents);
  const noms = new Map(clients.map(c => [c.id, c.nom]));
  const groupes = new Map();
  for (const devis of recap.devis) {
    const id = devis.client_id ?? null;
    if (!groupes.has(id)) groupes.set(id, []);
    groupes.get(id).push(devis);
  }
  return { ...recap, clients: [...groupes].map(([client_id, devis]) => ({
    client_id, nom: noms.get(client_id) || 'Client introuvable', ...recapitulerDevis(devis),
  })).sort((a, b) => a.nom.localeCompare(b.nom, 'fr') || (a.client_id || 0) - (b.client_id || 0)) };
}

module.exports = { recapitulerDevis, recapitulerParClient };
