// backend/services/dataAudit/hojas.js — Unica fuente de verdad de las 11
// hojas del Excel de auditoria: que tabla/origen alimenta cada una, cual es
// su clave tecnica (para identificar la fila al reinyectar) y que campos son
// editables. exportar.js y reinyectar.js usan esta misma lista — asi nunca
// pueden desalinearse sobre que campo vive en que hoja.
//
// Las hojas con leerActual/escribirCambio en null son de SOLO LECTURA: se
// exportan para auditoria pero reinyectar.js las ignora (ver el filtro en
// reinyectar.js). Hoy es solo SISCOMMATE_Manifiestos (el INSERT real usa ~25
// columnas con logica de negocio no trivial — ver SiscommateBridge.cs — y no
// hay evidencia de que ese dato se corrija con frecuencia, a diferencia de
// nombres/pesos/documentos).

const {
  deduplicarConsignadores, deduplicarConsignatarios,
  CAMPOS_CONSIGNADOR, CAMPOS_CONSIGNATARIO,
  actualizarConsignadorPorNombre, actualizarConsignatarioPorNombre,
} = require('./dedupe');
const { actualizarFilaSqlite } = require('./sqliteWriter');

const CAMPOS_EDITABLES_CLIENTS = ['name', 'ss', 'taxid', 'add1', 'add2', 'add3', 'phone1', 'phone2', 'ivu'];
const CAMPOS_EDITABLES_BL = [
  'goods_name', 'package_qty', 'gross_weight', 'value',
  'hacienda_item_code', 'hacienda_tariff', 'hacienda_container_no',
  'hacienda_client_ss', 'hacienda_client_ivu', 'notes',
];
const CAMPOS_EDITABLES_MANIFESTS = [
  'vessel_name', 'loading_port', 'unloading_port', 'discharge_port',
  'departure_date', 'arrival_date', 'manifest_no', 'carrier_code', 'docking_number', 'imo',
];
const CAMPOS_EDITABLES_CONTAINERS = ['container_type', 'package_code', 'amount', 'gross_weight', 'net_weight', 'seal_no1', 'size'];
const CAMPOS_EDITABLES_CUSTOMER = ['ss', 'code', 'type', 'taxid', 'add1', 'add2', 'add3', 'phone1', 'phone2', 'fax1', 'fax2', 'ivu'];
const CAMPOS_EDITABLES_BOL = ['consigne', 'exporter'];
const CAMPOS_EDITABLES_BOLCONT = ['contain', 'size'];
const CAMPOS_EDITABLES_BOLITEM = ['qty', 'weight', 'desc', 'code', 'value'];

function coincideClave(fila, claves) {
  return Object.keys(claves).every(k => String(fila[k] ?? '').trim() === String(claves[k]).trim());
}

/**
 * @typedef {object} HojaSpec
 * @property {string} nombre
 * @property {string[]} camposClave
 * @property {string[]} camposEditables
 * @property {(deps: {db: object, siscommate: object}) => Promise<object[]>|object[]} obtenerFilas
 * @property {null | (deps: {db: object, siscommate: object}, claves: Record<string, any>) => Promise<object|null>|object|null} leerActual
 * @property {null | (deps: {db: object, siscommate: object}, claves: Record<string, any>, cambios: object, filaFinal: object) => Promise<void>|void} escribirCambio
 * @property {string} [columnaDuplicados] Columna donde un valor repetido es un problema real
 *   (dos clientes/consignadores con el mismo nombre) — se resalta con formato
 *   condicional nativo de Excel (vivo: si corriges uno, el color desaparece solo).
 * @property {string[]} [columnasEspeciales] Columnas de texto libre que SISCOMMATE
 *   limpia a solo A-Z/0-9/espacio antes de guardar (ver limpiarTextoLibre en
 *   siscommateClient.js) — se resaltan si traen acentos, puntuación u otro
 *   caracter que se va a perder al enviarse.
 */

/** @returns {HojaSpec[]} */
function construirHojas() {
  return [
    {
      nombre: 'SQLite_Clientes',
      camposClave: ['id'],
      camposEditables: CAMPOS_EDITABLES_CLIENTS,
      obtenerFilas: ({ db }) => db.prepare('SELECT * FROM clients ORDER BY name').all(),
      leerActual: ({ db }, claves) => db.prepare('SELECT * FROM clients WHERE id = ?').get(claves.id) || null,
      escribirCambio: ({ db }, claves, cambios) => actualizarFilaSqlite(db, 'clients', claves, cambios),
      columnaDuplicados: 'name',
      columnasEspeciales: ['name'],
    },
    {
      nombre: 'SQLite_Consignadores',
      camposClave: ['consignor_name'],
      camposEditables: CAMPOS_CONSIGNADOR.filter(c => c !== 'consignor_name'),
      obtenerFilas: ({ db }) => deduplicarConsignadores(db.prepare('SELECT * FROM bills_of_lading').all()),
      leerActual: ({ db }, claves) =>
        db.prepare('SELECT * FROM bills_of_lading WHERE consignor_name = ? LIMIT 1').get(claves.consignor_name) || null,
      escribirCambio: ({ db }, claves, cambios) => actualizarConsignadorPorNombre(db, claves.consignor_name, cambios),
      columnaDuplicados: 'consignor_name',
      columnasEspeciales: ['consignor_name'],
    },
    {
      nombre: 'SQLite_Consignatarios',
      camposClave: ['consignee_name'],
      camposEditables: CAMPOS_CONSIGNATARIO.filter(c => c !== 'consignee_name'),
      obtenerFilas: ({ db }) => deduplicarConsignatarios(db.prepare('SELECT * FROM bills_of_lading').all()),
      leerActual: ({ db }, claves) =>
        db.prepare('SELECT * FROM bills_of_lading WHERE consignee_name = ? LIMIT 1').get(claves.consignee_name) || null,
      escribirCambio: ({ db }, claves, cambios) => actualizarConsignatarioPorNombre(db, claves.consignee_name, cambios),
      columnaDuplicados: 'consignee_name',
      columnasEspeciales: ['consignee_name'],
    },
    {
      nombre: 'SQLite_Manifiestos',
      camposClave: ['id'],
      camposEditables: CAMPOS_EDITABLES_MANIFESTS,
      obtenerFilas: ({ db }) => db.prepare('SELECT * FROM manifests ORDER BY id').all(),
      leerActual: ({ db }, claves) => db.prepare('SELECT * FROM manifests WHERE id = ?').get(claves.id) || null,
      escribirCambio: ({ db }, claves, cambios) => actualizarFilaSqlite(db, 'manifests', claves, cambios),
    },
    {
      nombre: 'SQLite_BLs',
      camposClave: ['id'],
      camposEditables: CAMPOS_EDITABLES_BL,
      obtenerFilas: ({ db }) => db.prepare('SELECT * FROM bills_of_lading ORDER BY id').all(),
      leerActual: ({ db }, claves) => db.prepare('SELECT * FROM bills_of_lading WHERE id = ?').get(claves.id) || null,
      escribirCambio: ({ db }, claves, cambios) => actualizarFilaSqlite(db, 'bills_of_lading', claves, cambios),
      columnasEspeciales: ['goods_name'],
    },
    {
      nombre: 'SQLite_Contenedores',
      camposClave: ['id'],
      camposEditables: CAMPOS_EDITABLES_CONTAINERS,
      obtenerFilas: ({ db }) => {
        const containers = db.prepare('SELECT * FROM containers ORDER BY id').all();
        const links = db.prepare('SELECT container_no, bl_no FROM container_bl').all();
        const blsPorContenedor = new Map();
        for (const l of links) {
          const lista = blsPorContenedor.get(l.container_no) || [];
          lista.push(l.bl_no);
          blsPorContenedor.set(l.container_no, lista);
        }
        // bls_asociados es informativo (viene de container_bl) — no es un
        // campo editable, corregirlo no reasigna vinculos.
        return containers.map(c => ({ ...c, bls_asociados: (blsPorContenedor.get(c.container_no) || []).join(', ') }));
      },
      leerActual: ({ db }, claves) => db.prepare('SELECT * FROM containers WHERE id = ?').get(claves.id) || null,
      escribirCambio: ({ db }, claves, cambios) => actualizarFilaSqlite(db, 'containers', claves, cambios),
    },
    {
      nombre: 'SISCOMMATE_Customers',
      camposClave: ['name'],
      camposEditables: CAMPOS_EDITABLES_CUSTOMER,
      obtenerFilas: ({ siscommate }) => siscommate.obtenerTablaCompleta('CUSTOMER'),
      leerActual: async ({ siscommate }, claves) => {
        const filas = await siscommate.obtenerTablaCompleta('CUSTOMER');
        return filas.find(f => String(f.name || '').trim() === claves.name) || null;
      },
      escribirCambio: ({ siscommate }, claves, cambios, filaFinal) =>
        siscommate.actualizarClienteSiscommate(claves.name, filaFinal),
      columnaDuplicados: 'name',
      columnasEspeciales: ['name'],
    },
    {
      nombre: 'SISCOMMATE_Manifiestos',
      camposClave: ['manifest'],
      camposEditables: [],
      obtenerFilas: ({ siscommate }) => siscommate.obtenerTablaCompleta('MANIFEST'),
      leerActual: null,
      escribirCambio: null,
    },
    {
      nombre: 'SISCOMMATE_BLs',
      camposClave: ['manifest', 'bolno'],
      camposEditables: CAMPOS_EDITABLES_BOL,
      obtenerFilas: ({ siscommate }) => siscommate.obtenerTablaCompleta('BOL'),
      leerActual: async ({ siscommate }, claves) => {
        const filas = await siscommate.obtenerTablaCompleta('BOL');
        return filas.find(f => coincideClave(f, claves)) || null;
      },
      escribirCambio: ({ siscommate }, claves, cambios, filaFinal) =>
        siscommate.actualizarBolSiscommate(claves.manifest, claves.bolno, filaFinal),
      columnasEspeciales: ['consigne', 'exporter'],
    },
    {
      nombre: 'SISCOMMATE_Contenedores',
      camposClave: ['manifest', 'bolno', 'control'],
      camposEditables: CAMPOS_EDITABLES_BOLCONT,
      obtenerFilas: ({ siscommate }) => siscommate.obtenerTablaCompleta('BOLCONT'),
      leerActual: async ({ siscommate }, claves) => {
        const filas = await siscommate.obtenerTablaCompleta('BOLCONT');
        return filas.find(f => coincideClave(f, claves)) || null;
      },
      escribirCambio: ({ siscommate }, claves, cambios, filaFinal) =>
        siscommate.actualizarBolcontSiscommate(claves.manifest, claves.bolno, claves.control, filaFinal),
    },
    {
      nombre: 'SISCOMMATE_Items',
      camposClave: ['manifest', 'bolno', 'control'],
      camposEditables: CAMPOS_EDITABLES_BOLITEM,
      obtenerFilas: ({ siscommate }) => siscommate.obtenerTablaCompleta('BOLITEM'),
      leerActual: async ({ siscommate }, claves) => {
        const filas = await siscommate.obtenerTablaCompleta('BOLITEM');
        return filas.find(f => coincideClave(f, claves)) || null;
      },
      escribirCambio: ({ siscommate }, claves, cambios, filaFinal) =>
        siscommate.actualizarBolitemSiscommate(claves.manifest, claves.bolno, claves.control, filaFinal),
    },
  ];
}

module.exports = { construirHojas };
