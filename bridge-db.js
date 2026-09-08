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

function resolveSessionAliases(sessionId) {
  const s = String(sessionId || '').trim();
  if (!s) return new Set();

  const aliases = new Set([s]);
  const sLower = s.toLowerCase();
  const db = getDb();

  // 1. Session config from gemini_convs.json
  const convsFile = path.join(SCRIPTS_DIR, 'gemini_convs.json');
  if (fs.existsSync(convsFile)) {
    try {
      const convs = JSON.parse(fs.readFileSync(convsFile, 'utf8'));
      for (const [k, v] of Object.entries(convs)) {
        if (k === 'default' || !v) continue;
        const kLow = k.toLowerCase();
        const vLow = String(v).toLowerCase();
        if (kLow === sLower || vLow === sLower) {
          aliases.add(k);
          aliases.add(String(v));
        }
      }
    } catch (_) {}
  }

  // 2. sessions table in SQLite
  try {
    const rows = db.prepare('SELECT key, session_id, custom_name FROM sessions').all();
    for (const r of rows) {
      const sid = (r.session_id || '').trim();
      const cname = (r.custom_name || '').trim();
      const keySess = (r.key || '').includes('/') ? r.key.split('/')[1].trim() : r.key.trim();

      const itemMatches = [sid, cname, keySess].some(cand => cand && aliases.has(cand));
      if (itemMatches) {
        if (sid) aliases.add(sid);
        if (cname) aliases.add(cname);
        if (keySess) aliases.add(keySess);
      }
    }
  } catch (_) {}

  // 3. session_aliases table in SQLite
  try {
    const aRows = db.prepare('SELECT alias, canonical_id FROM session_aliases').all();
    for (const r of aRows) {
      const a = (r.alias || '').trim();
      const c = (r.canonical_id || '').trim();
      if (aliases.has(a) || aliases.has(c)) {
        if (a) aliases.add(a);
        if (c) aliases.add(c);
      }
    }
  } catch (_) {}

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

function getCursor(reader, sessionId) {
  const db = getDb();
  const r = (reader || '').trim();
  const s = (sessionId || '').trim();
  if (!r) return 0;
  if (!s) {
    const globalRow = db.prepare('SELECT last_read_id FROM cursors WHERE reader = ?').get(r);
    return globalRow ? Number(globalRow.last_read_id) || 0 : 0;
  }

  const aliases = Array.from(resolveSessionAliases(s));
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
    const aliases = Array.from(resolveSessionAliases(s));
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
  readDocsIndex,
  saveDocIndex
};
