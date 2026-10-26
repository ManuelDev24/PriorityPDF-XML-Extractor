// backend/services/dataAudit/reinyectar.js — Lee el Excel corregido, calcula
// que cambio contra el estado actual (sin escribir nada), arma el texto de
// vista previa, y aplica los cambios ya aprobados. Usa la misma
// configuracion de hojas.js que exportar.js, para que ambos lados nunca se
// desalineen sobre que campo vive en que hoja.

const ExcelJS = require('exceljs');
const { construirHojas } = require('./hojas');
const { calcularDiferencias } = require('./diff');

/**
 * @typedef {object} CambioFila
 * @property {string} hoja
 * @property {Record<string, any>} claves
 * @property {Record<string, {antes: any, despues: any}>} [cambios]
 * @property {Record<string, any>} [filaFinal]
 * @property {Record<string, any>} [filaActual] Fila tal cual estaba antes del cambio — algunas
 *   escrituras (p.ej. actualizar un cliente en SISCOMMATE por su nombre ANTERIOR) la necesitan
 * @property {string} [error]
 * @property {object} [spec] HojaSpec de hojas.js — ausente cuando hay error
 */

/**
 * @param {string|Buffer} origenExcel Ruta de archivo (CLI) o buffer en memoria (subida por HTTP)
 * @param {{db: import('better-sqlite3').Database, siscommate: object}} deps
 * @returns {Promise<CambioFila[]>}
 */
async function calcularPlanDeCambios(origenExcel, deps) {
  const workbook = new ExcelJS.Workbook();
  if (Buffer.isBuffer(origenExcel)) await workbook.xlsx.load(origenExcel);
  else await workbook.xlsx.readFile(origenExcel);

  const filasPorProcesar = [];
  for (const spec of construirHojas()) {
    if (!spec.leerActual || !spec.escribirCambio) continue; // hoja de solo lectura
    const worksheet = workbook.getWorksheet(spec.nombre);
    if (!worksheet) continue;

    // .values es CellValue[] en la practica (la firma de ExcelJS lo declara
    // como union con una sobrecarga de funcion que nunca aplica aqui).
    const encabezados = (/** @type {any[]} */ (worksheet.getRow(1).values)).slice(1).map(String);
    worksheet.eachRow((row, numeroFila) => {
      if (numeroFila === 1) return;
      const filaExcel = {};
      (/** @type {any[]} */ (row.values)).slice(1).forEach((valor, i) => { filaExcel[encabezados[i]] = valor; });
      const claves = {};
      spec.camposClave.forEach(c => { claves[c] = String(filaExcel[c] ?? '').trim(); });
      filasPorProcesar.push({ spec, claves, filaExcel });
    });
  }

  const resueltos = await Promise.all(filasPorProcesar.map(async ({ spec, claves, filaExcel }) => {
    const filaActual = await spec.leerActual(deps, claves);
    if (!filaActual) {
      return { hoja: spec.nombre, claves, error: 'No se encontró el registro original (¿fue borrado o renombrado?)' };
    }
    const cambios = calcularDiferencias(filaExcel, filaActual, spec.camposEditables);
    if (Object.keys(cambios).length === 0) return null; // sin cambios, no entra al plan
    const filaFinal = { ...filaActual };
    Object.keys(cambios).forEach(c => { filaFinal[c] = cambios[c].despues; });
    return { hoja: spec.nombre, claves, cambios, filaFinal, filaActual, spec };
  }));

  return resueltos.filter(Boolean);
}

/**
 * @param {CambioFila[]} plan
 * @returns {string}
 */
function formatearVistaPrevia(plan) {
  if (plan.length === 0) return 'No hay cambios que aplicar.';
  const lineas = [];
  for (const item of plan) {
    if (item.error) {
      lineas.push(`[${item.hoja}] ${JSON.stringify(item.claves)} — ERROR: ${item.error}`);
      continue;
    }
    lineas.push(`[${item.hoja}] ${JSON.stringify(item.claves)}`);
    for (const [campo, { antes, despues }] of Object.entries(item.cambios)) {
      lineas.push(`  ${campo}: "${antes}" → "${despues}"`);
    }
  }
  const aplicables = plan.filter(i => !i.error).length;
  const conError = plan.length - aplicables;
  lineas.push('');
  lineas.push(`${aplicables} cambio${aplicables === 1 ? '' : 's'} por aplicar${conError ? `, ${conError} con error (no se aplicarán)` : ''}.`);
  return lineas.join('\n');
}

/**
 * Aplica un plan ya calculado (ignora automáticamente los que tienen error).
 * @param {CambioFila[]} plan
 * @param {{db: object, siscommate: object}} deps
 * @param {(entrada: object) => void} registrarCambio Ver ./log.js
 * @returns {Promise<{aplicados: number, fallidos: number}>}
 */
async function aplicarCambios(plan, deps, registrarCambio) {
  let aplicados = 0, fallidos = 0;
  for (const item of plan) {
    if (item.error) {
      registrarCambio({ hoja: item.hoja, claves: item.claves, cambios: {}, error: item.error });
      fallidos++;
      continue;
    }
    try {
      await item.spec.escribirCambio(deps, item.claves, item.cambios, item.filaFinal, item.filaActual);
      registrarCambio({ hoja: item.hoja, claves: item.claves, cambios: item.cambios });
      aplicados++;
    } catch (e) {
      registrarCambio({ hoja: item.hoja, claves: item.claves, cambios: item.cambios, error: e.message });
      fallidos++;
    }
  }
  return { aplicados, fallidos };
}

module.exports = { calcularPlanDeCambios, formatearVistaPrevia, aplicarCambios };
