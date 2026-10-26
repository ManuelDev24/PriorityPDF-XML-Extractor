const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const ExcelJS = require('exceljs');
const Database = require('better-sqlite3');
const { calcularPlanDeCambios, formatearVistaPrevia, aplicarCambios } = require('./reinyectar');

function crearDbDePrueba() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT, ss TEXT, taxid TEXT, add1 TEXT, add2 TEXT, add3 TEXT, phone1 TEXT, phone2 TEXT, ivu TEXT)`);
  db.prepare(`INSERT INTO clients (id, name, ss) VALUES (1, 'ACME', '123456789')`).run();
  // El resto de las tablas que hojas.js consulta deben existir, aunque vacias.
  db.exec(`
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
  return db;
}

function crearSiscommateFalso(tablas = {}) {
  const base = { CUSTOMER: [], MANIFEST: [], BOL: [], BOLCONT: [], BOLITEM: [], ...tablas };
  const llamadas = { actualizarClienteSiscommate: [] };
  return {
    obtenerTablaCompleta: async (tabla) => base[tabla] || [],
    actualizarClienteSiscommate: async (nombre, datos) => { llamadas.actualizarClienteSiscommate.push({ nombre, datos }); return { ok: true, filas_afectadas: 1 }; },
    actualizarBolSiscommate: async () => ({ ok: true, filas_afectadas: 1 }),
    actualizarBolcontSiscommate: async () => ({ ok: true, filas_afectadas: 1 }),
    actualizarBolitemSiscommate: async () => ({ ok: true, filas_afectadas: 1 }),
    _llamadas: llamadas,
  };
}

// Genera un .xlsx minimo con una hoja SQLite_Clientes cuya fila 1 de datos
// trae un name distinto al que hay en la base — para forzar un diff real.
async function crearExcelDePrueba(rutaDestino, nombreCorregido) {
  const workbook = new ExcelJS.Workbook();
  const hoja = workbook.addWorksheet('SQLite_Clientes');
  hoja.columns = ['id', 'name', 'ss', 'taxid', 'add1', 'add2', 'add3', 'phone1', 'phone2', 'ivu'].map(k => ({ header: k, key: k }));
  hoja.addRow({ id: 1, name: nombreCorregido, ss: '123456789' });
  await workbook.xlsx.writeFile(rutaDestino);
}

test('calcularPlanDeCambios acepta un buffer en memoria (subida por HTTP), no solo una ruta', async () => {
  const workbook = new ExcelJS.Workbook();
  const hoja = workbook.addWorksheet('SQLite_Clientes');
  hoja.columns = ['id', 'name', 'ss', 'taxid', 'add1', 'add2', 'add3', 'phone1', 'phone2', 'ivu'].map(k => ({ header: k, key: k }));
  hoja.addRow({ id: 1, name: 'ACME CORP', ss: '123456789' });
  const buffer = await workbook.xlsx.writeBuffer();

  const db = crearDbDePrueba();
  const plan = await calcularPlanDeCambios(buffer, { db, siscommate: crearSiscommateFalso() });

  assert.strictEqual(plan.length, 1);
  assert.deepStrictEqual(plan[0].cambios, { name: { antes: 'ACME', despues: 'ACME CORP' } });
});

test('calcularPlanDeCambios detecta un cambio real y lo ignora si no hay diferencias', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataAudit-reinyectar-'));
  const rutaExcel = path.join(dir, 'audit.xlsx');
  await crearExcelDePrueba(rutaExcel, 'ACME CORP');

  const db = crearDbDePrueba();
  const plan = await calcularPlanDeCambios(rutaExcel, { db, siscommate: crearSiscommateFalso() });

  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].hoja, 'SQLite_Clientes');
  assert.deepStrictEqual(plan[0].cambios, { name: { antes: 'ACME', despues: 'ACME CORP' } });
});

test('calcularPlanDeCambios no incluye filas sin cambios', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataAudit-reinyectar-'));
  const rutaExcel = path.join(dir, 'audit.xlsx');
  await crearExcelDePrueba(rutaExcel, 'ACME'); // mismo nombre que ya tiene la base

  const db = crearDbDePrueba();
  const plan = await calcularPlanDeCambios(rutaExcel, { db, siscommate: crearSiscommateFalso() });

  assert.strictEqual(plan.length, 0);
});

test('calcularPlanDeCambios marca error si el registro original ya no existe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataAudit-reinyectar-'));
  const rutaExcel = path.join(dir, 'audit.xlsx');
  const workbook = new ExcelJS.Workbook();
  const hoja = workbook.addWorksheet('SQLite_Clientes');
  hoja.columns = ['id', 'name', 'ss', 'taxid', 'add1', 'add2', 'add3', 'phone1', 'phone2', 'ivu'].map(k => ({ header: k, key: k }));
  hoja.addRow({ id: 999, name: 'FANTASMA', ss: '000' }); // id que no existe en la base
  await workbook.xlsx.writeFile(rutaExcel);

  const db = crearDbDePrueba();
  const plan = await calcularPlanDeCambios(rutaExcel, { db, siscommate: crearSiscommateFalso() });

  assert.strictEqual(plan.length, 1);
  assert.ok(plan[0].error);
});

test('formatearVistaPrevia muestra antes/despues legible y cuenta los cambios', () => {
  const plan = [{ hoja: 'SQLite_Clientes', claves: { id: 1 }, cambios: { name: { antes: 'ACME', despues: 'ACME CORP' } } }];
  const texto = formatearVistaPrevia(plan);
  assert.match(texto, /SQLite_Clientes/);
  assert.match(texto, /"ACME" → "ACME CORP"/);
  assert.match(texto, /1 cambio/);
});

test('formatearVistaPrevia sin cambios lo dice explicitamente', () => {
  assert.strictEqual(formatearVistaPrevia([]), 'No hay cambios que aplicar.');
});

test('aplicarCambios ejecuta escribirCambio y registra en el log; no toca las filas con error', async () => {
  const db = crearDbDePrueba();
  const siscommate = crearSiscommateFalso();
  const plan = [
    {
      hoja: 'SQLite_Clientes', claves: { id: 1 }, cambios: { name: { antes: 'ACME', despues: 'ACME CORP' } },
      filaFinal: { id: 1, name: 'ACME CORP' }, filaActual: { id: 1, name: 'ACME' },
      spec: require('./hojas').construirHojas().find(h => h.nombre === 'SQLite_Clientes'),
    },
    { hoja: 'SQLite_Clientes', claves: { id: 2 }, error: 'No se encontro el registro original' },
  ];
  const registrados = [];
  const resultado = await aplicarCambios(plan, { db, siscommate }, entrada => registrados.push(entrada));

  assert.deepStrictEqual(resultado, { aplicados: 1, fallidos: 1 });
  assert.strictEqual(db.prepare('SELECT name FROM clients WHERE id = 1').get().name, 'ACME CORP');
  assert.strictEqual(registrados.length, 2);
  // Escribe en los DOS lados: local (verificado arriba) y CUSTOMER.DBF real,
  // identificado por el nombre ANTERIOR (filaActual.name = 'ACME').
  assert.deepStrictEqual(siscommate._llamadas.actualizarClienteSiscommate, [
    { nombre: 'ACME', datos: { id: 1, name: 'ACME CORP' } },
  ]);
});
