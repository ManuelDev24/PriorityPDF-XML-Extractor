// services/blMove.js — Mover un B/L a otro viaje
//
// POR QUÉ EXISTE ESTE MÓDULO:
// Mover un B/L se hacía en tres rutas distintas (mover uno, mover en lote,
// y mover al cargar un PDF), cada una con su propia copia del mismo bloque de
// UPDATEs. Ninguna tocaba lo que SISCOMMATE ya sabía del B/L, así que un B/L
// enviado y luego movido llegaba al viaje nuevo marcado como "ya enviado" y
// el push lo salteaba. Ahora las tres llaman a esta función, para que no
// puedan volver a divergir.

/** @typedef {import('../types').BLRow} BLRow */

/**
 * Mueve un B/L y todo lo que le pertenece en exclusiva: sus vínculos de
 * contenedor (container_bl), los contenedores mismos (containers) — solo si
 * no los comparte con otro B/L que se queda atrás — y sus items de carga
 * (bl_cargo_items). Todo en una transacción para que no quede a medias.
 *
 * Si el B/L ya se había enviado a SISCOMMATE, deja registrado en qué viaje
 * quedó su copia (siscommate_voyage_no). Así el push del viaje destino sabe
 * que todavía NO está allí, lo envía, y retira la copia del viaje viejo.
 * La fecha de envío no se borra: es historial de cuándo se mandó.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {BLRow} bl B/L tal como está ANTES de moverlo
 * @param {number} destinoId Manifiesto destino (debe existir)
 * @param {number|null} seq sort_seq que tendrá en el destino
 */
function moverBl(db, bl, destinoId, seq) {
  const origenId = bl.manifest_id;
  const viajeDeOrigen = db.prepare('SELECT voyage_no FROM manifests WHERE id=?').get(origenId)?.voyage_no || null;

  // Si se envió pero nunca se anotó dónde (datos anteriores a la columna), la
  // copia está en el viaje donde vive ahora, o sea el de origen.
  const copiaEn = bl.siscommate_sent_at
    ? ((bl.siscommate_voyage_no && String(bl.siscommate_voyage_no).trim()) || viajeDeOrigen)
    : (bl.siscommate_voyage_no || null);

  db.transaction(() => {
    db.prepare('UPDATE bills_of_lading SET manifest_id=?, sort_seq=?, siscommate_voyage_no=? WHERE id=?')
      .run(destinoId, seq, copiaEn, bl.id);
    db.prepare('UPDATE container_bl SET manifest_id=? WHERE bl_no=? AND manifest_id=?')
      .run(destinoId, bl.bl_no, origenId);
    db.prepare(`
      UPDATE containers SET manifest_id=?
      WHERE manifest_id=?
        AND container_no IN (SELECT container_no FROM container_bl WHERE bl_no=? AND manifest_id=?)
        AND container_no NOT IN (SELECT container_no FROM container_bl WHERE manifest_id=?)
    `).run(destinoId, origenId, bl.bl_no, destinoId, origenId);
    db.prepare('UPDATE bl_cargo_items SET manifest_id=? WHERE bl_id=?').run(destinoId, bl.id);
  })();
}

module.exports = { moverBl };
