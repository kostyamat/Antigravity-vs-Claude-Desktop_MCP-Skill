'use strict';
// What a room can be found by.
//
// A hundred rooms in one list, sorted by what was said last, are found only by
// scrolling. The owner looks for a room by what he remembers of it: the project, the
// task, which agent sits in it — Claude or Antigravity — or the machine it talks to
// (owner, 16.11.2026). None of that is in a room's name by rule; it is in who its
// members are. So every room gets one line of text it can be found by, built here,
// once, for the page's filter and for list_rooms alike:
//
//   its name and id                       — the task is usually in the name
//   every member as it is shown           — the project's folder name, a window's title
//   project:<name>                        — the project of each Claude member
//   task:<title>                          — the title of a helper's conversation
//   agent:claude / agent:antigravity      — with the words people use for them
//   machine:<name>                        — this machine for local members, and every
//                                           linked machine the room has exchanged mail with
//
// A query is words; a room matches when every word is somewhere in its line. A word
// may be one of the prefixed forms above to mean exactly that ("agent:claude").

const fs = require('fs');
const path = require('path');
const { projectName } = require('./project-line');

// The words people call the agents by, in the languages of the page's owner. Kept with
// the other owner-facing words (locales/), since this file holds English only.
let wordsCache = null;
function agentWords() {
  if (!wordsCache) {
    try { wordsCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', 'search.json'), 'utf8')); }
    catch (_) { wordsCache = {}; }
  }
  return wordsCache;
}

function createRoomSearch({ bridgeDb, router, machineName }) {
  const here = String(typeof machineName === 'function' ? machineName() : machineName || '').toLowerCase();

  // room id → the machines it has exchanged mail with
  function peerMachines() {
    const out = new Map();
    try {
      const rows = bridgeDb.getDb().prepare(
        "SELECT DISTINCT m.room AS room, p.machine AS machine FROM peer_refs p JOIN messages m ON m.id = p.local_id WHERE m.room <> ''").all();
      for (const r of rows) out.set(r.room, (out.get(r.room) || new Set()).add(String(r.machine).toLowerCase()));
    } catch (_) {}
    return out;
  }

  // The line of text one room is found by, lower case.
  function lineOf(room, peers) {
    const w = agentWords();
    const bits = [room.name, room.id];
    const agents = new Set(), machines = new Set(peers && peers.get(room.id) || []);
    const named = /^machine:\s*(\S+)/i.exec(room.name || '') || /@\s*([a-z0-9][a-z0-9-]*)\s*$/i.exec(room.name || '');
    if (named) machines.add(named[1].toLowerCase());
    for (const m of room.members || []) {
      const card = String(m.card || '');
      if (!card) continue;
      let shown = '';
      try { shown = router.nameOf(card); } catch (_) {}
      bits.push(shown);
      let line = '';
      try { line = bridgeDb.lineOf(card) || (bridgeDb.lineMembers(card).length ? card : ''); } catch (_) {}
      if (line) bits.push('project:' + (projectName(line) || line), line);
      let c = null;
      try { c = router.cardOf(card); } catch (_) {}
      // Whose window it is: what the room recorded, else what the board can vouch for. An id
      // nobody knows — a window of another machine, a run long gone — is not called
      // Antigravity just because it is not Claude's.
      let agent = m.agent || '';
      if (!agent) {
        if (/^local_/.test(card) || line) agent = 'Claude';
        else if (c) { try { agent = router.agentOf(card); } catch (_) {} }
      }
      if (agent) agents.add(agent === 'Gemini' ? 'antigravity' : agent.toLowerCase());
      if (c) {
        if (c.name) bits.push((agent === 'Gemini' ? 'task:' : '') + c.name);
        if (c.project && !line) bits.push('project:' + path.basename(String(c.project).split(path.sep).join('/')));
        if (here) machines.add(here);                    // a window this machine has a card for
      }
    }
    for (const a of agents) {
      bits.push('agent:' + a, ...(w[a] || []));
      if (a === 'antigravity') bits.push('agent:gemini', 'gemini');
    }
    for (const mc of machines) bits.push('machine:' + mc);
    return bits.filter(Boolean).join(' \n ').toLowerCase();
  }

  // Every room with its `find` line. The page asks for the rooms every few seconds, and a
  // line is built from the cards of every member, so a room's line is kept while its name
  // and its members stay the same, and rebuilt after KEEP_MS in any case (a window is
  // renamed, a project gets a new machine to talk to).
  const KEEP_MS = 5 * 60000;
  const kept = new Map();                          // room id → { sig, find, at }
  let peersKept = { at: 0, map: new Map() };
  function withFind(rooms) {
    const now = Date.now();
    if (now - peersKept.at > 30000) peersKept = { at: now, map: peerMachines() };
    return rooms.map(r => {
      const sig = r.name + '|' + (r.members || []).map(m => m.card).join(',');
      let k = kept.get(r.id);
      if (!k || k.sig !== sig || now - k.at > KEEP_MS) {
        k = { sig, find: lineOf(r, peersKept.map), at: now };
        kept.set(r.id, k);
      }
      return Object.assign({}, r, { find: k.find });
    });
  }

  return { withFind, lineOf, peerMachines };
}

// Does a room's line answer the query? Every word must be in it.
function matches(find, query) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const hay = String(find || '');
  return terms.every(t => hay.includes(t));
}

module.exports = { createRoomSearch, matches };
