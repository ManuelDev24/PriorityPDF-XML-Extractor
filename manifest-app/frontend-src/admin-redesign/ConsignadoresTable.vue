<script setup lang="ts">
// Tabla de consignadores — mismo patrón que ClientesTable.vue (paginación
// real del servidor, no un recorte cargado de antemano). SISCOMMATE solo da
// el nombre (BOL.exporter es texto libre, ver clientSync.js); documento,
// teléfono y dirección son campos editables a mano desde Admin, sin fuente
// real que sincronizar — por eso vienen casi siempre vacíos salvo que
// alguien los haya completado.
import type { Consignador } from '../admin/api';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Pencil, Trash2 } from '@lucide/vue';
import Paginador from './Paginador.vue';

const props = defineProps<{ consignadores: Consignador[]; total: number; pagina: number; porPagina: number }>();
const emit = defineEmits<{
  editar: [consignador: Consignador];
  eliminarUno: [consignador: Consignador];
  cambiarPagina: [pagina: number];
}>();

function texto(v: string | undefined) { return v && v.trim() ? v : '—'; }
</script>

<template>
  <div class="flex flex-col gap-2.5">
    <p class="text-xs text-ink-faint">{{ props.total }} resultado{{ props.total === 1 ? '' : 's' }} en total</p>

    <div class="w-full overflow-hidden rounded-md border border-border">
      <Table class="w-full table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead class="w-16"></TableHead>
            <TableHead>Nombre</TableHead>
            <TableHead class="w-32">Documento</TableHead>
            <TableHead class="w-28">Teléfono</TableHead>
            <TableHead>Dirección</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="c in props.consignadores" :key="c.name">
            <TableCell>
              <div class="flex items-center">
                <Button variant="ghost" size="icon-sm" title="Editar" @click="emit('editar', c)">
                  <Pencil class="size-3.5" />
                </Button>
                <Button
                  variant="ghost" size="icon-sm" class="text-destructive hover:text-destructive" title="Eliminar"
                  @click="emit('eliminarUno', c)"
                >
                  <Trash2 class="size-3.5" />
                </Button>
              </div>
            </TableCell>
            <TableCell class="text-sm font-medium text-ink">{{ c.name }}</TableCell>
            <TableCell class="text-sm text-ink-muted">{{ texto(c.document_no) }}</TableCell>
            <TableCell class="text-sm text-ink-muted">{{ texto(c.tel) }}</TableCell>
            <TableCell class="truncate text-sm text-ink-muted" :title="[c.street, c.city].filter(Boolean).join(', ')">
              {{ texto([c.street, c.city].filter(Boolean).join(', ')) }}
            </TableCell>
          </TableRow>
          <TableRow v-if="!props.consignadores.length">
            <TableCell colspan="5" class="p-5 text-center text-xs text-ink-faint">
              Sin resultados — probá con otro término, o sincronizá el catálogo si nunca se ha corrido.
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>

    <Paginador :pagina="pagina" :por-pagina="porPagina" :total="total" @cambiar="p => emit('cambiarPagina', p)" />
  </div>
</template>
