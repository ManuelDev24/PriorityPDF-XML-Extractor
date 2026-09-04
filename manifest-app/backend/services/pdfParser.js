// services/pdfParser.js — Parser de manifiestos en PDF
//
// Extraído de server.js (paso 3 de la separación backend/frontend).
//
// Soporta dos formatos:
//   1. US Customs 1302 (cargo manifest de Priority RORO / SIGA) — parser posicional
//   2. PDF genérico de la DGA — extracción heurística por expresiones regulares
//
// El PDF debe ser digital (generado por un sistema), no un escaneo sin texto.

const pdfParse = require('pdf-parse');

/** @typedef {import('../types').ParsedManifest} ParsedManifest */
/** @typedef {import('../types').ParsedBL} ParsedBL */
/** @typedef {import('../types').PdfParty} PdfParty */

// Normaliza fechas DD/MM/YYYY, DD-MM-YYYY o YYYY-MM-DD → YYYY-MM-DD
/**
 * Normaliza DD/MM/YYYY, DD-MM-YYYY o YYYY-MM-DD a YYYY-MM-DD.
 * @param {string|null|undefined} s
 * @returns {string} Cadena vacía si no reconoce el formato
 */
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
/**
 * Convierte un número con separador de miles a float, aceptando formato
 * americano (1,234.56) y europeo (1.234,56).
 * @param {string|null|undefined} s
 * @returns {number} 0 si no es convertible
 */
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
/**
 * Devuelve el primer grupo capturado por la primera expresión que haga match.
 * @param {string} text
 * @param {RegExp[]} regexes Etiquetas alternativas, en orden de preferencia
 * @returns {string} Cadena vacía si ninguna coincide
 */
function grabPdf(text, regexes) {
  for (const re of regexes) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

// B/L con todos los campos que espera el INSERT (better-sqlite3 no acepta undefined)
/**
 * B/L con todos los campos que espera el INSERT inicializados.
 * better-sqlite3 no acepta undefined, por eso no se pueden omitir.
 * @returns {ParsedBL}
 */
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

/**
 * ¿El texto parece un contenedor? Sirve para no confundir un número de B/L
 * con uno de contenedor: en ISO 6346 la cuarta letra solo puede ser U, J o Z.
 * @param {string} s
 * @returns {boolean}
 */
function isIsoContainer(s) {
  return /^[A-Z]{3}[UJZ]\d{6,7}$/i.test(s) || /^(PRRU|MXRU|CRSU|GVTU|MCLU|CAXU|TGHU|TEMU|SEGU|MSKU)\d+$/i.test(s);
}

/**
 * Une un número de contenedor partido por el PDF: "PRRU 201010-6" a "PRRU2010106".
 * @param {string|null|undefined} raw
 * @returns {string}
 */
function normContainerNo(raw) {
  if (!raw) return '';
  const m = raw.match(/^([A-Z]{4})\s*(\d{6})\s*-?\s*(\d)?$/);
  if (m) return m[1] + m[2] + (m[3] || '');
  return raw.replace(/\s+/g, '');
}

/**
 * ¿La línea es un teléfono y no parte de una dirección?
 * @param {string} l
 * @returns {boolean}
 */
function isPhoneNumber(l) {
  const clean = l.trim();
  const digits = clean.replace(/\D/g, '');
  if (digits.length < 7) return false;
  return /^[\d\s()\-.\/+]+$/.test(clean) || /(?:Tel|Phone|Cel|Fax|Mobile)/i.test(clean);
}

// Bloque de dirección → { name, street, city, zip, tel, email, document_no, document_type }
/**
 * Convierte un bloque de dirección en sus campos.
 * @param {string[]|null|undefined} blockLines
 * @returns {PdfParty} Campos vacíos si el bloque no existe, nunca undefined
 */
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

    // Teléfono. isPhoneNumber ya solo deja pasar líneas con caracteres de
    // teléfono (dígitos/espacios/paréntesis/guión/punto/slash/+) o la palabra
    // Tel/Phone/etc, así que no hace falta recortar — un límite de 30
    // truncaba casos reales de dos teléfonos separados por " - " (32+ chars).
    if (isPhoneNumber(raw)) {
      if (!p.tel || p.tel.replace(/\D/g,'').length < raw.replace(/\D/g,'').length) {
        p.tel = raw;
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
/**
 * Recolecta hacia atrás los 3 bloques de dirección que preceden a la línea del B/L.
 * @param {string[]} lines Líneas de la página
 * @param {number} blIdx Índice de la línea del B/L
 * @returns {Array<string[]|null>} [shipper, consignee, notify]; null si falta alguno
 */
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

/**
 * Parsea el formato US Customs 1302 (cargo manifest de Priority RORO).
 *
 * Es el único parser que produce cargoItems: genera una entrada por cada línea
 * del manifiesto, lo que permite varios ítems o vehículos por un mismo B/L.
 * @param {string} text Texto extraído del PDF
 * @returns {ParsedManifest}
 */
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

    // Entradas de B/L en la página. El PDF imprime el B/L con guión
    // ("PYRR-2624176"), pero el mismo número en el XML de la DGA no lo trae
    // ("PYRR2624176") — se exige el guión para reconocer la línea (evita
    // confundir con otro texto), pero se guarda sin él para que ambas fuentes
    // usen el mismo formato.
    const blLineRe = /^([A-Z]{2,6})-(\d{5,10})(?:\s+(\S.*))?$/;
    const pageEntries = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].trim().match(blLineRe);
      if (!m) continue;

      const rawSecondToken = (m[3] || '').trim();
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
        bl_no: m[1] + m[2],
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

// ¿El texto corresponde al formato US Customs 1302 de Priority RORO?
/**
 * ¿El texto corresponde al formato US Customs 1302 de Priority RORO?
 * @param {string} text
 * @returns {boolean}
 */
function isCustoms1302(text) {
  return /Name of Ship/i.test(text) && (
    /N[uú]mero de recibo/i.test(text) ||
    /Voyage Number/i.test(text) ||
    /Customs Form 1300/i.test(text) ||
    /BL Numbers/i.test(text)
  );
}

// ── Parser genérico de manifiestos DGA en PDF ────────────────────────────────
// Extracción heurística por expresiones regulares, para PDF digitales que no
// siguen el formato US Customs 1302.
/**
 * Parser genérico de manifiestos DGA en PDF, por expresiones regulares.
 * Para PDF digitales que no siguen el formato US Customs 1302.
 * @param {string} text Texto extraído del PDF
 * @returns {ParsedManifest} Sin cargoItems
 * @throws {Error} Si no encuentra ningún B/L reconocible
 */
function parseGenericDga(text) {
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

// Punto de entrada: extrae el texto del PDF y elige el parser según el formato.
/**
 * Punto de entrada: extrae el texto del PDF y elige el parser según el formato.
 * @param {Buffer} buffer Contenido del archivo PDF
 * @returns {Promise<ParsedManifest>}
 * @throws {Error} Si el PDF no tiene texto extraíble (escaneo) o no se reconoce
 */
async function parsePdfManifest(buffer) {
  const data = await pdfParse(buffer);
  const text = (data.text || '').replace(/ /g, ' ');
  if (!text.trim()) {
    throw new Error('El PDF no contiene texto extraíble (parece un escaneo). Usa un PDF generado digitalmente o el XML de la DGA.');
  }

  // Tipo 1 — US Customs 1302 (cargo manifest Priority RORO / SIGA / Inbound & Outbound)
  if (isCustoms1302(text)) {
    const r = parseCustoms1302(text);
    if (r.bls.length) return r;
  }

  // Tipo 2 — PDF genérico de la DGA
  return parseGenericDga(text);
}

module.exports = {
  normalizePdfDate, parsePdfNum, grabPdf, emptyPdfBL,
  isIsoContainer, normContainerNo, isPhoneNumber,
  parsePdfParty, collectPartyBlocks,
  isCustoms1302, parseCustoms1302, parseGenericDga, parsePdfManifest,
};
