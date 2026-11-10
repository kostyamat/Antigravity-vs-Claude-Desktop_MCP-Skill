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

const claudeHome = require('./claude-home');

const HOME = process.env.USERPROFILE || os.homedir();
const CLAUDE_CODE_CONFIG = path.join(HOME, '.claude.json');
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
  for (const file of claudeHome.configFiles()) {
    const cfg = readJson(file);
    if (cfg && cfg.lastKnownAccountUuid) return cfg.lastKnownAccountUuid;
  }
  return null;
}

// The address behind an account id, where this machine records one. Claude
// Code keeps the account it is signed in to, so usually one of the two is
// named and the other is not; nothing else on disk carries an address, and a
// heading that says the real one beats a uuid that means nothing to anybody.
// Accounts with no address recorded are simply absent from the map, and the
// caller says "this account" or "other account" rather than inventing a name.
function accountEmails() {
  const out = {};
  const cfg = readJson(CLAUDE_CODE_CONFIG);
  const acc = cfg && cfg.oauthAccount;
  if (acc && acc.accountUuid && acc.emailAddress) {
    out[String(acc.accountUuid)] = String(acc.emailAddress);
  }
  return out;
}

function claudeAccounts() {
  const out = new Set();
  for (const root of claudeHome.sessionRoots()) for (const a of listDirs(root)) out.add(a);
  return [...out];
}

// Every window record of one account, as the client wrote it, across every data
// root. A window found in two roots (the app left an old folder behind when it
// moved) is the one with the later activity.
function claudeRecords(acct) {
  const byId = new Map();
  for (const root of claudeHome.sessionRoots()) {
    const base = path.join(root, acct);
    for (const ws of listDirs(base)) {
      let files = [];
      try {
        files = fs.readdirSync(path.join(base, ws)).filter(f => f.startsWith('local_') && f.endsWith('.json'));
      } catch (_) { continue; }
      for (const f of files) {
        const d = readJson(path.join(base, ws, f));
        if (!d || !d.sessionId) continue;
        const prev = byId.get(d.sessionId);
        const at = Number(d.lastActivityAt || d.lastFocusedAt || 0);
        if (!prev || at > Number(prev.d.lastActivityAt || prev.d.lastFocusedAt || 0)) byId.set(d.sessionId, { d, ws });
      }
    }
  }
  return [...byId.values()];
}

// The window a Claude Code run belongs to. The client gives every run of a
// window a new id (cliSessionId) and that is what a session knows itself by, but
// the window is what the owner sees and what a room holds. Without this step a
// room was built around a run id: it looked like an unnamed Antigravity window
// and stopped receiving the day the window restarted.
let cliCache = { at: 0, map: new Map() };
function claudeWindowOfCli(cliId) {
  const id = String(cliId || '').trim();
  if (!id) return null;
  if (Date.now() - cliCache.at > 20000 || !cliCache.map.has(id)) {
    const map = new Map();
    for (const acct of claudeAccounts()) {
      for (const { d } of claudeRecords(acct)) {
        const card = { id: d.sessionId, name: d.title || '', account: acct, project: d.originCwd || d.cwd || '' };
        if (d.cliSessionId) map.set(String(d.cliSessionId), card);
        map.set(String(d.sessionId), card);
      }
    }
    cliCache = { at: Date.now(), map };
  }
  return cliCache.map.get(id) || null;
}

// Every Claude window of one account, newest activity first. `account` defaults
// to the one signed in; pass a different id to look at the other account's
// windows without switching to it.
function claudeCards(account) {
  const acct = account || currentAccount();
  if (!acct) return [];
  return claudeRecords(acct).map(({ d, ws }) => ({
    agent: 'Claude',
    id: d.sessionId,
    name: d.title || '',
    project: d.originCwd || d.cwd || '',
    account: acct,
    workspace: ws,
    archived: Boolean(d.isArchived),
    createdAt: asIso(d.createdAt),
    activeAt: asIso(d.lastActivityAt || d.lastFocusedAt)
  })).sort(byActivity);
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
// The strings inside a protobuf message, depth first. Antigravity stores its rows as
// protobuf without a schema we have; the fields we need are plain strings in them.
function protoStrings(buf, out, depth) {
  out = out || [];
  if (!buf || depth > 6) return out;
  let i = 0;
  const varint = () => {
    let v = 0, shift = 0, b;
    do { if (i >= buf.length) throw new Error('eof'); b = buf[i++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    return v;
  };
  try {
    while (i < buf.length) {
      const key = varint();
      const wire = key & 7;
      if (wire === 0) varint();
      else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else if (wire === 2) {
        const len = varint();
        if (len < 0 || i + len > buf.length) return out;
        const part = buf.subarray(i, i + len);
        i += len;
        const before = out.length;
        protoStrings(part, out, (depth || 0) + 1);
        if (out.length === before) {
          const s = part.toString('utf8');
          if (s && !s.includes('�') && !/[\x00-\x08\x0e-\x1f]/.test(s)) out.push(s);
        }
      } else return out;
    }
  } catch (_) {}
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A conversation file is not always a window. Antigravity also keeps a database per
// child process an agent starts in a project (trajectory type 22, with a parent
// reference), and leaves empty ones behind; its sidebar shows neither, so neither has a
// summary row, and the board listed 26 of them as "Untitled window" (08.10.2026).
// A child is shown under its parent window with the task it was given; an empty one is
// dropped. Asked only for files without a summary, so the big ones are rarely opened.
function conversationKind(id, known) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(GEMINI_CONVERSATIONS, id + '.db'), { readOnly: true });
    try {
      const steps = Number(db.prepare('SELECT COUNT(*) AS n FROM steps').get().n);
      if (!steps) return { kind: 'empty' };
      const ref = db.prepare('SELECT data FROM parent_references ORDER BY idx LIMIT 1').get();
      if (!ref) return { kind: 'window' };
      const parent = protoStrings(Buffer.from(ref.data)).filter(s => UUID.test(s)).find(s => known.has(s)) || '';
      // The task: the request the child started from (step type 14, the same words the
      // parent was given), or, when it started without one, the first action it took.
      let task = '';
      for (const r of db.prepare('SELECT step_type, step_payload FROM steps ORDER BY idx LIMIT 8').all()) {
        const strings = protoStrings(r.step_payload ? Buffer.from(r.step_payload) : null);
        if (Number(r.step_type) === 14) {
          task = strings.filter(s => !UUID.test(s) && /\s/.test(s)).sort((a, b) => b.length - a.length)[0] || '';
        } else {
          for (const s of strings) {
            try { task = JSON.parse(s).toolAction || ''; } catch (_) {}
            if (task) break;
          }
        }
        if (task) break;
      }
      return { kind: 'child', parent, task: task.replace(/\s+/g, ' ').trim() };
    } finally {
      db.close();
    }
  } catch (_) {
    return { kind: 'window' };   // an unreadable file stays listed: hiding a real window is the worse error
  }
}

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

  const known = new Set(ids);
  const out = [];
  const children = [];
  for (const id of ids) {
    const m = meta.get(id);
    if (m && Number(m.killed) === 1) continue;
    const title = annotatedTitle(id);
    const kind = (m || title) ? { kind: 'window' } : conversationKind(id, known);
    if (kind.kind === 'empty') continue;
    let activeAt = null;
    try {
      activeAt = fs.statSync(path.join(GEMINI_CONVERSATIONS, id + '.db')).mtime.toISOString();
    } catch (_) {}
    const card = {
      agent: 'Gemini',
      id,
      name: title || (m && (m.title || m.preview)) || '',
      project: m ? firstWorkspace(m.workspace_uris) : '',
      account: null,          // Antigravity switches accounts without splitting these
      archived: false,
      busy: Boolean(m && m.status && !String(m.status).endsWith('IDLE')),
      steps: m ? Number(m.step_count) || 0 : 0,
      createdAt: null,
      activeAt: asIso(m && m.last_user_input_time) || activeAt
    };
    if (kind.kind === 'child') {
      card.parent = kind.parent;
      card.task = kind.task;
      children.push(card);
    } else {
      out.push(card);
    }
  }
  out.sort(byActivity);

  // A child is named after its parent window and the task it was given, and listed right
  // under the parent (newest child first); one whose parent is gone goes to the end.
  const byId = new Map(out.map(c => [c.id, c]));
  const under = new Map();
  for (const c of children.sort(byActivity)) {
    const p = byId.get(c.parent);
    c.name = '↳ ' + ((p && p.name) || 'Antigravity') + (c.task ? ': ' + c.task : '');
    if (p && !c.project) c.project = p.project;
    const key = p ? p.id : '';
    if (!under.has(key)) under.set(key, []);
    under.get(key).push(c);
  }
  const ordered = [];
  for (const c of out) ordered.push(c, ...(under.get(c.id) || []));
  return ordered.concat(under.get('') || []);
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
// Every Claude window of every account signed in on this machine, newest
// first. One job here is carried from two accounts, so a list limited to the
// account signed in right now hides half the work and shows it as absence.
function claudeCardsEverywhere() {
  const out = [];
  for (const acct of claudeAccounts()) out.push(...claudeCards(acct));
  return out.sort(byActivity);
}

function allCards(opts) {
  const o = opts || {};
  const names = o.names || {};
  const cards = (o.allAccounts ? claudeCardsEverywhere() : claudeCards(o.account))
    .concat(geminiCards());
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
  accountEmails,
  claudeAccounts,
  claudeCards,
  claudeCardsEverywhere,
  claudeWindowOfCli,
  claudeProblem: () => claudeHome.problem(),
  geminiCards,
  allCards
};
