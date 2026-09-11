// Tests de siscommateClient.js — solo la parte pura (limpiarTextoLibre).
// pushManifest/bridgeRequest hacen HTTP real, no se prueban aquí.
// Ejecutar: npm test   (desde manifest-app/)

const test = require('node:test');
const assert = require('node:assert');
const { limpiarTextoLibre, calcularPackageUnitCode, calcularPuertos } = require('./siscommateClient');

test('limpiarTextoLibre quita acentos conservando la letra', () => {
  assert.strictEqual(limpiarTextoLibre('GOMAS Y PLÁSTICOS'), 'GOMAS Y PLASTICOS');
  assert.strictEqual(limpiarTextoLibre('CATAÑO'), 'CATANO');
});

test('limpiarTextoLibre quita dos puntos, comas, puntos, guiones y barras', () => {
  assert.strictEqual(limpiarTextoLibre('CONTAINING: BOXES'), 'CONTAINING BOXES');
  assert.strictEqual(limpiarTextoLibre('GOMAS Y PLASTICOS, S.A'), 'GOMAS Y PLASTICOS SA');
  assert.strictEqual(limpiarTextoLibre('KM. 28,, CARR. SANCHEZ'), 'KM 28 CARR SANCHEZ');
  assert.strictEqual(limpiarTextoLibre('TEL: 787-767-6910'), 'TEL 7877676910');
  assert.strictEqual(limpiarTextoLibre('RNC: 130584966 // CALLE G'), 'RNC 130584966 CALLE G');
});

test('limpiarTextoLibre quita comillas curvas y otros símbolos no previstos', () => {
  assert.strictEqual(limpiarTextoLibre('JAR CANDLES 8” QUALITY'), 'JAR CANDLES 8 QUALITY');
  assert.strictEqual(limpiarTextoLibre('CAFÉ ★ EXPRESS'), 'CAFE EXPRESS');
});

test('limpiarTextoLibre colapsa espacios múltiples y recorta puntas', () => {
  assert.strictEqual(limpiarTextoLibre('  DOBLE   ESPACIO  '), 'DOBLE ESPACIO');
});

test('limpiarTextoLibre con vacío/null/undefined da string vacío', () => {
  assert.strictEqual(limpiarTextoLibre(''), '');
  assert.strictEqual(limpiarTextoLibre(null), '');
  assert.strictEqual(limpiarTextoLibre(undefined), '');
});

test('calcularPackageUnitCode respeta un valor ya válido', () => {
  assert.strictEqual(calcularPackageUnitCode('BOX', false), 'BOX');
  assert.strictEqual(calcularPackageUnitCode('LSE', true), 'LSE');
});

test('calcularPackageUnitCode vacío: LSE sin contenedor, BOX con contenedor', () => {
  assert.strictEqual(calcularPackageUnitCode('', false), 'LSE');
  assert.strictEqual(calcularPackageUnitCode(null, false), 'LSE');
  assert.strictEqual(calcularPackageUnitCode(undefined, true), 'BOX');
  assert.strictEqual(calcularPackageUnitCode('', true), 'BOX');
});

test('calcularPackageUnitCode normaliza sinónimos antes de decidir', () => {
  assert.strictEqual(calcularPackageUnitCode('carton', false), 'BOX');
  assert.strictEqual(calcularPackageUnitCode('pallet', true), 'PALETS');
});

test('calcularPackageUnitCode descarta un valor no reconocido y cae al respaldo', () => {
  assert.strictEqual(calcularPackageUnitCode('PACK', false), 'LSE');
  assert.strictEqual(calcularPackageUnitCode('IG013', true), 'BOX');
});

test('calcularPuertos traduce origen y destino igual que el TXT local', () => {
  assert.deepStrictEqual(
    calcularPuertos({ loading_port: 'USMIA', unloading_port: 'PRSJU' }),
    { origport: 'MIA', discport: 'XSJ' }
  );
  assert.deepStrictEqual(
    calcularPuertos({ loading_port: 'VISTT', unloading_port: 'MGE' }),
    { origport: 'STT', discport: 'MGE' }
  );
});

test('calcularPuertos sin puerto cae al respaldo (Santo Domingo / San Juan)', () => {
  assert.deepStrictEqual(calcularPuertos({}), { origport: 'DRP', discport: 'XSJ' });
});
