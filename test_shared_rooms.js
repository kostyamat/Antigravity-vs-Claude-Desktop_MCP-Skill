'use strict';
// node test_shared_rooms.js — a room with a window of another machine in it is that machine's
// room too: it appears there under the same id, what is said in it travels both ways, and a
// copy's owner changes its members through the machine that made it. Two boards, "alpha" and
// "beta", each a copy of the bridge in a temporary folder with its own database, talk over HTTP
// on this machine's loopback; the live board is not touched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-shared-'));
process.env.USERPROFILE = tmp;
process.env.HOME = tmp;
process.env.AGENT_BRIDGE_NO_WAKE = '1';

function side(name, other, port, otherPort) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  for (const f of fs.readdirSync(__dirname)) if (/\.js$/.test(f) && !/^test_/.test(f)) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
  if (fs.existsSync(path.join(__dirname, 'locales'))) fs.cpSync(path.join(__dirname, 'locales'), path.join(dir, 'locales'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bridge_config.json'), JSON.stringify({ machineName: name, peers: [{ name: other, url: `http://127.0.0.1:${otherPort}` }] }));
  const db = require(path.join(dir, 'bridge-db.js'));
  const peer = require(path.join(dir, 'peer-link.js'));
  const cards = require(path.join(dir, 'cards.js'));
  const router = require(path.join(dir, 'room-routing.js')).createRouter(db, cards);
  const deps = { bridgeDb: db, cardsLib: cards, router, projectSlice: null, skillReader: null,
    roomMember: async (action, id, card, agent, by) => action === 'add'
      ? db.addRoomMember(id, card, agent, { owner: true }) : db.removeRoomMember(id, card, { by }) };
  const server = http.createServer((req, res) => peer.handle(req, res, deps)).listen(port, '127.0.0.1');
  return { db, peer, deps, server };
}

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok ' + name); };
const msgs = (s, room) => s.db.getDb().prepare('SELECT * FROM messages WHERE room = ? ORDER BY id').all(room);
const cardsOf = (s, room) => (s.db.getRoom(room).members || []).map(m => m.card).sort();

(async () => {
  const A = side('alpha', 'beta', 18931, 18932);
  const B = side('beta', 'alpha', 18932, 18931);
  try {
    // Said before the room was shared stays on this machine.
    const room = A.db.createRoom('Shared work', [{ card: 'local_a1', agent: 'Claude' }, { card: 'local_a2', agent: 'Claude' }], '');
    A.db.addMessage({ from: 'Claude', fromSession: 'local_a1', to: 'all', room: room.id, message: 'before the neighbour came' });
    A.db.addRoomMember(room.id, 'local_b1@beta', 'Claude', { owner: true });
    const letterbox = A.db.createRoom('Machine: beta', [{ card: 'local_a1', agent: 'Claude' }, { card: 'local_b9@beta', agent: 'Claude' }], '');

    await t('the room appears on the other machine, same id, members as it names them', async () => {
      await A.peer.pump(A.deps);
      const copy = B.db.getRoom(room.id);
      assert.ok(copy, 'the copy exists');
      assert.strictEqual(copy.name, 'Shared work');
      assert.deepStrictEqual(cardsOf(B, room.id), ['local_a1@alpha', 'local_a2@alpha', 'local_b1']);
      assert.strictEqual(B.db.roomOrigin(room.id), 'alpha');
      assert.strictEqual(B.db.getRoom(letterbox.id), null, 'a machine\'s letterbox room is not shared');
    });
    await t('what was said before the sharing does not travel', async () => {
      assert.strictEqual(msgs(B, room.id).length, 0);
    });
    await t('said in the room on one machine, it is in the room on the other', async () => {
      A.db.addMessage({ from: 'Claude', fromSession: 'local_a1', to: 'all', room: room.id, message: 'hello from alpha' });
      await A.peer.pump(A.deps);
      const got = msgs(B, room.id);
      assert.strictEqual(got.length, 1);
      assert.strictEqual(got[0].message, 'hello from alpha');
      assert.strictEqual(got[0].from_session, 'local_a1@alpha');
    });
    await t('the answer goes back into the same room, a reply to the same message', async () => {
      const there = msgs(B, room.id)[0];
      B.db.addMessage({ from: 'Claude', fromSession: 'local_b1', to: 'Claude', toSession: 'local_a1@alpha', room: room.id,
        replyTo: there.id, message: 'hello back from beta' });
      await B.peer.pump(B.deps);
      const got = msgs(A, room.id).filter(m => m.message === 'hello back from beta');
      assert.strictEqual(got.length, 1);
      assert.strictEqual(got[0].from_session, 'local_b1@beta');
      assert.strictEqual(got[0].to_session, 'local_a1');
      const orig = msgs(A, room.id).find(m => m.message === 'hello from alpha');
      assert.strictEqual(got[0].reply_to, orig.id);
    });
    await t('nothing comes back as an echo', async () => {
      const before = [msgs(A, room.id).length, msgs(B, room.id).length];
      await A.peer.pump(A.deps); await B.peer.pump(B.deps); await A.peer.pump(A.deps);
      assert.deepStrictEqual([msgs(A, room.id).length, msgs(B, room.id).length], before);
    });
    await t('the owner on the other machine sends a window out: asked of the room\'s maker, the copy follows', async () => {
      await B.peer.changeMember(B.db, room.id, 'local_a2@alpha', 'Claude', 'remove', 'owner');
      assert.deepStrictEqual(cardsOf(A, room.id), ['local_a1', 'local_b1@beta']);
      await A.peer.pump(A.deps);
      assert.deepStrictEqual(cardsOf(B, room.id), ['local_a1@alpha', 'local_b1']);
    });
    await t('mail to a window there, said in the shared room, is delivered into that room', async () => {
      assert.strictEqual(A.peer.sharedRoom(A.db, room.id, 'beta'), room.id);
      assert.strictEqual(A.peer.sharedRoom(A.db, 'Shared work', 'beta'), room.id, 'by its name too');
      assert.strictEqual(A.peer.sharedRoom(A.db, letterbox.id, 'beta'), '', 'the letterbox room is not a shared room');
      A.db.addMessage({ from: 'Owner', fromSession: 'human/web', to: 'Claude', toSession: 'local_b1@beta', room: room.id,
        status: 'question', message: 'Room invitation for local_b1' });
      await A.peer.pump(A.deps);
      const got = msgs(B, room.id).filter(m => m.message === 'Room invitation for local_b1');
      assert.strictEqual(got.length, 1, 'in the room on beta');
      assert.strictEqual(got[0].to_session, 'local_b1');
    });
    await t('a copy is never written over a room of the machine itself', async () => {
      B.db.createRoom('Mine', [{ card: 'local_b5', agent: 'Claude' }], '');
      assert.throws(() => B.db.mirrorRoom('mine', 'Mine', [], 'alpha'), /already exists/);
    });
  } finally {
    A.server.close(); B.server.close();
    for (const s of [A, B]) { try { s.db.getDb().close(); } catch (_) {} }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(n + '/8 passed');
})().catch(e => { console.error(e); process.exit(1); });
