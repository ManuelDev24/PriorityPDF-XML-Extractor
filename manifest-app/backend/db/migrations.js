// db/migrations.js — Migraciones que se aplican al arrancar
//
// Extraído de server.js (paso 4 de la separación backend/frontend).
// Todas son idempotentes: se pueden correr en cada arranque sin efecto
// secundario. El esquema base lo crea db/init.js (script de una sola vez).

const db = require('./connection');
const { VESSELS, PORT_MAPPINGS } = require('./catalogDefaults');

// Agrega una columna solo si no existe todavía
/**
 * Agrega una columna solo si no existe. Idempotente.
 * @param {string} table
 * @param {string} column
 * @param {string} definition Tipo SQL, por ejemplo TEXT
 * @returns {boolean} true si la agregó
 */
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }
  return false;
}

/**
 * Aplica las migraciones de arranque. Todas idempotentes: se pueden correr
 * en cada inicio sin efecto secundario.
 * @param {{bridgeHost?: string, bridgePort?: string|number, dbfPath?: string}} defaults Valores
 *   iniciales de settings, solo se usan la primera vez
 */
function runMigrations({
  bridgeHost = process.env.BRIDGE_HOST || 'localhost',
  bridgePort = process.env.BRIDGE_PORT || 5001,
  dbfPath = '',
} = {}) {
  // ── Columnas agregadas después del esquema original ────────────────────────
  addColumnIfMissing('bills_of_lading', 'hacienda_client_ivu', 'TEXT');
  addColumnIfMissing('containers',      'size',                'TEXT');
  addColumnIfMissing('manifests',       'docking_number',      'TEXT');

  // El IMO del buque nunca tuvo columna, pese a que el editor lo pide, la ruta
  // lo declara editable y el TXT de Hacienda lo escribe en [174:181]. Cualquier
  // PUT que lo incluyera fallaba con "no such column: imo", perdiendo de paso
  // todos los demás campos de esa misma petición, y en el TXT salía 0000000.
  addColumnIfMissing('manifests',       'imo',                 'TEXT');

  // Puerto de descarga: distinto de unloading_port (destino final) para carga
  // en tránsito, donde el contenedor se descarga en un puerto intermedio
  // antes de continuar hacia el destino. Pedido explícito 2026-09-03.
  addColumnIfMissing('manifests',       'discharge_port',      'TEXT');

  // ── Configuración persistente (bridge host/port, ruta DBF) ─────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`);
  // Parametrizado: antes se interpolaban las variables de entorno en el SQL
  const insSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
    WHERE settings.value=''
  `);
  insSetting.run('bridge_host', String(bridgeHost));
  insSetting.run('bridge_port', String(bridgePort));
  insSetting.run('dbf_path',    String(dbfPath || process.env.SISCOMMATE_DBF_PATH || ''));

  // Valores usados por parsers y generadores cuando un manifiesto no trae
  // puerto/carrier. Solo se aplican si todavía no hay una preferencia guardada.
  insSetting.run('default_loading_port',  'DRP');
  insSetting.run('default_unloading_port', 'SJU');
  insSetting.run('default_carrier_code',  'MPRIORO');

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
    ['13','48','48ft Standard'],
    ['R','RORO','Roll-On Roll-Off'],['P','RORO','RORO/Plataforma'],
  ];
  const insCT = db.prepare(`INSERT OR IGNORE INTO container_type_map VALUES (?,?,?)`);
  ctDefaults.forEach(r => insCT.run(...r));

  // ── Catálogo SISCOMMATE de buques y puertos ─────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS vessels (
    code    TEXT PRIMARY KEY,
    name    TEXT NOT NULL,
    imo     TEXT NOT NULL DEFAULT '',
    carrier TEXT NOT NULL DEFAULT '',
    scac    TEXT NOT NULL DEFAULT ''
  )`);
  const insVessel = db.prepare(
    `INSERT OR IGNORE INTO vessels (code,name,imo,carrier,scac) VALUES (?,?,?,?,?)`
  );
  VESSELS.forEach(v => insVessel.run(v.code, v.name, v.imo, v.carrier, v.scac));

  db.exec(`CREATE TABLE IF NOT EXISTS port_mappings (
    dga_code        TEXT PRIMARY KEY,
    siscommate_code TEXT NOT NULL,
    label           TEXT NOT NULL DEFAULT ''
  )`);
  const insPortMapping = db.prepare(
    `INSERT OR IGNORE INTO port_mappings (dga_code,siscommate_code,label) VALUES (?,?,?)`
  );
  PORT_MAPPINGS.forEach(([dga, siscommate]) => insPortMapping.run(dga, siscommate, ''));

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
