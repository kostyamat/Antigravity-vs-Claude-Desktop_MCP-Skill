#!/usr/bin/env node
'use strict';
// The Claude CLI follows the account the desktop app is signed in to.
//
// The owner works from two Claude accounts and switches the desktop app between
// them when a quota runs out. The terminal `claude` stayed on whichever account it
// was signed in to last: a session started or resumed from the command line then
// spent the quota of the wrong account (owner, 16.11.2026: "when the board switches
// Claude accounts, make it switch the Claude CLI account. To the same one").
//
// Claude Code's own answer to several accounts is a configuration directory per
// account (CLAUDE_CONFIG_DIR): its sign-in is kept in that directory, in a file the
// CLI writes itself when the owner signs in there. So nothing here reads, copies or
// stores a token. Each account gets a directory under ~/.claude-accounts/<account>;
// the owner signs in once in each (`claude-acct login`); and `claude-acct` starts the
// CLI in the directory of whichever account the desktop app is signed in to now.
// There is no switch to forget: the account is looked up at every start.
//
// A configuration directory also holds settings, hooks, skills, plugins and the
// transcripts — and those must stay one set, or the second account's sessions would
// run without the board's hooks and could not resume the first one's sessions. So
// an account's directory holds links: every entry of ~/.claude except what makes an
// account an account (OWN) is linked into it, directories as junctions, files as
// symbolic links (a hard link where those are not allowed). The links are checked
// again at every start, because ~/.claude grows new entries.
//
// Nothing here deletes anything, and nothing recurses into a link: a junction
// removed carelessly takes its target's content with it.
//
// Installed as the command `claude-acct` (install-bridge.js), used exactly like `claude`:
//   claude-acct [claude arguments…]          the CLI, as the account the desktop app uses now
//   claude-acct --accounts status            every account directory, signed in or not, which is current
//   claude-acct --accounts login [account]   make the directory, then `claude auth login` there — the owner signs in
//   claude-acct --accounts prepare [account] make or refresh the directory without signing in
//   claude-acct --as <account> [arguments…]  the CLI as a named account, whatever the desktop app uses

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = process.env.USERPROFILE || os.homedir();
const SHARED = process.env.AGENT_BRIDGE_CLAUDE_SHARED || path.join(HOME, '.claude');
const ROOT = process.env.AGENT_BRIDGE_CLAUDE_ACCOUNTS || path.join(HOME, '.claude-accounts');

// What belongs to one account and is never linked: the sign-in the CLI writes, its
// global state file (which names the signed-in account), and per-install markers.
const OWN = new Set(['.credentials.json', '.claude.json', '.claude.json.backup', '.last-cleanup',
  '.last-update-result.json', 'mcp-needs-auth-cache.json', 'statsig', 'telemetry']);
// Backups and leftovers in ~/.claude: no account needs them.
const NOISE = /\.bak($|[-.])|\.before-|\.uk-before-|^backups$/i;

const dirFor = account => path.join(ROOT, String(account || '').replace(/[^A-Za-z0-9_-]/g, ''));
const enabled = () => fs.existsSync(ROOT);

// The account the desktop app is signed in to now, or ''.
function current() {
  try { return require('./cards').currentAccount() || ''; } catch (_) { return ''; }
}

// A sign-in exists in that directory. Only whether the file is there: it is never opened.
function signedIn(account) {
  try { return fs.statSync(path.join(dirFor(account), '.credentials.json')).size > 0; } catch (_) { return false; }
}

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Make the account's directory and link into it everything of ~/.claude that is shared.
// Returns { dir, linked: [names made now], ok: n, own: [names the account keeps],
//           conflicts: [{ name, why }] } — a conflict is reported and left as it is.
function prepare(account) {
  const acc = String(account || '').trim();
  if (!acc) throw new Error('no account: the desktop app is not signed in, or pass one');
  const dir = dirFor(acc);
  if (same(dir, ROOT)) throw new Error('"' + acc + '" is not an account id');
  fs.mkdirSync(dir, { recursive: true });
  const out = { dir, linked: [], ok: 0, own: [], conflicts: [] };
  for (const name of fs.readdirSync(SHARED)) {
    if (OWN.has(name) || NOISE.test(name)) continue;
    const target = path.join(SHARED, name), link = path.join(dir, name);
    let t, l = null;
    try { t = fs.statSync(target); } catch (_) { continue; }
    try { l = fs.lstatSync(link); } catch (_) {}
    if (!l) {
      try {
        if (t.isDirectory()) fs.symlinkSync(target, link, 'junction');
        else {
          try { fs.symlinkSync(target, link, 'file'); }
          catch (_) { fs.linkSync(target, link); }          // no right to make symbolic links: a hard link
        }
        out.linked.push(name);
      } catch (e) { out.conflicts.push({ name, why: 'could not be linked: ' + e.code }); }
      continue;
    }
    if (l.isSymbolicLink()) {
      let real = '';
      try { real = fs.realpathSync(link); } catch (_) {}
      if (real && same(real, fs.realpathSync(target))) out.ok++;
      else out.conflicts.push({ name, why: 'a link that points somewhere else' });
    } else if (l.isFile() && t.isFile()) {
      const a = fs.statSync(link, { bigint: true }), b = fs.statSync(target, { bigint: true });
      if (a.ino !== 0n && a.ino === b.ino && a.dev === b.dev) out.ok++;
      else out.conflicts.push({ name, why: 'a separate copy (the link was replaced by a file); newer: ' + (l.mtimeMs > t.mtimeMs ? 'the account\'s' : 'the shared one') });
    } else {
      out.conflicts.push({ name, why: 'a real ' + (l.isDirectory() ? 'folder' : 'entry') + ' where a link to the shared one belongs' });
    }
  }
  for (const name of fs.readdirSync(dir)) if (!fs.existsSync(path.join(SHARED, name)) || OWN.has(name)) out.own.push(name);
  return out;
}

// Every account directory: [{ account, dir, signedIn, current }]
function list() {
  const cur = current();
  let names = [];
  try { names = fs.readdirSync(ROOT).filter(n => fs.statSync(path.join(ROOT, n)).isDirectory()); } catch (_) {}
  return names.map(account => ({ account, dir: dirFor(account), signedIn: signedIn(account), current: account === cur }));
}

// The environment the CLI is started with for that account.
function envFor(account) {
  return Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: dirFor(account) });
}

// One line for the session-start brief, or ''. Said once a day per account, and only
// on a machine where the owner has set account directories up at all.
function briefLine(runDir, account) {
  try {
    if (!enabled()) return '';
    const cur = account || current();
    if (!cur) return '';
    const p = prepare(cur);
    if (signedIn(cur) && !p.conflicts.length) return '';
    const mark = path.join(runDir || path.join(__dirname, 'run'), 'cli_account_' + cur.slice(0, 8) + '.json');
    try { if (Date.now() - JSON.parse(fs.readFileSync(mark, 'utf8')).at < 86400e3) return ''; } catch (_) {}
    try { fs.mkdirSync(path.dirname(mark), { recursive: true }); fs.writeFileSync(mark, JSON.stringify({ at: Date.now() })); } catch (_) {}
    if (!signedIn(cur)) {
      return '🔑 The Claude CLI is not signed in for the account the desktop app uses now, so `claude-acct` cannot follow it. ' +
        'Tell the owner once: run `claude-acct --accounts login` in a terminal and sign in with this account.';
    }
    return '⚠️ The CLI directory of this account no longer mirrors ~/.claude: ' +
      p.conflicts.map(c => `${c.name} — ${c.why}`).join('; ') + '. Tell the owner; nothing was changed.';
  } catch (_) { return ''; }
}

module.exports = { prepare, list, current, signedIn, envFor, dirFor, enabled, briefLine, ROOT, SHARED, OWN };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const say = s => process.stdout.write(s + '\n');
  const report = p => {
    say(`${p.dir}: ${p.ok + p.linked.length} shared entries linked` + (p.linked.length ? ` (${p.linked.length} new)` : '') +
      (p.own.length ? `; its own: ${p.own.join(', ')}` : ''));
    for (const c of p.conflicts) say(`  ! ${c.name}: ${c.why} — left as it is`);
  };
  try {
    if (argv[0] === '--accounts') {
      const cmd = argv[1] || 'status';
      if (cmd === 'status') {
        const cur = current();
        say('Desktop account now: ' + (cur || 'unknown'));
        const all = list();
        if (!all.length) say('No account directory yet. Make one with: claude-acct --accounts login');
        for (const a of all) say(`${a.current ? '→' : ' '} ${a.account}   ${a.signedIn ? 'signed in' : 'NOT signed in'}   ${a.dir}`);
        if (cur && all.length && !all.some(a => a.current)) say('The current account has no directory: claude-acct --accounts login');
      } else if (cmd === 'prepare') {
        report(prepare(argv[2] || current()));
      } else if (cmd === 'login') {
        const acc = argv[2] || current();
        report(prepare(acc));
        say('Signing in for account ' + acc + ' — a browser opens; sign in with THAT account.');
        const r = spawnSync('claude', ['auth', 'login'], { env: envFor(acc), stdio: 'inherit' });
        say(signedIn(acc) ? 'Signed in: claude-acct follows this account from now on.' : 'No sign-in was written.');
        process.exitCode = r.status || 0;
      } else {
        say('usage: claude-acct --accounts status | login [account] | prepare [account]');
        process.exitCode = 2;
      }
    } else {
      let rest = argv, acc = '';
      if (rest[0] === '--as') { acc = rest[1] || ''; rest = rest.slice(2); }
      acc = acc || current();
      if (!acc) { process.stderr.write('claude-acct: the desktop app is not signed in to any account; use --as <account>\n'); process.exit(2); }
      const p = prepare(acc);
      if (!signedIn(acc)) process.stderr.write(`claude-acct: account ${acc} is not signed in for the CLI yet — it will ask you to sign in.\n`);
      for (const c of p.conflicts) process.stderr.write(`claude-acct: ${c.name}: ${c.why}\n`);
      const r = spawnSync('claude', rest, { env: envFor(acc), stdio: 'inherit' });
      if (r.error) { process.stderr.write('claude-acct: ' + r.error.message + '\n'); process.exit(127); }
      process.exit(r.status === null ? 1 : r.status);
    }
  } catch (e) {
    process.stderr.write('claude-acct: ' + e.message + '\n');
    process.exitCode = 1;
  }
}
