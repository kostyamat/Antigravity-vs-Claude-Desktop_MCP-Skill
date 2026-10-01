'use strict';
// Which room a message belongs in, and what the owner is still waiting for.
//
// The human reads the board one room at a time. Whatever lands outside the room
// he is looking at is, for him, never said. Leaving the choice to the agents did
// not work: they replied to him on the Square, put a question and its answer in
// two made-up "rooms" that did not exist, and opened new conversations with no
// room at all. So the server decides, in this order:
//
//   1. a reply goes where the message it answers is;
//   2. a room named outright — by id, name or a part of the name — is used if it
//      exists; a name that is not a room is
//      the agent's idea of a topic, and becomes a real room between the two
//      windows, called by that name;
//   3. a message to the human, to everyone or to no window in particular goes
//      to the room this window is talking in — where the owner last wrote among
//      its rooms, else where it last wrote; the Square only for a window with no
//      recent room;
//   4. the one room the two windows share — the busiest, if they share several;
//   5. a conversation between two windows that share none opens a room for them.
//
// A window whose id the server cannot see (Claude Desktop has no way to report
// one) gets the old behaviour: a named room or none.

const OWNER_WINDOW_HOURS = 48;

function isWindowId(s) {
  return /^local_/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
function isHuman(s) { return /^human/i.test(String(s || '')); }

function createRouter(bridgeDb, cardsLib) {
  const windowOf = label => {
    const s = String(label || '').trim();
    if (!s || s === 'all') return '';
    if (isWindowId(s) || isHuman(s)) return s;
    try {
      for (const a of bridgeDb.resolveSessionAliases(s, { lines: false })) if (isWindowId(a)) return a;
    } catch (_) {}
    return '';
  };

  const agentOf = card => /^local_/.test(card) ? 'Claude' : 'Gemini';

  const nameOf = card => {
    try {
      const c = cardsLib.allCards({}).find(x => x.id === card);
      if (c && c.name) return c.name;
    } catch (_) {}
    return agentOf(card) + ' window ' + String(card).replace(/^local_/, '').slice(0, 4);
  };
  const short = s => {
    s = String(s || '');
    if (s.length <= 28) return s;
    const cut = s.slice(0, 28), sp = cut.lastIndexOf(' ');
    return (sp > 12 ? cut.slice(0, sp) : cut).trim() + '…';
  };

  const account = () => { try { return cardsLib.currentAccount() || ''; } catch (_) { return ''; } };

  const roomOfPair = (mine, theirs, name) => {
    if (!mine || !theirs || mine === theirs || isHuman(theirs)) return null;
    const count = () => bridgeDb.getDb().prepare('SELECT COUNT(*) n FROM rooms').get().n;
    const before = count();
    // createRoom returns the existing room when these two already have one.
    const room = bridgeDb.createRoom(
      name || short(nameOf(mine)) + ' ↔ ' + short(nameOf(theirs)),
      [{ card: mine, agent: agentOf(mine) }, { card: theirs, agent: agentOf(theirs) }],
      account());
    return { room, isNew: count() > before };
  };

  const busiest = ids => {
    if (ids.length < 2) return ids[0] || '';
    const n = id => bridgeDb.getDb().prepare('SELECT MAX(id) m FROM messages WHERE room = ?').get(id).m || 0;
    return ids.slice().sort((x, y) => n(y) - n(x))[0];
  };

  // Returns { room, opened } — opened is set when this call made the room, so the
  // sender can be told where its conversation now lives.
  function resolve(a, toAgent, toSession, replyTo) {
    const mine = windowOf(a.canonicalId) || windowOf(a.sessionId);
    const theirs = windowOf(toSession);
    try {
      if (replyTo) {
        const parent = bridgeDb.getMessageById(replyTo);
        if (parent && parent.room && bridgeDb.getRoom(parent.room)) return { room: parent.room };
      }

      const named = String(a.room || '').trim();
      if (named) {
        const found = findRoom(named, [mine]);
        if (found) return { room: found.id };
        const made = roomOfPair(mine, theirs, named);
        return made ? { room: made.room.id, opened: made.isNew ? made.room : null } : { room: '' };
      }

      // A message to the owner, to everyone, or to "any Gemini" names no window to
      // share a room with. It goes where this window is talking: the room the
      // owner last wrote in among its rooms, else the one it last wrote in itself.
      // The Square belongs to the owner — "if I want everyone, I go to the Square"
      // — and an agent answering a room by broadcasting there took a room's urgent
      // note to every window on the machine.
      const toHuman = isHuman(toSession) || (toAgent && !['Claude', 'Gemini', 'all'].includes(toAgent));
      if ((toHuman || !theirs) && mine) {
        const rooms = new Set(bridgeDb.roomsOfCard(mine));
        if (!rooms.size) return { room: '' };
        const since = new Date(Date.now() - OWNER_WINDOW_HOURS * 3600e3).toISOString();
        const recent = bridgeDb.getDb().prepare(
          "SELECT room, from_session FROM messages WHERE room <> '' AND ts > ? ORDER BY id DESC"
        ).all(since).filter(r => rooms.has(r.room));
        const mineSet = new Set([mine, a.sessionId, a.canonicalId].filter(Boolean).map(String));
        const last = recent.find(r => isHuman(r.from_session)) ||
                     recent.find(r => mineSet.has(String(r.from_session)));
        return { room: last ? last.room : '' };
      }

      if (!mine || !theirs) return { room: '' };
      const here = new Set(bridgeDb.roomsOfCard(mine));
      const shared = bridgeDb.roomsOfCard(theirs).filter(r => here.has(r));
      if (shared.length) return { room: busiest(shared) };

      const made = roomOfPair(mine, theirs);
      return made ? { room: made.room.id, opened: made.isNew ? made.room : null } : { room: '' };
    } catch (_) {
      return { room: String(a.room || '').trim() && bridgeDb.getRoom(String(a.room).trim()) ? String(a.room).trim() : '' };
    }
  }

  // The owner's messages this window owes an answer to. A message addressed to
  // this window needs this window's answer; one written to a room it is in needs
  // an answer from somebody in that room — one, not every member.
  function ownerWaiting(board, myWindow, isMyOwn) {
    const mineSet = new Set([...myWindow].map(String));
    const rooms = new Set();
    for (const w of mineSet) for (const r of bridgeDb.roomsOfCard(w)) rooms.add(r);
    const since = Date.now() - OWNER_WINDOW_HOURS * 3600e3;
    const out = [];
    for (let i = 0; i < board.length; i++) {
      const m = board[i];
      if (!isHuman(m.fromSession) || new Date(m.ts).getTime() < since) continue;
      const toMe = m.toSession && mineSet.has(String(m.toSession));
      const inMyRoom = m.room && rooms.has(m.room);
      if (!toMe && !inMyRoom) continue;
      const later = board.slice(i + 1);
      const answered = toMe
        ? later.some(n => isMyOwn(n) && (n.replyTo === m.id || !m.room || n.room === m.room))
        : later.some(n => !isHuman(n.fromSession) && (n.replyTo === m.id || n.room === m.room));
      if (!answered) out.push(m);
    }
    return out;
  }

  // Is a message for this window, as far as rooms go? A message in a room that
  // is not addressed to one window is for the room's members and nobody else —
  // urgent or not. One answer for every place that asks: the P0 banner and the
  // "for me" filter here; the Antigravity waker and the Claude watchman apply the
  // same rule in their own process.
  function roomAdmits(m, myWindow) {
    const room = String((m && m.room) || '');
    if (!room) return true;
    if (m.toSession && m.toSession !== 'all') return true;   // addressed: the address decides
    let r = null;
    try { r = bridgeDb.getRoom(room); } catch (_) { return true; }
    if (!r) return true;                                     // a room that no longer exists hides nothing
    const mine = new Set([...(myWindow || [])].map(x => String(x).toLowerCase()));
    return (r.members || []).some(x => mine.has(String(x.card).toLowerCase()));
  }

  // A room as the owner says it: "in the debug room, ask…". The agent passes the
  // id, the name, or a part of the name; the one room that matches is used. Of
  // several, the one the asking window is in; still several is no match —
  // guessing would post into the wrong conversation.
  function findRoom(text, myWindow) {
    const q = String(text || '').trim();
    if (!q) return null;
    try {
      const exact = bridgeDb.getRoom(q);
      if (exact) return exact;
      const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const want = norm(q);
      if (!want) return null;
      const rooms = bridgeDb.readRooms(account());
      const named = rooms.filter(r => norm(r.name) === want);
      if (named.length === 1) return bridgeDb.getRoom(named[0].id);
      const words = want.split(' ');
      let close = rooms.filter(r => { const n = norm(r.name) + ' ' + norm(r.id); return words.every(w => n.includes(w)); });
      // Several match: the one the asking window is in is the one it means.
      if (close.length > 1 && myWindow) {
        const mine = new Set([...myWindow].filter(Boolean).map(String));
        close = close.filter(r => (r.members || []).some(m => mine.has(String(m.card))));
      }
      return close.length === 1 ? bridgeDb.getRoom(close[0].id) : null;
    } catch (_) { return null; }
  }

  return { resolve, ownerWaiting, windowOf, roomAdmits, findRoom };
}

module.exports = { createRouter, isHuman, isWindowId };
