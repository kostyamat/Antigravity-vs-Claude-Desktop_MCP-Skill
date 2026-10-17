# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less script in the
# ANSI code page, and UTF-8 bytes of emoji or box characters decode into quote
# marks there, which breaks parsing.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# $PSScriptRoot exists only from PowerShell 3.0.
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$Host.UI.RawUI.WindowTitle = "Agent-Bridge v2: Setup & Dependencies"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " Agent-Bridge v2: Dependency Verification & Setup             " -ForegroundColor Cyan
Write-Host "================================================================`n" -ForegroundColor Cyan

function Refresh-Path {
    $machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:PATH = "$machinePath;$userPath"
    if (Test-Path "$env:ProgramFiles\nodejs") { $env:PATH = "$env:ProgramFiles\nodejs;$env:PATH" }
    if (Test-Path "${env:ProgramFiles(x86)}\nodejs") { $env:PATH = "${env:ProgramFiles(x86)}\nodejs;$env:PATH" }
}

# --- 1. Check Node.js (v22.5+) -----------------------------------------------
Write-Host "[1/4] Checking Node.js environment..." -ForegroundColor Yellow
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$nodeOk = $false

if ($nodeCmd) {
    try {
        $nodeVerRaw = & node -v 2>$null
        if ($nodeVerRaw -match 'v(\d+)\.(\d+)') {
            $major = [int]$matches[1]
            $minor = [int]$matches[2]
            if ($major -gt 22 -or ($major -eq 22 -and $minor -ge 5)) {
                $nodeOk = $true
                Write-Host "  [OK] Node.js $nodeVerRaw detected (native node:sqlite supported)." -ForegroundColor Green
            } else {
                Write-Host "  [!]  Outdated Node.js version detected: $nodeVerRaw." -ForegroundColor DarkYellow
            }
        }
    } catch {}
} else {
    Write-Host "  [!]  Node.js NOT found in system!" -ForegroundColor DarkYellow
}

if (-not $nodeOk) {
    Write-Host "      Node.js v22.5+ is required for the autonomous SQLite database." -ForegroundColor DarkYellow
    $ans = Read-Host ">> Would you like to automatically download and install Node.js (LTS)? [Y/n]"
    if ($ans -eq '' -or $ans -match '^[Yy]') {
        $hasWinget = (Get-Command winget -ErrorAction SilentlyContinue) -ne $null
        if ($hasWinget) {
            Write-Host "  [v] Installing Node.js via Windows Package Manager (winget)..." -ForegroundColor Cyan
            & winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
        } else {
            Write-Host "  [v] Downloading official Node.js MSI installer from nodejs.org..." -ForegroundColor Cyan
            $msiUrl = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi"
            $msiPath = "$env:TEMP\node_setup.msi"
            # TLS 1.2 by number: the enum name is missing before .NET 4.5.
            try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]3072 } catch {}
            (New-Object System.Net.WebClient).DownloadFile($msiUrl, $msiPath)
            Write-Host "  [*] Installing Node.js..." -ForegroundColor Cyan
            Start-Process msiexec.exe -ArgumentList '/i', "`"$msiPath`"", '/passive' -Wait
        }
        Refresh-Path
    } else {
        Write-Warning "Skipped. Please install Node.js v22+ manually from https://nodejs.org/"
    }
}

# --- 2. Check Python 3.x -----------------------------------------------------
Write-Host "`n[2/4] Checking Python 3 environment..." -ForegroundColor Yellow
$pyOk = $false
try {
    $proc = Start-Process python -ArgumentList '-c', '"import sys; sys.exit(0 if sys.version_info[0]>=3 else 1)"' -PassThru -NoNewWindow -Wait -ErrorAction SilentlyContinue
    if ($proc.ExitCode -eq 0) {
        $pyOk = $true
        $pyVer = (& python --version 2>&1).Trim()
        Write-Host "  [OK] $pyVer detected (watchmen watch_board.py and watch_gemini.py ready)." -ForegroundColor Green
    }
} catch {}

if (-not $pyOk) {
    Write-Host "  [!]  Python 3 NOT found in system!" -ForegroundColor DarkYellow
    Write-Host "      Required for background watchmen watch_board.py (Claude) and watch_gemini.py (Antigravity)." -ForegroundColor DarkYellow
    $ans = Read-Host ">> Would you like to automatically download and install Python 3? [Y/n]"
    if ($ans -eq '' -or $ans -match '^[Yy]') {
        $hasWinget = (Get-Command winget -ErrorAction SilentlyContinue) -ne $null
        if ($hasWinget) {
            Write-Host "  [v] Installing Python 3 via Windows Package Manager (winget)..." -ForegroundColor Cyan
            & winget install --id Python.Python.3.12 -e --accept-package-agreements --accept-source-agreements
        } else {
            Write-Host "  [v] Downloading official Python 3 installer..." -ForegroundColor Cyan
            $pyUrl = "https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe"
            $pyPath = "$env:TEMP\python_setup.exe"
            # TLS 1.2 by number: the enum name is missing before .NET 4.5.
            try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]3072 } catch {}
            (New-Object System.Net.WebClient).DownloadFile($pyUrl, $pyPath)
            Write-Host "  [*] Installing Python 3..." -ForegroundColor Cyan
            Start-Process $pyPath -ArgumentList '/passive', 'InstallAllUsers=1', 'PrependPath=1' -Wait
        }
        Refresh-Path
    } else {
        Write-Warning "Skipped. Please install Python 3 manually from https://python.org/"
    }
}

# --- 3. Inspect AI Environments ----------------------------------------------
Write-Host "`n[3/4] Inspecting AI client environments..." -ForegroundColor Yellow

# Claude Desktop
$claudeAppDir = "$env:APPDATA\Claude"
if (Test-Path $claudeAppDir) {
    Write-Host "  [OK] Claude Desktop config directory found ($claudeAppDir)." -ForegroundColor Green
} else {
    Write-Host "  [i]  Claude Desktop has not been launched on this system yet." -ForegroundColor Gray
    Write-Host "      (Configuration will be created automatically; client download: https://claude.ai/download)" -ForegroundColor Gray
}

# Antigravity IDE
$antiDir = "$env:LOCALAPPDATA\Programs\antigravity"
if (Test-Path $antiDir) {
    Write-Host "  [OK] Antigravity IDE detected ($antiDir)." -ForegroundColor Green
} else {
    Write-Host "  [i]  Antigravity IDE: MCP configuration will be written to ~/.gemini/config/mcp_config.json" -ForegroundColor Gray
}

# Claude Code CLI
$claudeCodeCmd = Get-Command claude -ErrorAction SilentlyContinue
if ($claudeCodeCmd) {
    Write-Host "  [OK] Claude Code CLI available in system." -ForegroundColor Green
} else {
    Write-Host "  [i] Claude Code CLI can be installed later: npm install -g @anthropic-ai/claude-code" -ForegroundColor Gray
}

# --- 4. Launch Core JS Installer ---------------------------------------------
Write-Host "`n[4/4] Launching Agent-Bridge core configurator..." -ForegroundColor Yellow

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "[X] ERROR: Node.js not found in current session PATH!" -ForegroundColor Red
    Write-Host "   Please close this window, install Node.js v22+, and run install-bridge.cmd again." -ForegroundColor Red
    exit 1
}

& node "$ScriptDir\install-bridge.js"
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n[X] Configurator exited with code $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}
