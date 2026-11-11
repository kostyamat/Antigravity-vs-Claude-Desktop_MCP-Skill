'use strict';
// Where Claude Desktop keeps its data — the one place that knows.
//
// The app has moved this folder more than once: first the roaming profile, then
// the package's private copy of it, then a folder of its own under the local
// profile. Every reader here had the first path written into it, so on the day
// of the last move the board showed no Claude windows at all, the session hook
// stopped recognising the window it ran in, and every window began signing with
// a per-run id nobody could address. The owner saw "the board is broken"; the
// cause was one moved folder.
//
// So nothing else in the bridge names that path. A data root is any candidate
// folder that actually holds window records or the app's config; when several
// exist (an old one left behind beside the live one) all are read and the
// freshest wins. board_brief.py carries the same list in Python, because a hook
// that runs on every prompt cannot afford to start node to learn a path.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.USERPROFILE || os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(dir, e.name));
  } catch (_) { return []; }
}
function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch (_) { return 0; }
}
function exists(p) {
  try { fs.accessSync(p); return true; } catch (_) { return false; }
}

function candidates() {
  const out = [];
  const forced = process.env.AGENT_BRIDGE_CLAUDE_DATA;
  if (forced) out.push(...forced.split(path.delimiter).filter(Boolean));
  out.push(...subdirs(path.join(LOCALAPPDATA, 'Claude-Data')));
  out.push(path.join(APPDATA, 'Claude'));
  for (const pkg of subdirs(path.join(LOCALAPPDATA, 'Packages'))) {
    if (/^claude_/i.test(path.basename(pkg))) out.push(path.join(pkg, 'LocalCache', 'Roaming', 'Claude'));
  }
  if (process.platform === 'darwin') out.push(path.join(HOME, 'Library', 'Application Support', 'Claude'));
  if (process.platform === 'linux') out.push(path.join(HOME, '.config', 'Claude'));
  return [...new Set(out.map(p => path.resolve(p)))];
}

// Every folder that is a Claude Desktop data root right now, the live one first.
let cache = { at: 0, roots: [] };
function dataRoots() {
  if (Date.now() - cache.at < 30000) return cache.roots;
  const roots = candidates()
    .filter(r => exists(path.join(r, 'claude-code-sessions')) || exists(path.join(r, 'config.json')))
    .sort((a, b) => mtime(path.join(b, 'config.json')) - mtime(path.join(a, 'config.json')));
  cache = { at: Date.now(), roots };
  return roots;
}

// The folders of window records: <root>/claude-code-sessions/<account>/<workspace>/local_*.json
function sessionRoots() {
  return dataRoots().map(r => path.join(r, 'claude-code-sessions')).filter(exists);
}

// The app's own config (which account is signed in), freshest first.
function configFiles() {
  return dataRoots().map(r => path.join(r, 'config.json')).filter(exists);
}

// Every claude_desktop_config.json the app may read its MCP servers from. The
// classic roaming path is always listed: an install that has not moved yet, or a
// fresh one, reads it, and writing a server there harms nobody.
function desktopConfigFiles() {
  const live = dataRoots().map(r => path.join(r, 'claude_desktop_config.json'));
  // Where a fresh install reads it from: the roaming profile on Windows, the
  // user's config folder on Linux (Claude Desktop for Linux, beta) and macOS.
  const classic = process.platform === 'linux'
    ? path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'Claude', 'claude_desktop_config.json')
    : process.platform === 'darwin'
      ? path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(APPDATA, 'Claude', 'claude_desktop_config.json');
  return [...new Set(live.concat(classic).map(p => path.resolve(p)))];
}

// Where the app caches the skills uploaded to one account. They are that
// account's own copies and are refreshed from the server, never from disk — which
// is how two accounts end up following two versions of one skill.
function accountSkillDirs(account) {
  const out = [];
  for (const r of dataRoots()) {
    for (const org of subdirs(path.join(r, 'local-agent-mode-sessions', 'skills-plugin'))) {
      for (const acct of subdirs(org)) {
        if (account && path.basename(acct) !== account) continue;
        const dir = path.join(acct, 'skills');
        if (exists(dir)) out.push({ account: path.basename(acct), dir });
      }
    }
  }
  return out;
}

// What to tell the human when there is nothing to list, or ''.
function problem() {
  if (sessionRoots().length) return '';
  return 'Claude Desktop keeps its window records in a folder this board cannot find. Looked in: ' +
    candidates().join('; ') + '. Set AGENT_BRIDGE_CLAUDE_DATA to the folder that holds claude-code-sessions.';
}

module.exports = { dataRoots, sessionRoots, configFiles, desktopConfigFiles, accountSkillDirs, problem, candidates };

// node claude-home.js → the roots, one per line (for a human checking an install)
if (require.main === module) {
  const roots = dataRoots();
  process.stdout.write(roots.length ? roots.join('\n') + '\n' : problem() + '\n');
}
