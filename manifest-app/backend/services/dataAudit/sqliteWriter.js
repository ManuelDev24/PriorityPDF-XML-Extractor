// backend/services/dataAudit/sqliteWriter.js — UPDATE generico por clave,
// reutilizado por todas las hojas de auditoria respaldadas por una tabla
// SQLite corriente (clients, manifests, bills_of_lading, containers). Las
// hojas deduplicadas (consignadores/consignatarios) NO usan esto — ver
// dedupe.js, porque ahi una fila corrige varios registros a la vez.

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} tabla
 * @param {Record<string, any>} claves p.ej. {id: 42}
 * @param {Record<string, {antes: any, despues: any}>} cambios Formato que produce diff.js
 */
function actualizarFilaSqlite(db, tabla, claves, cambios) {
  const camposCambiados = Object.keys(cambios);
  if (camposCambiados.length === 0) return;
  const setClause = camposCambiados.map(c => `${c} = ?`).join(', ');
  const whereClause = Object.keys(claves).map(c => `${c} = ?`).join(' AND ');
  const valores = [...camposCambiados.map(c => cambios[c].despues), ...Object.values(claves)];
  db.prepare(`UPDATE ${tabla} SET ${setClause} WHERE ${whereClause}`).run(...valores);
}

module.exports = { actualizarFilaSqlite };
