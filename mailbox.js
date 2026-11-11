'use strict';
// What is addressed to a window, what it wrote itself, and what it must not
// leave unread. One rule, used by get_messages, by the Stop hook that will not
// let a Claude session go idle over unread mail, and by the background watcher
// that wakes an idle one.
//
// Two sets, because they answer different questions. Whether a message is for a
// window follows its line of work — the project: sent to the line, or to another
// window on it, it is this window's to see. Whether a message is the window's own
// echo, and how far it has read, does not: another window of the project posting
// is somebody else talking, and what that window read this one has not seen.

const { isHuman } = require('./room-routing');

const URGENT_STATUSES = ['question', 'blocked', 'done', 'answer'];
// Of those, the two that mean the sender cannot go on until somebody reacts.
const WAITING_STATUSES = ['question', 'blocked'];
// Mail nobody read in a day is no longer a reason to interrupt anybody: it is
// still on the board, and get_messages still shows it.
const URGENT_HOURS = 24;

function createMailbox(bridgeDb, router) {

  function open(reader, sessionId, canonicalId) {
    const sid = String(sessionId || '').trim();
    const myLine = sid ? bridgeDb.resolveSessionAliases(sid, { agent: reader }) : new Set();
    const myWindow = sid ? bridgeDb.resolveSessionAliases(sid, { agent: reader, lines: false }) : new Set();
    const cards = new Set([...myWindow, canonicalId].filter(Boolean));
    const cursor = reader ? bridgeDb.getCursor(reader, sid) : 0;
    const lowerLine = new Set([...myLine].map(x => String(x).trim().toLowerCase()));
    const lowerWindow = new Set([...myWindow].map(x => String(x).trim().toLowerCase()));

    const isForMe = m => {
      if (m.toSession && m.toSession !== 'all') {
        if (!sid) return false;
        if (!lowerLine.has(String(m.toSession).trim().toLowerCase())) return false;
      }
      if (reader && m.to !== reader && m.to !== 'all') return false;
      if (sid && !router.roomAdmits(m, cards)) return false;
      return true;
    };

    const isMyOwn = m => {
      if (!reader) return false;
      if (!sid) return m.from === reader;
      return m.from === reader && lowerWindow.has(String(m.fromSession || '').trim().toLowerCase());
    };

    // Worth interrupting for: sent to this window or its project, a P0, anything
    // the owner wrote in its rooms, and an agent in a room who is waiting on it —
    // never a status note or a receipt, and never old mail.
    //
    // An agent speaking to a room at large is the narrow case. A question or a
    // "blocked" means somebody is waiting, so the room is woken. A "done" or an
    // "answer" wakes only the agent it names: sent to everyone, it is a notice —
    // "stand released", "build finished" — and fifty-five of those in three days
    // each woke every window of the room. They are read on the next get_messages.
    const isUrgent = m => {
      if (!isForMe(m) || isMyOwn(m) || m.status === 'ack') return false;
      if (Date.now() - new Date(m.ts).getTime() > URGENT_HOURS * 3600e3) return false;
      if (m.priority === 'P0') return true;
      if (m.toSession && m.toSession !== 'all') return true;
      if (!m.room) return false;
      if (isHuman(m.fromSession)) return true;
      if (WAITING_STATUSES.includes(m.status)) return true;
      return m.to === reader && URGENT_STATUSES.includes(m.status);
    };

    return { myLine, myWindow, cards, cursor, isForMe, isMyOwn, isUrgent };
  }

  // Unread and urgent for this window, oldest first. `after` overrides the read
  // cursor (the watcher only cares about what arrived since it started).
  function urgentFor(reader, sessionId, canonicalId, after) {
    const box = open(reader, sessionId, canonicalId);
    const since = typeof after === 'number' ? after : box.cursor;
    return bridgeDb.readAllMessages({ since: Math.max(0, since) }).filter(box.isUrgent);
  }

  // What a window finds on the board when its session starts: how much is unread
  // for it, counted from its own read cursor, and what of that will not wait.
  //
  // The cursor is the window's own or none. A window that has never read has no
  // cursor, and borrowing the agent-wide one — which stops moving once windows
  // keep their own — made every new session open with "1006 unread", nearly all
  // of it other projects' talk. Such a window is `fresh`: nothing is counted
  // against it, and it is shown only what is urgent for it from the last day.
  function briefFor(reader, sessionId, canonicalId) {
    const box = open(reader, sessionId, canonicalId);
    const own = ownCursor(reader, sessionId);
    const fresh = own === null;
    const board = bridgeDb.readAllMessages({ since: fresh ? 0 : own });
    const urgent = board.filter(box.isUrgent);
    const unread = fresh ? [] : board.filter(m => box.isForMe(m) && !box.isMyOwn(m));
    return { fresh, cursor: fresh ? 0 : own, unread: unread.length, urgent: urgent.length,
             last: (urgent.length ? urgent : unread).slice(-3).map(oneLine) };
  }

  // The read cursor kept under this window's own names, or null when it has none.
  function ownCursor(reader, sessionId) {
    const sid = String(sessionId || '').trim();
    if (!reader || !sid) return null;
    const keys = [...bridgeDb.resolveSessionAliases(sid, { agent: reader, lines: false })].map(a => `${reader}/${a}`);
    if (!keys.length) return null;
    const row = bridgeDb.getDb().prepare(
      `SELECT MAX(last_read_id) n FROM cursors WHERE reader IN (${keys.map(() => '?').join(',')})`).get(...keys);
    return row && row.n !== null ? Number(row.n) || 0 : null;
  }

  return { open, urgentFor, briefFor };
}

function oneLine(m) {
  return `#${m.id} ${m.from}${m.room ? ' [' + m.room + ']' : ''}${m.status && m.status !== 'info' ? ' ' + m.status : ''}: ` +
    String(m.message || '').replace(/\s+/g, ' ').slice(0, 110);
}

module.exports = { createMailbox, oneLine, URGENT_STATUSES, WAITING_STATUSES };

// CLI for the Python side, so the watchman and the session-start brief ask this
// rule instead of keeping a copy of it (the watchman's copy had drifted: it woke
// a Claude window for mail sent to Gemini):
//   node mailbox.js urgent <agent> <window> <afterId>  ->  {"list":[{id, priority, status, topic, toSession, fromSession, message}]}
//   node mailbox.js brief  <agent> <window>            ->  {"fresh":bool, "cursor":N, "unread":N, "urgent":N, "last":["#id …"]}
if (require.main === module) {
  const [mode, agent, win, after] = process.argv.slice(2);
  try {
    const bridgeDb = require('./bridge-db');
    const router = require('./room-routing').createRouter(bridgeDb, require('./cards'));
    const mailbox = createMailbox(bridgeDb, router);
    if (mode === 'brief') {
      process.stdout.write(JSON.stringify(mailbox.briefFor(agent, win, win)));
    } else {
      const list = mailbox.urgentFor(agent, win, win, Number(after) || 0).map(m => ({
        id: m.id, priority: m.priority || 'normal', status: m.status || '', topic: m.topic || '',
        toSession: m.toSession || '', fromSession: m.fromSession || '',
        message: String(m.message || '').replace(/\s+/g, ' ').slice(0, 150) }));
      process.stdout.write(JSON.stringify({ list }));
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e.message }));
  }
}
