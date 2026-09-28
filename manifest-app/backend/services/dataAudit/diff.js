// backend/services/dataAudit/diff.js — Compara una fila del Excel corregido
// contra el estado actual de un registro y devuelve solo los campos que
// cambiaron. No escribe nada: es la base tanto del reporte de vista previa
// como de la lista de UPDATEs que reinyectar.js va a ejecutar.

/**
 * @param {Record<string, any>} filaExcel Fila leida del Excel (sin la columna tecnica de clave)
 * @param {Record<string, any>} filaActual Fila actual en la base/DBF, mismas claves
 * @param {string[]} camposEditables Que campos comparar — columnas tecnicas y de solo lectura no entran aqui
 * @returns {Record<string, {antes: any, despues: any}>} Solo los campos distintos
 */
function calcularDiferencias(filaExcel, filaActual, camposEditables) {
  const cambios = {};
  for (const campo of camposEditables) {
    const antes = normalizar(filaActual[campo]);
    const despues = normalizar(filaExcel[campo]);
    if (antes !== despues) {
      cambios[campo] = { antes: filaActual[campo] ?? '', despues: filaExcel[campo] ?? '' };
    }
  }
  return cambios;
}

// Un Excel siempre devuelve string o number, nunca hay que distinguir ""
// de null/undefined aqui: los tres significan "vacio". Comparar como texto
// recortado tambien hace que 1500 (numero) y "1500" (texto) cuenten como
// el mismo valor.
function normalizar(valor) {
  return String(valor ?? '').trim();
}

module.exports = { calcularDiferencias };
