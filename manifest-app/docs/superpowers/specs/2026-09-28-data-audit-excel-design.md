# Auditoría de datos SQLite + SISCOMMATE vía Excel

Fecha: 2026-09-28
Estado: Aprobado por el usuario, pendiente de plan de implementación

## Problema

`manifest-app` (SQLite) y SISCOMMATE (DBF, vía `bridge/SiscommateBridge.cs`) son dos
copias de la misma realidad (viajes, B/L, clientes) que se han ido desincronizando:
nombres mal escritos, documentos incorrectos, datos faltantes. No hay forma de ver
de un vistazo dónde están los errores en ninguno de los dos sistemas, ni de corregirlos
sin editar campo por campo desde la UI o directo en el DBF.

Se necesita: exportar todo el estado relevante de ambos sistemas a un Excel bien
organizado (separado por tipo de entidad, no por B/L), permitir corregirlo a mano,
y reinyectar los cambios de vuelta a ambos sistemas de forma segura.

## Alcance

- **SISCOMMATE**: todo el histórico completo de `CUSTOMER`, `MANIFEST`, `BOL`,
  `BOLCONT`, `BOLITEM` — no solo los viajes que también existen en SQLite.
- **SQLite**: todas las tablas relevantes a un viaje — `clients`, `manifests`,
  `bills_of_lading`, `containers`, `container_bl`.
- Reinyección con vista previa obligatoria antes de escribir en producción.
- Fuera de alcance: UI web para este flujo (es un script de auditoría, no una
  feature permanente); revertir cambios automáticamente (el log sirve para
  revertir a mano si hace falta).

## Arquitectura y flujo de datos

Módulo nuevo `backend/services/dataAudit/`, operado por un script de consola
(sin pantalla nueva en el frontend):

```
node backend/scripts/dataAudit.js exportar
    → genera audit_YYYYMMDD.xlsx

node backend/scripts/dataAudit.js reinyectar audit_YYYYMMDD.xlsx
    → arma vista previa (antes → después) → pide confirmación → escribe
```

**Exportar**: lee SQLite directo con `better-sqlite3` (ya es dependencia del
proyecto) para `clients/manifests/bills_of_lading/containers/container_bl`, y
llama al bridge (`http://192.168.6.3:5001`, o el host que indique `.env`) para
el histórico completo de SISCOMMATE. Arma un único `.xlsx` con `exceljs`
(dependencia nueva — hoy no existe ninguna librería de Excel en el proyecto).

**Reinyectar**: relee el mismo Excel, compara cada fila contra el estado
actual usando su columna de clave técnica, imprime un diff campo por campo, y
solo tras confirmación explícita (`y/N` en consola) aplica los `UPDATE`
correspondientes — a SQLite directo, y a SISCOMMATE vía el bridge.

## Estructura del Excel

Un solo archivo `.xlsx` con 11 hojas. Cada hoja tiene como primera columna una
clave técnica **congelada y sombreada en gris**, con un comentario de celda
"No editar — se usa para identificar la fila al reinyectar". El resto de
columnas son editables libremente.

### Lado SQLite (clave = `id`, ya existe como PK en cada tabla)

| Hoja | Origen | Notas |
|------|--------|-------|
| `SQLite_Clientes` | tabla `clients` | tal cual |
| `SQLite_Consignadores` | `bills_of_lading`, deduplicado | una fila por `consignor_name` distinto, con `consignor_document_type/document_no/tel/email/street/city` — corregir una vez propaga a todos los B/L que compartan ese nombre |
| `SQLite_Consignatarios` | `bills_of_lading`, deduplicado | igual que arriba, con los campos `consignee_*` |
| `SQLite_Manifiestos` | tabla `manifests` | tal cual |
| `SQLite_BLs` | tabla `bills_of_lading` | completa: cantidad, peso, contenedor, arancel |
| `SQLite_Contenedores` | `containers` + `container_bl` | tal cual |

La deduplicación de consignadores/consignatarios es clave: sin ella, corregir
un nombre mal escrito significaría editar la misma dirección repetida en
decenas de filas de B/L.

### Lado SISCOMMATE (histórico completo, clave = llave de negocio real del DBF)

| Hoja | Tabla DBF | Clave |
|------|-----------|-------|
| `SISCOMMATE_Customers` | `CUSTOMER` | `name` (igual que ya usa `/cliente-actualizar`) |
| `SISCOMMATE_Manifiestos` | `MANIFEST` | `manifest` |
| `SISCOMMATE_BLs` | `BOL` | `manifest + bolno` — ahí solo existen `consigne`/`exporter` como texto libre; SISCOMMATE no guarda dirección/documento separado del consignador/consignatario |
| `SISCOMMATE_Contenedores` | `BOLCONT` | `manifest + bolno + contain` |
| `SISCOMMATE_Items` | `BOLITEM` | `manifest + bolno + control` |

## Nuevos endpoints en el bridge (`bridge/SiscommateBridge.cs`)

- `GET /exportar-tabla?tabla=X` — dump completo de una tabla sin límite `TOP`
  (el `/muestra` existente exige un límite fijo, no sirve para histórico
  completo).
- `POST /bol-actualizar` — `UPDATE BOL SET consigne=?,exporter=?,... WHERE manifest=? AND bolno=?`
- `POST /bolcont-actualizar` — `UPDATE BOLCONT ... WHERE manifest=? AND bolno=? AND contain=?`
- `POST /bolitem-actualizar` — `UPDATE BOLITEM ... WHERE manifest=? AND bolno=? AND control=?`

`/cliente-actualizar` (tabla `CUSTOMER`) ya existe y se reutiliza sin cambios.

## Seguridad — vista previa obligatoria

`reinyectar` nunca escribe en el primer paso. Primero arma un reporte tipo:

```
[SQLite] bills_of_lading id=4521 (bl_no CF371-001)
  consignor_name: "JHON DOE"  →  "JOHN DOE"
[SISCOMMATE] BOL manifest=CF371 bolno=001
  exporter: "JHON DOE"  →  "JOHN DOE"
2 cambios en SQLite, 1 cambio en SISCOMMATE. ¿Aplicar? (y/N)
```

Una fila sin cambios no aparece en el reporte y no dispara ningún `UPDATE`.
Solo tras la confirmación explícita se ejecutan los cambios, uno por uno, y
cada uno se registra (tabla, clave, campo, valor anterior, valor nuevo,
timestamp) en `logs/dataAudit_YYYYMMDD.log`, para poder revertir a mano si
algo sale mal.

## Testing

Pruebas unitarias en `backend/services/dataAudit/*.test.js` para:
- la generación de las hojas deduplicadas (consignadores/consignatarios),
- el cálculo del diff antes → después,
- que una fila sin cambios no dispare ningún `UPDATE`.

La escritura real contra SISCOMMATE no es testeable en CI (depende del
bridge y del DBF real) — se prueba manualmente contra producción con un
cambio de prueba controlado antes de usarlo para la auditoría completa.
