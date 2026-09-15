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
const { recalcularEstadoManifiesto } = require('./bl');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * Compara los B/L de un archivo recién parseado contra lo que ya existe en
 * la base — en CUALQUIER manifiesto, no solo en el viaje destino — para que
 * un B/L que el usuario movió a otro viaje (feature "mover B/L") no se
 * reimporte ni duplique al volver a cargar el mismo PDF/XML.
 * @param {string} voyageNo
 * @param {{bl_no:string}[]} bls
 */
function clasificarBLs(voyageNo, bls) {
  const manifiesto = db.prepare('SELECT id FROM manifests WHERE voyage_no=?').get(voyageNo);
  const manifestId = manifiesto ? manifiesto.id : null;

  // bl_no -> { id, manifest_id, voyage_no } en TODA la base, de un tirón
  const ubicaciones = new Map();
  db.prepare(`
    SELECT b.id, b.bl_no, b.manifest_id, m.voyage_no
    FROM bills_of_lading b JOIN manifests m ON m.id = b.manifest_id
  `).all().forEach(r => ubicaciones.set(r.bl_no, r));

  const nuevos = [], yaEnEsteViaje = [], enOtroViaje = [];
  bls.forEach(bl => {
    const u = ubicaciones.get(bl.bl_no);
    if (!u) { nuevos.push(bl.bl_no); return; }
    if (manifestId && u.manifest_id === manifestId) yaEnEsteViaje.push(bl.bl_no);
    // id incluido para que, si el usuario decide moverlos, el frontend pueda
    // llamar a /api/bl/mover-lote sin tener que volver a consultarlo.
    else enOtroViaje.push({ id: u.id, bl_no: bl.bl_no, voyage_no: u.voyage_no });
  });
  return { manifestId, nuevos, yaEnEsteViaje, enOtroViaje };
}

// ── CREAR VIAJE VACÍO (sin XML/PDF, se llena todo a mano) ────────────────────
router.post('/api/manifests', (req, res) => {
  const voyageNo = String(req.body?.voyage_no || '').trim();
  if (!voyageNo) return res.status(400).json({ error: 'El número de viaje es obligatorio' });
  if (db.prepare('SELECT 1 FROM manifests WHERE voyage_no=?').get(voyageNo)) {
    return res.status(409).json({ error: `Ya existe un viaje "${voyageNo}"` });
  }
  const info = db.prepare(`
    INSERT INTO manifests (filename, voyage_no, status)
    VALUES ('', ?, 'borrador')
  `).run(voyageNo);
  const manifest = db.prepare('SELECT * FROM manifests WHERE id=?').get(info.lastInsertRowid);
  res.status(201).json({ ok: true, manifest });
});

// ── VISTA PREVIA DE CARGA (cuenta B/L nuevos/repetidos/movidos, no escribe nada) ─
router.post('/api/manifests/upload/preview', upload.single('xml'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

    const isPdf = /\.pdf$/i.test(req.file.originalname || '') ||
                  req.file.buffer.slice(0, 5).toString('latin1') === '%PDF-';
    const parsed = isPdf
      ? await parsePdfManifest(req.file.buffer)
      : await parseXmlManifest(req.file.buffer.toString('utf8'));

    const { manifestId, nuevos, yaEnEsteViaje, enOtroViaje } = clasificarBLs(parsed.header.voyage_no, parsed.bls);
    res.json({
      voyage_no: parsed.header.voyage_no,
      existe_viaje: !!manifestId,
      manifest_id: manifestId,
      nuevos_count: nuevos.length,
      ya_en_este_viaje_count: yaEnEsteViaje.length,
      en_otro_viaje: enOtroViaje,
      // Advertencias de consistencia del parser (peso que no cuadra,
      // contenedores reconectados a mano, B/L sin contenedor) — solo el
      // parser de PDF 1302 las genera hoy; el resto de formatos manda [].
      warnings: parsed.warnings || [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── SUBIR MANIFIESTO (XML de la DGA o PDF digital) ───────────────────────────
router.post('/api/manifests/upload', upload.single('xml'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

    const isPdf = /\.pdf$/i.test(req.file.originalname || '') ||
                  req.file.buffer.slice(0, 5).toString('latin1') === '%PDF-';
    const parsed = isPdf
      ? await parsePdfManifest(req.file.buffer)
      : await parseXmlManifest(req.file.buffer.toString('utf8'));

    // Reimportar el mismo viaje (p.ej. el transportista manda un PDF
    // actualizado con B/L nuevos) no debe crear un manifiesto duplicado ni
    // tocar los B/L que ya se trabajaron: se suman solo los B/L realmente
    // nuevos. Un B/L que ya existe en OTRO viaje (porque el usuario lo movió
    // ahí con "mover B/L") tampoco se reimporta — se deja donde está, salvo
    // que el operador haya pedido moverlo también (mover_ids más abajo).
    const { manifestId: manifestIdExistente, nuevos: nuevosBlNoArr } = clasificarBLs(parsed.header.voyage_no, parsed.bls);
    const nuevosBlNo = new Set(nuevosBlNoArr);

    // Posición de cada B/L en el documento ORIGINAL (antes de filtrar) — se
    // usa como sort_seq tanto para los que se insertan de cero como para los
    // que se mueven desde otro viaje, así ambos quedan en su lugar real
    // dentro de la lista sin importar cuál de los dos caminos siguieron.
    const origIndex = new Map();
    parsed.bls.forEach((bl, i) => { if (!origIndex.has(bl.bl_no)) origIndex.set(bl.bl_no, i); });

    parsed.bls = parsed.bls.filter(bl => nuevosBlNo.has(bl.bl_no));

    let manifestId;
    if (manifestIdExistente) {
      manifestId = manifestIdExistente;
      if (!parsed.bls.length) {
        return res.json({
          ok: true, manifest_id: manifestId, bl_count: 0, merged: true,
          mensaje: `El viaje "${parsed.header.voyage_no}" ya tiene todos los B/L de este archivo (o están en otro viaje) — no se agregó nada.`,
        });
      }
      parsed.cargoItems  = (parsed.cargoItems  || []).filter(ci => nuevosBlNo.has(ci.bl_no));
      parsed.containerBLs = (parsed.containerBLs || []).filter(cb => nuevosBlNo.has(cb.bl_no));
      const containeresYaExisten = new Set(
        db.prepare('SELECT container_no FROM containers WHERE manifest_id=?').all(manifestId).map(r => r.container_no)
      );
      parsed.containers = (parsed.containers || []).filter(c => !containeresYaExisten.has(c.container_no));
    } else if (!parsed.bls.length) {
      return res.status(400).json({ error: 'Todos los B/L de este archivo ya están en otro viaje — no hay nada nuevo que cargar.' });
    } else {
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
      manifestId = info.lastInsertRowid;
    }

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
         hacienda_container_no,hacienda_client_ss,hacienda_client_ivu,sort_seq)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
      bl.hacienda_container_no || '', bl.hacienda_client_ss || '', bl.hacienda_client_ivu || '',
      origIndex.get(bl.bl_no) ?? null
    )))(parsed.bls);

    // ── Mover en el mismo paso los B/L que ya estaban en OTRO viaje ──────────
    // El operador puede pedir esto desde el modal "Confirmar carga" cuando el
    // PDF trae B/L que el sistema ya tenía en otro viaje. Se hace AQUÍ, en la
    // misma carga, y no como una llamada aparte después — así el sort_seq
    // (posición real dentro de ESTE documento) queda igual de bien calculado
    // que el de los B/L insertados de cero, en vez de conservar el id viejo
    // de cuando se insertaron por primera vez (eso los mandaba siempre al
    // principio de la lista sin importar dónde aparecieran en el PDF).
    const moverIdsRaw = (() => { try { return JSON.parse(req.body?.mover_ids || '[]'); } catch { return []; } })();
    const moverIds = Array.isArray(moverIdsRaw) ? moverIdsRaw.map(Number).filter(Number.isInteger) : [];
    const movidos = [];
    const omitidos = [];
    if (moverIds.length) {
      const moverUno = db.transaction((bl, seq) => {
        const origenId = bl.manifest_id;
        db.prepare('UPDATE bills_of_lading SET manifest_id=?, sort_seq=? WHERE id=?').run(manifestId, seq, bl.id);
        db.prepare('UPDATE container_bl SET manifest_id=? WHERE bl_no=? AND manifest_id=?')
          .run(manifestId, bl.bl_no, origenId);
        db.prepare(`
          UPDATE containers SET manifest_id=?
          WHERE manifest_id=?
            AND container_no IN (SELECT container_no FROM container_bl WHERE bl_no=? AND manifest_id=?)
            AND container_no NOT IN (SELECT container_no FROM container_bl WHERE manifest_id=?)
        `).run(manifestId, origenId, bl.bl_no, manifestId, origenId);
        db.prepare('UPDATE bl_cargo_items SET manifest_id=? WHERE bl_id=?').run(manifestId, bl.id);
      });
      moverIds.forEach(id => {
        const bl = db.prepare('SELECT * FROM bills_of_lading WHERE id=?').get(id);
        if (!bl) { omitidos.push({ id, motivo: 'No encontrado' }); return; }
        if (bl.manifest_id === manifestId) { omitidos.push({ id, bl_no: bl.bl_no, motivo: 'Ya está en este viaje' }); return; }
        if (db.prepare('SELECT 1 FROM bills_of_lading WHERE manifest_id=? AND bl_no=?').get(manifestId, bl.bl_no)) {
          omitidos.push({ id, bl_no: bl.bl_no, motivo: `Ya existe un B/L "${bl.bl_no}" en este viaje` });
          return;
        }
        moverUno(bl, origIndex.get(bl.bl_no) ?? null);
        movidos.push({ id: bl.id, bl_no: bl.bl_no });
      });
    }

    // Items de carga individuales (soporta multi-ítem y vehículos)
    if (parsed.cargoItems && parsed.cargoItems.length) {
      const blRows = db.prepare(`SELECT id, bl_no FROM bills_of_lading WHERE manifest_id=?`).all(manifestId);
      const blIdMap = {};
      blRows.forEach(r => { blIdMap[r.bl_no] = r.id; });

      const insCargo = db.prepare(`
        INSERT INTO bl_cargo_items
          (bl_id, manifest_id, container_no, goods_name, gross_weight, hacienda_item_code, hacienda_tariff, seq, package_qty)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          // package_qty sí lo produce pdfParser (cargoItems[].package_qty, una
          // línea de mercancía por bulto) — antes se descartaba por falta de
          // columna en bl_cargo_items.
          insCargo.run(
            blId, manifestId, ci.container_no || null, ci.goods_name || '',
            Number(ci.gross_weight) || 0, null,
            null, seqMap[blId], Number(ci.package_qty) || 0
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
    }
    if (parsed.containerBLs.length) {
      const insCBL = db.prepare(`INSERT INTO container_bl (container_no,bl_no,manifest_id) VALUES (?,?,?)`);
      parsed.containerBLs.forEach(cb => insCBL.run(cb.container_no, cb.bl_no, manifestId));
    }

    if (movidos.length) recalcularEstadoManifiesto(manifestId);
    res.json({
      ok: true, manifest_id: manifestId, bl_count: parsed.bls.length, merged: !!manifestIdExistente,
      movidos, omitidos,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── LISTAR / OBTENER ─────────────────────────────────────────────────────────
router.get('/api/manifests', (req, res) => {
  res.json(db.prepare(`
    SELECT m.*, COUNT(b.id) as bl_count,
      SUM(CASE WHEN b.status != 'validado' THEN 1 ELSE 0 END) as pending_count
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
    // Mismo orden en que aparecen en el PDF, uno detrás de otro — no por
    // bl_no ni por status (pedido explícito: no priorizar los validados
    // arriba, respetar la posición original del documento). sort_seq guarda
    // esa posición real y se asigna tanto al insertar un B/L nuevo como al
    // mover uno desde otro viaje (ver /api/manifests/upload) — con id solo,
    // un B/L movido conservaba su id viejo y saltaba al principio de la
    // lista en vez de quedar en su lugar real. COALESCE cubre filas de
    // antes de que existiera esta columna (quedan en su orden de siempre).
    bls:          db.prepare(`
      SELECT * FROM bills_of_lading WHERE manifest_id=?
      ORDER BY COALESCE(sort_seq, id)
    `).all(req.params.id),
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
  'loading_port','unloading_port','discharge_port','departure_date','arrival_date','status',
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
  // Antes el nombre era siempre igual (voyage_no fijo) — reexportar el mismo
  // manifiesto (p.ej. después de corregir un B/L) sobrescribía el TXT
  // anterior en la carpeta de descargas sin avisar. La marca de tiempo hace
  // que cada exportación quede como un archivo propio.
  const marcaTiempo = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const filename = `${manifest.manifest_no || manifest.voyage_no}_HACIENDA_${marcaTiempo}.TXT`;

  // Registrar export ANTES de enviar (si res.send falla el cliente puede
  // reintentar — es preferible a no registrarlo nunca). Ya no cambia el
  // status del manifiesto: exportar el TXT no significa que el viaje esté
  // completo — eso lo decide únicamente si todos los B/L quedaron validados
  // (ver recalcularEstadoManifiesto en routes/bl.js). Se puede exportar
  // cuantas veces haga falta, con o sin todos los B/L validados.
  db.prepare(`INSERT INTO export_log (manifest_id,filename,bl_count) VALUES (?,?,?)`)
    .run(manifest.id, filename, bls.length);
  db.prepare(`UPDATE manifests SET exported_at=datetime('now') WHERE id=?`)
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
