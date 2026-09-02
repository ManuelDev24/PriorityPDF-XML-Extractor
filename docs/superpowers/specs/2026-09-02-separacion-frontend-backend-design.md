# Separación frontend/backend — manifest-app

Fecha: 2026-09-02
Estado: aprobado para implementación (Fase A)

## Contexto

`manifest-app` extrae manifiestos de carga (XML de la DGA y PDF US Customs 1302),
permite editarlos y enriquecerlos, y los entrega por dos caminos:

1. **Exportación TXT** para Hacienda PR (formato fijo de 205 caracteres por línea)
2. **Push a SISCOMMATE**, que llama por HTTP a `SiscommateBridge.exe` (C#), el cual
   escribe en las tablas Visual FoxPro `MANIFEST`, `BOL`, `BOLCONT`, `BOLITEM`

Hoy todo el backend vive en un solo archivo de 1601 líneas (`server.js`) y todo el
frontend en un HTML de 1898 líneas con CSS y JS embebidos (`public/index.html`).

### Restricciones confirmadas con el usuario

- El despliegue **no cambia**: un solo proceso Node sirviendo archivos estáticos en
  una máquina Windows de la oficina. Sin build step, sin bundler, sin framework nuevo.
- `SiscommateBridge.cs` **no se puede modificar ni redesplegar** — el equipo no tiene
  acceso al servidor donde corre como servicio.
- El equipo **sí tiene acceso directo a los archivos DBF** por ruta de red (VFPOLEDB).
- Existen **dos ambientes SISCOMMATE**; uno se eliminará eventualmente, pero por ahora
  ambos se mantienen. El diseño no debe forzar a elegir uno.
- La máquina de desarrollo actual **no tiene** acceso de red a los shares DBF ni el
  driver VFPOLEDB instalado, por lo que nada del camino SISCOMMATE puede validarse
  desde ahí. El usuario probará en su ambiente local.

## Objetivos

- Separar backend y frontend en carpetas explícitas, con módulos de una sola
  responsabilidad cada uno.
- Aislar el punto de integración con SISCOMMATE en un único archivo, para que la
  Fase B sea un cambio contenido.
- Corregir los defectos que no dependen de acceso a SISCOMMATE.
- No romper el flujo operativo actual en ningún momento de la migración.

## No-objetivos

- No se migra a SPA, framework ni build step.
- No se toca `SiscommateBridge.cs` ni el esquema de la base de datos SQLite.
- No se consolidan los dos ambientes SISCOMMATE.
- No se rediseña la interfaz visualmente: mismo HTML renderizado, mismas URLs.

## Arquitectura — Fase A

### Estructura de carpetas

```
manifest-app/
├── backend/
│   ├── server.js              bootstrap: crea la app, monta rutas, listen
│   ├── db/
│   │   ├── connection.js      conexión SQLite única de larga vida
│   │   └── migrations.js      las ALTER TABLE actuales, ordenadas
│   ├── routes/
│   │   ├── manifests.js       CRUD de manifiestos, upload, export TXT
│   │   ├── bl.js              CRUD de B/L y cargo items
│   │   ├── catalogs.js        items Hacienda, puertos, carriers, clientes, buques
│   │   ├── settings.js        configuración persistente + container_type_map
│   │   └── siscommate.js      push + estado del bridge
│   └── services/
│       ├── xmlParser.js       parseXmlManifest()
│       ├── pdfParser.js       parsePdfManifest(), parseCustoms1302() y helpers
│       ├── txtGenerator.js    generateTxtLine0/1/2, generateFullTxt, pad/padL/padZ
│       └── siscommateClient.js  único punto de contacto con el bridge
│
├── frontend/
│   ├── index.html             solo markup
│   ├── admin.html
│   ├── css/app.css            unificado (hoy duplicado entre los dos HTML)
│   └── js/
│       ├── util.js            esc(), toast(), setStatus()
│       ├── api.js             wrapper de fetch
│       ├── state.js           estado global compartido
│       ├── manifests.js       sidebar, lista de viajes, tabs, búsqueda
│       ├── editor.js          renderEditor y sus secciones
│       ├── cargoItems.js      items de carga por contenedor
│       ├── modal.js           openModal/showModal/closeModal
│       └── admin.js           JS de admin.html
│
├── db/init.js                 sin cambios
├── bridge/                    sin cambios (fuera de alcance)
└── package.json               "main" y "start" apuntan a backend/server.js
```

### Backend

`server.js` queda reducido a bootstrap: middleware, `app.use('/api/...', router)` por
cada módulo de rutas, y `listen`. Ninguna consulta SQL ni lógica de parseo vive ahí.

**Conexión SQLite.** Hoy cada request hace `getDB()` … `db.close()`. Se reemplaza por
una única instancia de larga vida exportada desde `db/connection.js`, que es el patrón
recomendado por `better-sqlite3` (es síncrono; no hay pool que administrar). Esto
elimina ~30 pares abrir/cerrar y simplifica cada handler.

**Servicios.** Los parsers y el generador de TXT pasan a ser módulos puros: reciben
datos, devuelven datos, no tocan Express ni la base. Esto es lo que los hace testeables.

**`siscommateClient.js`.** Encapsula `bridgeRequest()` y la lectura de `bridge_host`/
`bridge_port` desde settings. Las rutas solo llaman a funciones con nombre de negocio
(`pushManifest()`, `getBridgeStatus()`), sin saber que por debajo hay HTTP. En Fase B
se cambia la implementación interna sin tocar rutas.

### Frontend

Se conserva JavaScript plano con `<script src>`, sin módulos ES ni bundler, para no
introducir build step. Cada archivo agrupa una responsabilidad y expone sus funciones
globalmente, igual que hoy — el cambio es de organización, no de mecánica.

`express.static()` pasa a apuntar a `frontend/` en vez de `public/`. Las URLs que ve
el navegador no cambian.

## Defectos que se corrigen en Fase A

Estos no dependen de acceso a SISCOMMATE:

1. **XSS almacenado.** `esc()` no escapa comillas simples y se usa dentro de atributos
   `onclick="fn('...')"` alimentados por datos del manifiesto subido (`voyage_no`,
   `bl_no`, `container_no`, nombre de cliente). Un manifiesto con una comilla simple en
   esos campos rompe el atributo y ejecuta JS arbitrario.

   **Corrección al implementar:** escapar a entidades HTML NO alcanza en este
   contexto. El parser de HTML decodifica `&#39;` de vuelta a `'` *antes* de que
   el JS del atributo se evalúe, así que la comilla vuelve a cerrar el string y
   el payload sigue ejecutándose. Se verificó en el navegador que el primer
   intento seguía siendo vulnerable. El fix correcto es una función aparte,
   `escJs()`, que escapa primero para contexto JavaScript (barra invertida) y
   recién después para HTML: al decodificar, el `\'` sobrevive como comilla
   literal dentro del string. Se aplicó en los 11 puntos donde un valor se
   interpola dentro de un string JS en un atributo inline (8 en la app, 3 en
   admin). `esc()` se mantiene para contenido HTML y atributos normales.

2. **Paridad de validaciones antes del push.** `export-txt` filtra a B/L con
   `status='validado'` y exige código arancelario, tarifa, SS/EIN y docking number.
   `push-siscommate` solo exige docking number y envía **todos** los B/L, validados o
   no. Se aplican las mismas validaciones en el push, extrayéndolas a una función
   compartida para que no puedan volver a divergir.

3. **Timeout en las llamadas al bridge.** `bridgeRequest()` no fija timeout: si el
   bridge se cuelga, la petición Express queda esperando indefinidamente.

4. **Código muerto documentado.** `siscommate-bridge/dbf.js` no lo requiere nada hoy.
   No se elimina ni se mueve en Fase A: es el wrapper VFPOLEDB que servirá de base para
   la Fase B. Se le agrega una nota de cabecera aclarando que está inactivo, para que
   nadie asuma que forma parte del camino de ejecución actual.

## Testing

El generador de TXT es el corazón del negocio y hoy no tiene ni un test, pese a
depender de offsets de byte exactos documentados campo por campo. Es lo primero que
se mueve y lo primero que se cubre:

- Toda línea generada mide exactamente 205 caracteres.
- Cada campo cae en el rango de posiciones documentado (`bl_no` en `[1:17]`,
  `ss_ein` en `[67:76]`, `docking_number` en `[165:173]`, etc.).
- Tarifa `040` fuerza valor FOB a 0.
- `sanitizeSS()` rellena a 9 dígitos por la izquierda, preservando el EIN real.
- Un B/L con varios contenedores genera un par línea1+línea2 por contenedor.

Los parsers se cubren con archivos de ejemplo reales (XML DGA y PDF 1302) como tests
de regresión, para detectar cuando el formato de origen cambie.

## Estrategia de migración sin romper nada

Un módulo a la vez, verificando que la app sigue funcionando después de cada paso:

1. Crear `backend/` y `frontend/`, mover archivos sin modificar su contenido.
2. Extraer `txtGenerator.js` + sus tests (el módulo más crítico y más puro).
3. Extraer los parsers.
4. Extraer `db/connection.js` y convertir los handlers uno por uno.
5. Partir las rutas por dominio.
6. Partir el frontend por responsabilidad.
7. Aplicar los cuatro fixes de la sección anterior.

El orden pone primero lo que tiene menos acoplamiento con Express, para que cada paso
sea reversible y verificable de forma aislada.

## Fase B — diferida

Reemplazar la llamada HTTP al bridge C# por escritura directa a los DBF desde Node
(vía VFPOLEDB), leyendo `dbf_path` desde la tabla `settings` para soportar ambos
ambientes sin recompilar nada.

Esto corrige cuatro campos que hoy el operador llena y que **nunca llegan a
SISCOMMATE**, porque el bridge C# no los lee:

| Campo | Situación en el bridge |
|---|---|
| `docking_number` | `SiscommateBridge.cs:226` escribe `docking=""` fijo |
| `hacienda_tariff` | no aparece en el INSERT de `BOL` ni `BOLITEM` |
| `hacienda_client_ss` / `hacienda_client_ivu` | no aparecen en el INSERT de `BOL` |
| `bl_cargo_items` (items por contenedor) | el INSERT de `BOLITEM` ignora `cargoItems` y escribe una sola fila con los totales del B/L |

**Prerrequisito bloqueante:** se desconoce si `BOL.DBF` y `BOLITEM.DBF` tienen columnas
físicas para tarifa, SS/EIN e IVU, o si habría que coordinarlo con quien administra
SISCOMMATE. `MANIFEST.DBF` sí tiene la columna `docking`; el bridge simplemente nunca
la llena. Antes de diseñar la Fase B hay que leer el esquema real de esas tablas.

**Riesgo a manejar:** escribir directo a DBF de FoxPro no tiene transacciones. El
bridge actual tampoco las usa — si falla a mitad de los B/L quedan datos parciales y
el chequeo de "el viaje ya existe" bloquea el reintento. La Fase B debe resolver esto,
no heredarlo.
