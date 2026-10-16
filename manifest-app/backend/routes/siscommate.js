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
const { getBridgeStatus, getLote, pushManifest, consultarManifiesto, eliminarBlSiscommate } = require('../services/siscommateClient');
const { validateForSubmission } = require('../services/blValidation');
const { separarPorEnviar, viajesAnterioresARetirar } = require('../services/siscommateEnvio');

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
    // solo se manda lo que todavía no está en ESTE viaje de SISCOMMATE — si ya
    // se envió todo, ni siquiera se llama al bridge, se avisa y ya. "Ya está"
    // significa enviado a este viaje, no solo "tiene fecha de envío": un B/L
    // que se envió dentro de otro viaje y luego se movió aquí sigue pendiente
    // (ver services/siscommateEnvio.js).
    const { porEnviar, yaEnviados } = separarPorEnviar(validBls, manifest.voyage_no);
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
    // SISCOMMATE. Se anota también EN QUÉ viaje quedó cada uno, para que un
    // movimiento posterior a otro viaje no lo haga pasar por ya enviado allá.
    const marcarEnviado = db.prepare(`UPDATE bills_of_lading SET siscommate_sent_at=datetime('now'), siscommate_voyage_no=? WHERE id=?`);
    const marcarTodos = db.transaction(() => { porEnviar.forEach(bl => marcarEnviado.run(manifest.voyage_no, bl.id)); });
    marcarTodos();

    // B/L que se enviaron antes dentro de OTRO viaje y luego se movieron a este:
    // su copia vieja sigue en SISCOMMATE y dejaría el B/L duplicado. Se retira
    // solo DESPUÉS de que el envío nuevo salió bien, así un fallo aquí nunca
    // deja el B/L sin ninguna copia. Un fallo se avisa, no bloquea el envío.
    const retirados = [];
    const retiradosConFallo = [];
    const retirar = viajesAnterioresARetirar(porEnviar, manifest.voyage_no);
    for (const { bl, voyage_no: viajeViejo } of retirar) {
      // Si otro B/L local con el mismo número sigue legítimamente en ese
      // viaje, la copia de allá es suya — no se toca.
      const reclamado = db.prepare(`
        SELECT 1 FROM bills_of_lading o JOIN manifests m ON m.id = o.manifest_id
        WHERE o.bl_no=? AND o.id<>? AND m.voyage_no=?
      `).get(bl.bl_no, bl.id, viajeViejo);
      if (reclamado) continue;
      try {
        await eliminarBlSiscommate(viajeViejo, bl.bl_no);
        retirados.push({ bl_no: bl.bl_no, viaje: viajeViejo });
      } catch (err) {
        retiradosConFallo.push({ bl_no: bl.bl_no, viaje: viajeViejo, error: err.message });
      }
    }
    if (retiradosConFallo.length) {
      warnings.push(
        `${retiradosConFallo.length === 1 ? '1 B/L se envió' : `${retiradosConFallo.length} B/L se enviaron`} a este viaje pero su copia anterior NO se pudo retirar de SISCOMMATE ` +
        `(${retiradosConFallo.map(r => `${r.bl_no} en ${r.viaje}`).join(', ')}). ` +
        `${retiradosConFallo.length === 1 ? 'Quedó duplicado — bórralo' : 'Quedaron duplicados — bórralos'} a mano del viaje anterior` +
        (retiradosConFallo.some(r => /404|rutas|no existe/i.test(r.error)) ? ', o actualiza SiscommateBridge.exe en el servidor para que lo haga solo.' : '.')
      );
    }

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
      retirados_de_viaje_anterior: retirados,
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

// ── REABRIR UN VIAJE "YA ENVIADO" QUE EN REALIDAD YA NO ESTÁ EN SISCOMMATE ──
// Caso real: ella elimina un viaje directo en SISCOMMATE (la app nativa),
// pero la webapp nunca se entera — sigue creyendo que está "siscommate"
// (enviado de verdad) porque ese estado nunca se recalcula solo (ver
// recalcularEstadoManifiesto en bl.js: 'siscommate' es más fuerte que
// 'validado', a propósito, para que desvalidar un B/L después no "deshaga"
// un envío real). El push tampoco lo detecta por su cuenta: si TODOS los
// B/L ya tienen siscommate_sent_at, /push-siscommate no vuelve a llamar al
// bridge — asume que ya se envió todo y no hay nada que hacer, aunque el
// viaje ya no exista allá.
// Esta ruta es el único camino de vuelta: confirma contra SISCOMMATE real
// (nunca a ciegas) que el viaje de verdad no está, y si es así, limpia
// siscommate_sent_at de todos sus B/L y regresa el estado a "validado" para
// que un push posterior vuelva a mandar todo desde cero.
router.post('/api/manifests/:id/reabrir-siscommate', async (req, res) => {
  const manifest = db.prepare('SELECT * FROM manifests WHERE id=?').get(req.params.id);
  if (!manifest) return res.status(404).json({ error: 'No encontrado' });
  if (manifest.status !== 'siscommate') {
    return res.status(400).json({ error: 'Este viaje no está marcado como enviado a SISCOMMATE — no hay nada que reabrir.' });
  }

  let datos;
  try {
    datos = await consultarManifiesto(manifest.voyage_no);
  } catch (err) {
    return res.status(503).json({
      error: 'No se pudo conectar con SiscommateBridge: ' + err.message,
      hint: 'Verifica que SiscommateBridge está corriendo en el servidor (puerto 5001)',
    });
  }
  if (datos.encontrado) {
    return res.status(409).json({ error: `El viaje "${manifest.voyage_no}" SÍ existe todavía en SISCOMMATE — no se reabre para evitar un envío duplicado.` });
  }

  db.prepare(`UPDATE manifests SET status='validado' WHERE id=?`).run(req.params.id);
  const info = db.prepare(`UPDATE bills_of_lading SET siscommate_sent_at=NULL WHERE manifest_id=?`).run(req.params.id);
  res.json({ ok: true, bls_reabiertos: info.changes });
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
