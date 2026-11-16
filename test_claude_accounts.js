'use strict';
// node test_claude_accounts.js — an account's CLI directory mirrors the shared settings folder
// by links, keeps its own sign-in, and nothing of the shared folder is ever copied or removed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-'));
const shared = path.join(home, 'shared'), root = path.join(home, 'accounts');
process.env.AGENT_BRIDGE_CLAUDE_SHARED = shared;
process.env.AGENT_BRIDGE_CLAUDE_ACCOUNTS = root;
fs.mkdirSync(path.join(shared, 'skills', 'one'), { recursive: true });
fs.mkdirSync(path.join(shared, 'projects'));
fs.mkdirSync(path.join(shared, 'backups'));
fs.writeFileSync(path.join(shared, 'skills', 'one', 'SKILL.md'), 'skill');
fs.writeFileSync(path.join(shared, 'settings.json'), '{"hooks":{}}');
fs.writeFileSync(path.join(shared, 'CLAUDE.md'), 'rules');
fs.writeFileSync(path.join(shared, 'settings.json.bak-2026'), 'old');
fs.writeFileSync(path.join(shared, '.credentials.json'), 'the-other-accounts-sign-in');
fs.writeFileSync(path.join(shared, '.claude.json'), '{}');

const acc = require('./claude-accounts');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok ' + name); };
const dir = acc.dirFor('acc-1');

// Take every link out by hand before the temp folder goes: nothing here may recurse into one.
function unlinkAll(d) {
  for (const name of fs.readdirSync(d)) {
    const p = path.join(d, name), l = fs.lstatSync(p);
    if (l.isSymbolicLink()) { try { fs.rmdirSync(p); } catch (_) { fs.unlinkSync(p); } }
  }
}

try {
  t('not set up until the owner makes the first directory', () => {
    assert.strictEqual(acc.enabled(), false);
    assert.strictEqual(acc.briefLine(path.join(home, 'run'), 'acc-1'), '');
  });
  t('the shared entries are linked; the sign-in, the state file and backups are not', () => {
    const p = acc.prepare('acc-1');
    assert.deepStrictEqual(p.linked.sort(), ['CLAUDE.md', 'projects', 'settings.json', 'skills']);
    assert.deepStrictEqual(p.conflicts, []);
    for (const own of ['.credentials.json', '.claude.json', 'backups', 'settings.json.bak-2026']) {
      assert.ok(!fs.existsSync(path.join(dir, own)), own + ' must not be there');
    }
    assert.strictEqual(fs.readFileSync(path.join(dir, 'skills', 'one', 'SKILL.md'), 'utf8'), 'skill');
  });
  t('a change on either side is one change: there is no second copy', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"hooks":{"x":1}}');
    assert.strictEqual(fs.readFileSync(path.join(shared, 'settings.json'), 'utf8'), '{"hooks":{"x":1}}');
    fs.writeFileSync(path.join(shared, 'projects', 'p.jsonl'), 'transcript');
    assert.ok(fs.existsSync(path.join(dir, 'projects', 'p.jsonl')));
  });
  t('asked again it makes nothing new; a new shared entry is linked the next time', () => {
    let p = acc.prepare('acc-1');
    assert.deepStrictEqual(p.linked, []);
    assert.strictEqual(p.ok, 4);
    fs.mkdirSync(path.join(shared, 'plugins'));
    p = acc.prepare('acc-1');
    assert.deepStrictEqual(p.linked, ['plugins']);
  });
  t('the sign-in is the account\'s own, and only its presence is looked at', () => {
    assert.strictEqual(acc.signedIn('acc-1'), false);
    assert.match(acc.briefLine(path.join(home, 'run'), 'acc-1'), /not signed in/);
    assert.strictEqual(acc.briefLine(path.join(home, 'run'), 'acc-1'), '', 'said once a day');
    fs.writeFileSync(path.join(dir, '.credentials.json'), 'written-by-the-cli-at-login');
    assert.strictEqual(acc.signedIn('acc-1'), true);
    assert.strictEqual(fs.readFileSync(path.join(shared, '.credentials.json'), 'utf8'), 'the-other-accounts-sign-in');
    assert.deepStrictEqual(acc.prepare('acc-1').own, ['.credentials.json']);
    assert.strictEqual(acc.envFor('acc-1').CLAUDE_CONFIG_DIR, dir);
  });
  t('a link that was replaced by a separate file is reported and left alone', () => {
    fs.unlinkSync(path.join(dir, 'CLAUDE.md'));
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'a private copy');
    const p = acc.prepare('acc-1');
    assert.strictEqual(p.conflicts.length, 1);
    assert.match(p.conflicts[0].why, /separate copy/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), 'a private copy');
    assert.strictEqual(fs.readFileSync(path.join(shared, 'CLAUDE.md'), 'utf8'), 'rules');
    assert.match(acc.briefLine(path.join(home, 'run2'), 'acc-1'), /no longer mirrors/);
  });
  t('two accounts, two directories, one shared folder', () => {
    acc.prepare('acc-2');
    assert.strictEqual(acc.signedIn('acc-2'), false);
    assert.deepStrictEqual(acc.list().map(a => a.account).sort(), ['acc-1', 'acc-2']);
    assert.throws(() => acc.prepare(''), /no account/);
  });
  t('taking the links away leaves the shared folder whole', () => {
    unlinkAll(dir); unlinkAll(acc.dirFor('acc-2'));
    assert.strictEqual(fs.readFileSync(path.join(shared, 'skills', 'one', 'SKILL.md'), 'utf8'), 'skill');
    assert.ok(fs.existsSync(path.join(shared, 'projects', 'p.jsonl')));
  });
  console.log(n + '/8 passed');
} finally {
  try { unlinkAll(dir); } catch (_) {}
  try { unlinkAll(acc.dirFor('acc-2')); } catch (_) {}
  fs.rmSync(home, { recursive: true, force: true });
}
