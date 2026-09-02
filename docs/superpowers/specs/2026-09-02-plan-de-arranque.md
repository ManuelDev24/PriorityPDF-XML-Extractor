# Plan de arranque — manifest-app

Fecha: 2026-09-02
Consolida todo lo analizado y ejecutado en la sesión del 2026-09-02.

---

## 1. Dónde estamos hoy

### Hecho y verificado (sin commitear)

La Fase A está completa: backend y frontend separados en `backend/` y `frontend/`,
54 tests pasando, 4 defectos corregidos.

| | Antes | Ahora |
|---|---|---|
| Backend | `server.js`, 1601 líneas | bootstrap de 55 líneas + 11 módulos |
| Frontend | `index.html`, 1898 líneas | 103 líneas de markup + 9 módulos JS + CSS externo |
| Tests | ninguno | 54, todos pasando |

Defectos corregidos: XSS almacenado (con `escJs()`, verificado en navegador con el
payload real), paridad de validaciones entre `export-txt` y `push-siscommate`,
timeout en las llamadas al bridge, y `dbf.js` marcado como inactivo.

### Decidido

- **SQLite se queda.** Postgres queda como destino futuro, no ahora.
- **Framework de migración: Vue 3 + TypeScript + Vite.** Elegido por fidelidad
  visual: preserva `class` y `style` tal cual, mientras que React obligaría a
  convertir a mano 413 atributos (253 `class`→`className`, 160 `style` a objeto).
- **Backend: TypeScript sí, cambio de framework no.** Express se queda.

---

## 2. Bloqueantes — decisiones que solo el equipo puede tomar

Nada de lo que sigue avanza sin estas respuestas.

### B1. ¿Cuál es el objetivo de producción?

El repo tiene dos caminos de despliegue incompatibles:

- `instalar_produccion.bat` → Windows 11/10 **64 bits**, Node LTS del PATH
- `preparar_deploy_32bit.bat` → Windows Server 2008 SP2 **32 bits**, Node 12.22.12 x86

Node 12 está fuera de soporte desde abril 2022, y `better-sqlite3` 9.6.0 no
funciona ahí. Sospecha: el camino de 32 bits está muerto, pero hay que
confirmarlo.

**Impacto:** si WS2008 sigue vivo y alguien abre la app ahí con IE11, ninguna
opción de framework moderno corre sin `@vitejs/plugin-legacy`. Bloquea el spec
de migración.

### B2. ¿Quién debe poder entrar a la aplicación?

Hoy **no hay autenticación**. Cualquiera en la red puede borrar manifiestos,
editar SS/EIN de consignatarios o disparar el push a SISCOMMATE. El README
documenta el acceso en red (`http://[IP]:3000`).

No se implementó a propósito: definir el mecanismo y las credenciales es una
decisión del equipo, y hacerlo mal deja a la gente afuera.

**Opciones:** allowlist por IP (lo más simple), usuario/clave básico, o
integración con el dominio Windows.

### B3. ¿Qué columnas tienen realmente BOL.DBF y BOLITEM.DBF?

Bloquea la Fase B entera. Se sabe que `MANIFEST.DBF` sí tiene columna `docking`
(el bridge simplemente nunca la llena, `SiscommateBridge.cs:226`). Se desconoce
si existen columnas para tarifa, SS/EIN e IVU, o si habría que coordinarlo con
quien administra SISCOMMATE.

El equipo tiene acceso a los DBF por red, así que es consultable.

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

### Paso 0 — Commitear la Fase A (urgente)

Todo el trabajo de la sesión está **sin commitear**. Es lo primero, antes de
cualquier otra cosa: si la máquina falla, se pierde.

### Paso 1 — Responder B1, B2, B3

Sin B1 no se puede cerrar el spec de migración. B2 y B3 se pueden responder en
paralelo.

### Paso 2 — Asegurar la base (si B5 dice que no hay respaldo)

Tarea chica, valor alto: una copia programada de `manifest.db`. Con WAL activo,
usar `VACUUM INTO` o la API de backup de SQLite, no copiar el archivo en caliente.

### Paso 3 — Fijar la versión de Node

Ya mordió una vez en esta sesión: el `node_modules` estaba compilado para Node 20
y el Node del sistema (24) falló con `NODE_MODULE_VERSION 115 vs 137`.

- Agregar `engines` a `package.json`
- Documentar que se usa el Node 20 empaquetado del repo
- Que los `.bat` de despliegue apunten a ese Node, no al del PATH

### Paso 4 — Tipos en el backend, sin cambiar el despliegue

JSDoc + `checkJs` + `tsc --noEmit` solo para verificar. Se siguen desplegando los
mismos `.js` por `xcopy`, cero fricción nueva.

Prioridad por valor:
1. `txtGenerator.js` — vive de offsets de bytes y anchos de campo
2. Los parsers — producen objetos de 45 campos que entran a un INSERT con 45
   marcadores posicionales; un desalineo ahí es silencioso y catastrófico
3. El contrato del payload al bridge, hoy implícito

### Paso 5 — Migración del frontend a Vue 3 + TS

1. **Línea base visual primero**: capturar pantallas y DOM de cada estado
   (lista, editor con B/L, multi-contenedor, preview TXT, modales, admin) para
   comparar después. La fidelidad se prueba, no se promete.
2. **Piloto en `admin.html`** — 168 líneas de JS, pantalla aislada, cero riesgo de
   negocio. El objetivo real del piloto no es el código: es verificar que
   `npm run build` + copiar `dist/` funciona en el servidor Windows. Si falla, se
   enteran con la pantalla que no importa.
3. **Editor, pantalla por pantalla.** `app.css` no se toca ni una línea. El markup
   se copia; solo cambia la sintaxis de interpolación.
4. Los 54 tests del backend no cambian: el contrato de la API es el mismo y
   sirven de red durante toda la migración.

### Paso 6 — Fase B, SISCOMMATE (condicionada a B3)

**Replantear el enfoque.** El análisis cambió: `VFPOLEDB`, el proveedor para leer
los DBF, existe **solo en 32 bits** — Microsoft nunca publicó versión x64.

Eso significa que el bridge en C# **no es basura heredada: es el aislamiento de
una dependencia de 32 bits en un proceso aparte**. Si moviéramos la escritura de
DBF adentro de Node, todo el proceso Node tendría que ser de 32 bits, arrastrando
límite de ~1.5 GB de memoria y menos versiones disponibles, para siempre.

**Enfoque correcto:** reemplazar el bridge C# por un helper de 32 bits **propio**
—mismo aislamiento, pero bajo control del equipo— en vez de meter DBF en Node.

Lo que debe resolver:
- Los 4 campos que hoy no llegan a SISCOMMATE: `docking_number`,
  `hacienda_tariff`, `hacienda_client_ss` / `hacienda_client_ivu`, y el detalle de
  `bl_cargo_items` (hoy se escribe una sola fila BOLITEM con los totales del B/L)
- Leer `dbf_path` desde `settings` en vez de tenerlo compilado, para que cambiar
  de ambiente no requiera recompilar
- **Transaccionalidad**: hoy no hay. Si falla a mitad de los B/L quedan datos
  parciales y el chequeo de "el viaje ya existe" bloquea el reintento, obligando a
  limpiar el DBF a mano

---

## 4. Deuda conocida de la Fase A

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

## 5. Anotado para el día que se vaya a Postgres

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
