'use strict';
// Which urgent messages are still pending for a window. One rule, used by the
// MCP banner, the get_messages header and the session-start brief (which calls
// this file from Python).
//
// A P0 is pending for a window when all of these hold:
//   - it is not the window's own;
//   - it is addressed to this agent or to all, and to this window (or its line)
//     or to no window in particular;
//   - its room, if it has one, has this window as a member;
//   - the window has not read past it;
//   - it is less than P0_TTL_HOURS old. An urgent line nobody acted on in a day
//     is no longer urgent, it is noise — and a banner that never clears teaches
//     everyone to ignore it. Before this, a P0 hung on every new session for as
//     long as it stayed unread: thirty of them, days old, from other rooms.

const P0_TTL_HOURS = 24;

function pendingP0(opts) {
  const { board, agent, myWindow, myLine, cursor, roomAdmits } = opts;
  const now = Date.now();
  const lower = set => new Set([...(set || [])].map(x => String(x).trim().toLowerCase()));
  const win = lower(myWindow), line = lower(myLine);
  return (board || []).filter(m => {
    if (m.priority !== 'P0') return false;
    if ((m.id || 0) <= (cursor || 0)) return false;
    if (now - new Date(m.ts).getTime() > P0_TTL_HOURS * 3600e3) return false;
    if (m.from === agent && win.has(String(m.fromSession || '').trim().toLowerCase())) return false;
    if (m.to && m.to !== 'all' && m.to !== agent) return false;
    if (m.toSession && m.toSession !== 'all' && !line.has(String(m.toSession).trim().toLowerCase())) return false;
    if (roomAdmits && !roomAdmits(m, myWindow)) return false;
    return true;
  });
}

module.exports = { pendingP0, P0_TTL_HOURS };

// CLI for the Python session-start brief:
//   node p0.js <agent> <sessionId> [canonicalId]  ->  {"count":N,"ids":[…],"cursor":N}
// (the window's read cursor too, so the brief counts unread from the same place)
if (require.main === module) {
  try {
    const [agent, session, canonical] = process.argv.slice(2);
    const bridgeDb = require('./bridge-db');
    const router = require('./room-routing').createRouter(bridgeDb, require('./cards'));
    const ids = [session, canonical].filter(Boolean);
    const myWindow = new Set(ids), myLine = new Set(ids);
    for (const s of ids) {
      for (const a of bridgeDb.resolveSessionAliases(s, { agent, lines: false })) myWindow.add(a);
      for (const a of bridgeDb.resolveSessionAliases(s, { agent })) myLine.add(a);
    }
    const cursor = session ? bridgeDb.getCursor(agent, session) : bridgeDb.getCursor(agent);
    const since = Math.max(0, cursor);
    const board = bridgeDb.readAllMessages().filter(m => m.id > since);
    const list = pendingP0({ board, agent, myWindow, myLine, cursor, roomAdmits: router.roomAdmits });
    process.stdout.write(JSON.stringify({ count: list.length, ids: list.map(m => m.id), cursor }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ count: 0, ids: [], error: e.message }));
  }
}
