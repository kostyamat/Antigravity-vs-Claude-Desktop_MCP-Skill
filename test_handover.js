'use strict';
// node test_handover.js — the previous window's ending is shown when the slice is behind it,
// and a helper is asked for a handover once per new window of its lead.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'abho-'));
process.env.USERPROFILE = home;
process.env.BRIDGE_RUN_DIR = path.join(home, 'run');
const handover = require('./handover');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok ' + name); };

try {
  const proj = path.join(home, 'work', 'MyApp');
  fs.mkdirSync(path.join(proj, '.agents'), { recursive: true });
  const slice = path.join(proj, '.agents', 'HANDOFF.md');
  fs.writeFileSync(slice, '# slice');
  const dir = handover.transcriptDir(proj);
  fs.mkdirSync(dir, { recursive: true });
  const line = o => JSON.stringify(o) + '\n';
  const old = path.join(dir, 'prev-session.jsonl');
  fs.writeFileSync(old,
    line({ type: 'user', message: { role: 'user', content: 'fix the parser please' }, timestamp: '2026-11-11T01:00:00Z' }) +
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }) +
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'noise' }] } }) +
    line({ type: 'user', message: { content: '<task-notification>bg</task-notification>' } }) +
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Parser fixed in parse.js, now running the tests' }] } }));
  fs.writeFileSync(path.join(dir, 'this-session.jsonl'), line({ type: 'user', message: { content: 'current window' } }));
  // Written within the same millisecond or two: give each file the age the story needs.
  const age = (f, sec) => { const s = Date.now() / 1000 - sec; fs.utimesSync(f, s, s); };
  age(path.join(dir, 'this-session.jsonl'), 7200);
  age(old, 0);

  const past = Date.now() / 1000 - 3600;
  fs.utimesSync(slice, past, past);                    // the slice is an hour old, the transcript fresh
  t('slice behind the previous window: its ending is shown', () => {
    const l = handover.briefLines(proj, 'this-session').join('\n');
    assert.match(l, /previous window/);
    assert.match(l, /fix the parser please/);
    assert.match(l, /Parser fixed in parse\.js/);
    assert.doesNotMatch(l, /noise|task-notification|current window/);
  });
  t('slice written after it: nothing', () => {
    const now = Date.now() / 1000 + 120;
    fs.utimesSync(slice, now, now);
    assert.deepStrictEqual(handover.briefLines(proj, 'this-session'), []);
  });

  // ── an old conversation comes back after another window worked (the other account) ──
  const back = path.join(dir, 'old-window.jsonl');
  fs.writeFileSync(back,
    line({ type: 'user', message: { content: 'start the export' }, timestamp: '2026-11-01T10:00:00Z' }) +
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'export started' }] }, timestamp: '2026-11-01T10:01:00Z' }));
  t('a window that comes back is told, even when the slice is newer than the other window', () => {
    const later = Date.now() / 1000 + 300;
    fs.utimesSync(slice, later, later);                  // the other window did update the slice
    const l = handover.briefLines(proj, 'old-window').join('\n');
    assert.match(l, /Another window of this project/);
    assert.match(l, /reread/);
    assert.match(l, /Parser fixed in parse\.js/);
  });
  t('…once, until the other window works again', () => {
    assert.deepStrictEqual(handover.briefLines(proj, 'old-window'), []);
    const t2 = Date.now() / 1000 + 600;
    fs.utimesSync(old, t2, t2);
    assert.match(handover.briefLines(proj, 'old-window').join('\n'), /Another window/);
  });

  // ── the helper's handover ──
  const msgs = [{ id: 1, room: 'pair', fromSession: 'local_old', ts: new Date().toISOString(), topic: '' }];
  const bridgeDb = {
    readHelpers: () => [{ helper: 'gem-1', lead: 'c:/work/myapp', room: 'pair' }],
    readAllMessages: () => msgs,
    cluster: c => (c === 'c:/work/myapp' ? ['c:/work/myapp', 'local_old', 'local_new'] : [c])
  };
  const router = {
    agentOf: () => 'Claude',
    same: (a, b) => bridgeDb.cluster(a).includes(b) || bridgeDb.cluster(b).includes(a),
    windowOf: s => s, nameOf: s => s
  };
  const posted = [];
  const post = m => { posted.push(m); msgs.push(Object.assign({ id: msgs.length + 1, ts: new Date().toISOString() }, m)); };
  t('a new window of the lead asks the helper once', () => {
    const l = handover.askHelpers({ bridgeDb, router, win: 'local_new', post });
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].toSession, 'gem-1');
    assert.strictEqual(posted[0].topic, 'handover');
    assert.match(l.join(''), /asked for a handover/);
    handover.askHelpers({ bridgeDb, router, win: 'local_new', post });
    assert.strictEqual(posted.length, 1, 'not asked twice');
  });
  t('the same window as before asks nothing', () => {
    const before = posted.length;
    handover.askHelpers({ bridgeDb, router, win: 'local_new', post });
    msgs.push({ id: 99, room: 'pair', fromSession: 'local_new', ts: new Date().toISOString(), topic: '' });
    handover.askHelpers({ bridgeDb, router, win: 'local_new', post });
    assert.strictEqual(posted.length, before);
  });
  t('the old window coming back asks the helper again', () => {
    const before = posted.length;
    handover.askHelpers({ bridgeDb, router, win: 'local_old', post });
    assert.strictEqual(posted.length, before + 1);
    assert.strictEqual(posted[posted.length - 1].fromSession, 'local_old');
  });
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(n + '/7 passed');
