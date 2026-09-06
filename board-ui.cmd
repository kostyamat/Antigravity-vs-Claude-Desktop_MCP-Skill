@echo off
rem ═══════════════════════════════════════════════════════════════════════════════
rem  Agent-Bridge Board Viewer — One-click launcher.
rem  Starts local server at 127.0.0.1:8787 and opens default browser.
rem  To stop — press Ctrl+C in this window or close the window.
rem ═══════════════════════════════════════════════════════════════════════════════
title Agent-Bridge Board
cd /d "%~dp0"
node board-ui.js
pause

