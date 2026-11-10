'use strict';
// A file the owner attaches on the board: kept as it is, and turned into text.
//
// The board used to take pictures only. Everything else the owner works with —
// a manual in PDF, a specification in Word, a table, a slide deck — had to be
// handed to an agent by path, and the agent then spent a tool chain and a pile of
// tokens opening it, or guessed. Now any file is stored, converted once by
// doc-convert.py into Markdown beside it, and listed among the room's documents.
// The message carries the path of the text, so an agent reads that and nothing
// else. A picture or a recording has no text to extract: it is queued for the
// supervisor, which writes a description into the same .md.
//
// The original is only ever served back as a download, never rendered: an
// attachment is somebody else's bytes on the board's own origin.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const MAX_BYTES = 40 * 1024 * 1024;

function slug(s, fallback) {
  const out = String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return out || fallback;
}

function python() {
  for (const cmd of [process.env.AGENT_BRIDGE_PYTHON, 'python', 'python3', 'py'].filter(Boolean)) {
    try {
      const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      if (r.status === 0 && String(r.stdout).trim() === '3') return cmd;
    } catch (_) {}
  }
  return '';
}

function createAttachments(bridgeDb, home) {
  const dir = path.join(home, 'docs', 'attachments');
  const textDir = path.join(home, 'docs', 'converted');
  let py = null;

  // → { ok, filename, file, url, image, text, chars, kind, note, needsDescription }
  function store({ filename, data, room, from }) {
    const buf = Buffer.from(String(data || '').replace(/^data:[^;]*;base64,/, ''), 'base64');
    if (!buf.length) return { error: 'The file is empty.' };
    if (buf.length > MAX_BYTES) return { error: `The file is larger than ${MAX_BYTES / 1048576} MB.` };
    fs.mkdirSync(dir, { recursive: true });
    const original = path.basename(String(filename || 'file'));
    let ext = path.extname(original).toLowerCase();
    if (!/^\.[a-z0-9]{1,8}$/.test(ext)) ext = '.bin';
    const base = slug(path.basename(original, path.extname(original)), 'file');
    const safeName = `att_${Date.now()}_${base}${ext}`;
    const saved = path.join(dir, safeName);
    fs.writeFileSync(saved, buf);
    const out = { ok: true, filename: safeName, file: saved, url: '/api/attachment/' + safeName,
                  image: IMAGE_EXT.includes(ext), name: original };

    // The text of it, for agents.
    if (py === null) py = python();
    if (!py) return Object.assign(out, { note: 'Python 3 was not found, so the file is attached as it is, without a text copy.' });
    fs.mkdirSync(textDir, { recursive: true });
    const md = path.join(textDir, safeName.replace(/\.[^.]+$/, '') + '.md');
    let res = {};
    try {
      const r = spawnSync(py, [path.join(home, 'doc-convert.py'), saved, md, original],
        { encoding: 'utf8', windowsHide: true, timeout: 120000, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) });
      res = JSON.parse(String(r.stdout || '').trim().split('\n').pop() || '{}');
    } catch (e) { res = { ok: false, note: e.message }; }
    if (!res.ok || !fs.existsSync(md)) return Object.assign(out, { note: res.note || 'The file could not be converted to text.' });

    Object.assign(out, { text: md, chars: res.chars || 0, kind: res.kind || '', note: res.note || '',
                         needsDescription: Boolean(res.needs_description) });
    try {
      bridgeDb.saveDocIndex({
        name: path.basename(md), title: original, from: String(from || ''), fromSession: 'human/web',
        to: 'all', toSession: '', topic: 'attachment', priority: 'normal', file: md,
        created: new Date().toISOString(), readBy: [], ackedBy: [], room: String(room || '')
      });
    } catch (_) {}
    if (out.needsDescription) {
      try { bridgeDb.queueDescription(md, saved, res.kind || '', room || ''); } catch (_) {}
    }
    return out;
  }

  // What the message says about its attachment — the part an agent acts on.
  function line(att) {
    if (!att || !att.text) return att && att.name ? `[Attached: ${att.name} — ${att.file}]` : '';
    if (att.needsDescription) {
      return `[Attached: ${att.name} (${att.kind}). Original: ${att.file}. A description is being written to ${att.text} — ` +
        'read that file; if it still says "Not described yet", look at the original.]';
    }
    return `[Attached: ${att.name} → text for you: ${att.text} (${att.chars} characters${att.note ? '; ' + att.note : ''}). ` +
      `Read that file, not the original (${att.file}).]`;
  }

  return { store, line, dir, IMAGE_EXT };
}

module.exports = { createAttachments };
