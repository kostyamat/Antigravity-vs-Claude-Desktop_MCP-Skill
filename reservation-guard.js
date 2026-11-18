#!/usr/bin/env node
'use strict';
// Called by the global pre-commit hook (git-hooks/pre-commit) with the staged files on stdin and the
// kind of committer (claude | gemini | human) as the argument. Stops an agent's commit that touches a
// file another window reserved (file-reservations.js); tells the owner and lets him commit.
// It never breaks a commit on its own failure: no board, no database, no git — it says nothing.

const { execSync } = require('child_process');

function main() {
  const kind = String(process.argv[2] || 'human');
  let repo = '';
  try { repo = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim(); } catch (_) { return 0; }
  let files = '';
  try { files = require('fs').readFileSync(0, 'utf8'); } catch (_) { return 0; }
  const list = files.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!list.length) return 0;
  let held = [];
  try {
    const db = require('./bridge-db');
    const res = require('./file-reservations').createReservations(() => db.getDb());
    const committer = /^local_/.test(process.env.CLAUDE_CODE_HOST_SESSION_ID || '') ? process.env.CLAUDE_CODE_HOST_SESSION_ID
      : String(process.env.BRIDGE_WINDOW || '').trim();
    held = res.heldByOthers({ repo, files: list, committer, committerAgent: kind });
  } catch (_) { return 0; }
  if (!held.length) return 0;
  const lines = held.map(h => `    ${h.file}  — held by "${h.holderName || h.holder}" (${h.pattern}) until ${String(h.until).slice(0, 16).replace('T', ' ')}` +
    (h.reason ? `: ${h.reason}` : ''));
  if (kind === 'human') {
    process.stderr.write('⚠ Files reserved by another window (the commit goes through — you are the owner):\n' + lines.join('\n') + '\n');
    return 0;
  }
  process.stderr.write('✖ Files reserved by another window — do not commit them over its work:\n' + lines.join('\n') + '\n' +
    '  Ask that window (or wait for its reservation to end), or unstage them: git restore --staged <file>.\n');
  return 1;
}

process.exitCode = main();
