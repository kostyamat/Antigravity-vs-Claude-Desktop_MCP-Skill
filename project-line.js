'use strict';
// A project is the folder a window is opened in, and that is who a participant is.
//
// Windows come and go. Switching accounts gives the same job a different window
// with a different id; a restart gives the window a new run id; the client names
// a window after its first sentence and the owner renames it. Rooms, helpers and
// addresses built on any of those broke each time one of them changed. The
// folder does not change: both accounts open the same project in the same place.
//
// So every Claude window opened in one folder is one participant. The mechanism
// already existed — a line of work makes its members one address, in the server,
// in the watchman and in the session brief — but lines were linked by hand, and
// were forgotten. Here a window joins the line of its folder by itself. A window
// somebody linked by hand keeps the line it was given.
//
// The line is named by the folder (lower case, forward slashes) and shown by the
// folder's own name.

const os = require('os');
const path = require('path');

function projectKey(folder) {
  let f = String(folder || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!f) return '';
  // A drive root or the home folder is where a window lands when no project was
  // chosen. Treating it as a project would make one participant out of every
  // unrelated window opened there.
  if (/^[A-Za-z]:$/.test(f) || f === '') return '';
  const home = String(process.env.USERPROFILE || os.homedir() || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (home && f.toLowerCase() === home.toLowerCase()) return '';
  return f.toLowerCase();
}

function projectName(key) {
  const k = String(key || '');
  return /[\\/]/.test(k) ? path.posix.basename(k.replace(/\\/g, '/')) : '';
}

function isProjectKey(s) {
  return /^([a-z]:)?\/.+/.test(String(s || '')) || /^[a-z]:\/.+/.test(String(s || ''));
}

// The line this window answers to: the one it is already on, else the line of
// its folder, joined now. '' when it has neither.
function ensureLine(bridgeDb, windowId, folder, agent) {
  const w = String(windowId || '').trim();
  if (!w) return '';
  try {
    const have = bridgeDb.lineOf(w);
    if (have) return have;
    const key = projectKey(folder);
    if (!key) return '';
    bridgeDb.linkSessions(key, [w], agent || 'Claude');
    return key;
  } catch (_) { return ''; }
}

// Every Claude window of every account joins the line of its folder. Run by the
// installer, so the board is right before any window has restarted.
function adoptAll(bridgeDb, cardsLib) {
  const done = [];
  for (const c of cardsLib.claudeCardsEverywhere()) {
    if (c.archived || bridgeDb.lineOf(c.id)) continue;
    const line = ensureLine(bridgeDb, c.id, c.project, 'Claude');
    if (line) done.push({ window: c.id, name: c.name, line });
  }
  return done;
}

// A room member recorded under a run id becomes the window that run belongs to.
function adoptRunIds(bridgeDb, cardsLib) {
  const done = [];
  const rows = bridgeDb.getDb().prepare('SELECT DISTINCT card FROM room_members').all();
  for (const r of rows) {
    if (/^local_/.test(r.card)) continue;
    const w = cardsLib.claudeWindowOfCli(r.card);
    if (!w || w.id === r.card) continue;
    bridgeDb.registerSessionAlias(r.card, w.id);
    bridgeDb.adoptCard(r.card, w.id, 'Claude');
    done.push({ from: r.card, to: w.id, name: w.name });
  }
  return done;
}

module.exports = { projectKey, projectName, isProjectKey, ensureLine, adoptAll, adoptRunIds };

// node project-line.js --adopt  → repair the board once, print what was changed
if (require.main === module && process.argv.includes('--adopt')) {
  try {
    const bridgeDb = require('./bridge-db');
    const cardsLib = require('./cards');
    const runs = adoptRunIds(bridgeDb, cardsLib);
    const lines = adoptAll(bridgeDb, cardsLib);
    for (const r of runs) console.log(`room member ${r.from.slice(0, 8)}… is the window "${r.name}"`);
    const by = new Map();
    for (const l of lines) by.set(l.line, (by.get(l.line) || 0) + 1);
    for (const [line, n] of by) console.log(`project ${projectName(line) || line}: ${n} window(s)`);
    if (!runs.length && !lines.length) console.log('nothing to adopt');
  } catch (e) {
    console.error('adopt failed: ' + e.message);
    process.exitCode = 1;
  }
}
