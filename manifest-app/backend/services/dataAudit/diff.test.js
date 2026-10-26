const test = require('node:test');
const assert = require('node:assert');
const { calcularDiferencias } = require('./diff');

test('calcularDiferencias no reporta nada si ningun campo editable cambio', () => {
  const actual = { id: 1, name: 'ACME', ss: '123456789' };
  const excel  = { id: 1, name: 'ACME', ss: '123456789' };
  assert.deepStrictEqual(calcularDiferencias(excel, actual, ['name', 'ss']), {});
});

test('calcularDiferencias reporta solo los campos que cambiaron', () => {
  const actual = { name: 'JHON DOE', ss: '123456789', tel: '7871234567' };
  const excel  = { name: 'JOHN DOE', ss: '123456789', tel: '7871234567' };
  assert.deepStrictEqual(
    calcularDiferencias(excel, actual, ['name', 'ss', 'tel']),
    { name: { antes: 'JHON DOE', despues: 'JOHN DOE' } }
  );
});

test('calcularDiferencias trata null, undefined y "" como el mismo valor vacio', () => {
  const actual = { notas: null };
  const excel  = { notas: '' };
  assert.deepStrictEqual(calcularDiferencias(excel, actual, ['notas']), {});
});

test('calcularDiferencias compara numeros y su version en texto como iguales', () => {
  const actual = { peso: 1500 };
  const excel  = { peso: '1500' };
  assert.deepStrictEqual(calcularDiferencias(excel, actual, ['peso']), {});
});

test('calcularDiferencias ignora campos que no estan en camposEditables', () => {
  const actual = { id: 1, name: 'ACME' };
  const excel  = { id: 2, name: 'ACME' }; // id cambio, pero no es editable
  assert.deepStrictEqual(calcularDiferencias(excel, actual, ['name']), {});
});
