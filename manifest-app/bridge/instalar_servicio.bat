@echo off
REM ── Instalar SiscommateBridge como servicio de Windows ─────────────────────
REM Ejecutar como Administrador

echo Instalando SiscommateBridge como servicio...

REM Registrar el puerto en el firewall y HTTP
netsh http add urlacl url=http://localhost:5001/ user=Everyone

REM Usar sc.exe para crear el servicio (requiere SiscommateBridge.exe en misma carpeta)
set RUTA=%~dp0SiscommateBridge.exe

sc create SiscommateBridge binPath= "%RUTA%" start= auto DisplayName= "SISCOMMATE Bridge API"
sc description SiscommateBridge "Puente HTTP entre la app web de manifiestos y los DBF del SISCOMMATE"
sc start SiscommateBridge

echo.
echo Servicio instalado. Verificar en: http://localhost:5001/health
pause
