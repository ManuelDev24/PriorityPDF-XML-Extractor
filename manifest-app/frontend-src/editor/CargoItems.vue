<script setup lang="ts">
// Items de carga por B/L. Con un solo contenedor es una lista simple; con
// varios, un bloque por contenedor. Markup copiado de frontend/js/cargoItems.js.
import { ref, computed, watch } from 'vue';
import { api, type ItemCarga } from './api';
import { blActual, contenedoresDelBL, toast } from './store';

const items = ref<ItemCarga[]>([]);
const cnos  = computed(() => contenedoresDelBL.value.map(c => c.container_no));
const multi = computed(() => cnos.value.length > 1);

// Modal propio de esta sección
const modalAbierto = ref(false);
const modalTitulo  = ref('');
const editandoId   = ref<number | null>(null);
const fGoods  = ref('');
const fPeso   = ref(0);
const fCodigo = ref('');
const fTarifa = ref('');
const fCont   = ref<string>('');
const contForzado = ref<string | null>(null);

async function cargar() {
  const bl = blActual.value;
  if (!bl) { items.value = []; return; }
  try { items.value = await api.listarItems(bl.id); }
  catch { items.value = []; }
}

watch(() => blActual.value?.id, cargar, { immediate: true });

/** Items de un contenedor. Los que no tienen contenedor aplican a todos. */
function itemsDe(cno: string) {
  return items.value.filter(i => i.container_no === cno);
}
const compartidos = computed(() => items.value.filter(i => !i.container_no));
const todosTienen = computed(() => cnos.value.every(c => itemsDe(c).length > 0));

async function guardarCampo(id: number, campo: keyof ItemCarga, valor: string) {
  await api.actualizarItem(id, { [campo]: valor } as Partial<ItemCarga>);
  const it = items.value.find(i => i.id === id);
  if (it) (it as Record<string, unknown>)[campo] = valor;
}

async function inicializarPorContenedor() {
  const bl = blActual.value;
  if (!bl) return;
  const existentes = new Set(items.value.map(i => i.container_no));
  const crear = cnos.value.filter(c => !existentes.has(c));
  if (!crear.length) { toast('Todos los contenedores ya tienen items'); return; }
  for (const cno of crear) {
    await api.crearItem(bl.id, {
      container_no: cno,
      goods_name: bl.goods_name || '',
      gross_weight: bl.gross_weight || 0,
      hacienda_item_code: bl.hacienda_item_code || null,
      hacienda_tariff: bl.hacienda_tariff || null,
    });
  }
  await cargar();
  toast(`${crear.length} item${crear.length > 1 ? 's' : ''} inicializado${crear.length > 1 ? 's' : ''}`);
}

function abrirAgregar(forzarCno: string | null) {
  const bl = blActual.value;
  modalTitulo.value = 'Agregar item de carga';
  editandoId.value = null;
  contForzado.value = forzarCno;
  fGoods.value  = bl?.goods_name || '';
  fPeso.value   = Number(bl?.gross_weight) || 0;
  fCodigo.value = bl?.hacienda_item_code || '';
  fTarifa.value = bl?.hacienda_tariff || '';
  fCont.value   = forzarCno ?? '';
  modalAbierto.value = true;
}

function abrirEditar(id: number) {
  const it = items.value.find(i => i.id === id);
  if (!it) return;
  modalTitulo.value = 'Editar item';
  editandoId.value = id;
  contForzado.value = null;
  fGoods.value  = it.goods_name;
  fPeso.value   = Number(it.gross_weight) || 0;
  fCodigo.value = it.hacienda_item_code || '';
  fTarifa.value = it.hacienda_tariff || '';
  modalAbierto.value = true;
}

async function guardarModal() {
  const bl = blActual.value;
  if (!bl) return;
  if (!fGoods.value.trim()) { toast('La descripción es requerida', 'err'); return; }
  try {
    if (editandoId.value !== null) {
      await api.actualizarItem(editandoId.value, {
        goods_name: fGoods.value.trim(), gross_weight: fPeso.value,
        hacienda_item_code: fCodigo.value.trim() || null, hacienda_tariff: fTarifa.value || null,
      });
      toast('Item actualizado');
    } else {
      await api.crearItem(bl.id, {
        goods_name: fGoods.value.trim(), gross_weight: fPeso.value,
        hacienda_item_code: fCodigo.value.trim() || null, hacienda_tariff: fTarifa.value || null,
        container_no: fCont.value || null,
      });
      toast('Item agregado');
    }
    modalAbierto.value = false;
    await cargar();
  } catch (e) { toast((e as Error).message || 'Error', 'err'); }
}

async function eliminar(id: number) {
  if (!confirm('¿Eliminar este item?')) return;
  await api.eliminarItem(id);
  await cargar();
  toast('Item eliminado');
}
</script>

<template>
  <!-- ── Un solo contenedor (o ninguno): lista libre ── -->
  <template v-if="!multi">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px">Items de carga</span>
      <span v-if="items.length" style="padding:1px 7px;border-radius:20px;font-size:10px;font-weight:600;background:var(--accent-bg);color:var(--accent);border:1px solid #aac8f0">{{ items.length }} item{{ items.length > 1 ? 's' : '' }}</span>
      <span style="font-size:10px;color:var(--text3);flex:1">Si hay items, reemplazan la descripción general en el TXT</span>
      <button class="btn sm accent" @click="abrirAgregar(null)">+ Agregar item</button>
    </div>
    <div id="ci-single-list" style="display:flex;flex-direction:column;gap:6px">
      <template v-if="items.length">
        <div v-for="item in items" :key="item.id"
             style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);font-size:12px">
          <div style="flex:1;min-width:0">
            <div style="font-weight:600">{{ item.goods_name }}</div>
            <div style="font-size:10px;color:var(--text3);margin-top:3px;display:flex;gap:10px;flex-wrap:wrap">
              <span>Peso: <b>{{ item.gross_weight || 0 }} kg</b></span>
              <span>Código: <b>{{ item.hacienda_item_code || '—' }}</b></span>
              <span>Tarifa: <b>{{ item.hacienda_tariff || '—' }}</b></span>
            </div>
          </div>
          <button class="btn sm" @click="abrirEditar(item.id)" title="Editar">✏</button>
          <button class="btn sm danger" @click="eliminar(item.id)" title="Eliminar">✕</button>
        </div>
      </template>
      <div v-else style="font-size:11px;color:var(--text3);padding:4px 0">Sin items adicionales — se usa la descripción general del B/L</div>
    </div>
  </template>

  <!-- ── Varios contenedores: un bloque por contenedor ── -->
  <template v-else>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px">Carga por contenedor</span>
      <span v-if="items.length" style="padding:1px 7px;border-radius:20px;font-size:10px;font-weight:600;background:var(--accent-bg);color:var(--accent);border:1px solid #aac8f0">{{ items.length }} item{{ items.length > 1 ? 's' : '' }}</span>
      <span style="font-size:10px;color:var(--text3);flex:1">Cada contenedor puede tener descripción, peso y código distintos</span>
      <button v-if="!todosTienen" class="btn sm" title="Crear un item inicial por contenedor con los datos del B/L" @click="inicializarPorContenedor">⚡ Inicializar por contenedor</button>
    </div>

    <div v-for="cno in cnos" :key="cno" style="border:1px solid var(--border);border-radius:var(--radius);margin-bottom:8px;overflow:hidden">
      <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--surface2);border-bottom:1px solid var(--border)">
        <span v-if="itemsDe(cno).length" style="width:7px;height:7px;border-radius:50%;background:#2cb67d;display:inline-block;flex-shrink:0"></span>
        <span v-else style="width:7px;height:7px;border-radius:50%;background:#e0c060;display:inline-block;flex-shrink:0" title="Usando descripción del B/L"></span>
        <span style="font-family:monospace;font-size:12px;font-weight:700;color:var(--accent)">{{ cno }}</span>
        <span style="font-size:10px;color:var(--text3);flex:1">{{ itemsDe(cno).length ? itemsDe(cno).length + ' item(s) propios' : 'usando descripción general del B/L' }}</span>
        <button class="btn sm accent" @click="abrirAgregar(cno)">+ Item</button>
      </div>
      <table v-if="itemsDe(cno).length" style="width:100%;border-collapse:collapse">
        <thead><tr style="background:var(--surface3)">
          <th style="padding:4px 8px;text-align:left;font-size:10px;color:var(--text3);font-weight:600">Descripción</th>
          <th style="padding:4px 8px;text-align:left;font-size:10px;color:var(--text3);font-weight:600">Peso (kg)</th>
          <th style="padding:4px 8px;text-align:left;font-size:10px;color:var(--text3);font-weight:600">Código aranc.</th>
          <th style="padding:4px 8px;text-align:left;font-size:10px;color:var(--text3);font-weight:600">Tarifa</th>
          <th style="padding:4px 8px"></th>
        </tr></thead>
        <tbody>
          <tr v-for="item in itemsDe(cno)" :key="item.id">
            <td style="padding:5px 8px;vertical-align:top">
              <textarea rows="2" style="width:100%;padding:4px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px;resize:vertical;min-width:200px"
                :value="item.goods_name" @change="guardarCampo(item.id,'goods_name',($event.target as HTMLTextAreaElement).value)"></textarea>
            </td>
            <td style="padding:5px 8px;white-space:nowrap">
              <input type="number" step="0.01" style="width:90px;padding:4px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px"
                :value="item.gross_weight || 0" @change="guardarCampo(item.id,'gross_weight',($event.target as HTMLInputElement).value)"/>
            </td>
            <td style="padding:5px 8px">
              <input type="text" placeholder="código" style="width:120px;padding:4px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px;font-family:monospace"
                :value="item.hacienda_item_code || ''" @change="guardarCampo(item.id,'hacienda_item_code',($event.target as HTMLInputElement).value)"/>
            </td>
            <td style="padding:5px 8px">
              <select style="padding:4px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px"
                :value="item.hacienda_tariff || ''" @change="guardarCampo(item.id,'hacienda_tariff',($event.target as HTMLSelectElement).value)">
                <option value="">—</option>
                <option value="040">040</option>
                <option value="045">045</option>
              </select>
            </td>
            <td style="padding:5px 8px">
              <button class="btn sm danger" @click="eliminar(item.id)" title="Eliminar">✕</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>

  <!-- Modal de agregar / editar item -->
  <div v-if="modalAbierto" class="modal-overlay" @click.self="modalAbierto = false">
    <div class="modal" style="max-width:580px;width:90%">
      <h3 style="margin-bottom:16px">{{ modalTitulo }}</h3>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="field">
          <label>Descripción de mercancía <span style="color:var(--danger)">*</span></label>
          <textarea rows="3" style="padding:5px 8px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px;resize:vertical" v-model="fGoods"></textarea>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <div class="field" style="flex:1;min-width:120px">
            <label>Peso bruto (kg)</label>
            <input type="number" step="0.01" style="padding:5px 9px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px;width:100%" v-model.number="fPeso"/>
          </div>
          <div class="field" style="flex:1;min-width:120px">
            <label>Código arancelario</label>
            <input type="text" style="padding:5px 9px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px;width:100%;font-family:monospace" v-model="fCodigo"/>
          </div>
          <div class="field" style="width:80px">
            <label>Tarifa</label>
            <select style="padding:5px 9px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px;width:100%" v-model="fTarifa">
              <option value="">—</option>
              <option value="040">040</option>
              <option value="045">045</option>
            </select>
          </div>
        </div>
        <div class="field" v-if="multi && editandoId === null">
          <label>Contenedor</label>
          <select style="padding:5px 9px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px;width:100%" v-model="fCont">
            <option v-if="!contForzado" value="">Todos los contenedores</option>
            <option v-for="c in cnos" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" @click="modalAbierto = false">Cancelar</button>
        <button class="btn accent" @click="guardarModal">Guardar</button>
      </div>
    </div>
  </div>
</template>
