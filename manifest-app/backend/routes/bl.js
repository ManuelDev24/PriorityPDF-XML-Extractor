// routes/bl.js — B/L, sus items de carga y los contenedores
//
// Extraído de server.js (paso 5 de la separación backend/frontend).

const express = require('express');
const db = require('../db/connection');

/** @typedef {import('../types').BLRow} BLRow */
/** @typedef {import('../types').CargoItemRow} CargoItemRow */
const { generateTxtLine1, generateTxtLine2 } = require('../services/txtGenerator');

const router = express.Router();

// ── ACTUALIZAR B/L ───────────────────────────────────────────────────────────
const CAMPOS_EDITABLES_BL = [
  'goods_name','package_qty','gross_weight','value','package_unit_code',
  'consignor_name','consignor_document_no','consignor_document_type',
  'consignor_tel','consignor_email','consignor_street','consignor_city','consignor_zip',
  'consignee_name','consignee_document_no','consignee_document_type',
  'consignee_tel','consignee_email','consignee_street','consignee_city','consignee_zip',
  'notify_name','notify_document_no','notify_street','notify_city',
  'hacienda_item_code','hacienda_tariff','hacienda_container_no','hacienda_client_ss',
  'hacienda_client_ivu','status','notes','unloading_port_code',
];

router.put('/api/bl/:id', (req, res) => {
  const sets = []; const vals = [];
  CAMPOS_EDITABLES_BL.forEach(f => {
    if (req.body[f] !== undefined) { sets.push(`${f}=?`); vals.push(req.body[f]); }
  });
  if (sets.length) {
    sets.push(`modified_at=datetime('now')`);
    vals.push(req.params.id);
    db.prepare(`UPDATE bills_of_lading SET ${sets.join(',')} WHERE id=?`).run(...vals);
  }
  res.json({ ok: true });
});

// ── ELIMINAR UN B/L (y sus items y vínculos de contenedor) ───────────────────
router.delete('/api/bl/:id', (req, res) => {
  /** @type {BLRow} */
  const bl = db.prepare('SELECT * FROM bills_of_lading WHERE id=?').get(req.params.id);
  if (!bl) return res.status(404).json({ error: 'B/L no encontrado' });

  db.prepare('DELETE FROM bl_cargo_items WHERE bl_id=?').run(bl.id);
  db.prepare('DELETE FROM container_bl WHERE bl_no=? AND manifest_id=?').run(bl.bl_no, bl.manifest_id);
  db.prepare(`
    DELETE FROM containers
    WHERE manifest_id=?
      AND container_no NOT IN (SELECT container_no FROM container_bl WHERE manifest_id=?)
  `).run(bl.manifest_id, bl.manifest_id);
  db.prepare('DELETE FROM bills_of_lading WHERE id=?').run(bl.id);

  res.json({ ok: true, deleted: bl.bl_no, manifest_id: bl.manifest_id });
});

// ── PREVIEW TXT DE UN B/L ────────────────────────────────────────────────────
router.get('/api/bl/:id/txt-preview', (req, res) => {
  const bl = db.prepare(`
    SELECT b.*, m.voyage_no, m.manifest_no, m.carrier_code, m.vessel_name,
           m.departure_date, m.arrival_date
    FROM bills_of_lading b JOIN manifests m ON m.id=b.manifest_id
    WHERE b.id=?
  `).get(req.params.id);
  if (!bl) return res.status(404).json({ error: 'No encontrado' });

  const cbls = db.prepare('SELECT container_no FROM container_bl WHERE bl_no=? AND manifest_id=?')
    .all(bl.bl_no, bl.manifest_id);
  const containerNos = cbls.length ? cbls.map(r => r.container_no) : [bl.hacienda_container_no || ''];
  if (!bl.hacienda_container_no && containerNos[0]) bl.hacienda_container_no = containerNos[0];

  const carrier = db.prepare('SELECT ivu FROM carriers WHERE code=?').get(bl.carrier_code);
  bl.carrier_ivu = carrier ? carrier.ivu : '';

  // Un par línea1+línea2 por contenedor (igual que el TXT real)
  const pairs = containerNos.map(containerNo => ({
    containerNo,
    line1: generateTxtLine1(bl, bl, containerNo),
    line2: generateTxtLine2(bl, containerNo, containerNos.length),
  }));
  res.json({ pairs, line1: pairs[0].line1, line2: pairs[0].line2 });
});

// ── CONTENEDORES ─────────────────────────────────────────────────────────────
router.put('/api/containers/:id', (req, res) => {
  const { size } = req.body;
  db.prepare('UPDATE containers SET size=? WHERE id=?').run(size || '', req.params.id);
  res.json({ ok: true });
});

// ── CARGO ITEMS POR B/L ──────────────────────────────────────────────────────
router.get('/api/bl/:id/cargo-items', (req, res) => {
  res.json(db.prepare(`SELECT * FROM bl_cargo_items WHERE bl_id=? ORDER BY seq,id`).all(req.params.id));
});

router.post('/api/bl/:id/cargo-items', (req, res) => {
  const bl_id = parseInt(req.params.id);
  const bl = db.prepare(`SELECT manifest_id FROM bills_of_lading WHERE id=?`).get(bl_id);
  if (!bl) return res.status(404).json({ error: 'B/L no encontrado' });

  const { container_no, goods_name, gross_weight, hacienda_item_code, hacienda_tariff, seq } = req.body;
  const maxSeq = db.prepare(`SELECT COALESCE(MAX(seq),0) as m FROM bl_cargo_items WHERE bl_id=?`).get(bl_id).m;
  const info = db.prepare(`
    INSERT INTO bl_cargo_items
      (bl_id,manifest_id,container_no,goods_name,gross_weight,hacienda_item_code,hacienda_tariff,seq)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    bl_id, bl.manifest_id, container_no || null, goods_name || '',
    parseFloat(gross_weight) || 0, hacienda_item_code || null,
    hacienda_tariff || null, seq || maxSeq + 1
  );
  const item = db.prepare(`SELECT * FROM bl_cargo_items WHERE id=?`).get(info.lastInsertRowid);
  res.json({ ok: true, item });
});

router.put('/api/bl-cargo-items/:id', (req, res) => {
  const allowed = ['container_no','goods_name','gross_weight','hacienda_item_code','hacienda_tariff','seq'];
  const sets = []; const vals = [];
  allowed.forEach(f => {
    if (req.body[f] !== undefined) {
      sets.push(`${f}=?`);
      vals.push(req.body[f] === '' && f === 'container_no' ? null : req.body[f]);
    }
  });
  if (sets.length) {
    vals.push(req.params.id);
    db.prepare(`UPDATE bl_cargo_items SET ${sets.join(',')} WHERE id=?`).run(...vals);
  }
  res.json({ ok: true });
});

router.delete('/api/bl-cargo-items/:id', (req, res) => {
  db.prepare(`DELETE FROM bl_cargo_items WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
