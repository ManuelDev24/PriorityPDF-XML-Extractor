# SiscommateBridge — Instalación en Windows Server 2008

## Prerrequisitos

### 1. Node.js v16 (última versión compatible con Windows Server 2008 R2)
Descargar: https://nodejs.org/dist/v16.20.2/node-v16.20.2-x64.msi
Instalar con todas las opciones por defecto.

### 2. VFP OLE DB Provider
Descargar: https://aka.ms/vfpoledb  (archivo: vfpoledb.exe ~3 MB)
Instalar como Administrador. Es gratuito de Microsoft.
Verificar en: Panel de control → Orígenes de datos ODBC → Drivers

### 3. NSSM (gestor de servicios)
Descargar: https://nssm.cc/release/nssm-2.24.zip
Extraer y copiar `nssm.exe` (win64) a `C:\nssm\nssm.exe`

---

## Configuración

Editar el archivo `.env` en `C:\Priority\siscommate-bridge\.env`:

```
PORT=5001
DBF_PATH=C:\Priority\SISCOMMATE\DATA
```

> Si la carpeta de datos de SISCOMMATE está en otra ruta, ajustar `DBF_PATH`.
> También puede ser una ruta UNC: `\\SERVIDOR\Compartido\DATA`

---

## Instalación como servicio Windows

1. Abrir **CMD como Administrador**
2. Ejecutar:
   ```
   cd C:\Priority\siscommate-bridge
   instalar-servicio.bat
   ```

El script:
- Instala dependencias npm
- Registra el servicio `SiscommateBridge` con NSSM
- Lo inicia automáticamente
- Verifica con `curl http://localhost:5001/health`

---

## Verificación manual

```
curl http://localhost:5001/health
```

Respuesta esperada:
```json
{"ok":true,"dbf_path":"C:\\Priority\\SISCOMMATE\\DATA","version":"1.0.0"}
```

Si `ok: false`, el error indica el problema con la conexión DBF.

---

## Logs

- `C:\Priority\siscommate-bridge\logs\stdout.log`
- `C:\Priority\siscommate-bridge\logs\stderr.log`

Rotan automáticamente cada 24 horas o al llegar a 1 MB.

---

## Comandos de administración

```batch
# Ver estado del servicio
nssm status SiscommateBridge

# Reiniciar
nssm restart SiscommateBridge

# Detener
nssm stop SiscommateBridge

# Desinstalar
nssm remove SiscommateBridge confirm
```

---

## Firewall (si manifest-app está en otra PC)

Abrir puerto 5001 TCP entrante:
```
netsh advfirewall firewall add rule name="SiscommateBridge" dir=in action=allow protocol=TCP localport=5001
```

Luego en `manifest-app` (PC con Windows 10), editar Admin → Configuración del Bridge:
- Host: `192.168.6.3`
- Puerto: `5001`
