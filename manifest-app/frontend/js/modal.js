// modal.js — Diálogos modales
// Extraído de index.html (paso 6 de la separación frontend/backend)

// Modal simple: título + cuerpo HTML (los botones van dentro del cuerpo)
function openModal(title, bodyHtml) {
  document.getElementById('modal-overlay')?.remove();
  const div = document.createElement('div');
  div.id = 'modal-overlay';
  div.className = 'modal-overlay';
  div.innerHTML = `<div class="modal" style="max-width:580px;width:90%">
    <h3 style="margin-bottom:16px">${title}</h3>
    ${bodyHtml}
  </div>`;
  document.body.appendChild(div);
  div.addEventListener('click', e => { if(e.target===div) closeModal(); });
  return div;
}

// Modal con lista de botones declarada aparte
function showModal(title, html, buttons){
  document.getElementById('modal-overlay')?.remove();
  const div=document.createElement('div');
  div.id='modal-overlay';
  div.className='modal-overlay';
  div.innerHTML=`
    <div class="modal">
      <h3><i class="ti ti-alert-triangle"></i> ${title}</h3>
      <div style="font-size:13px;line-height:1.6">${html}</div>
      <div class="modal-actions">
        ${buttons.map(b=>`<button class="btn ${b.cls||''}" onclick="${b.action}">${b.label}</button>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(div);
  div.addEventListener('click',e=>{ if(e.target===div) closeModal(); });
}

function closeModal(){ document.getElementById('modal-overlay')?.remove(); }
