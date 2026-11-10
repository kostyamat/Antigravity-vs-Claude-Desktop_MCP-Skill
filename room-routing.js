'use strict';
// Which room a message belongs in, and what the owner is still waiting for.
//
// The human reads the board one room at a time. Whatever lands outside the room
// he is looking at is, for him, never said. Leaving the choice to the agents did
// not work: they replied to him on the Square, put a question and its answer in
// two made-up "rooms" that did not exist, and opened new conversations with no
// room at all. So the server decides, in this order:
//
//   1. a room named outright — by id, name or a part of the name — is used if it
//      exists; a name that is not a room is the agent's idea of a topic, and
//      becomes a real room between the two participants, called by that name;
//   2. a reply goes where the message it answers is;
//   3. a helper that names nothing writes to its lead, in their room;
//   4. the one room the two participants share;
//   5. a message to the human, to everyone or to nobody in particular goes to
//      the one room this participant is in.
//
// Everything else is refused, with the rooms to choose from. The server used to
// guess here — the room the window wrote in last, the busiest of several, a new
// room for two windows that shared none, the Square when nothing fitted — and a
// guess is exactly how an answer landed in another line's room, a status report
// on the Square in front of every window, and a room called "Gemini window ed15"
// with one message in it. The Square is the owner's: an agent writes there only
// by saying so (`square: true`) or by answering what the owner wrote there.
//
// A participant is a project, not a window: see project-line.js. Every lookup
// here goes through the line a window is on, so the other account's window of
// the same project is in the same rooms and answers to the same address.

const { projectName, ensureLine } = require('./project-line');

const OWNER_WINDOW_HOURS = 48;
const { answersTo } = require('./owner-waiting');

function isWindowId(s) {
  return /^local_/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
function isHuman(s) { return /^human/i.test(String(s || '')); }

function createRouter(bridgeDb, cardsLib) {
  const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  // Every window of every account, by id. A room is often shared with a window
  // of the other account, and "Claude window 94ee" names nobody.
  let cardCache = { at: 0, map: new Map() };
  const cardOf = card => {
    if (Date.now() - cardCache.at > 15000) {
      const map = new Map();
      try { for (const c of cardsLib.allCards({ allAccounts: true })) map.set(c.id, c); } catch (_) {}
      cardCache = { at: Date.now(), map };
    }
    return cardCache.map.get(card) || null;
  };

  // A line of work named the way a person says it: the folder's own name, or the
  // whole key. '' unless exactly one line answers to it.
  const lineNamed = label => {
    const want = norm(label);
    if (!want) return '';
    let lines = [];
    try { lines = [...bridgeDb.readLines().keys()]; } catch (_) {}
    const exact = lines.filter(l => l.toLowerCase() === String(label).trim().toLowerCase().replace(/\\/g, '/'));
    if (exact.length === 1) return exact[0];
    const byName = lines.filter(l => norm(projectName(l) || l) === want);
    return byName.length === 1 ? byName[0] : '';
  };

  // The window behind whatever a session signed with. A Claude window is known
  // by the id its card carries (local_…); a run of it has an id of its own, which
  // looks like an Antigravity conversation id and is not one. The run resolves to
  // its window first, so a room is never built around a run. A project named by
  // its folder resolves to its line, which every function below accepts in place
  // of a window.
  const windowOf = label => {
    const s = String(label || '').trim();
    if (!s || s === 'all') return '';
    if (isHuman(s) || /^local_/.test(s)) return s;
    try {
      const w = cardsLib.claudeWindowOfCli && cardsLib.claudeWindowOfCli(s);
      if (w) return w.id;
    } catch (_) {}
    let aliases = [];
    try { aliases = [...bridgeDb.resolveSessionAliases(s, { lines: false })]; } catch (_) {}
    const locals = aliases.filter(a => /^local_/.test(a));
    if (locals.length === 1) return locals[0];
    if (isWindowId(s)) return s;
    for (const a of aliases) if (isWindowId(a)) return a;
    return lineNamed(s);
  };

  // The stable address of a participant: the line its window is on (the project),
  // else the window itself. A Claude window joins the line of its folder here,
  // the first time the board hears of it.
  const addressOf = label => {
    const w = windowOf(label);
    if (!w || isHuman(w)) return w;
    if (/^local_/.test(w) && !bridgeDb.lineOf(w)) {
      const c = cardOf(w);
      if (c && c.project) ensureLine(bridgeDb, w, c.project, 'Claude');
    }
    return bridgeDb.addressOf(w);
  };
  const same = (a, b) => Boolean(a) && Boolean(b) && addressOf(a) === addressOf(b);

  // Whose window an id is. A Claude window is local_…; a project line is its
  // members'; and an id shaped like an Antigravity conversation is one unless the
  // board has seen Claude sign with it — the id of a run that has since ended,
  // which no card remembers. Such a run was once listed as "Gemini window ed15".
  const claudeRuns = new Map();
  const agentOf = card => {
    const c = String(card || '');
    if (/^local_/.test(c)) return 'Claude';
    try {
      const m = bridgeDb.lineMembers(c);
      if (m.length) return m[0].agent || (/^local_/.test(m[0].member) ? 'Claude' : 'Gemini');
    } catch (_) {}
    if (!claudeRuns.has(c)) {
      let seen = false;
      try {
        const db = bridgeDb.getDb();
        seen = Boolean(db.prepare("SELECT 1 FROM messages WHERE from_session = ? AND from_agent = 'Claude' LIMIT 1").get(c)) &&
               !db.prepare("SELECT 1 FROM messages WHERE from_session = ? AND from_agent = 'Gemini' LIMIT 1").get(c);
      } catch (_) {}
      if (!seen) return 'Gemini';          // not cached: it may still sign as Claude later
      claudeRuns.set(c, true);
    }
    return 'Claude';
  };

  // What to call a participant. The project's folder name first: the window's
  // own name is whatever the client made of its first sentence, and it changes.
  const nameOf = card => {
    const c = String(card || '');
    let line = '';
    try { line = bridgeDb.lineOf(c) || (bridgeDb.lineMembers(c).length ? c : ''); } catch (_) {}
    if (line) return projectName(line) || line;
    const k = cardOf(c);
    if (k && k.name) return k.name;
    return agentOf(c) + ' window ' + c.replace(/^local_/, '').slice(0, 4);
  };
  const short = s => {
    s = String(s || '');
    if (s.length <= 28) return s;
    const cut = s.slice(0, 28), sp = cut.lastIndexOf(' ');
    return (sp > 12 ? cut.slice(0, sp) : cut).trim() + '…';
  };

  const account = () => { try { return cardsLib.currentAccount() || ''; } catch (_) { return ''; } };
  const roomLabel = id => { const r = bridgeDb.getRoom(id); return r ? `"${r.name}" [${r.id}]` : id; };

  const leadOf = win => {
    const me = addressOf(win);
    if (!me) return null;
    try { return bridgeDb.readHelpers().find(h => addressOf(h.helper) === me) || null; } catch (_) { return null; }
  };

  const roomOfPair = (mine, theirs, name) => {
    if (!mine || !theirs || same(mine, theirs) || isHuman(theirs)) return null;
    const count = () => bridgeDb.getDb().prepare('SELECT COUNT(*) n FROM rooms').get().n;
    const before = count();
    // createRoom returns the existing room when these two already have one.
    const room = bridgeDb.createRoom(
      name || short(nameOf(mine)) + ' ↔ ' + short(nameOf(theirs)),
      [{ card: mine, agent: agentOf(mine) }, { card: theirs, agent: agentOf(theirs) }],
      account());
    return { room, isNew: count() > before };
  };

  // Returns { room, opened, refuse }. `opened` is set when this call made the
  // room, so the sender can be told where its conversation now lives. `refuse`
  // is the reason nothing may be recorded; the caller hands it to the agent.
  function resolve(a, toAgent, toSession, replyTo) {
    const mine = windowOf(a.canonicalId) || windowOf(a.sessionId);
    const theirs = windowOf(toSession);
    const named = String(a.room || '').trim();
    try {
      // A room the sender names that exists wins over everything, the parent's
      // room included: the owner opens a room to move a conversation into it,
      // and an answer to a message from elsewhere must land where he asked.
      const found = named ? findRoom(named, [mine]) : null;
      if (found) return { room: found.id };

      if (replyTo) {
        const parent = bridgeDb.getMessageById(replyTo);
        if (parent && parent.room && bridgeDb.getRoom(parent.room)) return { room: parent.room };
        // The owner wrote on the Square: the answer is read there, next to it —
        // and so is the rest of the thread he started there.
        if (parent && !parent.room) {
          let top = parent;
          for (let i = 0; i < 30 && top && top.replyTo && !isHuman(top.fromSession); i++) top = bridgeDb.getMessageById(top.replyTo);
          if (top && isHuman(top.fromSession)) return { room: '' };
        }
      }

      if (named) {
        const made = roomOfPair(mine, isHuman(theirs) ? '' : theirs, named);
        if (made) return { room: made.room.id, opened: made.isNew ? made.room : null };
        return { room: '', refuse: `no room matches "${named}" (list_rooms shows them), and a new room needs the other ` +
          'participant: pass toSession with its id or project, or use create_room.' };
      }

      if (a.square === true) return { room: '' };

      const here = mine ? bridgeDb.roomsOfCard(mine) : [];
      const list = ids => ids.slice(0, 8).map(roomLabel).join(', ');

      // A helper that names nothing means its lead.
      const boss = leadOf(mine);
      if (boss && boss.room && bridgeDb.getRoom(boss.room) && (!theirs || isHuman(theirs) || same(theirs, boss.lead))) {
        return { room: boss.room };
      }

      if (mine && theirs && !isHuman(theirs)) {
        const shared = bridgeDb.roomsOfCard(theirs).filter(r => here.includes(r));
        if (shared.length === 1) return { room: shared[0] };
        if (shared.length > 1) {
          return { room: '', refuse: `you share ${shared.length} rooms with "${nameOf(theirs)}": ${list(shared)}. ` +
            'Say which — room: "<id>".' };
        }
        return { room: '', refuse: `you share no room with "${nameOf(theirs)}" [${theirs}]. Open one first: ` +
          `create_room({name: "…", cards: ["${mine}", "${theirs}"]}) — then post with room: "<id>".` };
      }

      if (here.length === 1) return { room: here[0] };
      if (here.length > 1) {
        return { room: '', refuse: `name the room. You are in ${here.length}: ${list(here)}. Post with room: "<id>" ` +
          '(or replyTo a message that is in it).' };
      }
      return { room: '', refuse: (mine ? 'you are in no room' : 'the board does not know which window you are') +
        ', so this would land on the Square, in front of every window. Post with room: "<id>" (list_rooms), ' +
        'reply to a message with replyTo, or — only when the owner asked you to speak to everyone — pass square: true.' };
    } catch (e) {
      const id = named && bridgeDb.getRoom(named) ? named : '';
      return id ? { room: id } : { room: '', refuse: 'the room could not be worked out (' + e.message + '); pass room: "<id>".' };
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
        : later.some(n => answersTo(m, n));
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
    const mine = new Set();
    for (const x of (myWindow || [])) {
      if (!x) continue;
      for (const c of bridgeDb.cluster(String(x))) mine.add(c.toLowerCase());
    }
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
      const want = norm(q);
      if (!want) return null;
      const rooms = bridgeDb.readRooms();
      const named = rooms.filter(r => norm(r.name) === want);
      if (named.length === 1) return bridgeDb.getRoom(named[0].id);
      const words = want.split(' ');
      let close = rooms.filter(r => { const n = norm(r.name) + ' ' + norm(r.id); return words.every(w => n.includes(w)); });
      // Several match: the one the asking window is in is the one it means.
      if (close.length > 1 && myWindow) {
        const mine = new Set();
        for (const x of [...myWindow].filter(Boolean)) for (const c of bridgeDb.cluster(String(x))) mine.add(c);
        close = close.filter(r => (r.members || []).some(m => mine.has(String(m.card))));
      }
      return close.length === 1 ? bridgeDb.getRoom(close[0].id) : null;
    } catch (_) { return null; }
  }

  return { resolve, ownerWaiting, windowOf, addressOf, same, roomAdmits, findRoom, nameOf, cardOf, agentOf, leadOf };
}

module.exports = { createRouter, isHuman, isWindowId };
