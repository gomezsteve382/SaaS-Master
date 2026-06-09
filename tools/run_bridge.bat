@echo off
REM ============================================================
REM  SRT Lab J2534 Bridge Launcher
REM  Auto-detects TOPDON R-Link / ArtiDiag DLL
REM  Falls back to registry scan if not found at default paths
REM  Double-click to start. Keep this window open while using SRT Lab.
REM ============================================================
setlocal EnableDelayedExpansion

set BRIDGE_PORT=8765
set BRIDGE_PY=%~dp0..\SaaS-Master\tools\python-bridge\bridge\j2534_bridge.py
set DLL_PATH=

echo ============================================================
echo  SRT Lab J2534 Bridge Launcher
echo  Port: %BRIDGE_PORT%
echo ============================================================
echo.

REM --- Try TOPDON R-Link 32-bit (most common for Python 32-bit) ---
if exist "C:\Program Files (x86)\TOPDON\RLink\PassThru432.dll" (
    set DLL_PATH=C:\Program Files (x86)\TOPDON\RLink\PassThru432.dll
    echo [FOUND] TOPDON R-Link 32-bit: !DLL_PATH!
    goto :launch
)

REM --- Try TOPDON ArtiDiag 32-bit ---
if exist "C:\Program Files (x86)\TOPDON\ArtiDiagVci\PassThru432.dll" (
    set DLL_PATH=C:\Program Files (x86)\TOPDON\ArtiDiagVci\PassThru432.dll
    echo [FOUND] TOPDON ArtiDiag 32-bit: !DLL_PATH!
    goto :launch
)

REM --- Try TOPDON R-Link 64-bit ---
if exist "C:\Program Files (x86)\TOPDON\RLink\PassThru464.dll" (
    set DLL_PATH=C:\Program Files (x86)\TOPDON\RLink\PassThru464.dll
    echo [FOUND] TOPDON R-Link 64-bit: !DLL_PATH!
    goto :launch
)

REM --- Try TOPDON ArtiDiag 64-bit ---
if exist "C:\Program Files (x86)\TOPDON\ArtiDiagVci\PassThru464.dll" (
    set DLL_PATH=C:\Program Files (x86)\TOPDON\ArtiDiagVci\PassThru464.dll
    echo [FOUND] TOPDON ArtiDiag 64-bit: !DLL_PATH!
    goto :launch
)

REM --- Try TOPDON in Program Files (non-x86) ---
if exist "C:\Program Files\TOPDON\RLink\PassThru464.dll" (
    set DLL_PATH=C:\Program Files\TOPDON\RLink\PassThru464.dll
    echo [FOUND] TOPDON R-Link 64-bit (PF): !DLL_PATH!
    goto :launch
)

REM --- Try Autel MaxiFlash (fallback) ---
if exist "C:\Windows\SysWOW64\CFJW432.DLL" (
    set DLL_PATH=C:\Windows\SysWOW64\CFJW432.DLL
    echo [FOUND] Autel MaxiFlash 32-bit fallback: !DLL_PATH!
    goto :launch
)

REM --- Try registry query for any PassThru DLL ---
echo [INFO] Scanning registry for J2534 devices...
for /f "tokens=2*" %%A in ('reg query "HKLM\SOFTWARE\WOW6432Node\PassThruSupport.04.04" /s /v "FunctionLibrary" 2^>nul') do (
    if "!DLL_PATH!"=="" (
        set DLL_PATH=%%B
        echo [REGISTRY] Found: !DLL_PATH!
    )
)

if "!DLL_PATH!"=="" (
    echo.
    echo [ERROR] No J2534 DLL found.
    echo.
    echo  Make sure TOPDON R-Link software is installed.
    echo  Download from: https://www.topdon.com/pages/download
    echo.
    echo  Or manually set DLL_PATH at the top of this script.
    echo.
    pause
    exit /b 1
)

:launch
echo.
echo [DLL]  !DLL_PATH!
echo [PORT] %BRIDGE_PORT%
echo.
echo  Starting bridge... keep this window open.
echo  In SRT Lab, set bridge URL to: http://localhost:%BRIDGE_PORT%
echo.
echo ============================================================

REM Try python3 first, then python
where python3 >nul 2>&1
if %ERRORLEVEL%==0 (
    python3 "%BRIDGE_PY%" --dll "!DLL_PATH!" --port %BRIDGE_PORT% --verbose
) else (
    python "%BRIDGE_PY%" --dll "!DLL_PATH!" --port %BRIDGE_PORT% --verbose
)

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Bridge exited with error code %ERRORLEVEL%
    echo  Make sure Python 3 is installed and in your PATH.
    echo  Download from: https://www.python.org/downloads/
    pause
)
