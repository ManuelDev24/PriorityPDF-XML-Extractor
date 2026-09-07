<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api, type ContainerType, type EnvioSiscommate } from '../admin/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
} from '@/components/ui/card';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableFooter,
} from '@/components/ui/table';
import { Trash2 } from '@lucide/vue';

const FALLBACK_TAMANOS = ['20', '40', '40HC', '45', '48', '53', 'RORO'];

const bridgeHost = ref('');
const bridgePort = ref('');
const dbfPath = ref('');
const bridgeOnline = ref<boolean | null>(null);
const bridgeTexto = ref('Verificando…');
const filas = ref<ContainerType[]>([]);
const tamanosValidos = ref<string[]>([]);
const nuevoTipo = ref('');
const nuevoTamano = ref('40');
const nuevaEtiqueta = ref('');

const toastMsg = ref('');
const toastTipo = ref<'ok' | 'err'>('ok');
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string, tipo: 'ok' | 'err' = 'ok') {
  toastMsg.value = msg;
  toastTipo.value = tipo;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastMsg.value = ''; }, 2500);
}

const bridgeUrl = computed(() => `http://${bridgeHost.value || 'localhost'}:${bridgePort.value || '5001'}`);

function opciones(size: string): string[] {
  const tamanos = tamanosValidos.value.length ? tamanosValidos.value : FALLBACK_TAMANOS;
  return tamanos.includes(size) ? tamanos : [...tamanos, size];
}

async function cargarSettings() {
  const s = await api.getSettings();
  bridgeHost.value = s.bridge_host || 'localhost';
  bridgePort.value = s.bridge_port || '5001';
  dbfPath.value = s.dbf_path || '';
}

async function checkBridge() {
  bridgeOnline.value = null;
  bridgeTexto.value = 'Verificando…';
  try {
    const d = await api.getBridgeStatus();
    bridgeOnline.value = d.online;
    bridgeTexto.value = d.online ? `Bridge activo — ${d.version || 'SiscommateBridge'}` : `Bridge offline — ${d.error || 'Sin respuesta'}`;
  } catch (e) {
    bridgeOnline.value = false;
    bridgeTexto.value = 'Error al consultar el bridge: ' + (e as Error).message;
  }
}

async function saveBridgeConfig() {
  try {
    await api.saveSettings({ bridge_host: bridgeHost.value.trim(), bridge_port: bridgePort.value.trim() });
    toast('Configuración guardada');
    checkBridge();
  } catch { toast('Error al guardar', 'err'); }
}

async function saveDbfPath() {
  try {
    await api.saveSettings({ dbf_path: dbfPath.value.trim() });
    toast('Ruta DBF guardada');
  } catch { toast('Error al guardar', 'err'); }
}

async function cargarTipos() {
  filas.value = await api.getContainerTypes();
}

const historial = ref<EnvioSiscommate[]>([]);
async function cargarHistorial() {
  try { historial.value = await api.getHistorialSiscommate(); }
  catch { historial.value = []; }
}
function fechaCorta(iso: string) {
  return iso ? iso.replace('T', ' ').substring(0, 16) : '';
}

async function cargarTamanos() {
  try { tamanosValidos.value = await api.getContainerSizes(); }
  catch { tamanosValidos.value = FALLBACK_TAMANOS; }
}

async function guardarFila(fila: ContainerType) {
  await api.saveContainerType(fila.xml_type, fila.size, fila.label);
  toast(`${fila.xml_type} → ${fila.size} guardado`);
  await cargarTipos();
}

async function eliminarFila(xmlType: string) {
  if (!confirm(`¿Eliminar el mapeo para código "${xmlType}"?`)) return;
  await api.deleteContainerType(xmlType);
  toast(`Código ${xmlType} eliminado`);
  await cargarTipos();
}

async function agregarTipo() {
  const xmlType = nuevoTipo.value.trim();
  if (!xmlType) { toast('Ingresa el código XML', 'err'); return; }
  if (!nuevoTamano.value) { toast('Selecciona el tamaño', 'err'); return; }
  try {
    await api.addContainerType(xmlType, nuevoTamano.value, nuevaEtiqueta.value.trim());
    toast(`Código ${xmlType} agregado`);
    nuevoTipo.value = '';
    nuevaEtiqueta.value = '';
    await cargarTipos();
  } catch (e) {
    let msg = 'Error al agregar';
    try { msg = JSON.parse((e as Error).message).error || msg; } catch { /* texto plano */ }
    toast(msg, 'err');
  }
}

onMounted(() => { cargarSettings(); cargarTipos(); cargarTamanos(); checkBridge(); cargarHistorial(); });
</script>

<template>
  <div class="min-h-screen bg-paper">
    <header class="flex h-14 items-center gap-3 border-b border-border bg-paper-raised px-6">
      <span class="text-sm font-semibold text-accent">Priority Global</span>
      <span class="text-xs text-ink-muted">Manifiestos DGA → Hacienda PR</span>
      <div class="flex-1"></div>
      <Button variant="outline" size="sm" as-child>
        <a href="/">← Volver al editor</a>
      </Button>
    </header>

    <main class="mx-auto max-w-4xl px-6 py-8">
      <h1 class="text-2xl font-semibold text-ink">Administración</h1>
      <p class="mt-1 text-sm text-ink-muted">
        Configuración del sistema, mapeo de contenedores y conexión con SISCOMMATE
      </p>

      <!-- ── Bridge SISCOMMATE ── -->
      <Card class="mt-6">
        <CardHeader>
          <CardTitle>Conexión SISCOMMATE Bridge</CardTitle>
          <CardDescription>
            Servidor donde corre SiscommateBridge.exe — recibe el manifiesto y lo
            inserta en la base de datos SISCOMMATE
          </CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-3.5">
          <div class="flex items-center gap-3 rounded-md border border-border bg-paper px-3 py-2 text-sm">
            <span
              class="h-2 w-2 shrink-0 rounded-full"
              :class="bridgeOnline === null ? 'bg-ink-faint' : bridgeOnline ? 'bg-status-validated' : 'bg-destructive'"
            />
            <span class="text-ink-muted">{{ bridgeTexto }}</span>
            <div class="flex-1"></div>
            <Button variant="outline" size="sm" @click="checkBridge">Probar conexión</Button>
          </div>

          <!-- Sistema de 12 columnas (mismo que el editor): la columna del
               botón "Guardar" queda en el mismo lugar (col 10-12) en ambas
               filas de esta tarjeta, así los botones se alinean entre sí
               aunque el campo de arriba sea más corto que el de abajo. -->
          <div class="grid grid-cols-12 items-end gap-x-3 gap-y-2.5">
            <div class="col-span-12 md:col-span-7 flex flex-col gap-1">
              <Label class="text-xs">Host / IP del servidor</Label>
              <Input v-model="bridgeHost" placeholder="localhost" class="font-mono text-sm" />
            </div>
            <div class="col-span-6 md:col-span-2 flex flex-col gap-1">
              <Label class="text-xs">Puerto</Label>
              <Input v-model="bridgePort" placeholder="5001" class="font-mono text-sm" />
            </div>
            <Button class="col-span-6 md:col-span-3" @click="saveBridgeConfig">Guardar</Button>
          </div>
          <p class="-mt-2 text-xs text-ink-faint">
            URL resultante: <code class="font-mono text-accent">{{ bridgeUrl }}</code>
          </p>

          <div class="border-t border-border pt-5">
            <p class="text-sm font-medium text-ink">Ruta de red — Tablas DBF de SISCOMMATE (VisualFoxPro)</p>
            <p class="mt-1 text-xs text-ink-muted">
              Ruta UNC o de red donde residen los archivos <code class="font-mono">.DBF</code> de SISCOMMATE.
              Ejemplo: <code class="font-mono">\\SERVIDOR\SISCOMMATE\DATA</code>
            </p>
            <div class="mt-3 grid grid-cols-12 items-end gap-x-3 gap-y-2.5">
              <div class="col-span-12 md:col-span-9 flex flex-col gap-1">
                <Label class="text-xs">Ruta de tablas DBF</Label>
                <Input v-model="dbfPath" class="font-mono text-sm" />
              </div>
              <Button class="col-span-12 md:col-span-3" @click="saveDbfPath">Guardar</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- ── Tipos de contenedor ── -->
      <Card class="mt-6">
        <CardHeader>
          <div class="flex items-center gap-2">
            <CardTitle>Tipos de contenedor XML → Tamaño SISCOMMATE</CardTitle>
            <Badge class="bg-accent-soft text-accent">{{ filas.length }} registros</Badge>
          </div>
          <CardDescription>
            Mapea los códigos <code class="font-mono">&lt;ContainerType&gt;</code> del XML de
            DGA al tamaño que espera SISCOMMATE. Se aplica automáticamente al importar un XML.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead class="w-24">Código XML</TableHead>
                <TableHead class="w-32">Tamaño</TableHead>
                <TableHead>Descripción / Etiqueta</TableHead>
                <TableHead class="w-20 text-right">Acción</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="fila in filas" :key="fila.xml_type">
                <TableCell>
                  <code class="font-mono text-sm font-semibold text-accent">{{ fila.xml_type }}</code>
                </TableCell>
                <TableCell>
                  <Select v-model="fila.size" @update:model-value="guardarFila(fila)">
                    <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="s in opciones(fila.size)" :key="s" :value="s">{{ s }}</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Input v-model="fila.label" class="h-8 max-w-sm text-sm" @change="guardarFila(fila)" />
                </TableCell>
                <TableCell class="text-right">
                  <Button variant="ghost" size="icon-sm" class="text-destructive hover:text-destructive" title="Eliminar" @click="eliminarFila(fila.xml_type)">
                    <Trash2 class="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell>
                  <Input v-model="nuevoTipo" placeholder="ej. 13" class="h-8 font-mono text-sm" />
                </TableCell>
                <TableCell>
                  <Select v-model="nuevoTamano">
                    <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="s in (tamanosValidos.length ? tamanosValidos : FALLBACK_TAMANOS)" :key="s" :value="s">{{ s }}</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Input v-model="nuevaEtiqueta" placeholder="ej. 40ft High Cube Refrigerado" class="h-8 max-w-sm text-sm" />
                </TableCell>
                <TableCell class="text-right">
                  <Button size="sm" @click="agregarTipo">+ Agregar</Button>
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>

      <!-- ── Historial de envíos a SISCOMMATE ── -->
      <Card class="mt-6">
        <CardHeader>
          <div class="flex items-center gap-2">
            <CardTitle>Historial de envíos a SISCOMMATE</CardTitle>
            <Badge class="bg-accent-soft text-accent">{{ historial.length }} envíos</Badge>
          </div>
          <CardDescription>
            Cada fila es un push real al bridge — el lote es lo que permite ubicar el
            envío en la base de SISCOMMATE. Este es nuestro registro local; para ver lo
            que de verdad quedó grabado, abrí el manifiesto en el editor y usá
            "Ver en SISCOMMATE".
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table v-if="historial.length">
            <TableHeader>
              <TableRow>
                <TableHead>Viaje</TableHead>
                <TableHead class="w-24">Lote</TableHead>
                <TableHead class="w-20 text-right">B/L</TableHead>
                <TableHead class="w-40">Fecha de envío</TableHead>
                <TableHead class="w-28">Estado actual</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="envio in historial" :key="envio.id">
                <TableCell class="font-medium">{{ envio.voyage_no }}</TableCell>
                <TableCell><code class="font-mono text-sm text-accent">{{ envio.lote }}</code></TableCell>
                <TableCell class="text-right">{{ envio.bl_count }}</TableCell>
                <TableCell class="text-ink-muted">{{ fechaCorta(envio.pushed_at) }}</TableCell>
                <TableCell>
                  <Badge v-if="envio.manifest_status === 'siscommate'" class="bg-status-siscommate-soft text-status-siscommate">Enviado</Badge>
                  <Badge v-else class="bg-paper-sunken text-ink-muted">{{ envio.manifest_status || '—' }}</Badge>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p v-else class="text-sm text-ink-faint">Todavía no se hizo ningún envío a SISCOMMATE.</p>
        </CardContent>
      </Card>
    </main>

    <div v-if="toastMsg" class="fixed bottom-5 right-5 rounded-md px-4 py-2.5 text-sm shadow-lg" :class="toastTipo === 'ok' ? 'bg-ink text-status-validated-soft' : 'bg-danger text-white'">
      {{ toastTipo === 'ok' ? '✓ ' : '⚠ ' }}{{ toastMsg }}
    </div>
  </div>
</template>
