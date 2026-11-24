'use strict';
// A file sent to a window or a project on another linked machine.
//
// An attachment travels inside its message, base64 in one JSON body: 40 MB at most, and all of it
// again after a dropped connection. A firmware image or a build does not fit. So a file has a road
// of its own (owner, 24.11.2026: exchange files with other machines, a friend's among them, through
// the bridge): the sender's window asks for it with send_file, the MCP server only records it, and
// this machine's board sends it in pieces to the neighbour's door, /api/peer/file/. A dropped
// connection resumes where it stopped; the receiver checks the whole file's SHA-256 and only then
// keeps it, and tells the window it was for in a message that wakes it.
//
// What arrives is somebody else's bytes: it lands in exchange/inbox/<machine>/, under a cleaned
// name, and nothing there is ever opened or run by the board. The receiving agent decides.
//
// Only linked machines reach the door (peer-link.js admits). A machine that does not answer is
// tried again for RETRY_HOURS, as a message is; the sender is told once after a few minutes.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const CHUNK = 8 * 1024 * 1024;
const RETRY_HOURS = 24;
const NOTICE_AFTER_MS = 5 * 60000;
const MAX_GB_DEFAULT = 20;
const EXCHANGE_DIR = path.join(__dirname, 'exchange');

function ensureTable(bridgeDb) {
  bridgeDb.getDb().exec(`
    CREATE TABLE IF NOT EXISTS file_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dir TEXT NOT NULL,              -- 'out' or 'in'
      machine TEXT NOT NULL,          -- the other machine
      target TEXT DEFAULT '',         -- out: the window or project there; in: the window here
      from_session TEXT DEFAULT '',   -- out: the window here that sent it; in: sender@machine
      from_agent TEXT DEFAULT '',
      path TEXT NOT NULL,             -- out: the file here; in: where it was kept
      name TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      sha256 TEXT DEFAULT '',
      sent INTEGER DEFAULT 0,
      note TEXT DEFAULT '',
      state TEXT DEFAULT 'queued',    -- queued | sending | waiting | told | done | failed
      error TEXT DEFAULT '',
      remote_key TEXT DEFAULT '',
      created TEXT,
      updated TEXT
    );
  `);
}

const now = () => new Date().toISOString();
const human = n => n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const cleanName = s => String(s || 'file').split(/[\\/]/).pop().replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
const maxBytes = cfg => (Number((cfg || {}).maxFileGB) || MAX_GB_DEFAULT) * 1073741824;

// ── the sender's window: queue a file ────────────────────────────────────────────────────

// → { id, text } or { error }. Nothing is sent here: the board's pump does it.
function queue(bridgeDb, { to, file, note, fromSession, fromAgent, parseAddress, cfg }) {
  ensureTable(bridgeDb);
  const addr = parseAddress(String(to || ''));
  if (!addr) return { error: `"${to}" names no linked machine — address a window or a project there as <name>@<machine> (list_cards shows them).` };
  if (!addr.peer) return { error: `no machine "${addr.machine}" is linked here.` };
  if (!addr.target) return { error: 'name the window or the project on that machine before the @.' };
  const p = path.resolve(String(file || ''));
  let st;
  try { st = fs.statSync(p); } catch (_) { return { error: `no file at "${file}".` }; }
  if (!st.isFile()) return { error: `"${file}" is not a file (a folder goes as an archive: zip it first).` };
  if (st.size > maxBytes(cfg)) return { error: `the file is ${human(st.size)}; ${human(maxBytes(cfg))} is the most (maxFileGB in bridge_config.json).` };
  const r = bridgeDb.getDb().prepare(`INSERT INTO file_transfers (dir, machine, target, from_session, from_agent, path, name, size, note, state, created, updated)
    VALUES ('out', ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`).run(addr.machine, addr.target, String(fromSession || ''), String(fromAgent || ''),
    p, cleanName(p), st.size, String(note || ''), now(), now());
  return { id: Number(r.lastInsertRowid), text: `📦 ${cleanName(p)} (${human(st.size)}) is queued for "${addr.target}" on ${addr.machine}, transfer #${r.lastInsertRowid}. ` +
    'The board sends it in pieces and tells you when it is there, with its checksum checked. Do not move or change the file until then.' };
}

function list(bridgeDb, win) {
  ensureTable(bridgeDb);
  const rows = bridgeDb.getDb().prepare(`SELECT * FROM file_transfers WHERE (dir = 'out' AND from_session = ?) OR (dir = 'in' AND target = ?)
    ORDER BY id DESC LIMIT 20`).all(String(win || ''), String(win || ''));
  if (!rows.length) return 'No files sent or received by this window.';
  return rows.map(r => r.dir === 'out'
    ? `#${r.id} → ${r.target}@${r.machine}: ${r.name} ${human(r.size)} — ${r.state}${r.state === 'sending' || r.state === 'waiting' ? ' ' + Math.floor(100 * r.sent / Math.max(1, r.size)) + ' %' : ''}${r.error ? ' (' + r.error + ')' : ''}`
    : `#${r.id} ← ${r.from_session}: ${r.name} ${human(r.size)} at ${r.path}`).join('\n');
}

// ── the board: send what is queued ───────────────────────────────────────────────────────

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function call(peer, method, pathname, headers, bodyStream, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request(peer.url + pathname, { method, timeout: timeoutMs || 60000, headers }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => { let json = {}; try { json = JSON.parse(raw || '{}'); } catch (_) {} resolve({ status: res.statusCode, json }); });
    });
    req.on('timeout', () => req.destroy(new Error('no answer in time')));
    req.on('error', reject);
    if (bodyStream) { bodyStream.on('error', e => req.destroy(e)); bodyStream.pipe(req); } else req.end();
  });
}

let pumping = false;
// deps: { bridgeDb, peerByName, machineName, say(rec) } — say posts a board message and wakes its reader.
async function pump(deps) {
  if (pumping) return;
  pumping = true;
  const { bridgeDb } = deps;
  try {
    ensureTable(bridgeDb);
    const db = bridgeDb.getDb();
    const set = (id, fields) => {
      const keys = Object.keys(fields);
      db.prepare(`UPDATE file_transfers SET ${keys.map(k => k + ' = ?').join(', ')}, updated = ? WHERE id = ?`).run(...keys.map(k => fields[k]), now(), id);
    };
    const tell = (t, text, status) => deps.say({ from: 'Board', fromSession: 'board/files', to: t.from_agent || 'all', toSession: t.from_session,
      room: '', topic: 'file', priority: 'normal', status, message: text });
    const rows = db.prepare("SELECT * FROM file_transfers WHERE dir = 'out' AND state IN ('queued', 'sending', 'waiting', 'told') ORDER BY id").all();
    for (const t of rows) {
      if (Date.now() - new Date(t.created).getTime() > RETRY_HOURS * 3600e3) {
        set(t.id, { state: 'failed', error: `${t.machine} did not answer for ${RETRY_HOURS} hours` });
        tell(t, `📦 #${t.id} ${t.name} was not delivered: machine "${t.machine}" did not answer for ${RETRY_HOURS} hours. Send it again when it is on.`, 'blocked');
        continue;
      }
      const peer = deps.peerByName(t.machine);
      if (!peer) { set(t.id, { state: 'failed', error: 'machine no longer linked' }); tell(t, `📦 #${t.id} ${t.name}: machine "${t.machine}" is no longer linked.`, 'blocked'); continue; }
      let st;
      try { st = fs.statSync(t.path); } catch (_) { set(t.id, { state: 'failed', error: 'the file is gone' }); tell(t, `📦 #${t.id}: ${t.path} is gone; nothing was sent.`, 'blocked'); continue; }
      if (st.size !== t.size) { set(t.id, { state: 'failed', error: 'the file changed' }); tell(t, `📦 #${t.id}: ${t.path} changed size while queued; send it again.`, 'blocked'); continue; }
      let sha = t.sha256;
      if (!sha) { sha = await sha256Of(t.path); set(t.id, { sha256: sha }); }
      const key = `${deps.machineName()}-${t.id}`.replace(/[^\w.-]/g, '_');
      const head = { 'X-Board-Machine': deps.machineName(), 'X-File-Name': encodeURIComponent(t.name), 'X-File-Size': String(t.size),
        'X-File-Sha256': sha, 'X-File-Target': encodeURIComponent(t.target), 'X-File-From': encodeURIComponent(t.from_session),
        'X-File-Agent': encodeURIComponent(t.from_agent || ''), 'X-File-Note': encodeURIComponent(t.note || '') };
      try {
        // Where the other side stands: a resumed transfer goes on from there.
        let r = await call(peer, 'GET', '/api/peer/file/' + key, head, null, 8000);
        if (r.status === 200 && r.json.done) {
          set(t.id, { state: 'done', sent: t.size, remote_key: key });
          continue;
        }
        // A 4xx is an answer, not silence: an unknown addressee, a file too large, or a board too old
        // to have this door ("no such door") — trying again for a day changes none of them.
        if (r.status !== 200) throw Object.assign(new Error((r.json.error === 'no such door' ? 'its bridge is too old to take files — update it' : r.json.error) || 'answered ' + r.status),
          { refused: r.status >= 400 && r.status < 500 });
        let offset = Number(r.json.have) || 0;
        set(t.id, { state: 'sending', sent: offset, remote_key: key });
        while (offset < t.size) {
          const end = Math.min(t.size, offset + CHUNK);
          r = await call(peer, 'PUT', `/api/peer/file/${key}?offset=${offset}`, Object.assign({}, head, { 'Content-Length': String(end - offset),
            'Content-Type': 'application/octet-stream' }), fs.createReadStream(t.path, { start: offset, end: end - 1 }), 120000);
          if (r.status === 409 && typeof r.json.have === 'number') { offset = r.json.have; continue; }   // it holds something else: go on from there
          if (r.status !== 200) throw Object.assign(new Error(r.json.error || 'answered ' + r.status), { refused: true });
          offset = end;
          set(t.id, { sent: offset });
          if (r.json.done) {
            set(t.id, { state: 'done' });
            tell(t, `📦 #${t.id} ${t.name} (${human(t.size)}) is on ${t.machine} for "${t.target}", SHA-256 checked (${sha.slice(0, 12)}…): ${r.json.path}.`, 'done');
            break;
          }
        }
      } catch (e) {
        if (e.refused) {
          set(t.id, { state: 'failed', error: e.message });
          tell(t, `📦 #${t.id} ${t.name}: machine "${t.machine}" refused it — ${e.message}.`, 'blocked');
        } else if (t.state === 'waiting' && Date.now() - new Date(t.updated).getTime() > NOTICE_AFTER_MS) {
          set(t.id, { state: 'told', error: e.message });
          tell(t, `📦 #${t.id} ${t.name}: machine "${t.machine}" does not answer (${e.message}). The board goes on trying for ${RETRY_HOURS} hours ` +
            'and resumes where it stopped.', 'blocked');
        } else if (t.state !== 'waiting' && t.state !== 'told') {
          set(t.id, { state: 'waiting', error: e.message });
        }
      }
    }
  } catch (_) { /* a neighbour's trouble never takes the board down */ } finally { pumping = false; }
}

// ── the door: receive ────────────────────────────────────────────────────────────────────

// deps: { bridgeDb, router, say(rec), cfg } ; machine: the linked neighbour that sends.
async function handle(req, res, deps, machine) {
  const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(json)); };
  const { bridgeDb, router } = deps;
  ensureTable(bridgeDb);
  const url = new URL(req.url, 'http://x');
  const key = url.pathname.replace(/^\/api\/peer\/file\//, '');
  if (!/^[\w.-]{1,120}$/.test(key)) return send(400, { error: 'bad transfer key' });
  const h = n => { try { return decodeURIComponent(String(req.headers[n] || '')); } catch (_) { return ''; } };
  const size = Number(req.headers['x-file-size']);
  const sha = String(req.headers['x-file-sha256'] || '').toLowerCase();
  if (!(size >= 0) || !/^[0-9a-f]{64}$/.test(sha)) return send(400, { error: 'size and SHA-256 are required' });
  if (size > maxBytes(deps.cfg)) return send(413, { error: `the file is ${human(size)}; this machine takes ${human(maxBytes(deps.cfg))} at most` });
  const box = path.join(EXCHANGE_DIR, 'inbox', cleanName(machine));
  const part = path.join(EXCHANGE_DIR, 'partial', cleanName(machine) + '_' + key + '.part');
  const done = bridgeDb.getDb().prepare("SELECT path FROM file_transfers WHERE dir = 'in' AND machine = ? AND remote_key = ?").get(machine, key);
  if (done) return send(200, { done: true, have: size, path: done.path });
  let have = 0;
  try { have = fs.statSync(part).size; } catch (_) {}
  if (have > size) { try { fs.unlinkSync(part); } catch (_) {} have = 0; }

  // Who it is for, checked before a byte is kept.
  const target = h('x-file-target');
  const win = router.windowOf(target) || '';
  if (!win) return send(404, { error: `"${target}" is no window and no project on this machine` });

  if (req.method === 'GET') return send(200, { have });
  if (req.method !== 'PUT') return send(405, { error: 'GET or PUT' });
  const offset = Number(url.searchParams.get('offset'));
  if (offset !== have) { req.resume(); return send(409, { have, error: `this machine holds ${have} bytes of it, not ${offset}` }); }
  const len = Number(req.headers['content-length']);
  if (!(len > 0) || offset + len > size) { req.resume(); return send(400, { error: 'a piece past the end of the file' }); }

  fs.mkdirSync(path.dirname(part), { recursive: true });
  const ok = await new Promise(resolve => {
    const out = fs.createWriteStream(part, { flags: have ? 'r+' : 'w', start: have });
    let got = 0;
    req.on('data', d => { got += d.length; });
    req.pipe(out);
    out.on('finish', () => resolve(got === len));
    out.on('error', () => resolve(false));
    req.on('aborted', () => resolve(false));
  });
  if (!ok) { let now2 = 0; try { now2 = fs.statSync(part).size; } catch (_) {} return send(409, { have: now2, error: 'the piece did not arrive whole' }); }
  if (offset + len < size) return send(200, { have: offset + len });

  const got = await sha256Of(part);
  if (got !== sha) { try { fs.unlinkSync(part); } catch (_) {} return send(422, { error: `SHA-256 does not match (${got.slice(0, 12)}…): the file was dropped; send it again` }); }
  fs.mkdirSync(box, { recursive: true });
  const name = cleanName(h('x-file-name'));
  let dest = path.join(box, name);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(box, name.replace(/(\.[^.]*)?$/, m => `-${i}${m}`));
  fs.renameSync(part, dest);
  const from = `${h('x-file-from') || 'unknown'}@${machine}`;
  const note = h('x-file-note');
  bridgeDb.getDb().prepare(`INSERT INTO file_transfers (dir, machine, target, from_session, from_agent, path, name, size, sha256, sent, note, state, remote_key, created, updated)
    VALUES ('in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', ?, ?, ?)`).run(machine, win, from, h('x-file-agent'), dest, path.basename(dest), size, sha, size, note, key, now(), now());
  deps.say({ from: h('x-file-agent') || 'Board', fromSession: from, to: router.agentOf(win) || 'all', toSession: win, room: '', topic: 'file',
    priority: 'normal', status: 'answer',
    message: `📦 A file from ${from}: ${path.basename(dest)} (${human(size)}), SHA-256 ${sha} checked. It is at ${dest}.` +
      (note ? ` Note: ${note}` : '') + ' It is somebody else\'s file: look before you open or run it.' });
  return send(200, { done: true, have: size, path: dest });
}

module.exports = { queue, list, pump, handle, ensureTable, cleanName, EXCHANGE_DIR, CHUNK };
