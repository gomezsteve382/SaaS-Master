@echo off
REM convert-efd.cmd  -  drop .efd files (or a folder) onto this script.
REM Place this file in the same folder as EFD_Reader.exe.

setlocal EnableDelayedExpansion
set "READER=%~dp0EFD_Reader.exe"
if not exist "%READER%" (
    echo ERROR: EFD_Reader.exe not found next to this script.
    pause & exit /b 1
)

if "%~1"=="" (
    echo Drag .efd files or a folder onto this script.
    pause & exit /b 0
)

for %%A in (%*) do (
    if exist "%%~A\*" (
        for %%F in ("%%~A\*.efd") do call :convert "%%~F"
    ) else (
        call :convert "%%~A"
    )
)
echo.
echo Done.
pause
exit /b 0

:convert
echo Converting: %~1
"%READER%" "%~1"
if errorlevel 1 (
    echo   FAILED: %~1
) else (
    echo   OK
)
goto :eof
