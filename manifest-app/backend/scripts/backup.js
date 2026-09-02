// scripts/backup.js — Respaldo de manifest.db
//
// Ejecutar:  npm run backup
//
// POR QUÉ NO SE COPIA EL ARCHIVO Y YA:
// La base corre en modo WAL. Copiar manifest.db en caliente con xcopy puede
// producir un archivo inconsistente, porque las escrituras más recientes viven
// en manifest.db-wal y no en el archivo principal. Se usa la API de backup de
// SQLite, que es segura con la base en uso y no requiere detener el servicio.
//
// Configuración por variables de entorno:
//   BACKUP_DIR    carpeta destino        (por defecto: <raíz>/backups)
//   BACKUP_KEEP   cuántos conservar      (por defecto: 30)

const fs   = require('fs');
const path = require('path');
const db   = require('../db/connection');

const BACKUP_DIR  = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP) || 30;

// Prefijo propio: la rotación solo borra archivos que este script creó.
const PREFIJO = 'manifest-';
const SUFIJO  = '.db';

function marcaDeTiempo() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// Borra los respaldos más viejos, conservando los BACKUP_KEEP más recientes.
// Solo toca archivos con el patrón propio; ignora cualquier otra cosa.
function rotar() {
  const propios = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith(PREFIJO) && f.endsWith(SUFIJO))
    .map(f => ({ nombre: f, ruta: path.join(BACKUP_DIR, f) }))
    .sort((a, b) => b.nombre.localeCompare(a.nombre)); // más reciente primero

  const sobrantes = propios.slice(BACKUP_KEEP);
  sobrantes.forEach(x => {
    fs.unlinkSync(x.ruta);
    console.log(`  eliminado (rotación): ${x.nombre}`);
  });
  return { conservados: Math.min(propios.length, BACKUP_KEEP), eliminados: sobrantes.length };
}

async function main() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    console.log(`Carpeta creada: ${BACKUP_DIR}`);
  }

  const destino = path.join(BACKUP_DIR, `${PREFIJO}${marcaDeTiempo()}${SUFIJO}`);
  console.log(`Respaldando ${db.name}`);
  console.log(`         -> ${destino}`);

  await db.backup(destino);

  const tam = fs.statSync(destino).size;
  console.log(`[OK] Respaldo completo: ${mb(tam)}`);

  // Verificación: el respaldo debe abrirse y tener las tablas principales.
  // Un archivo que no se puede leer no es un respaldo.
  const Database = require('better-sqlite3');
  const copia = new Database(destino, { readonly: true });
  const manifiestos = copia.prepare('SELECT COUNT(*) n FROM manifests').get().n;
  const bls         = copia.prepare('SELECT COUNT(*) n FROM bills_of_lading').get().n;
  const integridad  = copia.pragma('integrity_check', { simple: true });
  copia.close();

  // Abrir la copia para verificarla deja archivos -shm y -wal al lado. La
  // rotación solo mira los .db, así que si no se limpian aquí se acumulan para
  // siempre. Se borran únicamente los dos derivados del respaldo recién hecho.
  for (const sufijo of ['-shm', '-wal']) {
    const suelto = destino + sufijo;
    if (fs.existsSync(suelto)) fs.unlinkSync(suelto);
  }

  if (integridad !== 'ok') {
    console.error(`[ERROR] El respaldo no pasa integrity_check: ${integridad}`);
    process.exit(1);
  }
  console.log(`[OK] Verificado: ${manifiestos} manifiestos, ${bls} B/L, integridad ok`);

  const r = rotar();
  console.log(`[OK] ${r.conservados} respaldos conservados${r.eliminados ? `, ${r.eliminados} eliminados` : ''}`);
}

main().catch(err => {
  console.error('[ERROR] Falló el respaldo:', err.message);
  process.exit(1);
});
