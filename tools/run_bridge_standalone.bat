@echo off
setlocal EnableDelayedExpansion
title SRT Lab — J2534 Bridge
color 0A

echo.
echo  ================================================================
echo   SRT Lab J2534 Bridge Launcher
echo   TOPDON R-Link / ArtiDiag VCI
echo  ================================================================
echo.

REM ── Find Python ──────────────────────────────────────────────────────────
set PYTHON=
for %%P in (python.exe python3.exe) do (
    if "!PYTHON!"=="" (
        where %%P >nul 2>&1
        if !errorlevel! == 0 set PYTHON=%%P
    )
)
if "!PYTHON!"=="" (
    echo [ERROR] Python not found.
    echo         Install Python 3 from https://python.org
    echo         Check "Add Python to PATH" during install.
    pause & exit /b 1
)
echo [OK] Python: !PYTHON!

REM ── Find j2534_bridge.py ─────────────────────────────────────────────────
set BRIDGE_PY=

REM First: look next to this .bat file (same folder)
if exist "%~dp0j2534_bridge.py" (
    set BRIDGE_PY=%~dp0j2534_bridge.py
    goto :BRIDGE_FOUND
)

REM Second: look on the Desktop
if exist "%USERPROFILE%\Desktop\j2534_bridge.py" (
    set BRIDGE_PY=%USERPROFILE%\Desktop\j2534_bridge.py
    goto :BRIDGE_FOUND
)

REM Third: look in common SaaS-Master / re-agent locations
for %%D in (
    "%USERPROFILE%\SaaS-Master\tools\python-bridge\bridge\j2534_bridge.py"
    "%USERPROFILE%\re-agent\SaaS-Master\tools\python-bridge\bridge\j2534_bridge.py"
    "C:\srt-lab\j2534_bridge.py"
    "%USERPROFILE%\srt-lab\j2534_bridge.py"
) do (
    if "!BRIDGE_PY!"=="" if exist %%D set BRIDGE_PY=%%~D
)
if not "!BRIDGE_PY!"=="" goto :BRIDGE_FOUND

echo [ERROR] j2534_bridge.py not found.
echo.
echo  This launcher requires j2534_bridge.py in the same folder.
echo  Place j2534_bridge.py next to this .bat file and try again.
echo.
echo  You can get j2534_bridge.py from the SRT Lab download page
echo  or from the SaaS-Master repository.
echo.
pause & exit /b 1

:BRIDGE_FOUND
echo [OK] Bridge script: !BRIDGE_PY!

REM ── Find TOPDON R-Link DLL ────────────────────────────────────────────────
set DLL=

if exist "C:\Program Files (x86)\TOPDON\ArtiDiagVci\PassThru432.dll" (
    set DLL=C:\Program Files (x86)\TOPDON\ArtiDiagVci\PassThru432.dll
    echo [OK] TOPDON ArtiDiag VCI found
    goto :DLL_FOUND
)
if exist "C:\Program Files (x86)\TOPDON\RLink\PassThru432.dll" (
    set DLL=C:\Program Files (x86)\TOPDON\RLink\PassThru432.dll
    echo [OK] TOPDON R-Link found
    goto :DLL_FOUND
)
if exist "C:\Program Files\TOPDON\ArtiDiagVci\PassThru432.dll" (
    set DLL=C:\Program Files\TOPDON\ArtiDiagVci\PassThru432.dll
    echo [OK] TOPDON ArtiDiag VCI found ^(64-bit^)
    goto :DLL_FOUND
)
if exist "C:\Program Files (x86)\DCC Tools\wiTECH\jserver\app\legacyVCI\lvci32.dll" (
    set DLL=C:\Program Files (x86)\DCC Tools\wiTECH\jserver\app\legacyVCI\lvci32.dll
    echo [OK] Chrysler wiTECH Legacy VCI found
    goto :DLL_FOUND
)

echo.
echo [ERROR] TOPDON R-Link DLL not found.
echo.
echo  Expected: C:\Program Files (x86)\TOPDON\ArtiDiagVci\PassThru432.dll
echo.
echo  Registered J2534 adapters on this machine:
reg query "HKLM\SOFTWARE\WOW6432Node\PassThruSupport.04.04" /s /v "FunctionLibrary" 2>nul
echo.
echo  Edit this .bat file and add your DLL path if you see it above.
pause & exit /b 1

:DLL_FOUND
echo.
echo  DLL:  !DLL!
echo  Port: 8765
echo.
echo  Starting bridge... keep this window open while using SRT Lab.
echo  Set bridge URL in SRT Lab to: http://localhost:8765
echo  ================================================================
echo.

!PYTHON! "!BRIDGE_PY!" --dll "!DLL!" --port 8765

echo.
echo  Bridge stopped. Press any key to close.
pause >nul
