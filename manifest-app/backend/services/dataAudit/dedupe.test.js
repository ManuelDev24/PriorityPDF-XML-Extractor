const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const {
  CAMPOS_CONSIGNADOR, CAMPOS_CONSIGNATARIO,
  deduplicarConsignadores, deduplicarConsignatarios,
  actualizarConsignadorPorNombre, actualizarConsignatarioPorNombre,
} = require('./dedupe');

const bls = [
  { consignor_name: 'ACME SA', consignor_document_type: 'RNC', consignor_document_no: '111', consignor_tel: '', consignor_email: '', consignor_street: 'CALLE 1', consignor_city: 'STO DGO',
    consignee_name: 'JOHN DOE', consignee_document_type: 'SS', consignee_document_no: '999', consignee_tel: '7871234567', consignee_email: '', consignee_street: '', consignee_city: '' },
  { consignor_name: 'ACME SA', consignor_document_type: 'RNC', consignor_document_no: '111', consignor_tel: '', consignor_email: '', consignor_street: 'CALLE 1', consignor_city: 'STO DGO',
    consignee_name: 'JANE DOE', consignee_document_type: 'SS', consignee_document_no: '888', consignee_tel: '', consignee_email: '', consignee_street: '', consignee_city: '' },
  { consignor_name: '', consignor_document_type: '', consignor_document_no: '', consignor_tel: '', consignor_email: '', consignor_street: '', consignor_city: '',
    consignee_name: 'ANA PEREZ', consignee_document_type: '', consignee_document_no: '', consignee_tel: '', consignee_email: '', consignee_street: '', consignee_city: '' },
];

test('deduplicarConsignadores devuelve una fila por nombre distinto, sin vacios', () => {
  const r = deduplicarConsignadores(bls);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].consignor_name, 'ACME SA');
  assert.strictEqual(r[0].consignor_document_no, '111');
});

test('deduplicarConsignatarios devuelve una fila por cada consignatario distinto, ordenadas por nombre', () => {
  const r = deduplicarConsignatarios(bls);
  assert.deepStrictEqual(r.map(x => x.consignee_name), ['ANA PEREZ', 'JANE DOE', 'JOHN DOE']);
});

test('deduplicarConsignadores/Consignatarios usan las columnas declaradas en CAMPOS_*', () => {
  const r = deduplicarConsignadores(bls)[0];
  assert.deepStrictEqual(Object.keys(r).sort(), [...CAMPOS_CONSIGNADOR].sort());
  const r2 = deduplicarConsignatarios(bls)[0];
  assert.deepStrictEqual(Object.keys(r2).sort(), [...CAMPOS_CONSIGNATARIO].sort());
});

test('actualizarConsignadorPorNombre propaga el cambio a todos los B/L con ese nombre', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE bills_of_lading (id INTEGER PRIMARY KEY, consignor_name TEXT, consignor_city TEXT, consignee_name TEXT)`);
  db.prepare(`INSERT INTO bills_of_lading (consignor_name, consignor_city, consignee_name) VALUES ('JHON DOE','SAN JUAN','X')`).run();
  db.prepare(`INSERT INTO bills_of_lading (consignor_name, consignor_city, consignee_name) VALUES ('JHON DOE','SAN JUAN','Y')`).run();
  db.prepare(`INSERT INTO bills_of_lading (consignor_name, consignor_city, consignee_name) VALUES ('OTRO','PONCE','Z')`).run();

  actualizarConsignadorPorNombre(db, 'JHON DOE', { consignor_city: { antes: 'SAN JUAN', despues: 'BAYAMON' } });

  const filas = db.prepare('SELECT consignor_name, consignor_city FROM bills_of_lading ORDER BY id').all();
  assert.deepStrictEqual(filas, [
    { consignor_name: 'JHON DOE', consignor_city: 'BAYAMON' },
    { consignor_name: 'JHON DOE', consignor_city: 'BAYAMON' },
    { consignor_name: 'OTRO', consignor_city: 'PONCE' },
  ]);
});

test('actualizarConsignadorPorNombre sin cambios no ejecuta ningun UPDATE', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE bills_of_lading (id INTEGER PRIMARY KEY, consignor_name TEXT)`);
  db.prepare(`INSERT INTO bills_of_lading (consignor_name) VALUES ('ACME')`).run();
  assert.doesNotThrow(() => actualizarConsignadorPorNombre(db, 'ACME', {}));
});
