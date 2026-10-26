// Tests de blMove.js — mover B/L entre viajes sin perder el rastro de SISCOMMATE.
// Ejecutar: npm test   (desde manifest-app/)

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { moverBl } = require('./blMove');
const { yaEnviadoAViaje } = require('./siscommateEnvio');

function baseDeDatos() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE manifests (id INTEGER PRIMARY KEY, voyage_no TEXT);
    CREATE TABLE bills_of_lading (id INTEGER PRIMARY KEY, manifest_id INTEGER, bl_no TEXT, sort_seq INTEGER,
      status TEXT, siscommate_sent_at TEXT, siscommate_voyage_no TEXT);
    CREATE TABLE container_bl (container_no TEXT, bl_no TEXT, manifest_id INTEGER);
    CREATE TABLE containers (id INTEGER PRIMARY KEY, manifest_id INTEGER, container_no TEXT);
    CREATE TABLE bl_cargo_items (id INTEGER PRIMARY KEY, bl_id INTEGER, manifest_id INTEGER);
    INSERT INTO manifests VALUES (1,'K1350A'),(2,'K1351A');
  `);
  return db;
}

const traer = (db, id) => db.prepare('SELECT * FROM bills_of_lading WHERE id=?').get(id);

test('regresión K1351A: un B/L enviado y luego movido queda pendiente de enviar en el destino', () => {
  const db = baseDeDatos();
  db.prepare(`INSERT INTO bills_of_lading VALUES (1,1,'PYRR1',0,'validado','2026-10-13 13:12:54','K1350A')`).run();
  moverBl(db, traer(db, 1), 2, 0);
  const bl = traer(db, 1);
  assert.strictEqual(bl.manifest_id, 2);
  assert.strictEqual(yaEnviadoAViaje(bl, 'K1351A'), false, 'el push de K1351A debe incluirlo');
  assert.strictEqual(bl.siscommate_voyage_no, 'K1350A', 'recuerda dónde quedó su copia, para retirarla');
});

test('B/L con marca vieja sin viaje: el mover registra de dónde se envió', () => {
  const db = baseDeDatos();
  db.prepare(`INSERT INTO bills_of_lading VALUES (2,1,'PYRR2',0,'validado','2026-10-13 13:12:54',NULL)`).run();
  moverBl(db, traer(db, 2), 2, 0);
  assert.strictEqual(traer(db, 2).siscommate_voyage_no, 'K1350A');
  assert.strictEqual(yaEnviadoAViaje(traer(db, 2), 'K1351A'), false);
});

test('devolver el B/L al viaje donde vive su copia lo vuelve a contar como enviado', () => {
  const db = baseDeDatos();
  db.prepare(`INSERT INTO bills_of_lading VALUES (3,1,'PYRR3',0,'validado','2026-10-13 13:12:54','K1350A')`).run();
  moverBl(db, traer(db, 3), 2, 0);
  moverBl(db, traer(db, 3), 1, 0);
  assert.strictEqual(yaEnviadoAViaje(traer(db, 3), 'K1350A'), true);
});

test('un B/L nunca enviado se mueve sin inventar marcas', () => {
  const db = baseDeDatos();
  db.prepare(`INSERT INTO bills_of_lading VALUES (4,1,'PYRR4',0,'validado',NULL,NULL)`).run();
  moverBl(db, traer(db, 4), 2, 0);
  const bl = traer(db, 4);
  assert.strictEqual(bl.siscommate_sent_at, null);
  assert.strictEqual(bl.siscommate_voyage_no, null);
});

test('mueve también contenedores exclusivos, vínculos e items de carga', () => {
  const db = baseDeDatos();
  db.prepare(`INSERT INTO bills_of_lading VALUES (5,1,'PYRR5',0,'validado',NULL,NULL)`).run();
  db.prepare(`INSERT INTO bills_of_lading VALUES (6,1,'PYRR6',1,'validado',NULL,NULL)`).run();
  db.exec(`
    INSERT INTO container_bl VALUES ('C-SOLO','PYRR5',1),('C-COMPARTIDO','PYRR5',1),('C-COMPARTIDO','PYRR6',1);
    INSERT INTO containers VALUES (1,1,'C-SOLO'),(2,1,'C-COMPARTIDO');
    INSERT INTO bl_cargo_items VALUES (1,5,1);
  `);
  moverBl(db, traer(db, 5), 2, 7);
  assert.strictEqual(traer(db, 5).sort_seq, 7);
  assert.strictEqual(db.prepare(`SELECT manifest_id m FROM containers WHERE container_no='C-SOLO'`).get().m, 2);
  assert.strictEqual(db.prepare(`SELECT manifest_id m FROM containers WHERE container_no='C-COMPARTIDO'`).get().m, 1);
  assert.strictEqual(db.prepare(`SELECT manifest_id m FROM container_bl WHERE bl_no='PYRR5' AND container_no='C-SOLO'`).get().m, 2);
  assert.strictEqual(db.prepare('SELECT manifest_id m FROM bl_cargo_items WHERE bl_id=5').get().m, 2);
});
