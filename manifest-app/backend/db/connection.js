// db/connection.js — Conexión única y de larga vida a SQLite
//
// Extraído de server.js (paso 4 de la separación backend/frontend).
//
// Antes: cada request hacía getDB() … db.close(), abriendo y cerrando el
// archivo ~30 veces por pantalla. better-sqlite3 es síncrono y está pensado
// para una sola conexión reutilizada — no hay pool que administrar.
//
// Los PRAGMA se aplican una vez, al arrancar el proceso.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'manifest.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Cierre ordenado: sin esto, un WAL abierto puede quedar sin checkpoint.
function closeOnExit() {
  try { db.close(); } catch (_) { /* ya estaba cerrada */ }
}
process.on('exit', closeOnExit);
process.on('SIGINT',  () => { closeOnExit(); process.exit(0); });
process.on('SIGTERM', () => { closeOnExit(); process.exit(0); });

// La ruta del archivo también está disponible como db.name (API de better-sqlite3)
module.exports = db;
