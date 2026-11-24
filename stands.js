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

// The owner, 24.11.2026: a session must take ADB and let it go; sessions forget to tell the others they
// no longer need it, and his work stands still. So a stand is freed by the board itself when its
// holder goes idle (bridge-hook.js watch for a Claude window, board-ui.js for an Antigravity one),
// and every window that was refused it is told at once, in a message that wakes it.
// `wake`: how an Antigravity window is woken for a message (wake-antigravity.js); optional.
function createStands(bridgeDb, router, wake) {
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
      try { bridgeDb.addStandWaiter(id, router.addressOf(holder) || holder, agent); } catch (_) {}
      return { ok: false, text: `stand ${id} is taken by "${router.nameOf(row.holder)}" [${row.holder}] for ${since(row)}` +
        (row.note ? ` — ${row.note}` : '') + '. You are on its waiting list: the board tells you the moment it is free (its holder says done, ' +
        'or goes idle). Nothing was booked: do not touch the stand meanwhile.' };
    }
    const took = row && !router.same(row.holder, holder)
      ? ` (taken over from "${router.nameOf(row.holder)}", whose booking was ${since(row)} old)` : '';
    bridgeDb.takeStand(id, router.addressOf(holder) || holder, agent, room, note);
    try { bridgeDb.removeStandWaiter(id, router.addressOf(holder) || holder); } catch (_) {}
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
    free(id, `"${router.nameOf(holder)}" is done`);
    return { ok: true, stand: id, room: row.room, text: `stand ${id} is free.`, free: true };
  }

  // Free a stand and say so: a status line in the holder's room, and to every window that was refused
  // it a message of its own, which wakes it. → the number of windows told, or -1 if it was not booked.
  function free(id, why) {
    const row = bridgeDb.readStands().find(r => r.stand === id);
    if (!row) return -1;
    bridgeDb.releaseStand(id);
    let waiters = [];
    try { waiters = bridgeDb.takeStandWaiters(id); } catch (_) {}
    const say = m => {
      const rec = Object.assign({ ts: new Date().toISOString(), from: 'Board', fromSession: 'board/stands', replyTo: null,
        topic: 'stand', progress: '', file: null, readBy: [] }, m);
      try { rec.id = bridgeDb.addMessage(rec).id; if (rec.room) bridgeDb.touchRoom(rec.room); if (wake) wake(rec); } catch (_) {}
    };
    if (row.room) say({ room: row.room, to: 'all', toSession: '', priority: 'fyi', status: 'info', message: `✅ Stand ${id} is free (${why}).` });
    for (const w of waiters) {
      if (router.same(w.waiter, row.holder)) continue;
      say({ room: '', to: w.agent || 'all', toSession: w.waiter, priority: 'normal', status: 'answer',
        message: `🔧 Stand ${id} is free now (${why}). It is not booked for you: take it first — ` +
          `book_stand({stand: "${id}", action: "take"}) — then work, and say done when you finish.` });
    }
    return waiters.length;
  }

  // The stands a window holds.
  function heldBy(win) { return bridgeDb.readStands().filter(r => router.same(r.holder, win)).map(r => r.stand); }

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

  return { take, done, describe, free, heldBy };
}

module.exports = { createStands, standId, STALE_HOURS };
