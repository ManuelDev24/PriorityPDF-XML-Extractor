// services/siscommateClient.js — Único punto de contacto con SISCOMMATE
//
// Extraído de server.js (paso 5 de la separación backend/frontend).
//
// IMPORTANTE (Fase B): hoy la comunicación es HTTP contra SiscommateBridge.exe
// (C#), que corre en el servidor y escribe en las tablas DBF de Visual FoxPro.
// Ese bridge NO puede modificarse desde aquí, y hoy descarta cuatro campos que
// el operador sí llena: docking_number, hacienda_tariff, hacienda_client_ss/ivu
// y el detalle de bl_cargo_items. Cuando se resuelva el acceso al esquema DBF,
// la Fase B reemplaza la implementación de este archivo por escritura directa
// vía VFPOLEDB — sin tocar las rutas que lo consumen.

const http = require('http');
const db = require('../db/connection');
const { quitarAcentos, sanitizeIdentificador, normalizarEmpaque, calcularPuertosDbf } = require('./txtGenerator');

/**
 * Para el push a SISCOMMATE: más estricto que quitarAcentos() (que se usa
 * para el TXT local y sí conserva puntuación real como "S.A." o "KM. 72.2").
 * Pedido explícito: NINGÚN carácter especial debe llegar a la base real de
 * SISCOMMATE — ni dos puntos, ni guiones, ni barras, ni comas, nada que no
 * sea letra/número/espacio. Se quitan acentos primero (para no perder la
 * letra, solo el acento) y despues cualquier otra cosa que no sea A-Z, 0-9
 * o espacio.
 * @param {string|null|undefined} texto
 * @returns {string}
 */
function limpiarTextoLibre(texto) {
  return quitarAcentos(String(texto || ''))
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const DEFAULT_HOST = process.env.BRIDGE_HOST || 'localhost';
const DEFAULT_PORT = process.env.BRIDGE_PORT || 5001;

// Tiempo máximo de espera del bridge. Antes no había timeout: si el bridge se
// colgaba, la petición de Express quedaba esperando indefinidamente.
const BRIDGE_TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS) || 30000;

// La configuración vive en la tabla settings (editable desde /admin.html),
// con las variables de entorno como respaldo.
/**
 * Host y puerto del bridge. Vive en la tabla settings (editable desde
 * /admin.html), con las variables de entorno como respaldo.
 * @returns {{host: string, port: string|number}}
 */
function getBridgeConfig() {
  const rows = db.prepare(
    `SELECT key, value FROM settings WHERE key IN ('bridge_host','bridge_port')`
  ).all();
  const cfg = { host: DEFAULT_HOST, port: DEFAULT_PORT };
  rows.forEach(r => {
    if (r.key === 'bridge_host' && r.value) cfg.host = r.value;
    if (r.key === 'bridge_port' && r.value) cfg.port = r.value;
  });
  return cfg;
}

/**
 * Petición HTTP al bridge de SISCOMMATE.
 * @param {string} method
 * @param {string} path
 * @param {object|null} [body]
 * @returns {Promise<any>} La respuesta parseada, o {raw} si no es JSON válido
 * @throws {Error} Si no conecta o si supera BRIDGE_TIMEOUT_MS
 */
function bridgeRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const { host, port } = getBridgeConfig();
    const postData = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: host,
      port:     port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (postData) opts.headers['Content-Length'] = Buffer.byteLength(postData);

    const req = http.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Un status fuera de 2xx significa que NO fue el bridge real quien
        // contestó (o que el bridge real rechazó la operación) — antes esto
        // se resolvía igual que una respuesta válida en cuanto llegaba algo
        // de texto, así que un 404 ajeno (otro proceso ocupando el puerto,
        // ruta que no existe en una versión vieja del bridge) se trataba
        // como éxito. Con /guardar eso marcó un manifiesto como enviado a
        // SISCOMMATE sin haberse escrito nada real.
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const preview = data.replace(/\s+/g, ' ').trim().substring(0, 200);
          reject(new Error(`El bridge respondió ${res.statusCode} en ${path}: ${preview || '(sin cuerpo)'}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ raw: data }); }
      });
    });

    // Fix Fase A: sin esto una petición podía quedar colgada para siempre
    req.setTimeout(BRIDGE_TIMEOUT_MS, () => {
      req.destroy(new Error(
        `El bridge no respondió en ${BRIDGE_TIMEOUT_MS / 1000}s (${host}:${port})`
      ));
    });

    req.on('error', err => reject(describirError(err, host, port)));
    if (postData) req.write(postData);
    req.end();
  });
}

// En algunas versiones de Node los errores de socket llegan con .message vacío
// y la información útil en .code. El Admin muestra este texto, así que se
// arma un mensaje legible en vez de dejarlo en blanco.
/**
 * Arma un mensaje legible para errores de socket sin .message.
 * @param {NodeJS.ErrnoException} err
 * @param {string} host
 * @param {string|number} port
 * @returns {Error}
 */
function describirError(err, host, port) {
  if (err && err.message) return err;
  const destino = `${host}:${port}`;
  const explicacion = {
    ECONNREFUSED: `Conexión rechazada por ${destino} — el bridge no está corriendo`,
    ETIMEDOUT:    `Sin respuesta de ${destino} — revisa red o firewall`,
    ENOTFOUND:    `No se pudo resolver el host "${host}"`,
    EHOSTUNREACH: `Host ${host} inalcanzable desde este servidor`,
    ECONNRESET:   `El bridge cerró la conexión inesperadamente (${destino})`,
  }[err && err.code] || `Fallo de conexión con ${destino}${err && err.code ? ` (${err.code})` : ''}`;
  return Object.assign(err instanceof Error ? err : new Error(explicacion), { message: explicacion });
}

// ── Operaciones de negocio ───────────────────────────────────────────────────
/**
 * ¿Está vivo el bridge? Nunca lanza: devuelve el estado.
 * @returns {Promise<{online: boolean, error?: string}>}
 */
async function getBridgeStatus() {
  try {
    const data = await bridgeRequest('GET', '/health', null);
    return { online: true, ...data };
  } catch (e) {
    return { online: false, error: e.message };
  }
}

// Lote actual de SISCOMMATE. No bloquea el push si el bridge no responde.
/**
 * Número de lote actual de SISCOMMATE. No bloquea el push si el bridge no
 * responde: devuelve nulos.
 * @returns {Promise<{lote: number|null, siguiente: number|null}>}
 */
async function getLote() {
  try { return await bridgeRequest('GET', '/lote', null); }
  catch (_) { return { lote: null, siguiente: null }; }
}

/**
 * Envía el manifiesto al bridge para que lo escriba en las tablas DBF.
 * Limpia caracteres especiales antes de mandar — ver limpiarTextoLibre() y
 * sanitizeIdentificador() (mismas reglas que ya usa el TXT local, para que
 * lo que queda en SISCOMMATE nunca diverja de lo que dice el TXT). No muta
 * los objetos originales: el caller (routes/siscommate.js) los sigue usando
 * después para marcar siscommate_sent_at por id.
 * @param {{manifest: import('../types').ManifestRow, bls: import('../types').BLRow[], containers: import('../types').BridgeContainer[]}} payload
 * @returns {Promise<any>}
 */
/**
 * Mismo par de reglas que ya usa el TXT local (generateTxtLine2) — antes el
 * bridge decidía el ptype por su cuenta, sin mirar si el B/L de verdad tiene
 * contenedor (si package_unit_code venía vacío, siempre ponía "BOX" fijo,
 * nunca "LSE") ni validar el valor contra el vocabulario real de SISCOMMATE.
 * Eso podía divergir de lo que el TXT decía para el mismo B/L. Calculado
 * aquí con la misma lógica, lo que queda en SISCOMMATE ya no se desalinea.
 * @param {string|null|undefined} packageUnitCode
 * @param {boolean} hasContainer
 * @returns {string}
 */
function calcularPackageUnitCode(packageUnitCode, hasContainer) {
  const empaqueValido = normalizarEmpaque(packageUnitCode);
  return empaqueValido || (hasContainer ? 'BOX' : 'LSE');
}

function pushManifest({ manifest, bls, containers }) {
  const blNosConContenedor = new Set(containers.map(c => c.bl_no));
  // calcularPuertosDbf vive en txtGenerator.js — única fuente para el TXT y
  // el push, así nunca divergen (ver el jsdoc ahí para la distinción real
  // entre descarga y destino en carga en tránsito).
  const { origport, discport, destport } = calcularPuertosDbf(manifest);
  const manifestLimpio = {
    ...manifest, vessel_name: limpiarTextoLibre(manifest.vessel_name), origport, discport, destport,
  };
  const blsLimpios = bls.map(bl => ({
    ...bl,
    bl_no: sanitizeIdentificador(bl.bl_no),
    consignee_name: limpiarTextoLibre(bl.consignee_name),
    consignor_name: limpiarTextoLibre(bl.consignor_name),
    goods_name: limpiarTextoLibre(bl.goods_name),
    package_unit_code: calcularPackageUnitCode(bl.package_unit_code, blNosConContenedor.has(bl.bl_no)),
  }));
  const containersLimpios = containers.map(c => ({
    ...c,
    bl_no: sanitizeIdentificador(c.bl_no),
    container_no: sanitizeIdentificador(c.container_no),
  }));
  return bridgeRequest('POST', '/guardar', { manifest: manifestLimpio, bls: blsLimpios, containers: containersLimpios });
}

/**
 * Consulta de solo lectura: lo que de verdad quedó grabado en SISCOMMATE para
 * un viaje (MANIFEST + BOL/BOLCONT/BOLITEM), para comparar contra lo que el
 * editor cree haber enviado.
 * @param {string} voyageNo
 * @returns {Promise<{encontrado: boolean, manifest: object|null, bls: object[], items: object[], containers: object[]}>}
 */
function consultarManifiesto(voyageNo) {
  return bridgeRequest('GET', '/consultar?voyage=' + encodeURIComponent(voyageNo), null);
}

/**
 * Volcado directo de una tabla real de SISCOMMATE (endpoint /muestra del
 * bridge, ya existente — pensado para explorar tablas a mano). Se reutiliza
 * aquí para traer TODO el catálogo de clientes (CUSTOMER) de una sola vez en
 * vez de una búsqueda con "q" — no existe otro endpoint para un volcado
 * masivo, y agregar uno nuevo al bridge hubiera significado recompilar y
 * redesplegar el .exe para algo que /muestra ya resuelve.
 * @param {string} tabla Nombre de la tabla real en SISCOMMATE (ej. "CUSTOMER")
 * @param {number} [limite]
 * @returns {Promise<object[]>}
 */
function obtenerMuestra(tabla, limite) {
  return bridgeRequest('GET', `/muestra?tabla=${encodeURIComponent(tabla)}&limite=${limite || 10}`, null);
}

/**
 * Crea un cliente nuevo directo en CUSTOMER.DBF de SISCOMMATE (no en el
 * catálogo local — CUSTOMER es la fuente real). Verificado en vivo contra
 * SISCOMMATE real antes de exponerse acá.
 * @param {object} datos name, ss, code, type, taxid, add1-3, phone1-2, fax1-2, ivu
 * @returns {Promise<any>}
 */
function crearClienteSiscommate(datos) {
  return bridgeRequest('POST', '/cliente-crear', datos);
}

/**
 * Actualiza un cliente existente en CUSTOMER.DBF, ubicado por su nombre
 * ANTERIOR — necesario porque el nombre mismo se puede estar editando en el
 * mismo guardado. filas_afectadas en la respuesta: 0 = no se encontró ese
 * nombre (pudo cambiar mientras tanto), más de 1 = el nombre no era único —
 * el caller debe avisar en vez de asumir que se aplicó a la fila correcta.
 * @param {string} nombreOriginal
 * @param {object} datos Mismos campos que crearClienteSiscommate
 * @returns {Promise<{ok: true, filas_afectadas: number}>}
 */
function actualizarClienteSiscommate(nombreOriginal, datos) {
  return bridgeRequest('POST', '/cliente-actualizar', { ...datos, nombre_original: nombreOriginal });
}

/**
 * Elimina un cliente de CUSTOMER.DBF por nombre exacto. Igual que
 * actualizarClienteSiscommate, filas_afectadas dice cuántas filas reales se
 * tocaron (0 = no se encontró, más de 1 = el nombre no era único).
 * @param {string} nombre
 * @returns {Promise<{ok: true, filas_afectadas: number}>}
 */
function eliminarClienteSiscommate(nombre) {
  return bridgeRequest('POST', '/cliente-eliminar', { name: nombre });
}

/**
 * Busca clientes reales de SISCOMMATE (tabla CUSTOMER) por nombre o SS/EIN,
 * para autocompletar el consignatario en el editor. Nunca lanza: si el
 * bridge no responde, se devuelve una lista vacía en vez de romper la
 * búsqueda local de clientes.
 * @param {string} q
 * @returns {Promise<object[]>}
 */
async function buscarClientesSiscommate(q) {
  try { return await bridgeRequest('GET', '/clientes?q=' + encodeURIComponent(q), null); }
  catch (_) { return []; }
}

/**
 * (code, consigne, n) para TODO el historial real de SISCOMMATE, agregado
 * por el bridge en una sola consulta — ver services/itemClientAnalysis.js
 * para cómo se procesa esto en "código arancelario → cliente más frecuente".
 * @returns {Promise<{code:string, consigne:string, n:number}[]>}
 */
async function analizarItemClienteTodos() {
  return bridgeRequest('GET', '/analisis-item-cliente-todos', null);
}

module.exports = {
  getBridgeConfig, bridgeRequest,
  getBridgeStatus, getLote, pushManifest, consultarManifiesto, buscarClientesSiscommate,
  analizarItemClienteTodos, limpiarTextoLibre, calcularPackageUnitCode,
  obtenerMuestra, crearClienteSiscommate, actualizarClienteSiscommate, eliminarClienteSiscommate,
  BRIDGE_TIMEOUT_MS,
};
