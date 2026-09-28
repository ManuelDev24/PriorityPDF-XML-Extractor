// routes/dataAudit.js — Auditoria SQLite + SISCOMMATE via Excel, expuesta en
// /admin (pestaña "Auditoría de datos"). Solo expone HTTP encima de la
// lógica ya construida y testeada en services/dataAudit/*.js — este archivo
// no calcula nada por su cuenta.
//
// El CLI (backend/scripts/dataAudit.js) sigue existiendo tal cual, para usar
// sin navegador.

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db/connection');
const siscommate = require('../services/siscommateClient');
const { construirLibroAuditoria } = require('../services/dataAudit/exportar');
const { calcularPlanDeCambios, formatearVistaPrevia, aplicarCambios } = require('../services/dataAudit/reinyectar');
const { registrarCambio } = require('../services/dataAudit/log');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// El archivo subido para "preview" se guarda en memoria (nunca en disco) bajo
// un token, para que "aplicar" pueda recalcular el plan fresco sin pedirle al
// navegador que lo suba dos veces. TTL corto: es un flujo de un solo uso,
// pensado para segundos entre preview y aplicar, no para dejarlo pendiente.
const TTL_MS = 30 * 60 * 1000;
const previews = new Map(); // token -> { buffer, creadoEn }

function limpiarPreviewsVencidos() {
  const ahora = Date.now();
  for (const [token, entrada] of previews) {
    if (ahora - entrada.creadoEn > TTL_MS) previews.delete(token);
  }
}

// El plan trae spec.escribirCambio/leerActual (funciones de hojas.js), que no
// son serializables — el cliente solo necesita ver hoja/claves/cambios/error.
function paraJson(plan) {
  return plan.map(({ hoja, claves, cambios, error }) => ({ hoja, claves, cambios: cambios || {}, error: error || null }));
}

router.get('/api/data-audit/exportar', async (req, res) => {
  try {
    const workbook = await construirLibroAuditoria(db, siscommate);
    const p = n => String(n).padStart(2, '0');
    const d = new Date();
    const nombre = `audit_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/data-audit/preview', upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo Excel (campo "archivo").' });
  try {
    limpiarPreviewsVencidos();
    const plan = await calcularPlanDeCambios(req.file.buffer, { db, siscommate });
    const token = crypto.randomUUID();
    previews.set(token, { buffer: req.file.buffer, creadoEn: Date.now() });
    res.json({ token, plan: paraJson(plan), vistaPrevia: formatearVistaPrevia(plan) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/data-audit/aplicar', async (req, res) => {
  const token = req.body && req.body.token;
  const entrada = token && previews.get(token);
  if (!entrada) {
    return res.status(410).json({ error: 'El preview expiró o no existe — vuelve a subir el archivo.' });
  }
  try {
    // Recalcula el plan fresco contra el estado ACTUAL (no el que se vio en
    // el preview) — si algo cambió mientras tanto, esto evita aplicar un
    // diff desactualizado.
    const plan = await calcularPlanDeCambios(entrada.buffer, { db, siscommate });
    const resultado = await aplicarCambios(plan, { db, siscommate }, registrarCambio);
    previews.delete(token);
    res.json(resultado);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
