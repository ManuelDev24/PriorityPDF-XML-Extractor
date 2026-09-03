# Plan de arranque — manifest-app

Fecha: 2026-09-02 · Última actualización: 2026-09-03
Consolida todo lo analizado y ejecutado en las sesiones del 2026-09-02 y 2026-09-03.

---

## 1. Dónde estamos hoy

### Hecho, commiteado en `Dev`, verificado

La Fase A y la migración completa del frontend a Vue 3 + TypeScript están
terminadas. Seis commits en `Dev` (`main` sigue intacto):

```
ad8da9b  Reemplazar index.html y admin.html por las versiones Vue probadas
05628bb  Migrar el editor a Vue 3 + TypeScript
8c6ef22  Piloto de migración: pantalla de administración
06f16c0  Corregir tres bugs de pérdida silenciosa de datos
ffb1213  Fijar versión de Node, agregar respaldo y verificación de tipos
8df5e75  Separar backend y frontend en módulos + corregir 4 defectos
```

| | Antes | Ahora |
|---|---|---|
| Backend | `server.js`, 1601 líneas | bootstrap de 55 líneas + 11 módulos, tipado con JSDoc |
| Frontend | `index.html` escrito a mano, 1898 líneas | Vue 3 + TS, `frontend/index.html` es salida de `npm run build` |
| Tests backend | ninguno | 57, todos pasando |
| Typecheck | ninguno | backend (`tsc`) y frontend (`vue-tsc`) limpios |

Las versiones originales de `index.html`/`admin.html` se conservan como
`index.legacy.html` / `admin.legacy.html` — contenido idéntico, nunca borradas.

**Fidelidad visual verificada, no asumida**: se comparó el DOM real (estilos
calculados + geometría al píxel, no solo el markup) del original contra la
versión Vue. 0 diferencias en 844 elementos del editor y 265 del admin.

**Tres bugs preexistentes encontrados y corregidos** (los destapó la prueba de
punta a punta, no eran defectos de la migración): la columna `imo` nunca
existió en `manifests` pese a que el TXT la escribe (cualquier `PUT` que la
incluyera perdía *todos* los campos de esa petición); `updateBL` y
`updateManifest` compartían un temporizador de guardado, así que elegir un
buque (4 campos de golpe) solo guardaba el último; `vessel_code` se descartaba
en silencio por no estar en la lista de campos editables.

Defectos de la Fase A: XSS almacenado (con `escJs()`, verificado en navegador
con el payload real — un primer intento con solo entidades HTML resultó
insuficiente), paridad de validaciones entre `export-txt` y `push-siscommate`,
timeout en las llamadas al bridge, y `dbf.js` marcado como inactivo.

### Decidido

- **SQLite se queda.** Postgres queda como destino futuro, no ahora.
- **Framework de migración: Vue 3 + TypeScript + Vite.** Elegido por fidelidad
  visual: preserva `class` y `style` tal cual, mientras que React obligaría a
  convertir a mano 413 atributos (253 `class`→`className`, 160 `style` a objeto).
- **Backend: TypeScript sí, cambio de framework no.** Express se queda.
  TypeScript fijado a `~5.9` — `vue-tsc` no soporta TS 7, que ya no expone
  `typescript/lib/tsc`.
- **Rediseño visual futuro: shadcn-vue** (Tailwind + componentes con piel
  propia). Fase separada, posterior a este reemplazo — corrige la falta de
  armonía en los grids del formulario (hoy usan fracciones iguales sin
  relación al contenido real de cada campo).
- **Fase B: se mantiene C#/.NET.** Ver sección 4 — la razón no es preferencia
  de lenguaje, es que el único camino seguro para no corromper los índices de
  SISCOMMATE pasa por el motor real de FoxPro (VFPOLEDB), y eso fija el
  mecanismo de acceso, no el lenguaje que lo invoca.

---

## 2. Bloqueantes — decisiones que solo el equipo puede tomar

Nada de lo que sigue avanza sin estas respuestas.

### B1. ¿Cuál es el objetivo de producción? — RESUELTO: Windows 10

**Confirmado el 2026-09-02: el servidor real es Windows 10.** `preparar_deploy_32bit.bat`
(WS2008 SP2, Node 12) queda descartado como objetivo — es candidato a limpieza,
no se usa.

Verificado con documentación oficial que la cadena corre ahí sin sorpresas:
Vite 8 requiere Node 20.19+ (el Node empaquetado es 20.20.2), y Node 20 da
soporte **Tier 1** (producción, con pruebas oficiales) a Windows 10/Server 2016+.
De paso, la misma tabla de plataformas de Node confirma que Windows 8.1/Server 2012
es "Experimental" y **Windows Server 2008 no aparece en absoluto** — el camino
de 32 bits no solo estaba desactualizado, nunca estuvo en una plataforma soportada.

Fuentes: [Vite 8.0 — requisitos](https://vite.dev/blog/announcing-vite8) ·
[Node.js BUILDING.md — tabla de plataformas](https://github.com/nodejs/node/blob/v20.x/BUILDING.md)

### B2. ¿Quién debe poder entrar a la aplicación? — DECIDIDO: se pospone

**Resuelto el 2026-09-02: se continúa sin autenticación por ahora; se creará un
login más adelante.** Deja de ser bloqueante.

Queda registrado el riesgo asumido: cualquiera con acceso a la red puede borrar
manifiestos, editar SS/EIN de consignatarios o disparar el push a SISCOMMATE, y
el README documenta el acceso en red (`http://[IP]:3000`).

Mitigación barata disponible mientras tanto, que no requiere decidir nada sobre
credenciales ni deja a nadie afuera: **restringir CORS**. Hoy el servidor usa
`app.use(cors())` sin restricción de origen. Como el frontend se sirve desde el
mismo origen que la API, CORS no hace falta para que la app funcione — pero
abierto permite que cualquier sitio web que alguien del equipo visite haga
peticiones a la API y lea o borre datos desde su navegador. Antes de aplicarlo
hay que confirmar que ninguna otra herramienta interna consuma esta API desde
otro origen.

**Opciones para el login futuro:** allowlist por IP (lo más simple),
usuario/clave básico, o integración con el dominio Windows.

### B3. ¿Qué columnas tienen realmente BOL.DBF y BOLITEM.DBF? — sigue abierto, con más contexto

Bloquea la Fase B entera. Ver sección 4 para el detalle completo de lo
encontrado el 2026-09-03 (proyecto `HCDPR`, un segundo bridge en Node.js sin
desplegar). Resumen:

- **`MANIFEST.docking` y `BOLITEM.code` confirmados como columnas reales** —
  dos implementaciones de C# escritas por separado las declaran en su INSERT,
  y las dos las mandan vacías. No es un bug aislado, es que nadie las cableó.
- **Ninguna de las tres implementaciones encontradas (los dos bridges en C# y
  uno en Node) coincide en el esquema completo de `BOL`** — la de Node tiene
  una columna `status` que las otras no usan, y le faltan `charges`/`comvali`/
  `comval`/`cdesport` que sí aparecen en las otras dos. Ninguna está verificada
  contra el DBF real.
- Sigue sin confirmarse si existen columnas para tarifa, SS/EIN e IVU en
  `BOL`/`BOLITEM`, o si habría que coordinarlo con quien administra SISCOMMATE.

El equipo tiene acceso a los DBF por red, así que es consultable. Próximo paso
concreto: conseguir una copia de `MANIFEST.DBF`, `BOL.DBF`, `BOLCONT.DBF`,
`BOLITEM.DBF` **y sus archivos asociados** (`.CDX`, `.FPT`, si existen) —
idealmente desde un respaldo o en una ventana sin uso, no copiando los
archivos mientras SISCOMMATE los tiene abiertos. Esos archivos van a traer
datos reales de clientes (SS/EIN, nombres, direcciones): tratarlos con el
mismo cuidado que el resto de la base.

### B4. ¿Cuál de los dos ambientes SISCOMMATE es el real hoy?

- Configurado en Admin: `\\SDQSERVER\c$\Projects\PYRR\SiscomPriority\Sismate\DATA`
- Hardcodeado en el bridge C#: `\\192.168.6.2\c$\Projects\MXRS\sismatedata\SisMate\Data`

Ya se confirmó que son dos ambientes y que por ahora se mantienen ambos. Pero el
bridge tiene su ruta **compilada como constante**: no lee `dbf_path` de la tabla
`settings`, así que el campo de Admin hoy no tiene efecto sobre él.

### B5. ¿Existe respaldo de `manifest.db`?

`manifest.db` contiene 4 manifiestos y 297 B/L, y está en `.gitignore` (correcto:
no debe versionarse). Pero eso significa que **git no es la red de seguridad**.
Hay que confirmar si algo la respalda.

---

## 3. Orden de arranque recomendado

### Paso 0 — Commitear la Fase A ✅ hecho

Commiteado en `Dev` (ver sección 1). `main` sigue intacto.

### Paso 1 — Responder B1, B2, B3

✅ B1 resuelto (Windows 10). ✅ B2 resuelto (login pospuesto). **B3 sigue
abierto** — ver sección 6, es lo único que falta de este paso.

### Paso 2 — Asegurar la base ✅ hecho

`npm run backup` implementado y probado contra la base real: usa la API de
backup de SQLite (no copia el archivo — la base corre en WAL y una copia en
caliente puede salir inconsistente), verifica el resultado (cuenta filas +
`integrity_check`) antes de darlo por bueno, y rota conservando los últimos 30.

**Falta programarlo en el servidor** (`schtasks`) y apuntar `BACKUP_DIR` a otro
disco — hoy guarda junto al original, protege contra borrado accidental, no
contra falla de disco.

### Paso 3 — Fijar la versión de Node ✅ hecho

`engines: {"node": ">=18.0.0"}` en `package.json` + `.npmrc` con
`engine-strict=true` (falla el `npm install` con la versión equivocada, en vez
de fallar después con un error críptico) + prueba de humo en
`instalar_produccion.bat` que verifica que `better-sqlite3` cargue con el Node
que va a correr el servicio, antes de dejarlo instalado.

### Paso 4 — Tipos en el backend ✅ hecho

`tsconfig.json` con `checkJs` + `noEmit` (`npm run typecheck`), TypeScript y
`@types/node` como devDependencies (el `npm install --production` no las baja).
Tipado `txtGenerator`, los dos parsers, `blValidation`, `siscommateClient`,
`migrations`, `backup` y las consultas de las 5 rutas.

**El typecheck encontró bugs reales al aplicarse**, no solo faltas de tipo:
dos `parseFloat()` sobre valores que llegan como número desde SQLite o como
texto desde el frontend (reemplazados por un `toNum()` explícito, con 3 tests
que fijan el comportamiento), y una ruta que leía `ci.hacienda_item_code` /
`ci.hacienda_tariff` de un objeto que ningún parser produce con esas
propiedades — siempre insertaba `NULL` dando a entender que podían venir del
archivo.

### Paso 5 — Migración del frontend a Vue 3 + TS ✅ hecho

Los 4 sub-pasos planeados se ejecutaron y verificaron:
1. Línea base visual — comparación de DOM real (estilos calculados +
   geometría), no solo markup.
2. Piloto en admin — confirmó que Vite + Vue corre limpio; typecheck reveló
   que `vue-tsc` no soporta TypeScript 7, fijado a `~5.9`.
3. Editor completo migrado, con las mismas pruebas de fidelidad, más CRUD de
   items de carga, alta/edición de consignatario, y **exportación real del TXT
   de Hacienda** (21 líneas, todas de 205 caracteres) verificada de punta a punta.
4. `index.html`/`admin.html` reemplazados — son salida de `npm run build` desde
   ahora; los originales se conservan como `*.legacy.html`.

**Pendiente, no bloqueante:** probar el build en el servidor real (todo indica
que corre — ver B1 — pero nunca se ejecutó ahí), y el rediseño con shadcn-vue
como fase separada.

### Paso 6 — Fase B, SISCOMMATE (condicionada a B3)

Ver sección 4 completa — se reescribió el 2026-09-03 con hallazgos nuevos de
tres implementaciones previas encontradas en el equipo.

---

## 4. Fase B — SISCOMMATE: hallazgos del 2026-09-03

Estado: **pendiente de validación de SISCOMMATE.** No se toma la decisión de
implementar escritura directa a los DBF hasta confirmar los índices/CDX y,
sobre todo, cómo SISCOMMATE abre y busca esas tablas.

### 4.1 Se encontraron tres implementaciones previas, ninguna sabía de las otras

| Ubicación | Qué es | Estado |
|---|---|---|
| `manifest-app/bridge/SiscommateBridge.cs` | El bridge en C# **actualmente en producción** — HTTP puro, .NET Framework, VFPOLEDB vía `OleDbConnection` con parámetros | Compilado (`.exe` presente), es el que corre hoy |
| `siscommate-bridge/server.js` | Un **segundo bridge, completo, en Node.js puro** — mismo puerto 5001, mismos 4 endpoints | Código terminado, `node_modules` instalados, nunca desplegado (su `INSTALAR.md` describe Windows Server 2008 + Node 16, objetivo distinto al actual) |
| `HCDPR` (`Desktop/HaciendaPR/HCDPR`) | Formulario WinForms experimental, mismo esquema de tablas que el bridge C#, referencia a `DotNetDBF` sin llegar a usarla | Sin compilar, copiado el 2026-09-03, sin historial previo |

Los dos bridges reales escuchan en el **mismo puerto 5001** — mutuamente
excluyentes, nunca corrieron a la vez.

### 4.2 Lo que las tres implementaciones confirman en conjunto

- **`MANIFEST.docking` y `BOLITEM.code` son columnas reales** — dos
  implementaciones de C# escritas por separado las declaran en su INSERT y las
  dos las mandan vacías. Confirma que es una falta de cableado, no una
  limitación del esquema.
- **El esquema de `BOL` no coincide entre las tres** — la de Node agrega una
  columna `status` que las otras no usan y le faltan `charges`/`comvali`/
  `comval`/`cdesport`. Ninguna está verificada contra el DBF real. Esto no
  resuelve B3, lo refuerza: se necesita el esquema real, no otra suposición.
- Ninguna de las tres tiene un campo para SS/EIN o IVU en `BOL`, ni para
  tarifa en `BOLITEM`. Sigue sin ser prueba de que no existan las columnas.

### 4.3 El bridge en Node sí sabe llegar a VFPOLEDB — y cómo

`siscommate-bridge/server.js` usa el paquete npm `adodb`. Su mecanismo, en
`node_modules/adodb/core/core.js`:

```js
let cscriptPath = path.join(sysroot, x64 ? 'SysWOW64' : 'System32', 'cscript.exe');
```

Node no carga VFPOLEDB directamente: arranca como proceso hijo el
`cscript.exe` de 32 bits que ya viene incluido en cualquier Windows
(`SysWOW64\cscript.exe`), y le habla por stdin/stdout con un script JScript que
hace el `ADODB.Connection` real dentro de ese proceso hijo. El proceso Node
principal se queda en 64 bits sin restricción; solo el hijo desechable —cero
instalación extra— toca el driver de 32 bits.

Esto demuestra que el límite de 32 bits no obliga a que *todo el proceso
satélite* sea x86 — se puede aislar en algo más chico que un ejecutable .NET
completo. No cambia la decisión tomada (se mantiene C#/.NET), pero es
información real encontrada analizando el código y queda documentada para no
perderla.

**Dos problemas de calidad reales en esa implementación**, si alguna vez se
retoma: no usa consultas parametrizadas — arma el SQL con interpolación de
strings directa (`'${voyageNo}'`), abriendo una vía de inyección hacia el DBF;
y `.env` apunta a `DBF_PATH=Z:\` (una unidad mapeada, no una ruta UNC como las
otras dos), lo que sugiere que nunca se probó contra el ambiente real.

### 4.4 Por qué la escritura directa a DBF (en cualquier lenguaje) sigue sin ser segura

Se investigó si `DotNetDBF` (o cualquier librería de DBF puro, en cualquier
lenguaje) resuelve el problema de fondo. No lo resuelve:

**Ninguna librería de DBF puro sabe escribir índices compuestos de Visual
FoxPro (`.cdx`)** — ni `DotNetDBF` ni su alternativa `DbfDataReader` (que solo
lee CDX, no escribe). SISCOMMATE es una aplicación FoxPro viva: si se escriben
filas nuevas directo al `.dbf` sin pasar por el motor real de FoxPro, el
índice que usa para sus propias búsquedas queda desincronizado del dato — en
el mejor caso no encuentra los registros nuevos por sus pantallas, en el peor
corrompe el índice.

VFPOLEDB es interesante precisamente porque la operación pasa por el motor/
driver real, no por manipulación directa de bytes — por eso mantiene los
índices correctos, y por eso todo lo demás (`DotNetDBF`, cualquier librería
DBF en Python/Node/Rust) comparte el mismo riesgo estructural sin importar el
lenguaje.

Confirmado con fuente que VFPOLEDB nunca tuvo build de 64 bits (última
actualización 2009, VFP 9 SP2):
[Watch out for 64 bit Incompatibility using the Visual FoxPro OleDb Provider — Rick Strahl](https://webconnection.west-wind.com/blog/posts/2022/Nov/22/Watch-out-for-64-bit-Incompatibility-using-the-Visual-FoxPro-OleDb-Provider) ·
[Microsoft OLE DB Provider for Visual FoxPro 9.0 — notas de versión](https://github.com/VFPX/VFP9SP2Hotfix3/blob/master/OLEDB_Release_Notes.md)

**`DotNetDBF` no queda descartado del todo**: para lectura/inspección/
diagnóstico es seguro con cualquier librería DBF pura, porque leer nunca toca
el índice. Lo que no se usa para producción es escribir sin pasar por el motor
real, hasta demostrar cómo se mantienen los índices.

### 4.5 Arquitectura confirmada para la Fase B

```
   Backend Web (Node, 64 bits)
            │  HTTP
            ▼
   SISCOMMATE Bridge (satélite x86)
      .NET 8 + System.Data.OleDb
            │
       VFPOLEDB x86
            │
            ▼
   DBF de SISCOMMATE (+ CDX)
```

Mismo patrón de hoy (proceso satélite de 32 bits separado del backend
principal), modernizado de .NET Framework 4.8 a **.NET 8 x86** —
`System.Data.OleDb` existe como paquete NuGet en .NET 8 y sigue hablando con
VFPOLEDB igual. La web nunca toca los DBF directamente.

**La web no tiene por qué esperar a la Fase B para funcionar** — sigue
entregándole al bridge un payload igual al de hoy (`manifest`, `bls`,
`containers`); lo que cambia es solo la implementación interna del bridge.

### 4.6 Los tres pasos antes de escribir una sola línea

1. **No tocar producción todavía.** Conseguir de quien administra SISCOMMATE:
   ubicación real de los DBF, estructura de las 4 tablas, índices `.CDX`,
   claves usadas, relaciones `MANIFEST → BOL → BOLCONT → BOLITEM`, campos
   obligatorios, campos que SISCOMMATE genera automáticamente, y cómo
   determina que un B/L es válido.
2. **Prueba de solo lectura.** El bridge ejecuta `SELECT * FROM BOL` (y las
   otras 3 tablas) y devuelve los datos — sin insertar nada.
3. **Prueba controlada de escritura**, con un registro de prueba: escribir por
   el camino completo (web → bridge → VFPOLEDB → DBF) y **verificar
   visualmente en SISCOMMATE** que el registro aparece y se comporta normal.
   Es la única prueba que confirma que el índice quedó sincronizado sin tener
   que leer el binario del `.cdx` a mano.

### 4.7 Herramientas: VS Code vs Visual Studio

| Parte del proyecto | Herramienta |
|---|---|
| `manifest-app/` (backend Node + frontend Vue/TS) | **VS Code** — ya en uso, Volar para `.vue`, terminal para los `npm run *` |
| El bridge en C# (hoy y su modernización a .NET 8) | **Visual Studio** — mejor depuración de llamadas COM/OLE DB, gestión de NuGet integrada; `HCDPR` ya está armado como proyecto de VS y es el punto de partida natural si se retoma esa base (aunque el bridge debe ser un servicio HTTP headless, no WinForms) |

No hay solapamiento: cada herramienta cubre su mitad del stack.

### 4.8 Lo que debe resolver el bridge modernizado

- Los 4 campos que hoy no llegan a SISCOMMATE: `docking_number` (confirmado
  que la columna existe), `hacienda_item_code`/`code` (confirmado que existe),
  `hacienda_tariff`, `hacienda_client_ss`/`hacienda_client_ivu` (columnas sin
  confirmar — B3), y el detalle de `bl_cargo_items` (hoy se escribe una sola
  fila BOLITEM con los totales del B/L)
- Leer `dbf_path` desde `settings` en vez de tenerlo compilado, para que
  cambiar de ambiente no requiera recompilar
- **Transaccionalidad**: hoy no hay. Si falla a mitad de los B/L quedan datos
  parciales y el chequeo de "el viaje ya existe" bloquea el reintento,
  obligando a limpiar el DBF a mano. El bridge en Node resuelve esto distinto
  (borra el viaje completo y reinserta) — evaluar si ese patrón es más seguro
  o más riesgoso antes de adoptarlo

---

## 5. Deuda conocida de la Fase A

Decisiones conscientes, no olvidos:

- **Autenticación**: no implementada, bloqueada por B2
- **CSS de admin sin unificar**: `admin.css` y `app.css` duplican variables `:root`
  y reglas `.btn`. Fusionarlos arriesgaba cambios visuales; es limpieza posterior
  de bajo riesgo
- **Sin paginación**: `/api/manifests` trae todo el histórico y el sidebar lo
  renderiza completo en cada acción. A 4 manifiestos no se nota; con años de
  operación sí
- **Espacios múltiples en `goods_name`**: la indentación del XML deja espacios de
  más, que consumen caracteres del campo de 121 del TXT. Documentado en
  `parsers.test.js`, no corregido porque alteraría la salida
- **Traducción de puertos duplicada en 3 lugares**: tabla `ports`,
  `toSiscommatePort()` y una traducción distinta dentro del bridge C#
  (`MGE`→`XMG`, código que no existe en ninguna otra parte del sistema)

---

## 6. Anotado para el día que se vaya a Postgres

El acceso a la base quedó concentrado en 6 archivos, así que es un trabajo
acotado. Lo mecánico: 72 llamadas síncronas pasan a `await`, más `datetime('now')`
(3), `lastInsertRowid` (3), `INSERT OR IGNORE` (2), `AUTOINCREMENT` (6),
`PRAGMA table_info` (1).

**La trampa que no da error:** las 15 búsquedas con `LIKE`. En SQLite `LIKE` es
insensible a mayúsculas; en Postgres es sensible. Buscar `lanco` dejaría de
encontrar `LANCO MANUFACTURING CORP` en el autocompletar de consignatarios, el
catálogo de items y la búsqueda global. Sin error, solo resultados vacíos. La
solución es `ILIKE`, pero hay que acordarse de las 15.

Menor: SQLite acepta por afinidad de tipos valores que Postgres rechaza — el
frontend manda `package_qty` y `gross_weight` como strings, y un string vacío en
columna numérica revienta en Postgres. Conviene convertir tipos en el borde de la
API, que además es buena higiene hoy.

**No construir una capa de repositorio ni meter un ORM "para estar listos".** Es
complejidad especulativa por un quizás; el beneficio real ya está.
