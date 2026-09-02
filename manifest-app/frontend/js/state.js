// state.js — Estado global compartido entre los módulos del frontend
// Extraído de index.html (paso 6 de la separación frontend/backend)

let allManifests       = [];
let currentManifestId  = null;
let currentManifestData= null;
let currentBL          = null;
let catalogCarriers    = [];
let catalogPorts       = [];
let catalogVessels     = [];
const expandedSet      = new Set(); // IDs de manifiestos con BL-list expandido

// ── Guardado diferido ────────────────────────────────────────────────────────
// Antes había un solo `saveTimer` compartido por updateBL y updateManifest, y
// ambos hacían clearTimeout sobre él. Eso cancelaba guardados en silencio:
//   - elegir un buque dispara 4 updateManifest seguidos (vessel_code,
//     vessel_name, imo, carrier_code) y solo sobrevivía el último;
//   - editar un campo del B/L y tocar el manifiesto antes de 600 ms cancelaba
//     el guardado del B/L.
// Ahora los cambios se acumulan por entidad y se envían juntos en un solo PUT.
let blSaveTimer        = null;
let manifestSaveTimer  = null;
let pendingBL          = { id: null, campos: {} };
let pendingManifest    = { id: null, campos: {} };

// Pestaña activa del sidebar: 'active' | 'completed'
let currentTab = 'active';

// Items de carga del B/L abierto
let currentCargoItems = [];

// Timers de debounce de los autocompletes y búsquedas
let searchTimer, itemTimer, clientTimer, suggestTimer;
