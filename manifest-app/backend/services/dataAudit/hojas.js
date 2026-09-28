// backend/services/dataAudit/hojas.js — Unica fuente de verdad de las hojas
// del Excel de auditoria: que tabla/origen alimenta cada una, cual es su
// clave tecnica (para identificar la fila al reinyectar) y que campos son
// editables. exportar.js y reinyectar.js usan esta misma lista — asi nunca
// pueden desalinearse sobre que campo vive en que hoja.
//
// Solo lee SQLite — nunca golpea el bridge de SISCOMMATE al exportar. Las
// hojas que antes traian el historico completo de SISCOMMATE (Manifiestos,
// BLs, Contenedores, Items) se quitaron: forzaban un volcado sin limite que
// tumbaba el bridge (ver commit e1ff3b3). "Clientes" SI representa a
// SISCOMMATE (CUSTOMER.DBF), pero via el cache local `clients`, que se
// sincroniza aparte con un limite seguro (ver clientSync.js) — nunca en el
// momento del export.

const {
  deduplicarConsignadores, deduplicarConsignatarios,
  CAMPOS_CONSIGNADOR, CAMPOS_CONSIGNATARIO,
  actualizarConsignadorPorNombre, actualizarConsignatarioPorNombre,
} = require('./dedupe');
const { actualizarFilaSqlite } = require('./sqliteWriter');
const { camposFaltantes, detectarPosiblesDuplicados } = require('./calidad');

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

const MAPEO_FALTANTES_CLIENTS = { documento: 'ss', direccion: 'add1', telefono: 'phone1' };
const MAPEO_FALTANTES_CONSIGNADOR = { documento: 'consignor_document_no', direccion: 'consignor_street', telefono: 'consignor_tel' };
const MAPEO_FALTANTES_CONSIGNATARIO = { documento: 'consignee_document_no', direccion: 'consignee_street', telefono: 'consignee_tel' };

/**
 * @typedef {object} HojaSpec
 * @property {string} nombre
 * @property {string[]} camposClave
 * @property {string[]} camposEditables
 * @property {(deps: {db: object, siscommate?: object}) => Promise<object[]>|object[]} obtenerFilas
 * @property {null | (deps: {db: object, siscommate: object}, claves: Record<string, any>) => Promise<object|null>|object|null} leerActual
 * @property {null | (deps: {db: object, siscommate: object}, claves: Record<string, any>, cambios: object, filaFinal: object, filaActual: object) => Promise<void>|void} escribirCambio
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
      // Este cliente ES la fuente CUSTOMER.DBF de SISCOMMATE, cacheada
      // localmente por clientSync.js — por eso ya no existe una hoja
      // "SISCOMMATE_Customers" aparte, seria la misma tabla dos veces.
      obtenerFilas: ({ db }) => {
        const filas = db.prepare('SELECT * FROM clients ORDER BY name').all();
        const duplicados = detectarPosiblesDuplicados(filas.map(f => f.name));
        return filas.map((f, i) => ({
          ...f,
          _campos_faltantes: camposFaltantes(f, MAPEO_FALTANTES_CLIENTS),
          _posible_duplicado: duplicados[i],
        }));
      },
      leerActual: ({ db }, claves) => db.prepare('SELECT * FROM clients WHERE id = ?').get(claves.id) || null,
      // Escribe en los DOS lados: el cache local Y el CUSTOMER.DBF real — se
      // identifica en SISCOMMATE por el nombre ANTERIOR (filaActual.name),
      // igual que ya hace el editor de clientes en Admin, porque el nombre
      // mismo puede ser justo el campo que se esta corrigiendo. Si el push a
      // SISCOMMATE falla, el cambio local ya quedo aplicado — se reporta como
      // error en el log de auditoria, y se puede reintentar solo el lado
      // SISCOMMATE desde "Editar cliente" en Admin sin perder la correccion.
      escribirCambio: async ({ db, siscommate }, claves, cambios, filaFinal, filaActual) => {
        actualizarFilaSqlite(db, 'clients', claves, cambios);
        await siscommate.actualizarClienteSiscommate(filaActual.name, filaFinal);
      },
      columnasEspeciales: ['name'],
    },
    {
      nombre: 'SQLite_Consignadores',
      camposClave: ['consignor_name'],
      camposEditables: CAMPOS_CONSIGNADOR.filter(c => c !== 'consignor_name'),
      obtenerFilas: ({ db }) => {
        const filas = deduplicarConsignadores(db.prepare('SELECT * FROM bills_of_lading').all());
        const duplicados = detectarPosiblesDuplicados(filas.map(f => f.consignor_name));
        return filas.map((f, i) => ({
          ...f,
          _campos_faltantes: camposFaltantes(f, MAPEO_FALTANTES_CONSIGNADOR),
          _posible_duplicado: duplicados[i],
        }));
      },
      leerActual: ({ db }, claves) =>
        db.prepare('SELECT * FROM bills_of_lading WHERE consignor_name = ? LIMIT 1').get(claves.consignor_name) || null,
      escribirCambio: ({ db }, claves, cambios) => actualizarConsignadorPorNombre(db, claves.consignor_name, cambios),
      columnasEspeciales: ['consignor_name'],
    },
    {
      nombre: 'SQLite_Consignatarios',
      camposClave: ['consignee_name'],
      camposEditables: CAMPOS_CONSIGNATARIO.filter(c => c !== 'consignee_name'),
      obtenerFilas: ({ db }) => {
        const filas = deduplicarConsignatarios(db.prepare('SELECT * FROM bills_of_lading').all());
        const duplicados = detectarPosiblesDuplicados(filas.map(f => f.consignee_name));
        return filas.map((f, i) => ({
          ...f,
          _campos_faltantes: camposFaltantes(f, MAPEO_FALTANTES_CONSIGNATARIO),
          _posible_duplicado: duplicados[i],
        }));
      },
      leerActual: ({ db }, claves) =>
        db.prepare('SELECT * FROM bills_of_lading WHERE consignee_name = ? LIMIT 1').get(claves.consignee_name) || null,
      escribirCambio: ({ db }, claves, cambios) => actualizarConsignatarioPorNombre(db, claves.consignee_name, cambios),
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
  ];
}

module.exports = { construirHojas };
