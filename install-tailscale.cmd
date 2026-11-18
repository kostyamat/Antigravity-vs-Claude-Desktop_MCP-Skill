@echo off
setlocal
rem Puts this machine into your Tailscale network, so that a board far away can link to it.
rem   install-tailscale.cmd               install Tailscale if missing, then sign in (your browser)
rem   install-tailscale.cmd tskey-...     join with a one-time key you made in Tailscale's admin page
rem                                       (how a friend's machine joins without your account)
set "SRC_DIR=%~dp0"
if "%SRC_DIR:~-1%"=="\" set "SRC_DIR=%SRC_DIR:~0,-1%"
where node >nul 2>nul || (echo Node.js is needed: https://nodejs.org/ & pause & exit /b 1)
node "%SRC_DIR%\tailscale-setup.js" %*
pause
