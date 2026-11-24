'use strict';
// node test_watch_and_stands.js — two ways work stood still (owner, 24.11.2026):
// a window slept through a message that came while it was at work, because its watchman counted
// from the newest message on the board; and a stand stayed booked after its holder was done with
// it, so the next window waited for nobody. Run in a copy of the code: the board database lives
// beside the code, and the live one is never touched.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-watch-'));
for (const f of fs.readdirSync(__dirname)) if (/\.js$/.test(f) && !/^test_/.test(f)) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
const db = require(path.join(dir, 'bridge-db.js'));
const room = require(path.join(dir, 'room-routing.js')).createRouter(db, require(path.join(dir, 'cards.js')));
const stands = require(path.join(dir, 'stands.js')).createStands(db, room);

const WIN = 'local_' + 'a'.repeat(8) + '-0000-4000-8000-' + '1'.repeat(12);
const OTHER = 'local_' + 'b'.repeat(8) + '-0000-4000-8000-' + '2'.repeat(12);
const post = m => db.addMessage(Object.assign({ ts: new Date().toISOString(), from: 'Claude', fromSession: OTHER, to: 'Claude',
  toSession: WIN, room: '', replyTo: null, priority: 'normal', status: 'answer', progress: '', topic: '', file: null, readBy: [] }, m)).id;

// The watchman as the client starts it at the end of a turn; → { code, err } or code null if it is still listening.
function watch(ms) {
  return new Promise(resolve => {
    const env = Object.assign({}, process.env, { CLAUDE_CODE_HOST_SESSION_ID: WIN });
    delete env.CLAUDE_PID;
    const p = spawn(process.execPath, [path.join(dir, 'bridge-hook.js'), 'watch'], { env });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    const t = setTimeout(() => { p.kill(); resolve({ code: null, err }); }, ms);
    p.on('exit', code => { clearTimeout(t); resolve({ code, err }); });
    p.stdin.end('{}');
  });
}

let n = 0;
const ok = name => { n++; console.log('ok ' + name); };
(async () => {
  try {
    const read = post({ message: 'read before the turn ended' });
    db.getDb().prepare('INSERT OR REPLACE INTO cursors (reader, last_read_id) VALUES (?, ?)').run('Claude/' + WIN, read);
    const during = post({ message: 'came while the window was at work' });

    assert.ok(stands.take({ stand: '198', holder: WIN, agent: 'Claude', room: '' }).ok);
    const refused = stands.take({ stand: '198', holder: OTHER, agent: 'Claude', room: '' });
    assert.ok(!refused.ok && /waiting list/.test(refused.text), 'refused, and told it waits');
    ok('a window refused a stand is put on its waiting list');

    const first = await watch(9000);
    assert.strictEqual(first.code, 2, 'woken: ' + first.err);
    assert.match(first.err, new RegExp('#' + during + '\\b'), 'for the message that came during the turn');
    ok('a message that came while the window worked wakes it when its turn ends');

    assert.ok(!db.readStands().some(r => r.stand === '198'), 'the stand is free');
    const told = db.readAllMessages({ since: during }).filter(m => m.toSession === OTHER && /Stand 198 is free/.test(m.message));
    assert.strictEqual(told.length, 1, 'the waiting window is told once');
    assert.strictEqual(told[0].status, 'answer', 'in a message that wakes it');
    ok('its turn over, the stand it held is free and the window that waited is told');

    const second = await watch(7000);
    assert.strictEqual(second.code, null, 'not woken again for the same message: ' + second.err);
    ok('a window is not woken twice for the same message');

    assert.ok(stands.take({ stand: '198', holder: OTHER, agent: 'Claude', room: '' }).ok);
    assert.strictEqual(stands.done({ stand: '198', holder: OTHER }).free, true);
    assert.strictEqual(db.takeStandWaiters('198').length, 0, 'no one left waiting');
    ok('the waiter takes it and says done; nobody else is told');
  } finally {
    try { db.getDb().close(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(n + '/5 passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
