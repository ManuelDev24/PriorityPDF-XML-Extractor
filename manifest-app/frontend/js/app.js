// app.js — Arranque de la aplicación y handlers globales
// Extraído de index.html (paso 6 de la separación frontend/backend)
//
// Este archivo se carga de último: todos los módulos anteriores ya definieron
// sus funciones cuando init() corre.

// ═══════════════════════════════════════════════════════════════
// BRIDGE STATUS
// ═══════════════════════════════════════════════════════════════
async function checkBridge(){
  try{
    const d=await api('/api/bridge/status');
    const pill=document.getElementById('bridge-pill');
    const txt=document.getElementById('bridge-txt');
    if(d.online){
      pill.className='online';
      txt.textContent='Bridge activo';
    } else { throw new Error('offline'); }
  } catch(e){
    const pill=document.getElementById('bridge-pill');
    pill.className='offline';
    document.getElementById('bridge-txt').textContent='Bridge offline';
  }
}

// ═══════════════════════════════════════════════════════════════
// CATÁLOGOS Y STATS
// ═══════════════════════════════════════════════════════════════
async function loadCatalogs(){
  try{
    [catalogCarriers, catalogPorts, catalogVessels] = await Promise.all([
      api('/api/catalogs/carriers'),
      api('/api/catalogs/ports'),
      api('/api/catalogs/vessels'),
    ]);
  } catch(e){ console.warn('Error cargando catálogos', e); }
}

async function loadStats(){
  try{
    const s=await api('/api/stats');
    document.getElementById('stats-top').innerHTML=
      `<b>${s.manifests}</b> viajes &nbsp;·&nbsp; <b>${s.bls}</b> B/L &nbsp;·&nbsp; `+
      `<span style="color:var(--warn)"><b>${s.pending}</b> pendientes</span>`;
  } catch(e){}
}

// ═══════════════════════════════════════════════════════════════
// SUBIDA DE XML / PDF
// ═══════════════════════════════════════════════════════════════
function openUpload(){ document.getElementById('xml-input').click(); }

async function uploadXml(input){
  const file=input.files[0];
  if(!file) return;
  setStatus('Cargando manifiesto...');
  const fd=new FormData();
  fd.append('xml',file);
  try{
    const r=await fetch('/api/manifests/upload',{method:'POST',body:fd});
    const data=await r.json();
    if(!data.ok) throw new Error(data.error);
    toast(`Manifiesto cargado: ${data.bl_count} B/L`);
    await loadManifests();
    selectManifest(data.manifest_id);
  }catch(e){ toast('Error: '+e.message,'err'); setStatus('Error cargando manifiesto'); }
  input.value='';
}

function handleDrop(e){
  e.preventDefault();
  document.getElementById('drop-zone').classList.remove('drag');
  const file=e.dataTransfer.files[0];
  if(!file||!/\.(xml|pdf)$/i.test(file.name)){ toast('Selecciona un archivo .xml o .pdf','err'); return; }
  uploadXml({files:[file]});
}

// ═══════════════════════════════════════════════════════════════
// EVENTOS GLOBALES
// ═══════════════════════════════════════════════════════════════
// Cerrar dropdowns al hacer clic fuera
document.addEventListener('click',e=>{
  if(!e.target.closest('.ac-wrap'))
    document.querySelectorAll('.ac-drop').forEach(el=>el.style.display='none');
});

// Reposicionar dropdowns visibles al hacer scroll (evita que queden flotando)
document.getElementById('editor')?.addEventListener('scroll', ()=>{
  document.querySelectorAll('.ac-drop').forEach(drop=>{
    if(drop.style.display==='none') return;
    const wrap = drop.closest('.ac-wrap');
    const inp  = wrap?.querySelector('input');
    if(inp) positionDrop(inp, drop);
  });
}, { passive: true });

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════
setInterval(checkBridge,30000);
checkBridge();

async function init(){
  await loadCatalogs();
  await loadManifests();
}
init();
