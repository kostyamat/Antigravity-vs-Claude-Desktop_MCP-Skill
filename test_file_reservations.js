'use strict';
// node test_file_reservations.js — advisory file reservations (overlap, conflicts, release), the
// pre-commit guard on a real temporary git repository, the idempotency key, and the retry on a busy
// database. Everything runs on copies in a temporary folder; the live board is not touched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-res-'));
for (const f of ['bridge-db.js', 'sqlite.js', 'file-reservations.js', 'reservation-guard.js']) fs.copyFileSync(path.join(__dirname, f), path.join(tmp, f));
const db = require(path.join(tmp, 'bridge-db.js'));
const R = require(path.join(tmp, 'file-reservations.js'));
const res = R.createReservations(() => db.getDb());
const repo = path.join(tmp, 'repo');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok ' + name); };

t('overlap: same file, a glob over it, a folder holding it; not a neighbour', () => {
  assert.ok(R.overlap('src/a.js', 'src/a.js'));
  assert.ok(R.overlap('src/**', 'src/deep/b.js'));
  assert.ok(R.overlap('src', 'src/a.js'), 'a reserved folder holds its files');
  assert.ok(R.overlap('src/*.js', 'src/**'));
  assert.ok(!R.overlap('src/a.js', 'src/b.js'));
  assert.ok(!R.overlap('docs/**', 'src/a.js'));
});
t('a window reserves; another is refused with the holder named; the same window may renew', () => {
  const a = res.reserve({ repo, holder: 'local_lead', holderName: 'Lead', agent: 'Claude', patterns: ['src/**'], reason: 'refactor' });
  assert.deepStrictEqual(a.taken, ['src/**']);
  const b = res.reserve({ repo, holder: 'gem-helper', holderName: 'Helper', agent: 'Gemini', patterns: ['src/x.js'] });
  assert.strictEqual(b.taken.length, 0);
  assert.strictEqual(b.conflicts[0].holderName, 'Lead');
  assert.ok(res.reserve({ repo, holder: 'local_lead', patterns: ['src/**'] }).taken.length, 'renewed');
  assert.ok(res.reserve({ repo, holder: 'gem-helper', agent: 'Gemini', patterns: ['docs/**'] }).taken.length, 'other files are free');
});
t('the guard stops another agent\'s commit over a reserved file, lets the holder and the owner through', () => {
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: repo });
  fs.writeFileSync(path.join(repo, 'src', 'x.js'), '1');
  execSync('git add src/x.js', { cwd: repo });
  const run = (kind, win) => spawnSync(process.execPath, [path.join(tmp, 'reservation-guard.js'), kind], { cwd: repo, input: 'src/x.js\n',
    env: Object.assign({}, process.env, { CLAUDE_CODE_HOST_SESSION_ID: win || '', BRIDGE_WINDOW: '' }), encoding: 'utf8' });
  const other = run('claude', 'local_other');
  assert.strictEqual(other.status, 1, other.stderr);
  assert.match(other.stderr, /held by "Lead"/);
  assert.strictEqual(run('claude', 'local_lead').status, 0, 'the holder commits');
  const owner = run('human', '');
  assert.strictEqual(owner.status, 0, 'the owner is never stopped');
  assert.match(owner.stderr, /you are the owner/);
});
t('release frees them for the others', () => {
  assert.ok(res.release({ repo, holder: 'local_lead' }) >= 1);
  assert.ok(res.reserve({ repo, holder: 'gem-helper', agent: 'Gemini', patterns: ['src/x.js'] }).taken.length);
});
t('an idempotency key returns the message already written', () => {
  const m = db.addMessage({ from: 'Claude', fromSession: 'local_lead', to: 'all', message: 'once' });
  db.rememberIdempotent('local_lead', 'k-1', m.id);
  assert.strictEqual(db.idempotentMessage('local_lead', 'k-1'), m.id);
  assert.strictEqual(db.idempotentMessage('local_other', 'k-1'), null, 'the key is the sender\'s own');
});
t('a busy database is tried again; any other error is not', () => {
  let tries = 0;
  assert.strictEqual(db.retryBusy(() => { if (++tries < 3) throw new Error('database is locked'); return 'ok'; }), 'ok');
  assert.strictEqual(tries, 3);
  let other = 0;
  assert.throws(() => db.retryBusy(() => { other++; throw new Error('no such table'); }), /no such table/);
  assert.strictEqual(other, 1);
});
try { db.getDb().close(); } catch (_) {}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
console.log(n + '/6 passed');
