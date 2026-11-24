'use strict';
// node test_file_transfer.js — a file to a window on another machine (owner, 24.11.2026). Two
// "machines" are two copies of the code in temporary folders, each with its own board database;
// the receiver's door is a real HTTP server. Checked: a file larger than one piece arrives whole
// and its window is told; a connection dropped mid-way resumes where it stopped; a file whose
// checksum does not match is dropped, never kept; an unknown addressee is refused at once.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');

function machine(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-file-' + tag + '-'));
  for (const f of fs.readdirSync(__dirname)) if (/\.js$/.test(f) && !/^test_/.test(f)) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
  const db = require(path.join(dir, 'bridge-db.js'));
  return { dir, db, ft: require(path.join(dir, 'file-transfer.js')) };
}
const A = machine('a'), B = machine('b');
const WIN = 'local_' + 'c'.repeat(8) + '-0000-4000-8000-' + '3'.repeat(12);
const SENDER = 'local_' + 'd'.repeat(8) + '-0000-4000-8000-' + '4'.repeat(12);
const saidA = [], saidB = [];
const routerB = { windowOf: s => (s === 'qf_dvr' || s === WIN) ? WIN : '', agentOf: () => 'Claude' };

let dropAfter = 0;   // > 0: the door cuts the connection after this many bytes of a piece, once
const srv = http.createServer((req, res) => {
  if (dropAfter && req.method === 'PUT') {
    let got = 0; const limit = dropAfter; dropAfter = 0;
    const orig = req.pipe.bind(req);
    req.on('data', d => { got += d.length; if (got > limit) req.socket.destroy(); });
    return void B.ft.handle(req, res, { bridgeDb: B.db, router: routerB, say: m => saidB.push(m), cfg: {} }, 'alpha');
  }
  B.ft.handle(req, res, { bridgeDb: B.db, router: routerB, say: m => saidB.push(m), cfg: {} }, 'alpha');
});

let n = 0;
const ok = name => { n++; console.log('ok ' + name); };
(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const peer = { name: 'beta', url: 'http://127.0.0.1:' + srv.address().port };
  const deps = { bridgeDb: A.db, peerByName: x => x === 'beta' ? peer : null, machineName: () => 'alpha', say: m => saidA.push(m) };
  const parseAddress = s => { const m = /^(.+)@(\w+)$/.exec(s); return m ? { target: m[1], machine: m[2], peer: deps.peerByName(m[2]) } : null; };
  const src = path.join(A.dir, 'image.bin');
  const data = crypto.randomBytes(A.ft.CHUNK * 2 + 12345);
  fs.writeFileSync(src, data);
  const pumpUntil = async (id, states) => {
    for (let i = 0; i < 40; i++) {
      await A.ft.pump(deps);
      const t = A.db.getDb().prepare('SELECT * FROM file_transfers WHERE id = ?').get(id);
      if (states.includes(t.state)) return t;
    }
    throw new Error('transfer #' + id + ' stuck');
  };
  try {
    const q = A.ft.queue(A.db, { to: 'qf_dvr@beta', file: src, note: 'the DVR build', fromSession: SENDER, fromAgent: 'Claude', parseAddress, cfg: {} });
    assert.ok(q.id, q.error);
    dropAfter = 3 * 1024 * 1024;            // the first piece is cut short
    await A.ft.pump(deps);                  // fails mid-piece: waiting
    let t = A.db.getDb().prepare('SELECT * FROM file_transfers WHERE id = ?').get(q.id);
    assert.ok(['waiting', 'sending'].includes(t.state), 'a dropped connection is waited for, not given up: ' + t.state);
    t = await pumpUntil(q.id, ['done', 'failed']);
    assert.strictEqual(t.state, 'done', t.error);
    const kept = B.db.getDb().prepare("SELECT * FROM file_transfers WHERE dir = 'in'").get();
    assert.ok(kept && fs.readFileSync(kept.path).equals(data), 'the file there is the file here, byte for byte');
    assert.ok(kept.path.includes(path.join('exchange', 'inbox', 'alpha')), 'in the inbox of the sending machine: ' + kept.path);
    ok('a file of three pieces arrives whole after a dropped connection, in exchange/inbox/<machine>/');

    assert.strictEqual(saidB.length, 1);
    assert.strictEqual(saidB[0].toSession, WIN);
    assert.strictEqual(saidB[0].status, 'answer', 'a message that wakes the window');
    assert.match(saidB[0].message, /image\.bin .*SHA-256 [0-9a-f]{64} checked.*the DVR build.*look before you open/);
    assert.ok(saidA.some(m => m.toSession === SENDER && /is on beta for "qf_dvr", SHA-256 checked/.test(m.message)), 'the sender is told');
    ok('the window it is for is woken with its path and checksum; the sender is told it arrived');

    await A.ft.pump(deps);
    assert.strictEqual(saidB.length, 1, 'a finished transfer is not sent again');
    ok('a delivered file is not sent twice');

    // A file that changes after it was queued and hashed: the other side refuses to keep it.
    const src2 = path.join(A.dir, 'two.bin');
    fs.writeFileSync(src2, crypto.randomBytes(1000));
    const q2 = A.ft.queue(A.db, { to: 'qf_dvr@beta', file: src2, fromSession: SENDER, fromAgent: 'Claude', parseAddress, cfg: {} });
    A.db.getDb().prepare('UPDATE file_transfers SET sha256 = ? WHERE id = ?').run('0'.repeat(64), q2.id);
    t = await pumpUntil(q2.id, ['done', 'failed']);
    assert.strictEqual(t.state, 'failed');
    assert.match(t.error, /SHA-256 does not match/);
    assert.strictEqual(B.db.getDb().prepare("SELECT COUNT(*) n FROM file_transfers WHERE dir = 'in'").get().n, 1, 'nothing kept');
    ok('a checksum that does not match: dropped there, the sender told');

    const q3 = A.ft.queue(A.db, { to: 'nobody@beta', file: src2, fromSession: SENDER, fromAgent: 'Claude', parseAddress, cfg: {} });
    t = await pumpUntil(q3.id, ['done', 'failed']);
    assert.match(t.error, /no window and no project/);
    assert.match(A.ft.queue(A.db, { to: 'x@gamma', file: src2, parseAddress, cfg: {} }).error || '', /no linked machine|is linked here/);
    assert.match(A.ft.queue(A.db, { to: 'x@beta', file: src2, parseAddress, cfg: { maxFileGB: 0.0000001 } }).error || '', /is the most/);
    assert.match(A.ft.list(A.db, SENDER), /#\d+ → qf_dvr@beta: image\.bin .* done/);
    ok('an unknown addressee, an unlinked machine and a file too large are refused; list shows the transfers');
  } finally {
    srv.close();
    for (const m of [A, B]) { try { m.db.getDb().close(); } catch (_) {} try { fs.rmSync(m.dir, { recursive: true, force: true }); } catch (_) {} }
  }
  console.log(n + '/5 passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
