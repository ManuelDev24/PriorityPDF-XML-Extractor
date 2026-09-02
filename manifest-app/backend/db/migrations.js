// db/migrations.js — Migraciones que se aplican al arrancar
//
// Extraído de server.js (paso 4 de la separación backend/frontend).
// Todas son idempotentes: se pueden correr en cada arranque sin efecto
// secundario. El esquema base lo crea db/init.js (script de una sola vez).

const db = require('./connection');

// Agrega una columna solo si no existe todavía
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }
  return false;
}

function runMigrations({ bridgeHost, bridgePort }) {
  // ── Columnas agregadas después del esquema original ────────────────────────
  addColumnIfMissing('bills_of_lading', 'hacienda_client_ivu', 'TEXT');
  addColumnIfMissing('containers',      'size',                'TEXT');
  addColumnIfMissing('manifests',       'docking_number',      'TEXT');

  // ── Configuración persistente (bridge host/port, ruta DBF) ─────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`);
  // Parametrizado: antes se interpolaban las variables de entorno en el SQL
  const insSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  insSetting.run('bridge_host', String(bridgeHost));
  insSetting.run('bridge_port', String(bridgePort));
  insSetting.run('dbf_path',    '');

  // ── Mapeo XML ContainerType → tamaño SISCOMMATE ────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS container_type_map (
    xml_type TEXT PRIMARY KEY,
    size     TEXT NOT NULL,
    label    TEXT NOT NULL DEFAULT ''
  )`);
  const ctDefaults = [
    ['1','20','20ft Standard'],['2','20','20ft Refrigerado'],
    ['3','40','40ft Standard'],['4','40','40ft Refrigerado'],
    ['5','40HC','40ft High Cube'],['6','45','45ft High Cube'],
    ['7','20','20ft Open Top'],['8','40','40ft Open Top'],
    ['9','40','40ft Standard'],['10','20','20ft Flat Rack'],
    ['11','40','40ft Flat Rack'],['12','45','45ft Standard'],
    ['R','RORO','Roll-On Roll-Off'],['P','RORO','RORO/Plataforma'],
  ];
  const insCT = db.prepare(`INSERT OR IGNORE INTO container_type_map VALUES (?,?,?)`);
  ctDefaults.forEach(r => insCT.run(...r));

  // ── Items de carga múltiples por B/L (opcionalmente por contenedor) ────────
  db.exec(`CREATE TABLE IF NOT EXISTS bl_cargo_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    bl_id            INTEGER NOT NULL,
    manifest_id      INTEGER NOT NULL,
    container_no     TEXT,
    goods_name       TEXT NOT NULL DEFAULT '',
    gross_weight     REAL  NOT NULL DEFAULT 0,
    hacienda_item_code TEXT,
    hacienda_tariff  TEXT,
    seq              INTEGER NOT NULL DEFAULT 1
  )`);
}

module.exports = { runMigrations, addColumnIfMissing };
