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
const cardsLib = require('./cards');
const archiver = require('./room-archive').createArchiver(bridgeDb, path.resolve(__dirname));
const { wakeAntigravity } = require('./wake-antigravity');
const { inviteText } = require('./room-invite');

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
      to: m.to || 'all', toSession: m.toSession || '', room: m.room || '', replyTo: m.replyTo || null,
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
  const room = (data.room || '').trim();

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
    room,
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

  wakeAntigravity(rec);
  return { ok: true, id: nextId };
}

// A window put in a room is told so at once, in the room, addressed to it: the
// message wakes it (Antigravity through the waker, Claude through its watchman)
// and carries the calls that bring it in. Adding a member and saying nothing
// left the owner to carry the room id to the window by hand.
function inviteFromOwner(owner, room, card, known) {
  const agent = (known && known.agent) || (/^local_/.test(card) ? 'Claude' : 'Gemini');
  return apiPost({
    from: String(owner || '').trim() || 'Owner',
    room: room.id, to: agent, toSession: card, status: 'question',
    text: inviteText(room, { name: (known && known.name) || '', card })
  });
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
const SESSIONS_DIR = path.join(SCRIPTS_DIR, 'docs', 'sessions');

function slug(s, fallback) {
  const v = String(s || '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gui, '-')
    .replace(/^-+|-+$/g, '');
  return v || fallback || 'unknown';
}

// What the board calls a window, so a card with no title of its own still shows
// the name a human or an agent gave it here.
function boardCardNames() {
  const names = {};
  try {
    const sessions = bridgeDb.readSessions();
    for (const s of Object.values(sessions || {})) {
      if (!s) continue;
      const label = s.customName || s.title || '';
      if (!label) continue;
      if (s.canonicalId) names[s.canonicalId] = label;
      if (s.sessionId) names[s.sessionId] = label;
    }
  } catch (_) {}
  return names;
}

function apiCards(hours, allAccounts) {
  const names = boardCardNames();
  const here = cardsLib.currentAccount() || '';
  const list = cardsLib.allCards({ sinceHours: hours || 48, names });

  // Windows of the other Claude account are offered too, marked as elsewhere.
  // One of them is not open now and will not answer today — but it reads the
  // board when it comes back, and a room is exactly how a thread waits for it.
  if (allAccounts) {
    for (const acct of cardsLib.claudeAccounts()) {
      if (acct === here) continue;
      for (const c of cardsLib.claudeCards(acct)) {
        if (c.archived) continue;
        list.push(Object.assign({}, c, { name: c.name || names[c.id] || '', elsewhere: true }));
      }
    }
  }
  return { account: here, accounts: cardsLib.claudeAccounts(), cards: list };
}

function apiRooms() {
  const account = cardsLib.currentAccount() || '';
  return { account, rooms: bridgeDb.readRooms(account) };
}

function apiSessions() {
  let reg = {};
  try { reg = bridgeDb.readSessions(); } catch (_) {}
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
      line: lineFor(s),
      lineMembers: lineRoster(s),
      topics: (s.topics || []).slice(0, 14),
      summary: s.summary || '',
      project: s.project || '',
      lastSeen: s.lastSeen || (msgs.length ? msgs[msgs.length - 1].ts : ''),
      messages: msgs.length,
      hasSnapshot: fs.existsSync(snap)
    };
  });
  out.sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
  return { sessions: groupByWindow(out) };
}

// One window, one row. A client issues a fresh session label every time the
// session starts, so a conversation that has been reopened three times appeared
// here as three sessions — which is what made deliberate forks and ordinary
// restarts look the same. The id the client issued does not change, so rows
// that share it are the same window, and its earlier labels are history rather
// than separate participants.
//
// Rows without that id cannot be grouped: they predate it or come from a client
// that has none to give. They stay exactly as they were.
// The line a session belongs to, found through its window: a label issued this
// morning is not a member itself, but the window it belongs to is.
function lineFor(s) {
  try {
    for (const name of bridgeDb.resolveSessionAliases(s.sessionId, { agent: s.agent, lines: false })) {
      const line = bridgeDb.lineOf(name);
      if (line) return line;
    }
  } catch (_) {}
  return '';
}

// The whole roster of a line, so the dashboard can filter by it even when some
// members have never posted and therefore have no card of their own.
function lineRoster(s) {
  const line = lineFor(s);
  return line ? bridgeDb.lineMembers(line).map(m => m.member) : [];
}

function groupByWindow(rows) {
  const groups = new Map();
  const out = [];
  for (const r of rows) {
    if (!r.canonicalId) { out.push(r); continue; }
    const key = r.agent + '|' + r.canonicalId;
    const head = groups.get(key);
    if (!head) {
      groups.set(key, r);
      r.aliases = [];
      out.push(r);
      continue;
    }
    // rows arrive newest first, so the first one seen is the current label
    head.aliases.push({ sessionId: r.sessionId, lastSeen: r.lastSeen, messages: r.messages });
    head.messages += r.messages;
    head.hasSnapshot = head.hasSnapshot || r.hasSnapshot;
    for (const t of r.topics || []) {
      if (head.topics.length < 14 && !head.topics.includes(t)) head.topics.push(t);
    }
    for (const field of ['customName', 'client', 'cwd', 'title', 'summary', 'project', 'line']) {
      if (!head[field] && r[field]) head[field] = r[field];
    }
    if (!(head.lineMembers || []).length && (r.lineMembers || []).length) head.lineMembers = r.lineMembers;
  }
  return out;
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

// ── page ──────────────────────────────────────────────────────────────────────
// The page lives in ui/ as ordinary files, so each is checked by the tool made
// for it. As a template string inside this file, broken client code still
// passed `node --check` and only showed up as a blank board.
const UI_DIR = path.join(SCRIPTS_DIR, 'ui');
const UI_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function uiPage() {
  const admin = (readConfig().adminName || '').trim();
  return fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8')
    .replace('__ADMIN_NAME__', admin.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'));
}

function uiFile(url) {
  const name = path.basename(url.split('?')[0]);
  const type = UI_TYPES[path.extname(name)];
  const file = path.join(UI_DIR, name);
  if (!type || !fs.existsSync(file)) return null;
  return { type, body: fs.readFileSync(file) };
}

// ── Server ───────────────────────────────────────────────────────────────────────────────
function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    return send(res, 200, 'text/html; charset=utf-8', uiPage());
  }
  if (req.method === 'GET' && req.url.startsWith('/ui/')) {
    const f = uiFile(req.url);
    return f ? send(res, 200, f.type, f.body) : send(res, 404, 'text/plain; charset=utf-8', 'Not found');
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
  if (req.method === 'GET' && req.url.startsWith('/api/cards')) {
    const q = new URL(req.url, 'http://x').searchParams;
    return send(res, 200, 'application/json; charset=utf-8',
      JSON.stringify(apiCards(Number(q.get('hours')) || 48, q.get('all') === '1')));
  }
  if (req.method === 'GET' && req.url === '/api/rooms') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(apiRooms()));
  }
  if (req.method === 'POST' && req.url.startsWith('/api/room/')) {
    const what = req.url.slice('/api/room/'.length).split('?')[0];
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let out;
      try {
        const d = JSON.parse(body || '{}');
        if (what === 'create') {
          const cards = (d.cards || []).map(x => String(x).trim()).filter(Boolean);
          const known = new Map(cardsLib.allCards({}).map(c => [c.id, c]));
          const members = cards.map(c => ({ card: c, agent: (known.get(c) || {}).agent || '' }));
          out = bridgeDb.createRoom(d.name || 'room', members, cardsLib.currentAccount() || '');
          if (out && out.id) {
            for (const m of members) inviteFromOwner(d.from, out, m.card, known.get(m.card));
          }
        } else if (what === 'add') {
          const known = new Map(cardsLib.allCards({}).map(c => [c.id, c]));
          out = bridgeDb.addRoomMember(d.id, d.card, (known.get(d.card) || {}).agent || d.agent || '');
          const room = bridgeDb.getRoom(String(d.id || ''));
          if (room) inviteFromOwner(d.from, room, d.card, known.get(d.card));
        } else if (what === 'remove') {
          out = bridgeDb.removeRoomMember(d.id, d.card);
        } else if (what === 'rename') {
          out = bridgeDb.renameRoom(d.id, d.name);
        } else if (what === 'describe') {
          out = archiver.describe(d.id);
        } else if (what === 'archive') {
          // The conversation, documents and images go into one zip; the room
          // leaves the board. Nothing is removed unless the zip was written.
          out = Object.assign({ ok: true }, archiver.archiveRoom(d.id));
        } else if (what === 'delete') {
          // For good: messages, documents and files. The page asked first.
          out = Object.assign({ ok: true }, archiver.deleteRoomForever(d.id));
        } else {
          out = { error: 'unknown room action: ' + what };
        }
      } catch (e) {
        out = { error: e.message };
      }
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(out));
    });
    return;
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
  if (req.method === 'POST' && req.url === '/api/session/link') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { line, members, agent, remove } = JSON.parse(body || '{}');
        const result = remove
          ? bridgeDb.unlinkSessions(line, members)
          : bridgeDb.linkSessions(line, members, agent);
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, result }));
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

    if (!agent && toSession) {
      try {
        const known = bridgeDb.lineMembers(toSession).find(x => x.agent);
        if (known) agent = String(known.agent).trim().toLowerCase();
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
