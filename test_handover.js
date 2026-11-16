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
    readHelpers: () => [{ helper: 'gem-1', lead: 'c:/work/myapp', room: 'pair' },
                        { helper: 'gem-2', lead: 'c:/work/other', room: 'pair2' }],
    readAllMessages: () => msgs,
    cluster: c => (c === 'c:/work/myapp' ? ['c:/work/myapp', 'local_old', 'local_new', 'local_guest'] : [c])
  };
  // local_guest is opened in another project's folder and sits on this line by mistake.
  const folders = { local_old: 'C:\\work\\MyApp', local_new: 'C:\\work\\MyApp', local_guest: 'C:\\work\\Other' };
  const router = {
    agentOf: () => 'Claude',
    same: (a, b) => bridgeDb.cluster(a).includes(b) || bridgeDb.cluster(b).includes(a),
    addressOf: s => (folders[s] ? 'c:/work/myapp' : s),
    cardOf: s => (folders[s] ? { project: folders[s] } : null),
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
  t('the old window coming back asks nothing: it wrote in the room before', () => {
    const before = posted.length;
    handover.askHelpers({ bridgeDb, router, win: 'local_old', post });
    assert.strictEqual(posted.length, before);
  });
  t('two windows of the lead taking turns ask once between them', () => {
    const m = [{ id: 1, room: 'pair', fromSession: 'local_old', ts: new Date().toISOString(), topic: 'helper' }];
    const db2 = Object.assign({}, bridgeDb, { readAllMessages: () => m });
    const got = [];
    const p = x => { got.push(x); m.push(Object.assign({ id: m.length + 1, ts: new Date().toISOString(), status: 'question' }, x)); };
    handover.askHelpers({ bridgeDb: db2, router, win: 'local_new', post: p });
    assert.strictEqual(got.length, 1, 'the new window asks');
    m.push({ id: m.length + 1, room: 'pair', fromSession: 'gem-1', ts: new Date().toISOString(), topic: 'handover', status: 'answer' });
    m.push({ id: m.length + 1, room: 'pair', fromSession: 'local_old', ts: new Date().toISOString(), topic: 'handover', status: 'info' });
    handover.askHelpers({ bridgeDb: db2, router, win: 'local_new', post: p });
    handover.askHelpers({ bridgeDb: db2, router, win: 'local_old', post: p });
    assert.strictEqual(got.length, 1, 'neither window asks again');
    assert.match(got[0].message, /go on with that task/);
  });
  t('a window of another project on this line asks nobody', () => {
    const before = posted.length;
    assert.deepStrictEqual(handover.askHelpers({ bridgeDb, router, win: 'local_guest', post }), []);
    assert.strictEqual(posted.length, before);
  });
  t('another project\'s helper is never asked, and many helpers make one line', () => {
    assert.ok(!posted.some(m => m.toSession === 'gem-2'));
    const many = { readHelpers: () => [1, 2, 3, 4, 5, 6].map(i => ({ helper: 'g' + i, lead: 'c:/work/myapp', room: 'r' + i })),
      readAllMessages: () => [1, 2, 3, 4, 5, 6].map(i => ({ id: i, room: 'r' + i, fromSession: 'local_old', ts: new Date().toISOString() })),
      cluster: bridgeDb.cluster };
    const got = [];
    const l = handover.askHelpers({ bridgeDb: many, router, win: 'local_new', post: m => got.push(m) });
    assert.strictEqual(got.length, 6);
    assert.strictEqual(l.length, 1);
    assert.match(l[0], /6 of your helpers were asked.*and 2 more/);
  });
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(n + '/10 passed');
