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

// Outside Windows there is no tasklist, no PowerShell and no shell:AppsFolder. A
// board on Linux (the build machine) asks the process table instead and starts an
// application only when its command is on PATH. Run under WSL, the Windows
// commands are reachable too, and the first Linux board reached through them and
// "started" the Claude Desktop of the Windows host.
const WINDOWS = process.platform === 'win32';
function onPath(cmd) {
  try { return spawnSync('which', [cmd], { encoding: 'utf8', timeout: 5000 }).status === 0; } catch (_) { return false; }
}
function processRunning(pattern) {
  try { return spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8', timeout: 5000 }).status === 0; } catch (_) { return false; }
}
const LINUX_APPS = { antigravity: 'antigravity', claude: 'claude-desktop' };

function antigravityRunning() {
  if (!WINDOWS) return processRunning('(^|/)' + LINUX_APPS.antigravity + '( |$)');
  try {
    const r = spawnSync('powershell', PS_ARGS, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return hasMainProcess(r.stdout);
  } catch (_) { return false; }
}

function antigravityRunningAsync() {
  if (!WINDOWS) return Promise.resolve(antigravityRunning());
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
  if (!WINDOWS) return processRunning('(^|/)' + LINUX_APPS.claude + '( |$)');
  try {
    const r = spawnSync('tasklist', TASKLIST_ARGS, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return claudeDesktopFromTasklist(r.stdout);
  } catch (_) { return false; }
}

function claudeDesktopRunningAsync() {
  if (!WINDOWS) return Promise.resolve(claudeDesktopRunning());
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
  if (!WINDOWS) {
    for (const name of ['antigravity', 'claude']) {
      if (app !== name && app !== 'all') continue;
      const running = name === 'claude' ? claudeDesktopRunning() : antigravityRunning();
      if (running || !onPath(LINUX_APPS[name])) continue;
      spawn(LINUX_APPS[name], [], { detached: true, stdio: 'ignore' }).unref();
      started.push(name);
    }
    if (started.length && log) log('started ' + started.join(', '));
    if (started.length) cached.at = 0;
    return started;
  }
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
const cached = { antigravity: false, claude: false, at: 0 };
// One look at a time; whoever asks while it runs waits for the same answer.
let pending = null;
function refresh() {
  if (pending) return pending;
  pending = Promise.all([antigravityRunningAsync(), claudeDesktopRunningAsync()]).then(([a, c]) => {
    if (a !== null) cached.antigravity = a;
    if (c !== null) cached.claude = c;
    cached.at = Date.now();
  }).finally(() => { pending = null; });
  return pending;
}
function snapshot() { return { antigravity: cached.antigravity, claude: cached.claude, checkedAt: cached.at }; }
// Without waiting: the last known state (and a look in the background when it is old).
function current() {
  if (Date.now() - cached.at > 4000) refresh();
  return snapshot();
}
// Waiting for a look no older than two seconds. Handing out the last known state
// instead showed a closed Antigravity as open for up to twenty seconds (owner, 11.11).
async function fresh() {
  if (Date.now() - cached.at > 2000) await refresh();
  return snapshot();
}

module.exports = {
  hasMainProcess, claudeDesktopFromTasklist,
  antigravityRunning, claudeDesktopRunning, launch, refresh, current, fresh, ANTIGRAVITY_EXE
};
