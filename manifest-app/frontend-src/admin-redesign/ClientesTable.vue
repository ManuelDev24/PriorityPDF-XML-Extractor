<script setup lang="ts">
// Tabla de clientes con TanStack Table (v8, API clásica) — antes era una
// <Table> plana de shadcn sin orden ni control de columnas. CUSTOMER.DBF
// trae 13 campos reales (confirmado contra el esquema del bridge) y no
// entran todos de forma legible a la vez, así que se pueden mostrar/ocultar
// por columna en vez de forzar una sola vista fija.
import { ref, computed, h } from 'vue';
import {
  useVueTable, getCoreRowModel, getSortedRowModel, getPaginationRowModel,
  type ColumnDef, type SortingState, type VisibilityState, FlexRender,
} from '@tanstack/vue-table';
import type { Cliente } from '../admin/api';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { ArrowUp, ArrowDown, ArrowUpDown, Columns3, ChevronLeft, ChevronRight, Pencil, Trash2 } from '@lucide/vue';

const props = defineProps<{ clientes: Cliente[] }>();
const emit = defineEmits<{
  editar: [cliente: Cliente];
  eliminarUno: [cliente: Cliente];
  eliminarVarios: [clientes: Cliente[]];
}>();

function texto(v: string | undefined) { return v && v.trim() ? v : '—'; }

// Selección con checkbox — para poder borrar varios duplicados de un tirón
// en vez de uno por uno. Mismo patrón que "mover varios B/L" del editor:
// checkbox siempre visible, nunca solo al pasar el mouse.
const seleccion = ref<Set<number>>(new Set());
function alternarSeleccion(id: number) {
  if (seleccion.value.has(id)) seleccion.value.delete(id);
  else seleccion.value.add(id);
}
function limpiarSeleccion() { seleccion.value.clear(); }
function eliminarSeleccionados() {
  const elegidos = props.clientes.filter(c => seleccion.value.has(c.id));
  if (elegidos.length) emit('eliminarVarios', elegidos);
}

const columnas: ColumnDef<Cliente>[] = [
  {
    id: 'seleccion', header: '', enableHiding: false, enableSorting: false,
    cell: ({ row }) => h('input', {
      type: 'checkbox', class: 'size-3.5', checked: seleccion.value.has(row.original.id),
      onClick: (e: Event) => { e.stopPropagation(); alternarSeleccion(row.original.id); },
    }),
  },
  {
    id: 'acciones', header: '', enableHiding: false, enableSorting: false,
    cell: ({ row }) => h('div', { class: 'flex items-center' }, [
      h(Button, {
        variant: 'ghost', size: 'icon-sm', title: 'Editar cliente',
        onClick: () => emit('editar', row.original),
      }, () => h(Pencil, { class: 'size-3.5' })),
      h(Button, {
        variant: 'ghost', size: 'icon-sm', title: 'Eliminar cliente', class: 'text-destructive hover:text-destructive',
        onClick: () => emit('eliminarUno', row.original),
      }, () => h(Trash2, { class: 'size-3.5' })),
    ]),
  },
  { accessorKey: 'name', header: 'Nombre', enableHiding: false },
  { accessorKey: 'ss', header: 'SS / EIN', cell: ({ getValue }) => texto(getValue<string>()) },
  { accessorKey: 'code', header: 'Código SISCOMMATE', cell: ({ getValue }) => texto(getValue<string>()) },
  { accessorKey: 'type', header: 'Tipo', cell: ({ getValue }) => texto(getValue<string>()) },
  { accessorKey: 'taxid', header: 'Tax ID', cell: ({ getValue }) => texto(getValue<string>()) },
  { accessorKey: 'add1', header: 'Dirección 1', cell: ({ getValue }) => texto(getValue<string>()) },
  { accessorKey: 'add2', header: 'Dirección 2', cell: ({ getValue }) => texto(getValue<string>()) },
  { accessorKey: 'add3', header: 'Dirección 3', cell: ({ getValue }) => texto(getValue<string>()) },
  { accessorKey: 'phone1', header: 'Teléfono', cell: ({ getValue }) => texto(getValue<string>()) },
  { accessorKey: 'phone2', header: 'Teléfono 2', cell: ({ getValue }) => texto(getValue<string>()) },
  { accessorKey: 'fax1', header: 'Fax', cell: ({ getValue }) => texto(getValue<string>()) },
  { accessorKey: 'fax2', header: 'Fax 2', cell: ({ getValue }) => texto(getValue<string>()) },
  { accessorKey: 'ivu', header: 'IVU', cell: ({ getValue }) => texto(getValue<string>()) },
];

// Columnas visibles por defecto: las que se usan a diario. El resto (code,
// type, taxid, add3, phone2, fax1, fax2) casi siempre viene vacío en datos
// reales — se puede prender desde "Columnas" cuando haga falta.
const visibilidad = ref<VisibilityState>({
  code: false, type: false, taxid: false, add3: false, phone2: false, fax1: false, fax2: false,
});
const orden = ref<SortingState>([{ id: 'name', desc: false }]);

const table = useVueTable({
  get data() { return props.clientes; },
  columns: columnas,
  state: {
    get sorting() { return orden.value; },
    get columnVisibility() { return visibilidad.value; },
  },
  onSortingChange: updater => { orden.value = typeof updater === 'function' ? updater(orden.value) : updater; },
  onColumnVisibilityChange: updater => { visibilidad.value = typeof updater === 'function' ? updater(visibilidad.value) : updater; },
  getCoreRowModel: getCoreRowModel(),
  getSortedRowModel: getSortedRowModel(),
  getPaginationRowModel: getPaginationRowModel(),
  initialState: { pagination: { pageSize: 25 } },
});

const columnasOcultables = computed(() => table.getAllColumns().filter(c => c.getCanHide()));

// Ancho por columna (% de la tabla, no exacto) — con table-fixed y esto, las
// 13 columnas reales de CUSTOMER caben en pantalla sin scroll horizontal
// aunque estén todas visibles a la vez. El texto largo se trunca con "…" y
// queda completo al pasar el mouse (title), en vez de forzar el ancho.
const ANCHOS: Record<string, string> = {
  seleccion: '2%', acciones: '5%', name: '14%', ss: '7%', code: '7%', type: '5%', taxid: '6%',
  add1: '10%', add2: '9%', add3: '9%', phone1: '6%', phone2: '6%',
  fax1: '6%', fax2: '6%', ivu: '6%',
};
</script>

<template>
  <div class="flex flex-col gap-2.5">
    <div class="flex items-center justify-between">
      <p class="text-xs text-ink-faint">{{ props.clientes.length }} resultados cargados</p>
      <Popover>
        <PopoverTrigger as-child>
          <Button variant="outline" size="sm"><Columns3 class="size-3.5" />Columnas</Button>
        </PopoverTrigger>
        <PopoverContent align="end" class="w-56">
          <p class="px-1 text-xs font-medium text-ink-muted">Mostrar columnas</p>
          <label
            v-for="col in columnasOcultables" :key="col.id"
            class="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-paper-sunken"
          >
            <input
              type="checkbox" class="size-3.5" :checked="col.getIsVisible()"
              @change="col.toggleVisibility()"
            />
            {{ typeof col.columnDef.header === 'string' ? col.columnDef.header : col.id }}
          </label>
        </PopoverContent>
      </Popover>
    </div>

    <div v-if="seleccion.size" class="flex items-center justify-between rounded-md border border-status-pending/40 bg-status-pending/10 px-3 py-1.5">
      <span class="text-xs font-medium text-status-pending">{{ seleccion.size }} seleccionado{{ seleccion.size > 1 ? 's' : '' }}</span>
      <div class="flex items-center gap-2">
        <button type="button" class="text-xs text-ink-faint hover:text-ink" @click="limpiarSeleccion">Cancelar</button>
        <Button variant="destructive" size="sm" @click="eliminarSeleccionados"><Trash2 class="size-3.5" />Eliminar seleccionados</Button>
      </div>
    </div>

    <div class="w-full overflow-hidden rounded-md border border-border">
      <Table class="w-full table-fixed">
        <TableHeader>
          <TableRow v-for="hg in table.getHeaderGroups()" :key="hg.id">
            <TableHead
              v-for="header in hg.headers" :key="header.id"
              class="cursor-pointer select-none overflow-hidden text-ellipsis whitespace-nowrap"
              :style="{ width: ANCHOS[header.column.id] }"
              @click="header.column.getToggleSortingHandler()?.($event)"
            >
              <span class="inline-flex items-center gap-1">
                <FlexRender v-if="!header.isPlaceholder" :render="header.column.columnDef.header" :props="header.getContext()" />
                <ArrowUp v-if="header.column.getIsSorted() === 'asc'" class="size-3 shrink-0" />
                <ArrowDown v-else-if="header.column.getIsSorted() === 'desc'" class="size-3 shrink-0" />
                <ArrowUpDown v-else class="size-3 shrink-0 text-ink-faint" />
              </span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="row in table.getRowModel().rows" :key="row.id">
            <TableCell
              v-for="cell in row.getVisibleCells()" :key="cell.id"
              class="overflow-hidden text-ellipsis whitespace-nowrap text-sm"
              :title="typeof cell.getValue() === 'string' ? (cell.getValue() as string) : undefined"
            >
              <span :class="cell.column.id === 'name' && 'font-medium text-ink'">
                <FlexRender :render="cell.column.columnDef.cell" :props="cell.getContext()" />
              </span>
            </TableCell>
          </TableRow>
          <TableRow v-if="!table.getRowModel().rows.length">
            <TableCell :colspan="columnas.length" class="p-5 text-center text-xs text-ink-faint">
              Sin resultados — probá con otro término, o sincronizá el catálogo si nunca se ha corrido.
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>

    <div v-if="table.getPageCount() > 1" class="flex items-center justify-between text-xs text-ink-muted">
      <span>Página {{ table.getState().pagination.pageIndex + 1 }} de {{ table.getPageCount() }}</span>
      <div class="flex items-center gap-1">
        <Button variant="outline" size="icon-sm" :disabled="!table.getCanPreviousPage()" @click="table.previousPage()">
          <ChevronLeft class="size-3.5" />
        </Button>
        <Button variant="outline" size="icon-sm" :disabled="!table.getCanNextPage()" @click="table.nextPage()">
          <ChevronRight class="size-3.5" />
        </Button>
      </div>
    </div>
  </div>
</template>
