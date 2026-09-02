// store.ts — Estado compartido del editor.
//
// Reemplaza las variables globales de frontend/js/state.js. La diferencia real
// no es el framework: es que el guardado diferido, que antes vivia suelto en
// dos funciones con un temporizador compartido, queda encapsulado aqui.

import { reactive, ref, computed } from 'vue';
import { api, type Manifiesto, type DatosManifiesto, type BL,
         type Carrier, type Puerto, type Buque } from './api';

// ── Catalogos (se cargan una vez al arrancar) ────────────────────────────────
export const carriers = ref<Carrier[]>([]);
export const puertos  = ref<Puerto[]>([]);
export const buques   = ref<Buque[]>([]);

// ── Listado y seleccion ──────────────────────────────────────────────────────
export const manifiestos     = ref<Manifiesto[]>([]);
export const datosManifiesto = ref<DatosManifiesto | null>(null);
export const blActual        = ref<BL | null>(null);
export const expandidos      = reactive(new Set<number>());
export const pestana         = ref<'active' | 'completed'>('active');

export const manifiestoActualId = computed(() => datosManifiesto.value?.manifest.id ?? null);

export const manifiestosFiltrados = computed(() => {
  const completado = (m: Manifiesto) => m.status === 'siscommate' || m.status === 'exportado';
  return pestana.value === 'completed'
    ? manifiestos.value.filter(completado)
    : manifiestos.value.filter(m => !completado(m));
});

// ── Barra de estado y avisos ─────────────────────────────────────────────────
export const estado       = ref('Listo');
export const estadoDerecha = ref('');
export const toastMsg     = ref('');
export const toastTipo    = ref<'ok' | 'err'>('ok');
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(msg: string, tipo: 'ok' | 'err' = 'ok') {
  toastMsg.value = msg;
  toastTipo.value = tipo;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastMsg.value = ''; }, 3200);
}

export function setEstado(msg: string, derecha = '') {
  estado.value = msg;
  estadoDerecha.value = derecha;
}

const hora = () => new Date().toLocaleTimeString('es-PR');

// ── Guardado diferido ────────────────────────────────────────────────────────
// Antes habia un unico saveTimer compartido por el B/L y el manifiesto, y ambos
// hacian clearTimeout sobre el: elegir un buque disparaba cuatro guardados y
// solo sobrevivia el ultimo, y editar un B/L y tocar el manifiesto cancelaba el
// del B/L. Aqui cada entidad acumula sus cambios y los envia juntos.
function crearGuardado<T extends object>(
  enviar: (id: number, campos: Partial<T>) => Promise<unknown>,
  alGuardar: () => void,
  alFallar: (e: Error) => void,
) {
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  let pendiente: { id: number | null; campos: Partial<T> } = { id: null, campos: {} };

  async function enviarYa() {
    clearTimeout(temporizador);
    const { id, campos } = pendiente;
    if (id === null || !Object.keys(campos).length) return;
    pendiente = { id: null, campos: {} };   // limpiar antes del await
    try { await enviar(id, campos); alGuardar(); }
    catch (e) { alFallar(e as Error); }
  }

  function encolar(id: number, campo: keyof T, valor: unknown) {
    // Si cambio la entidad con cambios pendientes, mandarlos antes de acumular
    if (pendiente.id !== null && pendiente.id !== id) enviarYa();
    pendiente.id = id;
    (pendiente.campos as Record<string, unknown>)[campo as string] = valor;
    clearTimeout(temporizador);
    temporizador = setTimeout(enviarYa, 600);
  }

  return { encolar, enviarYa };
}

const guardadoBL = crearGuardado<BL>(
  (id, campos) => api.actualizarBL(id, campos),
  () => setEstado('Guardado', hora()),
  (e) => toast('Error guardando: ' + e.message, 'err'),
);

const guardadoManifiesto = crearGuardado<Manifiesto>(
  (id, campos) => api.actualizarManifiesto(id, campos),
  () => setEstado('Manifiesto actualizado', hora()),
  (e) => toast('Error guardando manifiesto: ' + e.message, 'err'),
);

/** Actualiza un campo del B/L abierto: en memoria al instante, al servidor tras 600 ms. */
export function actualizarBL<K extends keyof BL>(campo: K, valor: BL[K]) {
  if (!blActual.value) return;
  blActual.value[campo] = valor;
  guardadoBL.encolar(blActual.value.id, campo, valor);
}

/** Igual para el manifiesto. Importa al elegir buque: cambia 4 campos de golpe. */
export function actualizarManifiesto<K extends keyof Manifiesto>(campo: K, valor: Manifiesto[K]) {
  const m = datosManifiesto.value?.manifest;
  if (!m) return;
  m[campo] = valor;
  guardadoManifiesto.encolar(m.id, campo, valor);
}

/** Fuerza el envio de lo pendiente. Se usa antes de exportar o de hacer push. */
export async function guardarPendientes() {
  await guardadoBL.enviarYa();
  await guardadoManifiesto.enviarYa();
}

// ── Carga de datos ───────────────────────────────────────────────────────────
export const stats = ref({ manifests: 0, bls: 0, pending: 0, siscommate: 0 });

export async function cargarStats() {
  try { stats.value = await api.estadisticas(); } catch { /* no critico */ }
}

export async function cargarCatalogos() {
  try {
    const [c, p, b] = await Promise.all([api.carriers(), api.puertos(), api.buques()]);
    carriers.value = c; puertos.value = p; buques.value = b;
  } catch (e) { console.warn('Error cargando catálogos', e); }
}

export async function cargarManifiestos() {
  try {
    manifiestos.value = await api.listarManifiestos();
    cargarStats();
  } catch (e) { setEstado('Error conectando con el servidor: ' + (e as Error).message); }
}

export async function seleccionarManifiesto(id: number) {
  expandidos.add(id);
  try {
    datosManifiesto.value = await api.obtenerManifiesto(id);
    const m = datosManifiesto.value.manifest;
    if (datosManifiesto.value.bls.length) {
      blActual.value = datosManifiesto.value.bls[0];
    } else {
      blActual.value = null;
    }
    setEstado(`Manifiesto ${m.voyage_no} — ${datosManifiesto.value.bls.length} B/L cargados`);
  } catch { toast('Error cargando manifiesto', 'err'); }
}

export function seleccionarBL(id: number) {
  const bl = datosManifiesto.value?.bls.find(b => b.id === id);
  if (bl) blActual.value = bl;
}

/** Contenedores vinculados al B/L abierto, con su tamaño. */
export const contenedoresDelBL = computed(() => {
  const d = datosManifiesto.value;
  const bl = blActual.value;
  if (!d || !bl) return [];
  return d.container_bl
    .filter(c => c.bl_no === bl.bl_no)
    .map(c => {
      const full = d.containers.find(ct => ct.container_no === c.container_no);
      return { container_no: c.container_no, id: full?.id ?? null, size: full?.size ?? '' };
    });
});
