// services/txtGenerator.js — Generación del TXT oficial de Hacienda PR
//
// Formato verificado contra archivos TXT reales del sistema SISCOMMATE.
// Todas las líneas tienen exactamente 205 caracteres.
//
// Extraído de server.js (paso 2 de la separación backend/frontend).
// Recibe datos y devuelve strings. Lee catálogos/configuración de SQLite cuando
// están disponibles, pero conserva fallbacks para tests y actualizaciones.
//
// Tipado con JSDoc — verificar con: npm run typecheck

const db = require('../db/connection');
const { PORT_MAPPINGS } = require('../db/catalogDefaults');

function setting(key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row && row.value !== '' ? row.value : fallback;
  } catch (_) {
    return fallback;
  }
}

/**
 * Manifiesto tal como llega desde la tabla `manifests`, más `carrier_ivu` que
 * la ruta de exportación adjunta desde el catálogo de carriers.
 * @typedef {object} Manifest
 * @property {string} [carrier_code]    Código del carrier (por defecto MPRIORO)
 * @property {string} [manifest_no]     No. de manifiesto de Hacienda
 * @property {string} [vessel_name]
 * @property {string} [voyage_no]
 * @property {string|number} [imo]
 * @property {string} [departure_date]  YYYY-MM-DD
 * @property {string} [arrival_date]    YYYY-MM-DD
 * @property {string|number} [docking_number] Número de atraque, obligatorio
 * @property {string} [loading_port]
 * @property {string} [unloading_port]
 * @property {string} [carrier_ivu]     Respaldo del IVU si el consignatario no tiene
 */

/**
 * Item de carga individual de `bl_cargo_items`. Cuando existe, reemplaza los
 * campos del B/L en la línea 2.
 * @typedef {object} CargoItem
 * @property {string} [goods_name]
 * @property {number|string} [gross_weight]
 * @property {string} [hacienda_item_code]
 * @property {string} [hacienda_tariff]
 * @property {number|string} [package_qty]
 * @property {string|null} [container_no]
 */

/**
 * B/L de la tabla `bills_of_lading`. `containers` y `cargoItems` los adjunta la
 * ruta de exportación antes de generar el TXT.
 * @typedef {object} BL
 * @property {string} [bl_no]
 * @property {string} [consignee_name]
 * @property {string} [consignor_name]
 * @property {string} [consignee_document_no]
 * @property {string} [hacienda_client_ss]
 * @property {string} [hacienda_client_ivu]
 * @property {string} [hacienda_item_code]
 * @property {string} [hacienda_tariff]   '040' libre arancel | '045' carga general
 * @property {string} [hacienda_container_no]
 * @property {string} [goods_name]
 * @property {number|string} [package_qty]
 * @property {number|string} [gross_weight]
 * @property {number|string} [value]      Valor FOB en USD
 * @property {string[]} [containers]      Contenedores del B/L
 * @property {CargoItem[]|null} [cargoItems]
 */

// ─── HELPERS DE RELLENO ──────────────────────────────────────────────────────

/**
 * Recorta a n caracteres y rellena con espacios a la derecha.
 * @param {string|number|null|undefined} s
 * @param {number} n Ancho exacto del campo
 * @returns {string} Siempre de longitud n
 */
function pad(s, n)  { return String(s || '').substring(0, n).padEnd(n, ' '); }

/**
 * Recorta a n caracteres y rellena con espacios a la izquierda.
 * @param {string|number|null|undefined} s
 * @param {number} n Ancho exacto del campo
 * @returns {string} Siempre de longitud n
 */
function padL(s, n) { return String(s || '').substring(0, n).padStart(n, ' '); }

/**
 * Rellena con ceros a la izquierda hasta n caracteres.
 * @param {string|number|null|undefined} s
 * @param {number} n Ancho exacto del campo
 * @returns {string} Siempre de longitud n
 */
function padZ(s, n) { return String(s || '').padStart(n, '0').substring(0, n); }

/**
 * Convierte a número tanto lo que llega como texto (el frontend manda los
 * inputs numéricos como string) como lo que ya viene numérico de SQLite.
 *
 * Antes se usaba parseFloat() directo, que solo acepta texto y funcionaba por
 * coerción implícita de JavaScript. El chequeo de tipos lo detectó.
 * @param {string|number|null|undefined} v
 * @returns {number} 0 si no es convertible
 */
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

// SS/EIN: exactamente 9 dígitos. Devuelve null si no tiene exactamente 9 para
// que la validación de export-txt pueda detectar valores inválidos.
/**
 * SS/EIN a exactamente 9 dígitos, rellenando con ceros a la IZQUIERDA para
 * preservar el EIN real. Si viene con más de 9 dígitos, conserva los últimos 9.
 * @param {string|number|null|undefined} ss
 * @returns {string} Siempre 9 dígitos
 */
function sanitizeSS(ss) {
  const digits = String(ss || '').replace(/[^0-9]/g, '');
  if (digits.length === 0) return '000000000';
  // Rellenar con ceros a la izquierda (no derecha) para preservar el EIN real
  return digits.padStart(9, '0').substring(digits.length > 9 ? digits.length - 9 : 0);
}

/**
 * Quita cualquier carácter que no sea letra o número. Se usa en TODOS los
 * campos identificador/código de ancho fijo que van al TXT — contenedor,
 * B/L, viaje, No. de manifiesto, IVU — sin importar el origen del dato (PDF
 * mal extraído, XML, o el operador escribiéndolo a mano en el editor): un
 * punto, dos puntos, guión u otro símbolo colado en cualquiera de esos
 * campos hace que SISCOMMATE/Hacienda rechace la línea al recibir el TXT.
 *
 * NO se usa en nombres, direcciones ni descripciones — ahí el punto, la
 * coma o el "&" son contenido real ("S.A.", "KM. 72.2", "P.O. BOX") y
 * quitarlos dañaría el dato en vez de limpiarlo.
 * @param {string|null|undefined} valor
 * @returns {string}
 */
function sanitizeIdentificador(valor) {
  return String(valor || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Vocabulario real confirmado contra BOLITEM.ptype de SISCOMMATE — mismo
// catálogo que ya usa el combobox del editor (TIPOS_EMPAQUE en
// EditorPanel.vue). Cualquier otro valor no es un código de empaque válido
// para SISCOMMATE, aunque sea texto real (ej. "PACK", "UNIT") o un código de
// la DGA que no corresponde a este catálogo (ej. "IG013", o un "1" suelto).
const TIPOS_EMPAQUE_VALIDOS = new Set([
  'AUTO', 'AUTO-T', 'BARREL', 'BBL', 'BBLS', 'BOX', 'BUNDLE', 'CRATE', 'DRUMS', 'LSE', 'PALETS', 'PIECES',
]);
// Variantes de ortografía/plural/idioma con una traducción obvia y segura —
// a diferencia de "PACK" o "UNIT", que son genéricos y podrían mapear a
// varias cosas, estas no dejan duda de a qué código corresponden.
const SINONIMOS_EMPAQUE = {
  'PALLET': 'PALETS',
  'VEHICLE': 'AUTO',
  'DRUM': 'DRUMS',
  'CARTON': 'BOX',
};
/**
 * Código empaque (DGA) que el operador eligió o que trajo el PDF/XML de
 * origen — validado contra el vocabulario real de SISCOMMATE antes de
 * escribirlo al TXT. Antes se mandaba cualquier valor tal cual llegara
 * (confirmado con datos reales: "PACK", "UNIT", "1", "IG013"... — códigos
 * internos de la DGA o palabras genéricas del PDF que SISCOMMATE no
 * reconoce), lo que mandaba basura al campo en ~85% de los B/L con este
 * campo lleno. Ahora solo pasa un valor si es válido o tiene una traducción
 * segura; cualquier otro se descarta — mejor caer al respaldo BOX/LSE que
 * mandar un código inventado o desconocido.
 * @param {string|null|undefined} valor
 * @returns {string} El código válido, o '' si no se reconoce
 */
function normalizarEmpaque(valor) {
  const v = String(valor || '').trim().toUpperCase();
  if (!v) return '';
  if (TIPOS_EMPAQUE_VALIDOS.has(v)) return v;
  return SINONIMOS_EMPAQUE[v] || '';
}

const MAPA_ACENTOS = {
  'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u', 'ü': 'u', 'ñ': 'n',
  'Á': 'A', 'É': 'E', 'Í': 'I', 'Ó': 'O', 'Ú': 'U', 'Ü': 'U', 'Ñ': 'N',
  // Comillas/rayas "curvas" y puntos suspensivos — típico artefacto de
  // copiar texto de un PDF (ej. 8" de pulgadas queda como comilla curva).
  '“': '"', '”': '"', '‘': "'", '’': "'",
  '–': '-', '—': '-', '…': '...',
};
/**
 * Quita acentos, diéresis (á→a, ñ→n, ü→u, Ñ→N...) y cualquier otro carácter
 * fuera de ASCII, sin tocar el resto del texto — a diferencia de
 * sanitizeIdentificador, aquí sí importa conservar la puntuación real
 * (comas, puntos, "&", números). El TXT de Hacienda es de ancho fijo por
 * BYTE, y el archivo se sirve como UTF-8: cualquier carácter fuera de ASCII
 * ocupa 2 o más bytes en vez de 1, así que corre posiciones todo lo que
 * sigue en la línea sin que nada lo avise en pantalla — visto en datos
 * reales con acentos (CAÑAS, PLÁSTICOS) y con comillas curvas coladas desde
 * un PDF ("8" QUALITY..."). Los caracteres conocidos se transliteran
 * (mapa arriba); cualquier otro que aparezca y no se haya previsto se quita
 * directo — es preferible perder un símbolo raro a desalinear el resto de
 * la línea. Se usa en nombre/descripción/buque, los únicos campos de texto
 * libre (no controlado) que van al TXT.
 * @param {string|null|undefined} texto
 * @returns {string}
 */
function quitarAcentos(texto) {
  const conMapa = String(texto || '').replace(/[áéíóúüñÁÉÍÓÚÜÑ“”‘’–—…]/g, c => MAPA_ACENTOS[c]);
  // Red de seguridad: cualquier carácter fuera de ASCII que no esté en el
  // mapa (símbolo raro, artefacto de OCR/PDF que no anticipamos) se quita.
  return conMapa.replace(/[^\x00-\x7F]/g, '');
}

// Puerto XML/DGA → código SISCOMMATE (fuente: ports.dbf de SISCOMMATE)
/**
 * Traduce un código de puerto XML/DGA al código de 3 letras de SISCOMMATE.
 * Los desconocidos se recortan a 3 caracteres; sin código asume San Juan.
 * @param {string|null|undefined} code
 * @returns {string} Código de 3 caracteres
 */
function toSiscommatePort(code) {
  const fallbackMap = {
    // San Juan, PR
    'PRSJU':'XSJ', 'SJU':'XSJ', 'SJX':'XSJ',
    // Mayagüez, PR
    'MGE':'MGE', 'PRMGE':'MGE', 'MAZ':'MAZ', 'PRMAZ':'MAZ',
    // Santo Domingo / Caucedo, DO
    'DRP':'DRP', 'DOSDQ':'DRP', 'DOSDO':'DRP', 'SDQ':'DRP', 'RPX':'DRP',
    // Río Haina, DO
    'RHA':'RHA', 'DORHA':'RHA',
    // St. Thomas, USVI
    'STT':'STT', 'STH':'STT', 'VISTT':'STT',
    // St. Croix, USVI
    'STX':'STX', 'CRX':'STX', 'VISTX':'STX',
    // St. Maarten / St. Martin
    'SXM':'SXM', 'STM':'SXM', 'MST':'SXM', 'SFG':'SFG',
    // Tortola, BVI
    'TOR':'TOR', 'VGTOR':'TOR',
    // Saint Kitts
    'SKB':'SKB',
    // Antigua
    'ANU':'ANU',
    // USA
    'MIA':'MIA', 'USMIA':'MIA',
    'FLL':'FLL', 'USFLL':'FLL',
    'PEV':'PEV', 'PEG':'PEV', 'USPEV':'PEV',
    'JAX':'JAX', 'USJAX':'JAX',
    'TAP':'TAP', 'USTAP':'TAP',
    'MCO':'MCO', 'NAP':'NAP', 'LAX':'LAX', 'PEN':'PEN',
    'NY':'NY', 'NYC':'NY', 'USNYC':'NY',
    // México
    'MXI':'MXI', 'MXVER':'MXI',
    // China
    'TSI':'TSI', 'CNTAO':'TSI',
  };
  const normalized = (code || '').toUpperCase();
  let mapped;
  let mappingsAvailable = false;
  try {
    mapped = db.prepare(
      'SELECT siscommate_code FROM port_mappings WHERE dga_code=?'
    ).get(normalized);
    mappingsAvailable = true;
  } catch (_) { /* migración todavía no aplicada */ }
  if (mapped && mapped.siscommate_code) return mapped.siscommate_code;
  if (mappingsAvailable) {
    return (code || 'XSJ').toUpperCase().substring(0, 3);
  }
  const fallback = PORT_MAPPINGS.find(([dga]) => dga === normalized);
  return (fallback ? fallback[1] : fallbackMap[normalized] ||
    (code || 'XSJ').toUpperCase().substring(0, 3));
}

// ── LÍNEA 0 — Encabezado del manifiesto (205 chars) ──────────────────────────
// Posiciones verificadas (0-indexed):
//  [0]      tipo '0'
//  [1:17]   16 espacios
//  [17:24]  carrier (7)
//  [24]     espacio
//  [25:32]  manifest_no (7)
//  [32:36]  bl_count (4, zero-padded)
//  [36:44]  arrival_date YYYYMMDD (8)
//  [44:60]  vessel_name (16)
//  [60:66]  voyage_no (6)
//  [66:74]  departure_date YYYYMMDD (8)
//  [74:82]  arrival_date YYYYMMDD (8)
//  [82:87]  'N1800'
//  [87:94]  carrier (7)
//  [94]     espacio
//  [95:101] voyage_no (6)
//  [101:165] 64 espacios (reservado SISCOMMATE)
//  [165:173] docking_number (8, número de atraque — obligatorio)
//  [173]    espacio
//  [174:181] imo (7)
//  [181:183] 2 espacios
//  [183:191] arrival_date YYYYMMDD (8)
//  [191:205] 14 espacios
/**
 * Línea 0 — encabezado del manifiesto.
 * @param {Manifest} manifest
 * @param {number} blCount Total de pares B/L-contenedor del archivo
 * @returns {string} Exactamente 205 caracteres
 */
function generateTxtLine0(manifest, blCount) {
  const carrier = pad(manifest.carrier_code || setting('default_carrier_code', 'MPRIORO'), 7);
  const manNo   = pad(sanitizeIdentificador(manifest.manifest_no), 7);
  const vessel  = pad(quitarAcentos(manifest.vessel_name), 16);
  const voyNo   = pad(sanitizeIdentificador(manifest.voyage_no), 6);
  const imo     = padZ(manifest.imo || '0', 7);
  const dep     = (manifest.departure_date || '').replace(/-/g, '').substring(0, 8).padEnd(8, ' ');
  const arr     = (manifest.arrival_date || '').replace(/-/g, '').substring(0, 8).padEnd(8, ' ');
  const cnt     = padZ(blCount, 4);
  return (
    '0' +                    // [0]      tipo
    pad('', 16) +            // [1:17]   16 espacios
    carrier +                // [17:24]  carrier
    ' ' +                    // [24]     espacio
    manNo +                  // [25:32]  manifest_no
    cnt +                    // [32:36]  bl_count
    arr +                    // [36:44]  arrival_date
    vessel +                 // [44:60]  vessel
    voyNo +                  // [60:66]  voyage
    dep +                    // [66:74]  departure_date
    arr +                    // [74:82]  arrival_date (repetido)
    'N1800' +                // [82:87]
    carrier +                // [87:94]  carrier (repetido)
    ' ' +                    // [94]
    voyNo +                  // [95:101] voyage (repetido)
    pad('', 64) +            // [101:165] reservado
    padZ(manifest.docking_number || '0', 8) + // [165:173] docking_number
    ' ' +                    // [173]
    imo +                    // [174:181] IMO
    '  ' +                   // [181:183]
    arr +                    // [183:191] arrival_date
    pad('', 14)              // [191:205] trailing
  );
}

// ── LÍNEA 1 — Datos del B/L y consignatario (205 chars) ──────────────────────
// Posiciones verificadas (0-indexed):
//  [0]       tipo '1'
//  [1:17]    bl_no (16)
//  [17:19]   'AM'
//  [19:37]   container_no (18)
//  [37:67]   consignee_name (30)
//  [67:76]   ss_ein (9)
//  [76:83]   type_code (7) = 'C      ' o referencia de cliente
//  [83:143]  consignor_name (60)
//  [143:146] orig_port (3)
//  [146:149] disc_port (3)
//  [149:152] dest_port (3)
//  [152]     'C'
//  [153:162] fob_value_cents (9)
//  [162]     'C'
//  [163:175] 12 espacios
//  [175]     'V'
//  [176:186] 10 ceros
//  [186:190] tariff+'R' (4) o 4 espacios si libre arancel
//  [190:201] IVU/No. comerciante del CONSIGNATARIO (11) — verificado contra
//            archivos reales SISCOMMATE: este campo varía por B/L según el
//            IVU del consignatario, NO es el código arancelario. Si el
//            consignatario no tiene IVU registrado, SISCOMMATE usa el IVU
//            del carrier como respaldo (visto en los TXT reales).
//  [201:205] 4 espacios
/**
 * Línea 1 — datos del B/L y del consignatario.
 * @param {BL} bl
 * @param {Manifest} manifest
 * @param {string} [containerNo] Contenedor de esta línea; si se omite usa el del B/L
 * @returns {string} Exactamente 205 caracteres
 */
function generateTxtLine1(bl, manifest, containerNo) {
  const ss9      = sanitizeSS(bl.hacienda_client_ss || bl.consignee_document_no);
  const loadPort = toSiscommatePort(manifest.loading_port || setting('default_loading_port', 'DRP'));
  const discPort = toSiscommatePort(manifest.unloading_port || setting('default_unloading_port', 'SJU'));
  const tariff   = bl.hacienda_tariff;
  // Libre arancel (040): SISCOMMATE requiere valor FOB = 0
  const fobValue = (tariff === '040') ? 0 : toNum(bl.value);
  const valCents = padZ(Math.round(fobValue * 100), 9);
  // tariff+R: '040R', '045R', o 4 espacios si es libre arancel / tránsito
  const tariffR  = tariff ? `${pad(tariff, 3)}R` : '    ';
  const ivu11    = sanitizeIdentificador(bl.hacienda_client_ivu || manifest.carrier_ivu);
  return (
    '1' +
    pad(sanitizeIdentificador(bl.bl_no), 16) + // [1:17]
    'AM' +                        // [17:19]
    pad(sanitizeIdentificador(containerNo !== undefined ? containerNo : bl.hacienda_container_no), 18) + // [19:37]
    pad(quitarAcentos(bl.consignee_name), 30) +  // [37:67]
    ss9 +                         // [67:76]
    'C      ' +                   // [76:83] tipo C + 6 espacios
    pad(quitarAcentos(bl.consignor_name), 60) +  // [83:143]
    pad(loadPort, 3) +            // [143:146]
    pad(discPort, 3) +            // [146:149]
    pad(discPort, 3) +            // [149:152]
    'C' +                         // [152]
    valCents +                    // [153:162]
    'C' +                         // [162]
    pad('', 12) +                 // [163:175]
    'V' +                         // [175]
    padZ(0, 10) +                 // [176:186]
    tariffR +                     // [186:190]
    pad(ivu11, 11) +              // [190:201] IVU consignatario (fallback: IVU carrier)
    '    '                        // [201:205]
  );
}

// ── LÍNEA 2 — Detalle de carga (205 chars) ────────────────────────────────────
// Posiciones verificadas contra TXT reales de SISCOMMATE (3309577.TXT / K1305):
//  [0]       tipo '2'
//  [1:17]    bl_no (16)
//  [17:22]   qty (5)
//  [22:28]   unit_type (6) — 'BOX   ' si tiene contenedor, 'LSE   ' si no
//  [28:35]   weight (7) = gross_weight_kg × 100
//  [35:38]   tariff (3)
//  [38:159]  goods_description (121)
//  [159:164] qty_repeat (5)
//  [164:179] hacienda_item_code (15) zero-padded izquierda
//  [179:181] 2 espacios
//  [181:201] 20 ceros
//  [201:203] 'KF'
//  [203:205] 2 espacios
// containerCount: total de contenedores del B/L — divide el peso entre ellos
// item: objeto { goods_name, gross_weight, hacienda_item_code, hacienda_tariff, package_qty }
//       si null, usa los campos del bl directamente
/**
 * Línea 2 — detalle de carga.
 * @param {BL} bl
 * @param {string} [containerNo]
 * @param {number} [containerCount] Contenedores del B/L: reparte el peso entre ellos
 * @param {CargoItem|null} [item] Si viene, sus campos reemplazan los del B/L
 * @returns {string} Exactamente 205 caracteres
 */
function generateTxtLine2(bl, containerNo, containerCount, item) {
  const src       = item || bl;
  const tariff    = pad(src.hacienda_tariff || bl.hacienda_tariff || '   ', 3);
  const totalWeight = toNum(src.gross_weight);
  const weightPerCont = (!item && containerCount > 1) ? totalWeight / containerCount : totalWeight;
  const weightG   = padZ(Math.round(weightPerCont * 100), 7);
  const goodsDesc = pad(quitarAcentos((src.goods_name || '').replace(/[\r\n]+/g, ' ')), 121);
  const qty       = padZ(src.package_qty || bl.package_qty || 0, 5);
  const itemCode  = padZ(parseInt(src.hacienda_item_code || bl.hacienda_item_code) || 0, 15);
  const hasContainer = !!(containerNo !== undefined ? containerNo : bl.hacienda_container_no || '').trim();
  // Código empaque (DGA) que el operador elige en el editor — antes se
  // ignoraba por completo y siempre se mandaba "BOX"/"LSE" fijo según si
  // había contenedor. La data real de SISCOMMATE confirma que BOLITEM.ptype
  // sí varía (BOX, BUNDLE, PALETS, BARREL...) y coincide con esta lista, así
  // que el valor elegido va primero — pero solo si normalizarEmpaque() lo
  // reconoce como válido; si no, cae al mismo respaldo que cuando está vacío.
  const empaqueElegido = normalizarEmpaque(bl.package_unit_code);
  const unitType  = pad(empaqueElegido || (hasContainer ? 'BOX' : 'LSE'), 6);
  return (
    '2' +
    pad(sanitizeIdentificador(bl.bl_no), 16) +
    qty +
    unitType +
    weightG +
    tariff +
    goodsDesc +
    qty +
    itemCode +
    '  ' +
    padZ(0, 20) +
    'KF' +
    '  '
  );
}

// bl.containers: lista de container_no; bl.cargoItems: lista de cargo items
/**
 * Arma el TXT completo: una línea 0, y por cada contenedor de cada B/L un par
 * línea 1 + línea 2. Separador CRLF.
 * @param {Manifest} manifest
 * @param {BL[]} bls Solo los B/L validados
 * @returns {string}
 */
function generateFullTxt(manifest, bls) {
  const lines = [];
  const pairCount = bls.reduce((sum, bl) => sum + (bl.containers && bl.containers.length ? bl.containers.length : 1), 0);
  lines.push(generateTxtLine0(manifest, pairCount));
  bls.forEach(bl => {
    const containerNos = (bl.containers && bl.containers.length) ? bl.containers : [bl.hacienda_container_no || ''];
    const cargoItems = bl.cargoItems && bl.cargoItems.length ? bl.cargoItems : null;
    containerNos.forEach(containerNo => {
      lines.push(generateTxtLine1(bl, manifest, containerNo));
      if (cargoItems) {
        // Filtrar items del contenedor o items sin contenedor asignado (aplican a todos)
        const items = cargoItems.filter(ci => !ci.container_no || ci.container_no === containerNo);
        if (items.length) {
          items.forEach(item => lines.push(generateTxtLine2(bl, containerNo, 1, item)));
        } else {
          lines.push(generateTxtLine2(bl, containerNo, containerNos.length, null));
        }
      } else {
        lines.push(generateTxtLine2(bl, containerNo, containerNos.length, null));
      }
    });
  });
  return lines.join('\r\n');
}

module.exports = {
  pad, padL, padZ,
  sanitizeSS,
  toSiscommatePort,
  generateTxtLine0, generateTxtLine1, generateTxtLine2,
  generateFullTxt,
};
