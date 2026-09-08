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
const ATTACHMENTS_DIR = path.join(SCRIPTS_DIR, 'docs', 'attachments');
// Image types the board accepts and serves. Anything else is stored under a
// .png name and served as an opaque download, so nothing uploaded here can be
// executed by the browser in the board's own origin.
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};
const P0_FLAG_FILE = path.join(SCRIPTS_DIR, 'P0_PENDING.txt');
const HOST = '127.0.0.1';
const PORT_FROM = 8787;
const INLINE_LIMIT = 4000;

const PRIORITIES = ['P0', 'normal', 'fyi'];
const STATUSES = ['info', 'question', 'answer', 'working', 'done', 'blocked', 'ack'];

// ── Board (SQLite via bridge-db) ────────────────────────────────────────────────────────
function readBoard(options = {}) {
  try {
    return bridgeDb.readAllMessages(options);
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

function isImageExt(file) {
  if (!file) return false;
  return /\.(png|jpe?g|webp|gif|svg)$/i.test(file);
}

function bodyOf(m) {
  if (m.file && !isImageExt(m.file) && fs.existsSync(m.file)) {
    try { return fs.readFileSync(m.file, 'utf8'); } catch (_) {}
  }
  return m.message || '';
}

// ── API ──────────────────────────────────────────────────────────────────────────────────
function apiBoard(options = {}) {
  const board = readBoard(options);
  if (board === null) return { error: 'Failed to read board' };
  let cursors = {};
  try { cursors = bridgeDb.readCursors(); } catch (_) {}
  return {
    cursors,
    messages: board.map(m => ({
      id: m.id, ts: m.ts, from: m.from, fromSession: m.fromSession || '',
      to: m.to || 'all', toSession: m.toSession || '', replyTo: m.replyTo || null,
      topic: m.topic || '', priority: m.priority || 'normal', status: m.status || 'info',
      progress: m.progress || '', text: bodyOf(m),
      file: m.file ? path.basename(m.file) : null,
      hasFile: !!m.file,
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
      if (!toSession && to === parent.from) toSession = parent.fromSession || '';
      if (!topic && parent.topic) topic = parent.topic;
    }
  }
  if (!to) to = 'all';

  // If toSession belongs to a different agent, clear it to prevent cross-agent routing defects
  if (to && to !== 'all' && toSession) {
    try {
      const sRow = bridgeDb.getDb().prepare('SELECT agent FROM sessions WHERE session_id = ?').get(toSession);
      if (sRow && sRow.agent && sRow.agent.toLowerCase() !== to.toLowerCase()) {
        toSession = '';
      }
    } catch (_) {}
  }

  const attachedFile = (data.file && typeof data.file === 'string') ? data.file.trim() : null;

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
    file: attachedFile,
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

  if (!rec.file && text.length > INLINE_LIMIT) {
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
      canonicalId: s.canonicalId || '',
      client: s.client || '',
      cwd: s.cwd || '',
      title: s.title || '',
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

html, body {
  height: 100%;
  margin: 0;
  overflow: hidden;
}
.app-wrap {
  display: flex;
  height: calc(100vh - 49px);
  overflow: hidden;
}
aside {
  flex: 0 0 280px;
  max-width: 280px;
  background: var(--surface);
  border-right: 1px solid var(--border);
  padding: 14px 12px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  box-sizing: border-box;
}
aside::-webkit-scrollbar { width: 5px; }
aside::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
.btn-new-task {
  width: 100%;
  background: var(--surface-variant);
  border: 1px solid var(--border);
  border-radius: 9999px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  margin-bottom: 14px;
  transition: all .15s ease;
  box-sizing: border-box;
}
.btn-new-task:hover {
  background: var(--surface-hover);
  border-color: var(--accent);
  color: var(--accent);
}
aside h2 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--ink-dim);
  margin: 0 0 8px 4px;
  font-weight: 600;
}
#slist {
  flex: 1 1 auto;
  overflow-y: auto;
  margin-bottom: 8px;
}
.sitem {
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  padding: 8px 10px;
  margin-bottom: 4px;
  cursor: pointer;
  transition: all .15s ease;
}
.sitem:hover {
  background: var(--surface-variant);
}
.sitem.on {
  background: var(--surface-variant);
  border-color: var(--accent);
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
  margin-bottom: 4px;
}
.stitle {
  font-weight: 500;
  font-size: 13px;
  color: var(--ink);
  line-height: 1.35;
  word-break: break-word;
}
.rename-btn {
  background: none;
  border: 1px solid transparent;
  padding: 2px 5px;
  font-size: 11px;
  opacity: 0.5;
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
  font-size: 11px;
  color: var(--ink-secondary);
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-bottom: 4px;
}
.stopics {
  font-size: 10.5px;
  color: var(--ink-dim);
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sitem .sid {
  font: 10px var(--mono);
  color: var(--ink-dim);
  word-break: break-all;
  opacity: 0.7;
  cursor: copy;
  display: flex;
  gap: 4px;
  align-items: baseline;
}
.sitem .sid:hover { opacity: 1; }
.sitem .sid .cpy { flex: none; opacity: 0.55; }
.sitem .sid:hover .cpy { opacity: 1; }
/* The id the client issued, as opposed to the label the agent chose. Marked so
   the two are never confused at a glance: one can be invented, one cannot. */
.sitem .scanon { opacity: 0.95; }
.sitem .scanon code { color: var(--accent, inherit); }
.sitem .scwd {
  font: 10px var(--mono);
  color: var(--ink-dim);
  opacity: 0.55;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sfoot {
  display: flex;
  gap: 6px;
  align-items: center;
  justify-content: space-between;
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--border-subtle);
}
.sfoot .cnt {
  font: 10.5px var(--mono);
  color: var(--ink-dim);
}
.sfoot .sbtns {
  display: flex;
  gap: 4px;
}
.sfoot button {
  padding: 2px 6px;
  font-size: 11px;
  border-radius: 4px;
}
.sbtn-poke {
  border-color: var(--p0) !important;
  color: var(--p0) !important;
}
.sbtn-poke:hover {
  background: var(--p0) !important;
  color: #fff !important;
}

/* ── Chat Feed Layout ── */
.main-chat {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  position: relative;
  background: var(--bg);
}
#snap {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 14px;
  margin: 10px 20px 0;
  white-space: pre-wrap;
  font: 12px/1.55 var(--mono);
  max-height: 35vh;
  overflow: auto;
}
#list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 20px 24px 10px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  scroll-behavior: smooth;
  box-sizing: border-box;
}
#list::-webkit-scrollbar { width: 6px; }
#list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

.chat-row {
  width: 100%;
  max-width: 860px;
  margin: 0 auto;
  box-sizing: border-box;
}

/* Human message (User bubble right-aligned) */
.row-human {
  display: flex;
  justify-content: flex-end;
}
.bubble-human {
  max-width: 78%;
  background: var(--surface-variant);
  border: 1px solid var(--border);
  border-radius: 20px 20px 4px 20px;
  padding: 12px 18px;
  color: var(--ink);
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
  position: relative;
}
.row-human.p0 .bubble-human {
  border-color: var(--p0);
  box-shadow: 0 0 0 1px var(--p0), 0 2px 8px rgba(234,67,53,0.3);
}
.bubble-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--ink-dim);
  margin-bottom: 5px;
  font-family: var(--mono);
  flex-wrap: wrap;
}
.bubble-author {
  color: var(--human);
  font-weight: 600;
}
.bubble-target {
  color: var(--ink-secondary);
}
.bubble-time {
  margin-left: auto;
  font-size: 11px;
}
.bubble-text {
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.bubble-actions {
  display: flex;
  gap: 4px;
  margin-top: 8px;
  justify-content: flex-end;
  opacity: 0.35;
  transition: opacity .15s;
}
.bubble-human:hover .bubble-actions {
  opacity: 1;
}

/* Agent message (AI response left-aligned) */
.row-agent {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.row-agent.p0 {
  background: rgba(234, 67, 53, 0.08);
  border: 1px solid var(--p0);
  border-radius: var(--radius-md);
  padding: 12px;
}
.agent-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--surface);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  flex-shrink: 0;
  margin-top: 2px;
}
.agent-content {
  flex: 1 1 auto;
  min-width: 0;
}
.agent-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--ink-dim);
  margin-bottom: 5px;
  flex-wrap: wrap;
}
.agent-name {
  font-weight: 600;
}
.agent-name.Claude { color: var(--claude); }
.agent-name.Gemini { color: var(--gemini); }
.agent-target { color: var(--ink-secondary); }
.agent-text {
  font-size: 14px;
  line-height: 1.65;
  color: var(--ink);
  white-space: pre-wrap;
  word-break: break-word;
}
.agent-text.clip {
  max-height: 220px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(#000 60%, transparent);
}
.more-btn {
  margin-top: 6px;
  background: none;
  border: none;
  color: var(--accent);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  padding: 0;
}
.more-btn:hover { text-decoration: underline; }
.agent-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  opacity: 0.35;
  transition: opacity .15s;
}
.row-agent:hover .agent-actions {
  opacity: 1;
}
.act-btn {
  padding: 3px 8px;
  font-size: 11.5px;
  border-radius: var(--radius-sm);
  background: var(--surface-variant);
  border: 1px solid var(--border);
  color: var(--ink-secondary);
}
.act-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.icon-btn {
  background: none;
  border: none;
  font-size: 11.5px;
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--ink-dim);
  cursor: pointer;
}
.icon-btn:hover {
  background: var(--surface-hover);
  color: var(--accent);
}

.pill-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 7px;
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
  padding: 2px 7px;
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
  padding: 2px 7px;
  border-radius: 9999px;
  background: var(--surface-variant);
  border: 1px solid var(--border);
  color: var(--accent);
  font-family: var(--mono);
}
.msg-id { color: var(--ink-dim); font-size: 11px; font-weight: 500; }
.reply-ref {
  color: var(--accent);
  cursor: pointer;
  font-size: 11.5px;
  margin-bottom: 4px;
  display: inline-block;
}
.reply-ref:hover { text-decoration: underline; }
.progress-tag {
  color: var(--accent);
  background: var(--surface-variant);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  display: inline-block;
  margin-bottom: 4px;
}
.edited, .bubble-edited, .agent-edited {
  font-size: 11px;
  color: var(--ink-dim);
  margin-top: 6px;
  font-style: italic;
}

/* Image Attachment in Chat */
.chat-img-wrap {
  margin-top: 8px;
  max-width: 440px;
}
.chat-img {
  max-width: 100%;
  max-height: 320px;
  border-radius: 12px;
  border: 1px solid var(--border);
  cursor: pointer;
  display: block;
  transition: transform .15s, box-shadow .15s;
}
.chat-img:hover {
  transform: scale(1.015);
  box-shadow: 0 4px 16px rgba(0,0,0,0.35);
}

/* ── Floating Compose Capsule (Gemini Style) ── */
.compose-capsule {
  flex: 0 0 auto;
  max-width: 880px;
  width: 100%;
  margin: 0 auto;
  padding: 0 20px 12px;
  box-sizing: border-box;
}
.capsule-box {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 24px;
  padding: 12px 16px 10px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.3);
  transition: border-color .15s, box-shadow .15s;
}
.capsule-box:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent), 0 4px 20px rgba(0,0,0,0.35);
}
.capsule-box.flash { animation: flash .8s ease-out; }
@keyframes flash {
  from { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent); }
  to { border-color: var(--border); box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
}
.capsule-box.drag-over {
  border-color: var(--accent);
  background: var(--surface-hover);
}
.capsule-box textarea {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--ink);
  font: 14px/1.55 var(--sans);
  resize: none;
  min-height: 24px;
  max-height: 180px;
  padding: 0;
  margin: 0 0 8px 0;
  outline: none;
  display: block;
  box-sizing: border-box;
}
.capsule-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: nowrap;
}
.capsule-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
  min-width: 0;
  overflow: hidden;
}
.capsule-right {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex-shrink: 0;
}
.sem-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--surface-variant);
  border: 1px solid var(--border);
  border-radius: 9999px;
  padding: 3px 8px;
  font-size: 11px;
  color: var(--ink-secondary);
  user-select: none;
  flex-shrink: 0;
  white-space: nowrap;
}
.sem-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}
.sem-dot.green { background: #22c55e; box-shadow: 0 0 6px rgba(34,197,94,0.7); }
.sem-dot.yellow { background: #eab308; box-shadow: 0 0 6px rgba(234,179,8,0.7); }
.sem-dot.red { background: #ef4444; box-shadow: 0 0 6px rgba(239,68,68,0.7); }
.sem-dot.blue { background: #3b82f6; box-shadow: 0 0 6px rgba(59,130,246,0.7); }
@keyframes sem-pulse {
  0% { transform: scale(0.9); opacity: 0.7; }
  50% { transform: scale(1.2); opacity: 1; }
  100% { transform: scale(0.9); opacity: 0.7; }
}
.sem-dot.pulse { animation: sem-pulse 1.8s infinite ease-in-out; }
.target-select-wrap select {
  background: var(--surface-variant);
  border: 1px solid var(--border);
  border-radius: 9999px;
  padding: 3px 8px;
  font-size: 11px;
  color: var(--ink-secondary);
  cursor: pointer;
  outline: none;
  max-width: 140px;
}
.topic-pill-input {
  background: var(--surface-variant);
  border: 1px solid var(--border);
  border-radius: 9999px;
  padding: 3px 8px;
  font-size: 11px;
  color: var(--accent);
  width: 70px;
  font-family: var(--mono);
  outline: none;
  flex-shrink: 0;
}
.topic-pill-input:focus { border-color: var(--accent); }
.seg-compact {
  border-radius: 9999px;
  padding: 2px;
  background: var(--surface-variant);
  border: 1px solid var(--border);
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.seg-compact button {
  background: none;
  border: 1px solid transparent;
  padding: 2px 8px;
  font-size: 11px;
  border-radius: 9999px;
  color: var(--ink-secondary);
}
.seg-compact button.on {
  background: var(--accent);
  color: #04121f;
  font-weight: 600;
}
.btn-attach {
  background: none;
  border: 1px solid transparent;
  border-radius: 50%;
  width: 28px;
  height: 28px;
  font-size: 14px;
  cursor: pointer;
  color: var(--ink-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: all .15s;
}
.btn-attach:hover {
  background: var(--surface-variant);
  color: var(--accent);
  border-color: var(--border);
}
.p0-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--ink-dim);
  cursor: pointer;
  user-select: none;
}
.send-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--accent);
  color: #04121f;
  border: none;
  font-size: 16px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background .15s, transform .1s;
  padding: 0;
}
.send-btn:hover {
  background: var(--accent-hover);
  transform: scale(1.06);
}
.reply-badge, .attach-badge, .target-capsule-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: rgba(99,102,241,0.12);
  border: 1px solid rgba(99,102,241,0.35);
  border-radius: var(--radius-sm);
  padding: 5px 10px;
  font-size: 11.5px;
  margin-bottom: 6px;
  color: var(--ink);
}
.attach-badge {
  background: rgba(52,168,83,0.12);
  border-color: rgba(52,168,83,0.35);
}
.badge-cancel {
  background: none;
  border: none;
  color: var(--ink-dim);
  cursor: pointer;
  font-size: 12px;
  padding: 0 4px;
}
.badge-cancel:hover { color: var(--ink); }
.capsule-footnote {
  text-align: center;
  font-size: 11px;
  color: var(--ink-dim);
  margin-top: 5px;
}
.empty {
  color: var(--ink-dim);
  text-align: center;
  padding: 48px;
  font-size: 14px;
}
.ditem {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  margin-bottom: 4px;
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
<div class="app-wrap">
<aside>
  <button type="button" class="btn-new-task" onclick="newTask()" title="Start a fresh task or message">
    ➕ New Task
  </button>
  <h2>Recent Sessions (<span id="sessCount">0</span>)</h2>
  <div id="slist"><div class="hint">loading sessions…</div></div>
  <button id="pokeAll" class="sbtn-poke" style="width:100%;margin-top:auto;padding:6px;font-size:12px"
          title="Send a high-priority wake message to both agents at once">🚨 Wake everyone</button>
  <details id="docDetails" style="margin-top:12px;font-size:12px">
    <summary style="cursor:pointer;color:var(--ink-dim);font-weight:600;user-select:none">Documents (<span id="docCount">0</span>)</summary>
    <div id="dlist" style="margin-top:8px"><div class="hint">loading docs…</div></div>
  </details>
</aside>
<main class="main-chat">
  <div id="snap" hidden></div>
  <div id="list" class="chat-feed"><div class="empty">loading messages…</div></div>
  <form class="compose-capsule" id="compose">
    <div id="replyBadge" class="reply-badge" style="display:none">
      <span id="replyBadgeText">↳ Replying to #...</span>
      <button type="button" class="badge-cancel" onclick="cancelReply()" title="Cancel reply">✕</button>
    </div>
    <div id="attachBadge" class="attach-badge" style="display:none">
      <span id="attachBadgeText">🖼️ Attached: image.png</span>
      <button type="button" class="badge-cancel" onclick="cancelAttach()" title="Remove attachment">✕</button>
    </div>
    <div id="targetBanner" class="target-capsule-banner" style="display:none">
      <span id="targetBannerText"></span>
      <button type="button" class="badge-cancel" onclick="clearTargetSession()" title="Reset to all">✕ Reset</button>
    </div>
    <div class="capsule-box">
      <textarea id="text" placeholder="Message agents... (Enter to send, Ctrl+Enter for newline, paste/drop image)" rows="1"></textarea>
      <div class="capsule-toolbar">
        <div class="capsule-left">
          <input type="file" id="fileInput" accept="image/*" style="display:none" onchange="if(this.files[0])uploadFile(this.files[0])">
          <button type="button" class="btn-attach" onclick="$('#fileInput').click()" title="Attach image (or Ctrl+V / drag-and-drop)">📎</button>
          <div id="activitySemaphore" class="sem-pill" title="Live status of conversation and agents">
            <span class="sem-dot green"></span> <b id="semTitle">All Ready</b>
          </div>
          <div class="target-select-wrap" title="Target specific session">
            <select id="toSession" class="target-select">
              <option value="">📢 All / Broadcast</option>
            </select>
          </div>
          <div class="seg seg-compact" id="to" data-v="all">
            <button type="button" data-v="all" class="on" title="All agents">All</button>
            <button type="button" data-v="Claude" title="Claude only"><code class="nt">Claude</code></button>
            <button type="button" data-v="Gemini" title="Gemini only"><code class="nt">Gemini</code></button>
          </div>
          <input id="topic" placeholder="#topic" class="topic-pill-input" title="Topic label (kebab-case)">
        </div>
        <div class="capsule-right">
          <label class="p0-toggle" title="Emergency wake-up alarm — wakes all sessions immediately">
            <input type="checkbox" id="p0Check"> 🚨 P0
          </label>
          <button type="submit" class="send-btn" title="Send message (Enter)">↑</button>
        </div>
      </div>
    </div>
    <input id="from" type="hidden" value="__ADMIN_NAME__">
    <input id="replyTo" type="hidden" value="">
  </form>
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
    const topId = (!full && DATA.length > 0) ? (DATA[DATA.length - 1].id || 0) : 0;
    const url = topId > 0 ? ('/api/board?since=' + topId) : '/api/board';
    const r = await fetch(url);
    const j = await r.json();
    if(j.error){$('#stat').textContent=j.error;return;}
    if(topId > 0){
      const incoming = j.messages || [];
      if(incoming.length > 0){
        for(const m of incoming){
          const idx = DATA.findIndex(x => x.id === m.id);
          if(idx >= 0) DATA[idx] = m;
          else DATA.push(m);
        }
        render(false);
        updateSemaphore();
      }
    }else{
      DATA = j.messages || [];
      render(full);
      updateSemaphore();
    }
  }catch(e){$('#stat').textContent='server not responding';}
}

function updateSemaphore(){
  const sem=$('#activitySemaphore');if(!sem)return;
  const dot=sem.querySelector('.sem-dot');
  const title=$('#semTitle');
  if(!dot||!title)return;

  const slice = DATA.slice(-80);
  const replied = new Set();
  for(let i = 0; i < slice.length; i++){
    if(slice[i].replyTo) replied.add(slice[i].replyTo);
  }

  // 1. Check for active blocked messages
  for(let i = slice.length - 1; i >= 0; i--){
    const m = slice[i];
    if(m.status === 'blocked' && !replied.has(m.id)){
      let resolved = false;
      if(m.topic){
        for(let j = i + 1; j < slice.length; j++){
          if(slice[j].topic === m.topic && (slice[j].status === 'done' || slice[j].status === 'info')){
            resolved = true; break;
          }
        }
      }
      if(!resolved){
        dot.className='sem-dot red pulse';
        title.textContent='Blocked: '+(m.from||'Agent');
        sem.title='Agent Blocked: '+(m.from||'Agent')+' on #'+(m.topic||m.id)+': '+(m.text||'');
        return;
      }
    }
  }

  // 2. Check for active working messages
  for(let i = slice.length - 1; i >= 0; i--){
    const m = slice[i];
    if(m.status === 'working'){
      let finished = false;
      for(let j = i + 1; j < slice.length; j++){
        const x = slice[j];
        if(m.fromSession && x.fromSession === m.fromSession && (x.status === 'done' || x.status === 'question' || x.status === 'info')){
          finished = true; break;
        }
        if(m.topic && x.topic === m.topic && x.status === 'done'){
          finished = true; break;
        }
      }
      if(!finished){
        const sObj = m.fromSession ? SESSIONS.find(s => s.sessionId === m.fromSession) : null;
        const sName = sObj ? (sObj.customName || sObj.sessionId) : (m.from || 'Agent');
        dot.className = 'sem-dot yellow pulse';
        title.textContent = 'Working: ' + sName;
        sem.title = 'Agent Working: ' + sName + ' — ' + (m.progress || m.topic || m.text || '');
        return;
      }
    }
  }

  // 3. Check for unanswered questions
  const openQuestions = [];
  for(let i = 0; i < slice.length; i++){
    const m = slice[i];
    if(m.status === 'question' && !replied.has(m.id)){
      openQuestions.push(m);
    }
  }
  if(openQuestions.length > 0){
    dot.className='sem-dot blue';
    const latestQ = openQuestions[openQuestions.length - 1];
    title.textContent = 'Questions (' + openQuestions.length + ')';
    sem.title = openQuestions.length + ' question(s) awaiting response — latest from ' + latestQ.from + ' on #' + (latestQ.topic || latestQ.id);
    return;
  }

  // 4. Default: All ready / idle
  dot.className='sem-dot green';
  title.textContent='All Ready';
  sem.title='All agents idle and ready for instructions';
}

function visible(){
  let items=DATA;
  if(SFILTER){
    const sessionMsgIds = new Set();
    for(const m of DATA){
      if((m.fromSession||'') === SFILTER || (m.toSession||'') === SFILTER){
        sessionMsgIds.add(m.id);
      }
    }
    // Include replies in threads of visible messages (transitive 2 passes)
    for(let pass = 0; pass < 2; pass++){
      for(const m of DATA){
        if(m.replyTo && sessionMsgIds.has(m.replyTo)){
          sessionMsgIds.add(m.id);
        }
      }
    }
    items = items.filter(m => sessionMsgIds.has(m.id));
  }
  if(FILTER==='P0')items=items.filter(m=>m.priority==='P0');
  else if(FILTER==='human')items=items.filter(m=>kind(m.from)==='human');
  else if(FILTER!=='all')items=items.filter(m=>m.from===FILTER);
  return items;
}

let ATTACHED_FILE = null;

function isImageFile(f) {
  if (!f) return false;
  return /\.(png|jpe?g|webp|gif|svg)$/i.test(f);
}

function cardHTML(m) {
  const k = kind(m.from), targetKind = kind(m.to), long = (m.text || '').length > 650, open = OPEN.has(m.id);
  const targetIcon = m.to === 'all' ? '👥' : (targetKind === 'Claude' ? '🤖' : (targetKind === 'Gemini' ? '✨' : '👤'));

  if (k === 'human') {
    return '<div class="chat-row row-human ' + (m.priority === 'P0' ? 'p0' : '') + '" id="msg-' + m.id + '" data-id="' + m.id + '">' +
      '<div class="bubble-human">' +
        '<div class="bubble-meta">' +
          '<span class="bubble-author">👤 <code class="nt" translate="no">' + esc(m.from) + '</code></span>' +
          '<span class="arrow">→</span>' +
          '<span class="bubble-target">' + targetIcon + ' <code class="nt" translate="no">' + esc(m.to) + '</code></span>' +
          (m.topic ? '<span class="pill-topic" title="Topic"><code class="nt" translate="no">#' + esc(m.topic) + '</code></span>' : '') +
          (m.priority !== 'normal' ? '<span class="pill-priority ' + esc(m.priority) + '" title="' + priorityHelp(m.priority) + '">' +
            (m.priority === 'P0' ? '🚨 ' : '') + '<code class="nt" translate="no">' + esc(m.priority) + '</code></span>' : '') +
          '<span class="bubble-time"><code class="nt" translate="no">' + ago(m.ts) + '</code> · <code class="nt msg-id" translate="no">#' + m.id + '</code></span>' +
        '</div>' +
        (m.replyTo ? '<div class="reply-ref" onclick="focusMsg(' + m.replyTo + ')" title="Jump to #' + m.replyTo + '">↳ in reply to <code class="nt" translate="no">#' + m.replyTo + '</code></div>' : '') +
        '<div class="bubble-text" id="t' + m.id + '">' + esc(m.text) + '</div>' +
        (isImageFile(m.file) ? '<div class="chat-img-wrap"><img class="chat-img" src="/api/attachment/' + encodeURIComponent(m.file) + '" onclick="window.open(this.src,\'_blank\')" alt="Attachment" title="Click to open full size" loading="lazy"></div>' : '') +
        (m.editedAt ? '<div class="bubble-edited">Edited <code class="nt" translate="no">' + ago(m.editedAt) + '</code>' + (m.editedBy ? ' by ' + esc(m.editedBy) : '') + '</div>' : '') +
        '<div class="bubble-actions">' +
          '<button class="icon-btn" onclick="copyText(' + m.id + ')" title="Copy message text">📋 Copy</button>' +
          '<button class="icon-btn" onclick="reply(' + m.id + ')" title="Reply">↩️</button>' +
          '<button class="icon-btn" onclick="startEdit(' + m.id + ')" title="Edit">✏️</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  const avatarIcon = k === 'Claude' ? '🤖' : (k === 'Gemini' ? '✨' : '👤');
  return '<div class="chat-row row-agent ' + (m.priority === 'P0' ? 'p0' : '') + '" id="msg-' + m.id + '" data-id="' + m.id + '">' +
    '<div class="agent-avatar ' + k + '">' + avatarIcon + '</div>' +
    '<div class="agent-content">' +
      '<div class="agent-meta">' +
        '<span class="agent-name ' + k + '"><code class="nt" translate="no">' + esc(m.from) + '</code></span>' +
        '<span class="arrow">→</span>' +
        '<span class="agent-target">' + targetIcon + ' <code class="nt" translate="no">' + esc(m.to) + '</code></span>' +
        '<span class="pill-status" title="' + statusHelp(m.status) + '">' +
          statusIcon(m.status) + ' <code class="nt" translate="no">' + esc(m.status) + '</code></span>' +
        (m.priority !== 'normal' ? '<span class="pill-priority ' + esc(m.priority) + '" title="' + priorityHelp(m.priority) + '">' +
          (m.priority === 'P0' ? '🚨 ' : '') + '<code class="nt" translate="no">' + esc(m.priority) + '</code></span>' : '') +
        (m.topic ? '<span class="pill-topic" title="Topic"><code class="nt" translate="no">#' + esc(m.topic) + '</code></span>' : '') +
        (m.progress ? '<span class="progress-tag">⚡ ' + esc(m.progress) + '</span>' : '') +
        '<span style="margin-left:auto;font-size:11px;color:var(--ink-dim)"><code class="nt" translate="no">' + ago(m.ts) + '</code> · <code class="nt msg-id" translate="no">#' + m.id + '</code></span>' +
      '</div>' +
      (m.replyTo ? '<div class="reply-ref" onclick="focusMsg(' + m.replyTo + ')" title="Jump to #' + m.replyTo + '">↳ in reply to <code class="nt" translate="no">#' + m.replyTo + '</code></div>' : '') +
      '<div class="agent-text' + (long && !open ? ' clip' : '') + '" id="t' + m.id + '">' + esc(m.text) + '</div>' +
      (long ? '<button class="more-btn" onclick="toggle(' + m.id + ')">' + (open ? 'Show less' : 'Show full message') + '</button>' : '') +
      (isImageFile(m.file) ? '<div class="chat-img-wrap"><img class="chat-img" src="/api/attachment/' + encodeURIComponent(m.file) + '" onclick="window.open(this.src,\'_blank\')" alt="Attachment" title="Click to open full size" loading="lazy"></div>' : '') +
      (m.editedAt ? '<div class="agent-edited">Edited <code class="nt" translate="no">' + ago(m.editedAt) + '</code>' + (m.editedBy ? ' by ' + esc(m.editedBy) : '') + '</div>' : '') +
      '<div class="agent-actions">' +
        '<button class="act-btn" onclick="reply(' + m.id + ')">↩️ Reply</button>' +
        '<button class="act-btn" onclick="copyText(' + m.id + ')">📋 Copy</button>' +
        '<button class="act-btn" onclick="startEdit(' + m.id + ')">✏️ Edit</button>' +
      '</div>' +
    '</div>' +
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

  const list = $('#list');
  const items = visible().slice().sort((a, b) => a.id - b.id);
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
    list.insertAdjacentHTML('beforeend', cardHTML(m));
    added = true;
  }
  if (added || full) {
    list.scrollTop = list.scrollHeight;
  }
}

window.copyText = function(id) {
  const m = DATA.find(x => x.id === id);
  if (!m) return;
  navigator.clipboard.writeText(m.text).then(() => {
    const el = document.getElementById('msg-' + id);
    if (el) {
      el.style.outline = '2px solid var(--accent)';
      setTimeout(() => { el.style.outline = ''; }, 600);
    }
  }).catch(() => {});
};

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
    if(box.id==='to'&&window.setQuick)window.setQuick(b.dataset.v);
  });
});

function flashForm(){
  const f=$('.capsule-box');if(!f)return;
  f.classList.remove('flash');void f.offsetWidth;f.classList.add('flash');
}

function adjustTextHeight(){
  const ta=$('#text');if(!ta)return;
  ta.style.height='auto';
  ta.style.height=Math.min(ta.scrollHeight, 180)+'px';
}
$('#text').addEventListener('input',adjustTextHeight);

window.cancelReply=function(){
  $('#replyTo').value='';
  const b=$('#replyBadge');if(b)b.style.display='none';
  const h=$('#hint');if(h)h.textContent='Enter to send · Ctrl+Enter or Shift+Enter for newline · Paste or drop images to attach';
};

window.cancelAttach=function(){
  ATTACHED_FILE=null;
  const b=$('#attachBadge');if(b)b.style.display='none';
  const fi=$('#fileInput');if(fi)fi.value='';
};

window.uploadFile=async function(file){
  if(!file)return;
  const badge=$('#attachBadge');
  const badgeText=$('#attachBadgeText');
  if(badge)badge.style.display='flex';
  if(badgeText)badgeText.textContent='⏳ Uploading ' + file.name + '...';
  try{
    const reader=new FileReader();
    reader.onload=async()=>{
      try{
        const r=await fetch('/api/upload',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({filename:file.name,data:reader.result})
        });
        const j=await r.json();
        if(j.error){
          alert('Upload failed: '+j.error);
          window.cancelAttach();
          return;
        }
        ATTACHED_FILE=j.filename;
        if(badgeText)badgeText.innerHTML='🖼️ Attached: <code class="nt">'+esc(file.name)+'</code>';
      }catch(err){
        alert('Upload failed: '+err.message);
        window.cancelAttach();
      }
    };
    reader.readAsDataURL(file);
  }catch(e){
    alert('Error reading file: '+e.message);
    window.cancelAttach();
  }
};

// Clipboard paste (Ctrl+V) for image files
document.addEventListener('paste', e=>{
  const items=(e.clipboardData||e.originalEvent?.clipboardData)?.items;
  if(!items)return;
  for(const item of items){
    if(item.kind==='file'&&item.type.startsWith('image/')){
      const file=item.getAsFile();
      if(file){
        window.uploadFile(file);
        break;
      }
    }
  }
});

// Drag and drop images onto compose capsule
const cBox=$('.capsule-box');
if(cBox){
  ['dragenter','dragover'].forEach(name=>{
    cBox.addEventListener(name,e=>{
      e.preventDefault();
      e.stopPropagation();
      cBox.classList.add('drag-over');
    });
  });
  ['dragleave','drop'].forEach(name=>{
    cBox.addEventListener(name,e=>{
      e.preventDefault();
      e.stopPropagation();
      cBox.classList.remove('drag-over');
    });
  });
  cBox.addEventListener('drop',e=>{
    const files=e.dataTransfer&&e.dataTransfer.files;
    if(files&&files.length>0){
      for(const f of files){
        if(f.type.startsWith('image/')){
          window.uploadFile(f);
          break;
        }
      }
    }
  });
}

function reply(id){
  const m=DATA.find(x=>x.id===id);if(!m)return;
  $('#replyTo').value=id;
  $('#topic').value=m.topic||'';
  const dst=(m.from==='Claude'||m.from==='Gemini')?m.from:'all';
  segSet('to',dst);
  const sel=$('#toSession');
  if(sel)sel.value=m.fromSession||'';
  if(m.fromSession)SFILTER=m.fromSession;
  updateTargetBanner();
  const rb=$('#replyBadge');
  const rbt=$('#replyBadgeText');
  if(rbt)rbt.innerHTML='↳ Replying to <code class="nt">#'+id+'</code> ('+esc(m.from)+')';
  if(rb)rb.style.display='flex';
  flashForm();
  $('#text').focus();
}

function startEdit(id){
  const m=DATA.find(x=>x.id===id);if(!m)return;
  EDIT=id;$('#text').value=m.text;
  adjustTextHeight();
  const rb=$('#replyBadge');
  const rbt=$('#replyBadgeText');
  if(rbt)rbt.innerHTML='✏️ Editing <code class="nt">#'+id+'</code> — send to save (original preserved)';
  if(rb)rb.style.display='flex';
  flashForm();
  $('#text').focus();
}

$('#compose').addEventListener('submit',async e=>{
  e.preventDefault();
  const text=$('#text').value.trim();
  if(!text&&!ATTACHED_FILE)return;
  let r;
  const toSessionVal=($('#toSession')?$('#toSession').value:'').trim();
  if(EDIT){
    r=await fetch('/api/edit',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id:EDIT,text,editedBy:$('#from').value})});
    EDIT=null;
    window.cancelReply();
  }else{
    const isP0=Boolean($('#p0Check')&&$('#p0Check').checked);
    const priorityVal=isP0?'P0':'normal';
    const isReply=Boolean($('#replyTo').value.trim());
    const isNewTask=Boolean($('#prNewTask')&&$('#prNewTask').classList.contains('on'));
    const autoStatus=isReply?'answer':((isNewTask||text.includes('?'))?'question':'info');
    const toVal=segGet('to')||'all';
    r=await fetch('/api/post',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        from:$('#from').value,
        to:toVal,
        toSession:toSessionVal,
        topic:$('#topic').value,
        priority:priorityVal,
        status:autoStatus,
        replyTo:$('#replyTo').value,
        text:text||(ATTACHED_FILE?'[Attached Image: '+ATTACHED_FILE+']':''),
        file:ATTACHED_FILE
      })});
  }
  const j=await r.json();
  if(j.error){alert(j.error);return;}
  $('#text').value='';
  adjustTextHeight();
  window.cancelReply();
  window.cancelAttach();
  if($('#p0Check'))$('#p0Check').checked=false;
  if($('#prNewTask'))$('#prNewTask').classList.remove('on');
  OPEN.clear();load(true);
});

$('#text').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = ta.value.substring(0, start) + '\n' + ta.value.substring(end);
      ta.selectionStart = ta.selectionEnd = start + 1;
      adjustTextHeight();
    } else if (!e.shiftKey) {
      e.preventDefault();
      $('#compose').requestSubmit();
    }
  }
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
    updateSemaphore();
  }catch(e){$('#slist').innerHTML='<div class="hint">Registry unavailable</div>';}
}

window.copyId = async function(el, value){
  // Addressing a specific window is the whole point of having ids, and until
  // now the only way to get one was to read it off the screen by hand.
  try{
    await navigator.clipboard.writeText(value);
  }catch(e){
    const ta=document.createElement('textarea');
    ta.value=value; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select();
    try{ document.execCommand('copy'); }catch(_){}
    document.body.removeChild(ta);
  }
  const mark=el.querySelector('.cpy');
  if(mark){
    const was=mark.textContent;
    mark.textContent='✓';
    setTimeout(()=>{mark.textContent=was;},900);
  }
};

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

function updateTargetBanner(){
  const sel=$('#toSession');
  const banner=$('#targetBanner');
  const bannerText=$('#targetBannerText');
  const val=(sel?sel.value:'').trim();
  if(!val){
    if(banner)banner.style.display='none';
    return;
  }
  const s=SESSIONS.find(x=>x.sessionId===val);
  const name=s?(s.customName||s.sessionId):val;
  const agent=s?s.agent:'session';
  const icon=agent==='Claude'?'🤖':(agent==='Gemini'?'✨':'👤');
  if(bannerText)bannerText.innerHTML='🎯 <b>Targeting session:</b> '+icon+' <code class="nt">'+esc(name)+'</code> ('+esc(agent)+') — <i>only this session will receive wake interrupts</i>';
  if(banner)banner.style.display='flex';
}

window.clearTargetSession=function(){
  SFILTER=null;
  const sel=$('#toSession');
  if(sel)sel.value='';
  segSet('to','all');
  const h=$('#hint');if(h)h.textContent='Enter to send · Ctrl+Enter or Shift+Enter for newline · Paste or drop images to attach';
  updateTargetBanner();
  renderSessions();
  render(true);
};

window.setTargetSession=function(sid){
  const sel=$('#toSession');
  if(!sid){
    window.clearTargetSession();
    return;
  }
  SFILTER=sid;
  if(sel)sel.value=sid;
  const s=SESSIONS.find(x=>x.sessionId===sid);
  if(s){
    segSet('to',s.agent);
  }
  updateTargetBanner();
  renderSessions();
  render(true);
  flashForm();
};

function populateSessionSelect(){
  const sel=$('#toSession');if(!sel)return;
  const curr=sel.value||SFILTER||'';
  let html='<option value="">📢 All / Broadcast (no direct wake)</option>';
  for(const s of SESSIONS){
    const icon=s.agent==='Claude'?'🤖':(s.agent==='Gemini'?'✨':'👤');
    const name=s.customName||s.sessionId;
    html+='<option value="'+esc(s.sessionId)+'">'+icon+' '+esc(name)+' ('+esc(s.agent)+')</option>';
  }
  sel.innerHTML=html;
  if(curr&&SESSIONS.some(s=>s.sessionId===curr)){
    sel.value=curr;
  }else{
    sel.value='';
  }
  updateTargetBanner();
}

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
      // Both identifiers, each copyable. The label is what the agents sign
      // with and what reads well; the canonical id is what the client issued
      // and the only one that cannot be invented twice. Addressing accepts
      // either — a message sent to one reaches the same window.
      '<div class="sid" title="Board label — click to copy" onclick="event.stopPropagation(); window.copyId(this, \''+esc(s.sessionId)+'\')">'+
        '<code class="nt">'+esc(s.sessionId)+'</code><span class="cpy">⧉</span></div>'+
      (s.canonicalId ? '<div class="sid scanon" title="'+esc(s.client||'client')+' session id — click to copy" '+
        'onclick="event.stopPropagation(); window.copyId(this, \''+esc(s.canonicalId)+'\')">'+
        '<code class="nt">'+esc(s.canonicalId)+'</code><span class="cpy">⧉</span></div>' : '')+
      (s.cwd ? '<div class="scwd" title="'+esc(s.cwd)+'"><code class="nt">'+esc(s.cwd)+'</code></div>' : '')+
      '<div class="sfoot">'+
        '<span class="cnt"><code class="nt">'+s.messages+' msg'+(s.messages===1?'':'s')+'</code></span>'+
        '<div class="sbtns">'+
          (s.hasSnapshot?'<button class="sbtn" data-act="snap" title="View session snapshot">📋 Context</button>':'')+
          '<button class="sbtn sbtn-poke" data-act="poke" title="Send a high priority wake notification">🚨 Wake</button>'+
        '</div>'+
      '</div>'+
      '</div>';
  }).join('');
  populateSessionSelect();
}

$('#slist').addEventListener('click',async e=>{
  const item=e.target.closest('.sitem');if(!item)return;
  const sid=item.dataset.sid;if(!sid)return;
  const s=SESSIONS.find(x=>x.sessionId===sid);if(!s)return;
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
  window.setTargetSession(sid);
});

const toSessEl=$('#toSession');
if(toSessEl){
  toSessEl.addEventListener('change',e=>{
    const val=e.target.value;
    window.setTargetSession(val);
  });
}

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
  const sel=$('#toSession');
  if(tgt==='all'){
    window.clearTargetSession();
  }else{
    const currVal=sel?sel.value:'';
    const currS=SESSIONS.find(s=>s.sessionId===currVal);
    if(currS&&currS.agent===tgt){
      updateTargetBanner();
      return;
    }
    const topicVal = ($('#topic') ? $('#topic').value : '').trim().toLowerCase();
    const matches=SESSIONS.filter(s=>s.agent===tgt);
    let bestMatch = null;
    if (topicVal) {
      bestMatch = matches.find(s => (s.topics || []).some(t => t.toLowerCase() === topicVal));
    }
    if (!bestMatch && matches.length > 0) {
      bestMatch = matches[0];
    }
    if (bestMatch) {
      window.setTargetSession(bestMatch.sessionId);
    } else {
      if (sel) sel.value = '';
      SFILTER = null;
      updateTargetBanner();
      renderSessions();
      render(true);
    }
  }
};

window.newTask=function(){
  $('#replyTo').value = '';
  $('#topic').value = '';
  $('#text').value = '';
  adjustTextHeight();
  window.cancelReply();
  window.cancelAttach();
  window.clearTargetSession();
  if($('#p0Check')) $('#p0Check').checked = false;
  const h=$('#hint');if(h)h.textContent='Enter to send · Ctrl+Enter or Shift+Enter for newline';
  if($('#prNewTask')) $('#prNewTask').classList.add('on');
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
    const admin = (readConfig().adminName || '').trim();
    const page = HTML.replace('__ADMIN_NAME__', admin.replace(/"/g, '&quot;'));
    return send(res, 200, 'text/html; charset=utf-8', page);
  }
  if (req.method === 'GET' && (req.url === '/api/board' || req.url.startsWith('/api/board?'))) {
    const q = new URL(req.url, 'http://127.0.0.1').searchParams;
    const sinceParam = q.get('since');
    const opts = {};
    if (sinceParam !== null) {
      opts.since = Number(sinceParam) || 0;
    }
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(apiBoard(opts)));
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
  if (req.method === 'POST' && req.url === '/api/upload') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 25e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { filename, data } = JSON.parse(body || '{}');
        if (!data) return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'Data is required' }));
        if (!fs.existsSync(ATTACHMENTS_DIR)) fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
        const base64Data = data.replace(/^data:[^;]+;base64,/, '');
        const buf = Buffer.from(base64Data, 'base64');
        // Only image types the board renders are accepted. An arbitrary
        // extension would be stored and later served from the board's own
        // origin; an SVG in particular can carry script, and this origin
        // exposes APIs that post messages and launch agents.
        let ext = path.extname(filename || '').toLowerCase();
        if (!IMAGE_EXT.includes(ext)) ext = '.png';
        const cleanBase = slug(path.basename(filename || 'image', ext), 'image');
        const safeName = `att_${Date.now()}_${cleanBase}${ext}`;
        const savePath = path.join(ATTACHMENTS_DIR, safeName);
        fs.writeFileSync(savePath, buf);
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
          ok: true,
          filename: safeName,
          file: savePath,
          url: '/api/attachment/' + safeName
        }));
      } catch (e) {
        return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/attachment/')) {
    const safeName = path.basename(req.url.slice('/api/attachment/'.length));
    const fullPath = path.join(ATTACHMENTS_DIR, safeName);
    if (!fs.existsSync(fullPath)) return send(res, 404, 'text/plain; charset=utf-8', 'Attachment not found');
    const ext = path.extname(safeName).toLowerCase();
    const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
    try {
      const imgData = fs.readFileSync(fullPath);
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=86400',
        // Never let the browser second-guess the type of a stored file.
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(imgData);
    } catch (e) {
      return send(res, 500, 'text/plain; charset=utf-8', e.message);
    }
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

// A closed environment is usually closed on purpose. Starting both of them
// whenever the board is opened undoes that decision several times a day, so the
// bridge waits until something is actually addressed to the one that is down —
// then, and only then, it brings it up.
//
// Broadcast does not count. "To everyone" is how routine notices are written,
// and the protocol already says an ordinary broadcast must not interrupt a
// window; it must not resurrect a closed one either. A P0 does, because P0
// means drop everything, and nobody can drop anything while shut down.
function raiseTargetEnvironment(m) {
  try {
    const to = String(m.to || m.to_agent || '').trim().toLowerCase();
    const toSession = String(m.toSession || m.to_session || '').trim();
    const directed = to === 'claude' || to === 'gemini';
    if (!directed && !toSession) {
      if (String(m.priority || '').toUpperCase() !== 'P0') return;
    }

    let agent = directed ? to : '';
    if (!agent && toSession) {
      try {
        const row = bridgeDb.getDb().prepare(
          'SELECT agent FROM sessions WHERE session_id = ? OR canonical_id = ? OR key = ?'
        ).get(toSession, toSession, toSession);
        if (row && row.agent) agent = String(row.agent).trim().toLowerCase();
      } catch (_) {}
    }

    if (agent === 'gemini') return launchApp('antigravity');
    if (agent === 'claude') return launchApp('claude');
    if (String(m.priority || '').toUpperCase() === 'P0') launchApp('all');
  } catch (_) {}
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
        raiseTargetEnvironment(m);
      }
      lastSeenId = top;
    }
  } catch (_) {}
}, 3000);

listen(PORT_FROM);
