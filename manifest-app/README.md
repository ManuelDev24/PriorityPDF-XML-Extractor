# Editor Manifiesto DGA → Hacienda PR

Aplicación web local (Node.js + SQLite) para cargar el manifiesto de exportación
de la DGA (XML o PDF digital), editar los B/L y generar el archivo TXT para
Hacienda de Puerto Rico.

> **Nota sobre PDF:** el PDF debe ser generado digitalmente (SIGA u otro sistema),
> no un escaneo. El lector busca las etiquetas del manifiesto (No. Viaje, Buque,
> BL No, Consignatario, Peso Bruto, etc.); si tu formato de PDF no se reconoce,
> envía un ejemplo para ajustar el lector.

---

## Instalación

```bash
# 1. Descomprimir la carpeta manifest-app y entrar a ella
cd manifest-app

# 2. Instalar dependencias
npm install

# 3. Crear e inicializar la base de datos (solo la primera vez)
node db/init.js

# 4. Iniciar el servidor
npm start
```

Abrir en el navegador: **http://localhost:3000**

---

## Configurar SQLite compartido en red (varios usuarios)

SQLite puede usarse en red **si la carpeta compartida está en la misma LAN**.
Para múltiples usuarios simultáneos se recomienda que solo **un equipo corra
el servidor Node.js** y todos los demás accedan vía navegador a su IP.

### Opción A — Un servidor, todos acceden por navegador (RECOMENDADA)

1. Elige el equipo que actuará de servidor (puede ser cualquier PC de la oficina).
2. Instala Node.js en ese equipo: https://nodejs.org
3. Copia la carpeta `manifest-app` al servidor.
4. Ejecuta `npm install` y `node db/init.js`.
5. Inicia con `npm start`.
6. Desde los otros equipos, abre el navegador y entra a:
   ```
   http://192.168.1.XXX:3000
   ```
   (reemplaza con la IP real del servidor — la ves con `ipconfig` en Windows)

✅ Con esta opción SQLite funciona perfectamente: un solo proceso escribe,
   todos los usuarios leen y editan desde el navegador.

### Opción B — Archivo SQLite en carpeta de red

Si necesitas que el archivo `.db` esté en una carpeta de red compartida
(\\\\SERVIDOR\\carpeta\\), edita el archivo `.env`:

```env
DB_PATH=\\\\SERVIDOR\\ManifiestosDGA\\manifest.db
```

> ⚠️ Requisitos para SQLite en red:
> - La carpeta debe estar en una **red local (LAN)**, no en OneDrive/Google Drive.
> - Activa el modo WAL (ya está configurado en el código).
> - No recomendado si más de 3 usuarios editan al mismo tiempo.

La ruta `dbf_path` guardada en Administración se publica también en
`bridge\siscommate-bridge.config` (formato `dbf_path=...`) para que
`SiscommateBridge.exe` pueda consumirla sin leer SQLite. Si el servicio corre
en otra carpeta, use `SISCOMMATE_BRIDGE_CONFIG` para indicar el archivo; también
se admite `SISCOMMATE_DBF_PATH` (o `DBF_PATH`) como variable de entorno del
servicio. La variable tiene prioridad sobre el archivo.

### Opción C — Migrar a SQL Server (para uso intensivo)

Si ya tienen SQL Server en Priority Global, podemos migrar fácilmente.
Solo cambia el driver `better-sqlite3` por `mssql` y ajusta las queries
(son SQL estándar). Avísame y lo hacemos.

---

## Flujo de uso

1. **Cargar XML/PDF** — arrastra el archivo XML o PDF de exportación DGA o usa el botón.
2. **Editar B/L** — para cada B/L completa los campos de Hacienda PR:
   - Código arancelario (busca por descripción)
   - Tarifa (040 / 045)
   - SS/EIN del consignatario en Hacienda
   - Número de manifiesto Hacienda
3. **Validar** — marca cada B/L como "validado" cuando esté correcto.
4. **Exportar TXT** — genera el archivo `.TXT` listo para Hacienda PR.

---

## Estructura del proyecto

```
manifest-app/
├── server.js          ← Servidor Express (API + archivos estáticos)
├── db/
│   └── init.js        ← Crea tablas y carga catálogos
├── public/
│   └── index.html     ← Interfaz web completa
├── manifest.db        ← Base de datos SQLite (se crea con init.js)
├── .env               ← Configuración (puerto, ruta DB)
└── package.json
```

---

## Agregar más códigos arancelarios

Para importar todos los ítems del Excel de Hacienda:

```bash
node db/import-items.js Hacienda.xlsx
```

(el script `import-items.js` se genera si lo necesitas — avísame)

---

## Actualizar catálogo de clientes

Puedes importar la hoja "Client" del Excel directamente:

```sql
-- Desde SQLite CLI:
INSERT INTO clients (name, ss, taxid, add1, add2, phone1)
VALUES ('SUPERMERCADOS ECONO', '660329639', '660329639', 'SABANA ABAJO IND PARK', 'CAROLINA PR', '787-620-9292');
```

O usar el endpoint (próxima versión): `POST /api/catalogs/clients`
