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
async function getBridgeStatus() {
  try {
    const data = await bridgeRequest('GET', '/health', null);
    return { online: true, ...data };
  } catch (e) {
    return { online: false, error: e.message };
  }
}

// Lote actual de SISCOMMATE. No bloquea el push si el bridge no responde.
async function getLote() {
  try { return await bridgeRequest('GET', '/lote', null); }
  catch (_) { return { lote: null, siguiente: null }; }
}

function pushManifest({ manifest, bls, containers }) {
  return bridgeRequest('POST', '/guardar', { manifest, bls, containers });
}

module.exports = {
  getBridgeConfig, bridgeRequest,
  getBridgeStatus, getLote, pushManifest,
  BRIDGE_TIMEOUT_MS,
};
