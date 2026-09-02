// util.js — Utilidades compartidas del frontend
// Extraído de index.html (paso 6 de la separación frontend/backend)

// Escapa texto para insertarlo como CONTENIDO HTML o valor de atributo normal.
// Correcta para <div>${esc(x)}</div> y para title="${esc(x)}".
function esc(s){
  return String(s ?? '')
    .replace(/&/g,'&amp;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;')
    .replace(/`/g,'&#96;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

// Escapa texto que va DENTRO DE UN STRING DE JAVASCRIPT en un atributo inline,
// como onclick="fn('${escJs(x)}')".
//
// FIX DE SEGURIDAD (Fase A). El bug original: esc() no escapaba la comilla
// simple, así que un manifiesto con ' en voyage_no / bl_no / container_no
// rompía el atributo y ejecutaba JavaScript arbitrario en el navegador de
// cualquiera que abriera ese viaje.
//
// Escapar solo a entidades HTML NO alcanza aquí: el parser de HTML decodifica
// &#39; de vuelta a ' ANTES de que el JS del atributo se evalúe, con lo que la
// comilla vuelve a cerrar el string. Por eso primero se escapa para contexto
// JavaScript (barra invertida) y recién después para HTML. Al decodificar, el
// \' sobrevive como comilla literal dentro del string.
function escJs(s){
  return esc(
    String(s ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g,  "\\'")
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
  );
}

function toast(msg, type='ok'){
  const el=document.getElementById('toast');
  el.textContent=(type==='ok'?'✓  ':'⚠  ')+msg;
  el.className='show '+(type==='ok'?'ok':'err');
  clearTimeout(el._t);
  el._t=setTimeout(()=>el.classList.remove('show'),3200);
}

function setStatus(msg,right=''){
  document.getElementById('status-msg').textContent=msg;
  document.getElementById('status-right').textContent=right;
}
