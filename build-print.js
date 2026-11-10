'use strict';
// One fingerprint for the code a running process was started from.
//
// The server and the dashboard are both built from the modules beside them. The
// installer used to decide "did the dashboard change" from one file's hash kept
// since the last run, so an update that touched only a module, or a run whose
// restart failed, left the old dashboard serving for days with nobody told. Now
// the dashboard says which build it is, and the installer compares that with the
// files on disk: what is running is asked, not remembered.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function modulesPrint(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => /\.js$/.test(f) && !/^install-/.test(f)).sort(); } catch (_) {}
  const hash = crypto.createHash('sha256');
  for (const n of names) {
    hash.update(n + ':');
    try { hash.update(fs.readFileSync(path.join(dir, n))); } catch (_) {}
  }
  return hash.digest('hex').slice(0, 16);
}

module.exports = { modulesPrint };
