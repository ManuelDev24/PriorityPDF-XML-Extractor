// routes/siscommate.js — Push a SISCOMMATE y estado del bridge
//
// Extraído de server.js (paso 5 de la separación backend/frontend).

const express = require('express');
const db = require('../db/connection');

/** @typedef {import('../types').ManifestRow} ManifestRow */
/** @typedef {import('../types').BLRow} BLRow */
/** @typedef {import('../types').ContainerRow} ContainerRow */
/** @typedef {import('../types').ContainerBLRow} ContainerBLRow */
/** @typedef {import('../types').CargoItemRow} CargoItemRow */
/** @typedef {import('../types').BridgeContainer} BridgeContainer */
const { getBridgeStatus, getLote, pushManifest, consultarManifiesto } = require('../services/siscommateClient');
const { validateForSubmission } = require('../services/blValidation');

const router = express.Router();

// ── ESTADO DEL BRIDGE ────────────────────────────────────────────────────────
router.get('/api/bridge/status', async (req, res) => {
  res.json(await getBridgeStatus());
});

// ── PUSH AL SISCOMMATE ───────────────────────────────────────────────────────
router.post('/api/manifests/:id/push-siscommate', async (req, res) => {
  try {
    /** @type {ManifestRow} */
    const manifest = db.prepare('SELECT * FROM manifests WHERE id=?').get(req.params.id);
    if (!manifest) return res.status(404).json({ error: 'No encontrado' });

    // MANIFEST.carrier en el DBF es char(3) — espera el SCAC ("PRR", "MXS"),
    // no el código interno del carrier ("MPRIORO"). Enviar el código interno
    // (7 chars) contra una columna de 3 rompía el INSERT completo con "Data
    // type mismatch", sin indicar cuál parámetro era.
    const carrierRow = db.prepare('SELECT scac FROM carriers WHERE code=?').get(manifest.carrier_code);
    manifest.carrier_code = (carrierRow && carrierRow.scac) || manifest.carrier_code;

    /** @type {BLRow[]} */
    const allBls = db.prepare('SELECT * FROM bills_of_lading WHERE manifest_id=? ORDER BY bl_no').all(req.params.id);

    // Mismas validaciones que la exportación TXT. Antes este camino solo
    // exigía el docking number y enviaba todos los B/L, validados o no.
    const { validBls, errors, warnings } = validateForSubmission(manifest, allBls);
    if (errors.length) return res.status(400).json({ error: errors.join(' | ') });

    /** @type {ContainerBLRow[]} */
    const container_bl = db.prepare('SELECT * FROM container_bl WHERE manifest_id=?').all(req.params.id);
    /** @type {ContainerRow[]} */
    const containers   = db.prepare('SELECT * FROM containers WHERE manifest_id=?').all(req.params.id);
    /** @type {CargoItemRow[]} */
    const cargoItems   = db.prepare('SELECT * FROM bl_cargo_items WHERE manifest_id=? ORDER BY bl_id, seq').all(req.params.id);

    // Adjuntar tamaño del contenedor a container_bl (para BOLCONT.size)
    const sizeMap = {};
    containers.forEach(c => { sizeMap[c.container_no] = c.size || ''; });

    // Solo los contenedores de los B/L que sí se envían
    const blNosEnviados = new Set(validBls.map(b => b.bl_no));
    const bridgeContainers = container_bl
      .filter(cb => blNosEnviados.has(cb.bl_no))
      .map(cb => ({
        bl_no:        cb.bl_no,
        container_no: cb.container_no,
        size:         sizeMap[cb.container_no] || '',
        type:         'R',
      }));

    // Agrupar cargo items por bl_id para adjuntarlos a cada B/L
    const itemsByBl = {};
    cargoItems.forEach(it => {
      (itemsByBl[it.bl_id] = itemsByBl[it.bl_id] || []).push(it);
    });
    validBls.forEach(bl => {
      const items = itemsByBl[bl.id];
      if (items && items.length > 0) bl.cargoItems = items;
    });

    const loteInfo = await getLote();
    const result = await pushManifest({
      manifest,
      bls: validBls,
      containers: bridgeContainers,
    });

    if (result && result.error) {
      return res.status(502).json({ error: `Bridge reportó error: ${result.error}` });
    }
    // Defensa adicional: un push real siempre trae un número de lote. Si
    // llegó una respuesta 2xx pero sin lote (bridge equivocado, versión
    // vieja, lo que sea), no se marca como enviado — mejor un error visible
    // que un "siscommate" falso.
    if (!result || result.lote == null) {
      return res.status(502).json({ error: 'El bridge respondió sin número de lote — no parece haber escrito nada. No se marcó como enviado.' });
    }

    db.prepare(`UPDATE manifests SET status='siscommate', exported_at=datetime('now') WHERE id=?`)
      .run(req.params.id);

    // Historial: el lote es lo único que permite ubicar este envío en la base
    // real de SISCOMMATE después, y antes no se guardaba en ningún lado.
    db.prepare(`
      INSERT INTO siscommate_push_log (manifest_id, voyage_no, lote, bl_count)
      VALUES (?,?,?,?)
    `).run(
      Number(req.params.id),
      manifest.voyage_no || '',
      String(result && result.lote != null ? result.lote : ''),
      validBls.length
    );

    res.json({
      ok: true,
      lote_anterior: loteInfo.lote,
      lote_nuevo: result.lote,
      bls: result.bls,
      enviados: validBls.length,
      warnings,
    });
  } catch (err) {
    console.error('[PUSH-SISCOMMATE]', err.message);
    res.status(503).json({
      error: 'No se pudo conectar con SiscommateBridge: ' + err.message,
      hint: 'Verifica que SiscommateBridge está corriendo en el servidor (puerto 5001)',
    });
  }
});

// ── VISTA EN VIVO DE LO QUE HAY EN SISCOMMATE ────────────────────────────────
// Lee directo de las tablas DBF reales (vía el bridge, el único proceso que
// puede hablar VFPOLEDB) — no nuestra copia local, la fuente de verdad.
router.get('/api/manifests/:id/siscommate-live', async (req, res) => {
  const manifest = db.prepare('SELECT voyage_no FROM manifests WHERE id=?').get(req.params.id);
  if (!manifest) return res.status(404).json({ error: 'No encontrado' });

  try {
    const datos = await consultarManifiesto(manifest.voyage_no);
    res.json(datos);
  } catch (err) {
    res.status(503).json({
      error: 'No se pudo conectar con SiscommateBridge: ' + err.message,
      hint: 'Verifica que SiscommateBridge está corriendo en el servidor (puerto 5001)',
    });
  }
});

// ── HISTORIAL DE ENVÍOS (nuestro registro local) ─────────────────────────────
router.get('/api/siscommate/history', (req, res) => {
  res.json(db.prepare(`
    SELECT l.*, m.status as manifest_status
    FROM siscommate_push_log l
    LEFT JOIN manifests m ON m.id = l.manifest_id
    ORDER BY l.pushed_at DESC
  `).all());
});

module.exports = router;
