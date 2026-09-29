<script setup lang="ts">
// Paginador genérico reutilizado por ClientesTable y ConsignadoresTable —
// ambas listas ahora se paginan del lado del servidor (offset real sobre la
// búsqueda completa, no sobre un recorte de 100 filas cargado de antemano),
// así que el componente solo necesita mostrar el estado y emitir el cambio.
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from '@lucide/vue';

const props = defineProps<{ pagina: number; porPagina: number; total: number }>();
const emit = defineEmits<{ cambiar: [pagina: number] }>();

function totalPaginas() { return Math.max(Math.ceil(props.total / props.porPagina), 1); }
function desde() { return props.total === 0 ? 0 : props.pagina * props.porPagina + 1; }
function hasta() { return Math.min((props.pagina + 1) * props.porPagina, props.total); }
</script>

<template>
  <div class="flex items-center justify-between text-xs text-ink-muted">
    <span>{{ total === 0 ? 'Sin resultados' : `${desde()}–${hasta()} de ${total}` }}</span>
    <div class="flex items-center gap-2">
      <span v-if="total > 0">Página {{ pagina + 1 }} de {{ totalPaginas() }}</span>
      <div class="flex items-center gap-1">
        <Button variant="outline" size="icon-sm" :disabled="pagina === 0" @click="emit('cambiar', pagina - 1)">
          <ChevronLeft class="size-3.5" />
        </Button>
        <Button variant="outline" size="icon-sm" :disabled="hasta() >= total" @click="emit('cambiar', pagina + 1)">
          <ChevronRight class="size-3.5" />
        </Button>
      </div>
    </div>
  </div>
</template>
