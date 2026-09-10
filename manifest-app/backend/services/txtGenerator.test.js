// Tests del generador de TXT Hacienda PR.
// Runner nativo de Node (node:test) — sin dependencias ni build step.
// Ejecutar: npm test   (desde manifest-app/)

const test = require('node:test');
const assert = require('node:assert');
const {
  pad, padZ, sanitizeSS, toSiscommatePort,
  generateTxtLine0, generateTxtLine1, generateTxtLine2, generateFullTxt,
} = require('./txtGenerator');

// ── Datos de ejemplo ─────────────────────────────────────────────────────────
const manifest = {
  carrier_code:   'MPRIORO',
  manifest_no:    '3309468',
  vessel_name:    'KYDON',
  voyage_no:      'K1326',
  imo:            '8916607',
  departure_date: '2026-08-15',
  arrival_date:   '2026-08-18',
  docking_number: '20262342',
  loading_port:   'DRP',
  unloading_port: 'SJU',
  carrier_ivu:    '01406530016',
};

const bl = {
  bl_no:                 'PYRR-2617593',
  consignee_name:        'LANCO MANUFACTURING CORP',
  consignor_name:        'EXPORTADORA DOMINICANA SRL',
  consignee_document_no: '660487552',
  hacienda_client_ss:    '660487552',
  hacienda_client_ivu:   '01406530016',
  hacienda_item_code:    '391400',
  hacienda_tariff:       '045',
  hacienda_container_no: 'PRRU2010106',
  goods_name:            'PACKAGES CONTAINING PAINT',
  package_qty:           288,
  gross_weight:          12500.5,
  value:                 1234.56,
};

// ── Invariante principal: 205 caracteres ─────────────────────────────────────
test('línea 0 mide exactamente 205 caracteres', () => {
  assert.strictEqual(generateTxtLine0(manifest, 3).length, 205);
});

test('línea 1 mide exactamente 205 caracteres', () => {
  assert.strictEqual(generateTxtLine1(bl, manifest, 'PRRU2010106').length, 205);
});

test('línea 2 mide exactamente 205 caracteres', () => {
  assert.strictEqual(generateTxtLine2(bl, 'PRRU2010106', 1, null).length, 205);
});

test('todas las líneas del TXT completo miden 205', () => {
  const blMulti = { ...bl, containers: ['PRRU2010106', 'MSCU1234567'] };
  const txt = generateFullTxt(manifest, [blMulti]);
  const lines = txt.split('\r\n');
  assert.ok(lines.length > 0);
  lines.forEach((l, i) => {
    assert.strictEqual(l.length, 205, `línea ${i} mide ${l.length}, no 205`);
  });
});

test('campos con valores largos se truncan sin desbordar la línea', () => {
  const largo = {
    ...bl,
    bl_no:          'X'.repeat(50),
    consignee_name: 'Y'.repeat(100),
    consignor_name: 'Z'.repeat(200),
    goods_name:     'W'.repeat(500),
  };
  assert.strictEqual(generateTxtLine1(largo, manifest, 'C'.repeat(40)).length, 205);
  assert.strictEqual(generateTxtLine2(largo, 'C'.repeat(40), 1, null).length, 205);
});

// ── Posiciones documentadas ──────────────────────────────────────────────────
test('línea 0 coloca cada campo en su posición documentada', () => {
  const l0 = generateTxtLine0(manifest, 3);
  assert.strictEqual(l0[0], '0',                          'tipo en [0]');
  assert.strictEqual(l0.substring(17, 24), 'MPRIORO',     'carrier en [17:24]');
  assert.strictEqual(l0.substring(25, 32), '3309468',     'manifest_no en [25:32]');
  assert.strictEqual(l0.substring(32, 36), '0003',        'bl_count en [32:36]');
  assert.strictEqual(l0.substring(36, 44), '20260818',    'arrival_date en [36:44]');
  assert.strictEqual(l0.substring(44, 60), pad('KYDON', 16), 'vessel en [44:60]');
  assert.strictEqual(l0.substring(60, 66), pad('K1326', 6),  'voyage en [60:66]');
  assert.strictEqual(l0.substring(66, 74), '20260815',    'departure_date en [66:74]');
  assert.strictEqual(l0.substring(82, 87), 'N1800',       'constante N1800 en [82:87]');
  assert.strictEqual(l0.substring(165, 173), '20262342',  'docking_number en [165:173]');
  assert.strictEqual(l0.substring(174, 181), '8916607',   'IMO en [174:181]');
});

test('línea 1 coloca cada campo en su posición documentada', () => {
  const l1 = generateTxtLine1(bl, manifest, 'PRRU2010106');
  assert.strictEqual(l1[0], '1',                             'tipo en [0]');
  assert.strictEqual(l1.substring(1, 17), pad('PYRR2617593', 16), 'bl_no en [1:17] — sin guión, igual que se guarda en la base');
  assert.strictEqual(l1.substring(17, 19), 'AM',             'AM en [17:19]');
  assert.strictEqual(l1.substring(19, 37), pad('PRRU2010106', 18), 'contenedor en [19:37]');
  assert.strictEqual(l1.substring(37, 67), pad('LANCO MANUFACTURING CORP', 30), 'consignee en [37:67]');
  assert.strictEqual(l1.substring(67, 76), '660487552',      'SS/EIN en [67:76]');
  assert.strictEqual(l1.substring(76, 83), 'C      ',        'tipo C en [76:83]');
  assert.strictEqual(l1.substring(143, 146), 'DRP',          'puerto origen en [143:146]');
  assert.strictEqual(l1.substring(146, 149), 'XSJ',          'puerto descarga en [146:149]');
  assert.strictEqual(l1.substring(186, 190), '045R',         'tarifa+R en [186:190]');
  assert.strictEqual(l1.substring(190, 201), '01406530016',  'IVU en [190:201]');
});

test('línea 2 coloca cada campo en su posición documentada', () => {
  const l2 = generateTxtLine2(bl, 'PRRU2010106', 1, null);
  assert.strictEqual(l2[0], '2',                          'tipo en [0]');
  assert.strictEqual(l2.substring(1, 17), pad('PYRR2617593', 16), 'bl_no en [1:17] — sin guión, igual que se guarda en la base');
  assert.strictEqual(l2.substring(17, 22), '00288',       'cantidad en [17:22]');
  assert.strictEqual(l2.substring(22, 28), 'BOX   ',      'unidad en [22:28]');
  assert.strictEqual(l2.substring(28, 35), '1250050',     'peso ×100 en [28:35]');
  assert.strictEqual(l2.substring(35, 38), '045',         'tarifa en [35:38]');
  assert.strictEqual(l2.substring(38, 159), pad('PACKAGES CONTAINING PAINT', 121), 'descripción en [38:159]');
  assert.strictEqual(l2.substring(159, 164), '00288',     'cantidad repetida en [159:164]');
  assert.strictEqual(l2.substring(164, 179), padZ('391400', 15), 'código Hacienda en [164:179]');
  assert.strictEqual(l2.substring(201, 203), 'KF',        'KF en [201:203]');
});

// ── Reglas de negocio ────────────────────────────────────────────────────────
test('tarifa 040 (libre arancel) fuerza el valor FOB a cero', () => {
  const libre = { ...bl, hacienda_tariff: '040', value: 9999.99 };
  const l1 = generateTxtLine1(libre, manifest, 'PRRU2010106');
  assert.strictEqual(l1.substring(153, 162), '000000000', 'FOB debe ser 0 con tarifa 040');
});

test('tarifa 045 sí incluye el valor FOB en centavos', () => {
  const l1 = generateTxtLine1(bl, manifest, 'PRRU2010106');
  assert.strictEqual(l1.substring(153, 162), '000123456', '1234.56 USD → 123456 centavos');
});

test('sin tarifa, el campo tarifa+R queda en blanco', () => {
  const sinTarifa = { ...bl, hacienda_tariff: '' };
  const l1 = generateTxtLine1(sinTarifa, manifest, 'PRRU2010106');
  assert.strictEqual(l1.substring(186, 190), '    ');
});

test('sin contenedor, la unidad es LSE en vez de BOX', () => {
  const sinCont = { ...bl, hacienda_container_no: '' };
  const l2 = generateTxtLine2(sinCont, '', 1, null);
  assert.strictEqual(l2.substring(22, 28), 'LSE   ');
});

// ── Código empaque (DGA): solo vocabulario real de SISCOMMATE ──────────────
// Con datos reales se confirmó que ~85% de los B/L con este campo lleno
// traían algo que SISCOMMATE no reconoce (palabras genéricas del PDF como
// "PACK"/"UNIT", o códigos internos de la DGA como "IG013" o un "1" suelto)
// y se mandaban tal cual al TXT.
test('un código de empaque válido se manda tal cual (mayúsculas)', () => {
  const conBox = { ...bl, package_unit_code: 'bundle' };
  const l2 = generateTxtLine2(conBox, 'PRRU2010106', 1, null);
  assert.strictEqual(l2.substring(22, 28), 'BUNDLE');
});

test('sinónimos con traducción segura se corrigen al código real', () => {
  const casos = [
    ['pallet',  'PALETS'],
    ['VEHICLE', 'AUTO  '],
    ['Drum',    'DRUMS '],
    ['carton',  'BOX   '],
  ];
  casos.forEach(([entrada, esperado]) => {
    const conEmpaque = { ...bl, package_unit_code: entrada };
    const l2 = generateTxtLine2(conEmpaque, 'PRRU2010106', 1, null);
    assert.strictEqual(l2.substring(22, 28), esperado, `"${entrada}" debería dar "${esperado}"`);
  });
});

test('un código no reconocido no se manda — cae al respaldo BOX/LSE', () => {
  const casosConContenedor = ['PACK', 'UNIT', 'PKG', 'bags', 'case', 'rolls', 'container', '1', 'IG013', 'IG001'];
  casosConContenedor.forEach(valor => {
    const conEmpaque = { ...bl, package_unit_code: valor };
    const l2 = generateTxtLine2(conEmpaque, 'PRRU2010106', 1, null);
    assert.strictEqual(l2.substring(22, 28), 'BOX   ', `"${valor}" con contenedor debería caer a BOX`);
  });
  const sinContenedor = { ...bl, hacienda_container_no: '', package_unit_code: 'IG013' };
  const l2b = generateTxtLine2(sinContenedor, '', 1, null);
  assert.strictEqual(l2b.substring(22, 28), 'LSE   ', 'sin contenedor debería caer a LSE');
});

test('el IVU del carrier se usa cuando el consignatario no tiene', () => {
  const sinIvu = { ...bl, hacienda_client_ivu: '' };
  const l1 = generateTxtLine1(sinIvu, manifest, 'PRRU2010106');
  assert.strictEqual(l1.substring(190, 201), '01406530016', 'debe caer al IVU del carrier');
});

test('con varios contenedores el peso se reparte entre ellos', () => {
  const l2 = generateTxtLine2(bl, 'PRRU2010106', 2, null);
  // 12500.5 / 2 = 6250.25 → ×100 = 625025
  assert.strictEqual(l2.substring(28, 35), '0625025');
});

test('un cargo item no reparte el peso: usa el suyo tal cual', () => {
  const item = { goods_name: 'CAJAS DE HERRAMIENTAS', gross_weight: 300, hacienda_item_code: '820000', hacienda_tariff: '045', package_qty: 10 };
  const l2 = generateTxtLine2(bl, 'PRRU2010106', 2, item);
  assert.strictEqual(l2.substring(28, 35), '0030000', 'peso del item sin dividir');
  assert.strictEqual(l2.substring(38, 159), pad('CAJAS DE HERRAMIENTAS', 121), 'descripción del item');
  assert.strictEqual(l2.substring(164, 179), padZ('820000', 15), 'código del item');
});

// ── Números que llegan como texto o como número ──────────────────────────────
// El frontend manda los inputs numéricos como string; SQLite los devuelve como
// número. Ambos caminos deben producir exactamente el mismo TXT.
test('el peso da igual venga como texto o como número', () => {
  const comoTexto  = { ...bl, gross_weight: '12500.50' };
  const comoNumero = { ...bl, gross_weight: 12500.5 };
  assert.strictEqual(
    generateTxtLine2(comoTexto,  'PRRU2010106', 1, null),
    generateTxtLine2(comoNumero, 'PRRU2010106', 1, null)
  );
  assert.strictEqual(generateTxtLine2(comoTexto, 'PRRU2010106', 1, null).substring(28, 35), '1250050');
});

test('el valor FOB da igual venga como texto o como número', () => {
  const comoTexto  = { ...bl, value: '1234.56' };
  const comoNumero = { ...bl, value: 1234.56 };
  assert.strictEqual(
    generateTxtLine1(comoTexto,  manifest, 'PRRU2010106'),
    generateTxtLine1(comoNumero, manifest, 'PRRU2010106')
  );
  assert.strictEqual(generateTxtLine1(comoTexto, manifest, 'PRRU2010106').substring(153, 162), '000123456');
});

test('un valor vacío o basura cuenta como cero, no rompe la línea', () => {
  for (const malo of ['', null, undefined, 'abc', NaN]) {
    const roto = { ...bl, gross_weight: malo, value: malo, hacienda_tariff: '045' };
    const l1 = generateTxtLine1(roto, manifest, 'PRRU2010106');
    const l2 = generateTxtLine2(roto, 'PRRU2010106', 1, null);
    assert.strictEqual(l1.length, 205, `línea 1 con ${String(malo)}`);
    assert.strictEqual(l2.length, 205, `línea 2 con ${String(malo)}`);
    assert.strictEqual(l1.substring(153, 162), '000000000', `FOB con ${String(malo)}`);
    assert.strictEqual(l2.substring(28, 35),   '0000000',   `peso con ${String(malo)}`);
  }
});

// ── sanitizeSS ───────────────────────────────────────────────────────────────
test('sanitizeSS rellena con ceros a la izquierda preservando el EIN', () => {
  assert.strictEqual(sanitizeSS('12345'), '000012345');
  assert.strictEqual(sanitizeSS('660487552'), '660487552');
});

test('sanitizeSS limpia guiones y símbolos', () => {
  assert.strictEqual(sanitizeSS('66-048-7552'), '660487552');
});

test('sanitizeSS sin dígitos devuelve nueve ceros', () => {
  assert.strictEqual(sanitizeSS(''), '000000000');
  assert.strictEqual(sanitizeSS(null), '000000000');
  assert.strictEqual(sanitizeSS('ABC'), '000000000');
});

test('sanitizeSS con más de 9 dígitos conserva los últimos 9', () => {
  assert.strictEqual(sanitizeSS('99660487552').length, 9);
  assert.strictEqual(sanitizeSS('99660487552'), '660487552');
});

// ── toSiscommatePort ─────────────────────────────────────────────────────────
test('toSiscommatePort traduce los puertos conocidos', () => {
  assert.strictEqual(toSiscommatePort('SJU'), 'XSJ');
  assert.strictEqual(toSiscommatePort('PRSJU'), 'XSJ');
  assert.strictEqual(toSiscommatePort('SDQ'), 'DRP');
  assert.strictEqual(toSiscommatePort('CRX'), 'STX');
  assert.strictEqual(toSiscommatePort('sju'), 'XSJ', 'debe ser case-insensitive');
});

test('toSiscommatePort recorta a 3 caracteres los puertos desconocidos', () => {
  assert.strictEqual(toSiscommatePort('ZZZZZ'), 'ZZZ');
});

test('toSiscommatePort sin código asume San Juan', () => {
  assert.strictEqual(toSiscommatePort(''), 'XSJ');
  assert.strictEqual(toSiscommatePort(null), 'XSJ');
});

// ── TXT completo ─────────────────────────────────────────────────────────────
test('cada contenedor del B/L genera su propio par línea1 + línea2', () => {
  const blMulti = { ...bl, containers: ['PRRU2010106', 'MSCU1234567'] };
  const lines = generateFullTxt(manifest, [blMulti]).split('\r\n');
  assert.strictEqual(lines.length, 5, '1 encabezado + 2 pares');
  assert.strictEqual(lines[0][0], '0');
  assert.strictEqual(lines[1][0], '1');
  assert.strictEqual(lines[2][0], '2');
  assert.strictEqual(lines[3][0], '1');
  assert.strictEqual(lines[4][0], '2');
  assert.strictEqual(lines[1].substring(19, 37), pad('PRRU2010106', 18));
  assert.strictEqual(lines[3].substring(19, 37), pad('MSCU1234567', 18));
});

test('el conteo del encabezado cuenta pares B/L-contenedor, no B/L', () => {
  const a = { ...bl, containers: ['C1', 'C2'] };
  const b = { ...bl, bl_no: 'PYRR-999', containers: ['C3'] };
  const lines = generateFullTxt(manifest, [a, b]).split('\r\n');
  assert.strictEqual(lines[0].substring(32, 36), '0003', '2 + 1 = 3 pares');
});

test('el TXT usa CRLF como separador de línea', () => {
  const txt = generateFullTxt(manifest, [bl]);
  assert.ok(txt.includes('\r\n'), 'debe separar con CRLF');
});

// ── Acentos: el TXT es de ancho fijo por BYTE, no por carácter ──────────────
// Una letra acentuada ocupa 2 bytes en UTF-8 — sin quitarla, corre 1 posición
// todo lo que sigue en la línea aunque la longitud en caracteres JS dé bien.
test('nombre de consignatario/consignador con acentos no rompe el ancho fijo', () => {
  const conAcentos = { ...bl, consignee_name: 'COMPAÑÍA MUÑOZ, S.A.', consignor_name: 'ALMACÉN CAÑAS' };
  const l1 = generateTxtLine1(conAcentos, manifest, 'PRRU2010106');
  assert.strictEqual(l1.length, 205);
  assert.strictEqual(Buffer.byteLength(l1, 'utf8'), 205, 'en bytes UTF-8 también debe medir 205');
  assert.strictEqual(l1.substring(37, 67), pad('COMPANIA MUNOZ, S.A.', 30), 'quita acentos, conserva puntuación');
  assert.strictEqual(l1.substring(83, 143), pad('ALMACEN CANAS', 60));
});

test('descripción de mercancía con acentos no rompe el ancho fijo', () => {
  const conAcentos = { ...bl, goods_name: 'CONTIENE: PAÑALES Y ALMOHADAS PEQUEÑAS' };
  const l2 = generateTxtLine2(conAcentos, 'PRRU2010106', 1, null);
  assert.strictEqual(l2.length, 205);
  assert.strictEqual(Buffer.byteLength(l2, 'utf8'), 205);
});

test('nombre del buque con acentos no rompe el ancho fijo', () => {
  const conAcentos = { ...manifest, vessel_name: 'NIÑO DE ÁVILA' };
  const l0 = generateTxtLine0(conAcentos, 1);
  assert.strictEqual(l0.length, 205);
  assert.strictEqual(Buffer.byteLength(l0, 'utf8'), 205);
});

test('comillas curvas de un PDF (8" copiado como comilla) no rompen el ancho fijo', () => {
  // Caso real: "JAR CANDLES 8” QUALITY..." — la comilla curva (U+201D) mide
  // 3 bytes en UTF-8, no 1, y desalineaba el resto de la línea sin avisar.
  const conComillas = { ...bl, goods_name: 'JAR CANDLES 8” QUALITY 12/1 — VARIOS COLORS' };
  const l2 = generateTxtLine2(conComillas, 'PRRU2010106', 1, null);
  assert.strictEqual(l2.length, 205);
  assert.strictEqual(Buffer.byteLength(l2, 'utf8'), 205);
});

test('un símbolo no previsto se quita en vez de desalinear la línea', () => {
  const raro = { ...bl, consignee_name: 'CAFÉ ★ EXPRESS' };
  const l1 = generateTxtLine1(raro, manifest, 'PRRU2010106');
  assert.strictEqual(l1.length, 205);
  assert.strictEqual(Buffer.byteLength(l1, 'utf8'), 205);
});
