// Cards — the windows a human can actually point at.
//
// The board used to be addressed by free text: "Claude wDSP", "main-05-09".
// Nothing stopped three windows of one project from signing the same label, and
// three of them did, so a message meant for one of them could not be sent at
// all. A card is the opposite: one window, one id, issued by the client itself.
//
// Claude Desktop keeps a card per window under its account folder, and the id in
// it survives restarts — the window called "Dashboard editor" was created 24
// days ago and still answers to the same id today. The per-run id lives beside
// it as cliSessionId and is not what anyone should address.
//
// Antigravity keeps one database per conversation, named by the conversation id,
// and none of them carries a title. The names the client shows live one level
// up, in conversation_summaries.db: a row per conversation with a title, a
// preview that is filled even when the title is not, the run status, and the
// workspace. That row is richer than a Claude card — it says whether the window
// is busy — so it is the source, and the board's own registry only overrides it
// when the human has renamed something.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.USERPROFILE || os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

const CLAUDE_SESSIONS = path.join(APPDATA, 'Claude', 'claude-code-sessions');
const CLAUDE_CONFIG = path.join(APPDATA, 'Claude', 'config.json');
const GEMINI_HOME = path.join(HOME, '.gemini', 'antigravity');
const GEMINI_CONVERSATIONS = path.join(GEMINI_HOME, 'conversations');
const GEMINI_SUMMARIES = path.join(GEMINI_HOME, 'conversation_summaries.db');
const GEMINI_ANNOTATIONS = path.join(GEMINI_HOME, 'annotations');

// The name the owner gave a conversation. Antigravity writes a rename to
// annotations/<id>.pbtxt first (title:"..."); conversation_summaries.db is its
// cache of that for the sidebar, rebuilt from these files. A rename overwrites
// the automatic name everywhere and the automatic name is not kept.
function annotatedTitle(id) {
  try {
    const t = fs.readFileSync(path.join(GEMINI_ANNOTATIONS, id + '.pbtxt'), 'utf8');
    const m = t.match(/(?:^|\s)title:"((?:[^"\\]|\\.)*)"/);
    return m ? m[1].replace(/\\(.)/g, '$1') : '';
  } catch (_) {
    return '';
  }
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

// A Claude card writes its times as epoch milliseconds while a conversation
// file gives an ISO string. Reading one as the other silently produced NaN, and
// every Claude window fell out of a picker filtered by recent activity — the
// list looked like the human simply had no windows open.
function asIso(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000).toISOString();
  const n = Number(v);
  if (!Number.isNaN(n) && String(v).trim() !== '') {
    return new Date(n > 1e12 ? n : n * 1000).toISOString();
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name);
  } catch (_) {
    return [];
  }
}

// Which Claude account is signed in. The cards live in a folder named by the
// account, so this is read from disk rather than guessed — and it is what makes
// "the room list follows the account" possible at all.
function currentAccount() {
  const cfg = readJson(CLAUDE_CONFIG);
  return (cfg && cfg.lastKnownAccountUuid) || null;
}

function claudeAccounts() {
  return listDirs(CLAUDE_SESSIONS);
}

// Every Claude window of one account, newest activity first. `account` defaults
// to the one signed in; pass a different id to look at the other account's
// windows without switching to it.
function claudeCards(account) {
  const acct = account || currentAccount();
  if (!acct) return [];
  const out = [];
  const base = path.join(CLAUDE_SESSIONS, acct);
  for (const ws of listDirs(base)) {
    const wsDir = path.join(base, ws);
    let files = [];
    try {
      files = fs.readdirSync(wsDir).filter(f => f.startsWith('local_') && f.endsWith('.json'));
    } catch (_) {
      continue;
    }
    for (const f of files) {
      const d = readJson(path.join(wsDir, f));
      if (!d || !d.sessionId) continue;
      out.push({
        agent: 'Claude',
        id: d.sessionId,
        name: d.title || '',
        project: d.cwd || d.originCwd || '',
        account: acct,
        workspace: ws,
        archived: Boolean(d.isArchived),
        createdAt: asIso(d.createdAt),
        activeAt: asIso(d.lastActivityAt || d.lastFocusedAt)
      });
    }
  }
  return out.sort(byActivity);
}

// The first workspace a conversation was opened against, as a plain path. The
// column holds a JSON array of file: URIs, percent-encoded in newer entries.
function firstWorkspace(raw) {
  if (!raw) return '';
  let list;
  try { list = JSON.parse(raw); } catch (_) { return ''; }
  if (!Array.isArray(list) || !list.length) return '';
  let u = String(list[0]);
  try { u = decodeURIComponent(u); } catch (_) {}
  u = u.replace(/^file:\/+/, '').replace(/\/+$/, '');
  // Antigravity often records the drive root as the workspace. "c:" tells the
  // human nothing and only takes up the column, so treat it as no project.
  return /^[A-Za-z]:?$/.test(u) ? '' : u;
}

// Every Antigravity conversation worth showing. The id is the file name and the
// address the waker already delivers to, so nothing has to be translated; the
// name, the project and whether the window is busy come from the summaries.
function geminiCards() {
  let ids = [];
  try {
    ids = fs.readdirSync(GEMINI_CONVERSATIONS)
      .filter(f => f.endsWith('.db')).map(f => f.slice(0, -3));
  } catch (_) {
    return [];
  }

  const meta = new Map();
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(GEMINI_SUMMARIES, { readOnly: true });
    try {
      const rows = db.prepare(
        'SELECT conversation_id, title, preview, status, killed, workspace_uris, ' +
        'last_modified_time, last_user_input_time, step_count FROM conversation_summaries'
      ).all();
      for (const r of rows) meta.set(r.conversation_id, r);
    } finally {
      db.close();
    }
  } catch (_) {
    // no summaries: fall back to file times and bare ids
  }

  const out = [];
  for (const id of ids) {
    const m = meta.get(id);
    if (m && Number(m.killed) === 1) continue;
    let activeAt = null;
    try {
      activeAt = fs.statSync(path.join(GEMINI_CONVERSATIONS, id + '.db')).mtime.toISOString();
    } catch (_) {}
    out.push({
      agent: 'Gemini',
      id,
      name: annotatedTitle(id) || (m && (m.title || m.preview)) || '',
      project: m ? firstWorkspace(m.workspace_uris) : '',
      account: null,          // Antigravity switches accounts without splitting these
      archived: false,
      busy: Boolean(m && m.status && !String(m.status).endsWith('IDLE')),
      steps: m ? Number(m.step_count) || 0 : 0,
      createdAt: null,
      activeAt: asIso(m && m.last_user_input_time) || activeAt
    });
  }
  return out.sort(byActivity);
}

function byActivity(a, b) {
  return String(b.activeAt || '').localeCompare(String(a.activeAt || ''));
}

// Both sides in one list. The name a window carries in its own client comes
// first — that is where the owner names and renames it. `names` (what the board
// knows) only fills a window the client left unnamed. The other way round, a
// task name typed on the board once replaced a window's name for good: the
// window "Restore Corrupted Radio Logos" showed everywhere as "Logo Packs
// (Serbia)", one of the jobs it did.
//
// `sinceHours` drops windows nobody has touched lately: there are over two
// hundred Antigravity conversations on this machine, and a picker showing all of
// them is the crowded square again.
function allCards(opts) {
  const o = opts || {};
  const names = o.names || {};
  const cards = claudeCards(o.account).concat(geminiCards());
  const cutoff = o.sinceHours
    ? Date.now() - o.sinceHours * 3600 * 1000
    : null;

  return cards
    .filter(c => o.includeArchived || !c.archived)
    .filter(c => {
      if (!cutoff) return true;
      if (!c.activeAt) return true;   // unknown age: show it rather than hide it
      const t = Date.parse(c.activeAt);
      return Number.isNaN(t) ? true : t >= cutoff;
    })
    .map(c => Object.assign({}, c, { name: c.name || names[c.id] || '' }));
}

module.exports = {
  currentAccount,
  claudeAccounts,
  claudeCards,
  geminiCards,
  allCards
};
