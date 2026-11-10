'use strict';
// Who has which stand.
//
// A stand is one physical device on the bench. "Taking 198, ten minutes" was a
// line in a room, seen by that room; the window next door, in another room,
// started its own install on the same device and both runs were lost. A booking
// is a row in the board database: every window sees it at the top of what it
// reads, whichever room it is in, and a second window that asks for the stand
// is refused with the name of the one that holds it.
//
// A booking nobody released does not block the bench for ever: after
// STALE_HOURS it may be taken over, and the owner can free a stand on the board.

const STALE_HOURS = 6;

function standId(s) {
  return String(s || '').trim().toLowerCase().replace(/^stand\s*/, '').replace(/\s+/g, '-');
}

function createStands(bridgeDb, router) {
  const ageHours = row => (Date.now() - new Date(row.since).getTime()) / 3600e3;
  const since = row => {
    const h = ageHours(row);
    return h < 1 ? Math.max(1, Math.round(h * 60)) + ' min' : h.toFixed(1) + ' h';
  };

  function take({ stand, holder, agent, room, note }) {
    const id = standId(stand);
    if (!id) return { ok: false, text: '`stand` is required — the name everybody uses for the device, e.g. "198".' };
    if (!holder) return { ok: false, text: 'the board does not know which window you are — pass sessionId.' };
    const row = bridgeDb.readStands().find(r => r.stand === id);
    if (row && !router.same(row.holder, holder) && ageHours(row) < STALE_HOURS) {
      return { ok: false, text: `stand ${id} is taken by "${router.nameOf(row.holder)}" [${row.holder}] for ${since(row)}` +
        (row.note ? ` — ${row.note}` : '') + '. Wait for its "done", or ask it' +
        (row.room ? ` in room "${row.room}"` : '') + '. Nothing was booked: do not touch the stand.' };
    }
    const took = row && !router.same(row.holder, holder)
      ? ` (taken over from "${router.nameOf(row.holder)}", whose booking was ${since(row)} old)` : '';
    bridgeDb.takeStand(id, router.addressOf(holder) || holder, agent, room, note);
    return { ok: true, stand: id, text: `stand ${id} is yours${took}. Say done when you finish: book_stand({stand: "${id}", action: "done"}).` };
  }

  function done({ stand, holder }) {
    const id = standId(stand);
    const row = bridgeDb.readStands().find(r => r.stand === id);
    if (!row) return { ok: true, stand: id, text: `stand ${id} was not booked.`, free: false };
    const boss = router.leadOf(row.holder);
    const mine = router.same(row.holder, holder) || (boss && router.same(boss.lead, holder));
    if (!mine && ageHours(row) < STALE_HOURS) {
      return { ok: false, text: `stand ${id} is held by "${router.nameOf(row.holder)}" [${row.holder}], not by you — only it, ` +
        'its lead or the owner releases it.' };
    }
    bridgeDb.releaseStand(id);
    return { ok: true, stand: id, room: row.room, text: `stand ${id} is free.`, free: true };
  }

  // One line for the top of every read, or nothing.
  function describe(win) {
    const rows = bridgeDb.readStands();
    if (!rows.length) return [];
    return ['🔧 Stands taken: ' + rows.map(r => {
      const me = win && router.same(r.holder, win);
      return `${r.stand} — ${me ? 'YOU' : '"' + router.nameOf(r.holder) + '"'}, ${since(r)}` +
        (r.note ? ` (${String(r.note).slice(0, 60)})` : '') + (ageHours(r) >= STALE_HOURS ? ' [stale]' : '');
    }).join('; ') + '. Book before you install: book_stand({stand, action: "take"}).'];
  }

  return { take, done, describe };
}

module.exports = { createStands, standId, STALE_HOURS };
