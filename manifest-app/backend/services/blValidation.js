// services/blValidation.js — Validaciones previas a entregar un manifiesto
//
// Extraído de server.js (paso 5 / fix 2 de la separación backend/frontend).
//
// POR QUÉ EXISTE ESTE MÓDULO:
// Había dos caminos de salida con reglas distintas. `export-txt` exigía B/L
// validados, código arancelario, tarifa, SS/EIN y docking number numérico.
// `push-siscommate` — que escribe en la base real — solo exigía el docking
// number y enviaba todos los B/L, validados o no. Un B/L incompleto no podía
// llegar a Hacienda por TXT, pero sí a SISCOMMATE.
//
// Ahora ambos caminos llaman a la misma función, para que no puedan volver
// a divergir.

// Reglas de negocio, en un solo lugar:
//  - Solo se entregan B/L marcados como 'validado'
//  - El docking number es obligatorio y numérico
//  - Cada B/L necesita código arancelario y SS/EIN del consignatario
//  - La descripción >121 caracteres NO bloquea nada: txtGenerator ya la
//    trunca sola vía pad() (mismo truco que usa para todos los campos de
//    ancho fijo del TXT). Antes bloqueaba el push a SISCOMMATE igual que un
//    error real, aunque el mensaje decía "se truncará" — quedaba B/L
//    validados sin poder enviarse por un campo que de todos modos se iba a
//    recortar solo. Ahora es aviso (warnings), no error.
const DESC_MAX = 121;

/** @typedef {import('../types').ManifestRow} ManifestRow */
/** @typedef {import('../types').BLRow} BLRow */

/**
 * Resultado de validar un manifiesto antes de entregarlo.
 * @typedef {object} ResultadoValidacion
 * @property {BLRow[]} validBls Los B/L que se pueden entregar (status 'validado')
 * @property {string[]} errors  Vacío si todo está en orden — bloquean la entrega
 * @property {string[]} warnings Informativos, no bloquean — ej. descripción larga
 */

/**
 * Decide si un manifiesto se puede entregar, y con qué B/L.
 *
 * La usan tanto la exportación del TXT de Hacienda como el push a SISCOMMATE,
 * para que no puedan volver a divergir.
 * @param {ManifestRow} manifest
 * @param {BLRow[]} allBls Todos los B/L del manifiesto, validados o no
 * @returns {ResultadoValidacion}
 */
function validateForSubmission(manifest, allBls) {
  const errors = [];
  const warnings = [];

  const validBls = allBls.filter(bl => bl.status === 'validado');
  if (!validBls.length) {
    return {
      validBls: [],
      errors: ['No hay B/L validados en este manifiesto. Marca al menos uno como Validado antes de continuar.'],
      warnings: [],
    };
  }

  if (!manifest.docking_number || !/^\d+$/.test(String(manifest.docking_number).trim())) {
    errors.push('El Docking Number es obligatorio y debe ser numérico.');
  }

  const sinCodigo = validBls.filter(bl =>
    !bl.hacienda_item_code ||
    bl.hacienda_item_code.trim() === '' ||
    /^0+$/.test(bl.hacienda_item_code.trim())
  );
  // Viajes AU/CF van a islas (STX/STT — US Virgin Islands, etc.), no a
  // Puerto Rico directo — sus consignatarios reales (residentes/negocios de
  // la isla) casi nunca tienen seguro social ni EIN de EE.UU., a diferencia
  // de un consignatario en PR. Antes esto bloqueaba la validación del B/L
  // por completo; el operador terminaba escribiendo un SS inventado a mano
  // (ej. "999002030") solo para poder pasar el chequeo. El campo ya queda
  // en blanco sin problema en el TXT (sanitizeSS en txtGenerator.js), así
  // que no hay razón real para exigirlo aquí en estos viajes.
  const esViajeSinSS = /^(AU|CF)/i.test(String(manifest.voyage_no || '').trim());
  const sinSS     = esViajeSinSS ? [] : validBls.filter(bl => !bl.hacienda_client_ss && !bl.consignee_document_no);
  const descLarga = validBls.filter(bl =>
    (bl.goods_name || '').replace(/[\r\n]+/g, ' ').length > DESC_MAX
  );

  const lista = arr => arr.map(b => b.bl_no).join(', ');
  if (sinCodigo.length) errors.push(`${sinCodigo.length} B/L sin código arancelario: ${lista(sinCodigo)}`);
  // Ya no se exige tarifa: si queda vacía, txtGenerator escribe el campo en
  // blanco (tránsito/libre arancel) en vez de bloquear la exportación.
  if (sinSS.length)     errors.push(`${sinSS.length} B/L sin SS/EIN consignatario: ${lista(sinSS)}`);
  if (descLarga.length) warnings.push(`${descLarga.length} B/L con descripción >${DESC_MAX} chars (se truncará automáticamente): ${lista(descLarga)}`);

  return { validBls, errors, warnings };
}

module.exports = { validateForSubmission, DESC_MAX };
