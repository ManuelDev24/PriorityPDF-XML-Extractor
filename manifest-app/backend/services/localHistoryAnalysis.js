// services/localHistoryAnalysis.js — Aprender de lo que los operadores YA
// escribieron en esta app (bills_of_lading), no del historial general de
// SISCOMMATE (eso lo hace itemClientAnalysis.js).
//
// Dos sugerencias distintas, mismo principio: mientras más se use el editor,
// mejor debería sugerir. Uso puntual desde Admin — el historial no cambia de
// un día para otro, así que no hace falta correrlo en cada arranque.

const db = require('../db/connection');

const MIN_OCURRENCIAS = 2;

/**
 * Normaliza una descripción de mercancía para agrupar variantes triviales
 * (mayúsculas/espacios) como la misma descripción. No intenta fuzzy-matching
 * real — dos descripciones que difieran en una palabra cuentan como distintas.
 * @param {string} desc
 * @returns {string}
 */
function normalizarDescripcion(desc) {
  return (desc || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

/**
 * Descripción de mercancía → código arancelario más usado para esa
 * descripción exacta (normalizada), según bills_of_lading local. Guarda el
 * resultado en learned_item_by_desc; lo consume GET /api/catalogs/items/suggest.
 * @returns {{descripciones_con_historial:number, descripciones_aprendidas:number}}
 */
function analizarDescripcionItem() {
  const filas = db.prepare(`
    SELECT goods_name, hacienda_item_code FROM bills_of_lading
    WHERE goods_name IS NOT NULL AND goods_name != ''
      AND hacienda_item_code IS NOT NULL AND hacienda_item_code != ''
  `).all();

  const porDescripcion = new Map();
  filas.forEach(f => {
    const norm = normalizarDescripcion(f.goods_name);
    if (!norm) return;
    if (!porDescripcion.has(norm)) porDescripcion.set(norm, new Map());
    const porCodigo = porDescripcion.get(norm);
    porCodigo.set(f.hacienda_item_code, (porCodigo.get(f.hacienda_item_code) || 0) + 1);
  });

  const upsert = db.prepare(`
    INSERT INTO learned_item_by_desc (desc_norm, item_code, n) VALUES (?, ?, ?)
    ON CONFLICT(desc_norm) DO UPDATE SET item_code=excluded.item_code, n=excluded.n
  `);

  let aprendidas = 0;
  const guardar = db.transaction(() => {
    porDescripcion.forEach((porCodigo, norm) => {
      let mejorCodigo = null, mejorN = 0;
      porCodigo.forEach((n, codigo) => { if (n > mejorN) { mejorN = n; mejorCodigo = codigo; } });
      if (mejorN >= MIN_OCURRENCIAS) {
        upsert.run(norm, mejorCodigo, mejorN);
        aprendidas++;
      }
    });
  });
  guardar();

  return { descripciones_con_historial: porDescripcion.size, descripciones_aprendidas: aprendidas };
}

/**
 * Código arancelario → consignatario más frecuente EN TU PROPIO HISTORIAL
 * (bills_of_lading), a diferencia de itemClientAnalysis.js que mira el
 * historial completo de SISCOMMATE. Cuando hay suficiente evidencia local
 * (>=2 casos), pisa lo que haya puesto el análisis de SISCOMMATE en
 * hacienda_items — el patrón real de Priority es más confiable que el
 * patrón genérico de todos los usuarios de SISCOMMATE.
 * @returns {{codigos_con_historial:number, codigos_aprendidos:number}}
 */
function analizarClientePorCodigo() {
  const filas = db.prepare(`
    SELECT hacienda_item_code AS code, hacienda_client_ss AS ss, consignee_name AS name,
           consignee_tel AS phone, consignee_street AS add1, consignee_city AS add2,
           hacienda_client_ivu AS ivu
    FROM bills_of_lading
    WHERE hacienda_item_code IS NOT NULL AND hacienda_item_code != ''
      AND hacienda_client_ss IS NOT NULL AND hacienda_client_ss != ''
  `).all();

  const codigosValidos = new Set(db.prepare(`SELECT code FROM hacienda_items`).all().map(r => r.code));

  const porCodigo = new Map();
  filas.forEach(f => {
    if (!codigosValidos.has(f.code)) return;
    if (!porCodigo.has(f.code)) porCodigo.set(f.code, new Map());
    const porSS = porCodigo.get(f.code);
    if (!porSS.has(f.ss)) porSS.set(f.ss, { n: 0, ultimo: f });
    const entrada = porSS.get(f.ss);
    entrada.n++;
    entrada.ultimo = f; // el más reciente en orden de id (SELECT sin ORDER BY sigue orden de inserción en SQLite)
  });

  const actualizar = db.prepare(`
    UPDATE hacienda_items
    SET client_name=?, client_ss=?, client_phone=?, client_add1=?, client_add2=?, client_ivu=?
    WHERE code=?
  `);

  let aprendidos = 0;
  const guardar = db.transaction(() => {
    porCodigo.forEach((porSS, code) => {
      let mejorSS = null, mejorEntrada = null;
      porSS.forEach((entrada, ss) => { if (entrada.n > (mejorEntrada?.n || 0)) { mejorEntrada = entrada; mejorSS = ss; } });
      if (mejorEntrada && mejorEntrada.n >= MIN_OCURRENCIAS) {
        const f = mejorEntrada.ultimo;
        actualizar.run(f.name || '', mejorSS, f.phone || '', f.add1 || '', f.add2 || '', f.ivu || '', code);
        aprendidos++;
      }
    });
  });
  guardar();

  return { codigos_con_historial: porCodigo.size, codigos_aprendidos: aprendidos };
}

/**
 * Corre ambos análisis de una vez — botón único en Admin.
 */
function analizarHistorialLocal() {
  const item = analizarDescripcionItem();
  const cliente = analizarClientePorCodigo();
  return { ...item, ...cliente };
}

module.exports = { analizarHistorialLocal, normalizarDescripcion, MIN_OCURRENCIAS };
