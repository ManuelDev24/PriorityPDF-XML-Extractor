<script setup lang="ts">
// Barra lateral: pestañas, búsqueda, lista de viajes y sus B/L.
// Markup copiado literal de frontend/js/manifests.js.
import { ref } from 'vue';
import { api, type ResultadoBusqueda } from './api';
import {
  manifiestos, manifiestosFiltrados, datosManifiesto, blActual, expandidos,
  pestana, seleccionarManifiesto, seleccionarBL, cargarManifiestos, cargarStats,
  toast,
} from './store';

const emit = defineEmits<{ confirmar: [titulo: string, cuerpo: string, accion: () => void] }>();

const busqueda   = ref('');
const blsHallados = ref<ResultadoBusqueda['bls']>([]);
const filtrados  = ref<typeof manifiestos.value | null>(null);
let temporizador: ReturnType<typeof setTimeout> | undefined;

const lista = () => filtrados.value ?? manifiestosFiltrados.value;

function cambiarPestana(p: 'active' | 'completed') {
  pestana.value = p;
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
  if (expandidos.has(id)) { expandidos.delete(id); return; }
  expandidos.add(id);
  if (datosManifiesto.value?.manifest.id !== id) await seleccionarManifiesto(id);
}

function claseBadge(status: string) {
  return status === 'siscommate' ? 'sis'
       : status === 'exportado'  ? 'exp'
       : status === 'validado'   ? 'ok' : 'pend';
}

function claseBL(bl: { id: number; status: string }) {
  if (blActual.value?.id === bl.id) return 'active';
  if (bl.status === 'validado') return 'validated';
  return '';
}

function pedirBorrarManifiesto(id: number, viaje: string) {
  emit('confirmar', 'Eliminar manifiesto',
    `<p>¿Seguro que deseas eliminar el viaje <strong>${viaje}</strong> y todos sus B/L?</p>
     <p style="margin-top:8px;font-size:12px;color:var(--danger)">Esta acción no se puede deshacer.</p>`,
    async () => {
      try {
        await api.eliminarManifiesto(id);
        expandidos.delete(id);
        toast('Manifiesto eliminado');
        if (datosManifiesto.value?.manifest.id === id) {
          datosManifiesto.value = null;
          blActual.value = null;
        }
        await cargarManifiestos();
      } catch (e) { toast('Error al eliminar: ' + (e as Error).message, 'err'); }
    });
}

function pedirBorrarBL(blId: number, blNo: string) {
  emit('confirmar', 'Eliminar B/L',
    `<p>¿Seguro que deseas eliminar el B/L <strong>${blNo}</strong> de este manifiesto?</p>
     <p style="margin-top:8px;font-size:12px;color:var(--danger)">Esta acción no se puede deshacer.</p>`,
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
          if (blActual.value?.id === blId) {
            blActual.value = datosManifiesto.value.bls[0] ?? null;
          }
        }
      } catch (e) { toast('Error eliminando B/L: ' + (e as Error).message, 'err'); }
    });
}
</script>

<template>
  <div class="sidebar">
    <div class="sidebar-tabs">
      <div class="sidebar-tab" :class="{ active: pestana === 'active' }" @click="cambiarPestana('active')">En curso</div>
      <div class="sidebar-tab" :class="{ active: pestana === 'completed' }" @click="cambiarPestana('completed')">Completados</div>
    </div>
    <div class="sidebar-search">
      <i class="ti ti-search" style="color:var(--text3);font-size:14px"></i>
      <input placeholder="Buscar viaje o B/L..." v-model="busqueda" @input="alBuscar"/>
    </div>

    <div class="bl-search-results" :style="blsHallados.length ? {} : { display: 'none' }">
      <div style="padding:4px 10px;font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">B/L encontrados</div>
      <div class="bl-search-item" v-for="bl in blsHallados" :key="bl.id" @click="irAlBL(bl.manifest_id, bl.id)">
        <div class="bsi-bl">{{ bl.bl_no }} <span style="font-weight:400;color:var(--text2)">{{ bl.consignee_name || '' }}</span></div>
        <div class="bsi-meta">Viaje {{ bl.voyage_no }} &nbsp;·&nbsp; {{ (bl.arrival_date || '').substring(0, 10) }}</div>
      </div>
    </div>

    <div class="manifest-list">
      <div v-if="!lista().length" style="padding:20px;text-align:center;color:var(--text3);font-size:12px">Sin manifiestos</div>
      <div v-else v-for="m in lista()" :key="m.id">
        <div class="manifest-item" :class="{ active: datosManifiesto?.manifest.id === m.id }">
          <div class="mi-title">
            <button class="mi-btn toggle-btn" :class="{ open: expandidos.has(m.id) }"
              :title="(expandidos.has(m.id) ? 'Colapsar' : 'Expandir') + ' lista de B/L'"
              @click="alternar(m.id)">{{ expandidos.has(m.id) ? '▼' : '▶' }}</button>
            <span style="flex:1;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
              @click="seleccionarManifiesto(m.id)">Viaje {{ m.voyage_no }}</span>
            <span class="badge" :class="claseBadge(m.status)">{{ m.status }}</span>
            <button class="mi-btn danger" title="Eliminar manifiesto"
              @click.stop="pedirBorrarManifiesto(m.id, m.voyage_no)">
              <i class="ti ti-trash"></i> Eliminar
            </button>
          </div>
          <div class="mi-sub" style="padding-left:26px;cursor:pointer" @click="seleccionarManifiesto(m.id)">
            {{ m.vessel_name || m.vessel_code || '' }} &nbsp;·&nbsp; {{ m.bl_count }} B/L
          </div>
          <div class="mi-sub" style="padding-left:26px">{{ (m.arrival_date || '').substring(0, 10) }}</div>
        </div>

        <div class="bl-list" v-if="expandidos.has(m.id) && datosManifiesto?.manifest.id === m.id">
          <div class="bl-list-item" v-for="bl in datosManifiesto.bls" :key="bl.id"
               :class="claseBL(bl)" @click="seleccionarBL(bl.id)">
            <span class="bl-dot"></span>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ bl.bl_no }}</span>
            <i v-if="bl.status === 'validado'" class="ti ti-check" style="font-size:11px;color:var(--success)"></i>
            <button class="mi-btn danger sm" style="padding:1px 5px;height:20px;font-size:10px;margin-left:4px"
              :title="'Eliminar B/L ' + bl.bl_no" @click.stop="pedirBorrarBL(bl.id, bl.bl_no)">
              <i class="ti ti-trash" style="font-size:11px"></i> Eliminar B/L
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
