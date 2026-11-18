'use strict';
// node test_context_guard.js — the context a session carries, read from its transcript, and the
// steps (80, 88, 94 %) at which the Stop hook has it save; a compaction starts the steps again.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const g = require('./context-guard');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-ctx-'));
const tr = path.join(dir, 'session.jsonl');
const turn = (tokens, extra) => JSON.stringify(Object.assign({ type: 'assistant', message: { model: 'claude-opus-5-5',
  usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: tokens - 1002, output_tokens: 300 } } }, extra || {})) + '\n';
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok ' + name); };

t('the newest main-thread turn gives the fill; a subagent\'s turn is not the session\'s', () => {
  fs.writeFileSync(tr, turn(500000) + turn(900000, { isSidechain: true }) + '{"type":"user"}\n');
  const f = g.fill(tr);
  assert.deepStrictEqual([f.tokens, f.size, f.pct], [500000, 1000000, 50]);
});
t('a model outside the 5 family has a 200k window', () => {
  assert.strictEqual(g.windowOf('claude-3-7-sonnet'), 200000);
  assert.strictEqual(g.windowOf('anything', 400000), 400000, 'a size the session reported wins');
});
t('each step holds the session once; the same step does not again', () => {
  const run = path.join(dir, 'run');
  assert.strictEqual(g.due(run, 'local_w', { pct: 70 }), 0);
  assert.strictEqual(g.due(run, 'local_w', { pct: 81 }), 80);
  assert.strictEqual(g.due(run, 'local_w', { pct: 84 }), 0, 'still the 80 step');
  assert.strictEqual(g.due(run, 'local_w', { pct: 89 }), 88);
  assert.strictEqual(g.due(run, 'local_w', { pct: 95 }), 94);
  assert.match(g.text({ pct: 95, tokens: 950000, size: 1000000 }), /HANDOFF\.md.*last warning/);
});
t('a compaction empties the context: the steps start again', () => {
  const run = path.join(dir, 'run');
  assert.strictEqual(g.due(run, 'local_w', { pct: 20 }), 0);
  assert.strictEqual(g.due(run, 'local_w', { pct: 82 }), 80);
});
t('no transcript, no fill', () => {
  assert.strictEqual(g.fill(''), null);
  assert.strictEqual(g.fill(path.join(dir, 'none.jsonl')), null);
});
fs.rmSync(dir, { recursive: true, force: true });
console.log(n + '/5 passed');
