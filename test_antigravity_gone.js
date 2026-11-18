'use strict';
// node test_antigravity_gone.js — an Antigravity conversation deleted from the machine is taken off the
// board: its pair ends, it leaves its rooms, a room left to one participant is archived; and nothing is
// done when the folder of conversations is missing or too many look gone at once.
// A copy of bridge-db.js in a temporary folder and a fake brain folder; the live board is not touched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-gone-'));
fs.copyFileSync(path.join(__dirname, 'bridge-db.js'), path.join(tmp, 'bridge-db.js'));
fs.copyFileSync(path.join(__dirname, 'sqlite.js'), path.join(tmp, 'sqlite.js'));
const db = require(path.join(tmp, 'bridge-db.js'));
const g = require('./antigravity-gone');
const brain = path.join(tmp, 'brain');
const { randomUUID } = require('crypto');                  // ids made at run time: no session id in a tracked file
const H1 = randomUUID(), H2 = randomUUID(), H3 = randomUUID();
for (const id of [H1, H2, H3, randomUUID()]) fs.mkdirSync(path.join(brain, id), { recursive: true });
for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(brain, randomUUID()));   // other conversations

const pairRoom = db.createRoom('App + helper', [{ card: 'local_lead', agent: 'Claude' }, { card: H1, agent: 'Gemini' }], '');
db.setHelper(H1, 'c:/work/app', pairRoom.id);
const big = db.createRoom('Team', [{ card: 'local_lead', agent: 'Claude' }, { card: 'local_other', agent: 'Claude' }, { card: H1, agent: 'Gemini' }, { card: H2, agent: 'Gemini' }], '');
const archived = [], said = [];
const deps = { bridgeDb: db, archiveRoom: id => { archived.push(id); return { file: id + '.zip' }; }, say: m => said.push(m) };
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok ' + name); };

t('nothing gone: nothing changes', () => {
  assert.deepStrictEqual(g.sweep(deps, { dir: brain }).gone, []);
});
t('a deleted helper: pair ended, rooms left, its pair room archived, the other room kept', () => {
  fs.rmSync(path.join(brain, H1), { recursive: true });
  const out = g.sweep(deps, { dir: brain });
  assert.deepStrictEqual(out.gone, [H1]);
  assert.ok(!db.readHelpers().some(h => h.helper === H1), 'pair ended');
  assert.deepStrictEqual(archived, [pairRoom.id], 'its pair room archived, the team room kept');
  assert.ok(!db.getRoom(big.id).members.some(m => m.card === H1), 'left the team room');
  assert.strictEqual(said.length, 1);
  assert.strictEqual(said[0].toSession, 'c:/work/app');
});
t('a room left to one participant is archived', () => {
  const solo = db.createRoom('Solo', [{ card: 'local_lead', agent: 'Claude' }, { card: H3, agent: 'Gemini' }], '');
  fs.rmSync(path.join(brain, H3), { recursive: true });
  g.sweep(deps, { dir: brain });
  assert.ok(archived.includes(solo.id));
});
t('no folder of conversations: nothing is decided', () => {
  assert.strictEqual(g.gone(H2, path.join(tmp, 'nowhere')), null);
  assert.deepStrictEqual(g.sweep(deps, { dir: path.join(tmp, 'nowhere') }).gone, []);
});
t('too many gone at once: refused, nothing changed', () => {
  const many = [];
  for (let i = 0; i < 7; i++) {
    const id = randomUUID();
    many.push(id);
    db.createRoom('R' + i, [{ card: 'local_lead', agent: 'Claude' }, { card: id, agent: 'Gemini' }], '');
  }
  const before = archived.length;
  const out = g.sweep(deps, { dir: brain });
  assert.match(out.refused, /look gone at once/);
  assert.strictEqual(archived.length, before);
});
t('an id not shaped like a conversation is never judged', () => {
  assert.strictEqual(g.gone('local_lead', brain), null);
});
try { db.getDb().close(); } catch (_) {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
console.log(n + '/6 passed');
