'use strict';
// A lead that changed windows — an account switch, a restart — picks up where the
// last one stopped, even when that one was cut off before it wrote its slice.
//
// Two sources, because each knows something the other does not:
//   1. The previous window's own transcript. Both Claude accounts keep their sessions
//      in the one ~/.claude/projects folder, so a new window can read how the last one
//      ended. Shown at session start when that window was active after the slice was
//      last written — which is exactly when the slice cannot be trusted.
//   2. The helper. It holds the context of what it was asked and what it did. When its
//      lead's project opens in a new window, the board asks it, once per window, to post
//      a handover in their room.
// Owner, 11.11.2026: the second account's lead should take the first one's place, and
// the helper keep its context.

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS = path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'projects');
const TAIL_BYTES = 600 * 1024;
const FRESH_MS = 7 * 86400e3;

// Claude Code names a project's transcript folder after its path, every character
// that is not a letter or a digit turned into "-" (the drive colon and each separator too).
function transcriptDir(cwd) {
  return path.join(PROJECTS, String(cwd || '').replace(/[^A-Za-z0-9]/g, '-'));
}

// What a person would call the conversation: the words, not the tool traffic.
function textOf(entry) {
  const c = entry && entry.message && entry.message.content;
  const parts = typeof c === 'string' ? [c]
    : Array.isArray(c) ? c.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text) : [];
  const t = parts.join('\n')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .trim();
  if (!t || /^<(task-notification|command-name|local-command-stdout|bash-|user-memory)/.test(t)) return '';
  return t;
}

function readTail(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift();                 // the first line was cut in half
    return lines;
  } finally { fs.closeSync(fd); }
}

// When this window last answered: the newest assistant entry of its own transcript,
// or 0 for a window that has not answered yet (a new one).
function lastAnswer(file) {
  let last = 0;
  try {
    for (const line of readTail(file)) {
      if (line.indexOf('"assistant"') < 0) continue;
      let e; try { e = JSON.parse(line); } catch (_) { continue; }
      if (e && e.type === 'assistant' && !e.isSidechain && e.timestamp) last = Math.max(last, Date.parse(e.timestamp) || 0);
    }
  } catch (_) {}
  return last;
}

// Another window of this project that went on after this one knew the state:
// { file, endedAt, sliceAt, since, resumed, turns: [{who, text}] } or null.
// A new window knows the state from the slice, so the slice is the mark. A window
// that comes back — an old conversation reopened, possibly in the other account —
// knows it from its own last answer, and is behind whenever another window worked
// after that, even when that window did update the slice: it read the slice long ago.
function previousWindow(cwd, currentSession, opts) {
  const o = opts || {};
  const dir = transcriptDir(cwd);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && f !== String(currentSession || '') + '.jsonl'); } catch (_) { return null; }
  const newest = files.map(f => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  if (!newest || Date.now() - newest.m > FRESH_MS) return null;
  let slice = 0;
  try { slice = fs.statSync(path.join(cwd, '.agents', 'HANDOFF.md')).mtimeMs; } catch (_) {}
  const mine = currentSession ? lastAnswer(path.join(dir, String(currentSession) + '.jsonl')) : 0;
  const since = mine || slice;
  if (newest.m <= since + 60e3) return null;        // nothing happened elsewhere since
  const turns = [];
  for (const line of readTail(newest.f)) {
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; }
    if (!e || (e.type !== 'user' && e.type !== 'assistant') || e.isSidechain || e.isMeta) continue;
    const text = textOf(e);
    if (text) turns.push({ who: e.type === 'user' ? 'owner' : 'lead', text, at: e.timestamp || '' });
  }
  if (!turns.length) return null;
  return { file: newest.f, endedAt: new Date(newest.m).toISOString(), sliceAt: slice ? new Date(slice).toISOString() : '',
           since: new Date(since).toISOString(), resumed: !!mine, mtime: newest.m, turns: turns.slice(-(o.turns || 6)) };
}

const RUN_DIR = process.env.BRIDGE_RUN_DIR || path.join(__dirname, 'run');

function briefLines(cwd, currentSession) {
  const p = previousWindow(cwd, currentSession);
  if (!p) return [];
  // Once per piece of work done elsewhere: the start brief and every prompt ask, the
  // first one to see it tells, the rest stay quiet until that window works again.
  const mark = path.join(RUN_DIR, 'catchup_' + String(currentSession || 'none').replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
  try { if (JSON.parse(fs.readFileSync(mark, 'utf8')).seen >= p.mtime) return []; } catch (_) {}
  try { fs.mkdirSync(RUN_DIR, { recursive: true }); fs.writeFileSync(mark, JSON.stringify({ seen: p.mtime })); } catch (_) {}
  const cut = s => s.length > 420 ? s.slice(0, 420).replace(/\s+\S*$/, '') + ' …' : s;
  const head = p.resumed
    ? `🔁 Another window of this project (maybe the other account) worked after this one last answered ` +
      `(${p.since.slice(0, 16)}Z), until ${p.endedAt.slice(0, 16)}Z. What you remember is behind: reread ` +
      `.agents/HANDOFF.md (written ${p.sliceAt ? p.sliceAt.slice(0, 16) + 'Z' : 'never'}) and git log since ${p.since.slice(0, 16)}Z ` +
      'before you act on anything from memory. How that window ended:'
    : `🔁 The previous window of this project went on until ${p.endedAt.slice(0, 16)}Z, ` +
      (p.sliceAt ? `after the slice was last written (${p.sliceAt.slice(0, 16)}Z)` : 'and this project has no slice') +
      ' — so the slice may be behind. How it ended:';
  return [
    head,
    ...p.turns.map(t => `   ${t.who === 'owner' ? '👤 owner' : '🤖 lead'}: ${cut(t.text.replace(/\s+/g, ' '))}`),
    `   Full transcript: ${p.file.split(path.sep).join('/')} (read its end if this is not enough).`,
    '   Before you go on: bring the slice up to date from this, and from your helper\'s handover if one is asked below.'
  ];
}

// Ask each helper of this lead for a handover, once per new window of the lead.
// Returns the lines for the brief. `post` writes a board message and wakes the helper.
function askHelpers({ bridgeDb, router, win, post, now }) {
  const out = [];
  if (!win || router.agentOf(win) !== 'Claude') return out;
  let pairs = [];
  try { pairs = bridgeDb.readHelpers().filter(h => router.same(h.lead, win)); } catch (_) { return out; }
  const t = now || Date.now();
  for (const h of pairs) {
    if (!h.room) continue;
    const inRoom = bridgeDb.readAllMessages().filter(m => m.room === h.room);
    const lead = new Set(bridgeDb.cluster(h.lead).concat(bridgeDb.cluster(win)).map(String));
    const lastLead = [...inRoom].reverse().find(m => lead.has(String(m.fromSession)) || router.same(m.fromSession, h.lead));
    if (!lastLead || String(lastLead.fromSession) === String(win)) continue;     // same window, nothing changed
    if (router.windowOf(lastLead.fromSession) === win) continue;
    if (t - new Date(lastLead.ts).getTime() > 3 * 86400e3) continue;            // old work: the slice is the source
    if (inRoom.some(m => m.topic === 'handover' && String(m.fromSession) === String(win) && m.id > lastLead.id)) {
      out.push(`🤝 Handover from your helper "${router.nameOf(h.helper)}" was asked in room "${h.room}" — read it there.`);
      continue;
    }
    post({
      room: h.room, to: 'Gemini', toSession: h.helper, from: 'Claude', fromSession: win, topic: 'handover',
      message: 'Your lead continues in a new window (an account switch or a restart); the last one may have been cut off ' +
        'mid-task. Post a handover here now, before anything else: the last task your lead gave you, what you did ' +
        '(files, commits, what is on the device), what is still open, and what the lead said it would do next. ' +
        'Facts only, short. Then wait for the lead.'
    });
    out.push(`🤝 Your helper "${router.nameOf(h.helper)}" was asked for a handover in room "${h.room}" — read it before you go on.`);
  }
  return out;
}

module.exports = { transcriptDir, textOf, lastAnswer, previousWindow, briefLines, askHelpers };

// node handover.js <cwd> <sessionId> → the transcript lines for the session-start brief.
if (require.main === module) {
  try {
    const [cwd, session] = process.argv.slice(2);
    process.stdout.write(briefLines(cwd || process.cwd(), session || '').join('\n'));
  } catch (_) {}
}
