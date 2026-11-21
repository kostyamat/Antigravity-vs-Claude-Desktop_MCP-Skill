'use strict';
// node test_antigravity_locate.js — Antigravity 2.34 keeps its token out of the command line and
// writes daemon/hub_<port>.json instead; locate() takes the newest file whose language server is
// alive and skips the ones an earlier start left behind. A temporary home; nothing live is read.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-locate-'));
process.env.USERPROFILE = tmp;
process.env.LOCALAPPDATA = path.join(tmp, 'local');
const bin = path.join(tmp, 'local', 'Programs', 'antigravity', 'resources', 'bin');
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, 'language_server.exe'), '');
const daemon = path.join(tmp, '.gemini', 'antigravity', 'daemon');
fs.mkdirSync(daemon, { recursive: true });

const write = (port, pid, ageSec) => {
  const p = path.join(daemon, `hub_${port}.json`);
  fs.writeFileSync(p, JSON.stringify({ pid, httpsPort: port - 1, httpPort: port, lsVersion: '2.34.0', csrfToken: 'tok-' + port }));
  const t = new Date(Date.now() - ageSec * 1000);
  fs.utimesSync(p, t, t);
};

try {
  const api = require('./antigravity-api');
  write(50001, process.pid, 60);        // alive, older
  write(50002, 2147483000, 1);          // newest, but that start is gone
  const at = api.locate();
  assert.strictEqual(at.env.ANTIGRAVITY_LS_ADDRESS, 'localhost:50001', 'a file of a dead language server is skipped');
  assert.strictEqual(at.env.ANTIGRAVITY_CSRF_TOKEN, 'tok-50001');
  write(50003, process.pid, 0);
  assert.strictEqual(api.locate().env.ANTIGRAVITY_LS_ADDRESS, 'localhost:50003', 'the newest live one wins');
  console.log('ok 2/2');
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
