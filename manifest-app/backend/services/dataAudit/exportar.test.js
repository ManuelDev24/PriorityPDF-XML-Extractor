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
  db.prepare(`INSERT INTO clients (id, name, ss, add1, phone1) VALUES (1, 'ACME', '123456789', 'CALLE 1', '7871234567')`).run();
  db.prepare(`INSERT INTO manifests (id, voyage_no, vessel_name) VALUES (1, 'CF371', 'BARCO 1')`).run();
  db.prepare(`INSERT INTO bills_of_lading (id, manifest_id, bl_no, consignor_name, consignor_city, consignor_document_no, consignor_tel, consignee_name, gross_weight)
              VALUES (1, 1, 'CF371-001', 'EXPORTADOR X', 'STO DGO', '111', '8091234567', 'JOHN DOE', 1500)`).run();
  db.prepare(`INSERT INTO bills_of_lading (id, manifest_id, bl_no, consignor_name, consignor_city, consignor_document_no, consignor_tel, consignee_name, gross_weight)
              VALUES (2, 1, 'CF371-002', 'EXPORTADOR X', 'STO DGO', '111', '8091234567', 'JANE DOE', 800)`).run();
  db.prepare(`INSERT INTO containers (id, manifest_id, container_no, size) VALUES (1, 1, 'MXRU1234567', '40')`).run();
  db.prepare(`INSERT INTO container_bl (container_no, bl_no, manifest_id) VALUES ('MXRU1234567', 'CF371-001', 1)`).run();
  return db;
}

test('construirLibroAuditoria genera las 6 hojas esperadas, todas desde SQLite', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba());
  const nombres = workbook.worksheets.map(w => w.name);
  assert.deepStrictEqual(nombres, [
    'SQLite_Clientes', 'SQLite_Consignadores', 'SQLite_Consignatarios', 'SQLite_Manifiestos', 'SQLite_BLs', 'SQLite_Contenedores',
  ]);
});

test('SQLite_Consignadores deduplica: 2 B/L del mismo exportador dan 1 fila', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba());
  const hoja = workbook.getWorksheet('SQLite_Consignadores');
  assert.strictEqual(hoja.rowCount, 2); // encabezado + 1 fila de datos
  assert.strictEqual(hoja.getRow(2).getCell('consignor_name').value, 'EXPORTADOR X');
});

test('SQLite_Contenedores incluye los B/L asociados via container_bl', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba());
  const hoja = workbook.getWorksheet('SQLite_Contenedores');
  assert.strictEqual(hoja.getRow(2).getCell('bls_asociados').value, 'CF371-001');
});

test('la primera columna de cada hoja es la clave tecnica, sombreada y con nota', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba());
  const hoja = workbook.getWorksheet('SQLite_Clientes');
  assert.strictEqual(hoja.getRow(1).getCell(1).value, 'id');
  const celda = hoja.getRow(1).getCell(1);
  assert.strictEqual(celda.fill.fgColor.argb, 'FFD9D9D9');
  assert.ok(celda.note);
});

test('SQLite_Clientes trae formula viva para resaltar caracteres fuera de A-Z/0-9/espacio en "name"', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba());
  const hoja = workbook.getWorksheet('SQLite_Clientes');
  const reglas = hoja.model.conditionalFormattings;
  const especiales = reglas.find(r => r.rules.some(x => x.type === 'expression'));
  assert.ok(especiales, 'debe existir una regla expression para caracteres especiales');
  assert.match(especiales.rules[0].formulae[0], /ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/);
});

test('una hoja sin columnasEspeciales configuradas no trae formato condicional', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba());
  const hoja = workbook.getWorksheet('SQLite_Contenedores');
  assert.strictEqual((hoja.model.conditionalFormattings || []).length, 0);
});

test('SQLite_Clientes trae _campos_faltantes vacio cuando el cliente esta completo', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba());
  const hoja = workbook.getWorksheet('SQLite_Clientes');
  assert.strictEqual(hoja.getRow(2).getCell('_campos_faltantes').value, '');
});

test('SQLite_Clientes marca y colorea _campos_faltantes cuando le falta documento/direccion/telefono', async () => {
  const db = crearDbDePrueba();
  db.prepare(`INSERT INTO clients (id, name) VALUES (2, 'INCOMPLETO SA')`).run(); // sin ss/add1/phone1
  const workbook = await construirLibroAuditoria(db);
  const hoja = workbook.getWorksheet('SQLite_Clientes');
  const celda = hoja.getRow(3).getCell('_campos_faltantes');
  assert.strictEqual(celda.value, 'documento, direccion, telefono');
  assert.strictEqual(celda.fill.fgColor.argb, 'FFFFE0B2');
});

test('SQLite_Clientes marca y colorea _posible_duplicado cuando dos nombres son muy parecidos', async () => {
  const db = crearDbDePrueba();
  db.prepare(`INSERT INTO clients (id, name) VALUES (2, 'Acme.')`).run(); // misma entidad que "ACME" (solo puntuacion/mayusculas)
  const workbook = await construirLibroAuditoria(db);
  const hoja = workbook.getWorksheet('SQLite_Clientes');
  const celdaUno = hoja.getRow(2).getCell('_posible_duplicado');
  const celdaDos = hoja.getRow(3).getCell('_posible_duplicado');
  assert.match(String(celdaUno.value), /Acme\./);
  assert.match(String(celdaDos.value), /ACME/);
  assert.strictEqual(celdaUno.fill.fgColor.argb, 'FFF8D7DA');
});

test('SQLite_Consignadores tambien trae _campos_faltantes y _posible_duplicado', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba());
  const hoja = workbook.getWorksheet('SQLite_Consignadores');
  const encabezados = hoja.getRow(1).values.slice(1);
  assert.ok(encabezados.includes('_campos_faltantes'));
  assert.ok(encabezados.includes('_posible_duplicado'));
});
