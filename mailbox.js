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

    // Worth interrupting for: named to this participant, anything the owner
    // wrote in its rooms, or something there that asks, answers or reports —
    // never a status note or a receipt, and never old mail.
    const isUrgent = m => {
      if (!isForMe(m) || isMyOwn(m) || m.status === 'ack') return false;
      if (Date.now() - new Date(m.ts).getTime() > URGENT_HOURS * 3600e3) return false;
      if (m.priority === 'P0') return true;
      if (m.toSession && m.toSession !== 'all') return true;
      if (!m.room) return false;
      return isHuman(m.fromSession) || URGENT_STATUSES.includes(m.status);
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

  return { open, urgentFor };
}

function oneLine(m) {
  return `#${m.id} ${m.from}${m.room ? ' [' + m.room + ']' : ''}${m.status && m.status !== 'info' ? ' ' + m.status : ''}: ` +
    String(m.message || '').replace(/\s+/g, ' ').slice(0, 110);
}

module.exports = { createMailbox, oneLine, URGENT_STATUSES };
