@echo off
cd /d "%~dp0"
start "" /b node board-ui.js --no-open
