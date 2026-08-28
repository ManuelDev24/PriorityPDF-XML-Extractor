@echo off
REM ─────────────────────────────────────────────────────────────────────────
REM  instalar-servicio.bat
REM  Instala SiscommateBridge como servicio Windows usando NSSM
REM  Ejecutar como Administrador en el servidor 192.168.6.3
REM ─────────────────────────────────────────────────────────────────────────

SET SERVICE_NAME=SiscommateBridge
SET APP_DIR=C:\Priority\siscommate-bridge
SET NODE_EXE=C:\Program Files\nodejs\node.exe
SET NSSM=C:\nssm\nssm.exe

echo === Instalando dependencias npm ===
cd /d %APP_DIR%
call npm install --production
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: npm install fallo
    pause
    exit /b 1
)

echo === Registrando servicio con NSSM ===
%NSSM% remove %SERVICE_NAME% confirm 2>nul

%NSSM% install %SERVICE_NAME% "%NODE_EXE%" "server.js"
%NSSM% set %SERVICE_NAME% AppDirectory "%APP_DIR%"
%NSSM% set %SERVICE_NAME% DisplayName "SiscommateBridge (Manifiestos)"
%NSSM% set %SERVICE_NAME% Description "Inyecta datos de manifiestos en tablas DBF de SISCOMMATE"
%NSSM% set %SERVICE_NAME% Start SERVICE_AUTO_START
%NSSM% set %SERVICE_NAME% AppStdout "%APP_DIR%\logs\stdout.log"
%NSSM% set %SERVICE_NAME% AppStderr "%APP_DIR%\logs\stderr.log"
%NSSM% set %SERVICE_NAME% AppRotateFiles 1
%NSSM% set %SERVICE_NAME% AppRotateSeconds 86400
%NSSM% set %SERVICE_NAME% AppRotateBytes 1048576

echo === Iniciando servicio ===
%NSSM% start %SERVICE_NAME%
if %ERRORLEVEL% NEQ 0 (
    echo ERROR al iniciar. Revisar logs en %APP_DIR%\logs\
    pause
    exit /b 1
)

echo.
echo === Verificando (esperar 3 segundos) ===
ping -n 4 127.0.0.1 >nul
curl -s http://localhost:5001/health
echo.
echo === Instalacion completada ===
pause
