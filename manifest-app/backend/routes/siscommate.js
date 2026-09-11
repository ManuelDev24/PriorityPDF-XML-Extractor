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

    // Reenvío incremental: el bridge rechaza con error un viaje cuyo MANIFEST
    // ya existe, así que si se valida un B/L nuevo DESPUÉS de un primer push
    // ya no se podía enviar nada sin borrar el viaje completo primero. Ahora
    // solo se manda lo que todavía no tiene siscommate_sent_at — si ya se
    // envió todo, ni siquiera se llama al bridge, se avisa y ya.
    const porEnviar = validBls.filter(bl => !bl.siscommate_sent_at);
    const yaEnviados = validBls.length - porEnviar.length;
    if (!porEnviar.length) {
      return res.json({
        ok: true,
        enviados: 0,
        ya_enviados: yaEnviados,
        mensaje: yaEnviados
          ? `${yaEnviados === 1 ? 'El único B/L validado' : `Los ${yaEnviados} B/L validados`} de este viaje ya se ${yaEnviados === 1 ? 'había enviado' : 'habían enviado'} antes a SISCOMMATE. No hay nada nuevo que enviar.`
          : 'No hay B/L validados en este viaje.',
        warnings,
      });
    }

    /** @type {ContainerBLRow[]} */
    const container_bl = db.prepare('SELECT * FROM container_bl WHERE manifest_id=?').all(req.params.id);
    /** @type {ContainerRow[]} */
    const containers   = db.prepare('SELECT * FROM containers WHERE manifest_id=?').all(req.params.id);
    /** @type {CargoItemRow[]} */
    const cargoItems   = db.prepare('SELECT * FROM bl_cargo_items WHERE manifest_id=? ORDER BY bl_id, seq').all(req.params.id);

    // Adjuntar tamaño del contenedor a container_bl (para BOLCONT.size)
    const sizeMap = {};
    containers.forEach(c => { sizeMap[c.container_no] = c.size || ''; });

    // Solo los contenedores de los B/L que sí se envían esta vez
    const blNosEnviados = new Set(porEnviar.map(b => b.bl_no));
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
    porEnviar.forEach(bl => {
      const items = itemsByBl[bl.id];
      if (items && items.length > 0) bl.cargoItems = items;
    });

    const loteInfo = await getLote();
    const result = await pushManifest({
      manifest,
      bls: porEnviar,
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

    // Marcar SOLO los B/L que de verdad se acaban de enviar — así un push
    // posterior sabe cuáles quedan pendientes sin volver a preguntarle a
    // SISCOMMATE.
    const marcarEnviado = db.prepare(`UPDATE bills_of_lading SET siscommate_sent_at=datetime('now') WHERE id=?`);
    const marcarTodos = db.transaction(() => { porEnviar.forEach(bl => marcarEnviado.run(bl.id)); });
    marcarTodos();

    // Historial: el lote es lo único que permite ubicar este envío en la base
    // real de SISCOMMATE después, y antes no se guardaba en ningún lado.
    db.prepare(`
      INSERT INTO siscommate_push_log (manifest_id, voyage_no, lote, bl_count)
      VALUES (?,?,?,?)
    `).run(
      Number(req.params.id),
      manifest.voyage_no || '',
      String(result && result.lote != null ? result.lote : ''),
      porEnviar.length
    );

    res.json({
      ok: true,
      lote_anterior: loteInfo.lote,
      lote_nuevo: result.lote,
      bls: result.bls,
      enviados: porEnviar.length,
      ya_enviados: yaEnviados,
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

// ── SINCRONIZAR DESDE SISCOMMATE (ella edita directo en la base real) ───────
// Dirección inversa al push: trae lo que SISCOMMATE tiene AHORA para este
// viaje y sobreescribe la copia local — sin diff ni confirmación campo por
// campo, SISCOMMATE siempre gana para estos campos. No incluye SS/EIN, IVU
// ni tarifa: no existen en BOL/BOLITEM (SS/EIN vive en CUSTOMER), así que no
// hay nada real que traer de vuelta para esos tres.
router.post('/api/manifests/:id/sync-from-siscommate', async (req, res) => {
  const manifest = db.prepare('SELECT * FROM manifests WHERE id=?').get(req.params.id);
  if (!manifest) return res.status(404).json({ error: 'No encontrado' });

  let datos;
  try {
    datos = await consultarManifiesto(manifest.voyage_no);
  } catch (err) {
    return res.status(503).json({
      error: 'No se pudo conectar con SiscommateBridge: ' + err.message,
      hint: 'Verifica que SiscommateBridge está corriendo en el servidor (puerto 5001)',
    });
  }
  if (!datos.encontrado) {
    return res.json({
      ok: true, actualizados: 0, sin_encontrar_local: 0, total_en_siscommate: 0,
      mensaje: `No se encontró el viaje ${manifest.voyage_no} en SISCOMMATE.`,
    });
  }

  const localBls = db.prepare('SELECT * FROM bills_of_lading WHERE manifest_id=?').all(req.params.id);
  const localByBlNo = new Map(localBls.map(b => [b.bl_no, b]));

  // Un item/contenedor por bolno (el primero si hay varios — el B/L es la
  // unidad que se sincroniza, no cada línea suelta de BOLITEM/BOLCONT).
  const itemPorBolno = new Map();
  (datos.items || []).forEach(it => { if (!itemPorBolno.has(it.bolno)) itemPorBolno.set(it.bolno, it); });
  const contPorBolno = new Map();
  (datos.containers || []).forEach(c => { if (!contPorBolno.has(c.bolno)) contPorBolno.set(c.bolno, c); });

  const actualizar = db.prepare(`
    UPDATE bills_of_lading
    SET consignee_name=?, consignor_name=?, hacienda_item_code=?, goods_name=?,
        gross_weight=?, package_qty=?, value=?, hacienda_container_no=?, status='validado'
    WHERE id=?
  `);

  let actualizados = 0;
  let sinEncontrarLocal = 0;
  const hacer = db.transaction(() => {
    (datos.bls || []).forEach(remoto => {
      const local = localByBlNo.get(remoto.bolno);
      if (!local) { sinEncontrarLocal++; return; }
      const item = itemPorBolno.get(remoto.bolno) || {};
      const cont = contPorBolno.get(remoto.bolno) || {};
      actualizar.run(
        remoto.consigne || local.consignee_name,
        remoto.exporter || local.consignor_name,
        item.code || local.hacienda_item_code,
        item.desc || local.goods_name,
        item.weight ?? local.gross_weight,
        item.qty ?? local.package_qty,
        item.value ?? local.value,
        cont.contain || local.hacienda_container_no,
        local.id
      );
      actualizados++;
    });
  });
  hacer();

  res.json({
    ok: true,
    actualizados,
    sin_encontrar_local: sinEncontrarLocal,
    total_en_siscommate: (datos.bls || []).length,
  });
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
