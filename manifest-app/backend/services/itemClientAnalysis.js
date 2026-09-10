// services/itemClientAnalysis.js — Sugerir un cliente por código arancelario
// según el historial real de SISCOMMATE.
//
// No existe una tabla código→cliente en SISCOMMATE: un código arancelario
// (materia prima) lo puede importar cualquiera. Lo que sí hay es historial —
// BOL.consigne cruzado con BOLITEM.code — y algunos códigos tienen un
// importador claramente dominante. Esto calcula esa asociación (el más
// frecuente, con al menos 3 casos) y la guarda en hacienda_items
// (client_name, client_ss) para que el editor pueda sugerir/autocompletar
// el consignatario.
//
// El nombre se busca primero en el catálogo local `clients` (rápido, en
// memoria) y si no aparece ahí, directo en CUSTOMER.DBF de SISCOMMATE (la
// fuente real) — `clients` local es solo un caché liviano, no el maestro.

const db = require('../db/connection');
const { analizarItemClienteTodos, buscarClientesSiscommate } = require('./siscommateClient');

const MIN_OCURRENCIAS = 3;

/**
 * Empareja un nombre de SISCOMMATE (BOL.consigne, texto libre) con un
 * cliente del catálogo local. Misma lógica de coincidencia que ya usa la
 * carga de manifiestos (routes/manifests.js) para no divergir.
 * @param {string} nombreSiscommate
 * @param {Map<string, {name:string, ss:string}>} clientMap nombre en mayúsculas → cliente
 * @returns {{name:string, ss:string}|null}
 */
function emparejarClienteLocal(nombreSiscommate, clientMap) {
  const norm = (nombreSiscommate || '').trim().toUpperCase();
  if (!norm) return null;
  const exacto = clientMap.get(norm);
  if (exacto) return exacto;
  for (const [cName, cObj] of clientMap.entries()) {
    if (cName.length >= 4 && (norm.includes(cName) || cName.includes(norm))) return cObj;
  }
  return null;
}

/**
 * Corre el análisis completo: trae el historial agregado del bridge, elige
 * el cliente más frecuente por código (mínimo 3 casos), busca su SS —
 * primero en el catálogo local, si no en CUSTOMER.DBF real — y guarda
 * hacienda_items.client_name/client_ss.
 * @returns {Promise<{codigos_con_historial:number, codigos_asociados_local:number, codigos_asociados_siscommate:number, sin_ss:number}>}
 */
async function analizarYGuardar() {
  const filas = await analizarItemClienteTodos();

  const porCodigo = new Map();
  filas.forEach(f => {
    if (!porCodigo.has(f.code)) porCodigo.set(f.code, []);
    porCodigo.get(f.code).push(f);
  });

  const clients = db.prepare(`SELECT name, ss, phone1, add1, add2, ivu FROM clients WHERE name IS NOT NULL AND name != '' AND ss IS NOT NULL AND ss != ''`).all();
  const clientMap = new Map();
  clients.forEach(c => { const k = c.name.trim().toUpperCase(); if (!clientMap.has(k)) clientMap.set(k, c); });

  const codigosValidos = new Set(db.prepare(`SELECT code FROM hacienda_items`).all().map(r => r.code));

  // Candidatos que califican (top con n>=MIN_OCURRENCIAS) para un código
  // real de nuestro catálogo, sin resolver todavía a qué cliente.
  const candidatos = [];
  porCodigo.forEach((filasCodigo, code) => {
    if (!codigosValidos.has(code)) return;
    filasCodigo.sort((a, b) => b.n - a.n);
    const top = filasCodigo[0];
    if (top.n >= MIN_OCURRENCIAS) candidatos.push({ code, consigne: top.consigne });
  });

  let asociadosLocal = 0, asociadosSiscommate = 0, sinSS = 0;
  const actualizar = db.prepare(`
    UPDATE hacienda_items
    SET client_name=?, client_ss=?, client_phone=?, client_add1=?, client_add2=?, client_add3=?, client_ivu=?
    WHERE code=?
  `);

  for (const { code, consigne } of candidatos) {
    const local = emparejarClienteLocal(consigne, clientMap);
    if (local) {
      actualizar.run(local.name, local.ss, local.phone1 || '', local.add1 || '', local.add2 || '', '', local.ivu || '', code);
      asociadosLocal++;
      continue;
    }
    // No está en el caché local: preguntarle directo a SISCOMMATE (CUSTOMER
    // real). Solo se acepta un match de nombre exacto o casi exacto — el
    // buscador de clientes ya hace LIKE, así que hay que filtrar del lado de
    // acá para no asociar el primer resultado parecido.
    let real = [];
    try { real = await buscarClientesSiscommate(consigne); } catch (_) { real = []; }
    const normConsigne = consigne.trim().toUpperCase();
    const exacto = real.find(c => (c.name || '').trim().toUpperCase() === normConsigne && c.ss);
    if (exacto) {
      actualizar.run(exacto.name, exacto.ss, exacto.phone1 || '', exacto.add1 || '', exacto.add2 || '', exacto.add3 || '', exacto.ivu || '', code);
      asociadosSiscommate++;
    } else {
      sinSS++;
    }
  }

  return {
    codigos_con_historial: porCodigo.size,
    codigos_candidatos: candidatos.length,
    codigos_asociados_local: asociadosLocal,
    codigos_asociados_siscommate: asociadosSiscommate,
    sin_ss: sinSS,
  };
}

module.exports = { analizarYGuardar, emparejarClienteLocal, MIN_OCURRENCIAS };
