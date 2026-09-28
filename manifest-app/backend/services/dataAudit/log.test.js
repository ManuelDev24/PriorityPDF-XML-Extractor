const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registrarCambio, rutaDelDia } = require('./log');

function carpetaTemporal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dataAudit-log-'));
}

test('registrarCambio crea la carpeta y el archivo del dia si no existen', () => {
  const dir = carpetaTemporal();
  registrarCambio({ hoja: 'SQLite_Clientes', claves: { id: 1 }, cambios: { name: { antes: 'A', despues: 'B' } } }, dir);
  const ruta = rutaDelDia(new Date(), dir);
  assert.ok(fs.existsSync(ruta));
});

test('registrarCambio agrega una linea JSON por llamada, con timestamp', () => {
  const dir = carpetaTemporal();
  registrarCambio({ hoja: 'X', claves: { id: 1 }, cambios: {} }, dir);
  registrarCambio({ hoja: 'Y', claves: { id: 2 }, cambios: {} }, dir);
  const lineas = fs.readFileSync(rutaDelDia(new Date(), dir), 'utf8').trim().split('\n');
  assert.strictEqual(lineas.length, 2);
  const primera = JSON.parse(lineas[0]);
  assert.strictEqual(primera.hoja, 'X');
  assert.ok(primera.timestamp);
});

test('registrarCambio conserva el campo error cuando la escritura fallo', () => {
  const dir = carpetaTemporal();
  registrarCambio({ hoja: 'X', claves: { id: 1 }, cambios: {}, error: 'El bridge no respondio' }, dir);
  const linea = JSON.parse(fs.readFileSync(rutaDelDia(new Date(), dir), 'utf8').trim());
  assert.strictEqual(linea.error, 'El bridge no respondio');
});
