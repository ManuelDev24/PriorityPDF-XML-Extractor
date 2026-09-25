const test = require('node:test');
const assert = require('node:assert');

const { validateForSubmission } = require('./blValidation');

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
