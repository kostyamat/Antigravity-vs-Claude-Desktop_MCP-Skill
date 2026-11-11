'use strict';
// What a call must satisfy before the board records anything: who is speaking,
// and whether they may speak to whom they named.
//
// Both were left to the agents, and both failed the same way — quietly. A helper
// signed a report with the name of its sandbox folder; the answer went to that
// name, the helper went on listening under its real id, and it stood idle for
// twenty-five minutes. A status report was signed with nothing at all and landed
// on the Square. A helper answered a task another line's lead had written to it.
// A wrong signature is not an error anybody sees: the message is recorded, and
// then it is simply never read. So the server refuses here, and says what to
// pass instead.

const { isWindowId, isHuman } = require('./room-routing');

const AGENTS = ['Claude', 'Gemini'];

function createRules(bridgeDb, cardsLib, router) {

  // Who is calling, by what the client can vouch for.
  //
  // Returns { agent, sessionId, canonicalId, title, note } or { error }.
  // `strict` is for calls that write: a reader with a bad signature still gets
  // to read, and is told.
  function identify(a, agentName, strict) {
    let agent = agentName || '';
    let sid = String(a.sessionId || '').trim();
    let canon = String(a.canonicalId || a.canonical_id || '').trim();
    const notes = [];

    // `sender: "<window id>"` with no sessionId: the id was put in the wrong
    // field. It says who is speaking well enough to be used.
    const rawWho = String(a.sender || a.reader || a.agent || '').trim();
    if (isWindowId(rawWho)) {
      if (!sid) sid = rawWho;
      const viaCard = cardsLib.claudeWindowOfCli(rawWho);
      agent = (/^local_/.test(rawWho) || viaCard) ? 'Claude' : 'Gemini';
      notes.push(`sender is "${agent}" — the id belongs in sessionId`);
    }
    if (!AGENTS.includes(agent)) return { agent, sessionId: sid, canonicalId: canon, note: '' };

    if (agent === 'Claude') {
      // The window, from whichever field carries something the client issued.
      let win = '';
      for (const x of [canon, sid]) {
        if (!x) continue;
        if (/^local_/.test(x)) { win = x; break; }
        const w = cardsLib.claudeWindowOfCli(x);
        if (w) { win = w.id; break; }
      }
      if (!win && sid) {
        const w = router.windowOf(sid);
        if (/^local_/.test(w)) win = w;
      }
      if (win) {
        if (sid && sid !== win) { try { bridgeDb.registerSessionAlias(sid, win); bridgeDb.adoptCard(sid, win, 'Claude'); } catch (_) {} }
        const card = router.cardOf(win);
        router.addressOf(win);                       // joins the line of its project folder
        return { agent, sessionId: win, canonicalId: win, title: (card && card.name) || '',
                 cwd: (card && card.project) || '', note: notes.join('; ') };
      }
      if (!sid && strict) {
        return { error: '`sessionId` is required — the id the session-start hook printed for this window. ' +
          'Nothing was recorded.' };
      }
      return { agent, sessionId: sid, canonicalId: canon, note: notes.join('; ') };
    }

    // Antigravity: a conversation is its id. One server process serves every
    // conversation of the app, so there is nothing to fall back on — a signature
    // that is not a conversation id cannot be traced to one.
    if (!sid) {
      if (!strict) return { agent, sessionId: '', canonicalId: canon, note: '' };
      return { error: '`sessionId` is required: the id of your own conversation. ' + geminiHint() + ' Nothing was recorded.' };
    }
    if (isWindowId(sid)) return { agent, sessionId: sid, canonicalId: canon || sid, note: notes.join('; ') };
    const w = router.windowOf(sid);
    if (w && isWindowId(w) && !/^local_/.test(w)) {
      notes.push(`signed as ${w} — "${sid}" is a label of that conversation`);
      return { agent, sessionId: w, canonicalId: w, note: notes.join('; ') };
    }
    if (!strict) return { agent, sessionId: sid, canonicalId: canon, note: '' };
    return { error: `sessionId "${sid}" is not a conversation id, and no conversation is registered under that name — ` +
      'an answer sent to it would reach nobody. ' + geminiHint() + ' Nothing was recorded.' };
  }

  function geminiHint() {
    let recent = [];
    try {
      recent = cardsLib.allCards({ sinceHours: 24 }).filter(c => c.agent === 'Gemini' && c.parent === undefined).slice(0, 5);
    } catch (_) {}
    return 'Sign with the id of this conversation' + (recent.length
      ? ' — the Antigravity windows active today: ' + recent.map(c => `"${String(c.name).slice(0, 40)}" ${c.id}`).join('; ') + '.'
      : ' (list_cards({agent: "Gemini"}) shows them).');
  }

  // A helper takes work from its lead and from the owner, and reports to its
  // lead. Returns the reason to refuse, or ''.
  function helperGuard({ mine, theirs, room, replyTo }) {
    if (!mine) return '';

    // The owner is above lead and helper. An answer to what he wrote, in the room he
    // wrote it in, is always allowed: refused, it went to the lead's room instead and
    // the owner, reading the room he had written in, saw no answer (11.11, #2621 → #2622).
    if (replyTo && room) {
      let parent = null;
      try { parent = bridgeDb.getMessageById(Number(replyTo)); } catch (_) {}
      if (parent && isHuman(parent.fromSession) && String(parent.room || '') === String(room)) return '';
    }
    const target = theirs && !isHuman(theirs) ? theirs : '';

    // Somebody else's helper is not mine to task.
    if (target && !router.same(mine, target)) {
      const theirBoss = router.leadOf(target);
      if (theirBoss && !router.same(theirBoss.lead, mine)) {
        return `"${router.nameOf(target)}" is the helper of "${router.nameOf(theirBoss.lead)}" and takes tasks only from it. ` +
          `Write to its lead (toSession: "${theirBoss.lead}") or ask the owner.`;
      }
    }

    const boss = router.leadOf(mine);
    if (!boss) return '';
    const where = boss.room ? ` in room "${boss.room}"` : '';
    if (target && !router.same(target, boss.lead)) {
      return `you are the helper of "${router.nameOf(boss.lead)}": you report to it${where}, and a task from ` +
        `"${router.nameOf(target)}" is not yours to answer. Tell your lead (toSession: "${boss.lead}").`;
    }
    if (room) {
      let r = null;
      try { r = bridgeDb.getRoom(room); } catch (_) {}
      const lead = new Set(bridgeDb.cluster(boss.lead));
      if (r && !(r.members || []).some(m => lead.has(String(m.card)))) {
        return `you are the helper of "${router.nameOf(boss.lead)}", and room "${r.name}" [${r.id}] is not its room. ` +
          `Report${where || ' to your lead'} (toSession: "${boss.lead}").`;
      }
    }
    return '';
  }

  // The lines a window needs to see about who it works with.
  function describeHelpers(win) {
    if (!win) return [];
    const out = [];
    const boss = router.leadOf(win);
    if (boss) {
      out.push(`👤 You are the helper of "${router.nameOf(boss.lead)}" [${boss.lead}]` +
        (boss.room ? `, room "${boss.room}"` : '') +
        '. Take tasks from it and from the owner only; a post that names nobody goes to it.');
    }
    let mine = [];
    try { mine = bridgeDb.readHelpers().filter(h => router.same(h.lead, win)); } catch (_) {}
    for (const h of mine) {
      out.push(`🧑‍🔧 Your helper: "${router.nameOf(h.helper)}" [${h.helper}]` + (h.room ? `, room "${h.room}"` : '') + '.');
    }
    return out;
  }

  // One helper, one lead: recording a pair replaces whatever the helper had.
  function pair(helper, lead, room) {
    const cur = router.leadOf(helper);
    if (cur) bridgeDb.dropHelper(cur.helper);
    bridgeDb.setHelper(helper, router.addressOf(lead) || lead, room || '');
  }

  // A room of one Claude project and one Antigravity window is a pair, and is
  // recorded as one the moment the room exists: the project leads, the
  // Antigravity window helps. Nobody has to remember to say so — the owner ticks
  // two windows on the board, or a lead opens a room with its helper, and both
  // sides are told who they are from then on. A window that already has a lead
  // keeps it; a room of two projects is two peers and records nothing.
  function autoPair(roomId) {
    let room = null;
    try { room = bridgeDb.getRoom(roomId); } catch (_) {}
    if (!room) return null;
    const who = new Map();
    for (const m of room.members || []) {
      const addr = router.addressOf(m.card) || m.card;
      if (!who.has(addr)) who.set(addr, m.card);
    }
    if (who.size !== 2) return null;
    const cards = [...who.values()];
    const lead = cards.find(c => router.agentOf(c) === 'Claude');
    const helper = cards.find(c => router.agentOf(c) === 'Gemini' && isWindowId(c));
    if (!lead || !helper || router.leadOf(helper)) return null;
    pair(helper, lead, room.id);
    return { helper, lead, room: room.id };
  }

  // What the helper is told when a pair is recorded. The lead reads it too: it
  // is posted in their room.
  function pairNotice(p) {
    const room = bridgeDb.getRoom(p.room);
    const lead = router.addressOf(p.lead) || p.lead;
    return `Pair on record: "${router.nameOf(p.helper)}" [${p.helper}] is the helper of "${router.nameOf(p.lead)}" [${lead}]. ` +
      `Helper: sign every call with your own id, ${p.helper}; report here — room "${room ? room.name : p.room}" [${p.room}] — ` +
      'and a post that names nobody goes to your lead. Take tasks from your lead and from the owner only. ' +
      'Both: before an install or a test on a shared device, book_stand.';
  }

  return { identify, helperGuard, describeHelpers, pair, autoPair, pairNotice };
}

module.exports = { createRules, AGENTS };
