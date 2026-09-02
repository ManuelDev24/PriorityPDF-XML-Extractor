// clients.js — Alta y edición de consignatarios (catálogo de clientes)
// Extraído de index.html (paso 6 de la separación frontend/backend)

function openCreateClient(prefill=''){
  document.getElementById('client-ac').style.display='none';
  // Detectar si prefill parece SS (9 dígitos) o nombre
  const digits = prefill.replace(/[^0-9]/g,'');
  const ssVal  = digits.length >= 9 ? digits.substring(0,9) : '';
  const nameVal= digits.length >= 9 ? '' : prefill;

  showModal('Nuevo consignatario — Hacienda PR',`
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="field">
        <label>Nombre / Razón social <span style="color:var(--danger)">*</span></label>
        <input id="nc-name" value="${esc(nameVal)}" placeholder="Ej. LANCO MANUFACTURING CORP" autofocus/>
      </div>
      <div class="fg fg2">
        <div class="field">
          <label>SS / EIN (9 dígitos) <span style="color:var(--danger)">*</span></label>
          <input id="nc-ss" value="${esc(ssVal)}" placeholder="660123456" maxlength="11"
            oninput="this.value=this.value.replace(/[^0-9-]/g,'');validateSSField(this)"/>
          <div id="nc-ss-hint" class="hint"></div>
        </div>
        <div class="field">
          <label>IVU / No. comerciante</label>
          <input id="nc-ivu" placeholder="Opcional"/>
        </div>
      </div>
      <div class="field">
        <label>Dirección línea 1</label>
        <input id="nc-add1" placeholder="Ej. URB. APONTE #5"/>
      </div>
      <div class="field">
        <label>Dirección línea 2</label>
        <input id="nc-add2" placeholder="Ej. SAN LORENZO, PR 00754"/>
      </div>
      <div class="field">
        <label>Teléfono</label>
        <input id="nc-phone" placeholder="787-000-0000"/>
      </div>
      <div id="nc-error" style="color:var(--danger);font-size:12px;display:none"></div>
    </div>`,
    [
      {label:'Cancelar',  action:'closeModal()',        cls:''},
      {label:'Guardar consignatario', action:'saveNewClient(false)', cls:'accent'},
    ]
  );
}

async function openEditClient(id, ss, name){
  // Cargar datos actuales del cliente para poblar todos los campos
  let client = { ss, name: name||'', ivu:'', add1:'', add2:'', phone1:'' };
  try {
    const list = await api(`/api/catalogs/clients?q=${encodeURIComponent(ss)}`);
    const found = list.find(c=>c.id===id||c.ss===ss);
    if(found) client = found;
  } catch(_) {}

  showModal(`Editar consignatario`,`
    <div style="display:flex;flex-direction:column;gap:10px">
      <p style="font-size:12px;color:var(--text2)">SS/EIN: <strong>${esc(client.ss)}</strong></p>
      <div class="field">
        <label>Nombre / Razón social</label>
        <input id="nc-name" value="${esc(client.name||'')}"/>
      </div>
      <div class="fg fg2">
        <div class="field">
          <label>SS / EIN</label>
          <input id="nc-ss" value="${esc(client.ss||'')}" maxlength="11"
            oninput="this.value=this.value.replace(/[^0-9-]/g,'');validateSSField(this)"/>
          <div id="nc-ss-hint" class="hint"></div>
        </div>
        <div class="field">
          <label>IVU / No. comerciante</label>
          <input id="nc-ivu" value="${esc(client.ivu||'')}" placeholder="Opcional"/>
        </div>
      </div>
      <div class="field"><label>Dirección línea 1</label><input id="nc-add1" value="${esc(client.add1||'')}"/></div>
      <div class="field"><label>Dirección línea 2</label><input id="nc-add2" value="${esc(client.add2||'')}"/></div>
      <div class="field"><label>Teléfono</label><input id="nc-phone" value="${esc(client.phone1||'')}"/></div>
      <div id="nc-error" style="color:var(--danger);font-size:12px;display:none"></div>
    </div>`,
    [
      {label:'Cancelar', action:'closeModal()', cls:''},
      {label:'Guardar cambios', action:`saveEditClient(${id})`, cls:'accent'},
    ]
  );
}

function validateSSField(inp){
  const digits = inp.value.replace(/[^0-9]/g,'');
  const hint   = document.getElementById('nc-ss-hint');
  if(!hint) return;
  if(digits.length === 9){
    hint.innerHTML = `<span style="color:var(--success)">✓ 9 dígitos — formato correcto</span>`;
  } else if(digits.length > 0){
    hint.textContent = `${digits.length}/9 dígitos`;
    hint.style.color = 'var(--warn)';
  } else {
    hint.textContent = '';
  }
}

async function saveNewClient(skipDupCheck){
  const name  = document.getElementById('nc-name')?.value?.trim();
  const ss    = document.getElementById('nc-ss')?.value?.replace(/[^0-9]/g,'').substring(0,9);
  const ivu   = document.getElementById('nc-ivu')?.value?.trim()||'';
  const add1  = document.getElementById('nc-add1')?.value?.trim()||'';
  const add2  = document.getElementById('nc-add2')?.value?.trim()||'';
  const phone = document.getElementById('nc-phone')?.value?.trim()||'';
  const errEl = document.getElementById('nc-error');

  if(!name){ errEl.textContent='El nombre es requerido'; errEl.style.display='block'; return; }
  if(!ss||ss.length<9){ errEl.textContent='El SS/EIN debe tener exactamente 9 dígitos'; errEl.style.display='block'; return; }

  try{
    const result = await api('/api/catalogs/clients',{
      method:'POST',
      body: JSON.stringify({name, ss, ivu, add1, add2, phone1:phone})
    });
    closeModal();
    toast(`Consignatario "${result.client.name}" creado`);
    selectClient(result.client.ss, result.client.name, result.client.id);
  } catch(e){
    // 409 = ya existe ese SS
    let msg = e.message;
    try{ const d=JSON.parse(e.message); msg=d.error; } catch(_){}
    errEl.textContent = msg;
    errEl.style.display='block';
  }
}

async function saveEditClient(id){
  const name  = document.getElementById('nc-name')?.value?.trim();
  const ss    = document.getElementById('nc-ss')?.value?.replace(/[^0-9]/g,'').substring(0,9);
  const ivu   = document.getElementById('nc-ivu')?.value?.trim()||'';
  const add1  = document.getElementById('nc-add1')?.value?.trim()||'';
  const add2  = document.getElementById('nc-add2')?.value?.trim()||'';
  const phone = document.getElementById('nc-phone')?.value?.trim()||'';
  const errEl = document.getElementById('nc-error');

  try{
    const result = await api(`/api/catalogs/clients/${id}`,{
      method:'PUT',
      body: JSON.stringify({name, ss, ivu, add1, add2, phone1:phone})
    });
    closeModal();
    toast('Consignatario actualizado');
    selectClient(result.client.ss, result.client.name, result.client.id);
  } catch(e){
    let msg = e.message;
    try{ const d=JSON.parse(e.message); msg=d.error; } catch(_){}
    errEl.textContent = msg;
    errEl.style.display='block';
  }
}
