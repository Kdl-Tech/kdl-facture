'use strict';

/**
 * L'API HTTP. Elle ne parle qu'en loopback : ce logiciel garde les données
 * comptables de Karim et de ses clients sur leur propre machine, et rien ne
 * sort sans une action explicite.
 */

const express = require('express');
const { Service, ErreurMetier } = require('./factures');
const { genererPDF } = require('./pdf');
const { genererXML, verifier } = require('./facturx');
const { calculerDocument } = require('./calculs');

function creerApi(db) {
  const service = new Service(db);
  const api = express.Router();
  api.use(express.json({ limit: '2mb' }));

  /** Erreur métier : ce n'est pas un plantage, c'est un refus expliqué. */
  const repondre = (res, action) => {
    try {
      const r = action();
      res.json(r === undefined ? { ok: true } : r);
    } catch (e) {
      if (e instanceof ErreurMetier) {
        res.status(422).json({ erreur: e.message, anomalies: e.anomalies });
      } else {
        res.status(500).json({ erreur: e.message });
      }
    }
  };

  const entrepriseCourante = () =>
    db.prepare('SELECT * FROM entreprises ORDER BY id LIMIT 1').get();

  // — Entreprise ———————————————————————————————————————————
  api.get('/entreprise', (req, res) => repondre(res, () => entrepriseCourante() || {}));

  api.put('/entreprise', (req, res) => repondre(res, () => {
    const actuelle = entrepriseCourante();
    const champs = ['nom', 'forme_juridique', 'siren', 'siret', 'tva_intra', 'rcs', 'capital',
      'adresse', 'code_postal', 'ville', 'pays', 'email', 'telephone', 'iban', 'bic',
      'regime_tva', 'tva_sur_debits', 'penalites_taux', 'escompte'];
    const valeurs = champs.map((c) => (req.body[c] !== undefined ? req.body[c] : (actuelle ? actuelle[c] : '')));
    if (actuelle) {
      db.prepare(`UPDATE entreprises SET ${champs.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...valeurs, actuelle.id);
      return entrepriseCourante();
    }
    db.prepare(`INSERT INTO entreprises (${champs.join(', ')}) VALUES (${champs.map(() => '?').join(', ')})`)
      .run(...valeurs);
    return entrepriseCourante();
  }));

  // — Clients ——————————————————————————————————————————————
  api.get('/clients', (req, res) => repondre(res, () => {
    const e = entrepriseCourante();
    if (!e) return [];
    return db.prepare('SELECT * FROM clients WHERE entreprise_id = ? AND actif = 1 ORDER BY nom').all(e.id);
  }));

  api.post('/clients', (req, res) => repondre(res, () => {
    const e = entrepriseCourante();
    if (!e) throw new ErreurMetier("Renseignez d'abord votre entreprise.");
    const champs = ['type', 'nom', 'contact', 'siren', 'siret', 'tva_intra', 'code_service',
      'numero_engagement', 'adresse', 'code_postal', 'ville', 'pays', 'email', 'telephone',
      'livraison_adresse', 'livraison_code_postal', 'livraison_ville', 'livraison_pays',
      'delai_paiement_jours', 'notes'];
    const valeurs = champs.map((c) => (req.body[c] !== undefined ? req.body[c] : (c === 'delai_paiement_jours' ? 30 : (c === 'type' ? 'entreprise' : (c === 'pays' ? 'FR' : '')))));
    const info = db.prepare(`INSERT INTO clients (entreprise_id, ${champs.join(', ')}) VALUES (?, ${champs.map(() => '?').join(', ')})`)
      .run(e.id, ...valeurs);
    return db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid);
  }));

  api.put('/clients/:id', (req, res) => repondre(res, () => {
    const champs = Object.keys(req.body).filter((c) => c !== 'id' && c !== 'entreprise_id');
    if (!champs.length) return service.client(req.params.id);
    db.prepare(`UPDATE clients SET ${champs.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...champs.map((c) => req.body[c]), req.params.id);
    return service.client(req.params.id);
  }));

  api.delete('/clients/:id', (req, res) => repondre(res, () => {
    const lie = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE client_id = ?').get(req.params.id).n;
    if (lie > 0) {
      // On n'efface pas un client qui a des factures : la comptabilité doit
      // rester lisible. On le retire simplement des listes.
      db.prepare('UPDATE clients SET actif = 0 WHERE id = ?').run(req.params.id);
      return { archive: true };
    }
    db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
    return { supprime: true };
  }));

  // — Articles —————————————————————————————————————————————
  api.get('/articles', (req, res) => repondre(res, () => {
    const e = entrepriseCourante();
    if (!e) return [];
    return db.prepare('SELECT * FROM articles WHERE entreprise_id = ? AND actif = 1 ORDER BY designation').all(e.id);
  }));

  api.post('/articles', (req, res) => repondre(res, () => {
    const e = entrepriseCourante();
    const info = db.prepare(`
      INSERT INTO articles (entreprise_id, reference, designation, nature, unite, prix_ht, tva_taux)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(e.id, req.body.reference || '', req.body.designation || '', req.body.nature || 'service',
      req.body.unite || 'heure', Number(req.body.prix_ht) || 0, Number(req.body.tva_taux) ?? 20);
    return db.prepare('SELECT * FROM articles WHERE id = ?').get(info.lastInsertRowid);
  }));

  api.delete('/articles/:id', (req, res) => repondre(res, () => {
    db.prepare('UPDATE articles SET actif = 0 WHERE id = ?').run(req.params.id);
    return { archive: true };
  }));

  // — Documents ————————————————————————————————————————————
  api.get('/documents', (req, res) => repondre(res, () => {
    const e = entrepriseCourante();
    if (!e) return [];
    return service.liste(e.id, req.query);
  }));

  api.get('/documents/:id', (req, res) => repondre(res, () => {
    const d = service.document(req.params.id);
    if (!d) throw new ErreurMetier('Document introuvable.');
    return d;
  }));

  api.post('/documents', (req, res) => repondre(res, () => {
    const e = entrepriseCourante();
    if (!e) throw new ErreurMetier("Renseignez d'abord votre entreprise.");
    return service.creer(e.id, req.body);
  }));

  api.put('/documents/:id', (req, res) => repondre(res, () => service.modifier(req.params.id, req.body)));

  api.delete('/documents/:id', (req, res) => repondre(res, () => service.supprimerBrouillon(req.params.id)));

  api.post('/documents/:id/emettre', (req, res) => repondre(res, () => service.emettre(req.params.id)));

  api.post('/documents/:id/paiements', (req, res) => repondre(res, () => service.encaisser(req.params.id, req.body)));

  api.post('/documents/:id/avoir', (req, res) => repondre(res, () => service.creerAvoir(req.params.id, req.body)));

  /** Contrôle de conformité à la demande, sans rien émettre. */
  api.get('/documents/:id/controle', (req, res) => repondre(res, () => {
    const d = service.document(req.params.id);
    if (!d) throw new ErreurMetier('Document introuvable.');
    return verifier(d);
  }));

  api.get('/documents/:id/pdf', async (req, res) => {
    try {
      const d = service.document(req.params.id);
      if (!d) return res.status(404).json({ erreur: 'Document introuvable.' });
      const pdf = await genererPDF(d);
      const nom = `${d.document.numero || 'brouillon'}.pdf`.replace(/[^\w.-]/g, '_');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${req.query.telecharger ? 'attachment' : 'inline'}; filename="${nom}"`);
      return res.end(pdf);
    } catch (e) {
      return res.status(500).json({ erreur: e.message });
    }
  });

  api.get('/documents/:id/xml', (req, res) => {
    const d = service.document(req.params.id);
    if (!d) return res.status(404).json({ erreur: 'Document introuvable.' });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="factur-x-${d.document.numero || 'brouillon'}.xml"`);
    return res.end(genererXML(d));
  });

  /** Aperçu des totaux pendant la saisie, sans rien enregistrer. */
  api.post('/apercu', (req, res) => repondre(res, () => calculerDocument(req.body.lignes || [], { acompte: req.body.acompte })));

  // — Pilotage —————————————————————————————————————————————
  api.get('/tableau-de-bord', (req, res) => repondre(res, () => {
    const e = entrepriseCourante();
    if (!e) return { entreprise_absente: true };
    return {
      entreprise: e,
      stats: service.statistiques(e.id),
      impayes: service.impayes(e.id),
      brouillons: service.liste(e.id, { statut: 'brouillon' }),
      derniers: service.liste(e.id).slice(0, 8),
      journal: service.verifierJournal(),
    };
  }));

  api.get('/journal', (req, res) => repondre(res, () =>
    db.prepare('SELECT * FROM journal ORDER BY id DESC LIMIT 200').all()));

  /** Export comptable : ce que réclame un expert-comptable, en CSV. */
  api.get('/export/ventes.csv', (req, res) => {
    const e = entrepriseCourante();
    if (!e) return res.status(400).end('Aucune entreprise.');
    const docs = service.liste(e.id).filter((d) => d.statut !== 'brouillon');
    const lignes = ['numero;type;date;client;siret;total_ht;total_tva;total_ttc;encaisse;statut'];
    for (const d of docs) {
      const c = service.document(d.id);
      lignes.push([
        d.numero, d.type, d.date_emission, `"${(d.client_nom || '').replace(/"/g, '""')}"`,
        c.client.siret || c.client.siren || '',
        c.totaux.total_ht.toFixed(2), c.totaux.total_tva.toFixed(2), c.totaux.total_ttc.toFixed(2),
        Number(d.verse || 0).toFixed(2), d.statut,
      ].join(';'));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ventes.csv"');
    return res.end(`﻿${lignes.join('\n')}`);
  });

  return api;
}

module.exports = { creerApi };
