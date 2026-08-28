@echo off
REM ── Compilar SiscommateBridge.exe ──────────────────────────────────────────
REM Requiere .NET Framework 3.5 o superior (viene con Windows Server 2008)

echo Compilando SiscommateBridge...

REM Buscar csc.exe en ubicaciones comunes de .NET Framework
set CSC=""
if exist "%windir%\Microsoft.NET\Framework\v4.0.30319\csc.exe" (
    set CSC="%windir%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) else if exist "%windir%\Microsoft.NET\Framework\v3.5\csc.exe" (
    set CSC="%windir%\Microsoft.NET\Framework\v3.5\csc.exe"
) else if exist "%windir%\Microsoft.NET\Framework\v2.0.50727\csc.exe" (
    set CSC="%windir%\Microsoft.NET\Framework\v2.0.50727\csc.exe"
)

if %CSC%=="" (
    echo ERROR: No se encontro csc.exe. Instala .NET Framework 3.5+
    pause
    exit /b 1
)

echo Usando: %CSC%

%CSC% SiscommateBridge.cs ^
    /r:System.Data.dll ^
    /r:System.Web.Extensions.dll ^
    /r:System.Net.dll ^
    /target:exe ^
    /out:SiscommateBridge.exe

if %ERRORLEVEL%==0 (
    echo.
    echo Compilacion exitosa: SiscommateBridge.exe
    echo Para instalar como servicio de Windows ejecuta: instalar_servicio.bat
) else (
    echo ERROR en compilacion. Revisa los mensajes arriba.
)
pause
