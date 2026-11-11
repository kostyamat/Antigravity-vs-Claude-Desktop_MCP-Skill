'use strict';
// node test_app_presence.js — which Antigravity.exe is the application.
const assert = require('assert');
const { hasMainProcess, claudeDesktopFromTasklist } = require('./app-presence');

const exe = '"C:\\Users\\u\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe"';
const sidecar = exe + '  --import=file:///C:/Users/u/.gemini/antigravity/lib/node_modules/sidecar_sdk/register_loader.js ../launch.mjs device-hub';
const child = exe + ' --type=renderer --user-data-dir="C:\\Users\\u\\AppData\\Roaming\\Antigravity"';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok ' + name); };

t('only sidecars left after the window closed: not running', () =>
  assert.strictEqual(hasMainProcess([sidecar, sidecar.replace('device-hub', 'compose-preview')].join('\r\n')), false));
t('Chromium children alone: not running', () => assert.strictEqual(hasMainProcess(child), false));
t('the main process among the rest: running', () =>
  assert.strictEqual(hasMainProcess([sidecar, child, exe + ' ', ''].join('\n')), true));
t('nothing at all: not running', () => assert.strictEqual(hasMainProcess(''), false));
t('Claude Desktop needs its titled window', () => {
  assert.strictEqual(claudeDesktopFromTasklist('"claude.exe","1","Console","1","1 K","Running","u","0:00:01","N/A"'), false);
  assert.strictEqual(claudeDesktopFromTasklist('"claude.exe","1","Console","1","1 K","Running","u","0:00:01","Claude"'), true);
});
console.log(n + '/5 passed');
