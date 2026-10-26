const test = require('node:test');
const assert = require('node:assert');

const { validateForSubmission, evaluarCompletitud } = require('./blValidation');

function bl(overrides) {
  return {
    bl_no: 'PYRR0000001',
    status: 'validado',
    hacienda_item_code: '1234.56',
    hacienda_client_ss: '',
    consignee_document_no: '',
    goods_name: 'ALGO',
    ...overrides,
  };
}

test('sin SS/EIN del consignatario bloquea la entrega en un viaje normal', () => {
  const manifest = { docking_number: '123', voyage_no: 'K1340' };
  const { errors } = validateForSubmission(manifest, [bl({})]);
  assert.ok(errors.some(e => e.includes('SS/EIN')), 'debe bloquear por falta de SS/EIN');
});

test('viajes AU no exigen SS/EIN del consignatario — consignatarios de islas (STX/STT) casi nunca lo tienen', () => {
  const manifest = { docking_number: '123', voyage_no: 'AU034s' };
  const { errors } = validateForSubmission(manifest, [bl({})]);
  assert.ok(!errors.some(e => e.includes('SS/EIN')), 'no debe bloquear por SS/EIN en un viaje AU');
});

test('viajes CF tampoco exigen SS/EIN del consignatario', () => {
  const manifest = { docking_number: '123', voyage_no: 'CF012' };
  const { errors } = validateForSubmission(manifest, [bl({})]);
  assert.ok(!errors.some(e => e.includes('SS/EIN')), 'no debe bloquear por SS/EIN en un viaje CF');
});

test('un viaje AU sigue exigiendo código arancelario — la excepción es solo para SS/EIN', () => {
  const manifest = { docking_number: '123', voyage_no: 'AU034s' };
  const { errors } = validateForSubmission(manifest, [bl({ hacienda_item_code: '' })]);
  assert.ok(errors.some(e => e.includes('código arancelario')), 'sigue exigiendo el código arancelario');
});

// ── evaluarCompletitud: ¿este B/L está listo para validarse? ────────────────
// Misma regla que el punto rojo del sidebar y que bloquea el export, en un
// solo lugar: código arancelario, SS/EIN del consignatario (salvo viajes
// AU/CF) y tamaño de cada contenedor.
const viaje = { voyage_no: 'K1352' };

test('completitud: un B/L con código, SS y contenedores con tamaño está completo', () => {
  const r = evaluarCompletitud(viaje, bl({ hacienda_client_ss: '123456789' }), []);
  assert.deepStrictEqual(r, { completo: true, motivos: [] });
});

test('completitud: sin código arancelario, o con código solo ceros, está incompleto', () => {
  const base = { hacienda_client_ss: '123456789' };
  assert.deepStrictEqual(evaluarCompletitud(viaje, bl({ ...base, hacienda_item_code: '' }), []).motivos, ['sin código arancelario']);
  assert.deepStrictEqual(evaluarCompletitud(viaje, bl({ ...base, hacienda_item_code: '  ' }), []).motivos, ['sin código arancelario']);
  assert.deepStrictEqual(evaluarCompletitud(viaje, bl({ ...base, hacienda_item_code: '0000' }), []).motivos, ['sin código arancelario']);
});

test('completitud: sin SS/EIN ni documento del consignatario está incompleto en un viaje normal', () => {
  const r = evaluarCompletitud(viaje, bl({}), []);
  assert.strictEqual(r.completo, false);
  assert.deepStrictEqual(r.motivos, ['sin SS/EIN del consignatario']);
});

test('completitud: el documento del consignatario sustituye al SS', () => {
  assert.strictEqual(evaluarCompletitud(viaje, bl({ consignee_document_no: '987654321' }), []).completo, true);
});

test('completitud: viajes AU y CF no exigen SS/EIN (igual que validateForSubmission)', () => {
  assert.strictEqual(evaluarCompletitud({ voyage_no: 'AU034s' }, bl({}), []).completo, true);
  assert.strictEqual(evaluarCompletitud({ voyage_no: 'cf381b' }, bl({}), []).completo, true);
});

test('completitud: contenedores sin tamaño hacen incompleto el B/L y se nombran', () => {
  const r = evaluarCompletitud(viaje, bl({ hacienda_client_ss: '1' }), ['MSKU1234567', 'TCLU7654321']);
  assert.strictEqual(r.completo, false);
  assert.deepStrictEqual(r.motivos, ['contenedor sin tamaño: MSKU1234567, TCLU7654321']);
});

test('completitud: acumula todos los motivos, en un orden estable', () => {
  const r = evaluarCompletitud(viaje, bl({ hacienda_item_code: '' }), ['MSKU1234567']);
  assert.deepStrictEqual(r.motivos, ['sin código arancelario', 'sin SS/EIN del consignatario', 'contenedor sin tamaño: MSKU1234567']);
});

test('completitud: validateForSubmission y evaluarCompletitud no pueden contradecirse en código y SS', () => {
  const manifest = { docking_number: '123', voyage_no: 'K1352' };
  [bl({}), bl({ hacienda_item_code: '0' }), bl({ hacienda_client_ss: '1' }), bl({ consignee_document_no: '9' })].forEach(b => {
    const bloqueaExport = validateForSubmission(manifest, [b]).errors.length > 0;
    assert.strictEqual(evaluarCompletitud(manifest, b, []).completo, !bloqueaExport);
  });
});
