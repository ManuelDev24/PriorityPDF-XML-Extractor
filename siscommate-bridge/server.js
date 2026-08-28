/**
 * SiscommateBridge v1.0
 * Servidor HTTP que recibe datos del manifest-app y los escribe
 * directamente en las tablas DBF de SISCOMMATE (VFP / VisualFoxPro)
 *
 * Puerto: 5001
 * Endpoints:
 *   GET  /health           → estado del servicio y prueba de conexión DBF
 *   GET  /lote             → próximo número de lote disponible
 *   POST /guardar          → escribe MANIFEST + BOL + BOLCONT + BOLITEM
 *   DELETE /manifiesto/:v  → elimina un viaje completo de las tablas
 */

'use strict';
require('dotenv').config();

const express = require('express');
const dbf = require('./dbf');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 5001;
const DBF_PATH = process.env.DBF_PATH || '';

dbf.setPath(DBF_PATH);

// ── Utilidades locales ────────────────────────────────────────────

function today() {
  return new Date().toISOString().substring(0, 10);
}

/**
 * Extrae solo la hora HH:MM de un string de hora (acepta "18:00", "1800", "18:00:00")
 */
function fmtHora(h) {
  if (!h) return '00:00';
  const s = String(h).replace(/[^0-9:]/g, '');
  if (s.includes(':')) return s.substring(0, 5);
  if (s.length >= 4) return s.substring(0, 2) + ':' + s.substring(2, 4);
  return '00:00';
}

/**
 * Elimina todos los registros de un viaje (voyage_no) de las 4 tablas
 */
async function borrarViaje(voyageNo) {
  const v = dbf.fmtStr(voyageNo, 10);
  await dbf.execute(`DELETE FROM BOLITEM  WHERE manifest='${v}'`);
  await dbf.execute(`DELETE FROM BOLCONT  WHERE manifest='${v}'`);
  await dbf.execute(`DELETE FROM BOL      WHERE manifest='${v}'`);
  await dbf.execute(`DELETE FROM MANIFEST WHERE manifest='${v}'`);
}

// ── Health / prueba de conexión ───────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await dbf.query('SELECT 1 AS test FROM MANIFEST WHERE 1=0');
    res.json({ ok: true, dbf_path: DBF_PATH, version: '1.0.0' });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message, dbf_path: DBF_PATH });
  }
});

// ── Próximo lote ──────────────────────────────────────────────────
app.get('/lote', async (req, res) => {
  try {
    const rows = await dbf.query('SELECT MAX(lotnum) AS maxlote FROM MANIFEST');
    const actual = parseInt(rows[0]?.maxlote) || 3000000;
    res.json({ lote: actual, siguiente: actual + 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Eliminar viaje ────────────────────────────────────────────────
app.delete('/manifiesto/:voyageNo', async (req, res) => {
  try {
    await borrarViaje(req.params.voyageNo);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Guardar / sincronizar manifiesto ─────────────────────────────
/**
 * Body esperado:
 * {
 *   manifest: { voyage_no, vessel_name, vessel_code, carrier_code, imo,
 *               loading_port, unloading_port, departure_date, arrival_date,
 *               departure_time, docking_number },
 *   bls: [
 *     { bl_no, bl_type, consignee_name, consignor_name,
 *       hacienda_tariff, value, package_qty, gross_weight,
 *       goods_name, hacienda_item_code,
 *       hacienda_client_ss,        ← SS del consignatario
 *       cargoItems: [              ← opcional, items por contenedor
 *         { container_no, goods_name, gross_weight,
 *           hacienda_item_code, hacienda_tariff }
 *       ]
 *     }
 *   ],
 *   containers: [
 *     { bl_no, container_no, size, type }
 *   ]
 * }
 */
app.post('/guardar', async (req, res) => {
  const { manifest, bls, containers } = req.body;

  if (!manifest?.voyage_no) {
    return res.status(400).json({ error: 'manifest.voyage_no es requerido' });
  }
  if (!Array.isArray(bls) || bls.length === 0) {
    return res.status(400).json({ error: 'bls[] no puede estar vacío' });
  }

  const voyageNo = dbf.fmtStr(manifest.voyage_no, 10);

  try {
    // ── Calcular siguiente lote ──────────────────────────────────
    const loteRows = await dbf.query('SELECT MAX(lotnum) AS maxlote FROM MANIFEST');
    const nextLote = (parseInt(loteRows[0]?.maxlote) || 3000000) + 1;

    // ── Eliminar registros previos (re-inserción limpia) ─────────
    await borrarViaje(voyageNo);

    // ── INSERT MANIFEST ──────────────────────────────────────────
    const m = manifest;
    const vesselName = dbf.fmtStr(m.vessel_name || m.vessel_code || '', 20);
    const arrDate    = dbf.fmtDate(m.arrival_date);
    const depDate    = dbf.fmtDate(m.departure_date);
    const origPort   = dbf.fmtStr(m.loading_port, 3);
    const discPort   = dbf.fmtStr(m.unloading_port, 3);
    const carrier    = dbf.fmtStr(m.carrier_code, 10);
    const imo        = dbf.fmtStr(m.imo, 10);
    const docking    = dbf.fmtStr(m.docking_number, 10);
    const dtime      = dbf.fmtStr(fmtHora(m.departure_time), 5);
    const todayDate  = dbf.fmtDate(today());

    await dbf.execute(`
      INSERT INTO MANIFEST
        (manifest, date, mawb, vessel, voyfli, sdate, idate, dtime,
         forigin, origport, discport, destport,
         tind, agent,
         carrier, lotnum, lotdate, lottype, lotamt,
         arrival, imo, docking)
      VALUES (
        '${voyageNo}',
        ${arrDate},
        '${voyageNo}',
        '${vesselName}',
        '${voyageNo}',
        ${depDate},
        ${arrDate},
        '${dtime}',
        '${origPort}',
        '${origPort}',
        '${discPort}',
        '${discPort}',
        .F.,
        .F.,
        '${carrier}',
        ${nextLote},
        ${todayDate},
        'N',
        0,
        ${arrDate},
        '${imo}',
        '${docking}'
      )
    `);

    // ── Agrupar contenedores por BL ──────────────────────────────
    const contByBl = {};
    (containers || []).forEach(cb => {
      const key = String(cb.bl_no);
      (contByBl[key] = contByBl[key] || []).push(cb);
    });

    let totalBls = 0;

    // ── Iterar BLs ───────────────────────────────────────────────
    for (const bl of bls) {
      const bolNo  = dbf.fmtStr(bl.bl_no, 20);
      const blType = dbf.fmtStr(bl.bl_type || 'M', 1);

      // FOB: si tarifa = 040 (libre arancel) → siempre 0
      const isLibre = (bl.hacienda_tariff === '040');
      const fob     = isLibre ? 0 : (parseFloat(bl.value) || 0);

      const consignee  = dbf.fmtStr(bl.consignee_name, 30);
      const exporter   = dbf.fmtStr(bl.consignor_name, 30);

      // ── INSERT BOL ───────────────────────────────────────────
      await dbf.execute(`
        INSERT INTO BOL
          (manifest, bolno, date, boltype,
           consigne, exporter,
           ptype, pind, taxtype,
           taxamt, taxadi, invamt,
           discport, destport, coriport,
           relno, declno, status)
        VALUES (
          '${voyageNo}',
          '${bolNo}',
          ${arrDate},
          '${blType}',
          '${consignee}',
          '${exporter}',
          'C',
          'C',
          'A',
          0, 0,
          ${dbf.fmtNum(fob)},
          '${discPort}',
          '${discPort}',
          '${origPort}',
          '', '',
          'E'
        )
      `);

      // ── INSERT BOLCONT (uno por contenedor del BL) ───────────
      const blContainers = contByBl[String(bl.bl_no)] || [];
      let contSec = 1;

      for (const cb of blContainers) {
        const contNo   = dbf.fmtStr(cb.container_no, 15);
        const contSize = dbf.fmtSize(cb.size);
        const contType = dbf.fmtStr(cb.type || 'R', 1);

        await dbf.execute(`
          INSERT INTO BOLCONT
            (manifest, bolno, contain, size, type, sec)
          VALUES (
            '${voyageNo}',
            '${bolNo}',
            '${contNo}',
            '${contSize}',
            '${contType}',
            ${contSec++}
          )
        `);
      }

      const hasContainer = blContainers.length > 0;
      const pkgType = hasContainer ? 'BOX' : 'LSE';

      // ── INSERT BOLITEM ───────────────────────────────────────
      // Usar cargoItems si existen, si no usar datos del BL
      const cargoItems = Array.isArray(bl.cargoItems) && bl.cargoItems.length > 0
        ? bl.cargoItems
        : null;

      if (cargoItems) {
        // Items por contenedor (multi-cargo)
        let itemSec = 1;
        for (const item of cargoItems) {
          const itemIsLibre = (item.hacienda_tariff === '040') || isLibre;
          const itemFob     = itemIsLibre ? 0 : (parseFloat(item.value || bl.value) || 0);
          const itemDesc    = dbf.fmtStr(
            String(item.goods_name || bl.goods_name || '').replace(/[\r\n]+/g, ' '),
            80
          );
          const itemCode    = dbf.fmtStr(item.hacienda_item_code || bl.hacienda_item_code, 10);
          const itemTariff  = dbf.fmtStr(item.hacienda_tariff || bl.hacienda_tariff, 3);
          const itemWeight  = dbf.fmtNum(item.gross_weight || bl.gross_weight, 4);
          const itemPkg     = parseInt(bl.package_qty) || 0;
          const controlRef  = dbf.fmtStr(item.container_no || '', 15);

          await dbf.execute(`
            INSERT INTO BOLITEM
              (manifest, bolno, qty, ptype, weight, [desc],
               sind, qrec, code, value, rate,
               wind, vind, taxamt, taxadi, control, sec)
            VALUES (
              '${voyageNo}',
              '${bolNo}',
              ${itemPkg},
              '${pkgType}',
              ${itemWeight},
              '${itemDesc}',
              '',
              ${itemPkg},
              '${itemCode}',
              ${dbf.fmtNum(itemFob)},
              '${itemTariff}',
              'K',
              'F',
              0, 0,
              '${controlRef}',
              ${itemSec++}
            )
          `);
        }
      } else {
        // Item único desde el BL
        const descText = dbf.fmtStr(
          String(bl.goods_name || '').replace(/[\r\n]+/g, ' '),
          80
        );
        const itemCode   = dbf.fmtStr(bl.hacienda_item_code, 10);
        const itemTariff = dbf.fmtStr(bl.hacienda_tariff, 3);
        const itemWeight = dbf.fmtNum(bl.gross_weight, 4);
        const itemPkg    = parseInt(bl.package_qty) || 0;
        const firstCont  = blContainers[0]?.container_no || '';

        await dbf.execute(`
          INSERT INTO BOLITEM
            (manifest, bolno, qty, ptype, weight, [desc],
             sind, qrec, code, value, rate,
             wind, vind, taxamt, taxadi, control, sec)
          VALUES (
            '${voyageNo}',
            '${bolNo}',
            ${itemPkg},
            '${pkgType}',
            ${itemWeight},
            '${descText}',
            '',
            ${itemPkg},
            '${itemCode}',
            ${dbf.fmtNum(fob)},
            '${itemTariff}',
            'K',
            'F',
            0, 0,
            '${dbf.fmtStr(firstCont, 15)}',
            1
          )
        `);
      }

      totalBls++;
    }

    res.json({
      ok: true,
      voyageNo,
      lote: nextLote,
      bls: totalBls,
      containers: (containers || []).length
    });

  } catch (e) {
    console.error('[GUARDAR ERROR]', e);
    res.status(500).json({ error: e.message, voyageNo });
  }
});

// ── Inicio ────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`SiscommateBridge corriendo en puerto ${PORT}`);
  console.log(`DBF Path: ${DBF_PATH}`);
});
