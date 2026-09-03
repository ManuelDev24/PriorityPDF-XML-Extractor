<script setup lang="ts">
// Misma lógica de negocio que frontend-src/editor/EditorPanel.vue (store.ts
// sin tocar). Lo que cambia es la presentación: Card/Input/Select de shadcn,
// y sobre todo el grid — cada campo se dimensiona por su contenido real en
// vez de fracciones iguales (era el reclamo original: IMO con 7 caracteres
// ocupaba el mismo ancho que el nombre del buque).
import { ref, computed, watch } from 'vue';
import { api, type ItemHacienda, type Cliente } from '../editor/api';
import {
  datosManifiesto, blActual, carriers, puertos, buques, contenedoresDelBL,
  actualizarBL, actualizarManifiesto, setEstado, toast,
} from '../editor/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel } from '@/components/ui/select';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command';
import CargoItems from './CargoItems.vue';
import StatusBadge from './StatusBadge.vue';
import { Check, Eye, X } from '@lucide/vue';

const emit = defineEmits<{
  vistaPrevia: [blId: number];
  crearCliente: [prefill: string];
  editarCliente: [id: number, ss: string, nombre: string];
}>();

const m = computed(() => datosManifiesto.value!.manifest);
const bl = computed(() => blActual.value!);

const PAISES: Record<string, string> = {
  PR: 'Puerto Rico', DO: 'Rep. Dominicana', US: 'Estados Unidos', VI: 'Islas Vírgenes (US)',
  VG: 'Islas Vírgenes (UK)', SX: 'St. Maarten', MF: 'St. Martin', KN: 'Saint Kitts',
  AG: 'Antigua', MX: 'México', CN: 'China',
};
const paises = computed(() => [...new Set(puertos.value.map(p => p.country))]);
const puertosDe = (pais: string) => puertos.value.filter(p => p.country === pais);

const puertoOrigen = computed({
  get: () => m.value.loading_port || 'DRP',
  set: (v: string) => actualizarManifiesto('loading_port', v),
});
const puertoDestino = computed({
  get: () => m.value.unloading_port || 'XSJ',
  set: (v: string) => actualizarManifiesto('unloading_port', v),
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

// ── Combobox: código arancelario (Popover + Command, reemplaza el
// autocomplete casero — teclado y foco reales, mismo comportamiento) ──
const itemAbierto = ref(false);
const itemsHallados = ref<ItemHacienda[]>([]);
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
const nombreCliente = ref('');
const clienteId = ref<number | null>(null);
const busquedaCliente = ref('');
let tCliente: ReturnType<typeof setTimeout> | undefined;

function buscarCliente(q: string) {
  busquedaCliente.value = q;
  clearTimeout(tCliente);
  if (!q || q.length < 2) { clientesHallados.value = []; return; }
  tCliente = setTimeout(async () => {
    try { clientesHallados.value = await api.buscarClientes(q); } catch { clientesHallados.value = []; }
  }, 200);
}
function elegirCliente(c: Cliente) {
  actualizarBL('hacienda_client_ss', c.ss);
  clienteAbierto.value = false;
  nombreCliente.value = c.name;
  clienteId.value = c.id;
  if (c.ivu && !bl.value.hacienda_client_ivu) actualizarBL('hacienda_client_ivu', c.ivu);
}
function aplicarCliente(c: Cliente) { elegirCliente(c); }
defineExpose({ aplicarCliente });

watch(() => bl.value?.id, () => {
  itemAbierto.value = false; clienteAbierto.value = false;
  sugerencias.value = []; nombreCliente.value = ''; clienteId.value = null; descItem.value = '';
  if (bl.value?.hacienda_item_code) cargarDescItem(bl.value.hacienda_item_code);
  else if (bl.value?.goods_name) sugerir(bl.value.goods_name);
}, { immediate: true });
</script>

<template>
  <div class="flex flex-col gap-5">
    <!-- ── MANIFIESTO ── -->
    <Card>
      <CardHeader class="flex-row items-center justify-between">
        <CardTitle>Manifiesto — Viaje {{ m.voyage_no }}</CardTitle>
        <StatusBadge :status="m.status" />
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <!-- Buque flexible, IMO angosto — antes eran fracciones iguales -->
        <div class="grid grid-cols-[1fr_140px] gap-3">
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">Buque</Label>
            <Select :model-value="m.vessel_code" @update:model-value="(v) => alCambiarBuque(String(v))">
              <SelectTrigger class="w-full"><SelectValue placeholder="— selecciona —" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="v in buques" :key="v.code" :value="v.code">{{ v.name }} — IMO {{ v.imo }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">IMO</Label>
            <Input :model-value="m.imo || imoDelBuque(m.vessel_code) || ''" placeholder="Número IMO" class="font-mono"
              @change="(e:Event) => actualizarManifiesto('imo', (e.target as HTMLInputElement).value)" />
          </div>
        </div>

        <div class="grid grid-cols-[1fr_180px_160px] gap-3">
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">Carrier Hacienda PR</Label>
            <Select :model-value="m.carrier_code || 'MPRIORO'" @update:model-value="(v) => actualizarManifiesto('carrier_code', String(v))">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="c in carriers" :key="c.code" :value="c.code">{{ c.name }} ({{ c.scac }})</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">No. manifiesto Hacienda <span class="text-danger">*</span></Label>
            <Input :model-value="m.manifest_no || ''" placeholder="ej. 3309468" :class="!m.manifest_no && 'border-status-pending bg-status-pending-soft'"
              @change="(e:Event) => actualizarManifiesto('manifest_no', (e.target as HTMLInputElement).value)" />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">Docking Number <span class="text-danger">*</span></Label>
            <Input :model-value="m.docking_number || ''" placeholder="ej. 20262342" maxlength="8" inputmode="numeric"
              class="font-mono" :class="!m.docking_number && 'border-status-pending bg-status-pending-soft'"
              @input="(e:Event) => { const el = e.target as HTMLInputElement; el.value = el.value.replace(/[^0-9]/g,''); }"
              @change="(e:Event) => alCambiarDocking((e.target as HTMLInputElement).value)" />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">Puerto origen (DGA)</Label>
            <Select v-model="puertoOrigen">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup v-for="pais in paises" :key="pais">
                  <SelectLabel>{{ PAISES[pais] || pais }}</SelectLabel>
                  <SelectItem v-for="p in puertosDe(pais)" :key="p.code" :value="p.code">{{ p.code }} — {{ p.description }}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">Puerto destino (PR)</Label>
            <Select v-model="puertoDestino">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup v-for="pais in paises" :key="pais">
                  <SelectLabel>{{ PAISES[pais] || pais }}</SelectLabel>
                  <SelectItem v-for="p in puertosDe(pais)" :key="p.code" :value="p.code">{{ p.code }} — {{ p.description }}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">Fecha salida</Label>
            <Input type="date" :model-value="(m.departure_date || '').substring(0,10)"
              @change="(e:Event) => actualizarManifiesto('departure_date', (e.target as HTMLInputElement).value)" />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">Fecha llegada</Label>
            <Input type="date" :model-value="(m.arrival_date || '').substring(0,10)"
              @change="(e:Event) => actualizarManifiesto('arrival_date', (e.target as HTMLInputElement).value)" />
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- ── B/L HEADER ── -->
    <div class="flex items-center gap-2">
      <h2 class="text-sm font-semibold">{{ bl.bl_no }}</h2>
      <StatusBadge :status="bl.status" />
      <div class="flex-1"></div>
      <Button v-if="bl.status === 'validado'" variant="outline" size="sm" @click="marcar('pendiente')"><X class="size-3.5" />Desvalidar</Button>
      <Button v-else variant="outline" size="sm" class="border-status-validated text-status-validated hover:bg-status-validated-soft hover:text-status-validated" @click="marcar('validado')"><Check class="size-3.5" />Validado</Button>
      <Button variant="outline" size="sm" @click="emit('vistaPrevia', bl.id)"><Eye class="size-3.5" />Ver TXT</Button>
    </div>

    <!-- ── HACIENDA PR ── -->
    <Card class="border-status-pending/40 bg-status-pending-soft/30">
      <CardHeader><CardTitle class="text-status-pending">Hacienda PR — campos requeridos para el TXT</CardTitle></CardHeader>
      <CardContent class="flex flex-col gap-4">
        <div class="grid grid-cols-[1fr_180px] gap-3">
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">Código arancelario — Items Hacienda <span class="text-danger">*</span></Label>
            <Popover v-model:open="itemAbierto">
              <PopoverTrigger as-child>
                <Button variant="outline" role="combobox" class="justify-start bg-paper-raised font-mono font-normal">
                  {{ bl.hacienda_item_code || 'Buscar por código o descripción...' }}
                </Button>
              </PopoverTrigger>
              <PopoverContent class="w-96 p-0" align="start">
                <Command>
                  <CommandInput placeholder="Buscar..." @update:model-value="(v: string) => buscarItem(v)" />
                  <CommandList>
                    <CommandEmpty>Sin resultados</CommandEmpty>
                    <CommandGroup>
                      <CommandItem v-for="it in itemsHallados" :key="it.code" :value="it.code" @select="elegirItem(it)">
                        <span class="flex-1 truncate">{{ it.description }}</span>
                        <span class="font-mono text-xs text-ink-faint">{{ it.code }}</span>
                      </CommandItem>
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <p v-if="descItem" class="text-xs text-status-validated">{{ descItem }}</p>
          </div>
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">Tarifa (arbitrio)</Label>
            <Select v-model="tarifa">
              <SelectTrigger class="w-full bg-paper-raised"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="040">040 — Libre arancel</SelectItem>
                <SelectItem value="045">045 — Carga general</SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-ink-faint">{{ libreArancel ? 'FOB será 0 en el TXT' : 'Incluye valor FOB' }}</p>
          </div>
        </div>

        <div v-if="sugerencias.length" class="rounded-md border border-status-pending/50 bg-paper-raised p-2.5">
          <p class="text-xs font-medium text-status-pending">Sugerido para: "{{ (bl.goods_name || '').substring(0,60) }}"</p>
          <div class="mt-1.5 flex flex-wrap gap-1.5">
            <button v-for="it in sugerencias" :key="it.code" class="rounded-full border border-status-pending/50 bg-paper px-2.5 py-1 text-xs hover:bg-status-pending hover:text-white" @click="elegirItem(it)">
              <span class="font-mono font-semibold">{{ it.code }}</span> {{ it.description.substring(0,35) }}
            </button>
          </div>
        </div>

        <div class="grid grid-cols-[1fr_140px_1fr] gap-3">
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">SS / EIN consignatario <span class="text-danger">*</span></Label>
            <Popover v-model:open="clienteAbierto">
              <PopoverTrigger as-child>
                <Button variant="outline" role="combobox" class="justify-start bg-paper-raised font-mono font-normal">
                  {{ bl.hacienda_client_ss || bl.consignee_document_no || 'Buscar por nombre o EIN...' }}
                </Button>
              </PopoverTrigger>
              <PopoverContent class="w-96 p-0" align="start">
                <Command>
                  <CommandInput placeholder="Buscar..." @update:model-value="(v: string) => buscarCliente(v)" />
                  <CommandList>
                    <CommandEmpty>Sin resultados</CommandEmpty>
                    <CommandGroup>
                      <CommandItem v-for="c in clientesHallados" :key="c.id" :value="String(c.id)" @select="elegirCliente(c)">
                        <span class="flex-1 truncate">{{ c.name }}</span>
                        <span class="font-mono text-xs text-ink-faint">{{ c.ss || '—' }}</span>
                      </CommandItem>
                      <CommandItem value="crear-nuevo" class="text-accent" @select="clienteAbierto = false; emit('crearCliente', busquedaCliente)">
                        + Crear nuevo consignatario…
                      </CommandItem>
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <p v-if="nombreCliente" class="flex items-center gap-1 text-xs text-status-validated">
              <Check class="size-3" />{{ nombreCliente }}
              <button class="text-accent underline" @click="emit('editarCliente', clienteId || 0, bl.hacienda_client_ss || '', nombreCliente)">Editar</button>
            </p>
          </div>
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">IVU consignatario</Label>
            <Input :model-value="bl.hacienda_client_ivu || ''" placeholder="ej. 01406530016" maxlength="11" class="bg-paper-raised font-mono"
              @input="(e:Event) => { const el = e.target as HTMLInputElement; el.value = el.value.replace(/[^0-9]/g,''); }"
              @change="(e:Event) => actualizarBL('hacienda_client_ivu', (e.target as HTMLInputElement).value)" />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">Notas internas</Label>
            <Input :model-value="bl.notes || ''" placeholder="Observaciones..." class="bg-paper-raised"
              @change="(e:Event) => actualizarBL('notes', (e.target as HTMLInputElement).value)" />
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label class="text-xs">No. contenedor (Hacienda)</Label>
          <Input :model-value="contenedorHacienda" placeholder="ej. TCKU1234567" class="max-w-sm bg-paper-raised font-mono"
            @change="(e:Event) => actualizarBL('hacienda_container_no', (e.target as HTMLInputElement).value)" />
          <div v-if="contenedoresDelBL.length" class="mt-1 flex flex-col gap-1.5">
            <div v-for="c in contenedoresDelBL" :key="c.container_no" class="flex items-center gap-2">
              <button class="rounded border border-accent/30 bg-accent-soft px-2 py-0.5 font-mono text-xs text-accent" @click="actualizarBL('hacienda_container_no', c.container_no)">{{ c.container_no }}</button>
              <Select :model-value="c.size" :disabled="!c.id" @update:model-value="(v) => alCambiarTamano(c.id, String(v))">
                <SelectTrigger class="h-7 w-40 text-xs" :class="!c.size && 'border-danger bg-danger-soft'"><SelectValue placeholder="— tamaño —" /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="s in ['20','40','40HC','45','53']" :key="s" :value="s">{{ s }}</SelectItem>
                </SelectContent>
              </Select>
              <span class="text-xs text-ink-faint">Tipo: R (RORO)</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- ── CARGA ── -->
    <Card>
      <CardHeader><CardTitle>Carga</CardTitle></CardHeader>
      <CardContent class="flex flex-col gap-4">
        <div class="grid grid-cols-[140px_160px_1fr] gap-3">
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">Cantidad bultos</Label>
            <Input type="number" :model-value="bl.package_qty || 0" @change="(e:Event) => actualizarBL('package_qty', (e.target as HTMLInputElement).value)" />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">Peso bruto (kg)</Label>
            <Input type="number" step="0.01" :model-value="bl.gross_weight || 0" @change="(e:Event) => actualizarBL('gross_weight', (e.target as HTMLInputElement).value)" />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">Valor FOB (USD)</Label>
            <Input type="number" step="0.01" :model-value="bl.value || 0" :class="libreArancel && 'opacity-50'"
              :title="libreArancel ? '040 Libre arancel — se fuerza a 0 en el TXT' : ''"
              @change="(e:Event) => actualizarBL('value', (e.target as HTMLInputElement).value)" />
          </div>
        </div>
        <div class="flex flex-col gap-1.5">
          <Label class="text-xs">Descripción de mercancía (DGA) — máx. 121 caracteres en TXT</Label>
          <Textarea :model-value="bl.goods_name || ''" class="min-h-16" @input="(e:Event) => alCambiarDescripcion((e.target as HTMLTextAreaElement).value)" />
          <p class="text-xs" :class="(bl.goods_name||'').length > 121 ? 'text-danger' : 'text-ink-faint'">{{ (bl.goods_name || '').length }}/121 caracteres</p>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">Puerto descarga (DGA)</Label>
            <Input :model-value="bl.unloading_port_code || ''" @change="(e:Event) => actualizarBL('unloading_port_code', (e.target as HTMLInputElement).value)" />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs">Código empaque (DGA)</Label>
            <Input :model-value="bl.package_unit_code || ''" @change="(e:Event) => actualizarBL('package_unit_code', (e.target as HTMLInputElement).value)" />
          </div>
        </div>
        <div class="border-t border-border pt-4"><CargoItems /></div>
      </CardContent>
    </Card>

    <!-- ── CONSIGNADOR / CONSIGNATARIO ── -->
    <Card>
      <CardHeader><CardTitle><span class="rounded bg-status-validated-soft px-1.5 py-0.5 text-status-validated">Consignador</span> — Shipper (República Dominicana)</CardTitle></CardHeader>
      <CardContent class="flex flex-col gap-3">
        <div class="flex flex-col gap-1.5"><Label class="text-xs">Nombre / Razón social</Label><Input :model-value="bl.consignor_name || ''" @change="(e:Event) => actualizarBL('consignor_name', (e.target as HTMLInputElement).value)" /></div>
        <div class="grid grid-cols-[1fr_160px] gap-3">
          <div class="flex flex-col gap-1.5"><Label class="text-xs">No. documento (RNC / Cédula)</Label><Input :model-value="bl.consignor_document_no || ''" @change="(e:Event) => actualizarBL('consignor_document_no', (e.target as HTMLInputElement).value)" /></div>
          <div class="flex flex-col gap-1.5"><Label class="text-xs">Tipo documento</Label><Input :model-value="bl.consignor_document_type || ''" @change="(e:Event) => actualizarBL('consignor_document_type', (e.target as HTMLInputElement).value)" /></div>
        </div>
        <div class="flex flex-col gap-1.5"><Label class="text-xs">Dirección</Label><Input :model-value="bl.consignor_street || ''" @change="(e:Event) => actualizarBL('consignor_street', (e.target as HTMLInputElement).value)" /></div>
        <div class="grid grid-cols-3 gap-3">
          <div class="flex flex-col gap-1.5"><Label class="text-xs">Ciudad</Label><Input :model-value="bl.consignor_city || ''" @change="(e:Event) => actualizarBL('consignor_city', (e.target as HTMLInputElement).value)" /></div>
          <div class="flex flex-col gap-1.5"><Label class="text-xs">Teléfono</Label><Input :model-value="bl.consignor_tel || ''" class="font-mono" @change="(e:Event) => actualizarBL('consignor_tel', (e.target as HTMLInputElement).value)" /></div>
          <div class="flex flex-col gap-1.5"><Label class="text-xs">Email</Label><Input type="email" :model-value="bl.consignor_email || ''" @change="(e:Event) => actualizarBL('consignor_email', (e.target as HTMLInputElement).value)" /></div>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle><span class="rounded bg-accent-soft px-1.5 py-0.5 text-accent">Consignatario</span> — Consignee (Puerto Rico)</CardTitle></CardHeader>
      <CardContent class="flex flex-col gap-3">
        <div class="grid grid-cols-[1fr_160px_160px] gap-3">
          <div class="flex flex-col gap-1.5"><Label class="text-xs">Nombre / Razón social</Label><Input :model-value="bl.consignee_name || ''" @change="(e:Event) => actualizarBL('consignee_name', (e.target as HTMLInputElement).value)" /></div>
          <div class="flex flex-col gap-1.5"><Label class="text-xs">EIN / SS (PR)</Label><Input :model-value="bl.consignee_document_no || ''" class="font-mono" @change="(e:Event) => actualizarBL('consignee_document_no', (e.target as HTMLInputElement).value)" /></div>
          <div class="flex flex-col gap-1.5"><Label class="text-xs">Teléfono</Label><Input :model-value="bl.consignee_tel || ''" class="font-mono" @change="(e:Event) => actualizarBL('consignee_tel', (e.target as HTMLInputElement).value)" /></div>
        </div>
        <div class="flex flex-col gap-1.5"><Label class="text-xs">Dirección</Label><Input :model-value="bl.consignee_street || ''" @change="(e:Event) => actualizarBL('consignee_street', (e.target as HTMLInputElement).value)" /></div>
        <div class="grid grid-cols-3 gap-3">
          <div class="flex flex-col gap-1.5"><Label class="text-xs">Ciudad</Label><Input :model-value="bl.consignee_city || ''" @change="(e:Event) => actualizarBL('consignee_city', (e.target as HTMLInputElement).value)" /></div>
          <div class="flex flex-col gap-1.5"><Label class="text-xs">Zip code</Label><Input :model-value="bl.consignee_zip || ''" class="font-mono" @change="(e:Event) => actualizarBL('consignee_zip', (e.target as HTMLInputElement).value)" /></div>
          <div class="flex flex-col gap-1.5"><Label class="text-xs">Email</Label><Input type="email" :model-value="bl.consignee_email || ''" @change="(e:Event) => actualizarBL('consignee_email', (e.target as HTMLInputElement).value)" /></div>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
