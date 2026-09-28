// backend/services/dataAudit/log.js — Registro de auditoria de cada cambio
// que reinyectar.js aplica (o intenta aplicar), para poder revertir a mano
// si algo sale mal en produccion. Un archivo por dia en logs/ (ya
// gitignorado — ver ../.gitignore).

const fs = require('fs');
const path = require('path');

const LOG_DIR_DEFAULT = path.join(__dirname, '..', '..', '..', 'logs');

/**
 * @param {Date} [fecha]
 * @param {string} [logDir]
 * @returns {string}
 */
function rutaDelDia(fecha = new Date(), logDir = LOG_DIR_DEFAULT) {
  const p = n => String(n).padStart(2, '0');
  return path.join(logDir, `dataAudit_${fecha.getFullYear()}${p(fecha.getMonth() + 1)}${p(fecha.getDate())}.log`);
}

/**
 * Agrega una linea al log del dia con el cambio aplicado (o el error, si fallo).
 * @param {{hoja: string, claves: Record<string, any>, cambios: Record<string, {antes: any, despues: any}>, error?: string}} entrada
 * @param {string} [logDir]
 */
function registrarCambio(entrada, logDir = LOG_DIR_DEFAULT) {
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const linea = JSON.stringify({ timestamp: new Date().toISOString(), ...entrada });
  fs.appendFileSync(rutaDelDia(new Date(), logDir), linea + '\n');
}

module.exports = { registrarCambio, rutaDelDia };
