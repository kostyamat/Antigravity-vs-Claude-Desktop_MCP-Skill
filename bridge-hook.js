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
//   failed   StopFailure. A turn that ended on an error — the usage limit first of all —
//            left no slice: what it was doing is lifted from its transcript into the
//            project's slice (rescue.js), and a turn that ended on the limit tells the
//            supervisor that this account has run out (claude-quota.js).
//   statusline  For a terminal session only (the desktop app runs no status line): hands
//            the account's limits to the supervisor and prints them in one short line.
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

// A window whose last turn ended longer ago than this is dormant: only what is addressed to it by
// its own id wakes it (owner, 24.11.2026: he does not want 25 sessions eating the quota at once while he
// works with the two or three he woke by hand). Measured that day: of 403 wake-ups in 24 hours, a
// message to one window woke its project's other windows too (270 wake-ups for 178 messages), and
// one word of the owner's to a room woke up to nine windows. activeWindowMinutes in bridge_config.json.
function activeMs() {
  if (Number(process.env.BRIDGE_ACTIVE_MS) > 0) return Number(process.env.BRIDGE_ACTIVE_MS);
  try { return require('./settings').get('activeWindowMinutes') * 60e3; } catch (_) { return 60 * 60e3; }
}

// Which of the messages that are urgent for this window are to wake it (see activeMs):
//   addressed to this very window — always;
//   addressed to its project — only the project's window whose turn ended last (one window answers);
//   said to a room, a P0 to all, the owner to a room — only while the window is active.
function toWake(list, box, win, idleMs) {
  const own = new Set([...box.myWindow].map(x => String(x).trim().toLowerCase()));
  const exact = m => m.toSession && own.has(String(m.toSession).trim().toLowerCase());
  const active = idleMs < activeMs();
  let newest = null;
  const newestOfLine = () => {
    if (newest !== null) return newest;
    newest = win;
    let best = -1;
    for (const id of [...box.myLine].filter(x => /^local_/.test(x))) {
      try {
        const f = path.join(RUN_DIR, `rewake_${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
        if (!alive(JSON.parse(fs.readFileSync(f, 'utf8')).pid)) continue;
        const t = fs.statSync(f).mtimeMs;
        if (t > best) { best = t; newest = id; }
      } catch (_) {}
    }
    return newest;
  };
  return list.filter(m => {
    if (exact(m)) return true;
    // Another window of the project, named by its id: that one is woken, not this.
    if (/^local_|^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(m.toSession || ''))) return false;
    if (m.toSession && m.toSession !== 'all') return newestOfLine() === win;
    return active;
  });
}

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

const AS_SENDER = ['post_message', 'put_doc', 'invite_to_room', 'set_helper', 'book_stand', 'create_room', 'report_usage'];
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

// The owner pressed Stop work on the board: no hook wakes, holds or feeds a session.
function paused() {
  try { return !!require('./bridge-db').boardPaused(); } catch (_) { return false; }
}

function waiting(win) {
  const { mailbox, oneLine } = board();
  // Only what would wake it (toWake): mail for another window of the same project held a window at
  // the end of some twenty turns in one evening, each only to say "not mine" (24.11.2026).
  const list = toWake(mailbox.urgentFor(AGENT, win, win), mailbox.open(AGENT, win, win), win, 0);
  if (!list.length) return '';
  return `${list.length} unread on the board for this window:\n` + list.slice(-5).map(m => '  ' + oneLine(m)).join('\n') +
    `\nRead them now: get_messages({reader: "${AGENT}", sessionId: "${win}"}) — and answer in the room each one is in.` +
    ' Not yours: end the turn without a word. Never retell board messages in this chat: the owner reads the board ' +
        'himself, and only the lead reports to him.';
}

function prompt(input) {
  if (paused()) return;
  const win = windowOf(input);
  if (!win) return;
  try { require('./listening').markBusy(win, RUN_DIR); } catch (_) {}
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
      const { wakeAntigravity, setWaitLimit } = require('./wake-antigravity');
      setWaitLimit(0);   // a hook ends in a moment: it cannot wait for a busy helper
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
  if (paused()) return;
  const win = windowOf(input);
  if (!win) return;
  // The session's own context, from its transcript: at 80, 88 and 94 % it saves first (context-guard.js).
  let ctx = '';
  try {
    const guard = require('./context-guard');
    const f = guard.fill(input.transcript_path);
    if (guard.due(RUN_DIR, win, f)) ctx = guard.text(f);
  } catch (_) {}
  const text = waiting(win);
  if (!text && !ctx) return;
  process.stdout.write(JSON.stringify({ decision: 'block',
    reason: 'agent-bridge: do not go idle yet. ' + [ctx && ctx.charAt(0).toUpperCase() + ctx.slice(1), text].filter(Boolean).join('\n\n') }));
}

// ── failed ───────────────────────────────────────────────────────────────────────────────

// Errors that pass by themselves: the owner presses retry and the turn goes on.
const PASSING = /^(overloaded|server_error|max_output_tokens)$/;
const OUT_OF_QUOTA = /rate_limit|billing|account_on_hold|credit/i;

function failed(input) {
  const win = windowOf(input);
  // The name of the field that carries the kind of error is not relied on: every
  // likely one is read, and what the client really sent is kept for a look.
  const raw = input.error_type || input.error || input.failure || input.reason || input.stop_reason || '';
  const kind = String(typeof raw === 'object' ? (raw.type || raw.code || JSON.stringify(raw)) : raw).slice(0, 80);
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    const seen = {};
    for (const k of Object.keys(input)) seen[k] = typeof input[k] === 'string' ? input[k].slice(0, 160) : typeof input[k];
    fs.writeFileSync(path.join(RUN_DIR, 'stopfailure_last.json'), JSON.stringify({ at: new Date().toISOString(), seen }, null, 1));
  } catch (_) {}
  if (PASSING.test(kind)) return;

  const cardsLib = require('./cards');
  const card = win ? cardsLib.claudeWindowOfCli(win) : null;
  const folder = (card && card.project) || input.cwd || process.cwd();
  const rescue = require('./rescue');
  const info = input.transcript_path ? rescue.ending(input.transcript_path) : { why: '' };
  const limit = OUT_OF_QUOTA.test(kind) || /limit/i.test(info.certain ? info.why : '');
  const why = (limit ? 'the usage limit was reached' : 'the turn ended on an error') + (kind ? ` (${kind})` : '') +
    (info.certain && info.why ? ': ' + info.why : '');
  const r = rescue.rescueProject(folder, { transcript: input.transcript_path || '', why, force: true });
  if (limit && card && card.account) require('./claude-quota').exhausted({ account: card.account, win, why: info.certain ? info.why : kind });

  // Told on the board and on the screen. A turn that ran out of quota is announced by
  // the supervisor's quota ticker within a minute; here only when that is switched off.
  let sv = {};
  try { sv = JSON.parse(fs.readFileSync(path.join(HOME, 'bridge_config.json'), 'utf8')).supervisor || {}; } catch (_) {}
  const name = path.basename(String(folder).split(String.fromCharCode(92)).join('/'));
  if (r && r.written) {
    try {
      const bridgeDb = require('./bridge-db');
      const rec = { ts: new Date().toISOString(), from: 'Supervisor', fromSession: 'supervisor/board', room: sv.room || '', to: 'all',
        toSession: 'human/web', replyTo: null, topic: 'supervisor', priority: 'normal', status: 'info', progress: '', file: null, readBy: [],
        message: `Supervisor: the session of project "${name}" was cut off — ${why}. What it was doing is saved in its slice: ${r.file}.` };
      bridgeDb.addMessage(rec);
      if (rec.room) bridgeDb.touchRoom(rec.room);
    } catch (_) {}
  }
  if (!(limit && sv.enabled)) {
    const alert = require('./alert');
    alert.show(alert.t('headCut'), [alert.t('cut', { project: name, why })]);
  }
}

// ── statusline ───────────────────────────────────────────────────────────────────────────

function statusline(input) {
  const claudeQuota = require('./claude-quota');
  const usage = claudeQuota.fromStatusline(input);
  if (!usage) return;
  const win = windowOf(input);
  let account = '';
  try { const c = win && require('./cards').claudeWindowOfCli(win); account = (c && c.account) || ''; } catch (_) {}
  claudeQuota.report({ account: account || 'cli', win: win || String(input.session_id || ''), usage, by: 'statusline' });
  const bits = [];
  if (usage.context && usage.context.size) bits.push('ctx ' + Math.round(100 * usage.context.tokens / usage.context.size) + '%');
  for (const w of usage.windows) bits.push((/5/.test(w.label) ? '5h ' : '7d ') + Math.round(w.used) + '%');
  process.stdout.write(bits.join(' · '));
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
  try { require('./listening').clearBusy(win, RUN_DIR); } catch (_) {}
  const mine = () => { try { return JSON.parse(fs.readFileSync(lock, 'utf8')).token === token; } catch (_) { return false; } };

  const session = Number(process.env.CLAUDE_PID || 0);
  const started = Date.now();
  // Where to count from: what this window has read, not the newest message on the board. Counted
  // from the newest, a message that came while the window was at work — after its last read, before
  // its turn ended — was never seen, and the window slept through it (24.11.2026: five live windows,
  // the owner's own messages among those missed). A message it was already woken for is not woken
  // for again (woken_<window>.json), so a window that will not read is not woken in a loop.
  const wokenFile = path.join(RUN_DIR, `woken_${safe}.json`);
  let woken = 0;
  try { woken = Number(JSON.parse(fs.readFileSync(wokenFile, 'utf8')).id) || 0; } catch (_) {}
  let newest = 0;
  try { newest = bridgeDb.getDb().prepare('SELECT COALESCE(MAX(id), 0) n FROM messages').get().n; } catch (_) {}
  let read = null;
  try { read = mailbox.ownCursor(AGENT, win); } catch (_) {}
  let seen = read === null ? newest : Math.max(Number(read) || 0, woken);

  // Its turn is over: the stands it holds are free for the others, and whoever waits for one is
  // told (stands.js). It books again when it needs one again.
  try {
    const { wakeAntigravity, setWaitLimit } = require('./wake-antigravity');
    setWaitLimit(0);
    const { router } = board();
    const stands = require('./stands').createStands(bridgeDb, router, rec => wakeAntigravity(rec));
    for (const s of stands.heldBy(win)) stands.free(s, `"${router.nameOf(win)}" ended its turn; a stand is freed when its holder goes idle`);
  } catch (_) {}

  const tick = () => {
    if (!mine() || monitored() || Date.now() - started > WATCH_MAX_MS || (session && !alive(session))) {
      if (mine()) { try { fs.unlinkSync(lock); } catch (_) {} }
      process.exit(0);
    }
    // Stopped by the owner: what arrives meanwhile does not wake this window, now or after.
    if (paused()) {
      try { seen = bridgeDb.getDb().prepare('SELECT COALESCE(MAX(id), 0) n FROM messages').get().n; } catch (_) {}
      return;
    }
    let list = [];
    try { list = toWake(mailbox.urgentFor(AGENT, win, win, seen), mailbox.open(AGENT, win, win), win, Date.now() - started); } catch (_) {}
    if (list.length) {
      try { fs.unlinkSync(lock); } catch (_) {}
      try { fs.writeFileSync(wokenFile, JSON.stringify({ id: Math.max(...list.map(m => Number(m.id) || 0)) })); } catch (_) {}
      try { require('./listening').markBusy(win, RUN_DIR); } catch (_) {}
      process.stderr.write(`agent-bridge: ${list.length} new on the board for this window:\n` +
        list.slice(-5).map(m => '  ' + oneLine(m)).join('\n') +
        `\nRead and answer now: get_messages({reader: "${AGENT}", sessionId: "${win}"}). Answer on the board, in its room.` +
        ' Not yours: end the turn without a word. Never retell board messages in this chat: the owner reads the board ' +
        'himself, and only the lead reports to him.' + '\n');
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
    else if (mode === 'failed') failed(input);
    else if (mode === 'statusline') statusline(input);
    else if (mode === 'watch') watch(input);
  } catch (_) { /* never the session's problem */ }
});
