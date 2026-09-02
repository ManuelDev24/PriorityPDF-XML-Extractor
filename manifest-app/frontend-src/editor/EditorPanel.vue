<script setup lang="ts">
// Editor del B/L. Markup copiado literal de frontend/js/editor.js: mismas
// etiquetas, mismas clases, los style= en linea intactos.
import { ref, computed, watch } from 'vue';
import { api, type ItemHacienda, type Cliente } from './api';
import {
  datosManifiesto, blActual, carriers, puertos, buques, contenedoresDelBL,
  actualizarBL, actualizarManifiesto, setEstado, toast,
} from './store';
import CargoItems from './CargoItems.vue';

const emit = defineEmits<{
  vistaPrevia: [blId: number];
  crearCliente: [prefill: string];
  editarCliente: [id: number, ss: string, nombre: string];
}>();

const m  = computed(() => datosManifiesto.value!.manifest);
const bl = computed(() => blActual.value!);

const PAISES: Record<string, string> = {
  PR:'Puerto Rico', DO:'Rep. Dominicana', US:'Estados Unidos', VI:'Islas Vírgenes (US)',
  VG:'Islas Vírgenes (UK)', SX:'St. Maarten', MF:'St. Martin', KN:'Saint Kitts',
  AG:'Antigua', MX:'México', CN:'China',
};

const paises = computed(() => [...new Set(puertos.value.map(p => p.country))]);
const puertosDe = (pais: string) => puertos.value.filter(p => p.country === pais);

// El desplegable de puerto cae a un valor por defecto cuando el manifiesto no
// trae ninguno, igual que antes.
const puertoOrigen  = computed({
  get: () => m.value.loading_port || 'DRP',
  set: (v: string) => actualizarManifiesto('loading_port', v),
});
const puertoDestino = computed({
  get: () => m.value.unloading_port || 'XSJ',
  set: (v: string) => actualizarManifiesto('unloading_port', v),
});

// Tarifa: por defecto 040 en pantalla, sin persistirlo solo. Igual que antes.
const tarifa = computed({
  get: () => bl.value.hacienda_tariff || '040',
  set: (v: string) => actualizarBL('hacienda_tariff', v),
});
const libreArancel = computed(() => tarifa.value !== '045');

const contenedorHacienda = computed(() =>
  bl.value.hacienda_container_no || contenedoresDelBL.value[0]?.container_no || ''
);

function imoDelBuque(code: string) { return buques.value.find(v => v.code === code)?.imo ?? ''; }

function alCambiarBuque(code: string) {
  const v = buques.value.find(b => b.code === code);
  if (!v) return;
  // Cuatro campos de golpe: el store los acumula y los manda en un solo PUT.
  actualizarManifiesto('vessel_code', code);
  actualizarManifiesto('vessel_name', v.name);
  actualizarManifiesto('imo', v.imo);
  actualizarManifiesto('carrier_code', v.carrier);
}

function alCambiarDocking(valor: string) {
  actualizarManifiesto('docking_number', valor.replace(/[^0-9]/g, ''));
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

async function marcar(estado: 'validado' | 'pendiente') {
  try {
    await api.actualizarBL(bl.value.id, { status: estado });
    bl.value.status = estado;
    toast(estado === 'validado' ? 'B/L marcado como validado' : 'B/L regresado a pendiente');
  } catch { toast('Error', 'err'); }
}

// ── Autocomplete: código arancelario ─────────────────────────────────────────
const itemsHallados = ref<ItemHacienda[]>([]);
const itemAbierto   = ref(false);
const descItem      = ref('');
const sugerencias   = ref<ItemHacienda[]>([]);
let tItem: ReturnType<typeof setTimeout> | undefined;
let tSugerir: ReturnType<typeof setTimeout> | undefined;

function buscarItem(q: string) {
  actualizarBL('hacienda_item_code', q);
  clearTimeout(tItem);
  if (!q || q.length < 2) { itemAbierto.value = false; return; }
  tItem = setTimeout(async () => {
    try {
      itemsHallados.value = await api.buscarItems(q);
      itemAbierto.value = itemsHallados.value.length > 0;
    } catch { itemAbierto.value = false; }
  }, 200);
}

function elegirItem(it: ItemHacienda) {
  actualizarBL('hacienda_item_code', it.code);
  itemAbierto.value = false;
  sugerencias.value = [];
  descItem.value = it.description;
}

async function cargarDescItem(code: string) {
  if (!code) { descItem.value = ''; return; }
  try {
    const items = await api.buscarItems(code);
    descItem.value = items.find(i => i.code === code)?.description ?? '';
  } catch { /* sin descripción */ }
}

async function sugerir(desc: string) {
  if (!desc || desc.length < 5) return;
  if (bl.value.hacienda_item_code) return;   // ya tiene código
  try {
    const items = await api.sugerirItems(desc);
    sugerencias.value = items.slice(0, 6);
  } catch { /* sin sugerencias */ }
}

function alCambiarDescripcion(valor: string) {
  actualizarBL('goods_name', valor);
  clearTimeout(tSugerir);
  tSugerir = setTimeout(() => sugerir(valor), 800);
}

// ── Autocomplete: consignatario ──────────────────────────────────────────────
const clientesHallados = ref<Cliente[]>([]);
const clienteAbierto   = ref(false);
const nombreCliente    = ref('');
const clienteId        = ref<number | null>(null);
const ultimaBusquedaCliente = ref('');
let tCliente: ReturnType<typeof setTimeout> | undefined;

function buscarCliente(q: string) {
  actualizarBL('hacienda_client_ss', q);
  ultimaBusquedaCliente.value = q;
  clearTimeout(tCliente);
  if (!q || q.length < 2) { clienteAbierto.value = false; return; }
  tCliente = setTimeout(async () => {
    try {
      clientesHallados.value = await api.buscarClientes(q);
      clienteAbierto.value = true;   // siempre, por la opción de crear nuevo
    } catch { clienteAbierto.value = false; }
  }, 200);
}

function elegirCliente(c: Cliente) {
  actualizarBL('hacienda_client_ss', c.ss);
  clienteAbierto.value = false;
  nombreCliente.value = c.name;
  clienteId.value = c.id;
  if (c.ivu && !bl.value.hacienda_client_ivu) actualizarBL('hacienda_client_ivu', c.ivu);
}

/** Lo llama App.vue tras crear o editar un consignatario en el modal. */
function aplicarCliente(c: Cliente) { elegirCliente(c); }
defineExpose({ aplicarCliente });

// Al cambiar de B/L, recargar la descripción del código y limpiar lo volátil.
watch(() => bl.value?.id, () => {
  itemAbierto.value = false;
  clienteAbierto.value = false;
  sugerencias.value = [];
  nombreCliente.value = '';
  clienteId.value = null;
  descItem.value = '';
  if (bl.value?.hacienda_item_code) cargarDescItem(bl.value.hacienda_item_code);
  else if (bl.value?.goods_name) sugerir(bl.value.goods_name);
}, { immediate: true });
</script>

<template>
  <!-- ── MANIFIESTO ──────────────────────────────── -->
  <div class="card">
    <div class="card-hdr"><i class="ti ti-ship"></i> Manifiesto — Viaje {{ m.voyage_no }}
      <span class="badge" :class="m.status === 'siscommate' ? 'sis' : m.status === 'exportado' ? 'exp' : 'pend'" style="margin-left:auto">{{ m.status }}</span>
    </div>
    <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
      <div class="fg fg3">
        <div class="field" style="grid-column:1/3">
          <label>Buque</label>
          <select :value="m.vessel_code" @change="alCambiarBuque(($event.target as HTMLSelectElement).value)">
            <option value="">— selecciona —</option>
            <option v-for="v in buques" :key="v.code" :value="v.code">{{ v.name }} — IMO {{ v.imo }}</option>
          </select>
        </div>
        <div class="field">
          <label>IMO</label>
          <input id="f-imo" :value="m.imo || imoDelBuque(m.vessel_code) || ''" placeholder="Número IMO"
            @change="actualizarManifiesto('imo', ($event.target as HTMLInputElement).value)"/>
        </div>
      </div>
      <div class="fg fg2">
        <div class="field">
          <label>Carrier Hacienda PR</label>
          <select :value="m.carrier_code || 'MPRIORO'" @change="actualizarManifiesto('carrier_code', ($event.target as HTMLSelectElement).value)">
            <option v-for="c in carriers" :key="c.code" :value="c.code">{{ c.name }} ({{ c.scac }})</option>
          </select>
        </div>
        <div class="field">
          <label>No. manifiesto Hacienda <span style="color:var(--danger)">*</span></label>
          <input :value="m.manifest_no || ''" placeholder="ej. 3309468"
            :style="m.manifest_no ? '' : 'border-color:#e6a840;background:#fffcf2'"
            @change="actualizarManifiesto('manifest_no', ($event.target as HTMLInputElement).value)"/>
        </div>
        <div class="field">
          <label>Docking Number <span style="color:var(--danger)">*</span></label>
          <input id="f-docking" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="8"
            :value="m.docking_number || ''" placeholder="ej. 20262342"
            :style="(m.docking_number ? '' : 'border-color:#e6a840;background:#fffcf2;') + 'font-family:monospace'"
            @input="($event.target as HTMLInputElement).value = ($event.target as HTMLInputElement).value.replace(/[^0-9]/g,'')"
            @change="alCambiarDocking(($event.target as HTMLInputElement).value)"/>
          <div class="hint">Número de atraque — requerido en el TXT encabezado [165:173]</div>
        </div>
      </div>
      <div class="fg fg2">
        <div class="field">
          <label>Puerto origen (DGA)</label>
          <select v-model="puertoOrigen">
            <optgroup v-for="pais in paises" :key="pais" :label="PAISES[pais] || pais">
              <option v-for="p in puertosDe(pais)" :key="p.code" :value="p.code">{{ p.code }} — {{ p.description }}</option>
            </optgroup>
          </select>
        </div>
        <div class="field">
          <label>Puerto destino (PR)</label>
          <select v-model="puertoDestino">
            <optgroup v-for="pais in paises" :key="pais" :label="PAISES[pais] || pais">
              <option v-for="p in puertosDe(pais)" :key="p.code" :value="p.code">{{ p.code }} — {{ p.description }}</option>
            </optgroup>
          </select>
        </div>
      </div>
      <div class="fg fg2">
        <div class="field">
          <label>Fecha salida</label>
          <input type="date" :value="(m.departure_date || '').substring(0,10)"
            @change="actualizarManifiesto('departure_date', ($event.target as HTMLInputElement).value)"/>
        </div>
        <div class="field">
          <label>Fecha llegada</label>
          <input type="date" :value="(m.arrival_date || '').substring(0,10)"
            @change="actualizarManifiesto('arrival_date', ($event.target as HTMLInputElement).value)"/>
        </div>
      </div>
    </div>
  </div>

  <!-- ── B/L HEADER ────────────────────────────────── -->
  <div style="display:flex;align-items:center;gap:8px;margin:0 1px">
    <h2 style="font-size:14px;font-weight:700">{{ bl.bl_no }}</h2>
    <span class="badge" :class="bl.status === 'validado' ? 'ok' : 'pend'">{{ bl.status }}</span>
    <span class="spacer"></span>
    <button v-if="bl.status === 'validado'" class="btn sm danger" @click="marcar('pendiente')"><i class="ti ti-x"></i> Desvalidar</button>
    <button v-else class="btn sm success" @click="marcar('validado')"><i class="ti ti-check"></i> Validado</button>
    <button class="btn sm" @click="emit('vistaPrevia', bl.id)"><i class="ti ti-eye"></i> Ver TXT</button>
  </div>

  <!-- ── HACIENDA PR ──────────────────────────────── -->
  <div class="card warn-card" id="hac-card">
    <div class="card-hdr"><i class="ti ti-building-bank"></i> Hacienda PR — campos requeridos para el TXT</div>
    <div class="card-body" style="display:flex;flex-direction:column;gap:12px">

      <div class="fg fg3">
        <div style="grid-column:1/3;display:flex;flex-direction:column;gap:4px">
          <div :class="['field', bl.hacienda_item_code ? 'f-ok' : 'f-warn', 'ac-wrap']">
            <label>Código arancelario — Items Hacienda <span style="color:var(--danger)">*</span></label>
            <input id="f-item-code" :value="bl.hacienda_item_code || ''" autocomplete="off"
              placeholder="Buscar por código o descripción..."
              @input="buscarItem(($event.target as HTMLInputElement).value)"/>
            <div class="ac-drop" :style="itemAbierto ? { display:'block', position:'absolute', top:'100%', left:'0', width:'100%' } : { display:'none' }">
              <div class="ac-item" v-for="it in itemsHallados" :key="it.code" @click="elegirItem(it)">
                <span class="ac-name">{{ it.description }}</span>
                <span class="ac-code">{{ it.code }}</span>
                <span v-if="it.taxable" class="ac-badge">tributable</span>
              </div>
            </div>
          </div>
          <div id="item-desc-hint" class="hint" style="color:var(--success);font-size:11px">{{ descItem }}</div>
        </div>
        <div class="field f-ok">
          <label>Tarifa (arbitrio)</label>
          <select id="f-tariff" v-model="tarifa">
            <option value="040">040 — Libre arancel</option>
            <option value="045">045 — Carga general</option>
          </select>
          <div class="hint" id="tariff-hint">{{ libreArancel ? 'Libre arancel — valor FOB será 0 en el TXT' : 'Aplica arbitrio — incluye valor FOB' }}</div>
        </div>
      </div>

      <div id="suggest-area" :style="sugerencias.length ? {} : { display: 'none' }">
        <div class="suggest-box" v-if="sugerencias.length">
          <i class="ti ti-bulb"></i>
          <div class="suggest-content">
            <div class="suggest-title">Códigos sugeridos para: <i>"{{ (bl.goods_name || '').substring(0,60) }}"</i></div>
            <div class="suggest-items">
              <div class="suggest-chip" v-for="it in sugerencias" :key="it.code" @click="elegirItem(it)">
                <span class="sc-code">{{ it.code }}</span>
                <span>{{ it.description.substring(0,35) }}{{ it.description.length > 35 ? '…' : '' }}</span>
              </div>
            </div>
            <div style="font-size:10px;color:var(--text3);margin-top:6px">Haz clic para seleccionar, o escribe en el campo para buscar manualmente</div>
          </div>
        </div>
      </div>

      <div class="fg fg3">
        <div :class="['field', bl.hacienda_client_ss ? 'f-ok' : 'f-warn', 'ac-wrap']">
          <label>SS / EIN consignatario (Hacienda) <span style="color:var(--danger)">*</span></label>
          <input id="f-client-ss" :value="bl.hacienda_client_ss || bl.consignee_document_no || ''" autocomplete="off"
            placeholder="Buscar por nombre o EIN..."
            @input="buscarCliente(($event.target as HTMLInputElement).value)"/>
          <div class="ac-drop" :style="clienteAbierto ? { display:'block', position:'absolute', top:'100%', left:'0', width:'100%' } : { display:'none' }">
            <template v-if="clienteAbierto">
            <div class="ac-item" v-for="c in clientesHallados" :key="c.id" @click="elegirCliente(c)">
              <span class="ac-name">{{ c.name }}</span>
              <span class="ac-code">{{ c.ss || '—' }}</span>
            </div>
            <div class="ac-item" style="border-top:2px solid var(--border);background:var(--accent-bg)"
                 @click="clienteAbierto = false; emit('crearCliente', ultimaBusquedaCliente)">
              <span class="ac-name" style="color:var(--accent);font-weight:600">
                <i class="ti ti-user-plus"></i> Crear nuevo consignatario&hellip;
              </span>
            </div>
            </template>
          </div>
          <div class="hint" v-if="nombreCliente">
            <i class="ti ti-check" style="color:var(--success)"></i> {{ nombreCliente }}
            <button style="margin-left:6px;background:none;border:none;color:var(--accent);cursor:pointer;font-size:11px;padding:0"
              @click="emit('editarCliente', clienteId || 0, bl.hacienda_client_ss || '', nombreCliente)">Editar</button>
          </div>
        </div>
        <div class="field">
          <label>IVU / No. comerciante consignatario</label>
          <input id="f-client-ivu" :value="bl.hacienda_client_ivu || ''" placeholder="ej. 01406530016" maxlength="11"
            @input="($event.target as HTMLInputElement).value = ($event.target as HTMLInputElement).value.replace(/[^0-9]/g,'')"
            @change="actualizarBL('hacienda_client_ivu', ($event.target as HTMLInputElement).value)"/>
          <div class="hint">Requerido por Hacienda — si el consignatario no tiene IVU, se usa el del carrier</div>
        </div>
        <div class="field">
          <label>Notas internas</label>
          <input :value="bl.notes || ''" placeholder="Observaciones..."
            @change="actualizarBL('notes', ($event.target as HTMLInputElement).value)"/>
        </div>
      </div>

      <div class="field">
        <label>No. contenedor (Hacienda)</label>
        <input :value="contenedorHacienda" placeholder="ej. TCKU1234567"
          @change="actualizarBL('hacienda_container_no', ($event.target as HTMLInputElement).value)"/>
        <template v-if="contenedoresDelBL.length > 0">
          <div style="display:flex;flex-direction:column;gap:5px;margin-top:6px">
            <div style="display:flex;align-items:center;gap:8px" v-for="c in contenedoresDelBL" :key="c.container_no">
              <span class="cont-chip" style="cursor:pointer" title="Usar este contenedor en el campo Hacienda"
                @click="actualizarBL('hacienda_container_no', c.container_no)">{{ c.container_no }}</span>
              <select :style="'font-size:11px;padding:3px 6px;border-radius:5px;background:var(--surface);' + (c.size ? 'border:1px solid var(--border)' : 'border:1px solid var(--danger);background:#fff5f5')"
                :disabled="!c.id" :value="c.size"
                @change="alCambiarTamano(c.id, ($event.target as HTMLSelectElement).value)">
                <option value="">— tamaño (requerido) —</option>
                <option value="20">20'</option>
                <option value="40">40'</option>
                <option value="40HC">40' HC</option>
                <option value="45">45'</option>
                <option value="53">53'</option>
              </select>
              <span class="badge" style="font-size:10px">Tipo: R (RORO)</span>
            </div>
          </div>
          <div class="hint">Tamaño requerido por SISCOMMATE (BOLCONT) — selecciona por contenedor. Tipo de equipo fijo en RORO (R).</div>
        </template>
      </div>
    </div>
  </div>

  <!-- ── CARGA ────────────────────────────────────── -->
  <div class="card">
    <div class="card-hdr"><i class="ti ti-package"></i> Carga</div>
    <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
      <div class="fg fg3">
        <div class="field">
          <label>Cantidad bultos</label>
          <input type="number" :value="bl.package_qty || 0" @change="actualizarBL('package_qty', ($event.target as HTMLInputElement).value)"/>
        </div>
        <div class="field">
          <label>Peso bruto (kg)</label>
          <input type="number" step="0.01" :value="bl.gross_weight || 0" @change="actualizarBL('gross_weight', ($event.target as HTMLInputElement).value)"/>
        </div>
        <div class="field">
          <label>Valor FOB (USD)</label>
          <input id="f-fob" type="number" step="0.01" :value="bl.value || 0"
            :style="libreArancel ? 'opacity:.5' : ''"
            :title="libreArancel ? '040 Libre arancel — se fuerza a 0 en el TXT' : ''"
            @change="actualizarBL('value', ($event.target as HTMLInputElement).value)"/>
        </div>
      </div>
      <div class="field">
        <label>Descripción de mercancía (DGA) — máx. 121 caracteres en TXT</label>
        <textarea id="f-goods-name" style="min-height:60px" :value="bl.goods_name || ''"
          @input="alCambiarDescripcion(($event.target as HTMLTextAreaElement).value)"></textarea>
        <div class="hint" id="goods-char-count" :style="(bl.goods_name || '').length > 121 ? 'color:var(--danger)' : 'color:var(--text3)'">{{ (bl.goods_name || '').length }}/121 caracteres</div>
      </div>
      <div class="fg fg2">
        <div class="field">
          <label>Puerto descarga (DGA)</label>
          <input :value="bl.unloading_port_code || ''" @change="actualizarBL('unloading_port_code', ($event.target as HTMLInputElement).value)"/>
        </div>
        <div class="field">
          <label>Código empaque (DGA)</label>
          <input :value="bl.package_unit_code || ''" @change="actualizarBL('package_unit_code', ($event.target as HTMLInputElement).value)"/>
        </div>
      </div>

      <div id="cargo-section" style="border-top:1px solid var(--border);padding-top:12px">
        <CargoItems/>
      </div>
    </div>
  </div>

  <!-- ── CONSIGNADOR ──────────────────────────────── -->
  <div class="card">
    <div class="card-hdr"><span class="tag ship"><i class="ti ti-building-factory2"></i> Consignador</span> — Shipper (República Dominicana)</div>
    <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
      <div class="fg fg2">
        <div class="field fspan"><label>Nombre / Razón social</label><input :value="bl.consignor_name || ''" @change="actualizarBL('consignor_name', ($event.target as HTMLInputElement).value)"/></div>
        <div class="field"><label>No. documento (RNC / Cédula)</label><input :value="bl.consignor_document_no || ''" @change="actualizarBL('consignor_document_no', ($event.target as HTMLInputElement).value)"/></div>
        <div class="field"><label>Tipo documento</label><input :value="bl.consignor_document_type || ''" @change="actualizarBL('consignor_document_type', ($event.target as HTMLInputElement).value)"/></div>
      </div>
      <div class="fg fg3">
        <div class="field fspan"><label>Dirección</label><input :value="bl.consignor_street || ''" @change="actualizarBL('consignor_street', ($event.target as HTMLInputElement).value)"/></div>
        <div class="field"><label>Ciudad</label><input :value="bl.consignor_city || ''" @change="actualizarBL('consignor_city', ($event.target as HTMLInputElement).value)"/></div>
        <div class="field"><label>Teléfono</label><input :value="bl.consignor_tel || ''" @change="actualizarBL('consignor_tel', ($event.target as HTMLInputElement).value)"/></div>
        <div class="field"><label>Email</label><input :value="bl.consignor_email || ''" @change="actualizarBL('consignor_email', ($event.target as HTMLInputElement).value)"/></div>
      </div>
    </div>
  </div>

  <!-- ── CONSIGNATARIO ─────────────────────────────── -->
  <div class="card">
    <div class="card-hdr"><span class="tag cons"><i class="ti ti-home-2"></i> Consignatario</span> — Consignee (Puerto Rico)</div>
    <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
      <div class="fg fg2">
        <div class="field fspan"><label>Nombre / Razón social</label><input :value="bl.consignee_name || ''" @change="actualizarBL('consignee_name', ($event.target as HTMLInputElement).value)"/></div>
        <div class="field"><label>EIN / SS (Puerto Rico)</label><input :value="bl.consignee_document_no || ''" @change="actualizarBL('consignee_document_no', ($event.target as HTMLInputElement).value)"/></div>
        <div class="field"><label>Teléfono</label><input :value="bl.consignee_tel || ''" @change="actualizarBL('consignee_tel', ($event.target as HTMLInputElement).value)"/></div>
      </div>
      <div class="fg fg3">
        <div class="field fspan"><label>Dirección</label><input :value="bl.consignee_street || ''" @change="actualizarBL('consignee_street', ($event.target as HTMLInputElement).value)"/></div>
        <div class="field"><label>Ciudad</label><input :value="bl.consignee_city || ''" @change="actualizarBL('consignee_city', ($event.target as HTMLInputElement).value)"/></div>
        <div class="field"><label>Zip code</label><input :value="bl.consignee_zip || ''" @change="actualizarBL('consignee_zip', ($event.target as HTMLInputElement).value)"/></div>
        <div class="field"><label>Email</label><input :value="bl.consignee_email || ''" @change="actualizarBL('consignee_email', ($event.target as HTMLInputElement).value)"/></div>
      </div>
    </div>
  </div>
</template>
