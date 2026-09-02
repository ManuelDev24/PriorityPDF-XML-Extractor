// cargoItems.js — Items de carga múltiples por B/L y por contenedor
// Extraído de index.html (paso 6 de la separación frontend/backend)

async function loadCargoItems(blId) {
  try {
    currentCargoItems = await api(`/api/bl/${blId}/cargo-items`);
    renderCargoItems();
  } catch(e) { currentCargoItems = []; renderCargoItems(); }
}

function blContainers() {
  if (!currentManifestData || !currentBL) return [];
  return currentManifestData.container_bl
    .filter(c => c.bl_no === currentBL.bl_no)
    .map(c => c.container_no);
}

// ── Renderiza la sección de carga según cantidad de contenedores ──
function renderCargoItems() {
  const section = document.getElementById('cargo-section');
  if (!section) return;
  const cnos = blContainers();
  const multi = cnos.length > 1;

  if (multi) {
    renderCargoMulti(section, cnos);
  } else {
    renderCargoSingle(section);
  }
}

// ── Un solo contenedor (o sin contenedor): lista de items libre ──
function renderCargoSingle(section) {
  const items = currentCargoItems;
  const badge = items.length
    ? `<span style="padding:1px 7px;border-radius:20px;font-size:10px;font-weight:600;background:var(--accent-bg);color:var(--accent);border:1px solid #aac8f0">${items.length} item${items.length>1?'s':''}</span>`
    : '';
  section.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px">Items de carga</span>
      ${badge}
      <span style="font-size:10px;color:var(--text3);flex:1">Si hay items, reemplazan la descripción general en el TXT</span>
      <button class="btn sm accent" onclick="openAddCargoItem(null)">+ Agregar item</button>
    </div>
    <div id="ci-single-list" style="display:flex;flex-direction:column;gap:6px">
      ${items.length
        ? items.map(item => ciSingleRow(item)).join('')
        : `<div style="font-size:11px;color:var(--text3);padding:4px 0">Sin items adicionales — se usa la descripción general del B/L</div>`
      }
    </div>`;
}

function ciSingleRow(item) {
  return `<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);font-size:12px">
    <div style="flex:1;min-width:0">
      <div style="font-weight:600">${esc(item.goods_name)}</div>
      <div style="font-size:10px;color:var(--text3);margin-top:3px;display:flex;gap:10px;flex-wrap:wrap">
        <span>Peso: <b>${item.gross_weight||0} kg</b></span>
        <span>Código: <b>${esc(item.hacienda_item_code||'—')}</b></span>
        <span>Tarifa: <b>${esc(item.hacienda_tariff||'—')}</b></span>
      </div>
    </div>
    <button class="btn sm" onclick="openEditCargoItem(${item.id})" title="Editar">✏</button>
    <button class="btn sm danger" onclick="deleteCargoItem(${item.id})" title="Eliminar">✕</button>
  </div>`;
}

// ── Múltiples contenedores: una sección colapsable por contenedor ──
function renderCargoMulti(section, cnos) {
  const itemsByCno = {};
  cnos.forEach(c => { itemsByCno[c] = []; });
  currentCargoItems.forEach(item => {
    const key = item.container_no || '';
    if (key && itemsByCno[key] !== undefined) itemsByCno[key].push(item);
    else if (!key) cnos.forEach(c => itemsByCno[c].push({...item, _shared:true}));
  });

  const totalItems = currentCargoItems.length;
  const allSet = cnos.every(c => itemsByCno[c].some(i => !i._shared));

  section.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px">Carga por contenedor</span>
      ${totalItems ? `<span style="padding:1px 7px;border-radius:20px;font-size:10px;font-weight:600;background:var(--accent-bg);color:var(--accent);border:1px solid #aac8f0">${totalItems} item${totalItems>1?'s':''}</span>` : ''}
      <span style="font-size:10px;color:var(--text3);flex:1">Cada contenedor puede tener descripción, peso y código distintos</span>
      ${!allSet ? `<button class="btn sm" onclick="initCargoPerContainer()" title="Crear un item inicial por contenedor con los datos del B/L">⚡ Inicializar por contenedor</button>` : ''}
    </div>
    ${cnos.map(cno => ciContainerBlock(cno, itemsByCno[cno]||[])).join('')}`;
}

function ciContainerBlock(cno, items) {
  const hasOwn = items.some(i => !i._shared);
  const statusDot = hasOwn
    ? `<span style="width:7px;height:7px;border-radius:50%;background:#2cb67d;display:inline-block;flex-shrink:0"></span>`
    : `<span style="width:7px;height:7px;border-radius:50%;background:#e0c060;display:inline-block;flex-shrink:0" title="Usando descripción del B/L"></span>`;

  const rows = items.filter(i => !i._shared).map(item => `
    <tr>
      <td style="padding:5px 8px;vertical-align:top">
        <textarea data-ci-field="goods_name" data-ci-id="${item.id}" rows="2"
          style="width:100%;padding:4px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px;resize:vertical;min-width:200px"
          onchange="saveCargoField(${item.id},'goods_name',this.value)">${esc(item.goods_name)}</textarea>
      </td>
      <td style="padding:5px 8px;white-space:nowrap">
        <input type="number" step="0.01" value="${item.gross_weight||0}"
          style="width:90px;padding:4px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px"
          onchange="saveCargoField(${item.id},'gross_weight',this.value)"/>
      </td>
      <td style="padding:5px 8px">
        <input type="text" value="${esc(item.hacienda_item_code||'')}" placeholder="código"
          style="width:120px;padding:4px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px;font-family:monospace"
          onchange="saveCargoField(${item.id},'hacienda_item_code',this.value)"/>
      </td>
      <td style="padding:5px 8px">
        <select style="padding:4px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px"
          onchange="saveCargoField(${item.id},'hacienda_tariff',this.value)">
          <option value="">—</option>
          <option value="040" ${item.hacienda_tariff==='040'?'selected':''}>040</option>
          <option value="045" ${item.hacienda_tariff==='045'?'selected':''}>045</option>
        </select>
      </td>
      <td style="padding:5px 8px">
        <button class="btn sm danger" onclick="deleteCargoItem(${item.id},'${escJs(cno)}')" title="Eliminar">✕</button>
      </td>
    </tr>`).join('');

  return `<div style="border:1px solid var(--border);border-radius:var(--radius);margin-bottom:8px;overflow:hidden">
    <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--surface2);border-bottom:1px solid var(--border)">
      ${statusDot}
      <span style="font-family:monospace;font-size:12px;font-weight:700;color:var(--accent)">${esc(cno)}</span>
      <span style="font-size:10px;color:var(--text3);flex:1">${hasOwn ? items.filter(i=>!i._shared).length+' item(s) propios' : 'usando descripción general del B/L'}</span>
      <button class="btn sm accent" onclick="openAddCargoItem('${escJs(cno)}')">+ Item</button>
    </div>
    ${rows ? `<table style="width:100%;border-collapse:collapse">
      <thead><tr style="background:var(--surface3)">
        <th style="padding:4px 8px;text-align:left;font-size:10px;color:var(--text3);font-weight:600">Descripción</th>
        <th style="padding:4px 8px;text-align:left;font-size:10px;color:var(--text3);font-weight:600">Peso (kg)</th>
        <th style="padding:4px 8px;text-align:left;font-size:10px;color:var(--text3);font-weight:600">Código aranc.</th>
        <th style="padding:4px 8px;text-align:left;font-size:10px;color:var(--text3);font-weight:600">Tarifa</th>
        <th style="padding:4px 8px"></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>` : ''}
  </div>`;
}

// Guardar campo individual sin recargar todo el bloque
async function saveCargoField(id, field, value) {
  await fetch(`/api/bl-cargo-items/${id}`, {
    method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ [field]: value })
  });
  // Actualizar cache local sin re-render completo
  const item = currentCargoItems.find(i=>i.id===id);
  if (item) item[field] = value;
}

// Inicializar un item por contenedor con los datos del BL
async function initCargoPerContainer() {
  const cnos = blContainers();
  const bl = currentBL;
  const existing = new Set(currentCargoItems.map(i=>i.container_no));
  const toCreate = cnos.filter(c => !existing.has(c));
  if (!toCreate.length) { toast('Todos los contenedores ya tienen items'); return; }
  for (const cno of toCreate) {
    await fetch(`/api/bl/${bl.id}/cargo-items`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        container_no: cno,
        goods_name: bl.goods_name || '',
        gross_weight: bl.gross_weight || 0,
        hacienda_item_code: bl.hacienda_item_code || '',
        hacienda_tariff: bl.hacienda_tariff || '',
      })
    });
  }
  await loadCargoItems(bl.id);
  toast(`${toCreate.length} item${toCreate.length>1?'s':''} inicializado${toCreate.length>1?'s':''}`);
}

// Modal de agregar item (con contenedor pre-seleccionado si se pasa)
function openAddCargoItem(forceCno) {
  const cnos = blContainers();
  const hasTariff = currentBL?.hacienda_tariff || '';
  const cnoSelect = cnos.length > 1
    ? `<div class="field">
        <label>Contenedor</label>
        <select id="ci-container" style="padding:5px 9px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px;width:100%">
          ${forceCno ? '' : '<option value="">Todos los contenedores</option>'}
          ${cnos.map(c=>`<option value="${esc(c)}" ${c===forceCno?'selected':''}>${esc(c)}</option>`).join('')}
        </select>
      </div>`
    : `<input type="hidden" id="ci-container" value=""/>`;
  openModal('Agregar item de carga', `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="field">
        <label>Descripción de mercancía <span style="color:var(--danger)">*</span></label>
        <textarea id="ci-goods" rows="3" style="padding:5px 8px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px;resize:vertical">${esc(currentBL?.goods_name||'')}</textarea>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <div class="field" style="flex:1;min-width:120px">
          <label>Peso bruto (kg)</label>
          <input type="number" step="0.01" id="ci-weight" value="${currentBL?.gross_weight||0}" style="padding:5px 9px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px;width:100%"/>
        </div>
        <div class="field" style="flex:1;min-width:120px">
          <label>Código arancelario</label>
          <input type="text" id="ci-code" value="${esc(currentBL?.hacienda_item_code||'')}" style="padding:5px 9px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px;width:100%;font-family:monospace"/>
        </div>
        <div class="field" style="width:80px">
          <label>Tarifa</label>
          <select id="ci-tariff" style="padding:5px 9px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px;width:100%">
            <option value="">—</option>
            <option value="040" ${hasTariff==='040'?'selected':''}>040</option>
            <option value="045" ${hasTariff==='045'?'selected':''}>045</option>
          </select>
        </div>
      </div>
      ${cnoSelect}
    </div>
    <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn accent" onclick="saveNewCargoItem()">Guardar</button>
    </div>`);
}

async function saveNewCargoItem() {
  const goods  = document.getElementById('ci-goods')?.value.trim();
  const weight = parseFloat(document.getElementById('ci-weight')?.value) || 0;
  const code   = document.getElementById('ci-code')?.value.trim();
  const tariff = document.getElementById('ci-tariff')?.value;
  const cno    = document.getElementById('ci-container')?.value;
  if (!goods) { toast('La descripción es requerida','err'); return; }
  const r = await fetch(`/api/bl/${currentBL.id}/cargo-items`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ goods_name:goods, gross_weight:weight, hacienda_item_code:code, hacienda_tariff:tariff, container_no:cno||null })
  });
  if (r.ok) { closeModal(); await loadCargoItems(currentBL.id); toast('Item agregado'); }
  else { const d=await r.json(); toast(d.error||'Error','err'); }
}

function openEditCargoItem(id) {
  const item = currentCargoItems.find(i=>i.id===id);
  if (!item) return;
  openModal('Editar item', `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="field">
        <label>Descripción</label>
        <textarea id="ci-goods" rows="3" style="padding:5px 8px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px;resize:vertical">${esc(item.goods_name)}</textarea>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <div class="field" style="flex:1;min-width:120px">
          <label>Peso (kg)</label>
          <input type="number" step="0.01" id="ci-weight" value="${item.gross_weight||0}" style="padding:5px 9px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px;width:100%"/>
        </div>
        <div class="field" style="flex:1;min-width:120px">
          <label>Código arancelario</label>
          <input type="text" id="ci-code" value="${esc(item.hacienda_item_code||'')}" style="padding:5px 9px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px;width:100%;font-family:monospace"/>
        </div>
        <div class="field" style="width:80px">
          <label>Tarifa</label>
          <select id="ci-tariff" style="padding:5px 9px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px;width:100%">
            <option value="">—</option>
            <option value="040" ${item.hacienda_tariff==='040'?'selected':''}>040</option>
            <option value="045" ${item.hacienda_tariff==='045'?'selected':''}>045</option>
          </select>
        </div>
      </div>
    </div>
    <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn accent" onclick="saveEditCargoItem(${id})">Guardar</button>
    </div>`);
}

async function saveEditCargoItem(id) {
  const goods  = document.getElementById('ci-goods')?.value.trim();
  const weight = parseFloat(document.getElementById('ci-weight')?.value) || 0;
  const code   = document.getElementById('ci-code')?.value.trim();
  const tariff = document.getElementById('ci-tariff')?.value;
  const r = await fetch(`/api/bl-cargo-items/${id}`, {
    method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ goods_name:goods, gross_weight:weight, hacienda_item_code:code, hacienda_tariff:tariff })
  });
  if (r.ok) { closeModal(); await loadCargoItems(currentBL.id); toast('Item actualizado'); }
  else { const d=await r.json(); toast(d.error||'Error','err'); }
}

async function deleteCargoItem(id, reloadCno) {
  if (!confirm('¿Eliminar este item?')) return;
  const r = await fetch(`/api/bl-cargo-items/${id}`, { method:'DELETE' });
  if (r.ok) { await loadCargoItems(currentBL.id); toast('Item eliminado'); }
}
