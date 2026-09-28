// Tests de clientSync.js — solo la parte pura (similitudTexto,
// normalizarParaComparar). sincronizarClientesDesdeSiscommate y
// buscarClienteParecido tocan la base real / hacen HTTP, no se prueban aquí.
// Ejecutar: npm test   (desde manifest-app/)

const test = require('node:test');
const assert = require('node:assert');
const { similitudTexto, normalizarParaComparar, consolidarNombresParecidos } = require('./clientSync');

test('normalizarParaComparar quita acentos, mayúsculas, puntuación y espacios extra', () => {
  // La puntuación se convierte en espacio (no se elimina sin más), por eso
  // "S.A.S" queda "S A S" — sigue comparando igual entre variantes que usan
  // la misma puntuación, que es el caso real (mismo cliente, mismo sufijo).
  assert.strictEqual(normalizarParaComparar('Cartonera Alfredo Hued, S.A.S'), 'CARTONERA ALFREDO HUED S A S');
  assert.strictEqual(normalizarParaComparar('CATAÑO  Peña'), 'CATANO PENA');
  assert.strictEqual(normalizarParaComparar(''), '');
  assert.strictEqual(normalizarParaComparar(null), '');
});

test('similitudTexto da 1 para nombres idénticos salvo mayúsculas/acentos', () => {
  assert.strictEqual(similitudTexto('LANCO MANUFACTURING CORP', 'lanco manufacturing corp'), 1);
  assert.strictEqual(similitudTexto('CATAÑO', 'catano'), 1);
});

test('similitudTexto da un valor alto para una variante con un pequeño error de digitación', () => {
  const sim = similitudTexto('CARTONERA ALFREDO HUED SAS', 'CARTONERA ALFREDO HEUD SAS');
  assert.ok(sim > 0.85, `esperaba > 0.85, dio ${sim}`);
});

test('similitudTexto da un valor bajo para nombres genuinamente distintos', () => {
  const sim = similitudTexto('LANCO MANUFACTURING CORP', 'OLEIN RECOVERY CORPORATION');
  assert.ok(sim < 0.5, `esperaba < 0.5, dio ${sim}`);
});

test('similitudTexto con texto vacío da 0, no rompe', () => {
  assert.strictEqual(similitudTexto('', 'ALGO'), 0);
  assert.strictEqual(similitudTexto('ALGO', ''), 0);
  assert.strictEqual(similitudTexto('', ''), 0);
});

test('consolidarNombresParecidos colapsa variantes de puntuacion/mayusculas en una sola forma', () => {
  const r = consolidarNombresParecidos(['ACME SA', 'Acme, S.A.', 'acme sa']);
  assert.strictEqual(r.length, 1);
});

test('consolidarNombresParecidos elige la variante mas larga como forma canonica', () => {
  const r = consolidarNombresParecidos(['CARTONERA ALFREDO HUED', 'CARTONERA ALFREDO HUED SA']);
  assert.deepStrictEqual(r, ['CARTONERA ALFREDO HUED SA']);
});

test('consolidarNombresParecidos agrupa transitivamente (A~B, B~C agrupan los tres)', () => {
  const r = consolidarNombresParecidos(['CARTONERA ALFREDO HUED SAS', 'CARTONERA ALFREDO HEUD SAS', 'CARTONERA ALFREDO HUED SA']);
  assert.strictEqual(r.length, 1);
});

test('consolidarNombresParecidos no mezcla nombres genuinamente distintos', () => {
  const r = consolidarNombresParecidos(['LANCO MANUFACTURING CORP', 'OLEIN RECOVERY CORPORATION']);
  assert.strictEqual(r.length, 2);
});

test('consolidarNombresParecidos ignora vacios y duplicados exactos', () => {
  const r = consolidarNombresParecidos(['ACME', '', '  ', 'ACME', null, undefined]);
  assert.deepStrictEqual(r, ['ACME']);
});
