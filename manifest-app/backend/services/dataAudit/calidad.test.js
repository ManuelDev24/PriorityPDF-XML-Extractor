const test = require('node:test');
const assert = require('node:assert');
const { camposFaltantes, detectarPosiblesDuplicados } = require('./calidad');

const MAPEO = { documento: 'ss', direccion: 'add1', telefono: 'phone1' };

test('camposFaltantes lista solo lo que esta vacio', () => {
  assert.strictEqual(camposFaltantes({ ss: '', add1: 'CALLE 1', phone1: '' }, MAPEO), 'documento, telefono');
  assert.strictEqual(camposFaltantes({ ss: '123', add1: 'CALLE 1', phone1: '787' }, MAPEO), '');
});

test('camposFaltantes trata espacios en blanco y null como vacio', () => {
  assert.strictEqual(camposFaltantes({ ss: '   ', add1: null, phone1: '787' }, MAPEO), 'documento, direccion');
});

test('detectarPosiblesDuplicados encuentra variantes de mayusculas/puntuacion del mismo nombre', () => {
  const nombres = ['ACME SA', 'Acme S.A.', 'OTRO NOMBRE TOTALMENTE DISTINTO'];
  const r = detectarPosiblesDuplicados(nombres);
  assert.match(r[0], /Acme S\.A\./);
  assert.match(r[1], /ACME SA/);
  assert.strictEqual(r[2], '');
});

test('detectarPosiblesDuplicados no marca nombres genuinamente distintos', () => {
  const nombres = ['ACME SA', 'GOMAS Y PLASTICOS', 'JOHN DOE IMPORT'];
  const r = detectarPosiblesDuplicados(nombres);
  assert.deepStrictEqual(r, ['', '', '']);
});

test('detectarPosiblesDuplicados ignora nombres vacios', () => {
  const nombres = ['', 'ACME SA', ''];
  const r = detectarPosiblesDuplicados(nombres);
  assert.deepStrictEqual(r, ['', '', '']);
});

test('detectarPosiblesDuplicados agrupa solo por las primeras letras (no compara n^2 contra todo)', () => {
  // "ACME" y "ZULU" no comparten prefijo — no deberian ni intentarse comparar.
  const nombres = ['ACME SA', 'ZULU IMPORTS'];
  const r = detectarPosiblesDuplicados(nombres);
  assert.deepStrictEqual(r, ['', '']);
});
