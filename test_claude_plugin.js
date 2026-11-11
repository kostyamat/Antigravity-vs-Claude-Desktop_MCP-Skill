'use strict';
// node test_claude_plugin.js — the plugin files and the move out of settings.json.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('./claude-plugin');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok ' + name); };

const hooks = cp.bridgeHooks({ nodeExe: 'C:/node/node.exe', scriptsDir: path.join('X:', 'bridge'), pyCmd: 'python' });

t('eight hooks, five events', () => {
  assert.strictEqual(hooks.length, 8);
  const j = cp.hooksJson(hooks).hooks;
  assert.deepStrictEqual(Object.keys(j).sort(), ['PreCompact', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  assert.strictEqual(j.SessionStart.length, 3);
  assert.strictEqual(j.SessionStart[1].matcher, 'compact');
  assert.strictEqual(j.PreToolUse[0].matcher, 'mcp__agent-bridge__.*');
  assert.ok(j.Stop[1].hooks[0].asyncRewake);
  assert.ok(!JSON.stringify(j).includes('\\\\'), 'commands use forward slashes');
});

t('the two watch hooks are separate objects', () => {
  const w = hooks.filter(h => h.needle.endsWith('watch'));
  assert.strictEqual(w.length, 2);
  assert.notStrictEqual(w[0].hook, w[1].hook);
});

t('strip takes only bridge hooks, keeps the user\'s own', () => {
  const settings = { hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: 'python "D:/old/board_brief.py"' }] },
      { matcher: 'compact', hooks: [{ type: 'command', command: 'python "D:/old/after_compact.py"' }] },
      { hooks: [{ type: 'command', command: 'my-own-start' }] }
    ],
    UserPromptSubmit: [{ hooks: [
      { type: 'command', command: 'python board_brief.py --prompt' },
      { type: 'command', command: 'mine-too' }
    ] }],
    Stop: [{ hooks: [{ type: 'command', command: '"n" "D:/old/bridge-hook.js" stop' }] },
           { hooks: [{ type: 'command', command: '"n" "D:/old/bridge-hook.js" watch', async: true }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard-hook' }] }]
  } };
  const removed = cp.stripFromSettings(settings, hooks);
  assert.strictEqual(removed.length, 5);
  assert.deepStrictEqual(settings.hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'my-own-start' }] }]);
  assert.deepStrictEqual(settings.hooks.UserPromptSubmit[0].hooks.map(h => h.command), ['mine-too']);
  assert.ok(!('Stop' in settings.hooks));
  assert.strictEqual(settings.hooks.PreToolUse[0].hooks[0].command, 'guard-hook');
  assert.deepStrictEqual(cp.stripFromSettings(settings, hooks), [], 'second run removes nothing');
});

t('strip on settings without hooks', () => {
  assert.deepStrictEqual(cp.stripFromSettings({}, hooks), []);
});

t('writePlugin writes once, then reports up to date', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abplug-'));
  try {
    const a = cp.writePlugin(dir, hooks, '9.9.9');
    assert.deepStrictEqual(a, { manifest: true, hooks: true });
    const m = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.strictEqual(m.name, 'agent-bridge');
    assert.strictEqual(m.version, '9.9.9');
    assert.deepStrictEqual(m.skills, ['./']);
    assert.deepStrictEqual(cp.writePlugin(dir, hooks, '9.9.9'), { manifest: false, hooks: false });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(n + '/5 passed');
