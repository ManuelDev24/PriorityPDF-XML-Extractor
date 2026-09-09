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
 * @param {{manifest: import('../types').ManifestRow, bls: import('../types').BLRow[], containers: import('../types').BridgeContainer[]}} payload
 * @returns {Promise<any>}
 */
function pushManifest({ manifest, bls, containers }) {
  return bridgeRequest('POST', '/guardar', { manifest, bls, containers });
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
  analizarItemClienteTodos,
  BRIDGE_TIMEOUT_MS,
};
