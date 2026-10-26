const test = require('node:test');
const assert = require('node:assert');
const { generateFullTxt, pesoMaximoPorLinea } = require('./txtGenerator');
const { verificarTxt, pesosFueraDeRango } = require('./txtVerifier');

const manifest = {
  carrier_code: 'MPRIORO', manifest_no: '3309468', vessel_name: 'KYDON', voyage_no: 'K1326', imo: '8916607',
  departure_date: '2026-08-15', arrival_date: '2026-08-18', docking_number: '20262342',
  loading_port: 'DRP', unloading_port: 'SJU', carrier_ivu: '01406530016',
};
const bl = {
  bl_no: 'PYRR2617593', consignee_name: 'LANCO MANUFACTURING CORP', consignor_name: 'EXPORTADORA DOMINICANA SRL',
  hacienda_client_ss: '660487552', hacienda_client_ivu: '01406530016', hacienda_item_code: '391400',
  hacienda_container_no: 'PRRU2010106', containers: ['PRRU2010106'], containerSizes: { PRRU2010106: '40' },
  containerWeights: { PRRU2010106: 12500.5 }, goods_name: 'PAINT', package_qty: 288, gross_weight: 12500.5, value: 1234.56,
};

test('un TXT bien formado no produce errores', () => {
  assert.deepStrictEqual(verificarTxt(generateFullTxt(manifest, [bl])), []);
});

test('detecta tamaño de contenedor en blanco', () => {
  const txt = generateFullTxt(manifest, [{ ...bl, containerSizes: {} }]);
  const e = verificarTxt(txt);
  assert.ok(e.some(m => /tamaño de contenedor inválido/.test(m)), e.join('|'));
  assert.ok(e.some(m => /PYRR2617593/.test(m) && /PRRU2010106/.test(m)));
});

test('detecta líneas que no miden 205 (campo desplazado)', () => {
  const lineas = generateFullTxt(manifest, [bl]).split('\r\n');
  lineas[1] = lineas[1].slice(0, 203);
  const e = verificarTxt(lineas.join('\r\n'));
  assert.ok(e.some(m => /Línea 2 mide 203/.test(m)));
});

test('detecta peso no numérico y unidad de peso inválida', () => {
  const lineas = generateFullTxt(manifest, [bl]).split('\r\n');
  lineas[2] = lineas[2].substring(0, 28) + 'ABCDEFG' + lineas[2].substring(35, 201) + 'F ' + lineas[2].substring(203);
  const e = verificarTxt(lineas.join('\r\n'));
  assert.ok(e.some(m => /peso no numérico/.test(m)));
  assert.ok(e.some(m => /unidad de peso inválida/.test(m)));
});

test('detecta puerto ilegible', () => {
  const lineas = generateFullTxt(manifest, [bl]).split('\r\n');
  lineas[1] = lineas[1].substring(0, 143) + 'D P' + lineas[1].substring(146);
  assert.ok(verificarTxt(lineas.join('\r\n')).some(m => /puerto de origen inválido/.test(m)));
});

test('un peso por línea mayor a 99,999.99 kg se marca (padZ lo recortaría)', () => {
  const pesado = { ...bl, gross_weight: 123456.78, containerWeights: { PRRU2010106: 123456.78 } };
  assert.strictEqual(pesoMaximoPorLinea(pesado), 123456.78);
  assert.strictEqual(pesosFueraDeRango([pesado], pesoMaximoPorLinea).length, 1);
  assert.strictEqual(pesosFueraDeRango([bl], pesoMaximoPorLinea).length, 0);
});
