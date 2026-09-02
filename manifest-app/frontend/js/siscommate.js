// siscommate.js — Exportación a Hacienda y push a SISCOMMATE
// Extraído de index.html (paso 6 de la separación frontend/backend)

// ═══════════════════════════════════════════════════════════════
// PUSH AL SISCOMMATE
// ═══════════════════════════════════════════════════════════════
async function pushSiscommate(){
  if(!currentManifestId){ toast('Selecciona un manifiesto','err'); return; }

  // Verificar que el bridge está online
  try{
    const bst=await api('/api/bridge/status');
    if(!bst.online) throw new Error('offline');
  }catch(e){
    showModal('⚠️ Bridge offline',
      `<p>SiscommateBridge.exe no está corriendo en el servidor.</p>
       <p style="margin-top:8px;font-size:11px;color:var(--text2)">
         Para activarlo, ve a la carpeta <code>bridge/</code> en el servidor
         y ejecuta <code>iniciar_manual.bat</code> o instálalo como servicio con
         <code>instalar_servicio.bat</code>.
       </p>`,
      [{label:'Entendido', action:'closeModal()', cls:'accent'}]);
    return;
  }

  // Verificar campos mínimos
  const m=currentManifestData.manifest;
  if(!m.vessel_name){ toast('Selecciona el buque antes de guardar en SISCOMMATE','err'); return; }

  const blsSinCodigo=currentManifestData.bls.filter(b=>!b.hacienda_client_ss&&!b.consignee_document_no);
  if(blsSinCodigo.length){
    showModal('⚠️ B/L sin SS/EIN',
      `<p>${blsSinCodigo.length} B/L no tienen SS/EIN del consignatario:</p>
       <ul style="margin:8px 0 0 16px;font-size:12px">${blsSinCodigo.map(b=>`<li>${esc(b.bl_no)}</li>`).join('')}</ul>
       <p style="margin-top:8px;font-size:11px;color:var(--text2)">¿Deseas continuar igualmente?</p>`,
      [{label:'Cancelar', action:'closeModal()', cls:''},
       {label:'Continuar', action:`confirmPush()`, cls:'purple'}]);
    return;
  }

  await confirmPush();
}

async function confirmPush(){
  closeModal();
  const btn=document.getElementById('btn-push');
  btn.disabled=true;
  btn.innerHTML='<i class="ti ti-loader spin"></i> Guardando...';
  setStatus('Enviando al SISCOMMATE...');
  try{
    const result=await api(`/api/manifests/${currentManifestId}/push-siscommate`,{method:'POST'});
    toast(`Guardado en SISCOMMATE — Lote ${result.lote_nuevo}`);
    setStatus(`Guardado en SISCOMMATE. Lote anterior: ${result.lote_anterior} → nuevo: ${result.lote_nuevo}`);
    // Refrescar estado: recargar manifiesto completo para que el editor refleje el nuevo status
    await loadManifests();
    if(currentManifestId) await selectManifest(currentManifestId);
  }catch(e){
    // El servidor devuelve los errores de validación separados por " | "
    let msg = e.message;
    try{ const d=JSON.parse(e.message); msg=d.error||msg; } catch(_){}
    showModal('⚠️ No se puede guardar en SISCOMMATE',
      `<p style="color:var(--danger);font-weight:600">Corrija los siguientes problemas:</p>
       <ul style="margin:10px 0 0 16px;font-size:12px;line-height:2">
         ${String(msg).split(' | ').map(x=>`<li>${esc(x)}</li>`).join('')}
       </ul>`,
      [{label:'Entendido', action:'closeModal()', cls:'accent'}]);
    setStatus('Error al guardar en SISCOMMATE');
  }
  btn.disabled=false;
  btn.innerHTML='<i class="ti ti-database-import"></i> Guardar en SISCOMMATE';
}

// ═══════════════════════════════════════════════════════════════
// EXPORTAR TXT HACIENDA
// ═══════════════════════════════════════════════════════════════
async function exportTxt(){
  if(!currentManifestId){ toast('Selecciona un manifiesto','err'); return; }
  const m=currentManifestData.manifest;
  if(!m.manifest_no){
    toast('Ingresa el número de manifiesto Hacienda antes de exportar','err');
    document.querySelector('[onchange*="manifest_no"]')?.focus();
    return;
  }
  if(!m.docking_number || !/^\d+$/.test(m.docking_number)){
    toast('El Docking Number es obligatorio y debe ser numérico','err');
    document.getElementById('f-docking')?.focus();
    return;
  }
  // Validar en servidor antes de descargar
  try {
    const check = await fetch(`/api/manifests/${currentManifestId}/export-txt`);
    if (!check.ok) {
      const err = await check.json();
      showModal('⚠️ No se puede exportar',
        `<p style="color:var(--danger);font-weight:600">Corrija los siguientes problemas antes de exportar:</p>
         <ul style="margin:10px 0 0 16px;font-size:12px;line-height:2">
           ${err.error.split(' | ').map(e=>`<li>${esc(e)}</li>`).join('')}
         </ul>`,
        [{label:'Entendido', action:'closeModal()', cls:'accent'}]);
      return;
    }
    // Si pasó validación, descargar el blob directamente
    const blob = await check.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${m.manifest_no||m.voyage_no}_HACIENDA.TXT`;
    a.click();
    URL.revokeObjectURL(url);
    toast('TXT Hacienda PR generado correctamente');
    setTimeout(loadStats,1500);
    await loadManifests();
  } catch(e) {
    toast('Error generando TXT: '+e.message,'err');
  }
}
