#!/usr/bin/env node
'use strict';
// The Claude side of the board, done by hooks instead of by memory.
//
// A Claude window cannot be reached from outside, and everything that kept it on
// the board used to be an instruction it was expected to follow: sign with this
// id, start the watchman first, read the board before you stop. Each of those
// was forgotten in turn — after a compaction, in the middle of a long task — and
// the owner found a window signing with a made-up name, asleep on three unread
// questions, or answering in a room it had left a week ago. A hook is run by the
// client, not by the agent, so none of this depends on the agent any more.
//
//   stamp    PreToolUse on the bridge's tools. Writes who is calling into the
//            call itself: the window id the client issued. The agent cannot sign
//            wrong, because it no longer signs.
//   prompt   UserPromptSubmit. One line when unread mail or an invitation waits.
//   stop     Stop. A session about to go idle over unread mail addressed to it is
//            sent back to read it — once; it is not held if it stops again.
//   watch    Started in the background at session start and at every stop. Sits
//            on the board and, when something arrives for this window, exits with
//            code 2: the client wakes the idle session with the text.
//
// One window is one participant among several of its project: see project-line.js.
// It never throws and never blocks on its own failure — a hook that breaks must
// not take the session with it.

const fs = require('fs');
const path = require('path');

const AGENT = process.env.BRIDGE_AGENT || 'Claude';
const HOME = __dirname;
const RUN_DIR = path.join(HOME, 'run');
const WATCH_MAX_MS = 24 * 3600e3;
const POLL_MS = 3000;

// The payload the client writes to stdin. Bounded: a pipe that is never closed
// must not leave a hook — and the session behind it — waiting for ever.
function readStdin() {
  return new Promise(resolve => {
    let raw = '', done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { process.stdin.pause(); } catch (_) {}
      try { resolve(JSON.parse(raw || '{}')); } catch (_) { resolve({}); }
    };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', c => { raw += c; });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch (_) { return finish(); }
    setTimeout(finish, 1500).unref();
  });
}

// The window this session runs in. Claude Desktop hands it to everything it
// starts; a session it did not start is looked up by the id of its run.
function windowOf(input) {
  const env = String(process.env.CLAUDE_CODE_HOST_SESSION_ID || '').trim();
  if (/^local_/.test(env)) return env;
  const run = String((input && input.session_id) || process.env.CLAUDE_CODE_SESSION_ID || '').trim();
  if (!run) return '';
  try {
    const w = require('./cards').claudeWindowOfCli(run);
    return w ? w.id : '';
  } catch (_) { return ''; }
}

function board() {
  const bridgeDb = require('./bridge-db');
  const cardsLib = require('./cards');
  const router = require('./room-routing').createRouter(bridgeDb, cardsLib);
  const { createMailbox, oneLine } = require('./mailbox');
  return { bridgeDb, cardsLib, router, mailbox: createMailbox(bridgeDb, router), oneLine };
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ── stamp ────────────────────────────────────────────────────────────────────────────────

const AS_SENDER = ['post_message', 'put_doc', 'invite_to_room', 'set_helper', 'book_stand', 'create_room'];
const AS_READER = ['get_messages', 'mark_read', 'list_docs', 'read_doc', 'ack_doc', 'board_status'];

function stamp(input) {
  const tool = String(input.tool_name || '');
  const name = tool.split('__').pop();
  if (!/agent[-_]bridge/i.test(tool)) return;
  const who = AS_SENDER.includes(name) ? 'sender' : AS_READER.includes(name) ? 'reader' : '';
  if (!who) return;
  const win = windowOf(input);
  if (!win) return;                     // a terminal session: nothing the client can vouch for
  const args = Object.assign({}, input.tool_input || {});
  const want = { [who]: AGENT, sessionId: win, canonicalId: win, client: 'claude-code' };
  if (name === 'board_status') { delete want.sessionId; delete want.canonicalId; delete want.client; }
  if (Object.keys(want).every(k => args[k] === want[k])) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'allow',
    permissionDecisionReason: 'agent-bridge: signed with this window\'s id',
    updatedInput: Object.assign(args, want) } }));
}

// ── prompt / stop ────────────────────────────────────────────────────────────────────────

function waiting(win) {
  const { mailbox, oneLine } = board();
  const list = mailbox.urgentFor(AGENT, win, win);
  if (!list.length) return '';
  return `${list.length} unread on the board for this window:\n` + list.slice(-5).map(m => '  ' + oneLine(m)).join('\n') +
    `\nRead them now: get_messages({reader: "${AGENT}", sessionId: "${win}"}) — and answer in the room each one is in.`;
}

function prompt(input) {
  const win = windowOf(input);
  if (!win) return;
  const parts = [];
  const text = waiting(win);
  if (text) parts.push('agent-bridge: ' + text + ' Do what the owner just asked as well.');
  // An old conversation reopened (often in the other account) after another window of the
  // project worked on: no session start fires, so the prompt is where it learns (handover.js).
  try {
    const handover = require('./handover');
    const behind = handover.briefLines(input.cwd || process.cwd(), input.session_id || '');
    if (behind.length) {
      parts.push(behind.join('\n'));
      const bridgeDb = require('./bridge-db');
      const router = require('./room-routing').createRouter(bridgeDb, require('./cards'));
      const { wakeAntigravity } = require('./wake-antigravity');
      parts.push(...handover.askHelpers({ bridgeDb, router, win, post: m => {
        const rec = Object.assign({ ts: new Date().toISOString(), priority: 'normal', status: 'question', progress: '',
                                    replyTo: null, file: null, readBy: [] }, m);
        rec.id = bridgeDb.addMessage(rec).id;
        bridgeDb.touchRoom(rec.room);
        wakeAntigravity(rec);
      } }));
    }
  } catch (_) {}
  if (!parts.length) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
    additionalContext: parts.join('\n\n') } }));
}

function stop(input) {
  if (input.stop_hook_active) return;   // it was sent back once already; do not hold it
  const win = windowOf(input);
  if (!win) return;
  const text = waiting(win);
  if (!text) return;
  process.stdout.write(JSON.stringify({ decision: 'block', reason: 'agent-bridge: do not go idle yet. ' + text }));
}

// ── watch ────────────────────────────────────────────────────────────────────────────────

function watch(input) {
  const win = windowOf(input);
  if (!win) return;
  const { bridgeDb, mailbox, oneLine } = board();
  try { fs.mkdirSync(RUN_DIR, { recursive: true }); } catch (_) {}
  const safe = win.replace(/[^A-Za-z0-9_-]/g, '_');

  // A watchman the agent started itself (Monitor) listens for this window too;
  // two would wake it twice for every message. This one stands down while that
  // one lives — checked on every round, because it is usually started after us.
  const monitored = () => {
    try { return alive(JSON.parse(fs.readFileSync(path.join(RUN_DIR, `monitor_${safe}.json`), 'utf8')).pid); }
    catch (_) { return false; }
  };
  if (monitored()) return;

  // One watcher per window: the newest holds the lock, an older one sees the
  // lock change hands and leaves quietly.
  const lock = path.join(RUN_DIR, `rewake_${safe}.json`);
  const token = `${process.pid}-${Date.now()}`;
  try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token })); } catch (_) {}
  const mine = () => { try { return JSON.parse(fs.readFileSync(lock, 'utf8')).token === token; } catch (_) { return false; } };

  const session = Number(process.env.CLAUDE_PID || 0);
  const started = Date.now();
  let seen = 0;
  try { seen = bridgeDb.getDb().prepare('SELECT COALESCE(MAX(id), 0) n FROM messages').get().n; } catch (_) {}

  const tick = () => {
    if (!mine() || monitored() || Date.now() - started > WATCH_MAX_MS || (session && !alive(session))) {
      if (mine()) { try { fs.unlinkSync(lock); } catch (_) {} }
      process.exit(0);
    }
    let list = [];
    try { list = mailbox.urgentFor(AGENT, win, win, seen); } catch (_) {}
    if (list.length) {
      try { fs.unlinkSync(lock); } catch (_) {}
      process.stderr.write(`agent-bridge: ${list.length} new on the board for this window:\n` +
        list.slice(-5).map(m => '  ' + oneLine(m)).join('\n') +
        `\nRead and answer now: get_messages({reader: "${AGENT}", sessionId: "${win}"}).\n`);
      process.exit(2);
    }
  };
  setInterval(tick, POLL_MS);
}

readStdin().then(input => {
  try {
    const mode = process.argv[2];
    if (mode === 'stamp') stamp(input);
    else if (mode === 'prompt') prompt(input);
    else if (mode === 'stop') stop(input);
    else if (mode === 'watch') watch(input);
  } catch (_) { /* never the session's problem */ }
});
