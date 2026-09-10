// routes/bl.js — B/L, sus items de carga y los contenedores
//
// Extraído de server.js (paso 5 de la separación backend/frontend).

const express = require('express');
const db = require('../db/connection');

/** @typedef {import('../types').BLRow} BLRow */
/** @typedef {import('../types').CargoItemRow} CargoItemRow */
const { generateTxtLine1, generateTxtLine2 } = require('../services/txtGenerator');

const router = express.Router();

// ── ESTADO DEL MANIFIESTO SEGÚN SUS B/L ──────────────────────────────────────
// El manifiesto pasa a 'validado' (pestaña "Completados") solo cuando TODOS
// sus B/L están validados — no cuando se exporta el TXT ni al hacer push a
// SISCOMMATE. 'siscommate' es un estado más fuerte (ya se entregó de verdad)
// y no se recalcula: un B/L desvalidado después no debe "deshacer" un envío
// que ya ocurrió.
function recalcularEstadoManifiesto(manifestId) {
  const manifest = db.prepare('SELECT status FROM manifests WHERE id=?').get(manifestId);
  if (!manifest || manifest.status === 'siscommate') return manifest ? manifest.status : null;
  const bls = db.prepare('SELECT status FROM bills_of_lading WHERE manifest_id=?').all(manifestId);
  const todoValidado = bls.length > 0 && bls.every(b => b.status === 'validado');
  const nuevo = todoValidado ? 'validado' : 'borrador';
  if (nuevo !== manifest.status) {
    db.prepare('UPDATE manifests SET status=? WHERE id=?').run(nuevo, manifestId);
  }
  return nuevo;
}

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

// ── CREAR B/L VACIO ───────────────────────────────────────────────────────────
router.post('/api/manifests/:manifestId/bl', (req, res) => {
  const blNo = String(req.body?.bl_no || '').trim();
  const manifestId = Number(req.params.manifestId);
  if (!Number.isInteger(manifestId) || !blNo) {
    return res.status(400).json({ error: 'El número de B/L es obligatorio' });
  }
  if (!db.prepare('SELECT 1 FROM manifests WHERE id=?').get(manifestId)) {
    return res.status(404).json({ error: 'Manifiesto no encontrado' });
  }
  if (db.prepare('SELECT 1 FROM bills_of_lading WHERE manifest_id=? AND bl_no=?').get(manifestId, blNo)) {
    return res.status(409).json({ error: 'Ya existe un B/L con ese número en el manifiesto' });
  }
  const info = db.prepare(`
    INSERT INTO bills_of_lading (manifest_id, bl_no, package_qty, gross_weight, value, status)
    VALUES (?, ?, 0, 0, 0, 'pendiente')
  `).run(manifestId, blNo);
  const bl = db.prepare('SELECT * FROM bills_of_lading WHERE id=?').get(info.lastInsertRowid);
  const manifest_status = recalcularEstadoManifiesto(manifestId);
  res.status(201).json({ ok: true, bl, manifest_status });
});

// ── RENOMBRAR EL NÚMERO DE B/L ────────────────────────────────────────────────
// bl_no no está en CAMPOS_EDITABLES_BL a propósito: cambiarlo con un UPDATE
// simple dejaría container_bl (que lo referencia por string, no por bl_id)
// apuntando al número viejo. Hace falta esta ruta dedicada, con cascada,
// para los casos donde el B/L se crea con un número provisional (p.ej.
// cuando el número real se perdió en el PDF y se sabe el consignatario
// pero no el número todavía) y se corrige después.
router.put('/api/bl/:id/renombrar', (req, res) => {
  const bl = db.prepare('SELECT * FROM bills_of_lading WHERE id=?').get(req.params.id);
  if (!bl) return res.status(404).json({ error: 'B/L no encontrado' });

  const nuevoNo = String(req.body?.bl_no || '').trim();
  if (!nuevoNo) return res.status(400).json({ error: 'El número de B/L no puede quedar vacío' });
  if (nuevoNo === bl.bl_no) return res.json({ ok: true, bl_no: nuevoNo });

  if (db.prepare('SELECT 1 FROM bills_of_lading WHERE manifest_id=? AND bl_no=?').get(bl.manifest_id, nuevoNo)) {
    return res.status(409).json({ error: `Ya existe un B/L "${nuevoNo}" en este manifiesto` });
  }

  const renombrar = db.transaction(() => {
    db.prepare('UPDATE bills_of_lading SET bl_no=? WHERE id=?').run(nuevoNo, bl.id);
    db.prepare('UPDATE container_bl SET bl_no=? WHERE bl_no=? AND manifest_id=?')
      .run(nuevoNo, bl.bl_no, bl.manifest_id);
  });
  renombrar();
  res.json({ ok: true, bl_no: nuevoNo });
});

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
  let manifest_status;
  if (req.body.status !== undefined) {
    const bl = db.prepare('SELECT manifest_id FROM bills_of_lading WHERE id=?').get(req.params.id);
    if (bl) manifest_status = recalcularEstadoManifiesto(bl.manifest_id);
  }
  res.json({ ok: true, manifest_status });
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

  const manifest_status = recalcularEstadoManifiesto(bl.manifest_id);
  res.json({ ok: true, deleted: bl.bl_no, manifest_id: bl.manifest_id, manifest_status });
});

// ── MOVER UN B/L A OTRO MANIFIESTO ────────────────────────────────────────────
// Mueve el B/L y todo lo que le pertenece en exclusiva: sus vínculos de
// contenedor (container_bl), los contenedores mismos (containers) — solo si
// no los comparte con otro B/L que se queda atrás — y sus items de carga
// (bl_cargo_items). Todo en una transacción para que no quede a medias.
router.put('/api/bl/:id/mover', (req, res) => {
  /** @type {BLRow} */
  const bl = db.prepare('SELECT * FROM bills_of_lading WHERE id=?').get(req.params.id);
  if (!bl) return res.status(404).json({ error: 'B/L no encontrado' });

  const destinoId = Number(req.body?.manifest_id);
  if (!Number.isInteger(destinoId)) return res.status(400).json({ error: 'Falta el manifiesto destino' });
  if (destinoId === bl.manifest_id) return res.status(400).json({ error: 'El B/L ya está en ese manifiesto' });

  const destino = db.prepare('SELECT id FROM manifests WHERE id=?').get(destinoId);
  if (!destino) return res.status(404).json({ error: 'Manifiesto destino no encontrado' });

  if (db.prepare('SELECT 1 FROM bills_of_lading WHERE manifest_id=? AND bl_no=?').get(destinoId, bl.bl_no)) {
    return res.status(409).json({ error: `Ya existe un B/L "${bl.bl_no}" en el manifiesto destino` });
  }

  const origenId = bl.manifest_id;
  const mover = db.transaction(() => {
    db.prepare('UPDATE bills_of_lading SET manifest_id=? WHERE id=?').run(destinoId, bl.id);
    db.prepare('UPDATE container_bl SET manifest_id=? WHERE bl_no=? AND manifest_id=?')
      .run(destinoId, bl.bl_no, origenId);
    db.prepare(`
      UPDATE containers SET manifest_id=?
      WHERE manifest_id=?
        AND container_no IN (SELECT container_no FROM container_bl WHERE bl_no=? AND manifest_id=?)
        AND container_no NOT IN (SELECT container_no FROM container_bl WHERE manifest_id=?)
    `).run(destinoId, origenId, bl.bl_no, destinoId, origenId);
    db.prepare('UPDATE bl_cargo_items SET manifest_id=? WHERE bl_id=?').run(destinoId, bl.id);
  });
  mover();

  const status_anterior = recalcularEstadoManifiesto(origenId);
  const status_nuevo = recalcularEstadoManifiesto(destinoId);
  res.json({
    ok: true, bl_no: bl.bl_no,
    manifest_id_anterior: origenId, manifest_id_nuevo: destinoId,
    status_anterior, status_nuevo,
  });
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
  const contenedor = db.prepare('SELECT * FROM containers WHERE id=?').get(req.params.id);
  if (!contenedor) return res.status(404).json({ error: 'Contenedor no encontrado' });

  const { size, container_no } = req.body;
  // Cualquier símbolo (guión, punto, dos puntos, espacio) que el operador
  // escriba a mano se quita aquí también — si llega sucio hasta el TXT,
  // SISCOMMATE/Hacienda rechaza la línea.
  const nuevoNo = container_no !== undefined
    ? String(container_no).toUpperCase().replace(/[^A-Z0-9]/g, '')
    : contenedor.container_no;
  if (container_no !== undefined && !nuevoNo) {
    return res.status(400).json({ error: 'El número de contenedor no puede quedar vacío' });
  }

  const actualizar = db.transaction(() => {
    db.prepare('UPDATE containers SET size=?, container_no=? WHERE id=?')
      .run(size ?? contenedor.size ?? '', nuevoNo, contenedor.id);

    if (nuevoNo !== contenedor.container_no) {
      db.prepare('UPDATE container_bl SET container_no=? WHERE container_no=? AND manifest_id=?')
        .run(nuevoNo, contenedor.container_no, contenedor.manifest_id);
      db.prepare('UPDATE bl_cargo_items SET container_no=? WHERE container_no=? AND manifest_id=?')
        .run(nuevoNo, contenedor.container_no, contenedor.manifest_id);
      db.prepare('UPDATE bills_of_lading SET hacienda_container_no=? WHERE hacienda_container_no=? AND manifest_id=?')
        .run(nuevoNo, contenedor.container_no, contenedor.manifest_id);
    }
  });
  actualizar();
  res.json({ ok: true, container_no: nuevoNo });
});

// ── CARGO ITEMS POR B/L ──────────────────────────────────────────────────────
router.get('/api/bl/:id/cargo-items', (req, res) => {
  res.json(db.prepare(`SELECT * FROM bl_cargo_items WHERE bl_id=? ORDER BY seq,id`).all(req.params.id));
});

router.post('/api/bl/:id/cargo-items', (req, res) => {
  const bl_id = parseInt(req.params.id);
  const bl = db.prepare(`SELECT manifest_id FROM bills_of_lading WHERE id=?`).get(bl_id);
  if (!bl) return res.status(404).json({ error: 'B/L no encontrado' });

  const { container_no, goods_name, gross_weight, hacienda_item_code, hacienda_tariff, seq, package_qty } = req.body;
  const maxSeq = db.prepare(`SELECT COALESCE(MAX(seq),0) as m FROM bl_cargo_items WHERE bl_id=?`).get(bl_id).m;
  const info = db.prepare(`
    INSERT INTO bl_cargo_items
      (bl_id,manifest_id,container_no,goods_name,gross_weight,hacienda_item_code,hacienda_tariff,seq,package_qty)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    bl_id, bl.manifest_id, container_no || null, goods_name || '',
    parseFloat(gross_weight) || 0, hacienda_item_code || null,
    hacienda_tariff || null, seq || maxSeq + 1, parseInt(package_qty) || 0
  );
  const item = db.prepare(`SELECT * FROM bl_cargo_items WHERE id=?`).get(info.lastInsertRowid);
  res.json({ ok: true, item });
});

router.put('/api/bl-cargo-items/:id', (req, res) => {
  const allowed = ['container_no','goods_name','gross_weight','hacienda_item_code','hacienda_tariff','seq','package_qty'];
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
