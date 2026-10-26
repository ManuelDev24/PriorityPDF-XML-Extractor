// backend/services/dataAudit/dedupe.js — De-duplicacion de consignadores y
// consignatarios para el Excel de auditoria: una fila por entidad real, no
// por B/L, para no tener que corregir la misma direccion mal escrita decenas
// de veces. actualizarConsignador/atarioPorNombre hacen el camino inverso:
// una correccion en la hoja deduplicada se propaga a TODOS los B/L que
// compartan ese nombre.

const CAMPOS_CONSIGNADOR = [
  'consignor_name', 'consignor_document_type', 'consignor_document_no',
  'consignor_tel', 'consignor_email', 'consignor_street', 'consignor_city',
];
const CAMPOS_CONSIGNATARIO = [
  'consignee_name', 'consignee_document_type', 'consignee_document_no',
  'consignee_tel', 'consignee_email', 'consignee_street', 'consignee_city',
];

function deduplicarPorCampos(bls, campos) {
  const [campoNombre, ...resto] = campos;
  const vistos = new Map();
  for (const bl of bls) {
    const nombre = String(bl[campoNombre] || '').trim();
    if (!nombre || vistos.has(nombre)) continue;
    const fila = { [campoNombre]: nombre };
    resto.forEach(c => { fila[c] = bl[c] || ''; });
    vistos.set(nombre, fila);
  }
  return Array.from(vistos.values()).sort((a, b) => a[campoNombre].localeCompare(b[campoNombre]));
}

/** @param {import('../../types').BLRow[]} bls */
function deduplicarConsignadores(bls) {
  return deduplicarPorCampos(bls, CAMPOS_CONSIGNADOR);
}

/** @param {import('../../types').BLRow[]} bls */
function deduplicarConsignatarios(bls) {
  return deduplicarPorCampos(bls, CAMPOS_CONSIGNATARIO);
}

function actualizarPorNombre(db, campoNombre, nombre, cambios) {
  const campos = Object.keys(cambios);
  if (campos.length === 0) return;
  const setClause = campos.map(c => `${c} = ?`).join(', ');
  const valores = campos.map(c => cambios[c].despues);
  db.prepare(`UPDATE bills_of_lading SET ${setClause} WHERE ${campoNombre} = ?`).run(...valores, nombre);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} nombre
 * @param {Record<string, {antes: any, despues: any}>} cambios Formato que produce diff.js
 */
function actualizarConsignadorPorNombre(db, nombre, cambios) {
  actualizarPorNombre(db, 'consignor_name', nombre, cambios);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} nombre
 * @param {Record<string, {antes: any, despues: any}>} cambios Formato que produce diff.js
 */
function actualizarConsignatarioPorNombre(db, nombre, cambios) {
  actualizarPorNombre(db, 'consignee_name', nombre, cambios);
}

module.exports = {
  CAMPOS_CONSIGNADOR, CAMPOS_CONSIGNATARIO,
  deduplicarConsignadores, deduplicarConsignatarios,
  actualizarConsignadorPorNombre, actualizarConsignatarioPorNombre,
};
