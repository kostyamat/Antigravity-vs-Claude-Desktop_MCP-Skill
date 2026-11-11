'use strict';
// Is Claude Desktop / Antigravity open, and start it when it is not.
// One place for both the MCP server and the board: they each had their own
// copy, and both copies had the same defect.
//
// The defect: Antigravity counted as open whenever any Antigravity.exe was in
// the process list. Antigravity also runs Antigravity.exe as a plain node
// runtime for its sidecars (device-hub, compose-preview, main.mjs, started
// with --import=…sidecar_sdk…), and those outlive the application. With the
// window closed for hours, the board still said "Antigravity is running", the
// supervisor and the launcher believed it, and nothing was started for a
// message addressed to a Gemini window. The application itself is the one
// Antigravity.exe whose command line has neither --type= (Chromium child
// processes) nor --import= (sidecars).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFile } = require('child_process');

const ANTIGRAVITY_EXE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Programs', 'antigravity', 'Antigravity.exe');
const CLAUDE_APP = 'shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude';

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command',
  "Get-CimInstance Win32_Process -Filter \"Name='Antigravity.exe'\" | ForEach-Object { $_.CommandLine }"];

// The main application among the command lines of every Antigravity.exe.
function hasMainProcess(commandLines) {
  return String(commandLines || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    .some(cmd => !/\s--type=/.test(cmd) && !/\s--import=/.test(cmd));
}

function antigravityRunning() {
  try {
    const r = spawnSync('powershell', PS_ARGS, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return hasMainProcess(r.stdout);
  } catch (_) { return false; }
}

function antigravityRunningAsync() {
  return new Promise(resolve => {
    execFile('powershell', PS_ARGS, { encoding: 'utf8', windowsHide: true, timeout: 15000 },
      (err, stdout) => resolve(err ? null : hasMainProcess(stdout)));
  });
}

// Claude Desktop's main window is titled "Claude"; its helper processes have none.
function claudeDesktopFromTasklist(csv) {
  const out = String(csv || '');
  return out.toLowerCase().includes('claude.exe') && out.includes('"Claude"');
}
const TASKLIST_ARGS = ['/FI', 'IMAGENAME eq claude.exe', '/V', '/FO', 'CSV'];

function claudeDesktopRunning() {
  try {
    const r = spawnSync('tasklist', TASKLIST_ARGS, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return claudeDesktopFromTasklist(r.stdout);
  } catch (_) { return false; }
}

function claudeDesktopRunningAsync() {
  return new Promise(resolve => {
    execFile('tasklist', TASKLIST_ARGS, { encoding: 'utf8', windowsHide: true, timeout: 15000 },
      (err, stdout) => resolve(err ? null : claudeDesktopFromTasklist(stdout)));
  });
}

function startDetached(args) {
  spawn('cmd.exe', ['/c', 'start', '""'].concat(args), { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// Starts what is asked for ('antigravity' | 'claude' | 'all') when it is not
// open, checked afresh. Returns the names of the applications it started.
function launch(app, log) {
  const started = [];
  if ((app === 'antigravity' || app === 'all') && !antigravityRunning() && fs.existsSync(ANTIGRAVITY_EXE)) {
    startDetached([ANTIGRAVITY_EXE]);
    started.push('antigravity');
  }
  if ((app === 'claude' || app === 'all') && !claudeDesktopRunning()) {
    startDetached(['explorer.exe', CLAUDE_APP]);
    started.push('claude');
  }
  if (started.length && log) log('started ' + started.join(', '));
  if (started.length) cached.at = 0;   // the next look is a real one
  return started;
}

// For a page that asks every few seconds: the last known state, refreshed in
// the background so a request never waits on PowerShell.
const cached = { antigravity: false, claude: false, at: 0, busy: false };
async function refresh() {
  if (cached.busy) return;
  cached.busy = true;
  try {
    const [a, c] = await Promise.all([antigravityRunningAsync(), claudeDesktopRunningAsync()]);
    if (a !== null) cached.antigravity = a;
    if (c !== null) cached.claude = c;
    cached.at = Date.now();
  } finally { cached.busy = false; }
}
function current() {
  if (Date.now() - cached.at > 4000) refresh();
  return { antigravity: cached.antigravity, claude: cached.claude, checkedAt: cached.at };
}

module.exports = {
  hasMainProcess, claudeDesktopFromTasklist,
  antigravityRunning, claudeDesktopRunning, launch, refresh, current, ANTIGRAVITY_EXE
};
