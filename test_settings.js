'use strict';
// node test_settings.js — the Settings tab (settings.js): a value in force is the configured one
// when valid, else the default; a change is checked before it is written; null puts the default
// back. Run in a copy of the code, so the live bridge_config.json is never touched.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-settings-'));
fs.copyFileSync(path.join(__dirname, 'settings.js'), path.join(dir, 'settings.js'));
fs.writeFileSync(path.join(dir, 'bridge_config.json'), JSON.stringify({ maxFileGB: 'lots', other: 1 }));
const s = require(path.join(dir, 'settings.js'));
try {
  assert.strictEqual(s.get('maxFileGB'), 20, 'an invalid value: the default');
  assert.strictEqual(s.get('activeWindowMinutes'), 60);
  assert.deepStrictEqual(s.set('maxFileGB', '50'), { key: 'maxFileGB', value: 50, restart: false });
  assert.strictEqual(s.get('maxFileGB'), 50);
  assert.match(s.set('maxFileGB', 9999).error, /from 0\.1 to 500/);
  assert.match(s.set('activeWindowMinutes', 'x').error, /a number/);
  assert.match(s.set('nope', 1).error, /not a setting/);
  assert.strictEqual(s.set('listenOnNetwork', false).restart, true, 'said to need a restart');
  assert.strictEqual(s.get('listenOnNetwork'), false);
  s.set('maxFileGB', null);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'bridge_config.json'), 'utf8'));
  assert.ok(!('maxFileGB' in cfg), 'null puts the default back');
  assert.strictEqual(cfg.other, 1, 'other keys are kept');
  assert.ok(s.list().every(x => x.label && x.help && 'value' in x), 'every setting says what it is');
  console.log('ok 1/1 settings');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
