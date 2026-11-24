'use strict';
// node test_dormant.js — a window wakes for what is its own, not for the whole board (owner,
// 24.11.2026: twenty-five sessions woke and ate the quota while he worked with two or three).
// A dormant window (its last turn ended longer ago than activeWindowMinutes) is woken only by a
// message to its own id; an active one also by its rooms. Run in a copy of the code.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-dormant-'));
for (const f of fs.readdirSync(__dirname)) if (/\.js$/.test(f) && !/^test_/.test(f)) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
const db = require(path.join(dir, 'bridge-db.js'));

const WIN = 'local_' + 'e'.repeat(8) + '-0000-4000-8000-' + '5'.repeat(12);
const OTHER = 'local_' + 'f'.repeat(8) + '-0000-4000-8000-' + '6'.repeat(12);
const room = db.createRoom('work', [{ card: WIN, agent: 'Claude' }, { card: OTHER, agent: 'Claude' }], '');
const post = m => db.addMessage(Object.assign({ ts: new Date().toISOString(), from: 'Claude', fromSession: OTHER, to: 'Claude',
  toSession: '', room: room.id, replyTo: null, priority: 'normal', status: 'question', progress: '', topic: '', file: null, readBy: [] }, m)).id;

function watch(ms, activeMs) {
  return new Promise(resolve => {
    const env = Object.assign({}, process.env, { CLAUDE_CODE_HOST_SESSION_ID: WIN, BRIDGE_ACTIVE_MS: String(activeMs) });
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
    const read = post({ status: 'info', message: 'read' });
    db.getDb().prepare('INSERT OR REPLACE INTO cursors (reader, last_read_id) VALUES (?, ?)').run('Claude/' + WIN, read);

    post({ fromSession: 'human/web', from: 'Owner', to: 'all', status: 'info', message: 'the owner to the room' });
    post({ message: 'a question to the room' });
    post({ toSession: OTHER, status: 'answer', message: 'for the other window of the room' });
    let r = await watch(6000, 1);
    assert.strictEqual(r.code, null, 'dormant: the room, the owner to the room and another window\'s mail do not wake it: ' + r.err);
    ok('a dormant window sleeps through its rooms and other windows\' mail');

    r = await watch(6000, 3600e3);
    assert.strictEqual(r.code, 2, 'active: its room wakes it');
    assert.doesNotMatch(r.err, /for the other window/, 'never for another window\'s mail');
    ok('an active window is woken by its rooms, never by another window\'s mail');

    // The end of a turn: another window's mail does not hold this one (bridge-hook.js stop).
    const held = await new Promise(resolve => {
      const env = Object.assign({}, process.env, { CLAUDE_CODE_HOST_SESSION_ID: WIN });
      const p = spawn(process.execPath, [path.join(dir, 'bridge-hook.js'), 'stop'], { env });
      let out = ''; p.stdout.on('data', d => { out += d; }); p.on('exit', () => resolve(out)); p.stdin.end('{}');
    });
    assert.doesNotMatch(held, /for the other window/, 'not held for another window\'s mail: ' + held);
    ok('the end of a turn is not held for another window\'s mail');

    // A window in a turn listens: it reads its mail at the turn's end.
    const lis = require(path.join(dir, 'listening.js'));
    const rd = path.join(dir, 'run');
    assert.strictEqual(lis.listening(OTHER, rd), false);
    lis.markBusy(OTHER, rd);
    assert.strictEqual(lis.listening(OTHER, rd), true, 'in a turn: listening');
    lis.clearBusy(OTHER, rd);
    assert.strictEqual(lis.listening(OTHER, rd), false);
    ok('a window in a turn counts as listening, so nobody is told to ring it');

    const mine = post({ toSession: WIN, status: 'answer', message: 'for this window by its id' });
    r = await watch(6000, 1);
    assert.strictEqual(r.code, 2, 'dormant, but addressed by its own id: woken');
    assert.match(r.err, new RegExp('#' + mine + '\\b'));
    ok('a message to its own id wakes even a dormant window');
  } finally {
    try { db.getDb().close(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(n + '/5 passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
