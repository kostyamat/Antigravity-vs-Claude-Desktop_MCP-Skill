'use strict';
// The two tools that keep a pair and a bench in order: set_helper and book_stand.
// The rules themselves live in board-rules.js and stands.js; this is only the
// part that talks to the caller.

const { isHuman } = require('./room-routing');
const antigravity = require('./antigravity-api');
const { projectName } = require('./project-line');
const helperModels = require('./helper-models');

// The model a lead asks for (helper-models.js). Nothing asked → null: the caller's default.
async function pickModel(a) {
  if (!a.model && !a.effort && !a.kind) return null;
  const list = await helperModels.catalogue();
  const r = helperModels.resolve(list, { model: a.model, effort: a.effort, kind: a.kind });
  if (r.error) throw new Error(r.error + '. ' + helperModels.describe(list));
  return r.model;
}

function createPairTools({ bridgeDb, cardsLib, router, rules, stands, ok, fail, doPost, normAgent }) {

  // A lead with no helper starts one itself: a new Antigravity conversation that is told
  // whose helper it is and what the work is about, then paired like any other. The owner
  // is asked only when Antigravity is not running.
  async function startHelper(id, a, me) {
    if (router.agentOf(me) !== 'Claude') return fail(id, 'set_helper: only a lead (a Claude project) starts a helper.');
    const has = rules.describeHelpers(me);
    if (has.length && a.another !== true) {
      return fail(id, 'set_helper: you already have a helper — ' + has.join('; ') + '. Pass another: true to start one more.');
    }
    // A helper is named after its task, and a lead keeps few of them (owner, 16.11.2026).
    // Thirteen conversations called "Helper: <project>", in rooms "helper-2" … "helper-14",
    // told nobody which was doing what, and each open conversation costs the owner's
    // laptop memory it does not have. So: no start without a task name, no second helper
    // for the same task, and no more than MAX at once — a finished one is released first.
    const task = String(a.task || '').replace(/\s+/g, ' ').trim();
    if (task.length < 3 || task.length > 48 || /^(helper|assistant)\s*#?\d*$/i.test(task)) {
      return fail(id, 'set_helper: pass task — two to five words that say what this helper is for ("boot animation", ' +
        '"smali port of the dialer"). The helper and its room are named after it; "helper 2" names nothing.');
    }
    let mine = [];
    try { mine = bridgeDb.readHelpers().filter(h => router.same(h.lead, me)); } catch (_) {}
    const titles = mine.map(h => ({ h, title: String((router.cardOf(h.helper) || {}).name || '') }));
    const same = titles.find(x => x.title.toLowerCase().endsWith(': ' + task.toLowerCase()));
    if (same) {
      return fail(id, `set_helper: you already have a helper for "${task}" — "${same.title}" [${same.h.helper}]. Give it the work, ` +
        'or name the new task differently.');
    }
    const max = Math.max(1, Number(maxHelpers()) || 3);
    if (mine.length >= max) {
      return fail(id, `set_helper: you have ${mine.length} helpers, and ${max} is the most a lead keeps at once: ` +
        titles.map(x => `"${x.title || router.nameOf(x.h.helper)}" [${x.h.helper}]`).join('; ') + '. Give the task to one of them, or ' +
        'release one whose task is done — set_helper({helper: "<id>", release: true}) — and tell the owner its conversation can be ' +
        'closed. Every open conversation takes memory on the owner\'s machine. (The limit is maxHelpersPerLead in bridge_config.json.)');
    }
    const brief = String(a.brief || '').trim();
    if (brief.length < 40) {
      return fail(id, 'set_helper: pass brief — what the project is, where it lives, what the helper will be doing and what it must not touch. ' +
        'A helper started without context starts by guessing.');
    }
    const name = projectName(me) || router.nameOf(me);
    // Its model: what the lead asked for, else Hydrogen on medium effort (analysis and code, the
    // usual work of a helper); the old tier "pro" only when the list cannot be read.
    let chosen = null;
    try { chosen = await pickModel(a.model || a.effort || a.kind ? a : { model: 'hydrogen', effort: 'medium' }); }
    catch (e) { if (a.model || a.effort || a.kind) return fail(id, 'set_helper: ' + e.message); }
    let helper;
    try {
      helper = await antigravity.create({
        model: chosen ? chosen.id : 'pro',
        title: name + ': ' + task,
        prompt: `You are the helper of the project "${name}" for one task — "${task}" —, started through the agent-bridge board by its lead, a Claude session. ` +
          'Read your skills agent-bridge (PROTOCOL) and agent-workflow (section "Working with a helper agent") now, completely. ' +
          'The board is about to post your own id and your room to you; sign every bridge call with that id. ' +
          'The lead gives you the routine of the project and reviews what you deliver; the owner may give you a task directly at any time. ' +
          'Context from the lead:\n' + brief + '\n\nDo nothing else yet. Reply with the single word READY, then read your room with get_messages.'
      });
    } catch (e) {
      return fail(id, 'set_helper: could not start a helper (' + e.message + '). Ask the owner to open Antigravity, or to give you a helper window.');
    }
    // The new conversation appears among the cards a moment after it is made.
    for (let i = 0; i < 20 && !router.windowOf(helper); i++) await new Promise(r => setTimeout(r, 500));
    // Its first answer shows the model it really runs on; the pair is recorded with that.
    let seen = null;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try { seen = await helperModels.check(helper); } catch (_) { seen = null; }
      if (seen && seen.own) break;
    }
    if (chosen && (!seen || !seen.own)) seen = { id: chosen.id, own: chosen.id, note: `It was started on ${chosen.label}.` };
    return doSetHelper(id, Object.assign({}, a, { start: false, helper, lead: '', task, model: '', effort: '', kind: '', checked: seen }));
  }

  function maxHelpers() {
    try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'bridge_config.json'), 'utf8')).maxHelpersPerLead; }
    catch (_) { return 0; }
  }

  // Leave for another lead to consult a helper or give it a task. Given by the helper's
  // own lead, or — when that lead is away — by the owner: then the caller passes the id of
  // the owner's board message that says so, and the board checks it is his.
  function doGrant(id, a, me) {
    const helper = router.windowOf(String(a.helper || '').trim());
    const cur = helper ? router.leadOf(helper) : null;
    if (!cur) return fail(id, `set_helper: "${a.helper || ''}" is nobody's helper; anyone may write to it, no leave is needed.`);
    const raw = String(a.allow || a.revoke).trim();
    const grantee = router.windowOf(raw);
    if (!grantee || isHuman(grantee)) return fail(id, `set_helper: "${raw}" is no window and no project the board knows.`);
    let by = '';
    if (router.same(cur.lead, me)) by = `its lead "${router.nameOf(cur.lead)}"`;
    else if (a.approval) {
      const m = bridgeDb.getMessageById(Number(a.approval));
      if (m && isHuman(m.fromSession)) by = `the owner, #${m.id}`;
      else return fail(id, `set_helper: #${a.approval} is not a message from the owner.`);
    } else {
      return fail(id, `set_helper: only the lead of "${router.nameOf(helper)}" ("${router.nameOf(cur.lead)}") gives leave to use it. ` +
        'If that lead is away, the owner can: pass approval: <the id of his message that allows it>.');
    }
    const who = router.addressOf(grantee) || grantee;
    if (a.revoke) {
      const gone = bridgeDb.revokeGrant(helper, who);
      return ok(id, gone ? `✅ "${router.nameOf(who)}" no longer has leave to use "${router.nameOf(helper)}".` : 'There was no such leave.');
    }
    const hours = Number(a.hours);
    const until = hours > 0 ? new Date(Date.now() + hours * 3600e3).toISOString() : '';
    bridgeDb.grantHelper(helper, who, by, until);
    return ok(id, `✅ "${router.nameOf(who)}" may consult "${router.nameOf(helper)}" or give it a task` +
      (until ? ` until ${until.slice(0, 16)}Z` : ', until the leave is taken back') + ` (leave from ${by}). ` +
      'Both see it at every start. The helper finishes its own lead\'s task first and tells its lead before it takes one. ' +
      `Take it back: set_helper({helper: "${helper}", revoke: "${who}"}).`);
  }

  // The models a helper can run on now, and the lead's helpers with the one each is on.
  function listModels(id, me) {
    return helperModels.catalogue().then(list => {
      const mine = bridgeDb.readHelpers().filter(h => router.same(h.lead, me));
      const label = mid => (list.find(m => m.id === mid) || {}).label || mid || 'the one it was started on';
      return ok(id, helperModels.describe(list) + (mine.length ? '\nYour helpers: ' + mine.map(h =>
        `"${router.nameOf(h.helper)}" [${h.helper}] on ${label(h.model)}`).join('; ') + '.' : '') +
        '\nChange one: set_helper({helper, model?, effort?, kind?}); one message only: post_message with effort / model / kind.');
    }).catch(e => fail(id, 'set_helper: the model list could not be read (' + e.message + '). Is Antigravity running?'));
  }

  // The lead changes the model its helper runs on: every message to it from now on.
  function changeModel(id, a, me, pair) {
    return pickModel(a).then(m => {
      bridgeDb.setHelperModel(pair.helper, m.id);
      return ok(id, `✅ "${router.nameOf(pair.helper)}" now answers every message on ${m.label} (${m.id}). ` +
        'A message sent while it is at work waits until it is free, so that it runs on that model.');
    }).catch(e => fail(id, 'set_helper: ' + e.message));
  }

  async function doSetHelper(id, a) {
    const me = router.windowOf(a.canonicalId) || router.windowOf(a.sessionId);
    if (!me) return fail(id, 'set_helper: the board does not know which window you are — pass sessionId.');
    if (a.models === true) return listModels(id, me);
    if (a.start === true) return startHelper(id, a, me).catch(e => fail(id, 'set_helper: ' + e.message));
    if (String(a.allow || a.revoke || '').trim()) return doGrant(id, a, me);
    const asHelper = Boolean(String(a.lead || '').trim());
    const otherRaw = String((asHelper ? a.lead : a.helper) || '').trim();
    if (!otherRaw) {
      const own = rules.describeHelpers(me);
      return ok(id, own.length ? own.join('\n') : 'No pair is recorded for you. A lead passes `helper`, a helper passes `lead`.');
    }
    const other = router.windowOf(otherRaw);
    if (!other || isHuman(other)) {
      return fail(id, `set_helper: "${otherRaw}" is no window and no project the board knows — list_cards shows the ids.`);
    }
    if (router.same(me, other)) return fail(id, 'set_helper: that is you. A helper is another window.');
    const helper = asHelper ? me : other;
    const lead = asHelper ? other : me;

    const current = router.leadOf(helper);
    if (!asHelper && a.release !== true && (a.model || a.effort || a.kind) && current && router.same(current.lead, lead)) {
      return changeModel(id, a, me, current);
    }
    if (a.release === true) {
      if (!current) return ok(id, `"${router.nameOf(helper)}" was nobody's helper.`);
      if (!router.same(current.lead, lead) && !router.same(helper, me)) {
        return fail(id, `set_helper: "${router.nameOf(helper)}" is the helper of "${router.nameOf(current.lead)}", not yours to release.`);
      }
      // Done for good: the Antigravity conversation is deleted, and the board takes it off at once —
      // pair, rooms, its pair room archived (antigravity-gone.js). Only the lead deletes its own helper.
      if (a.delete === true) {
        if (asHelper || router.agentOf(helper) !== 'Gemini') {
          return fail(id, 'set_helper: delete is for a lead ending its own Antigravity helper (helper + release + delete).');
        }
        const name = router.nameOf(helper);
        return antigravity.remove(current.helper).then(() => {
          const gone = require('./antigravity-gone');
          const archiver = require('./room-archive').createArchiver(bridgeDb, __dirname);
          let swept = { gone: [], archived: [] };
          try { swept = gone.sweep({ bridgeDb, archiveRoom: r => archiver.archiveRoom(r) }, { only: [current.helper] }); } catch (_) {}
          bridgeDb.dropHelper(current.helper);
          return ok(id, `✅ "${name}" is deleted from Antigravity and is no longer your helper.` +
            (swept.archived.length ? ' Archived: ' + swept.archived.map(x => `"${x.name}" → ${x.file}`).join('; ') + '.' : ''));
        }).catch(e => fail(id, `set_helper: the Antigravity conversation was not deleted (${e.message}); the pair stays. Is Antigravity running?`));
      }
      bridgeDb.dropHelper(current.helper);
      return ok(id, `✅ "${router.nameOf(helper)}" is no longer the helper of "${router.nameOf(current.lead)}".`);
    }
    if (current && !router.same(current.lead, lead)) {
      return fail(id, `set_helper: "${router.nameOf(helper)}" is already the helper of "${router.nameOf(current.lead)}" ` +
        `[${current.lead}]. That lead or the owner ends it first: set_helper({helper: "${current.helper}", release: true}).`);
    }
    const back = router.leadOf(lead);
    if (back && router.same(back.lead, helper)) {
      return fail(id, 'set_helper: these two are already a pair the other way round.');
    }

    // Their room: the one named, else the smallest one they share, else a new one.
    let room = a.room ? router.findRoom(a.room, [me]) : null;
    if (!room) {
      const mineRooms = bridgeDb.roomsOfCard(lead);
      const shared = bridgeDb.roomsOfCard(helper).filter(r => mineRooms.includes(r))
        .map(r => bridgeDb.getRoom(r)).filter(Boolean)
        .sort((x, y) => (x.members.length - y.members.length) ||
                        String(y.last_activity || '').localeCompare(String(x.last_activity || '')));
      room = shared[0] || bridgeDb.createRoom(
        a.task ? `${router.nameOf(lead)} · ${a.task}` : `${router.nameOf(lead)} + helper`,
        [{ card: lead, agent: router.agentOf(lead) }, { card: helper, agent: router.agentOf(helper) }],
        cardsLib.currentAccount() || '');
    }
    rules.pair(helper, lead, room.id);
    // A helper's model is recorded with the pair and named on every message to it (wake-antigravity).
    // A window paired as it is gets checked here: it may have been left on Claude in the picker.
    let modelNote = '';
    if (router.agentOf(helper) === 'Gemini') {
      const pair = router.leadOf(helper) || { helper };
      const seen = a.checked || await helperModels.check(pair.helper).catch(() => null);
      if (seen && seen.id) {
        bridgeDb.setHelperModel(pair.helper, seen.id, seen.own || seen.id);
        modelNote = ' ' + seen.note + ' The model is named on every message to it, so the picker in Antigravity does not change it; ' +
          'the lead changes it with set_helper({helper, model?, effort?, kind?}).';
      }
    }

    const leadAddr = router.addressOf(lead) || lead;
    const toOther = asHelper ? lead : helper;
    return doPost(id, {
      sender: a.sender, sessionId: a.sessionId, canonicalId: a.canonicalId || '',
      room: room.id, to: router.agentOf(toOther), toSession: toOther, status: 'info', topic: 'helper',
      message: asHelper
        ? `Helper on record: "${router.nameOf(helper)}" [${helper}] now works for you, "${router.nameOf(lead)}". ` +
          `Tasks to it and its reports stay in this room, "${room.name}" [${room.id}].` + modelNote
        : `You are now the helper of "${router.nameOf(lead)}" [${leadAddr}]. Sign every call with your own id, ${helper}. ` +
          `Report here — room "${room.name}" [${room.id}]; a post that names nobody goes to your lead. Take tasks from it ` +
          'and from the owner only. Before you install or test on a shared device: book_stand.' + modelNote
    });
  }

  function doBookStand(id, a) {
    const me = router.windowOf(a.canonicalId) || router.windowOf(a.sessionId);
    const action = ['take', 'done', 'list'].includes(a.action) ? a.action : 'take';
    if (action === 'list' || !String(a.stand || '').trim()) {
      const lines = stands.describe(me);
      return ok(id, lines.length ? lines.join('\n') : 'Every stand is free.');
    }
    const agent = normAgent(a.sender);
    let room = a.room ? router.findRoom(a.room, [me]) : null;
    if (!room && me) {
      const boss = router.leadOf(me);
      const own = bridgeDb.roomsOfCard(me);
      const pick = (boss && boss.room) || (own.length === 1 ? own[0] : '');
      room = pick ? bridgeDb.getRoom(pick) : null;
    }
    const res = action === 'take'
      ? stands.take({ stand: a.stand, holder: me, agent, room: room ? room.id : '', note: a.note || '' })
      : stands.done({ stand: a.stand, holder: me });
    if (!res.ok) return fail(id, `book_stand: ${res.text}`);

    // The room hears it as a line of its own: a status, waking nobody.
    const noteRoom = room ? room.id : (res.room || '');
    if (noteRoom && action === 'take') {
      try {
        bridgeDb.addMessage({
          ts: new Date().toISOString(), from: agent, fromSession: me, room: noteRoom, to: 'all', toSession: '',
          replyTo: null, topic: 'stand', priority: 'fyi', status: 'info', progress: '',
          message: action === 'take'
            ? `🔧 Stand ${res.stand} taken by "${router.nameOf(me)}"` + (a.note ? ` — ${a.note}` : '')
            : `✅ Stand ${res.stand} is free ("${router.nameOf(me)}" is done)`,
          file: null, readBy: []
        });
        bridgeDb.touchRoom(noteRoom);
      } catch (_) {}
    }
    ok(id, (action === 'take' ? '🔧 ' : '✅ ') + res.text);
  }

  return { doSetHelper, doBookStand };
}

module.exports = { createPairTools };
