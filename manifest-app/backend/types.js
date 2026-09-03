// types.js — Tipos compartidos del backend, declarados con JSDoc.
//
// Este archivo NO tiene código: existe solo para que los módulos se refieran a
// las mismas formas de datos con `import('../types')`. Verificar con:
//   npm run typecheck
//
// POR QUÉ IMPORTA TIPAR ESTO:
// `ParsedBL` viaja desde los parsers hasta un INSERT con 45 marcadores
// posicionales en routes/manifests.js. Si el orden de los campos y el de los
// marcadores se desalinean, los datos entran corridos de columna — en silencio,
// sin error, y ningún test lo detecta si ambos lados se mueven juntos. Tener la
// forma declarada en un solo lugar es la primera defensa.

/**
 * Encabezado del manifiesto tal como sale de un archivo XML o PDF.
 * @typedef {object} ParsedHeader
 * @property {string} voyage_no
 * @property {string} vessel_code
 * @property {string} [vessel_name]     Solo lo produce el parser de US Customs 1302
 * @property {string} biz_company_code
 * @property {string} loading_port
 * @property {string} unloading_port
 * @property {string} departure_date    YYYY-MM-DD
 * @property {string} arrival_date      YYYY-MM-DD
 * @property {string} [manifest_no]     Solo US Customs 1302
 * @property {string} [carrier_code]    Solo US Customs 1302
 */

/**
 * B/L extraído de un manifiesto. Los 42 primeros campos salen del archivo; los
 * `hacienda_*` son opcionales porque los completa el parser 1302 (cuando el
 * consignatario trae EIN) o la ruta de carga al cruzar con el catálogo de
 * clientes.
 *
 * El orden aquí espeja la lista de columnas del INSERT en routes/manifests.js.
 * @typedef {object} ParsedBL
 * @property {string} bl_no
 * @property {string} bl_type
 * @property {string} transit_type
 * @property {string} unloading_port_code
 * @property {string} goods_name
 * @property {string} package_unit_code
 * @property {number} package_qty
 * @property {number} gross_weight
 * @property {number} value
 * @property {string} consignor_type
 * @property {string} consignor_code
 * @property {string} consignor_name
 * @property {string} consignor_document_type
 * @property {string} consignor_document_no
 * @property {string} consignor_country_code
 * @property {string} consignor_tel
 * @property {string} consignor_email
 * @property {string} consignor_street
 * @property {string} consignor_city
 * @property {string} consignor_zip
 * @property {string} consignee_type
 * @property {string} consignee_code
 * @property {string} consignee_name
 * @property {string} consignee_document_type
 * @property {string} consignee_document_no
 * @property {string} consignee_country_code
 * @property {string} consignee_tel
 * @property {string} consignee_email
 * @property {string} consignee_street
 * @property {string} consignee_city
 * @property {string} consignee_zip
 * @property {string} notify_name
 * @property {string} notify_code
 * @property {string} notify_document_type
 * @property {string} notify_document_no
 * @property {string} notify_country_code
 * @property {string} notify_tel
 * @property {string} notify_email
 * @property {string} notify_street
 * @property {string} notify_city
 * @property {string} notify_zip
 * @property {string} [hacienda_container_no]
 * @property {string} [hacienda_client_ss]
 * @property {string} [hacienda_client_ivu]
 */

/**
 * Contenedor extraído del manifiesto.
 * @typedef {object} ParsedContainer
 * @property {string} container_no
 * @property {string} container_type      Siempre 'R' (RORO) en este flujo
 * @property {string} xml_container_type  Código <ContainerType> del XML, para mapear el tamaño
 * @property {string} package_code
 * @property {number} amount
 * @property {number} gross_weight
 * @property {number} net_weight
 * @property {string} seal_no1
 * @property {string} [size]              Solo lo trae el parser 1302; el XML lo resuelve por mapeo
 */

/**
 * Vínculo entre un B/L y un contenedor.
 * @typedef {object} ContainerBLLink
 * @property {string} bl_no
 * @property {string} container_no
 */

/**
 * Item de carga individual. Solo lo produce el parser de US Customs 1302, que
 * genera una entrada por cada línea del manifiesto (permite varios ítems o
 * vehículos por B/L).
 * @typedef {object} ParsedCargoItem
 * @property {string} bl_no
 * @property {string|null} container_no
 * @property {string|null} vin           Vehículos: número de chasis
 * @property {string} goods_name
 * @property {number} gross_weight
 * @property {number} package_qty
 * @property {string} package_unit
 */

/**
 * Resultado completo de parsear un manifiesto.
 *
 * `cargoItems` solo viene del formato US Customs 1302. El parser genérico de la
 * DGA y el de XML no lo producen, y la ruta de carga lo contempla.
 * @typedef {object} ParsedManifest
 * @property {ParsedHeader} header
 * @property {ParsedBL[]} bls
 * @property {ParsedContainer[]} containers
 * @property {ContainerBLLink[]} containerBLs
 * @property {ParsedCargoItem[]} [cargoItems]
 */

/**
 * Bloque de dirección (shipper / consignee / notify) extraído de un PDF 1302.
 * @typedef {object} PdfParty
 * @property {string} name
 * @property {string} street
 * @property {string} city
 * @property {string} zip
 * @property {string} tel
 * @property {string} email
 * @property {string} document_no
 * @property {string} document_type  'RNC' | 'EIN' | ''
 */

// ─────────────────────────────────────────────────────────────────────────────
// FILAS DE LA BASE
//
// Lo que devuelven las consultas, que no es lo mismo que produce un parser: la
// base agrega id, status, timestamps y los campos que llena el operador.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fila de `manifests`.
 * @typedef {object} ManifestRow
 * @property {number} id
 * @property {string} filename
 * @property {string} voyage_no
 * @property {string} vessel_code
 * @property {string} vessel_name
 * @property {string} biz_company_code
 * @property {string} loading_port
 * @property {string} unloading_port
 * @property {string} [discharge_port] Puerto de descarga intermedio, para carga en tránsito
 * @property {string} departure_date
 * @property {string} arrival_date
 * @property {string} manifest_no
 * @property {string} carrier_code
 * @property {string} status          'borrador' | 'validado' | 'exportado' | 'siscommate'
 * @property {string} created_at
 * @property {string} [exported_at]
 * @property {string} [docking_number]
 * @property {string} [imo]
 * @property {number} [bl_count]      Solo en el listado, viene de un COUNT
 * @property {string} [carrier_ivu]   Lo adjunta la ruta de exportación
 */

/**
 * Fila de `bills_of_lading`: los campos del archivo más lo que agrega la base y
 * completa el operador.
 * @typedef {ParsedBL & {
 *   id: number,
 *   manifest_id: number,
 *   status: string,
 *   notes?: string,
 *   modified_at?: string,
 *   hacienda_item_code?: string,
 *   hacienda_tariff?: string,
 *   containers?: string[],
 *   cargoItems?: CargoItemRow[]
 * }} BLRow
 */

/**
 * Fila de `containers`.
 * @typedef {object} ContainerRow
 * @property {number} id
 * @property {number} manifest_id
 * @property {string} container_no
 * @property {string} container_type
 * @property {string} package_code
 * @property {number} amount
 * @property {number} gross_weight
 * @property {number} net_weight
 * @property {string} seal_no1
 * @property {string} [size]   Requerido por SISCOMMATE (BOLCONT); lo elige el operador
 */

/**
 * Fila de `container_bl`, la tabla que vincula B/L con contenedores.
 * @typedef {object} ContainerBLRow
 * @property {string} container_no
 * @property {string} bl_no
 * @property {number} manifest_id
 */

/**
 * Fila de `bl_cargo_items`. A diferencia de ParsedCargoItem, aquí sí existen los
 * campos de Hacienda: los llena el operador desde el editor, nunca el parser.
 * @typedef {object} CargoItemRow
 * @property {number} id
 * @property {number} bl_id
 * @property {number} manifest_id
 * @property {string|null} container_no  null = aplica a todos los contenedores del B/L
 * @property {string} goods_name
 * @property {number} gross_weight
 * @property {string|null} hacienda_item_code
 * @property {string|null} hacienda_tariff
 * @property {number} seq
 */

/**
 * Fila de `clients`, el catálogo de consignatarios.
 * @typedef {object} ClientRow
 * @property {number} id
 * @property {string} name
 * @property {string} ss      SS/EIN de 9 dígitos
 * @property {string} [taxid]
 * @property {string} [add1]
 * @property {string} [add2]
 * @property {string} [phone1]
 * @property {string} [ivu]   No. de comerciante de Hacienda
 */

/**
 * Payload que se envía al bridge de SISCOMMATE.
 * @typedef {object} BridgeContainer
 * @property {string} bl_no
 * @property {string} container_no
 * @property {string} size
 * @property {string} type   Siempre 'R' (RORO)
 */

module.exports = {};
