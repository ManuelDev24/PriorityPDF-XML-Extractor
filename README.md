# PriorityPDF-XML-Extractor

Sistema integral para la extracción, edición, enriquecimiento y transmisión de Manifiestos de Carga Marítima (formatos XML DGA y PDF US Customs 1302 / Priority RORO) hacia **Hacienda de Puerto Rico** y el sistema **SISCOMMATE** (Visual FoxPro DBF).

---

## 🚀 Componentes del Proyecto

### 1. `manifest-app/` (Aplicación Principal Web + API)
- **Backend:** Express.js + SQLite (vía `better-sqlite3` con modo WAL).
- **Parser Multiformato:**
  - **XML DGA:** Formato estándar de exportación de la Dirección General de Aduanas (República Dominicana).
  - **PDF US Customs 1302:** Formato de Manifiesto de Carga Priority RORO bilingüe (Inbound: Santo Domingo → San Juan / Outbound: San Juan → St. Croix/USVI).
  - **PDF Genérico:** Extracción heurística por expresiones regulares para manifiestos digitales.
- **Catálogos integrados:**
  - Catálogo arancelario de Hacienda PR (más de 5,200 códigos de mercancía y tarifas 040/045).
  - Catálogo de Puertos (mapeo DGA/ISO → Códigos SISCOMMATE: `XSJ`, `DRP`, `CRX`, etc.).
  - Catálogo de Consignatarios y Clientes (SS/EIN, Tax ID, IVU).
  - Catálogo de Buques (Kydon, Lyktos, Caribbean Force, Aurora) con números IMO.
- **Exportación TXT Oficial:** Generador de archivos `.TXT` de 205 caracteres por línea con validación estricta para Hacienda PR.
- **Integración SISCOMMATE:** Cliente HTTP para inyección directa a tablas DBF mediante el Bridge.

### 2. `siscommate-bridge/` y `manifest-app/bridge/` (Bridge de Datos DBF)
- **C# / .NET Service (`SiscommateBridge.cs`):** Servicio HTTP (puerto 5001) para interactuar con las tablas Visual FoxPro (`MANIFEST.DBF`, `BOL.DBF`, `BOLCONT.DBF`, `BOLITEM.DBF`).
- **Node.js Bridge alternativo (`dbf.js`):** Implementación en JavaScript para lectura y escritura directa en FoxPro DBF.

---

## 📦 Instalación y Puesta en Marcha

### Prerrequisitos
- Node.js 18+ (o Node.js 20 LTS)
- .NET Framework 4.0+ y proveedor `VFPOLEDB` (para el bridge de SISCOMMATE en Windows)

### 1. Iniciar la Aplicación Web (`manifest-app`)
```bash
cd manifest-app
npm install
node db/init.js     # Inicializa la base de datos y catálogos (solo la primera vez)
npm start           # Inicia el servidor en http://localhost:3000
```

### 2. Iniciar el Bridge de SISCOMMATE (opcional para integración directa)
```bash
cd manifest-app/bridge
# Compilar si es necesario:
compilar.bat
# Iniciar manualmente:
iniciar_manual.bat
```

---

## 🚢 Flujo Operativo

1. **Carga:** Arrastrar el manifiesto (PDF digital o XML) en la interfaz web (`http://localhost:3000`).
2. **Revisión y Edición:**
   - Asignación automática de códigos arancelarios sugeridos por descripción.
   - Vinculación de consignatarios con su SS/EIN e IVU de Hacienda.
   - Verificación de contenedores y tamaños (`20'`, `40'`, `40HC`, `FR`, etc.).
3. **Validación:** Marcar los B/L como validados e ingresar el *Docking Number* del viaje.
4. **Exportación / Inyección:**
   - Descargar archivo `.TXT` formateado para Hacienda PR.
   - O presionar **Push a SISCOMMATE** para escribir directamente en las tablas FoxPro.

---

## 🔒 Licencia y Confidencialidad
Desarrollado para la gestión de carga y manifiestos de Priority RORO Services.
