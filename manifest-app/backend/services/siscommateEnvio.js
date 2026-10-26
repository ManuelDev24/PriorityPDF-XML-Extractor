// services/siscommateEnvio.js — Qué B/L ya están en SISCOMMATE y dónde
//
// POR QUÉ EXISTE ESTE MÓDULO:
// "Este B/L ya se envió" se guardaba solo como una fecha (siscommate_sent_at)
// pegada al B/L. Pero SISCOMMATE guarda los B/L DENTRO de un viaje: si el B/L
// se mueve a otro viaje, la fecha viaja con él y el push del viaje nuevo lo
// descartaba como "ya enviado" — cuando en realidad su copia estaba en el
// viaje viejo y el nuevo quedaba sin él.
//
// Ahora el B/L también recuerda EN QUÉ VIAJE está su copia
// (siscommate_voyage_no). "Ya enviado" significa enviado a ESTE viaje, y esa
// regla vive aquí, en un solo lugar, para que ninguna ruta pueda volver a
// decidirlo por su cuenta.

/** @typedef {import('../types').BLRow} BLRow */

const norm = v => String(v == null ? '' : v).trim().toUpperCase();

// Ventana para casar la fecha de un B/L con una fila del historial de envíos.
// El push marca los B/L y escribe el historial en la misma petición, así que
// las dos fechas difieren por milisegundos; 5 s da margen sin mezclar envíos.
const VENTANA_HISTORIAL_SEG = 5;

/**
 * ¿Este B/L ya está en SISCOMMATE dentro de ESTE viaje?
 * Un B/L con fecha pero sin viaje registrado (datos anteriores a esta
 * columna) se respeta como enviado: tratarlo como pendiente duplicaría un B/L
 * que sí está escrito.
 * @param {Pick<BLRow,'siscommate_sent_at'> & {siscommate_voyage_no?: string|null}} bl
 * @param {string} voyageNo Viaje al que se está enviando
 * @returns {boolean}
 */
function yaEnviadoAViaje(bl, voyageNo) {
  if (!bl.siscommate_sent_at) return false;
  const copiaEn = norm(bl.siscommate_voyage_no);
  if (!copiaEn) return true;
  return copiaEn === norm(voyageNo);
}

/**
 * Reparte los B/L validados de un viaje entre los que hay que enviar y los
 * que ya están en SISCOMMATE.
 * @template {BLRow} T
 * @param {T[]} validBls
 * @param {string} voyageNo
 * @returns {{porEnviar: T[], yaEnviados: number}}
 */
function separarPorEnviar(validBls, voyageNo) {
  const porEnviar = validBls.filter(bl => !yaEnviadoAViaje(bl, voyageNo));
  return { porEnviar, yaEnviados: validBls.length - porEnviar.length };
}

/**
 * De los B/L que se van a enviar, los que dejaron una copia en OTRO viaje de
 * SISCOMMATE (porque se movieron después de enviarse). Esa copia hay que
 * retirarla al enviar el viaje nuevo, o el B/L quedaría duplicado.
 * @template {BLRow} T
 * @param {T[]} porEnviar
 * @param {string} voyageNo
 * @returns {{bl: T, voyage_no: string}[]}
 */
function viajesAnterioresARetirar(porEnviar, voyageNo) {
  return porEnviar
    .filter(bl => bl.siscommate_sent_at && norm(bl.siscommate_voyage_no) && norm(bl.siscommate_voyage_no) !== norm(voyageNo))
    .map(bl => ({ bl, voyage_no: String(bl.siscommate_voyage_no).trim() }));
}

/**
 * Migración de datos: B/L enviados antes de existir siscommate_voyage_no.
 * Deduce de qué viaje salieron con el historial de envíos (la fecha del B/L
 * coincide con el instante del push). Solo se confía en el historial cuando
 * es inequívoco: si en esa ventana hubo varios viajes, o si uno de ellos es
 * el viaje donde el B/L vive hoy, se queda con el viaje actual — equivocarse
 * hacia el otro lado retiraría de SISCOMMATE un B/L legítimo.
 * Idempotente: solo toca filas que aún no tienen viaje registrado.
 * @param {import('better-sqlite3').Database} db
 * @returns {number} B/L actualizados
 */
function rellenarViajeDeEnvio(db) {
  const pendientes = db.prepare(`
    SELECT b.id, b.siscommate_sent_at AS enviado, m.voyage_no AS actual,
           CAST(strftime('%s', b.siscommate_sent_at) AS INTEGER) AS t
    FROM bills_of_lading b
    LEFT JOIN manifests m ON m.id = b.manifest_id
    WHERE b.siscommate_sent_at IS NOT NULL
      AND COALESCE(b.siscommate_voyage_no, '') = ''
  `).all();
  if (!pendientes.length) return 0;

  const historial = db.prepare(`
    SELECT voyage_no, CAST(strftime('%s', pushed_at) AS INTEGER) AS t FROM siscommate_push_log
  `).all();

  const asignar = db.prepare('UPDATE bills_of_lading SET siscommate_voyage_no=? WHERE id=?');
  db.transaction(() => {
    pendientes.forEach(p => {
      const cercanos = new Set(
        historial.filter(h => Math.abs(h.t - p.t) <= VENTANA_HISTORIAL_SEG).map(h => norm(h.voyage_no))
      );
      const viaje = (cercanos.size === 1 && !cercanos.has(norm(p.actual)))
        ? historial.find(h => norm(h.voyage_no) === [...cercanos][0]).voyage_no
        : p.actual;
      if (viaje) asignar.run(viaje, p.id);
    });
  })();
  return pendientes.length;
}

module.exports = { yaEnviadoAViaje, separarPorEnviar, viajesAnterioresARetirar, rellenarViajeDeEnvio };
