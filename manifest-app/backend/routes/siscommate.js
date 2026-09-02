// routes/siscommate.js — Push a SISCOMMATE y estado del bridge
//
// Extraído de server.js (paso 5 de la separación backend/frontend).

const express = require('express');
const db = require('../db/connection');
const { getBridgeStatus, getLote, pushManifest } = require('../services/siscommateClient');
const { validateForSubmission } = require('../services/blValidation');

const router = express.Router();

// ── ESTADO DEL BRIDGE ────────────────────────────────────────────────────────
router.get('/api/bridge/status', async (req, res) => {
  res.json(await getBridgeStatus());
});

// ── PUSH AL SISCOMMATE ───────────────────────────────────────────────────────
router.post('/api/manifests/:id/push-siscommate', async (req, res) => {
  try {
    const manifest = db.prepare('SELECT * FROM manifests WHERE id=?').get(req.params.id);
    if (!manifest) return res.status(404).json({ error: 'No encontrado' });

    const allBls = db.prepare('SELECT * FROM bills_of_lading WHERE manifest_id=? ORDER BY bl_no').all(req.params.id);

    // Mismas validaciones que la exportación TXT. Antes este camino solo
    // exigía el docking number y enviaba todos los B/L, validados o no.
    const { validBls, errors } = validateForSubmission(manifest, allBls);
    if (errors.length) return res.status(400).json({ error: errors.join(' | ') });

    const container_bl = db.prepare('SELECT * FROM container_bl WHERE manifest_id=?').all(req.params.id);
    const containers   = db.prepare('SELECT * FROM containers WHERE manifest_id=?').all(req.params.id);
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

    db.prepare(`UPDATE manifests SET status='siscommate', exported_at=datetime('now') WHERE id=?`)
      .run(req.params.id);

    res.json({
      ok: true,
      lote_anterior: loteInfo.lote,
      lote_nuevo: result.lote,
      bls: result.bls,
      enviados: validBls.length,
    });
  } catch (err) {
    console.error('[PUSH-SISCOMMATE]', err.message);
    res.status(503).json({
      error: 'No se pudo conectar con SiscommateBridge: ' + err.message,
      hint: 'Verifica que SiscommateBridge está corriendo en el servidor (puerto 5001)',
    });
  }
});

module.exports = router;
