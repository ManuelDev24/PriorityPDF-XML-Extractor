# Auditoría de datos SQLite + SISCOMMATE vía Excel — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a console script (`node backend/scripts/dataAudit.js exportar|reinyectar`) that exports the full relevant state of SQLite and SISCOMMATE into one structured Excel workbook, and safely writes corrected data back to both systems with a mandatory before/after preview.

**Architecture:** A single source-of-truth config module (`hojas.js`) declares all 11 worksheets — what feeds each one, its technical key, and which fields are editable. `exportar.js` reads that config to build the workbook. `reinyectar.js` reads the same config to diff a corrected workbook against live data, print a preview, and apply approved changes. Three new bridge endpoints add the missing UPDATE capability for `BOL`/`BOLCONT`/`BOLITEM` (SISCOMMATE already has full CRUD for `CUSTOMER`).

**Tech Stack:** Node.js, `better-sqlite3` (existing), `exceljs` (new dependency), C# `SiscommateBridge.exe` (.NET Framework 4.0, VFPOLEDB) for the DBF-side endpoints.

**Spec:** `docs/superpowers/specs/2026-09-28-data-audit-excel-design.md`

## Global Constraints

- No UI changes — this is a console script only, per the spec's explicit scope.
- Reinjection must NEVER write without an explicit `y` confirmation after showing a before→after diff.
- Every applied (or failed) change must be appended to `logs/dataAudit_YYYYMMDD.log` (already gitignored — do not add a new ignore rule for it).
- The bridge is C# 5 / .NET Framework 4.0 — no LINQ-heavy or modern C# syntax; follow the exact patterns already in `bridge/SiscommateBridge.cs` (`GetStr`, `GetDec`, `AddNumeric`, `AddDate`, `ReadRow`).
- SISCOMMATE's `BOL` table only stores `consigne` (consignee name) and `exporter` (consignor name) as free text — no separate address/document fields exist there. Do not invent columns that aren't in the real DBF schema.
- Test style for this codebase: `node:test` + `node:assert`, pure-function unit tests; HTTP calls to the bridge are not mocked/tested (see `backend/services/siscommateClient.test.js`'s header comment) — thin HTTP wrapper functions are added without their own test.

---

### Task 1: Add `exceljs` dependency and gitignore audit exports

**Files:**
- Modify: `package.json`
- Modify: `../.gitignore` (repo root, one level above `manifest-app/`)

**Interfaces:**
- Produces: the `exceljs` package available to `require('exceljs')` for all later tasks.

- [ ] **Step 1: Install the dependency**

Run: `npm install exceljs@^4.4.0`

Expected: `package.json` gains `"exceljs": "^4.4.0"` under `dependencies`, `package-lock.json` updates, `node_modules/exceljs` exists.

- [ ] **Step 2: Ignore generated audit workbooks**

Add to `../.gitignore` (repo root), right after the `backups/` block:

```
# Excel generado por "node backend/scripts/dataAudit.js exportar" — contiene
# datos reales de clientes (SS/EIN, direcciones), nunca se versiona.
manifest-app/audit_*.xlsx
```

- [ ] **Step 3: Verify**

Run: `node -e "require('exceljs'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git -C .. add .gitignore
git commit -m "build: agregar exceljs para el modulo de auditoria de datos"
```

---

### Task 2: `diff.js` — pure before/after diff calculator

**Files:**
- Create: `backend/services/dataAudit/diff.js`
- Test: `backend/services/dataAudit/diff.test.js`

**Interfaces:**
- Produces: `calcularDiferencias(filaExcel, filaActual, camposEditables) => Record<string, {antes: any, despues: any}>` — used by `reinyectar.js` (Task 11) and, transitively, by the preview/apply flow.

- [ ] **Step 1: Write the failing tests**

```javascript
// backend/services/dataAudit/diff.test.js
const test = require('node:test');
const assert = require('node:assert');
const { calcularDiferencias } = require('./diff');

test('calcularDiferencias no reporta nada si ningun campo editable cambio', () => {
  const actual = { id: 1, name: 'ACME', ss: '123456789' };
  const excel  = { id: 1, name: 'ACME', ss: '123456789' };
  assert.deepStrictEqual(calcularDiferencias(excel, actual, ['name', 'ss']), {});
});

test('calcularDiferencias reporta solo los campos que cambiaron', () => {
  const actual = { name: 'JHON DOE', ss: '123456789', tel: '7871234567' };
  const excel  = { name: 'JOHN DOE', ss: '123456789', tel: '7871234567' };
  assert.deepStrictEqual(
    calcularDiferencias(excel, actual, ['name', 'ss', 'tel']),
    { name: { antes: 'JHON DOE', despues: 'JOHN DOE' } }
  );
});

test('calcularDiferencias trata null, undefined y "" como el mismo valor vacio', () => {
  const actual = { notas: null };
  const excel  = { notas: '' };
  assert.deepStrictEqual(calcularDiferencias(excel, actual, ['notas']), {});
});

test('calcularDiferencias compara numeros y su version en texto como iguales', () => {
  const actual = { peso: 1500 };
  const excel  = { peso: '1500' };
  assert.deepStrictEqual(calcularDiferencias(excel, actual, ['peso']), {});
});

test('calcularDiferencias ignora campos que no estan en camposEditables', () => {
  const actual = { id: 1, name: 'ACME' };
  const excel  = { id: 2, name: 'ACME' }; // id cambio, pero no es editable
  assert.deepStrictEqual(calcularDiferencias(excel, actual, ['name']), {});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test backend/services/dataAudit/diff.test.js`
Expected: FAIL — `Cannot find module './diff'`.

- [ ] **Step 3: Implement**

```javascript
// backend/services/dataAudit/diff.js — Compara una fila del Excel corregido
// contra el estado actual de un registro y devuelve solo los campos que
// cambiaron. No escribe nada: es la base tanto del reporte de vista previa
// como de la lista de UPDATEs que reinyectar.js va a ejecutar.

/**
 * @param {Record<string, any>} filaExcel Fila leida del Excel (sin la columna tecnica de clave)
 * @param {Record<string, any>} filaActual Fila actual en la base/DBF, mismas claves
 * @param {string[]} camposEditables Que campos comparar — columnas tecnicas y de solo lectura no entran aqui
 * @returns {Record<string, {antes: any, despues: any}>} Solo los campos distintos
 */
function calcularDiferencias(filaExcel, filaActual, camposEditables) {
  const cambios = {};
  for (const campo of camposEditables) {
    const antes = normalizar(filaActual[campo]);
    const despues = normalizar(filaExcel[campo]);
    if (antes !== despues) {
      cambios[campo] = { antes: filaActual[campo] ?? '', despues: filaExcel[campo] ?? '' };
    }
  }
  return cambios;
}

// Un Excel siempre devuelve string o number, nunca hay que distinguir ""
// de null/undefined aqui: los tres significan "vacio". Comparar como texto
// recortado tambien hace que 1500 (numero) y "1500" (texto) cuenten como
// el mismo valor.
function normalizar(valor) {
  return String(valor ?? '').trim();
}

module.exports = { calcularDiferencias };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test backend/services/dataAudit/diff.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/dataAudit/diff.js backend/services/dataAudit/diff.test.js
git commit -m "feat: calculador de diferencias antes/despues para la auditoria de datos"
```

---

### Task 3: `dedupe.js` — deduplicate consignors/consignees + propagate corrections

**Files:**
- Create: `backend/services/dataAudit/dedupe.js`
- Test: `backend/services/dataAudit/dedupe.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `CAMPOS_CONSIGNADOR: string[]`, `CAMPOS_CONSIGNATARIO: string[]`, `deduplicarConsignadores(bls) => object[]`, `deduplicarConsignatarios(bls) => object[]`, `actualizarConsignadorPorNombre(db, nombre, cambios)`, `actualizarConsignatarioPorNombre(db, nombre, cambios)` — all consumed by `hojas.js` (Task 8).

- [ ] **Step 1: Write the failing tests**

```javascript
// backend/services/dataAudit/dedupe.test.js
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const {
  CAMPOS_CONSIGNADOR, CAMPOS_CONSIGNATARIO,
  deduplicarConsignadores, deduplicarConsignatarios,
  actualizarConsignadorPorNombre, actualizarConsignatarioPorNombre,
} = require('./dedupe');

const bls = [
  { consignor_name: 'ACME SA', consignor_document_type: 'RNC', consignor_document_no: '111', consignor_tel: '', consignor_email: '', consignor_street: 'CALLE 1', consignor_city: 'STO DGO',
    consignee_name: 'JOHN DOE', consignee_document_type: 'SS', consignee_document_no: '999', consignee_tel: '7871234567', consignee_email: '', consignee_street: '', consignee_city: '' },
  { consignor_name: 'ACME SA', consignor_document_type: 'RNC', consignor_document_no: '111', consignor_tel: '', consignor_email: '', consignor_street: 'CALLE 1', consignor_city: 'STO DGO',
    consignee_name: 'JANE DOE', consignee_document_type: 'SS', consignee_document_no: '888', consignee_tel: '', consignee_email: '', consignee_street: '', consignee_city: '' },
  { consignor_name: '', consignor_document_type: '', consignor_document_no: '', consignor_tel: '', consignor_email: '', consignor_street: '', consignor_city: '',
    consignee_name: 'ANA PEREZ', consignee_document_type: '', consignee_document_no: '', consignee_tel: '', consignee_email: '', consignee_street: '', consignee_city: '' },
];

test('deduplicarConsignadores devuelve una fila por nombre distinto, sin vacios', () => {
  const r = deduplicarConsignadores(bls);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].consignor_name, 'ACME SA');
  assert.strictEqual(r[0].consignor_document_no, '111');
});

test('deduplicarConsignatarios devuelve una fila por cada consignatario distinto, ordenadas por nombre', () => {
  const r = deduplicarConsignatarios(bls);
  assert.deepStrictEqual(r.map(x => x.consignee_name), ['ANA PEREZ', 'JANE DOE', 'JOHN DOE']);
});

test('deduplicarConsignadores/Consignatarios usan las columnas declaradas en CAMPOS_*', () => {
  const r = deduplicarConsignadores(bls)[0];
  assert.deepStrictEqual(Object.keys(r).sort(), [...CAMPOS_CONSIGNADOR].sort());
  const r2 = deduplicarConsignatarios(bls)[0];
  assert.deepStrictEqual(Object.keys(r2).sort(), [...CAMPOS_CONSIGNATARIO].sort());
});

test('actualizarConsignadorPorNombre propaga el cambio a todos los B/L con ese nombre', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE bills_of_lading (id INTEGER PRIMARY KEY, consignor_name TEXT, consignor_city TEXT, consignee_name TEXT)`);
  db.prepare(`INSERT INTO bills_of_lading (consignor_name, consignor_city, consignee_name) VALUES ('JHON DOE','SAN JUAN','X')`).run();
  db.prepare(`INSERT INTO bills_of_lading (consignor_name, consignor_city, consignee_name) VALUES ('JHON DOE','SAN JUAN','Y')`).run();
  db.prepare(`INSERT INTO bills_of_lading (consignor_name, consignor_city, consignee_name) VALUES ('OTRO','PONCE','Z')`).run();

  actualizarConsignadorPorNombre(db, 'JHON DOE', { consignor_city: { antes: 'SAN JUAN', despues: 'BAYAMON' } });

  const filas = db.prepare('SELECT consignor_name, consignor_city FROM bills_of_lading ORDER BY id').all();
  assert.deepStrictEqual(filas, [
    { consignor_name: 'JHON DOE', consignor_city: 'BAYAMON' },
    { consignor_name: 'JHON DOE', consignor_city: 'BAYAMON' },
    { consignor_name: 'OTRO', consignor_city: 'PONCE' },
  ]);
});

test('actualizarConsignadorPorNombre sin cambios no ejecuta ningun UPDATE', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE bills_of_lading (id INTEGER PRIMARY KEY, consignor_name TEXT)`);
  db.prepare(`INSERT INTO bills_of_lading (consignor_name) VALUES ('ACME')`).run();
  assert.doesNotThrow(() => actualizarConsignadorPorNombre(db, 'ACME', {}));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test backend/services/dataAudit/dedupe.test.js`
Expected: FAIL — `Cannot find module './dedupe'`.

- [ ] **Step 3: Implement**

```javascript
// backend/services/dataAudit/dedupe.js — De-duplicacion de consignadores y
// consignatarios para el Excel de auditoria: una fila por entidad real, no
// por B/L, para no tener que corregir la misma direccion mal escrita decenas
// de veces. actualizarConsignador/atarioPorNombre hacen el camino inverso:
// una correccion en la hoja deduplicada se propaga a TODOS los B/L que
// compartan ese nombre.

const CAMPOS_CONSIGNADOR = [
  'consignor_name', 'consignor_document_type', 'consignor_document_no',
  'consignor_tel', 'consignor_email', 'consignor_street', 'consignor_city',
];
const CAMPOS_CONSIGNATARIO = [
  'consignee_name', 'consignee_document_type', 'consignee_document_no',
  'consignee_tel', 'consignee_email', 'consignee_street', 'consignee_city',
];

function deduplicarPorCampos(bls, campos) {
  const [campoNombre, ...resto] = campos;
  const vistos = new Map();
  for (const bl of bls) {
    const nombre = String(bl[campoNombre] || '').trim();
    if (!nombre || vistos.has(nombre)) continue;
    const fila = { [campoNombre]: nombre };
    resto.forEach(c => { fila[c] = bl[c] || ''; });
    vistos.set(nombre, fila);
  }
  return Array.from(vistos.values()).sort((a, b) => a[campoNombre].localeCompare(b[campoNombre]));
}

/** @param {import('../../types').BLRow[]} bls */
function deduplicarConsignadores(bls) {
  return deduplicarPorCampos(bls, CAMPOS_CONSIGNADOR);
}

/** @param {import('../../types').BLRow[]} bls */
function deduplicarConsignatarios(bls) {
  return deduplicarPorCampos(bls, CAMPOS_CONSIGNATARIO);
}

function actualizarPorNombre(db, campoNombre, nombre, cambios) {
  const campos = Object.keys(cambios);
  if (campos.length === 0) return;
  const setClause = campos.map(c => `${c} = ?`).join(', ');
  const valores = campos.map(c => cambios[c].despues);
  db.prepare(`UPDATE bills_of_lading SET ${setClause} WHERE ${campoNombre} = ?`).run(...valores, nombre);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} nombre
 * @param {Record<string, {antes: any, despues: any}>} cambios Formato que produce diff.js
 */
function actualizarConsignadorPorNombre(db, nombre, cambios) {
  actualizarPorNombre(db, 'consignor_name', nombre, cambios);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} nombre
 * @param {Record<string, {antes: any, despues: any}>} cambios Formato que produce diff.js
 */
function actualizarConsignatarioPorNombre(db, nombre, cambios) {
  actualizarPorNombre(db, 'consignee_name', nombre, cambios);
}

module.exports = {
  CAMPOS_CONSIGNADOR, CAMPOS_CONSIGNATARIO,
  deduplicarConsignadores, deduplicarConsignatarios,
  actualizarConsignadorPorNombre, actualizarConsignatarioPorNombre,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test backend/services/dataAudit/dedupe.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/dataAudit/dedupe.js backend/services/dataAudit/dedupe.test.js
git commit -m "feat: deduplicar consignadores y consignatarios para la auditoria de datos"
```

---

### Task 4: `sqliteWriter.js` — generic single-row UPDATE helper

**Files:**
- Create: `backend/services/dataAudit/sqliteWriter.js`
- Test: `backend/services/dataAudit/sqliteWriter.test.js`

**Interfaces:**
- Produces: `actualizarFilaSqlite(db, tabla, claves, cambios)` — consumed by `hojas.js` (Task 8) for every plain SQLite table (clients, manifests, bills_of_lading, containers).

- [ ] **Step 1: Write the failing tests**

```javascript
// backend/services/dataAudit/sqliteWriter.test.js
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { actualizarFilaSqlite } = require('./sqliteWriter');

function crearDbDePrueba() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT, ss TEXT)`);
  db.prepare(`INSERT INTO clients (id, name, ss) VALUES (1, 'ACME', '123')`).run();
  return db;
}

test('actualizarFilaSqlite aplica solo los campos presentes en cambios', () => {
  const db = crearDbDePrueba();
  actualizarFilaSqlite(db, 'clients', { id: 1 }, { name: { antes: 'ACME', despues: 'ACME CORP' } });
  const fila = db.prepare('SELECT * FROM clients WHERE id = 1').get();
  assert.deepStrictEqual(fila, { id: 1, name: 'ACME CORP', ss: '123' });
});

test('actualizarFilaSqlite con cambios vacios no ejecuta ningun UPDATE', () => {
  const db = crearDbDePrueba();
  assert.doesNotThrow(() => actualizarFilaSqlite(db, 'clients', { id: 1 }, {}));
  const fila = db.prepare('SELECT * FROM clients WHERE id = 1').get();
  assert.strictEqual(fila.name, 'ACME');
});

test('actualizarFilaSqlite solo toca la fila que coincide con la clave', () => {
  const db = crearDbDePrueba();
  db.prepare(`INSERT INTO clients (id, name, ss) VALUES (2, 'OTRO', '456')`).run();
  actualizarFilaSqlite(db, 'clients', { id: 1 }, { ss: { antes: '123', despues: '999' } });
  assert.strictEqual(db.prepare('SELECT ss FROM clients WHERE id = 1').get().ss, '999');
  assert.strictEqual(db.prepare('SELECT ss FROM clients WHERE id = 2').get().ss, '456');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test backend/services/dataAudit/sqliteWriter.test.js`
Expected: FAIL — `Cannot find module './sqliteWriter'`.

- [ ] **Step 3: Implement**

```javascript
// backend/services/dataAudit/sqliteWriter.js — UPDATE generico por clave,
// reutilizado por todas las hojas de auditoria respaldadas por una tabla
// SQLite corriente (clients, manifests, bills_of_lading, containers). Las
// hojas deduplicadas (consignadores/consignatarios) NO usan esto — ver
// dedupe.js, porque ahi una fila corrige varios registros a la vez.

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} tabla
 * @param {Record<string, any>} claves p.ej. {id: 42}
 * @param {Record<string, {antes: any, despues: any}>} cambios Formato que produce diff.js
 */
function actualizarFilaSqlite(db, tabla, claves, cambios) {
  const camposCambiados = Object.keys(cambios);
  if (camposCambiados.length === 0) return;
  const setClause = camposCambiados.map(c => `${c} = ?`).join(', ');
  const whereClause = Object.keys(claves).map(c => `${c} = ?`).join(' AND ');
  const valores = [...camposCambiados.map(c => cambios[c].despues), ...Object.values(claves)];
  db.prepare(`UPDATE ${tabla} SET ${setClause} WHERE ${whereClause}`).run(...valores);
}

module.exports = { actualizarFilaSqlite };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test backend/services/dataAudit/sqliteWriter.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/dataAudit/sqliteWriter.js backend/services/dataAudit/sqliteWriter.test.js
git commit -m "feat: UPDATE generico por clave para reinyectar correcciones en SQLite"
```

---

### Task 5: Bridge — `/exportar-tabla` (full-table dump, no `TOP` limit)

**Files:**
- Modify: `bridge/SiscommateBridge.cs`

**Interfaces:**
- Produces: `GET /exportar-tabla?tabla=X` → JSON array of every row in that DBF table — consumed by `siscommateClient.js` (Task 7).

- [ ] **Step 1: Add the route**

In `bridge/SiscommateBridge.cs`, find the existing `/muestra` route (around line 133) and add a new branch right after its closing `}`:

```csharp
                    // Volcado COMPLETO de una tabla, sin límite — a diferencia de
                    // /muestra (que exige un TOP fijo, pensado para explorar a
                    // mano). Lo usa el script de auditoría de datos para traer
                    // TODO el histórico de SISCOMMATE y volcarlo a Excel.
                    else if (method == "GET" && path == "/exportar-tabla")
                    {
                        string tablaExp = req.QueryString["tabla"] ?? "";
                        var filasExp = ObtenerTablaCompleta(tablaExp);
                        Send(resp, 200, new JavaScriptSerializer().Serialize(filasExp));
                    }
```

- [ ] **Step 2: Add the implementation**

Right after the existing `ObtenerMuestra` method (around line 532), add:

```csharp
    static List<Dictionary<string, object>> ObtenerTablaCompleta(string tabla)
    {
        var result = new List<Dictionary<string, object>>();
        using (var conn = new OleDbConnection(GetConnectionString()))
        {
            conn.Open();
            using (var cmd = new OleDbCommand("SELECT * FROM " + tabla, conn))
            using (var reader = cmd.ExecuteReader())
            {
                while (reader.Read()) result.Add(ReadRow(reader));
            }
        }
        return result;
    }
```

- [ ] **Step 3: Compile**

Run (from `bridge/`, on the Windows machine that has the C# build tools — this cannot run in this environment, hand off to the user):

```bash
csc /target:exe /out:SiscommateBridge.exe /r:System.Data.dll /r:System.Web.Extensions.dll /r:System.Net.dll SiscommateBridge.cs
```

Expected: compiles with 0 errors (same command already used for every prior change to this file).

- [ ] **Step 4: Manual verification (against a real or test DBF)**

Start the bridge (`iniciar_manual.bat`) and run:

```bash
curl "http://localhost:5001/exportar-tabla?tabla=CUSTOMER"
```

Expected: a JSON array with every row of `CUSTOMER` (not just the first 10/15 like `/muestra` or `/clientes`).

- [ ] **Step 5: Commit**

```bash
git add bridge/SiscommateBridge.cs
git commit -m "feat(bridge): endpoint /exportar-tabla para volcar una tabla completa sin limite"
```

---

### Task 6: Bridge — `/bol-actualizar`, `/bolcont-actualizar`, `/bolitem-actualizar`

**Files:**
- Modify: `bridge/SiscommateBridge.cs`

**Interfaces:**
- Produces: three new `POST` endpoints that update `BOL`/`BOLCONT`/`BOLITEM` by their natural keys — consumed by `siscommateClient.js` (Task 7).
  - `POST /bol-actualizar` body `{manifest, bolno, consigne, exporter}` → `{ok:true, filas_afectadas:number}`
  - `POST /bolcont-actualizar` body `{manifest, bolno, control, contain, size}` → `{ok:true, filas_afectadas:number}`
  - `POST /bolitem-actualizar` body `{manifest, bolno, control, qty, weight, desc, code, value}` → `{ok:true, filas_afectadas:number}`

- [ ] **Step 1: Add the three routes**

In `bridge/SiscommateBridge.cs`, right after the existing `/cliente-eliminar` route (around line 202, just before the `else if (method == "OPTIONS")` branch), add:

```csharp
                    // Corrige el consignatario/consignador de un B/L ya guardado en
                    // SISCOMMATE. BOL solo tiene estos dos campos de texto libre para
                    // eso — no hay direccion/documento separados en esa tabla.
                    else if (method == "POST" && path == "/bol-actualizar")
                    {
                        string body6 = new StreamReader(req.InputStream, Encoding.UTF8).ReadToEnd();
                        var data6 = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body6);
                        int filas6 = ActualizarBolEnDBF(data6);
                        Send(resp, 200, "{\"ok\":true,\"filas_afectadas\":" + filas6 + "}");
                    }
                    // Corrige el numero de contenedor o el tamano de una fila de
                    // BOLCONT ya guardada. Identificada por manifest+bolno+control
                    // (no por "contain", que es justo el campo que puede estar mal).
                    else if (method == "POST" && path == "/bolcont-actualizar")
                    {
                        string body7 = new StreamReader(req.InputStream, Encoding.UTF8).ReadToEnd();
                        var data7 = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body7);
                        int filas7 = ActualizarBolcontEnDBF(data7);
                        Send(resp, 200, "{\"ok\":true,\"filas_afectadas\":" + filas7 + "}");
                    }
                    // Corrige cantidad/peso/descripcion/codigo/valor de una fila de
                    // BOLITEM ya guardada. Identificada por manifest+bolno+control.
                    else if (method == "POST" && path == "/bolitem-actualizar")
                    {
                        string body8 = new StreamReader(req.InputStream, Encoding.UTF8).ReadToEnd();
                        var data8 = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body8);
                        int filas8 = ActualizarBolitemEnDBF(data8);
                        Send(resp, 200, "{\"ok\":true,\"filas_afectadas\":" + filas8 + "}");
                    }
```

- [ ] **Step 2: Add the three implementations**

Right after `EliminarClienteDeDBF` (around line 678), add:

```csharp
    static int ActualizarBolEnDBF(Dictionary<string, object> d)
    {
        string manifest = GetStr(d, "manifest");
        string bolno = GetStr(d, "bolno");
        if (string.IsNullOrWhiteSpace(manifest) || string.IsNullOrWhiteSpace(bolno))
            throw new Exception("Falta manifest o bolno.");
        using (var conn = new OleDbConnection(GetConnectionString()))
        {
            conn.Open();
            using (var cmd = new OleDbCommand(
                "UPDATE BOL SET consigne=?,exporter=? WHERE manifest=? AND bolno=?", conn))
            {
                cmd.Parameters.AddWithValue("consigne", GetStr(d, "consigne"));
                cmd.Parameters.AddWithValue("exporter", GetStr(d, "exporter"));
                cmd.Parameters.AddWithValue("manifest", manifest);
                cmd.Parameters.AddWithValue("bolno", bolno);
                return cmd.ExecuteNonQuery();
            }
        }
    }

    static int ActualizarBolcontEnDBF(Dictionary<string, object> d)
    {
        string manifest = GetStr(d, "manifest");
        string bolno = GetStr(d, "bolno");
        string control = GetStr(d, "control");
        if (string.IsNullOrWhiteSpace(manifest) || string.IsNullOrWhiteSpace(bolno) || string.IsNullOrWhiteSpace(control))
            throw new Exception("Falta manifest, bolno o control.");
        using (var conn = new OleDbConnection(GetConnectionString()))
        {
            conn.Open();
            using (var cmd = new OleDbCommand(
                "UPDATE BOLCONT SET contain=?,size=? WHERE manifest=? AND bolno=? AND control=?", conn))
            {
                cmd.Parameters.AddWithValue("contain", GetStr(d, "contain"));
                cmd.Parameters.AddWithValue("size", GetStr(d, "size"));
                cmd.Parameters.AddWithValue("manifest", manifest);
                cmd.Parameters.AddWithValue("bolno", bolno);
                cmd.Parameters.AddWithValue("control", control);
                return cmd.ExecuteNonQuery();
            }
        }
    }

    static int ActualizarBolitemEnDBF(Dictionary<string, object> d)
    {
        string manifest = GetStr(d, "manifest");
        string bolno = GetStr(d, "bolno");
        string control = GetStr(d, "control");
        if (string.IsNullOrWhiteSpace(manifest) || string.IsNullOrWhiteSpace(bolno) || string.IsNullOrWhiteSpace(control))
            throw new Exception("Falta manifest, bolno o control.");
        using (var conn = new OleDbConnection(GetConnectionString()))
        {
            conn.Open();
            using (var cmd = new OleDbCommand(
                "UPDATE BOLITEM SET qty=?,weight=?,desc=?,code=?,value=? WHERE manifest=? AND bolno=? AND control=?", conn))
            {
                AddNumeric(cmd, "qty", GetDec(d, "qty"));
                AddNumeric(cmd, "weight", GetDec(d, "weight"));
                cmd.Parameters.AddWithValue("desc", GetStr(d, "desc"));
                cmd.Parameters.AddWithValue("code", GetStr(d, "code"));
                AddNumeric(cmd, "value", GetDec(d, "value"));
                cmd.Parameters.AddWithValue("manifest", manifest);
                cmd.Parameters.AddWithValue("bolno", bolno);
                cmd.Parameters.AddWithValue("control", control);
                return cmd.ExecuteNonQuery();
            }
        }
    }
```

- [ ] **Step 3: Compile**

Same command as Task 5 Step 3 (hand off to the user, on the machine with the C# build tools).

- [ ] **Step 4: Manual verification**

With the bridge running against a real (or test) DBF that has at least one `BOL` row:

```bash
curl -X POST http://localhost:5001/bol-actualizar -H "Content-Type: application/json" -d "{\"manifest\":\"CF371\",\"bolno\":\"001\",\"consigne\":\"JOHN DOE TEST\",\"exporter\":\"ACME TEST\"}"
```

Expected: `{"ok":true,"filas_afectadas":1}`. Then `curl "http://localhost:5001/exportar-tabla?tabla=BOL"` (from Task 5) and confirm the row shows the new values. **Revert the test value manually afterward** if run against production data.

- [ ] **Step 5: Commit**

```bash
git add bridge/SiscommateBridge.cs
git commit -m "feat(bridge): endpoints de actualizacion para BOL, BOLCONT y BOLITEM"
```

---

### Task 7: `siscommateClient.js` — JS wrappers for the new bridge endpoints

**Files:**
- Modify: `backend/services/siscommateClient.js`

**Interfaces:**
- Consumes: `bridgeRequest(method, path, body)` (already exists in this file).
- Produces: `obtenerTablaCompleta(tabla) => Promise<object[]>`, `actualizarBolSiscommate(manifest, bolno, datos) => Promise<{ok, filas_afectadas}>`, `actualizarBolcontSiscommate(manifest, bolno, control, datos) => Promise<{ok, filas_afectadas}>`, `actualizarBolitemSiscommate(manifest, bolno, control, datos) => Promise<{ok, filas_afectadas}>` — consumed by `hojas.js` (Task 8).

- [ ] **Step 1: Add the wrappers**

In `backend/services/siscommateClient.js`, right after `obtenerMuestra` (after its closing `}`, before `crearClienteSiscommate`), add:

```javascript
/**
 * Volcado completo de una tabla real de SISCOMMATE, sin limite (endpoint
 * /exportar-tabla del bridge) — a diferencia de obtenerMuestra(), que trae
 * solo las primeras N filas. Lo usa el modulo de auditoria de datos para
 * traer TODO el historico.
 * @param {string} tabla Nombre de la tabla real en SISCOMMATE (ej. "BOL")
 * @returns {Promise<object[]>}
 */
function obtenerTablaCompleta(tabla) {
  return bridgeRequest('GET', `/exportar-tabla?tabla=${encodeURIComponent(tabla)}`, null);
}
```

Then, right after `eliminarClienteSiscommate` (after its closing `}`, before `buscarClientesSiscommate`), add:

```javascript
/**
 * Corrige el consignatario/consignador (BOL.consigne/exporter) de un B/L ya
 * guardado en SISCOMMATE, identificado por manifest+bolno. Usado por el
 * modulo de auditoria de datos al reinyectar correcciones.
 * @param {string} manifest
 * @param {string} bolno
 * @param {{consigne?: string, exporter?: string}} datos
 * @returns {Promise<{ok: true, filas_afectadas: number}>}
 */
function actualizarBolSiscommate(manifest, bolno, datos) {
  return bridgeRequest('POST', '/bol-actualizar', {
    manifest, bolno, consigne: datos.consigne || '', exporter: datos.exporter || '',
  });
}

/**
 * Corrige el numero de contenedor o tamano de una fila de BOLCONT ya
 * guardada, identificada por manifest+bolno+control.
 * @param {string} manifest
 * @param {string} bolno
 * @param {string} control
 * @param {{contain?: string, size?: string}} datos
 * @returns {Promise<{ok: true, filas_afectadas: number}>}
 */
function actualizarBolcontSiscommate(manifest, bolno, control, datos) {
  return bridgeRequest('POST', '/bolcont-actualizar', {
    manifest, bolno, control, contain: datos.contain || '', size: datos.size || '',
  });
}

/**
 * Corrige cantidad/peso/descripcion/codigo/valor de una fila de BOLITEM ya
 * guardada, identificada por manifest+bolno+control.
 * @param {string} manifest
 * @param {string} bolno
 * @param {string} control
 * @param {{qty?: number, weight?: number, desc?: string, code?: string, value?: number}} datos
 * @returns {Promise<{ok: true, filas_afectadas: number}>}
 */
function actualizarBolitemSiscommate(manifest, bolno, control, datos) {
  return bridgeRequest('POST', '/bolitem-actualizar', {
    manifest, bolno, control,
    qty: datos.qty || 0, weight: datos.weight || 0,
    desc: datos.desc || '', code: datos.code || '', value: datos.value || 0,
  });
}
```

Update the `module.exports` block at the bottom to include the four new functions:

```javascript
module.exports = {
  getBridgeConfig, bridgeRequest,
  getBridgeStatus, getLote, pushManifest, consultarManifiesto, buscarClientesSiscommate,
  analizarItemClienteTodos, limpiarTextoLibre, calcularPackageUnitCode,
  obtenerMuestra, crearClienteSiscommate, actualizarClienteSiscommate, eliminarClienteSiscommate,
  obtenerTablaCompleta, actualizarBolSiscommate, actualizarBolcontSiscommate, actualizarBolitemSiscommate,
  BRIDGE_TIMEOUT_MS,
};
```

- [ ] **Step 2: Verify nothing broke**

Run: `npm test`
Expected: PASS — same test count as before this task (this file's test file only covers pure functions and doesn't test these new HTTP wrappers, matching the existing convention noted in its header comment).

- [ ] **Step 3: Commit**

```bash
git add backend/services/siscommateClient.js
git commit -m "feat: wrappers para los endpoints de auditoria/actualizacion del bridge"
```

---

### Task 8: `hojas.js` — the single source of truth for all 11 worksheets

**Files:**
- Create: `backend/services/dataAudit/hojas.js`

**Interfaces:**
- Consumes: `deduplicarConsignadores`, `deduplicarConsignatarios`, `CAMPOS_CONSIGNADOR`, `CAMPOS_CONSIGNATARIO`, `actualizarConsignadorPorNombre`, `actualizarConsignatarioPorNombre` (Task 3); `actualizarFilaSqlite` (Task 4); `obtenerTablaCompleta`, `actualizarClienteSiscommate`, `actualizarBolSiscommate`, `actualizarBolcontSiscommate`, `actualizarBolitemSiscommate` (Task 7, plus the pre-existing `actualizarClienteSiscommate`).
- Produces: `construirHojas() => HojaSpec[]`, where each `HojaSpec` is:
  ```
  {
    nombre: string,
    camposClave: string[],
    camposEditables: string[],
    obtenerFilas: ({db, siscommate}) => Promise<object[]> | object[],
    leerActual: null | ({db, siscommate}, claves) => Promise<object|null> | object|null,
    escribirCambio: null | ({db, siscommate}, claves, cambios, filaFinal) => Promise<void> | void,
  }
  ```
  Consumed by `exportar.js` (Task 9) and `reinyectar.js` (Task 11).

This task has no dedicated test file — it's a declarative config table whose behavior is exercised end-to-end by Task 9's and Task 11's tests (which use a real `hojas.js` against a fixture DB and a fake `siscommate`).

- [ ] **Step 1: Implement**

```javascript
// backend/services/dataAudit/hojas.js — Unica fuente de verdad de las 11
// hojas del Excel de auditoria: que tabla/origen alimenta cada una, cual es
// su clave tecnica (para identificar la fila al reinyectar) y que campos son
// editables. exportar.js y reinyectar.js usan esta misma lista — asi nunca
// pueden desalinearse sobre que campo vive en que hoja.
//
// Las hojas con leerActual/escribirCambio en null son de SOLO LECTURA: se
// exportan para auditoria pero reinyectar.js las ignora (ver el filtro en
// reinyectar.js). Hoy son SISCOMMATE_Manifiestos (el INSERT real usa ~25
// columnas con logica de negocio no trivial — ver SiscommateBridge.cs — y no
// hay evidencia de que ese dato se corrija con frecuencia, a diferencia de
// nombres/pesos/documentos).

const {
  deduplicarConsignadores, deduplicarConsignatarios,
  CAMPOS_CONSIGNADOR, CAMPOS_CONSIGNATARIO,
  actualizarConsignadorPorNombre, actualizarConsignatarioPorNombre,
} = require('./dedupe');
const { actualizarFilaSqlite } = require('./sqliteWriter');

const CAMPOS_EDITABLES_CLIENTS = ['name', 'ss', 'taxid', 'add1', 'add2', 'add3', 'phone1', 'phone2', 'ivu'];
const CAMPOS_EDITABLES_BL = [
  'goods_name', 'package_qty', 'gross_weight', 'value',
  'hacienda_item_code', 'hacienda_tariff', 'hacienda_container_no',
  'hacienda_client_ss', 'hacienda_client_ivu', 'notes',
];
const CAMPOS_EDITABLES_MANIFESTS = [
  'vessel_name', 'loading_port', 'unloading_port', 'discharge_port',
  'departure_date', 'arrival_date', 'manifest_no', 'carrier_code', 'docking_number', 'imo',
];
const CAMPOS_EDITABLES_CONTAINERS = ['container_type', 'package_code', 'amount', 'gross_weight', 'net_weight', 'seal_no1', 'size'];
const CAMPOS_EDITABLES_CUSTOMER = ['ss', 'code', 'type', 'taxid', 'add1', 'add2', 'add3', 'phone1', 'phone2', 'fax1', 'fax2', 'ivu'];
const CAMPOS_EDITABLES_BOL = ['consigne', 'exporter'];
const CAMPOS_EDITABLES_BOLCONT = ['contain', 'size'];
const CAMPOS_EDITABLES_BOLITEM = ['qty', 'weight', 'desc', 'code', 'value'];

function coincideClave(fila, claves) {
  return Object.keys(claves).every(k => String(fila[k] ?? '').trim() === String(claves[k]).trim());
}

/** @returns {object[]} Ver el bloque "Interfaces" de la Tarea 8 del plan para la forma exacta de cada elemento */
function construirHojas() {
  return [
    {
      nombre: 'SQLite_Clientes',
      camposClave: ['id'],
      camposEditables: CAMPOS_EDITABLES_CLIENTS,
      obtenerFilas: ({ db }) => db.prepare('SELECT * FROM clients ORDER BY name').all(),
      leerActual: ({ db }, claves) => db.prepare('SELECT * FROM clients WHERE id = ?').get(claves.id) || null,
      escribirCambio: ({ db }, claves, cambios) => actualizarFilaSqlite(db, 'clients', claves, cambios),
    },
    {
      nombre: 'SQLite_Consignadores',
      camposClave: ['consignor_name'],
      camposEditables: CAMPOS_CONSIGNADOR.filter(c => c !== 'consignor_name'),
      obtenerFilas: ({ db }) => deduplicarConsignadores(db.prepare('SELECT * FROM bills_of_lading').all()),
      leerActual: ({ db }, claves) =>
        db.prepare('SELECT * FROM bills_of_lading WHERE consignor_name = ? LIMIT 1').get(claves.consignor_name) || null,
      escribirCambio: ({ db }, claves, cambios) => actualizarConsignadorPorNombre(db, claves.consignor_name, cambios),
    },
    {
      nombre: 'SQLite_Consignatarios',
      camposClave: ['consignee_name'],
      camposEditables: CAMPOS_CONSIGNATARIO.filter(c => c !== 'consignee_name'),
      obtenerFilas: ({ db }) => deduplicarConsignatarios(db.prepare('SELECT * FROM bills_of_lading').all()),
      leerActual: ({ db }, claves) =>
        db.prepare('SELECT * FROM bills_of_lading WHERE consignee_name = ? LIMIT 1').get(claves.consignee_name) || null,
      escribirCambio: ({ db }, claves, cambios) => actualizarConsignatarioPorNombre(db, claves.consignee_name, cambios),
    },
    {
      nombre: 'SQLite_Manifiestos',
      camposClave: ['id'],
      camposEditables: CAMPOS_EDITABLES_MANIFESTS,
      obtenerFilas: ({ db }) => db.prepare('SELECT * FROM manifests ORDER BY id').all(),
      leerActual: ({ db }, claves) => db.prepare('SELECT * FROM manifests WHERE id = ?').get(claves.id) || null,
      escribirCambio: ({ db }, claves, cambios) => actualizarFilaSqlite(db, 'manifests', claves, cambios),
    },
    {
      nombre: 'SQLite_BLs',
      camposClave: ['id'],
      camposEditables: CAMPOS_EDITABLES_BL,
      obtenerFilas: ({ db }) => db.prepare('SELECT * FROM bills_of_lading ORDER BY id').all(),
      leerActual: ({ db }, claves) => db.prepare('SELECT * FROM bills_of_lading WHERE id = ?').get(claves.id) || null,
      escribirCambio: ({ db }, claves, cambios) => actualizarFilaSqlite(db, 'bills_of_lading', claves, cambios),
    },
    {
      nombre: 'SQLite_Contenedores',
      camposClave: ['id'],
      camposEditables: CAMPOS_EDITABLES_CONTAINERS,
      obtenerFilas: ({ db }) => {
        const containers = db.prepare('SELECT * FROM containers ORDER BY id').all();
        const links = db.prepare('SELECT container_no, bl_no FROM container_bl').all();
        const blsPorContenedor = new Map();
        for (const l of links) {
          const lista = blsPorContenedor.get(l.container_no) || [];
          lista.push(l.bl_no);
          blsPorContenedor.set(l.container_no, lista);
        }
        // bls_asociados es informativo (viene de container_bl) — no es un
        // campo editable, corregirlo no reasigna vinculos.
        return containers.map(c => ({ ...c, bls_asociados: (blsPorContenedor.get(c.container_no) || []).join(', ') }));
      },
      leerActual: ({ db }, claves) => db.prepare('SELECT * FROM containers WHERE id = ?').get(claves.id) || null,
      escribirCambio: ({ db }, claves, cambios) => actualizarFilaSqlite(db, 'containers', claves, cambios),
    },
    {
      nombre: 'SISCOMMATE_Customers',
      camposClave: ['name'],
      camposEditables: CAMPOS_EDITABLES_CUSTOMER,
      obtenerFilas: ({ siscommate }) => siscommate.obtenerTablaCompleta('CUSTOMER'),
      leerActual: async ({ siscommate }, claves) => {
        const filas = await siscommate.obtenerTablaCompleta('CUSTOMER');
        return filas.find(f => String(f.name || '').trim() === claves.name) || null;
      },
      escribirCambio: ({ siscommate }, claves, cambios, filaFinal) =>
        siscommate.actualizarClienteSiscommate(claves.name, filaFinal),
    },
    {
      nombre: 'SISCOMMATE_Manifiestos',
      camposClave: ['manifest'],
      camposEditables: [],
      obtenerFilas: ({ siscommate }) => siscommate.obtenerTablaCompleta('MANIFEST'),
      leerActual: null,
      escribirCambio: null,
    },
    {
      nombre: 'SISCOMMATE_BLs',
      camposClave: ['manifest', 'bolno'],
      camposEditables: CAMPOS_EDITABLES_BOL,
      obtenerFilas: ({ siscommate }) => siscommate.obtenerTablaCompleta('BOL'),
      leerActual: async ({ siscommate }, claves) => {
        const filas = await siscommate.obtenerTablaCompleta('BOL');
        return filas.find(f => coincideClave(f, claves)) || null;
      },
      escribirCambio: ({ siscommate }, claves, cambios, filaFinal) =>
        siscommate.actualizarBolSiscommate(claves.manifest, claves.bolno, filaFinal),
    },
    {
      nombre: 'SISCOMMATE_Contenedores',
      camposClave: ['manifest', 'bolno', 'control'],
      camposEditables: CAMPOS_EDITABLES_BOLCONT,
      obtenerFilas: ({ siscommate }) => siscommate.obtenerTablaCompleta('BOLCONT'),
      leerActual: async ({ siscommate }, claves) => {
        const filas = await siscommate.obtenerTablaCompleta('BOLCONT');
        return filas.find(f => coincideClave(f, claves)) || null;
      },
      escribirCambio: ({ siscommate }, claves, cambios, filaFinal) =>
        siscommate.actualizarBolcontSiscommate(claves.manifest, claves.bolno, claves.control, filaFinal),
    },
    {
      nombre: 'SISCOMMATE_Items',
      camposClave: ['manifest', 'bolno', 'control'],
      camposEditables: CAMPOS_EDITABLES_BOLITEM,
      obtenerFilas: ({ siscommate }) => siscommate.obtenerTablaCompleta('BOLITEM'),
      leerActual: async ({ siscommate }, claves) => {
        const filas = await siscommate.obtenerTablaCompleta('BOLITEM');
        return filas.find(f => coincideClave(f, claves)) || null;
      },
      escribirCambio: ({ siscommate }, claves, cambios, filaFinal) =>
        siscommate.actualizarBolitemSiscommate(claves.manifest, claves.bolno, claves.control, filaFinal),
    },
  ];
}

module.exports = { construirHojas };
```

- [ ] **Step 2: Sanity check (no automated test — verified by Tasks 9 & 11)**

Run: `node -e "console.log(require('./backend/services/dataAudit/hojas').construirHojas().map(h => h.nombre))"`
Expected: prints an array of exactly 11 names, matching the spec's sheet list.

- [ ] **Step 3: Commit**

```bash
git add backend/services/dataAudit/hojas.js
git commit -m "feat: tabla de configuracion de las 11 hojas del Excel de auditoria"
```

---

### Task 9: `exportar.js` — build the workbook

**Files:**
- Create: `backend/services/dataAudit/exportar.js`
- Test: `backend/services/dataAudit/exportar.test.js`

**Interfaces:**
- Consumes: `construirHojas()` (Task 8).
- Produces: `construirLibroAuditoria(db, siscommate) => Promise<ExcelJS.Workbook>` — consumed by `backend/scripts/dataAudit.js` (Task 12).

- [ ] **Step 1: Write the failing test**

```javascript
// backend/services/dataAudit/exportar.test.js
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { construirLibroAuditoria } = require('./exportar');

function crearDbDePrueba() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT, ss TEXT, taxid TEXT, add1 TEXT, add2 TEXT, add3 TEXT, phone1 TEXT, phone2 TEXT, ivu TEXT);
    CREATE TABLE manifests (id INTEGER PRIMARY KEY, voyage_no TEXT, vessel_name TEXT, loading_port TEXT, unloading_port TEXT, discharge_port TEXT, departure_date TEXT, arrival_date TEXT, manifest_no TEXT, carrier_code TEXT, docking_number TEXT, imo TEXT);
    CREATE TABLE bills_of_lading (
      id INTEGER PRIMARY KEY, manifest_id INTEGER, bl_no TEXT,
      consignor_name TEXT, consignor_document_type TEXT, consignor_document_no TEXT, consignor_tel TEXT, consignor_email TEXT, consignor_street TEXT, consignor_city TEXT,
      consignee_name TEXT, consignee_document_type TEXT, consignee_document_no TEXT, consignee_tel TEXT, consignee_email TEXT, consignee_street TEXT, consignee_city TEXT,
      goods_name TEXT, package_qty INTEGER, gross_weight REAL, value REAL,
      hacienda_item_code TEXT, hacienda_tariff TEXT, hacienda_container_no TEXT, hacienda_client_ss TEXT, hacienda_client_ivu TEXT, notes TEXT
    );
    CREATE TABLE containers (id INTEGER PRIMARY KEY, manifest_id INTEGER, container_no TEXT, container_type TEXT, package_code TEXT, amount INTEGER, gross_weight REAL, net_weight REAL, seal_no1 TEXT, size TEXT);
    CREATE TABLE container_bl (container_no TEXT, bl_no TEXT, manifest_id INTEGER);
  `);
  db.prepare(`INSERT INTO clients (id, name, ss) VALUES (1, 'ACME', '123456789')`).run();
  db.prepare(`INSERT INTO manifests (id, voyage_no, vessel_name) VALUES (1, 'CF371', 'BARCO 1')`).run();
  db.prepare(`INSERT INTO bills_of_lading (id, manifest_id, bl_no, consignor_name, consignor_city, consignee_name, gross_weight)
              VALUES (1, 1, 'CF371-001', 'EXPORTADOR X', 'STO DGO', 'JOHN DOE', 1500)`).run();
  db.prepare(`INSERT INTO bills_of_lading (id, manifest_id, bl_no, consignor_name, consignor_city, consignee_name, gross_weight)
              VALUES (2, 1, 'CF371-002', 'EXPORTADOR X', 'STO DGO', 'JANE DOE', 800)`).run();
  db.prepare(`INSERT INTO containers (id, manifest_id, container_no, size) VALUES (1, 1, 'MXRU1234567', '40')`).run();
  db.prepare(`INSERT INTO container_bl (container_no, bl_no, manifest_id) VALUES ('MXRU1234567', 'CF371-001', 1)`).run();
  return db;
}

function crearSiscommateFalso() {
  const tablas = {
    CUSTOMER: [{ name: 'ACME', ss: '123456789', code: '', type: '', taxid: '', add1: '', add2: '', add3: '', phone1: '', phone2: '', fax1: '', fax2: '', ivu: '' }],
    MANIFEST: [{ manifest: 'CF371', vessel: 'BARCO 1' }],
    BOL: [{ manifest: 'CF371', bolno: '001', consigne: 'JOHN DOE', exporter: 'EXPORTADOR X' }],
    BOLCONT: [{ manifest: 'CF371', bolno: '001', contain: 'MXRU1234567', size: '040', control: '1' }],
    BOLITEM: [{ manifest: 'CF371', bolno: '001', qty: 1, weight: 1500, desc: 'VEHICULO', code: '8703', value: 5000, control: '1' }],
  };
  return { obtenerTablaCompleta: async (tabla) => tablas[tabla] || [] };
}

test('construirLibroAuditoria genera las 11 hojas esperadas', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba(), crearSiscommateFalso());
  const nombres = workbook.worksheets.map(w => w.name);
  assert.deepStrictEqual(nombres, [
    'SQLite_Clientes', 'SQLite_Consignadores', 'SQLite_Consignatarios', 'SQLite_Manifiestos', 'SQLite_BLs', 'SQLite_Contenedores',
    'SISCOMMATE_Customers', 'SISCOMMATE_Manifiestos', 'SISCOMMATE_BLs', 'SISCOMMATE_Contenedores', 'SISCOMMATE_Items',
  ]);
});

test('SQLite_Consignadores deduplica: 2 B/L del mismo exportador dan 1 fila', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba(), crearSiscommateFalso());
  const hoja = workbook.getWorksheet('SQLite_Consignadores');
  assert.strictEqual(hoja.rowCount, 2); // encabezado + 1 fila de datos
  assert.strictEqual(hoja.getRow(2).getCell('consignor_name').value, 'EXPORTADOR X');
});

test('SQLite_Contenedores incluye los B/L asociados via container_bl', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba(), crearSiscommateFalso());
  const hoja = workbook.getWorksheet('SQLite_Contenedores');
  assert.strictEqual(hoja.getRow(2).getCell('bls_asociados').value, 'CF371-001');
});

test('la primera columna de cada hoja es la clave tecnica, sombreada y con nota', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba(), crearSiscommateFalso());
  const hoja = workbook.getWorksheet('SQLite_Clientes');
  assert.strictEqual(hoja.getRow(1).getCell(1).value, 'id');
  const celda = hoja.getRow(1).getCell(1);
  assert.strictEqual(celda.fill.fgColor.argb, 'FFD9D9D9');
  assert.ok(celda.note);
});

test('SISCOMMATE_BLs trae los datos del "siscommate" falso inyectado', async () => {
  const workbook = await construirLibroAuditoria(crearDbDePrueba(), crearSiscommateFalso());
  const hoja = workbook.getWorksheet('SISCOMMATE_BLs');
  assert.strictEqual(hoja.getRow(2).getCell('consigne').value, 'JOHN DOE');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test backend/services/dataAudit/exportar.test.js`
Expected: FAIL — `Cannot find module './exportar'`.

- [ ] **Step 3: Implement**

```javascript
// backend/services/dataAudit/exportar.js — Arma el Excel de auditoria con
// las 11 hojas declaradas en hojas.js. No sabe nada de SQL ni de SISCOMMATE:
// solo itera la configuracion y escribe filas en un Workbook de exceljs.

const ExcelJS = require('exceljs');
const { construirHojas } = require('./hojas');

const COLOR_CLAVE = 'FFD9D9D9'; // gris — columnas tecnicas, no editar
const NOTA_CLAVE = 'No editar — se usa para identificar la fila al reinyectar.';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} siscommate Ver backend/services/siscommateClient.js
 * @returns {Promise<import('exceljs').Workbook>}
 */
async function construirLibroAuditoria(db, siscommate) {
  const workbook = new ExcelJS.Workbook();
  for (const hoja of construirHojas()) {
    const filas = await hoja.obtenerFilas({ db, siscommate });
    agregarHoja(workbook, hoja, filas);
  }
  return workbook;
}

function agregarHoja(workbook, hoja, filas) {
  const worksheet = workbook.addWorksheet(hoja.nombre);
  const columnasClave = hoja.camposClave;
  // Las columnas de datos se derivan de la primera fila real (asi la hoja
  // siempre refleja TODO lo que trae el origen, incluyendo columnas
  // informativas como bls_asociados que no estan en camposEditables). Si no
  // hay filas, se cae a camposEditables para que la hoja al menos tenga
  // encabezados.
  const columnasResto = filas.length > 0
    ? Object.keys(filas[0]).filter(c => !columnasClave.includes(c))
    : hoja.camposEditables;
  const columnas = [...columnasClave, ...columnasResto];

  worksheet.columns = columnas.map(nombre => ({ header: nombre, key: nombre, width: 22 }));
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: 'frozen', xSplit: columnasClave.length, ySplit: 1 }];

  filas.forEach(fila => worksheet.addRow(fila));

  for (let i = 1; i <= columnasClave.length; i++) {
    worksheet.getColumn(i).eachCell({ includeEmpty: true }, (celda, numeroFila) => {
      celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_CLAVE } };
      if (numeroFila === 1) celda.note = NOTA_CLAVE;
    });
  }
}

module.exports = { construirLibroAuditoria };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test backend/services/dataAudit/exportar.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/dataAudit/exportar.js backend/services/dataAudit/exportar.test.js
git commit -m "feat: construir el libro de Excel de auditoria a partir de hojas.js"
```

---

### Task 10: `log.js` — audit trail for applied changes

**Files:**
- Create: `backend/services/dataAudit/log.js`
- Test: `backend/services/dataAudit/log.test.js`

**Interfaces:**
- Produces: `registrarCambio(entrada, logDir?)`, `rutaDelDia(fecha?, logDir?)` — consumed by `backend/scripts/dataAudit.js` (Task 12).

- [ ] **Step 1: Write the failing tests**

```javascript
// backend/services/dataAudit/log.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registrarCambio, rutaDelDia } = require('./log');

function carpetaTemporal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dataAudit-log-'));
}

test('registrarCambio crea la carpeta y el archivo del dia si no existen', () => {
  const dir = carpetaTemporal();
  registrarCambio({ hoja: 'SQLite_Clientes', claves: { id: 1 }, cambios: { name: { antes: 'A', despues: 'B' } } }, dir);
  const ruta = rutaDelDia(new Date(), dir);
  assert.ok(fs.existsSync(ruta));
});

test('registrarCambio agrega una linea JSON por llamada, con timestamp', () => {
  const dir = carpetaTemporal();
  registrarCambio({ hoja: 'X', claves: { id: 1 }, cambios: {} }, dir);
  registrarCambio({ hoja: 'Y', claves: { id: 2 }, cambios: {} }, dir);
  const lineas = fs.readFileSync(rutaDelDia(new Date(), dir), 'utf8').trim().split('\n');
  assert.strictEqual(lineas.length, 2);
  const primera = JSON.parse(lineas[0]);
  assert.strictEqual(primera.hoja, 'X');
  assert.ok(primera.timestamp);
});

test('registrarCambio conserva el campo error cuando la escritura fallo', () => {
  const dir = carpetaTemporal();
  registrarCambio({ hoja: 'X', claves: { id: 1 }, cambios: {}, error: 'El bridge no respondio' }, dir);
  const linea = JSON.parse(fs.readFileSync(rutaDelDia(new Date(), dir), 'utf8').trim());
  assert.strictEqual(linea.error, 'El bridge no respondio');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test backend/services/dataAudit/log.test.js`
Expected: FAIL — `Cannot find module './log'`.

- [ ] **Step 3: Implement**

```javascript
// backend/services/dataAudit/log.js — Registro de auditoria de cada cambio
// que reinyectar.js aplica (o intenta aplicar), para poder revertir a mano
// si algo sale mal en produccion. Un archivo por dia en logs/ (ya
// gitignorado — ver ../.gitignore).

const fs = require('fs');
const path = require('path');

const LOG_DIR_DEFAULT = path.join(__dirname, '..', '..', '..', 'logs');

/**
 * @param {Date} [fecha]
 * @param {string} [logDir]
 * @returns {string}
 */
function rutaDelDia(fecha = new Date(), logDir = LOG_DIR_DEFAULT) {
  const p = n => String(n).padStart(2, '0');
  return path.join(logDir, `dataAudit_${fecha.getFullYear()}${p(fecha.getMonth() + 1)}${p(fecha.getDate())}.log`);
}

/**
 * Agrega una linea al log del dia con el cambio aplicado (o el error, si fallo).
 * @param {{hoja: string, claves: Record<string, any>, cambios: Record<string, {antes: any, despues: any}>, error?: string}} entrada
 * @param {string} [logDir]
 */
function registrarCambio(entrada, logDir = LOG_DIR_DEFAULT) {
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const linea = JSON.stringify({ timestamp: new Date().toISOString(), ...entrada });
  fs.appendFileSync(rutaDelDia(new Date(), logDir), linea + '\n');
}

module.exports = { registrarCambio, rutaDelDia };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test backend/services/dataAudit/log.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/dataAudit/log.js backend/services/dataAudit/log.test.js
git commit -m "feat: log de auditoria para los cambios que reinyectar.js aplica"
```

---

### Task 11: `reinyectar.js` — diff plan, preview text, apply

**Files:**
- Create: `backend/services/dataAudit/reinyectar.js`
- Test: `backend/services/dataAudit/reinyectar.test.js`

**Interfaces:**
- Consumes: `construirHojas()` (Task 8), `calcularDiferencias` (Task 2).
- Produces: `calcularPlanDeCambios(rutaExcel, {db, siscommate}) => Promise<CambioFila[]>`, `formatearVistaPrevia(plan) => string`, `aplicarCambios(plan, {db, siscommate}, registrarCambio) => Promise<{aplicados, fallidos}>` — consumed by `backend/scripts/dataAudit.js` (Task 12).

- [ ] **Step 1: Write the failing tests**

```javascript
// backend/services/dataAudit/reinyectar.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const ExcelJS = require('exceljs');
const Database = require('better-sqlite3');
const { calcularPlanDeCambios, formatearVistaPrevia, aplicarCambios } = require('./reinyectar');

function crearDbDePrueba() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT, ss TEXT, taxid TEXT, add1 TEXT, add2 TEXT, add3 TEXT, phone1 TEXT, phone2 TEXT, ivu TEXT)`);
  db.prepare(`INSERT INTO clients (id, name, ss) VALUES (1, 'ACME', '123456789')`).run();
  // El resto de las tablas que hojas.js consulta deben existir, aunque vacias.
  db.exec(`
    CREATE TABLE manifests (id INTEGER PRIMARY KEY, voyage_no TEXT, vessel_name TEXT, loading_port TEXT, unloading_port TEXT, discharge_port TEXT, departure_date TEXT, arrival_date TEXT, manifest_no TEXT, carrier_code TEXT, docking_number TEXT, imo TEXT);
    CREATE TABLE bills_of_lading (
      id INTEGER PRIMARY KEY, manifest_id INTEGER, bl_no TEXT,
      consignor_name TEXT, consignor_document_type TEXT, consignor_document_no TEXT, consignor_tel TEXT, consignor_email TEXT, consignor_street TEXT, consignor_city TEXT,
      consignee_name TEXT, consignee_document_type TEXT, consignee_document_no TEXT, consignee_tel TEXT, consignee_email TEXT, consignee_street TEXT, consignee_city TEXT,
      goods_name TEXT, package_qty INTEGER, gross_weight REAL, value REAL,
      hacienda_item_code TEXT, hacienda_tariff TEXT, hacienda_container_no TEXT, hacienda_client_ss TEXT, hacienda_client_ivu TEXT, notes TEXT
    );
    CREATE TABLE containers (id INTEGER PRIMARY KEY, manifest_id INTEGER, container_no TEXT, container_type TEXT, package_code TEXT, amount INTEGER, gross_weight REAL, net_weight REAL, seal_no1 TEXT, size TEXT);
    CREATE TABLE container_bl (container_no TEXT, bl_no TEXT, manifest_id INTEGER);
  `);
  return db;
}

function crearSiscommateFalso(tablas = {}) {
  const base = { CUSTOMER: [], MANIFEST: [], BOL: [], BOLCONT: [], BOLITEM: [], ...tablas };
  const llamadas = { actualizarClienteSiscommate: [] };
  return {
    obtenerTablaCompleta: async (tabla) => base[tabla] || [],
    actualizarClienteSiscommate: async (nombre, datos) => { llamadas.actualizarClienteSiscommate.push({ nombre, datos }); return { ok: true, filas_afectadas: 1 }; },
    actualizarBolSiscommate: async () => ({ ok: true, filas_afectadas: 1 }),
    actualizarBolcontSiscommate: async () => ({ ok: true, filas_afectadas: 1 }),
    actualizarBolitemSiscommate: async () => ({ ok: true, filas_afectadas: 1 }),
    _llamadas: llamadas,
  };
}

// Genera un .xlsx minimo con una hoja SQLite_Clientes cuya fila 1 de datos
// trae un name distinto al que hay en la base — para forzar un diff real.
async function crearExcelDePrueba(rutaDestino, nombreCorregido) {
  const workbook = new ExcelJS.Workbook();
  const hoja = workbook.addWorksheet('SQLite_Clientes');
  hoja.columns = ['id', 'name', 'ss', 'taxid', 'add1', 'add2', 'add3', 'phone1', 'phone2', 'ivu'].map(k => ({ header: k, key: k }));
  hoja.addRow({ id: 1, name: nombreCorregido, ss: '123456789' });
  await workbook.xlsx.writeFile(rutaDestino);
}

test('calcularPlanDeCambios detecta un cambio real y lo ignora si no hay diferencias', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataAudit-reinyectar-'));
  const rutaExcel = path.join(dir, 'audit.xlsx');
  await crearExcelDePrueba(rutaExcel, 'ACME CORP');

  const db = crearDbDePrueba();
  const plan = await calcularPlanDeCambios(rutaExcel, { db, siscommate: crearSiscommateFalso() });

  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].hoja, 'SQLite_Clientes');
  assert.deepStrictEqual(plan[0].cambios, { name: { antes: 'ACME', despues: 'ACME CORP' } });
});

test('calcularPlanDeCambios no incluye filas sin cambios', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataAudit-reinyectar-'));
  const rutaExcel = path.join(dir, 'audit.xlsx');
  await crearExcelDePrueba(rutaExcel, 'ACME'); // mismo nombre que ya tiene la base

  const db = crearDbDePrueba();
  const plan = await calcularPlanDeCambios(rutaExcel, { db, siscommate: crearSiscommateFalso() });

  assert.strictEqual(plan.length, 0);
});

test('calcularPlanDeCambios marca error si el registro original ya no existe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataAudit-reinyectar-'));
  const rutaExcel = path.join(dir, 'audit.xlsx');
  const workbook = new ExcelJS.Workbook();
  const hoja = workbook.addWorksheet('SQLite_Clientes');
  hoja.columns = ['id', 'name', 'ss', 'taxid', 'add1', 'add2', 'add3', 'phone1', 'phone2', 'ivu'].map(k => ({ header: k, key: k }));
  hoja.addRow({ id: 999, name: 'FANTASMA', ss: '000' }); // id que no existe en la base
  await workbook.xlsx.writeFile(rutaExcel);

  const db = crearDbDePrueba();
  const plan = await calcularPlanDeCambios(rutaExcel, { db, siscommate: crearSiscommateFalso() });

  assert.strictEqual(plan.length, 1);
  assert.ok(plan[0].error);
});

test('formatearVistaPrevia muestra antes/despues legible y cuenta los cambios', () => {
  const plan = [{ hoja: 'SQLite_Clientes', claves: { id: 1 }, cambios: { name: { antes: 'ACME', despues: 'ACME CORP' } } }];
  const texto = formatearVistaPrevia(plan);
  assert.match(texto, /SQLite_Clientes/);
  assert.match(texto, /"ACME" → "ACME CORP"/);
  assert.match(texto, /1 cambio/);
});

test('formatearVistaPrevia sin cambios lo dice explicitamente', () => {
  assert.strictEqual(formatearVistaPrevia([]), 'No hay cambios que aplicar.');
});

test('aplicarCambios ejecuta escribirCambio y registra en el log; no toca las filas con error', async () => {
  const db = crearDbDePrueba();
  const siscommate = crearSiscommateFalso();
  const plan = [
    { hoja: 'SQLite_Clientes', claves: { id: 1 }, cambios: { name: { antes: 'ACME', despues: 'ACME CORP' } }, filaFinal: { id: 1, name: 'ACME CORP' }, spec: require('./hojas').construirHojas().find(h => h.nombre === 'SQLite_Clientes') },
    { hoja: 'SQLite_Clientes', claves: { id: 2 }, error: 'No se encontro el registro original' },
  ];
  const registrados = [];
  const resultado = await aplicarCambios(plan, { db, siscommate }, entrada => registrados.push(entrada));

  assert.deepStrictEqual(resultado, { aplicados: 1, fallidos: 1 });
  assert.strictEqual(db.prepare('SELECT name FROM clients WHERE id = 1').get().name, 'ACME CORP');
  assert.strictEqual(registrados.length, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test backend/services/dataAudit/reinyectar.test.js`
Expected: FAIL — `Cannot find module './reinyectar'`.

- [ ] **Step 3: Implement**

```javascript
// backend/services/dataAudit/reinyectar.js — Lee el Excel corregido, calcula
// que cambio contra el estado actual (sin escribir nada), arma el texto de
// vista previa, y aplica los cambios ya aprobados. Usa la misma
// configuracion de hojas.js que exportar.js, para que ambos lados nunca se
// desalineen sobre que campo vive en que hoja.

const ExcelJS = require('exceljs');
const { construirHojas } = require('./hojas');
const { calcularDiferencias } = require('./diff');

/**
 * @typedef {object} CambioFila
 * @property {string} hoja
 * @property {Record<string, any>} claves
 * @property {Record<string, {antes: any, despues: any}>} [cambios]
 * @property {Record<string, any>} [filaFinal]
 * @property {string} [error]
 * @property {object} [spec] HojaSpec de hojas.js — ausente cuando hay error
 */

/**
 * @param {string} rutaExcel
 * @param {{db: import('better-sqlite3').Database, siscommate: object}} deps
 * @returns {Promise<CambioFila[]>}
 */
async function calcularPlanDeCambios(rutaExcel, deps) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(rutaExcel);

  const filasPorProcesar = [];
  for (const spec of construirHojas()) {
    if (!spec.leerActual || !spec.escribirCambio) continue; // hoja de solo lectura
    const worksheet = workbook.getWorksheet(spec.nombre);
    if (!worksheet) continue;

    const encabezados = worksheet.getRow(1).values.slice(1).map(String);
    worksheet.eachRow((row, numeroFila) => {
      if (numeroFila === 1) return;
      const filaExcel = {};
      row.values.slice(1).forEach((valor, i) => { filaExcel[encabezados[i]] = valor; });
      const claves = {};
      spec.camposClave.forEach(c => { claves[c] = String(filaExcel[c] ?? '').trim(); });
      filasPorProcesar.push({ spec, claves, filaExcel });
    });
  }

  const resueltos = await Promise.all(filasPorProcesar.map(async ({ spec, claves, filaExcel }) => {
    const filaActual = await spec.leerActual(deps, claves);
    if (!filaActual) {
      return { hoja: spec.nombre, claves, error: 'No se encontró el registro original (¿fue borrado o renombrado?)' };
    }
    const cambios = calcularDiferencias(filaExcel, filaActual, spec.camposEditables);
    if (Object.keys(cambios).length === 0) return null; // sin cambios, no entra al plan
    const filaFinal = { ...filaActual };
    Object.keys(cambios).forEach(c => { filaFinal[c] = cambios[c].despues; });
    return { hoja: spec.nombre, claves, cambios, filaFinal, spec };
  }));

  return resueltos.filter(Boolean);
}

/**
 * @param {CambioFila[]} plan
 * @returns {string}
 */
function formatearVistaPrevia(plan) {
  if (plan.length === 0) return 'No hay cambios que aplicar.';
  const lineas = [];
  for (const item of plan) {
    if (item.error) {
      lineas.push(`[${item.hoja}] ${JSON.stringify(item.claves)} — ERROR: ${item.error}`);
      continue;
    }
    lineas.push(`[${item.hoja}] ${JSON.stringify(item.claves)}`);
    for (const [campo, { antes, despues }] of Object.entries(item.cambios)) {
      lineas.push(`  ${campo}: "${antes}" → "${despues}"`);
    }
  }
  const aplicables = plan.filter(i => !i.error).length;
  const conError = plan.length - aplicables;
  lineas.push('');
  lineas.push(`${aplicables} cambio${aplicables === 1 ? '' : 's'} por aplicar${conError ? `, ${conError} con error (no se aplicarán)` : ''}.`);
  return lineas.join('\n');
}

/**
 * Aplica un plan ya calculado (ignora automáticamente los que tienen error).
 * @param {CambioFila[]} plan
 * @param {{db: object, siscommate: object}} deps
 * @param {(entrada: object) => void} registrarCambio Ver ./log.js
 * @returns {Promise<{aplicados: number, fallidos: number}>}
 */
async function aplicarCambios(plan, deps, registrarCambio) {
  let aplicados = 0, fallidos = 0;
  for (const item of plan) {
    if (item.error) {
      registrarCambio({ hoja: item.hoja, claves: item.claves, cambios: {}, error: item.error });
      fallidos++;
      continue;
    }
    try {
      await item.spec.escribirCambio(deps, item.claves, item.cambios, item.filaFinal);
      registrarCambio({ hoja: item.hoja, claves: item.claves, cambios: item.cambios });
      aplicados++;
    } catch (e) {
      registrarCambio({ hoja: item.hoja, claves: item.claves, cambios: item.cambios, error: e.message });
      fallidos++;
    }
  }
  return { aplicados, fallidos };
}

module.exports = { calcularPlanDeCambios, formatearVistaPrevia, aplicarCambios };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test backend/services/dataAudit/reinyectar.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/dataAudit/reinyectar.js backend/services/dataAudit/reinyectar.test.js
git commit -m "feat: calcular y aplicar el plan de reinyeccion con vista previa obligatoria"
```

---

### Task 12: `backend/scripts/dataAudit.js` — CLI wiring

**Files:**
- Create: `backend/scripts/dataAudit.js`
- Modify: `package.json` (two convenience npm scripts)

**Interfaces:**
- Consumes: `construirLibroAuditoria` (Task 9), `calcularPlanDeCambios`, `formatearVistaPrevia`, `aplicarCambios` (Task 11), `registrarCambio` (Task 10), `../db/connection` (existing), `../services/siscommateClient` (existing + Task 7).

This task has no automated test — it's a thin CLI wrapper around already-tested functions (same shape as the existing `backend/scripts/backup.js`, which also has no test file). It's verified manually in Step 3 and, end-to-end, in Task 13.

- [ ] **Step 1: Implement**

```javascript
// backend/scripts/dataAudit.js — Auditoria SQLite + SISCOMMATE via Excel
//
// Uso:
//   node backend/scripts/dataAudit.js exportar
//   node backend/scripts/dataAudit.js reinyectar <archivo.xlsx>
//
// Ver docs/superpowers/specs/2026-09-28-data-audit-excel-design.md para el diseno completo.

const path = require('path');
const readline = require('readline');
const db = require('../db/connection');
const siscommate = require('../services/siscommateClient');
const { construirLibroAuditoria } = require('../services/dataAudit/exportar');
const { calcularPlanDeCambios, formatearVistaPrevia, aplicarCambios } = require('../services/dataAudit/reinyectar');
const { registrarCambio } = require('../services/dataAudit/log');

function marcaDeTiempo() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function preguntar(texto) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(texto, respuesta => { rl.close(); resolve(respuesta); }));
}

async function exportar() {
  const destino = path.join(__dirname, '..', '..', `audit_${marcaDeTiempo()}.xlsx`);
  console.log('Exportando SQLite + SISCOMMATE...');
  const workbook = await construirLibroAuditoria(db, siscommate);
  await workbook.xlsx.writeFile(destino);
  console.log(`[OK] Excel generado: ${destino}`);
}

async function reinyectar(rutaExcel) {
  if (!rutaExcel) {
    console.error('Uso: node backend/scripts/dataAudit.js reinyectar <archivo.xlsx>');
    process.exitCode = 1;
    return;
  }
  console.log('Calculando cambios...');
  const plan = await calcularPlanDeCambios(rutaExcel, { db, siscommate });
  console.log(formatearVistaPrevia(plan));
  if (plan.length === 0) return;

  const respuesta = await preguntar('¿Aplicar estos cambios? (y/N) ');
  if (respuesta.trim().toLowerCase() !== 'y') {
    console.log('Cancelado — no se escribió nada.');
    return;
  }
  const resultado = await aplicarCambios(plan, { db, siscommate }, registrarCambio);
  console.log(`[OK] ${resultado.aplicados} aplicado(s), ${resultado.fallidos} con error.`);
}

async function main() {
  const [, , comando, arg] = process.argv;
  if (comando === 'exportar') await exportar();
  else if (comando === 'reinyectar') await reinyectar(arg);
  else {
    console.error('Uso: node backend/scripts/dataAudit.js exportar | reinyectar <archivo.xlsx>');
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('[ERROR]', err.message);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Add npm script aliases**

In `package.json`, inside `"scripts"`, right after `"backup"`, add:

```json
    "data-audit:exportar": "node backend/scripts/dataAudit.js exportar",
    "data-audit:reinyectar": "node backend/scripts/dataAudit.js reinyectar",
```

- [ ] **Step 3: Manual verification against the local dev database**

Run: `npm run data-audit:exportar`
Expected: `[OK] Excel generado: .../audit_YYYYMMDD.xlsx`. Open the file and confirm all 11 sheets exist, `SQLite_*` sheets have real data from `manifest.db`, and `SISCOMMATE_*` sheets are populated if the bridge is reachable (empty with no crash if it isn't — verify `siscommateClient.obtenerTablaCompleta` surfaces the bridge's connection error instead of throwing an unhandled exception; if it throws, wrap the `SISCOMMATE_*` sheet's `obtenerFilas` calls in `hojas.js` is out of scope for this plan — note it as a follow-up if it happens, since the spec assumed the bridge is reachable during an audit).

Then edit one harmless cell (e.g. a `clients` row's `phone1`) and run:

Run: `npm run data-audit:reinyectar -- audit_YYYYMMDD.xlsx` (adjust filename)
Expected: preview shows exactly that one change, prompts for confirmation; answering `n` applies nothing (verify the cell is unchanged in `manifest.db`); re-running and answering `y` applies it (verify the cell changed) and appends a line to `logs/dataAudit_YYYYMMDD.log`.

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/dataAudit.js package.json
git commit -m "feat: CLI de auditoria de datos (exportar/reinyectar)"
```

---

### Task 13: End-to-end verification against a real SISCOMMATE write-back

**Files:** none (verification only — no code changes)

This task exists because the three new bridge endpoints (Task 6) and the SISCOMMATE-side `escribirCambio` functions (Task 8) can't be exercised by CI: they need a running `SiscommateBridge.exe` against a real DBF. This closes that gap deliberately, with a reversible test change, before trusting the tool on real audit corrections.

- [ ] **Step 1: Pick one real, low-risk B/L**

On the production bridge (or a copy of the DBF used for testing), find one `BOL` row whose `exporter` field has an obvious, known-safe typo to fix (or use a voyage already known to be a test/throwaway one from earlier sessions, e.g. anything under the `ZZTEST*` naming pattern used earlier in this project).

- [ ] **Step 2: Run a full exportar → edit → reinyectar cycle against it**

```bash
npm run data-audit:exportar
```

Open the resulting `.xlsx`, find that exact B/L row in `SISCOMMATE_BLs`, correct `exporter`, save.

```bash
npm run data-audit:reinyectar -- audit_YYYYMMDD.xlsx
```

Confirm the preview shows exactly that one field changing, on that exact `manifest`/`bolno`. Answer `y`.

- [ ] **Step 3: Verify against the live DBF**

```bash
curl "http://<bridge-host>:5001/exportar-tabla?tabla=BOL" | grep -A2 "\"bolno\":\"<ese bolno>\""
```

Expected: `exporter` shows the corrected value.

- [ ] **Step 4: Confirm the log captured it**

Check `logs/dataAudit_YYYYMMDD.log` on the machine that ran the script — the last line should have `"hoja":"SISCOMMATE_BLs"`, the right `claves`, and the `antes`/`despues` pair.

- [ ] **Step 5: Report back**

This is a manual verification task with no commit — report the outcome (pass/fail, and the exact row used) so the plan can be marked complete.

---

## Self-Review Notes

- **Spec coverage:** all 11 sheets (Task 8), technical key styling (Task 9), mandatory preview before write (Task 11 + Task 12 Step 3), audit log (Task 10), new bridge endpoints for `BOL`/`BOLCONT`/`BOLITEM` (Tasks 5–6), `exceljs` dependency (Task 1) — every section of the spec maps to a task.
- **Scope trim flagged explicitly:** `SISCOMMATE_Manifiestos` is read-only (no `MANIFEST` update endpoint) — called out in `hojas.js`'s own comment and in Task 8, since the spec's "Nuevos endpoints" list only named `BOL`/`BOLCONT`/`BOLITEM`, matching this plan.
- **Type/interface consistency checked:** `HojaSpec.escribirCambio` signature `(deps, claves, cambios, filaFinal)` is used identically in `hojas.js` (Task 8), `reinyectar.js` (Task 11), and the fake specs in `reinyectar.test.js`. `registrarCambio(entrada, logDir?)` matches between `log.js` (Task 10) and its call sites in `reinyectar.js`'s tests and `dataAudit.js` (Task 12).
