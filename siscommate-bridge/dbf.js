/**
 * dbf.js - Wrapper ADODB / VFP OLE DB para SISCOMMATE
 *
 * Provider: VFPOLEDB.1 (Visual FoxPro OLE DB Provider)
 * Instalar desde: https://aka.ms/vfpoledb  (vfpoledb.exe ~3 MB)
 * Requiere: Windows 32-bit o 64-bit con VFP OLE DB instalado
 */

'use strict';
const ADODB = require('adodb');

let _dbfPath = null;

function setPath(p) {
  _dbfPath = p;
}

function openConn() {
  if (!_dbfPath) throw new Error('DBF_PATH no configurado');
  return ADODB.open(
    `Provider=VFPOLEDB.1;Data Source=${_dbfPath};` +
    `Exclusive=No;Null=No;Collate=Machine;BackgroundFetch=No;Deleted=No;`
  );
}

/**
 * Ejecuta una sentencia SQL sin resultado (INSERT / UPDATE / DELETE)
 */
async function execute(sql) {
  const conn = openConn();
  await conn.execute(sql);
}

/**
 * Ejecuta una consulta y devuelve array de objetos
 */
async function query(sql) {
  const conn = openConn();
  return await conn.query(sql);
}

// ── Helpers de formateo para SQL VFP ───────────────────────────────

/**
 * Formatea fecha para VFP: {^YYYY-MM-DD} o NULL
 * Acepta: "2024-07-15", Date, ISO string
 */
function fmtDate(d) {
  if (!d) return 'NULL';
  let s;
  if (d instanceof Date) {
    s = d.toISOString().substring(0, 10);
  } else {
    s = String(d).substring(0, 10);
  }
  // Valida formato YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'NULL';
  return `{^${s}}`;
}

/**
 * Formatea string escapando comillas simples y recortando a maxLen
 */
function fmtStr(v, maxLen) {
  return String(v == null ? '' : v)
    .substring(0, maxLen)
    .replace(/'/g, "''");
}

/**
 * Formatea número decimal
 */
function fmtNum(v, decimals = 2) {
  const n = parseFloat(v) || 0;
  return n.toFixed(decimals);
}

/**
 * Lógico VFP: .T. o .F.
 */
function fmtBool(v) {
  return v ? '.T.' : '.F.';
}

/**
 * Tamaño de contenedor en formato SISCOMMATE (3 dígitos: "020","040","045")
 * o "40HC" para high-cube
 */
function fmtSize(size) {
  if (!size) return '   ';
  const s = String(size).trim().toUpperCase();
  if (s === '40HC' || s === '40HQ') return '40H';
  const n = parseInt(s);
  if (!isNaN(n)) return String(n).padStart(3, '0');
  return s.substring(0, 3).padEnd(3, ' ');
}

module.exports = { setPath, execute, query, fmtDate, fmtStr, fmtNum, fmtBool, fmtSize };
