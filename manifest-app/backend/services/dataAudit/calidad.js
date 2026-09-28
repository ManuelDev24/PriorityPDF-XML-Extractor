// backend/services/dataAudit/calidad.js — Senales de calidad de datos para
// el Excel de auditoria: que le falta a un cliente/consignador/consignatario,
// y que tan parecido es su nombre a otro ya existente en la MISMA hoja
// (posible duplicado por error de digitacion). Reutiliza la similitud de
// texto ya afinada en clientSync.js (Levenshtein + umbral 0.82) en vez de
// inventar otra — es la misma que ya usa el editor para avisar de un nombre
// parecido al guardar un cliente.

const { similitudTexto, normalizarParaComparar, UMBRAL_PARECIDO } = require('../clientSync');

/**
 * @param {Record<string, any>} fila
 * @param {Record<string, string>} mapeo Etiqueta legible -> nombre de columna en `fila`
 * @returns {string} Etiquetas separadas por coma de lo que esta vacio, o '' si no falta nada
 */
function camposFaltantes(fila, mapeo) {
  const faltan = [];
  for (const etiqueta of Object.keys(mapeo)) {
    if (!String(fila[mapeo[etiqueta]] || '').trim()) faltan.push(etiqueta);
  }
  return faltan.join(', ');
}

/**
 * Para cada nombre en `nombres`, busca si hay OTRO nombre en la misma lista
 * que se le parezca (Levenshtein normalizado >= UMBRAL_PARECIDO, la misma
 * distancia relativa que ya usa buscarClienteParecido). Agrupa primero por
 * las primeras 3 letras normalizadas para no comparar cada nombre contra
 * TODOS los demas — con ~8,000 clientes, la comparacion completa (n^2)
 * tardaria demasiado para un export sincrono; casi cualquier variante real
 * de un mismo nombre ("ACME SA" / "Acme S.A.") comparte esas primeras letras.
 * @param {string[]} nombres
 * @returns {string[]} mismo largo que `nombres`; '' si no se encontro nada parecido
 */
function detectarPosiblesDuplicados(nombres) {
  const resultado = new Array(nombres.length).fill('');
  const buckets = new Map();
  nombres.forEach((nombre, i) => {
    const norm = normalizarParaComparar(nombre);
    if (!norm) return;
    const clave = norm.slice(0, 3);
    if (!buckets.has(clave)) buckets.set(clave, []);
    buckets.get(clave).push(i);
  });

  for (const indices of buckets.values()) {
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const i = indices[a], j = indices[b];
        const sim = similitudTexto(nombres[i], nombres[j]);
        if (sim < UMBRAL_PARECIDO) continue;
        const pct = Math.round(sim * 100);
        if (!resultado[i]) resultado[i] = `parecido a "${nombres[j]}" (${pct}%)`;
        if (!resultado[j]) resultado[j] = `parecido a "${nombres[i]}" (${pct}%)`;
      }
    }
  }
  return resultado;
}

module.exports = { camposFaltantes, detectarPosiblesDuplicados };
