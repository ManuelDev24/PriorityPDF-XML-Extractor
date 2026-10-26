// Tests de blValidarLote.js — "Validar todos" de un viaje, solo los B/L completos.
// Ejecutar: npm test   (desde manifest-app/)

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { validarLote } = require('./blValidarLote');
const { moverBl } = require('./blMove');

function baseDeDatos() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE manifests (id INTEGER PRIMARY KEY, voyage_no TEXT, status TEXT, docking_number TEXT);
    CREATE TABLE bills_of_lading (id INTEGER PRIMARY KEY, manifest_id INTEGER, bl_no TEXT, sort_seq INTEGER,
      status TEXT DEFAULT 'pendiente', hacienda_item_code TEXT, hacienda_client_ss TEXT,
      consignee_document_no TEXT, hacienda_container_no TEXT, modified_at TEXT,
      siscommate_sent_at TEXT, siscommate_voyage_no TEXT);
    CREATE TABLE container_bl (container_no TEXT, bl_no TEXT, manifest_id INTEGER);
    CREATE TABLE containers (id INTEGER PRIMARY KEY, manifest_id INTEGER, container_no TEXT, size TEXT);
    CREATE TABLE bl_cargo_items (id INTEGER PRIMARY KEY, bl_id INTEGER, manifest_id INTEGER);
    INSERT INTO manifests VALUES (1,'K1352','borrador','12345'),(2,'K1351','borrador','12345'),(3,'AU034','borrador','12345');
  `);
  return db;
}
let n = 100;
function nuevoBl(db, manifestId, bl_no, extra = {}) {
  const f = { status: 'pendiente', hacienda_item_code: '1234.56', hacienda_client_ss: '123456789', consignee_document_no: '', ...extra };
  db.prepare(`INSERT INTO bills_of_lading (id,manifest_id,bl_no,status,hacienda_item_code,hacienda_client_ss,consignee_document_no)
    VALUES (?,?,?,?,?,?,?)`).run(++n, manifestId, bl_no, f.status, f.hacienda_item_code, f.hacienda_client_ss, f.consignee_document_no);
  return n;
}
const estado = (db, id) => db.prepare('SELECT status FROM bills_of_lading WHERE id=?').get(id).status;
const contenedor = (db, manifestId, blNo, no, size) => {
  db.prepare('INSERT INTO container_bl VALUES (?,?,?)').run(no, blNo, manifestId);
  db.prepare('INSERT INTO containers (manifest_id,container_no,size) VALUES (?,?,?)').run(manifestId, no, size);
};

test('valida los B/L completos y deja los incompletos con su motivo', () => {
  const db = baseDeDatos();
  const ok = nuevoBl(db, 1, 'PYRR1');
  const sinCodigo = nuevoBl(db, 1, 'PYRR2', { hacienda_item_code: '' });
  const r = validarLote(db, 1);
  assert.deepStrictEqual(r.validados.map(b => b.bl_no), ['PYRR1']);
  assert.deepStrictEqual(r.omitidos, [{ id: sinCodigo, bl_no: 'PYRR2', motivos: ['sin código arancelario'] }]);
  assert.strictEqual(estado(db, ok), 'validado');
  assert.strictEqual(estado(db, sinCodigo), 'pendiente', 'el incompleto NO se toca');
});

test('un contenedor sin tamaño deja el B/L fuera, con el contenedor nombrado', () => {
  const db = baseDeDatos();
  const a = nuevoBl(db, 1, 'PYRR3');
  contenedor(db, 1, 'PYRR3', 'MSKU1234567', '');
  const b = nuevoBl(db, 1, 'PYRR4');
  contenedor(db, 1, 'PYRR4', 'TCLU7654321', '40');
  const r = validarLote(db, 1);
  assert.deepStrictEqual(r.omitidos.map(o => [o.bl_no, o.motivos]), [['PYRR3', ['contenedor sin tamaño: MSKU1234567']]]);
  assert.strictEqual(estado(db, a), 'pendiente');
  assert.strictEqual(estado(db, b), 'validado');
});

test('los B/L ya validados no se vuelven a tocar y se cuentan aparte', () => {
  const db = baseDeDatos();
  nuevoBl(db, 1, 'PYRR5', { status: 'validado' });
  nuevoBl(db, 1, 'PYRR6');
  const r = validarLote(db, 1);
  assert.strictEqual(r.ya_validados, 1);
  assert.deepStrictEqual(r.validados.map(b => b.bl_no), ['PYRR6']);
});

test('es idempotente: la segunda vez no valida nada nuevo', () => {
  const db = baseDeDatos();
  nuevoBl(db, 1, 'PYRR7');
  validarLote(db, 1);
  const r = validarLote(db, 1);
  assert.deepStrictEqual(r.validados, []);
  assert.strictEqual(r.ya_validados, 1);
});

test('solo toca el viaje pedido, no los B/L de otros viajes', () => {
  const db = baseDeDatos();
  nuevoBl(db, 1, 'PYRR8');
  const ajeno = nuevoBl(db, 2, 'PYRR9');
  validarLote(db, 1);
  assert.strictEqual(estado(db, ajeno), 'pendiente');
});

test('viajes AU/CF no exigen SS, igual que el export', () => {
  const db = baseDeDatos();
  const id = nuevoBl(db, 3, 'PYRR10', { hacienda_client_ss: '' });
  const r = validarLote(db, 3);
  assert.strictEqual(estado(db, id), 'validado');
  assert.deepStrictEqual(r.omitidos, []);
});

test('un B/L movido a este viaje se evalúa aquí y no pierde su marca de SISCOMMATE', () => {
  const db = baseDeDatos();
  const id = nuevoBl(db, 2, 'PYRR11');
  db.prepare(`UPDATE bills_of_lading SET siscommate_sent_at='2026-10-13 13:12:54', siscommate_voyage_no='K1351' WHERE id=?`).run(id);
  moverBl(db, db.prepare('SELECT * FROM bills_of_lading WHERE id=?').get(id), 1, 0);
  const r = validarLote(db, 1);
  assert.deepStrictEqual(r.validados.map(b => b.bl_no), ['PYRR11']);
  const fila = db.prepare('SELECT siscommate_sent_at s, siscommate_voyage_no v FROM bills_of_lading WHERE id=?').get(id);
  assert.strictEqual(fila.v, 'K1351', 'validar no debe tocar dónde está la copia en SISCOMMATE');
  assert.strictEqual(fila.s, '2026-10-13 13:12:54');
});

test('un B/L movido FUERA de este viaje ya no entra en la validación', () => {
  const db = baseDeDatos();
  const id = nuevoBl(db, 1, 'PYRR12');
  moverBl(db, db.prepare('SELECT * FROM bills_of_lading WHERE id=?').get(id), 2, 0);
  const r = validarLote(db, 1);
  assert.deepStrictEqual(r.validados, []);
  assert.strictEqual(estado(db, id), 'pendiente');
});

test('un viaje sin B/L no falla: devuelve todo en cero', () => {
  const db = baseDeDatos();
  assert.deepStrictEqual(validarLote(db, 1), { validados: [], omitidos: [], ya_validados: 0 });
});

test('un viaje que no existe devuelve null', () => {
  assert.strictEqual(validarLote(baseDeDatos(), 999), null);
});
