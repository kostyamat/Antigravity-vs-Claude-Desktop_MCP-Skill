'use strict';
// The guard of the board database: notices a loss, and puts back what was lost.
//
// The database is the only store of everything said on the board, and it sits in
// a folder where agents run tools. Twice a tool has taken more than it was asked
// to. So on every round of the supervisor the board checks, with no model
// involved:
//
//   * that the file is sound (PRAGMA quick_check);
//   * that no message has gone missing since the last round. Messages only ever
//     leave on purpose — a cleared Square or room, an archived or deleted room —
//     and every such path writes the ids into the removed_messages ledger in the
//     same transaction. A message that is gone and is not in the ledger is a loss;
//   * that a snapshot fresh enough to repair from exists (db-backup.js).
//
// Repair is additive and therefore safe to run at any moment: rows that a
// snapshot has, the board lacks and the ledger does not list are inserted back
// under their own numbers. Nothing on the board is changed or removed by it.
// A database that fails quick_check cannot be mended from inside the processes
// that hold it open; then the guard names the snapshot to copy back.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const dbBackup = require('./db-backup');

const SNAPSHOT_MAX_AGE_MS = 60 * 60000;
const AUTO_REPAIR_FROM = 10;        // a loss this large is put back without waiting for anyone

function snapshots(home) {
  try {
    const dir = dbBackup.backupDir(home);
    return fs.readdirSync(dir).filter(f => /^agent_bridge_.*\.db$/.test(f)).sort().reverse().map(f => path.join(dir, f));
  } catch (_) { return []; }
}

// agent_bridge_2026-11-10T20-31-21.db → epoch ms
function takenAt(file) {
  const m = /agent_bridge_(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)/.exec(path.basename(file));
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : 0;
}

// Ids cleared before the ledger existed: the archives clear_messages wrote name their scope.
function archivedOnPurpose(home) {
  const ids = new Set();
  const dir = path.join(home, 'agent_bridge_archive');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^board_.*\.json$/.test(f)); } catch (_) {}
  for (const f of files) {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (a && a.scope && Array.isArray(a.messages)) for (const m of a.messages) ids.add(m.id);
    } catch (_) {}
  }
  return ids;
}

function createGuard({ bridgeDb, home }) {
  const live = () => {
    const db = bridgeDb.getDb();
    const r = db.prepare('SELECT COUNT(*) n, COALESCE(MAX(id), 0) top FROM messages').get();
    const gone = db.prepare('SELECT COUNT(*) n FROM removed_messages').get().n;
    // The highest number ever given out, which an emptied table no longer shows.
    let seq = 0;
    try { seq = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'messages'").get() || {}).seq || 0; } catch (_) {}
    return { count: r.n, top: Math.max(r.top, seq), removed: gone };
  };

  function sound() {
    try {
      const r = bridgeDb.getDb().prepare('PRAGMA quick_check').all();
      const first = r.length ? String(Object.values(r[0])[0]) : '';
      return first === 'ok' ? '' : (first || 'quick_check returned nothing');
    } catch (e) { return e.message; }
  }

  // What the snapshot has and the board has lost.
  function missingIn(file, purposely) {
    const snap = new DatabaseSync(file, { readOnly: true });
    try {
      const have = new Set(bridgeDb.getDb().prepare('SELECT id FROM messages').all().map(r => r.id));
      return snap.prepare('SELECT * FROM messages ORDER BY id').all().filter(r => !have.has(r.id) && !purposely.has(r.id));
    } finally { snap.close(); }
  }

  // `since` keeps snapshots taken before the guard's first round out of it: rooms deleted
  // in those days are in no ledger, and must not come back.
  function findLoss(since) {
    const purposely = bridgeDb.removedIds();
    for (const id of archivedOnPurpose(home)) purposely.add(id);
    for (const file of snapshots(home)) {
      if (since && takenAt(file) < since) break;
      let rows;
      try { rows = missingIn(file, purposely); } catch (_) { continue; }
      if (rows.length) return { file, rows };
    }
    return { file: '', rows: [] };
  }

  // Put the lost rows back under their own numbers. Additive only.
  function repair(since) {
    const bad = sound();
    if (bad) {
      const newest = snapshots(home)[0] || '';
      return { error: 'the database fails its integrity check (' + bad + '). It cannot be mended while the board and the ' +
        'agents hold it open: stop the board and both applications, then copy ' + (newest || '(no snapshot found)') +
        ' over agent_bridge.db.' };
    }
    const loss = findLoss(since);
    if (!loss.rows.length) return { restored: 0, from: '' };
    const db = bridgeDb.getDb();
    const known = new Set(db.prepare('PRAGMA table_info(messages)').all().map(c => c.name));
    const cols = Object.keys(loss.rows[0]).filter(c => known.has(c));
    const ins = db.prepare(`INSERT OR IGNORE INTO messages (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    db.exec('BEGIN');
    try {
      for (const r of loss.rows) ins.run(...cols.map(c => r[c]));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); return { error: e.message }; }
    return { restored: loss.rows.length, from: loss.file, first: loss.rows[0].id, last: loss.rows[loss.rows.length - 1].id };
  }

  // One round. `prev` is what the last round saw ({ count, top, removed, since }); the
  // caller keeps the returned `seen` for the next one.
  function check(prev) {
    const out = { ok: true, problem: '', lost: 0, repaired: null, snapshot: '', seen: prev || null };
    const bad = sound();
    if (bad) {
      out.ok = false;
      out.problem = 'the board database fails its integrity check: ' + bad + '. Newest snapshot: ' + (snapshots(home)[0] || 'none');
      return out;
    }
    const now = live();
    let since = prev && prev.since;
    if (!since) {
      // The first round: the board as it stands is the baseline, and is copied at once.
      try { out.snapshot = dbBackup.snapshot(bridgeDb, home); since = takenAt(out.snapshot); }
      catch (e) { out.problem = 'snapshot failed: ' + e.message; since = Date.now(); }
    }
    if (prev && typeof prev.count === 'number') {
      // Every id above the old top is a new message; every new ledger line is a wanted removal.
      const expected = prev.count + Math.max(0, now.top - prev.top) - (now.removed - (prev.removed || 0));
      out.lost = Math.max(0, expected - now.count);
    }
    if (out.lost > 0) {
      out.ok = false;
      const loss = findLoss(since);
      out.problem = `${out.lost} message(s) left the board since the last round with no record of a removal` +
        (loss.rows.length ? `; ${loss.rows.length} of them are in the snapshot ${loss.file}` : '; no snapshot holds them');
      if (loss.rows.length >= AUTO_REPAIR_FROM) out.repaired = repair(since);
    } else {
      // A healthy board, and the newest copy is old: take one now, so that a repair never
      // has more than an hour to make up.
      const newest = snapshots(home)[0];
      if (!newest || Date.now() - takenAt(newest) > SNAPSHOT_MAX_AGE_MS) {
        try { out.snapshot = dbBackup.snapshot(bridgeDb, home); } catch (e) { out.problem = 'snapshot failed: ' + e.message; }
      }
    }
    const after = live();
    out.seen = { count: after.count, top: after.top, removed: after.removed, since };
    return out;
  }

  return { check, repair, sound, findLoss, live };
}

module.exports = { createGuard };
