'use strict';
// The board page. One conversation on screen at a time: a room, or the square
// for whatever is not in a room. The server is the only source of state; this
// file keeps a copy of it and redraws.

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
}).then(r => r.json());
const store = {
  get(k, d) { try { const v = localStorage.getItem('bridge:' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('bridge:' + k, JSON.stringify(v)); } catch (_) {} }
};

const SQUARE = '';
const ME = $('#from').value;

let DATA = [];          // every message, oldest first
let ROOMS = [];
let CARDS = [];
let SESSIONS = [];
let DOCS = [];
let ROOM = null;        // null until the first choice; SQUARE ('') is a real place
let DOC_ROOM = null;    // the documents panel filtered to one room
let REPLY = null, EDIT = null, FILE = null;
let SEEN = store.get('seen', null);   // room id -> last message id the human has seen
const OPEN = new Set();

// ── words ───────────────────────────────────────────────────────────────────

function kind(agent) { return agent === 'Claude' ? 'Claude' : agent === 'Gemini' ? 'Gemini' : 'human'; }
function clientName(agent) { return agent === 'Gemini' ? 'Antigravity' : agent === 'Claude' ? 'Claude' : agent; }
function isHuman(m) { return kind(m.from) === 'human' || String(m.fromSession || '').toLowerCase().startsWith('human'); }

function ago(ts) {
  const t = new Date(ts).getTime();
  if (!t) return '';
  const d = (Date.now() - t) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + ' min ago';
  if (d < 86400) return Math.floor(d / 3600) + ' h ago';
  if (d < 86400 * 7) return Math.floor(d / 86400) + ' d ago';
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
function clock(ts) { return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
function fullDate(ts) { return new Date(ts).toLocaleString(); }
function dayOf(ts) {
  const d = new Date(ts), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

// The name of a window. The id is what messages route on; nobody should have
// to read one, so it only ever appears as a last resort.
function windowName(id, agent) {
  const s = String(id || '').trim();
  if (!s || s === 'all') return '';
  if (/^human/i.test(s)) return ME || 'You';
  const c = CARDS.find(x => x.id === s);
  if (c && c.name) return c.name;
  const r = SESSIONS.find(x => x.sessionId === s || x.canonicalId === s ||
                               (x.aliases || []).some(a => a.sessionId === s));
  if (r && (r.customName || r.title)) return r.customName || r.title;
  if (/^local_|^[0-9a-f]{8}-/i.test(s)) return (clientName(agent) || 'Window') + ' window ' + s.replace(/^local_/, '').slice(0, 4);
  return s;
}
function senderName(m) {
  if (isHuman(m)) return m.from;
  return windowName(m.fromSession, m.from) || clientName(m.from);
}
function addresseeName(m) {
  if (m.toSession && m.toSession !== 'all') return windowName(m.toSession, m.to);
  if (m.to === 'Claude') return 'any Claude window';
  if (m.to === 'Gemini') return 'any Antigravity window';
  return 'everyone';
}
function short(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }

// Agents write Markdown. Two marks carry most of the meaning — code and bold —
// and the rest reads fine as plain text.
function richText(s) {
  return esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
}

// ── what is on screen ───────────────────────────────────────────────────────

function roomById(id) { return ROOMS.find(r => r.id === id) || null; }
function messagesHere() { return DATA.filter(m => String(m.room || '') === ROOM); }
function lastIdIn(room) {
  if (room === SQUARE) { let n = 0; for (const m of DATA) if (!m.room && m.id > n) n = m.id; return n; }
  const r = roomById(room); return r ? (r.lastMessage || 0) : 0;
}
function markSeen() {
  if (ROOM == null || !SEEN) return;
  SEEN[ROOM] = lastIdIn(ROOM);
  store.set('seen', SEEN);
}
function isUnread(room) { return Boolean(SEEN) && lastIdIn(room) > (SEEN[room] || 0); }

// ── rooms ───────────────────────────────────────────────────────────────────

function renderRooms() {
  const row = (id, name, meta, title) => {
    const on = ROOM === id, unread = !on && isUnread(id);
    return '<div class="row' + (on ? ' on' : '') + (unread ? ' unread' : '') + '" data-room="' + esc(id) + '" title="' + esc(title || name) + '">' +
      '<div class="row-main"><div class="row-name">' + esc(name) + '</div>' +
      '<div class="row-meta">' + esc(meta) + '</div></div>' +
      (unread ? '<i class="dot-new" aria-label="new messages"></i>' : '') + '</div>';
  };
  const loose = DATA.filter(m => !m.room);
  const lastLoose = loose.length ? loose[loose.length - 1].ts : '';
  let html = row(SQUARE, 'Square', 'Messages outside any room' + (lastLoose ? ' · ' + ago(lastLoose) : ''),
                 'Everything that was never put in a room');
  html += '<div class="divider"></div>';
  html += ROOMS.map(r => row(r.id, r.name,
    r.messages + (r.messages === 1 ? ' message' : ' messages') + (r.lastTs ? ' · ' + ago(r.lastTs) : ''),
    r.name + '\n' + r.members.map(m => windowName(m.card, m.agent)).join('\n'))).join('');
  if (!ROOMS.length) html += '<div class="hint" style="padding:8px">No rooms yet. Tick two windows under Windows to make one.</div>';
  $('#roomList').innerHTML = html;
}

$('#roomList').addEventListener('click', e => {
  const r = e.target.closest('[data-room]');
  if (r) enterRoom(r.dataset.room);
});

async function loadRooms() {
  try { ROOMS = (await (await fetch('/api/rooms')).json()).rooms || []; } catch (_) { return; }
  renderRooms();
  if (ROOM != null) renderHead();
}

function enterRoom(id) {
  if (ROOM === id) return;
  ROOM = id;
  store.set('room', id);
  REPLY = null; EDIT = null;
  renderRooms();
  renderHead();
  renderFeed(true);
  fillTo();
  renderChips();
  markSeen();
  if (!$('#panel-windows').hidden) renderWindows();
  if (!$('#panel-docs').hidden && DOC_ROOM != null) { DOC_ROOM = ROOM === SQUARE ? null : ROOM; renderDocs(); }
}

function renderHead() {
  const r = roomById(ROOM);
  $('#roomActions').hidden = !r;
  if (!r) {
    $('#roomName').textContent = 'Square';
    $('#roomSub').innerHTML = '<span>Messages that are not in any room. Start a room to keep a conversation apart.</span>';
    return;
  }
  $('#roomName').textContent = r.name;
  $('#roomName').title = r.name;
  const docs = DOCS.filter(d => d.room === r.id).length;
  // A button that leads to an empty list is noise; it appears with the first document.
  $('#roomDocs').hidden = !docs;
  $('#roomDocs').textContent = 'Documents (' + docs + ')';
  $('#roomSub').innerHTML = r.members.map(m => {
    const n = windowName(m.card, m.agent);
    return '<span class="member" title="' + esc(n + ' · ' + clientName(m.agent)) + '"><i class="c-' + kind(m.agent) + '"></i><span>' + esc(n) + '</span></span>';
  }).join('') + '<button type="button" class="link-btn" id="addWindow">+ Add a window</button>';
  $('#addWindow').onclick = () => showPanel('windows');
}

$('#roomRename').onclick = async () => {
  const r = roomById(ROOM); if (!r) return;
  const name = prompt('Room name', r.name);
  if (name == null || !name.trim() || name.trim() === r.name) return;
  await post('/api/room/rename', { id: r.id, name: name.trim() });
  loadRooms();
};
$('#roomDelete').onclick = async () => {
  const r = roomById(ROOM); if (!r) return;
  if (!confirm('Delete the room "' + r.name + '"?\n\nIts ' + r.messages + ' messages are kept and move to the Square.')) return;
  await post('/api/room/delete', { id: r.id });
  await loadRooms();
  ROOM = null; enterRoom(SQUARE);
  await load(true);
};
$('#roomDocs').onclick = () => { DOC_ROOM = ROOM; showPanel('docs'); };
// The id is what an agent reads a room by. Pasted into another conversation it
// says "discuss it there".
$('#roomCopy').onclick = () => {
  const b = $('#roomCopy');
  navigator.clipboard.writeText('room: ' + ROOM)
    .then(() => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy id'; }, 1200); })
    .catch(() => { b.textContent = ROOM; });
};
$('#newRoom').onclick = () => {
  showPanel('windows');
  $('#winFilter').focus();
};

// ── windows ─────────────────────────────────────────────────────────────────

async function loadCards() {
  const all = $('#winOtherAccount').checked;
  try { CARDS = (await (await fetch('/api/cards?hours=720' + (all ? '&all=1' : ''))).json()).cards || []; } catch (_) {}
}

function renderWindows() {
  const q = $('#winFilter').value.trim().toLowerCase();
  const picked = new Set(pickedWindows());
  const inRoom = new Set((roomById(ROOM) || { members: [] }).members.map(m => m.card));
  const project = c => (c.project || '').split(/[\\/]/).filter(Boolean).pop() || '';
  const match = c => !q || (c.name + ' ' + project(c)).toLowerCase().includes(q);
  const row = c => '<label class="row' + (inRoom.has(c.id) ? ' here' : '') + '" title="' + esc(c.name || '') + '">' +
    '<input type="checkbox" value="' + esc(c.id) + '"' + (picked.has(c.id) ? ' checked' : '') + '>' +
    '<div class="row-main"><div class="row-name">' + esc(c.name || 'Untitled window') + '</div>' +
    '<div class="row-meta">' + esc([project(c), c.elsewhere ? 'other account' : '', c.busy ? 'working now' : '',
      c.activeAt ? ago(c.activeAt) : ''].filter(Boolean).join(' · ')) + '</div></div></label>';
  const group = (title, list) => list.length ? '<div class="group">' + title + '</div>' + list.map(row).join('') : '';
  const shown = CARDS.filter(match);
  $('#winList').innerHTML =
    group('Claude', shown.filter(c => c.agent === 'Claude')) +
    group('Antigravity', shown.filter(c => c.agent !== 'Claude')) ||
    '<div class="hint" style="padding:8px">' + (q ? 'No window matches.' : 'No windows found.') + '</div>';
  updateTray();
}

function pickedWindows() { return [...document.querySelectorAll('#winList input:checked')].map(i => i.value); }

function updateTray() {
  const n = pickedWindows().length;
  $('#winTray').hidden = !n;
  $('#winPicked').textContent = n + (n === 1 ? ' window selected' : ' windows selected');
  $('#winAddHere').hidden = !roomById(ROOM);
}

$('#winList').addEventListener('change', updateTray);
$('#winFilter').addEventListener('input', renderWindows);
$('#winOtherAccount').onchange = async () => { await loadCards(); renderWindows(); };

$('#winNewRoom').onclick = async () => {
  const cards = pickedWindows(); if (!cards.length) return;
  const suggested = cards.map(c => short(windowName(c), 28)).join(' + ');
  const name = prompt('Name the room', suggested);
  if (name == null) return;
  const j = await post('/api/room/create', { name: name.trim() || suggested, cards });
  if (j.error) { alert(j.error); return; }
  await loadRooms();
  showPanel('rooms');
  enterRoom(j.id);
};
$('#winAddHere').onclick = async () => {
  const r = roomById(ROOM); if (!r) return;
  for (const card of pickedWindows()) await post('/api/room/add', { id: r.id, card });
  await loadRooms();
  renderWindows();
};

// ── documents ───────────────────────────────────────────────────────────────

async function loadDocs() {
  try { DOCS = (await (await fetch('/api/docs')).json()).docs || []; } catch (_) { return; }
  if (!$('#panel-docs').hidden) renderDocs();
  if (roomById(ROOM)) renderHead();
}

function renderDocs() {
  const r = DOC_ROOM != null ? roomById(DOC_ROOM) : null;
  $('#docScope').hidden = !r;
  if (r) { $('#docScopeText').textContent = 'In ' + r.name; $('#docScopeText').title = r.name; }
  const list = r ? DOCS.filter(d => d.room === r.id) : DOCS;
  $('#docList').innerHTML = list.map(d => {
    const room = d.room ? roomById(d.room) : null;
    const where = r ? '' : (room ? room.name : 'Square');
    return '<div class="row" data-doc="' + esc(d.name) + '" title="' + esc(d.title) + '">' +
      '<div class="row-main"><div class="row-name">' + esc(d.title || d.name) + '</div>' +
      '<div class="row-meta">' + esc([where, ago(d.created)].filter(Boolean).join(' · ')) + '</div></div></div>';
  }).join('') || '<div class="hint" style="padding:8px">' + (r ? 'No documents in this room yet.' : 'No documents yet.') + '</div>';
}

$('#docScopeAll').onclick = () => { DOC_ROOM = null; renderDocs(); };
$('#docList').addEventListener('click', async e => {
  const d = e.target.closest('[data-doc]'); if (!d) return;
  const j = await (await fetch('/api/doc?name=' + encodeURIComponent(d.dataset.doc))).json();
  if (j.error) { alert(j.error); return; }
  const meta = DOCS.find(x => x.name === d.dataset.doc) || {};
  const room = meta.room ? roomById(meta.room) : null;
  $('#readerTitle').textContent = j.title || j.name;
  $('#readerMeta').textContent = [
    'From ' + (windowName(meta.fromSession, j.from) || clientName(j.from)),
    'to ' + (windowName(meta.toSession, j.to) || clientName(j.to)),
    room ? 'in ' + room.name : '', ago(j.created)
  ].filter(Boolean).join(' · ');
  $('#readerText').textContent = j.text;
  $('#reader').hidden = false;
  $('#readerClose').focus();
});
$('#readerClose').onclick = () => { $('#reader').hidden = true; };
$('#reader').addEventListener('click', e => { if (e.target.id === 'reader') $('#reader').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#reader').hidden = true; });

// ── sidebar panels ──────────────────────────────────────────────────────────

function showPanel(name) {
  for (const p of ['rooms', 'windows', 'docs']) $('#panel-' + p).hidden = p !== name;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.panel === name));
  if (name === 'windows') loadCards().then(renderWindows);
  if (name === 'docs') renderDocs();
}
document.querySelectorAll('#tabs button').forEach(b => {
  b.onclick = () => { if (b.dataset.panel === 'docs') DOC_ROOM = null; showPanel(b.dataset.panel); };
});

// ── feed ────────────────────────────────────────────────────────────────────

function statusTag(m) {
  switch (m.status) {
    case 'question': return '<span class="tag question">asks</span>';
    case 'blocked':  return '<span class="tag blocked">blocked</span>';
    case 'done':     return '<span class="tag">done</span>';
    case 'working':  return '<span class="tag">working' + (m.progress ? ': ' + esc(m.progress) : '') + '</span>';
    default:         return '';
  }
}

// The addressee is worth a word only where it is not obvious: on the square,
// or in a room of more than two windows.
function showsAddressee() {
  const r = roomById(ROOM);
  return !r || r.members.length > 2;
}

// prev: the message above when it belongs to the same run (same day), for
// grouping. prevShown: the message directly above regardless, so a reply to it
// does not quote what the reader has just read.
function messageHTML(m, prev, prevShown) {
  const k = isHuman(m) ? 'human' : kind(m.from);
  const who = senderName(m);
  const cont = prev && senderName(prev) === who && (m.fromSession || '') === (prev.fromSession || '') &&
               new Date(m.ts) - new Date(prev.ts) < 5 * 60e3 && !m.replyTo && m.priority !== 'P0';
  const parent = m.replyTo ? DATA.find(x => x.id === m.replyTo) : null;
  const long = (m.text || '').length > 900 && !OPEN.has(m.id);
  const img = m.file && /\.(png|jpe?g|webp|gif)$/i.test(m.file)
    ? '<img src="/api/attachment/' + encodeURIComponent(m.file) + '" alt="Attached image" loading="lazy">' : '';
  return '<article class="msg' + (cont ? ' cont' : '') + (m.priority === 'P0' ? ' urgent' : '') + '" id="m' + m.id + '" data-id="' + m.id + '">' +
    '<div class="avatar c-' + k + '" aria-hidden="true">' + esc((who || '?').trim().charAt(0).toUpperCase()) + '</div>' +
    '<div>' +
      (cont ? '' : '<div class="msg-head">' +
        '<span class="msg-from" title="' + esc(who + (m.fromSession ? '\n' + m.fromSession : '')) + '">' + esc(who) + '</span>' +
        (showsAddressee() ? '<span class="msg-to" title="' + esc(m.toSession || m.to) + '">to ' + esc(addresseeName(m)) + '</span>' : '') +
        '<span class="msg-time" title="' + esc(fullDate(m.ts) + ' · message ' + m.id) + '">' + clock(m.ts) + '</span>' +
        (m.priority === 'P0' ? '<span class="tag urgent">urgent</span>' : '') +
        statusTag(m) +
        (m.editedAt ? '<span class="msg-time" title="' + esc('Edited ' + fullDate(m.editedAt) + (m.editedBy ? ' by ' + m.editedBy : '')) + '">edited</span>' : '') +
      '</div>') +
      (m.replyTo && !(prevShown && prevShown.id === m.replyTo) ? '<div class="msg-reply" data-jump="' + m.replyTo + '">↳ ' +
        (parent ? esc(senderName(parent)) + ': ' + esc(short(parent.text.replace(/\s+/g, ' '), 90)) : 'reply to message ' + m.replyTo) + '</div>' : '') +
      '<div class="msg-text' + (long ? ' clip' : '') + '">' + richText(m.text) + '</div>' +
      ((m.text || '').length > 900 ? '<button type="button" class="more" data-more="' + m.id + '">' + (long ? 'Show more' : 'Show less') + '</button>' : '') +
      img +
    '</div>' +
    '<div class="msg-tools">' +
      '<button type="button" data-act="reply">Reply</button>' +
      '<button type="button" data-act="copy">Copy</button>' +
      (isHuman(m) ? '<button type="button" data-act="edit">Edit</button>' : '') +
    '</div>' +
  '</article>';
}

let SHOWN_LAST = null;   // the last message drawn, for grouping and day breaks

function renderFeed(full) {
  if (ROOM == null) return;
  const feed = $('#feed');
  const items = messagesHere();
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
  if (full) {
    SHOWN_LAST = null;
    if (!items.length) {
      feed.innerHTML = '<div class="empty">' + (ROOM === SQUARE ? 'Nothing on the square.' : 'No messages in this room yet. Write the first one below.') + '</div>';
      return;
    }
    feed.innerHTML = '';
  }
  const start = SHOWN_LAST ? items.findIndex(m => m.id > SHOWN_LAST.id) : 0;
  if (start < 0) return;
  if (feed.firstElementChild && feed.firstElementChild.classList.contains('empty')) feed.innerHTML = '';
  let html = '';
  for (let i = start; i < items.length; i++) {
    const m = items[i];
    if (!SHOWN_LAST || dayOf(SHOWN_LAST.ts) !== dayOf(m.ts)) html += '<div class="day">' + esc(dayOf(m.ts)) + '</div>';
    html += messageHTML(m, SHOWN_LAST && dayOf(SHOWN_LAST.ts) === dayOf(m.ts) ? SHOWN_LAST : null, SHOWN_LAST);
    SHOWN_LAST = m;
  }
  feed.insertAdjacentHTML('beforeend', html);
  if (full || nearBottom) feed.scrollTop = feed.scrollHeight;
}

function redraw(id) {
  const m = DATA.find(x => x.id === id), el = document.getElementById('m' + id);
  if (!m || !el) return;
  const i = messagesHere().findIndex(x => x.id === id);
  const prev = i > 0 ? messagesHere()[i - 1] : null;
  el.outerHTML = messageHTML(m, prev && dayOf(prev.ts) === dayOf(m.ts) ? prev : null, prev);
}

$('#feed').addEventListener('click', e => {
  const jump = e.target.closest('[data-jump]');
  if (jump) { focusMessage(Number(jump.dataset.jump)); return; }
  const more = e.target.closest('[data-more]');
  if (more) { const id = Number(more.dataset.more); OPEN.has(id) ? OPEN.delete(id) : OPEN.add(id); redraw(id); return; }
  if (e.target.tagName === 'IMG') { window.open(e.target.src, '_blank'); return; }
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const id = Number(act.closest('.msg').dataset.id);
  const m = DATA.find(x => x.id === id); if (!m) return;
  if (act.dataset.act === 'reply') startReply(m);
  if (act.dataset.act === 'edit') startEdit(m);
  if (act.dataset.act === 'copy') {
    navigator.clipboard.writeText(m.text).then(() => { act.textContent = 'Copied'; setTimeout(() => { act.textContent = 'Copy'; }, 1200); })
      .catch(() => { act.textContent = 'Not copied'; });
  }
});

function focusMessage(id) {
  const m = DATA.find(x => x.id === id);
  if (m && String(m.room || '') !== ROOM) enterRoom(String(m.room || ''));
  const el = document.getElementById('m' + id);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1400);
}

async function load(full) {
  const top = !full && DATA.length ? DATA[DATA.length - 1].id : 0;
  let j;
  try { j = await (await fetch(top ? '/api/board?since=' + top : '/api/board')).json(); } catch (_) { return; }
  if (j.error) return;
  const incoming = j.messages || [];
  if (!top) {
    DATA = incoming.sort((a, b) => a.id - b.id);
    renderFeed(true);
    return;
  }
  if (!incoming.length) return;
  for (const m of incoming) {
    const i = DATA.findIndex(x => x.id === m.id);
    if (i >= 0) { DATA[i] = m; redraw(m.id); } else DATA.push(m);
  }
  renderFeed(false);
  if (document.visibilityState === 'visible') markSeen();
  // The room that just spoke moves to the top of the list now, not on the
  // next timer tick.
  loadRooms();
}

// ── compose ─────────────────────────────────────────────────────────────────

// Who a message can go to from here. In a room: its windows. On the square:
// everyone, one client's windows, or any single window.
function fillTo(keep) {
  const sel = $('#to');
  const r = roomById(ROOM);
  let html;
  if (r) {
    html = '<option value="">Everyone in this room</option>' +
      r.members.map(m => '<option value="card:' + esc(m.card) + '|' + esc(m.agent) + '">' + esc(short(windowName(m.card, m.agent), 48)) + '</option>').join('');
  } else {
    const opt = c => '<option value="card:' + esc(c.id) + '|' + esc(c.agent) + '">' + esc(short(c.name || c.id, 48)) + '</option>';
    html = '<option value="">Everyone</option>' +
      '<option value="agent:Claude">Any Claude window</option>' +
      '<option value="agent:Gemini">Any Antigravity window</option>' +
      '<optgroup label="Claude">' + CARDS.filter(c => c.agent === 'Claude' && !c.elsewhere).map(opt).join('') + '</optgroup>' +
      '<optgroup label="Antigravity">' + CARDS.filter(c => c.agent !== 'Claude').map(opt).join('') + '</optgroup>';
  }
  sel.innerHTML = html;
  if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
  // One window in the room: there is nobody else to mean.
  else if (r && r.members.length === 1) sel.selectedIndex = 1;
  $('#text').placeholder = r ? 'Message ' + short(r.name, 60) : 'Write a message';
}

function target() {
  const v = $('#to').value;
  if (v.startsWith('card:')) { const [card, agent] = v.slice(5).split('|'); return { to: agent, toSession: card }; }
  if (v.startsWith('agent:')) return { to: v.slice(6), toSession: '' };
  return { to: 'all', toSession: '' };
}

function renderChips() {
  const chips = [];
  if (REPLY) chips.push(['reply', 'Replying to ' + senderName(REPLY) + ': ' + short(REPLY.text.replace(/\s+/g, ' '), 60)]);
  if (EDIT) chips.push(['edit', 'Editing your message. The original is kept.']);
  if (FILE) chips.push(['file', FILE.uploading ? 'Uploading ' + FILE.name + '…' : 'Image: ' + FILE.name]);
  $('#chips').innerHTML = chips.map(([k, t]) =>
    '<span class="chip"><span>' + esc(t) + '</span><button type="button" data-cancel="' + k + '" title="Cancel">✕</button></span>').join('');
}
$('#chips').addEventListener('click', e => {
  const b = e.target.closest('[data-cancel]'); if (!b) return;
  if (b.dataset.cancel === 'reply') REPLY = null;
  if (b.dataset.cancel === 'edit') { EDIT = null; $('#text').value = ''; grow(); }
  if (b.dataset.cancel === 'file') { FILE = null; $('#fileInput').value = ''; }
  renderChips();
});

function startReply(m) {
  EDIT = null; REPLY = m;
  if (!isHuman(m) && m.fromSession) {
    const v = 'card:' + m.fromSession + '|' + m.from;
    const sel = $('#to');
    if (![...sel.options].some(o => o.value === v)) {
      sel.insertAdjacentHTML('beforeend', '<option value="' + esc(v) + '">' + esc(short(senderName(m), 48)) + '</option>');
    }
    sel.value = v;
  }
  renderChips();
  $('#text').focus();
}
function startEdit(m) {
  REPLY = null; EDIT = m;
  $('#text').value = m.text; grow();
  renderChips();
  $('#text').focus();
}

function grow() { const t = $('#text'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 200) + 'px'; }
$('#text').addEventListener('input', grow);
$('#text').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing) return;
  if (e.shiftKey || e.ctrlKey || e.metaKey) {
    if (e.ctrlKey || e.metaKey) {           // Ctrl+Enter inserts a line break too, as it always has here
      e.preventDefault();
      const t = e.target, a = t.selectionStart;
      t.value = t.value.slice(0, a) + '\n' + t.value.slice(t.selectionEnd);
      t.selectionStart = t.selectionEnd = a + 1; grow();
    }
    return;
  }
  e.preventDefault();
  $('#compose').requestSubmit();
});

$('#compose').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('#text').value.trim();
  if (FILE && FILE.uploading) return;
  if (!text && !FILE) return;
  let j;
  if (EDIT) {
    j = await post('/api/edit', { id: EDIT.id, text, editedBy: ME });
  } else {
    const t = target();
    j = await post('/api/post', {
      from: ME, room: ROOM || '', to: t.to, toSession: t.toSession,
      priority: $('#urgent').checked ? 'P0' : 'normal',
      status: REPLY ? 'answer' : (text.includes('?') ? 'question' : 'info'),
      replyTo: REPLY ? REPLY.id : '',
      text: text || '[Attached image: ' + FILE.stored + ']',
      file: FILE ? FILE.stored : null
    });
  }
  if (j.error) { alert(j.error); return; }
  const kept = $('#to').value;
  $('#text').value = ''; grow();
  $('#urgent').checked = false;
  REPLY = null; EDIT = null; FILE = null; $('#fileInput').value = '';
  renderChips();
  fillTo(kept);
  OPEN.clear();
  await load(true);
  markSeen();
});

// ── images ──────────────────────────────────────────────────────────────────

function upload(file) {
  if (!file || !file.type.startsWith('image/')) return;
  FILE = { name: file.name || 'pasted image', uploading: true };
  renderChips();
  const reader = new FileReader();
  reader.onload = async () => {
    const j = await post('/api/upload', { filename: file.name || 'pasted.png', data: reader.result }).catch(err => ({ error: err.message }));
    if (j.error) { FILE = null; renderChips(); alert('The image was not attached: ' + j.error); return; }
    FILE = { name: file.name || 'pasted image', stored: j.filename };
    renderChips();
  };
  reader.readAsDataURL(file);
}
$('#attach').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = e => upload(e.target.files[0]);
document.addEventListener('paste', e => {
  for (const it of (e.clipboardData && e.clipboardData.items) || []) {
    if (it.kind === 'file' && it.type.startsWith('image/')) { upload(it.getAsFile()); break; }
  }
});
const box = $('#compose');
['dragenter', 'dragover'].forEach(n => box.addEventListener(n, e => { e.preventDefault(); box.classList.add('drag'); }));
['dragleave', 'drop'].forEach(n => box.addEventListener(n, e => { e.preventDefault(); box.classList.remove('drag'); }));
box.addEventListener('drop', e => { const f = [...(e.dataTransfer.files || [])].find(x => x.type.startsWith('image/')); if (f) upload(f); });

// ── the two apps ────────────────────────────────────────────────────────────

async function checkApps() {
  let j;
  try { j = await (await fetch('/api/agents')).json(); } catch (_) {
    $('#apps').innerHTML = '<div><i></i>The board server is not answering</div>';
    return;
  }
  const line = (name, up, app) => '<div><i class="' + (up ? 'up' : '') + '"></i>' + name + (up ? ' is running' :
    ' is closed <button type="button" class="link-btn" data-launch="' + app + '">Start</button>') + '</div>';
  $('#apps').innerHTML = line('Claude Desktop', j.claude, 'claude') + line('Antigravity', j.antigravity, 'antigravity');
}
$('#apps').addEventListener('click', async e => {
  const b = e.target.closest('[data-launch]'); if (!b) return;
  b.disabled = true; b.textContent = 'Starting…';
  await fetch('/api/agents/launch?app=' + encodeURIComponent(b.dataset.launch), { method: 'POST' });
  setTimeout(checkApps, 2000);
});

async function loadSessions() {
  try { SESSIONS = (await (await fetch('/api/sessions')).json()).sessions || []; } catch (_) {}
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { markSeen(); renderRooms(); } });

// ── start ───────────────────────────────────────────────────────────────────

(async function start() {
  await Promise.all([loadCards(), loadSessions(), load(true)]);
  await loadRooms();
  await loadDocs();
  // The first visit has nothing to compare with: every room would light up as
  // new. Start from "all seen" and count from here.
  if (!SEEN) { SEEN = {}; SEEN[SQUARE] = lastIdIn(SQUARE); for (const r of ROOMS) SEEN[r.id] = r.lastMessage || 0; store.set('seen', SEEN); }
  const last = store.get('room', null);
  enterRoom(last != null && (last === SQUARE || roomById(last)) ? last : (ROOMS[0] ? ROOMS[0].id : SQUARE));
  checkApps();
  setInterval(() => load(false), 2000);
  setInterval(loadRooms, 45000);
  setInterval(loadDocs, 30000);
  setInterval(checkApps, 10000);
  setInterval(async () => { await Promise.all([loadCards(), loadSessions()]); if (!$('#panel-windows').hidden) renderWindows(); }, 60000);
  setInterval(renderRooms, 60000);   // keeps the "5 min ago" lines honest
})();
