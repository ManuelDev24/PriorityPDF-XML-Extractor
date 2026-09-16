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
  // Fuera de ese patrón exacto (p.ej. cuando el PDF omite el prefijo de 4
  // letras, o cuando es una marca tipo "PALLET-000123"), cualquier símbolo
  // (guión, punto, dos puntos, etc.) no aporta nada al número de contenedor
  // — se quita todo lo que no sea letra o número, igual que hace el TXT al
  // escribirlo, para no depender de encontrar cada símbolo suelto a mano.
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
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
    if (/^[—-]?\s*(SH|CO|NO|NF|KG|LBS)$/.test(t) || /^P[aá]gina/i.test(t) || /^Page/i.test(t) ||
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

  // Último B/L reconocido — persiste entre páginas porque un mismo B/L con
  // varios contenedores puede partirse en un salto de página (ver más abajo).
  let lastBlNo = '';
  // Contadores para las advertencias de consistencia al final del parseo —
  // cada carrier/barco imprime su PDF con variaciones de formato distintas
  // (la de hoy: celdas de B/L fusionadas), y no hay forma de "aprender" un
  // layout nuevo sin verlo antes. Esto no evita el problema, pero lo saca a
  // la luz al momento de cargar en vez de perderse en silencio como pasó con
  // CF365 — quien carga el PDF ve la advertencia y puede revisar a mano.
  let contenedoresReconectados = 0;
  // Contenedor huérfano que NO se reconecta porque justo antes termina un
  // bloque de dirección completo — la fila real a la que pertenece tiene su
  // propio "PYRR-XXXXXXX" perdido en la extracción del PDF (ver comentario
  // más abajo). Se pierde ese contenedor puntual en vez de arriesgar
  // corromper el peso de todos los B/L que siguen.
  let contenedorSinBlPerdido = 0;
  let totalWeightPdf = 0;

  // Números de peso (KG,LBS) de TODO el documento, en el mismo orden en que
  // aparecen — NO se reinician por página. El par de una fila puede quedar
  // partido justo en el salto de página (el KG al final de una página, su
  // LBS al inicio de la siguiente): si se empareja por página, esa página
  // "adelantada" en media pareja desalinea TODOS los pesos siguientes de
  // ahí en adelante (cada entrada recibe el peso de la fila anterior o
  // siguiente, en KG o LBS mezclados). Emparejando de una sola vez al final,
  // sobre el documento completo, el corte de página deja de importar.
  const allPureNums = [];

  rawPages.forEach((pageText, pIdx) => {
    if (!pageText.trim()) return;
    const lines = pageText.split('\n');

    // Pesos al inicio de la página
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (/^\s*\d{1,3}(?:,\d{3})*\.\d{2}\s*$/.test(l)) allPureNums.push(parsePdfNum(l));
      if (/1\.- Name of Ship/i.test(l) || /BL Numbers/i.test(l)) break;
    }

    // Entradas de B/L en la página. El PDF imprime el B/L con guión
    // ("PYRR-2624176"), pero el mismo número en el XML de la DGA no lo trae
    // ("PYRR2624176") — se exige el guión para reconocer la línea (evita
    // confundir con otro texto), pero se guarda sin él para que ambas fuentes
    // usen el mismo formato.
    //
    // El patrón PREFIJO-DÍGITOS no es exclusivo del B/L: una marca de carga
    // suelta como "PALLET-0000138879" (que en otras filas del mismo PDF
    // aparece como container_no de un B/L real) tiene la misma forma. Si esa
    // marca cae al inicio de una línea — típicamente cuando el B/L real que
    // la precedía se perdió en un salto de página, el mismo patrón que ya
    // afecta a Consignador — el parser la confundía con un B/L nuevo,
    // reemplazando el "PYRR..." real. Se excluyen los prefijos conocidos de
    // tipo de empaque/carga suelta, nunca códigos de transportista reales.
    const PREFIJOS_NO_BL = /^(PALLET|BOX|LCL|CRATE|CARTON|DRUM|SKID|BUNDLE|ROLL|PACKAGE|PKG|LOOSE)$/i;
    const blLineRe = /^([A-Z]{2,6})-(\d{5,10})(?:\s+(\S.*))?$/;
    const pageEntries = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      const m = raw.match(blLineRe);
      let blNo = '';
      let rawSecondToken = '';

      if (m && !PREFIJOS_NO_BL.test(m[1])) {
        blNo = m[1] + m[2];
        rawSecondToken = (m[3] || '').trim();
        lastBlNo = blNo;
      } else {
        // Contenedor "huérfano": cuando un B/L tiene más de un contenedor, la
        // celda del B/L en el PDF original está fusionada visualmente para
        // esas filas extra — el texto extraído no repite "PYRR-1234567" y la
        // línea llega sola, solo con el número de contenedor. Sin esto la
        // línea no hacía match con nada y se perdía entera (contenedor Y
        // peso), aunque sí perteneciera a un B/L real — confirmado contra
        // manifiestos reales de flatbed/rebar con muchos contenedores por B/L
        // (ej. CF365: PYRR-2631003, PYRR-2631004).
        if (!lastBlNo) continue;
        const cleanedOrphan = normContainerNo(raw);
        if (!isIsoContainer(cleanedOrphan)) continue;
        // Pero si justo antes (sin nada de por medio) termina un bloque de
        // dirección completo — "... (PUERTO RICO)", "... (REPUBLICA
        // DOMINICANA)", etc., el mismo patrón con el que SIEMPRE cierra un
        // bloque de shipper/consignee/notify — esto NO es una fila fusionada
        // del B/L anterior: es una fila nueva cuyo propio "PYRR-XXXXXXX" se
        // perdió en la extracción del PDF (bug real encontrado con K1338,
        // B/L "PYRR-2630003": un contenedor de OTRO envío, con su propio
        // shipper/consignee/notify completo, quedó pegado al B/L anterior
        // sin ningún B/L real de por medio). Reconectarlo de todas formas
        // no solo pone el contenedor en el B/L equivocado — como ese
        // contenedor NO tiene peso propio en el PDF, "roba" el peso del
        // siguiente B/L real y desalinea el peso de TODOS los que siguen.
        // Mejor perder este contenedor puntual (con aviso) que corromper el
        // peso de todo el resto del manifiesto.
        let j2 = i - 1;
        while (j2 >= 0 && lines[j2].trim() === '') j2--;
        if (j2 >= 0 && /\([A-ZÁÉÍÓÚÑ\s.,\-]+\)\s*$/i.test(lines[j2].trim())) {
          contenedorSinBlPerdido++;
          continue;
        }
        blNo = lastBlNo;
        rawSecondToken = raw;
        contenedoresReconectados++;
      }

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
        } else if (!/^[—-]?(KG|LBS|N\/?A)$/i.test(cleaned) && cleaned.replace(/[^A-Z0-9]/gi, '').length >= 6) {
          // Cuando la celda "No. de contenedor" viene vacía en el PDF (fila
          // de un contenedor adicional del mismo B/L), lo que queda pegado a
          // continuación del B/L en el texto extraído es la etiqueta de peso
          // ("KG"/"LBS") de esa misma fila, no un número de contenedor. Sin
          // este filtro se guardaba "KG" como si fuera el contenedor.
          containerNo = cleaned;
        }
      }

      const e = {
        bl_no: blNo,
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
        // El peso en blanco se imprime como "— KG"/"— LBS" (celda vacía +
        // etiqueta de unidad) en vez de solo "KG"/"LBS" — sin el "—?" ese
        // texto se colaba como si fuera parte de la descripción.
        if (/^[—-]?\s*(KG|LBS)$/.test(t)) break;
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
        if (/^[—-]?\s*(KG|LBS|SH|CO|NO|NF)$/.test(t) || /^P[aá]gina/i.test(t) || /^Page/i.test(t) || /^1\.- Name/i.test(t)) break;
        desc.push(t);
        if (desc.join(' ').length > 400) break;
      }
      e.goods = desc.join(' ').replace(/\s+/g, ' ').trim().substring(0, 300);

      const parties = collectPartyBlocks(lines, i);
      e.shipper = parties[0]; e.consignee = parties[1]; e.notify = parties[2];
      pageEntries.push(e);
    }

    pageEntries.forEach(e => allEntries.push(e));
  });

  // Un peso por fila, emparejado sobre el documento COMPLETO (ver comentario
  // de allPureNums más arriba) — así el corte de página no desalinea nada.
  const allWeightsKg = [];
  for (let i = 0; i + 1 < allPureNums.length; i += 2) allWeightsKg.push(allPureNums[i]);
  totalWeightPdf = allWeightsKg.reduce((a, b) => a + b, 0);
  allEntries.forEach((e, idx) => { e.gross_weight = idx < allWeightsKg.length ? allWeightsKg[idx] : 0; });

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

  const bls = [...blMap.values()];

  // ── Advertencias de consistencia ──────────────────────────────────────────
  // No detectan un layout nuevo por sí solas — comparan cifras que deberían
  // cuadrar sin importar el formato del PDF, así que cualquier fila que el
  // parser haya perdido o malinterpretado (el bug de hoy, o uno futuro con
  // otro carrier) deja una diferencia medible en vez de pasar inadvertido.
  const warnings = [];
  const totalWeightAsignado = bls.reduce((a, bl) => a + bl.gross_weight, 0);
  // Margen de 1 kg: redondeos de parsePdfNum entre páginas, no un error real.
  if (Math.abs(totalWeightAsignado - totalWeightPdf) > 1) {
    warnings.push(
      `El peso total repartido entre los B/L (${totalWeightAsignado.toFixed(2)} kg) no coincide ` +
      `con el peso total impreso en el PDF (${totalWeightPdf.toFixed(2)} kg) — puede haberse ` +
      `perdido o duplicado una fila. Revisa los B/L antes de continuar.`
    );
  }
  if (contenedoresReconectados > 0) {
    warnings.push(
      `${contenedoresReconectados} contenedor${contenedoresReconectados > 1 ? 'es' : ''} ` +
      `aparecía${contenedoresReconectados > 1 ? 'n' : ''} en el PDF sin el número de B/L junto ` +
      `(celda fusionada en el PDF original) y se reconectó automáticamente con el B/L anterior — ` +
      `confirma que quedó en el B/L correcto.`
    );
  }
  if (contenedorSinBlPerdido > 0) {
    warnings.push(
      `${contenedorSinBlPerdido} contenedor${contenedorSinBlPerdido > 1 ? 'es' : ''} ` +
      `aparecía${contenedorSinBlPerdido > 1 ? 'n' : ''} en el PDF con su propia dirección de ` +
      `shipper/consignatario pero SIN ningún número de B/L junto — a diferencia del aviso ` +
      `anterior, no se reconectó con el B/L de arriba (habría quedado en el B/L equivocado y ` +
      `corrompido el peso de los demás) y por ahora se perdió esa fila. Revisar el PDF original: ` +
      `probablemente falta un "PYRR-XXXXXXX" que no se imprimió o no se pudo leer.`
    );
  }
  const conContenedor = new Set(containerBLs.map(cb => cb.bl_no));
  const blsSinContenedor = bls.filter(bl => !conContenedor.has(bl.bl_no)).length;
  if (blsSinContenedor > 0) {
    warnings.push(
      `${blsSinContenedor} B/L no trae${blsSinContenedor > 1 ? 'n' : ''} ningún número de ` +
      `contenedor en el PDF — puede ser carga suelta real, o un dato que faltó digitar en el ` +
      `manifiesto original.`
    );
  }

  return { header, bls, containers, containerBLs, cargoItems, warnings };
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

  return { header, bls, containers, containerBLs, warnings: [] };
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

/**
 * Un mismo número de contenedor apareciendo en DOS B/L distintos del mismo
 * archivo casi siempre es un error de digitación en el manifiesto original o
 * de lectura del PDF (un contenedor real nunca pertenece a dos B/L a la
 * vez) — bug real encontrado analizando K1339. Aplica sobre el resultado ya
 * parseado (containerBLs), así que sirve para CUALQUIER formato — PDF 1302,
 * DGA genérico o XML — sin repetir la lógica en cada parser.
 *
 * Se nombra el/los contenedor(es) exactos y en qué B/L aparecen — mientras
 * no haya forma de saber automáticamente cuál copia es la correcta, esto
 * permite revisar a mano y quitar la sobrante desde "Contenedores
 * asociados" (ícono de papelera) en el B/L equivocado, en vez de
 * descubrirlo después en SISCOMMATE.
 * @param {{bl_no: string, container_no: string}[]} containerBLs
 * @returns {string[]} Advertencias a agregar a parsed.warnings (vacío si no hay problema)
 */
function advertirContenedoresEnVariosBl(containerBLs) {
  const blsPorContenedor = new Map();
  (containerBLs || []).forEach(cb => {
    if (!blsPorContenedor.has(cb.container_no)) blsPorContenedor.set(cb.container_no, new Set());
    blsPorContenedor.get(cb.container_no).add(cb.bl_no);
  });
  const repetidos = [...blsPorContenedor.entries()].filter(([, bls]) => bls.size > 1);
  if (!repetidos.length) return [];
  const detalle = repetidos.map(([cont, bls]) => `${cont} (en ${[...bls].join(' y ')})`).join(', ');
  return [
    `${repetidos.length} contenedor${repetidos.length > 1 ? 'es' : ''} aparece${repetidos.length > 1 ? 'n' : ''} repetido${repetidos.length > 1 ? 's' : ''} en más de un B/L — casi seguro un error de digitación en el manifiesto original o de lectura del PDF: ${detalle}. Revisa cuál es el correcto y quita el sobrante desde "Contenedores asociados" en el B/L equivocado (ícono de papelera) antes de continuar.`,
  ];
}

module.exports = {
  normalizePdfDate, parsePdfNum, grabPdf, emptyPdfBL,
  isIsoContainer, normContainerNo, isPhoneNumber,
  parsePdfParty, collectPartyBlocks,
  isCustoms1302, parseCustoms1302, parseGenericDga, parsePdfManifest,
  advertirContenedoresEnVariosBl,
};
