@echo off
:: ============================================================
:: PREPARAR PAQUETE DE DESPLIEGUE PARA WS2008 SP2 32-BIT
::
:: Ejecutar en la maquina de desarrollo (Windows 10/11 64-bit)
:: Genera una carpeta lista para copiar al servidor.
::
:: REQUIERE: Node.js 12.22.12 x86 instalado en este equipo
::   Descarga: https://nodejs.org/dist/v12.22.12/node-v12.22.12-x86.msi
::   Instala en C:\nodejs32\ (cambia el path de instalacion en el wizard)
:: ============================================================
setlocal

set NODE32=C:\nodejs32\node.exe
set NPM32=C:\nodejs32\npm.cmd
set APP_DIR=%~dp0
set APP_DIR=%APP_DIR:~0,-1%
set DEPLOY_DIR=%APP_DIR%\..\manifest-app-deploy
set DEST=%DEPLOY_DIR%\manifest-app

echo.
echo ================================================
echo  Preparando paquete para WS2008 SP2 32-bit
echo ================================================
echo.

:: Verificar Node.js 32-bit
if not exist "%NODE32%" (
    echo [ERROR] Node.js 32-bit no encontrado en %NODE32%
    echo.
    echo PASOS:
    echo 1. Descarga Node.js 12.22.12 ^(x86^):
    echo    https://nodejs.org/dist/v12.22.12/node-v12.22.12-x86.msi
    echo 2. Durante la instalacion, cambia la carpeta destino a:
    echo    C:\nodejs32
    echo 3. Vuelve a ejecutar este script
    echo.
    pause & exit /b 1
)

:: Verificar version
for /f "tokens=*" %%v in ('"%NODE32%" --version') do set NODE_VER=%%v
echo [OK] Node.js 32-bit: %NODE_VER%

:: Verificar arquitectura - debe ser x86
for /f "tokens=*" %%a in ('"%NODE32%" -e "process.arch" 2^>^&1') do set ARCH=%%a
echo [OK] Arquitectura: %ARCH%
if /i not "%ARCH%"=="ia32" (
    echo [ERROR] El Node.js en %NODE32% no es de 32-bit ^(ia32^).
    echo         Asegurate de instalar node-v12.22.12-x86.msi
    pause & exit /b 1
)

:: Crear carpeta de destino
echo.
echo [1/4] Preparando carpeta de despliegue...
if exist "%DEST%" (
    echo Limpiando carpeta anterior...
    rmdir /s /q "%DEST%"
)
mkdir "%DEST%"

:: Copiar archivos del proyecto (sin node_modules)
echo [2/4] Copiando archivos del proyecto...
xcopy "%APP_DIR%\backend\*"          "%DEST%\backend\" /s /q
xcopy "%APP_DIR%\package.json"       "%DEST%\" /q
xcopy "%APP_DIR%\.env.produccion"    "%DEST%\.env" /q
xcopy "%APP_DIR%\frontend\*"         "%DEST%\frontend\" /s /q
xcopy "%APP_DIR%\db\*"               "%DEST%\db\" /s /q
xcopy "%APP_DIR%\bridge\*"           "%DEST%\bridge\" /s /q
xcopy "%APP_DIR%\instalar_produccion.bat" "%DEST%\" /q

:: Instalar dependencias con Node.js 32-bit
echo [3/4] Instalando dependencias con Node.js 32-bit...
cd /d "%DEST%"
"%NPM32%" install --production
if errorlevel 1 (
    echo [ERROR] Fallo npm install. Verifica la instalacion de Node.js 32-bit.
    pause & exit /b 1
)

:: Verificar que better-sqlite3 es 32-bit
echo [4/4] Verificando modulo nativo...
"%NODE32%" -e "const db=require('better-sqlite3')(':memory:');db.close();console.log('better-sqlite3 OK')"
if errorlevel 1 (
    echo [ERROR] better-sqlite3 no funciona. Puede necesitar herramientas de compilacion:
    echo         npm install -g windows-build-tools
    pause & exit /b 1
)

echo.
echo ================================================
echo  Paquete listo en:
echo  %DEST%
echo ================================================
echo.
echo SIGUIENTE PASO:
echo 1. Copia la carpeta manifest-app al servidor WS2008
echo    Destino sugerido: C:\manifest-app\
echo.
echo 2. En el servidor, instala Node.js 12.22.12 x86:
echo    node-v12.22.12-x86.msi
echo.
echo 3. Copia NSSM 32-bit al servidor:
echo    nssm-2.24 ^> win32 ^> nssm.exe ^> C:\Windows\System32\
echo.
echo 4. Ejecuta instalar_produccion.bat como Administrador
echo.
echo NOTA: El manifest.db se crea al primer inicio.
echo       NO copies el manifest.db de desarrollo.
echo.
pause
