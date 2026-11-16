'use strict';
// What a session was doing when it was cut off, written into its project's slice.
//
// A session that hits the usage limit, crashes or is closed in the middle of a turn
// writes no slice: that is exactly the turn it did not finish. The owner then opens
// the project in the other account and the new window starts from a slice that is an
// hour behind, or reads the whole transcript to find out (owner, 16.11.2026: "teach
// it to read the transcript of a session cut off mid-word and save its context in
// that session's slice").
//
// Everything a new window needs first is in the transcript and in git, and reading
// them needs no model: the owner's last request, the last things the lead said, the
// tool call that was running, what is uncommitted, what was committed after the slice.
// It is written as one marked block at the top of .agents/HANDOFF.md — the lead's own
// words below it are not touched. The block says what it is: facts lifted by the
// board, for the next window to check, fold into the slice and delete.
//
// Two callers: the StopFailure hook, the moment a turn ends on an error (bridge-hook.js,
// mode `failed`), and the supervisor's round, for a session that died without a word.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const handover = require('./handover');

const QUIET_MIN = 10;          // a transcript younger than this may simply still be working
// A turn that ended on an error message is cut off for certain. One that merely stops after a
// tool call or a prompt may be waiting — for a permission, for a long command — so it is
// called cut off only after this much silence.
const SILENT_MIN = 60;
const START = '<!-- board-rescue:start -->';
const END = '<!-- board-rescue:end -->';
const LIMIT_WORDS = /hit your [^.]{0,40}limit|usage limit|rate limit|prompt is too long|api error|overloaded|credit balance/i;

const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + ' …' : s; };

// How a transcript ends: { cut, why, lastOwner, said: [..], inFlight, endedAt, file }.
function ending(file) {
  const out = { cut: false, why: '', lastOwner: '', said: [], inFlight: '', endedAt: '', file };
  let lines;
  try { out.endedAt = new Date(fs.statSync(file).mtimeMs).toISOString(); lines = handover.readTail(file); } catch (_) { return out; }
  const open = new Map();                 // tool calls not answered yet: id → description
  let last = '', lastTool = '', errorText = '';
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; }
    if (!e || (e.type !== 'user' && e.type !== 'assistant') || e.isSidechain || e.isMeta) continue;
    const content = e.message && e.message.content;
    const parts = Array.isArray(content) ? content : [];
    if (e.type === 'assistant') {
      const text = handover.textOf(e);
      errorText = e.isApiErrorMessage || (text && text.length < 300 && LIMIT_WORDS.test(text)) ? text : '';
      if (text && !errorText) out.said.push(text);
      for (const p of parts) {
        if (!p || p.type !== 'tool_use') continue;
        const i = p.input || {};
        const what = i.command || i.file_path || i.path || i.pattern || i.url || i.description || i.prompt || '';
        lastTool = String(p.name || 'tool') + (what ? ' — ' + cut(what, 200) : '');
        open.set(p.id, lastTool);
      }
      last = 'assistant';
    } else {
      for (const p of parts) if (p && p.type === 'tool_result') open.delete(p.tool_use_id);
      const text = handover.textOf(e);
      if (text && !/^This session is being continued from a previous conversation/.test(text)) out.lastOwner = text;
      errorText = '';
      last = 'user';
    }
  }
  out.said = out.said.slice(-3);
  if (errorText) { out.cut = true; out.certain = true; out.why = cut(errorText, 140); out.inFlight = lastTool; }
  else if (open.size) { out.cut = true; out.inFlight = [...open.values()].pop(); out.why = 'it stopped while a tool call was running'; }
  else if (last === 'user') { out.cut = true; out.why = 'it stopped before it answered'; out.inFlight = lastTool; }
  return out;
}

function git(folder, ...args) {
  const r = spawnSync('git', ['-C', folder, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

// The block, as text. `info` is what ending() returned; `why` overrides its reason.
function block(folder, info, why) {
  const slice = path.join(folder, '.agents', 'HANDOFF.md');
  let sliceAt = 0;
  try { sliceAt = fs.statSync(slice).mtimeMs; } catch (_) {}
  const dirty = git(folder, 'status', '--porcelain').split('\n').filter(l => l && !l.startsWith('??'))
    .map(l => l.replace(/^\s*\S+\s+/, ''));
  const commits = sliceAt ? git(folder, 'log', '--since=' + new Date(sliceAt).toISOString(), '--format=%h %s', '-8').split('\n').filter(Boolean) : [];
  const out = [
    START,
    `## 🛟 Cut off — read this first (written by the board from the transcript, ${new Date().toISOString().slice(0, 16)}Z)`,
    `The last session of this project stopped in the middle of its work: ${why || info.why || 'reason unknown'} ` +
      `(transcript ends ${String(info.endedAt).slice(0, 16)}Z). These are facts lifted from the transcript and from git, not the ` +
      'lead\'s own slice: check them, fold what holds into the slice below, then delete this block.'
  ];
  if (info.lastOwner) out.push('- **The owner\'s last request:** ' + cut(info.lastOwner, 500));
  if (info.said.length) out.push('- **The last things the lead said:** ' + info.said.map((s, i) => `(${i + 1}) ${cut(s, 320)}`).join(' '));
  if (info.inFlight) out.push('- **Running when it stopped:** ' + cut(info.inFlight, 260));
  if (dirty.length) out.push(`- **Uncommitted files (${dirty.length}):** ` + dirty.slice(0, 12).join(', ') + (dirty.length > 12 ? ' …' : ''));
  if (commits.length) out.push('- **Commits made after the slice was written:** ' + commits.map(c => cut(c, 90)).join('; '));
  out.push('- **Transcript:** ' + String(info.file).split(path.sep).join('/'), END);
  return out.join('\n');
}

// Put the block at the top of the slice, in place of an older block if there is one.
function writeBlock(folder, text) {
  const dir = path.join(folder, '.agents');
  if (!fs.existsSync(dir)) return '';                        // a project that keeps no notes: nothing to write into
  const file = path.join(dir, 'HANDOFF.md');
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch (_) {}
  const a = cur.indexOf(START), b = cur.indexOf(END);
  let next;
  if (a >= 0 && b > a) next = cur.slice(0, a) + text + cur.slice(b + END.length);
  else if (!cur.trim()) next = `# Slice — ${path.basename(folder)}\n\n${text}\n`;
  else {
    const nl = cur.indexOf('\n');                            // keep the title line on top
    const title = /^#\s/.test(cur) && nl > 0;
    next = title ? cur.slice(0, nl + 1) + '\n' + text + '\n' + cur.slice(nl + 1) : text + '\n\n' + cur;
  }
  fs.writeFileSync(file, next, 'utf8');
  return file;
}

// Rescue one project. opts: { seen, transcript, why, force }.
//   seen        the key of the ending already handled: nothing is written twice
//   transcript  the file to read (the hook knows it); else the project's newest
//   why         the reason, when the caller knows it better than the transcript does
//   force       write even when the transcript does not look cut (the hook: the turn failed)
// Returns { written, key, why, file } or null when there is nothing to do.
function rescueProject(folder, opts) {
  const o = opts || {};
  let file = o.transcript || '';
  if (!file) {
    const dir = handover.transcriptDir(folder);
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)); } catch (_) { return null; }
    file = files.map(f => ({ f, m: fs.statSync(f).mtimeMs })).sort((x, y) => y.m - x.m).map(x => x.f)[0] || '';
  }
  if (!file) return null;
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch (_) { return null; }
  const key = path.basename(file) + ':' + Math.round(mtime / 1000);
  if (o.seen === key) return null;
  if (!o.force) {
    if (Date.now() - mtime < QUIET_MIN * 60000) return null;                 // may still be working
    let sliceAt = 0;
    try { sliceAt = fs.statSync(path.join(folder, '.agents', 'HANDOFF.md')).mtimeMs; } catch (_) {}
    if (sliceAt > mtime - 60000) return null;                                // the slice was written at the end: it is whole
  }
  const info = ending(file);
  if (!info.cut && !o.force) return null;
  if (!o.force && !info.certain && Date.now() - mtime < SILENT_MIN * 60000) return null;
  const why = o.why || info.why;
  const written = writeBlock(folder, block(folder, info, why));
  return written ? { written: true, key, why, file: written.split(path.sep).join('/') } : { written: false, key, why, file: '' };
}

module.exports = { ending, block, writeBlock, rescueProject, QUIET_MIN, START, END };

// node rescue.js <project folder> [--dry]  → what would be written (dry), or write it
if (require.main === module) {
  const [folder, flag] = process.argv.slice(2);
  if (flag === '--dry') {
    const dir = handover.transcriptDir(folder);
    const f = fs.readdirSync(dir).filter(x => x.endsWith('.jsonl')).map(x => path.join(dir, x))
      .sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs)[0];
    const info = ending(f);
    console.log(JSON.stringify({ cut: info.cut, why: info.why }) + '\n' + block(folder, info));
  } else console.log(JSON.stringify(rescueProject(folder, { force: true })));
}
