'use strict';
// A new release unpacked beside the old one.
//
// The bridge installs in place: the board, its documents and its settings live
// next to the code. A release is a zip named after its version, and unpacking it
// the ordinary way gives a folder named after the zip — so every version lands
// in a folder of its own, beside the last. The installer then pointed the
// clients at the new folder and started a board there with an empty database,
// and the owner's board, history and settings stayed behind in the old folder
// with nothing saying so (11.11.2026: 2.8.2 installed next to 2.3.1).
//
// So the installer looks for the bridge the clients were using. When that is
// another folder and this one has no board yet, the board moves here: the
// database as one consistent copy, the documents, message bodies, archive and
// settings, with the paths inside them pointed at the new folder. The old
// folder is left exactly as it was — it is the owner's to delete.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.USERPROFILE || os.homedir();

// What makes up a board, beside the code. Names only: all of it sits in the bridge folder.
const DATA_FILES = ['bridge_config.json', 'agent_bridge.json', 'agent_bridge_cursors.json', 'argon_jobs.json',
  'gemini_convs.json', 'antigravity_sessions.json', 'current_antigravity_conv.txt', 'helper_skills_seen.json'];
const DATA_DIRS = ['docs', 'agent_bridge_bodies', 'agent_bridge_archive', 'contracts', 'sandbox'];
const DB = 'agent_bridge.db';

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const exists = p => { try { fs.accessSync(p); return true; } catch (_) { return false; } };

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// Every client config that may name the bridge's MCP server.
function clientConfigs() {
  const out = [];
  try { out.push(...require('./claude-home').desktopConfigFiles()); } catch (_) {}
  out.push(path.join(HOME, '.gemini', 'config', 'mcp_config.json'));
  out.push(path.join(HOME, '.gemini', 'antigravity', 'mcp_config.json'));
  return [...new Set(out.map(p => path.resolve(p)))];
}

// Is there a board in this folder — something a person would miss?
function hasBoard(dir) {
  if (exists(path.join(dir, 'agent_bridge.json'))) return true;
  const db = path.join(dir, DB);
  if (!exists(db)) return false;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(db, { readOnly: true });
    try { return d.prepare('SELECT COUNT(*) n FROM messages').get().n > 0; } finally { d.close(); }
  } catch (_) { return true; }          // a database that cannot be read is still somebody's board
}

// The bridge folder the clients are configured for, when it is not `here`.
// { dir, version, from } or null. `configs` is for tests.
function findOther(here, configs) {
  for (const file of configs || clientConfigs()) {
    const cfg = readJson(file);
    const srv = cfg && cfg.mcpServers && cfg.mcpServers['agent-bridge'];
    const script = srv && Array.isArray(srv.args) && srv.args.find(a => /agent-bridge-mcp\.js$/i.test(String(a)));
    if (!script) continue;
    const dir = path.dirname(path.resolve(String(script)));
    if (same(dir, here) || !exists(path.join(dir, 'agent-bridge-mcp.js'))) continue;
    let version = '';
    try { version = fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(); } catch (_) {}
    return { dir, version, from: file };
  }
  return null;
}

function copyTree(from, to) {
  let n = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) { fs.mkdirSync(b, { recursive: true }); n += copyTree(a, b); }
    else if (e.isFile() && !exists(b)) { fs.copyFileSync(a, b); n++; }
  }
  return n;
}

// Moves the board of `from` into `to`. Nothing in `from` is changed.
// → { files, messages, repointed } ; throws when the database cannot be copied.
function take(from, to) {
  const { DatabaseSync } = require('node:sqlite');
  const out = { files: 0, messages: 0, repointed: 0 };

  // The database first, as one consistent copy even if the old board is running.
  const oldDb = path.join(from, DB), newDb = path.join(to, DB);
  if (exists(oldDb)) {
    for (const tail of ['', '-wal', '-shm']) { try { fs.unlinkSync(newDb + tail); } catch (_) {} }
    const src = new DatabaseSync(oldDb, { readOnly: true });
    try { src.exec(`VACUUM INTO '${newDb.replace(/'/g, "''")}'`); } finally { src.close(); }
  }

  for (const f of DATA_FILES) {
    const a = path.join(from, f), b = path.join(to, f);
    if (exists(a) && !exists(b)) { fs.copyFileSync(a, b); out.files++; }
  }
  for (const d of DATA_DIRS) {
    const a = path.join(from, d);
    if (!exists(a)) continue;
    fs.mkdirSync(path.join(to, d), { recursive: true });
    out.files += copyTree(a, path.join(to, d));
  }

  // Paths written into the board and the settings named the old folder.
  const pairs = [[path.resolve(from), path.resolve(to)],
                 [path.resolve(from).replace(/\\/g, '/'), path.resolve(to).replace(/\\/g, '/')]];
  if (exists(newDb)) {
    const db = new DatabaseSync(newDb);
    try {
      try { out.messages = db.prepare('SELECT COUNT(*) n FROM messages').get().n; } catch (_) {}
      for (const [table, cols] of [['messages', ['file', 'message']], ['docs_index', ['file']]]) {
        for (const col of cols) {
          for (const [a, b] of pairs) {
            try {
              out.repointed += Number(db.prepare(`UPDATE ${table} SET ${col} = REPLACE(${col}, ?, ?) WHERE ${col} LIKE ?`)
                .run(a, b, '%' + a.replace(/[%_]/g, '') + '%').changes) || 0;
            } catch (_) { /* an older board has no such table or column */ }
          }
        }
      }
    } finally { db.close(); }
  }
  const cfgFile = path.join(to, 'bridge_config.json');
  const cfg = readJson(cfgFile);
  if (cfg) {
    for (const k of Object.keys(cfg)) {
      if (typeof cfg[k] !== 'string') continue;
      for (const [a, b] of pairs) if (cfg[k].toLowerCase().startsWith(a.toLowerCase())) cfg[k] = b + cfg[k].slice(a.length);
    }
    cfg.movedFrom = path.resolve(from);
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), 'utf8');
  }
  return out;
}

module.exports = { findOther, hasBoard, take, clientConfigs, DATA_FILES, DATA_DIRS };
