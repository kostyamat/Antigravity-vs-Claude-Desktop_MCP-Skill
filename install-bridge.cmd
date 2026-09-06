@echo off
setlocal
set "SRC_DIR=%~dp0"
if "%SRC_DIR:~-1%"=="\" set "SRC_DIR=%SRC_DIR:~0,-1%"

if /i not "%SRC_DIR%"=="C:\scripts" (
    echo [0/8] Deploying Agent-Bridge files to C:\scripts...
    if not exist "C:\scripts" mkdir "C:\scripts"
    xcopy /E /Y /I "%SRC_DIR%\*" "C:\scripts\" >nul
    cd /d "C:\scripts"
)

powershell -NoProfile -ExecutionPolicy Bypass -File "C:\scripts\install-bridge.ps1"
if errorlevel 1 (
    echo.
    echo Setup was interrupted or encountered an error.
    pause
    exit /b 1
)
pause
