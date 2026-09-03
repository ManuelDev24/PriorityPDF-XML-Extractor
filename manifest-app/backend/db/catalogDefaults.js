// Catálogos que se mantienen alineados con la instalación actual de
// SISCOMMATE. Las migraciones los insertan en SQLite y sirven como fallback
// seguro durante una actualización.

const VESSELS = [
  { code: 'EMVS20170336', name: 'KYDON',           imo: '8916607', carrier: 'MMARINEX', scac: 'MXS' },
  { code: 'EMVS20190966', name: 'LYKTOS',          imo: '8401145', carrier: 'MMARINEX', scac: 'MXS' },
  { code: 'EMVS20190510', name: 'CARIBBEAN FORCE', imo: '9335161', carrier: 'MMARINEX', scac: 'MXS' },
];

const VALID_CONTAINER_SIZES = ['20', '40', '40HC', '45', 'RORO'];

const PORT_MAPPINGS = [
  ['PRSJU', 'XSJ'], ['SJU', 'XSJ'], ['SJX', 'XSJ'],
  ['MGE', 'MGE'], ['PRMGE', 'MGE'], ['MAZ', 'MAZ'], ['PRMAZ', 'MAZ'],
  ['DRP', 'DRP'], ['DOSDQ', 'DRP'], ['DOSDO', 'DRP'], ['SDQ', 'DRP'], ['RPX', 'DRP'],
  ['RHA', 'RHA'], ['DORHA', 'RHA'],
  ['STT', 'STT'], ['STH', 'STT'], ['VISTT', 'STT'],
  ['STX', 'STX'], ['CRX', 'STX'], ['VISTX', 'STX'],
  ['SXM', 'SXM'], ['STM', 'SXM'], ['MST', 'SXM'], ['SFG', 'SFG'],
  ['TOR', 'TOR'], ['VGTOR', 'TOR'],
  ['SKB', 'SKB'], ['ANU', 'ANU'],
  ['MIA', 'MIA'], ['USMIA', 'MIA'],
  ['FLL', 'FLL'], ['USFLL', 'FLL'],
  ['PEV', 'PEV'], ['PEG', 'PEV'], ['USPEV', 'PEV'],
  ['JAX', 'JAX'], ['USJAX', 'JAX'],
  ['TAP', 'TAP'], ['USTAP', 'TAP'],
  ['MCO', 'MCO'], ['NAP', 'NAP'], ['LAX', 'LAX'], ['PEN', 'PEN'],
  ['NY', 'NY'], ['NYC', 'NY'], ['USNYC', 'NY'],
  ['MXI', 'MXI'], ['MXVER', 'MXI'],
  ['TSI', 'TSI'], ['CNTAO', 'TSI'],
];

module.exports = { VESSELS, PORT_MAPPINGS, VALID_CONTAINER_SIZES };
