'use strict';
// An invitation into a room is one act: the window becomes a member and is told,
// in the same breath, how to join. Before this, the board only added the member;
// the owner then copied the room id, opened the window's chat, pasted it, and
// waited while the agent worked out what to do with it.
//
// The text is shared by every way a window gets invited — the owner on the board,
// an agent with invite_to_room — so there is one wording to keep right. The calls
// come first: the Antigravity waker passes on only the first 300 characters.
// It names the window, which also keeps two invitations from looking like one
// duplicated post to the board's duplicate guard.

const PREFIX = 'Room invitation';

function inviteText(room, { name = '', card = '', why = '' } = {}) {
  const id = room.id;
  const who = name || card;
  return `${PREFIX}${who ? ' for ' + who : ''}: "${room.name}", room id ${id}.\n` +
    `Join now: get_messages({room: "${id}", only: "all"}), then list_docs({room: "${id}"}). ` +
    `Answer in the room: post_message with room: "${id}".` +
    (String(why).trim() ? `\n\n${String(why).trim()}` : '');
}

// A window that was not running when it was invited — a Claude window with no
// watchman, a closed one — learns of it the next time it looks: the rooms it is
// in and the invitations it has not acted on travel with every get_messages and
// with the brief at session start. "Go to the room you were invited to" then
// needs nothing more from the owner.
//
// An invitation is acted on once the window has written in that room.
function roomsOfWindow(bridgeDb, myWindow, board) {
  const mine = new Set([...myWindow].filter(Boolean).map(String));
  const ids = new Set();
  for (const w of mine) for (const r of bridgeDb.roomsOfCard(w)) ids.add(r);
  const rooms = [...ids].map(id => bridgeDb.getRoom(id)).filter(Boolean)
    .map(r => ({ id: r.id, name: r.name }));
  const invited = [];
  for (const m of board) {
    if (!String(m.message || '').startsWith(PREFIX) || !m.room || !mine.has(String(m.toSession || ''))) continue;
    const r = rooms.find(x => x.id === m.room);
    if (!r || invited.some(x => x.id === r.id)) continue;
    const spoke = board.some(n => n.id > m.id && n.room === m.room && mine.has(String(n.fromSession || '')));
    if (!spoke) invited.push(Object.assign({ message: m.id }, r));
  }
  return { rooms, invited };
}

function describeRooms({ rooms, invited }) {
  const out = [];
  if (invited.length) {
    out.push('📨 Invited, not joined yet: ' + invited.map(r => `"${r.name}" [${r.id}] (#${r.message})`).join(', ') +
      ` — join now: get_messages({room: "<id>", only: "all"}), list_docs({room: "<id>"}), then answer in the room.`);
  }
  if (rooms.length) {
    out.push('🚪 Your rooms: ' + rooms.slice(0, 8).map(r => `"${r.name}" [${r.id}]`).join(', ') +
      (rooms.length > 8 ? ` and ${rooms.length - 8} more (list_rooms)` : '') +
      '. Post into one with room: "<id or name>".');
  }
  return out;
}

module.exports = { inviteText, roomsOfWindow, describeRooms, PREFIX };

// The session-start brief is Python; it asks here rather than repeating the rule.
// node room-invite.js <agent> <sessionId> [canonicalId] → the lines, one per row.
if (require.main === module) {
  try {
    const [agent, session, canonical] = process.argv.slice(2);
    const bridgeDb = require('./bridge-db');
    const ids = [session, canonical].filter(Boolean);
    const myWindow = new Set(ids);
    for (const s of ids) for (const a of bridgeDb.resolveSessionAliases(s, { agent, lines: false })) myWindow.add(a);
    const lines = describeRooms(roomsOfWindow(bridgeDb, myWindow, bridgeDb.readAllMessages()));
    process.stdout.write(lines.join('\n'));
  } catch (_) {}
}
