// manifests.js — Sidebar: lista de viajes, pestañas, búsqueda y borrado
// Extraído de index.html (paso 6 de la separación frontend/backend)

async function loadManifests(){
  try{
    allManifests=await api('/api/manifests');
    renderManifestList(filteredByTab(allManifests));
    loadStats();
  } catch(e){ setStatus('Error conectando con el servidor: '+e.message); }
}

function renderManifestList(list){
  const el=document.getElementById('manifest-list');
  if(!list.length){
    el.innerHTML='<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px">Sin manifiestos</div>';
    return;
  }
  el.innerHTML=list.map(m=>{
    const isActive  = currentManifestId===m.id;
    const isOpen    = expandedSet.has(m.id);
    const badgeCls  = m.status==='siscommate'?'sis':m.status==='exportado'?'exp':m.status==='validado'?'ok':'pend';

    // Lista de BLs — solo si está expandido y tenemos datos
    let blHtml='';
    if(isOpen && isActive && currentManifestData){
      blHtml=`<div class="bl-list">`+
        currentManifestData.bls.map(bl=>{
          const cls=currentBL&&currentBL.id===bl.id?'active':bl.status==='validado'?'validated':'';
          return `<div class="bl-list-item ${cls}" onclick="selectBLById(${bl.id})">
            <span class="bl-dot"></span>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(bl.bl_no)}</span>
            ${bl.status==='validado'?'<i class="ti ti-check" style="font-size:11px;color:var(--success)"></i>':''}
            <button class="mi-btn danger sm" style="padding:1px 5px;height:20px;font-size:10px;margin-left:4px" title="Eliminar B/L ${esc(bl.bl_no)}"
              onclick="event.stopPropagation();confirmDeleteBL(${bl.id},'${escJs(bl.bl_no)}')">
              <i class="ti ti-trash" style="font-size:11px"></i> Eliminar B/L
            </button>
          </div>`;
        }).join('')+
      `</div>`;
    }

    return `
    <div>
      <div class="manifest-item ${isActive?'active':''}">
        <div class="mi-title">
          <button class="mi-btn toggle-btn ${isOpen?'open':''}" title="${isOpen?'Colapsar':'Expandir'} lista de B/L"
            onclick="toggleExpand(${m.id})">
            ${isOpen ? '▼' : '▶'}
          </button>
          <span style="flex:1;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            onclick="selectManifest(${m.id})">Viaje ${esc(m.voyage_no)}</span>
          <span class="badge ${badgeCls}">${esc(m.status)}</span>
          <button class="mi-btn danger" title="Eliminar manifiesto"
            onclick="event.stopPropagation();confirmDeleteManifest(${m.id},'${escJs(m.voyage_no)}')">
            <i class="ti ti-trash"></i> Eliminar
          </button>
        </div>
        <div class="mi-sub" style="padding-left:26px;cursor:pointer" onclick="selectManifest(${m.id})">
          ${esc(m.vessel_name||m.vessel_code||'')} &nbsp;·&nbsp; ${m.bl_count} B/L
        </div>
        <div class="mi-sub" style="padding-left:26px">${esc((m.arrival_date||'').substring(0,10))}</div>
      </div>
      ${blHtml}
    </div>`;
  }).join('');
}

async function toggleExpand(id){
  if(expandedSet.has(id)){
    expandedSet.delete(id);
    renderManifestList(filteredByTab(allManifests));
  } else {
    expandedSet.add(id);
    if(currentManifestId !== id){
      await selectManifest(id);
    } else {
      renderManifestList(filteredByTab(allManifests));
    }
  }
}

// ─── TABS: En curso / Completados ───────────────────────────────────────────
function switchTab(tab){
  currentTab = tab;
  document.getElementById('tab-active').className    = 'sidebar-tab' + (tab==='active'?' active':'');
  document.getElementById('tab-completed').className = 'sidebar-tab' + (tab==='completed'?' active':'');
  document.getElementById('sidebar-search-input').value = '';
  document.getElementById('bl-search-results').style.display = 'none';
  renderManifestList(filteredByTab(allManifests));
}

function filteredByTab(list){
  if(currentTab==='completed')
    return list.filter(m=>m.status==='siscommate'||m.status==='exportado');
  return list.filter(m=>m.status!=='siscommate'&&m.status!=='exportado');
}

async function onSidebarSearch(q){
  clearTimeout(searchTimer);
  const blPanel = document.getElementById('bl-search-results');
  if(!q || q.length < 2){
    blPanel.style.display='none';
    renderManifestList(filteredByTab(allManifests));
    return;
  }
  searchTimer = setTimeout(async()=>{
    try{
      const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
      // Manifiestos filtrados
      const ql = q.toLowerCase();
      const matchedManifests = allManifests.filter(m=>
        (m.voyage_no||'').toLowerCase().includes(ql)||
        (m.filename||'').toLowerCase().includes(ql)||
        (m.vessel_name||'').toLowerCase().includes(ql)||
        (m.manifest_no||'').toLowerCase().includes(ql)
      );
      renderManifestList(matchedManifests);
      // Resultados de BL
      if(data.bls && data.bls.length){
        blPanel.style.display='block';
        blPanel.innerHTML=
          `<div style="padding:4px 10px;font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">B/L encontrados</div>`+
          data.bls.map(bl=>`
            <div class="bl-search-item" onclick="jumpToBL(${bl.manifest_id},${bl.id})">
              <div class="bsi-bl">${esc(bl.bl_no)} <span style="font-weight:400;color:var(--text2)">${esc(bl.consignee_name||'')}</span></div>
              <div class="bsi-meta">Viaje ${esc(bl.voyage_no)} &nbsp;·&nbsp; ${esc((bl.arrival_date||'').substring(0,10))}</div>
            </div>`).join('');
      } else {
        blPanel.style.display='none';
      }
    }catch(e){}
  },250);
}

async function jumpToBL(manifestId, blId){
  document.getElementById('sidebar-search-input').value='';
  document.getElementById('bl-search-results').style.display='none';
  if(currentManifestId !== manifestId) await selectManifest(manifestId);
  selectBLById(blId);
}

function filterManifests(q){
  renderManifestList(allManifests.filter(m=>
    m.voyage_no.toLowerCase().includes(q.toLowerCase())||
    (m.filename||'').toLowerCase().includes(q.toLowerCase())||
    (m.vessel_name||'').toLowerCase().includes(q.toLowerCase())
  ));
}

async function selectManifest(id){
  currentManifestId=id;
  expandedSet.add(id); // auto-expandir al seleccionar
  try{
    currentManifestData=await api(`/api/manifests/${id}`);
    const m=currentManifestData.manifest;
    // Toolbar
    document.getElementById('main-toolbar').style.display='flex';
    document.getElementById('toolbar-voyage').textContent=`Viaje ${m.voyage_no}`;
    document.getElementById('toolbar-vessel').textContent=m.vessel_name||'';
    // Re-render sidebar con BLs
    renderManifestList(filteredByTab(allManifests));
    // Seleccionar primer BL
    if(currentManifestData.bls.length){
      selectBL(currentManifestData.bls[0]);
    } else {
      document.getElementById('editor').innerHTML='<div class="empty-state"><i class="ti ti-packages"></i><p>Este manifiesto no tiene B/L</p></div>';
    }
    setStatus(`Manifiesto ${m.voyage_no} — ${currentManifestData.bls.length} B/L cargados`);
  } catch(e){ toast('Error cargando manifiesto','err'); }
}

function selectBLById(id){
  if(!currentManifestData) return;
  const bl=currentManifestData.bls.find(b=>b.id===id);
  if(bl) selectBL(bl);
}

function selectBL(bl){
  currentBL=bl;
  document.getElementById('btn-preview').disabled=false;
  renderManifestList(filteredByTab(allManifests));
  renderEditor(bl);
}

// ─── ELIMINAR MANIFIESTO ────────────────────────────────────────────────────
function confirmDeleteManifest(id, voyageNo){
  showModal('Eliminar manifiesto',
    `<p>¿Seguro que deseas eliminar el viaje <strong>${esc(voyageNo)}</strong> y todos sus B/L?</p>
     <p style="margin-top:8px;font-size:12px;color:var(--danger)">Esta acción no se puede deshacer.</p>`,
    [
      {label:'Cancelar',  action:'closeModal()',           cls:''},
      {label:'Eliminar',  action:`deleteManifest(${id})`,  cls:'danger'},
    ]
  );
}

async function deleteManifest(id){
  closeModal();
  try {
    await api(`/api/manifests/${id}`, {method:'DELETE'});
    expandedSet.delete(id);
    toast('Manifiesto eliminado');
    // Limpiar estado si era el activo
    if(currentManifestId === id){
      currentManifestId   = null;
      currentManifestData = null;
      currentBL           = null;
      document.getElementById('main-toolbar').style.display='none';
      document.getElementById('editor').innerHTML=`
        <div class="empty-state">
          <i class="ti ti-ship"></i>
          <p style="font-size:15px;color:var(--text2)">Selecciona un manifiesto</p>
          <p style="font-size:12px">o carga un XML o PDF de la DGA</p>
        </div>`;
    }
    await loadManifests();
  } catch(e){
    toast('Error al eliminar: '+e.message, 'err');
  }
}

// ─── ELIMINAR B/L INDIVIDUAL ────────────────────────────────────────────────
function confirmDeleteBL(blId, blNo){
  showModal('Eliminar B/L',
    `<p>¿Seguro que deseas eliminar el B/L <strong>${esc(blNo)}</strong> de este manifiesto?</p>
     <p style="margin-top:8px;font-size:12px;color:var(--danger)">Esta acción no se puede deshacer.</p>`,
    [
      {label:'Cancelar',     action:'closeModal()',      cls:''},
      {label:'Eliminar B/L', action:`deleteBL(${blId})`, cls:'danger'},
    ]
  );
}

async function deleteBL(blId){
  closeModal();
  try {
    await api(`/api/bl/${blId}`, {method:'DELETE'});
    toast('B/L eliminado correctamente');
    if(currentManifestId){
      currentManifestData = await api(`/api/manifests/${currentManifestId}`);
      // Actualizar conteo de B/Ls en lista global
      const m = allManifests.find(x => x.id === currentManifestId);
      if(m && currentManifestData.bls) m.bl_count = currentManifestData.bls.length;
      renderManifestList(filteredByTab(allManifests));
      loadStats();

      // Si el B/L eliminado era el que estaba abierto en el editor
      if(currentBL && currentBL.id === blId){
        if(currentManifestData.bls && currentManifestData.bls.length){
          selectBL(currentManifestData.bls[0]);
        } else {
          currentBL = null;
          document.getElementById('btn-preview').disabled = true;
          document.getElementById('editor').innerHTML = `
            <div class="empty-state">
              <i class="ti ti-packages"></i>
              <p style="font-size:15px;color:var(--text2)">Este manifiesto no tiene B/L</p>
            </div>`;
        }
      }
    }
  } catch(e){
    toast('Error eliminando B/L: ' + e.message, 'err');
  }
}
