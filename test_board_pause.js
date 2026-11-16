'use strict';
// node test_board_pause.js — the owner's Stop work: stored, read by the hooks' check and by the
// Python watchmen, and lifted by the second press. Runs on a copy of bridge-db.js in a temporary
// folder, so the live board is not touched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-pause-'));
fs.copyFileSync(path.join(__dirname, 'bridge-db.js'), path.join(dir, 'bridge-db.js'));
const db = require(path.join(dir, 'bridge-db.js'));
const py = name => execFileSync('python', ['-c',
  'import sys; sys.path.insert(0, sys.argv[1]); import ' + name + ' as m; print(m.board_paused(sys.argv[2]))',
  __dirname, path.join(dir, 'agent_bridge.db')], { encoding: 'utf8' }).trim();

assert.strictEqual(db.boardPaused(), null, 'not stopped at first');
assert.strictEqual(py('watch_board'), 'False');
const p = db.setBoardPaused(true, 'owner');
assert.ok(p && p.since && p.by === 'owner', 'stopped, with when and by whom');
for (const m of ['watch_board', 'watch_gemini', 'board_brief']) assert.strictEqual(py(m), 'True', m + ' sees the stop');
db.setBoardPaused(true, 'owner');
assert.strictEqual(db.getDb().prepare('SELECT COUNT(*) n FROM board_pause').get().n, 1, 'one switch, not a pile');
assert.strictEqual(db.setBoardPaused(false), null, 'the second press lifts it');
assert.strictEqual(py('watch_gemini'), 'False');

try { db.getDb().close(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
console.log('board pause: all checks passed');
