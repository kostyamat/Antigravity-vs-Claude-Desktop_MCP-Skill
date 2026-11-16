'use strict';
// node test_attachments_async.js — converting an attachment does not block the board's process.
// Works in a temporary folder with a stub database; the live board and its files are not touched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAttachments } = require('./attachments');

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-att-'));
  fs.copyFileSync(path.join(__dirname, 'doc-convert.py'), path.join(home, 'doc-convert.py'));
  const indexed = [];
  const att = createAttachments({ saveDocIndex: d => indexed.push(d), queueDescription: () => {} }, home);

  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const pending = att.store({ filename: 'notes.txt', data: Buffer.from('hello board\n'.repeat(50)).toString('base64'), room: 'r1', from: 'owner' });
  assert.ok(pending && typeof pending.then === 'function', 'store returns a promise');
  const out = await pending;
  clearInterval(timer);

  assert.ok(out.ok, 'stored');
  assert.ok(fs.existsSync(out.file), 'original kept');
  assert.ok(ticks > 0, 'the event loop ran while the file was converted');
  if (out.text) {
    assert.ok(fs.existsSync(out.text), 'text copy written');
    assert.strictEqual(indexed.length, 1, 'indexed once');
  } else {
    console.log('note: no text copy (' + (out.note || 'no python') + ')');
  }
  assert.ok((await att.store({ filename: 'x', data: '' })).error, 'empty file refused');

  fs.rmSync(home, { recursive: true, force: true });
  console.log(`attachments async: all checks passed (${ticks} ticks during conversion)`);
})().catch(e => { console.error(e); process.exit(1); });
