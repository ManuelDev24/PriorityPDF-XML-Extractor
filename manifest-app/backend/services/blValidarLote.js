// services/blValidarLote.js — "Validar todos" los B/L de un viaje
//
// Marcar un B/L como validado, uno por uno, no revisa nada: es solo cambiar
// el status. Lo que de verdad bloquea es el export TXT y el push a SISCOMMATE.
// Validar en lote sin criterio dejaría B/L "validados" que después no pasan
// esas puertas, así que aquí solo se validan los que están completos según la
// misma regla (blValidation.evaluarCompletitud) y los demás se dejan como
// están, diciendo por qué.

const { evaluarCompletitud } = require('./blValidation');
const { contenedoresSinTamano } = require('./txtGenerator');

/** @typedef {import('../types').BLRow} BLRow */

/**
 * @typedef {object} ResultadoValidarLote
 * @property {{id: number, bl_no: string}[]} validados Pasaron a 'validado' ahora
 * @property {{id: number, bl_no: string, motivos: string[]}[]} omitidos Quedaron como estaban, con la razón
 * @property {number} ya_validados Ya estaban validados; no se tocaron
 */

/**
 * Valida los B/L completos de un viaje, todo en una transacción. Evalúa los
 * B/L que el viaje tiene EN ESTE MOMENTO: uno que se movió fuera ya no está, y
 * uno que se movió adentro entra como cualquier otro (mover conserva el
 * status, y validar no toca nada de lo que SISCOMMATE sabe del B/L).
 * Idempotente: repetirlo no cambia nada que ya esté hecho.
 *
 * No recalcula el estado del viaje — eso lo hace la ruta con
 * recalcularEstadoManifiesto, que es quien conoce la regla de 'siscommate'.
 * @param {import('better-sqlite3').Database} db
 * @param {number} manifestId
 * @returns {ResultadoValidarLote|null} null si el viaje no existe
 */
function validarLote(db, manifestId) {
  const manifest = db.prepare('SELECT * FROM manifests WHERE id=?').get(manifestId);
  if (!manifest) return null;

  /** @type {BLRow[]} */
  const bls = db.prepare('SELECT * FROM bills_of_lading WHERE manifest_id=? ORDER BY bl_no').all(manifestId);

  // Mismos datos que arma el export-txt: contenedores de cada B/L (o el único
  // del B/L) y el tamaño de cada contenedor del viaje.
  /** @type {Record<string, string[]>} */
  const contenedoresPorBl = {};
  db.prepare('SELECT bl_no, container_no FROM container_bl WHERE manifest_id=?').all(manifestId).forEach(r => {
    (contenedoresPorBl[r.bl_no] = contenedoresPorBl[r.bl_no] || []).push(r.container_no);
  });
  /** @type {Record<string, string>} */
  const tamanoPorContenedor = {};
  db.prepare('SELECT container_no, size FROM containers WHERE manifest_id=?').all(manifestId).forEach(c => {
    tamanoPorContenedor[c.container_no] = c.size;
  });

  /** @type {ResultadoValidarLote} */
  const resultado = { validados: [], omitidos: [], ya_validados: 0 };
  bls.forEach(bl => {
    if (bl.status === 'validado') { resultado.ya_validados++; return; }

    const conTamano = /** @type {any} */ ({
      ...bl,
      containers: contenedoresPorBl[bl.bl_no] && contenedoresPorBl[bl.bl_no].length
        ? contenedoresPorBl[bl.bl_no]
        : [bl.hacienda_container_no || ''],
      containerSizes: tamanoPorContenedor,
    });
    const { completo, motivos } = evaluarCompletitud(manifest, bl, contenedoresSinTamano(conTamano));
    if (completo) resultado.validados.push({ id: bl.id, bl_no: bl.bl_no });
    else resultado.omitidos.push({ id: bl.id, bl_no: bl.bl_no, motivos });
  });

  const validar = db.prepare(`UPDATE bills_of_lading SET status='validado', modified_at=datetime('now') WHERE id=?`);
  db.transaction(() => { resultado.validados.forEach(b => validar.run(b.id)); })();
  return resultado;
}

module.exports = { validarLote };
