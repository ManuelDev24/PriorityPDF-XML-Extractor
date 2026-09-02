<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api, type ContainerType } from './api';

const TAMANOS = ['20', '40', '40HC', '45', 'RORO'];

// ── Estado ───────────────────────────────────────────────────────────────────
const bridgeHost = ref('');
const bridgePort = ref('');
const dbfPath    = ref('');

const bridgeOnline = ref<boolean | null>(null);   // null = verificando
const bridgeTexto  = ref('Verificando...');

const filas = ref<ContainerType[]>([]);

const nuevoTipo   = ref('');
const nuevoTamano = ref('40');
const nuevaEtiqueta = ref('');

const toastMsg  = ref('');
const toastTipo = ref<'ok' | 'err'>('ok');
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const bridgeUrl = computed(
  () => `http://${bridgeHost.value || 'localhost'}:${bridgePort.value || '5001'}`
);

// Mantiene el mismo comportamiento que la versión anterior: si el tamaño
// guardado no es uno de los conocidos, se agrega como opción extra para no
// perderlo al abrir el desplegable.
function opciones(size: string): string[] {
  return TAMANOS.includes(size) ? TAMANOS : [...TAMANOS, size];
}

function toast(msg: string, tipo: 'ok' | 'err' = 'ok') {
  toastMsg.value = msg;
  toastTipo.value = tipo;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastMsg.value = ''; }, 2500);
}

// ── Acciones ─────────────────────────────────────────────────────────────────
async function cargarSettings() {
  const s = await api.getSettings();
  bridgeHost.value = s.bridge_host || 'localhost';
  bridgePort.value = s.bridge_port || '5001';
  dbfPath.value    = s.dbf_path    || '';
}

async function checkBridge() {
  bridgeOnline.value = null;
  bridgeTexto.value = 'Verificando…';
  try {
    const d = await api.getBridgeStatus();
    bridgeOnline.value = d.online;
    bridgeTexto.value = d.online
      ? `Bridge online — ${d.version || 'SiscommateBridge'}`
      : `Bridge offline — ${d.error || 'Sin respuesta'}`;
  } catch (e) {
    bridgeOnline.value = false;
    bridgeTexto.value = 'Error al consultar el bridge: ' + (e as Error).message;
  }
}

async function saveBridgeConfig() {
  try {
    await api.saveSettings({ bridge_host: bridgeHost.value.trim(), bridge_port: bridgePort.value.trim() });
    toast('Configuración guardada');
    checkBridge();
  } catch { toast('Error al guardar', 'err'); }
}

async function saveDbfPath() {
  try {
    await api.saveSettings({ dbf_path: dbfPath.value.trim() });
    toast('Ruta DBF guardada');
  } catch { toast('Error al guardar', 'err'); }
}

async function cargarTipos() {
  filas.value = await api.getContainerTypes();
}

async function guardarFila(fila: ContainerType) {
  await api.saveContainerType(fila.xml_type, fila.size, fila.label);
  toast(`${fila.xml_type} → ${fila.size} guardado`);
  await cargarTipos();
}

async function eliminarFila(xmlType: string) {
  if (!confirm(`¿Eliminar el mapeo para código "${xmlType}"?`)) return;
  await api.deleteContainerType(xmlType);
  toast(`Código ${xmlType} eliminado`);
  await cargarTipos();
}

async function agregarTipo() {
  const xmlType = nuevoTipo.value.trim();
  if (!xmlType)          { toast('Ingresa el código XML', 'err'); return; }
  if (!nuevoTamano.value) { toast('Selecciona el tamaño', 'err'); return; }
  try {
    await api.addContainerType(xmlType, nuevoTamano.value, nuevaEtiqueta.value.trim());
    toast(`Código ${xmlType} agregado`);
    nuevoTipo.value = '';
    nuevaEtiqueta.value = '';
    await cargarTipos();
  } catch (e) {
    let msg = 'Error al agregar';
    try { msg = JSON.parse((e as Error).message).error || msg; } catch { /* texto plano */ }
    toast(msg, 'err');
  }
}

onMounted(() => {
  cargarSettings();
  cargarTipos();
  checkBridge();
});
</script>

<template>
  <!-- Markup copiado literal de admin.html: mismas etiquetas, mismas clases y
       los style= en línea intactos. Solo cambia la interpolación. -->
  <div class="topbar">
    <div class="topbar-logo">Priority Global <span>Manifiestos DGA → Hacienda PR</span></div>
    <div class="spacer"></div>
    <a href="/" class="btn">← Volver al editor</a>
  </div>

  <div class="content">
    <div class="page-title">Administración</div>
    <div class="page-sub">Configuración del sistema, mapeo de contenedores y conexión con SISCOMMATE</div>

    <!-- ── BRIDGE CONFIG ── -->
    <div class="card">
      <div class="card-title">🔌 Conexión SISCOMMATE Bridge</div>
      <div class="card-sub">Servidor donde corre SiscommateBridge.exe — recibe el manifiesto y lo inserta en la base de datos SISCOMMATE</div>

      <div class="status-row">
        <div class="status-dot" :class="bridgeOnline === null ? '' : (bridgeOnline ? 'online' : 'offline')"></div>
        <span>{{ bridgeTexto }}</span>
        <div class="spacer"></div>
        <button class="btn sm" @click="checkBridge">Probar conexión</button>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Host / IP del servidor</label>
          <input type="text" class="mono" placeholder="localhost" v-model="bridgeHost"/>
        </div>
        <div class="field">
          <label>Puerto</label>
          <input type="number" class="mono" placeholder="5001" style="width:100px" v-model="bridgePort"/>
        </div>
        <button class="btn accent" @click="saveBridgeConfig">Guardar</button>
      </div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:14px">
        URL resultante: <code style="font-family:monospace;color:var(--accent)">{{ bridgeUrl }}</code>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:14px;margin-top:4px">
        <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:4px">Ruta de red — Tablas DBF de SISCOMMATE (VisualFoxPro)</div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:10px">Ruta UNC o de red donde residen los archivos <code>.DBF</code> de SISCOMMATE. El bridge usa esta ruta para leer/escribir directamente las tablas. Ejemplo: <code>\\SERVIDOR\SISCOMMATE\DATA</code></div>
        <div class="field-row">
          <div class="field grow">
            <label>Ruta de tablas DBF</label>
            <input type="text" class="mono" placeholder="\\\\SERVIDOR\\SISCOMMATE\\DATA" style="width:100%" v-model="dbfPath"/>
          </div>
          <button class="btn accent" @click="saveDbfPath">Guardar</button>
        </div>
      </div>
    </div>

    <!-- ── CONTAINER TYPE MAP ── -->
    <div class="card">
      <div class="card-title">📦 Tipos de contenedor XML → Tamaño SISCOMMATE <span class="badge">{{ filas.length }} registros</span></div>
      <div class="card-sub">Mapea los códigos <code>&lt;ContainerType&gt;</code> del XML de DGA al tamaño que espera SISCOMMATE (20, 40, 40HC, 45, RORO…). Se aplica automáticamente al importar un XML.</div>

      <table>
        <thead>
          <tr>
            <th style="width:110px">Código XML</th>
            <th style="width:120px">Tamaño SISCOMMATE</th>
            <th>Descripción / Etiqueta</th>
            <th style="width:80px">Acción</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="fila in filas" :key="fila.xml_type">
            <td>
              <code style="font-family:monospace;font-weight:700;color:var(--accent)">{{ fila.xml_type }}</code>
            </td>
            <td>
              <select style="width:90px" v-model="fila.size" @change="guardarFila(fila)">
                <option v-for="s in opciones(fila.size)" :key="s">{{ s }}</option>
              </select>
            </td>
            <td>
              <input type="text" style="width:100%" v-model="fila.label" @blur="guardarFila(fila)"/>
            </td>
            <td>
              <button class="btn sm danger" @click="eliminarFila(fila.xml_type)">Eliminar</button>
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td colspan="4" style="padding:0">
              <div class="add-row-form">
                <div class="field">
                  <label>Código XML</label>
                  <input type="text" class="mono" placeholder="ej. 13" style="width:80px" v-model="nuevoTipo"/>
                </div>
                <div class="field">
                  <label>Tamaño</label>
                  <select style="width:100px" v-model="nuevoTamano">
                    <option value="20">20</option>
                    <option value="40">40</option>
                    <option value="40HC">40HC</option>
                    <option value="45">45</option>
                    <option value="RORO">RORO</option>
                    <option value="">Otro</option>
                  </select>
                </div>
                <div class="field grow">
                  <label>Descripción</label>
                  <input type="text" placeholder="ej. 40ft High Cube Refrigerado" v-model="nuevaEtiqueta"/>
                </div>
                <button class="btn accent" @click="agregarTipo">+ Agregar</button>
              </div>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  </div>

  <div v-if="toastMsg" class="toast" :class="toastTipo">{{ toastMsg }}</div>
</template>
