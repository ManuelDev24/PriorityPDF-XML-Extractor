<script setup lang="ts">
// Tabla de consignadores — mismo patrón que ClientesTable.vue (paginación
// real del servidor, no un recorte cargado de antemano) pero mucho más
// simple: consignor_catalog solo tiene el nombre (SISCOMMATE no guarda
// dirección ni documento del consignador aparte, ver clientSync.js), así
// que no hace falta TanStack Table completo — una sola columna no necesita
// ordenar ni ocultar nada.
import type { Consignador } from '../admin/api';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Trash2 } from '@lucide/vue';
import Paginador from './Paginador.vue';

const props = defineProps<{ consignadores: Consignador[]; total: number; pagina: number; porPagina: number }>();
const emit = defineEmits<{
  eliminarUno: [consignador: Consignador];
  cambiarPagina: [pagina: number];
}>();
</script>

<template>
  <div class="flex flex-col gap-2.5">
    <p class="text-xs text-ink-faint">{{ props.total }} resultado{{ props.total === 1 ? '' : 's' }} en total</p>

    <div class="w-full overflow-hidden rounded-md border border-border">
      <Table class="w-full">
        <TableHeader>
          <TableRow>
            <TableHead>Nombre</TableHead>
            <TableHead class="w-16 text-right">Acción</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="c in props.consignadores" :key="c.name">
            <TableCell class="text-sm">{{ c.name }}</TableCell>
            <TableCell class="text-right">
              <Button
                variant="ghost" size="icon-sm" class="text-destructive hover:text-destructive" title="Eliminar"
                @click="emit('eliminarUno', c)"
              >
                <Trash2 class="size-3.5" />
              </Button>
            </TableCell>
          </TableRow>
          <TableRow v-if="!props.consignadores.length">
            <TableCell colspan="2" class="p-5 text-center text-xs text-ink-faint">
              Sin resultados — probá con otro término, o sincronizá el catálogo si nunca se ha corrido.
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>

    <Paginador :pagina="pagina" :por-pagina="porPagina" :total="total" @cambiar="p => emit('cambiarPagina', p)" />
  </div>
</template>
