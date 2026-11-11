'use strict';
// node test_helper_answers_owner.js — a helper answers the owner in the room the owner
// wrote in, even when that room is not its lead's; everything else stays as it was.
const assert = require('assert');
const { createRules } = require('./board-rules');

const HELPER = 'gem-helper', LEAD = 'local_lead', OTHER = 'local_other';
const rooms = {
  'lead-room': { id: 'lead-room', name: 'Lead room', members: [{ card: LEAD }, { card: HELPER }] },
  'other-room': { id: 'other-room', name: 'Other room', members: [{ card: OTHER }, { card: HELPER }] }
};
const messages = {
  1: { id: 1, fromSession: 'human/web', room: 'other-room' },   // the owner, in the other room
  2: { id: 2, fromSession: OTHER, room: 'other-room' },         // another agent, same room
  3: { id: 3, fromSession: 'human/web', room: 'lead-room' }     // the owner, in the lead's room
};
const bridgeDb = {
  getRoom: id => rooms[id] || null,
  cluster: c => [c],
  getMessageById: id => messages[id] || null
};
const router = {
  leadOf: w => (w === HELPER ? { lead: LEAD, room: 'lead-room' } : null),
  same: (a, b) => a === b,
  nameOf: c => c
};
const rules = createRules(bridgeDb, {}, router);
const guard = o => rules.helperGuard(Object.assign({ mine: HELPER, theirs: 'human/web' }, o));

assert.strictEqual(guard({ room: 'other-room', replyTo: 1 }), '', 'answer to the owner where he wrote: allowed');
assert.match(guard({ room: 'other-room' }), /is not its room/, 'no reply: still refused');
assert.match(guard({ room: 'other-room', replyTo: 2 }), /is not its room/, 'reply to another agent: still refused');
assert.match(guard({ room: 'other-room', replyTo: 3 }), /is not its room/, 'owner message from another room: still refused');
assert.strictEqual(guard({ room: 'lead-room' }), '', "the lead's room: allowed as before");
console.log('ok 5/5');
