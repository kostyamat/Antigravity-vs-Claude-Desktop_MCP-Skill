'use strict';
// Advisory file reservations: "I am editing these files", so that two agents do not edit and commit
// the same files at once. The owner, 18.11.2026, after a comparison with another coordination layer
// that has them (the idea only; this is our own code): a lead and its helpers, or two helpers, had
// nothing but discipline between them and the same file.
//
// A reservation is a path or a glob relative to the repository root, held by one window for a time.
// reserve_files takes them (refused, naming the holder, when another window holds an overlapping one);
// the global pre-commit hook (reservation-guard.js) stops an agent's commit that touches a file another
// window holds. The owner is never stopped: he is told.

const DEFAULT_MINUTES = 120;
const MAX_MINUTES = 24 * 60;

// The repository as one key: forward slashes, lower case, no trailing slash.
function repoKey(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
// A path inside it: forward slashes, no leading ./ or /.
function relPath(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

// A glob as a regular expression: ** any depth, * one name, ? one character. A plain path also covers
// everything below it (a reserved folder holds its files).
function toRegex(glob) {
  const g = relPath(glob);
  let rx = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { rx += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (c === '*') rx += '[^/]*';
    else if (c === '?') rx += '[^/]';
    else rx += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + rx + '(/.*)?$', 'i');
}
function covers(pattern, file) { return toRegex(pattern).test(relPath(file)); }

// Two reservations collide when either covers the other, or one is a folder holding the other.
function overlap(a, b) {
  const x = relPath(a), y = relPath(b);
  if (!x || !y) return false;
  if (x.toLowerCase() === y.toLowerCase()) return true;
  const lit = s => s.replace(/[*?].*$/, '');           // the literal head of a glob
  return covers(x, y) || covers(y, x) || covers(x, lit(y)) || covers(y, lit(x));
}

function createReservations(getDb) {
  const db = () => {
    const d = getDb();
    d.exec(`CREATE TABLE IF NOT EXISTS file_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, pattern TEXT NOT NULL,
      holder TEXT NOT NULL, holder_name TEXT DEFAULT '', agent TEXT DEFAULT '', reason TEXT DEFAULT '',
      since TEXT, until TEXT)`);
    d.exec('CREATE INDEX IF NOT EXISTS idx_file_reservations_repo ON file_reservations(repo)');
    return d;
  };
  const active = repo => db().prepare('SELECT * FROM file_reservations WHERE repo = ? AND until > ? ORDER BY id')
    .all(repoKey(repo), new Date().toISOString());

  // { taken: [patterns], conflicts: [{pattern, holder, holderName, theirs, until, reason}] }
  function reserve({ repo, holder, holderName, agent, patterns, reason, minutes }) {
    const key = repoKey(repo);
    if (!key || !holder) throw new Error('a reservation needs the repository and the window that holds it');
    const list = (patterns || []).map(relPath).filter(Boolean);
    if (!list.length) throw new Error('name the files: paths or globs relative to the repository root');
    const mins = Math.min(MAX_MINUTES, Math.max(5, Number(minutes) || DEFAULT_MINUTES));
    const now = new Date(), until = new Date(now.getTime() + mins * 60000).toISOString();
    const others = active(key).filter(r => r.holder !== holder);
    const conflicts = [];
    for (const p of list) for (const r of others) {
      if (overlap(p, r.pattern)) conflicts.push({ pattern: p, holder: r.holder, holderName: r.holder_name, theirs: r.pattern, until: r.until, reason: r.reason });
    }
    if (conflicts.length) return { taken: [], conflicts };
    const d = db();
    if (!holderName) {                                  // a renewal keeps the name it was taken under
      const had = d.prepare("SELECT holder_name FROM file_reservations WHERE repo = ? AND holder = ? AND holder_name <> '' LIMIT 1").get(key, holder);
      if (had) holderName = had.holder_name;
    }
    for (const p of list) {
      d.prepare('DELETE FROM file_reservations WHERE repo = ? AND holder = ? AND lower(pattern) = lower(?)').run(key, holder, p);
      d.prepare('INSERT INTO file_reservations (repo, pattern, holder, holder_name, agent, reason, since, until) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(key, p, holder, String(holderName || ''), String(agent || ''), String(reason || ''), now.toISOString(), until);
    }
    return { taken: list, conflicts: [], until };
  }

  // Release some (patterns) or all of this window's reservations in the repository (repo '' = everywhere).
  function release({ repo, holder, patterns }) {
    const d = db();
    const list = (patterns || []).map(relPath).filter(Boolean);
    if (!list.length) {
      return repo ? d.prepare('DELETE FROM file_reservations WHERE repo = ? AND holder = ?').run(repoKey(repo), holder).changes
                  : d.prepare('DELETE FROM file_reservations WHERE holder = ?').run(holder).changes;
    }
    let n = 0;
    for (const p of list) n += d.prepare('DELETE FROM file_reservations WHERE repo = ? AND holder = ? AND lower(pattern) = lower(?)').run(repoKey(repo), holder, p).changes;
    return n;
  }

  // The files of a commit that another window holds: [{file, pattern, holder, holderName, agent, until, reason}].
  function heldByOthers({ repo, files, committer, committerAgent }) {
    const out = [];
    for (const r of active(repo)) {
      if (committer && r.holder === committer) continue;
      // An agent the hook cannot name (an Antigravity window) is not stopped by another Antigravity
      // window's reservation: it may well be its own.
      if (!committer && committerAgent === 'gemini' && r.agent === 'Gemini') continue;
      for (const f of files || []) if (covers(r.pattern, f)) out.push({ file: relPath(f), pattern: r.pattern, holder: r.holder,
        holderName: r.holder_name, agent: r.agent, until: r.until, reason: r.reason });
    }
    return out;
  }

  return { reserve, release, active, heldByOthers };
}

module.exports = { createReservations, overlap, covers, repoKey, relPath, DEFAULT_MINUTES };
