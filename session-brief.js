#!/usr/bin/env node
'use strict';
// Everything the session-start brief asks the board, in one process.
//
// The brief is Python and asks the rules that live here in JavaScript rather than
// keeping copies of them: which P0 is still pending (p0.js), what mail waits
// (mailbox.js), which rooms and helpers the window has (window-brief.js), how the
// previous window ended (handover.js), and it registers the window
// (register-window.js). Each was a process of its own — five starts of node, five
// times the database opened and the window cards read from disk — and the brief
// took two to three and a half seconds at the start of every session, over the
// three seconds its own acceptance test allows. Asked together they share one
// start, one database handle and one reading of the cards.
//
//   node session-brief.js <agent> <runId> <windowId> <cwd> <title> <account>
// The brief signs with the window id when the client names one, and with the id of the
// run otherwise; the pending-P0 rule is asked with the run id and the window both, as
// the brief always asked it.
//   → {"p0":{count,ids,cursor},"mail":{…}|null,"rooms":[…],"previous":[…],"registered":bool}
// A part that fails is left out; the brief falls back to asking for it alone.

function gather([agent, run, win, cwd, title, account]) {
  const sid = win || run || '';          // what the brief signs with
  const out = { sid, run: run || '', win: win || '' };
  const part = (name, fn) => { try { out[name] = fn(); } catch (_) {} };
  part('registered', () => require('./register-window').register(agent, sid, win, 'claude-code', cwd, title));
  part('paused', () => require('./bridge-db').boardPaused());
  if (out.paused) return out;
  part('p0', () => require('./p0').stateFor(agent, run, win));
  if (win) {
    part('mail', () => {
      const bridgeDb = require('./bridge-db');
      const router = require('./room-routing').createRouter(bridgeDb, require('./cards'));
      return require('./mailbox').createMailbox(bridgeDb, router).briefFor(agent, win, win);
    });
  }
  part('rooms', () => require('./window-brief').linesFor(agent, sid, win, account));
  part('previous', () => require('./handover').briefLines(cwd || process.cwd(), sid || ''));
  return out;
}

module.exports = { gather };

if (require.main === module) {
  let out = {};
  try { out = gather(process.argv.slice(2)); } catch (_) {}
  process.stdout.write(JSON.stringify(out));
}
