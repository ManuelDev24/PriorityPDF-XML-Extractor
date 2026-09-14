<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api, type ContainerType, type EnvioSiscommate, type Cliente } from '../admin/api';
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Trash2, Search, RefreshCw, Plus } from '@lucide/vue';
import ClientesTable from './ClientesTable.vue';

// Recordar la pestaña activa entre recargas — conveniencia por navegador,
// no dato que valga la pena guardar en el servidor.
function pestanaGuardada(): string {
  try { return localStorage.getItem('admin_pestana') || 'config'; } catch { return 'config'; }
}
const pestanaAdmin = ref(pestanaGuardada());
function cambiarPestanaAdmin(v: string) {
  pestanaAdmin.value = v;
  try { localStorage.setItem('admin_pestana', v); } catch { /* privado/bloqueado: no pasa nada */ }
}

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

// ── Sugerencias inteligentes: código arancelario, SS/EIN, nombre ───────────
// Dos fuentes de historial distintas para el mismo objetivo (ver
// backend/services/itemClientAnalysis.js y localHistoryAnalysis.js):
// SISCOMMATE completo (todos los usuarios) vs. el uso real de Priority en
// esta app. Ninguna corre sola — el historial no cambia de un día para
// otro y consultar SISCOMMATE repetidamente puede tardar.
const corriendoSiscommate = ref(false);
const corriendoLocal = ref(false);
const resultadoSiscommate = ref<Record<string, unknown> | null>(null);
const resultadoLocal = ref<Record<string, unknown> | null>(null);

async function correrAnalisisSiscommate() {
  corriendoSiscommate.value = true;
  resultadoSiscommate.value = null;
  try {
    const r = await api.analizarClientesSiscommate();
    resultadoSiscommate.value = r;
    toast('Análisis contra SISCOMMATE completado');
  } catch (e) {
    let msg = 'Error al analizar';
    try { msg = JSON.parse((e as Error).message).error || msg; } catch { /* texto plano */ }
    toast(msg, 'err');
  } finally { corriendoSiscommate.value = false; }
}

async function correrAnalisisLocal() {
  corriendoLocal.value = true;
  resultadoLocal.value = null;
  try {
    const r = await api.analizarHistorialLocal();
    resultadoLocal.value = r;
    toast('Análisis del historial local completado');
  } catch (e) {
    let msg = 'Error al analizar';
    try { msg = JSON.parse((e as Error).message).error || msg; } catch { /* texto plano */ }
    toast(msg, 'err');
  } finally { corriendoLocal.value = false; }
}

// ── Catálogo de clientes (caché local de CUSTOMER.DBF de SISCOMMATE) ──
const totalClientes = ref<number | null>(null);
const busquedaCliente = ref('');
const clientesFiltrados = ref<Cliente[]>([]);
const buscandoClientes = ref(false);
const sincronizandoClientes = ref(false);
const resultadoSincronizacion = ref<{ creados: number; actualizados: number; sin_cambios: number; total_siscommate: number } | null>(null);
let temporizadorBusqueda: ReturnType<typeof setTimeout> | undefined;

async function cargarTotalClientes() {
  try { totalClientes.value = (await api.contarClientes()).total; }
  catch { totalClientes.value = null; }
}

async function buscarClientesAdmin() {
  buscandoClientes.value = true;
  try { clientesFiltrados.value = await api.buscarClientes(busquedaCliente.value, 100); }
  catch { clientesFiltrados.value = []; }
  finally { buscandoClientes.value = false; }
}

function alBuscarCliente() {
  clearTimeout(temporizadorBusqueda);
  temporizadorBusqueda = setTimeout(buscarClientesAdmin, 250);
}

async function sincronizarClientes() {
  sincronizandoClientes.value = true;
  resultadoSincronizacion.value = null;
  try {
    const r = await api.sincronizarClientesSiscommate();
    resultadoSincronizacion.value = r;
    toast(`Catálogo actualizado: ${r.creados} nuevos, ${r.actualizados} actualizados`);
    await cargarTotalClientes();
    await buscarClientesAdmin();
  } catch (e) {
    let msg = 'Error al sincronizar';
    try { msg = JSON.parse((e as Error).message).error || msg; } catch { /* texto plano */ }
    toast(msg, 'err');
  } finally { sincronizandoClientes.value = false; }
}

// ── Crear / editar un cliente — escribe local Y en CUSTOMER.DBF real ──
// (best-effort: si el bridge falla, el guardado local no se pierde, pero se
// avisa claramente que no llegó a SISCOMMATE — ver routes/catalogs.js).
type FormCliente = { id: number | null } & Omit<Cliente, 'id'>;
const CLIENTE_VACIO = (): FormCliente => ({
  id: null, name: '', ss: '', code: '', type: '', taxid: '',
  add1: '', add2: '', add3: '', phone1: '', phone2: '', fax1: '', fax2: '', ivu: '',
});
const clienteForm = ref<FormCliente | null>(null);
const guardandoCliente = ref(false);

function abrirNuevoCliente() { clienteForm.value = CLIENTE_VACIO(); }
function abrirEditarCliente(c: Cliente) { clienteForm.value = { ...c }; }

async function guardarCliente() {
  const f = clienteForm.value;
  if (!f || !f.name.trim()) { toast('El nombre es requerido', 'err'); return; }
  guardandoCliente.value = true;
  try {
    const r = f.id !== null ? await api.actualizarCliente(f.id, f) : await api.crearCliente(f);
    if (r.siscommate.ok) {
      toast(`Guardado — reflejado en SISCOMMATE`);
    } else {
      toast(`Guardado local, pero no en SISCOMMATE: ${r.siscommate.error}`, 'err');
    }
    clienteForm.value = null;
    await cargarTotalClientes();
    await buscarClientesAdmin();
  } catch (e) {
    let msg = 'Error al guardar';
    try { msg = JSON.parse((e as Error).message).error || msg; } catch { /* texto plano */ }
    toast(msg, 'err');
  } finally { guardandoCliente.value = false; }
}

// ── Eliminar cliente(s) — local Y en CUSTOMER.DBF real ──
// Irreversible: confirmación con window.confirm, mismo patrón que ya usa
// "Eliminar" en Tipos de contenedor más arriba en este archivo.
async function eliminarUnCliente(id: number, nombre: string) {
  try {
    const r = await api.eliminarCliente(id);
    toast(r.siscommate.ok ? 'Eliminado — también en SISCOMMATE' : `Eliminado local, pero no en SISCOMMATE: ${r.siscommate.error}`, r.siscommate.ok ? 'ok' : 'err');
  } catch (e) {
    let msg = 'Error al eliminar';
    try { msg = JSON.parse((e as Error).message).error || msg; } catch { /* texto plano */ }
    toast(`No se pudo eliminar "${nombre}": ${msg}`, 'err');
  }
}

const confirmarEliminarCliente = ref<{ mensaje: string; accion: () => void } | null>(null);

function pedirEliminarCliente(c: Cliente) {
  confirmarEliminarCliente.value = {
    mensaje: `¿Eliminar "${c.name}" del catálogo local Y de SISCOMMATE? Esta acción no se puede deshacer.`,
    accion: () => {
      confirmarEliminarCliente.value = null;
      eliminarUnCliente(c.id, c.name).then(() => { cargarTotalClientes(); buscarClientesAdmin(); });
    },
  };
}

function pedirEliminarClientes(clientes: Cliente[]) {
  confirmarEliminarCliente.value = {
    mensaje: `¿Eliminar ${clientes.length} clientes seleccionados del catálogo local Y de SISCOMMATE? Esta acción no se puede deshacer.`,
    accion: async () => {
      confirmarEliminarCliente.value = null;
      for (const c of clientes) await eliminarUnCliente(c.id, c.name);
      await cargarTotalClientes();
      await buscarClientesAdmin();
    },
  };
}

onMounted(() => {
  cargarSettings(); cargarTipos(); cargarTamanos(); checkBridge(); cargarHistorial();
  cargarTotalClientes(); buscarClientesAdmin();
});
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

    <!-- Configuración se queda angosta (son formularios cortos, se leen mejor
         así) — Clientes necesita todo el ancho posible: son hasta 13 columnas
         reales de CUSTOMER.DBF y una tabla angosta las hace ilegibles. -->
    <main class="mx-auto px-6 py-8" :class="pestanaAdmin === 'clientes' ? 'max-w-none' : 'max-w-4xl'">
      <h1 class="text-2xl font-semibold text-ink">Administración</h1>
      <p class="mt-1 text-sm text-ink-muted">
        Configuración del sistema, mapeo de contenedores, conexión con SISCOMMATE y catálogo de clientes
      </p>

      <Tabs :model-value="pestanaAdmin" class="mt-6" @update:model-value="(v) => cambiarPestanaAdmin(String(v))">
        <TabsList>
          <TabsTrigger value="config">Configuración</TabsTrigger>
          <TabsTrigger value="clientes">
            Clientes
            <Badge v-if="totalClientes !== null" class="ml-1.5 bg-accent-soft text-accent">{{ totalClientes }}</Badge>
          </TabsTrigger>
        </TabsList>

      <TabsContent value="config">
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

      <!-- ── Sugerencias inteligentes (código, SS/EIN, nombre consignatario) ── -->
      <Card class="mt-6">
        <CardHeader>
          <CardTitle>Sugerencias inteligentes</CardTitle>
          <CardDescription>
            Mejoran solo con el uso, pero no se recalculan automáticamente — el
            historial no cambia de un día para otro. Corré el análisis que
            corresponda cuando quieras refrescar las sugerencias.
          </CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-5">
          <div class="flex flex-col gap-2 rounded-lg border border-border p-3.5">
            <div class="flex items-center justify-between gap-3">
              <div>
                <p class="text-sm font-medium">Historial local de Priority</p>
                <p class="text-xs text-ink-faint">
                  Descripción → código y código → consignatario, según lo que tus
                  propios operadores ya escogieron en esta app.
                </p>
              </div>
              <Button size="sm" :disabled="corriendoLocal" @click="correrAnalisisLocal">
                {{ corriendoLocal ? 'Analizando…' : 'Analizar historial local' }}
              </Button>
            </div>
            <p v-if="resultadoLocal" class="text-xs text-status-validated">
              {{ resultadoLocal.descripciones_aprendidas }} de {{ resultadoLocal.descripciones_con_historial }}
              descripciones aprendidas · {{ resultadoLocal.codigos_aprendidos }} de {{ resultadoLocal.codigos_con_historial }}
              códigos con consignatario aprendido · {{ resultadoLocal.consignadores_aprendidos }} de
              {{ resultadoLocal.consignadores_con_historial }} códigos con consignador aprendido.
            </p>
          </div>

          <div class="flex flex-col gap-2 rounded-lg border border-border p-3.5">
            <div class="flex items-center justify-between gap-3">
              <div>
                <p class="text-sm font-medium">Historial completo de SISCOMMATE</p>
                <p class="text-xs text-ink-faint">
                  Código → consignatario más frecuente entre TODOS los usuarios de
                  SISCOMMATE, no solo Priority. Consulta el bridge repetidamente —
                  puede tardar.
                </p>
              </div>
              <Button size="sm" variant="outline" :disabled="corriendoSiscommate" @click="correrAnalisisSiscommate">
                {{ corriendoSiscommate ? 'Analizando…' : 'Analizar SISCOMMATE' }}
              </Button>
            </div>
            <p v-if="resultadoSiscommate" class="text-xs text-status-validated">
              {{ resultadoSiscommate.codigos_asociados_local }} asociados por catálogo local ·
              {{ resultadoSiscommate.codigos_asociados_siscommate }} por CUSTOMER.DBF ·
              {{ resultadoSiscommate.sin_ss }} sin SS/EIN encontrado.
            </p>
          </div>
        </CardContent>
      </Card>
      </TabsContent>

      <TabsContent value="clientes">
        <Card>
          <CardHeader>
            <div class="flex items-center gap-2">
              <CardTitle>Catálogo de clientes</CardTitle>
              <Badge v-if="totalClientes !== null" class="bg-accent-soft text-accent">{{ totalClientes }} en total</Badge>
            </div>
            <CardDescription>
              Caché local de la tabla CUSTOMER de SISCOMMATE — se usa para autocompletar
              consignatario/consignador y para avisar cuando un nombre nuevo se parece
              mucho a uno ya conocido (posible error de digitación). Ella corrige en
              SISCOMMATE, no acá — este botón trae esos cambios.
            </CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-3.5">
            <div class="flex items-center gap-3">
              <Button :disabled="sincronizandoClientes" @click="sincronizarClientes">
                <RefreshCw class="size-3.5" :class="sincronizandoClientes && 'animate-spin'" />
                {{ sincronizandoClientes ? 'Sincronizando…' : 'Actualizar desde SISCOMMATE' }}
              </Button>
              <Button variant="outline" @click="abrirNuevoCliente"><Plus class="size-3.5" />Nuevo cliente</Button>
              <p v-if="resultadoSincronizacion" class="text-xs text-status-validated">
                {{ resultadoSincronizacion.creados }} nuevos ·
                {{ resultadoSincronizacion.actualizados }} actualizados ·
                {{ resultadoSincronizacion.sin_cambios }} sin cambios
                (de {{ resultadoSincronizacion.total_siscommate }} en SISCOMMATE)
              </p>
            </div>

            <div class="flex items-center gap-2 border-t border-border pt-3.5">
              <Search class="size-3.5 shrink-0 text-ink-faint" />
              <Input
                v-model="busquedaCliente" placeholder="Buscar por nombre, SS/EIN o IVU..."
                class="h-8 max-w-sm text-sm" @input="alBuscarCliente"
              />
              <span v-if="buscandoClientes" class="text-xs text-ink-faint">Buscando…</span>
              <span v-else class="text-xs text-ink-faint">{{ clientesFiltrados.length }} resultados</span>
            </div>

            <ClientesTable
              :clientes="clientesFiltrados" @editar="abrirEditarCliente"
              @eliminar-uno="pedirEliminarCliente" @eliminar-varios="pedirEliminarClientes"
            />
            <p class="text-xs text-ink-faint">
              Muestra hasta 100 resultados a la vez — refiná la búsqueda si no encontrás lo que buscás.
            </p>
          </CardContent>
        </Card>
      </TabsContent>
      </Tabs>
    </main>

    <Dialog :open="!!clienteForm" @update:open="(v) => !v && (clienteForm = null)">
      <DialogContent v-if="clienteForm" class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ clienteForm.id !== null ? 'Editar cliente' : 'Nuevo cliente' }}</DialogTitle>
        </DialogHeader>
        <p class="-mt-2 text-xs text-ink-faint">
          Se guarda acá Y en CUSTOMER.DBF de SISCOMMATE — si el bridge no responde, el
          cambio local no se pierde, pero queda pendiente de reflejarse allá.
        </p>
        <div class="grid grid-cols-12 gap-x-3 gap-y-2.5">
          <div class="col-span-12 flex flex-col gap-1">
            <Label class="text-xs">Nombre / Razón social *</Label>
            <Input v-model="clienteForm.name" class="h-9 text-xs" />
          </div>
          <div class="col-span-6 md:col-span-4 flex flex-col gap-1">
            <Label class="text-xs">SS / EIN</Label>
            <Input v-model="clienteForm.ss" class="h-9 font-mono text-xs" />
          </div>
          <div class="col-span-6 md:col-span-4 flex flex-col gap-1">
            <Label class="text-xs">Tax ID</Label>
            <Input v-model="clienteForm.taxid" class="h-9 font-mono text-xs" />
          </div>
          <div class="col-span-6 md:col-span-2 flex flex-col gap-1">
            <Label class="text-xs">Código</Label>
            <Input v-model="clienteForm.code" class="h-9 font-mono text-xs" />
          </div>
          <div class="col-span-6 md:col-span-2 flex flex-col gap-1">
            <Label class="text-xs">Tipo</Label>
            <Input v-model="clienteForm.type" class="h-9 text-xs" />
          </div>
          <div class="col-span-12 flex flex-col gap-1">
            <Label class="text-xs">Dirección 1</Label>
            <Input v-model="clienteForm.add1" class="h-9 text-xs" />
          </div>
          <div class="col-span-12 md:col-span-6 flex flex-col gap-1">
            <Label class="text-xs">Dirección 2</Label>
            <Input v-model="clienteForm.add2" class="h-9 text-xs" />
          </div>
          <div class="col-span-12 md:col-span-6 flex flex-col gap-1">
            <Label class="text-xs">Dirección 3</Label>
            <Input v-model="clienteForm.add3" class="h-9 text-xs" />
          </div>
          <div class="col-span-6 flex flex-col gap-1">
            <Label class="text-xs">Teléfono</Label>
            <Input v-model="clienteForm.phone1" class="h-9 font-mono text-xs" />
          </div>
          <div class="col-span-6 flex flex-col gap-1">
            <Label class="text-xs">Teléfono 2</Label>
            <Input v-model="clienteForm.phone2" class="h-9 font-mono text-xs" />
          </div>
          <div class="col-span-6 flex flex-col gap-1">
            <Label class="text-xs">Fax</Label>
            <Input v-model="clienteForm.fax1" class="h-9 font-mono text-xs" />
          </div>
          <div class="col-span-6 flex flex-col gap-1">
            <Label class="text-xs">IVU</Label>
            <Input v-model="clienteForm.ivu" class="h-9 font-mono text-xs" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="clienteForm = null">Cancelar</Button>
          <Button :disabled="guardandoCliente || !clienteForm.name.trim()" @click="guardarCliente">
            {{ guardandoCliente ? 'Guardando…' : 'Guardar' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!confirmarEliminarCliente" @update:open="(v) => !v && (confirmarEliminarCliente = null)">
      <DialogContent v-if="confirmarEliminarCliente">
        <DialogHeader><DialogTitle>Eliminar cliente</DialogTitle></DialogHeader>
        <p class="text-sm text-ink-muted">{{ confirmarEliminarCliente.mensaje }}</p>
        <DialogFooter>
          <Button variant="outline" @click="confirmarEliminarCliente = null">Cancelar</Button>
          <Button variant="destructive" @click="confirmarEliminarCliente.accion">Eliminar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <div v-if="toastMsg" class="fixed bottom-5 right-5 rounded-md px-4 py-2.5 text-sm shadow-lg" :class="toastTipo === 'ok' ? 'bg-ink text-status-validated-soft' : 'bg-danger text-white'">
      {{ toastTipo === 'ok' ? '✓ ' : '⚠ ' }}{{ toastMsg }}
    </div>
  </div>
</template>
