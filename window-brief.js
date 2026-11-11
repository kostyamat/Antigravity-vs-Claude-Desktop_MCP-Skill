'use strict';
// What a window must know about itself before it writes a word: which project it
// is, which rooms it is in and with whom, who its helper or its lead is, which
// stands are taken, and which invitations it has not acted on.
//
// A session loses all of this at every compaction and every restart, and went on
// from memory: wrote to the room it remembered, forgot it had a helper, started
// an install on a stand somebody else was using. Nothing here is remembered by
// the agent. The session-start hook prints it (after a compaction too), and
// get_messages carries the short form at the top of every read — which is the
// only place an Antigravity window, having no hooks, can be told.

const fs = require('fs');
const path = require('path');
const os = require('os');

const { roomsOfWindow } = require('./room-invite');
const { projectName } = require('./project-line');
const claudeHome = require('./claude-home');

function createBrief(bridgeDb, cardsLib, router, rules, stands) {

  // myWindow: every id this window answers to. win: its window id, when known.
  function describe({ myWindow, win, board, full }) {
    const out = [];
    const me = win || [...myWindow].find(x => /^local_/.test(x)) || [...myWindow][0] || '';

    if (full && me) {
      const line = bridgeDb.lineOf(me);
      if (line) {
        const mates = bridgeDb.lineMembers(line).length;
        out.push(`📁 On the board you are the project "${projectName(line) || line}" (${line})` +
          (mates > 1 ? ` — ${mates} windows open it, across accounts, and all of them are this one participant` : '') +
          '. Rooms, helper and messages belong to the project, not to this window.');
      }
    }

    const { rooms, invited } = roomsOfWindow(bridgeDb, new Set([...myWindow, me].filter(Boolean)), board || []);
    if (invited.length) {
      out.push('📨 Invited, not joined yet: ' + invited.map(r => `"${r.name}" [${r.id}] (#${r.message})`).join(', ') +
        ' — join now: get_messages({room: "<id>", only: "all"}), list_docs({room: "<id>"}), then answer in the room.');
    }
    if (rooms.length) {
      const mine = new Set(bridgeDb.cluster(me));
      const withWhom = r => {
        const room = bridgeDb.getRoom(r.id);
        const others = ((room && room.members) || []).filter(m => !mine.has(String(m.card)))
          .map(m => router.nameOf(m.card));
        return `"${r.name}" [${r.id}]` + (full && others.length ? ` with ${[...new Set(others)].slice(0, 4).join(', ')}` : '');
      };
      out.push('🚪 Your rooms: ' + rooms.slice(0, 8).map(withWhom).join('; ') +
        (rooms.length > 8 ? ` and ${rooms.length - 8} more (list_rooms)` : '') +
        (rooms.length > 1 ? '. Every post names its room: room: "<id>".' : '. Your posts go there.'));
    } else if (full) {
      out.push('🚪 You are in no room. To talk to another window, open one: create_room({name, cards: [you, it]}).');
    }

    out.push(...rules.describeHelpers(me));
    // A Claude project with no helper asks the owner for one when real work starts
    // (agent-workflow, "Working with a helper agent"); the board only reminds it how.
    if (full && me && router.agentOf(me) === 'Claude' && !router.leadOf(me) && !rules.describeHelpers(me).length) {
      out.push('🧑‍🔧 This project has no helper. When real work starts, ask the owner whether to start one. ' +
        'Yes: set_helper({start: true, brief: "<the project, its state, the first task, what not to touch>"}) — ' +
        'you start it, brief it and pair it yourself. No: work alone. A window he names: set_helper({helper: "<its id>"}).');
    }
    out.push(...stands.describe(me));
    return out;
  }

  return { describe };
}

// Skills the owner uploaded to this account that are also installed on disk —
// equal or not. The app keeps an uploaded skill per account, frozen at the day it
// was uploaded, and Claude Code lists it beside the disk copy; that is how one
// account went on by rules three weeks old. Nothing needs an uploaded copy any
// more (the chat app reads the disk copy through read_skill), so every one of
// them is a duplicate to delete, not only the ones that already drifted.
function staleAccountSkills(account) {
  const out = new Set();
  const home = process.env.USERPROFILE || os.homedir();
  const disk = path.join(home, '.claude', 'skills');
  const text = f => { try { return fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').trim(); } catch (_) { return null; } };
  for (const { dir } of claudeHome.accountSkillDirs(account)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    // Only what the owner uploaded: those have a server id "skill_…" in the account's
    // manifest. Anthropic's own skills (canvas-design, docx…) carry a plain id and are
    // not his to delete. An unreadable manifest leaves the list as it is.
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, '..', 'manifest.json'), 'utf8'));
      const uploaded = new Set((m.skills || []).filter(k => /^skill_/.test(String(k.skillId || ''))).map(k => k.name));
      names = names.filter(n => uploaded.has(n));
    } catch (_) {}
    for (const n of names) {
      const mine = text(path.join(disk, n, 'SKILL.md'));
      const theirs = text(path.join(dir, n, 'SKILL.md'));
      if (mine !== null && theirs !== null) out.add(n);
    }
  }
  return [...out].sort();
}

module.exports = { createBrief, staleAccountSkills };

// The session-start brief is Python; it asks here rather than repeating the rules.
// node window-brief.js <agent> <sessionId> [windowId] [account] → the lines, one per row.
if (require.main === module) {
  try {
    const [agent, session, window, account] = process.argv.slice(2);
    const bridgeDb = require('./bridge-db');
    const cardsLib = require('./cards');
    const router = require('./room-routing').createRouter(bridgeDb, cardsLib);
    const rules = require('./board-rules').createRules(bridgeDb, cardsLib, router);
    const stands = require('./stands').createStands(bridgeDb, router);
    const win = window || router.windowOf(session);
    if (/^local_/.test(win)) router.addressOf(win);          // joins the line of its project folder
    const ids = [session, win].filter(Boolean);
    const myWindow = new Set(ids);
    for (const s of ids) for (const a of bridgeDb.resolveSessionAliases(s, { agent, lines: false })) myWindow.add(a);
    const lines = createBrief(bridgeDb, cardsLib, router, rules, stands)
      .describe({ myWindow, win, board: bridgeDb.readAllMessages(), full: true });
    const stale = staleAccountSkills(account || process.env.CLAUDE_CODE_ACCOUNT_UUID || cardsLib.currentAccount() || '');
    if (stale.length) {
      lines.push('⚠️ This account holds its own uploaded copies of ' + stale.join(', ') + ' (`anthropic-skills:<name>`). ' +
        'They are frozen per account and nothing needs them any more: use the plain skill name (the disk copy). ' +
        'Remind the owner to delete them in Settings → Capabilities → Skills.');
    }
    // A lead in a new window asks its helper for a handover (handover.js), once per window.
    try {
      const { wakeAntigravity } = require('./wake-antigravity');
      lines.push(...require('./handover').askHelpers({ bridgeDb, router, win, post: m => {
        const rec = Object.assign({ ts: new Date().toISOString(), priority: 'normal', status: 'question', progress: '',
                                    replyTo: null, file: null, readBy: [] }, m);
        rec.id = bridgeDb.addMessage(rec).id;
        bridgeDb.touchRoom(rec.room);
        wakeAntigravity(rec);
      } }));
    } catch (_) {}
    process.stdout.write(lines.join('\n'));
  } catch (_) {}
}
