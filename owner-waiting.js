'use strict';
// What became of a message the owner wrote: was it read, was it answered, by whom, how fast.
//
// The owner gives his orders and asks his questions on the board, and the board is where
// he waits. An agent that reads his message and goes off to work for half an hour without
// a word leaves him to walk through the chats to find out whether it even woke up. So the
// board keeps one rule about it, used in four places:
//
//   * the board page shows, under each message of his, "not read yet", "read, no reply"
//     or "answered in 20 s" (receipts);
//   * the MCP server names the unanswered ones at the top of get_messages for the window
//     that owes the reply (room-routing.js ownerWaiting, which uses answersTo from here);
//   * the waker's prompt and the supervisor's reminder say the same thing;
//   * PROTOCOL.md states it for the agents: the reply comes first, the work after.
//
// A reply is a message from an agent with replyTo = the owner's message. The supervisor's
// own reminder is not a reply.

const TTL_HOURS = 24;
const SUPERVISOR = 'supervisor/board';

const isOwner = m => /^human/i.test(String(m.fromSession || ''));
const isAgentReply = m => !isOwner(m) && String(m.fromSession || '') !== SUPERVISOR;

// The owner's messages that expect someone in particular: addressed to an agent, or said
// in a room. A broadcast on the Square is nobody's to answer.
function expectsReply(m) {
  if (!isOwner(m)) return false;
  const named = m.to && m.to !== 'all';
  return !!(named || m.room || (m.toSession && m.toSession !== 'all'));
}

// The answer to the owner's message at board[i]: the first later message from an agent
// that replies to it by number, or — in a room — is said there by the agent he asked
// (by any agent when he asked nobody by name). One definition, used by the board page,
// by the supervisor and by room-routing.js (what a window still owes him).
function answersTo(m, n) {
  if (!isAgentReply(n)) return false;
  if (n.replyTo === m.id) return true;
  if (!m.room || n.room !== m.room) return false;
  if (m.to && m.to !== 'all' && n.from !== m.to) return false;
  // Asked of one window: another window of the same agent talking in the room is not its answer.
  const one = String(m.toSession || '').toLowerCase();
  return !one || one === 'all' || String(n.fromSession || '').toLowerCase() === one;
}

function answersOf(board, i) {
  const m = board[i], out = [];
  for (let k = i + 1; k < board.length; k++) if (answersTo(m, board[k])) out.push(board[k]);
  return out;
}

// { id: { asked, read, readBy, first: {id, from, status, afterSec}, last: {id, status}, waitingMin } }
function receipts(board, now) {
  now = now || Date.now();
  const out = {};
  for (let i = 0; i < board.length; i++) {
    const m = board[i];
    if (!expectsReply(m)) continue;
    const age = now - Date.parse(m.ts);
    if (!(age < TTL_HOURS * 3600e3)) continue;
    // In a room the talk moves on: only what was said before his next message there counts.
    let mine = answersOf(board, i);
    const next = board.findIndex((n, k) => k > i && isOwner(n) && (n.room || '') === (m.room || ''));
    if (next > 0) mine = mine.filter(n => n.replyTo === m.id || n.id < board[next].id);
    const readers = (m.readBy || []).map(String).filter(r => !/^human/i.test(r));
    const asked = m.to && m.to !== 'all' ? m.to : '';
    const read = asked ? readers.some(r => r.split('/')[0] === asked) : readers.length > 0;
    const first = mine[0], last = mine[mine.length - 1];
    out[m.id] = {
      asked, room: m.room || '', to: m.to || 'all', toSession: m.toSession || '',
      read: read || !!first, readBy: [...new Set(readers.map(r => r.split('/')[0]))],
      first: first ? { id: first.id, from: first.from, status: first.status || 'info',
                       afterSec: Math.max(0, Math.round((Date.parse(first.ts) - Date.parse(m.ts)) / 1000)) } : null,
      last: last && last !== first ? { id: last.id, status: last.status || 'info' } : null,
      waitingMin: first ? 0 : Math.floor(age / 60000)
    };
  }
  // He often writes one thought in two or three messages. The earlier pieces are answered
  // by the answer to the last one: said in the same room to the same addressee, before any reply.
  for (let i = board.length - 2; i >= 0; i--) {
    const m = board[i], r = out[m.id];
    if (!r || r.first || !m.room) continue;
    const next = board.slice(i + 1).find(n => isOwner(n) && n.room === m.room);
    const nr = next && out[next.id];
    if (nr && nr.first && (next.to || 'all') === (m.to || 'all') && (next.toSession || '') === (m.toSession || '')) {
      out[m.id] = Object.assign({}, r, { read: true, first: nr.first, last: nr.last, waitingMin: 0 });
    }
  }
  return out;
}

// What an agent is told, in the waker's prompt, the server's banner and the supervisor's reminder.
const RULE = 'Reply to the owner on the board FIRST, before any other work: if he asked a question, the answer to it; ' +
  'otherwise one line saying what you are going to do. Then do the work, then post the result as a second reply.';

module.exports = { receipts, answersOf, answersTo, expectsReply, isOwner, RULE, TTL_HOURS };
