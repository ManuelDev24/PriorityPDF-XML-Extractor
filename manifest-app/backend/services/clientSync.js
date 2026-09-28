// services/clientSync.js — Catálogo local de clientes en sincronía con
// SISCOMMATE, y detección de nombres parecidos (posible error de digitación).
//
// SISCOMMATE (CUSTOMER.DBF) es la fuente real — ella corrige ahí, no en esta
// app. El catálogo local `clients` es un caché que se refresca a demanda
// (botón manual en Admin, ver routes/catalogs.js) para no depender de
// consultar el bridge en cada carga de PDF.

const db = require('../db/connection');
const { obtenerMuestra, obtenerExportadoresSiscommate } = require('./siscommateClient');

/**
 * Trae TODO el catálogo CUSTOMER de SISCOMMATE y lo mezcla con el catálogo
 * local `clients`: actualiza el existente por nombre exacto, o lo crea.
 * Nunca borra nada — un cliente que ya no está en SISCOMMATE simplemente no
 * se toca, sigue disponible localmente.
 *
 * Se empareja SOLO por nombre, nunca por SS/EIN — confirmado contra datos
 * reales que el SS/EIN NO es único en CUSTOMER: hay valores genéricos
 * compartidos por cientos de clientes distintos (ej. un SS "comodín" usado
 * por 600+ importadores distintos bajo el mismo bróker). Emparejar por SS
 * colapsaba a todos esos clientes en un solo registro local, sobrescrito una
 * y otra vez — el nombre, en cambio, sí resultó único en la práctica.
 * @returns {Promise<{total_siscommate: number, creados: number, actualizados: number, sin_cambios: number}>}
 */
async function sincronizarClientesDesdeSiscommate() {
  // CUSTOMER en producción ronda las ~8,000 filas (confirmado) — un límite
  // holgado que cubre crecimiento futuro sin arriesgar truncar el volcado.
  const filas = await obtenerMuestra('CUSTOMER', 50000);

  const buscarPorNombre = db.prepare(`SELECT id, name, ss, code, type, taxid, add1, add2, add3, phone1, phone2, fax1, fax2, ivu FROM clients WHERE UPPER(name)=UPPER(?)`);
  const insertar = db.prepare(`
    INSERT INTO clients (name,ss,code,type,taxid,add1,add2,add3,phone1,phone2,fax1,fax2,ivu)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const actualizar = db.prepare(`
    UPDATE clients SET name=?,ss=?,code=?,type=?,taxid=?,add1=?,add2=?,add3=?,phone1=?,phone2=?,fax1=?,fax2=?,ivu=?
    WHERE id=?
  `);

  let creados = 0, actualizados = 0, sinCambios = 0;

  const sincronizar = db.transaction(() => {
    filas.forEach(f => {
      const nombre = (f.name || '').trim();
      if (!nombre) return;
      const ss = (f.ss || '').trim();
      const existente = buscarPorNombre.get(nombre);

      const valores = [
        nombre, ss, f.code || '', f.type || '', f.taxid || '',
        f.add1 || '', f.add2 || '', f.add3 || '', f.phone1 || '', f.phone2 || '',
        f.fax1 || '', f.fax2 || '', f.ivu || '',
      ];

      if (!existente) {
        insertar.run(...valores);
        creados++;
        return;
      }

      const cambio = existente.name !== nombre || (existente.ss || '') !== ss ||
        (existente.code || '') !== (f.code || '') || (existente.type || '') !== (f.type || '') ||
        (existente.taxid || '') !== (f.taxid || '') || (existente.add1 || '') !== (f.add1 || '') ||
        (existente.add2 || '') !== (f.add2 || '') || (existente.add3 || '') !== (f.add3 || '') ||
        (existente.phone1 || '') !== (f.phone1 || '') || (existente.phone2 || '') !== (f.phone2 || '') ||
        (existente.fax1 || '') !== (f.fax1 || '') || (existente.fax2 || '') !== (f.fax2 || '') ||
        (existente.ivu || '') !== (f.ivu || '');

      if (cambio) {
        actualizar.run(...valores, existente.id);
        actualizados++;
      } else {
        sinCambios++;
      }
    });
  });
  sincronizar();

  return { total_siscommate: filas.length, creados, actualizados, sin_cambios: sinCambios };
}

/**
 * Normaliza texto para comparar: mayúsculas, sin acentos, sin puntuación,
 * espacios colapsados. Misma idea que quitarAcentos/limpiarTextoLibre de
 * txtGenerator/siscommateClient, pero sin depender de esos módulos — aquí
 * solo importa comparar, no lo que se manda a ningún lado.
 * @param {string} texto
 * @returns {string}
 */
function normalizarParaComparar(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos (marcas combinantes tras NFD)
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Distancia de Levenshtein clásica (número mínimo de ediciones de un
 * carácter para convertir a en b).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function distanciaLevenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + costo);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/**
 * Similitud entre 0 (nada parecido) y 1 (idéntico), basada en Levenshtein
 * normalizado por la longitud del texto más largo.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function similitudTexto(a, b) {
  const na = normalizarParaComparar(a), nb = normalizarParaComparar(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  return 1 - distanciaLevenshtein(na, nb) / maxLen;
}

const UMBRAL_PARECIDO = 0.82;

/**
 * Busca en el catálogo local un nombre PARECIDO (no idéntico, no ya
 * contenido uno en el otro — esos casos ya los resuelve emparejarClienteLocal
 * de itemClientAnalysis.js) al que se está por guardar — para avisar de un
 * posible error de digitación, nunca para corregir solo. Ignora coincidencias
 * exactas o por substring a propósito: esas no son "parecidas", son la misma.
 * @param {string} nombre
 * @returns {{name: string, ss: string, similitud: number}|null}
 */
function buscarClienteParecido(nombre) {
  const norm = normalizarParaComparar(nombre);
  if (!norm || norm.length < 4) return null;

  const clientes = db.prepare(`SELECT name, ss FROM clients WHERE name IS NOT NULL AND name != ''`).all();
  let mejor = null;
  for (const c of clientes) {
    const normC = normalizarParaComparar(c.name);
    if (!normC || normC === norm) continue;
    if (normC.includes(norm) || norm.includes(normC)) continue; // ya lo resuelve el match por substring
    const sim = similitudTexto(norm, normC);
    if (sim >= UMBRAL_PARECIDO && (!mejor || sim > mejor.similitud)) {
      mejor = { name: c.name, ss: c.ss || '', similitud: sim };
    }
  }
  return mejor;
}

/**
 * Agrupa nombres parecidos entre sí (mismo criterio que buscarClienteParecido:
 * Levenshtein normalizado >= UMBRAL_PARECIDO) y devuelve UNA forma canónica
 * por grupo — la variante más larga, normalmente la más completa ("ACME
 * CORP S.A." en vez de "ACME CORP" o "ACME"). Usa union-find para que la
 * agrupación sea transitiva (A~B y B~C agrupan A, B y C juntos aunque A y C
 * no se parezcan directo) y agrupa primero por las primeras 3 letras
 * normalizadas para no comparar cada nombre contra TODOS los demás — con
 * miles de nombres reales de SISCOMMATE, la comparación completa (n²)
 * tardaría demasiado.
 * @param {string[]} nombres
 * @returns {string[]} Nombres canónicos, uno por grupo, ordenados alfabéticamente
 */
function consolidarNombresParecidos(nombres) {
  const unicos = Array.from(new Set(nombres.map(n => String(n || '').trim()).filter(Boolean)));

  const buckets = new Map();
  unicos.forEach((nombre, i) => {
    const clave = normalizarParaComparar(nombre).slice(0, 3);
    if (!clave) return;
    if (!buckets.has(clave)) buckets.set(clave, []);
    buckets.get(clave).push(i);
  });

  const padre = unicos.map((_, i) => i);
  const encontrar = i => (padre[i] === i ? i : (padre[i] = encontrar(padre[i])));
  const unir = (a, b) => { const ra = encontrar(a), rb = encontrar(b); if (ra !== rb) padre[ra] = rb; };

  for (const indices of buckets.values()) {
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        if (similitudTexto(unicos[indices[a]], unicos[indices[b]]) >= UMBRAL_PARECIDO) {
          unir(indices[a], indices[b]);
        }
      }
    }
  }

  const grupos = new Map();
  unicos.forEach((nombre, i) => {
    const raiz = encontrar(i);
    const lista = grupos.get(raiz) || [];
    lista.push(nombre);
    grupos.set(raiz, lista);
  });

  return Array.from(grupos.values())
    .map(grupo => grupo.reduce((mejor, actual) => (actual.length > mejor.length ? actual : mejor)))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Trae TODOS los nombres de exportador/consignador del histórico real de
 * SISCOMMATE (BOL.exporter — no hay tabla propia de consignadores allá, a
 * diferencia de CUSTOMER para consignatarios), los consolida (agrupa
 * variantes del mismo nombre real) y guarda las formas canónicas nuevas en
 * `consignor_catalog`. Nunca borra nada — igual que sincronizarClientesDesdeSiscommate.
 * @returns {Promise<{total_siscommate: number, canonicos: number, nuevos: number}>}
 */
async function sincronizarConsignadoresDesdeSiscommate() {
  const nombresRaw = await obtenerExportadoresSiscommate();
  const canonicos = consolidarNombresParecidos(nombresRaw);

  const existentes = new Set(db.prepare('SELECT name FROM consignor_catalog').all().map(r => r.name));
  const insertar = db.prepare('INSERT OR IGNORE INTO consignor_catalog (name) VALUES (?)');
  let nuevos = 0;
  const transaccion = db.transaction(() => {
    canonicos.forEach(nombre => {
      if (!existentes.has(nombre)) { insertar.run(nombre); nuevos++; }
    });
  });
  transaccion();

  return { total_siscommate: nombresRaw.length, canonicos: canonicos.length, nuevos };
}

module.exports = {
  sincronizarClientesDesdeSiscommate,
  sincronizarConsignadoresDesdeSiscommate,
  consolidarNombresParecidos,
  similitudTexto,
  buscarClienteParecido,
  normalizarParaComparar,
  UMBRAL_PARECIDO,
};
