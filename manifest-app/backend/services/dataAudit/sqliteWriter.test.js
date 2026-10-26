const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { actualizarFilaSqlite } = require('./sqliteWriter');

function crearDbDePrueba() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT, ss TEXT)`);
  db.prepare(`INSERT INTO clients (id, name, ss) VALUES (1, 'ACME', '123')`).run();
  return db;
}

test('actualizarFilaSqlite aplica solo los campos presentes en cambios', () => {
  const db = crearDbDePrueba();
  actualizarFilaSqlite(db, 'clients', { id: 1 }, { name: { antes: 'ACME', despues: 'ACME CORP' } });
  const fila = db.prepare('SELECT * FROM clients WHERE id = 1').get();
  assert.deepStrictEqual(fila, { id: 1, name: 'ACME CORP', ss: '123' });
});

test('actualizarFilaSqlite con cambios vacios no ejecuta ningun UPDATE', () => {
  const db = crearDbDePrueba();
  assert.doesNotThrow(() => actualizarFilaSqlite(db, 'clients', { id: 1 }, {}));
  const fila = db.prepare('SELECT * FROM clients WHERE id = 1').get();
  assert.strictEqual(fila.name, 'ACME');
});

test('actualizarFilaSqlite solo toca la fila que coincide con la clave', () => {
  const db = crearDbDePrueba();
  db.prepare(`INSERT INTO clients (id, name, ss) VALUES (2, 'OTRO', '456')`).run();
  actualizarFilaSqlite(db, 'clients', { id: 1 }, { ss: { antes: '123', despues: '999' } });
  assert.strictEqual(db.prepare('SELECT ss FROM clients WHERE id = 1').get().ss, '999');
  assert.strictEqual(db.prepare('SELECT ss FROM clients WHERE id = 2').get().ss, '456');
});
