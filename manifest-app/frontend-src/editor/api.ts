// api.ts — Acceso tipado a la API del backend.
//
// Los tipos espejan backend/types.js. Cuando cambie una forma alla, aqui
// tiene que cambiar tambien: vue-tsc avisa si algo deja de encajar.

export interface Manifiesto {
  id: number;
  filename: string;
  voyage_no: string;
  vessel_code: string;
  vessel_name: string;
  loading_port: string;
  unloading_port: string;
  discharge_port?: string;
  departure_date: string;
  arrival_date: string;
  manifest_no: string;
  carrier_code: string;
  status: string;
  created_at: string;
  exported_at?: string;
  docking_number?: string;
  imo?: string;
  bl_count?: number;
}

export interface BL {
  id: number;
  manifest_id: number;
  bl_no: string;
  goods_name: string;
  package_unit_code: string;
  package_qty: number | string;
  gross_weight: number | string;
  value: number | string;
  unloading_port_code: string;
  consignor_name: string;
  consignor_document_no: string;
  consignor_document_type: string;
  consignor_tel: string;
  consignor_email: string;
  consignor_street: string;
  consignor_city: string;
  consignor_zip: string;
  consignee_name: string;
  consignee_document_no: string;
  consignee_tel: string;
  consignee_email: string;
  consignee_street: string;
  consignee_city: string;
  consignee_zip: string;
  hacienda_item_code?: string;
  hacienda_tariff?: string;
  hacienda_container_no?: string;
  hacienda_client_ss?: string;
  hacienda_client_ivu?: string;
  status: string;
  notes?: string;
}

export interface Contenedor {
  id: number;
  container_no: string;
  container_type: string;
  size?: string;
  amount?: number;
}

export interface VinculoContenedor {
  container_no: string;
  bl_no: string;
  manifest_id: number;
}

export interface DatosManifiesto {
  manifest: Manifiesto;
  bls: BL[];
  containers: Contenedor[];
  container_bl: VinculoContenedor[];
}

export interface ItemCarga {
  id: number;
  bl_id: number;
  container_no: string | null;
  goods_name: string;
  gross_weight: number | string;
  hacienda_item_code: string | null;
  hacienda_tariff: string | null;
  seq: number;
  package_qty: number | string;
}

export interface ItemHacienda {
  code: string;
  description: string;
  unit?: string;
  tariff?: string;
  taxable?: number;
}

export interface Cliente {
  id: number;
  name: string;
  ss: string;
  taxid?: string;
  add1?: string;
  add2?: string;
  phone1?: string;
  ivu?: string;
}

/** Cliente real de SISCOMMATE (tabla CUSTOMER, vía el bridge) — de solo lectura. */
export interface ClienteSiscommate {
  name: string;
  ss: string;
  code?: string;
  taxid?: string;
  add1?: string;
  add2?: string;
  add3?: string;
  phone1?: string;
  ivu?: string;
}

export interface Puerto { code: string; description: string; country: string }
export interface Carrier { code: string; name: string; scac: string; ivu?: string }
export interface Buque   { code: string; name: string; imo: string; carrier: string; scac: string }

export interface Estadisticas {
  manifests: number;
  bls: number;
  pending: number;
  siscommate: number;
}

export interface ResultadoBusqueda {
  manifests: Manifiesto[];
  bls: Array<Pick<BL, 'id' | 'bl_no' | 'consignee_name' | 'status' | 'manifest_id'> & {
    voyage_no: string; vessel_name: string; arrival_date: string;
  }>;
}

export interface ParTxt { containerNo: string; line1: string; line2: string }
export interface VistaPreviaTxt { pairs: ParTxt[]; line1: string; line2: string }

export interface EstadoBridge { online: boolean; version?: string; error?: string }

/** Lo que de verdad quedó grabado en SISCOMMATE para un viaje (lectura directa del DBF). */
export interface DatosSiscommateVivo {
  encontrado: boolean;
  manifest: Record<string, unknown> | null;
  bls: Record<string, unknown>[];
  items: Record<string, unknown>[];
  containers: Record<string, unknown>[];
}

// ── Cliente HTTP ─────────────────────────────────────────────────────────────
async function pedir<T>(url: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<T>;
}

const cuerpo = (metodo: string, body: unknown): RequestInit => ({
  method: metodo,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  // Manifiestos
  listarManifiestos: () => pedir<Manifiesto[]>('/api/manifests'),
  crearManifiesto: (voyageNo: string) =>
    pedir<{ ok: true; manifest: Manifiesto }>('/api/manifests', cuerpo('POST', { voyage_no: voyageNo })),
  obtenerManifiesto: (id: number) => pedir<DatosManifiesto>(`/api/manifests/${id}`),
  actualizarManifiesto: (id: number, campos: Partial<Manifiesto>) =>
    pedir<{ ok: true }>(`/api/manifests/${id}`, cuerpo('PUT', campos)),
  eliminarManifiesto: (id: number) =>
    pedir<{ ok: true }>(`/api/manifests/${id}`, { method: 'DELETE' }),

  // B/L
  crearBL: (manifestId: number, blNo: string) =>
    pedir<{ ok: true; bl: BL }>(`/api/manifests/${manifestId}/bl`, cuerpo('POST', { bl_no: blNo })),
  actualizarBL: (id: number, campos: Partial<BL>) =>
    pedir<{ ok: true }>(`/api/bl/${id}`, cuerpo('PUT', campos)),
  eliminarBL: (id: number) =>
    pedir<{ ok: true }>(`/api/bl/${id}`, { method: 'DELETE' }),
  moverBL: (id: number, manifestId: number) =>
    pedir<{ ok: true; bl_no: string; manifest_id_anterior: number; manifest_id_nuevo: number }>(
      `/api/bl/${id}/mover`, cuerpo('PUT', { manifest_id: manifestId })
    ),
  vistaPreviaTxt: (id: number) => pedir<VistaPreviaTxt>(`/api/bl/${id}/txt-preview`),

  // Contenedores
  actualizarTamano: (id: number, size: string) =>
    pedir<{ ok: true }>(`/api/containers/${id}`, cuerpo('PUT', { size })),

  // Items de carga
  listarItems: (blId: number) => pedir<ItemCarga[]>(`/api/bl/${blId}/cargo-items`),
  crearItem: (blId: number, item: Partial<ItemCarga>) =>
    pedir<{ ok: true; item: ItemCarga }>(`/api/bl/${blId}/cargo-items`, cuerpo('POST', item)),
  actualizarItem: (id: number, campos: Partial<ItemCarga>) =>
    pedir<{ ok: true }>(`/api/bl-cargo-items/${id}`, cuerpo('PUT', campos)),
  eliminarItem: (id: number) =>
    pedir<{ ok: true }>(`/api/bl-cargo-items/${id}`, { method: 'DELETE' }),

  // Catalogos
  buscarItems: (q: string) => pedir<ItemHacienda[]>(`/api/catalogs/items?q=${encodeURIComponent(q)}`),
  sugerirItems: (desc: string) => pedir<ItemHacienda[]>(`/api/catalogs/items/suggest?desc=${encodeURIComponent(desc)}`),
  buscarClientes: (q: string) => pedir<Cliente[]>(`/api/catalogs/clients?q=${encodeURIComponent(q)}`),
  buscarClientesSiscommate: (q: string) =>
    pedir<ClienteSiscommate[]>(`/api/catalogs/siscommate-clients?q=${encodeURIComponent(q)}`),
  crearCliente: (c: Partial<Cliente> & { phone1?: string }) =>
    pedir<{ ok: true; client: Cliente }>('/api/catalogs/clients', cuerpo('POST', c)),
  actualizarCliente: (id: number, c: Partial<Cliente> & { phone1?: string }) =>
    pedir<{ ok: true; client: Cliente }>(`/api/catalogs/clients/${id}`, cuerpo('PUT', c)),
  puertos: () => pedir<Puerto[]>('/api/catalogs/ports'),
  carriers: () => pedir<Carrier[]>('/api/catalogs/carriers'),
  buques: () => pedir<Buque[]>('/api/catalogs/vessels'),
  tamanosContenedor: () => pedir<string[]>('/api/catalogs/container-sizes'),

  // Otros
  estadisticas: () => pedir<Estadisticas>('/api/stats'),
  buscar: (q: string) => pedir<ResultadoBusqueda>(`/api/search?q=${encodeURIComponent(q)}`),
  estadoBridge: () => pedir<EstadoBridge>('/api/bridge/status'),
  pushSiscommate: (id: number) =>
    pedir<{ ok: true; lote_anterior: number | null; lote_nuevo: number; enviados: number }>(
      `/api/manifests/${id}/push-siscommate`, { method: 'POST' }
    ),
  siscommateVivo: (id: number) =>
    pedir<DatosSiscommateVivo>(`/api/manifests/${id}/siscommate-live`),
};
