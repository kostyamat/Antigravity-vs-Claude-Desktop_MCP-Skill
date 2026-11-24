'use strict';
// node test_courier.js — the courier (courier.js) rings a Claude window that cannot hear the board,
// for mail that is its own, and only that (owner and ROM Builder, 24.11.2026). The `claude -p` run
// is faked: what is checked is who is rung, what the courier is told, and what the sender hears.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-courier-'));
for (const f of fs.readdirSync(__dirname)) if (/\.js$/.test(f) && !/^test_/.test(f)) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
const db = require(path.join(dir, 'bridge-db.js'));
const courier = require(path.join(dir, 'courier.js'));
const { createMailbox } = require(path.join(dir, 'mailbox.js'));
const settings = require(path.join(dir, 'settings.js'));

const DEAF = 'local_' + '1'.repeat(8) + '-0000-4000-8000-' + 'a'.repeat(12);
const HEARS = 'local_' + '2'.repeat(8) + '-0000-4000-8000-' + 'b'.repeat(12);
const LEAD = 'local_' + '3'.repeat(8) + '-0000-4000-8000-' + 'c'.repeat(12);
const names = { [DEAF]: 'Repair  of  apps', [HEARS]: 'BitPerfect', [LEAD]: 'ROM Builder' };
const router = { cardOf: w => names[w] ? { name: names[w] } : null, roomAdmits: () => true, nameOf: w => names[w] || w };
const listening = w => w === HEARS;
const old = new Date(Date.now() - 5 * 60e3).toISOString();
const post = m => db.addMessage(Object.assign({ ts: old, from: 'Claude', fromSession: LEAD, to: 'Claude', toSession: '', room: '',
  replyTo: null, priority: 'normal', status: 'question', progress: '', topic: '', file: null, readBy: [] }, m)).id;

let n = 0;
const ok = name => { n++; console.log('ok ' + name); };
(async () => {
  try {
    const mine = post({ toSession: DEAF, message: 'task for the deaf window' });
    post({ toSession: HEARS, message: 'for a window that hears' });
    post({ toSession: DEAF, status: 'working', message: 'a working note' });
    post({ toSession: DEAF, priority: 'fyi', message: 'for information' });
    post({ toSession: '', room: 'r1', message: 'to the room' });
    post({ toSession: DEAF, ts: new Date().toISOString(), message: 'too fresh' });
    const deps = { bridgeDb: db, router, mailbox: createMailbox(db, router), listening, settings };
    const due = courier.due(deps);
    assert.deepStrictEqual(due.map(d => [d.msg.id, d.win]), [[mine, DEAF]], 'only the deaf window, only its own real mail, after two minutes');
    ok('rung: a deaf window, for its own mail — never a listening one, a room, a note, fyi, or mail under two minutes old');

    const p = courier.prompt(due);
    assert.match(p, /"name": "Repair of apps"/, 'its name, spaces normalised');
    assert.match(p, new RegExp('Board #' + mine + ' is for you'));
    assert.doesNotMatch(p, /task for the deaf window/, 'no text of any message reaches the courier');
    ok('the courier is told ids and names only, never what the message says');

    const said = []; let args = null, env = null;
    const results = await courier.tick(Object.assign({}, deps, { say: m => said.push(m),
      run: (a, o, cb) => { args = a; env = o.env; cb(null, 'RUNG 1\n'); } }));
    assert.deepStrictEqual(results.map(r => r.result), ['rung']);
    assert.ok(args.includes('haiku') && args.includes('low') && args.includes('--strict-mcp-config'), 'Haiku, low effort, no MCP servers');
    assert.strictEqual(env.AGENT_BRIDGE_COURIER, '1', 'the bridge\'s hooks stand aside');
    assert.strictEqual(said.length, 1);
    assert.strictEqual(said[0].toSession, LEAD, 'the sender hears it');
    assert.strictEqual(said[0].priority, 'fyi', 'without being woken');
    assert.match(said[0].message, /courier rang it/);
    ok('one Haiku run rings it; the sender is told in a line that wakes nobody');

    assert.strictEqual(courier.due(deps).length, 0, 'not rung twice for the same message');
    db.getDb().prepare('INSERT OR REPLACE INTO cursors (reader, last_read_id) VALUES (?, ?)').run('Claude/' + DEAF, 1e9);
    post({ toSession: DEAF, message: 'another, but read' });
    assert.strictEqual(courier.due(deps).length, 0, 'mail it has read is not rung');
    ok('never twice for one message, never for mail already read');

    settings.set('courier', false);
    assert.strictEqual(await courier.tick(Object.assign({}, deps, { say: () => {}, run: () => { throw new Error('ran'); } })), null);
    ok('switched off on the Settings tab: nothing runs');
  } finally {
    try { db.getDb().close(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(n + '/5 passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
