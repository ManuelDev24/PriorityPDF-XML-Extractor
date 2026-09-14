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

/** Resultado de crear/actualizar un cliente — separa el guardado local del
 * intento de escribir en CUSTOMER.DBF real (best-effort, puede fallar sin
 * perder el guardado local). */
export interface ResultadoGuardarCliente {
  ok: true;
  client: Cliente;
  siscommate: { ok: boolean; error?: string };
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
};
