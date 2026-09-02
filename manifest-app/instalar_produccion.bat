@echo off
:: ============================================================
:: manifest-app — Instalacion en Produccion
:: Windows 11 / Windows 10 (64-bit)
:: Ejecutar como Administrador
:: ============================================================
setlocal

set APP_DEST=C:\manifest-app
set NODE_EXE=node.exe

echo.
echo ================================================
echo  Priority Global — Manifest App
echo  Instalacion en Produccion (Windows 11)
echo ================================================
echo.

:: Verificar que se ejecuta como Admin
net session >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Ejecuta este script como Administrador.
    echo         Click derecho → "Ejecutar como administrador"
    pause & exit /b 1
)

:: Verificar Node.js
%NODE_EXE% --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js no encontrado.
    echo         Descarga: https://nodejs.org/en/download ^(LTS^)
    pause & exit /b 1
)
for /f "tokens=*" %%v in ('%NODE_EXE% --version') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER%

:: Verificar NSSM
where nssm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] NSSM no encontrado.
    echo         1. Descarga: https://nssm.cc/release/nssm-2.24.zip
    echo         2. Extrae y copia win64\nssm.exe a C:\Windows\System32\
    pause & exit /b 1
)
echo [OK] NSSM encontrado

:: Crear directorio de instalacion
echo.
echo [1/6] Creando directorio C:\manifest-app...
if not exist "%APP_DEST%" mkdir "%APP_DEST%"
if not exist "%APP_DEST%\logs" mkdir "%APP_DEST%\logs"

:: Copiar archivos
echo [2/6] Copiando archivos...
xcopy /s /y /q "%~dp0*"  "%APP_DEST%\"
if errorlevel 1 (
    echo [ERROR] Fallo al copiar archivos
    pause & exit /b 1
)

:: Configurar .env
echo [3/6] Configurando .env...
if not exist "%APP_DEST%\.env" (
    copy /y "%APP_DEST%\.env.produccion" "%APP_DEST%\.env" >nul
    echo [OK] .env creado desde .env.produccion
) else (
    echo [OK] .env ya existe, no se sobreescribe
)

:: Instalar dependencias npm
:: Se instalan TODAS (no solo --production) porque el frontend en Vue se compila
:: aqui con Vite, que es una dependencia de desarrollo. Node 20 sobre Windows 10
:: es plataforma Tier 1 y Vite 8 requiere Node 20.19+; ambos verificados.
echo [4/6] Instalando dependencias npm...
cd /d "%APP_DEST%"
npm install
if errorlevel 1 (
    echo [ERROR] Fallo npm install
    pause & exit /b 1
)
echo [OK] Dependencias instaladas

:: Compilar el frontend en Vue
echo      Compilando frontend...
npm run build
if errorlevel 1 (
    echo.
    echo [ERROR] Fallo la compilacion del frontend ^(npm run build^).
    echo         La aplicacion actual seguira funcionando: el build solo agrega
    echo         archivos, no borra los existentes. Revisa el error de arriba.
    echo.
    pause & exit /b 1
)
echo [OK] Frontend compilado

:: Verificar que el modulo nativo cargue con ESTE Node.
:: better-sqlite3 se compila contra la version de Node que ejecuta npm install.
:: Si el servicio despues corre con otra version mayor, falla en el arranque con
:: un error críptico de NODE_MODULE_VERSION. Mejor detectarlo aqui.
%NODE_EXE% -e "require('better-sqlite3')" 2>nul
if errorlevel 1 (
    echo.
    echo [ERROR] El modulo nativo better-sqlite3 no carga con este Node.
    echo.
    echo   Causa habitual: npm install se ejecuto con una version de Node
    echo   distinta a la que va a correr la aplicacion.
    echo.
    echo   Solucion: borra la carpeta node_modules y vuelve a ejecutar este
    echo   script con la MISMA version de Node que usara el servicio.
    echo.
    pause & exit /b 1
)
echo [OK] Modulo nativo better-sqlite3 verificado

:: Inicializar base de datos (solo si no existe)
echo [5/6] Inicializando base de datos...
if not exist "%APP_DEST%\manifest.db" (
    node db/init.js
    if errorlevel 1 (
        echo [ERROR] Fallo inicializacion de DB
        pause & exit /b 1
    )
    echo [OK] manifest.db creado con catalogo Hacienda PR ^(5,298 items^)
) else (
    echo [OK] manifest.db ya existe
)

:: Instalar servicios con NSSM
echo [6/6] Instalando servicios Windows...

:: -- ManifestApp --
sc query ManifestApp >nul 2>&1
if not errorlevel 1 (
    echo Deteniendo servicio anterior ManifestApp...
    nssm stop ManifestApp >nul 2>&1
    nssm remove ManifestApp confirm >nul 2>&1
)
nssm install ManifestApp "%NODE_EXE%" "backend\server.js"
nssm set ManifestApp AppDirectory "%APP_DEST%"
nssm set ManifestApp DisplayName "Priority Global — Manifest App"
nssm set ManifestApp Description "Editor de Manifiestos DGA para Hacienda PR"
nssm set ManifestApp Start SERVICE_AUTO_START
nssm set ManifestApp AppStdout "%APP_DEST%\logs\app.log"
nssm set ManifestApp AppStderr "%APP_DEST%\logs\app-error.log"
nssm set ManifestApp AppRotateFiles 1
nssm set ManifestApp AppRotateBytes 5000000
nssm start ManifestApp
echo [OK] Servicio ManifestApp instalado y arrancado

:: -- SiscommateBridge --
if exist "%APP_DEST%\bridge\SiscommateBridge.exe" (
    sc query SiscommateBridge >nul 2>&1
    if not errorlevel 1 (
        echo Deteniendo servicio anterior SiscommateBridge...
        nssm stop SiscommateBridge >nul 2>&1
        nssm remove SiscommateBridge confirm >nul 2>&1
    )
    :: Registrar URL para HttpListener (requiere admin)
    netsh http add urlacl url=http://localhost:5001/ user="NT AUTHORITY\SYSTEM" >nul 2>&1
    nssm install SiscommateBridge "%APP_DEST%\bridge\SiscommateBridge.exe"
    nssm set SiscommateBridge AppDirectory "%APP_DEST%\bridge"
    nssm set SiscommateBridge DisplayName "Priority Global — SISCOMMATE Bridge"
    nssm set SiscommateBridge Description "Puente HTTP a base de datos DBF de SISCOMMATE"
    nssm set SiscommateBridge Start SERVICE_AUTO_START
    nssm set SiscommateBridge AppStdout "%APP_DEST%\logs\bridge.log"
    nssm set SiscommateBridge AppStderr "%APP_DEST%\logs\bridge-error.log"
    nssm start SiscommateBridge
    echo [OK] Servicio SiscommateBridge instalado y arrancado
) else (
    echo [AVISO] SiscommateBridge.exe no encontrado.
    echo         Compila el Bridge primero: ejecuta bridge\compilar.bat
    echo         Luego vuelve a ejecutar este script.
)

:: Abrir regla de firewall para acceso LAN
echo.
echo Abriendo puerto 3000 en el firewall...
netsh advfirewall firewall delete rule name="ManifestApp" >nul 2>&1
netsh advfirewall firewall add rule name="ManifestApp" dir=in action=allow protocol=TCP localport=3000
echo [OK] Firewall configurado

:: Resultado
echo.
echo ================================================
echo  Instalacion completada exitosamente
echo ================================================
echo.
echo  URL local:    http://localhost:3000
echo  URL en red:   http://%COMPUTERNAME%:3000
echo.
echo  Servicios instalados ^(se inician automaticamente^):
echo    - ManifestApp        ^(puerto 3000^)
echo    - SiscommateBridge   ^(puerto 5001^)
echo.
echo  Logs en: %APP_DEST%\logs\
echo.
echo  PRUEBA AHORA:
echo  1. Abre http://localhost:3000
echo  2. Verifica que el Bridge muestra "activo"
echo  3. Carga un XML de prueba con 1-2 B/L
echo  4. Guarda en SISCOMMATE y confirma el lote
echo ================================================
echo.

:: Abrir el navegador automaticamente
timeout /t 3 /nobreak >nul
start http://localhost:3000

pause
