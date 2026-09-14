// routes/catalogs.js — Catálogos: items Hacienda, puertos, carriers, clientes, buques
//
// Extraído de server.js (paso 5 de la separación backend/frontend).

const express = require('express');
const db = require('../db/connection');
const { VESSELS, PORT_MAPPINGS, VALID_CONTAINER_SIZES } = require('../db/catalogDefaults');
const {
  buscarClientesSiscommate, crearClienteSiscommate, actualizarClienteSiscommate, eliminarClienteSiscommate,
} = require('../services/siscommateClient');
const { analizarYGuardar } = require('../services/itemClientAnalysis');
const { analizarHistorialLocal, normalizarDescripcion } = require('../services/localHistoryAnalysis');
const { sincronizarClientesDesdeSiscommate, buscarClienteParecido } = require('../services/clientSync');

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

// Corre el análisis código arancelario → cliente más frecuente contra el
// historial real de SISCOMMATE (vía el bridge) y guarda el resultado en
// hacienda_items.client_name/client_ss. Uso puntual desde Admin, no algo que
// se dispare solo — el historial no cambia de un día para otro, y puede
// tardar porque consulta el bridge repetidamente.
router.post('/api/catalogs/items/analizar-clientes', async (req, res) => {
  try {
    const resultado = await analizarYGuardar();
    res.json({ ok: true, ...resultado });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo completar el análisis: ' + err.message });
  }
});

// Corre el análisis del historial LOCAL (bills_of_lading de esta app, no
// SISCOMMATE) — ver services/localHistoryAnalysis.js. Síncrono y rápido
// (no toca el bridge), pero igual manual: el historial no cambia de un día
// para otro.
router.post('/api/catalogs/items/analizar-historial-local', (req, res) => {
  try {
    const resultado = analizarHistorialLocal();
    res.json({ ok: true, ...resultado });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo completar el análisis: ' + err.message });
  }
});

// Sugerir código arancelario basado en descripción de la mercancía
router.get('/api/catalogs/items/suggest', (req, res) => {
  const desc = (req.query.desc || '').toLowerCase();
  if (!desc || desc.length < 3) return res.json([]);

  // Aprendido del historial local (ver localHistoryAnalysis.js): si esta
  // descripción exacta (normalizada) ya se usó antes con un código
  // consistente, va de primero — es más confiable que el match por palabra
  // clave contra el catálogo genérico.
  const seen = new Set();
  const candidates = [];
  const aprendido = db.prepare(`
    SELECT hi.*, la.n as veces_usado FROM learned_item_by_desc la
    JOIN hacienda_items hi ON hi.code = la.item_code
    WHERE la.desc_norm = ?
  `).get(normalizarDescripcion(req.query.desc || ''));
  if (aprendido) { seen.add(aprendido.code); candidates.push({ ...aprendido, score: 1000 }); }

  // Extraer palabras clave de la descripción (ignorar palabras cortas y comunes)
  const stopWords = new Set(['and','the','for','with','not','per','are','fue','los','las','del','con','para','que','una','uno']);
  const words = desc.split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w)).slice(0, 5);
  if (!words.length) return res.json(candidates);

  // Buscar coincidencias por cada palabra clave
  const stmt = db.prepare(`SELECT *, ? as match_word FROM hacienda_items WHERE description LIKE ? LIMIT 10`);
  words.forEach(word => {
    stmt.all(word, `%${word}%`).forEach(row => {
      if (!seen.has(row.code)) { seen.add(row.code); candidates.push(row); }
    });
  });

  // Puntuar: cuántas palabras clave aparecen en la descripción (el
  // aprendido ya trae score:1000, se queda de primero sin recalcularlo)
  const scored = candidates.map(item => {
    if (item.score === 1000) return item;
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
  // El límite por defecto (20) es para el autocompletar del editor; la
  // pantalla de Clientes en Admin pide más filas explícitamente (cap 500
  // para no mandar el catálogo completo de un golpe).
  const limit = Math.min(Number(req.query.limit) || 20, 500);
  res.json(db.prepare(
    `SELECT * FROM clients WHERE name LIKE ? OR taxid LIKE ? OR ss LIKE ? ORDER BY name LIMIT ?`
  ).all(`%${q}%`, `%${q}%`, `%${q}%`, limit));
});

// Cuántos clientes hay en el catálogo local — para el contador en Admin sin
// tener que traer las filas.
router.get('/api/catalogs/clients/count', (req, res) => {
  res.json(db.prepare(`SELECT COUNT(*) as total FROM clients`).get());
});

// Trae TODO el catálogo CUSTOMER de SISCOMMATE y actualiza/crea en el
// catálogo local — ver services/clientSync.js. Manual desde Admin: no se
// dispara solo, el catálogo real no cambia de un minuto a otro.
router.post('/api/catalogs/clients/sincronizar-siscommate', async (req, res) => {
  try {
    const resultado = await sincronizarClientesDesdeSiscommate();
    res.json({ ok: true, ...resultado });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo sincronizar con SISCOMMATE: ' + err.message });
  }
});

// ¿Hay un cliente local con un nombre PARECIDO (no igual) al que se está por
// guardar? Para avisar de un posible error de digitación en el editor — solo
// sugiere, nunca cambia nada solo.
router.get('/api/catalogs/clients/parecido', (req, res) => {
  const nombre = req.query.name || '';
  res.json({ sugerencia: buscarClienteParecido(nombre) });
});

// Clientes reales de SISCOMMATE (tabla CUSTOMER, vía el bridge) — para
// autocompletar el consignatario con datos que no están en nuestro catálogo
// local. De solo lectura: nunca se guarda nada de vuelta en SISCOMMATE aquí.
router.get('/api/catalogs/siscommate-clients', async (req, res) => {
  const q = req.query.q || '';
  res.json(await buscarClientesSiscommate(q));
});

// Campos "extra" de CUSTOMER.DBF que el formulario de "+ Crear nuevo
// consignatario" del editor no usa (solo manda name/ss/taxid/add1/add2/
// phone1/ivu) pero que sí puede mandar la pantalla de Clientes en Admin —
// se leen si vienen, nunca se exigen.
function camposExtra(body) {
  return {
    code: body.code || '', type: body.type || '',
    add3: body.add3 || '', phone2: body.phone2 || '',
    fax1: body.fax1 || '', fax2: body.fax2 || '',
  };
}

router.post('/api/catalogs/clients', async (req, res) => {
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
  const extra = camposExtra(req.body);
  const info = db.prepare(`
    INSERT INTO clients (name,ss,taxid,add1,add2,phone1,ivu,code,type,add3,phone2,fax1,fax2)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    name.trim(), ssSanitized, taxid || '', add1 || '', add2 || '', phone1 || '', ivu || '',
    extra.code, extra.type, extra.add3, extra.phone2, extra.fax1, extra.fax2
  );
  const client = db.prepare(`SELECT * FROM clients WHERE id=?`).get(info.lastInsertRowid);

  // Best-effort: SISCOMMATE es la fuente real (ver clientSync.js), pero si el
  // bridge no responde no tiene sentido perder el guardado local por eso —
  // se reporta aparte para que quien edita sepa si de verdad llegó allá.
  let siscommate = { ok: false, error: 'No se intentó (revisa la conexión con el bridge)' };
  try {
    await crearClienteSiscommate(client);
    siscommate = { ok: true };
  } catch (err) {
    siscommate = { ok: false, error: err.message };
  }
  res.json({ ok: true, client, siscommate });
});

router.put('/api/catalogs/clients/:id', async (req, res) => {
  const actual = db.prepare(`SELECT * FROM clients WHERE id=?`).get(req.params.id);
  if (!actual) return res.status(404).json({ error: 'Cliente no encontrado' });

  const { name, ss, taxid, add1, add2, phone1, ivu } = req.body;
  const ssSanitized = ss ? String(ss).replace(/[^0-9]/g, '').substring(0, 9) : undefined;
  const extra = camposExtra(req.body);
  const sets = []; const vals = [];
  if (name)              { sets.push('name=?');   vals.push(name.trim()); }
  if (ssSanitized)       { sets.push('ss=?');     vals.push(ssSanitized); }
  if (taxid !== undefined)  { sets.push('taxid=?');  vals.push(taxid); }
  if (add1 !== undefined)   { sets.push('add1=?');   vals.push(add1); }
  if (add2 !== undefined)   { sets.push('add2=?');   vals.push(add2); }
  if (phone1 !== undefined) { sets.push('phone1=?'); vals.push(phone1); }
  if (ivu !== undefined)    { sets.push('ivu=?');    vals.push(ivu); }
  if (req.body.code !== undefined)   { sets.push('code=?');   vals.push(extra.code); }
  if (req.body.type !== undefined)   { sets.push('type=?');   vals.push(extra.type); }
  if (req.body.add3 !== undefined)   { sets.push('add3=?');   vals.push(extra.add3); }
  if (req.body.phone2 !== undefined) { sets.push('phone2=?'); vals.push(extra.phone2); }
  if (req.body.fax1 !== undefined)   { sets.push('fax1=?');   vals.push(extra.fax1); }
  if (req.body.fax2 !== undefined)   { sets.push('fax2=?');   vals.push(extra.fax2); }
  if (sets.length) {
    vals.push(req.params.id);
    db.prepare(`UPDATE clients SET ${sets.join(',')} WHERE id=?`).run(...vals);
  }
  const client = db.prepare(`SELECT * FROM clients WHERE id=?`).get(req.params.id);

  // Se busca en SISCOMMATE por el nombre ANTERIOR (actual.name, antes de
  // aplicar este cambio) — si el nombre se editó en el mismo guardado, ya no
  // sirve como referencia después. filas_afectadas distingue "no se encontró
  // ese nombre allá" (0) de "el nombre no era único" (>1) — ver
  // services/siscommateClient.js#actualizarClienteSiscommate.
  let siscommate = { ok: false, error: 'No se intentó (revisa la conexión con el bridge)' };
  try {
    const r = await actualizarClienteSiscommate(actual.name, client);
    if (r.filas_afectadas === 0) {
      siscommate = { ok: false, error: `No se encontró "${actual.name}" en SISCOMMATE — puede que ya no exista con ese nombre.` };
    } else if (r.filas_afectadas > 1) {
      siscommate = { ok: false, error: `Había ${r.filas_afectadas} clientes con el nombre "${actual.name}" en SISCOMMATE — se actualizaron todos, revisa que sea correcto.` };
    } else {
      siscommate = { ok: true };
    }
  } catch (err) {
    siscommate = { ok: false, error: err.message };
  }
  res.json({ ok: true, client, siscommate });
});

// Elimina local Y en CUSTOMER.DBF real (por nombre exacto) — pensado sobre
// todo para limpiar duplicados detectados a mano en la pantalla de Clientes.
// Irreversible: la confirmación queda del lado del frontend (mismo patrón
// que ya usa "Eliminar" en Tipos de contenedor).
router.delete('/api/catalogs/clients/:id', async (req, res) => {
  const cliente = db.prepare(`SELECT * FROM clients WHERE id=?`).get(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

  db.prepare(`DELETE FROM clients WHERE id=?`).run(req.params.id);

  let siscommate = { ok: false, error: 'No se intentó (revisa la conexión con el bridge)' };
  try {
    const r = await eliminarClienteSiscommate(cliente.name);
    if (r.filas_afectadas === 0) {
      siscommate = { ok: false, error: `No se encontró "${cliente.name}" en SISCOMMATE — puede que ya no exista con ese nombre.` };
    } else {
      siscommate = { ok: true, filas_afectadas: r.filas_afectadas };
    }
  } catch (err) {
    siscommate = { ok: false, error: err.message };
  }
  res.json({ ok: true, deleted: cliente.name, siscommate });
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
