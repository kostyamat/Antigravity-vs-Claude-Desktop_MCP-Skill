#!/usr/bin/env node
// ═════════════════════════════════════════════════════════════════════════════════════════
// 🖥️  AGENT-BRIDGE BOARD VIEWER — Local Web UI for Human & Cross-Agent Oversight
//
// Redesign in Google Gemini Web style (https://gemini.google.com):
//   • Two-level message card hierarchy (human message on top, technical muted below).
//   • Custom clear session names with inline rename ✏️ in the UI.
//   • P0 counter strictly for active unread messages for the user (hidden when 0).
//   • English UI with machine tokens wrapped in <code class="nt">,
//     allowing the browser's built-in translator to cleanly translate human text
//     without breaking system identifiers.
//   • Full backward compatibility: SQLite WAL (bridge-db), byte-for-byte format,
//     incremental rendering, preserving original on edit, wakeAntigravity.
//
// Run: node board-ui.js
// ═════════════════════════════════════════════════════════════════════════════════════════
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const bridgeDb = require('./bridge-db');
const { wakeAntigravity } = require('./wake-antigravity');

const SCRIPTS_DIR = path.resolve(__dirname);
const LOG_FILE = path.join(SCRIPTS_DIR, 'board_ui_stderr.log');

process.on('uncaughtException', err => {
  if (err && (err.code === 'EPIPE' || err.code === 'EBADF')) return;
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} Uncaught: ${err && err.stack ? err.stack : err}\n`);
  } catch (_) {}
});
process.on('exit', code => {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} PROCESS EXIT code=${code}\n`);
  } catch (_) {}
});
process.on('beforeExit', code => {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} BEFORE EXIT code=${code}\n`);
  } catch (_) {}
});

const BRIDGE_FILE = path.join(SCRIPTS_DIR, 'agent_bridge.json');
const BODIES_DIR = path.join(SCRIPTS_DIR, 'agent_bridge_bodies');
const P0_FLAG_FILE = path.join(SCRIPTS_DIR, 'P0_PENDING.txt');
const HOST = '127.0.0.1';
const PORT_FROM = 8787;
const INLINE_LIMIT = 4000;

const PRIORITIES = ['P0', 'normal', 'fyi'];
const STATUSES = ['info', 'question', 'answer', 'working', 'done', 'blocked', 'ack'];

// ── Board (SQLite via bridge-db) ────────────────────────────────────────────────────────
function readBoard() {
  try {
    return bridgeDb.readAllMessages();
  } catch (e) {
    console.error('Board cannot be read:', e.message);
    return [];
  }
}

const CONFIG_FILE = path.join(SCRIPTS_DIR, 'bridge_config.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}

const BACKUP_DIR = path.join(SCRIPTS_DIR, 'agent_bridge_backups');
const BACKUP_KEEP = 40;

function validateBoard(board) {
  if (!Array.isArray(board)) return 'board must be an array';
  const ids = new Set();
  for (const m of board) {
    if (!m || typeof m !== 'object') return 'record is not an object';
    if (typeof m.id !== 'number') return 'record without numeric id';
    if (ids.has(m.id)) return `id #${m.id} duplicate`;
    ids.add(m.id);
  }
  return null;
}

function validateNew(rec) {
  if (!rec.from || typeof rec.from !== 'string') return 'missing author';
  if (typeof rec.message !== 'string' || !rec.message.trim()) return 'empty message text';
  if (rec.id !== undefined && typeof rec.id !== 'number') return 'invalid id';
  if (!PRIORITIES.includes(rec.priority)) return 'unknown priority';
  if (!STATUSES.includes(rec.status)) return 'unknown status';
  return null;
}

function backupBoard() {
  try {
    if (!fs.existsSync(BRIDGE_FILE)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(BRIDGE_FILE, path.join(BACKUP_DIR, `board_${stamp}.json`));
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('board_')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {}
    }
  } catch (e) {
    console.error('Backup failed:', e.message);
  }
}

function bodyOf(m) {
  if (m.file && fs.existsSync(m.file)) {
    try { return fs.readFileSync(m.file, 'utf8'); } catch (_) {}
  }
  return m.message || '';
}

// ── API ──────────────────────────────────────────────────────────────────────────────────
function apiBoard() {
  const board = readBoard();
  if (board === null) return { error: 'Failed to read board' };
  let cursors = {};
  try { cursors = bridgeDb.readCursors(); } catch (_) {}
  return {
    cursors,
    messages: board.map(m => ({
      id: m.id, ts: m.ts, from: m.from, fromSession: m.fromSession || '',
      to: m.to || 'all', toSession: m.toSession || '', replyTo: m.replyTo || null,
      topic: m.topic || '', priority: m.priority || 'normal', status: m.status || 'info',
      progress: m.progress || '', text: bodyOf(m), hasFile: !!m.file,
      editedAt: m.editedAt || null, editedBy: m.editedBy || null
    }))
  };
}

function apiPost(data) {
  const from = (data.from || '').trim();
  const text = (data.text || '').trim();
  if (!from) return { error: 'Author is required' };
  if (!text) return { error: 'Message text is empty' };

  const priority = PRIORITIES.includes(data.priority) ? data.priority : 'normal';
  const status = STATUSES.includes(data.status) ? data.status : 'info';
  let to = (data.to || '').trim();
  let toSession = (data.toSession || '').trim();
  let topic = (data.topic || '').trim();
  const replyTo = data.replyTo ? Number(data.replyTo) : null;

  // 🧵 Preserve conversation thread context when replying from UI
  if (replyTo) {
    const parent = bridgeDb.getMessageById(replyTo);
    if (parent) {
      if (!to || to === 'all') to = parent.from;
      if (!toSession) toSession = parent.fromSession || '';
      if (!topic && parent.topic) topic = parent.topic;
    }
  }
  if (!to) to = 'all';

  const rec = {
    ts: new Date().toISOString(),
    from,
    fromSession: data.fromSession || 'human/web',
    to,
    toSession,
    replyTo,
    topic,
    priority,
    status,
    progress: '',
    message: text.length > INLINE_LIMIT ? (text.slice(0, INLINE_LIMIT) + '\n…') : text,
    file: null,
    readBy: []
  };

  const bad = validateNew(rec);
  if (bad) return { error: 'Message rejected: ' + bad };

  // 🛡️ Guard against duplicate posts within 60 seconds (Claude #119)
  const dup = bridgeDb.findRecentDuplicate(from, rec.message, 60);
  if (dup) return { ok: true, id: dup.id, duplicate: true };

  const saved = bridgeDb.addMessage(rec);
  const nextId = saved.id;
  rec.id = nextId;

  if (text.length > INLINE_LIMIT) {
    if (!fs.existsSync(BODIES_DIR)) fs.mkdirSync(BODIES_DIR, { recursive: true });
    const file = path.join(BODIES_DIR, `msg_${String(nextId).padStart(4, '0')}.md`);
    fs.writeFileSync(file, text, 'utf8');
    bridgeDb.updateMessage(nextId, { file });
    rec.file = file;
  }

  if (priority === 'P0') {
    try {
      fs.writeFileSync(P0_FLAG_FILE,
        `${rec.ts}\t#${rec.id}\t${from} → ${rec.to}\t${rec.topic}\n`, { flag: 'a' });
    } catch (_) {}
  }
  wakeAntigravity(rec);
  return { ok: true, id: nextId };
}

function apiEdit(data) {
  const id = Number(data.id);
  const text = (data.text || '').trim();
  if (!id || !text) return { error: 'id and text are required' };
  const m = bridgeDb.getMessageById(id);
  if (!m) return { error: `#${id} does not exist on board` };

  const updates = {
    editedAt: new Date().toISOString(),
    editedBy: (data.editedBy || 'human').trim()
  };
  if (!m.originalMessage) updates.originalMessage = m.message;

  if (m.file && fs.existsSync(m.file)) {
    try { fs.writeFileSync(m.file, text, 'utf8'); } catch (_) {}
    updates.message = text.slice(0, INLINE_LIMIT) + (text.length > INLINE_LIMIT ? '\n…' : '');
  } else if (text.length > INLINE_LIMIT) {
    if (!fs.existsSync(BODIES_DIR)) fs.mkdirSync(BODIES_DIR, { recursive: true });
    const file = path.join(BODIES_DIR, `msg_${String(id).padStart(4, '0')}.md`);
    fs.writeFileSync(file, text, 'utf8');
    updates.file = file;
    updates.message = text.slice(0, INLINE_LIMIT) + '\n…';
  } else {
    updates.message = text;
  }

  bridgeDb.updateMessage(id, updates);
  return { ok: true, id };
}

// ── Sessions ────────────────────────────────────────────────────────────────────────────
const SESSIONS_REG = path.join(SCRIPTS_DIR, 'docs', '_sessions.json');
const SESSIONS_DIR = path.join(SCRIPTS_DIR, 'docs', 'sessions');

function slug(s, fallback) {
  const v = String(s || '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gui, '-')
    .replace(/^-+|-+$/g, '');
  return v || fallback || 'unknown';
}

function apiSessions() {
  let reg = {};
  try { reg = bridgeDb.readSessions(); } catch (_) {}
  if (!Object.keys(reg).length) {
    try { reg = JSON.parse(fs.readFileSync(SESSIONS_REG, 'utf8')) || {}; } catch (_) {}
  }
  const board = readBoard() || [];
  const out = Object.keys(reg).map(k => {
    const s = reg[k];
    const msgs = board.filter(m => (m.fromSession || '') === s.sessionId);
    const snap = path.join(SESSIONS_DIR, `${slug(s.agent, 'agent')}__${slug(s.sessionId, 'session')}.md`);
    return {
      key: k,
      agent: s.agent,
      sessionId: s.sessionId,
      customName: s.customName || '',
      topics: (s.topics || []).slice(0, 14),
      summary: s.summary || '',
      project: s.project || '',
      lastSeen: s.lastSeen || (msgs.length ? msgs[msgs.length - 1].ts : ''),
      messages: msgs.length,
      hasSnapshot: fs.existsSync(snap)
    };
  });
  out.sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
  return { sessions: out };
}

function apiSnapshot(q) {
  const file = path.join(SESSIONS_DIR, `${slug(q.agent, 'agent')}__${slug(q.session, 'session')}.md`);
  if (!fs.existsSync(file)) return { error: 'No snapshot available for this session yet' };
  try { return { text: fs.readFileSync(file, 'utf8') }; }
  catch (e) { return { error: e.message }; }
}

function apiDocs() {
  try {
    const docs = bridgeDb.readDocsIndex();
    return { docs };
  } catch (e) {
    return { docs: [] };
  }
}

function apiDocText(name) {
  try {
    const docs = bridgeDb.readDocsIndex();
    const d = docs.find(x => x.name === name);
    if (!d) return { error: 'Document not found' };
    const fullPath = d.file && fs.existsSync(d.file) ? d.file : path.join(SCRIPTS_DIR, 'docs', name);
    if (!fs.existsSync(fullPath)) return { error: 'File not found on disk' };
    return { name: d.name, title: d.title, topic: d.topic, from: d.from, to: d.to, created: d.created, text: fs.readFileSync(fullPath, 'utf8') };
  } catch (e) {
    return { error: e.message };
  }
}

// ── HTML ─────────────────────────────────────────────────────────────────────────────────
const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Bridge</title>
<style>
:root {
  --bg: #131314;
  --surface: #1e1f20;
  --surface-variant: #282a2c;
  --surface-hover: #333538;
  --surface-container: #212122;
  --border: #333538;
  --border-subtle: #26282b;
  --ink: #e3e3e3;
  --ink-secondary: #c4c7c5;
  --ink-dim: #8e918f;
  --accent: #a8c7fa;
  --accent-hover: #d3e3fd;
  --accent-subtle: rgba(168, 199, 250, 0.12);
  --claude: #f59e0b;
  --claude-bg: rgba(245, 158, 11, 0.12);
  --gemini: #7cacf8;
  --gemini-bg: rgba(124, 172, 248, 0.12);
  --human: #34a853;
  --human-bg: rgba(52, 168, 83, 0.12);
  --p0: #ea4335;
  --p0-bg: rgba(234, 67, 53, 0.18);
  --mono: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace;
  --sans: "Google Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-xl: 24px;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f8fafd;
    --surface: #ffffff;
    --surface-variant: #f0f4f9;
    --surface-hover: #e9eef6;
    --surface-container: #edf2fa;
    --border: #e1e3e1;
    --border-subtle: #eeeff1;
    --ink: #1f1f1f;
    --ink-secondary: #444746;
    --ink-dim: #747775;
    --accent: #0b57d0;
    --accent-hover: #0842a0;
    --accent-subtle: #e8f0fe;
    --claude: #b45309;
    --claude-bg: #fef3c7;
    --gemini: #1a73e8;
    --gemini-bg: #e8f0fe;
    --human: #1e8e3e;
    --human-bg: #e6f4ea;
    --p0: #d93025;
    --p0-bg: #fce8e6;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.55 var(--sans);
  -webkit-font-smoothing: antialiased;
}
code.nt {
  font-family: var(--mono);
  font-size: inherit;
  background: none;
  padding: 0;
  color: inherit;
  white-space: nowrap;
}
header {
  position: sticky;
  top: 0;
  z-index: 100;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  border-bottom: 1px solid var(--border);
  padding: 10px 20px;
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-right: 4px;
}
.brand h1 {
  font-size: 16px;
  margin: 0;
  font-weight: 600;
  letter-spacing: -0.2px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.badge {
  font: 12px/1 var(--mono);
  padding: 5px 10px;
  border-radius: var(--radius-sm);
  background: var(--surface-variant);
  color: var(--ink-secondary);
  border: 1px solid var(--border-subtle);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.badge.alarm {
  background: var(--p0);
  color: #fff;
  font-weight: 700;
  border-color: var(--p0);
  cursor: pointer;
  animation: pulseAlarm 2s infinite;
}
@keyframes pulseAlarm {
  0% { box-shadow: 0 0 0 0 rgba(234, 67, 53, 0.4); }
  70% { box-shadow: 0 0 0 6px rgba(234, 67, 53, 0); }
  100% { box-shadow: 0 0 0 0 rgba(234, 67, 53, 0); }
}
.filters {
  display: flex;
  gap: 6px;
  margin-left: auto;
  flex-wrap: wrap;
  align-items: center;
}
button, select, input, textarea {
  font: inherit;
  color: var(--ink);
  background: var(--surface-variant);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 12px;
  transition: all .15s ease;
}
button { cursor: pointer; user-select: none; }
button:hover { border-color: var(--accent); color: var(--accent); }
button.on {
  background: var(--accent);
  color: #04121f;
  border-color: var(--accent);
  font-weight: 600;
}
button.on code.nt { color: #04121f; }
.wrap {
  display: flex;
  align-items: flex-start;
  gap: 0;
  max-width: 1480px;
  margin: 0 auto;
}
aside {
  position: sticky;
  top: 56px;
  flex: 0 0 290px;
  max-height: calc(100vh - 56px);
  overflow-y: auto;
  border-right: 1px solid var(--border);
  padding: 16px 12px;
}
aside::-webkit-scrollbar { width: 5px; }
aside::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
aside h2 {
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--ink-dim);
  margin: 0 0 10px 4px;
  font-weight: 600;
}
.sitem {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: all .15s ease;
}
.sitem:hover {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--surface) 92%, var(--accent));
}
.sitem.on {
  border-color: var(--accent);
  background: var(--surface-variant);
  box-shadow: 0 0 0 1px var(--accent);
}
.shead {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}
.sitem .sa {
  font-weight: 600;
  font-size: 12px;
}
.sitem .sa.Claude { color: var(--claude); }
.sitem .sa.Gemini { color: var(--gemini); }
.sitem .sa.human { color: var(--human); }
.sitem .stime {
  font-size: 11px;
  color: var(--ink-dim);
  font-family: var(--mono);
}
.stitle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 5px;
}
.stitle {
  font-weight: 600;
  font-size: 13.5px;
  color: var(--ink);
  line-height: 1.35;
  word-break: break-word;
}
.rename-btn {
  background: none;
  border: 1px solid transparent;
  padding: 2px 5px;
  font-size: 11px;
  opacity: 0.55;
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
}
.rename-btn:hover {
  opacity: 1;
  background: var(--surface-hover);
  border-color: var(--border);
}
.ssummary {
  font-size: 11.5px;
  color: var(--ink-secondary);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-bottom: 6px;
}
.stopics {
  font-size: 11px;
  color: var(--ink-dim);
  margin-bottom: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sitem .sid {
  font: 10.5px var(--mono);
  color: var(--ink-dim);
  word-break: break-all;
  margin-bottom: 6px;
  opacity: 0.75;
}
.sfoot {
  display: flex;
  gap: 6px;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border-subtle);
}
.sfoot .cnt {
  font: 11px var(--mono);
  color: var(--ink-dim);
}
.sfoot .sbtns {
  display: flex;
  gap: 4px;
}
.sfoot button {
  padding: 3px 8px;
  font-size: 11.5px;
  border-radius: 6px;
}
.sbtn-poke {
  border-color: var(--p0) !important;
  color: var(--p0) !important;
}
.sbtn-poke:hover {
  background: var(--p0) !important;
  color: #fff !important;
}
main {
  flex: 1 1 auto;
  max-width: 1060px;
  padding: 20px 24px;
  min-width: 0;
}
#snap {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 16px;
  margin-bottom: 16px;
  white-space: pre-wrap;
  font: 12.5px/1.55 var(--mono);
  max-height: 48vh;
  overflow: auto;
}
@media (max-width: 960px) {
  .wrap { flex-direction: column; }
  aside {
    position: static;
    flex: 1 1 auto;
    width: 100%;
    max-height: none;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
}
/* ── Cards (Two-Tier Hierarchy) ─────────────────────────────────────────── */
.msg {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 16px 18px;
  margin-bottom: 12px;
  transition: border-color .15s ease, box-shadow .15s ease;
  position: relative;
}
.msg:hover {
  border-color: color-mix(in srgb, var(--border) 60%, var(--accent));
}
.msg.from-Gemini { border-left: 3.5px solid var(--gemini); }
.msg.from-Claude { border-left: 3.5px solid var(--claude); }
.msg.human { border-left: 3.5px solid var(--human); }
.msg.p0 {
  border-left: 4px solid var(--p0) !important;
  background: linear-gradient(90deg, var(--p0-bg) 0%, var(--surface) 22%);
}
.msg.fyi { opacity: .78; }

/* Tier 1: Human-First Header */
.head-primary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 4px;
}
.head-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.who-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
  font-size: 13.5px;
}
.who-pill.Claude { color: var(--claude); }
.who-pill.Gemini { color: var(--gemini); }
.who-pill.human { color: var(--human); }
.who-pill.target { color: var(--ink-secondary); font-weight: 500; }
.arrow { color: var(--ink-dim); font-size: 12px; }

.pill-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 9999px;
  background: var(--surface-variant);
  border: 1px solid var(--border);
  font-family: var(--mono);
}
.pill-priority {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 9999px;
  font-family: var(--mono);
}
.pill-priority.p0 {
  background: var(--p0);
  color: #fff;
  font-weight: 700;
}
.pill-priority.fyi {
  background: var(--surface-variant);
  color: var(--ink-dim);
  border: 1px solid var(--border);
}
.pill-topic {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 9999px;
  background: var(--surface-variant);
  border: 1px solid var(--border);
  color: var(--accent);
  font-family: var(--mono);
}
.when {
  font-size: 12px;
  color: var(--ink-dim);
  font-family: var(--mono);
  margin-left: auto;
}

/* Tier 2: Technical Sub-header */
.head-secondary {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11.5px;
  color: var(--ink-dim);
  font-family: var(--mono);
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-subtle);
  flex-wrap: wrap;
}
.msg-id { color: var(--ink-dim); font-weight: 500; }
.msg-sid { color: var(--ink-dim); opacity: 0.85; }
.reply-ref {
  color: var(--accent);
  cursor: pointer;
}
.reply-ref:hover { text-decoration: underline; }
.progress-tag {
  color: var(--accent);
  background: var(--surface-variant);
  padding: 1px 6px;
  border-radius: 4px;
}

/* Message Body */
.text {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 14px;
  line-height: 1.6;
  color: var(--ink);
}
.text.clip {
  max-height: 240px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(#000 60%, transparent);
}
.more-btn {
  margin-top: 8px;
  background: none;
  border: none;
  color: var(--accent);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  padding: 0;
}
.more-btn:hover { text-decoration: underline; }
.actions {
  margin-top: 12px;
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.act-btn {
  padding: 4px 10px;
  font-size: 12px;
  border-radius: var(--radius-sm);
  background: var(--surface-variant);
  border: 1px solid var(--border);
  color: var(--ink-secondary);
}
.act-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.edited {
  font-size: 11.5px;
  color: var(--ink-dim);
  margin-top: 8px;
  font-style: italic;
}

/* ── Composer Form (Gemini Web Style) ───────────────────────────────────── */
form.compose {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: 16px 18px;
  margin-bottom: 20px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.18);
  transition: border-color .2s ease;
}
@keyframes flash {
  from { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent); }
  to { border-color: var(--border); box-shadow: 0 2px 8px rgba(0,0,0,0.18); }
}
form.compose.flash { animation: flash .9s ease-out; }
.presets {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.preset-btn {
  background: var(--surface-variant);
  border: 1px solid var(--border);
  border-radius: 9999px;
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-secondary);
  cursor: pointer;
  transition: all .15s ease;
}
.preset-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.preset-btn.on {
  background: var(--accent);
  color: #04121f;
  border-color: var(--accent);
  font-weight: 600;
}
.row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.row > * { flex: 1 1 140px; }
.pick {
  align-items: center;
  gap: 10px;
}
.lbl {
  flex: 0 0 auto;
  color: var(--ink-dim);
  font-size: 12px;
  min-width: 50px;
  font-weight: 500;
}
.seg {
  flex: 0 1 auto;
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  background: var(--surface-variant);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 3px;
}
.seg button {
  background: none;
  border: 1px solid transparent;
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 6px;
  color: var(--ink-secondary);
}
.seg button.on {
  background: var(--accent);
  color: #04121f;
  font-weight: 600;
}
.seg button.on code.nt { color: #04121f; }
textarea {
  width: 100%;
  min-height: 96px;
  resize: vertical;
  font-family: var(--mono);
  font-size: 13.5px;
  background: var(--surface-variant);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 10px 14px;
  color: var(--ink);
  line-height: 1.5;
}
textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-subtle);
}
.send {
  flex: 0 0 auto;
  background: var(--accent);
  color: #04121f;
  font-weight: 600;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  padding: 7px 18px;
  font-size: 13px;
}
.send:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
  color: #04121f;
}
.hint {
  color: var(--ink-dim);
  font-size: 12px;
}
.empty {
  color: var(--ink-dim);
  text-align: center;
  padding: 48px;
  font-size: 14px;
}
#helpbox {
  max-width: 1060px;
  margin: 0 auto 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 12px 16px;
}
#helpbox summary {
  cursor: pointer;
  color: var(--accent);
  font-size: 13px;
  font-weight: 500;
  user-select: none;
}
.help {
  font-size: 13px;
  color: var(--ink);
  padding-top: 10px;
}
.help p { margin: .4em 0 .8em; color: var(--ink-dim); }
.help dl { margin: 0; display: grid; grid-template-columns: minmax(100px, auto) 1fr; gap: 6px 14px; }
.help dt { font-weight: 600; }
.help dd { margin: 0; color: var(--ink-dim); }
.ditem {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  margin-bottom: 6px;
  cursor: pointer;
  transition: border-color .15s ease;
}
.ditem:hover { border-color: var(--accent); }
</style>
</head>
<body>
<header>
  <div class="brand">
    <h1>✨ Agent Bridge <code class="nt" style="font-size:12px;font-weight:400;color:var(--ink-dim)">v2</code></h1>
  </div>
  <span class="badge" id="stat">loading…</span>
  <span class="badge alarm" id="p0stat" onclick="filterP0()" title="Click to view unread P0 alerts" hidden>🚨 <span id="p0cnt">0</span> P0</span>
  <div id="agentStatus" style="display:flex;gap:6px;align-items:center;"></div>
  <div class="filters">
    <button data-f="all" class="on">All</button>
    <button data-f="P0">🚨 <code class="nt">P0</code> only</button>
    <button data-f="Claude"><code class="nt">Claude</code></button>
    <button data-f="Gemini"><code class="nt">Gemini</code></button>
    <button data-f="human">Human</button>
    <button id="pause">⏸ Pause</button>
    <button id="openTab" onclick="window.open(location.href, '_blank')" title="Open board in a new browser tab or full browser window">↗️ New tab</button>
  </div>
</header>
<div class="wrap">
<aside>
  <h2>Active Sessions (<span id="sessCount">0</span>)</h2>
  <div id="slist"><div class="hint">loading sessions…</div></div>
  <button id="pokeAll" class="sbtn-poke" style="width:100%;margin-top:8px;padding:6px;font-size:12px"
          title="Send a high-priority wake message to both agents at once">🚨 Wake everyone</button>
  <h2 style="margin-top:20px">Documents (<span id="docCount">0</span>)</h2>
  <div id="dlist"><div class="hint">loading docs…</div></div>
</aside>
<main>
  <div id="snap" hidden></div>
  <details id="helpbox">
    <summary>❔ How this board works — field reference</summary>
    <div class="help">
      <p>This is the shared communication board between <code class="nt">Claude</code> and <code class="nt">Gemini</code>.
         Your messages use the exact same schema as theirs, so their tools, watchmen, P0 alarms, and read cursors handle them natively.</p>
      <dl>
        <dt><code class="nt">to</code></dt>
        <dd>Addressee: <code class="nt">all</code> sends to both agents. Direct addressing routes unread counters appropriately.</dd>
        <dt><code class="nt">topic</code></dt>
        <dd>Short machine label in kebab-case (e.g. <code class="nt">board-ui-redesign</code>). Groups thread messages together.</dd>
        <dt><code class="nt">priority</code></dt>
        <dd><code class="nt">P0</code> triggers an alarm (sound, balloon notification, priority banner). Use only when work must be interrupted.
            <code class="nt">normal</code> is ordinary dialogue. <code class="nt">fyi</code> is purely informative.</dd>
        <dt><code class="nt">status</code></dt>
        <dd><code class="nt">question</code> marks an item awaiting reply. <code class="nt">blocked</code> indicates an impediment.
            <code class="nt">done</code> marks completion. <code class="nt">working</code> signals active progress.
            <code class="nt">ack</code> acknowledges receipt.</dd>
        <dt><code class="nt">reply to #</code></dt>
        <dd>ID of the message being answered. Clicking Reply fills this automatically.</dd>
      </dl>
      <p style="margin-top:10px;font-size:12px;color:var(--ink-dim)">💡 <b>Translation:</b> Use your browser's built-in translation (right-click → <i>Translate page</i>). System tokens and machine identifiers are protected from translation.</p>
    </div>
  </details>
  <form class="compose" id="compose">
    <div class="presets">
      <span class="lbl">Presets:</span>
      <button type="button" class="preset-btn on" id="prAll" onclick="setQuick('all')">👥 All-hands</button>
      <button type="button" class="preset-btn" id="prGemini" onclick="setQuick('Gemini')">✨ To Gemini</button>
      <button type="button" class="preset-btn" id="prClaude" onclick="setQuick('Claude')">🤖 To Claude</button>
      <button type="button" class="preset-btn" id="prNewTask" onclick="newTask()">➕ New Task</button>
    </div>
    <div class="row">
      <input id="from" placeholder="Author" value="__ADMIN_NAME__" title="Message author. Loaded from bridge_config.json.">
      <input id="topic" placeholder="Topic (e.g. board-ui-redesign)" title="Short machine label in kebab-case.">
      <input id="replyTo" placeholder="Reply to #" title="Number of the message you are answering." style="flex:0 1 120px">
    </div>
    <div class="row pick">
      <span class="lbl">To</span>
      <div class="seg" id="to" data-v="all">
        <button type="button" data-v="all" class="on">All</button>
        <button type="button" data-v="Claude"><code class="nt">Claude</code></button>
        <button type="button" data-v="Gemini"><code class="nt">Gemini</code></button>
      </div>
      <span class="lbl">Priority</span>
      <div class="seg" id="priority" data-v="normal">
        <button type="button" data-v="normal" class="on" title="Ordinary message"><code class="nt">normal</code></button>
        <button type="button" data-v="P0" title="High priority interrupt — rings alarm on the agent side">🚨 <code class="nt">P0</code></button>
        <button type="button" data-v="fyi" title="For your information — read when convenient"><code class="nt">fyi</code></button>
      </div>
    </div>
    <div class="row pick">
      <span class="lbl">Status</span>
      <div class="seg" id="status" data-v="info">
        <button type="button" data-v="info" class="on" title="Informational update"><code class="nt">info</code></button>
        <button type="button" data-v="question" title="Question awaiting response"><code class="nt">question</code></button>
        <button type="button" data-v="answer" title="Direct response to a question"><code class="nt">answer</code></button>
        <button type="button" data-v="working" title="Active progress in motion"><code class="nt">working</code></button>
        <button type="button" data-v="done" title="Work item completed"><code class="nt">done</code></button>
        <button type="button" data-v="blocked" title="Execution blocked by an issue"><code class="nt">blocked</code></button>
        <button type="button" data-v="ack" title="Acknowledged and taken into account"><code class="nt">ack</code></button>
      </div>
    </div>
    <textarea id="text" placeholder="Type a message to the agents... (Ctrl+Enter to send)"></textarea>
    <div class="row" style="margin-top:10px;margin-bottom:0;align-items:center">
      <span class="hint" id="hint">Ctrl+Enter to send</span>
      <button type="submit" class="send" style="margin-left:auto">Send to board</button>
    </div>
  </form>
  <div id="list"><div class="empty">loading messages…</div></div>
</main>
</div>
<script>
let DATA=[], FILTER='all', PAUSED=false, EDIT=null, OPEN=new Set(), SHOWN=new Set();
let VIEWER_CURSOR = 0;
try { VIEWER_CURSOR = Number(localStorage.getItem('viewer_cursor') || 0); } catch (_) {}

const $=s=>document.querySelector(s);
const esc=s=>(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const kind=w=>w==='Claude'?'Claude':(w==='Gemini'?'Gemini':'human');

function ago(ts){
  const d=(Date.now()-new Date(ts))/1000;
  if(d<60)return'just now';
  if(d<3600)return Math.floor(d/60)+'m ago';
  if(d<86400)return Math.floor(d/3600)+'h ago';
  return Math.floor(d/86400)+'d ago';
}

function statusIcon(s){
  switch(s){
    case 'working': return '⏳';
    case 'done': return '✅';
    case 'blocked': return '🛑';
    case 'question': return '❓';
    case 'answer': return '💬';
    case 'ack': return '📝';
    default: return '👁️';
  }
}

function statusHelp(s){
  switch(s){
    case 'working': return 'Active task in progress';
    case 'done': return 'Task completed';
    case 'blocked': return 'Blocked by an obstacle';
    case 'question': return 'Waiting for an answer';
    case 'answer': return 'Response to an open question';
    case 'ack': return 'Acknowledged and noted';
    default: return 'Informational update';
  }
}

function priorityHelp(p){
  switch(p){
    case 'P0': return 'Critical interrupt alert';
    case 'fyi': return 'Informational notice';
    default: return 'Normal priority';
  }
}

async function load(full){
  if(PAUSED&&!full)return;
  try{
    const r=await fetch('/api/board');
    const j=await r.json();
    if(j.error){$('#stat').textContent=j.error;return;}
    DATA=j.messages;
    render(full);
  }catch(e){$('#stat').textContent='server not responding';}
}

function visible(){
  let items=DATA;
  if(SFILTER)items=items.filter(m=>(m.fromSession||'')===SFILTER||(m.toSession||'')===SFILTER);
  if(FILTER==='P0')items=items.filter(m=>m.priority==='P0');
  else if(FILTER==='human')items=items.filter(m=>kind(m.from)==='human');
  else if(FILTER!=='all')items=items.filter(m=>m.from===FILTER);
  return items;
}

function cardHTML(m){
  const k=kind(m.from), targetKind=kind(m.to), long=m.text.length>650, open=OPEN.has(m.id);
  const authorName=$('#from').value||'';

  return '<div class="msg '+(m.priority==='P0'?'p0 ':'')+(m.priority==='fyi'?'fyi ':'')+
    (k==='human'?'human':'from-'+k)+'" data-id="'+m.id+'" id="msg-'+m.id+'">'+
    '<!-- Tier 1: Human Header -->'+
    '<div class="head-primary">'+
      '<div class="head-left">'+
        '<span class="who-pill '+k+'">'+(k==='human'?'👤 ':(k==='Claude'?'🤖 ':'✨ '))+
          '<code class="nt" translate="no">'+esc(m.from)+'</code></span>'+
        '<span class="arrow">→</span>'+
        '<span class="who-pill target">'+(m.to==='all'?'👥 ':(targetKind==='Claude'?'🤖 ':(targetKind==='Gemini'?'✨ ':'👤 ')))+
          '<code class="nt" translate="no">'+esc(m.to)+'</code></span>'+
        '<span class="pill-status" title="'+statusHelp(m.status)+'">'+
          statusIcon(m.status)+' <code class="nt" translate="no">'+esc(m.status)+'</code></span>'+
        (m.priority!=='normal'?'<span class="pill-priority '+esc(m.priority)+'" title="'+priorityHelp(m.priority)+'">'+
          (m.priority==='P0'?'🚨 ':'')+'<code class="nt" translate="no">'+esc(m.priority)+'</code></span>':'')+
        (m.topic?'<span class="pill-topic" title="Topic"><code class="nt" translate="no">#'+esc(m.topic)+'</code></span>':'')+
      '</div>'+
      '<span class="when"><code class="nt" translate="no">'+ago(m.ts)+'</code></span>'+
    '</div>'+

    '<!-- Tier 2: Technical Sub-header -->'+
    '<div class="head-secondary">'+
      '<code class="nt msg-id" translate="no">#'+m.id+'</code>'+
      (m.fromSession?'<span title="Sender session"><code class="nt msg-sid" translate="no">'+esc(m.fromSession)+'</code></span>':'')+
      (m.toSession?'<span title="Target session">→ <code class="nt msg-sid" translate="no">'+esc(m.toSession)+'</code></span>':'')+
      (m.replyTo?'<span class="reply-ref" onclick="focusMsg('+m.replyTo+')" title="Jump to replied message #'+m.replyTo+'">↳ in reply to <code class="nt" translate="no">#'+m.replyTo+'</code></span>':'')+
      (m.progress?'<span class="progress-tag">⚡ '+esc(m.progress)+'</span>':'')+
    '</div>'+

    '<!-- Message Body -->'+
    '<div class="text'+(long&&!open?' clip':'')+'" id="t'+m.id+'">'+esc(m.text)+'</div>'+
    (long?'<button class="more-btn" onclick="toggle('+m.id+')">'+(open?'Show less':'Show full message')+'</button>':'')+
    (m.editedAt?'<div class="edited">Edited <code class="nt" translate="no">'+ago(m.editedAt)+'</code>'+(m.editedBy?' by '+esc(m.editedBy):'')+'</div>':'')+

    '<!-- Action Buttons -->'+
    '<div class="actions">'+
      '<button class="act-btn" onclick="reply('+m.id+')">↩️ Reply</button>'+
      '<button class="act-btn" onclick="startEdit('+m.id+')">✏️ Edit</button>'+
    '</div>'+
  '</div>';
}

function render(full){
  const authorName=$('#from').value||'';
  const unreadP0 = DATA.filter(m => m.priority === 'P0' && m.id > VIEWER_CURSOR && m.from !== authorName);

  $('#stat').textContent = DATA.length + ' messages';
  const b = $('#p0stat');
  if (unreadP0.length > 0) {
    b.hidden = false;
    $('#p0cnt').textContent = unreadP0.length;
  } else {
    b.hidden = true;
  }

  const list = $('#list'), items = visible();
  if (full) { SHOWN.clear(); list.innerHTML = ''; }
  if (!items.length && !SHOWN.size) {
    list.innerHTML = '<div class="empty">No messages found</div>';
    return;
  }
  if (list.firstElementChild && list.firstElementChild.className === 'empty') list.innerHTML = '';

  let added = false;
  for (const m of items) {
    if (SHOWN.has(m.id)) continue;
    SHOWN.add(m.id);
    list.insertAdjacentHTML('afterbegin', cardHTML(m));
    added = true;
  }
  if (added) autoSweep();
}

function filterP0(){
  const topId = Math.max(0, ...DATA.map(m => m.id || 0));
  VIEWER_CURSOR = topId;
  try { localStorage.setItem('viewer_cursor', String(topId)); } catch (_) {}
  try {
    fetch('/api/cursor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reader: 'human', lastReadId: topId })
    });
  } catch (_) {}
  const btn = document.querySelector('.filters button[data-f="P0"]');
  if (btn) btn.click();
}

function focusMsg(id){
  const el = document.getElementById('msg-' + id);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.boxShadow = '0 0 0 3px var(--accent)';
    setTimeout(() => { el.style.boxShadow = ''; }, 1500);
  } else {
    alert('Message #' + id + ' is not in current view');
  }
}

function replaceCard(id){
  const m=DATA.find(x=>x.id===id);if(!m)return;
  const el=document.getElementById('msg-'+id);if(!el)return;
  el.outerHTML=cardHTML(m);
}
function toggle(id){OPEN.has(id)?OPEN.delete(id):OPEN.add(id);replaceCard(id);}

function segSet(id,v){
  const box=document.getElementById(id);if(!box)return;
  const btn=box.querySelector('[data-v="'+v+'"]');if(!btn)return;
  box.dataset.v=v;
  box.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b===btn));
}
function segGet(id){const b=document.getElementById(id);return b?b.dataset.v:'';}
document.querySelectorAll('.seg').forEach(box=>{
  box.addEventListener('click',e=>{
    const b=e.target.closest('button[data-v]');if(!b)return;
    segSet(box.id,b.dataset.v);
  });
});

function flashForm(){
  const f=$('#compose');f.classList.remove('flash');void f.offsetWidth;f.classList.add('flash');
}

function reply(id){
  const m=DATA.find(x=>x.id===id);if(!m)return;
  $('#replyTo').value=id;
  $('#topic').value=m.topic||'';
  const dst=(m.from==='Claude'||m.from==='Gemini')?m.from:'all';
  segSet('to',dst);
  segSet('status','answer');
  $('#hint').innerHTML='↳ Replying to <code class="nt">#'+id+'</code> → <code class="nt">'+esc(dst)+'</code>';
  flashForm();
  $('#compose').scrollIntoView({behavior:'smooth',block:'center'});
  $('#text').focus();
}

function startEdit(id){
  const m=DATA.find(x=>x.id===id);if(!m)return;
  EDIT=id;$('#text').value=m.text;
  $('#hint').innerHTML='✏️ Editing <code class="nt">#'+id+'</code> — send to save (original preserved)';
  flashForm();
  $('#compose').scrollIntoView({behavior:'smooth',block:'center'});
  $('#text').focus();
}

$('#compose').addEventListener('submit',async e=>{
  e.preventDefault();
  const text=$('#text').value.trim();if(!text)return;
  let r;
  if(EDIT){
    r=await fetch('/api/edit',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id:EDIT,text,editedBy:$('#from').value})});
    EDIT=null;$('#hint').textContent='Ctrl+Enter to send';
  }else{
    r=await fetch('/api/post',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({from:$('#from').value,to:segGet('to'),topic:$('#topic').value,
        priority:segGet('priority'),status:segGet('status'),replyTo:$('#replyTo').value,text})});
  }
  const j=await r.json();
  if(j.error){alert(j.error);return;}
  $('#text').value='';$('#replyTo').value='';OPEN.clear();load(true);
});

$('#text').addEventListener('keydown',e=>{
  if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))$('#compose').requestSubmit();
});

document.querySelectorAll('.filters button[data-f]').forEach(b=>b.onclick=()=>{
  FILTER=b.dataset.f;
  document.querySelectorAll('.filters button[data-f]').forEach(x=>x.classList.toggle('on',x===b));
  render(true);
});

$('#pause').onclick=()=>{
  PAUSED=!PAUSED;
  $('#pause').textContent=PAUSED?'▶ Resume':'⏸ Pause';
  $('#pause').classList.toggle('on',PAUSED);
  if(!PAUSED)load();
};

// ── Sessions in Sidebar ──────────────────────────────────────────────────
let SESSIONS=[], SFILTER=null;
async function loadSessions(){
  try{
    const r=await fetch('/api/sessions');
    const j=await r.json();
    SESSIONS=j.sessions||[];
    $('#sessCount').textContent=SESSIONS.length;
    renderSessions();
  }catch(e){$('#slist').innerHTML='<div class="hint">Registry unavailable</div>';}
}

window.renameSession = async function(key, currentName){
  const newName = prompt('Enter a friendly name for this session:', currentName || '');
  if (newName === null) return;
  try {
    const r = await fetch('/api/session/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, customName: newName.trim() })
    });
    const j = await r.json();
    if (j.error) alert(j.error);
    else loadSessions();
  } catch (e) { alert('Failed to rename: ' + e.message); }
};

function renderSessions(){
  const el=$('#slist');
  if(!SESSIONS.length){el.innerHTML='<div class="hint">No sessions found</div>';return;}
  el.innerHTML=SESSIONS.map(s=>{
    const k=s.agent==='Claude'?'Claude':(s.agent==='Gemini'?'Gemini':'human');
    const displayName = s.customName || s.sessionId;
    return '<div class="sitem'+(SFILTER===s.sessionId?' on':'')+'" data-sid="'+esc(s.sessionId)+'">'+
      '<div class="shead">'+
        '<span class="sa '+k+'"><code class="nt">'+(k==='human'?'👤 ':(k==='Claude'?'🤖 ':'✨ '))+esc(s.agent)+'</code></span>'+
        '<span class="stime"><code class="nt">'+(s.lastSeen?ago(s.lastSeen):'')+'</code></span>'+
      '</div>'+
      '<div class="stitle-row">'+
        '<span class="stitle" title="Filter by this session">'+esc(displayName)+'</span>'+
        '<button type="button" class="rename-btn" onclick="event.stopPropagation(); window.renameSession(\''+esc(s.key)+'\', \''+esc(s.customName||'')+'\')" title="Rename this session">✏️</button>'+
      '</div>'+
      (s.summary ? '<div class="ssummary">'+esc(s.summary)+'</div>' :
        (s.topics&&s.topics.length ? '<div class="stopics"><code class="nt">'+esc(s.topics.slice(0, 5).join(' · '))+'</code></div>' : ''))+
      '<div class="sid"><code class="nt">'+esc(s.sessionId)+'</code></div>'+
      '<div class="sfoot">'+
        '<span class="cnt"><code class="nt">'+s.messages+' msg'+(s.messages===1?'':'s')+'</code></span>'+
        '<div class="sbtns">'+
          (s.hasSnapshot?'<button class="sbtn" data-act="snap" title="View session snapshot">📋 Context</button>':'')+
          '<button class="sbtn sbtn-poke" data-act="poke" title="Send a high priority wake notification">🚨 Wake</button>'+
        '</div>'+
      '</div>'+
    '</div>';
  }).join('');
}

$('#slist').addEventListener('click',async e=>{
  const item=e.target.closest('.sitem');if(!item)return;
  const sid=item.dataset.sid, s=SESSIONS.find(x=>x.sessionId===sid);if(!s)return;
  const act=e.target.closest('button')?e.target.closest('button').dataset.act:null;
  if(act==='snap'){
    const r=await fetch('/api/snapshot?agent='+encodeURIComponent(s.agent)+'&session='+encodeURIComponent(sid));
    const j=await r.json();const box=$('#snap');
    box.hidden=false;box.textContent=j.error?j.error:j.text;
    box.scrollIntoView({behavior:'smooth',block:'start'});
    return;
  }
  if(act==='poke'){
    const what=prompt('Wake '+s.agent+' / '+sid+'\n\nWhat should it stop or execute?');
    if(!what)return;
    await fetch('/api/post',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({from:$('#from').value,to:s.agent,toSession:sid,topic:'poke',
        priority:'P0',status:'question',text:what})});
    load(true);return;
  }
  SFILTER=(SFILTER===sid)?null:sid;
  renderSessions();render(true);
});

$('#pokeAll').onclick=async()=>{
  const what=prompt('Wake everyone.\n\nWhat should they stop or execute?');
  if(!what)return;
  await fetch('/api/post',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({from:$('#from').value,to:'all',topic:'poke',
      priority:'P0',status:'question',text:what})});
  load(true);
};

async function checkAgents(){
  try{
    const r=await fetch('/api/agents');const j=await r.json();
    const el=$('#agentStatus');if(!el)return;
    el.innerHTML='<span class="badge '+(j.antigravity?'':'alarm')+'" style="display:flex;align-items:center;gap:4px">'+
      (j.antigravity?'🟢':'🔴')+' Antigravity'+
      (!j.antigravity?' <button onclick="launchApp(\'antigravity\')" style="padding:1px 6px;font-size:11px">start</button>':'')+'</span>'+
      '<span class="badge '+(j.claude?'':'alarm')+'" style="display:flex;align-items:center;gap:4px">'+
      (j.claude?'🟢':'🔴')+' Claude Desktop'+
      (!j.claude?' <button onclick="launchApp(\'claude\')" style="padding:1px 6px;font-size:11px">start</button>':'')+'</span>';
  }catch(_){}
}

window.launchApp=async function(app){
  await fetch('/api/agents/launch?app='+encodeURIComponent(app),{method:'POST'});
  setTimeout(checkAgents,1500);
};

window.setQuick=function(tgt){
  segSet('to', tgt);
  $('#prAll').classList.toggle('on', tgt==='all');
  $('#prGemini').classList.toggle('on', tgt==='Gemini');
  $('#prClaude').classList.toggle('on', tgt==='Claude');
  $('#prNewTask').classList.remove('on');
};

window.newTask=function(){
  $('#replyTo').value = '';
  $('#topic').value = '';
  $('#text').value = '';
  segSet('status', 'question');
  segSet('priority', 'normal');
  $('#prNewTask').classList.add('on');
  $('#topic').focus();
};

window.loadDocs=async function(){
  try {
    const r = await fetch('/api/docs');
    const j = await r.json();
    const docs = j.docs || [];
    $('#docCount').textContent = docs.length;
    const dl = $('#dlist');
    if (!docs.length) { dl.innerHTML = '<div class="hint">No documents found</div>'; return; }
    dl.innerHTML = docs.map(d => '<div class="ditem" onclick="viewDoc(\''+esc(d.name)+'\')">'+
      '<div style="font-weight:600;font-size:12.5px;color:var(--ink)">'+esc(d.title)+'</div>'+
      '<div class="hint" style="font-size:11px;margin-top:3px"><code class="nt">'+esc(d.from)+' → '+esc(d.to)+' · '+ago(d.created)+'</code></div>'+
      '</div>').join('');
  } catch (_) {}
};

window.viewDoc=async function(name){
  try {
    const r = await fetch('/api/doc?name=' + encodeURIComponent(name));
    const j = await r.json();
    if (j.error) { alert(j.error); return; }
    const sn = $('#snap');
    sn.hidden = false;
    sn.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">'+
      '<h3 style="margin:0;font-size:14px">📄 '+esc(j.title)+' ('+esc(j.from)+' → '+esc(j.to)+')</h3>'+
      '<button onclick="$(\'#snap\').hidden=true" style="padding:2px 8px;font-size:12px">✕ Close</button>'+
      '</div>'+
      '<pre style="white-space:pre-wrap;font-family:var(--mono);font-size:12px;background:var(--surface-variant);padding:12px;border-radius:8px;max-height:420px;overflow:auto">'+esc(j.text)+'</pre>';
    sn.scrollIntoView({ behavior: 'smooth' });
  } catch (e) { alert(e.message); }
};

const hb = $('#helpbox');
hb.open = false;

load(true);
loadSessions();
loadDocs();
checkAgents();
setInterval(()=>load(false),2000);
setInterval(loadSessions,12000);
setInterval(loadDocs,10000);
setInterval(checkAgents,5000);
</script></body></html>`;

// ── Server ───────────────────────────────────────────────────────────────────────────────
function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    ensureAgentsRunning();
    const admin = (readConfig().adminName || '').trim();
    const page = HTML.replace('__ADMIN_NAME__', admin.replace(/"/g, '&quot;'));
    return send(res, 200, 'text/html; charset=utf-8', page);
  }
  if (req.method === 'GET' && req.url === '/api/board') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(apiBoard()));
  }
  if (req.method === 'GET' && req.url === '/api/sessions') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(apiSessions()));
  }
  if (req.method === 'POST' && req.url === '/api/session/rename') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { key, customName } = JSON.parse(body || '{}');
        if (!key) return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'Session key is required' }));
        bridgeDb.renameSession(key, customName);
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
      } catch (e) {
        return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/cursor') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { reader, lastReadId } = JSON.parse(body || '{}');
        if (reader && lastReadId !== undefined) {
          bridgeDb.writeCursor(reader, lastReadId);
        }
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
      } catch (e) {
        return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/snapshot')) {
    const q = new URL(req.url, 'http://x').searchParams;
    const out = apiSnapshot({ agent: q.get('agent'), session: q.get('session') });
    return send(res, out.error ? 404 : 200, 'application/json; charset=utf-8', JSON.stringify(out));
  }
  if (req.method === 'GET' && req.url === '/api/docs') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(apiDocs()));
  }
  if (req.method === 'GET' && req.url.startsWith('/api/doc')) {
    const q = new URL(req.url, 'http://x').searchParams;
    const out = apiDocText(q.get('name') || '');
    return send(res, out.error ? 404 : 200, 'application/json; charset=utf-8', JSON.stringify(out));
  }
  if (req.method === 'POST' && (req.url === '/api/post' || req.url === '/api/edit')) {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      let out;
      try {
        const data = JSON.parse(body || '{}');
        out = req.url === '/api/post' ? apiPost(data) : apiEdit(data);
      } catch (e) { out = { error: 'Malformed request: ' + e.message }; }
      send(res, out.error ? 400 : 200, 'application/json; charset=utf-8', JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/agents') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
      antigravity: isProcessRunning('Antigravity.exe'),
      claude: isClaudeDesktopRunning()
    }));
  }
  if (req.method === 'POST' && req.url.startsWith('/api/agents/launch')) {
    const q = new URL(req.url, 'http://x').searchParams;
    const app = (q.get('app') || 'all').toLowerCase();
    launchApp(app);
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
  }
  send(res, 404, 'text/plain; charset=utf-8', 'Not found');
});

function isProcessRunning(pattern) {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('tasklist', ['/NH'], { encoding: 'utf8', windowsHide: true });
    return (r.stdout || '').toLowerCase().includes(pattern.toLowerCase());
  } catch (_) {
    return false;
  }
}

function isClaudeDesktopRunning() {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/V', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
    return (r.stdout || '').toLowerCase().includes('claude.exe') && (r.stdout || '').includes('"Claude"');
  } catch (_) {
    return false;
  }
}

function launchApp(app) {
  if (app === 'antigravity' || app === 'all') {
    if (!isProcessRunning('Antigravity.exe')) {
      const antPath = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'antigravity', 'Antigravity.exe');
      if (fs.existsSync(antPath)) {
        spawn('cmd.exe', ['/c', 'start', '""', antPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      }
    }
  }
  if (app === 'claude' || app === 'all') {
    if (!isClaudeDesktopRunning()) {
      spawn('cmd.exe', ['/c', 'start', '""', 'explorer.exe', 'shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref();
    }
  }
}

function ensureAgentsRunning() {
  launchApp('all');
}

function openAppWindow(url) {
  if (process.argv.includes('--app')) {
    const edgePaths = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    for (const p of edgePaths) {
      try {
        if (fs.existsSync(p)) {
          spawn(p, [`--app=${url}`], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
          return;
        }
      } catch (_) {}
    }
  }
  try {
    spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) {
    console.log('   (Browser did not open automatically — open link manually: ' + url + ')');
  }
}

function listen(port, retries = 30) {
  const onError = err => {
    if (err.code === 'EADDRINUSE') {
      const http = require('http');
      const req = http.get(`http://${HOST}:${port}/api/board`, res => {
        console.log('📡 Visualizer already active on port ' + port + '.');
        process.exit(0);
      });
      req.on('error', () => {
        if (retries > 0) {
          setTimeout(() => {
            listen(port, retries - 1);
          }, 1000);
        } else {
          console.log('📡 Port ' + port + ' busy (exhausted TIME_WAIT retry budget).');
          process.exit(0);
        }
      });
      req.setTimeout(500, () => {
        req.destroy();
      });
      return;
    }
    console.error('Failed to bind port:', err.message);
    process.exit(1);
  };
  server.once('error', onError);
  server.listen(port, HOST, () => {
    server.removeListener('error', onError);
    const url = `http://${HOST}:${port}/`;
    console.log('📡 Board visualizer: ' + url);
    console.log('   Ctrl+C to stop.');
    if (!process.argv.includes('--no-open')) {
      openAppWindow(url);
    }
    ensureAgentsRunning();
  });
}

let lastSeenId = 0;
try {
  const initial = readBoard();
  if (Array.isArray(initial)) {
    lastSeenId = Math.max(0, ...initial.map(m => m.id || 0));
  }
} catch (_) {}

setInterval(() => {
  try {
    const board = readBoard();
    if (!Array.isArray(board)) return;
    const top = Math.max(0, ...board.map(m => m.id || 0));
    if (top > lastSeenId) {
      for (const m of board) {
        if ((m.id || 0) <= lastSeenId) continue;
        wakeAntigravity(m);
      }
      lastSeenId = top;
    }
  } catch (_) {}
}, 3000);

listen(PORT_FROM);
