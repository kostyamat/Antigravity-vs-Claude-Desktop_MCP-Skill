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

// A window in the middle of a turn has no watchman — it is started when the turn ends — and reads
// what came meanwhile at that end (bridge-hook.js stop). It was reported "not listening, ring it",
// and its lead rang it by hand after nearly every post (24.11.2026, ROM Builder). So a turn leaves a
// mark, run/busy_<window>.json, set when it begins (a prompt, or a wake-up) and taken away when the
// watchman starts; a mark older than BUSY_MAX_MS is a client that died mid-turn and counts for nothing.
const BUSY_MAX_MS = 3 * 3600e3;
const safeOf = w => String(w).replace(/[^A-Za-z0-9_-]/g, '_');
function markBusy(win, runDir) {
  try { fs.mkdirSync(runDir || RUN_DIR, { recursive: true }); fs.writeFileSync(path.join(runDir || RUN_DIR, `busy_${safeOf(win)}.json`), JSON.stringify({ at: Date.now() })); } catch (_) {}
}
function clearBusy(win, runDir) {
  try { fs.unlinkSync(path.join(runDir || RUN_DIR, `busy_${safeOf(win)}.json`)); } catch (_) {}
}
function inTurn(win, runDir) {
  try { return Date.now() - Number(JSON.parse(fs.readFileSync(path.join(runDir || RUN_DIR, `busy_${safeOf(win)}.json`), 'utf8')).at) < BUSY_MAX_MS; }
  catch (_) { return false; }
}

// true / false for a Claude window id (local_…); null for anything the board cannot tell about.
function listening(win, runDir) {
  const w = String(win || '').trim();
  if (!/^local_/.test(w)) return null;
  const dir = runDir || RUN_DIR;
  const safe = safeOf(w);
  for (const name of [`rewake_${safe}.json`, `monitor_${safe}.json`]) {
    try { if (alive(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).pid)) return true; } catch (_) {}
  }
  return inTurn(w, dir);
}

module.exports = { listening, alive, markBusy, clearBusy, inTurn };
