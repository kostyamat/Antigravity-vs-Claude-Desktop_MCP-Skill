@echo off
setlocal
set "SRC_DIR=%~dp0"
if "%SRC_DIR:~-1%"=="\" set "SRC_DIR=%SRC_DIR:~0,-1%"

rem Agent Bridge installs in place. The folder holding this file becomes the
rem bridge home: the board database, the message bodies and the docs are all
rem created next to it. Nothing is copied anywhere else, so put the package
rem where you want it to live before running this.

if not exist "%SRC_DIR%\agent-bridge-mcp.js" (
    echo.
    echo   agent-bridge-mcp.js was not found next to this script.
    echo.
    echo   You are probably running the copy that ships inside the Skill
    echo   folder, which carries the documentation but not the MCP server.
    echo   Run install-bridge.cmd from the root of the full package instead:
    echo   https://github.com/kostyamat/Antigravity-vs-Claude-Desktop_MCP-Skill
    echo.
    pause
    exit /b 1
)

echo Installing Agent Bridge in place: %SRC_DIR%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%SRC_DIR%\install-bridge.ps1"
if errorlevel 1 (
    echo.
    echo Setup was interrupted or encountered an error.
    pause
    exit /b 1
)
pause
