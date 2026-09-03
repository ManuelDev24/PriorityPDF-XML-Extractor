// routes/settings.js — Configuración persistente y mapeo de tipos de contenedor
//
// Extraído de server.js (paso 5 de la separación backend/frontend).

const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db/connection');

const router = express.Router();
const BRIDGE_CONFIG_PATH = process.env.SISCOMMATE_BRIDGE_CONFIG ||
  process.env.BRIDGE_CONFIG_PATH ||
  path.join(__dirname, '..', '..', 'bridge', 'siscommate-bridge.config');

function publishBridgeDbfPath(value) {
  try {
    fs.writeFileSync(BRIDGE_CONFIG_PATH, `dbf_path=${value || ''}\r\n`, { encoding: 'utf8' });
  } catch (err) {
    // SQLite sigue siendo la fuente de verdad; el bridge puede configurarse
    // por SISCOMMATE_DBF_PATH si el proceso no tiene permisos de escritura aquí.
    console.warn('[settings] no se pudo publicar configuración del bridge:', err.message);
  }
}

// Sincroniza configuraciones antiguas al arrancar, incluso si nadie vuelve a
// abrir Administración después de actualizar la aplicación.
try {
  const configured = db.prepare(`SELECT value FROM settings WHERE key='dbf_path'`).get();
  if (configured) publishBridgeDbfPath(configured.value);
} catch (_) { /* migración pendiente; el arranque continúa */ }

// ── SETTINGS ─────────────────────────────────────────────────────────────────
router.get('/api/settings', (req, res) => {
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  const obj = {};
  rows.forEach(r => { obj[r.key] = r.value; });
  res.json(obj);
});

router.put('/api/settings', (req, res) => {
  const allowed = ['bridge_host', 'bridge_port', 'dbf_path'];
  const upd = db.prepare(
    `INSERT INTO settings(key,value) VALUES(?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  );
  allowed.forEach(k => {
    if (req.body[k] !== undefined) {
      const value = String(req.body[k]).trim();
      upd.run(k, value);
      if (k === 'dbf_path') publishBridgeDbfPath(value);
    }
  });
  res.json({ ok: true });
});

// ── CATÁLOGO CONTAINER TYPE MAP ──────────────────────────────────────────────
router.get('/api/catalogs/container-types', (req, res) => {
  res.json(db.prepare(`SELECT * FROM container_type_map ORDER BY xml_type`).all());
});

router.put('/api/catalogs/container-types/:xmlType', (req, res) => {
  const { size, label } = req.body;
  db.prepare(
    `INSERT INTO container_type_map(xml_type,size,label) VALUES(?,?,?)
     ON CONFLICT(xml_type) DO UPDATE SET size=excluded.size, label=excluded.label`
  ).run(req.params.xmlType, size || '', label || '');
  res.json({ ok: true });
});

router.post('/api/catalogs/container-types', (req, res) => {
  const { xml_type, size, label } = req.body;
  if (!xml_type || !size) return res.status(400).json({ error: 'xml_type y size requeridos' });
  try {
    db.prepare(`INSERT INTO container_type_map(xml_type,size,label) VALUES(?,?,?)`)
      .run(xml_type.trim(), size.trim(), label || '');
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: 'Código XML ya existe: ' + e.message });
  }
});

router.delete('/api/catalogs/container-types/:xmlType', (req, res) => {
  db.prepare(`DELETE FROM container_type_map WHERE xml_type=?`).run(req.params.xmlType);
  res.json({ ok: true });
});

module.exports = router;
