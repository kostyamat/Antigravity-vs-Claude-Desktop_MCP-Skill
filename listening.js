'use strict';
// Is a Claude window listening to the board right now?
//
// A Claude window is woken by its own watchman (bridge-hook.js watch, or a Monitor it started), a
// background process its hooks start at session start, at the end of a turn and on a failed turn.
// A window that has had no turn since its client restarted has none, and nothing the board does
// reaches it until the owner opens it (18.11: an invitation sat unread in a window on artempc). The
// watchman keeps a lock with its pid in run/; a live pid is a window that hears the board.
//
// What follows from "not listening": the agent that wrote to it rings it with Claude Code's own
// SendMessage (post_message says so), and the board page marks it, so the owner opens it.

const fs = require('fs');
const path = require('path');

const RUN_DIR = process.env.BRIDGE_RUN_DIR || path.join(__dirname, 'run');

function alive(pid) {
  const n = Number(pid);
  if (!n) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// true / false for a Claude window id (local_…); null for anything the board cannot tell about.
function listening(win, runDir) {
  const w = String(win || '').trim();
  if (!/^local_/.test(w)) return null;
  const dir = runDir || RUN_DIR;
  const safe = w.replace(/[^A-Za-z0-9_-]/g, '_');
  for (const name of [`rewake_${safe}.json`, `monitor_${safe}.json`]) {
    try { if (alive(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).pid)) return true; } catch (_) {}
  }
  return false;
}

module.exports = { listening, alive };
