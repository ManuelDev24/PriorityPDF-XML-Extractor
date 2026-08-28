// server.js — Editor de manifiestos DGA → Hacienda PR + SISCOMMATE bridge
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const multer   = require('multer');
const xml2js   = require('xml2js');
const pdfParse = require('pdf-parse');
const http     = require('http');
const Database = require('better-sqlite3');

const app  = express();
const PORT = process.env.PORT || 3000;
const BRIDGE_HOST = process.env.BRIDGE_HOST || 'localhost';
const BRIDGE_PORT = process.env.BRIDGE_PORT || 5001;

// ─── BASE DE DATOS ──────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'manifest.db');
function getDB() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

// ─── MIGRACIONES ──────────────────────────────────────────────────────────────
(function migrate(){
  const db = getDB();
  const blCols = db.prepare("PRAGMA table_info(bills_of_lading)").all().map(c=>c.name);
  if (!blCols.includes('hacienda_client_ivu')) db.exec('ALTER TABLE bills_of_lading ADD COLUMN hacienda_client_ivu TEXT');
  const contCols = db.prepare("PRAGMA table_info(containers)").all().map(c=>c.name);
  if (!contCols.includes('size')) db.exec('ALTER TABLE containers ADD COLUMN size TEXT');
  const manCols = db.prepare("PRAGMA table_info(manifests)").all().map(c=>c.name);
  if (!manCols.includes('docking_number')) db.exec('ALTER TABLE manifests ADD COLUMN docking_number TEXT');

  // Configuración persistente (bridge host/port, etc.)
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`);
  db.exec(`INSERT OR IGNORE INTO settings VALUES ('bridge_host','${BRIDGE_HOST}'),('bridge_port','${BRIDGE_PORT}'),('dbf_path','')`);

  // Mapeo XML ContainerType → tamaño SISCOMMATE
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

  // Items de carga múltiples por B/L (opcionalmente por contenedor)
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

  db.close();
})();

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── BRIDGE HELPER ──────────────────────────────────────────────────────────
function getBridgeConfig() {
  const db = getDB();
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN ('bridge_host','bridge_port')`).all();
  db.close();
  const cfg = { host: BRIDGE_HOST, port: BRIDGE_PORT };
  rows.forEach(r => { if (r.key === 'bridge_host') cfg.host = r.value; if (r.key === 'bridge_port') cfg.port = r.value; });
  return cfg;
}

function bridgeRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const { host, port } = getBridgeConfig();
    const postData = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: host,
      port:     port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (postData) opts.headers['Content-Length'] = Buffer.byteLength(postData);

    const req = http.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ raw: data }); }
      });
    });
    req.on('error', err => reject(err));
    if (postData) req.write(postData);
    req.end();
  });
}

// ─── HELPERS XML ─────────────────────────────────────────────────────────────
function v(obj, key) {
  if (!obj || !obj[key]) return '';
  const val = obj[key];
  return Array.isArray(val) ? (val[0] || '') : val;
}

function parseXmlManifest(xmlText) {
  return new Promise((resolve, reject) => {
    xml2js.parseString(xmlText, { explicitArray: true, trim: true }, (err, result) => {
      if (err) return reject(err);
      try {
        const root     = result['ExportManifest'] || result;
        const manifest = root['Manifest'] ? root['Manifest'][0] : root;
        const header = {
          voyage_no:        v(manifest, 'VoyageNo'),
          vessel_code:      v(manifest, 'VesselCode'),
          biz_company_code: v(manifest, 'BizCompanyCode'),
          loading_port:     v(manifest, 'LoadingLocationCode'),
          unloading_port:   v(manifest, 'UnloadingLocationCode'),
          departure_date:   v(manifest, 'DepartureDate'),
          arrival_date:     v(manifest, 'ArrivalDate'),
        };
        const bls = (manifest['ManifestBL'] || []).map(bl => ({
          bl_no:                   v(bl, 'BLNo'),
          bl_type:                 v(bl, 'BLType'),
          transit_type:            v(bl, 'TransitType'),
          unloading_port_code:     v(bl, 'UnloadingPortCode'),
          goods_name:              v(bl, 'GoodsName').replace(/[\r\n\t]+/g,' ').trim(),
          package_unit_code:       v(bl, 'PackageUnitCode'),
          package_qty:             parseInt(v(bl,'PackageQty'))||0,
          gross_weight:            parseFloat(v(bl,'GrossWeight'))||0,
          value:                   parseFloat(v(bl,'Value'))||0,
          consignor_type:          v(bl,'ConsignorType'),
          consignor_code:          v(bl,'ConsignorCode'),
          consignor_name:          v(bl,'ConsignorName').replace(/&amp;/g,'&'),
          consignor_document_type: v(bl,'ConsignorDocumentType'),
          consignor_document_no:   v(bl,'ConsignorDocumentNo'),
          consignor_country_code:  v(bl,'ConsignorCountryCode'),
          consignor_tel:           v(bl,'ConsignorTel'),
          consignor_email:         v(bl,'ConsignorEmail'),
          consignor_street:        v(bl,'ConsignorStreet'),
          consignor_city:          v(bl,'ConsignorCity'),
          consignor_zip:           v(bl,'ConsignorZipCode'),
          consignee_type:          v(bl,'ConsigneeType'),
          consignee_code:          v(bl,'ConsigneeCode'),
          consignee_name:          v(bl,'ConsigneeName').replace(/&amp;/g,'&'),
          consignee_document_type: v(bl,'ConsigneeDocumentType'),
          consignee_document_no:   v(bl,'ConsigneeDocumentNo'),
          consignee_country_code:  v(bl,'ConsigneeCountryCode'),
          consignee_tel:           v(bl,'ConsigneeTel'),
          consignee_email:         v(bl,'ConsigneeEmail'),
          consignee_street:        v(bl,'ConsigneeStreet'),
          consignee_city:          v(bl,'ConsigneeCity'),
          consignee_zip:           v(bl,'ConsigneeZipCode'),
          notify_name:             v(bl,'NotifyName'),
          notify_code:             v(bl,'NotifyCode'),
          notify_document_type:    v(bl,'NotifyDocumentType'),
          notify_document_no:      v(bl,'NotifyDocumentNo'),
          notify_country_code:     v(bl,'NotifyCountryCode'),
          notify_tel:              v(bl,'NotifyTel'),
          notify_email:            v(bl,'NotifyEmail'),
          notify_street:           v(bl,'NotifyStreet'),
          notify_city:             v(bl,'NotifyCity'),
          notify_zip:              v(bl,'NotifyZipCode'),
        }));
        const containers = (manifest['ManifestContainer']||[]).map(c=>({
          container_no:   v(c,'ContainerNo'),
          container_type: 'R',
          xml_container_type: v(c,'ContainerType') || '',
          package_code:   v(c,'PackageCode'),
          amount:         parseInt(v(c,'Amount'))||0,
          gross_weight:   parseFloat(v(c,'GrossWeight'))||0,
          net_weight:     parseFloat(v(c,'NetWeight'))||0,
          seal_no1:       v(c,'SealNo1'),
        }));
        const containerBLs = (manifest['ContainerBL']||[]).map(cb=>({
          bl_no:        v(cb,'BLNo'),
          container_no: v(cb,'ContainerNo'),
        }));
        resolve({ header, bls, containers, containerBLs });
      } catch(e) { reject(e); }
    });
  });
}

// ─── HELPERS PDF ─────────────────────────────────────────────────────────────
// Parser de manifiestos DGA en PDF. Extrae el texto del PDF y busca los mismos
// campos que el XML usando etiquetas en español/inglés. El PDF debe ser
// digital (generado por SIGA u otro sistema), no un escaneo sin texto.

// Normaliza fechas DD/MM/YYYY, DD-MM-YYYY o YYYY-MM-DD → YYYY-MM-DD
function normalizePdfDate(s) {
  if (!s) return '';
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yyyy}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  return '';
}

// Números con separador de miles: "1,234.56" o "1.234,56" → float
function parsePdfNum(s) {
  if (!s) return 0;
  s = String(s).trim();
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // El separador que aparece último es el decimal
    s = lastComma > lastDot ? s.replace(/\./g,'').replace(',', '.') : s.replace(/,/g,'');
  } else if (lastComma > -1) {
    // Solo comas: decimal si parece "123,45", miles si "1,234"
    s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g,'');
  }
  return parseFloat(s) || 0;
}

// Busca la primera etiqueta que haga match y devuelve el grupo capturado
function grabPdf(text, regexes) {
  for (const re of regexes) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

// B/L con todos los campos que espera el INSERT (better-sqlite3 no acepta undefined)
function emptyPdfBL() {
  return {
    bl_no:'', bl_type:'', transit_type:'', unloading_port_code:'',
    goods_name:'', package_unit_code:'', package_qty:0, gross_weight:0, value:0,
    consignor_type:'', consignor_code:'', consignor_name:'', consignor_document_type:'',
    consignor_document_no:'', consignor_country_code:'', consignor_tel:'', consignor_email:'',
    consignor_street:'', consignor_city:'', consignor_zip:'',
    consignee_type:'', consignee_code:'', consignee_name:'', consignee_document_type:'',
    consignee_document_no:'', consignee_country_code:'', consignee_tel:'', consignee_email:'',
    consignee_street:'', consignee_city:'', consignee_zip:'',
    notify_name:'', notify_code:'', notify_document_type:'', notify_document_no:'',
    notify_country_code:'', notify_tel:'', notify_email:'', notify_street:'',
    notify_city:'', notify_zip:'',
  };
}

// ── Parser formato US Customs 1302 (cargo manifest de Priority RORO) ─────────
// Estructura por entrada (una por contenedor, el B/L puede repetirse):
//   [bloque shipper] [bloque consignee] [bloque notify]   ← separados por líneas en blanco
//   PYRR-2617593 PRRU 201010-6                            ← B/L + contenedor
//   40' CONT                                              ← tamaño
//   111895                                                ← marcas/sellos
//   288 carton:                                           ← cantidad + tipo bulto
//   PACKAGES CONTAINING: ...                              ← descripción hasta " KG"
// Los pesos (pares KG,LBS) aparecen agrupados al inicio de cada página, en el
// mismo orden que las entradas.

function isIsoContainer(s) {
  return /^[A-Z]{3}[UJZ]\d{6,7}$/i.test(s) || /^(PRRU|MXRU|CRSU|GVTU|MCLU|CAXU|TGHU|TEMU|SEGU|MSKU)\d+$/i.test(s);
}

function normContainerNo(raw) {
  if (!raw) return '';
  const m = raw.match(/^([A-Z]{4})\s*(\d{6})\s*-?\s*(\d)?$/);
  if (m) return m[1] + m[2] + (m[3] || '');
  return raw.replace(/\s+/g, '');
}

function isPhoneNumber(l) {
  const clean = l.trim();
  const digits = clean.replace(/\D/g, '');
  if (digits.length < 7) return false;
  return /^[\d\s()\-.\/+]+$/.test(clean) || /(?:Tel|Phone|Cel|Fax|Mobile)/i.test(clean);
}

// Bloque de dirección → { name, street, city, zip, tel, email, document_no, document_type }
function parsePdfParty(blockLines) {
  const p = { name:'', street:'', city:'', zip:'', tel:'', email:'', document_no:'', document_type:'' };
  if (!blockLines || !blockLines.length) return p;
  p.name = blockLines[0].substring(0, 60);

  // Extraer Documento si viene en la línea del nombre (ej: "DYLAN SMITH TAX ID: 430000145")
  const mNameDoc = p.name.match(/(?:TAX\s*ID|EIN|RNC)\s*[:#]?\s*(\d[\d-]*\d|\d+)/i);
  if (mNameDoc) {
    p.document_no = mNameDoc[1].replace(/\D/g, '');
    p.document_type = /RNC/i.test(mNameDoc[0]) ? 'RNC' : 'EIN';
    p.name = p.name.replace(/(?:TAX\s*ID|EIN|RNC)\s*[:#]?\s*[\d-]+/i, '').trim();
  }

  // Unir líneas de ciudad/país partidas entre paréntesis, ej: '4837 - KINGSHILL (UNITED STATES VIRGIN' y 'ISLANDS)'
  const mergedLines = [];
  let pendingWrap = '';
  for (let i = 1; i < blockLines.length; i++) {
    const l = blockLines[i].trim();
    if (!l) continue;
    if (pendingWrap) {
      pendingWrap += ' ' + l;
      if (l.includes(')')) { mergedLines.push(pendingWrap); pendingWrap = ''; }
    } else if (l.includes('(') && !l.includes(')')) {
      pendingWrap = l;
    } else {
      mergedLines.push(l);
    }
  }
  if (pendingWrap) mergedLines.push(pendingWrap);

  const streetParts = [];
  mergedLines.forEach(raw => {
    // Email
    const mEmail = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (mEmail) {
      p.email = mEmail[0];
      raw = raw.replace(mEmail[0], '').trim();
      if (!raw) return;
    }

    // RNC
    const mRnc = raw.match(/RNC\s*[:#]?\s*(\d[\d-]*\d|\d+)/i);
    if (mRnc) {
      p.document_no = mRnc[1].replace(/\D/g, '');
      p.document_type = 'RNC';
      raw = raw.replace(/RNC\s*[:#]?\s*[\d-]+/i, '').replace(/^[-\s]+|[-\s]+$/g, '').trim();
    }

    // TAX ID / EIN
    const mTaxId = raw.match(/TAX\s*ID\s*[:#]?\s*(\d[\d-]*\d|\d+)/i);
    if (mTaxId) {
      p.document_no = mTaxId[1].replace(/\D/g, '');
      p.document_type = 'EIN';
      raw = raw.replace(/TAX\s*ID\s*[:#]?\s*[\d-]+/i, '').replace(/^[-\s]+|[-\s]+$/g, '').trim();
    }

    // Teléfono
    if (isPhoneNumber(raw)) {
      if (!p.tel || p.tel.replace(/\D/g,'').length < raw.replace(/\D/g,'').length) {
        p.tel = raw.substring(0, 30);
      }
      return;
    }

    // Zip y ciudad: '00907 - SAN JUAN (PR - PUERTO RICO)' o '4837 - KINGSHILL (UNITED STATES VIRGIN ISLANDS)'
    const zipMatch = raw.match(/^(\d{4,5}(?:-\d{4})?)\s*-\s*(.+)$/);
    if (zipMatch) {
      p.zip = zipMatch[1];
      raw = zipMatch[2].trim();
    }

    // Ciudad limpia sin paréntesis de estado/país
    if (/\(/.test(raw) || p.zip) {
      const cleanCity = raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (cleanCity && !p.city) {
        p.city = cleanCity.substring(0, 40);
        return;
      }
    }

    if (raw) streetParts.push(raw);
  });

  p.street = streetParts.join(' ').substring(0, 60);
  return p;
}

// Los 3 bloques de dirección que preceden a la línea del B/L (hacia atrás)
function collectPartyBlocks(lines, blIdx) {
  const blocks = [];
  let cur = [];
  for (let i = blIdx - 1; i >= 0 && blocks.length < 3; i--) {
    const t = lines[i].trim();
    if (t === '') {
      if (cur.length) { blocks.push(cur.reverse()); cur = []; }
      continue;
    }
    if (/^(SH|CO|NO|NF|KG|LBS)$/.test(t) || /^P[aá]gina/i.test(t) || /^Page/i.test(t) ||
        /CUSTOMS USE ONLY/i.test(t) || /^\d[\d,]*\.\d{2}$/.test(t)) break;
    cur.push(t);
  }
  if (cur.length && blocks.length < 3) blocks.push(cur.reverse());
  // Se recolectaron en orden [notify, consignee, shipper] → invertir y
  // rellenar por delante si faltan bloques
  blocks.reverse();
  while (blocks.length < 3) blocks.unshift(null);
  return blocks;  // [shipper, consignee, notify]
}

function parseCustoms1302(text) {
  const header = {
    voyage_no:'', vessel_code:'', vessel_name:'', biz_company_code:'',
    loading_port:'', unloading_port:'', departure_date:'', arrival_date:'',
    manifest_no:'', carrier_code:'MPRIORO'
  };

  const mShip = text.match(/Name of Ship[^\n]*\n(.+)/i);
  if (mShip) {
    const mv = mShip[1].trim().match(/^(.*?)\s{2,}(\S+)$/);
    if (mv) {
      header.vessel_name = mv[1].replace(/\s*\([^)]*\)\s*$/,'').trim();
      header.vessel_code = header.vessel_name;
      header.manifest_no = mv[2];
      header.voyage_no   = mv[2];
    } else {
      header.vessel_name = mShip[1].trim();
      header.vessel_code = header.vessel_name;
    }
  }
  const mLoad = text.match(/(?:Puerto de carga|Loading Port)\s*\n(.+)/i);
  if (mLoad) header.loading_port = (mLoad[1].match(/\(([A-Z]{2,5})\)/)||[])[1] || mLoad[1].trim();
  const mUnl = text.match(/(?:Puerto de Descarga|Discharge Port)\s*\n(.+)/i);
  if (mUnl) header.unloading_port = (mUnl[1].match(/\(([A-Z]{2,5})\)/)||[])[1] || mUnl[1].trim();
  const mDep = text.match(/(?:Date of Sailing[^\n]*|Fecha\s*de\s*Zarpe[^\n]*)\n\s*(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})/i);
  if (mDep) header.departure_date = `${mDep[1]}-${mDep[2].padStart(2,'0')}-${mDep[3].padStart(2,'0')}`;

  // Dividir por páginas para emparejar pesos y entradas 1-a-1 por página
  const rawPages = text.split(/(?:Page\s+\d+\/\d+|P[aá]gina\s*(?:\d+\/\d+)?)/i);
  const allEntries = [];

  rawPages.forEach((pageText, pIdx) => {
    if (!pageText.trim()) return;
    const lines = pageText.split('\n');

    // Pesos al inicio de la página
    const pureNums = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (/^\s*\d{1,3}(?:,\d{3})*\.\d{2}\s*$/.test(l)) pureNums.push(parsePdfNum(l));
      if (/1\.- Name of Ship/i.test(l) || /BL Numbers/i.test(l)) break;
    }
    const pageWeightsKg = [];
    for (let i = 0; i + 1 < pureNums.length; i += 2) pageWeightsKg.push(pureNums[i]);

    // Entradas de B/L en la página
    const blLineRe = /^([A-Z]{2,6}-\d{5,10})(?:\s+(\S.*))?$/;
    const pageEntries = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].trim().match(blLineRe);
      if (!m) continue;

      const rawSecondToken = (m[2] || '').trim();
      let containerNo = '';
      let vin = '';
      let equipmentType = '';

      if (rawSecondToken) {
        const cleaned = normContainerNo(rawSecondToken);
        if (isIsoContainer(cleaned)) {
          containerNo = cleaned;
        } else if (/^[A-HJ-NPR-Z0-9]{11,17}$/i.test(cleaned)) {
          vin = cleaned;
          equipmentType = 'VEHICLE';
        } else {
          containerNo = cleaned;
        }
      }

      const e = {
        bl_no: m[1],
        container_no: containerNo,
        vin: vin,
        size: '',
        qty: 0,
        unit: '',
        goods: '',
        equipmentType: equipmentType,
        hazard: false,
        page: pIdx + 1,
        shipper: null,
        consignee: null,
        notify: null
      };

      let j = i + 1;
      while (j < lines.length && j < i + 6) {
        const t = lines[j].trim();
        if (/Hazardous\s*cargo/i.test(t)) { e.hazard = true; j++; continue; }
        if (!e.vin && /^[A-HJ-NPR-Z0-9]{17}$/i.test(t)) { e.vin = t; j++; continue; }
        if (/^VEHICLE$/i.test(t)) { e.equipmentType = 'VEHICLE'; j++; continue; }
        const sz = t.match(/^(\d{2})'\s*(.*)$/);
        if (sz) { e.size = /HC|HIGH/i.test(sz[2]) ? `${sz[1]}HC` : sz[1]; j++; continue; }
        if (/^PALLET|^FLATBED|^FR\b/i.test(t)) { j++; continue; }
        break;
      }

      let descStart = j;
      for (let k = 0; k < 6 && j + k < lines.length; k++) {
        const t = lines[j+k].trim();
        if (/^(KG|LBS)$/.test(t)) break;
        const qm = t.match(/^(\d+)\s*([A-Za-z]*)\s*:$/);
        if (qm) {
          e.qty = parseInt(qm[1]) || 0;
          e.unit = qm[2] || (e.equipmentType === 'VEHICLE' ? 'UNIT' : 'PKG');
          descStart = j + k + 1;
          break;
        }
      }

      const desc = [];
      for (j = descStart; j < lines.length; j++) {
        const t = lines[j].trim();
        if (/^(KG|LBS|SH|CO|NO|NF)$/.test(t) || /^P[aá]gina/i.test(t) || /^Page/i.test(t) || /^1\.- Name/i.test(t)) break;
        desc.push(t);
        if (desc.join(' ').length > 400) break;
      }
      e.goods = desc.join(' ').replace(/\s+/g, ' ').trim().substring(0, 300);

      const parties = collectPartyBlocks(lines, i);
      e.shipper = parties[0]; e.consignee = parties[1]; e.notify = parties[2];
      pageEntries.push(e);
    }

    pageEntries.forEach((e, idx) => {
      e.gross_weight = idx < pageWeightsKg.length ? pageWeightsKg[idx] : 0;
      allEntries.push(e);
    });
  });

  // Consolidar B/Ls y extraer Contenedores y Cargo Items
  const blMap = new Map();
  const containers = [];
  const containerBLs = [];
  const cargoItems = [];
  const seenCont = new Set();

  allEntries.forEach(e => {
    let bl = blMap.get(e.bl_no);
    if (!bl) {
      bl = emptyPdfBL();
      bl.bl_no = e.bl_no;
      bl.unloading_port_code = header.unloading_port;
      bl.goods_name = e.goods;
      bl.package_unit_code = e.unit;
      const sh = parsePdfParty(e.shipper);
      const co = parsePdfParty(e.consignee);
      const nf = parsePdfParty(e.notify);
      bl.consignor_name          = sh.name;
      bl.consignor_document_no   = sh.document_no || '';
      bl.consignor_document_type = sh.document_type || (sh.document_no ? 'RNC' : '');
      bl.consignor_street        = sh.street;
      bl.consignor_city          = sh.city;
      bl.consignor_zip           = sh.zip;
      bl.consignor_tel           = sh.tel;
      bl.consignor_email         = sh.email;

      bl.consignee_name          = co.name;
      bl.consignee_document_no   = co.document_no || '';
      bl.consignee_document_type = co.document_type || (co.document_no ? 'EIN' : '');
      bl.consignee_street        = co.street;
      bl.consignee_city          = co.city;
      bl.consignee_zip           = co.zip;
      bl.consignee_tel           = co.tel;
      bl.consignee_email         = co.email;
      if (co.document_no) bl.hacienda_client_ss = co.document_no;

      bl.notify_name             = nf.name;
      bl.notify_street           = nf.street;
      bl.notify_city             = nf.city;
      bl.notify_zip              = nf.zip;
      bl.notify_tel              = nf.tel;
      bl.notify_email            = nf.email;

      bl.hacienda_container_no   = e.container_no || e.vin || '';
      blMap.set(e.bl_no, bl);
    }

    bl.gross_weight += e.gross_weight;
    bl.package_qty  += e.qty;

    if (e.container_no) {
      containerBLs.push({ bl_no: e.bl_no, container_no: e.container_no });
      if (!seenCont.has(e.container_no)) {
        seenCont.add(e.container_no);
        containers.push({
          container_no: e.container_no,
          container_type: 'R',
          xml_container_type: '',
          package_code: e.unit || '',
          amount: e.qty,
          gross_weight: e.gross_weight,
          net_weight: 0,
          seal_no1: '',
          size: e.size || '40'
        });
      }
    }

    cargoItems.push({
      bl_no: e.bl_no,
      container_no: e.container_no || null,
      vin: e.vin || null,
      goods_name: e.vin ? `[VIN: ${e.vin}] ${e.goods}` : e.goods,
      gross_weight: e.gross_weight,
      package_qty: e.qty,
      package_unit: e.unit || ''
    });
  });

  return { header, bls: [...blMap.values()], containers, containerBLs, cargoItems };
}

async function parsePdfManifest(buffer) {
  const data = await pdfParse(buffer);
  const text = (data.text || '').replace(/ /g, ' ');
  if (!text.trim()) {
    throw new Error('El PDF no contiene texto extraíble (parece un escaneo). Usa un PDF generado digitalmente o el XML de la DGA.');
  }

  // Formato US Customs 1302 (cargo manifest Priority RORO / SIGA / Inbound & Outbound)
  if (/Name of Ship/i.test(text) && (/N[uú]mero de recibo/i.test(text) || /Voyage Number/i.test(text) || /Customs Form 1300/i.test(text) || /BL Numbers/i.test(text))) {
    const r = parseCustoms1302(text);
    if (r.bls.length) return r;
  }

  const header = {
    voyage_no: grabPdf(text, [
      /(?:No\.?\s*(?:de\s*)?Viaje|Viaje\s*(?:No\.?|N[uú]m(?:ero)?\.?)?|Voyage\s*(?:No\.?)?)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]*)/i,
    ]),
    vessel_code: grabPdf(text, [
      /(?:Nombre\s+del\s+Buque|Buque|Vessel|Motonave|Nave)\s*[:\-]?\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9 .\-]{2,39})/i,
    ]),
    biz_company_code: '',
    loading_port: grabPdf(text, [
      /(?:Puerto\s+de\s+(?:Embarque|Carga|Salida|Origen)|Loading\s+(?:Port|Location))\s*[:\-]?\s*([A-Z]{3,5})\b/i,
      /(?:Puerto\s+de\s+(?:Embarque|Carga|Salida|Origen)|Loading\s+(?:Port|Location))\s*[:\-]?\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ ]{2,29})/i,
    ]),
    unloading_port: grabPdf(text, [
      /(?:Puerto\s+de\s+(?:Desembarque|Descarga|Destino|Llegada)|(?:Unloading|Discharge)\s+(?:Port|Location))\s*[:\-]?\s*([A-Z]{3,5})\b/i,
      /(?:Puerto\s+de\s+(?:Desembarque|Descarga|Destino|Llegada)|(?:Unloading|Discharge)\s+(?:Port|Location))\s*[:\-]?\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ ]{2,29})/i,
    ]),
    departure_date: normalizePdfDate(grabPdf(text, [
      /(?:Fecha\s+de\s+(?:Salida|Zarpe|Partida|Embarque)|Departure\s*Date)\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})/i,
    ])),
    arrival_date: normalizePdfDate(grabPdf(text, [
      /(?:Fecha\s+de\s+(?:Llegada|Arribo)|Arrival\s*Date)\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})/i,
    ])),
  };

  // Dividir el texto en bloques por número de B/L. Cada match abre un bloque
  // que termina donde empieza el siguiente B/L.
  const blLabelRe = /(?:No\.?\s*)?(?:B\/?L|Conocimiento(?:\s+de\s+Embarque)?)\s*(?:No\.?|N[uú]m(?:ero)?\.?)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{4,24})/gi;
  const marks = [];
  let m;
  while ((m = blLabelRe.exec(text)) !== null) {
    // Evitar falsos positivos: descartar tokens que son solo la palabra siguiente
    if (/^(NO|NUM|NUMERO)$/i.test(m[1])) continue;
    marks.push({ bl_no: m[1].toUpperCase(), start: m.index });
  }

  const bls = [];
  const containers = [];
  const containerBLs = [];
  const seenBL = new Set();
  const seenCont = new Set();

  marks.forEach((mark, i) => {
    if (seenBL.has(mark.bl_no)) return;  // páginas repetidas / totales
    seenBL.add(mark.bl_no);
    const block = text.substring(mark.start, i + 1 < marks.length ? marks[i+1].start : text.length);
    const bl = emptyPdfBL();
    bl.bl_no          = mark.bl_no;
    bl.consignee_name = grabPdf(block, [/(?:Consignatario|Consignee)\s*[:\-]?\s*(.+)/i]).replace(/\s{2,}.*$/,'').substring(0,60);
    bl.consignor_name = grabPdf(block, [/(?:Embarcador|Exportador|Shipper|Consignor)\s*[:\-]?\s*(.+)/i]).replace(/\s{2,}.*$/,'').substring(0,60);
    bl.goods_name     = grabPdf(block, [/(?:Descripci[oó]n(?:\s+de\s+la\s+Mercanc[ií]a)?|Mercanc[ií]a|Goods)\s*[:\-]?\s*(.+)/i]).replace(/[\r\n\t]+/g,' ').trim();
    bl.gross_weight   = parsePdfNum(grabPdf(block, [/(?:Peso\s*Bruto|Gross\s*Weight)\s*(?:\(?\s*kgs?\.?\s*\)?)?\s*[:\-]?\s*([\d.,]+)/i]));
    bl.package_qty    = parseInt(grabPdf(block, [/(?:Bultos|Cantidad(?:\s+de\s+Bultos)?|Packages?)\s*[:\-]?\s*(\d+)/i])) || 0;
    bl.value          = parsePdfNum(grabPdf(block, [/(?:Valor(?:\s*FOB)?|Value)\s*(?:\(?\s*US\$?\s*\)?|USD)?\s*[:\-]?\s*([\d.,]+)/i]));
    bls.push(bl);

    // Contenedores ISO 6346 dentro del bloque del B/L (ej: MSCU1234567).
    // La 4ª letra solo puede ser U/J/Z según ISO — evita confundir números
    // de B/L tipo "PRIO2026001" con contenedores.
    const contRe = /\b([A-Z]{3}[UJZ]\d{7})\b/g;
    let cm;
    while ((cm = contRe.exec(block)) !== null) {
      const contNo = cm[1];
      if (seenBL.has(contNo)) continue;
      containerBLs.push({ bl_no: mark.bl_no, container_no: contNo });
      if (!seenCont.has(contNo)) {
        seenCont.add(contNo);
        containers.push({
          container_no: contNo, container_type: 'R', xml_container_type: '',
          package_code: '', amount: 0, gross_weight: 0, net_weight: 0, seal_no1: '',
        });
      }
    }
  });

  if (!bls.length) {
    console.error('PDF sin B/L reconocibles. Primeros 800 caracteres extraídos:\n', text.substring(0, 800));
    throw new Error('No se encontraron B/L en el PDF. Verifica que sea un manifiesto DGA digital; si el formato es distinto, envía un ejemplo para ajustar el lector.');
  }

  return { header, bls, containers, containerBLs };
}

// ─── GENERACIÓN TXT HACIENDA / SISCOMMATE ────────────────────────────────────
// Formato verificado contra archivos TXT reales del sistema SISCOMMATE.
// Todas las líneas tienen exactamente 205 caracteres.
function pad(s,n)   { return String(s||'').substring(0,n).padEnd(n,' '); }
function padL(s,n)  { return String(s||'').substring(0,n).padStart(n,' '); }
function padZ(s,n)  { return String(s||'').padStart(n,'0').substring(0,n); }

// SS/EIN: exactamente 9 dígitos. Devuelve null si no tiene exactamente 9 para
// que la validación de export-txt pueda detectar valores inválidos.
function sanitizeSS(ss) {
  const digits = String(ss||'').replace(/[^0-9]/g,'');
  if (digits.length === 0) return '000000000';
  // Rellenar con ceros a la izquierda (no derecha) para preservar el EIN real
  return digits.padStart(9,'0').substring(digits.length > 9 ? digits.length - 9 : 0);
}

// Puerto XML/DGA → código SISCOMMATE (fuente: ports.dbf de SISCOMMATE)
function toSiscommatePort(code) {
  const map = {
    // San Juan, PR
    'PRSJU':'XSJ', 'SJU':'XSJ', 'SJX':'XSJ',
    // Mayagüez, PR
    'MGE':'MGE', 'PRMGE':'MGE', 'MAZ':'MAZ', 'PRMAZ':'MAZ',
    // Santo Domingo / Caucedo, DO
    'DRP':'DRP', 'DOSDQ':'DRP', 'DOSDO':'DRP', 'SDQ':'DRP', 'RPX':'DRP',
    // Río Haina, DO
    'RHA':'RHA', 'DORHA':'RHA',
    // St. Thomas, USVI
    'STT':'STT', 'STH':'STT', 'VISTT':'STT',
    // St. Croix, USVI
    'STX':'STX', 'CRX':'STX', 'VISTX':'STX',
    // St. Maarten / St. Martin
    'SXM':'SXM', 'STM':'SXM', 'MST':'SXM', 'SFG':'SFG',
    // Tortola, BVI
    'TOR':'TOR', 'VGTOR':'TOR',
    // Saint Kitts
    'SKB':'SKB',
    // Antigua
    'ANU':'ANU',
    // USA
    'MIA':'MIA', 'USMIA':'MIA',
    'FLL':'FLL', 'USFLL':'FLL',
    'PEV':'PEV', 'PEG':'PEV', 'USPEV':'PEV',
    'JAX':'JAX', 'USJAX':'JAX',
    'TAP':'TAP', 'USTAP':'TAP',
    'MCO':'MCO', 'NAP':'NAP', 'LAX':'LAX', 'PEN':'PEN',
    'NY':'NY', 'NYC':'NY', 'USNYC':'NY',
    // México
    'MXI':'MXI', 'MXVER':'MXI',
    // China
    'TSI':'TSI', 'CNTAO':'TSI',
  };
  return map[(code||'').toUpperCase()] || (code||'XSJ').toUpperCase().substring(0,3);
}

// ── LÍNEA 0 — Encabezado del manifiesto (205 chars) ──────────────────────────
// Posiciones verificadas (0-indexed):
//  [0]      tipo '0'
//  [1:17]   16 espacios
//  [17:24]  carrier (7)
//  [24]     espacio
//  [25:32]  manifest_no (7)
//  [32:36]  bl_count (4, zero-padded)
//  [36:44]  arrival_date YYYYMMDD (8)
//  [44:60]  vessel_name (16)
//  [60:66]  voyage_no (6)
//  [66:74]  departure_date YYYYMMDD (8)
//  [74:82]  arrival_date YYYYMMDD (8)
//  [82:87]  'N1800'
//  [87:94]  carrier (7)
//  [94]     espacio
//  [95:101] voyage_no (6)
//  [101:165] 64 espacios (reservado SISCOMMATE)
//  [165:173] docking_number (8, número de atraque — obligatorio)
//  [173]    espacio
//  [174:181] imo (7)
//  [181:183] 2 espacios
//  [183:191] arrival_date YYYYMMDD (8)
//  [191:205] 14 espacios
function generateTxtLine0(manifest, blCount) {
  const carrier = pad(manifest.carrier_code||'MPRIORO', 7);
  const manNo   = pad(manifest.manifest_no||'', 7);
  const vessel  = pad(manifest.vessel_name||'', 16);
  const voyNo   = pad(manifest.voyage_no||'', 6);
  const imo     = padZ(manifest.imo||'0', 7);
  const dep     = (manifest.departure_date||'').replace(/-/g,'').substring(0,8).padEnd(8,' ');
  const arr     = (manifest.arrival_date||'').replace(/-/g,'').substring(0,8).padEnd(8,' ');
  const cnt     = padZ(blCount, 4);
  return (
    '0' +                    // [0]      tipo
    pad('',16) +             // [1:17]   16 espacios
    carrier +                // [17:24]  carrier
    ' ' +                    // [24]     espacio
    manNo +                  // [25:32]  manifest_no
    cnt +                    // [32:36]  bl_count
    arr +                    // [36:44]  arrival_date
    vessel +                 // [44:60]  vessel
    voyNo +                  // [60:66]  voyage
    dep +                    // [66:74]  departure_date
    arr +                    // [74:82]  arrival_date (repetido)
    'N1800' +                // [82:87]
    carrier +                // [87:94]  carrier (repetido)
    ' ' +                    // [94]
    voyNo +                  // [95:101] voyage (repetido)
    pad('',64) +             // [101:165] reservado
    padZ(manifest.docking_number||'0', 8) + // [165:173] docking_number
    ' ' +                    // [173]
    imo +                    // [174:181] IMO
    '  ' +                   // [181:183]
    arr +                    // [183:191] arrival_date
    pad('',14)               // [191:205] trailing
  );
}

// ── LÍNEA 1 — Datos del B/L y consignatario (205 chars) ──────────────────────
// Posiciones verificadas (0-indexed):
//  [0]       tipo '1'
//  [1:17]    bl_no (16)
//  [17:19]   'AM'
//  [19:37]   container_no (18)
//  [37:67]   consignee_name (30)
//  [67:76]   ss_ein (9)
//  [76:83]   type_code (7) = 'C      ' o referencia de cliente
//  [83:143]  consignor_name (60)
//  [143:146] orig_port (3)
//  [146:149] disc_port (3)
//  [149:152] dest_port (3)
//  [152]     'C'
//  [153:162] fob_value_cents (9)
//  [162]     'C'
//  [163:175] 12 espacios
//  [175]     'V'
//  [176:186] 10 ceros
//  [186:190] tariff+'R' (4) o 4 espacios si libre arancel
//  [190:201] IVU/No. comerciante del CONSIGNATARIO (11) — verificado contra
//            archivos reales SISCOMMATE: este campo varía por B/L según el
//            IVU del consignatario, NO es el código arancelario. Si el
//            consignatario no tiene IVU registrado, SISCOMMATE usa el IVU
//            del carrier como respaldo (visto en los TXT reales).
//  [201:205] 4 espacios
function generateTxtLine1(bl, manifest, containerNo) {
  const ss9      = sanitizeSS(bl.hacienda_client_ss||bl.consignee_document_no);
  const loadPort = toSiscommatePort(manifest.loading_port||'DRP');
  const discPort = toSiscommatePort(manifest.unloading_port||'SJU');
  const tariff   = bl.hacienda_tariff;
  // Libre arancel (040): SISCOMMATE requiere valor FOB = 0
  const fobValue = (tariff === '040') ? 0 : (parseFloat(bl.value)||0);
  const valCents = padZ(Math.round(fobValue * 100), 9);
  // tariff+R: '040R', '045R', o 4 espacios si es libre arancel / tránsito
  const tariffR  = tariff ? `${pad(tariff,3)}R` : '    ';
  const ivu11    = bl.hacienda_client_ivu || manifest.carrier_ivu || '';
  return (
    '1' +
    pad(bl.bl_no, 16) +          // [1:17]
    'AM' +                        // [17:19]
    pad(containerNo!==undefined ? containerNo : (bl.hacienda_container_no||''), 18) + // [19:37]
    pad(bl.consignee_name, 30) +  // [37:67]
    ss9 +                         // [67:76]
    'C      ' +                   // [76:83] tipo C + 6 espacios
    pad(bl.consignor_name, 60) +  // [83:143]
    pad(loadPort, 3) +            // [143:146]
    pad(discPort, 3) +            // [146:149]
    pad(discPort, 3) +            // [149:152]
    'C' +                         // [152]
    valCents +                    // [153:162]
    'C' +                         // [162]
    pad('',12) +                  // [163:175]
    'V' +                         // [175]
    padZ(0,10) +                  // [176:186]
    tariffR +                     // [186:190]
    pad(ivu11, 11) +              // [190:201] IVU consignatario (fallback: IVU carrier)
    '    '                        // [201:205]
  );
}

// ── LÍNEA 2 — Detalle de carga (205 chars) ────────────────────────────────────
// Posiciones verificadas contra TXT reales de SISCOMMATE (3309577.TXT / K1305):
//  [0]       tipo '2'
//  [1:17]    bl_no (16)
//  [17:22]   qty (5)
//  [22:28]   unit_type (6) — 'BOX   ' si tiene contenedor, 'LSE   ' si no
//  [28:35]   weight (7) = gross_weight_kg × 100
//  [35:38]   tariff (3)
//  [38:159]  goods_description (121)
//  [159:164] qty_repeat (5)
//  [164:179] hacienda_item_code (15) zero-padded izquierda
//  [179:181] 2 espacios
//  [181:201] 20 ceros
//  [201:203] 'KF'
//  [203:205] 2 espacios
// containerCount: total de contenedores del B/L — divide el peso entre ellos
// item: objeto { goods_name, gross_weight, hacienda_item_code, hacienda_tariff, package_qty }
//       si null, usa los campos del bl directamente
function generateTxtLine2(bl, containerNo, containerCount, item) {
  const src       = item || bl;
  const tariff    = pad(src.hacienda_tariff || bl.hacienda_tariff || '   ', 3);
  const totalWeight = parseFloat(src.gross_weight)||0;
  const weightPerCont = (!item && containerCount > 1) ? totalWeight / containerCount : totalWeight;
  const weightG   = padZ(Math.round(weightPerCont * 100), 7);
  const goodsDesc = pad((src.goods_name||'').replace(/[\r\n]+/g,' '), 121);
  const qty       = padZ(src.package_qty || bl.package_qty || 0, 5);
  const itemCode  = padZ(parseInt(src.hacienda_item_code || bl.hacienda_item_code)||0, 15);
  const hasContainer = !!(containerNo!==undefined ? containerNo : bl.hacienda_container_no||'').trim();
  const unitType  = pad(hasContainer ? 'BOX' : 'LSE', 6);
  return (
    '2' +
    pad(bl.bl_no, 16) +
    qty +
    unitType +
    weightG +
    tariff +
    goodsDesc +
    qty +
    itemCode +
    '  ' +
    padZ(0,20) +
    'KF' +
    '  '
  );
}

// bl.containers: lista de container_no; bl.cargoItems: lista de cargo items
function generateFullTxt(manifest, bls) {
  const lines = [];
  const pairCount = bls.reduce((sum,bl) => sum + (bl.containers && bl.containers.length ? bl.containers.length : 1), 0);
  lines.push(generateTxtLine0(manifest, pairCount));
  bls.forEach(bl => {
    const containerNos = (bl.containers && bl.containers.length) ? bl.containers : [bl.hacienda_container_no||''];
    const cargoItems = bl.cargoItems && bl.cargoItems.length ? bl.cargoItems : null;
    containerNos.forEach(containerNo => {
      lines.push(generateTxtLine1(bl, manifest, containerNo));
      if (cargoItems) {
        // Filtrar items del contenedor o items sin contenedor asignado (aplican a todos)
        const items = cargoItems.filter(ci => !ci.container_no || ci.container_no === containerNo);
        if (items.length) {
          items.forEach(item => lines.push(generateTxtLine2(bl, containerNo, 1, item)));
        } else {
          lines.push(generateTxtLine2(bl, containerNo, containerNos.length, null));
        }
      } else {
        lines.push(generateTxtLine2(bl, containerNo, containerNos.length, null));
      }
    });
  });
  return lines.join('\r\n');
}

// ─── RUTAS API ───────────────────────────────────────────────────────────────

// Subir manifiesto (XML de la DGA o PDF digital)
app.post('/api/manifests/upload', upload.single('xml'), async (req,res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
    const isPdf = /\.pdf$/i.test(req.file.originalname||'') ||
                  req.file.buffer.slice(0,5).toString('latin1') === '%PDF-';
    const parsed = isPdf
      ? await parsePdfManifest(req.file.buffer)
      : await parseXmlManifest(req.file.buffer.toString('utf8'));
    const db     = getDB();
    const info   = db.prepare(`
      INSERT INTO manifests (filename,voyage_no,vessel_code,biz_company_code,
        loading_port,unloading_port,departure_date,arrival_date,carrier_code,manifest_no)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(req.file.originalname, parsed.header.voyage_no, parsed.header.vessel_code,
           parsed.header.biz_company_code,
           toSiscommatePort(parsed.header.loading_port),
           toSiscommatePort(parsed.header.unloading_port),
           parsed.header.departure_date,
           parsed.header.arrival_date, 'MPRIORO', parsed.header.manifest_no || '');
    const manifestId = info.lastInsertRowid;

    // Catálogo de clientes para auto-match de SS/EIN e IVU
    const clients = db.prepare(`SELECT name, ss, ivu FROM clients WHERE ss IS NOT NULL AND ss != ''`).all();
    const clientMap = new Map();
    clients.forEach(c => {
      if (c.name) clientMap.set(c.name.trim().toUpperCase(), c);
    });

    // Enriquecer BLs antes de insertar
    parsed.bls.forEach(bl => {
      let clientMatch = clientMap.get((bl.consignee_name||'').trim().toUpperCase());
      if (!clientMatch && bl.consignee_name) {
        const normName = bl.consignee_name.trim().toUpperCase();
        for (const [cName, cObj] of clientMap.entries()) {
          if (cName.length >= 4 && (normName.includes(cName) || cName.includes(normName))) {
            clientMatch = cObj;
            break;
          }
        }
      }
      if (clientMatch) {
        if (!bl.consignee_document_no && clientMatch.ss) bl.consignee_document_no = clientMatch.ss;
        bl.hacienda_client_ss  = clientMatch.ss || '';
        bl.hacienda_client_ivu = clientMatch.ivu || '';
      }
    });

    const insBL = db.prepare(`
      INSERT INTO bills_of_lading
        (manifest_id,bl_no,bl_type,transit_type,unloading_port_code,
         goods_name,package_unit_code,package_qty,gross_weight,value,
         consignor_type,consignor_code,consignor_name,consignor_document_type,
         consignor_document_no,consignor_country_code,consignor_tel,consignor_email,
         consignor_street,consignor_city,consignor_zip,
         consignee_type,consignee_code,consignee_name,consignee_document_type,
         consignee_document_no,consignee_country_code,consignee_tel,consignee_email,
         consignee_street,consignee_city,consignee_zip,
         notify_name,notify_code,notify_document_type,notify_document_no,
         notify_country_code,notify_tel,notify_email,notify_street,notify_city,notify_zip,
         hacienda_container_no,hacienda_client_ss,hacienda_client_ivu)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    db.transaction(bls => bls.forEach(bl => insBL.run(
      manifestId,bl.bl_no,bl.bl_type,bl.transit_type,bl.unloading_port_code,
      bl.goods_name,bl.package_unit_code,bl.package_qty,bl.gross_weight,bl.value,
      bl.consignor_type,bl.consignor_code,bl.consignor_name,bl.consignor_document_type,
      bl.consignor_document_no,bl.consignor_country_code,bl.consignor_tel,bl.consignor_email,
      bl.consignor_street,bl.consignor_city,bl.consignor_zip,
      bl.consignee_type,bl.consignee_code,bl.consignee_name,bl.consignee_document_type,
      bl.consignee_document_no,bl.consignee_country_code,bl.consignee_tel,bl.consignee_email,
      bl.consignee_street,bl.consignee_city,bl.consignee_zip,
      bl.notify_name,bl.notify_code,bl.notify_document_type,bl.notify_document_no,
      bl.notify_country_code,bl.notify_tel,bl.notify_email,bl.notify_street,
      bl.notify_city,bl.notify_zip,
      bl.hacienda_container_no||'',bl.hacienda_client_ss||'',bl.hacienda_client_ivu||''
    )))(parsed.bls);

    // Insertar items de carga individuales (soporta multi-ítem y vehículos)
    if (parsed.cargoItems && parsed.cargoItems.length) {
      const blRows = db.prepare(`SELECT id, bl_no FROM bills_of_lading WHERE manifest_id=?`).all(manifestId);
      const blIdMap = {};
      blRows.forEach(r => { blIdMap[r.bl_no] = r.id; });

      const insCargo = db.prepare(`
        INSERT INTO bl_cargo_items
          (bl_id, manifest_id, container_no, goods_name, gross_weight, hacienda_item_code, hacienda_tariff, seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const seqMap = {};
      parsed.cargoItems.forEach(ci => {
        const blId = blIdMap[ci.bl_no];
        if (blId) {
          seqMap[blId] = (seqMap[blId] || 0) + 1;
          insCargo.run(
            blId,
            manifestId,
            ci.container_no || null,
            ci.goods_name || '',
            parseFloat(ci.gross_weight) || 0,
            ci.hacienda_item_code || null,
            ci.hacienda_tariff || null,
            seqMap[blId]
          );
        }
      });
    }

    if (parsed.containers.length) {
      // Leer el mapeo ContainerType XML → size para asignar tamaño automáticamente
      const ctMap = {};
      db.prepare(`SELECT xml_type, size FROM container_type_map`).all().forEach(r => { ctMap[r.xml_type] = r.size; });
      const insCont = db.prepare(`INSERT INTO containers (manifest_id,container_no,container_type,package_code,amount,gross_weight,net_weight,seal_no1,size) VALUES (?,?,?,?,?,?,?,?,?)`);
      parsed.containers.forEach(c => {
        const size = c.size || (c.xml_container_type ? (ctMap[c.xml_container_type] || '') : '');
        insCont.run(manifestId,c.container_no,c.container_type,c.package_code,c.amount,c.gross_weight,c.net_weight,c.seal_no1,size);
      });
      const insCBL = db.prepare(`INSERT INTO container_bl (container_no,bl_no,manifest_id) VALUES (?,?,?)`);
      parsed.containerBLs.forEach(cb => insCBL.run(cb.container_no,cb.bl_no,manifestId));
    }
    db.close();
    res.json({ ok:true, manifest_id:manifestId, bl_count:parsed.bls.length });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// (ruta /api/ports eliminada — usar /api/catalogs/ports)

// Listar manifiestos
app.get('/api/manifests', (req,res) => {
  const db = getDB();
  res.json(db.prepare(`
    SELECT m.*, COUNT(b.id) as bl_count
    FROM manifests m LEFT JOIN bills_of_lading b ON b.manifest_id=m.id
    GROUP BY m.id ORDER BY m.created_at DESC
  `).all());
  db.close();
});

// Obtener un manifiesto completo
app.get('/api/manifests/:id', (req,res) => {
  const db = getDB();
  const manifest = db.prepare('SELECT * FROM manifests WHERE id=?').get(req.params.id);
  if (!manifest) { db.close(); return res.status(404).json({ error:'No encontrado' }); }
  res.json({
    manifest,
    bls:          db.prepare('SELECT * FROM bills_of_lading WHERE manifest_id=? ORDER BY bl_no').all(req.params.id),
    containers:   db.prepare('SELECT * FROM containers WHERE manifest_id=?').all(req.params.id),
    container_bl: db.prepare('SELECT * FROM container_bl WHERE manifest_id=?').all(req.params.id),
  });
  db.close();
});

// Actualizar B/L
app.put('/api/bl/:id', (req,res) => {
  const db = getDB();
  const allowed = [
    'goods_name','package_qty','gross_weight','value','package_unit_code',
    'consignor_name','consignor_document_no','consignor_document_type',
    'consignor_tel','consignor_email','consignor_street','consignor_city','consignor_zip',
    'consignee_name','consignee_document_no','consignee_document_type',
    'consignee_tel','consignee_email','consignee_street','consignee_city','consignee_zip',
    'notify_name','notify_document_no','notify_street','notify_city',
    'hacienda_item_code','hacienda_tariff','hacienda_container_no','hacienda_client_ss',
    'hacienda_client_ivu','status','notes','unloading_port_code'
  ];
  const sets=[]; const vals=[];
  allowed.forEach(f=>{ if(req.body[f]!==undefined){ sets.push(`${f}=?`); vals.push(req.body[f]); } });
  if(sets.length){ sets.push(`modified_at=datetime('now')`); vals.push(req.params.id); db.prepare(`UPDATE bills_of_lading SET ${sets.join(',')} WHERE id=?`).run(...vals); }
  db.close();
  res.json({ ok:true });
});

// Actualizar tamaño de contenedor
app.put('/api/containers/:id', (req,res) => {
  const { size } = req.body;
  const db = getDB();
  db.prepare('UPDATE containers SET size=? WHERE id=?').run(size||'', req.params.id);
  db.close();
  res.json({ ok:true });
});

// Eliminar manifiesto (y sus B/L, contenedores, logs — CASCADE)
app.delete('/api/manifests/:id', (req,res) => {
  const db = getDB();
  const manifest = db.prepare('SELECT * FROM manifests WHERE id=?').get(req.params.id);
  if (!manifest) { db.close(); return res.status(404).json({ error:'No encontrado' }); }
  db.prepare('DELETE FROM export_log    WHERE manifest_id=?').run(req.params.id);
  db.prepare('DELETE FROM container_bl  WHERE manifest_id=?').run(req.params.id);
  db.prepare('DELETE FROM containers    WHERE manifest_id=?').run(req.params.id);
  db.prepare('DELETE FROM bills_of_lading WHERE manifest_id=?').run(req.params.id);
  db.prepare('DELETE FROM manifests     WHERE id=?').run(req.params.id);
  db.close();
  res.json({ ok: true, deleted: manifest.voyage_no });
});

// Eliminar un B/L individual (y sus items de carga y vínculos de contenedor)
app.delete('/api/bl/:id', (req, res) => {
  const db = getDB();
  const bl = db.prepare('SELECT * FROM bills_of_lading WHERE id=?').get(req.params.id);
  if (!bl) { db.close(); return res.status(404).json({ error: 'B/L no encontrado' }); }

  db.prepare('DELETE FROM bl_cargo_items WHERE bl_id=?').run(bl.id);
  db.prepare('DELETE FROM container_bl WHERE bl_no=? AND manifest_id=?').run(bl.bl_no, bl.manifest_id);
  db.prepare(`
    DELETE FROM containers
    WHERE manifest_id=?
      AND container_no NOT IN (SELECT container_no FROM container_bl WHERE manifest_id=?)
  `).run(bl.manifest_id, bl.manifest_id);

  db.prepare('DELETE FROM bills_of_lading WHERE id=?').run(bl.id);
  db.close();
  res.json({ ok: true, deleted: bl.bl_no, manifest_id: bl.manifest_id });
});

// Actualizar manifiesto
app.put('/api/manifests/:id', (req,res) => {
  const db = getDB();
  const allowed = ['manifest_no','vessel_name','carrier_code','voyage_no','imo',
                   'loading_port','unloading_port','departure_date','arrival_date','status',
                   'docking_number'];
  const sets=[]; const vals=[];
  allowed.forEach(f=>{ if(req.body[f]!==undefined){ sets.push(`${f}=?`); vals.push(req.body[f]); } });
  if(sets.length){ vals.push(req.params.id); db.prepare(`UPDATE manifests SET ${sets.join(',')} WHERE id=?`).run(...vals); }
  db.close();
  res.json({ ok:true });
});

// ── PUSH AL SISCOMMATE ────────────────────────────────────────────────────────
app.post('/api/manifests/:id/push-siscommate', async (req,res) => {
  try {
    const db = getDB();
    const manifest  = db.prepare('SELECT * FROM manifests WHERE id=?').get(req.params.id);
    if (!manifest) { db.close(); return res.status(404).json({ error:'No encontrado' }); }

    if (!manifest.docking_number) {
      db.close();
      return res.status(400).json({ error: 'El Docking Number es requerido antes de inyectar en SISCOMMATE' });
    }

    const bls          = db.prepare('SELECT * FROM bills_of_lading WHERE manifest_id=? ORDER BY bl_no').all(req.params.id);
    const container_bl = db.prepare('SELECT * FROM container_bl WHERE manifest_id=?').all(req.params.id);
    const containers   = db.prepare('SELECT * FROM containers WHERE manifest_id=?').all(req.params.id);
    const cargoItems   = db.prepare('SELECT * FROM bl_cargo_items WHERE manifest_id=? ORDER BY bl_id, seq').all(req.params.id);
    db.close();

    // Adjuntar tamaño del contenedor a container_bl (para BOLCONT.size)
    const sizeMap = {};
    containers.forEach(c => { sizeMap[c.container_no] = c.size || ''; });

    // Construir lista de containers con tipo para el bridge
    const bridgeContainers = container_bl.map(cb => ({
      bl_no:        cb.bl_no,
      container_no: cb.container_no,
      size:         sizeMap[cb.container_no] || '',
      type:         'R'
    }));

    // Agrupar cargo items por bl_id para adjuntarlos a cada BL
    const itemsByBl = {};
    cargoItems.forEach(it => {
      (itemsByBl[it.bl_id] = itemsByBl[it.bl_id] || []).push(it);
    });

    // Enriquecer BLs con sus cargo items
    bls.forEach(bl => {
      const items = itemsByBl[bl.id];
      if (items && items.length > 0) bl.cargoItems = items;
    });

    // Consultar lote actual (no bloquea si el bridge no responde)
    let loteInfo = { lote: null, siguiente: null };
    try { loteInfo = await bridgeRequest('GET', '/lote', null); } catch(_) {}

    // Enviar al bridge
    const result = await bridgeRequest('POST', '/guardar', {
      manifest,
      bls,
      containers: bridgeContainers
    });

    if (result && result.error) {
      return res.status(502).json({ error: `Bridge reportó error: ${result.error}` });
    }

    // Marcar como enviado
    const db2 = getDB();
    db2.prepare(`UPDATE manifests SET status='siscommate', exported_at=datetime('now') WHERE id=?`).run(req.params.id);
    db2.close();

    res.json({ ok: true, lote_anterior: loteInfo.lote, lote_nuevo: result.lote, bls: result.bls });
  } catch(err) {
    console.error('[PUSH-SISCOMMATE]', err.message);
    res.status(503).json({
      error: 'No se pudo conectar con SiscommateBridge: ' + err.message,
      hint: 'Verifica que SiscommateBridge está corriendo en el servidor (puerto 5001)'
    });
  }
});

// ── ESTADO DEL BRIDGE ─────────────────────────────────────────────────────────
app.get('/api/bridge/status', async (req,res) => {
  try {
    const data = await bridgeRequest('GET', '/health', null);
    res.json({ online: true, ...data });
  } catch(e) {
    res.json({ online: false, error: e.message });
  }
});

// ── EXPORTAR TXT ──────────────────────────────────────────────────────────────
app.get('/api/manifests/:id/export-txt', (req,res) => {
  const db = getDB();
  const manifest = db.prepare('SELECT * FROM manifests WHERE id=?').get(req.params.id);
  if (!manifest) { db.close(); return res.status(404).json({ error:'No encontrado' }); }
  const allBls = db.prepare('SELECT * FROM bills_of_lading WHERE manifest_id=? ORDER BY bl_no').all(req.params.id);

  // Solo se exportan los B/L marcados como validados
  const bls = allBls.filter(bl => bl.status === 'validado');
  if (!bls.length) {
    db.close();
    return res.status(400).json({ error: 'No hay B/L validados en este manifiesto. Marca al menos uno como Validado antes de exportar.' });
  }

  // ── Validaciones previas a la exportación ──────────────────────────────────
  if (!manifest.docking_number || !/^\d+$/.test(manifest.docking_number.trim())) {
    db.close();
    return res.status(400).json({ error: 'El Docking Number es obligatorio y debe ser numérico antes de exportar.' });
  }
  const sinCodigo  = bls.filter(bl => !bl.hacienda_item_code || bl.hacienda_item_code.trim() === '' || /^0+$/.test(bl.hacienda_item_code.trim()));
  const sinTarifa  = bls.filter(bl => !bl.hacienda_tariff);
  const sinSS      = bls.filter(bl => !bl.hacienda_client_ss && !bl.consignee_document_no);
  const descLarga  = bls.filter(bl => (bl.goods_name||'').replace(/[\r\n]+/g,' ').length > 121);
  const errores    = [];
  if (sinCodigo.length)  errores.push(`${sinCodigo.length} B/L sin código arancelario: ${sinCodigo.map(b=>b.bl_no).join(', ')}`);
  if (sinTarifa.length)  errores.push(`${sinTarifa.length} B/L sin tarifa (040/045): ${sinTarifa.map(b=>b.bl_no).join(', ')}`);
  if (sinSS.length)      errores.push(`${sinSS.length} B/L sin SS/EIN consignatario: ${sinSS.map(b=>b.bl_no).join(', ')}`);
  if (descLarga.length)  errores.push(`${descLarga.length} B/L con descripción >121 chars (se truncará en TXT): ${descLarga.map(b=>b.bl_no).join(', ')}`);
  if (errores.length) {
    db.close();
    return res.status(400).json({ error: errores.join(' | ') });
  }

  const carrier = db.prepare('SELECT ivu FROM carriers WHERE code=?').get(manifest.carrier_code);
  manifest.carrier_ivu = carrier ? carrier.ivu : '';

  const containersByBl = {};
  db.prepare('SELECT * FROM container_bl WHERE manifest_id=?').all(req.params.id).forEach(r=>{
    (containersByBl[r.bl_no] = containersByBl[r.bl_no]||[]).push(r.container_no);
  });
  const cargoItemsByBl = {};
  db.prepare('SELECT * FROM bl_cargo_items WHERE manifest_id=? ORDER BY seq').all(req.params.id).forEach(ci=>{
    (cargoItemsByBl[ci.bl_id] = cargoItemsByBl[ci.bl_id]||[]).push(ci);
  });
  bls.forEach(bl=>{
    bl.containers = containersByBl[bl.bl_no] && containersByBl[bl.bl_no].length
      ? containersByBl[bl.bl_no]
      : [bl.hacienda_container_no||''];
    if (!bl.hacienda_container_no) bl.hacienda_container_no = bl.containers[0]||'';
    bl.cargoItems = cargoItemsByBl[bl.id] || null;
  });
  const txt = generateFullTxt(manifest, bls);
  const filename = `${manifest.manifest_no||manifest.voyage_no}_HACIENDA.TXT`;
  // Registrar export y marcar status ANTES de enviar (si res.send falla el cliente
  // puede reintentar — es preferible a no registrarlo nunca)
  db.prepare(`INSERT INTO export_log (manifest_id,filename,bl_count) VALUES (?,?,?)`).run(manifest.id,`${manifest.voyage_no}.TXT`,bls.length);
  db.prepare(`UPDATE manifests SET status='exportado', exported_at=datetime('now') WHERE id=?`).run(manifest.id);
  db.close();
  res.setHeader('Content-Type','text/plain; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
  res.send(txt);
});

// Preview TXT de un B/L
app.get('/api/bl/:id/txt-preview', (req,res) => {
  const db = getDB();
  const bl = db.prepare('SELECT b.*,m.voyage_no,m.manifest_no,m.carrier_code,m.vessel_name,m.departure_date,m.arrival_date FROM bills_of_lading b JOIN manifests m ON m.id=b.manifest_id WHERE b.id=?').get(req.params.id);
  if (!bl) { db.close(); return res.status(404).json({ error:'No encontrado' }); }
  const cbls = db.prepare('SELECT container_no FROM container_bl WHERE bl_no=? AND manifest_id=?').all(bl.bl_no, bl.manifest_id);
  const containerNos = cbls.length ? cbls.map(r=>r.container_no) : [bl.hacienda_container_no||''];
  if (!bl.hacienda_container_no && containerNos[0]) bl.hacienda_container_no = containerNos[0];
  const carrier = db.prepare('SELECT ivu FROM carriers WHERE code=?').get(bl.carrier_code);
  bl.carrier_ivu = carrier ? carrier.ivu : '';
  db.close();
  // Devuelve un par línea1+línea2 por cada contenedor (igual que el TXT real)
  const pairs = containerNos.map(containerNo => ({
    containerNo,
    line1: generateTxtLine1(bl, bl, containerNo),
    line2: generateTxtLine2(bl, containerNo, containerNos.length),
  }));
  res.json({ pairs, line1: pairs[0].line1, line2: pairs[0].line2 });
});

// ── CATÁLOGOS ─────────────────────────────────────────────────────────────────
app.get('/api/catalogs/items', (req,res) => {
  const db = getDB();
  const q  = req.query.q || '';
  // Escapar caracteres especiales de LIKE para evitar wildcards involuntarios
  const qLike = q.replace(/[%_\\]/g, '\\$&');
  const rows = db.prepare(`
    SELECT * FROM hacienda_items
    WHERE description LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\'
    ORDER BY
      CASE WHEN code=? THEN 0
           WHEN code LIKE ? ESCAPE '\\' THEN 1
           WHEN description LIKE ? ESCAPE '\\' THEN 2
           ELSE 3 END,
      length(code), code
    LIMIT 40
  `).all(`%${qLike}%`, `%${qLike}%`, q, `${qLike}%`, `${qLike}%`);
  db.close();
  res.json(rows);
});

// Sugerir código arancelario basado en descripción de la mercancía
app.get('/api/catalogs/items/suggest', (req,res) => {
  const db   = getDB();
  const desc = (req.query.desc || '').toLowerCase();
  if (!desc || desc.length < 3) { db.close(); return res.json([]); }

  // Extraer palabras clave de la descripción (ignorar palabras cortas y comunes)
  const stopWords = new Set(['and','the','for','with','not','per','are','fue','los','las','del','con','para','que','una','uno']);
  const words = desc.split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w)).slice(0, 5);

  if (!words.length) { db.close(); return res.json([]); }

  // Buscar coincidencias por cada palabra clave
  const candidates = [];
  const seen = new Set();
  words.forEach(word => {
    db.prepare(`SELECT *, ? as match_word FROM hacienda_items WHERE description LIKE ? LIMIT 10`)
      .all(word, `%${word}%`)
      .forEach(row => { if(!seen.has(row.code)){ seen.add(row.code); candidates.push(row); } });
  });

  // Puntuar: cuántas palabras clave aparecen en la descripción
  const scored = candidates.map(item => {
    let score = 0;
    words.forEach(w => { if(item.description.toLowerCase().includes(w)) score++; });
    return { ...item, score };
  }).sort((a,b) => b.score - a.score).slice(0, 8);

  db.close();
  res.json(scored);
});

app.get('/api/catalogs/ports',   (req,res) => { const db=getDB(); res.json(db.prepare('SELECT * FROM ports ORDER BY country,description').all()); db.close(); });
app.get('/api/catalogs/carriers',(req,res) => { const db=getDB(); res.json(db.prepare('SELECT * FROM carriers').all()); db.close(); });
app.get('/api/catalogs/clients', (req,res) => {
  const db = getDB();
  const q  = req.query.q || '';
  res.json(db.prepare(`SELECT * FROM clients WHERE name LIKE ? OR taxid LIKE ? OR ss LIKE ? ORDER BY name LIMIT 20`).all(`%${q}%`,`%${q}%`,`%${q}%`));
  db.close();
});

// Crear nuevo consignatario
app.post('/api/catalogs/clients', (req,res) => {
  const { name, ss, taxid, add1, add2, phone1, ivu } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  const ssSanitized = String(ss||'').replace(/[^0-9]/g,'').substring(0,9);
  if (ssSanitized.length < 9) return res.status(400).json({ error: 'El SS/EIN debe tener 9 dígitos numéricos' });
  const db = getDB();
  // Verificar si ya existe ese SS/EIN
  const exists = db.prepare(`SELECT id,name FROM clients WHERE ss=?`).get(ssSanitized);
  if (exists) {
    db.close();
    return res.status(409).json({ error: `Ya existe un consignatario con SS ${ssSanitized}: ${exists.name}`, client: exists });
  }
  const info = db.prepare(`INSERT INTO clients (name,ss,taxid,add1,add2,phone1,ivu) VALUES (?,?,?,?,?,?,?)`)
    .run(name.trim(), ssSanitized, taxid||'', add1||'', add2||'', phone1||'', ivu||'');
  const client = db.prepare(`SELECT * FROM clients WHERE id=?`).get(info.lastInsertRowid);
  db.close();
  res.json({ ok: true, client });
});

// Actualizar consignatario
app.put('/api/catalogs/clients/:id', (req,res) => {
  const { name, ss, taxid, add1, add2, phone1, ivu } = req.body;
  const ssSanitized = ss ? String(ss).replace(/[^0-9]/g,'').substring(0,9) : undefined;
  const db = getDB();
  const sets = []; const vals = [];
  if (name)         { sets.push('name=?');  vals.push(name.trim()); }
  if (ssSanitized)  { sets.push('ss=?');    vals.push(ssSanitized); }
  if (taxid!==undefined){ sets.push('taxid=?'); vals.push(taxid); }
  if (add1!==undefined) { sets.push('add1=?');  vals.push(add1); }
  if (add2!==undefined) { sets.push('add2=?');  vals.push(add2); }
  if (phone1!==undefined){ sets.push('phone1=?'); vals.push(phone1); }
  if (ivu!==undefined)  { sets.push('ivu=?');   vals.push(ivu); }
  if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE clients SET ${sets.join(',')} WHERE id=?`).run(...vals); }
  const client = db.prepare(`SELECT * FROM clients WHERE id=?`).get(req.params.id);
  db.close();
  res.json({ ok: true, client });
});

// Buques disponibles (hardcoded del SISCOMMATE, puede moverse a tabla)
app.get('/api/catalogs/vessels', (req,res) => {
  res.json([
    { code:'EMVS20170336', name:'KYDON',           imo:'8916607', carrier:'MMARINEX', scac:'MXS' },
    { code:'EMVS20190966', name:'LYKTOS',          imo:'8401145', carrier:'MMARINEX', scac:'MXS' },
    { code:'EMVS20190510', name:'CARIBBEAN FORCE', imo:'9335161', carrier:'MMARINEX', scac:'MXS' },
  ]);
});

// Búsqueda global (viajes + B/L)
app.get('/api/search', (req,res) => {
  const db = getDB();
  const q  = (req.query.q || '').trim();
  if (q.length < 2) { db.close(); return res.json({ manifests:[], bls:[] }); }
  const like = `%${q}%`;
  const manifests = db.prepare(`
    SELECT m.*, COUNT(b.id) as bl_count
    FROM manifests m LEFT JOIN bills_of_lading b ON b.manifest_id=m.id
    WHERE m.voyage_no LIKE ? OR m.vessel_name LIKE ? OR m.manifest_no LIKE ? OR m.filename LIKE ?
    GROUP BY m.id ORDER BY m.created_at DESC LIMIT 20
  `).all(like, like, like, like);
  const bls = db.prepare(`
    SELECT b.id, b.bl_no, b.consignee_name, b.status, b.manifest_id,
           m.voyage_no, m.vessel_name, m.arrival_date
    FROM bills_of_lading b JOIN manifests m ON m.id=b.manifest_id
    WHERE b.bl_no LIKE ? OR b.consignee_name LIKE ? OR b.consignor_name LIKE ?
    ORDER BY m.created_at DESC LIMIT 30
  `).all(like, like, like);
  db.close();
  res.json({ manifests, bls });
});

// Stats
app.get('/api/stats', (req,res) => {
  const db = getDB();
  res.json({
    manifests: db.prepare('SELECT COUNT(*) as n FROM manifests').get().n,
    bls:       db.prepare('SELECT COUNT(*) as n FROM bills_of_lading').get().n,
    pending:   db.prepare("SELECT COUNT(*) as n FROM bills_of_lading WHERE status='pendiente'").get().n,
    siscommate:db.prepare("SELECT COUNT(*) as n FROM manifests WHERE status='siscommate'").get().n,
  });
  db.close();
});

// ── SETTINGS ─────────────────────────────────────────────────────────────────
app.get('/api/settings', (req,res) => {
  const db = getDB();
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  db.close();
  const obj = {};
  rows.forEach(r => { obj[r.key] = r.value; });
  res.json(obj);
});

app.put('/api/settings', (req,res) => {
  const allowed = ['bridge_host','bridge_port','dbf_path'];
  const db = getDB();
  const upd = db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  allowed.forEach(k => { if (req.body[k] !== undefined) upd.run(k, String(req.body[k]).trim()); });
  db.close();
  res.json({ ok: true });
});

// ── CATÁLOGO CONTAINER TYPE MAP ──────────────────────────────────────────────
app.get('/api/catalogs/container-types', (req,res) => {
  const db = getDB();
  res.json(db.prepare(`SELECT * FROM container_type_map ORDER BY xml_type`).all());
  db.close();
});

app.put('/api/catalogs/container-types/:xmlType', (req,res) => {
  const { size, label } = req.body;
  const db = getDB();
  db.prepare(`INSERT INTO container_type_map(xml_type,size,label) VALUES(?,?,?) ON CONFLICT(xml_type) DO UPDATE SET size=excluded.size, label=excluded.label`)
    .run(req.params.xmlType, size||'', label||'');
  db.close();
  res.json({ ok: true });
});

app.post('/api/catalogs/container-types', (req,res) => {
  const { xml_type, size, label } = req.body;
  if (!xml_type || !size) return res.status(400).json({ error: 'xml_type y size requeridos' });
  const db = getDB();
  try {
    db.prepare(`INSERT INTO container_type_map(xml_type,size,label) VALUES(?,?,?)`).run(xml_type.trim(), size.trim(), label||'');
    db.close();
    res.json({ ok: true });
  } catch(e) {
    db.close();
    res.status(409).json({ error: 'Código XML ya existe: ' + e.message });
  }
});

app.delete('/api/catalogs/container-types/:xmlType', (req,res) => {
  const db = getDB();
  db.prepare(`DELETE FROM container_type_map WHERE xml_type=?`).run(req.params.xmlType);
  db.close();
  res.json({ ok: true });
});

// ── CARGO ITEMS POR B/L ───────────────────────────────────────────────────────
app.get('/api/bl/:id/cargo-items', (req,res) => {
  const db = getDB();
  res.json(db.prepare(`SELECT * FROM bl_cargo_items WHERE bl_id=? ORDER BY seq,id`).all(req.params.id));
  db.close();
});

app.post('/api/bl/:id/cargo-items', (req,res) => {
  const bl_id = parseInt(req.params.id);
  const db = getDB();
  const bl = db.prepare(`SELECT manifest_id FROM bills_of_lading WHERE id=?`).get(bl_id);
  if (!bl) { db.close(); return res.status(404).json({ error: 'B/L no encontrado' }); }
  const { container_no, goods_name, gross_weight, hacienda_item_code, hacienda_tariff, seq } = req.body;
  const maxSeq = db.prepare(`SELECT COALESCE(MAX(seq),0) as m FROM bl_cargo_items WHERE bl_id=?`).get(bl_id).m;
  const info = db.prepare(`INSERT INTO bl_cargo_items (bl_id,manifest_id,container_no,goods_name,gross_weight,hacienda_item_code,hacienda_tariff,seq) VALUES (?,?,?,?,?,?,?,?)`)
    .run(bl_id, bl.manifest_id, container_no||null, goods_name||'', parseFloat(gross_weight)||0, hacienda_item_code||null, hacienda_tariff||null, seq||maxSeq+1);
  const item = db.prepare(`SELECT * FROM bl_cargo_items WHERE id=?`).get(info.lastInsertRowid);
  db.close();
  res.json({ ok: true, item });
});

app.put('/api/bl-cargo-items/:id', (req,res) => {
  const allowed = ['container_no','goods_name','gross_weight','hacienda_item_code','hacienda_tariff','seq'];
  const db = getDB();
  const sets=[]; const vals=[];
  allowed.forEach(f=>{ if(req.body[f]!==undefined){ sets.push(`${f}=?`); vals.push(req.body[f]===''&&f==='container_no'?null:req.body[f]); }});
  if(sets.length){ vals.push(req.params.id); db.prepare(`UPDATE bl_cargo_items SET ${sets.join(',')} WHERE id=?`).run(...vals); }
  db.close();
  res.json({ ok: true });
});

app.delete('/api/bl-cargo-items/:id', (req,res) => {
  const db = getDB();
  db.prepare(`DELETE FROM bl_cargo_items WHERE id=?`).run(req.params.id);
  db.close();
  res.json({ ok: true });
});

// ─── INICIAR ─────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✓ Manifest Editor corriendo en http://localhost:${PORT}`);
  console.log(`  Base de datos: ${DB_PATH}`);
  console.log(`  Bridge SISCOMMATE: http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
  console.log(`  Acceso en red: http://[IP]:${PORT}\n`);
});
