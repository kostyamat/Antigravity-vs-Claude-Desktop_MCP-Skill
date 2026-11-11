'use strict';
// node test_wake_after_start.js — a message posted while Antigravity is closed is
// still delivered once the board has started it (owner, 11.11: the application
// opened, the supervisor never heard "are you alive?").
const assert = require('assert');
const path = require('path');

// The real antigravity-api reaches into the running client: replace it.
let up = false;
const sent = [];
const apiPath = require.resolve('./antigravity-api');
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: {
  locate() { if (!up) throw new Error('no csrf token on the language_server command line — is Antigravity running?'); return { exe: 'x', env: {} }; },
  send(conv, text) { sent.push({ conv, text }); }
} };

const { wakeAntigravity } = require('./wake-antigravity');
const conv = ['0f0e0d0c', '1111', '4222', '8333', '944455556666'].join('-');   // a made-up conversation id
const m = { id: 987654321, from: 'Owner', fromSession: 'human/web', to: 'Gemini', toSession: conv, room: 'supervisor', message: 'are you alive?' };

wakeAntigravity(m);                       // posted: Antigravity closed, nothing delivered
assert.strictEqual(sent.length, 0);
up = true;
wakeAntigravity(m);                       // the queued delivery after the start
assert.strictEqual(sent.length, 1, 'delivered once Antigravity is up');
assert.strictEqual(sent[0].conv, conv);
wakeAntigravity(m);                       // and only once
assert.strictEqual(sent.length, 1, 'not delivered twice');
console.log('ok 3/3');
