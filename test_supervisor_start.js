'use strict';
// node test_supervisor_start.js — a supervisor that is switched on has its conversation and
// its room from the first round, with no task waiting; one that is off creates nothing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The application and the database guard are not what is tested here.
const created = [], sent = [];
const stub = (file, exports) => { require.cache[require.resolve(file)] = { id: file, filename: file, loaded: true, exports }; };
stub('./antigravity-api', {
  create: async o => { created.push(o); return 'conv-1'; },
  send: (id, text) => { sent.push({ id, text }); },
  locate: () => ({})
});
stub('./antigravity-quota', { read: async () => { throw new Error('not asked here'); }, remember: () => ({}), warning: () => null });
stub('./db-guard', { createGuard: () => ({ check: () => ({ ok: true, problem: '' }), live: () => ({}), sound: () => '', repair: () => ({}) }) });

const { createSupervisor } = require('./supervisor');

function board(home) {
  const rooms = new Map();
  return {
    rooms,
    bridgeDb: {
      readLines: () => new Map(), readStands: () => [], readDescriptions: () => [], readAllMessages: () => [],
      getDb: () => ({ prepare: () => ({ get: () => ({ n: 0 }) }) }),
      getRoom: id => rooms.get(id) || null,
      createRoom: (name, members) => { const r = { id: 'supervisor', name, members }; rooms.set(r.id, r); return r; },
      addMessage: () => ({ id: 1 }), touchRoom: () => {}
    },
    cardsLib: { claudeCardsEverywhere: () => [], geminiCards: () => created.length ? [{ id: 'conv-1' }] : [] },
    router: { nameOf: s => s }, home
  };
}
const config = home => JSON.parse(fs.readFileSync(path.join(home, 'bridge_config.json'), 'utf8')).supervisor;

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'absv-'));
  try {
    fs.writeFileSync(path.join(home, 'bridge_config.json'), JSON.stringify({ supervisor: { enabled: false } }));
    let b = board(home);
    let sv = createSupervisor(b);
    await sv.tick(false);
    assert.strictEqual(created.length, 0, 'off means off');

    fs.writeFileSync(path.join(home, 'bridge_config.json'), JSON.stringify({ supervisor: { enabled: true } }));
    b = board(home);
    sv = createSupervisor(b);
    const st = await sv.tick(false);
    assert.strictEqual(created.length, 1, 'switched on with nothing to do: the conversation is started');
    assert.strictEqual(config(home).conversation, 'conv-1');
    assert.strictEqual(config(home).room, 'supervisor');
    assert.ok(b.rooms.has('supervisor'), 'and its room exists');
    assert.strictEqual(sent.length, 1, 'it is told its id and its room');
    assert.match(sent[0].text, /sessionId: conv-1.*room: supervisor/i);
    assert.match(st.sent, /were created/);

    await sv.tick(false);
    assert.strictEqual(created.length, 1, 'not started twice');
    assert.strictEqual(sent.length, 1, 'and not told twice');
    console.log('ok 9/9');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
