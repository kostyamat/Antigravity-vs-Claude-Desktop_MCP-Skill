'use strict';
// node test_room_pin.js — the owner pins a room to the top of the list and unpins it.
// Runs on a copy of bridge-db.js in a temporary folder, so the live board database is not touched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-pin-'));
fs.copyFileSync(path.join(__dirname, 'bridge-db.js'), path.join(dir, 'bridge-db.js'));
fs.copyFileSync(path.join(__dirname, 'sqlite.js'), path.join(dir, 'sqlite.js'));
const db = require(path.join(dir, 'bridge-db.js'));

const order = () => db.readRooms().map(r => r.name);
const a = db.createRoom('quiet', [{ card: 'local_a', agent: 'Claude' }], '');
const b = db.createRoom('busy', [{ card: 'local_b', agent: 'Claude' }], '');
const c = db.createRoom('other', [{ card: 'local_c', agent: 'Claude' }], '');
db.addMessage({ from: 'x', to: 'y', message: 'hi', room: b.id });

assert.strictEqual(order()[0], 'busy', 'unpinned rooms follow the conversation');
db.pinRoom(a.id, true);
assert.strictEqual(order()[0], 'quiet', 'a pinned room comes first');
assert.ok(db.getRoom(a.id).pinned_at, 'the pin is stored');
{ const until = Date.now() + 5; while (Date.now() < until); }   // two pins in one millisecond have no order
db.pinRoom(c.id, true);
assert.deepStrictEqual(order().slice(0, 2), ['quiet', 'other'], 'pinned rooms keep the order they were pinned in');
db.pinRoom(a.id, false);
assert.strictEqual(db.getRoom(a.id).pinned_at, '', 'unpinned');
assert.deepStrictEqual(order().slice(0, 2), ['other', 'busy'], 'an unpinned room moves with the conversation again');
assert.throws(() => db.pinRoom('nope', true), /no such room/);

try { db.getDb().close(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
console.log('room pin: all checks passed');
