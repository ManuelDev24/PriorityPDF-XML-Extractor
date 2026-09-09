// routes/catalogs.js — Catálogos: items Hacienda, puertos, carriers, clientes, buques
//
// Extraído de server.js (paso 5 de la separación backend/frontend).

const express = require('express');
const db = require('../db/connection');
const { VESSELS, PORT_MAPPINGS, VALID_CONTAINER_SIZES } = require('../db/catalogDefaults');
const { buscarClientesSiscommate } = require('../services/siscommateClient');

const router = express.Router();

// ── ITEMS DE HACIENDA ────────────────────────────────────────────────────────
router.get('/api/catalogs/items', (req, res) => {
  const q = req.query.q || '';
  // Escapar caracteres especiales de LIKE para evitar wildcards involuntarios
  const qLike = q.replace(/[%_\\]/g, '\\$&');
  const rows = db.prepare(`
    SELECT * FROM hacienda_items
    WHERE description LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\'
    ORDER BY
      CASE WHEN code=? THEN 0
           WHEN code LIKE ? ESCAPE '\\' THEN 1
           WHEN description LIKE ? ESCAPE '\\' THEN 2
           ELSE 3 END,
      length(code), code
    LIMIT 40
  `).all(`%${qLike}%`, `%${qLike}%`, q, `${qLike}%`, `${qLike}%`);
  res.json(rows);
});

// Sugerir código arancelario basado en descripción de la mercancía
router.get('/api/catalogs/items/suggest', (req, res) => {
  const desc = (req.query.desc || '').toLowerCase();
  if (!desc || desc.length < 3) return res.json([]);

  // Extraer palabras clave de la descripción (ignorar palabras cortas y comunes)
  const stopWords = new Set(['and','the','for','with','not','per','are','fue','los','las','del','con','para','que','una','uno']);
  const words = desc.split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w)).slice(0, 5);
  if (!words.length) return res.json([]);

  // Buscar coincidencias por cada palabra clave
  const candidates = [];
  const seen = new Set();
  const stmt = db.prepare(`SELECT *, ? as match_word FROM hacienda_items WHERE description LIKE ? LIMIT 10`);
  words.forEach(word => {
    stmt.all(word, `%${word}%`).forEach(row => {
      if (!seen.has(row.code)) { seen.add(row.code); candidates.push(row); }
    });
  });

  // Puntuar: cuántas palabras clave aparecen en la descripción
  const scored = candidates.map(item => {
    let score = 0;
    words.forEach(w => { if (item.description.toLowerCase().includes(w)) score++; });
    return { ...item, score };
  }).sort((a, b) => b.score - a.score).slice(0, 8);

  res.json(scored);
});

// ── PUERTOS Y CARRIERS ───────────────────────────────────────────────────────
router.get('/api/catalogs/ports', (req, res) => {
  res.json(db.prepare('SELECT * FROM ports ORDER BY country,description').all());
});

router.get('/api/catalogs/port-mappings', (req, res) => {
  try {
    res.json(db.prepare(
      'SELECT dga_code, siscommate_code, label FROM port_mappings ORDER BY dga_code'
    ).all());
  } catch (err) {
    console.warn('[catalogs/port-mappings] SQLite unavailable:', err.message);
    res.json(PORT_MAPPINGS.map(([dga_code, siscommate_code]) => ({
      dga_code, siscommate_code, label: '',
    })));
  }
});

// Valores válidos para BOLCONT.size. Se derivan del catálogo editable para
// que editor y administración no mantengan listas divergentes.
router.get('/api/catalogs/container-sizes', (req, res) => {
  const configured = db.prepare(
    `SELECT DISTINCT size FROM container_type_map
     WHERE size IS NOT NULL AND trim(size) <> '' ORDER BY size`
  ).all().map(row => row.size);
  res.json([...new Set([...VALID_CONTAINER_SIZES, ...configured])]);
});

router.get('/api/catalogs/carriers', (req, res) => {
  res.json(db.prepare('SELECT * FROM carriers').all());
});

// ── CLIENTES / CONSIGNATARIOS ────────────────────────────────────────────────
router.get('/api/catalogs/clients', (req, res) => {
  const q = req.query.q || '';
  res.json(db.prepare(
    `SELECT * FROM clients WHERE name LIKE ? OR taxid LIKE ? OR ss LIKE ? ORDER BY name LIMIT 20`
  ).all(`%${q}%`, `%${q}%`, `%${q}%`));
});

// Clientes reales de SISCOMMATE (tabla CUSTOMER, vía el bridge) — para
// autocompletar el consignatario con datos que no están en nuestro catálogo
// local. De solo lectura: nunca se guarda nada de vuelta en SISCOMMATE aquí.
router.get('/api/catalogs/siscommate-clients', async (req, res) => {
  const q = req.query.q || '';
  res.json(await buscarClientesSiscommate(q));
});

router.post('/api/catalogs/clients', (req, res) => {
  const { name, ss, taxid, add1, add2, phone1, ivu } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  const ssSanitized = String(ss || '').replace(/[^0-9]/g, '').substring(0, 9);
  if (ssSanitized.length < 9) return res.status(400).json({ error: 'El SS/EIN debe tener 9 dígitos numéricos' });

  const exists = db.prepare(`SELECT id,name FROM clients WHERE ss=?`).get(ssSanitized);
  if (exists) {
    return res.status(409).json({
      error: `Ya existe un consignatario con SS ${ssSanitized}: ${exists.name}`,
      client: exists,
    });
  }
  const info = db.prepare(`INSERT INTO clients (name,ss,taxid,add1,add2,phone1,ivu) VALUES (?,?,?,?,?,?,?)`)
    .run(name.trim(), ssSanitized, taxid || '', add1 || '', add2 || '', phone1 || '', ivu || '');
  const client = db.prepare(`SELECT * FROM clients WHERE id=?`).get(info.lastInsertRowid);
  res.json({ ok: true, client });
});

router.put('/api/catalogs/clients/:id', (req, res) => {
  const { name, ss, taxid, add1, add2, phone1, ivu } = req.body;
  const ssSanitized = ss ? String(ss).replace(/[^0-9]/g, '').substring(0, 9) : undefined;
  const sets = []; const vals = [];
  if (name)              { sets.push('name=?');   vals.push(name.trim()); }
  if (ssSanitized)       { sets.push('ss=?');     vals.push(ssSanitized); }
  if (taxid !== undefined)  { sets.push('taxid=?');  vals.push(taxid); }
  if (add1 !== undefined)   { sets.push('add1=?');   vals.push(add1); }
  if (add2 !== undefined)   { sets.push('add2=?');   vals.push(add2); }
  if (phone1 !== undefined) { sets.push('phone1=?'); vals.push(phone1); }
  if (ivu !== undefined)    { sets.push('ivu=?');    vals.push(ivu); }
  if (sets.length) {
    vals.push(req.params.id);
    db.prepare(`UPDATE clients SET ${sets.join(',')} WHERE id=?`).run(...vals);
  }
  const client = db.prepare(`SELECT * FROM clients WHERE id=?`).get(req.params.id);
  res.json({ ok: true, client });
});

// ── BUQUES ───────────────────────────────────────────────────────────────────
router.get('/api/catalogs/vessels', (req, res) => {
  try {
    res.json(db.prepare(
      // rowid conserva el orden histórico del catálogo sembrado; no cambia la
      // forma de respuesta de la API ni impide agregar buques posteriormente.
      'SELECT code, name, imo, carrier, scac FROM vessels ORDER BY rowid'
    ).all());
  } catch (err) {
    // Permite arrancar durante una actualización en la que aún no se aplicó
    // la migración, sin volver a introducir el catálogo como fuente primaria.
    console.warn('[catalogs/vessels] SQLite unavailable:', err.message);
    res.json(VESSELS);
  }
});

module.exports = router;
