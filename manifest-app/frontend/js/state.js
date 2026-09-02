// state.js — Estado global compartido entre los módulos del frontend
// Extraído de index.html (paso 6 de la separación frontend/backend)

let allManifests       = [];
let currentManifestId  = null;
let currentManifestData= null;
let currentBL          = null;
let catalogCarriers    = [];
let catalogPorts       = [];
let catalogVessels     = [];
let saveTimer          = null;
const expandedSet      = new Set(); // IDs de manifiestos con BL-list expandido

// Pestaña activa del sidebar: 'active' | 'completed'
let currentTab = 'active';

// Items de carga del B/L abierto
let currentCargoItems = [];

// Timers de debounce de los autocompletes y búsquedas
let searchTimer, itemTimer, clientTimer, suggestTimer;
