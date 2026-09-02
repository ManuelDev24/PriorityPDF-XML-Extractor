<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api, type Cliente, type VistaPreviaTxt } from './api';
import {
  datosManifiesto, blActual, stats, estado, estadoDerecha, toastMsg, toastTipo,
  cargarCatalogos, cargarManifiestos, seleccionarManifiesto, cargarStats,
  guardarPendientes, toast, setEstado,
} from './store';
import Sidebar from './Sidebar.vue';
import EditorPanel from './EditorPanel.vue';

const bridgeOnline = ref(false);
const archivoInput = ref<HTMLInputElement | null>(null);
const arrastrando  = ref(false);
const editorRef    = ref<InstanceType<typeof EditorPanel> | null>(null);

// ── Modal genérico ───────────────────────────────────────────────────────────
const modal = ref<{
  titulo: string;
  cuerpo: string;
  botones: Array<{ label: string; cls: string; accion: () => void }>;
} | null>(null);

function cerrarModal() { modal.value = null; }

function confirmar(titulo: string, cuerpo: string, accion: () => void) {
  modal.value = {
    titulo, cuerpo,
    botones: [
      { label: 'Cancelar', cls: '', accion: cerrarModal },
      { label: titulo.includes('B/L') ? 'Eliminar B/L' : 'Eliminar', cls: 'danger',
        accion: () => { cerrarModal(); accion(); } },
    ],
  };
}

function avisar(titulo: string, cuerpo: string) {
  modal.value = { titulo, cuerpo, botones: [{ label: 'Entendido', cls: 'accent', accion: cerrarModal }] };
}

// ── Modal de consignatario ───────────────────────────────────────────────────
const cliente = ref<{ id: number | null; name: string; ss: string; ivu: string;
                      add1: string; add2: string; phone1: string } | null>(null);
const clienteError = ref('');

const ssDigitos = computed(() => (cliente.value?.ss || '').replace(/[^0-9]/g, ''));

function abrirCrearCliente(prefill: string) {
  const digitos = prefill.replace(/[^0-9]/g, '');
  cliente.value = {
    id: null,
    name: digitos.length >= 9 ? '' : prefill,
    ss:   digitos.length >= 9 ? digitos.substring(0, 9) : '',
    ivu: '', add1: '', add2: '', phone1: '',
  };
  clienteError.value = '';
}

async function abrirEditarCliente(id: number, ss: string, nombre: string) {
  let c: Partial<Cliente> = { id, ss, name: nombre };
  try {
    const lista = await api.buscarClientes(ss);
    c = lista.find(x => x.id === id || x.ss === ss) ?? c;
  } catch { /* usar lo que se sabe */ }
  cliente.value = {
    id: c.id ?? id, name: c.name ?? '', ss: c.ss ?? '', ivu: c.ivu ?? '',
    add1: c.add1 ?? '', add2: c.add2 ?? '', phone1: c.phone1 ?? '',
  };
  clienteError.value = '';
}

async function guardarCliente() {
  const c = cliente.value;
  if (!c) return;
  const ss = ssDigitos.value.substring(0, 9);
  if (!c.name.trim()) { clienteError.value = 'El nombre es requerido'; return; }
  if (ss.length < 9)  { clienteError.value = 'El SS/EIN debe tener exactamente 9 dígitos'; return; }
  try {
    const datos = { name: c.name.trim(), ss, ivu: c.ivu, add1: c.add1, add2: c.add2, phone1: c.phone1 };
    const r = c.id !== null
      ? await api.actualizarCliente(c.id, datos)
      : await api.crearCliente(datos);
    cliente.value = null;
    toast(c.id !== null ? 'Consignatario actualizado' : `Consignatario "${r.client.name}" creado`);
    editorRef.value?.aplicarCliente(r.client);
  } catch (e) {
    let msg = (e as Error).message;
    try { msg = JSON.parse(msg).error; } catch { /* texto plano */ }
    clienteError.value = msg;
  }
}

// ── Vista previa del TXT ─────────────────────────────────────────────────────
const previa = ref<VistaPreviaTxt | null>(null);
const regla = '123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234'.substring(0, 205);

async function verTxt(blId: number) {
  try { previa.value = await api.vistaPreviaTxt(blId); }
  catch { toast('Error en vista previa', 'err'); }
}

// ── Bridge, carga de archivo, exportar y push ────────────────────────────────
async function revisarBridge() {
  try { bridgeOnline.value = (await api.estadoBridge()).online; }
  catch { bridgeOnline.value = false; }
}

function abrirSubida() { archivoInput.value?.click(); }

async function subir(archivo: File | undefined) {
  if (!archivo) return;
  setEstado('Cargando manifiesto...');
  const fd = new FormData();
  fd.append('xml', archivo);
  try {
    const r = await fetch('/api/manifests/upload', { method: 'POST', body: fd });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error);
    toast(`Manifiesto cargado: ${data.bl_count} B/L`);
    await cargarManifiestos();
    await seleccionarManifiesto(data.manifest_id);
  } catch (e) {
    toast('Error: ' + (e as Error).message, 'err');
    setEstado('Error cargando manifiesto');
  }
  if (archivoInput.value) archivoInput.value.value = '';
}

function soltar(e: DragEvent) {
  arrastrando.value = false;
  const f = e.dataTransfer?.files[0];
  if (!f || !/\.(xml|pdf)$/i.test(f.name)) { toast('Selecciona un archivo .xml o .pdf', 'err'); return; }
  subir(f);
}

async function exportarTxt() {
  const m = datosManifiesto.value?.manifest;
  if (!m) { toast('Selecciona un manifiesto', 'err'); return; }
  await guardarPendientes();   // que no se quede nada sin mandar
  if (!m.manifest_no) { toast('Ingresa el número de manifiesto Hacienda antes de exportar', 'err'); return; }
  if (!m.docking_number || !/^\d+$/.test(m.docking_number)) {
    toast('El Docking Number es obligatorio y debe ser numérico', 'err'); return;
  }
  try {
    const r = await fetch(`/api/manifests/${m.id}/export-txt`);
    if (!r.ok) {
      const err = await r.json();
      avisar('⚠️ No se puede exportar',
        `<p style="color:var(--danger);font-weight:600">Corrija los siguientes problemas antes de exportar:</p>
         <ul style="margin:10px 0 0 16px;font-size:12px;line-height:2">
           ${String(err.error).split(' | ').map((x: string) => `<li>${x}</li>`).join('')}
         </ul>`);
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${m.manifest_no || m.voyage_no}_HACIENDA.TXT`;
    a.click();
    URL.revokeObjectURL(url);
    toast('TXT Hacienda PR generado correctamente');
    setTimeout(cargarStats, 1500);
    await cargarManifiestos();
  } catch (e) { toast('Error generando TXT: ' + (e as Error).message, 'err'); }
}

const enviando = ref(false);

async function pushSiscommate() {
  const m = datosManifiesto.value?.manifest;
  if (!m) { toast('Selecciona un manifiesto', 'err'); return; }
  await guardarPendientes();
  await revisarBridge();
  if (!bridgeOnline.value) {
    avisar('⚠️ Bridge offline',
      `<p>SiscommateBridge.exe no está corriendo en el servidor.</p>
       <p style="margin-top:8px;font-size:11px;color:var(--text2)">
         Para activarlo, ve a la carpeta <code>bridge/</code> en el servidor
         y ejecuta <code>iniciar_manual.bat</code> o instálalo como servicio con
         <code>instalar_servicio.bat</code>.
       </p>`);
    return;
  }
  if (!m.vessel_name) { toast('Selecciona el buque antes de guardar en SISCOMMATE', 'err'); return; }

  enviando.value = true;
  setEstado('Enviando al SISCOMMATE...');
  try {
    const r = await api.pushSiscommate(m.id);
    toast(`Guardado en SISCOMMATE — Lote ${r.lote_nuevo}`);
    setEstado(`Guardado en SISCOMMATE. Lote anterior: ${r.lote_anterior} → nuevo: ${r.lote_nuevo}`);
    await cargarManifiestos();
    await seleccionarManifiesto(m.id);
  } catch (e) {
    let msg = (e as Error).message;
    try { msg = JSON.parse(msg).error || msg; } catch { /* texto plano */ }
    avisar('⚠️ No se puede guardar en SISCOMMATE',
      `<p style="color:var(--danger);font-weight:600">Corrija los siguientes problemas:</p>
       <ul style="margin:10px 0 0 16px;font-size:12px;line-height:2">
         ${String(msg).split(' | ').map(x => `<li>${x}</li>`).join('')}
       </ul>`);
    setEstado('Error al guardar en SISCOMMATE');
  }
  enviando.value = false;
}

onMounted(async () => {
  revisarBridge();
  setInterval(revisarBridge, 30000);
  await cargarCatalogos();
  await cargarManifiestos();
});
</script>

<template>
  <!-- TOPBAR -->
  <div class="topbar">
    <div class="topbar-logo">Priority Global <span>Manifiestos DGA → Hacienda PR</span></div>
    <div id="bridge-pill" :class="bridgeOnline ? 'online' : 'offline'" title="Estado de SiscommateBridge">
      <span class="bridge-dot"></span><span>{{ bridgeOnline ? 'Bridge activo' : 'Bridge offline' }}</span>
    </div>
    <div class="spacer"></div>
    <div id="stats-top" style="font-size:11px;color:var(--text2)">
      <b>{{ stats.manifests }}</b> viajes &nbsp;·&nbsp; <b>{{ stats.bls }}</b> B/L &nbsp;·&nbsp;
      <span style="color:var(--warn)"><b>{{ stats.pending }}</b> pendientes</span>
    </div>
    <a href="/admin.html" target="_blank" class="btn" title="Configuración del sistema">&#9881; Admin</a>
    <button class="btn" @click="abrirSubida"><i class="ti ti-upload"></i> Cargar XML/PDF</button>
    <input type="file" ref="archivoInput" accept=".xml,.pdf" style="display:none"
           @change="subir(($event.target as HTMLInputElement).files?.[0])"/>
  </div>

  <div class="app-body">
    <Sidebar @confirmar="confirmar"/>

    <div class="main">
      <div class="main-toolbar" v-if="datosManifiesto">
        <i class="ti ti-ship" style="color:var(--accent)"></i>
        <span class="voy-label">Viaje {{ datosManifiesto.manifest.voyage_no }}</span>
        <span style="font-size:11px;color:var(--text3)">{{ datosManifiesto.manifest.vessel_name || '' }}</span>
        <span class="spacer"></span>
        <button class="btn sm" :disabled="!blActual" @click="blActual && verTxt(blActual.id)">
          <i class="ti ti-eye"></i> Ver TXT
        </button>
        <button class="btn sm accent" @click="exportarTxt">
          <i class="ti ti-file-export"></i> Exportar TXT
        </button>
        <button class="btn sm purple" :disabled="enviando" @click="pushSiscommate">
          <i class="ti" :class="enviando ? 'ti-loader spin' : 'ti-database-import'"></i>
          {{ enviando ? ' Guardando...' : ' Guardar en SISCOMMATE' }}
        </button>
      </div>

      <div id="editor" class="editor">
        <!-- Vista previa del TXT, arriba de todo -->
        <div v-if="previa" id="txt-preview-panel" class="card" style="border:2px solid var(--accent);order:-1">
          <div class="card-hdr" style="background:var(--accent-bg)">
            <i class="ti ti-file-text"></i> Vista previa TXT Hacienda PR — B/L {{ blActual?.bl_no || '' }}
            <button class="btn sm" style="margin-left:auto" @click="previa = null">✕</button>
          </div>
          <div class="card-body">
            <template v-for="(p, i) in previa.pairs" :key="i">
              <div style="font-size:10px;color:var(--text3);margin-bottom:2px">{{ previa.pairs.length > 1 ? `Contenedor ${i+1}: ${p.containerNo}` : '' }}</div>
              <div class="txt-ruler">{{ regla }}</div>
              <div class="txt-pre">{{ p.line1 }}</div>
              <div style="height:4px"></div>
              <div class="txt-ruler">{{ regla }}</div>
              <div class="txt-pre">{{ p.line2 }}</div>
              <div style="height:8px"></div>
            </template>
            <div style="font-size:10px;color:var(--text3);margin-top:2px">
              Línea 1: {{ previa.line1.length }} chars &nbsp;·&nbsp; Línea 2: {{ previa.line2.length }} chars &nbsp;·&nbsp; Requerido: 205 chars
              <span v-if="previa.line1.length !== 205 || previa.line2.length !== 205" style="color:var(--danger);font-weight:600;margin-left:6px">⚠ Longitud incorrecta</span>
              <span v-else style="color:var(--success);font-weight:600;margin-left:6px">✓ Longitud correcta</span>
            </div>
          </div>
        </div>

        <EditorPanel v-if="datosManifiesto && blActual" ref="editorRef"
          @vista-previa="verTxt" @crear-cliente="abrirCrearCliente" @editar-cliente="abrirEditarCliente"/>

        <div v-else-if="datosManifiesto" class="empty-state">
          <i class="ti ti-packages"></i><p>Este manifiesto no tiene B/L</p>
        </div>

        <div v-else class="empty-state">
          <i class="ti ti-ship"></i>
          <p style="font-size:15px;color:var(--text2)">Selecciona un manifiesto</p>
          <p style="font-size:12px">o carga un XML o PDF de la DGA</p>
          <div class="drop-zone" :class="{ drag: arrastrando }" @click="abrirSubida"
               @dragover.prevent="arrastrando = true" @dragleave="arrastrando = false" @drop.prevent="soltar">
            <i class="ti ti-file-upload" style="font-size:28px;display:block;margin-bottom:8px"></i>
            Arrastra el XML o PDF aquí o haz clic para seleccionar
          </div>
        </div>
      </div>

      <div class="statusbar">
        <span id="status-msg">{{ estado }}</span>
        <span id="status-right">{{ estadoDerecha }}</span>
      </div>
    </div>
  </div>

  <!-- Modal genérico -->
  <div v-if="modal" class="modal-overlay" @click.self="cerrarModal">
    <div class="modal">
      <h3><i class="ti ti-alert-triangle"></i> {{ modal.titulo }}</h3>
      <div style="font-size:13px;line-height:1.6" v-html="modal.cuerpo"></div>
      <div class="modal-actions">
        <button v-for="(b, i) in modal.botones" :key="i" class="btn" :class="b.cls" @click="b.accion">{{ b.label }}</button>
      </div>
    </div>
  </div>

  <!-- Modal de consignatario -->
  <div v-if="cliente" class="modal-overlay" @click.self="cliente = null">
    <div class="modal">
      <h3><i class="ti ti-alert-triangle"></i> {{ cliente.id !== null ? 'Editar consignatario' : 'Nuevo consignatario — Hacienda PR' }}</h3>
      <div style="font-size:13px;line-height:1.6">
        <div style="display:flex;flex-direction:column;gap:10px">
          <div class="field">
            <label>Nombre / Razón social <span style="color:var(--danger)">*</span></label>
            <input v-model="cliente.name" placeholder="Ej. LANCO MANUFACTURING CORP"/>
          </div>
          <div class="fg fg2">
            <div class="field">
              <label>SS / EIN (9 dígitos) <span style="color:var(--danger)">*</span></label>
              <input v-model="cliente.ss" placeholder="660123456" maxlength="11"
                     @input="cliente.ss = cliente.ss.replace(/[^0-9-]/g,'')"/>
              <div class="hint">
                <span v-if="ssDigitos.length === 9" style="color:var(--success)">✓ 9 dígitos — formato correcto</span>
                <span v-else-if="ssDigitos.length" style="color:var(--warn)">{{ ssDigitos.length }}/9 dígitos</span>
              </div>
            </div>
            <div class="field">
              <label>IVU / No. comerciante</label>
              <input v-model="cliente.ivu" placeholder="Opcional"/>
            </div>
          </div>
          <div class="field"><label>Dirección línea 1</label><input v-model="cliente.add1" placeholder="Ej. URB. APONTE #5"/></div>
          <div class="field"><label>Dirección línea 2</label><input v-model="cliente.add2" placeholder="Ej. SAN LORENZO, PR 00754"/></div>
          <div class="field"><label>Teléfono</label><input v-model="cliente.phone1" placeholder="787-000-0000"/></div>
          <div v-if="clienteError" style="color:var(--danger);font-size:12px">{{ clienteError }}</div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn" @click="cliente = null">Cancelar</button>
        <button class="btn accent" @click="guardarCliente">{{ cliente.id !== null ? 'Guardar cambios' : 'Guardar consignatario' }}</button>
      </div>
    </div>
  </div>

  <div id="toast" :class="toastMsg ? ['show', toastTipo] : []">{{ toastMsg ? (toastTipo === 'ok' ? '✓  ' : '⚠  ') + toastMsg : '' }}</div>
</template>
