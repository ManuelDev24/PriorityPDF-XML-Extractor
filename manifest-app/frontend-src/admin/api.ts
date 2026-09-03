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
};
