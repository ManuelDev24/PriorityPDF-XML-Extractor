<script setup lang="ts">
// Misma lógica que frontend-src/editor/CargoItems.vue. Cambia la presentación:
// Table de shadcn para el modo multi-contenedor, Dialog para agregar/editar.
import { ref, computed, watch } from 'vue';
import { api, type ItemCarga } from '../editor/api';
import { blActual, contenedoresDelBL, toast } from '../editor/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Pencil, Trash2, Zap } from '@lucide/vue';

// El Select de reka-ui reserva value="" para "sin selección" — usarlo en un
// SelectItem tira "Unhandled error during execution of setup function" en
// cuanto el diálogo se monta. TODOS_LOS_CONTENEDORES es el valor real que
// representa esa opción; se traduce a null al guardar (ver guardarModal).
const TODOS_LOS_CONTENEDORES = '__todos__';

const items = ref<ItemCarga[]>([]);
const cnos = computed(() => contenedoresDelBL.value.map(c => c.container_no));
const multi = computed(() => cnos.value.length > 1);

const modalAbierto = ref(false);
const modalTitulo = ref('');
const editandoId = ref<number | null>(null);
const fGoods = ref(''); const fCantidad = ref(0); const fPeso = ref(0); const fCodigo = ref(''); const fTarifa = ref('');
const fCont = ref(''); const contForzado = ref<string | null>(null);

async function cargar() {
  const bl = blActual.value;
  if (!bl) { items.value = []; return; }
  try { items.value = await api.listarItems(bl.id); } catch { items.value = []; }
}
watch(() => blActual.value?.id, cargar, { immediate: true });

function itemsDe(cno: string) { return items.value.filter(i => i.container_no === cno); }
function amountDe(cno: string) { return contenedoresDelBL.value.find(c => c.container_no === cno)?.amount || 0; }
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
    // La cantidad de bultos por contenedor viene del XML/PDF (containers.amount);
    // si el contenedor no trae ese dato, se usa la cantidad general del B/L.
    const contenedor = contenedoresDelBL.value.find(c => c.container_no === cno);
    await api.crearItem(bl.id, {
      container_no: cno, goods_name: bl.goods_name || '', gross_weight: bl.gross_weight || 0,
      hacienda_item_code: bl.hacienda_item_code || null, hacienda_tariff: bl.hacienda_tariff || null,
      package_qty: contenedor?.amount || Number(bl.package_qty) || 0,
    });
  }
  await cargar();
  toast(`${crear.length} item${crear.length > 1 ? 's' : ''} inicializado${crear.length > 1 ? 's' : ''}`);
}

function abrirAgregar(forzarCno: string | null) {
  const bl = blActual.value;
  modalTitulo.value = 'Agregar item de carga'; editandoId.value = null; contForzado.value = forzarCno;
  // Cantidad: se precarga desde el contenedor elegido (dato del XML/PDF) y,
  // si no aplica (sin contenedor forzado o sin dato), desde el B/L.
  const contenedor = forzarCno ? contenedoresDelBL.value.find(c => c.container_no === forzarCno) : null;
  fCantidad.value = contenedor?.amount || Number(bl?.package_qty) || 0;
  fGoods.value = bl?.goods_name || ''; fPeso.value = Number(bl?.gross_weight) || 0;
  fCodigo.value = bl?.hacienda_item_code || ''; fTarifa.value = bl?.hacienda_tariff || ''; fCont.value = forzarCno ?? TODOS_LOS_CONTENEDORES;
  modalAbierto.value = true;
}
function abrirEditar(id: number) {
  const it = items.value.find(i => i.id === id);
  if (!it) return;
  modalTitulo.value = 'Editar item'; editandoId.value = id; contForzado.value = null;
  fCantidad.value = Number(it.package_qty) || 0;
  fGoods.value = it.goods_name; fPeso.value = Number(it.gross_weight) || 0;
  fCodigo.value = it.hacienda_item_code || ''; fTarifa.value = it.hacienda_tariff || '';
  modalAbierto.value = true;
}
async function guardarModal() {
  const bl = blActual.value;
  if (!bl || !fGoods.value.trim()) { toast('La descripción es requerida', 'err'); return; }
  try {
    if (editandoId.value !== null) {
      await api.actualizarItem(editandoId.value, { goods_name: fGoods.value.trim(), package_qty: fCantidad.value, gross_weight: fPeso.value, hacienda_item_code: fCodigo.value.trim() || null, hacienda_tariff: fTarifa.value || null });
      toast('Item actualizado');
    } else {
      const contenedor = fCont.value && fCont.value !== TODOS_LOS_CONTENEDORES ? fCont.value : null;
      await api.crearItem(bl.id, { goods_name: fGoods.value.trim(), package_qty: fCantidad.value, gross_weight: fPeso.value, hacienda_item_code: fCodigo.value.trim() || null, hacienda_tariff: fTarifa.value || null, container_no: contenedor });
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

// El backend ya renombra bl_cargo_items.container_no al editar un
// contenedor (ver PUT /api/containers/:id), pero esta lista ya estaba
// cargada en memoria con el nombre viejo — sin esto, el item quedaba sin
// aparecer bajo ningún contenedor hasta recargar la página, porque
// itemsDe() lo busca por el nombre nuevo y el item seguía con el viejo.
function renombrarContenedor(viejo: string, nuevo: string) {
  items.value.forEach(i => { if (i.container_no === viejo) i.container_no = nuevo; });
}
defineExpose({ renombrarContenedor });
</script>

<template>
  <template v-if="!multi">
    <div class="mb-2 flex items-center gap-2">
      <span class="text-xs font-semibold uppercase tracking-wide text-ink-muted">Items de carga</span>
      <span v-if="items.length" class="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">{{ items.length }}</span>
      <span class="flex-1 text-xs text-ink-faint">Si hay items, reemplazan la descripción general en el TXT</span>
      <Button size="sm" variant="outline" @click="abrirAgregar(null)">+ Agregar item</Button>
    </div>
    <div v-if="items.length" class="flex flex-col gap-1">
      <div v-for="item in items" :key="item.id" class="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm shadow-sm">
        <div class="min-w-0 flex-1">
          <p class="font-medium">{{ item.goods_name }}</p>
          <p class="mt-0.5 flex flex-wrap gap-3 text-xs text-ink-faint">
            <span>Cantidad: <b class="text-ink">{{ item.package_qty || 0 }}</b></span>
            <span>Peso: <b class="text-ink">{{ item.gross_weight || 0 }} kg</b></span>
            <span>Código: <b class="font-mono text-ink">{{ item.hacienda_item_code || '—' }}</b></span>
            <span>Tarifa: <b class="text-ink">{{ item.hacienda_tariff || '—' }}</b></span>
          </p>
        </div>
        <Button variant="ghost" size="icon" class="size-7" @click="abrirEditar(item.id)"><Pencil class="size-3.5" /></Button>
        <Button variant="ghost" size="icon" class="size-7 text-destructive hover:text-destructive" @click="eliminar(item.id)"><Trash2 class="size-3.5" /></Button>
      </div>
    </div>
    <p v-else class="text-xs text-ink-faint">Sin items adicionales — se usa la descripción general del B/L</p>
  </template>

  <template v-else>
    <div class="mb-2.5 flex items-center gap-2">
      <span class="text-xs font-semibold uppercase tracking-wide text-ink-muted">Carga por contenedor</span>
      <span v-if="items.length" class="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">{{ items.length }}</span>
      <span class="flex-1 text-xs text-ink-faint">Cada contenedor puede tener descripción, peso y código distintos</span>
      <Button v-if="!todosTienen" size="sm" variant="outline" title="Crear un item inicial por contenedor con los datos del B/L" @click="inicializarPorContenedor"><Zap class="size-3.5" />Inicializar por contenedor</Button>
    </div>

    <div v-for="cno in cnos" :key="cno" class="mb-2 overflow-hidden rounded-md border border-slate-200 bg-white">
      <div class="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-2.5 py-1.5">
        <span class="size-1.5 rounded-full" :class="itemsDe(cno).length ? 'bg-status-validated' : 'bg-status-pending'" />
        <span class="font-mono text-xs font-semibold text-accent">{{ cno }}</span>
        <span v-if="itemsDe(cno).length" class="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">{{ itemsDe(cno).length }} item(s) propios</span>
        <span v-if="amountDe(cno)" class="rounded-full bg-paper-sunken px-2 py-0.5 text-[11px] font-medium text-ink-muted" title="Cantidad de bultos declarada en el XML/PDF para este contenedor">Cantidad: {{ amountDe(cno) }}</span>
        <span class="flex-1 text-xs text-ink-faint">{{ itemsDe(cno).length ? '' : 'usando descripción general del B/L' }}</span>
        <Button size="sm" variant="outline" class="h-6 text-xs" @click="abrirAgregar(cno)">+ Item</Button>
      </div>
      <Table v-if="itemsDe(cno).length" class="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead class="w-4/12">Descripción</TableHead>
            <TableHead class="w-1/12">Cantidad</TableHead>
            <TableHead class="w-2/12">Peso (kg)</TableHead>
            <TableHead class="w-2/12">Código</TableHead>
            <TableHead class="w-2/12">Tarifa</TableHead>
            <TableHead class="w-1/12"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="item in itemsDe(cno)" :key="item.id">
            <TableCell class="w-4/12"><Textarea :model-value="item.goods_name" rows="1" class="min-h-9 text-xs" @change="(e:Event) => guardarCampo(item.id,'goods_name',(e.target as HTMLTextAreaElement).value)" /></TableCell>
            <TableCell class="w-1/12"><Input type="number" step="1" :model-value="item.package_qty || 0" class="h-9 text-xs" @change="(e:Event) => guardarCampo(item.id,'package_qty',(e.target as HTMLInputElement).value)" /></TableCell>
            <TableCell class="w-2/12"><Input type="number" step="0.01" :model-value="item.gross_weight || 0" class="h-9 text-xs" @change="(e:Event) => guardarCampo(item.id,'gross_weight',(e.target as HTMLInputElement).value)" /></TableCell>
            <TableCell class="w-2/12"><Input :model-value="item.hacienda_item_code || ''" placeholder="código" class="h-9 font-mono text-xs" @change="(e:Event) => guardarCampo(item.id,'hacienda_item_code',(e.target as HTMLInputElement).value)" /></TableCell>
            <TableCell class="w-2/12">
              <Select :model-value="item.hacienda_tariff || ''" @update:model-value="(v) => guardarCampo(item.id,'hacienda_tariff',String(v))">
                <SelectTrigger class="h-9 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent><SelectItem value="040">040</SelectItem><SelectItem value="045">045</SelectItem></SelectContent>
              </Select>
            </TableCell>
            <TableCell class="w-1/12"><Button variant="ghost" size="icon" class="size-7 text-destructive" @click="eliminar(item.id)"><Trash2 class="size-3.5" /></Button></TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  </template>

  <Dialog v-model:open="modalAbierto">
    <DialogContent class="sm:max-w-xl">
      <DialogHeader><DialogTitle>{{ modalTitulo }}</DialogTitle></DialogHeader>
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-1">
          <Label class="text-xs">Descripción de mercancía <span class="text-danger">*</span></Label>
          <Textarea v-model="fGoods" rows="3" class="text-xs" />
        </div>
        <div class="grid grid-cols-4 gap-3">
          <div class="flex flex-col gap-1"><Label class="text-xs">Cantidad</Label><Input type="number" step="1" v-model.number="fCantidad" class="h-9 text-xs" /></div>
          <div class="flex flex-col gap-1"><Label class="text-xs">Peso bruto (kg)</Label><Input type="number" step="0.01" v-model.number="fPeso" class="h-9 text-xs" /></div>
          <div class="flex flex-col gap-1"><Label class="text-xs">Código arancelario</Label><Input v-model="fCodigo" class="h-9 font-mono text-xs" /></div>
          <div class="flex flex-col gap-1">
            <Label class="text-xs">Tarifa</Label>
            <Select v-model="fTarifa">
              <SelectTrigger class="h-9 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent><SelectItem value="040">040</SelectItem><SelectItem value="045">045</SelectItem></SelectContent>
            </Select>
          </div>
        </div>
        <div v-if="multi && editandoId === null" class="flex flex-col gap-1">
          <Label class="text-xs">Contenedor</Label>
          <Select v-model="fCont">
            <SelectTrigger class="h-9 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-if="!contForzado" :value="TODOS_LOS_CONTENEDORES">Todos los contenedores</SelectItem>
              <SelectItem v-for="c in cnos" :key="c" :value="c">{{ c }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="modalAbierto = false">Cancelar</Button>
        <Button @click="guardarModal">Guardar</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
