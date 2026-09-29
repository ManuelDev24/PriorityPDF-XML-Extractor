// api.ts — Acceso a la API del backend, tipado.
//
// Los tipos espejan lo que devuelven las rutas de backend/routes/settings.js.

export interface Settings {
  bridge_host?: string;
  bridge_port?: string;
  dbf_path?: string;
}

export interface BridgeStatus {
  online: boolean;
  version?: string;
  error?: string;
}

/** Fila de la tabla container_type_map: código del XML → tamaño SISCOMMATE. */
export interface ContainerType {
  xml_type: string;
  size: string;
  label: string;
}

/** Fila de siscommate_push_log: un envío real a SISCOMMATE. */
export interface EnvioSiscommate {
  id: number;
  manifest_id: number;
  voyage_no: string;
  lote: string;
  bl_count: number;
  pushed_at: string;
  manifest_status: string | null;
}

async function pedir<T>(url: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<T>;
}

function json(body: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Resultado de correr un análisis de sugerencias — las claves varían según cuál. */
export interface ResultadoAnalisis { ok: true; [clave: string]: unknown; }

/** Fila del catálogo local de clientes (caché de CUSTOMER.DBF). */
export interface Cliente {
  id: number;
  name: string;
  ss: string;
  code?: string;
  type?: string;
  taxid?: string;
  add1?: string;
  add2?: string;
  add3?: string;
  phone1?: string;
  phone2?: string;
  fax1?: string;
  fax2?: string;
  ivu?: string;
}

export interface ResultadoSincronizarClientes {
  ok: true;
  total_siscommate: number;
  creados: number;
  actualizados: number;
  sin_cambios: number;
}

export interface ResultadoSincronizarConsignadores {
  ok: true;
  total_siscommate: number;
  canonicos: number;
  nuevos: number;
}

/**
 * Un cliente local dentro de un grupo de posibles duplicados — ver
 * detectarClientesDuplicados. existe_en_siscommate llega vacío (undefined)
 * hasta que se verifica esa página en vivo contra SISCOMMATE (ver
 * verificarClientesSiscommate) — null significa que sí se intentó verificar
 * pero el bridge no respondió, nunca se asume nada en ese caso.
 */
export interface ClienteDuplicado {
  id: number;
  name: string;
  ss: string;
  existe_en_siscommate?: boolean | null;
}

/** Una página de resultados con paginación real (offset+total de la búsqueda, no del catálogo completo). */
export interface Pagina<T> { total: number; rows: T[]; }

/** Una página de grupos de duplicados (offset+total de grupos, no de filas). */
export interface PaginaGrupos<T> { total: number; groups: T[][]; }

/**
 * Fila del catálogo de consignadores (consignor_catalog) — SISCOMMATE solo
 * da el nombre (BOL.exporter es texto libre); el resto son campos editables
 * a mano desde Admin, sin fuente real que sincronizar.
 */
export interface Consignador {
  name: string;
  document_no?: string;
  tel?: string;
  street?: string;
  city?: string;
}

/** Resultado de crear/actualizar un cliente — separa el guardado local del
 * intento de escribir en CUSTOMER.DBF real (best-effort, puede fallar sin
 * perder el guardado local). */
export interface ResultadoGuardarCliente {
  ok: true;
  client: Cliente;
  siscommate: { ok: boolean; error?: string };
}

/** Una fila del plan de reinyección — ver backend/services/dataAudit/reinyectar.js */
export interface CambioAuditoria {
  hoja: string;
  claves: Record<string, unknown>;
  cambios: Record<string, { antes: unknown; despues: unknown }>;
  error: string | null;
}

export interface PreviewAuditoria {
  token: string;
  plan: CambioAuditoria[];
  vistaPrevia: string;
}

export interface ResultadoAplicarAuditoria {
  aplicados: number;
  fallidos: number;
}

export const api = {
  getSettings: () => pedir<Settings>('/api/settings'),

  saveSettings: (s: Settings) => pedir<{ ok: true }>('/api/settings', json(s)),

  getBridgeStatus: () => pedir<BridgeStatus>('/api/bridge/status'),

  getContainerTypes: () => pedir<ContainerType[]>('/api/catalogs/container-types'),
  getContainerSizes: () => pedir<string[]>('/api/catalogs/container-sizes'),

  saveContainerType: (xmlType: string, size: string, label: string) =>
    pedir<{ ok: true }>(
      `/api/catalogs/container-types/${encodeURIComponent(xmlType)}`,
      json({ size, label })
    ),

  addContainerType: (xml_type: string, size: string, label: string) =>
    pedir<{ ok: true }>('/api/catalogs/container-types', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xml_type, size, label }),
    }),

  deleteContainerType: (xmlType: string) =>
    pedir<{ ok: true }>(
      `/api/catalogs/container-types/${encodeURIComponent(xmlType)}`,
      { method: 'DELETE' }
    ),

  getHistorialSiscommate: () => pedir<EnvioSiscommate[]>('/api/siscommate/history'),

  // Sugerencias inteligentes (código arancelario, SS/EIN, nombre consignatario)
  analizarClientesSiscommate: () =>
    pedir<ResultadoAnalisis>('/api/catalogs/items/analizar-clientes', { method: 'POST' }),
  analizarHistorialLocal: () =>
    pedir<ResultadoAnalisis>('/api/catalogs/items/analizar-historial-local', { method: 'POST' }),

  // Catálogo de clientes (caché local de CUSTOMER.DBF)
  buscarClientes: (q: string, limit = 50) =>
    pedir<Cliente[]>(`/api/catalogs/clients?q=${encodeURIComponent(q)}&limit=${limit}`),
  contarClientes: () => pedir<{ total: number }>('/api/catalogs/clients/count'),
  sincronizarClientesSiscommate: () =>
    pedir<ResultadoSincronizarClientes>('/api/catalogs/clients/sincronizar-siscommate', { method: 'POST' }),
  // Lista completa con paginación real — a diferencia de buscarClientes
  // (usado también por el editor, capado a un puñado de resultados para
  // autocompletar), esta trae el total REAL de la búsqueda para poder
  // navegar hasta el final sin que nada quede invisible.
  listaClientes: (q: string, limit: number, offset: number) =>
    pedir<Pagina<Cliente>>(`/api/catalogs/clients/lista?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`),

  // Catálogo de consignadores (nombres de BOL.exporter, histórico real de
  // SISCOMMATE, consolidados por similitud)
  contarConsignadoresSiscommate: () => pedir<{ total: number }>('/api/catalogs/consignors-siscommate/count'),
  sincronizarConsignadoresSiscommate: () =>
    pedir<ResultadoSincronizarConsignadores>('/api/catalogs/consignors/sincronizar-siscommate', { method: 'POST' }),
  consignadoresDuplicados: (limit: number, offset: number) =>
    pedir<PaginaGrupos<string>>(`/api/catalogs/consignors-siscommate/duplicados?limit=${limit}&offset=${offset}`),
  eliminarConsignadorSiscommate: (name: string) =>
    pedir<{ ok: true }>(`/api/catalogs/consignors-siscommate/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  listaConsignadores: (q: string, limit: number, offset: number) =>
    pedir<Pagina<Consignador>>(`/api/catalogs/consignors-siscommate/lista?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`),
  actualizarConsignador: (name: string, datos: Partial<Consignador>) =>
    pedir<{ ok: true }>(`/api/catalogs/consignors-siscommate/${encodeURIComponent(name)}`, json(datos)),

  // Duplicados de clientes: la lista de grupos es rápida (agrupación local,
  // sin bridge) y paginada; verificar cuál variante sigue en SISCOMMATE es
  // lento (una consulta al bridge por nombre) así que se pide aparte, acotado
  // a los nombres de la página que se está mostrando — nunca el catálogo
  // completo de un tirón (eso fue lo que colgaba el navegador antes).
  clientesDuplicados: (limit: number, offset: number) =>
    pedir<PaginaGrupos<ClienteDuplicado>>(`/api/catalogs/clients/duplicados?limit=${limit}&offset=${offset}`),
  verificarClientesSiscommate: (nombres: string[]) =>
    pedir<{ ok: true; estado: Record<string, boolean | null> }>('/api/catalogs/clients/duplicados/verificar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombres }),
    }),
  crearCliente: (c: Partial<Cliente>) =>
    pedir<ResultadoGuardarCliente>('/api/catalogs/clients', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c),
    }),
  actualizarCliente: (id: number, c: Partial<Cliente>) =>
    pedir<ResultadoGuardarCliente>(`/api/catalogs/clients/${id}`, json(c)),
  eliminarCliente: (id: number) =>
    pedir<{ ok: true; deleted: string; siscommate: { ok: boolean; error?: string } }>(
      `/api/catalogs/clients/${id}`, { method: 'DELETE' }
    ),

  // Auditoría de datos (SQLite + SISCOMMATE vía Excel)
  urlExportarAuditoria: () => '/api/data-audit/exportar',
  previewAuditoria: async (archivo: File) => {
    const form = new FormData();
    form.append('archivo', archivo);
    const r = await fetch('/api/data-audit/preview', { method: 'POST', body: form });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || await r.text());
    return r.json() as Promise<PreviewAuditoria>;
  },
  aplicarAuditoria: (token: string) =>
    pedir<ResultadoAplicarAuditoria>('/api/data-audit/aplicar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    }),
};
