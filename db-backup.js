'use strict';
// Snapshots of the board database, so that losing it is never losing the board.
//
// Everything said on the board, every room, every pair of lead and helper and
// every line of work lives in one file, agent_bridge.db, next to the code — in a
// folder where agents run git and delete things. A consistent copy is written
// when the board starts and every few hours while it runs, into a folder outside
// the bridge's own, and the newest ones are kept: a few days of hourly-grade
// history and one copy per day for a month before that. Restoring is copying one
// of them back while the board is stopped.
//
// VACUUM INTO writes a complete, defragmented database in one transaction; it
// does not block readers and needs no other process to stop.

const fs = require('fs');
const os = require('os');
const path = require('path');

const EVERY_MS = 4 * 3600e3;
const KEEP_RECENT = 12;      // the last two days at this pace
const KEEP_DAILY = 30;

function backupDir(home) {
  const forced = process.env.AGENT_BRIDGE_BACKUP_DIR;
  if (forced) return forced;
  const local = process.env.LOCALAPPDATA;
  const base = local ? path.join(local, 'AgentBridge') : path.join(os.homedir(), '.agent-bridge');
  // One folder per board, named after where the board lives.
  const tag = path.resolve(home).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(-60);
  return path.join(base, 'backups', tag);
}

function snapshot(bridgeDb, home) {
  const dir = backupDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `agent_bridge_${stamp}.db`);
  bridgeDb.getDb().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  prune(dir);
  return file;
}

// Keep the newest KEEP_RECENT, then the last copy of each day for KEEP_DAILY days.
function prune(dir) {
  const files = fs.readdirSync(dir).filter(f => /^agent_bridge_.*\.db$/.test(f)).sort().reverse();
  const keep = new Set(files.slice(0, KEEP_RECENT));
  const days = new Set();
  for (const f of files) {
    const day = f.slice('agent_bridge_'.length, 'agent_bridge_'.length + 10);
    if (days.has(day)) continue;
    days.add(day);
    if (days.size <= KEEP_DAILY) keep.add(f);
  }
  for (const f of files) {
    if (!keep.has(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} }
  }
}

function newest(home) {
  try {
    const dir = backupDir(home);
    const files = fs.readdirSync(dir).filter(f => /^agent_bridge_.*\.db$/.test(f)).sort();
    return files.length ? path.join(dir, files[files.length - 1]) : '';
  } catch (_) { return ''; }
}

function start(bridgeDb, home) {
  const run = () => {
    try { snapshot(bridgeDb, home); } catch (e) { console.error('db backup failed: ' + e.message); }
  };
  setTimeout(run, 15000).unref();
  setInterval(run, EVERY_MS).unref();
}

module.exports = { start, snapshot, backupDir, newest };

// node db-backup.js → take one snapshot now and print where it went
if (require.main === module) {
  try {
    console.log(snapshot(require('./bridge-db'), __dirname));
  } catch (e) {
    console.error('db backup failed: ' + e.message);
    process.exitCode = 1;
  }
}
