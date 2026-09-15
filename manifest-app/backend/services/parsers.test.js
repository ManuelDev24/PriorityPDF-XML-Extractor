// Tests de los parsers de manifiestos — cubre LOS DOS TIPOS DE PDF y el XML.
// Ejecutar: npm test   (desde manifest-app/)

const test = require('node:test');
const assert = require('node:assert');

const { parseXmlManifest } = require('./xmlParser');
const {
  normalizePdfDate, parsePdfNum, isIsoContainer, normContainerNo,
  isPhoneNumber, parsePdfParty, isCustoms1302, parseCustoms1302, parseGenericDga,
} = require('./pdfParser');

// ═══════════════════════════════════════════════════════════════════
// TIPO 1 — US Customs 1302 (Priority RORO)
// ═══════════════════════════════════════════════════════════════════
const TEXTO_1302 = [
  'Page 1/1',
  '12,500.50',
  '27,557.00',
  '1.- Name of Ship',
  'KYDON                    K1326',
  'Puerto de carga',
  'SANTO DOMINGO (DRP)',
  'Puerto de Descarga',
  'SAN JUAN (XSJ)',
  'BL Numbers',
  '',
  'EXPORTADORA DOMINICANA SRL RNC: 130862154',
  'CALLE PRIMERA #45',
  '10101 - SANTO DOMINGO (DO - REP DOMINICANA)',
  '',
  'LANCO MANUFACTURING CORP TAX ID: 660487552',
  'URB APONTE 5',
  '00907 - SAN JUAN (PR - PUERTO RICO)',
  '',
  'NOTIFY PARTY INC',
  'PO BOX 100',
  '00907 - SAN JUAN (PR - PUERTO RICO)',
  'PYRR-2617593 PRRU 201010-6',
  "40' CONT",
  '288 carton:',
  'PACKAGES CONTAINING PAINT',
  'KG',
].join('\n');

test('1302: se detecta como formato US Customs 1302', () => {
  assert.strictEqual(isCustoms1302(TEXTO_1302), true);
});

test('1302: extrae buque, viaje y puertos del encabezado', () => {
  const r = parseCustoms1302(TEXTO_1302);
  assert.strictEqual(r.header.vessel_name, 'KYDON');
  assert.strictEqual(r.header.voyage_no, 'K1326');
  assert.strictEqual(r.header.manifest_no, 'K1326');
  assert.strictEqual(r.header.loading_port, 'DRP');
  assert.strictEqual(r.header.unloading_port, 'XSJ');
  assert.strictEqual(r.header.carrier_code, 'MPRIORO');
});

test('1302: extrae el B/L con cantidad, descripción y peso de la página', () => {
  const r = parseCustoms1302(TEXTO_1302);
  assert.strictEqual(r.bls.length, 1);
  const bl = r.bls[0];
  assert.strictEqual(bl.bl_no, 'PYRR2617593', 'el PDF imprime el guión pero se guarda sin él, igual que el XML de la DGA');
  assert.strictEqual(bl.package_qty, 288);
  assert.strictEqual(bl.package_unit_code, 'carton');
  assert.strictEqual(bl.goods_name, 'PACKAGES CONTAINING PAINT');
  assert.strictEqual(bl.gross_weight, 12500.5, 'toma el KG del par KG/LBS de la página');
});

test('1302: normaliza el número de contenedor partido', () => {
  const r = parseCustoms1302(TEXTO_1302);
  assert.strictEqual(r.containers.length, 1);
  assert.strictEqual(r.containers[0].container_no, 'PRRU2010106', '"PRRU 201010-6" → "PRRU2010106"');
  assert.strictEqual(r.containers[0].size, '40');
  assert.strictEqual(r.containers[0].container_type, 'R');
  assert.deepStrictEqual(r.containerBLs[0], { bl_no: 'PYRR2617593', container_no: 'PRRU2010106' });
});

test('1302: asigna shipper, consignee y notify en el orden correcto', () => {
  const r = parseCustoms1302(TEXTO_1302);
  const bl = r.bls[0];
  assert.strictEqual(bl.consignor_name, 'EXPORTADORA DOMINICANA SRL', 'shipper');
  assert.strictEqual(bl.consignor_document_no, '130862154');
  assert.strictEqual(bl.consignor_document_type, 'RNC');
  assert.strictEqual(bl.consignee_name, 'LANCO MANUFACTURING CORP', 'consignee');
  assert.strictEqual(bl.consignee_document_no, '660487552');
  assert.strictEqual(bl.consignee_document_type, 'EIN');
  assert.strictEqual(bl.notify_name, 'NOTIFY PARTY INC', 'notify');
});

test('1302: el EIN del consignatario alimenta hacienda_client_ss', () => {
  const r = parseCustoms1302(TEXTO_1302);
  assert.strictEqual(r.bls[0].hacienda_client_ss, '660487552');
});

test('1302: genera un cargo item por entrada', () => {
  const r = parseCustoms1302(TEXTO_1302);
  assert.strictEqual(r.cargoItems.length, 1);
  assert.strictEqual(r.cargoItems[0].bl_no, 'PYRR2617593');
  assert.strictEqual(r.cargoItems[0].container_no, 'PRRU2010106');
  assert.strictEqual(r.cargoItems[0].gross_weight, 12500.5);
});

test('1302: un vehículo se reconoce por VIN y no genera contenedor', () => {
  const texto = TEXTO_1302
    .replace('PYRR-2617593 PRRU 201010-6', 'PYRR-2617594 1HGCM82633A004352')
    .replace("40' CONT", 'VEHICLE');
  const r = parseCustoms1302(texto);
  assert.strictEqual(r.bls.length, 1);
  assert.strictEqual(r.containers.length, 0, 'un vehículo no crea contenedor');
  assert.ok(r.cargoItems[0].goods_name.startsWith('[VIN: 1HGCM82633A004352]'), 'el VIN queda en la descripción');
  assert.strictEqual(r.bls[0].hacienda_container_no, '1HGCM82633A004352');
});

test('1302: el mismo B/L en dos contenedores consolida pesos y cantidades', () => {
  const texto = [
    'Page 1/1',
    '1,000.00', '2,204.00',
    '500.00', '1,102.00',
    '1.- Name of Ship',
    'KYDON                    K1327',
    'BL Numbers',
    '',
    'SHIPPER UNO',
    'CALLE X',
    '',
    'CONSIGNEE UNO',
    'CALLE Y',
    '',
    'NOTIFY UNO',
    'CALLE Z',
    'PYRR-1111111 PRRU 100000-1',
    "40' CONT",
    '10 carton:',
    'MERCANCIA A',
    'KG',
    '',
    'SHIPPER UNO',
    'CALLE X',
    '',
    'CONSIGNEE UNO',
    'CALLE Y',
    '',
    'NOTIFY UNO',
    'CALLE Z',
    'PYRR-1111111 PRRU 200000-2',
    "20' CONT",
    '5 carton:',
    'MERCANCIA B',
    'KG',
  ].join('\n');
  const r = parseCustoms1302(texto);
  assert.strictEqual(r.bls.length, 1, 'un solo B/L consolidado');
  assert.strictEqual(r.bls[0].gross_weight, 1500, '1000 + 500');
  assert.strictEqual(r.bls[0].package_qty, 15, '10 + 5');
  assert.strictEqual(r.containers.length, 2, 'dos contenedores distintos');
  assert.strictEqual(r.cargoItems.length, 2, 'un item por contenedor');
});

test('1302: contenedor sin B/L al inicio de línea (celda fusionada) se reconecta con el último B/L', () => {
  // Caso real: un B/L con varios contenedores donde el PDF original fusiona
  // visualmente la celda del B/L para las filas extra — el texto extraído
  // no repite "PYRR-1234567" en esas filas, solo el contenedor (ver CF365:
  // PYRR-2631003 con PRRU 350178-1 y, en una fila huérfana, PRRU 433387-5).
  const texto = [
    'Page 1/1',
    '1,000.00', '2,204.00',
    '500.00', '1,102.00',
    '1.- Name of Ship',
    'KYDON                    K1327',
    'BL Numbers',
    '',
    'SHIPPER UNO',
    'CALLE X',
    '',
    'CONSIGNEE UNO',
    'CALLE Y',
    '',
    'NOTIFY UNO',
    'CALLE Z',
    'PYRR-2631003 PRRU 350178-1',
    "40' FR",
    'N/A',
    '17 rolls:',
    'REBAR IN COIL',
    'KG',
    'PRRU 433387-5',
    "40' FR",
    'N/A',
    '17 rolls:',
    'REBAR IN COIL',
    'KG',
  ].join('\n');
  const r = parseCustoms1302(texto);
  assert.strictEqual(r.bls.length, 1, 'ambos contenedores pertenecen al mismo B/L');
  assert.strictEqual(r.bls[0].bl_no, 'PYRR2631003');
  assert.strictEqual(r.containers.length, 2, 'no se pierde el segundo contenedor');
  assert.deepStrictEqual(
    r.containers.map(c => c.container_no).sort(),
    ['PRRU3501781', 'PRRU4333875'].sort()
  );
  assert.strictEqual(r.bls[0].gross_weight, 1500, 'se suma el peso de ambos contenedores, no se pierde el segundo');
  assert.strictEqual(r.cargoItems.length, 2, 'un cargo item por contenedor, incluido el huérfano');
});

test('1302: un par KG/LBS partido justo en el salto de página no desalinea el peso del B/L siguiente', () => {
  // Bug real (K1338, PYRR-2630003 / PYRR-2630487): cuando el KG de una fila
  // cae al final de una página y su LBS queda al inicio de la siguiente, el
  // conteo de peso reiniciaba por página — la cantidad de números "sobrante"
  // en la página anterior (aquí, un solo número: el KG sin su LBS) hacía que
  // la página siguiente empezara a contar desde su LBS "huérfano" como si
  // fuera el KG de una fila nueva, corriendo el peso de TODOS los B/L de esa
  // página en adelante.
  const pagina1 = [
    '1,000.00', // KG de PYRR-3000001 — su LBS queda en la página 2
    '1.- Name of Ship',
    'KYDON                    K1330',
    'BL Numbers',
    '',
    'SHIPPER UNO',
    'CALLE X',
    '',
    'CONSIGNEE UNO',
    'CALLE Y',
    '',
    'NOTIFY UNO',
    'CALLE Z',
    'PYRR-3000001 PRRU 111111-1',
    "40' CONT",
    'N/A',
    '10 carton:',
    'ALGO',
    'KG',
  ].join('\n');
  const pagina2 = [
    '2,204.00', // LBS "huérfano" de PYRR-3000001 (empieza la página 2)
    '500.00',   // KG de PYRR-3000002
    '1,102.00', // LBS de PYRR-3000002
    '1.- Name of Ship',
    'KYDON                    K1330',
    'BL Numbers',
    '',
    'SHIPPER DOS',
    'CALLE A',
    '',
    'CONSIGNEE DOS',
    'CALLE B',
    '',
    'NOTIFY DOS',
    'CALLE C',
    'PYRR-3000002 PRRU 222222-2',
    "40' CONT",
    'N/A',
    '5 carton:',
    'OTRA COSA',
    'KG',
  ].join('\n');
  const texto = `Page 1/2\n${pagina1}\nPage 2/2\n${pagina2}`;
  const r = parseCustoms1302(texto);
  const bl1 = r.bls.find(b => b.bl_no === 'PYRR3000001');
  const bl2 = r.bls.find(b => b.bl_no === 'PYRR3000002');
  assert.strictEqual(bl1.gross_weight, 1000, 'el KG de la fila 1 no lo pisa el LBS huérfano de la página 2');
  assert.strictEqual(bl2.gross_weight, 500, 'la fila 2 recibe su propio KG, no el LBS huérfano de la fila 1');
});

test('1302: un contenedor huérfano precedido de un bloque de dirección completo NO se reconecta al B/L anterior', () => {
  // Bug real (K1338): "MXRU 485642-8" aparecía sin ningún "PYRR-XXXXXXX"
  // junto, pero justo antes terminaba un bloque de shipper/consignee/notify
  // COMPLETO de una fila distinta — a diferencia de la celda fusionada real
  // (mismo B/L, mismo shipper, sin bloque de dirección de por medio), esto
  // es una fila nueva cuyo propio B/L se perdió en la extracción, no una
  // continuación. Reconectarlo con el B/L anterior le robaba el peso al
  // B/L que sigue (ver test de arriba) porque ese contenedor no tiene peso
  // propio en el PDF.
  const texto = [
    'Page 1/1',
    '1,000.00', '2,204.00',
    '1.- Name of Ship',
    'KYDON                    K1331',
    'BL Numbers',
    '',
    'SHIPPER UNO',
    'CALLE X',
    '00907 - SAN JUAN (PR - PUERTO RICO)',
    '',
    'CONSIGNEE UNO',
    'CALLE Y',
    '00907 - SAN JUAN (PR - PUERTO RICO)',
    '',
    'NOTIFY UNO',
    'CALLE Z',
    '00907 - SAN JUAN (PR - PUERTO RICO)',
    'PYRR-3000010 PRRU 350178-1',
    "40' FR",
    'N/A',
    '17 rolls:',
    'REBAR IN COIL',
    'KG',
    '',
    'SHIPPER OTRO ENVIO',
    'OTRA CALLE',
    '00726 - CAGUAS (PR - PUERTO RICO)',
    '',
    'CONSIGNEE OTRO ENVIO',
    'OTRA CALLE 2',
    '00726 - CAGUAS (PR - PUERTO RICO)',
    '',
    'NOTIFY OTRO ENVIO',
    'OTRA CALLE 3',
    '00726 - CAGUAS (PR - PUERTO RICO)',
    'MXRU 485642-8',
    "45' CONT",
    '159 pack:',
    'PACKAGES CONTAINING MODULAR KITCHEN',
    'LBS',
  ].join('\n');
  const r = parseCustoms1302(texto);
  assert.strictEqual(r.bls.length, 1, 'solo se reconoce el B/L real — el contenedor sin B/L propio no crea ni se pega a otro');
  assert.strictEqual(r.containers.length, 1, 'MXRU485642-8 no se cuela como contenedor de PYRR-3000010');
  assert.strictEqual(r.containers[0].container_no, 'PRRU3501781');
  assert.strictEqual(r.bls[0].gross_weight, 1000, 'el peso de PYRR-3000010 no se corre ni se mezcla con el envío perdido');
});

test('1302: una línea huérfana sin B/L previo ni forma de contenedor se ignora sin romper', () => {
  const texto = [
    'Page 1/1',
    '1,000.00', '2,204.00',
    '1.- Name of Ship',
    'KYDON                    K1328',
    'BL Numbers',
    'RANDOM TEXT THAT LOOKS LIKE NOTHING',
    'PYRR-2631010 PRRU 999999-9',
    "40' CONT",
    '10 carton:',
    'ALGO',
    'KG',
  ].join('\n');
  const r = parseCustoms1302(texto);
  assert.strictEqual(r.bls.length, 1);
  assert.strictEqual(r.bls[0].bl_no, 'PYRR2631010');
});

// ═══════════════════════════════════════════════════════════════════
// TIPO 2 — PDF genérico de la DGA
// ═══════════════════════════════════════════════════════════════════
const TEXTO_DGA = [
  'MANIFIESTO DE CARGA',
  'Viaje No: V-2026-045',
  'Buque: CARIBBEAN FORCE',
  'Puerto de Carga: DRP',
  'Puerto de Descarga: XSJ',
  'Fecha de Salida: 15/08/2026',
  'Fecha de Llegada: 18/08/2026',
  '',
  'B/L No: PRIO2026001',
  'Consignatario: FERRETERIA LA NACIONAL',
  'Embarcador: METALES DEL CARIBE SRL',
  'Descripcion de la Mercancia: TUBOS DE ACERO GALVANIZADO',
  'Bultos: 150',
  'Peso Bruto (kg): 8,432.75',
  'Valor FOB: 12,500.00',
  'Contenedor MSCU1234567',
  '',
  'B/L No: PRIO2026002',
  'Consignatario: DISTRIBUIDORA CENTRAL',
  'Embarcador: PLASTICOS ANTILLANOS',
  'Descripcion de la Mercancia: ENVASES PLASTICOS',
  'Bultos: 80',
  'Peso Bruto (kg): 1.234,50',
  'Valor FOB: 3,200.00',
].join('\n');

test('DGA genérico: NO se confunde con el formato 1302', () => {
  assert.strictEqual(isCustoms1302(TEXTO_DGA), false);
});

test('DGA genérico: extrae el encabezado del viaje', () => {
  const r = parseGenericDga(TEXTO_DGA);
  assert.strictEqual(r.header.voyage_no, 'V-2026-045');
  assert.strictEqual(r.header.loading_port, 'DRP');
  assert.strictEqual(r.header.unloading_port, 'XSJ');
  assert.strictEqual(r.header.departure_date, '2026-08-15', 'DD/MM/YYYY → YYYY-MM-DD');
  assert.strictEqual(r.header.arrival_date, '2026-08-18');
});

test('DGA genérico: extrae los dos B/L con sus datos', () => {
  const r = parseGenericDga(TEXTO_DGA);
  assert.strictEqual(r.bls.length, 2);

  const a = r.bls[0];
  assert.strictEqual(a.bl_no, 'PRIO2026001');
  assert.strictEqual(a.consignee_name, 'FERRETERIA LA NACIONAL');
  assert.strictEqual(a.consignor_name, 'METALES DEL CARIBE SRL');
  assert.strictEqual(a.goods_name, 'TUBOS DE ACERO GALVANIZADO');
  assert.strictEqual(a.package_qty, 150);
  assert.strictEqual(a.gross_weight, 8432.75, 'formato 8,432.75');
  assert.strictEqual(a.value, 12500);

  const b = r.bls[1];
  assert.strictEqual(b.bl_no, 'PRIO2026002');
  assert.strictEqual(b.gross_weight, 1234.5, 'formato europeo 1.234,50');
});

test('DGA genérico: detecta contenedores ISO 6346 sin confundirlos con el B/L', () => {
  const r = parseGenericDga(TEXTO_DGA);
  assert.strictEqual(r.containers.length, 1);
  assert.strictEqual(r.containers[0].container_no, 'MSCU1234567');
  assert.ok(!r.containers.some(c => c.container_no === 'PRIO2026001'),
    'PRIO2026001 es un B/L, no un contenedor (4ta letra debe ser U/J/Z)');
});

test('DGA genérico: un PDF sin B/L reconocibles lanza error explicativo', () => {
  assert.throws(
    () => parseGenericDga('Documento cualquiera sin estructura de manifiesto'),
    /No se encontraron B\/L en el PDF/
  );
});

// ═══════════════════════════════════════════════════════════════════
// Helpers compartidos
// ═══════════════════════════════════════════════════════════════════
test('normalizePdfDate acepta los formatos usuales', () => {
  assert.strictEqual(normalizePdfDate('2026-08-15'), '2026-08-15');
  assert.strictEqual(normalizePdfDate('15/08/2026'), '2026-08-15');
  assert.strictEqual(normalizePdfDate('15-08-2026'), '2026-08-15');
  assert.strictEqual(normalizePdfDate('5/8/26'), '2026-08-05', 'año de 2 dígitos y sin ceros');
  assert.strictEqual(normalizePdfDate('texto'), '');
  assert.strictEqual(normalizePdfDate(''), '');
});

test('parsePdfNum entiende separadores de miles americanos y europeos', () => {
  assert.strictEqual(parsePdfNum('1,234.56'), 1234.56);
  assert.strictEqual(parsePdfNum('1.234,56'), 1234.56);
  assert.strictEqual(parsePdfNum('123,45'), 123.45, 'solo coma decimal');
  assert.strictEqual(parsePdfNum('1,234'), 1234, 'solo coma de miles');
  assert.strictEqual(parsePdfNum('8432.75'), 8432.75);
  assert.strictEqual(parsePdfNum(''), 0);
  assert.strictEqual(parsePdfNum('abc'), 0);
});

test('isIsoContainer distingue contenedores de números de B/L', () => {
  assert.strictEqual(isIsoContainer('MSCU1234567'), true);
  assert.strictEqual(isIsoContainer('PRRU2010106'), true, 'prefijo conocido de Priority');
  assert.strictEqual(isIsoContainer('PRIO2026001'), false, '4ta letra no es U/J/Z');
});

test('normContainerNo une el número partido del PDF', () => {
  assert.strictEqual(normContainerNo('PRRU 201010-6'), 'PRRU2010106');
  assert.strictEqual(normContainerNo('MSCU 123456'), 'MSCU123456');
  assert.strictEqual(normContainerNo(''), '');
});

test('isPhoneNumber reconoce teléfonos y descarta direcciones', () => {
  assert.strictEqual(isPhoneNumber('787-831-1700'), true);
  assert.strictEqual(isPhoneNumber('(809) 555 1234'), true);
  assert.strictEqual(isPhoneNumber('Tel: 809-555-1234'), true);
  assert.strictEqual(isPhoneNumber('CALLE PRIMERA #45'), false);
  assert.strictEqual(isPhoneNumber('123'), false, 'muy corto');
});

test('parsePdfParty separa nombre, documento, dirección, ciudad y zip', () => {
  const p = parsePdfParty([
    'LANCO MANUFACTURING CORP TAX ID: 660487552',
    'URB APONTE 5',
    '00907 - SAN JUAN (PR - PUERTO RICO)',
    '787-831-1700',
    'ventas@lanco.com',
  ]);
  assert.strictEqual(p.name, 'LANCO MANUFACTURING CORP');
  assert.strictEqual(p.document_no, '660487552');
  assert.strictEqual(p.document_type, 'EIN');
  assert.strictEqual(p.street, 'URB APONTE 5');
  assert.strictEqual(p.city, 'SAN JUAN');
  assert.strictEqual(p.zip, '00907');
  assert.strictEqual(p.tel, '787-831-1700');
  assert.strictEqual(p.email, 'ventas@lanco.com');
});

test('parsePdfParty une la ciudad partida entre paréntesis', () => {
  const p = parsePdfParty([
    'CLIENTE USVI',
    '4837 - KINGSHILL (UNITED STATES VIRGIN',
    'ISLANDS)',
  ]);
  assert.strictEqual(p.zip, '4837');
  assert.strictEqual(p.city, 'KINGSHILL');
});

test('parsePdfParty con bloque vacío devuelve campos vacíos, no undefined', () => {
  const p = parsePdfParty(null);
  assert.strictEqual(p.name, '');
  assert.strictEqual(p.document_no, '');
});

// ═══════════════════════════════════════════════════════════════════
// XML de la DGA
// ═══════════════════════════════════════════════════════════════════
const XML_DGA = `<?xml version="1.0" encoding="UTF-8"?>
<ExportManifest>
  <Manifest>
    <VoyageNo>K1326</VoyageNo>
    <VesselCode>KYDON</VesselCode>
    <BizCompanyCode>PRIORITY</BizCompanyCode>
    <LoadingLocationCode>DOSDQ</LoadingLocationCode>
    <UnloadingLocationCode>PRSJU</UnloadingLocationCode>
    <DepartureDate>2026-08-15</DepartureDate>
    <ArrivalDate>2026-08-18</ArrivalDate>
    <ManifestBL>
      <BLNo>PYRR-2617593</BLNo>
      <GoodsName>PINTURA
      EN LATAS</GoodsName>
      <PackageQty>288</PackageQty>
      <GrossWeight>12500.50</GrossWeight>
      <Value>1234.56</Value>
      <PackageUnitCode>CT</PackageUnitCode>
      <ConsignorName>METALES &amp;amp; ACEROS SRL</ConsignorName>
      <ConsignorDocumentNo>130862154</ConsignorDocumentNo>
      <ConsigneeName>LANCO MANUFACTURING</ConsigneeName>
      <ConsigneeDocumentNo>660487552</ConsigneeDocumentNo>
    </ManifestBL>
    <ManifestContainer>
      <ContainerNo>PRRU2010106</ContainerNo>
      <ContainerType>5</ContainerType>
      <Amount>288</Amount>
      <GrossWeight>12500.50</GrossWeight>
    </ManifestContainer>
    <ContainerBL>
      <BLNo>PYRR-2617593</BLNo>
      <ContainerNo>PRRU2010106</ContainerNo>
    </ContainerBL>
  </Manifest>
</ExportManifest>`;

test('XML: extrae el encabezado del manifiesto', async () => {
  const r = await parseXmlManifest(XML_DGA);
  assert.strictEqual(r.header.voyage_no, 'K1326');
  assert.strictEqual(r.header.vessel_code, 'KYDON');
  assert.strictEqual(r.header.loading_port, 'DOSDQ');
  assert.strictEqual(r.header.unloading_port, 'PRSJU');
  assert.strictEqual(r.header.departure_date, '2026-08-15');
});

test('XML: extrae el B/L con tipos numéricos correctos', async () => {
  const r = await parseXmlManifest(XML_DGA);
  assert.strictEqual(r.bls.length, 1);
  const bl = r.bls[0];
  assert.strictEqual(bl.bl_no, 'PYRR-2617593');
  assert.strictEqual(bl.package_qty, 288);
  assert.strictEqual(bl.gross_weight, 12500.5);
  assert.strictEqual(bl.value, 1234.56);
  assert.strictEqual(bl.consignee_document_no, '660487552');
});

test('XML: limpia saltos de línea de la descripción y decodifica &amp;', async () => {
  const r = await parseXmlManifest(XML_DGA);
  assert.ok(!r.bls[0].goods_name.includes('\n'), 'sin saltos de línea');
  assert.strictEqual(r.bls[0].consignor_name, 'METALES & ACEROS SRL');
});

// COMPORTAMIENTO ACTUAL DOCUMENTADO (no es lo ideal, pero se respeta tal cual
// para no alterar la salida del TXT durante la refactorización):
// el parser colapsa \r\n\t a un espacio, pero NO colapsa los espacios de
// indentación que quedan después del salto. Una descripción partida en varias
// líneas del XML llega con espacios de más, que consumen caracteres del campo
// de 121 posiciones del TXT. Ver nota en el spec para decidir si se normaliza.
test('XML: la indentación del XML deja espacios múltiples en la descripción', async () => {
  const r = await parseXmlManifest(XML_DGA);
  assert.strictEqual(r.bls[0].goods_name, 'PINTURA       EN LATAS');
  assert.ok(/\s{2,}/.test(r.bls[0].goods_name), 'hoy quedan espacios múltiples');
});

test('XML: extrae contenedores y su vínculo con el B/L', async () => {
  const r = await parseXmlManifest(XML_DGA);
  assert.strictEqual(r.containers.length, 1);
  assert.strictEqual(r.containers[0].container_no, 'PRRU2010106');
  assert.strictEqual(r.containers[0].xml_container_type, '5', 'se conserva para mapear el tamaño');
  assert.deepStrictEqual(r.containerBLs[0], { bl_no: 'PYRR-2617593', container_no: 'PRRU2010106' });
});

test('XML: un manifiesto sin B/L no rompe el parser', async () => {
  const r = await parseXmlManifest('<ExportManifest><Manifest><VoyageNo>X1</VoyageNo></Manifest></ExportManifest>');
  assert.strictEqual(r.bls.length, 0);
  assert.strictEqual(r.containers.length, 0);
  assert.strictEqual(r.header.voyage_no, 'X1');
});

test('XML inválido rechaza la promesa', async () => {
  await assert.rejects(() => parseXmlManifest('<<<no es xml'));
});
