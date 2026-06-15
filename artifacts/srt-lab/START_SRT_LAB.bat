@echo off
REM ============================================================
REM   SRT Lab - FCA J2534 Bridge launcher (Topdon RLink)
REM   Ported from sincro's "runs perfectly" Topdon recipe:
REM     1) free the Topdon VCI so PassThruOpen can claim the adapter
REM     2) OneDrive-safe Python launch (no stale .pyc bytecode)
REM     3) start the J2534 bridge (auto-discovers the Topdon DLL)
REM     4) serve the prebuilt UI and open the browser (no Node.js needed)
REM   Double-click this file to run.
REM ============================================================
setlocal EnableExtensions
cd /d "%~dp0"

REM --- locate Python (stdlib only; the bridge needs no venv / pip) ---------
set "PY="
where py     >nul 2>nul && set "PY=py"
if not defined PY ( where python >nul 2>nul && set "PY=python" )
if not defined PY (
    echo [ERROR] Python 3.8+ was not found on PATH.
    echo         Install it from https://www.python.org/downloads/ then re-run.
    pause
    exit /b 1
)

REM --- 1. free the Topdon VCI (best-effort, no admin prompt) ---------------
REM     TOPDON's RLink / VCI software holds the adapter and makes PassThruOpen
REM     fail with ERR_DEVICE_IN_USE. Close the user-level holders now. For the
REM     SERVICES (VCIservice / VCI Observer Services), run _disable_topdon_autostart.ps1
REM     ONCE as Administrator -- after that this launcher just works.
echo Freeing the Topdon VCI...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process 'Rlink Platform','VciObserver','DiagsCap' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue" 2>nul

REM --- 2. OneDrive stale-bytecode guard (exactly like sincro) --------------
REM     OneDrive reverts source mtimes on sync, which can make Python load OLD
REM     .pyc bytecode and silently run stale code. Clear caches + forbid writing.
set "PYTHONDONTWRITEBYTECODE=1"
for %%d in (. public tools) do if exist "%%d\__pycache__" rd /s /q "%%d\__pycache__" 2>nul

REM --- 3. start the J2534 bridge (own window, live verbose log) ------------
set "BRIDGE=%~dp0public\j2534_bridge.py"
if not exist "%BRIDGE%" (
    echo [ERROR] Bridge script not found: %BRIDGE%
    pause
    exit /b 1
)
REM --no-open: serve the HTTP API immediately and open the adapter only when the
REM UI hits Connect. Without it, a slow/blocked PassThruOpen at startup can hang
REM the daemon before it ever binds the port.
echo Starting J2534 bridge (Topdon raw-CAN ISO-TP, auto-discovering the DLL)...
start "SRT Lab - J2534 Bridge" cmd /k %PY% -u "%BRIDGE%" --no-open --verbose

REM --- 4. serve the prebuilt UI + open the browser (no Node needed) --------
set "WEBROOT=%~dp0dist\public"
set "WEBPORT=8088"
if exist "%WEBROOT%\index.html" (
    start "SRT Lab - Web Server" cmd /k %PY% "%~dp0public\nocache_server.py" %WEBPORT% "%WEBROOT%"
    timeout /t 2 /nobreak >nul
    start "" "http://localhost:%WEBPORT%/diag.html"
) else (
    echo [WARN] Built UI not found at "%WEBROOT%".
    echo        The bridge is running; open your hosted SRT Lab page instead.
)

echo.
echo Bridge + web server are running in their own windows.
echo TIP: run _disable_topdon_autostart.ps1 ONCE (as Administrator) so TOPDON
echo      stops grabbing the VCI on every boot. You can close THIS window now.
echo.
pause
endlocal
