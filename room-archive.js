'use strict';
// Archiving and deleting a room.
//
// A room that has run its course is either archived or deleted, at the owner's
// word. Archiving writes one zip — the whole conversation as plain text, plus
// the room's documents and attached images — to agent_bridge_archive/rooms/, and
// then takes the room off the board. Feed the zip to an agent later and it will
// pull out what is useful. Deleting takes the room off the board with nothing
// kept. Either way the room's messages, documents and files leave the database
// and the disk: an archived room lives in its zip, a deleted one nowhere.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── a small zip writer: deflate, UTF-8 names, no dependencies ───────────────
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  const dosTime = d => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const dosDate = d => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  const now = new Date();
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8); head.writeUInt16LE(dosTime(now), 10); head.writeUInt16LE(dosDate(now), 12);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    locals.push(head, name, packed);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10); cen.writeUInt16LE(dosTime(now), 12); cen.writeUInt16LE(dosDate(now), 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    centrals.push(cen, name);
    offset += head.length + name.length + packed.length;
  }
  const cenSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function createArchiver(bridgeDb, bridgeDir) {
  const BODIES = path.join(bridgeDir, 'agent_bridge_bodies');
  const ATTACH = path.join(bridgeDir, 'docs', 'attachments');
  const OUT = path.join(bridgeDir, 'agent_bridge_archive', 'rooms');

  const isImage = f => /\.(png|jpe?g|webp|gif)$/i.test(String(f || ''));
  const bodyFile = m => (m.file && !isImage(m.file) && fs.existsSync(m.file)) ? m.file : null;
  const imageFile = m => {
    if (!m.file || !isImage(m.file)) return null;
    const p = path.isAbsolute(m.file) ? m.file : path.join(ATTACH, path.basename(m.file));
    return fs.existsSync(p) ? p : null;
  };

  // Everything that belongs to the room, read once.
  function gather(roomId) {
    const room = bridgeDb.getRoom(roomId);
    if (!room) throw new Error('no such room: ' + roomId);
    const messages = bridgeDb.readAllMessages().filter(m => m.room === roomId).sort((a, b) => a.id - b.id);
    const docs = bridgeDb.readDocsIndex().filter(d => d.room === roomId);
    return { room, messages, docs };
  }

  function transcript({ room, messages, docs }) {
    const lines = [
      `Room: ${room.name} (${room.id})`,
      `Members: ${(room.members || []).map(m => m.card + (m.agent ? ' [' + m.agent + ']' : '')).join(', ')}`,
      `Messages: ${messages.length}` + (messages.length ? `, ${messages[0].ts} — ${messages[messages.length - 1].ts}` : ''),
      `Documents: ${docs.length ? docs.map(d => d.title || d.name).join('; ') : 'none'}`,
      `Archived: ${new Date().toISOString()}`,
      '', '='.repeat(78), ''
    ];
    messages.forEach((m, i) => {
      let text = m.message || '';
      const bf = bodyFile(m);
      if (bf) { try { text = fs.readFileSync(bf, 'utf8'); } catch (_) {} }
      const to = m.toSession ? `${m.to} (${m.toSession})` : (m.to || 'all');
      lines.push(`#${i + 1}  [board #${m.id}]  ${m.ts}`);
      lines.push(`${m.from}${m.fromSession ? ' (' + m.fromSession + ')' : ''} → ${to}` +
        `${m.status && m.status !== 'info' ? '  [' + m.status + ']' : ''}${m.priority === 'P0' ? '  [P0]' : ''}` +
        `${m.replyTo ? '  reply to board #' + m.replyTo : ''}`);
      if (imageFile(m)) lines.push(`[image: attachments/${path.basename(m.file)}]`);
      lines.push('', text.trim(), '', '-'.repeat(78), '');
    });
    return lines.join('\n');
  }

  // Remove the room's messages, documents and files, then the room itself.
  // Files still used by a message outside the room are left alone.
  function purge({ room, messages, docs }) {
    const db = bridgeDb.getDb();
    const ids = new Set(messages.map(m => m.id));
    const others = bridgeDb.readAllMessages().filter(m => !ids.has(m.id) && m.file).map(m => path.basename(m.file));
    const files = [];
    for (const m of messages) {
      const f = bodyFile(m) || imageFile(m);
      if (f && !others.includes(path.basename(f))) files.push(f);
    }
    for (const d of docs) if (d.file && fs.existsSync(d.file)) files.push(d.file);
    db.exec('BEGIN');
    try {
      const delMsg = db.prepare('DELETE FROM messages WHERE id = ?');
      for (const id of ids) delMsg.run(id);
      const delDoc = db.prepare('DELETE FROM docs_index WHERE name = ?');
      for (const d of docs) delDoc.run(d.name);
      db.prepare('DELETE FROM room_members WHERE room = ?').run(room.id);
      db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    let removed = 0;
    for (const f of files) { try { fs.unlinkSync(f); removed++; } catch (_) {} }
    return { messages: ids.size, docs: docs.length, files: removed };
  }

  function archiveRoom(roomId) {
    const g = gather(roomId);
    const entries = [{ name: 'conversation.txt', data: transcript(g) }];
    for (const d of g.docs) {
      if (d.file && fs.existsSync(d.file)) entries.push({ name: 'docs/' + path.basename(d.file), data: fs.readFileSync(d.file) });
    }
    for (const m of g.messages) {
      const f = imageFile(m);
      if (f) entries.push({ name: 'attachments/' + path.basename(f), data: fs.readFileSync(f) });
    }
    fs.mkdirSync(OUT, { recursive: true });
    const safe = String(g.room.id).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60);
    const file = path.join(OUT, `${new Date().toISOString().slice(0, 10)}-${safe}.zip`);
    let target = file, n = 1;
    while (fs.existsSync(target)) target = file.replace(/\.zip$/, `-${++n}.zip`);
    fs.writeFileSync(target, zip(entries));
    // The zip is written and readable before anything is removed.
    if (!fs.statSync(target).size) throw new Error('the archive came out empty; nothing was removed');
    return Object.assign({ file: target }, purge(g));
  }

  function deleteRoomForever(roomId) {
    return purge(gather(roomId));
  }

  function describe(roomId) {
    const g = gather(roomId);
    return { name: g.room.name, messages: g.messages.length, docs: g.docs.length };
  }

  return { archiveRoom, deleteRoomForever, describe, ARCHIVE_DIR: OUT };
}

module.exports = { createArchiver, zip };
