// ─────────────────────────────────────────────────────────────────────────────────────────
// 🗄️ BRIDGE-DB: Transactional ACID SQLite Storage for Agent-Bridge Ecosystem
//
// Uses native built-in `node:sqlite` module (Node.js >= 22.5).
// 0 external npm dependencies.
// WAL mode (Write-Ahead Logging) for non-blocking concurrent multi-process reads.
// ─────────────────────────────────────────────────────────────────────────────────────────

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SCRIPTS_DIR = path.resolve(__dirname);
const DB_PATH = path.join(SCRIPTS_DIR, 'agent_bridge.db');
const JSON_BACKUP = path.join(SCRIPTS_DIR, 'agent_bridge.json');
const CURSORS_JSON = path.join(SCRIPTS_DIR, 'agent_bridge_cursors.json');
const SESSIONS_JSON = path.join(SCRIPTS_DIR, 'docs', '_sessions.json');
const DOCS_INDEX_JSON = path.join(SCRIPTS_DIR, 'docs', '_index.json');

let _db = null;

function getDb() {
  if (_db) return _db;

  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  _db = new DatabaseSync(DB_PATH);

  // Optimal pragmas for multi-process operation on Windows
  _db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
  `);

  initSchema(_db);
  migrateFromJsonIfEmpty(_db);

  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      from_agent TEXT NOT NULL,
      from_session TEXT DEFAULT '',
      to_agent TEXT NOT NULL DEFAULT 'all',
      to_session TEXT DEFAULT '',
      reply_to INTEGER,
      topic TEXT DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'info',
      progress TEXT DEFAULT '',
      message TEXT NOT NULL,
      file TEXT,
      read_by TEXT DEFAULT '[]',
      edited_at TEXT,
      edited_by TEXT,
      original_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent);
    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_agent);
    CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic);
    CREATE INDEX IF NOT EXISTS idx_messages_priority ON messages(priority);
    CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
    CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to);

    CREATE TABLE IF NOT EXISTS cursors (
      reader TEXT PRIMARY KEY,
      last_read_id INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      key TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      session_id TEXT NOT NULL,
      custom_name TEXT DEFAULT '',
      project TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      knows TEXT DEFAULT '',
      topics TEXT DEFAULT '[]',
      contacts TEXT DEFAULT '{}',
      has_snapshot INTEGER DEFAULT 0,
      first_seen TEXT,
      last_seen TEXT
    );

    CREATE TABLE IF NOT EXISTS docs_index (
      name TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      from_agent TEXT NOT NULL,
      from_session TEXT DEFAULT '',
      to_agent TEXT NOT NULL,
      to_session TEXT DEFAULT '',
      topic TEXT DEFAULT '',
      priority TEXT DEFAULT 'normal',
      file TEXT NOT NULL,
      created TEXT NOT NULL,
      read_by TEXT DEFAULT '[]',
      acked_by TEXT DEFAULT '[]',
      ack_note TEXT DEFAULT '',
      archived INTEGER DEFAULT 0,
      archived_at TEXT,
      archived_why TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_docs_topic ON docs_index(topic);
    CREATE INDEX IF NOT EXISTS idx_docs_to ON docs_index(to_agent);
    CREATE INDEX IF NOT EXISTS idx_docs_archived ON docs_index(archived);

    CREATE TABLE IF NOT EXISTS session_aliases (
      alias TEXT PRIMARY KEY,
      canonical_id TEXT NOT NULL,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_session_aliases_canonical ON session_aliases(canonical_id);
  `);

  try {
    db.exec("ALTER TABLE sessions ADD COLUMN custom_name TEXT DEFAULT ''");
  } catch (_) {}

  // A session is known to the board by the label the agent picked for itself.
  // That label is not an identity: nothing issues it, nothing checks it, and a
  // second window that picks a near-miss spelling becomes a phantom session on
  // the board. These columns hold what the client actually knows about the
  // window — the id it issued, which application it is, where it is working —
  // so the label can go back to being what it is good at, a name a human reads.
  //
  // Local only. The database is never committed and never shipped; a fresh
  // install starts from an empty one on the machine that runs it.
  for (const column of ['canonical_id', 'client', 'cwd', 'title']) {
    try {
      db.exec("ALTER TABLE sessions ADD COLUMN " + column + " TEXT DEFAULT ''");
    } catch (_) {}
  }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_canonical ON sessions(canonical_id)');
  } catch (_) {}

  // A line of work: the sessions that carry one job across windows and accounts.
  // The owner switches Claude Desktop between two accounts; each keeps its own
  // list of windows, so one job ends up served by a window in each, and every
  // window signs the board with labels of its own. A line is what says they are
  // the same job, so a message to any of them — or to the line by name — reaches
  // whichever window is alive.
  //
  // Its own table on purpose. Membership used to live in session_aliases, where
  // the next window to report its canonical id overwrote "label -> line" with
  // "label -> window". Nothing but linking writes here.
  db.exec(`
    CREATE TABLE IF NOT EXISTS line_members (
      member TEXT PRIMARY KEY,
      line TEXT NOT NULL,
      agent TEXT DEFAULT '',
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_line_members_line ON line_members(line);
  `);
  migrateLinesOnce(db);
}

// The first lines were stitched together by hand on 11.09: every session of one
// job got the same custom name, and the window ids were pointed at that name in
// session_aliases. It held only while the alias rows stayed in a lucky order, and
// one of them had already been rewritten by the time it was looked at again. This
// turns that patch into membership rows. Once — user_version records it — so two
// sessions renamed alike later are not silently merged into a line.
function migrateLinesOnce(db) {
  let version = 0;
  try { version = Number(db.prepare('PRAGMA user_version').get().user_version) || 0; } catch (_) {}
  if (version >= 1) return;

  const groups = new Map();
  const add = (line, member, agent) => {
    const l = String(line || '').trim();
    const m = String(member || '').trim();
    if (!l || !m || l === m) return;
    if (!groups.has(l)) groups.set(l, new Map());
    const g = groups.get(l);
    if (!g.has(m) || (!g.get(m) && agent)) g.set(m, agent || '');
  };

  try {
    const named = db.prepare("SELECT agent, session_id, canonical_id, custom_name FROM sessions WHERE custom_name != ''").all();
    for (const r of named) {
      add(r.custom_name, r.session_id, r.agent);
      if (r.canonical_id) add(r.custom_name, r.canonical_id, r.agent);
    }
    for (const a of db.prepare('SELECT alias, canonical_id FROM session_aliases').all()) {
      const target = String(a.canonical_id || '').trim();
      if (groups.has(target)) add(target, a.alias, '');
    }

    const insert = db.prepare('INSERT OR IGNORE INTO line_members (member, line, agent, created_at) VALUES (?, ?, ?, ?)');
    const now = new Date().toISOString();
    db.exec('BEGIN');
    for (const [line, members] of groups) {
      // A custom name on a single session is a rename, not a line.
      if (members.size < 2) continue;
      const known = [...members.values()].find(Boolean) || '';
      for (const [member, agent] of members) insert.run(member, line, agent || known, now);
    }
    db.exec('PRAGMA user_version = 1');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
  }
}

function rowToMessage(r) {
  if (!r) return null;
  let readBy = [];
  try {
    readBy = JSON.parse(r.read_by || '[]');
  } catch (_) {
    readBy = [];
  }
  return {
    id: r.id,
    ts: r.ts,
    from: r.from_agent,
    fromSession: r.from_session || '',
    to: r.to_agent,
    toSession: r.to_session || '',
    replyTo: r.reply_to || null,
    topic: r.topic || '',
    priority: r.priority || 'normal',
    status: r.status || 'info',
    progress: r.progress || '',
    message: r.message || '',
    file: r.file || null,
    readBy: Array.isArray(readBy) ? readBy : [],
    editedAt: r.edited_at || null,
    editedBy: r.edited_by || null,
    originalMessage: r.original_message || null
  };
}

function migrateFromJsonIfEmpty(db) {
  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM messages').get();
  if (countRow && countRow.cnt > 0) {
    return; // Database already populated
  }

  if (!fs.existsSync(JSON_BACKUP)) {
    return;
  }

  try {
    const raw = fs.readFileSync(JSON_BACKUP, 'utf8');
    const data = JSON.parse(raw);
    const msgs = Array.isArray(data) ? data : (data.messages || []);
    if (!msgs.length) return;

    db.exec('BEGIN');

    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO messages (
        id, ts, from_agent, from_session, to_agent, to_session,
        reply_to, topic, priority, status, progress, message,
        file, read_by, edited_at, edited_by, original_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const m of msgs) {
      const readByStr = JSON.stringify(Array.isArray(m.readBy) ? m.readBy : []);
      insertStmt.run(
        m.id,
        m.ts || m.timestamp || new Date().toISOString(),
        m.from || m.sender || '?',
        m.fromSession || '',
        m.to || 'all',
        m.toSession || '',
        m.replyTo || null,
        m.topic || '',
        m.priority || 'normal',
        m.status || 'info',
        m.progress || '',
        m.message || '',
        m.file || null,
        readByStr,
        m.editedAt || null,
        m.editedBy || null,
        m.originalMessage || null
      );
    }

    // Cursor migration
    if (fs.existsSync(CURSORS_JSON)) {
      try {
        const cData = JSON.parse(fs.readFileSync(CURSORS_JSON, 'utf8'));
        const curStmt = db.prepare(`INSERT OR REPLACE INTO cursors (reader, last_read_id) VALUES (?, ?)`);
        for (const [reader, lastId] of Object.entries(cData)) {
          curStmt.run(reader, Number(lastId) || 0);
        }
      } catch (_) {}
    }

    // Session migration
    if (fs.existsSync(SESSIONS_JSON)) {
      try {
        const sData = JSON.parse(fs.readFileSync(SESSIONS_JSON, 'utf8'));
        const sessStmt = db.prepare(`
          INSERT OR REPLACE INTO sessions (
            key, agent, session_id, project, summary, knows, topics, contacts, has_snapshot, first_seen, last_seen
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const [key, s] of Object.entries(sData)) {
          sessStmt.run(
            key,
            s.agent || '',
            s.sessionId || '',
            s.project || '',
            s.summary || '',
            s.knows || '',
            JSON.stringify(s.topics || []),
            JSON.stringify(s.contacts || {}),
            s.hasSnapshot ? 1 : 0,
            s.firstSeen || '',
            s.lastSeen || ''
          );
        }
      } catch (_) {}
    }

    // Document migration
    if (fs.existsSync(DOCS_INDEX_JSON)) {
      try {
        const dData = JSON.parse(fs.readFileSync(DOCS_INDEX_JSON, 'utf8'));
        if (Array.isArray(dData)) {
          const docStmt = db.prepare(`
            INSERT OR REPLACE INTO docs_index (
              name, title, from_agent, from_session, to_agent, to_session,
              topic, priority, file, created, read_by, acked_by, ack_note,
              archived, archived_at, archived_why
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const d of dData) {
            docStmt.run(
              d.name,
              d.title || '',
              d.from || '',
              d.fromSession || '',
              d.to || '',
              d.toSession || '',
              d.topic || '',
              d.priority || 'normal',
              d.file || '',
              d.created || '',
              JSON.stringify(d.readBy || []),
              JSON.stringify(d.ackedBy || []),
              d.ackNote || '',
              d.archived ? 1 : 0,
              d.archivedAt || null,
              d.archivedWhy || ''
            );
          }
        }
      } catch (_) {}
    }

    db.exec('COMMIT');
    // 🔴 console.error, NOT console.log. This module is loaded into the MCP server,
    // which communicates with the client via stdio: stdout must contain ONLY JSON-RPC.
    // Any stray output in stdout corrupts responses and drops the connection.
    // Diagnostics belong in stderr; stdout must never receive arbitrary logs.
    console.error(`[bridge-db] Successfully imported ${msgs.length} messages into SQLite (${DB_PATH})`);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    console.error('[bridge-db] Migration from JSON failed:', err.message);
  }
}

// ── Message CRUD ─────────────────────────────────────────────────────────────────────────

function readAllMessages(options = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM messages WHERE 1=1';
  const params = [];

  if (typeof options.since === 'number') {
    sql += ' AND id > ?';
    params.push(options.since);
  }
  if (options.topic) {
    sql += ' AND LOWER(topic) = LOWER(?)';
    params.push(options.topic);
  }
  if (options.thread) {
    sql += ' AND (id = ? OR reply_to = ?)';
    params.push(options.thread, options.thread);
  }
  if (options.to) {
    sql += ' AND (LOWER(to_agent) = LOWER(?) OR to_agent = "all")';
    params.push(options.to);
  }

  if (options.limit && typeof options.limit === 'number') {
    // If limit is specified, retrieve last N records
    sql = `SELECT * FROM (${sql} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`;
    params.push(options.limit);
  } else {
    sql += ' ORDER BY id ASC';
  }

  const rows = db.prepare(sql).all(...params);
  return rows.map(rowToMessage);
}

function getMessageById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(id));
  return rowToMessage(row);
}

function findRecentDuplicate(fromAgent, message, seconds = 60) {
  const db = getDb();
  const cutoff = new Date(Date.now() - seconds * 1000).toISOString();
  const row = db.prepare(`
    SELECT id, message FROM messages
    WHERE from_agent = ? AND message = ? AND ts > ?
    ORDER BY id DESC LIMIT 1
  `).get(fromAgent, message, cutoff);
  return row ? { id: Number(row.id) } : null;
}

function addMessage(msg) {
  const db = getDb();
  const ts = msg.ts || new Date().toISOString();
  const readByStr = JSON.stringify(Array.isArray(msg.readBy) ? msg.readBy : []);

  const stmt = db.prepare(`
    INSERT INTO messages (
      ts, from_agent, from_session, to_agent, to_session,
      reply_to, topic, priority, status, progress, message,
      file, read_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const res = stmt.run(
    ts,
    msg.from || msg.sender || '?',
    msg.fromSession || '',
    msg.to || 'all',
    msg.toSession || '',
    msg.replyTo ? Number(msg.replyTo) : null,
    msg.topic || '',
    msg.priority || 'normal',
    msg.status || 'info',
    msg.progress || '',
    msg.message || '',
    msg.file || null,
    readByStr
  );

  const newId = Number(res.lastInsertRowid);
  return getMessageById(newId);
}

function updateMessage(id, updates = {}) {
  const db = getDb();
  const sets = [];
  const params = [];

  if (updates.message !== undefined) {
    sets.push('message = ?');
    params.push(updates.message);
  }
  if (updates.editedAt !== undefined) {
    sets.push('edited_at = ?');
    params.push(updates.editedAt);
  }
  if (updates.editedBy !== undefined) {
    sets.push('edited_by = ?');
    params.push(updates.editedBy);
  }
  if (updates.originalMessage !== undefined) {
    sets.push('original_message = ?');
    params.push(updates.originalMessage);
  }
  if (updates.status !== undefined) {
    sets.push('status = ?');
    params.push(updates.status);
  }
  if (updates.progress !== undefined) {
    sets.push('progress = ?');
    params.push(updates.progress);
  }
  if (updates.file !== undefined) {
    sets.push('file = ?');
    params.push(updates.file);
  }
  if (updates.readBy !== undefined) {
    sets.push('read_by = ?');
    params.push(JSON.stringify(updates.readBy));
  }

  if (!sets.length) return getMessageById(id);

  params.push(Number(id));
  db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getMessageById(id);
}

// ── Cursors & Read Tracking ─────────────────────────────────────────────────────────────

function readCursors() {
  const db = getDb();
  const rows = db.prepare('SELECT reader, last_read_id FROM cursors').all();
  const out = {};
  for (const r of rows) {
    out[r.reader] = r.last_read_id;
  }
  return out;
}

// ── Session Alias Resolution (UUID <-> Branch Name <-> Custom Name) ──────────────────

// Resolution runs to a fixed point. It used to make one pass over each table in
// rowid order, so a chain — label -> window -> line — closed only when the rows
// happened to be stored in the order the chain needed. Measured on the live
// board before this change: of twelve names on two lines, three could not see
// their whole line, and every radio label picked up a phantom alias shared by
// all of them. A fixed point does not care what order anything is stored in.
//
// options.agent  keeps the match inside one agent's sessions: a label can be
//                shared by a Claude session and a Gemini one, and they are not
//                the same participant.
// options.lines  (default true) follows line membership. Addressing wants it —
//                a message to the line reaches every window on it. Read cursors
//                do not: see getCursor.
function resolveSessionAliases(sessionId, options) {
  const s = String(sessionId || '').trim();
  if (!s) return new Set();
  const opts = options || {};
  const agent = String(opts.agent || '').trim().toLowerCase();
  const withLines = opts.lines !== false;

  const aliases = new Set([s]);
  const db = getDb();

  let convs = {};
  const convsFile = path.join(SCRIPTS_DIR, 'gemini_convs.json');
  try {
    if (fs.existsSync(convsFile)) convs = JSON.parse(fs.readFileSync(convsFile, 'utf8')) || {};
  } catch (_) { convs = {}; }

  let sessions = [];
  let aliasRows = [];
  let members = [];
  try { sessions = db.prepare('SELECT agent, key, session_id, custom_name, canonical_id FROM sessions').all(); } catch (_) {}
  try { aliasRows = db.prepare('SELECT alias, canonical_id FROM session_aliases').all(); } catch (_) {}
  try { members = db.prepare('SELECT member, line FROM line_members').all(); } catch (_) {}
  const lineNames = new Set(members.map(m => String(m.line || '').trim()).filter(Boolean));

  let grew = true;
  const has = v => !!v && aliases.has(v);
  const put = v => { if (v && !aliases.has(v)) { aliases.add(v); grew = true; } };

  for (let round = 0; grew && round < 32; round++) {
    grew = false;

    // 1. gemini_convs.json: window <-> conversation, matched without regard to case
    const lower = new Set([...aliases].map(x => x.toLowerCase()));
    for (const [k, v] of Object.entries(convs)) {
      if (k === 'default' || !v) continue;
      if (lower.has(k.toLowerCase()) || lower.has(String(v).toLowerCase())) { put(k); put(String(v)); }
    }

    // 2. sessions
    for (const r of sessions) {
      if (agent && String(r.agent || '').trim().toLowerCase() !== agent) continue;
      const sid = String(r.session_id || '').trim();
      const canon = String(r.canonical_id || '').trim();
      const key = String(r.key || '').trim();
      // Everything after the FIRST slash. Labels contain slashes themselves, and
      // split('/')[1] cut "kostyamat_fmradio/main-05-09" down to
      // "kostyamat_fmradio" — a name every radio label then shared.
      const keySess = key.includes('/') ? key.slice(key.indexOf('/') + 1).trim() : key;
      // A shared custom name is how lines were first stitched together by hand,
      // so it joins sessions only when lines are being followed.
      const cname = withLines ? String(r.custom_name || '').trim() : '';
      if ([sid, canon, keySess, cname].some(has)) { put(sid); put(canon); put(keySess); put(cname); }
    }

    // 3. session_aliases: label -> window
    for (const r of aliasRows) {
      const a = String(r.alias || '').trim();
      const c = String(r.canonical_id || '').trim();
      // Rows pointing a label at a line name are the hand patch of 11.09 — line
      // membership kept in the wrong table — and say nothing about the window.
      if (!withLines && (lineNames.has(a) || lineNames.has(c))) continue;
      if (has(a) || has(c)) { put(a); put(c); }
    }

    // 4. line membership
    if (withLines) {
      for (const m of members) {
        const member = String(m.member || '').trim();
        const line = String(m.line || '').trim();
        if (has(member) || has(line)) { put(member); put(line); }
      }
    }
  }

  return aliases;
}

function registerSessionAlias(alias, canonicalId) {
  const a = String(alias || '').trim();
  const c = String(canonicalId || '').trim();
  if (!a || !c || a.toLowerCase() === c.toLowerCase()) return;
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO session_aliases (alias, canonical_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(alias) DO UPDATE SET canonical_id = excluded.canonical_id
    `).run(a, c, new Date().toISOString());
  } catch (_) {}
}

// Read state is kept per window, not per line. A line is served by a window in
// each of two accounts, and a message one of them has read is not a message the
// other has seen: sharing the cursor would mark it read for a context that never
// held it. So a cursor follows the window's own labels and the id its client
// issued, and stops there.
//
// Settled by the owner on 16.09.2026, and his reason is the part worth keeping:
// re-reading costs tokens, losing context costs days and sometimes a project. Of
// the two ways to be wrong, this one errs toward showing a window something it has
// already seen, never toward hiding what it has not — and every incident this
// bridge has had was a message that did not arrive. Do not flip it to lines: true
// for tidiness.
function getCursor(reader, sessionId) {
  const db = getDb();
  const r = (reader || '').trim();
  const s = (sessionId || '').trim();
  if (!r) return 0;
  if (!s) {
    const globalRow = db.prepare('SELECT last_read_id FROM cursors WHERE reader = ?').get(r);
    return globalRow ? Number(globalRow.last_read_id) || 0 : 0;
  }

  const aliases = Array.from(resolveSessionAliases(s, { agent: r, lines: false }));
  const placeholders = aliases.map(() => '?').join(',');
  const keys = aliases.map(a => `${r}/${a}`);
  const row = db.prepare(`
    SELECT MAX(last_read_id) as maxId FROM cursors WHERE reader IN (${placeholders})
  `).get(...keys);

  if (row && row.maxId !== null) {
    return Number(row.maxId) || 0;
  }

  // Fallback to active global agent cursor (Claude or Gemini),
  // so a new session does not start from zero and spam closed P0 items:
  const globalRow = db.prepare('SELECT last_read_id FROM cursors WHERE reader = ?').get(r);
  if (globalRow && globalRow.last_read_id) {
    return Number(globalRow.last_read_id) || 0;
  }

  return 0;
}

function writeCursor(reader, lastReadId) {
  const db = getDb();
  db.prepare(`
    INSERT INTO cursors (reader, last_read_id)
    VALUES (?, ?)
    ON CONFLICT(reader) DO UPDATE SET last_read_id = excluded.last_read_id
  `).run(reader, Number(lastReadId) || 0);
}

function markRead(reader, upTo, sessionId) {
  const db = getDb();
  const r = (reader || '').trim();
  const s = (sessionId || '').trim();
  const maxRow = db.prepare('SELECT MAX(id) as maxId FROM messages').get();
  const targetId = typeof upTo === 'number' ? upTo : (maxRow ? maxRow.maxId : 0);
  if (r && s) {
    const aliases = Array.from(resolveSessionAliases(s, { agent: r, lines: false }));
    for (const a of aliases) {
      writeCursor(`${r}/${a}`, targetId);
    }
  } else if (r) {
    writeCursor(r, targetId);
  }
  return targetId;
}

// ── Board Status ────────────────────────────────────────────────────────────────────────

function getBoardStatus(reader) {
  const db = getDb();
  const totalRow = db.prepare('SELECT COUNT(*) as cnt, MAX(id) as maxId FROM messages').get();
  const total = totalRow ? totalRow.cnt : 0;
  const maxId = totalRow ? totalRow.maxId : 0;

  const cursors = readCursors();

  // Determine unread statistics per agent (global)
  const unreadStats = {};
  for (const ag of ['Claude', 'Gemini']) {
    const cur = cursors[ag] || 0;
    const countRow = db.prepare(`
      SELECT
        COUNT(*) as unreadCount,
        SUM(CASE WHEN priority = 'P0' THEN 1 ELSE 0 END) as p0Count
      FROM messages
      WHERE id > ?
        AND from_agent != ?
        AND (to_agent = ? OR to_agent = 'all')
    `).get(cur, ag, ag);

    unreadStats[ag] = {
      unread: countRow ? (countRow.unreadCount || 0) : 0,
      p0: countRow ? (countRow.p0Count || 0) : 0
    };
  }

  // Latest agent state (global)
  const lastStates = {};
  for (const ag of ['Claude', 'Gemini']) {
    const row = db.prepare(`
      SELECT * FROM messages
      WHERE from_agent = ? AND status IN ('working', 'done', 'blocked')
      ORDER BY id DESC LIMIT 1
    `).get(ag);
    lastStates[ag] = rowToMessage(row);
  }

  // Latest state for each active session individually (multi-session)
  const sessionStates = [];
  try {
    const stateRows = db.prepare(`
      SELECT m.*, s.custom_name as session_custom_name
      FROM messages m
      LEFT JOIN sessions s ON s.key = (m.from_agent || '/' || m.from_session)
      WHERE m.status IN ('working', 'done', 'blocked')
        AND m.id IN (
          SELECT MAX(id) FROM messages
          WHERE status IN ('working', 'done', 'blocked')
          GROUP BY from_agent, from_session
        )
      ORDER BY m.id DESC
    `).all();
    for (const row of stateRows) {
      const msg = rowToMessage(row);
      msg.sessionCustomName = row.session_custom_name || '';
      sessionStates.push(msg);
    }
  } catch (_) {}

  // Unanswered questions
  const openQuestions = db.prepare(`
    SELECT * FROM messages m
    WHERE m.status IN ('question', 'blocked')
      AND NOT EXISTS (
        SELECT 1 FROM messages r WHERE r.reply_to = m.id
      )
    ORDER BY m.id ASC
  `).all().map(rowToMessage);

  return {
    total,
    maxId,
    cursors,
    unreadStats,
    lastStates,
    sessionStates,
    openQuestions
  };
}

// ── Cleanup & Archiving ─────────────────────────────────────────────────────────────────

function clearBoard(reason, archiveDir) {
  const db = getDb();
  const msgs = readAllMessages();
  if (!msgs.length) return null;

  if (archiveDir && fs.existsSync(archiveDir)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(archiveDir, `board_${stamp}.json`);
    fs.writeFileSync(dest, JSON.stringify({ archivedAt: new Date().toISOString(), reason: reason || '', messages: msgs }, null, 2), 'utf8');
  }

  db.exec('DELETE FROM messages;');
  db.exec('DELETE FROM sqlite_sequence WHERE name = "messages";');
  db.exec('DELETE FROM cursors;');

  return msgs.length;
}

// ── Sessions ───────────────────────────────────────────────────────────────────────────

function readSessions() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM sessions ORDER BY last_seen DESC').all();
  const out = {};
  for (const r of rows) {
    let topics = [];
    let contacts = {};
    try { topics = JSON.parse(r.topics || '[]'); } catch (_) {}
    try { contacts = JSON.parse(r.contacts || '{}'); } catch (_) {}
    out[r.key] = {
      agent: r.agent,
      sessionId: r.session_id,
      customName: r.custom_name || '',
      project: r.project || '',
      summary: r.summary || '',
      knows: r.knows || '',
      topics,
      contacts,
      hasSnapshot: !!r.has_snapshot,
      canonicalId: r.canonical_id || '',
      client: r.client || '',
      cwd: r.cwd || '',
      title: r.title || '',
      firstSeen: r.first_seen,
      lastSeen: r.last_seen
    };
  }
  return out;
}

function renameSession(key, customName) {
  const db = getDb();
  const trimmed = String(customName || '').trim();
  const res = db.prepare('UPDATE sessions SET custom_name = ? WHERE key = ? OR session_id = ?').run(trimmed, key, key);
  if (trimmed) {
    const row = db.prepare('SELECT session_id FROM sessions WHERE key = ? OR session_id = ?').get(key, key);
    if (row && row.session_id) {
      registerSessionAlias(trimmed, row.session_id);
    }
  }
  return res.changes > 0;
}

function saveSession(s) {
  const db = getDb();
  const key = `${s.agent || 'unknown'}/${String(s.sessionId || '').trim()}`;
  db.prepare(`
    INSERT INTO sessions (
      key, agent, session_id, custom_name, project, summary, knows, topics, contacts, has_snapshot,
      canonical_id, client, cwd, title, first_seen, last_seen
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      custom_name = CASE WHEN excluded.custom_name != '' THEN excluded.custom_name ELSE sessions.custom_name END,
      project = excluded.project,
      summary = excluded.summary,
      knows = excluded.knows,
      topics = excluded.topics,
      contacts = excluded.contacts,
      has_snapshot = excluded.has_snapshot,
      -- Identity is only ever filled in, never blanked: a later call that does
      -- not carry it must not erase what an earlier one established.
      canonical_id = CASE WHEN excluded.canonical_id != '' THEN excluded.canonical_id ELSE sessions.canonical_id END,
      client = CASE WHEN excluded.client != '' THEN excluded.client ELSE sessions.client END,
      cwd = CASE WHEN excluded.cwd != '' THEN excluded.cwd ELSE sessions.cwd END,
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE sessions.title END,
      last_seen = excluded.last_seen
  `).run(
    key,
    s.agent || '',
    s.sessionId || '',
    s.customName || '',
    s.project || '',
    s.summary || '',
    s.knows || '',
    JSON.stringify(s.topics || []),
    JSON.stringify(s.contacts || {}),
    s.hasSnapshot ? 1 : 0,
    s.canonicalId || '',
    s.client || '',
    s.cwd || '',
    s.title || '',
    s.firstSeen || new Date().toISOString(),
    s.lastSeen || new Date().toISOString()
  );

  if (s.customName && s.sessionId) {
    registerSessionAlias(s.customName, s.sessionId);
  }
  // The label the agent signs with resolves to the id the client issued, so a
  // message addressed to either reaches the same window.
  if (s.canonicalId && s.sessionId) {
    registerSessionAlias(s.sessionId, s.canonicalId);
    if (s.customName) registerSessionAlias(s.customName, s.canonicalId);
  }
}

// ── Documents ───────────────────────────────────────────────────────────────────────────

function readDocsIndex() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM docs_index ORDER BY created DESC').all();
  return rows.map(r => ({
    name: r.name,
    title: r.title,
    from: r.from_agent,
    fromSession: r.from_session || '',
    to: r.to_agent,
    toSession: r.to_session || '',
    topic: r.topic || '',
    priority: r.priority || 'normal',
    file: r.file,
    created: r.created,
    readBy: JSON.parse(r.read_by || '[]'),
    ackedBy: JSON.parse(r.acked_by || '[]'),
    ackNote: r.ack_note || '',
    archived: !!r.archived,
    archivedAt: r.archived_at || null,
    archivedWhy: r.archived_why || ''
  }));
}

function saveDocIndex(d) {
  const db = getDb();
  db.prepare(`
    INSERT INTO docs_index (
      name, title, from_agent, from_session, to_agent, to_session,
      topic, priority, file, created, read_by, acked_by, ack_note,
      archived, archived_at, archived_why
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      title = excluded.title,
      read_by = excluded.read_by,
      acked_by = excluded.acked_by,
      ack_note = excluded.ack_note,
      archived = excluded.archived,
      archived_at = excluded.archived_at,
      archived_why = excluded.archived_why
  `).run(
    d.name,
    d.title || '',
    d.from || '',
    d.fromSession || '',
    d.to || '',
    d.toSession || '',
    d.topic || '',
    d.priority || 'normal',
    d.file || '',
    d.created || new Date().toISOString(),
    JSON.stringify(d.readBy || []),
    JSON.stringify(d.ackedBy || []),
    d.ackNote || '',
    d.archived ? 1 : 0,
    d.archivedAt || null,
    d.archivedWhy || ''
  );
}

// ── Lines of work ───────────────────────────────────────────────────────────────────

function listFrom(members) {
  const raw = Array.isArray(members) ? members : String(members || '').split(/[,\n]+/);
  return [...new Set(raw.map(m => String(m || '').trim()).filter(Boolean))];
}

function lineOf(member) {
  const m = String(member || '').trim();
  if (!m) return '';
  try {
    const row = getDb().prepare('SELECT line FROM line_members WHERE member = ?').get(m);
    return row ? String(row.line || '') : '';
  } catch (_) {
    return '';
  }
}

function lineMembers(line) {
  const l = String(line || '').trim();
  if (!l) return [];
  try {
    return getDb().prepare('SELECT member, agent, created_at FROM line_members WHERE line = ? ORDER BY created_at, member').all(l);
  } catch (_) {
    return [];
  }
}

function readLines() {
  const out = new Map();
  try {
    for (const r of getDb().prepare('SELECT member, line, agent, created_at FROM line_members ORDER BY line, created_at, member').all()) {
      if (!out.has(r.line)) out.set(r.line, []);
      out.get(r.line).push({ member: r.member, agent: r.agent || '', created_at: r.created_at });
    }
  } catch (_) {}
  return out;
}

// A member belongs to one line at most. Moving it to another line is what linking
// means, so it is allowed — but it is reported, never done quietly.
function linkSessions(line, members, agent) {
  const l = String(line || '').trim();
  if (!l) throw new Error('a line name is required');
  const list = listFrom(members).filter(m => m !== l);
  if (!list.length) throw new Error('no members given');
  // A line named after something that is already a member elsewhere would fuse
  // two lines the moment anything resolved through it.
  const clash = lineOf(l);
  if (clash) throw new Error(`"${l}" is itself a member of the line "${clash}" and cannot name another`);

  const db = getDb();
  const now = new Date().toISOString();
  const who = String(agent || '').trim();
  const current = db.prepare('SELECT line FROM line_members WHERE member = ?');
  const upsert = db.prepare(`
    INSERT INTO line_members (member, line, agent, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(member) DO UPDATE SET
      line = excluded.line,
      agent = CASE WHEN excluded.agent != '' THEN excluded.agent ELSE line_members.agent END
  `);
  const added = [];
  const moved = [];
  db.exec('BEGIN');
  try {
    for (const m of list) {
      const prev = current.get(m);
      if (prev && prev.line === l) continue;
      if (prev) moved.push({ member: m, from: prev.line });
      else added.push(m);
      upsert.run(m, l, who, now);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
  return { line: l, added, moved, members: lineMembers(l) };
}

function unlinkSessions(line, members) {
  const l = String(line || '').trim();
  if (!l) throw new Error('a line name is required');
  const list = listFrom(members);
  if (!list.length) throw new Error('no members given');
  const del = getDb().prepare('DELETE FROM line_members WHERE member = ? AND line = ?');
  let removed = 0;
  for (const m of list) removed += Number(del.run(m, l).changes) || 0;
  return { line: l, removed, members: lineMembers(l) };
}

module.exports = {
  DB_PATH,
  getDb,
  readAllMessages,
  getMessageById,
  findRecentDuplicate,
  addMessage,
  updateMessage,
  readCursors,
  getCursor,
  writeCursor,
  markRead,
  getBoardStatus,
  clearBoard,
  readSessions,
  renameSession,
  saveSession,
  resolveSessionAliases,
  registerSessionAlias,
  lineOf,
  lineMembers,
  readLines,
  linkSessions,
  unlinkSessions,
  readDocsIndex,
  saveDocIndex
};
