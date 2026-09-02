// editor.js — Editor principal del B/L y del manifiesto
// Extraído de index.html (paso 6 de la separación frontend/backend)

function renderEditor(bl){
  const m=currentManifestData.manifest;
  // Todos los contenedores asociados a este B/L (puede haber varios) — con su tamaño
  const cblAll=currentManifestData.container_bl.filter(c=>c.bl_no===bl.bl_no).map(c=>{
    const full=currentManifestData.containers.find(ct=>ct.container_no===c.container_no);
    return { container_no:c.container_no, id:full?full.id:null, size:full?full.size:'' };
  });
  const containerNo=bl.hacienda_container_no||(cblAll.length?cblAll[0].container_no:'');
  // Defecto visual de tarifa — solo en memoria, NO se persiste automáticamente
  if(!bl.hacienda_tariff) bl.hacienda_tariff='040';

  // Opciones de carrier
  const carrierOpts=catalogCarriers.map(c=>
    `<option value="${esc(c.code)}" ${(m.carrier_code===c.code||(!m.carrier_code&&c.code==='MPRIORO'))?'selected':''}>${esc(c.name)} (${esc(c.scac)})</option>`
  ).join('');

  // Opciones de buque
  const vesselOpts=catalogVessels.map(v=>
    `<option value="${esc(v.code)}" ${m.vessel_code===v.code?'selected':''}>${esc(v.name)} — IMO ${esc(v.imo)}</option>`
  ).join('');

  // Opciones de puertos — agrupados por país (reutilizado para origen y destino)
  const countryNames={'PR':'Puerto Rico','DO':'Rep. Dominicana','US':'Estados Unidos','VI':'Islas Vírgenes (US)','VG':'Islas Vírgenes (UK)','SX':'St. Maarten','MF':'St. Martin','KN':'Saint Kitts','AG':'Antigua','MX':'México','CN':'China'};
  function buildPortOpts(fieldVal, defaultCode) {
    const groups=[...new Set(catalogPorts.map(p=>p.country))];
    return groups.map(country=>{
      const label=countryNames[country]||country;
      const opts=catalogPorts.filter(p=>p.country===country).map(p=>
        `<option value="${esc(p.code)}" ${fieldVal===p.code||(!fieldVal&&p.code===defaultCode)?'selected':''}>${esc(p.code)} — ${esc(p.description)}</option>`
      ).join('');
      return `<optgroup label="${esc(label)}">${opts}</optgroup>`;
    }).join('');
  }
  const portOptsOrigin = buildPortOpts(m.loading_port, 'DRP');
  const portOptsPR     = buildPortOpts(m.unloading_port, 'XSJ');

  document.getElementById('editor').innerHTML=`

  <!-- ── MANIFIESTO ──────────────────────────────── -->
  <div class="card">
    <div class="card-hdr"><i class="ti ti-ship"></i> Manifiesto — Viaje ${esc(m.voyage_no)}
      <span class="badge ${m.status==='siscommate'?'sis':m.status==='exportado'?'exp':'pend'}" style="margin-left:auto">${esc(m.status)}</span>
    </div>
    <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
      <!-- Fila 1: Buque e identificación -->
      <div class="fg fg3">
        <div class="field" style="grid-column:1/3">
          <label>Buque</label>
          <select onchange="onVesselChange(this.value)">
            <option value="">— selecciona —</option>${vesselOpts}
          </select>
        </div>
        <div class="field">
          <label>IMO</label>
          <input id="f-imo" value="${esc(m.imo||vesselImo(m.vessel_code)||'')}" onchange="updateManifest('imo',this.value)" placeholder="Número IMO"/>
        </div>
      </div>
      <!-- Fila 2: Carrier y número de manifiesto -->
      <div class="fg fg2">
        <div class="field">
          <label>Carrier Hacienda PR</label>
          <select onchange="updateManifest('carrier_code',this.value)">
            ${carrierOpts}
          </select>
        </div>
        <div class="field">
          <label>No. manifiesto Hacienda <span style="color:var(--danger)">*</span></label>
          <input value="${esc(m.manifest_no||'')}" onchange="updateManifest('manifest_no',this.value)" placeholder="ej. 3309468" style="${m.manifest_no?'':'border-color:#e6a840;background:#fffcf2'}"/>
        </div>
        <div class="field">
          <label>Docking Number <span style="color:var(--danger)">*</span></label>
          <input id="f-docking" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="8"
            value="${esc(m.docking_number||'')}"
            placeholder="ej. 20262342"
            style="${m.docking_number?'':'border-color:#e6a840;background:#fffcf2'};font-family:monospace"
            oninput="this.value=this.value.replace(/[^0-9]/g,'')"
            onchange="onDockingChange(this.value)"/>
          <div class="hint">Número de atraque — requerido en el TXT encabezado [165:173]</div>
        </div>
      </div>
      <!-- Fila 3: Puertos -->
      <div class="fg fg2">
        <div class="field">
          <label>Puerto origen (DGA)</label>
          <select onchange="updateManifest('loading_port',this.value)">
            ${portOptsOrigin}
          </select>
        </div>
        <div class="field">
          <label>Puerto destino (PR)</label>
          <select onchange="updateManifest('unloading_port',this.value)">
            ${portOptsPR}
          </select>
        </div>
      </div>
      <!-- Fila 4: Fechas -->
      <div class="fg fg2">
        <div class="field">
          <label>Fecha salida</label>
          <input type="date" value="${esc((m.departure_date||'').substring(0,10))}" onchange="updateManifest('departure_date',this.value)"/>
        </div>
        <div class="field">
          <label>Fecha llegada</label>
          <input type="date" value="${esc((m.arrival_date||'').substring(0,10))}" onchange="updateManifest('arrival_date',this.value)"/>
        </div>
      </div>
    </div>
  </div>

  <!-- ── B/L HEADER ────────────────────────────────── -->
  <div style="display:flex;align-items:center;gap:8px;margin:0 1px">
    <h2 style="font-size:14px;font-weight:700">${esc(bl.bl_no)}</h2>
    <span class="badge ${bl.status==='validado'?'ok':'pend'}">${esc(bl.status)}</span>
    <span class="spacer"></span>
    ${bl.status==='validado'
      ? `<button class="btn sm danger" onclick="markPendiente(${bl.id})"><i class="ti ti-x"></i> Desvalidar</button>`
      : `<button class="btn sm success" onclick="markValidated(${bl.id})"><i class="ti ti-check"></i> Validado</button>`
    }
    <button class="btn sm" onclick="showTxtPreview(${bl.id})"><i class="ti ti-eye"></i> Ver TXT</button>
  </div>

  <!-- ── HACIENDA PR — CAMPOS REQUERIDOS ──────────── -->
  <div class="card warn-card" id="hac-card">
    <div class="card-hdr"><i class="ti ti-building-bank"></i> Hacienda PR — campos requeridos para el TXT</div>
    <div class="card-body" style="display:flex;flex-direction:column;gap:12px">

      <!-- Fila 1: Código arancelario + Tarifa -->
      <div class="fg fg3">
        <div style="grid-column:1/3;display:flex;flex-direction:column;gap:4px">
          <div class="field ${bl.hacienda_item_code?'f-ok':'f-warn'} ac-wrap">
            <label>Código arancelario — Items Hacienda <span style="color:var(--danger)">*</span></label>
            <input id="f-item-code" value="${esc(bl.hacienda_item_code||'')}"
              placeholder="Buscar por código o descripción..."
              oninput="onItemInput(this.value)"
              onkeydown="acKeydown(event,'item-ac')"
              onchange="updateBL('hacienda_item_code',this.value)"
              autocomplete="off"/>
            <div class="ac-drop" id="item-ac"></div>
          </div>
          <div id="item-desc-hint" class="hint" style="color:var(--success);font-size:11px">${bl.hacienda_item_code?'Cargando descripción...':''}</div>
        </div>
        <div class="field f-ok">
          <label>Tarifa (arbitrio)</label>
          <select id="f-tariff" onchange="onTariffChange(this.value)">
            <option value="040" ${bl.hacienda_tariff!=='045'?'selected':''}>040 — Libre arancel</option>
            <option value="045" ${bl.hacienda_tariff==='045'?'selected':''}>045 — Carga general</option>
          </select>
          <div class="hint" id="tariff-hint">${bl.hacienda_tariff!=='045'?'Libre arancel — valor FOB será 0 en el TXT':'Aplica arbitrio — incluye valor FOB'}</div>
        </div>
      </div>

      <!-- Sugerencia automática -->
      <div id="suggest-area" style="display:none"></div>

      <!-- Fila 2: SS/EIN + IVU consignatario + Notas -->
      <div class="fg fg3">
        <div class="field ${bl.hacienda_client_ss?'f-ok':'f-warn'} ac-wrap">
          <label>SS / EIN consignatario (Hacienda) <span style="color:var(--danger)">*</span></label>
          <input id="f-client-ss" value="${esc(bl.hacienda_client_ss||bl.consignee_document_no||'')}"
            placeholder="Buscar por nombre o EIN..."
            oninput="onClientInput(this.value)"
            onkeydown="acKeydown(event,'client-ac')"
            onchange="updateBL('hacienda_client_ss',this.value)"
            autocomplete="off"/>
          <div class="ac-drop" id="client-ac"></div>
        </div>
        <div class="field">
          <label>IVU / No. comerciante consignatario</label>
          <input id="f-client-ivu" value="${esc(bl.hacienda_client_ivu||'')}"
            placeholder="ej. 01406530016" maxlength="11"
            oninput="this.value=this.value.replace(/[^0-9]/g,'')"
            onchange="updateBL('hacienda_client_ivu',this.value)"/>
          <div class="hint">Requerido por Hacienda — si el consignatario no tiene IVU, se usa el del carrier</div>
        </div>
        <div class="field">
          <label>Notas internas</label>
          <input value="${esc(bl.notes||'')}" placeholder="Observaciones..." onchange="updateBL('notes',this.value)"/>
        </div>
      </div>

      <!-- Fila 3: Contenedor(es) + tamaño -->
      <div class="field">
        <label>No. contenedor (Hacienda)</label>
        <input value="${esc(containerNo)}" onchange="updateBL('hacienda_container_no',this.value)" placeholder="ej. TCKU1234567"/>
        ${cblAll.length > 0 ? `
        <div style="display:flex;flex-direction:column;gap:5px;margin-top:6px">
          ${cblAll.map(c=>`
            <div style="display:flex;align-items:center;gap:8px">
              <span class="cont-chip" style="cursor:pointer" title="Usar este contenedor en el campo Hacienda"
                data-cno="${esc(c.container_no)}"
                onclick="(function(el){var v=el.dataset.cno;el.closest('.field').querySelector('input').value=v;updateBL('hacienda_container_no',v);})(this)">${esc(c.container_no)}</span>
              <select style="font-size:11px;padding:3px 6px;border-radius:5px;background:var(--surface);${c.size?'border:1px solid var(--border)':'border:1px solid var(--danger);background:#fff5f5'}"
                onchange="updateContainerSize(${c.id||0},this.value)" ${c.id?'':'disabled'}>
                <option value="">— tamaño (requerido) —</option>
                <option value="20" ${c.size==='20'?'selected':''}>20'</option>
                <option value="40" ${c.size==='40'?'selected':''}>40'</option>
                <option value="40HC" ${c.size==='40HC'?'selected':''}>40' HC</option>
                <option value="45" ${c.size==='45'?'selected':''}>45'</option>
                <option value="53" ${c.size==='53'?'selected':''}>53'</option>
              </select>
              <span class="badge" style="font-size:10px">Tipo: R (RORO)</span>
            </div>`).join('')}
        </div>
        <div class="hint">Tamaño requerido por SISCOMMATE (BOLCONT) — selecciona por contenedor. Tipo de equipo fijo en RORO (R).</div>` : ''}
      </div>
    </div>
  </div>

  <!-- ── CARGA ────────────────────────────────────── -->
  <div class="card">
    <div class="card-hdr"><i class="ti ti-package"></i> Carga</div>
    <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
      <div class="fg fg3">
        <div class="field">
          <label>Cantidad bultos</label>
          <input type="number" value="${bl.package_qty||0}" onchange="updateBL('package_qty',this.value)"/>
        </div>
        <div class="field">
          <label>Peso bruto (kg)</label>
          <input type="number" step="0.01" value="${bl.gross_weight||0}" onchange="updateBL('gross_weight',this.value)"/>
        </div>
        <div class="field">
          <label>Valor FOB (USD)</label>
          <input id="f-fob" type="number" step="0.01" value="${bl.value||0}"
            ${bl.hacienda_tariff!=='045'?'style="opacity:.5" title="040 Libre arancel — se fuerza a 0 en el TXT"':''}
            onchange="updateBL('value',this.value)"/>
        </div>
      </div>
      <div class="field">
        <label>Descripción de mercancía (DGA) — máx. 121 caracteres en TXT</label>
        <textarea id="f-goods-name" oninput="onGoodsNameChange(this.value)" onchange="updateBL('goods_name',this.value)" style="min-height:60px">${esc(bl.goods_name||'')}</textarea>
        <div class="hint" id="goods-char-count" style="color:${(bl.goods_name||'').length>121?'var(--danger)':'var(--text3)'}">${(bl.goods_name||'').length}/121 caracteres</div>
      </div>
      <div class="fg fg2">
        <div class="field">
          <label>Puerto descarga (DGA)</label>
          <input value="${esc(bl.unloading_port_code||'')}" onchange="updateBL('unloading_port_code',this.value)"/>
        </div>
        <div class="field">
          <label>Código empaque (DGA)</label>
          <input value="${esc(bl.package_unit_code||'')}" onchange="updateBL('package_unit_code',this.value)"/>
        </div>
      </div>

      <!-- Items de carga por contenedor -->
      <div id="cargo-section" style="border-top:1px solid var(--border);padding-top:12px"></div>
    </div>
  </div>

  <!-- ── CONSIGNADOR ──────────────────────────────── -->
  <div class="card">
    <div class="card-hdr"><span class="tag ship"><i class="ti ti-building-factory2"></i> Consignador</span> — Shipper (República Dominicana)</div>
    <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
      <div class="fg fg2">
        <div class="field fspan"><label>Nombre / Razón social</label><input value="${esc(bl.consignor_name||'')}" onchange="updateBL('consignor_name',this.value)"/></div>
        <div class="field"><label>No. documento (RNC / Cédula)</label><input value="${esc(bl.consignor_document_no||'')}" onchange="updateBL('consignor_document_no',this.value)"/></div>
        <div class="field"><label>Tipo documento</label><input value="${esc(bl.consignor_document_type||'')}" onchange="updateBL('consignor_document_type',this.value)"/></div>
      </div>
      <div class="fg fg3">
        <div class="field fspan"><label>Dirección</label><input value="${esc(bl.consignor_street||'')}" onchange="updateBL('consignor_street',this.value)"/></div>
        <div class="field"><label>Ciudad</label><input value="${esc(bl.consignor_city||'')}" onchange="updateBL('consignor_city',this.value)"/></div>
        <div class="field"><label>Teléfono</label><input value="${esc(bl.consignor_tel||'')}" onchange="updateBL('consignor_tel',this.value)"/></div>
        <div class="field"><label>Email</label><input value="${esc(bl.consignor_email||'')}" onchange="updateBL('consignor_email',this.value)"/></div>
      </div>
    </div>
  </div>

  <!-- ── CONSIGNATARIO ─────────────────────────────── -->
  <div class="card">
    <div class="card-hdr"><span class="tag cons"><i class="ti ti-home-2"></i> Consignatario</span> — Consignee (Puerto Rico)</div>
    <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
      <div class="fg fg2">
        <div class="field fspan"><label>Nombre / Razón social</label><input value="${esc(bl.consignee_name||'')}" onchange="updateBL('consignee_name',this.value)"/></div>
        <div class="field"><label>EIN / SS (Puerto Rico)</label><input value="${esc(bl.consignee_document_no||'')}" onchange="updateBL('consignee_document_no',this.value)"/></div>
        <div class="field"><label>Teléfono</label><input value="${esc(bl.consignee_tel||'')}" onchange="updateBL('consignee_tel',this.value)"/></div>
      </div>
      <div class="fg fg3">
        <div class="field fspan"><label>Dirección</label><input value="${esc(bl.consignee_street||'')}" onchange="updateBL('consignee_street',this.value)"/></div>
        <div class="field"><label>Ciudad</label><input value="${esc(bl.consignee_city||'')}" onchange="updateBL('consignee_city',this.value)"/></div>
        <div class="field"><label>Zip code</label><input value="${esc(bl.consignee_zip||'')}" onchange="updateBL('consignee_zip',this.value)"/></div>
        <div class="field"><label>Email</label><input value="${esc(bl.consignee_email||'')}" onchange="updateBL('consignee_email',this.value)"/></div>
      </div>
    </div>
  </div>

  `;

  // Cargar descripción del código si ya existe
  if(bl.hacienda_item_code) loadItemDesc(bl.hacienda_item_code);
  // Generar sugerencia automática si no hay código
  if(!bl.hacienda_item_code && bl.goods_name) suggestItemCode(bl.goods_name);
  // Cargo items
  loadCargoItems(bl.id);
}

// ═══════════════════════════════════════════════════════════════
// TARIFA — 040 Libre arancel fuerza FOB = 0
// ═══════════════════════════════════════════════════════════════
function onDockingChange(val) {
  const clean = val.replace(/[^0-9]/g,'');
  updateManifest('docking_number', clean);
  const inp = document.getElementById('f-docking');
  if (inp) {
    inp.style.borderColor = clean ? '' : '#e6a840';
    inp.style.background  = clean ? '' : '#fffcf2';
  }
  if (currentManifestData) currentManifestData.manifest.docking_number = clean;
}

function onTariffChange(val) {
  updateBL('hacienda_tariff', val);
  const fobInp  = document.getElementById('f-fob');
  const hint    = document.getElementById('tariff-hint');
  const isLibre = val !== '045';
  if (fobInp) {
    fobInp.style.opacity = isLibre ? '0.5' : '';
    fobInp.title = isLibre ? '040 Libre arancel — se fuerza a 0 en el TXT' : '';
  }
  if (hint) hint.textContent = isLibre
    ? 'Libre arancel — valor FOB será 0 en el TXT'
    : 'Aplica arbitrio — incluye valor FOB';
}

// ═══════════════════════════════════════════════════════════════
// BUQUE — al cambiar actualiza IMO y carrier
// ═══════════════════════════════════════════════════════════════
function vesselImo(code){
  const v=catalogVessels.find(v=>v.code===code);
  return v?v.imo:'';
}

function onVesselChange(code){
  const v=catalogVessels.find(v=>v.code===code);
  if(!v) return;
  updateManifest('vessel_code', code);
  updateManifest('vessel_name', v.name);
  updateManifest('imo',         v.imo);
  updateManifest('carrier_code', v.carrier);
  const imoEl=document.getElementById('f-imo');
  if(imoEl) imoEl.value=v.imo;
  document.getElementById('toolbar-vessel').textContent=v.name;
}

// ═══════════════════════════════════════════════════════════════
// AUTOCOMPLETE — CÓDIGO ARANCELARIO
// ═══════════════════════════════════════════════════════════════
function onItemInput(q){
  clearTimeout(itemTimer);
  const ac=document.getElementById('item-ac');
  if(!q||q.length<2){ ac.style.display='none'; return; }
  itemTimer=setTimeout(async()=>{
    try{
      const items=await api(`/api/catalogs/items?q=${encodeURIComponent(q)}`);
      if(!items.length){ ac.style.display='none'; return; }
      ac.innerHTML=items.map((it,i)=>
        `<div class="ac-item" data-idx="${i}" onclick="selectItem('${escJs(it.code)}','${escJs(it.description)}')">
          <span class="ac-name">${esc(it.description)}</span>
          <span class="ac-code">${esc(it.code)}</span>
          ${it.taxable?`<span class="ac-badge">tributable</span>`:''}
        </div>`
      ).join('');
      positionDrop(document.getElementById('f-item-code'), ac);
    }catch(e){}
  },200);
}

function selectItem(code, desc){
  const inp=document.getElementById('f-item-code');
  if(inp) inp.value=code;
  document.getElementById('item-ac').style.display='none';
  document.getElementById('suggest-area').style.display='none';
  updateBL('hacienda_item_code', code);
  const hint=document.getElementById('item-desc-hint');
  if(hint){ hint.textContent=desc; hint.style.color='var(--success)'; }
  // Actualizar clase del campo
  inp.closest('.field').className='field f-ok ac-wrap';
}

async function loadItemDesc(code){
  if(!code) return;
  try{
    const items=await api(`/api/catalogs/items?q=${encodeURIComponent(code)}`);
    const found=items.find(i=>i.code===code);
    const hint=document.getElementById('item-desc-hint');
    if(hint && found) hint.textContent=found.description;
  }catch(e){}
}

// Sugerencia automática basada en descripción de la mercancía
function onGoodsNameChange(val){
  const counter=document.getElementById('goods-char-count');
  if(counter){
    counter.textContent=`${val.length}/121 caracteres`;
    counter.style.color=val.length>121?'var(--danger)':'var(--text3)';
  }
  clearTimeout(suggestTimer);
  suggestTimer=setTimeout(()=>suggestItemCode(val), 800);
}

async function suggestItemCode(desc){
  if(!desc||desc.length<5) return;
  const code=document.getElementById('f-item-code');
  if(code && code.value) return; // ya tiene código, no sugerir
  try{
    const items=await api(`/api/catalogs/items/suggest?desc=${encodeURIComponent(desc)}`);
    if(!items.length) return;
    const area=document.getElementById('suggest-area');
    if(!area) return;
    area.style.display='block';
    area.innerHTML=`
      <div class="suggest-box">
        <i class="ti ti-bulb"></i>
        <div class="suggest-content">
          <div class="suggest-title">Códigos sugeridos para: <i>"${esc(desc.substring(0,60))}"</i></div>
          <div class="suggest-items">
            ${items.slice(0,6).map(it=>
              `<div class="suggest-chip" onclick="selectItem('${escJs(it.code)}','${escJs(it.description)}')">
                <span class="sc-code">${esc(it.code)}</span>
                <span>${esc(it.description.substring(0,35))}${it.description.length>35?'…':''}</span>
              </div>`
            ).join('')}
          </div>
          <div style="font-size:10px;color:var(--text3);margin-top:6px">Haz clic para seleccionar, o escribe en el campo para buscar manualmente</div>
        </div>
      </div>`;
  }catch(e){}
}

// ═══════════════════════════════════════════════════════════════
// AUTOCOMPLETE — CONSIGNATARIO / CLIENTE
// ═══════════════════════════════════════════════════════════════
function onClientInput(q){
  clearTimeout(clientTimer);
  const ac=document.getElementById('client-ac');
  if(!q||q.length<2){ ac.style.display='none'; return; }
  clientTimer=setTimeout(async()=>{
    try{
      const clients=await api(`/api/catalogs/clients?q=${encodeURIComponent(q)}`);
      let html = clients.map((c,i)=>
        `<div class="ac-item" data-idx="${i}" onclick="selectClient('${escJs(c.ss||'')}','${escJs(c.name)}',${c.id},'${escJs(c.ivu||'')}')">
          <span class="ac-name">${esc(c.name)}</span>
          <span class="ac-code">${esc(c.ss||'—')}</span>
        </div>`
      ).join('');
      // Siempre mostrar opción de crear nuevo al final
      html += `<div class="ac-item" style="border-top:2px solid var(--border);background:var(--accent-bg)"
        onclick="openCreateClient('${escJs(q)}')">
        <span class="ac-name" style="color:var(--accent);font-weight:600">
          <i class="ti ti-user-plus"></i> Crear nuevo consignatario&hellip;
        </span>
      </div>`;
      ac.innerHTML = html;
      positionDrop(document.getElementById('f-client-ss'), ac);
    }catch(e){}
  },200);
}

function selectClient(ss, name, clientId, ivu){
  const inp=document.getElementById('f-client-ss');
  if(inp){
    inp.value=ss;
    inp.closest('.field').className='field f-ok ac-wrap';
  }
  document.getElementById('client-ac').style.display='none';
  updateBL('hacienda_client_ss', ss);
  // Auto-rellenar IVU si viene del catálogo y el campo está vacío
  if(ivu){
    const ivuInp=document.getElementById('f-client-ivu');
    if(ivuInp && !ivuInp.value){ ivuInp.value=ivu; updateBL('hacienda_client_ivu',ivu); }
  }
  // Mostrar nombre debajo del campo
  let hint = document.getElementById('client-name-hint');
  if(!hint){
    hint = document.createElement('div');
    hint.id = 'client-name-hint';
    hint.className = 'hint';
    inp?.closest('.field')?.appendChild(hint);
  }
  const editBtn = document.createElement('button');
  editBtn.style.cssText='margin-left:6px;background:none;border:none;color:var(--accent);cursor:pointer;font-size:11px;padding:0';
  editBtn.textContent='Editar';
  editBtn.onclick = () => openEditClient(clientId||0, ss, name);
  hint.innerHTML = `<i class="ti ti-check" style="color:var(--success)"></i> ${esc(name)} `;
  hint.appendChild(editBtn);
}

// Navegación con teclado en los autocompletes
function acKeydown(e, acId){
  const ac=document.getElementById(acId);
  if(!ac||ac.style.display==='none') return;
  const items=ac.querySelectorAll('.ac-item');
  const focused=ac.querySelector('.ac-item.focused');
  let idx=focused?parseInt(focused.dataset.idx||0):(-1);
  if(e.key==='ArrowDown'){ e.preventDefault(); idx=Math.min(idx+1,items.length-1); }
  else if(e.key==='ArrowUp'){ e.preventDefault(); idx=Math.max(idx-1,0); }
  else if(e.key==='Enter' && focused){ e.preventDefault(); focused.click(); return; }
  else if(e.key==='Escape'){ ac.style.display='none'; return; }
  items.forEach(el=>el.classList.remove('focused'));
  if(items[idx]) items[idx].classList.add('focused');
}

// Posicionar dropdown fixed bajo el input (evita clipping de overflow:hidden en cards)
function positionDrop(inputEl, dropEl){
  const r = inputEl.getBoundingClientRect();
  dropEl.style.top    = `${r.bottom + 2}px`;
  dropEl.style.left   = `${r.left}px`;
  dropEl.style.width  = `${r.width}px`;
  dropEl.style.display= 'block';
}

// ═══════════════════════════════════════════════════════════════
// GUARDAR — autosave con debounce
// ═══════════════════════════════════════════════════════════════
function updateBL(field, value){
  if(!currentBL) return;
  currentBL[field]=value;
  clearTimeout(saveTimer);
  saveTimer=setTimeout(async()=>{
    try{
      await api(`/api/bl/${currentBL.id}`,{method:'PUT',body:JSON.stringify({[field]:value})});
      setStatus(`Guardado`,new Date().toLocaleTimeString('es-PR'));
    }catch(e){ toast('Error guardando: '+e.message,'err'); }
  },600);
}

async function updateContainerSize(containerId, size){
  if(!containerId) return;
  try{
    await api(`/api/containers/${containerId}`,{method:'PUT',body:JSON.stringify({size})});
    const c=currentManifestData.containers.find(ct=>ct.id===containerId);
    if(c) c.size=size;
    setStatus('Tamaño guardado',new Date().toLocaleTimeString('es-PR'));
  }catch(e){ toast('Error guardando tamaño: '+e.message,'err'); }
}

function updateManifest(field, value){
  if(!currentManifestData) return;
  currentManifestData.manifest[field]=value;
  clearTimeout(saveTimer);
  saveTimer=setTimeout(async()=>{
    try{
      await api(`/api/manifests/${currentManifestId}`,{method:'PUT',body:JSON.stringify({[field]:value})});
      setStatus(`Manifiesto actualizado`,new Date().toLocaleTimeString('es-PR'));
    }catch(e){ toast('Error guardando manifiesto: '+e.message,'err'); }
  },600);
}

async function markValidated(blId){
  try{
    await api(`/api/bl/${blId}`,{method:'PUT',body:JSON.stringify({status:'validado'})});
    if(currentBL) currentBL.status='validado';
    const blInData=currentManifestData.bls.find(b=>b.id===blId);
    if(blInData) blInData.status='validado';
    renderEditor(currentBL);
    renderManifestList(filteredByTab(allManifests));
    toast('B/L marcado como validado');
    loadStats();
  }catch(e){ toast('Error','err'); }
}

async function markPendiente(blId){
  try{
    await api(`/api/bl/${blId}`,{method:'PUT',body:JSON.stringify({status:'pendiente'})});
    if(currentBL) currentBL.status='pendiente';
    const blInData=currentManifestData.bls.find(b=>b.id===blId);
    if(blInData) blInData.status='pendiente';
    renderEditor(currentBL);
    renderManifestList(filteredByTab(allManifests));
    toast('B/L regresado a pendiente');
    loadStats();
  }catch(e){ toast('Error','err'); }
}

// ═══════════════════════════════════════════════════════════════
// PREVIEW TXT
// ═══════════════════════════════════════════════════════════════
async function showTxtPreview(blId){
  if(!blId) return;
  try{
    const data=await api(`/api/bl/${blId}/txt-preview`);
    const ruler='123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234';
    const edEl=document.getElementById('editor');
    document.getElementById('txt-preview-panel')?.remove();
    const div=document.createElement('div');
    div.id='txt-preview-panel';
    div.className='card';
    div.style.cssText='border:2px solid var(--accent);order:-1';
    div.innerHTML=`
      <div class="card-hdr" style="background:var(--accent-bg)">
        <i class="ti ti-file-text"></i> Vista previa TXT Hacienda PR — B/L ${esc(currentBL?.bl_no||'')}
        <button class="btn sm" style="margin-left:auto" onclick="document.getElementById('txt-preview-panel').remove()">✕</button>
      </div>
      <div class="card-body">
        ${data.pairs ? data.pairs.map((p,i)=>`
          <div style="font-size:10px;color:var(--text3);margin-bottom:2px">${data.pairs.length>1?`Contenedor ${i+1}: ${esc(p.containerNo)}`:''}</div>
          <div class="txt-ruler">${ruler.substring(0,205)}</div>
          <div class="txt-pre">${esc(p.line1)}</div>
          <div style="height:4px"></div>
          <div class="txt-ruler">${ruler.substring(0,205)}</div>
          <div class="txt-pre">${esc(p.line2)}</div>
          <div style="height:8px"></div>
        `).join('') : `
          <div class="txt-ruler">${ruler.substring(0,205)}</div>
          <div class="txt-pre">${esc(data.line1)}</div>
          <div style="height:4px"></div>
          <div class="txt-ruler">${ruler.substring(0,205)}</div>
          <div class="txt-pre">${esc(data.line2)}</div>
        `}
        <div style="font-size:10px;color:var(--text3);margin-top:2px">
          Línea 1: ${data.line1.length} chars &nbsp;·&nbsp; Línea 2: ${data.line2.length} chars &nbsp;·&nbsp; Requerido: 205 chars
          ${data.line1.length!==205||data.line2.length!==205?'<span style="color:var(--danger);font-weight:600;margin-left:6px">⚠ Longitud incorrecta</span>':'<span style="color:var(--success);font-weight:600;margin-left:6px">✓ Longitud correcta</span>'}
        </div>
      </div>`;
    edEl.prepend(div);
    div.scrollIntoView({behavior:'smooth'});
  }catch(e){ toast('Error en vista previa','err'); }
}
