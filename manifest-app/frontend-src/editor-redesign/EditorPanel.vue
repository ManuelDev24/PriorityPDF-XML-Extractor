<script setup lang="ts">
// Misma lógica de negocio que frontend-src/editor/EditorPanel.vue (store.ts
// sin tocar). Lo que cambia es la presentación: Card/Input/Select de shadcn,
// y sobre todo el grid — cada campo se dimensiona por su contenido real en
// vez de fracciones iguales (era el reclamo original: IMO con 7 caracteres
// ocupaba el mismo ancho que el nombre del buque).
import { ref, computed, watch } from 'vue';
import { api, type ItemHacienda, type Cliente, type ClienteSiscommate } from '../editor/api';
import {
  datosManifiesto, blActual, carriers, puertos, buques, contenedoresDelBL, tamanosValidos,
  actualizarBL, actualizarManifiesto, cerrarBL, setEstado, toast, sincronizarEstadoManifiesto,
} from '../editor/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel } from '@/components/ui/select';
import { Combobox, ComboboxAnchor, ComboboxInput, ComboboxList, ComboboxEmpty, ComboboxGroup, ComboboxItem } from '@/components/ui/combobox';
import CargoItems from './CargoItems.vue';
import StatusBadge from './StatusBadge.vue';
const cargoItemsRef = ref<InstanceType<typeof CargoItems> | null>(null);
import { Check, Eye, X, Sparkles, Box } from '@lucide/vue';

const emit = defineEmits<{
  vistaPrevia: [blId: number];
  crearCliente: [prefill: string];
  editarCliente: [id: number, ss: string, nombre: string];
}>();

const m = computed(() => datosManifiesto.value!.manifest);
const bl = computed(() => blActual.value!);
// Posición del B/L abierto dentro del viaje ("12 de 97") — para saber en
// qué punto de la lista se está trabajando, sobre todo en viajes con
// decenas de B/L donde el sidebar por sí solo no lo deja claro.
const posicionBL = computed(() => {
  const lista = datosManifiesto.value?.bls;
  if (!lista || !blActual.value) return '';
  const idx = lista.findIndex(b => b.id === blActual.value!.id);
  return idx === -1 ? '' : `${idx + 1} de ${lista.length}`;
});

const PAISES: Record<string, string> = {
  PR: 'Puerto Rico', DO: 'Rep. Dominicana', US: 'Estados Unidos', VI: 'Islas Vírgenes (US)',
  VG: 'Islas Vírgenes (UK)', SX: 'St. Maarten', MF: 'St. Martin', KN: 'Saint Kitts',
  AG: 'Antigua', MX: 'México', CN: 'China',
};
const paises = computed(() => [...new Set(puertos.value.map(p => p.country))]);
const puertosDe = (pais: string) => puertos.value.filter(p => p.country === pais);

// Código empaque (DGA): lista cerrada pedida explícitamente, pero el parser
// trae valores libres del XML/PDF ("pack", "unit", "IG013", etc.) que no
// necesariamente están en esta lista. displayEmpaque hace la "detección
// automática": si el valor guardado coincide con alguno de estos códigos
// (sin importar mayúsculas), lo muestra en su forma canónica; si no coincide
// con ninguno, se muestra tal cual llegó y el operador lo agrega manualmente
// — nunca se reescribe el dato guardado solo por mostrarlo.
const TIPOS_EMPAQUE = ['AUTO', 'AUTO-T', 'BARREL', 'BBL', 'BBLS', 'BOX', 'BUNDLE', 'CRATE', 'DRUMS', 'LSE', 'PALETS', 'PIECES'];
function displayEmpaque(valor: unknown) {
  const v = String(valor ?? '').trim();
  if (!v) return '';
  return TIPOS_EMPAQUE.find(t => t === v.toUpperCase()) ?? v;
}

const puertoOrigen = computed({
  get: () => m.value.loading_port || 'DRP',
  set: (v: string) => actualizarManifiesto('loading_port', v),
});
const puertoDestino = computed({
  get: () => m.value.unloading_port || 'XSJ',
  set: (v: string) => actualizarManifiesto('unloading_port', v),
});
// Puerto de descarga: distinto del destino final para carga en tránsito, sin
// valor por defecto (a diferencia de origen/destino, es opcional).
const puertoDescarga = computed({
  get: () => m.value.discharge_port || '',
  set: (v: string) => actualizarManifiesto('discharge_port', v),
});
const tarifa = computed({
  get: () => bl.value.hacienda_tariff || '040',
  set: (v: string) => actualizarBL('hacienda_tariff', v),
});
const libreArancel = computed(() => tarifa.value !== '045');
const contenedorHacienda = computed(() => bl.value.hacienda_container_no || contenedoresDelBL.value[0]?.container_no || '');

function imoDelBuque(code: string) { return buques.value.find(v => v.code === code)?.imo ?? ''; }

function alCambiarBuque(code: string) {
  const v = buques.value.find(b => b.code === code);
  if (!v) return;
  actualizarManifiesto('vessel_code', code);
  actualizarManifiesto('vessel_name', v.name);
  actualizarManifiesto('imo', v.imo);
  actualizarManifiesto('carrier_code', v.carrier);
}
function alCambiarDocking(valor: string) { actualizarManifiesto('docking_number', valor.replace(/[^0-9]/g, '')); }

// Combobox: al enfocar con un valor ya elegido, selecciona todo el texto
// para que escribir lo reemplace en vez de insertarse en medio. Diferido con
// setTimeout porque en el momento del evento focus el valor mostrado (el
// código/ss ya elegido) todavía no terminó de pintarse — seleccionar antes
// de eso no selecciona nada, y lo tipeado se inserta sobre el valor viejo.
function seleccionarTextoInput(e: FocusEvent) {
  const el = e.target as HTMLInputElement;
  window.setTimeout(() => el.select(), 0);
}

async function alCambiarTamano(id: number | null, size: string) {
  if (!id) return;
  try {
    await api.actualizarTamano(id, size);
    const c = datosManifiesto.value?.containers.find(ct => ct.id === id);
    if (c) c.size = size;
    setEstado('Tamaño guardado', new Date().toLocaleTimeString('es-PR'));
  } catch (e) { toast('Error guardando tamaño: ' + (e as Error).message, 'err'); }
}

async function alCambiarNumeroContenedor(id: number | null, nuevoNo: string) {
  if (!id) return;
  const c = datosManifiesto.value?.containers.find(ct => ct.id === id);
  const anterior = c?.container_no ?? '';
  const limpio = nuevoNo.trim().toUpperCase();
  if (!limpio || limpio === anterior) return;
  try {
    const eraHacienda = bl.value.hacienda_container_no === anterior;
    await api.actualizarContenedor(id, { container_no: limpio });
    if (c) c.container_no = limpio;
    datosManifiesto.value?.container_bl.forEach(v => { if (v.container_no === anterior) v.container_no = limpio; });
    cargoItemsRef.value?.renombrarContenedor(anterior, limpio);
    if (eraHacienda) actualizarBL('hacienda_container_no', limpio);
    setEstado('Contenedor guardado', new Date().toLocaleTimeString('es-PR'));
  } catch (e) { toast('Error guardando contenedor: ' + (e as Error).message, 'err'); }
}

function opcionesTamano(size: string) {
  return tamanosValidos.value.includes(size)
    ? tamanosValidos.value
    : [...tamanosValidos.value, size];
}

// bl_no no se puede cambiar con actualizarBL (no está en los campos
// editables del backend a propósito — cambiarlo requiere arrastrar
// container_bl, que lo referencia por texto, no por id). Se usa la ruta
// dedicada /renombrar y se refleja a mano en los mismos tres lugares que
// ya hacía falta actualizar para el contenedor.
async function renombrarBL(nuevoNo: string) {
  if (!blActual.value) return;
  const limpio = nuevoNo.trim().toUpperCase();
  const anterior = blActual.value.bl_no;
  if (!limpio || limpio === anterior) return;
  try {
    await api.renombrarBL(blActual.value.id, limpio);
    if (blActual.value) blActual.value.bl_no = limpio;
    const enLista = datosManifiesto.value?.bls.find(b => b.id === blActual.value?.id);
    if (enLista) enLista.bl_no = limpio;
    datosManifiesto.value?.container_bl.forEach(v => { if (v.bl_no === anterior) v.bl_no = limpio; });
    setEstado('B/L renombrado', new Date().toLocaleTimeString('es-PR'));
    toast(`B/L renombrado a ${limpio}`);
  } catch (e) { toast('Error renombrando B/L: ' + (e as Error).message, 'err'); }
}

async function marcar(estado: 'validado' | 'pendiente') {
  if (!blActual.value) return;
  const id = blActual.value.id;
  const manifestId = m.value.id;
  try {
    const r = await api.actualizarBL(id, { status: estado });
    if (blActual.value?.id === id) blActual.value.status = estado;
    sincronizarEstadoManifiesto(manifestId, r.manifest_status);
    toast(estado === 'validado' ? 'B/L marcado como validado' : 'B/L regresado a pendiente');
  } catch { toast('Error', 'err'); }
}

// ── Combobox: código arancelario (Popover + Command, reemplaza el
// autocomplete casero — teclado y foco reales, mismo comportamiento) ──
const itemAbierto = ref(false);
const itemsHallados = ref<ItemHacienda[]>([]);
const empaqueAbierto = ref(false);
const empaquesFiltrados = ref<string[]>(TIPOS_EMPAQUE);
function buscarEmpaque(q: string) {
  const texto = q.trim().toUpperCase();
  empaquesFiltrados.value = texto ? TIPOS_EMPAQUE.filter(t => t.includes(texto)) : TIPOS_EMPAQUE;
}
const descItem = ref('');
const sugerencias = ref<ItemHacienda[]>([]);
let tItem: ReturnType<typeof setTimeout> | undefined;
let tSugerir: ReturnType<typeof setTimeout> | undefined;

function buscarItem(q: string) {
  clearTimeout(tItem);
  if (!q || q.length < 2) { itemsHallados.value = []; return; }
  tItem = setTimeout(async () => {
    try { itemsHallados.value = await api.buscarItems(q); } catch { itemsHallados.value = []; }
  }, 200);
}
function elegirItem(it: ItemHacienda) {
  actualizarBL('hacienda_item_code', it.code);
  itemAbierto.value = false;
  sugerencias.value = [];
  descItem.value = it.description;
  // Sugerencia de consignatario según qué cliente usa más este código en el
  // historial real de SISCOMMATE (ver itemClientAnalysis.js) — no pisa un
  // SS/nombre que el operador ya haya puesto a mano.
  if (it.client_ss && !bl.value.hacienda_client_ss) {
    actualizarBL('hacienda_client_ss', it.client_ss);
    if (it.client_name) { nombreCliente.value = it.client_name; clienteId.value = null; }
    rellenarSiVacio('consignee_name', it.client_name || '');
  }
}
// El Combobox nativo emite el `value` del item elegido (el código, un
// string), no el objeto completo — se busca en itemsHallados para reusar
// elegirItem tal cual, igual que las sugerencias.
function alElegirCodigo(codigo: string) {
  const it = itemsHallados.value.find(i => i.code === codigo);
  if (it) elegirItem(it);
}
async function cargarDescItem(code: string) {
  if (!code) { descItem.value = ''; return; }
  try {
    const items = await api.buscarItems(code);
    descItem.value = items.find(i => i.code === code)?.description ?? '';
  } catch { /* sin descripción */ }
}
async function sugerir(desc: string) {
  if (!desc || desc.length < 5 || bl.value.hacienda_item_code) return;
  try { sugerencias.value = (await api.sugerirItems(desc)).slice(0, 6); } catch { /* sin sugerencias */ }
}
function alCambiarDescripcion(valor: string) {
  actualizarBL('goods_name', valor);
  clearTimeout(tSugerir);
  tSugerir = setTimeout(() => sugerir(valor), 800);
}

// ── Combobox: consignatario ──
const clienteAbierto = ref(false);
const clientesHallados = ref<Cliente[]>([]);
const clientesSiscommate = ref<ClienteSiscommate[]>([]);
const nombreCliente = ref('');
const clienteId = ref<number | null>(null);
const busquedaCliente = ref('');
let tCliente: ReturnType<typeof setTimeout> | undefined;

function buscarCliente(q: string) {
  busquedaCliente.value = q;
  clearTimeout(tCliente);
  if (!q || q.length < 2) { clientesHallados.value = []; clientesSiscommate.value = []; return; }
  tCliente = setTimeout(async () => {
    try { clientesHallados.value = await api.buscarClientes(q); } catch { clientesHallados.value = []; }
    try { clientesSiscommate.value = await api.buscarClientesSiscommate(q); } catch { clientesSiscommate.value = []; }
  }, 200);
}

// Última línea no vacía = ciudad, el resto = calle. Con 1 sola línea, esa
// línea se usa como calle y no hay ciudad — más seguro que adivinar.
function partirDireccion(lineas: Array<string | undefined>) {
  const validas = lineas.filter((l): l is string => !!l && l.trim() !== '');
  if (validas.length <= 1) return { street: validas[0] || '', city: '' };
  return { street: validas.slice(0, -1).join(', '), city: validas[validas.length - 1] };
}
// No pisa lo que el operador ya haya escrito a mano en el consignatario.
function rellenarSiVacio(campo: 'consignee_name' | 'consignee_tel' | 'consignee_street' | 'consignee_city', valor: string) {
  if (valor && !bl.value[campo]) actualizarBL(campo, valor);
}

function elegirCliente(c: Cliente) {
  actualizarBL('hacienda_client_ss', c.ss);
  clienteAbierto.value = false;
  nombreCliente.value = c.name;
  clienteId.value = c.id;
  if (c.ivu && !bl.value.hacienda_client_ivu) actualizarBL('hacienda_client_ivu', c.ivu);
  rellenarSiVacio('consignee_name', c.name);
  rellenarSiVacio('consignee_tel', c.phone1 || '');
  rellenarSiVacio('consignee_street', c.add1 || '');
  rellenarSiVacio('consignee_city', c.add2 || '');
}
function aplicarCliente(c: Cliente) { elegirCliente(c); }
defineExpose({ aplicarCliente });

// Cliente real de SISCOMMATE (CUSTOMER) elegido — mismo llenado, pero sin id
// local (no vive en nuestro catálogo `clients`) y con dirección de 3 líneas.
function elegirClienteSiscommate(c: ClienteSiscommate) {
  actualizarBL('hacienda_client_ss', c.ss);
  clienteAbierto.value = false;
  nombreCliente.value = c.name;
  clienteId.value = null;
  if (c.ivu && !bl.value.hacienda_client_ivu) actualizarBL('hacienda_client_ivu', c.ivu);
  const { street, city } = partirDireccion([c.add1, c.add2, c.add3]);
  rellenarSiVacio('consignee_name', c.name);
  rellenarSiVacio('consignee_tel', c.phone1 || '');
  rellenarSiVacio('consignee_street', street);
  rellenarSiVacio('consignee_city', city);
}

// Igual que alElegirCodigo: el Combobox entrega el `value` (string), más los
// casos especiales "crear-nuevo" y "sis:<indice>" para un resultado de
// SISCOMMATE (no tiene id local; nunca puede ser value="" — ver bug de
// CargoItems.vue con SelectItem value="").
function alElegirClienteValor(valor: string) {
  if (valor === 'crear-nuevo') {
    clienteAbierto.value = false;
    emit('crearCliente', busquedaCliente.value);
    return;
  }
  if (valor.startsWith('sis:')) {
    const c = clientesSiscommate.value[Number(valor.slice(4))];
    if (c) elegirClienteSiscommate(c);
    return;
  }
  const c = clientesHallados.value.find(x => String(x.id) === valor);
  if (c) elegirCliente(c);
}

watch(() => bl.value?.id, () => {
  itemAbierto.value = false; clienteAbierto.value = false;
  sugerencias.value = []; nombreCliente.value = ''; clienteId.value = null; descItem.value = '';
  clientesHallados.value = []; clientesSiscommate.value = [];
  if (bl.value?.hacienda_item_code) cargarDescItem(bl.value.hacienda_item_code);
  else if (bl.value?.goods_name) sugerir(bl.value.goods_name);
}, { immediate: true });
</script>

<template>
  <div class="flex flex-col gap-5">
    <!-- ── MANIFIESTO ── -->
    <Card>
      <CardHeader class="flex-row items-center gap-2">
        <CardTitle class="flex items-center gap-2">
          <span>Manifiesto</span>
          <span>— Viaje {{ m.voyage_no }}</span>
          <StatusBadge :status="m.status" />
        </CardTitle>
      </CardHeader>
      <CardContent class="flex flex-col gap-2.5">
        <!-- Grid único de 12 columnas. Fila 1 = quién transporta · Fila 2 =
             de dónde a dónde · Fila 3 = cuándo y bajo qué código. -->
        <div class="grid grid-cols-12 gap-x-3 gap-y-2.5">
          <!-- Fila 1: Buque (5) · IMO (3) · Carrier Hacienda PR (4) —
               IMO subió de 2→3: a 2 el valor de 7 dígitos (8916607) se
               cortaba, medido en el navegador (61.8px de caja vs 77px que
               necesita el texto). -->
          <div class="col-span-12 flex flex-col gap-1 md:col-span-5">
            <Label class="text-xs">Buque</Label>
            <Select :model-value="m.vessel_code" @update:model-value="(v) => alCambiarBuque(String(v))">
              <SelectTrigger class="h-9 w-full text-xs"><SelectValue placeholder="— selecciona —" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="v in buques" :key="v.code" :value="v.code">{{ v.name }} — IMO {{ v.imo }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="col-span-12 flex flex-col gap-1 md:col-span-3">
            <Label class="text-xs">IMO</Label>
            <Input :model-value="m.imo || imoDelBuque(m.vessel_code) || ''" placeholder="Número IMO" class="h-9 font-mono text-xs"
              @change="(e:Event) => actualizarManifiesto('imo', (e.target as HTMLInputElement).value)" />
          </div>
          <div class="col-span-12 flex flex-col gap-1 md:col-span-4">
            <Label class="text-xs">Carrier Hacienda PR</Label>
            <Select :model-value="m.carrier_code || 'MPRIORO'" @update:model-value="(v) => actualizarManifiesto('carrier_code', String(v))">
              <SelectTrigger class="h-9 w-full text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="c in carriers" :key="c.code" :value="c.code">{{ c.name }} ({{ c.scac }})</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <!-- Fila 2: Puerto origen (4) · Puerto descarga (4) · Puerto destino (4) —
               descarga es el puerto intermedio para carga en tránsito, distinto
               del destino final. Pedido explícito 2026-09-03. -->
          <div class="col-span-12 flex flex-col gap-1 md:col-span-4">
            <Label class="text-xs">Puerto origen (DGA)</Label>
            <Select v-model="puertoOrigen">
              <SelectTrigger class="h-9 w-full text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup v-for="pais in paises" :key="pais">
                  <SelectLabel>{{ PAISES[pais] || pais }}</SelectLabel>
                  <SelectItem v-for="p in puertosDe(pais)" :key="p.code" :value="p.code">{{ p.code }} — {{ p.description }}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div class="col-span-12 flex flex-col gap-1 md:col-span-4">
            <Label class="text-xs">Puerto de descarga</Label>
            <Select v-model="puertoDescarga">
              <SelectTrigger class="h-9 w-full text-xs"><SelectValue placeholder="— opcional —" /></SelectTrigger>
              <SelectContent>
                <SelectGroup v-for="pais in paises" :key="pais">
                  <SelectLabel>{{ PAISES[pais] || pais }}</SelectLabel>
                  <SelectItem v-for="p in puertosDe(pais)" :key="p.code" :value="p.code">{{ p.code }} — {{ p.description }}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div class="col-span-12 flex flex-col gap-1 md:col-span-4">
            <Label class="text-xs">Puerto destino (PR)</Label>
            <Select v-model="puertoDestino">
              <SelectTrigger class="h-9 w-full text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup v-for="pais in paises" :key="pais">
                  <SelectLabel>{{ PAISES[pais] || pais }}</SelectLabel>
                  <SelectItem v-for="p in puertosDe(pais)" :key="p.code" :value="p.code">{{ p.code }} — {{ p.description }}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

        </div>

        <!-- Fila 3: Fecha salida (6) · Fecha llegada (6) — un date picker
             nativo necesita ~145px mínimos (medido) para no cortar el ícono
             de calendario; a col-span-2 en esta fila (~62px) el "08/18/2026"
             se veía cortado en "08/". No caben 2 fechas + 2 campos más en
             una sola fila de 12, así que quedan en su propia fila. -->
        <div class="grid grid-cols-12 gap-x-3 gap-y-2.5">
          <div class="col-span-12 flex flex-col gap-1 md:col-span-6">
            <Label class="text-xs">Fecha salida</Label>
            <Input type="date" :model-value="(m.departure_date || '').substring(0,10)" class="h-9 text-xs"
              @change="(e:Event) => actualizarManifiesto('departure_date', (e.target as HTMLInputElement).value)" />
          </div>
          <div class="col-span-12 flex flex-col gap-1 md:col-span-6">
            <Label class="text-xs">Fecha llegada</Label>
            <Input type="date" :model-value="(m.arrival_date || '').substring(0,10)" class="h-9 text-xs"
              @change="(e:Event) => actualizarManifiesto('arrival_date', (e.target as HTMLInputElement).value)" />
          </div>
        </div>

        <!-- Fila 4: No. manifiesto (6) · Docking Number (6) -->
        <div class="grid grid-cols-12 gap-x-3 gap-y-2.5">
          <div class="col-span-12 flex flex-col gap-1 md:col-span-6">
            <Label class="text-xs">No. manifiesto Hacienda <span class="text-danger">*</span></Label>
            <Input :model-value="m.manifest_no || ''" placeholder="ej. 3309468" class="h-9 text-xs" :class="!m.manifest_no && 'border-status-pending bg-status-pending-soft'"
              @change="(e:Event) => actualizarManifiesto('manifest_no', (e.target as HTMLInputElement).value)" />
          </div>
          <div class="col-span-12 flex flex-col gap-1 md:col-span-6">
            <Label class="text-xs">Docking Number <span class="text-danger">*</span></Label>
            <Input :model-value="m.docking_number || ''" placeholder="ej. 20262342" maxlength="8" inputmode="numeric"
              class="h-9 font-mono text-xs" :class="!m.docking_number && 'border-status-pending bg-status-pending-soft'"
              @input="(e:Event) => { const el = e.target as HTMLInputElement; el.value = el.value.replace(/[^0-9]/g,''); }"
              @change="(e:Event) => alCambiarDocking((e.target as HTMLInputElement).value)" />
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- ── B/L HEADER ── -->
    <div class="flex items-center gap-2">
      <Input :model-value="bl.bl_no" title="Número de B/L (editable)"
        class="h-7 w-40 border-transparent bg-transparent px-1 font-mono text-sm font-semibold hover:border-border focus:border-border focus:bg-paper-raised"
        @change="(e:Event) => renombrarBL((e.target as HTMLInputElement).value)" />
      <StatusBadge :status="bl.status" />
      <span v-if="posicionBL" class="text-xs text-ink-faint" title="Posición de este B/L dentro del viaje">B/L {{ posicionBL }}</span>
      <div class="flex-1"></div>
      <Button v-if="bl.status === 'validado'" variant="outline" size="sm" @click="blActual && marcar('pendiente')"><X class="size-3.5" />Desvalidar</Button>
      <Button v-else variant="outline" size="sm" class="border-status-validated text-status-validated hover:bg-status-validated-soft hover:text-status-validated" @click="blActual && marcar('validado')"><Check class="size-3.5" />Validado</Button>
      <!-- blActual (no el computed bl, que fuerza no-null con !) por si el
           clic llega justo cuando blActual ya pasó a null — evita el
           "Cannot read properties of null (reading 'id')" en este handler. -->
      <Button variant="outline" size="sm" @click="blActual && emit('vistaPrevia', blActual.id)"><Eye class="size-3.5" />Ver TXT</Button>
      <Button variant="outline" size="sm" title="Cerrar B/L actual" aria-label="Cerrar B/L actual" @click="cerrarBL"><X class="size-3.5" />Cerrar B/L</Button>
    </div>

    <!-- ── HACIENDA PR ── -->
    <Card>
      <CardHeader><CardTitle class="text-accent">Hacienda PR — campos requeridos para el TXT</CardTitle></CardHeader>
      <CardContent class="flex flex-col gap-2.5">
        <!-- Fila 1 = clasificación arancelaria · Fila 3 = consignatario -->
        <div class="grid grid-cols-12 gap-x-3 gap-y-2.5">
          <!-- Fila 1: Código arancelario (6) · Tarifa (4) — antes era 8/4:
               con el Combobox nativo el campo solo muestra el código corto
               elegido (ej. "2715"), no la descripción larga; a 8 columnas
               (medido: 300px de contenido real dentro de una caja de ~600px)
               quedaba un hueco enorme que se veía roto. -->
          <div class="col-span-12 md:col-span-6 flex flex-col gap-1">
            <Label class="text-xs">Código arancelario — Items Hacienda <span class="text-danger">*</span></Label>
            <!-- Combobox nativo (reka-ui): el input real es el trigger — un
                 clic y ya se puede escribir, sin el paso extra de abrir un
                 botón primero. ignore-filter porque filtramos server-side
                 (buscarItem ya hace el debounce + la llamada a la API). -->
            <Combobox
              :model-value="bl.hacienda_item_code || ''"
              @update:model-value="(v) => alElegirCodigo(String(v))"
              v-model:open="itemAbierto"
              ignore-filter
              open-on-click
              open-on-focus
              :display-value="(v: unknown) => String(v ?? '')"
            >
              <ComboboxAnchor as-child>
                <ComboboxInput placeholder="Buscar por código o descripción..." class="font-mono text-xs"
                  @update:model-value="(v: string) => buscarItem(v)"
                  @focus="seleccionarTextoInput" />
              </ComboboxAnchor>
              <ComboboxList>
                <ComboboxEmpty>Sin resultados</ComboboxEmpty>
                <ComboboxGroup>
                  <ComboboxItem v-for="it in itemsHallados" :key="it.code" :value="it.code">
                    <span class="flex-1 truncate">{{ it.description }}</span>
                    <span class="font-mono text-xs text-ink-faint">{{ it.code }}</span>
                  </ComboboxItem>
                </ComboboxGroup>
              </ComboboxList>
            </Combobox>
            <p v-if="descItem" class="text-xs text-status-validated">{{ descItem }}</p>
          </div>
          <div class="col-span-12 md:col-span-4 flex flex-col gap-1">
            <Label class="text-xs">Tarifa (arbitrio)</Label>
            <Select v-model="tarifa">
              <SelectTrigger class="h-9 w-full bg-paper-raised text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="040">040 — Libre arancel</SelectItem>
                <SelectItem value="045">045 — Carga general</SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-ink-faint">{{ libreArancel ? 'FOB será 0 en el TXT' : 'Incluye valor FOB' }}</p>
          </div>
        </div>

        <div v-if="sugerencias.length" class="w-full flex flex-col gap-2 rounded-lg border border-blue-200 bg-blue-50/60 p-3">
          <p class="flex items-center gap-1.5 text-xs font-medium text-blue-900">
            <Sparkles class="size-3.5" />
            <span>Sugerido para: <strong>"{{ (bl.goods_name || '').substring(0,60) }}"</strong></span>
          </p>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="it in sugerencias" :key="it.code" type="button"
              class="group inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white px-3 py-1.5 text-xs font-medium text-blue-900 shadow-sm transition-colors hover:bg-blue-600 hover:text-white"
              @click="elegirItem(it)">
              <span class="font-mono font-bold text-blue-700 group-hover:text-white">{{ it.code }}</span>
              <span class="text-ink-faint">|</span>
              <span>{{ it.description.substring(0,35) }}</span>
            </button>
          </div>
        </div>

        <!-- Fila 3: SS/EIN consignatario (5) · IVU (3) · Notas internas (4) -->
        <div class="grid grid-cols-12 gap-x-3 gap-y-2.5">
          <div class="col-span-12 md:col-span-5 flex flex-col gap-1">
            <Label class="text-xs">SS / EIN consignatario <span class="text-danger">*</span></Label>
            <Combobox
              :model-value="bl.hacienda_client_ss || ''"
              @update:model-value="(v) => alElegirClienteValor(String(v))"
              v-model:open="clienteAbierto"
              ignore-filter
              open-on-click
              open-on-focus
              :display-value="(v: unknown) => String(v ?? '')"
            >
              <ComboboxAnchor as-child>
                <ComboboxInput placeholder="Buscar por nombre o EIN..." class="font-mono text-xs"
                  @update:model-value="(v: string) => buscarCliente(v)"
                  @focus="seleccionarTextoInput" />
              </ComboboxAnchor>
              <ComboboxList>
                <ComboboxEmpty>Sin resultados</ComboboxEmpty>
                <ComboboxGroup v-if="clientesHallados.length" heading="Locales">
                  <ComboboxItem v-for="c in clientesHallados" :key="c.id" :value="String(c.id)">
                    <span class="flex-1 truncate">{{ c.name }}</span>
                    <span class="font-mono text-xs text-ink-faint">{{ c.ss || '—' }}</span>
                  </ComboboxItem>
                </ComboboxGroup>
                <ComboboxGroup v-if="clientesSiscommate.length" heading="SISCOMMATE">
                  <ComboboxItem v-for="(c, i) in clientesSiscommate" :key="'sis:'+i" :value="'sis:'+i">
                    <span class="flex-1 truncate">{{ c.name }}</span>
                    <span class="font-mono text-xs text-ink-faint">{{ c.ss || '—' }}</span>
                  </ComboboxItem>
                </ComboboxGroup>
                <ComboboxGroup>
                  <ComboboxItem value="crear-nuevo" class="text-accent">
                    + Crear nuevo consignatario…
                  </ComboboxItem>
                </ComboboxGroup>
              </ComboboxList>
            </Combobox>
            <p v-if="nombreCliente" class="flex items-center gap-1 text-xs text-status-validated">
              <Check class="size-3" />{{ nombreCliente }}
              <button v-if="clienteId !== null" class="text-accent underline" @click="emit('editarCliente', clienteId || 0, bl.hacienda_client_ss || '', nombreCliente)">Editar</button>
              <span v-else class="text-ink-faint">(SISCOMMATE)</span>
            </p>
          </div>
          <div class="col-span-12 md:col-span-3 flex flex-col gap-1">
            <Label class="text-xs">IVU / No. comerciante consignatario</Label>
            <Input :model-value="bl.hacienda_client_ivu || ''" placeholder="ej. 01406530016" maxlength="11" class="font-mono text-xs"
              @input="(e:Event) => { const el = e.target as HTMLInputElement; el.value = el.value.replace(/[^0-9]/g,''); }"
              @change="(e:Event) => actualizarBL('hacienda_client_ivu', (e.target as HTMLInputElement).value)" />
          </div>
          <div class="col-span-12 md:col-span-4 flex flex-col gap-1">
            <Label class="text-xs">Notas internas</Label>
            <Input :model-value="bl.notes || ''" placeholder="Observaciones..." class="h-9 bg-paper-raised text-xs"
              @change="(e:Event) => actualizarBL('notes', (e.target as HTMLInputElement).value)" />
          </div>
        </div>

        <div class="grid grid-cols-12 gap-x-3 gap-y-2.5">
          <div class="col-span-12 flex flex-col gap-1 md:col-span-3">
            <Label class="text-xs">No. contenedor (Hacienda)</Label>
            <Input :model-value="contenedorHacienda" placeholder="ej. TCKU1234567" class="font-mono text-xs"
              @change="(e:Event) => actualizarBL('hacienda_container_no', (e.target as HTMLInputElement).value)" />
          </div>
          <div v-if="contenedoresDelBL.length" class="col-span-12 flex flex-col gap-1.5">
            <Label class="flex items-center gap-1.5 text-xs text-ink-muted"><Box class="size-3.5" />Contenedores asociados</Label>
            <div class="grid grid-cols-1 gap-1 sm:grid-cols-2">
              <div v-for="c in contenedoresDelBL" :key="c.container_no"
                class="flex items-center justify-between gap-1.5 rounded-md border border-border bg-paper-raised p-1.5 text-xs"
                :class="c.container_no === contenedorHacienda && 'border-accent/50 bg-accent-soft'">
                <div class="flex items-center gap-1">
                  <button type="button" title="Usar como contenedor Hacienda de este B/L"
                    class="rounded border border-accent/30 p-0.5"
                    :class="c.container_no === contenedorHacienda ? 'bg-accent text-white' : 'bg-transparent text-accent hover:bg-accent-soft'"
                    @click="actualizarBL('hacienda_container_no', c.container_no)"><Check class="size-3" /></button>
                  <Input :model-value="c.container_no" :disabled="!c.id" class="h-7 w-32 font-mono text-xs font-semibold text-accent"
                    @change="(e:Event) => alCambiarNumeroContenedor(c.id, (e.target as HTMLInputElement).value)" />
                </div>
                <Select :model-value="c.size" :disabled="!c.id" @update:model-value="(v) => alCambiarTamano(c.id, String(v))">
                  <SelectTrigger class="h-7 w-24 text-xs" :class="!c.size && 'border-danger bg-danger-soft'"><SelectValue placeholder="— tamaño —" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="s in opcionesTamano(c.size)" :key="s" :value="s">{{ s }}</SelectItem>
                  </SelectContent>
                </Select>
                <span class="whitespace-nowrap text-[11px] text-ink-faint">Tipo: <span class="text-ink">R (RORO)</span></span>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- ── CARGA ── -->
    <Card>
      <CardHeader><CardTitle>Carga</CardTitle></CardHeader>
      <CardContent class="flex flex-col gap-2.5">
        <!-- Cabecera: cantidad (2) · peso (3) · FOB (3) · puerto (2) ·
             empaque (2). La descripción ocupa una fila completa. -->
        <div class="grid grid-cols-12 gap-x-3 gap-y-2.5">
          <div class="col-span-12 flex flex-col gap-1 md:col-span-2">
            <Label class="text-xs">Cantidad bultos</Label>
            <Input type="number" :model-value="bl.package_qty || 0" class="h-9 text-xs" @change="(e:Event) => actualizarBL('package_qty', (e.target as HTMLInputElement).value)" />
          </div>
          <div class="col-span-12 flex flex-col gap-1 md:col-span-3">
            <Label class="text-xs">Peso bruto (kg)</Label>
            <Input type="number" step="0.01" :model-value="bl.gross_weight || 0" class="h-9 text-xs" @change="(e:Event) => actualizarBL('gross_weight', (e.target as HTMLInputElement).value)" />
          </div>
          <div class="col-span-12 flex flex-col gap-1 md:col-span-3">
            <Label class="text-xs">Valor FOB (USD)</Label>
            <Input type="number" step="0.01" :model-value="bl.value || 0" class="h-9 text-xs" :class="libreArancel && 'opacity-50'"
              :title="libreArancel ? '040 Libre arancel — se fuerza a 0 en el TXT' : ''"
              @change="(e:Event) => actualizarBL('value', (e.target as HTMLInputElement).value)" />
          </div>
          <div class="col-span-12 flex flex-col gap-1 md:col-span-2">
            <Label class="text-xs">Puerto descarga (DGA)</Label>
            <Input :model-value="bl.unloading_port_code || ''" class="h-9 text-xs" @change="(e:Event) => actualizarBL('unloading_port_code', (e.target as HTMLInputElement).value)" />
          </div>
          <div class="col-span-12 flex flex-col gap-1 md:col-span-2">
            <Label class="text-xs">Código empaque (DGA)</Label>
            <!-- Lista cerrada pedida por el usuario, pero con fallback a texto
                 libre: si el valor que trae el XML/PDF no está en la lista
                 (ignore-filter porque el filtro es local en buscarEmpaque, no
                 servidor), se muestra tal cual y el operador puede escribir
                 cualquier otro código a mano.
                 displayEmpaque se aplica ANTES del model-value (no vía
                 display-value): reka-ui solo recalcula display-value tras una
                 selección explícita, no al montar con un valor ya cargado —
                 así se ve normalizado ("BOX") desde el primer render. -->
            <Combobox
              :model-value="displayEmpaque(bl.package_unit_code)"
              @update:model-value="(v) => actualizarBL('package_unit_code', String(v))"
              v-model:open="empaqueAbierto"
              ignore-filter
              open-on-click
              open-on-focus
              :display-value="(v: unknown) => String(v ?? '')"
            >
              <ComboboxAnchor as-child>
                <ComboboxInput placeholder="Ej. BOX" class="text-xs"
                  @update:model-value="(v: string) => buscarEmpaque(v)"
                  @focus="seleccionarTextoInput" />
              </ComboboxAnchor>
              <ComboboxList>
                <ComboboxEmpty>Sin coincidencias — se guarda el texto escrito</ComboboxEmpty>
                <ComboboxGroup>
                  <ComboboxItem v-for="t in empaquesFiltrados" :key="t" :value="t">{{ t }}</ComboboxItem>
                </ComboboxGroup>
              </ComboboxList>
            </Combobox>
          </div>
        </div>
        <div class="flex w-full flex-col gap-1">
          <div class="flex items-center justify-between">
            <Label class="text-xs">Descripción de mercancía (DGA) — máx. 121 caracteres en TXT</Label>
            <span class="font-mono text-[11px]" :class="(bl.goods_name||'').length > 121 ? 'font-bold text-danger' : 'text-ink-faint'">{{ (bl.goods_name || '').length }}/121</span>
          </div>
          <Textarea :model-value="bl.goods_name || ''" class="min-h-16 w-full text-xs" @input="(e:Event) => alCambiarDescripcion((e.target as HTMLTextAreaElement).value)" />
        </div>
        <div class="border-t border-border pt-4"><CargoItems ref="cargoItemsRef" /></div>
      </CardContent>
    </Card>

    <!-- ── CONSIGNADOR / CONSIGNATARIO ── -->
    <Card>
      <CardHeader><CardTitle><span class="rounded bg-status-validated-soft px-1.5 py-0.5 text-status-validated">Consignador</span> — Shipper (República Dominicana)</CardTitle></CardHeader>
      <CardContent class="flex flex-col gap-2.5">
        <div class="flex flex-col gap-1"><Label class="text-xs">Nombre / Razón social</Label><Input :model-value="bl.consignor_name || ''" class="h-9 text-xs" @change="(e:Event) => actualizarBL('consignor_name', (e.target as HTMLInputElement).value)" /></div>
        <!-- Fila 2: tipo primero (se elige antes de escribir el número) · documento (5, contenido más largo) · espacio restante (4) -->
        <div class="grid grid-cols-12 gap-x-3 gap-y-2.5">
          <div class="col-span-12 flex flex-col gap-1 md:col-span-3"><Label class="text-xs">Tipo documento</Label><Input :model-value="bl.consignor_document_type || ''" class="h-9 text-xs" @change="(e:Event) => actualizarBL('consignor_document_type', (e.target as HTMLInputElement).value)" /></div>
          <div class="col-span-12 flex flex-col gap-1 md:col-span-5"><Label class="text-xs">No. documento (RNC / Cédula)</Label><Input :model-value="bl.consignor_document_no || ''" class="h-9 text-xs" @change="(e:Event) => actualizarBL('consignor_document_no', (e.target as HTMLInputElement).value)" /></div>
          <div class="hidden md:block md:col-span-4" aria-hidden="true" />
        </div>
        <div class="flex flex-col gap-1"><Label class="text-xs">Dirección</Label><Input :model-value="bl.consignor_street || ''" class="h-9 text-xs" @change="(e:Event) => actualizarBL('consignor_street', (e.target as HTMLInputElement).value)" /></div>
        <!-- Fila 4: ciudad (3) · teléfono (5, puede traer dos números concatenados en datos reales) · email (4) -->
        <div class="grid grid-cols-12 gap-x-3 gap-y-2.5">
          <div class="col-span-12 flex flex-col gap-1 md:col-span-3"><Label class="text-xs">Ciudad</Label><Input :model-value="bl.consignor_city || ''" class="h-9 text-xs" @change="(e:Event) => actualizarBL('consignor_city', (e.target as HTMLInputElement).value)" /></div>
          <div class="col-span-12 flex flex-col gap-1 md:col-span-5"><Label class="text-xs">Teléfono</Label><Input :model-value="bl.consignor_tel || ''" class="h-9 font-mono text-xs" @change="(e:Event) => actualizarBL('consignor_tel', (e.target as HTMLInputElement).value)" /></div>
          <div class="col-span-12 flex flex-col gap-1 md:col-span-4"><Label class="text-xs">Email</Label><Input type="email" :model-value="bl.consignor_email || ''" class="h-9 text-xs" @change="(e:Event) => actualizarBL('consignor_email', (e.target as HTMLInputElement).value)" /></div>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle><span class="rounded bg-accent-soft px-1.5 py-0.5 text-accent">Consignatario</span> — Consignee (Puerto Rico)</CardTitle></CardHeader>
      <CardContent class="flex flex-col gap-2.5">
        <div class="grid grid-cols-12 gap-x-3 gap-y-2.5">
          <div class="col-span-12 flex flex-col gap-1 md:col-span-7"><Label class="text-xs">Nombre / Razón social</Label><Input :model-value="bl.consignee_name || ''" class="h-9 text-xs" @change="(e:Event) => actualizarBL('consignee_name', (e.target as HTMLInputElement).value)" /></div>
          <div class="col-span-12 flex flex-col gap-1 md:col-span-2"><Label class="text-xs">EIN / SS (PR)</Label><Input :model-value="bl.consignee_document_no || ''" class="h-9 font-mono text-xs" @change="(e:Event) => actualizarBL('consignee_document_no', (e.target as HTMLInputElement).value)" /></div>
          <div class="col-span-12 flex flex-col gap-1 md:col-span-3"><Label class="text-xs">Teléfono</Label><Input :model-value="bl.consignee_tel || ''" class="h-9 font-mono text-xs" @change="(e:Event) => actualizarBL('consignee_tel', (e.target as HTMLInputElement).value)" /></div>
        </div>
        <div class="flex flex-col gap-1"><Label class="text-xs">Dirección</Label><Input :model-value="bl.consignee_street || ''" class="h-9 text-xs" @change="(e:Event) => actualizarBL('consignee_street', (e.target as HTMLInputElement).value)" /></div>
        <div class="grid grid-cols-12 gap-x-3 gap-y-2.5">
          <div class="col-span-12 flex flex-col gap-1 md:col-span-3"><Label class="text-xs">Ciudad</Label><Input :model-value="bl.consignee_city || ''" class="h-9 text-xs" @change="(e:Event) => actualizarBL('consignee_city', (e.target as HTMLInputElement).value)" /></div>
          <div class="col-span-12 flex flex-col gap-1 md:col-span-2"><Label class="text-xs">Zip code</Label><Input :model-value="bl.consignee_zip || ''" class="h-9 font-mono text-xs" @change="(e:Event) => actualizarBL('consignee_zip', (e.target as HTMLInputElement).value)" /></div>
          <div class="col-span-12 flex flex-col gap-1 md:col-span-7"><Label class="text-xs">Email</Label><Input type="email" :model-value="bl.consignee_email || ''" class="h-9 text-xs" @change="(e:Event) => actualizarBL('consignee_email', (e.target as HTMLInputElement).value)" /></div>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
