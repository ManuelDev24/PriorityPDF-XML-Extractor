// admin.js — Pantalla de administración: bridge, ruta DBF y tipos de contenedor
// Extraído de admin.html (paso 6 de la separación frontend/backend)

// ── Helpers ──
function toast(msg, type='ok') {
  let t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; setTimeout(()=>t.remove(),300); }, 2500);
}

// ── Bridge config ──
async function loadSettings() {
  const s = await fetch('/api/settings').then(r=>r.json());
  document.getElementById('bridge_host').value = s.bridge_host || 'localhost';
  document.getElementById('bridge_port').value = s.bridge_port || '5001';
  document.getElementById('dbf_path').value    = s.dbf_path    || '';
  updateBridgeUrl();
}

function updateBridgeUrl() {
  const h = document.getElementById('bridge_host').value || 'localhost';
  const p = document.getElementById('bridge_port').value || '5001';
  document.getElementById('bridge-url').textContent = `http://${h}:${p}`;
}
document.getElementById('bridge_host').addEventListener('input', updateBridgeUrl);
document.getElementById('bridge_port').addEventListener('input', updateBridgeUrl);

async function saveBridgeConfig() {
  const body = {
    bridge_host: document.getElementById('bridge_host').value.trim(),
    bridge_port: document.getElementById('bridge_port').value.trim(),
  };
  const r = await fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  if (r.ok) { toast('Configuración guardada'); checkBridge(); }
  else toast('Error al guardar', 'err');
}

async function saveDbfPath() {
  const body = { dbf_path: document.getElementById('dbf_path').value.trim() };
  const r = await fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  if (r.ok) toast('Ruta DBF guardada');
  else toast('Error al guardar', 'err');
}

async function checkBridge() {
  const dot  = document.getElementById('bridge-dot');
  const text = document.getElementById('bridge-status-text');
  dot.className = 'status-dot';
  text.textContent = 'Verificando…';
  try {
    const d = await fetch('/api/bridge/status').then(r=>r.json());
    if (d.online) {
      dot.className = 'status-dot online';
      text.textContent = `Bridge online — ${d.version || 'SiscommateBridge'}`;
    } else {
      dot.className = 'status-dot offline';
      text.textContent = `Bridge offline — ${d.error || 'Sin respuesta'}`;
    }
  } catch(e) {
    dot.className = 'status-dot offline';
    text.textContent = 'Error al consultar el bridge: ' + e.message;
  }
}

// ── Container type map ──
let ctRows = [];

async function loadContainerTypes() {
  ctRows = await fetch('/api/catalogs/container-types').then(r=>r.json());
  renderCT();
}

const SIZE_OPTS = ['20','40','40HC','45','48','53','RORO'];

function renderCT() {
  document.getElementById('ct-count').textContent = `${ctRows.length} registros`;
  const tbody = document.getElementById('ct-tbody');
  tbody.innerHTML = ctRows.map(row => `
    <tr id="ct-row-${esc(row.xml_type)}">
      <td><code style="font-family:monospace;font-weight:700;color:var(--accent)">${esc(row.xml_type)}</code></td>
      <td>
        <select onchange="saveCTRow('${escJs(row.xml_type)}', this.value, document.getElementById('ct-lbl-${esc(row.xml_type)}').value)" style="width:90px">
          ${SIZE_OPTS.map(s=>`<option ${row.size===s?'selected':''}>${s}</option>`).join('')}
          ${!SIZE_OPTS.includes(row.size)?`<option selected>${esc(row.size)}</option>`:''}
        </select>
      </td>
      <td><input type="text" id="ct-lbl-${esc(row.xml_type)}" value="${esc(row.label)}" onblur="saveCTRowLabel('${escJs(row.xml_type)}', this)" style="width:100%"/></td>
      <td><button class="btn sm danger" onclick="deleteCT('${escJs(row.xml_type)}')">Eliminar</button></td>
    </tr>
  `).join('');
}

// Escape para contenido HTML y atributos normales.
// (admin.js se mantiene autónomo: su toast() es distinto al de la app
// principal, por eso no carga util.js.)
function esc(s) {
  return String(s||'')
    .replace(/&/g,'&amp;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;')
    .replace(/`/g,'&#96;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

// Escape para valores dentro de un string de JavaScript en un atributo inline,
// como onclick="fn('${escJs(x)}')". Ver la explicación completa en js/util.js:
// escapar solo a entidades HTML no basta, porque el parser las decodifica
// antes de evaluar el JS del atributo y la comilla vuelve a cerrar el string.
function escJs(s) {
  return esc(
    String(s||'')
      .replace(/\\/g, '\\\\')
      .replace(/'/g,  "\\'")
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
  );
}

async function saveCTRow(xmlType, size, label) {
  await fetch(`/api/catalogs/container-types/${encodeURIComponent(xmlType)}`, {
    method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ size, label })
  });
  toast(`${xmlType} → ${size} guardado`);
  await loadContainerTypes();
}

async function saveCTRowLabel(xmlType, input) {
  const row = ctRows.find(r=>r.xml_type===xmlType);
  if (!row) return;
  await saveCTRow(xmlType, row.size, input.value);
}

async function deleteCT(xmlType) {
  if (!confirm(`¿Eliminar el mapeo para código "${xmlType}"?`)) return;
  await fetch(`/api/catalogs/container-types/${encodeURIComponent(xmlType)}`, { method:'DELETE' });
  toast(`Código ${xmlType} eliminado`);
  await loadContainerTypes();
}

async function addContainerType() {
  const xmlType = document.getElementById('new-xml-type').value.trim();
  const size    = document.getElementById('new-size').value;
  const label   = document.getElementById('new-label').value.trim();
  if (!xmlType) { toast('Ingresa el código XML', 'err'); return; }
  if (!size)    { toast('Selecciona el tamaño', 'err'); return; }
  const r = await fetch('/api/catalogs/container-types', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ xml_type: xmlType, size, label })
  });
  if (r.ok) {
    toast(`Código ${xmlType} agregado`);
    document.getElementById('new-xml-type').value = '';
    document.getElementById('new-label').value = '';
    await loadContainerTypes();
  } else {
    const d = await r.json();
    toast(d.error || 'Error al agregar', 'err');
  }
}

// ── Init ──
loadSettings();
loadContainerTypes();
checkBridge();
