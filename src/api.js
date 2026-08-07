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
const { TERRITOIRES, territoire, departement, devinerPrecis, tauxDisponibles } = require('./territoires');
const { capacites, lireLicence, poserLicence, retirerLicence, PRO } = require('./edition');

function creerApi(db, options = {}) {
  const cheminBase = options.base || '';
  let licence = lireLicence(cheminBase);
  const service = new Service(db, licence);
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

  /** Le taux à proposer : zéro en franchise, sinon celui choisi par l'entreprise. */
  const tauxParDefaut = (e) => {
    if (!e || e.regime_tva === 'franchise') return 0;
    const zone = territoire(e);
    if (!zone.tva) return 0;
    const choisi = Number(e.tva_taux_defaut);
    // Un taux qui n'existe pas sur le territoire ne doit pas être proposé :
    // on retombe sur le taux normal de la zone.
    return zone.taux.includes(choisi) ? choisi : zone.taux_normal;
  };

  // — Entreprise ———————————————————————————————————————————
  api.get('/entreprise', (req, res) => repondre(res, () => entrepriseCourante() || {}));

  api.put('/entreprise', (req, res) => repondre(res, () => {
    const actuelle = entrepriseCourante();
    const champs = ['nom', 'forme_juridique', 'siren', 'siret', 'tva_intra', 'rcs', 'capital',
      'adresse', 'code_postal', 'ville', 'pays', 'email', 'telephone', 'iban', 'bic',
      'regime_tva', 'seuil_franchise', 'tva_taux_defaut', 'territoire', 'activite', 'assurance_pro',
      'tva_sur_debits', 'penalites_taux', 'escompte'];
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

  /** Les seuls types de client qui existent — le contrôle de conformité en dépend. */
  const TYPES_CLIENT = ['entreprise', 'particulier', 'public'];

  /** Les colonnes modifiables d'un client. Toute autre clé est ignorée. */
  const CHAMPS_CLIENT = ['type', 'nom', 'contact', 'siren', 'siret', 'tva_intra', 'code_service',
    'numero_engagement', 'adresse', 'code_postal', 'ville', 'pays', 'email', 'telephone',
    'livraison_adresse', 'livraison_code_postal', 'livraison_ville', 'livraison_pays',
    'delai_paiement_jours', 'notes', 'actif'];

  api.post('/clients', (req, res) => repondre(res, () => {
    const e = entrepriseCourante();
    if (!e) throw new ErreurMetier("Renseignez d'abord votre entreprise.");
    // Un type inconnu — « professionnel » au lieu d'« entreprise », par exemple —
    // était accepté en silence, et le client perdait alors l'obligation de
    // SIREN sans que personne ne s'en aperçoive. On refuse plutôt que de laisser
    // passer une facture qui sera rejetée des mois plus tard.
    if (req.body.type !== undefined && !TYPES_CLIENT.includes(req.body.type)) {
      throw new ErreurMetier(
        `Type de client inconnu : « ${req.body.type} ». Valeurs acceptées : ${TYPES_CLIENT.join(', ')}.`);
    }
    const champs = CHAMPS_CLIENT.filter((c) => c !== 'actif');
    const valeurs = champs.map((c) => (req.body[c] !== undefined ? req.body[c] : (c === 'delai_paiement_jours' ? 30 : (c === 'type' ? 'entreprise' : (c === 'pays' ? 'FR' : '')))));
    const info = db.prepare(`INSERT INTO clients (entreprise_id, ${champs.join(', ')}) VALUES (?, ${champs.map(() => '?').join(', ')})`)
      .run(e.id, ...valeurs);
    return db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid);
  }));

  api.put('/clients/:id', (req, res) => repondre(res, () => {
    if (req.body.type !== undefined && !TYPES_CLIENT.includes(req.body.type)) {
      throw new ErreurMetier(
        `Type de client inconnu : « ${req.body.type} ». Valeurs acceptées : ${TYPES_CLIENT.join(', ')}.`);
    }
    // Les noms de colonnes viennent de cette liste, jamais du corps de la
    // requête : sans cela, une clé comme « nom = (SELECT iban FROM entreprises) »
    // s'écrivait telle quelle dans le SQL et permettait de lire ou d'écrire
    // n'importe quoi dans la base.
    const champs = CHAMPS_CLIENT.filter((c) => req.body[c] !== undefined);
    if (!champs.length) return service.client(req.params.id);
    const client = service.client(req.params.id);
    const e = entrepriseCourante();
    if (!client || !e || client.entreprise_id !== e.id) {
      throw new ErreurMetier("Ce client n'appartient pas à votre entreprise.");
    }
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
    if (!e) throw new ErreurMetier("Renseignez d'abord votre entreprise.");
    exigerPro('catalogue', 'Le catalogue de prestations');
    const info = db.prepare(`
      INSERT INTO articles (entreprise_id, reference, designation, nature, unite, prix_ht, tva_taux)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(e.id, req.body.reference || '', req.body.designation || '', req.body.nature || 'service',
      req.body.unite || 'heure', Number(req.body.prix_ht) || 0,
      req.body.tva_taux !== undefined ? Number(req.body.tva_taux) : tauxParDefaut(e));
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

  /** Les territoires fiscaux et leurs taux, pour que l'interface les propose. */
  api.get('/territoires', (req, res) => repondre(res, () => {
    const e = entrepriseCourante();
    return {
      liste: Object.entries(TERRITOIRES).map(([cle, v]) => ({
        cle,
        nom: v.nom,
        groupe: v.groupe,
        taux: v.taux,
        taux_normal: v.taux_normal,
        tva: v.tva,
        base: v.base || '',
        impose: v.impose || [],
        permet: v.permet || [],
        mention: v.mention || '',
      })),
      courant: e ? territoire(e) : null,
      taux_disponibles: tauxDisponibles(e),
      suggestion: e ? devinerPrecis(e.code_postal) : 'metropole',
      departement: e ? departement(e.code_postal) : null,
    };
  }));

  // — Édition ——————————————————————————————————————————————
  api.get('/edition', (req, res) => repondre(res, () => {
    const e = entrepriseCourante();
    const capa = capacites(licence);
    return {
      edition: licence.edition,
      nom: capa.nom,
      titulaire: licence.titulaire || '',
      refus: licence.refus || '',
      capacites: capa,
      factures_cette_annee: e ? service.facturesEmisesCetteAnnee(e.id) : 0,
      plafond: Number.isFinite(capa.factures_par_an) ? capa.factures_par_an : null,
    };
  }));

  api.post('/edition/licence', (req, res) => repondre(res, () => {
    const r = poserLicence(cheminBase, req.body.titulaire, req.body.cle);
    if (!r.ok) throw new ErreurMetier(r.message);
    licence = lireLicence(cheminBase);
    service.licence = licence;
    return { edition: licence.edition, titulaire: licence.titulaire };
  }));

  api.delete('/edition/licence', (req, res) => repondre(res, () => {
    retirerLicence(cheminBase);
    licence = lireLicence(cheminBase);
    service.licence = licence;
    return { edition: licence.edition };
  }));

  /** Refuse une route réservée, en expliquant plutôt qu'en se taisant. */
  const exigerPro = (quoi, quoiDit) => {
    if (!capacites(licence)[quoi]) {
      throw new ErreurMetier(`${quoiDit} fait partie de l'édition Pro.`);
    }
  };

  // — Pilotage —————————————————————————————————————————————
  api.get('/tableau-de-bord', (req, res) => repondre(res, () => {
    const e = entrepriseCourante();
    if (!e) return { entreprise_absente: true };
    return {
      entreprise: e,
      stats: service.statistiques(e.id),
      franchise: capacites(licence).suivi_plafond ? service.suiviFranchise(e.id) : null,
      edition: { nom: capacites(licence).nom, code: licence.edition },
      territoire: territoire(e),
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
    if (!capacites(licence).export_comptable) {
      return res.status(422).json({ erreur: "L'export comptable fait partie de l'édition Pro." });
    }
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
