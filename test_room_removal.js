'use strict';
// node test_room_removal.js — the owner sends a window out of a room and only he lets it back.
// Runs on a copy of bridge-db.js in a temporary folder, so the live board database is not touched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-removal-'));
fs.copyFileSync(path.join(__dirname, 'bridge-db.js'), path.join(dir, 'bridge-db.js'));
fs.copyFileSync(path.join(__dirname, 'sqlite.js'), path.join(dir, 'sqlite.js'));
const db = require(path.join(dir, 'bridge-db.js'));

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok ' + name); };
const cards = id => (db.getRoom(id).members || []).map(m => m.card);

const room = db.createRoom('test room', [{ card: 'local_lead', agent: 'Claude' }, { card: 'gem-helper', agent: 'Gemini' }], '');

t('a window starts as a member and is not removed', () => {
  assert.deepStrictEqual(cards(room.id).sort(), ['gem-helper', 'local_lead']);
  assert.strictEqual(db.removedFromRoom(room.id, 'gem-helper'), false);
});

t('removal without a remover is a plain leave: nothing remembered', () => {
  db.removeRoomMember(room.id, 'local_lead');
  assert.strictEqual(db.removedFromRoom(room.id, 'local_lead'), false);
  db.addRoomMember(room.id, 'local_lead', 'Claude');
  assert.ok(cards(room.id).includes('local_lead'));
});

t('the owner sends a window out: gone and remembered', () => {
  db.removeRoomMember(room.id, 'gem-helper', { by: 'owner' });
  assert.ok(!cards(room.id).includes('gem-helper'));
  assert.strictEqual(db.removedFromRoom(room.id, 'gem-helper'), true);
  assert.strictEqual(db.removedFromRoom(room.id, 'GEM-HELPER'), true, 'case does not matter');
});

t('an agent cannot invite it back', () => {
  assert.throws(() => db.addRoomMember(room.id, 'gem-helper', 'Gemini'), /only he can invite it back/);
  assert.ok(!cards(room.id).includes('gem-helper'));
});

t('the removal is per room', () => {
  const other = db.createRoom('other room', [{ card: 'local_lead', agent: 'Claude' }, { card: 'local_x', agent: 'Claude' }], '');
  db.addRoomMember(other.id, 'gem-helper', 'Gemini');
  assert.ok(cards(other.id).includes('gem-helper'));
  assert.strictEqual(db.removedFromRoom(other.id, 'gem-helper'), false);
});

t('the owner invites it back: member again, removal forgotten', () => {
  db.addRoomMember(room.id, 'gem-helper', 'Gemini', { owner: true });
  assert.ok(cards(room.id).includes('gem-helper'));
  assert.strictEqual(db.removedFromRoom(room.id, 'gem-helper'), false);
  db.addRoomMember(room.id, 'gem-helper', 'Gemini');   // and an agent's add is fine again
});

try { db.getDb().close(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
console.log(`${n} passed`);
