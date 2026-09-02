// routes/manifests.js — Carga, consulta, edición y exportación de manifiestos
//
// Extraído de server.js (paso 5 de la separación backend/frontend).

const express = require('express');
const multer  = require('multer');
const db = require('../db/connection');

/** @typedef {import('../types').ManifestRow} ManifestRow */
/** @typedef {import('../types').BLRow} BLRow */
/** @typedef {import('../types').ClientRow} ClientRow */
/** @typedef {import('../types').ParsedManifest} ParsedManifest */

const { parseXmlManifest } = require('../services/xmlParser');
const { parsePdfManifest } = require('../services/pdfParser');
const { toSiscommatePort, generateFullTxt } = require('../services/txtGenerator');
const { validateForSubmission } = require('../services/blValidation');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── SUBIR MANIFIESTO (XML de la DGA o PDF digital) ───────────────────────────
router.post('/api/manifests/upload', upload.single('xml'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

    const isPdf = /\.pdf$/i.test(req.file.originalname || '') ||
                  req.file.buffer.slice(0, 5).toString('latin1') === '%PDF-';
    const parsed = isPdf
      ? await parsePdfManifest(req.file.buffer)
      : await parseXmlManifest(req.file.buffer.toString('utf8'));

    const info = db.prepare(`
      INSERT INTO manifests (filename,voyage_no,vessel_code,biz_company_code,
        loading_port,unloading_port,departure_date,arrival_date,carrier_code,manifest_no)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      req.file.originalname, parsed.header.voyage_no, parsed.header.vessel_code,
      parsed.header.biz_company_code,
      toSiscommatePort(parsed.header.loading_port),
      toSiscommatePort(parsed.header.unloading_port),
      parsed.header.departure_date,
      parsed.header.arrival_date, 'MPRIORO', parsed.header.manifest_no || ''
    );
    const manifestId = info.lastInsertRowid;

    // Catálogo de clientes para auto-match de SS/EIN e IVU
    /** @type {ClientRow[]} */
    const clients = db.prepare(`SELECT name, ss, ivu FROM clients WHERE ss IS NOT NULL AND ss != ''`).all();
    const clientMap = new Map();
    clients.forEach(c => { if (c.name) clientMap.set(c.name.trim().toUpperCase(), c); });

    // Enriquecer B/L antes de insertar
    parsed.bls.forEach(bl => {
      let clientMatch = clientMap.get((bl.consignee_name || '').trim().toUpperCase());
      if (!clientMatch && bl.consignee_name) {
        const normName = bl.consignee_name.trim().toUpperCase();
        for (const [cName, cObj] of clientMap.entries()) {
          if (cName.length >= 4 && (normName.includes(cName) || cName.includes(normName))) {
            clientMatch = cObj;
            break;
          }
        }
      }
      if (clientMatch) {
        if (!bl.consignee_document_no && clientMatch.ss) bl.consignee_document_no = clientMatch.ss;
        bl.hacienda_client_ss  = clientMatch.ss || '';
        bl.hacienda_client_ivu = clientMatch.ivu || '';
      }
    });

    const insBL = db.prepare(`
      INSERT INTO bills_of_lading
        (manifest_id,bl_no,bl_type,transit_type,unloading_port_code,
         goods_name,package_unit_code,package_qty,gross_weight,value,
         consignor_type,consignor_code,consignor_name,consignor_document_type,
         consignor_document_no,consignor_country_code,consignor_tel,consignor_email,
         consignor_street,consignor_city,consignor_zip,
         consignee_type,consignee_code,consignee_name,consignee_document_type,
         consignee_document_no,consignee_country_code,consignee_tel,consignee_email,
         consignee_street,consignee_city,consignee_zip,
         notify_name,notify_code,notify_document_type,notify_document_no,
         notify_country_code,notify_tel,notify_email,notify_street,notify_city,notify_zip,
         hacienda_container_no,hacienda_client_ss,hacienda_client_ivu)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    db.transaction(bls => bls.forEach(bl => insBL.run(
      manifestId, bl.bl_no, bl.bl_type, bl.transit_type, bl.unloading_port_code,
      bl.goods_name, bl.package_unit_code, bl.package_qty, bl.gross_weight, bl.value,
      bl.consignor_type, bl.consignor_code, bl.consignor_name, bl.consignor_document_type,
      bl.consignor_document_no, bl.consignor_country_code, bl.consignor_tel, bl.consignor_email,
      bl.consignor_street, bl.consignor_city, bl.consignor_zip,
      bl.consignee_type, bl.consignee_code, bl.consignee_name, bl.consignee_document_type,
      bl.consignee_document_no, bl.consignee_country_code, bl.consignee_tel, bl.consignee_email,
      bl.consignee_street, bl.consignee_city, bl.consignee_zip,
      bl.notify_name, bl.notify_code, bl.notify_document_type, bl.notify_document_no,
      bl.notify_country_code, bl.notify_tel, bl.notify_email, bl.notify_street,
      bl.notify_city, bl.notify_zip,
      bl.hacienda_container_no || '', bl.hacienda_client_ss || '', bl.hacienda_client_ivu || ''
    )))(parsed.bls);

    // Items de carga individuales (soporta multi-ítem y vehículos)
    if (parsed.cargoItems && parsed.cargoItems.length) {
      const blRows = db.prepare(`SELECT id, bl_no FROM bills_of_lading WHERE manifest_id=?`).all(manifestId);
      const blIdMap = {};
      blRows.forEach(r => { blIdMap[r.bl_no] = r.id; });

      const insCargo = db.prepare(`
        INSERT INTO bl_cargo_items
          (bl_id, manifest_id, container_no, goods_name, gross_weight, hacienda_item_code, hacienda_tariff, seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const seqMap = {};
      parsed.cargoItems.forEach(ci => {
        const blId = blIdMap[ci.bl_no];
        if (blId) {
          seqMap[blId] = (seqMap[blId] || 0) + 1;
          // hacienda_item_code y hacienda_tariff entran siempre en NULL: ningún
          // parser los produce (el archivo del transportista no trae códigos de
          // Hacienda). Los llena el operador después, desde el editor.
          // Antes se leían de `ci`, dando a entender que podían venir del
          // archivo; el chequeo de tipos mostró que esas propiedades no existen.
          insCargo.run(
            blId, manifestId, ci.container_no || null, ci.goods_name || '',
            Number(ci.gross_weight) || 0, null,
            null, seqMap[blId]
          );
        }
      });
    }

    if (parsed.containers.length) {
      // Mapeo ContainerType XML → size para asignar tamaño automáticamente
      const ctMap = {};
      db.prepare(`SELECT xml_type, size FROM container_type_map`).all()
        .forEach(r => { ctMap[r.xml_type] = r.size; });

      const insCont = db.prepare(`
        INSERT INTO containers (manifest_id,container_no,container_type,package_code,amount,gross_weight,net_weight,seal_no1,size)
        VALUES (?,?,?,?,?,?,?,?,?)
      `);
      parsed.containers.forEach(c => {
        const size = c.size || (c.xml_container_type ? (ctMap[c.xml_container_type] || '') : '');
        insCont.run(manifestId, c.container_no, c.container_type, c.package_code,
                    c.amount, c.gross_weight, c.net_weight, c.seal_no1, size);
      });

      const insCBL = db.prepare(`INSERT INTO container_bl (container_no,bl_no,manifest_id) VALUES (?,?,?)`);
      parsed.containerBLs.forEach(cb => insCBL.run(cb.container_no, cb.bl_no, manifestId));
    }

    res.json({ ok: true, manifest_id: manifestId, bl_count: parsed.bls.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── LISTAR / OBTENER ─────────────────────────────────────────────────────────
router.get('/api/manifests', (req, res) => {
  res.json(db.prepare(`
    SELECT m.*, COUNT(b.id) as bl_count
    FROM manifests m LEFT JOIN bills_of_lading b ON b.manifest_id=m.id
    GROUP BY m.id ORDER BY m.created_at DESC
  `).all());
});

router.get('/api/manifests/:id', (req, res) => {
  /** @type {ManifestRow} */
  const manifest = db.prepare('SELECT * FROM manifests WHERE id=?').get(req.params.id);
  if (!manifest) return res.status(404).json({ error: 'No encontrado' });
  res.json({
    manifest,
    bls:          db.prepare('SELECT * FROM bills_of_lading WHERE manifest_id=? ORDER BY bl_no').all(req.params.id),
    containers:   db.prepare('SELECT * FROM containers WHERE manifest_id=?').all(req.params.id),
    container_bl: db.prepare('SELECT * FROM container_bl WHERE manifest_id=?').all(req.params.id),
  });
});

// ── ACTUALIZAR ───────────────────────────────────────────────────────────────
// Cualquier campo que el editor pueda enviar tiene que estar aquí: los que
// falten se descartan sin aviso ni error. Así se perdía 'vessel_code', que el
// desplegable de buque envía y el propio editor usa para preseleccionarlo — el
// buque elegido no se recordaba al recargar.
const CAMPOS_EDITABLES_MANIFEST = [
  'manifest_no','vessel_name','vessel_code','carrier_code','voyage_no','imo',
  'loading_port','unloading_port','departure_date','arrival_date','status',
  'docking_number',
];

router.put('/api/manifests/:id', (req, res) => {
  const sets = []; const vals = [];
  CAMPOS_EDITABLES_MANIFEST.forEach(f => {
    if (req.body[f] !== undefined) { sets.push(`${f}=?`); vals.push(req.body[f]); }
  });
  if (sets.length) {
    vals.push(req.params.id);
    db.prepare(`UPDATE manifests SET ${sets.join(',')} WHERE id=?`).run(...vals);
  }
  res.json({ ok: true });
});

// ── ELIMINAR (con sus B/L, contenedores y logs) ──────────────────────────────
router.delete('/api/manifests/:id', (req, res) => {
  /** @type {ManifestRow} */
  const manifest = db.prepare('SELECT * FROM manifests WHERE id=?').get(req.params.id);
  if (!manifest) return res.status(404).json({ error: 'No encontrado' });

  db.prepare('DELETE FROM export_log      WHERE manifest_id=?').run(req.params.id);
  db.prepare('DELETE FROM container_bl    WHERE manifest_id=?').run(req.params.id);
  db.prepare('DELETE FROM containers      WHERE manifest_id=?').run(req.params.id);
  db.prepare('DELETE FROM bills_of_lading WHERE manifest_id=?').run(req.params.id);
  db.prepare('DELETE FROM manifests       WHERE id=?').run(req.params.id);

  res.json({ ok: true, deleted: manifest.voyage_no });
});

// ── EXPORTAR TXT HACIENDA ────────────────────────────────────────────────────
router.get('/api/manifests/:id/export-txt', (req, res) => {
  /** @type {ManifestRow} */
  const manifest = db.prepare('SELECT * FROM manifests WHERE id=?').get(req.params.id);
  if (!manifest) return res.status(404).json({ error: 'No encontrado' });

  /** @type {BLRow[]} */
  const allBls = db.prepare('SELECT * FROM bills_of_lading WHERE manifest_id=? ORDER BY bl_no').all(req.params.id);

  // Mismas reglas que el push a SISCOMMATE (services/blValidation.js)
  const { validBls: bls, errors } = validateForSubmission(manifest, allBls);
  if (errors.length) return res.status(400).json({ error: errors.join(' | ') });

  const carrier = db.prepare('SELECT ivu FROM carriers WHERE code=?').get(manifest.carrier_code);
  manifest.carrier_ivu = carrier ? carrier.ivu : '';

  const containersByBl = {};
  db.prepare('SELECT * FROM container_bl WHERE manifest_id=?').all(req.params.id).forEach(r => {
    (containersByBl[r.bl_no] = containersByBl[r.bl_no] || []).push(r.container_no);
  });
  const cargoItemsByBl = {};
  db.prepare('SELECT * FROM bl_cargo_items WHERE manifest_id=? ORDER BY seq').all(req.params.id).forEach(ci => {
    (cargoItemsByBl[ci.bl_id] = cargoItemsByBl[ci.bl_id] || []).push(ci);
  });
  bls.forEach(bl => {
    bl.containers = containersByBl[bl.bl_no] && containersByBl[bl.bl_no].length
      ? containersByBl[bl.bl_no]
      : [bl.hacienda_container_no || ''];
    if (!bl.hacienda_container_no) bl.hacienda_container_no = bl.containers[0] || '';
    bl.cargoItems = cargoItemsByBl[bl.id] || null;
  });

  const txt = generateFullTxt(manifest, bls);
  const filename = `${manifest.manifest_no || manifest.voyage_no}_HACIENDA.TXT`;

  // Registrar export y marcar status ANTES de enviar (si res.send falla el
  // cliente puede reintentar — es preferible a no registrarlo nunca)
  db.prepare(`INSERT INTO export_log (manifest_id,filename,bl_count) VALUES (?,?,?)`)
    .run(manifest.id, `${manifest.voyage_no}.TXT`, bls.length);
  db.prepare(`UPDATE manifests SET status='exportado', exported_at=datetime('now') WHERE id=?`)
    .run(manifest.id);

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(txt);
});

// ── BÚSQUEDA GLOBAL Y ESTADÍSTICAS ───────────────────────────────────────────
router.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ manifests: [], bls: [] });
  const like = `%${q}%`;

  const manifests = db.prepare(`
    SELECT m.*, COUNT(b.id) as bl_count
    FROM manifests m LEFT JOIN bills_of_lading b ON b.manifest_id=m.id
    WHERE m.voyage_no LIKE ? OR m.vessel_name LIKE ? OR m.manifest_no LIKE ? OR m.filename LIKE ?
    GROUP BY m.id ORDER BY m.created_at DESC LIMIT 20
  `).all(like, like, like, like);

  const bls = db.prepare(`
    SELECT b.id, b.bl_no, b.consignee_name, b.status, b.manifest_id,
           m.voyage_no, m.vessel_name, m.arrival_date
    FROM bills_of_lading b JOIN manifests m ON m.id=b.manifest_id
    WHERE b.bl_no LIKE ? OR b.consignee_name LIKE ? OR b.consignor_name LIKE ?
    ORDER BY m.created_at DESC LIMIT 30
  `).all(like, like, like);

  res.json({ manifests, bls });
});

router.get('/api/stats', (req, res) => {
  res.json({
    manifests:  db.prepare('SELECT COUNT(*) as n FROM manifests').get().n,
    bls:        db.prepare('SELECT COUNT(*) as n FROM bills_of_lading').get().n,
    pending:    db.prepare("SELECT COUNT(*) as n FROM bills_of_lading WHERE status='pendiente'").get().n,
    siscommate: db.prepare("SELECT COUNT(*) as n FROM manifests WHERE status='siscommate'").get().n,
  });
});

module.exports = router;
