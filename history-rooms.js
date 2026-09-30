'use strict';
// Rooms out of an old board's history.
//
// Releases up to 2.1 had no rooms: every message sat in one feed. On the first
// install of 2.2 the installer sorts that history into rooms once, so the board
// opens on conversations instead of a crowd.
//
// The seam is the pair of sides, not the topic. A side is a window, or the line
// of work the window is on: one job is often carried by several windows — a
// restart, a continuation, a clone in the other Claude account — and a line says
// which. Without it, one conversation that moved between windows came out as
// three rooms with the same name.
//
// Before lines: the seam is the pair of windows, not the topic. A topic names one exchange and
// there are hundreds of them, which would be the crowd again with doors on it.
// A pair of windows that wrote to each other is a working relationship; it spans
// many topics. Pairs with fewer than MIN_MESSAGES are passing remarks and stay
// on the Square, as does every broadcast.
//
// Documents follow their conversation: a document between the same two windows
// goes into that pair's room.
//
// Runs only when the board has no rooms yet. Once somebody has made a room by
// hand, the history is theirs to arrange.

const MIN_MESSAGES = 5;
const NAME_PART = 26;

// The human writes from the board, and the board is in every room: a
// conversation between the human and one window is that window's room, with
// the window as its only member.
function isHuman(s) { return /^human/i.test(String(s || '')); }

function isWindowId(s) {
  return /^local_/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s);
}

function roomsFromHistory(bridgeDb, cardsLib, options) {
  const opts = Object.assign({ apply: true, minMessages: MIN_MESSAGES }, options || {});
  const raw = bridgeDb.getDb();
  const result = { skipped: '', rooms: 0, messages: 0, docs: 0, leftOnSquare: 0 };

  if (raw.prepare('SELECT COUNT(*) AS n FROM rooms').get().n > 0) {
    result.skipped = 'the board already has rooms';
    return result;
  }

  // A board label resolves to the window behind it; old labels without one
  // stay as they are and still group correctly, only with a plainer name.
  const windows = new Map();
  const windowOf = v => {
    const s = String(v || '').trim();
    if (!s || s === 'all') return '';
    if (windows.has(s)) return windows.get(s);
    let out = s;
    try {
      for (const a of bridgeDb.resolveSessionAliases(s)) {
        if (isWindowId(a)) { out = a; break; }
      }
    } catch (_) {}
    windows.set(s, out);
    return out;
  };

  const names = {};
  try {
    for (const s of Object.values(bridgeDb.readSessions() || {})) {
      const n = s && (s.customName || s.title);
      if (!n) continue;
      if (s.canonicalId) names[s.canonicalId] = n;
      if (s.sessionId) names[s.sessionId] = n;
    }
  } catch (_) {}
  try {
    for (const c of cardsLib.allCards({ names })) if (c.name) names[c.id] = c.name;
  } catch (_) {}

  // An Antigravity window is named by the first line of its conversation, a
  // whole sentence. Each side is cut at a word so the pair fits a sidebar.
  const shortName = id => {
    // A window nobody named is called what the board calls it, not by its id.
    const full = String(names[id] || (isWindowId(id)
      ? (agentOf(id) === 'Gemini' ? 'Antigravity' : 'Claude') + ' window ' + id.replace(/^local_/, '').slice(0, 4)
      : id));
    if (full.length <= NAME_PART) return full;
    const cut = full.slice(0, NAME_PART);
    const sp = cut.lastIndexOf(' ');
    return (sp > 12 ? cut.slice(0, sp) : cut).trim() + '…';
  };

  const agentOf = card => {
    try {
      const row = raw.prepare(
        'SELECT agent FROM sessions WHERE session_id = ? OR canonical_id = ? OR key = ?'
      ).get(card, card, card);
      if (row && row.agent) return row.agent;
    } catch (_) {}
    return /^local_/.test(card) ? 'Claude' : '';
  };

  const lineOfWindow = new Map();
  const sideOf = w => {
    if (!w || isHuman(w)) return w;
    if (!lineOfWindow.has(w)) {
      let line = '';
      try {
        for (const a of bridgeDb.resolveSessionAliases(w, { lines: false })) {
          line = bridgeDb.lineOf(a) || '';
          if (line) break;
        }
      } catch (_) {}
      lineOfWindow.set(w, line);
    }
    const line = lineOfWindow.get(w);
    return line ? 'line:' + line : w;
  };
  const sideName = side => side.startsWith('line:') ? side.slice(5) : shortName(side);

  const messages = bridgeDb.readAllMessages();
  const pairs = new Map();
  for (const m of messages) {
    if (m.room) continue;
    const a = windowOf(m.fromSession);
    const b = windowOf(m.toSession);
    if (!a || !b || a === b || (isHuman(a) && isHuman(b))) continue;
    const sa = sideOf(a), sb = sideOf(b);
    if (sa === sb) continue;                  // two windows of one line talking to themselves
    const key = [sa, sb].sort().join('|');
    if (!pairs.has(key)) pairs.set(key, { sides: key.split('|'), members: new Set(), ids: [] });
    const p = pairs.get(key);
    for (const w of [a, b]) if (!isHuman(w)) p.members.add(w);
    p.ids.push(m.id);
  }
  const chosen = [...pairs.values()].filter(p => p.ids.length >= opts.minMessages);

  result.rooms = chosen.length;
  result.messages = chosen.reduce((n, p) => n + p.ids.length, 0);
  result.leftOnSquare = messages.length - result.messages;

  const docs = raw.prepare("SELECT name, from_session, to_session FROM docs_index WHERE room = ''").all();
  const pairKey = (x, y) => {
    const a = windowOf(x), b = windowOf(y);
    if (!a || !b || a === b) return '';
    const sa = sideOf(a), sb = sideOf(b);
    return sa === sb ? '' : [sa, sb].sort().join('|');
  };
  if (!opts.apply) {
    const keys = new Set(chosen.map(p => p.sides.join('|')));
    result.docs = docs.filter(d => keys.has(pairKey(d.from_session, d.to_session))).length;
    return result;
  }

  let account = '';
  try { account = cardsLib.currentAccount() || ''; } catch (_) {}

  const tag = raw.prepare('UPDATE messages SET room = ? WHERE id = ?');
  const tagDoc = raw.prepare('UPDATE docs_index SET room = ? WHERE name = ?');
  const roomOfPair = new Map();
  // Two windows can carry one name (the same project opened twice), and two
  // rooms called alike cannot be told apart in the list. The later one is numbered.
  const used = new Map();
  const distinct = name => {
    const n = (used.get(name) || 0) + 1;
    used.set(name, n);
    return n === 1 ? name : name + ' (' + n + ')';
  };
  raw.exec('BEGIN');
  try {
    for (const p of chosen) {
      const room = bridgeDb.createRoom(
        distinct(p.sides.filter(x => !isHuman(x)).map(sideName).join(' ↔ ')),
        [...p.members].sort().map(card => ({ card, agent: agentOf(card) })),
        account
      );
      roomOfPair.set(p.sides.join('|'), room.id);
      for (const id of p.ids) tag.run(room.id, id);
    }
    for (const d of docs) {
      const room = roomOfPair.get(pairKey(d.from_session, d.to_session));
      if (room) { tagDoc.run(room, d.name); result.docs++; }
    }
    raw.exec('COMMIT');
  } catch (e) {
    raw.exec('ROLLBACK');
    throw e;
  }
  return result;
}

module.exports = { roomsFromHistory, MIN_MESSAGES };
