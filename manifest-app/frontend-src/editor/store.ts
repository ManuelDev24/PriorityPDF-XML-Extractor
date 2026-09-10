// store.ts — Estado compartido del editor.
//
// Reemplaza las variables globales de frontend/js/state.js. La diferencia real
// no es el framework: es que el guardado diferido, que antes vivia suelto en
// dos funciones con un temporizador compartido, queda encapsulado aqui.

import { reactive, ref, computed, watch } from 'vue';
import { api, type Manifiesto, type DatosManifiesto, type BL,
         type Carrier, type Puerto, type Buque } from './api';

// ── Catalogos (se cargan una vez al arrancar) ────────────────────────────────
export const carriers = ref<Carrier[]>([]);
export const puertos  = ref<Puerto[]>([]);
export const buques   = ref<Buque[]>([]);
const FALLBACK_TAMANOS = ['20', '40', '40HC', '45', '48', '53', 'RORO'];
export const tamanosValidos = ref<string[]>(FALLBACK_TAMANOS);

// ── Listado y seleccion ──────────────────────────────────────────────────────
export const manifiestos     = ref<Manifiesto[]>([]);
export const datosManifiesto = ref<DatosManifiesto | null>(null);
export const blActual        = ref<BL | null>(null);
export const expandidos      = reactive(new Set<number>());
export const pestana         = ref<'active' | 'completed'>('active');

export const manifiestoActualId = computed(() => datosManifiesto.value?.manifest.id ?? null);

// Recordar el viaje/B/L abierto para no perderlos al refrescar el navegador
// (antes se volvía siempre a "Selecciona un manifiesto"). Se guarda con un
// watch (no en cada punto que muta blActual/datosManifiesto) para que
// también funcione cuando el cierre viene de un lugar que no pasa por
// cerrarBL/seleccionarBL, como el colapso de un viaje en el sidebar.
const KEY_MANIFIESTO = 'priority-ultimo-manifiesto';
const KEY_BL = 'priority-ultimo-bl';
watch(datosManifiesto, (d) => {
  if (d) localStorage.setItem(KEY_MANIFIESTO, String(d.manifest.id));
  else localStorage.removeItem(KEY_MANIFIESTO);
});
watch(blActual, (bl) => {
  if (bl) localStorage.setItem(KEY_BL, String(bl.id));
  else localStorage.removeItem(KEY_BL);
});

// "Completado" = TODOS los B/L del viaje están validado ahora mismo — no
// que se haya empujado a SISCOMMATE. Antes se usaba m.status, pero el
// backend deja de recalcularlo en cuanto pasa a 'siscommate' (ver
// recalcularEstadoManifiesto en routes/bl.js), así que un viaje ya
// empujado con B/L agregados después sin validar se quedaba mostrado como
// "Completado" aunque en realidad le faltaba trabajo. pending_count se
// calcula en vivo en cada listado, así que siempre refleja el estado real.
const completado = (m: Manifiesto) => (m.bl_count ?? 0) > 0 && (m.pending_count ?? 0) === 0;
export const manifiestosFiltrados = computed(() => {
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

/** Refleja en memoria el status de manifiesto que el backend recalculó (al
 * validar/desvalidar un B/L, crearlo, borrarlo o moverlo) sin esperar un
 * refetch completo — así el badge y la pestaña "Completados" se actualizan
 * al toque. */
export function sincronizarEstadoManifiesto(manifestId: number, status: string | undefined) {
  if (!status) return;
  if (datosManifiesto.value?.manifest.id === manifestId) datosManifiesto.value.manifest.status = status;
  const m = manifiestos.value.find(x => x.id === manifestId);
  if (m) m.status = status;
}

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
    const [c, p, b, sizes] = await Promise.all([
      api.carriers(), api.puertos(), api.buques(), api.tamanosContenedor(),
    ]);
    carriers.value = c; puertos.value = p; buques.value = b;
    tamanosValidos.value = sizes.length ? sizes : FALLBACK_TAMANOS;
  } catch (e) { console.warn('Error cargando catálogos', e); }
}

export async function cargarManifiestos() {
  try {
    manifiestos.value = await api.listarManifiestos();
    cargarStats();
  } catch (e) { setEstado('Error conectando con el servidor: ' + (e as Error).message); }
}

export async function seleccionarManifiesto(id: number) {
  // Solo un viaje puede estar realmente "abierto" a la vez (datosManifiesto
  // es un único objeto) — si expandidos conservaba el id anterior al saltar
  // directo de un viaje a otro (sin colapsarlo primero), su fila se quedaba
  // con la flecha hacia abajo aunque ya no mostrara sus B/L. Un clic ahí
  // caía en la rama de "colapsar" en vez de "abrir", y como el id no
  // coincidía con el viaje realmente activo, no pasaba nada visible.
  expandidos.clear();
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
  } catch {
    toast('Error cargando manifiesto', 'err');
    // El id guardado ya no sirve (manifiesto eliminado, etc.) — si no se
    // limpia, cada refresh vuelve a intentar cargarlo y vuelve a fallar.
    localStorage.removeItem(KEY_MANIFIESTO);
    localStorage.removeItem(KEY_BL);
  }
}

export function seleccionarBL(id: number) {
  const bl = datosManifiesto.value?.bls.find(b => b.id === id);
  if (bl) blActual.value = bl;
}

export function cerrarBL() {
  blActual.value = null;
}

/** Reabre el viaje/B/L que estaba abierto antes de refrescar. Se llama una
 * sola vez al arrancar, después de que cargarManifiestos ya resolvió. */
export async function restaurarSeleccion() {
  const manifiestoId = Number(localStorage.getItem(KEY_MANIFIESTO)) || 0;
  if (!manifiestoId) return;
  // Leer el B/L guardado ANTES de seleccionarManifiesto: ese selecciona el
  // primer B/L por defecto, lo que dispara el watch de blActual y pisa este
  // valor en localStorage antes de que se pueda usar para restaurar.
  const blId = Number(localStorage.getItem(KEY_BL)) || 0;
  await seleccionarManifiesto(manifiestoId);
  if (blId && datosManifiesto.value) seleccionarBL(blId);
  // Sin esto, restaurar un manifiesto "completado" (siscommate/validado)
  // dejaba la pestaña en "active" por defecto — el sidebar mostraba "Sin
  // manifiestos" aunque el panel principal ya tenía el B/L cargado, como si
  // no hubiera abierto nada.
  const m = datosManifiesto.value?.manifest;
  if (m) pestana.value = completado(m) ? 'completed' : 'active';
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
      return { container_no: c.container_no, id: full?.id ?? null, size: full?.size ?? '', amount: full?.amount ?? 0 };
    });
});
