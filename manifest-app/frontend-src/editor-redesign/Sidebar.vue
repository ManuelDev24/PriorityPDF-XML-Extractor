<script setup lang="ts">
// Misma lógica que frontend-src/editor/Sidebar.vue (store.ts sin tocar), solo
// cambia la presentación: Tabs de shadcn en vez de divs a mano, Card/Button
// consistentes con el resto del rediseño.
import { ref } from 'vue';
import { api, type ResultadoBusqueda } from '../editor/api';
import {
  manifiestos, manifiestosFiltrados, datosManifiesto, blActual, expandidos,
  pestana, seleccionarManifiesto, seleccionarBL, cargarManifiestos, cargarStats,
  toast, setEstado,
} from '../editor/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import StatusBadge from './StatusBadge.vue';
import { Trash2, ChevronRight, ChevronDown, Search, Plus, X, Move } from '@lucide/vue';

defineProps<{ abierto: boolean }>();
const emit = defineEmits<{ confirmar: [titulo: string, cuerpo: string, accion: () => void] }>();

const busqueda = ref('');
const blsHallados = ref<ResultadoBusqueda['bls']>([]);
const filtrados = ref<typeof manifiestos.value | null>(null);
const nuevoBlPara = ref<number | null>(null);
const nuevoBlNo = ref('');
const creandoBl = ref(false);
let temporizador: ReturnType<typeof setTimeout> | undefined;

const lista = () => filtrados.value ?? manifiestosFiltrados.value;

function cambiarPestana(p: string) {
  pestana.value = p as 'active' | 'completed';
  busqueda.value = '';
  blsHallados.value = [];
  filtrados.value = null;
}

function alBuscar() {
  clearTimeout(temporizador);
  const q = busqueda.value;
  if (!q || q.length < 2) { blsHallados.value = []; filtrados.value = null; return; }
  temporizador = setTimeout(async () => {
    try {
      const data = await api.buscar(q);
      const ql = q.toLowerCase();
      filtrados.value = manifiestos.value.filter(m =>
        (m.voyage_no || '').toLowerCase().includes(ql) ||
        (m.filename || '').toLowerCase().includes(ql) ||
        (m.vessel_name || '').toLowerCase().includes(ql) ||
        (m.manifest_no || '').toLowerCase().includes(ql)
      );
      blsHallados.value = data.bls ?? [];
    } catch { /* sin resultados */ }
  }, 250);
}

async function irAlBL(manifestId: number, blId: number) {
  busqueda.value = '';
  blsHallados.value = [];
  filtrados.value = null;
  if (datosManifiesto.value?.manifest.id !== manifestId) await seleccionarManifiesto(manifestId);
  seleccionarBL(blId);
}

async function alternar(id: number) {
  if (expandidos.has(id)) {
    expandidos.delete(id);
    if (datosManifiesto.value?.manifest.id === id) {
      blActual.value = null;
      datosManifiesto.value = null;
      // Sin esto la barra de estado se quedaba con "Manifiesto X — N B/L
      // cargados" del viaje que se acaba de colapsar, aunque ya no hay
      // ningún manifiesto seleccionado.
      setEstado('Listo');
    }
    return;
  }
  expandidos.add(id);
  if (datosManifiesto.value?.manifest.id !== id) await seleccionarManifiesto(id);
}

function pedirBorrarManifiesto(id: number, viaje: string) {
  emit('confirmar', 'Eliminar manifiesto',
    `¿Seguro que deseas eliminar el viaje <strong>${viaje}</strong> y todos sus B/L? Esta acción no se puede deshacer.`,
    async () => {
      try {
        await api.eliminarManifiesto(id);
        expandidos.delete(id);
        toast('Manifiesto eliminado');
        if (datosManifiesto.value?.manifest.id === id) {
          datosManifiesto.value = null;
          blActual.value = null;
          setEstado('Listo');
        }
        await cargarManifiestos();
      } catch (e) { toast('Error al eliminar: ' + (e as Error).message, 'err'); }
    });
}

function pedirBorrarBL(blId: number, blNo: string) {
  emit('confirmar', 'Eliminar B/L',
    `¿Seguro que deseas eliminar el B/L <strong>${blNo}</strong> de este manifiesto? Esta acción no se puede deshacer.`,
    async () => {
      try {
        await api.eliminarBL(blId);
        toast('B/L eliminado correctamente');
        const id = datosManifiesto.value?.manifest.id;
        if (id) {
          datosManifiesto.value = await api.obtenerManifiesto(id);
          const m = manifiestos.value.find(x => x.id === id);
          if (m) m.bl_count = datosManifiesto.value.bls.length;
          cargarStats();
          if (blActual.value?.id === blId) blActual.value = datosManifiesto.value.bls[0] ?? null;
        }
      } catch (e) { toast('Error eliminando B/L: ' + (e as Error).message, 'err'); }
    });
}

async function crearNuevoBL(manifestId: number) {
  const blNo = nuevoBlNo.value.trim();
  if (!blNo || creandoBl.value) return;
  creandoBl.value = true;
  try {
    const data = await api.crearBL(manifestId, blNo);
    datosManifiesto.value = await api.obtenerManifiesto(manifestId);
    const m = manifiestos.value.find(x => x.id === manifestId);
    if (m) m.bl_count = datosManifiesto.value.bls.length;
    blActual.value = datosManifiesto.value.bls.find(bl => bl.id === data.bl.id) ?? data.bl;
    nuevoBlNo.value = '';
    nuevoBlPara.value = null;
    cargarStats();
    toast('B/L creado correctamente');
  } catch (e) {
    toast('Error creando B/L: ' + (e as Error).message, 'err');
  } finally {
    creandoBl.value = false;
  }
}

// ── Mover B/L a otro viaje ──
const moviendoBl = ref<{ id: number; blNo: string; manifestId: number } | null>(null);
const destinoId = ref('');
const moviendo = ref(false);
const destinosPosibles = () => manifiestos.value.filter(m => m.id !== moviendoBl.value?.manifestId);

function pedirMoverBL(blId: number, blNo: string, manifestId: number) {
  moviendoBl.value = { id: blId, blNo, manifestId };
  destinoId.value = '';
}

async function confirmarMoverBL() {
  const info = moviendoBl.value;
  const destino = Number(destinoId.value);
  if (!info || !destino || moviendo.value) return;
  moviendo.value = true;
  try {
    await api.moverBL(info.id, destino);
    toast(`B/L ${info.blNo} movido correctamente`);
    // Refrescar el viaje de origen (perdió el B/L) y, si el destino ya
    // estaba cargado en algún otro momento, también quedaría desactualizado
    // — pero solo el origen está visible ahora mismo, así que alcanza con él.
    if (datosManifiesto.value?.manifest.id === info.manifestId) {
      datosManifiesto.value = await api.obtenerManifiesto(info.manifestId);
      if (blActual.value?.id === info.id) blActual.value = datosManifiesto.value.bls[0] ?? null;
    }
    const origen = manifiestos.value.find(m => m.id === info.manifestId);
    if (origen && origen.bl_count) origen.bl_count -= 1;
    const dest = manifiestos.value.find(m => m.id === destino);
    if (dest) dest.bl_count = (dest.bl_count || 0) + 1;
    cargarStats();
    moviendoBl.value = null;
  } catch (e) {
    let msg = (e as Error).message;
    try { msg = JSON.parse(msg).error || msg; } catch { /* texto plano */ }
    toast('Error moviendo B/L: ' + msg, 'err');
  } finally {
    moviendo.value = false;
  }
}
</script>

<template>
  <aside
    class="flex shrink-0 flex-col overflow-hidden border-border bg-paper-raised transition-[width] duration-200 ease-in-out"
    :class="abierto ? 'w-72 border-r' : 'w-0 border-r-0'"
  >
    <div class="p-2">
      <Tabs :model-value="pestana" @update:model-value="(v) => cambiarPestana(String(v))">
        <TabsList class="w-full">
          <TabsTrigger value="active" class="flex-1">En curso</TabsTrigger>
          <TabsTrigger value="completed" class="flex-1">Completados</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>

    <div class="flex items-center gap-2 border-b border-border px-3 py-2">
      <Search class="size-3.5 shrink-0 text-ink-faint" />
      <Input v-model="busqueda" placeholder="Buscar viaje o B/L..." class="h-7 border-0 px-0 shadow-none focus-visible:ring-0" @input="alBuscar" />
    </div>

    <div v-if="blsHallados.length" class="border-b border-border bg-paper">
      <p class="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">B/L encontrados</p>
      <button
        v-for="bl in blsHallados" :key="bl.id"
        class="block w-full border-b border-border px-3 py-1.5 text-left text-xs last:border-0 hover:bg-accent-soft"
        @click="irAlBL(bl.manifest_id, bl.id)"
      >
        <div class="font-medium text-accent">{{ bl.bl_no }} <span class="font-normal text-ink-muted">{{ bl.consignee_name || '' }}</span></div>
        <div class="text-ink-faint">Viaje {{ bl.voyage_no }} · {{ (bl.arrival_date || '').substring(0, 10) }}</div>
      </button>
    </div>

    <div class="flex-1 overflow-y-auto">
      <p v-if="!lista().length" class="p-5 text-center text-xs text-ink-faint">Sin manifiestos</p>

      <div v-for="m in lista()" :key="m.id">
        <div class="group border-b border-border" :class="{ 'bg-accent-soft': datosManifiesto?.manifest.id === m.id }">
          <div class="flex items-center gap-1.5 px-2 py-2">
            <button class="shrink-0 rounded p-0.5 text-ink-faint hover:bg-paper-sunken" @click="alternar(m.id)">
              <ChevronDown v-if="expandidos.has(m.id)" class="size-3.5" />
              <ChevronRight v-else class="size-3.5" />
            </button>
            <button class="min-w-0 flex-1 truncate text-left text-sm font-medium" @click="alternar(m.id)">
              Viaje {{ m.voyage_no }}
            </button>
            <StatusBadge :status="m.status" />
            <button
              class="shrink-0 rounded p-1 text-ink-faint opacity-0 hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
              title="Eliminar manifiesto"
              @click.stop="pedirBorrarManifiesto(m.id, m.voyage_no)"
            ><Trash2 class="size-3.5" /></button>
          </div>
          <button class="block w-full px-2 pb-2 pl-8 text-left text-xs text-ink-muted" @click="alternar(m.id)">
            {{ m.vessel_name || m.vessel_code || '' }} · {{ m.bl_count }} B/L
            <span class="block text-ink-faint">{{ (m.arrival_date || '').substring(0, 10) }}</span>
          </button>
        </div>

        <div v-if="expandidos.has(m.id) && datosManifiesto?.manifest.id === m.id" class="bg-paper">
          <div class="flex items-center justify-end gap-1 border-b border-border px-2 py-1.5 pl-8">
            <template v-if="nuevoBlPara === m.id">
              <Input v-model="nuevoBlNo" class="h-7 min-w-0 flex-1 text-xs" placeholder="Número de B/L" @keyup.enter="crearNuevoBL(m.id)" />
              <Button size="sm" class="h-7 px-2 text-xs" :disabled="!nuevoBlNo.trim() || creandoBl" @click="crearNuevoBL(m.id)">Crear</Button>
              <button class="rounded p-1 text-ink-faint hover:bg-paper-sunken" title="Cancelar" @click="nuevoBlPara = null; nuevoBlNo = ''"><X class="size-3.5" /></button>
            </template>
            <Button v-else size="sm" class="h-7 bg-emerald-600 px-2 text-xs text-white hover:bg-emerald-700" @click="nuevoBlPara = m.id; nuevoBlNo = ''"><Plus class="size-3.5" />Nuevo B/L</Button>
          </div>
          <button
            v-for="bl in datosManifiesto.bls" :key="bl.id"
            class="group/bl flex w-full items-center gap-2 border-b border-border py-1.5 pl-8 pr-2 text-left text-xs hover:bg-accent-soft"
            :class="blActual?.id === bl.id ? 'bg-accent-soft font-medium text-accent' : bl.status === 'validado' ? 'font-medium text-status-validated' : 'text-ink-muted'"
            @click="seleccionarBL(bl.id)"
          >
            <span class="size-1.5 shrink-0 rounded-full" :class="blActual?.id === bl.id ? 'bg-accent' : bl.status === 'validado' ? 'bg-status-validated' : 'bg-ink-faint'" />
            <span class="min-w-0 flex-1 truncate">{{ bl.bl_no }}</span>
            <button
              class="shrink-0 rounded p-0.5 text-ink-faint opacity-0 hover:bg-accent-soft hover:text-accent group-hover/bl:opacity-100"
              :title="'Mover B/L ' + bl.bl_no + ' a otro viaje'"
              @click.stop="pedirMoverBL(bl.id, bl.bl_no, m.id)"
            ><Move class="size-3" /></button>
            <button
              class="shrink-0 rounded p-0.5 text-ink-faint opacity-0 hover:bg-danger-soft hover:text-danger group-hover/bl:opacity-100"
              :title="'Eliminar B/L ' + bl.bl_no"
              @click.stop="pedirBorrarBL(bl.id, bl.bl_no)"
            ><Trash2 class="size-3" /></button>
          </button>
        </div>
      </div>
    </div>

    <Dialog :open="!!moviendoBl" @update:open="(v) => !v && (moviendoBl = null)">
      <DialogContent v-if="moviendoBl">
        <DialogHeader><DialogTitle>Mover B/L {{ moviendoBl.blNo }}</DialogTitle></DialogHeader>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-ink-muted">Viaje destino</label>
          <Select v-model="destinoId">
            <SelectTrigger class="h-9 w-full text-xs"><SelectValue placeholder="— selecciona un viaje —" /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="m in destinosPosibles()" :key="m.id" :value="String(m.id)">
                Viaje {{ m.voyage_no }} — {{ m.vessel_name || m.vessel_code || '' }}
              </SelectItem>
            </SelectContent>
          </Select>
          <p v-if="!destinosPosibles().length" class="text-xs text-ink-faint">No hay otro viaje al cual mover este B/L.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="moviendoBl = null">Cancelar</Button>
          <Button :disabled="!destinoId || moviendo" @click="confirmarMoverBL">{{ moviendo ? 'Moviendo...' : 'Mover' }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </aside>
</template>
