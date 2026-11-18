'use strict';
// How full a Claude session's context is, read from its own transcript, and when to make it save.
//
// The owner, 18.11.2026: by the time a session learns it is short of room it has lost the work —
// the slice was not rewritten before the compaction. The bridge knew a session's fill only when
// the session happened to report its usage (report_usage), which is minutes or hours old. The
// transcript knows it after every turn: each assistant entry carries the tokens the model was given
// (input + cache read + cache written), which is the context the session now carries.
//
// At 80, 88 and 94 per cent the Stop hook holds the session once per step and has it rewrite its
// slice and commit before it goes idle. A compaction empties the context and starts the steps again.

const fs = require('fs');
const path = require('path');

const STEPS = [80, 88, 94];
const TAIL_BYTES = 2 * 1024 * 1024;

// The model's window, for the models this machine runs: the 5 family carries a million tokens.
function windowOf(model, reported) {
  if (Number(reported) > 0) return Number(reported);
  return /claude-(opus|fable|sonnet|haiku)-5/i.test(String(model || '')) ? 1000000 : 200000;
}

function tail(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift();
    return lines;
  } finally { fs.closeSync(fd); }
}

// { tokens, size, pct, model } of the newest main-thread assistant turn, or null.
function fill(transcript, reportedSize) {
  if (!transcript) return null;
  let lines;
  try { lines = tail(transcript); } catch (_) { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l || l.indexOf('"usage"') < 0) continue;
    let e;
    try { e = JSON.parse(l); } catch (_) { continue; }
    if (e.type !== 'assistant' || e.isSidechain) continue;
    const u = (e.message && e.message.usage) || null;
    if (!u) continue;
    const tokens = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
    const size = windowOf(e.message.model, reportedSize);
    return { tokens, size, pct: Math.round(100 * tokens / size), model: e.message.model || '' };
  }
  return null;
}

// The step this fill has newly reached for this window (remembered in runDir), or 0.
function due(runDir, win, f) {
  if (!f || !win) return 0;
  const step = STEPS.filter(s => f.pct >= s).pop() || 0;
  const file = path.join(runDir, 'ctx_' + String(win).replace(/[^\w.-]/g, '_') + '.json');
  let had = 0;
  try { had = JSON.parse(fs.readFileSync(file, 'utf8')).step || 0; } catch (_) {}
  if (step < had) { try { fs.writeFileSync(file, JSON.stringify({ step, at: new Date().toISOString() })); } catch (_) {} return 0; }
  if (!step || step === had) return 0;
  try { fs.mkdirSync(runDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ step, at: new Date().toISOString() })); } catch (_) {}
  return step;
}

function text(f) {
  const k = n => Math.round(n / 1000) + 'k';
  return `the context of this session is at ${f.pct} % (${k(f.tokens)} of ${k(f.size)} tokens); it is compacted at about 97 %. ` +
    'Before anything else: rewrite .agents/HANDOFF.md (state, the exact next step, what your helpers hold), commit what is ' +
    'verified, then go on with small steps.' + (f.pct >= 94 ? ' This is the last warning before the compaction.' : '');
}

module.exports = { fill, due, text, windowOf, STEPS };
