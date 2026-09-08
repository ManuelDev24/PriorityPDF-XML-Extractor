<script setup lang="ts">
// Misma lógica que frontend-src/editor/App.vue (store.ts sin tocar). Cambia
// la presentación: Dialog de shadcn para los modales, toast propio con las
// clases del sistema de diseño.
import { ref, computed, watch, onMounted } from 'vue';
import { api, type Cliente, type VistaPreviaTxt, type DatosSiscommateVivo } from '../editor/api';
import {
  datosManifiesto, blActual, stats, estado, estadoDerecha, toastMsg, toastTipo,
  cargarCatalogos, cargarManifiestos, seleccionarManifiesto, cargarStats,
  guardarPendientes, toast, setEstado, restaurarSeleccion,
} from '../editor/store';
import Sidebar from './Sidebar.vue';
import EditorPanel from './EditorPanel.vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Upload, Settings, Ship, Eye, FileOutput, DatabaseZap, Database, Loader2, FileUp, X, PanelLeftClose, PanelLeftOpen } from '@lucide/vue';

const bridgeOnline = ref(false);
const archivoInput = ref<HTMLInputElement | null>(null);
const arrastrando = ref(false);
const editorRef = ref<InstanceType<typeof EditorPanel> | null>(null);

// Sidebar colapsable: se recuerda entre recargas (misma idea que un IDE).
const SIDEBAR_KEY = 'priority-sidebar-abierto';
const sidebarAbierto = ref(localStorage.getItem(SIDEBAR_KEY) !== '0');
function alternarSidebar() {
  sidebarAbierto.value = !sidebarAbierto.value;
  localStorage.setItem(SIDEBAR_KEY, sidebarAbierto.value ? '1' : '0');
}

const modal = ref<{ titulo: string; cuerpo: string; botones: Array<{ label: string; variant: string; accion: () => void }> } | null>(null);
function cerrarModal() { modal.value = null; }
function confirmar(titulo: string, cuerpo: string, accion: () => void) {
  modal.value = { titulo, cuerpo, botones: [
    { label: 'Cancelar', variant: 'outline', accion: cerrarModal },
    { label: titulo.includes('B/L') ? 'Eliminar B/L' : 'Eliminar', variant: 'destructive', accion: () => { cerrarModal(); accion(); } },
  ] };
}
function avisar(titulo: string, cuerpo: string) {
  modal.value = { titulo, cuerpo, botones: [{ label: 'Entendido', variant: 'default', accion: cerrarModal }] };
}

const cliente = ref<{ id: number | null; name: string; ss: string; ivu: string; add1: string; add2: string; phone1: string } | null>(null);
const clienteError = ref('');
const ssDigitos = computed(() => (cliente.value?.ss || '').replace(/[^0-9]/g, ''));

function abrirCrearCliente(prefill: string) {
  const digitos = prefill.replace(/[^0-9]/g, '');
  cliente.value = { id: null, name: digitos.length >= 9 ? '' : prefill, ss: digitos.length >= 9 ? digitos.substring(0, 9) : '', ivu: '', add1: '', add2: '', phone1: '' };
  clienteError.value = '';
}
async function abrirEditarCliente(id: number, ss: string, nombre: string) {
  let c: Partial<Cliente> = { id, ss, name: nombre };
  try { c = (await api.buscarClientes(ss)).find(x => x.id === id || x.ss === ss) ?? c; } catch { /* usar lo que se sabe */ }
  cliente.value = { id: c.id ?? id, name: c.name ?? '', ss: c.ss ?? '', ivu: c.ivu ?? '', add1: c.add1 ?? '', add2: c.add2 ?? '', phone1: c.phone1 ?? '' };
  clienteError.value = '';
}
async function guardarCliente() {
  const c = cliente.value;
  if (!c) return;
  const ss = ssDigitos.value.substring(0, 9);
  if (!c.name.trim()) { clienteError.value = 'El nombre es requerido'; return; }
  if (ss.length < 9) { clienteError.value = 'El SS/EIN debe tener exactamente 9 dígitos'; return; }
  try {
    const datos = { name: c.name.trim(), ss, ivu: c.ivu, add1: c.add1, add2: c.add2, phone1: c.phone1 };
    const r = c.id !== null ? await api.actualizarCliente(c.id, datos) : await api.crearCliente(datos);
    cliente.value = null;
    toast(c.id !== null ? 'Consignatario actualizado' : `Consignatario "${r.client.name}" creado`);
    editorRef.value?.aplicarCliente(r.client);
  } catch (e) {
    let msg = (e as Error).message;
    try { msg = JSON.parse(msg).error; } catch { /* texto plano */ }
    clienteError.value = msg;
  }
}

const previa = ref<VistaPreviaTxt | null>(null);
const regla = '1'.repeat(205);
async function verTxt(blId: number) {
  try { previa.value = await api.vistaPreviaTxt(blId); } catch { toast('Error en vista previa', 'err'); }
}
// Sin esto, cambiar de B/L (desde el buscador del sidebar o la lista) dejaba
// la vista previa vieja en pantalla — mismo título "Vista previa TXT — B/L
// X" pero con las líneas del B/L anterior, porque nada volvía a pedir el
// preview ni lo limpiaba al cambiar de B/L activo.
watch(() => blActual.value?.id, () => { previa.value = null; });

async function revisarBridge() { try { bridgeOnline.value = (await api.estadoBridge()).online; } catch { bridgeOnline.value = false; } }
function abrirSubida() { archivoInput.value?.click(); }

async function subir(archivo: File | undefined) {
  if (!archivo) return;
  setEstado('Cargando manifiesto...');
  const fd = new FormData(); fd.append('xml', archivo);
  try {
    const r = await fetch('/api/manifests/upload', { method: 'POST', body: fd });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error);
    toast(`Manifiesto cargado: ${data.bl_count} B/L`);
    await cargarManifiestos();
    await seleccionarManifiesto(data.manifest_id);
  } catch (e) { toast('Error: ' + (e as Error).message, 'err'); setEstado('Error cargando manifiesto'); }
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
  await guardarPendientes();
  if (!m.manifest_no) { toast('Ingresa el número de manifiesto Hacienda antes de exportar', 'err'); return; }
  if (!m.docking_number || !/^\d+$/.test(m.docking_number)) { toast('El Docking Number es obligatorio y debe ser numérico', 'err'); return; }
  try {
    const r = await fetch(`/api/manifests/${m.id}/export-txt`);
    if (!r.ok) {
      const err = await r.json();
      avisar('No se puede exportar', `Corrija los siguientes problemas antes de exportar:<ul class="mt-2 ml-4 list-disc text-sm">${String(err.error).split(' | ').map((x: string) => `<li>${x}</li>`).join('')}</ul>`);
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${m.manifest_no || m.voyage_no}_HACIENDA.TXT`; a.click();
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
    avisar('Bridge offline', 'SiscommateBridge.exe no está corriendo en el servidor. Ve a la carpeta <code>bridge/</code> en el servidor y ejecuta <code>iniciar_manual.bat</code>.');
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
    avisar('No se puede guardar en SISCOMMATE', `Corrija los siguientes problemas:<ul class="mt-2 ml-4 list-disc text-sm">${String(msg).split(' | ').map(x => `<li>${x}</li>`).join('')}</ul>`);
    setEstado('Error al guardar en SISCOMMATE');
  }
  enviando.value = false;
}

const viendoVivo = ref(false);
const vivo = ref<DatosSiscommateVivo | null>(null);
async function verSiscommateVivo() {
  const m = datosManifiesto.value?.manifest;
  if (!m) return;
  viendoVivo.value = true;
  try {
    vivo.value = await api.siscommateVivo(m.id);
  } catch (e) {
    let msg = (e as Error).message;
    try { msg = JSON.parse(msg).error || msg; } catch { /* texto plano */ }
    avisar('No se pudo consultar SISCOMMATE', msg);
  }
  viendoVivo.value = false;
}

onMounted(async () => {
  revisarBridge();
  setInterval(revisarBridge, 30000);
  await cargarCatalogos();
  await cargarManifiestos();
  await restaurarSeleccion();
});
</script>

<template>
  <div class="flex h-screen flex-col">
    <!-- TOPBAR -->
    <header class="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-paper-raised px-4">
      <Button variant="ghost" size="icon" class="size-7 shrink-0" :title="sidebarAbierto ? 'Ocultar panel de viajes' : 'Mostrar panel de viajes'" @click="alternarSidebar">
        <PanelLeftClose v-if="sidebarAbierto" class="size-4" />
        <PanelLeftOpen v-else class="size-4" />
      </Button>
      <div class="h-4 w-px shrink-0 bg-border"></div>
      <span class="text-sm font-semibold text-accent">Priority Global</span>
      <span class="text-xs text-ink-faint">Manifiestos DGA → Hacienda PR</span>
      <span
        class="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium"
        :class="bridgeOnline ? 'border-status-validated/40 bg-status-validated-soft text-status-validated' : 'border-danger/40 bg-danger-soft text-danger'"
      >
        <span class="size-1.5 rounded-full bg-current" />
        {{ bridgeOnline ? 'Bridge activo' : 'Bridge offline' }}
      </span>
      <div class="flex-1"></div>
      <div class="hidden items-center gap-2 rounded-lg border border-border bg-paper px-3 py-1.5 text-xs text-ink-muted sm:flex">
        <span><b class="text-ink">{{ stats.manifests }}</b> viajes</span>
        <span class="text-ink-faint">·</span>
        <span><b class="text-ink">{{ stats.bls }}</b> B/L</span>
        <span class="text-ink-faint">·</span>
        <span class="font-medium text-status-pending"><b>{{ stats.pending }}</b> pendientes</span>
      </div>
      <Button variant="outline" size="sm" as-child><a href="/admin.html" target="_blank"><Settings class="size-3.5" />Admin</a></Button>
      <Button size="sm" @click="abrirSubida"><Upload class="size-3.5" />Cargar XML/PDF</Button>
      <input type="file" ref="archivoInput" accept=".xml,.pdf" class="hidden" @change="subir(($event.target as HTMLInputElement).files?.[0])" />
    </header>

    <div class="flex flex-1 overflow-hidden">
      <Sidebar :abierto="sidebarAbierto" @confirmar="confirmar" />

      <main class="flex flex-1 flex-col overflow-hidden">
        <div v-if="datosManifiesto" class="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-paper-raised px-4">
          <Ship class="size-4 text-accent" />
          <span class="text-sm font-medium">Viaje {{ datosManifiesto.manifest.voyage_no }}</span>
          <span class="text-xs text-ink-faint">{{ datosManifiesto.manifest.vessel_name || '' }}</span>
          <div class="flex-1"></div>
          <Button variant="outline" size="sm" :disabled="!blActual" @click="blActual && verTxt(blActual.id)"><Eye class="size-3.5" />Ver TXT</Button>
          <Button size="sm" @click="exportarTxt"><FileOutput class="size-3.5" />Exportar TXT</Button>
          <Button size="sm" variant="outline" class="border-status-siscommate text-status-siscommate hover:bg-status-siscommate-soft hover:text-status-siscommate" :disabled="enviando" @click="pushSiscommate">
            <Loader2 v-if="enviando" class="size-3.5 animate-spin" /><DatabaseZap v-else class="size-3.5" />
            {{ enviando ? 'Guardando...' : 'Guardar en SISCOMMATE' }}
          </Button>
          <Button variant="outline" size="sm" :disabled="viendoVivo" @click="verSiscommateVivo">
            <Loader2 v-if="viendoVivo" class="size-3.5 animate-spin" /><Database v-else class="size-3.5" />
            Ver en SISCOMMATE
          </Button>
        </div>

        <!-- Ancho máximo centrado (mismo criterio que admin-redesign): en
             pantallas grandes las tarjetas del grid de 12 columnas no se
             estiran a más de max-w-5xl, para que sigan siendo fáciles de
             escanear en vez de ocupar todo el monitor. -->
        <div class="flex-1 overflow-y-auto p-4">
          <div class="mx-auto flex h-full w-full max-w-5xl flex-col gap-4">
          <!-- shrink-0: sin esto, este es el único hijo directo de un
               flex-col con overflow-hidden dentro de un contenedor h-full —
               cuando el contenido total (este + EditorPanel) supera la altura
               disponible, flexbox fuerza TODO el achique a este div (por ser
               el único con overflow-hidden, su min-height automático cuenta
               como 0) y lo deja en ~4px, aunque su contenido siga intacto en
               el DOM. shrink-0 lo saca de ese cálculo. -->
          <div v-if="previa" class="shrink-0 overflow-hidden rounded-lg border-2 border-accent">
            <div class="flex items-center gap-2 bg-accent-soft px-3 py-2 text-sm font-medium text-accent">
              Vista previa TXT — B/L {{ blActual?.bl_no || '' }}
              <Button variant="ghost" size="icon" class="ml-auto size-6" @click="previa = null"><X class="size-3.5" /></Button>
            </div>
            <div class="bg-ink p-3 font-mono text-xs">
              <template v-for="(p, i) in previa.pairs" :key="i">
                <p v-if="previa.pairs.length > 1" class="mb-0.5 text-ink-faint">Contenedor {{ i + 1 }}: {{ p.containerNo }}</p>
                <pre class="overflow-x-auto whitespace-pre leading-relaxed text-status-validated">{{ p.line1 }}
{{ p.line2 }}</pre>
                <div class="h-2"></div>
              </template>
              <p class="mt-1 text-ink-faint">
                Línea 1: {{ previa.line1.length }} chars · Línea 2: {{ previa.line2.length }} chars · Requerido: 205
                <span v-if="previa.line1.length !== 205 || previa.line2.length !== 205" class="font-semibold text-danger">⚠ Longitud incorrecta</span>
                <span v-else class="font-semibold text-status-validated">✓ Longitud correcta</span>
              </p>
            </div>
          </div>

          <EditorPanel v-if="datosManifiesto && blActual" ref="editorRef" @vista-previa="verTxt" @crear-cliente="abrirCrearCliente" @editar-cliente="abrirEditarCliente" />

          <div v-else-if="datosManifiesto" class="flex h-full flex-col items-center justify-center gap-2 text-ink-faint">
            <p>{{ datosManifiesto.bls.length ? 'Selecciona un B/L' : 'Este manifiesto no tiene B/L' }}</p>
          </div>

          <div v-else class="flex flex-1 w-full flex-col items-center justify-center gap-3 text-center text-ink-faint">
            <Ship class="size-10" />
            <p class="text-base text-ink-muted">Selecciona un manifiesto</p>
            <p class="text-xs">o carga un XML o PDF de la DGA</p>
            <div
              class="max-w-md cursor-pointer rounded-lg border-2 border-dashed p-7 text-center text-sm transition-colors"
              :class="arrastrando ? 'border-accent bg-accent-soft text-accent' : 'border-border hover:border-accent hover:bg-accent-soft hover:text-accent'"
              @click="abrirSubida" @dragover.prevent="arrastrando = true" @dragleave="arrastrando = false" @drop.prevent="soltar"
            >
              <FileUp class="mx-auto mb-2 size-6" />
              Arrastra el XML o PDF aquí o haz clic para seleccionar
            </div>
          </div>
          </div>
        </div>

        <div class="flex h-6 shrink-0 items-center justify-between border-t border-border bg-paper-raised px-4 text-xs text-ink-faint">
          <span>{{ estado }}</span><span>{{ estadoDerecha }}</span>
        </div>
      </main>
    </div>

    <Dialog :open="!!modal" @update:open="(v) => !v && cerrarModal()">
      <DialogContent v-if="modal">
        <DialogHeader><DialogTitle>{{ modal.titulo }}</DialogTitle></DialogHeader>
        <div class="text-sm text-ink-muted" v-html="modal.cuerpo"></div>
        <DialogFooter>
          <Button v-for="(b, i) in modal.botones" :key="i" :variant="(b.variant as any)" @click="b.accion">{{ b.label }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!vivo" @update:open="(v) => !v && (vivo = null)">
      <DialogContent v-if="vivo" class="max-w-2xl">
        <DialogHeader><DialogTitle>Lo que hay en SISCOMMATE — Viaje {{ datosManifiesto?.manifest.voyage_no }}</DialogTitle></DialogHeader>
        <p v-if="!vivo.encontrado" class="text-sm text-ink-faint">No se encontró ningún manifiesto con este número de viaje en las tablas de SISCOMMATE.</p>
        <div v-else class="flex max-h-[70vh] flex-col gap-4 overflow-y-auto text-xs">
          <div>
            <p class="mb-1 font-medium text-ink-muted">Manifiesto (MANIFEST)</p>
            <div class="grid grid-cols-2 gap-x-4 gap-y-0.5 rounded border border-border p-2 font-mono">
              <template v-for="(val, key) in (vivo.manifest || {})" :key="key">
                <span class="text-ink-faint">{{ key }}</span><span class="truncate">{{ val === null || val === '' ? '—' : String(val) }}</span>
              </template>
            </div>
          </div>
          <div>
            <p class="mb-1 font-medium text-ink-muted">B/L — BOL ({{ vivo.bls.length }})</p>
            <p v-if="!vivo.bls.length" class="text-ink-faint">Sin B/L registrados.</p>
            <div v-else class="overflow-x-auto rounded border border-border">
              <table class="w-full border-collapse font-mono">
                <thead><tr class="border-b border-border bg-paper-raised text-left text-ink-faint">
                  <th v-for="k in Object.keys(vivo.bls[0])" :key="k" class="px-2 py-1 whitespace-nowrap">{{ k }}</th>
                </tr></thead>
                <tbody>
                  <tr v-for="(bl, i) in vivo.bls" :key="i" class="border-b border-border/50 last:border-0">
                    <td v-for="k in Object.keys(vivo.bls[0])" :key="k" class="px-2 py-1 whitespace-nowrap">{{ (bl as any)[k] === null || (bl as any)[k] === '' ? '—' : String((bl as any)[k]) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <p class="mb-1 font-medium text-ink-muted">Contenedores (BOLCONT) ({{ vivo.containers.length }})</p>
            <p v-if="!vivo.containers.length" class="text-ink-faint">Sin contenedores registrados.</p>
            <div v-else class="overflow-x-auto rounded border border-border">
              <table class="w-full border-collapse font-mono">
                <thead><tr class="border-b border-border bg-paper-raised text-left text-ink-faint">
                  <th v-for="k in Object.keys(vivo.containers[0])" :key="k" class="px-2 py-1 whitespace-nowrap">{{ k }}</th>
                </tr></thead>
                <tbody>
                  <tr v-for="(c, i) in vivo.containers" :key="i" class="border-b border-border/50 last:border-0">
                    <td v-for="k in Object.keys(vivo.containers[0])" :key="k" class="px-2 py-1 whitespace-nowrap">{{ (c as any)[k] === null || (c as any)[k] === '' ? '—' : String((c as any)[k]) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <p class="mb-1 font-medium text-ink-muted">Items de carga (BOLITEM) ({{ vivo.items.length }})</p>
            <p v-if="!vivo.items.length" class="text-ink-faint">Sin items registrados.</p>
            <div v-else class="overflow-x-auto rounded border border-border">
              <table class="w-full border-collapse font-mono">
                <thead><tr class="border-b border-border bg-paper-raised text-left text-ink-faint">
                  <th v-for="k in Object.keys(vivo.items[0])" :key="k" class="px-2 py-1 whitespace-nowrap">{{ k }}</th>
                </tr></thead>
                <tbody>
                  <tr v-for="(it, i) in vivo.items" :key="i" class="border-b border-border/50 last:border-0">
                    <td v-for="k in Object.keys(vivo.items[0])" :key="k" class="px-2 py-1 whitespace-nowrap">{{ (it as any)[k] === null || (it as any)[k] === '' ? '—' : String((it as any)[k]) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <DialogFooter><Button variant="outline" @click="vivo = null">Cerrar</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!cliente" @update:open="(v) => !v && (cliente = null)">
      <DialogContent v-if="cliente">
        <DialogHeader><DialogTitle>{{ cliente.id !== null ? 'Editar consignatario' : 'Nuevo consignatario — Hacienda PR' }}</DialogTitle></DialogHeader>
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1"><Label class="text-xs">Nombre / Razón social <span class="text-danger">*</span></Label><Input v-model="cliente.name" placeholder="Ej. LANCO MANUFACTURING CORP" /></div>
          <div class="grid grid-cols-2 gap-3">
            <div class="flex flex-col gap-1">
              <Label class="text-xs">SS / EIN (9 dígitos) <span class="text-danger">*</span></Label>
              <Input v-model="cliente.ss" placeholder="660123456" maxlength="11" class="font-mono" @input="cliente.ss = cliente.ss.replace(/[^0-9-]/g,'')" />
              <p class="text-xs" :class="ssDigitos.length === 9 ? 'text-status-validated' : 'text-status-pending'">
                <template v-if="ssDigitos.length === 9">✓ 9 dígitos — formato correcto</template>
                <template v-else-if="ssDigitos.length">{{ ssDigitos.length }}/9 dígitos</template>
              </p>
            </div>
            <div class="flex flex-col gap-1"><Label class="text-xs">IVU / No. comerciante</Label><Input v-model="cliente.ivu" placeholder="Opcional" class="font-mono" /></div>
          </div>
          <div class="flex flex-col gap-1"><Label class="text-xs">Dirección línea 1</Label><Input v-model="cliente.add1" placeholder="Ej. URB. APONTE #5" /></div>
          <div class="flex flex-col gap-1"><Label class="text-xs">Dirección línea 2</Label><Input v-model="cliente.add2" placeholder="Ej. SAN LORENZO, PR 00754" /></div>
          <div class="flex flex-col gap-1"><Label class="text-xs">Teléfono</Label><Input v-model="cliente.phone1" placeholder="787-000-0000" class="font-mono" /></div>
          <p v-if="clienteError" class="text-xs text-danger">{{ clienteError }}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="cliente = null">Cancelar</Button>
          <Button @click="guardarCliente">{{ cliente.id !== null ? 'Guardar cambios' : 'Guardar consignatario' }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <div v-if="toastMsg" class="fixed bottom-5 right-5 rounded-md px-4 py-2.5 text-sm shadow-lg" :class="toastTipo === 'ok' ? 'bg-ink text-status-validated-soft' : 'bg-danger text-white'">
      {{ toastTipo === 'ok' ? '✓ ' : '⚠ ' }}{{ toastMsg }}
    </div>
  </div>
</template>
