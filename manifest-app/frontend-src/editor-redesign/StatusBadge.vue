<script setup lang="ts">
// Los 4 estados de negocio, deliberados (ver styles.css), no colores random.
// Un solo lugar para el mapeo: aparecía repetido en sidebar, header del
// manifiesto y header del B/L.
const props = defineProps<{ status: string }>();

const ESTILOS: Record<string, string> = {
  borrador: 'bg-status-draft-soft text-status-draft',
  pendiente: 'bg-status-pending-soft text-status-pending',
  siscommate: 'bg-status-siscommate-soft text-status-siscommate',
  exportado: 'bg-status-exported-soft text-status-exported',
  validado: 'bg-status-validated-soft text-status-validated',
};
const ESTILO_DEFECTO = 'bg-status-draft-soft text-status-draft';

const clase = ESTILOS[props.status] || ESTILO_DEFECTO;
</script>

<template>
  <span :class="['inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', clase]">
    {{ status }}
  </span>
</template>
