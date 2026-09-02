// routes/settings.js — Configuración persistente y mapeo de tipos de contenedor
//
// Extraído de server.js (paso 5 de la separación backend/frontend).

const express = require('express');
const db = require('../db/connection');

const router = express.Router();

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
    if (req.body[k] !== undefined) upd.run(k, String(req.body[k]).trim());
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
