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
// What travels with a message: the file the owner attached and its text copy,
// or the document the message announces. The paths a message names are the
// sender's; the receiver keeps its own copies and rewrites them.
const ATT_DIR = path.join(__dirname, 'docs', 'attachments');
const TEXT_DIR = path.join(__dirname, 'docs', 'converted');
const DOCS_DIR = path.join(__dirname, 'docs');
const MAX_BODY = 90e6;           // an attachment is at most 40 MB, base64 adds a third

// Read again only when the file changed: parseAddress asks for it once per address, the pump
// once per member of every room message, and reading it from disk each time (3.6 ms) kept the
// board's process half busy (18.11, 263 messages every five seconds).
let configCache = null;
function readConfig() {
  let mtime = -1;
  try { mtime = fs.statSync(CONFIG_FILE).mtimeMs; } catch (_) { configCache = null; return {}; }
  if (configCache && configCache.mtime === mtime) return configCache.cfg;
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch (_) { cfg = {}; }
  configCache = { mtime, cfg };
  return cfg;
}
function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  configCache = null;
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

// An address of a private network: the only kind a stranger may knock from.
function isPrivate(addr) {
  const a = plain(addr);
  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) return true;
  const m = /^172\.(\d+)\./.exec(a);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return /^(fe80|fc|fd)/.test(a);
}

// The one rule for a request that did not come from this machine. A linked
// neighbour: its door, /api/peer/. A machine of the same private network that is
// not linked: two things only — asking who this board is, and knocking to be
// linked (which gives it nothing until the owner allows it). Everything else on
// the board is the owner's, whoever asks.
function admits(req, cfg) {
  const from = req.socket && req.socket.remoteAddress;
  if (isLoopback(from)) return true;
  const url = String(req.url || '').split('?')[0];
  if (!url.startsWith('/api/peer/')) return false;
  if (peerAt(from, cfg)) return true;
  return isPrivate(from) && (url === '/api/peer/hello' || url === '/api/peer/knock');
}

// The board listens on the network from the start, so that another board can
// find it and nothing has to be restarted when a machine is linked. The door
// above is what keeps that safe; "listenOnNetwork": false in bridge_config.json
// closes it for a machine that will never be linked.
function listenHost(cfg) {
  return (cfg || readConfig()).listenOnNetwork === false ? '127.0.0.1' : '0.0.0.0';
}
function myPort(cfg) {
  return Number(process.env.AGENT_BRIDGE_PORT) || Number((cfg || readConfig()).uiPort) || 8787;
}

// ── talking to a neighbour ───────────────────────────────────────────────────────

function request(peer, method, pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(peer.url + pathname, {
      method, timeout: timeoutMs || (data && data.length > 1e6 ? 120000 : 8000),
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
    CREATE TABLE IF NOT EXISTS peer_rooms (
      room TEXT NOT NULL,
      machine TEXT NOT NULL,
      hash TEXT DEFAULT '',
      since TEXT,
      PRIMARY KEY (room, machine)
    );
  `);
}

// ── shared rooms ─────────────────────────────────────────────────────────────────
//
// A room with a window of another machine in it is that machine's room too. The owner
// invited a window of artempc into a room here, and on artempc there was no such room:
// the window was told "no single room matches", and everything said with it went through
// "Machine: …" instead (owner, 18.11: inviting the other machine's windows "is done the
// hard way now"). So the board that made the room sends it to every machine with a member
// in it: the same id and name, and its members as that machine names them (its own windows
// bare, the others as <id>@<machine>). What is said in the room travels both ways.
// The machine that made the room holds its membership; a copy asks it for a change.

// The machines with a window in this room.
function machinesOf(room, cfg) {
  const out = new Set();
  for (const m of (room && room.members) || []) { const a = parseAddress(m.card, cfg); if (a) out.add(a.machine); }
  return out;
}
// The room's members as `machine` names them.
function membersFor(room, machine, me) {
  return ((room && room.members) || []).map(m => {
    const a = parseAddress(m.card);
    if (a && a.machine === machine) return { card: a.target, agent: m.agent || '' };
    if (a || /@/.test(m.card)) return { card: m.card, agent: m.agent || '' };
    return { card: `${m.card}@${me}`, agent: m.agent || '' };
  }).sort((x, y) => x.card.localeCompare(y.card));
}

// A machine that cannot take a room (asleep, or a board too old for shared rooms) is asked
// again after a pause, not every five seconds.
const roomRetry = new Map();
const ROOM_RETRY_MS = 10 * 60000;
async function syncRooms(deps) {
  const { bridgeDb } = deps;
  const me = machineName();
  const db = bridgeDb.getDb();
  const rooms = (bridgeDb.readRooms() || []).filter(r => !bridgeDb.roomOrigin(r.id) && !/^Machine: /.test(r.name));
  const want = new Map();
  for (const r of rooms) for (const machine of machinesOf(r)) want.set(r.id + '\u0000' + machine, { r, machine });
  // A machine whose last window left the room is told once more, with no window of its own in it.
  for (const row of db.prepare('SELECT room, machine FROM peer_rooms').all()) {
    const k = row.room + '\u0000' + row.machine;
    const r = rooms.find(x => x.id === row.room);
    if (!want.has(k) && r && peerByName(row.machine)) want.set(k, { r, machine: row.machine, last: true });
  }
  for (const { r, machine, last } of want.values()) {
    const members = membersFor(r, machine, me);
    const hash = JSON.stringify([r.name, members]);
    const had = db.prepare('SELECT hash, since FROM peer_rooms WHERE room = ? AND machine = ?').get(r.id, machine);
    if (had && had.hash === hash) { if (last) db.prepare('DELETE FROM peer_rooms WHERE room = ? AND machine = ?').run(r.id, machine); continue; }
    const key = r.id + '\u0000' + machine;
    if (Date.now() < (roomRetry.get(key) || 0)) continue;
    let res;
    try { res = await request(peerByName(machine), 'POST', '/api/peer/room', { id: r.id, name: r.name, members }, 5000); }
    catch (_) { res = { status: 0 }; }
    if (res.status !== 200) { roomRetry.set(key, Date.now() + ROOM_RETRY_MS); continue; }
    roomRetry.delete(key);
    if (last) { db.prepare('DELETE FROM peer_rooms WHERE room = ? AND machine = ?').run(r.id, machine); continue; }
    db.prepare(`INSERT INTO peer_rooms (room, machine, hash, since) VALUES (?, ?, ?, ?)
      ON CONFLICT(room, machine) DO UPDATE SET hash = excluded.hash`).run(r.id, machine, hash, new Date().toISOString());
  }
}

// When the room was first shared with `machine`: what was said before stays where it was said.
function sharedSince(bridgeDb, room, machine) {
  if (bridgeDb.roomOrigin(room) === machine) return '';            // a copy: everything said here goes home
  const r = bridgeDb.getDb().prepare('SELECT since FROM peer_rooms WHERE room = ? AND machine = ?').get(room, machine);
  return r ? r.since : null;
}

// A copy's owner adds or sends out a window: asked of the machine that holds the room.
async function changeMember(bridgeDb, roomId, card, agent, action, by) {
  const origin = bridgeDb.roomOrigin(roomId);
  const peer = origin && peerByName(origin);
  if (!peer) throw new Error(`room "${roomId}" belongs to machine "${origin}", which is not linked`);
  const me = machineName();
  const a = parseAddress(card);
  const there = a && a.machine === origin ? a.target : a ? card : `${card}@${me}`;
  let r;
  try { r = await request(peer, 'POST', '/api/peer/room-member', { id: roomId, card: there, agent: agent || '', action, by: by || '' }, 8000); }
  catch (e) { throw new Error(`machine "${origin}" holds this room and did not answer: ${e.message}`); }
  if (r.status !== 200) throw new Error(`machine "${origin}": ${r.json.error || 'answered ' + r.status}`);
  return r.json;
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
  if (!room) {
    // createRoom hands back an existing room that has exactly these members, so a
    // room made for one window alone was whatever room that window already sat in
    // by itself: the first letter to a neighbour landed in the owner's own room.
    // A marker member makes the set unique; it is taken out once the room exists.
    const marker = `machine:${machine}`;
    room = bridgeDb.createRoom(name, [{ card, agent: agent || '' }, { card: marker, agent: '' }], '');
    try { bridgeDb.getDb().prepare('DELETE FROM room_members WHERE room = ? AND card = ?').run(room.id, marker); } catch (_) {}
  } else if (card && !(room.members || []).some(m => m.card === card)) {
    try { bridgeDb.addRoomMember(room.id, card, agent || ''); } catch (_) { /* sent out by the owner */ }
  }
  return room.id;
}

// ── outgoing: the board delivers what was addressed to a neighbour ───────────────

function bodyOf(m) {
  try { if (m.file && /\.md$/i.test(m.file)) return fs.readFileSync(m.file, 'utf8'); } catch (_) {}
  return m.message || '';
}

// The attachment a message carries (messages.file holds its stored name), with
// the text copy made for agents when there is one.
function attachmentOf(m) {
  const name = path.basename(String(m.file || ''));
  if (!/^att_[\w.-]+$/.test(name)) return null;
  const file = path.join(ATT_DIR, name);
  if (!fs.existsSync(file)) return null;
  const out = { name, path: file, data: fs.readFileSync(file).toString('base64') };
  const text = path.join(TEXT_DIR, name.replace(/\.[^.]+$/, '') + '.md');
  if (fs.existsSync(text)) { out.textPath = text; out.text = fs.readFileSync(text, 'utf8'); }
  return out;
}

// The document a message announces: put_doc posts `read_doc({…name:"<file>"})`.
function documentOf(bridgeDb, m) {
  const hit = /read_doc\(\{[^}]*name:"([^"]+\.md)"/.exec(String(m.message || ''));
  if (!hit) return null;
  const d = (bridgeDb.readDocsIndex() || []).find(x => x.name === hit[1] && !x.archived);
  if (!d || !d.file || !fs.existsSync(d.file)) return null;
  return { name: d.name, title: d.title || '', topic: d.topic || '', priority: d.priority || 'normal',
           created: d.created || '', path: d.file, text: fs.readFileSync(d.file, 'utf8') };
}

let pumping = false;
async function pump(deps) {
  if (pumping || !enabled()) return;
  pumping = true;
  try {
    const { bridgeDb } = deps;
    ensureTable(bridgeDb);
    await syncRooms(deps);
    const me = machineName();
    const since = new Date(Date.now() - RETRY_HOURS * 3600e3).toISOString();
    // Addressed to a window over there, or said in a room shared with a machine — by this
    // machine (what came from a neighbour is not sent back), and not the board's own notes.
    // Only what is still to go: said after the room was shared, and not yet handed over
    // everywhere (a machine still waiting keeps the message in the list).
    const rows = bridgeDb.getDb().prepare(`
      SELECT m.id FROM messages m
      WHERE m.ts > ? AND (m.to_session LIKE '%@%'
        OR (m.room <> '' AND m.from_session NOT LIKE '%@%' AND m.from_session NOT LIKE 'board/%' AND m.from_session NOT LIKE 'supervisor/%'
            AND (EXISTS (SELECT 1 FROM peer_rooms pr WHERE pr.room = m.room AND m.ts > pr.since)
                 OR m.room IN (SELECT room FROM room_origin))))
        AND NOT (EXISTS (SELECT 1 FROM peer_refs r WHERE r.local_id = m.id AND r.state IN ('sent', 'refused', 'received'))
                 AND NOT EXISTS (SELECT 1 FROM peer_refs r WHERE r.local_id = m.id AND r.state NOT IN ('sent', 'refused', 'received')))
      ORDER BY m.id
    `).all(since);
    for (const row of rows) {
      const m = bridgeDb.getMessageById(row.id);
      if (!m) continue;
      const addr = parseAddress(m.toSession);
      const dests = new Map();
      if (addr) dests.set(addr.machine, addr.peer);
      if (m.room && !/@/.test(m.fromSession || '')) {
        const room = bridgeDb.getRoom(m.room);
        for (const machine of machinesOf(room)) {
          const from = sharedSince(bridgeDb, m.room, machine);
          if (from !== null && String(m.ts) > from) dests.set(machine, peerByName(machine));
        }
      }
      for (const [machine, peer] of dests) {
        if (!peer) continue;
        const had = ref(bridgeDb, m.id, machine);
        if (had && ['sent', 'refused', 'received'].includes(had.state)) continue;
        const parent = m.replyTo ? ref(bridgeDb, m.replyTo, machine) : null;
        const mine = addr && addr.machine === machine;
        const to = String(m.toSession || '');
        const payload = {
          id: m.id, ts: m.ts, from: m.from, fromSession: m.fromSession || '', target: mine ? addr.target : '',
          // Said to the room, or to someone not on that machine: it lands in the room there.
          room: m.room && sharedSince(bridgeDb, m.room, machine) !== null ? m.room : '',
          toSession: mine ? '' : /^human/i.test(to) ? 'human/web' : !to ? '' : parseAddress(to) ? to : `${to}@${me}`,
          topic: m.topic || '', priority: m.priority || 'normal', status: m.status || 'info',
          progress: m.progress || '', message: bodyOf(m), replyToRemote: parent ? parent.remote_id : 0
        };
        if (!payload.target && !payload.room) continue;
        const att = attachmentOf(m);
        if (att) payload.attachment = att;
        const doc = documentOf(bridgeDb, m);
        if (doc) payload.document = doc;
        const where = { machine, peer, target: payload.target || payload.room };
        let r;
        try { r = await request(peer, 'POST', '/api/peer/deliver', payload); }
        catch (e) { waiting(deps, m, where, e.message); continue; }
        if (r.status === 200 && r.json.id) {
          setRef(bridgeDb, m.id, machine, r.json.id, 'sent');
        } else {
          setRef(bridgeDb, m.id, machine, 0, 'refused');
          notice(deps, m, `Machine "${machine}" did not take #${m.id}: ${r.json.error || 'answered ' + r.status}. ` +
            'It was not delivered. Its windows and projects: list_cards({machine: "' + machine + '"}).');
        }
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
    // To the sender only. Sent to the owner as 'all' with no window, it landed as an urgent
    // unread in every window on this machine (16.11, #4602).
    to: human ? 'all' : m.from, toSession: human ? 'human/web' : (m.fromSession || ''), room: m.room || '',
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
  // A room both machines hold: said there, it is put there.
  const sharedRoom = p.room ? bridgeDb.getRoom(String(p.room)) : null;
  const shared = sharedRoom && ((sharedRoom.members || []).some(x => (parseAddress(x.card) || {}).machine === machine) ||
                                bridgeDb.roomOrigin(sharedRoom.id) === machine) ? sharedRoom : null;
  if (!target && !shared) return { status: 404, json: { error: `room "${p.room || ''}" is not shared with ${machine} here` } };
  const toRoom = !target;
  const human = /^(human|owner)/i.test(target) || (toRoom && /^human/i.test(String(p.toSession || '')));
  const named = toRoom ? String(p.toSession || '').replace(new RegExp('@' + machineName() + '$'), '') : target;
  const win = human || !named ? '' : (router.windowOf(named) || (toRoom ? named : ''));
  if (!toRoom && !human && !win) {
    return { status: 404, json: { error: `"${target}" is no window and no project on this machine` } };
  }
  const agent = human || !win ? '' : (router.agentOf(win) || '');
  const parent = Number(p.replyToRemote) ? bridgeDb.getMessageById(Number(p.replyToRemote)) : null;
  const room = shared ? shared.id
    : human ? ((parent && parent.room) || '') : ((parent && parent.room) || roomFor(bridgeDb, machine, win, agent));
  const sender = `${String(p.fromSession || 'unknown')}@${machine}`;
  // The window that wrote becomes a member of the machine's room, so the owner
  // can pick it there as an addressee of his own. A shared room's members are its maker's to set.
  if (room && !shared && !/^human/i.test(sender)) {
    try {
      const r = bridgeDb.getRoom(room);
      if (r && !(r.members || []).some(x => x.card === sender)) bridgeDb.addRoomMember(room, sender, String(p.from || ''));
    } catch (_) {}
  }

  // What came with it is kept here, under the same names, and the text is
  // pointed at this machine's copies.
  let text = String(p.message);
  let file = null;
  const att = p.attachment;
  if (att && /^att_[\w.-]+$/.test(String(att.name || '')) && att.name === path.basename(att.name)) {
    fs.mkdirSync(ATT_DIR, { recursive: true });
    const saved = path.join(ATT_DIR, att.name);
    fs.writeFileSync(saved, Buffer.from(String(att.data || ''), 'base64'));
    file = att.name;
    if (att.path) text = text.split(String(att.path)).join(saved);
    if (typeof att.text === 'string') {
      fs.mkdirSync(TEXT_DIR, { recursive: true });
      const md = path.join(TEXT_DIR, att.name.replace(/\.[^.]+$/, '') + '.md');
      fs.writeFileSync(md, att.text, 'utf8');
      if (att.textPath) text = text.split(String(att.textPath)).join(md);
    }
  }
  const doc = p.document;
  if (doc && /^[^\\/:*?"<>|]+\.md$/.test(String(doc.name || '')) && typeof doc.text === 'string') {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
    const saved = path.join(DOCS_DIR, doc.name);
    fs.writeFileSync(saved, doc.text, 'utf8');
    if (doc.path) text = text.split(String(doc.path)).join(saved);
    bridgeDb.saveDocIndex({
      name: doc.name, title: String(doc.title || doc.name), from: String(p.from || '?'), fromSession: sender,
      to: human ? (readConfig().adminName || 'all') : (agent || 'all'), toSession: human ? 'human/web' : win,
      topic: String(doc.topic || ''), priority: String(doc.priority || 'normal'), file: saved,
      created: String(doc.created || new Date().toISOString()), readBy: [], ackedBy: [], room: room || ''
    });
  }
  const rec = bridgeDb.addMessage({
    ts: new Date().toISOString(), from: String(p.from || '?'), fromSession: sender,
    to: human ? (readConfig().adminName || 'all') : (agent || 'all'), toSession: human ? 'human/web' : (win || ''), room,
    replyTo: parent ? parent.id : null, topic: String(p.topic || ''), priority: p.priority === 'P0' ? 'P0' : (p.priority === 'fyi' ? 'fyi' : 'normal'),
    status: String(p.status || 'info'), progress: String(p.progress || ''), message: text, file, readBy: []
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
    if (what === 'knock' && req.method === 'POST') {
      return send(200, knocked(from, await readBody(req, 4000), req.headers['x-board-machine']));
    }
    if (!peer) return send(403, { error: 'this machine is not linked to yours — link the two boards first (Machines on the board page)' });
    if (what === 'cards' && req.method === 'GET') {
      const hours = Number(url.searchParams.get('hours')) || 48;
      // An Antigravity conversation is never archived, so a month of them is a heap of
      // old chats: those go only while they are fresh (two days, as on the page).
      const geminiCutoff = Date.now() - Math.min(hours, 48) * 3600 * 1000;
      const list = deps.cardsLib.allCards({ sinceHours: hours, allAccounts: true, names: deps.names ? deps.names() : undefined })
        .filter(c => c.agent !== 'Gemini' || !c.activeAt || Date.parse(c.activeAt) >= geminiCutoff)
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
    if (what === 'room' && req.method === 'POST') {
      const b = await readBody(req, 200000);
      try { return send(200, { room: deps.bridgeDb.mirrorRoom(b.id, b.name, b.members, peer.name).id }); }
      catch (e) { return send(409, { error: e.message }); }
    }
    if (what === 'room-member' && req.method === 'POST') {
      const b = await readBody(req, 20000);
      if (!deps.roomMember) return send(501, { error: 'this board does not change rooms for a neighbour' });
      if (deps.bridgeDb.roomOrigin(String(b.id || ''))) return send(409, { error: 'this room is a copy here too' });
      try { return send(200, await deps.roomMember(b.action === 'remove' ? 'remove' : 'add', String(b.id || ''), String(b.card || ''), String(b.agent || ''), `${b.by || 'owner'}@${peer.name}`)); }
      catch (e) { return send(400, { error: e.message }); }
    }
    if (what === 'deliver' && req.method === 'POST') {
      const out = deliver(deps, peer.name, await readBody(req, MAX_BODY));
      return send(out.status, out.json);
    }
    send(404, { error: 'no such door' });
  } catch (e) {
    send(500, { error: e.message });
  }
}

// ── the neighbour's windows on the board page ───────────────────────────────────

// The page asks for its list of windows every few seconds and must not wait on
// another machine, so the neighbours are asked in the background and the page
// is given what was last heard. A machine that stops answering drops out.
let heard = [];
// The neighbour's open windows of every Claude account it holds, not only the
// last two days: the owner reads that list as "what is open there", and a window
// left for a week is still open. Archived windows are never sent.
const NEIGHBOUR_HOURS = 24 * 30;
async function refreshCards() {
  const out = [];
  for (const p of peers()) {
    try {
      const r = await request(p, 'GET', '/api/peer/cards?hours=' + NEIGHBOUR_HOURS, undefined, 4000);
      for (const c of (r.status === 200 && r.json.cards) || []) {
        out.push({ agent: c.agent, id: `${c.id}@${p.name}`, name: `${c.name || '(unnamed)'} @ ${p.name}`, project: c.project || '',
                   projectName: String(c.project || '').split(/[\\/]/).filter(Boolean).pop() || '', machine: p.name,
                   busy: !!c.busy, archived: false, account: null, activeAt: new Date().toISOString() });
      }
    } catch (_) {}
  }
  heard = out;
}
function neighbourCards() { return heard; }

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

// ── finding, knocking, allowing ──────────────────────────────────────────────────

// Another board asks to be linked. A machine already linked is told so. With
// "trust my network" on, a machine of the private network is linked at once;
// otherwise the request waits for the owner's click on this board.
function knocked(from, body, header) {
  const cfg = readConfig();
  const addr = plain(from);
  const port = Number(body && body.port) || 8787;
  const url = `http://${addr.includes(':') ? '[' + addr + ']' : addr}:${port}`;
  const name = freeName(slug((body && body.machine) || header) || 'machine', url, cfg);
  if (peers(cfg).some(p => p.url === url)) return { state: 'linked', machine: machineName(cfg) };
  if (cfg.trustNetwork === true && (isPrivate(addr) || isLoopback(addr))) {
    cfg.peers = (cfg.peers || []).concat([{ name, url }]);
    cfg.peerRequests = (cfg.peerRequests || []).filter(r => r.url !== url);
    writeConfig(cfg);
    return { state: 'linked', machine: machineName(cfg) };
  }
  cfg.peerRequests = (cfg.peerRequests || []).filter(r => r.url !== url)
    .concat([{ name, url, address: addr, at: new Date().toISOString() }]).slice(-20);
  writeConfig(cfg);
  return { state: 'pending', machine: machineName(cfg) };
}

// Two machines may call themselves the same; the second gets a number.
function freeName(name, url, cfg) {
  const taken = new Map(peers(cfg).map(p => [p.name, p.url]));
  if (!taken.has(name) || taken.get(name) === url) return name;
  for (let i = 2; i < 50; i++) if (!taken.has(`${name}-${i}`)) return `${name}-${i}`;
  return name + '-' + Date.now();
}

// Link this board to the board at `address` and tell it so. → { name, url, state }
// state: 'linked' (it has us too) or 'pending' (its owner has to allow it there).
async function linkTo(address, port) {
  const host = String(address || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!host) throw new Error('an address is needed');
  const url = /:\d+$/.test(host) ? `http://${host}` : `http://${host}:${Number(port) || 8787}`;
  let hello;
  try { hello = await request({ url }, 'GET', '/api/peer/hello', undefined, 4000); }
  catch (e) { throw new Error(`no board answers at ${url} (${e.message})`); }
  if (hello.status !== 200 || !hello.json.machine) throw new Error(`${url} did not answer as a board`);
  const p = link(freeName(slug(hello.json.machine), new URL(url).origin, readConfig()), url);
  let state = 'pending';
  try {
    const k = await request(p, 'POST', '/api/peer/knock', { machine: machineName(), port: myPort() }, 5000);
    if (k.status === 200 && k.json.state) state = k.json.state;
  } catch (_) {}
  // A board from before knocking existed (2.8.0-2.8.3) does not answer the knock; if
  // it was linked to this machine by hand it still says so when asked who it is.
  if (state !== 'linked') {
    try { if ((await request(p, 'GET', '/api/peer/hello', undefined, 4000)).json.knowsYou) state = 'linked'; } catch (_) {}
  }
  return { name: p.name, url: p.url, state, version: hello.json.version || '' };
}

function allow(url) {
  const cfg = readConfig();
  const r = (cfg.peerRequests || []).find(x => x.url === url);
  if (!r) throw new Error('no such request');
  cfg.peerRequests = cfg.peerRequests.filter(x => x.url !== url);
  cfg.peers = (cfg.peers || []).filter(p => p.url !== url).concat([{ name: freeName(r.name, url, cfg), url }]);
  writeConfig(cfg);
  return { name: r.name, url };
}
function refuse(url) {
  const cfg = readConfig();
  cfg.peerRequests = (cfg.peerRequests || []).filter(x => x.url !== url);
  writeConfig(cfg);
}
function setTrust(on) {
  const cfg = readConfig();
  cfg.trustNetwork = Boolean(on);
  writeConfig(cfg);
  return cfg.trustNetwork;
}

// This machine's addresses on private networks.
function myAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal && isPrivate(i.address)) out.push(i.address);
  }
  return out;
}

// Boards on this machine's private networks: every address of each /24 this
// machine is in is asked who it is. → [{ address, url, machine, version, linked }]
async function find(opts) {
  const o = opts || {};
  const port = Number(o.port) || myPort();
  const mine = new Set(myAddresses());
  const targets = [];
  for (const a of mine) {
    const base = a.split('.').slice(0, 3).join('.');
    for (let n = 1; n < 255; n++) {
      const ip = `${base}.${n}`;
      if (!mine.has(ip) || o.includeSelf) targets.push(ip);
    }
  }
  const found = [];
  const linked = new Set(peers().map(p => p.url));
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const ip = targets[next++];
      const url = `http://${ip}:${port}`;
      try {
        const r = await request({ url }, 'GET', '/api/peer/hello', undefined, o.timeoutMs || 600);
        if (r.status === 200 && r.json.machine) found.push({ address: ip, url, machine: r.json.machine, version: r.json.version || '', linked: linked.has(url) });
      } catch (_) {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(96, targets.length) }, worker));
  return found.sort((x, y) => x.address.localeCompare(y.address, undefined, { numeric: true }));
}

// What the board page shows under "Machines".
async function overview() {
  const cfg = readConfig();
  const linked = await Promise.all(peers(cfg).map(async p => {
    try {
      const r = await request(p, 'GET', '/api/peer/hello', undefined, 2500);
      return { name: p.name, url: p.url, answers: r.status === 200, version: r.json.version || '', knowsUs: Boolean(r.json.knowsYou) };
    } catch (_) { return { name: p.name, url: p.url, answers: false, version: '', knowsUs: false }; }
  }));
  return { me: machineName(cfg), addresses: myAddresses(), port: myPort(cfg), open: listenHost(cfg) !== '127.0.0.1',
           trust: cfg.trustNetwork === true, linked, requests: cfg.peerRequests || [] };
}

// The board page's own calls (/api/machines…). They come from this machine only.
async function localApi(req, res) {
  const send = (status, json) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(json));
  };
  try {
    const what = new URL(req.url, 'http://x').pathname.replace(/^\/api\/machines\/?/, '');
    if (req.method === 'GET' && !what) return send(200, await overview());
    if (req.method !== 'POST') return send(404, { error: 'no such call' });
    const d = await readBody(req, 4000);
    if (what === 'find') return send(200, { found: await find() });
    if (what === 'link') return send(200, await linkTo(d.address || d.url, d.port));
    if (what === 'allow') return send(200, allow(String(d.url || '')));
    if (what === 'refuse') { refuse(String(d.url || '')); return send(200, { ok: true }); }
    if (what === 'unlink') return send(200, { ok: unlink(String(d.name || '')) });
    if (what === 'trust') return send(200, { trust: setTrust(d.on === true) });
    send(404, { error: 'no such call' });
  } catch (e) { send(400, { error: e.message }); }
}

module.exports = {
  isPrivate, listenHost, myPort, knocked, linkTo, allow, refuse, setTrust, find, overview, localApi, myAddresses,
  machineName, peers, enabled, peerByName, parseAddress, isLoopback, admits, peerAt,
  request, ask, pump, handle, deliver, roomFor, ensureTable, ref, link, unlink, knownProject,
  refreshCards, neighbourCards, syncRooms, changeMember, machinesOf, membersFor
};
