'use strict';
// The two tools that keep a pair and a bench in order: set_helper and book_stand.
// The rules themselves live in board-rules.js and stands.js; this is only the
// part that talks to the caller.

const { isHuman } = require('./room-routing');

function createPairTools({ bridgeDb, cardsLib, router, rules, stands, ok, fail, doPost, normAgent }) {

  function doSetHelper(id, a) {
    const me = router.windowOf(a.canonicalId) || router.windowOf(a.sessionId);
    if (!me) return fail(id, 'set_helper: the board does not know which window you are — pass sessionId.');
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
