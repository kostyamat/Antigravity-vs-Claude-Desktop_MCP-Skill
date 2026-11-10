'use strict';
// The two tools that keep a pair and a bench in order: set_helper and book_stand.
// The rules themselves live in board-rules.js and stands.js; this is only the
// part that talks to the caller.

const { isHuman } = require('./room-routing');
const antigravity = require('./antigravity-api');
const { projectName } = require('./project-line');

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
    const brief = String(a.brief || '').trim();
    if (brief.length < 40) {
      return fail(id, 'set_helper: pass brief — what the project is, where it lives, what the helper will be doing and what it must not touch. ' +
        'A helper started without context starts by guessing.');
    }
    const name = projectName(me) || router.nameOf(me);
    let helper;
    try {
      helper = await antigravity.create({
        model: /^[A-Za-z0-9_.-]{2,60}$/.test(String(a.model || '')) ? a.model : 'pro',
        title: 'Helper: ' + name,
        prompt: `You are the helper of the project "${name}", started through the agent-bridge board by its lead, a Claude session. ` +
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
    return doSetHelper(id, Object.assign({}, a, { start: false, helper, lead: '' }));
  }

  function doSetHelper(id, a) {
    const me = router.windowOf(a.canonicalId) || router.windowOf(a.sessionId);
    if (!me) return fail(id, 'set_helper: the board does not know which window you are — pass sessionId.');
    if (a.start === true) return startHelper(id, a, me).catch(e => fail(id, 'set_helper: ' + e.message));
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
    if (a.release === true) {
      if (!current) return ok(id, `"${router.nameOf(helper)}" was nobody's helper.`);
      if (!router.same(current.lead, lead) && !router.same(helper, me)) {
        return fail(id, `set_helper: "${router.nameOf(helper)}" is the helper of "${router.nameOf(current.lead)}", not yours to release.`);
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
        `${router.nameOf(lead)} + helper`,
        [{ card: lead, agent: router.agentOf(lead) }, { card: helper, agent: router.agentOf(helper) }],
        cardsLib.currentAccount() || '');
    }
    rules.pair(helper, lead, room.id);

    const leadAddr = router.addressOf(lead) || lead;
    const toOther = asHelper ? lead : helper;
    return doPost(id, {
      sender: a.sender, sessionId: a.sessionId, canonicalId: a.canonicalId || '',
      room: room.id, to: router.agentOf(toOther), toSession: toOther, status: 'info', topic: 'helper',
      message: asHelper
        ? `Helper on record: "${router.nameOf(helper)}" [${helper}] now works for you, "${router.nameOf(lead)}". ` +
          `Tasks to it and its reports stay in this room, "${room.name}" [${room.id}].`
        : `You are now the helper of "${router.nameOf(lead)}" [${leadAddr}]. Sign every call with your own id, ${helper}. ` +
          `Report here — room "${room.name}" [${room.id}]; a post that names nobody goes to your lead. Take tasks from it ` +
          'and from the owner only. Before you install or test on a shared device: book_stand.'
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
    if (noteRoom && (action === 'take' || res.free)) {
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
