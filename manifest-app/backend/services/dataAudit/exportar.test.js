const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { construirLibroAuditoria } = require('./exportar');

function crearDbDePrueba() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT, ss TEXT, taxid TEXT, add1 TEXT, add2 TEXT, add3 TEXT, phone1 TEXT, phone2 TEXT, ivu TEXT);
    CREATE TABLE manifests (id INTEGER PRIMARY KEY, voyage_no TEXT, vessel_name TEXT, loading_port TEXT, unloading_port TEXT, discharge_port TEXT, departure_date TEXT, arrival_date TEXT, manifest_no TEXT, carrier_code TEXT, docking_number TEXT, imo TEXT);
    CREATE TABLE bills_of_lading (
      id INTEGER PRIMARY KEY, manifest_id INTEGER, bl_no TEXT,
      consignor_name TEXT, consignor_document_type TEXT, consignor_document_no TEXT, consignor_tel TEXT, consignor_email TEXT, consignor_street TEXT, consignor_city TEXT,
      consignee_name TEXT, consignee_document_type TEXT, consignee_document_no TEXT, consignee_tel TEXT, consignee_email TEXT, consignee_street TEXT, consignee_city TEXT,
      goods_name TEXT, package_qty INTEGER, gross_weight REAL, value REAL,
      hacienda_item_code TEXT, hacienda_tariff TEXT, hacienda_container_no TEXT, hacienda_client_ss TEXT, hacienda_client_ivu TEXT, notes TEXT
    );
    CREATE TABLE containers (id INTEGER PRIMARY KEY, manifest_id INTEGER, container_no TEXT, container_type TEXT, package_code TEXT, amount INTEGER, gross_weight REAL, net_weight REAL, seal_no1 TEXT, size TEXT);
    CREATE TABLE container_bl (container_no TEXT, bl_no TEXT, manifest_id INTEGER);
  `);
  db.prepare(`INSERT INTO clients (id, name, ss) VALUES (1, 'ACME', '123456789')`).run();
  db.prepare(`INSERT INTO manifests (id, voyage_no, vessel_name) VALUES (1, 'CF371', 'BARCO 1')`).run();
  db.prepare(`INSERT INTO bills_of_lading (id, manifest_id, bl_no, consignor_name, consignor_city, consignee_name, gross_weight)
              VALUES (1, 1, 'CF371-001', 'EXPORTADOR X', 'STO DGO', 'JOHN DOE', 1500)`).run();
  db.prepare(`INSERT INTO bills_of_lading (id, manifest_id, bl_no, consignor_name, consignor_city, consignee_name, gross_weight)
              VALUES (2, 1, 'CF371-002', 'EXPORTADOR X', 'STO DGO', 'JANE DOE', 800)`).run();
  db.prepare(`INSERT INTO containers (id, manifest_id, container_no, size) VALUES (1, 1, 'MXRU1234567', '40')`).run();
  db.prepare(`INSERT INTO container_bl (container_no, bl_no, manifest_id) VALUES ('MXRU1234567', 'CF371-001', 1)`).run();
  return db;
}

function crearSiscommateFalso() {
  const tablas = {
    CUSTOMER: [{ name: 'ACME', ss: '123456789', code: '', type: '', taxid: '', add1: '', add2: '', add3: '', phone1: '', phone2: '', fax1: '', fax2: '', ivu: '' }],
    MANIFEST: [{ manifest: 'CF371', vessel: 'BARCO 1' }],
    BOL: [{ manifest: 'CF371', bolno: '001', consigne: 'JOHN DOE', exporter: 'EXPORTADOR X' }],
    BOLCONT: [{ manifest: 'CF371', bolno: '001', contain: 'MXRU1234567', size: '040', control: '1' }],
    BOLITEM: [{ manifest: 'CF371', bolno: '001', qty: 1, weight: 1500, desc: 'VEHICULO', code: '8703', value: 5000, control: '1' }],
  };
  return { obtenerTablaCompleta: async (tabla) => tablas[tabla] || [] };
}

test('construirLibroAuditoria genera las 11 hojas esperadas', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba(), crearSiscommateFalso());
  const nombres = workbook.worksheets.map(w => w.name);
  assert.deepStrictEqual(nombres, [
    'SQLite_Clientes', 'SQLite_Consignadores', 'SQLite_Consignatarios', 'SQLite_Manifiestos', 'SQLite_BLs', 'SQLite_Contenedores',
    'SISCOMMATE_Customers', 'SISCOMMATE_Manifiestos', 'SISCOMMATE_BLs', 'SISCOMMATE_Contenedores', 'SISCOMMATE_Items',
  ]);
});

test('SQLite_Consignadores deduplica: 2 B/L del mismo exportador dan 1 fila', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba(), crearSiscommateFalso());
  const hoja = workbook.getWorksheet('SQLite_Consignadores');
  assert.strictEqual(hoja.rowCount, 2); // encabezado + 1 fila de datos
  assert.strictEqual(hoja.getRow(2).getCell('consignor_name').value, 'EXPORTADOR X');
});

test('SQLite_Contenedores incluye los B/L asociados via container_bl', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba(), crearSiscommateFalso());
  const hoja = workbook.getWorksheet('SQLite_Contenedores');
  assert.strictEqual(hoja.getRow(2).getCell('bls_asociados').value, 'CF371-001');
});

test('la primera columna de cada hoja es la clave tecnica, sombreada y con nota', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba(), crearSiscommateFalso());
  const hoja = workbook.getWorksheet('SQLite_Clientes');
  assert.strictEqual(hoja.getRow(1).getCell(1).value, 'id');
  const celda = hoja.getRow(1).getCell(1);
  assert.strictEqual(celda.fill.fgColor.argb, 'FFD9D9D9');
  assert.ok(celda.note);
});

test('SISCOMMATE_BLs trae los datos del "siscommate" falso inyectado', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba(), crearSiscommateFalso());
  const hoja = workbook.getWorksheet('SISCOMMATE_BLs');
  assert.strictEqual(hoja.getRow(2).getCell('consigne').value, 'JOHN DOE');
});

test('si el bridge no responde, las hojas SQLite igual se generan (la hoja SISCOMMATE queda vacia)', async () => {
  const siscommateRoto = { obtenerTablaCompleta: async () => { throw new Error('Conexión rechazada por localhost:5001'); } };
  const workbook = await construirLibroAuditoria(crearDbDePrueba(), siscommateRoto);
  assert.strictEqual(workbook.worksheets.length, 11);
  assert.strictEqual(workbook.getWorksheet('SQLite_Clientes').getRow(2).getCell('name').value, 'ACME');
  assert.strictEqual(workbook.getWorksheet('SISCOMMATE_Customers').rowCount, 1); // solo encabezado
});

test('SQLite_Clientes trae formato condicional para resaltar nombres duplicados en la columna "name"', async () => {
  const db = crearDbDePrueba();
  db.prepare(`INSERT INTO clients (id, name) VALUES (2, 'ACME')`).run(); // mismo nombre que el id=1
  const workbook = await construirLibroAuditoria(db, crearSiscommateFalso());
  const hoja = workbook.getWorksheet('SQLite_Clientes');
  const reglas = hoja.model.conditionalFormattings;
  const duplicados = reglas.find(r => r.rules.some(x => x.type === 'duplicateValues'));
  assert.ok(duplicados, 'debe existir una regla duplicateValues');
  assert.strictEqual(duplicados.ref, 'B2:B3'); // columna "name" es la B (A es "id"), 2 filas de datos
});

test('SQLite_Clientes trae formato condicional para resaltar caracteres fuera de A-Z/0-9/espacio en "name"', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba(), crearSiscommateFalso());
  const hoja = workbook.getWorksheet('SQLite_Clientes');
  const reglas = hoja.model.conditionalFormattings;
  const especiales = reglas.find(r => r.rules.some(x => x.type === 'expression'));
  assert.ok(especiales, 'debe existir una regla expression para caracteres especiales');
  assert.match(especiales.rules[0].formulae[0], /ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/);
});

test('una hoja sin columnaDuplicados/columnasEspeciales configuradas no trae formato condicional', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba(), crearSiscommateFalso());
  const hoja = workbook.getWorksheet('SQLite_Contenedores');
  assert.strictEqual((hoja.model.conditionalFormattings || []).length, 0);
});
