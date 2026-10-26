// Tests de siscommateEnvio.js — qué B/L faltan por enviar a SISCOMMATE.
// Ejecutar: npm test   (desde manifest-app/)

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const {
  yaEnviadoAViaje, separarPorEnviar, viajesAnterioresARetirar, rellenarViajeDeEnvio,
} = require('./siscommateEnvio');

test('un B/L sin marca de envío nunca está enviado', () => {
  assert.strictEqual(yaEnviadoAViaje({ siscommate_sent_at: null }, 'K1352'), false);
});

test('enviado a ESTE viaje: marca y viaje coinciden', () => {
  const bl = { siscommate_sent_at: '2026-10-13 13:12:54', siscommate_voyage_no: 'K1350A' };
  assert.strictEqual(yaEnviadoAViaje(bl, 'K1350A'), true);
});

test('regresión: B/L enviado con otro viaje y luego movido NO cuenta como enviado', () => {
  // Es el caso K1351A: el B/L se envió dentro de K1350A, se movió a K1351A y
  // traía la marca de fecha. Antes se descartaba del push por eso.
  const bl = { siscommate_sent_at: '2026-10-13 13:12:54', siscommate_voyage_no: 'K1350A' };
  assert.strictEqual(yaEnviadoAViaje(bl, 'K1351A'), false);
});

test('datos viejos: marca de fecha sin viaje registrado se sigue respetando', () => {
  // Antes de existir siscommate_voyage_no. Tratarlos como "no enviados"
  // duplicaría B/L ya escritos en SISCOMMATE.
  assert.strictEqual(yaEnviadoAViaje({ siscommate_sent_at: '2026-09-01 10:00:00', siscommate_voyage_no: null }, 'K1304'), true);
  assert.strictEqual(yaEnviadoAViaje({ siscommate_sent_at: '2026-09-01 10:00:00' }, 'K1304'), true);
});

test('la comparación de viaje ignora mayúsculas y espacios', () => {
  const bl = { siscommate_sent_at: '2026-10-13 13:12:54', siscommate_voyage_no: ' k1350a ' };
  assert.strictEqual(yaEnviadoAViaje(bl, 'K1350A'), true);
});

test('separarPorEnviar reparte los B/L y cuenta los ya enviados', () => {
  const bls = [
    { id: 1, siscommate_sent_at: '2026-10-13 13:12:54', siscommate_voyage_no: 'K1351A' },
    { id: 2, siscommate_sent_at: '2026-10-13 13:12:54', siscommate_voyage_no: 'K1350A' },
    { id: 3, siscommate_sent_at: null, siscommate_voyage_no: null },
  ];
  const r = separarPorEnviar(bls, 'K1351A');
  assert.deepStrictEqual(r.porEnviar.map(b => b.id), [2, 3]);
  assert.strictEqual(r.yaEnviados, 1);
});

test('viajesAnterioresARetirar: solo B/L con copia en OTRO viaje', () => {
  const bls = [
    { id: 1, bl_no: 'A', siscommate_sent_at: 'x', siscommate_voyage_no: 'K1350A' },
    { id: 2, bl_no: 'B', siscommate_sent_at: 'x', siscommate_voyage_no: 'K1351A' },
    { id: 3, bl_no: 'C', siscommate_sent_at: null, siscommate_voyage_no: null },
  ];
  assert.deepStrictEqual(viajesAnterioresARetirar(bls, 'K1351A'), [{ bl: bls[0], voyage_no: 'K1350A' }]);
});

// ── Relleno de datos viejos ─────────────────────────────────────────────────
function baseDeDatos() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE manifests (id INTEGER PRIMARY KEY, voyage_no TEXT);
    CREATE TABLE bills_of_lading (id INTEGER PRIMARY KEY, manifest_id INTEGER, bl_no TEXT,
      siscommate_sent_at TEXT, siscommate_voyage_no TEXT);
    CREATE TABLE siscommate_push_log (id INTEGER PRIMARY KEY AUTOINCREMENT, manifest_id INTEGER,
      voyage_no TEXT, lote TEXT, bl_count INTEGER, pushed_at TEXT);
    INSERT INTO manifests VALUES (1,'K1350A'),(2,'K1351A'),(3,'K1304');
    INSERT INTO siscommate_push_log (manifest_id,voyage_no,lote,bl_count,pushed_at)
      VALUES (1,'K1350A','3309911',14,'2026-10-13 13:12:54');
  `);
  return db;
}

test('rellenar: B/L movido tras su envío recupera el viaje REAL donde se envió', () => {
  const db = baseDeDatos();
  // Vive hoy en K1351A (manifest 2) pero se envió en el push de K1350A.
  db.prepare(`INSERT INTO bills_of_lading VALUES (10,2,'PYRR1','2026-10-13 13:12:55',NULL)`).run();
  rellenarViajeDeEnvio(db);
  assert.strictEqual(db.prepare('SELECT siscommate_voyage_no v FROM bills_of_lading WHERE id=10').get().v, 'K1350A');
});

test('rellenar: sin registro en el historial se asume el viaje actual', () => {
  const db = baseDeDatos();
  db.prepare(`INSERT INTO bills_of_lading VALUES (11,3,'PYRR2','2026-09-01 10:00:00',NULL)`).run();
  rellenarViajeDeEnvio(db);
  assert.strictEqual(db.prepare('SELECT siscommate_voyage_no v FROM bills_of_lading WHERE id=11').get().v, 'K1304');
});

test('rellenar: es idempotente y no pisa lo ya registrado', () => {
  const db = baseDeDatos();
  db.prepare(`INSERT INTO bills_of_lading VALUES (12,2,'PYRR3','2026-10-13 13:12:55','K9999')`).run();
  db.prepare(`INSERT INTO bills_of_lading VALUES (13,2,'PYRR4',NULL,NULL)`).run();
  rellenarViajeDeEnvio(db);
  rellenarViajeDeEnvio(db);
  assert.strictEqual(db.prepare('SELECT siscommate_voyage_no v FROM bills_of_lading WHERE id=12').get().v, 'K9999');
  assert.strictEqual(db.prepare('SELECT siscommate_voyage_no v FROM bills_of_lading WHERE id=13').get().v, null);
});

test('rellenar: si en la ventana hubo envíos de varios viajes NO adivina, usa el viaje actual', () => {
  const db = baseDeDatos();
  // Dos viajes se enviaron con 1 s de diferencia (pasa en la práctica). Un B/L
  // legítimo de K1304 no debe quedar atribuido al otro y retirarse por error.
  db.prepare(`INSERT INTO siscommate_push_log (manifest_id,voyage_no,lote,bl_count,pushed_at)
    VALUES (3,'K1304','1',1,'2026-09-10 20:21:33'),(1,'K1326','2',1,'2026-09-10 20:21:34')`).run();
  db.prepare(`INSERT INTO bills_of_lading VALUES (20,3,'PYRR9','2026-09-10 20:21:33',NULL)`).run();
  rellenarViajeDeEnvio(db);
  assert.strictEqual(db.prepare('SELECT siscommate_voyage_no v FROM bills_of_lading WHERE id=20').get().v, 'K1304');
});

test('rellenar: un B/L que vive en su propio viaje enviado no se reasigna aunque otro viaje esté cerca en el tiempo', () => {
  const db = baseDeDatos();
  db.prepare(`INSERT INTO siscommate_push_log (manifest_id,voyage_no,lote,bl_count,pushed_at)
    VALUES (3,'K1304','1',1,'2026-10-13 13:12:55')`).run();
  // K1350A (log base, 13:12:54) y K1304 (13:12:55) dentro de 5 s; el B/L vive en K1304.
  db.prepare(`INSERT INTO bills_of_lading VALUES (21,3,'PYRR10','2026-10-13 13:12:55',NULL)`).run();
  rellenarViajeDeEnvio(db);
  assert.strictEqual(db.prepare('SELECT siscommate_voyage_no v FROM bills_of_lading WHERE id=21').get().v, 'K1304');
});
