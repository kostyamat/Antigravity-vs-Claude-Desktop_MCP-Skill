'use strict';
// What wakes a window (mailbox.js isUrgent) and what a new session is told is
// unread (briefFor). Run: node test_mailbox.js
//
// The board is faked: the rule is about addresses, senders and statuses, and a
// real database would only add ways for the test to pass by accident.

const assert = require('assert');
const { createMailbox } = require('./mailbox');

const WIN = 'local_win-a';
const SIBLING = 'local_win-b';          // another window of the same project
const LINE = 'c:/proj';

function board(messages, cursors) {
  const db = {
    resolveSessionAliases: (sid, opts) => (opts && opts.lines === false)
      ? new Set([sid]) : new Set([sid, SIBLING, LINE]),
    getCursor: () => 0,
    readAllMessages: ({ since } = {}) => messages.filter(m => m.id > (since || 0)),
    getDb: () => ({ prepare: () => ({ get: (...keys) => {
      const hits = keys.filter(k => k in (cursors || {})).map(k => cursors[k]);
      return { n: hits.length ? Math.max(...hits) : null };
    } }) })
  };
  const router = { roomAdmits: m => !m.room || m.room !== 'foreign-room' };
  return createMailbox(db, router);
}

let id = 100;
const msg = over => Object.assign({ id: ++id, ts: new Date().toISOString(), from: 'Gemini', fromSession: 'gem-1',
  to: 'all', toSession: '', priority: 'normal', status: 'info', room: 'pair-room', message: 'x' }, over);

const urgent = m => board([m]).urgentFor('Claude', WIN, WIN, 0).length === 1;

// Addressed to the window, to a sibling window of its project, or to the project itself.
assert.ok(urgent(msg({ to: 'Claude', toSession: WIN })), 'sent to this window');
assert.ok(urgent(msg({ to: 'Claude', toSession: SIBLING, status: 'working' })), 'sent to another window of the project');
assert.ok(urgent(msg({ to: 'Claude', toSession: LINE })), 'sent to the project');
assert.ok(!urgent(msg({ to: 'Claude', toSession: 'local_somebody-else' })), 'sent to a window of another project');
assert.ok(!urgent(msg({ to: 'Claude', toSession: WIN, status: 'ack' })), 'a receipt never wakes');

// Mail for the other agent is not ours, whoever wrote it and however urgent.
assert.ok(!urgent(msg({ from: 'Kostiantyn', fromSession: 'human/web', to: 'Gemini' })), 'the owner writing to Gemini');
assert.ok(!urgent(msg({ from: 'Kostiantyn', fromSession: 'human/web', to: 'Gemini', priority: 'P0' })), 'a P0 for Gemini');
assert.ok(!urgent(msg({ from: 'Claude', fromSession: 'other', to: 'Gemini', status: 'answer' })), 'an answer given to Gemini');

// The owner in one of our rooms, and a P0 there.
assert.ok(urgent(msg({ from: 'Kostiantyn', fromSession: 'human/web' })), 'the owner in our room');
assert.ok(urgent(msg({ priority: 'P0' })), 'a P0 in our room');
assert.ok(!urgent(msg({ priority: 'P0', room: 'foreign-room' })), 'a P0 in a room we are not in');

// An agent speaking to the room at large.
assert.ok(urgent(msg({ status: 'question' })), 'a question to the room: somebody is waiting');
assert.ok(urgent(msg({ status: 'blocked' })), 'blocked: somebody is waiting');
assert.ok(!urgent(msg({ status: 'done' })), '"done" to everyone is a notice');
assert.ok(!urgent(msg({ status: 'answer' })), 'an answer to everyone is a notice');
assert.ok(!urgent(msg({ status: 'working' })), 'a status note');
assert.ok(!urgent(msg({ priority: 'fyi' })), 'an fyi');
assert.ok(urgent(msg({ to: 'Claude', status: 'done' })), '"done" naming this agent');
assert.ok(!urgent(msg({ to: 'Claude', status: 'working' })), 'a status note naming this agent');

// Outside any room, only an address or a P0.
assert.ok(!urgent(msg({ room: '', status: 'question' })), 'an agent asking on the square');
assert.ok(urgent(msg({ room: '', from: 'Kostiantyn', fromSession: 'human/web' })), 'the owner on the square');
assert.ok(!urgent(msg({ room: 'foreign-room', from: 'Kostiantyn', fromSession: 'human/web' })), 'the owner in a room we are not in');
assert.ok(urgent(msg({ room: '', priority: 'P0' })), 'a P0 on the square');

// Our own post, and old mail.
assert.ok(!urgent(msg({ from: 'Claude', fromSession: WIN, to: 'Claude', toSession: LINE })), 'our own post');
assert.ok(urgent(msg({ from: 'Claude', fromSession: SIBLING, to: 'Claude', toSession: LINE })), 'a sibling window is somebody else');
assert.ok(!urgent(msg({ to: 'Claude', toSession: WIN, ts: new Date(Date.now() - 25 * 3600e3).toISOString() })), 'a day old');

// The session-start count.
const mine = msg({ to: 'Claude', toSession: WIN, status: 'question' });
const noise = [msg({ room: 'foreign-room' }), msg({ to: 'Gemini' }), msg({ to: 'Claude', toSession: 'local_somebody-else' })];
const note = msg({ status: 'working' });

let b = board([...noise, mine, note], { ['Claude/' + WIN]: 100 }).briefFor('Claude', WIN, WIN);
assert.deepStrictEqual([b.fresh, b.unread, b.urgent], [false, 2, 1], 'counts only what is for this window');
assert.ok(b.last.length === 1 && b.last[0].startsWith('#' + mine.id), 'shows the urgent one');

b = board([...noise, mine, note], { ['Claude/' + WIN]: note.id }).briefFor('Claude', WIN, WIN);
assert.deepStrictEqual([b.fresh, b.unread, b.urgent], [false, 0, 0], 'nothing past its own cursor');

// A window that never read: the agent-wide cursor is not borrowed, history is not counted.
b = board([...noise, mine, note], { Claude: 5 }).briefFor('Claude', WIN, WIN);
assert.deepStrictEqual([b.fresh, b.unread, b.urgent], [true, 0, 1], 'a new window');

console.log('mailbox: all checks passed');
