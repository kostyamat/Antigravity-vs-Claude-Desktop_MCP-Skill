'use strict';
// Two boards on two machines of one local network.
//
// The owner works on a laptop while a stronger machine stands idle and can build
// around the clock. Each machine has its own board, its own database and its own
// windows; this module lets the two boards talk, so a window on one machine can
// read a project's slice or a skill from the other, see the other's windows, and
// send a task or a question there and get the answer back.
//
// Nothing is merged. Each database stays the only store of its own board. A
// message that crosses is stored on both, and the pair of numbers it has there
// is kept in `peer_refs`, so a reply finds its parent on either side.
//
// It is off until a neighbour is written into bridge_config.json
// ({"peers": [{"name": "desktop", "url": "http://192.168.1.50:8787"}]} — the
// link_machine tool does it). Only then does the board listen beyond this
// machine, and even then a request from outside is served only when it comes
// from a neighbour's address and only on /api/peer/. The owner's decision for
// the local network (11.11.2026): no pairing codes, no keys.
//
// An address across machines is `<window or project>@<machine>`.

const dns = require('dns');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'bridge_config.json');
const RETRY_HOURS = 24;          // mail for a sleeping machine waits this long
const NOTICE_AFTER_MS = 5 * 60000;

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch (_) { return {}; }
}
function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function slug(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

// This machine's name on the other board.
function machineName(cfg) {
  return slug((cfg || readConfig()).machineName || os.hostname()) || 'machine';
}

function peers(cfg) {
  const out = [];
  for (const p of ((cfg || readConfig()).peers || [])) {
    const name = slug(p && p.name);
    let url;
    try { url = new URL(String(p.url || '')); } catch (_) { continue; }
    if (!name || !/^https?:$/.test(url.protocol)) continue;
    out.push({ name, url: url.origin, host: url.hostname });
  }
  return out;
}
function enabled(cfg) { return peers(cfg).length > 0; }
function peerByName(name, cfg) {
  const n = slug(name);
  return peers(cfg).find(p => p.name === n) || null;
}

// `<target>@<machine>` for a machine that is a neighbour; null for anything else,
// so a label that merely contains an @ stays what it was.
function parseAddress(toSession, cfg) {
  const m = /^(.+)@([A-Za-z0-9][A-Za-z0-9-]*)$/.exec(String(toSession || '').trim());
  if (!m) return null;
  const peer = peerByName(m[2], cfg);
  return peer ? { target: m[1].trim(), machine: peer.name, peer } : null;
}

// ── who is knocking ──────────────────────────────────────────────────────────────

function plain(addr) {
  return String(addr || '').replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '').toLowerCase();
}
function isLoopback(addr) {
  const a = plain(addr);
  return a === '127.0.0.1' || a === '::1' || a.startsWith('127.');
}

// A neighbour's host may be a name; it is resolved now and then, never per request.
const resolved = new Map();      // host -> { at, addrs: Set }
function addressesOf(host) {
  const h = plain(host);
  const hit = resolved.get(h);
  if (!hit || Date.now() - hit.at > 60000) {
    resolved.set(h, { at: Date.now(), addrs: (hit && hit.addrs) || new Set([h]) });
    dns.lookup(h, { all: true }, (err, list) => {
      if (!err && list && list.length) resolved.set(h, { at: Date.now(), addrs: new Set([h, ...list.map(x => plain(x.address))]) });
    });
  }
  return resolved.get(h).addrs;
}
function peerAt(addr, cfg) {
  const a = plain(addr);
  return peers(cfg).find(p => addressesOf(p.host).has(a)) || null;
}

// The one rule for a request that did not come from this machine: a neighbour,
// and only the neighbour's door. Everything else on the board is the owner's.
function admits(req, cfg) {
  const from = req.socket && req.socket.remoteAddress;
  if (isLoopback(from)) return true;
  return String(req.url || '').startsWith('/api/peer/') && !!peerAt(from, cfg);
}

// ── talking to a neighbour ───────────────────────────────────────────────────────

function request(peer, method, pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(peer.url + pathname, {
      method, timeout: timeoutMs || 8000,
      headers: Object.assign({ 'X-Board-Machine': machineName() },
        data ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length } : {})
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw || '{}'); } catch (_) {}
        resolve({ status: res.statusCode, json: json || {} });
      });
    });
    req.on('timeout', () => req.destroy(new Error('no answer in time')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// What a neighbour answered, or a sentence saying why it did not.
async function ask(machine, pathname) {
  const peer = peerByName(machine);
  if (!peer) {
    const known = peers().map(p => p.name).join(', ');
    throw new Error(`no machine "${machine}" is linked` + (known ? ` (linked: ${known})` : ' — link_machine adds one'));
  }
  let r;
  try { r = await request(peer, 'GET', pathname); }
  catch (e) { throw new Error(`machine "${peer.name}" (${peer.url}) did not answer: ${e.message}. Is it on, and is its board running?`); }
  if (r.status !== 200) throw new Error(`machine "${peer.name}": ${r.json.error || 'answered ' + r.status}`);
  return r.json;
}

// ── the database side ────────────────────────────────────────────────────────────

function ensureTable(bridgeDb) {
  bridgeDb.getDb().exec(`
    CREATE TABLE IF NOT EXISTS peer_refs (
      local_id INTEGER NOT NULL,
      machine TEXT NOT NULL,
      remote_id INTEGER DEFAULT 0,
      state TEXT DEFAULT '',
      at TEXT,
      PRIMARY KEY (local_id, machine)
    );
    CREATE INDEX IF NOT EXISTS peer_refs_remote ON peer_refs (machine, remote_id);
  `);
}
function ref(bridgeDb, localId, machine) {
  return bridgeDb.getDb().prepare('SELECT * FROM peer_refs WHERE local_id = ? AND machine = ?').get(localId, machine) || null;
}
function setRef(bridgeDb, localId, machine, remoteId, state) {
  bridgeDb.getDb().prepare(`
    INSERT INTO peer_refs (local_id, machine, remote_id, state, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(local_id, machine) DO UPDATE SET remote_id = excluded.remote_id, state = excluded.state
  `).run(localId, machine, remoteId || 0, state, new Date().toISOString());
}

// One room per neighbour machine: the owner reads the board a room at a time,
// and mail that crossed machines should not be scattered over the Square.
function roomFor(bridgeDb, machine, card, agent) {
  const name = `Machine: ${machine}`;
  let room = (bridgeDb.readRooms() || []).find(r => r.name === name && !r.archived);
  if (!room) room = bridgeDb.createRoom(name, [{ card, agent: agent || '' }], '');
  else if (card && !(room.members || []).some(m => m.card === card)) bridgeDb.addRoomMember(room.id, card, agent || '');
  return room.id;
}

// ── outgoing: the board delivers what was addressed to a neighbour ───────────────

function bodyOf(m) {
  try { if (m.file && /\.md$/i.test(m.file)) return fs.readFileSync(m.file, 'utf8'); } catch (_) {}
  return m.message || '';
}

let pumping = false;
async function pump(deps) {
  if (pumping || !enabled()) return;
  pumping = true;
  try {
    const { bridgeDb } = deps;
    ensureTable(bridgeDb);
    const since = new Date(Date.now() - RETRY_HOURS * 3600e3).toISOString();
    const rows = bridgeDb.getDb().prepare(`
      SELECT m.id FROM messages m
      WHERE m.to_session LIKE '%@%' AND m.ts > ?
        AND NOT EXISTS (SELECT 1 FROM peer_refs r WHERE r.local_id = m.id AND r.state IN ('sent', 'refused', 'received'))
      ORDER BY m.id
    `).all(since);
    for (const row of rows) {
      const m = bridgeDb.getMessageById(row.id);
      const addr = m && parseAddress(m.toSession);
      if (!addr) continue;
      const parent = m.replyTo ? ref(bridgeDb, m.replyTo, addr.machine) : null;
      const payload = {
        id: m.id, ts: m.ts, from: m.from, fromSession: m.fromSession || '', target: addr.target,
        topic: m.topic || '', priority: m.priority || 'normal', status: m.status || 'info',
        progress: m.progress || '', message: bodyOf(m), replyToRemote: parent ? parent.remote_id : 0
      };
      let r;
      try { r = await request(addr.peer, 'POST', '/api/peer/deliver', payload); }
      catch (e) { waiting(deps, m, addr, e.message); continue; }
      if (r.status === 200 && r.json.id) {
        setRef(bridgeDb, m.id, addr.machine, r.json.id, 'sent');
      } else {
        setRef(bridgeDb, m.id, addr.machine, 0, 'refused');
        notice(deps, m, `Machine "${addr.machine}" did not take #${m.id}: ${r.json.error || 'answered ' + r.status}. ` +
          'It was not delivered. Its windows and projects: list_cards({machine: "' + addr.machine + '"}).');
      }
    }
  } catch (_) { /* the board must outlive a neighbour's trouble */ } finally { pumping = false; }
}

// A neighbour that does not answer is usually asleep. The message waits; the
// sender is told once, so it does not sit expecting an answer that cannot come.
function waiting(deps, m, addr, why) {
  const { bridgeDb } = deps;
  const had = ref(bridgeDb, m.id, addr.machine);
  if (!had) return setRef(bridgeDb, m.id, addr.machine, 0, 'waiting');
  if (had.state !== 'waiting' || Date.now() - new Date(had.at).getTime() < NOTICE_AFTER_MS) return;
  setRef(bridgeDb, m.id, addr.machine, 0, 'told');
  notice(deps, m, `Machine "${addr.machine}" does not answer (${why}), so #${m.id} is not delivered yet. ` +
    `The board keeps trying for ${RETRY_HOURS} hours and delivers it when that machine is back.`);
}

function notice(deps, m, text) {
  const { bridgeDb } = deps;
  const human = /^human/i.test(String(m.fromSession || ''));
  const rec = bridgeDb.addMessage({
    ts: new Date().toISOString(), from: 'Board', fromSession: 'board/peer-link',
    to: human ? 'all' : m.from, toSession: human ? '' : (m.fromSession || ''), room: m.room || '',
    replyTo: m.id, topic: m.topic || 'machines', priority: 'normal', status: 'blocked', progress: '',
    message: text, file: null, readBy: []
  });
  try { bridgeDb.touchRoom(rec.room); } catch (_) {}
}

// ── incoming: the neighbour's door ───────────────────────────────────────────────

function knownProject(deps, asked) {
  const want = String(asked || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!want) return '';
  const folders = new Set();
  try { for (const c of deps.cardsLib.allCards({ sinceHours: 24 * 120 })) if (c.project) folders.add(String(c.project)); } catch (_) {}
  try { for (const l of deps.bridgeDb.readLines().keys()) folders.add(l); } catch (_) {}
  for (const f of folders) {
    const k = f.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (k === want || k.split('/').pop() === want) return f;
  }
  return '';
}

function deliver(deps, machine, p) {
  const { bridgeDb, router } = deps;
  ensureTable(bridgeDb);
  const remoteId = Number(p.id) || 0;
  if (!remoteId || !String(p.message || '').trim()) return { status: 400, json: { error: 'a message needs an id and a text' } };
  const dup = bridgeDb.getDb().prepare(
    "SELECT local_id FROM peer_refs WHERE machine = ? AND remote_id = ? AND state = 'received'").get(machine, remoteId);
  if (dup) return { status: 200, json: { id: dup.local_id, duplicate: true } };

  const target = String(p.target || '').trim();
  const human = /^(human|owner)/i.test(target);
  const win = human ? '' : router.windowOf(target);
  if (!human && !win) {
    return { status: 404, json: { error: `"${target}" is no window and no project on this machine` } };
  }
  const agent = human ? '' : router.agentOf(win);
  const parent = Number(p.replyToRemote) ? bridgeDb.getMessageById(Number(p.replyToRemote)) : null;
  const room = human ? ((parent && parent.room) || '') : ((parent && parent.room) || roomFor(bridgeDb, machine, win, agent));
  const rec = bridgeDb.addMessage({
    ts: new Date().toISOString(), from: String(p.from || '?'), fromSession: `${String(p.fromSession || 'unknown')}@${machine}`,
    to: human ? (readConfig().adminName || 'all') : (agent || 'all'), toSession: human ? 'human/web' : win, room,
    replyTo: parent ? parent.id : null, topic: String(p.topic || ''), priority: p.priority === 'P0' ? 'P0' : (p.priority === 'fyi' ? 'fyi' : 'normal'),
    status: String(p.status || 'info'), progress: String(p.progress || ''), message: String(p.message), file: null, readBy: []
  });
  setRef(bridgeDb, rec.id, machine, remoteId, 'received');
  try { bridgeDb.touchRoom(room); } catch (_) {}
  return { status: 200, json: { id: rec.id } };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', c => { raw += c; if (raw.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Serves /api/peer/*. The caller has already let the request in (admits).
async function handle(req, res, deps) {
  const send = (status, json) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(json));
  };
  try {
    const url = new URL(req.url, 'http://x');
    const from = req.socket.remoteAddress;
    const peer = peerAt(from) || (isLoopback(from) ? peerByName(req.headers['x-board-machine']) : null);
    const what = url.pathname.replace(/^\/api\/peer\//, '');
    if (what === 'hello' && req.method === 'GET') {
      return send(200, { machine: machineName(), version: readConfig().installedVersion || '', knowsYou: peer ? peer.name : '' });
    }
    if (!peer) return send(403, { error: 'this machine is not linked to yours — link_machine on both sides' });
    if (what === 'cards' && req.method === 'GET') {
      const hours = Number(url.searchParams.get('hours')) || 48;
      const list = deps.cardsLib.allCards({ sinceHours: hours, names: deps.names ? deps.names() : undefined })
        .map(c => ({ id: c.id, agent: c.agent, name: c.name || '', project: c.project || '', busy: !!c.busy }));
      return send(200, { machine: machineName(), cards: list });
    }
    if (what === 'slice' && req.method === 'GET') {
      const folder = knownProject(deps, url.searchParams.get('project'));
      if (!folder) return send(404, { error: `no project "${url.searchParams.get('project')}" is known on this machine` });
      const s = deps.projectSlice.find(deps.bridgeDb, folder);
      if (!s.text) return send(404, { error: `${folder} has no slice (.agents/HANDOFF.md)` });
      return send(200, { machine: machineName(), folder: s.folder, mtime: s.mtime, git: s.git, text: s.text });
    }
    if (what === 'skill' && req.method === 'GET') {
      const name = url.searchParams.get('name');
      if (!name) return send(200, { machine: machineName(), skills: deps.skillReader.listSkills() });
      try {
        return send(200, { machine: machineName(), name, text: deps.skillReader.readSkill(name, url.searchParams.get('file') || undefined) });
      } catch (e) { return send(404, { error: e.message }); }
    }
    if (what === 'deliver' && req.method === 'POST') {
      const out = deliver(deps, peer.name, await readBody(req, 4e6));
      return send(out.status, out.json);
    }
    send(404, { error: 'no such door' });
  } catch (e) {
    send(500, { error: e.message });
  }
}

// ── linking ──────────────────────────────────────────────────────────────────────

function link(name, url) {
  const n = slug(name);
  let u;
  try { u = new URL(/^https?:\/\//i.test(String(url)) ? String(url) : 'http://' + String(url)); } catch (_) { throw new Error(`"${url}" is not an address`); }
  if (!n) throw new Error('the machine needs a name (letters, digits, dashes)');
  if (!u.port) u.port = String(readConfig().uiPort || 8787);
  const cfg = readConfig();
  cfg.peers = (cfg.peers || []).filter(p => slug(p.name) !== n).concat([{ name: n, url: u.origin }]);
  writeConfig(cfg);
  return { name: n, url: u.origin };
}
function unlink(name) {
  const cfg = readConfig();
  const before = (cfg.peers || []).length;
  cfg.peers = (cfg.peers || []).filter(p => slug(p.name) !== slug(name));
  writeConfig(cfg);
  return before !== cfg.peers.length;
}

module.exports = {
  machineName, peers, enabled, peerByName, parseAddress, isLoopback, admits, peerAt,
  request, ask, pump, handle, deliver, roomFor, ensureTable, ref, link, unlink, knownProject
};
