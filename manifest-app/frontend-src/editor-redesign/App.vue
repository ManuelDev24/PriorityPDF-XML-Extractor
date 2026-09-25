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
  manifiestosEliminadosSiscommate,
} from '../editor/store';
import Sidebar from './Sidebar.vue';
import EditorPanel from './EditorPanel.vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Upload, Settings, Ship, Eye, FileOutput, DatabaseZap, Database, Loader2, FileUp, X, PanelLeftClose, PanelLeftOpen, Check, RefreshCw } from '@lucide/vue';

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

const modal = ref<{
  titulo: string; cuerpo: string; botones: Array<{ label: string; variant: string; accion: () => void }>;
  // Solo lo usa el modal "Confirmar carga" cuando hay B/L en otro viaje —
  // ver subir(). No se mete en el sistema genérico de modales para todo lo
  // demás, que no necesita esto.
  enOtroViaje?: Array<{ id: number; bl_no: string; voyage_no: string }>;
  // Solo lo usa el modal "Cargar como viaje nuevo" — ver pedirVoyageNuevo().
  pedirTexto?: boolean;
} | null>(null);
// Nombre que el operador escribe para el viaje nuevo cuando el archivo trae
// un VoyageNo que ya existe pero, a diferencia del caso normal (mismo viaje,
// B/L nuevos), en realidad es un manifiesto operativamente distinto — caso
// real: dos XML de la DGA para "CF371" y "CF371TB", mismo viaje físico pero
// booking distinto, que antes se unificaban sin poder evitarlo.
const nuevoVoyageNo = ref('');
// true por defecto: es lo que se pidió — que esos B/L se puedan mover al
// viaje nuevo en el mismo paso de carga, en vez de tener que hacerlo a mano
// después. El operador puede destildarlo si de verdad quiere dejarlos donde
// están (por ejemplo, si de verdad pertenecen a ese otro viaje).
const moverEnOtroViaje = ref(true);
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
// Qué input(s) marcar en rojo además del texto de error — antes solo se veía
// el mensaje abajo, sin señalar cuál campo exactamente estaba vacío/mal.
const clienteCamposError = ref<Set<'name' | 'ss'>>(new Set());
const ssDigitos = computed(() => (cliente.value?.ss || '').replace(/[^0-9]/g, ''));

function abrirCrearCliente(prefill: string) {
  const digitos = prefill.replace(/[^0-9]/g, '');
  cliente.value = { id: null, name: digitos.length >= 9 ? '' : prefill, ss: digitos.length >= 9 ? digitos.substring(0, 9) : '', ivu: '', add1: '', add2: '', phone1: '' };
  clienteError.value = '';
  clienteCamposError.value = new Set();
}
async function abrirEditarCliente(id: number, ss: string, nombre: string) {
  let c: Partial<Cliente> = { id, ss, name: nombre };
  try { c = (await api.buscarClientes(ss)).find(x => x.id === id || x.ss === ss) ?? c; } catch { /* usar lo que se sabe */ }
  cliente.value = { id: c.id ?? id, name: c.name ?? '', ss: c.ss ?? '', ivu: c.ivu ?? '', add1: c.add1 ?? '', add2: c.add2 ?? '', phone1: c.phone1 ?? '' };
  clienteError.value = '';
  clienteCamposError.value = new Set();
}
async function guardarCliente() {
  const c = cliente.value;
  if (!c) return;
  const ss = ssDigitos.value.substring(0, 9);
  if (!c.name.trim()) { clienteError.value = 'El nombre es requerido'; clienteCamposError.value = new Set(['name']); return; }
  if (ss.length < 9) { clienteError.value = 'El SS/EIN debe tener exactamente 9 dígitos'; clienteCamposError.value = new Set(['ss']); return; }
  clienteCamposError.value = new Set();
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
  try {
    const resultado = await api.vistaPreviaTxt(blId);
    // Si el usuario ya saltó a otro B/L mientras esta petición estaba en
    // vuelo, aplicarla igual pisaba la vista previa recién limpiada con
    // datos de un B/L que ya no es el activo — se descarta la respuesta
    // tardía en vez de mostrarla.
    if (blActual.value?.id === blId) previa.value = resultado;
  } catch { toast('Error en vista previa', 'err'); }
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
  setEstado('Revisando manifiesto...');
  const fd = new FormData(); fd.append('xml', archivo);
  try {
    // Primero una vista previa (no escribe nada): cuenta cuántos B/L son
    // nuevos, cuántos ya están en este mismo viaje (no se tocan al recargar
    // el mismo PDF) y cuántos están en OTRO viaje porque el usuario los
    // movió ahí ("mover B/L") — esos tampoco se reinsertan aquí.
    const rp = await fetch('/api/manifests/upload/preview', { method: 'POST', body: fd });
    const preview = await rp.json();
    if (!rp.ok) throw new Error(preview.error);

    const partes: string[] = [];
    if (preview.existe_viaje) {
      partes.push(preview.nuevos_count
        ? `Se agregarán <strong>${preview.nuevos_count}</strong> B/L nuevos al viaje <strong>${preview.voyage_no}</strong>.`
        : `El viaje <strong>${preview.voyage_no}</strong> ya tiene todos los B/L de este archivo — no se agregará nada.`);
      if (preview.ya_en_este_viaje_count) {
        partes.push(`${preview.ya_en_este_viaje_count} B/L de este archivo ya estaban en el viaje y no se tocan.`);
      }
    } else {
      partes.push(`Se creará el viaje <strong>${preview.voyage_no}</strong> con <strong>${preview.nuevos_count}</strong> B/L.`);
    }
    if (preview.en_otro_viaje?.length) {
      const lista = preview.en_otro_viaje.map((m: { bl_no: string; voyage_no: string }) => `${m.bl_no} → ${m.voyage_no}`).join(', ');
      partes.push(`<span class="text-status-pending">${preview.en_otro_viaje.length} B/L de este archivo ya están en otro viaje: ${lista}. Podés elegir moverlos aquí abajo.</span>`);
    }
    // Advertencias del parser (peso que no cuadra, contenedores reconectados
    // a mano por celda fusionada, B/L sin contenedor) — se muestran ANTES de
    // cargar para que se puedan revisar a mano si algo se ve raro, en vez de
    // notarlo días después como pasó con CF365.
    if (preview.warnings?.length) {
      const avisos = preview.warnings.map((w: string) => `<li>${w}</li>`).join('');
      partes.push(`<div class="mt-2 rounded border border-status-pending/40 bg-status-pending/10 p-2 text-status-pending"><strong>Revisar antes de continuar:</strong><ul class="ml-4 list-disc">${avisos}</ul></div>`);
    }

    const cargarConFormData = async (mensajeExito: (data: any) => string) => {
      cerrarModal();
      setEstado('Cargando manifiesto...');
      try {
        const r = await fetch('/api/manifests/upload', { method: 'POST', body: fd });
        const data = await r.json();
        if (!data.ok) throw new Error(data.error);
        toast(mensajeExito(data));
        await cargarManifiestos();
        await seleccionarManifiesto(data.manifest_id);
      } catch (e) { toast('Error: ' + (e as Error).message, 'err'); setEstado('Error cargando manifiesto'); }
      if (archivoInput.value) archivoInput.value.value = '';
    };

    const ejecutarCarga = () => {
      const moverEstos = moverEnOtroViaje.value ? (modal.value?.enOtroViaje ?? []) : [];
      // El mover va en la MISMA petición de carga (mover_ids), no en una
      // llamada aparte después — así el backend calcula su posición real
      // dentro de este documento (sort_seq) igual que a los B/L insertados
      // de cero. Antes, moverlos con una llamada separada conservaba su id
      // viejo (de cuando se insertaron por primera vez, casi siempre mucho
      // más bajo) y por eso siempre saltaban al principio de la lista en
      // vez de quedar en su posición real del PDF.
      if (moverEstos.length) fd.set('mover_ids', JSON.stringify(moverEstos.map(m => m.id)));
      return cargarConFormData(data => {
        let mensaje = data.mensaje || `Manifiesto cargado: ${data.bl_count} B/L`;
        if (data.movidos?.length) mensaje += ` · ${data.movidos.length} B/L movidos aquí desde su viaje anterior`;
        if (data.omitidos?.length) mensaje += ` · ${data.omitidos.length} no se pudieron mover: ${data.omitidos.map((o: { motivo: string }) => o.motivo).join('; ')}`;
        return mensaje;
      });
    };

    // Dos archivos distintos (típicamente dos XML de la DGA) pueden traer el
    // MISMO VoyageNo en su propio encabezado sin ser, operativamente, el
    // mismo manifiesto — ej. "CF371" y "CF371TB" para el mismo buque/viaje
    // físico pero booking distinto. Antes no había forma de evitar que se
    // unificaran bajo un solo viaje; acá el operador puede pedir que este
    // archivo se cargue como un viaje separado, con el nombre que él elija.
    const pedirVoyageNuevo = () => {
      nuevoVoyageNo.value = '';
      modal.value = {
        titulo: 'Cargar como viaje nuevo',
        cuerpo: `Este archivo trae el viaje <strong>${preview.voyage_no}</strong>, que ya existe. ` +
          `Escribe un nombre distinto para cargarlo como un viaje aparte (sus B/L no se van a mezclar con el viaje <strong>${preview.voyage_no}</strong> existente).`,
        pedirTexto: true,
        botones: [
          { label: 'Cancelar', variant: 'outline', accion: () => { cerrarModal(); if (archivoInput.value) archivoInput.value.value = ''; } },
          { label: 'Crear viaje', variant: 'default', accion: () => {
            const nombre = nuevoVoyageNo.value.trim();
            if (!nombre) { toast('Escribe un nombre para el viaje nuevo', 'err'); return; }
            fd.set('voyage_no_override', nombre);
            cargarConFormData(data => data.mensaje || `Viaje "${nombre}" creado con ${data.bl_count} B/L`);
          } },
        ],
      };
    };

    if (!preview.nuevos_count) {
      // Nada que agregar: un solo botón informativo, no hace falta
      // confirmar una carga que no va a insertar nada.
      modal.value = { titulo: 'Nada nuevo que cargar', cuerpo: partes.join(' '),
        botones: [{ label: 'Entendido', variant: 'default', accion: () => { cerrarModal(); if (archivoInput.value) archivoInput.value.value = ''; } }] };
      setEstado('Listo');
      return;
    }
    moverEnOtroViaje.value = true;
    modal.value = {
      titulo: 'Confirmar carga', cuerpo: partes.join(' '),
      enOtroViaje: preview.en_otro_viaje,
      botones: [
        { label: 'Cancelar', variant: 'outline', accion: () => { cerrarModal(); if (archivoInput.value) archivoInput.value.value = ''; } },
        ...(preview.existe_viaje ? [{ label: 'Cargar como viaje nuevo', variant: 'outline', accion: pedirVoyageNuevo }] : []),
        { label: `Cargar ${preview.nuevos_count} B/L`, variant: 'default', accion: ejecutarCarga },
      ],
    };
    setEstado('Listo');
  } catch (e) { toast('Error: ' + (e as Error).message, 'err'); setEstado('Error cargando manifiesto'); if (archivoInput.value) archivoInput.value.value = ''; }
}

// Caso real: un manifiesto de un viaje a islas (AU/CF) puede venir partido
// en varios PDF (el sistema de origen no genera uno solo) — todos con el
// MISMO VoyageNo, así que el flujo normal de "reimportar el mismo viaje, se
// suman los B/L nuevos" (ver subir()) ya los mezcla bien uno por uno. Esto
// solo evita tener que confirmar el modal 5 veces: junta la vista previa de
// TODOS los archivos en un solo resumen y, al confirmar, los sube uno por
// uno en orden (no en paralelo — el segundo archivo necesita ver en la base
// el viaje que creó el primero para sumarse ahí en vez de crear uno nuevo).
// A propósito NO ofrece "mover B/L de otro viaje" ni "cargar como viaje
// nuevo" acá: son decisiones para un archivo a la vez, y agruparlas para N
// archivos heterogéneos complicaría el resumen sin un caso real que lo pida
// todavía — si aparece, usar la carga de un solo archivo para ese caso.
async function subirVarios(archivos: File[]) {
  if (!archivos.length) return;
  if (archivos.length === 1) { await subir(archivos[0]); return; }

  setEstado(`Revisando ${archivos.length} archivos...`);
  const previos = await Promise.all(archivos.map(async archivo => {
    try {
      const fd = new FormData(); fd.append('xml', archivo);
      const rp = await fetch('/api/manifests/upload/preview', { method: 'POST', body: fd });
      const preview = await rp.json();
      if (!rp.ok) throw new Error(preview.error);
      return { archivo, preview, error: undefined as string | undefined };
    } catch (e) { return { archivo, preview: undefined as any, error: (e as Error).message }; }
  }));

  const validos = previos.filter(p => p.preview);
  const filas = previos.map(p => p.error
    ? `<li><strong>${p.archivo.name}</strong>: <span class="text-danger">${p.error}</span></li>`
    : `<li><strong>${p.archivo.name}</strong>: ${p.preview.existe_viaje
        ? `${p.preview.nuevos_count} B/L nuevos al viaje <strong>${p.preview.voyage_no}</strong>`
        : `crea el viaje <strong>${p.preview.voyage_no}</strong> con ${p.preview.nuevos_count} B/L`}</li>`
  ).join('');
  const avisos = previos.flatMap(p => p.preview?.warnings || []);
  const cuerpo = `<ul class="ml-4 list-disc">${filas}</ul>` + (avisos.length
    ? `<div class="mt-2 rounded border border-status-pending/40 bg-status-pending/10 p-2 text-status-pending"><strong>Revisar antes de continuar:</strong><ul class="ml-4 list-disc">${avisos.map(w => `<li>${w}</li>`).join('')}</ul></div>`
    : '');

  if (!validos.length) {
    modal.value = { titulo: 'No se pudo leer ningún archivo', cuerpo,
      botones: [{ label: 'Entendido', variant: 'default', accion: () => { cerrarModal(); if (archivoInput.value) archivoInput.value.value = ''; } }] };
    setEstado('Error');
    return;
  }

  modal.value = {
    titulo: `Confirmar carga de ${validos.length} archivo${validos.length > 1 ? 's' : ''}` +
      (validos.length < previos.length ? ` (${previos.length - validos.length} con error, se omiten)` : ''),
    cuerpo,
    botones: [
      { label: 'Cancelar', variant: 'outline', accion: () => { cerrarModal(); if (archivoInput.value) archivoInput.value.value = ''; } },
      { label: `Cargar ${validos.length} archivo${validos.length > 1 ? 's' : ''}`, variant: 'default', accion: async () => {
        cerrarModal();
        let ultimoManifestId: number | null = null;
        const resultados: string[] = [];
        for (const { archivo } of validos) {
          setEstado(`Cargando ${archivo.name}...`);
          try {
            const fd = new FormData(); fd.append('xml', archivo);
            const r = await fetch('/api/manifests/upload', { method: 'POST', body: fd });
            const data = await r.json();
            if (!data.ok) throw new Error(data.error);
            resultados.push(`${archivo.name}: ${data.mensaje || `${data.bl_count} B/L`}`);
            ultimoManifestId = data.manifest_id ?? ultimoManifestId;
          } catch (e) { resultados.push(`${archivo.name}: ERROR — ${(e as Error).message}`); }
        }
        toast(resultados.join(' · '));
        await cargarManifiestos();
        if (ultimoManifestId) await seleccionarManifiesto(ultimoManifestId);
        setEstado('Listo');
        if (archivoInput.value) archivoInput.value.value = '';
      } },
    ],
  };
  setEstado('Listo');
}

function soltar(e: DragEvent) {
  arrastrando.value = false;
  const archivos = Array.from(e.dataTransfer?.files || []).filter(f => /\.(xml|pdf)$/i.test(f.name));
  if (!archivos.length) { toast('Selecciona un archivo .xml o .pdf', 'err'); return; }
  subirVarios(archivos);
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
// Check grande animado en el centro de la pantalla — confirmación visual de
// que SÍ se envió algo de verdad, más notoria que un toast que se puede
// perder de vista. Se cierra sola; también con clic o tecla Escape.
const envioExitoso = ref(false);
let envioExitosoTimer: ReturnType<typeof setTimeout> | undefined;
function mostrarEnvioExitoso() {
  envioExitoso.value = true;
  clearTimeout(envioExitosoTimer);
  envioExitosoTimer = setTimeout(() => { envioExitoso.value = false; }, 2200);
}
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
    if (r.enviados > 0) {
      mostrarEnvioExitoso();
      toast(`Guardado en SISCOMMATE — ${r.enviados} B/L nuevos, lote ${r.lote_nuevo}`);
      setEstado(`Guardado en SISCOMMATE. Lote anterior: ${r.lote_anterior} → nuevo: ${r.lote_nuevo}`);
    } else {
      // Reenvío incremental sin nada nuevo que mandar — no es un error, solo
      // no había B/L pendientes de enviar. Sin check grande: no se envió nada.
      toast(r.mensaje || 'No hay B/L nuevos que enviar');
      setEstado(r.mensaje || 'No hay B/L nuevos que enviar');
    }
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

const sincronizando = ref(false);
async function sincronizarDesdeSiscommate() {
  const m = datosManifiesto.value?.manifest;
  if (!m) { toast('Selecciona un manifiesto', 'err'); return; }
  modal.value = { titulo: 'Sincronizar desde SISCOMMATE', cuerpo:
    `Se va a traer lo que haya en SISCOMMATE ahora mismo para el viaje ${m.voyage_no} y va a `
    + 'SOBREESCRIBIR nombre, código arancelario, descripción, peso, cantidad, valor y contenedor '
    + 'de cada B/L que encuentre allá — sin mostrar qué cambió antes de aplicarlo. Cada B/L '
    + 'encontrado en SISCOMMATE queda marcado como validado. ¿Continuar?',
    botones: [
      { label: 'Cancelar', variant: 'outline', accion: cerrarModal },
      { label: 'Sincronizar', variant: 'default', accion: () => { cerrarModal(); ejecutarSincronizacion(m.id); } },
    ] };
}
async function ejecutarSincronizacion(manifestId: number) {
  sincronizando.value = true;
  setEstado('Sincronizando desde SISCOMMATE...');
  try {
    const r = await api.sincronizarDesdeSiscommate(manifestId);
    if (r.actualizados > 0) {
      mostrarEnvioExitoso();
      toast(`${r.actualizados} B/L actualizados y validados desde SISCOMMATE`);
      setEstado(`Sincronizado: ${r.actualizados} de ${r.total_en_siscommate} B/L en SISCOMMATE aplicados localmente.`);
    } else {
      toast(r.mensaje || 'No se encontró nada que sincronizar');
      setEstado(r.mensaje || 'No se encontró nada que sincronizar');
    }
    await cargarManifiestos();
    await seleccionarManifiesto(manifestId);
  } catch (e) {
    let msg = (e as Error).message;
    try { msg = JSON.parse(msg).error || msg; } catch { /* texto plano */ }
    avisar('No se pudo sincronizar desde SISCOMMATE', msg);
    setEstado('Error al sincronizar desde SISCOMMATE');
  }
  sincronizando.value = false;
}

const viendoVivo = ref(false);
const vivo = ref<DatosSiscommateVivo | null>(null);

// ── Detectar un viaje eliminado en SISCOMMATE desde su app nativa ──────────
// Caso real: ella borra un viaje en SISCOMMATE directamente (no desde
// acá) — la webapp nunca se entera sola, sigue mostrándolo como "ya
// enviado" para siempre (ver comentario en la ruta /reabrir-siscommate).
// manifiestosEliminadosSiscommate (store.ts) ya revisa TODO el sidebar en
// segundo plano al cargar la lista de viajes — este computed solo lee ese
// resultado para el viaje que está abierto ahora mismo. El watch de abajo
// vuelve a revisar puntualmente al abrir un viaje, por si el chequeo masivo
// todavía no había corrido o el bridge estaba caído en ese momento.
const siscommateEliminado = computed(() => {
  const id = datosManifiesto.value?.manifest.id;
  return id != null && manifiestosEliminadosSiscommate.has(id);
});
const reabriendo = ref(false);
watch(() => datosManifiesto.value?.manifest.id, async (id) => {
  const m = datosManifiesto.value?.manifest;
  if (!id || !m || m.status !== 'siscommate') return;
  try {
    const datos = await api.siscommateVivo(id);
    if (datos.encontrado) manifiestosEliminadosSiscommate.delete(id);
    else manifiestosEliminadosSiscommate.add(id);
  } catch { /* bridge caído u offline — no se avisa nada a ciegas */ }
});
async function reabrirSiscommate() {
  const m = datosManifiesto.value?.manifest;
  if (!m) return;
  reabriendo.value = true;
  try {
    const r = await api.reabrirSiscommate(m.id);
    toast(`Viaje reabierto — ${r.bls_reabiertos} B/L quedaron listos para reenviarse a SISCOMMATE`);
    manifiestosEliminadosSiscommate.delete(m.id);
    await cargarManifiestos();
    await seleccionarManifiesto(m.id);
  } catch (e) {
    let msg = (e as Error).message;
    try { msg = JSON.parse(msg).error || msg; } catch { /* texto plano */ }
    avisar('No se pudo reabrir el viaje', msg);
  }
  reabriendo.value = false;
}

// Columnas que el bridge SIEMPRE escribe con el mismo valor fijo (ver
// SiscommateBridge.cs, INSERT INTO BOL/BOLITEM) — no son un dato real por
// B/L, solo ocupan espacio en una tabla ya de por sí muy ancha. Se ocultan
// por defecto; el botón "Mostrar todas" las revela para quien sí necesite
// auditarlas literalmente tal como están en el DBF.
const COLUMNAS_ESTATICAS: Record<string, string[]> = {
  bol: ['ttype', 'boltype', 'payee', 'ptype', 'charges', 'pind', 'taxtype', 'taxamt', 'taxadi',
        'invoice', 'idate', 'invamt', 'sdesc', 'insamt', 'dutypaid', 'rate', 'relno', 'declno',
        'coriport', 'cdesport', 'comvali', 'comval'],
  items: ['sind', 'rate', 'taxamt', 'taxadi', 'wind', 'vind', 'sec', 'qty2', 'value2'],
};
const mostrarTodasCols = ref<Record<string, boolean>>({ bol: false, items: false });
function columnasVisibles(tabla: 'bol' | 'items', fila: Record<string, unknown>): string[] {
  const todas = Object.keys(fila);
  if (mostrarTodasCols.value[tabla]) return todas;
  const ocultas = new Set(COLUMNAS_ESTATICAS[tabla]);
  return todas.filter(k => !ocultas.has(k));
}
async function verSiscommateVivo() {
  const m = datosManifiesto.value?.manifest;
  if (!m) return;
  viendoVivo.value = true;
  mostrarTodasCols.value = { bol: false, items: false };
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
      <input type="file" ref="archivoInput" accept=".xml,.pdf" multiple class="hidden"
        @change="subirVarios(Array.from(($event.target as HTMLInputElement).files || []))" />
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
          <Button variant="outline" size="sm" :disabled="sincronizando" title="Trae lo que haya en SISCOMMATE ahora mismo y sobreescribe estos B/L localmente, marcándolos validado" @click="sincronizarDesdeSiscommate">
            <Loader2 v-if="sincronizando" class="size-3.5 animate-spin" /><RefreshCw v-else class="size-3.5" />
            {{ sincronizando ? 'Sincronizando...' : 'Sincronizar desde SISCOMMATE' }}
          </Button>
        </div>

        <div v-if="siscommateEliminado" class="flex shrink-0 items-center gap-3 border-b border-danger/40 bg-danger-soft px-4 py-2 text-sm text-danger">
          <span class="flex-1">
            Este viaje está marcado como "enviado a SISCOMMATE" acá, pero ya no existe allá —
            probablemente lo eliminaron con la app nativa de SISCOMMATE.
          </span>
          <Button size="sm" variant="destructive" :disabled="reabriendo" @click="reabrirSiscommate">
            <Loader2 v-if="reabriendo" class="size-3.5 animate-spin" />
            {{ reabriendo ? 'Reabriendo...' : 'Reabrir para reenviar' }}
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
        <Input v-if="modal.pedirTexto" v-model="nuevoVoyageNo" placeholder="ej. CF371TB" class="h-9 font-mono text-xs" autofocus />
        <label v-if="modal.enOtroViaje?.length" class="flex items-center gap-2 rounded-md border border-border bg-paper-sunken px-3 py-2 text-sm">
          <input type="checkbox" v-model="moverEnOtroViaje" class="size-3.5" />
          Mover esos {{ modal.enOtroViaje.length }} B/L a este viaje también
        </label>
        <DialogFooter>
          <Button v-for="(b, i) in modal.botones" :key="i" :variant="(b.variant as any)" @click="b.accion">{{ b.label }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!vivo" @update:open="(v) => !v && (vivo = null)">
      <!-- sm:max-w-[95vw] es obligatorio, no solo max-w-[95vw]: el componente
           base (DialogContent.vue) trae "sm:max-w-sm" (24rem) por defecto, y
           tailwind-merge no lo reemplaza a menos que la clase nueva tenga la
           MISMA variante — sin el prefijo "sm:" aquí, el default seguía
           ganando en cualquier pantalla ≥640px y el modal se quedaba
           atascado en 384px pese al max-w-[95vw]. Confirmado con
           getComputedStyle en el navegador antes de este fix. -->
      <DialogContent v-if="vivo" class="w-[95vw] max-w-[95vw] sm:max-w-[95vw]">
        <DialogHeader><DialogTitle>Lo que hay en SISCOMMATE — Viaje {{ datosManifiesto?.manifest.voyage_no }}</DialogTitle></DialogHeader>
        <p v-if="!vivo.encontrado" class="text-sm text-ink-faint">No se encontró ningún manifiesto con este número de viaje en las tablas de SISCOMMATE.</p>
        <div v-else class="flex max-h-[80vh] flex-col gap-4 overflow-y-auto text-xs">
          <div>
            <p class="mb-1 font-medium text-ink-muted">Manifiesto (MANIFEST)</p>
            <div class="grid grid-cols-2 gap-x-4 gap-y-0.5 rounded border border-border p-2 font-mono md:grid-cols-4">
              <template v-for="(val, key) in (vivo.manifest || {})" :key="key">
                <span class="text-ink-faint">{{ key }}</span><span class="truncate">{{ val === null || val === '' ? '—' : String(val) }}</span>
              </template>
            </div>
          </div>
          <div>
            <div class="mb-1 flex items-center gap-2">
              <p class="font-medium text-ink-muted">B/L — BOL ({{ vivo.bls.length }})</p>
              <button v-if="vivo.bls.length" type="button" class="text-accent underline" @click="mostrarTodasCols.bol = !mostrarTodasCols.bol">
                {{ mostrarTodasCols.bol ? 'Ocultar columnas siempre vacías' : `Mostrar todas (+${COLUMNAS_ESTATICAS.bol.length} columnas siempre vacías)` }}
              </button>
            </div>
            <p v-if="!vivo.bls.length" class="text-ink-faint">Sin B/L registrados.</p>
            <div v-else class="overflow-x-auto rounded border border-border">
              <table class="w-full border-collapse font-mono">
                <thead><tr class="border-b border-border bg-paper-raised text-left text-ink-faint">
                  <th v-for="k in columnasVisibles('bol', vivo.bls[0])" :key="k" class="px-2 py-1 whitespace-nowrap">{{ k }}</th>
                </tr></thead>
                <tbody>
                  <tr v-for="(bl, i) in vivo.bls" :key="i" class="border-b border-border/50 last:border-0">
                    <td v-for="k in columnasVisibles('bol', bl as Record<string, unknown>)" :key="k" class="px-2 py-1 whitespace-nowrap">{{ (bl as any)[k] === null || (bl as any)[k] === '' ? '—' : String((bl as any)[k]) }}</td>
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
            <div class="mb-1 flex items-center gap-2">
              <p class="font-medium text-ink-muted">Items de carga (BOLITEM) ({{ vivo.items.length }})</p>
              <button v-if="vivo.items.length" type="button" class="text-accent underline" @click="mostrarTodasCols.items = !mostrarTodasCols.items">
                {{ mostrarTodasCols.items ? 'Ocultar columnas siempre vacías' : `Mostrar todas (+${COLUMNAS_ESTATICAS.items.length} columnas siempre vacías)` }}
              </button>
            </div>
            <p v-if="!vivo.items.length" class="text-ink-faint">Sin items registrados.</p>
            <div v-else class="overflow-x-auto rounded border border-border">
              <table class="w-full border-collapse font-mono">
                <thead><tr class="border-b border-border bg-paper-raised text-left text-ink-faint">
                  <th v-for="k in columnasVisibles('items', vivo.items[0])" :key="k" class="px-2 py-1 whitespace-nowrap">{{ k }}</th>
                </tr></thead>
                <tbody>
                  <tr v-for="(it, i) in vivo.items" :key="i" class="border-b border-border/50 last:border-0">
                    <td v-for="k in columnasVisibles('items', it as Record<string, unknown>)" :key="k" class="px-2 py-1 whitespace-nowrap">{{ (it as any)[k] === null || (it as any)[k] === '' ? '—' : String((it as any)[k]) }}</td>
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
          <div class="flex flex-col gap-1">
            <Label class="text-xs">Nombre / Razón social <span class="text-danger">*</span></Label>
            <Input v-model="cliente.name" placeholder="Ej. LANCO MANUFACTURING CORP" :class="clienteCamposError.has('name') && 'border-danger focus-visible:ring-danger'" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="flex flex-col gap-1">
              <Label class="text-xs">SS / EIN (9 dígitos) <span class="text-danger">*</span></Label>
              <Input v-model="cliente.ss" placeholder="660123456" maxlength="11" class="font-mono" :class="clienteCamposError.has('ss') && 'border-danger focus-visible:ring-danger'" @input="cliente.ss = cliente.ss.replace(/[^0-9-]/g,'')" />
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

    <!-- Check grande animado: confirmación visual de un envío real a
         SISCOMMATE (enviados > 0) — más notorio que el toast, que se puede
         perder de vista con la pantalla llena de campos. -->
    <Transition name="check-envio">
      <div v-if="envioExitoso" class="fixed inset-0 z-50 flex items-center justify-center bg-ink/40" @click="envioExitoso = false">
        <div class="check-envio-circulo flex size-36 items-center justify-center rounded-full bg-status-validated shadow-2xl">
          <Check class="size-20 text-white" stroke-width="3" />
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.check-envio-enter-active .check-envio-circulo { animation: check-envio-pop 0.45s cubic-bezier(0.34, 1.56, 0.64, 1); }
.check-envio-enter-active { transition: opacity 0.15s ease; }
.check-envio-leave-active { transition: opacity 0.25s ease; }
.check-envio-enter-from, .check-envio-leave-to { opacity: 0; }
@keyframes check-envio-pop {
  0%   { transform: scale(0.4); opacity: 0; }
  60%  { transform: scale(1.08); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
</style>
