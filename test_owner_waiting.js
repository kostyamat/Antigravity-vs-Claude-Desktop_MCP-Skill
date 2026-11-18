'use strict';
// node test_owner_waiting.js — what the owner waits on from a window: his message to it, or to a room it
// is in; never his message to ANOTHER window said in that room (an invitation of it, a notice to it).
// A copy of bridge-db.js in a temporary folder; the live board is not touched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-ownerwait-'));
process.env.USERPROFILE = tmp; process.env.HOME = tmp;
fs.copyFileSync(path.join(__dirname, 'bridge-db.js'), path.join(tmp, 'bridge-db.js'));
fs.copyFileSync(path.join(__dirname, 'sqlite.js'), path.join(tmp, 'sqlite.js'));
const db = require(path.join(tmp, 'bridge-db.js'));
const router = require('./room-routing').createRouter(db, require('./cards'));

const ME = 'local_me-window', OTHER = 'local_other-window';
const room = db.createRoom('Shared', [{ card: ME, agent: 'Claude' }, { card: OTHER, agent: 'Claude' }], '');
const owner = (over) => db.addMessage(Object.assign({ from: 'Owner', fromSession: 'human/web', to: 'Claude', room: room.id, status: 'question', message: 'x' }, over));
const toRoom = owner({ to: 'all', toSession: '', message: 'to the room' });
const toMe = owner({ toSession: ME, message: 'to me' });
const toOther = owner({ toSession: OTHER, message: 'invitation for the other window' });
const waiting = () => router.ownerWaiting(db.readAllMessages({ since: 0 }), new Set([ME]), m => m.fromSession === ME).map(m => m.message);

assert.deepStrictEqual(waiting().sort(), ['to me', 'to the room'], 'his question to me and to the room wait on me; the other window\'s does not');
db.addMessage({ from: 'Claude', fromSession: ME, to: 'Owner', toSession: 'human/web', room: room.id, replyTo: toMe.id, status: 'answer', message: 'answered' });
assert.ok(!waiting().includes('to me'), 'answered: no longer waiting');
assert.ok(toOther.id && toRoom.id);
try { db.getDb().close(); } catch (_) {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
console.log('owner waiting: all checks passed');
