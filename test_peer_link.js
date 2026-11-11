'use strict';
// node test_peer_link.js — the parts of the link between two boards that need no network:
// what counts as an address on another machine, and who is let in from outside.
// (Two real boards exchanging mail: .agents/tests, pl_test.)
const assert = require('assert');
const peerLink = require('./peer-link');

const cfg = { machineName: 'Laptop', peers: [
  { name: 'Desktop', url: 'http://192.168.1.50:8787' },
  { name: 'broken', url: 'not a url' },
  { name: '', url: 'http://192.168.1.60:8787' }] };
const none = { peers: [] };

// Who the neighbours are.
assert.deepStrictEqual(peerLink.peers(cfg).map(p => p.name + ' ' + p.url), ['desktop http://192.168.1.50:8787'], 'only a named machine with a real address');
assert.strictEqual(peerLink.machineName(cfg), 'laptop');
assert.strictEqual(peerLink.enabled(cfg), true);
assert.strictEqual(peerLink.enabled(none), false, 'no neighbour: the link is off');

// An address on another machine.
let a = peerLink.parseAddress('local_1234-abcd@desktop', cfg);
assert.deepStrictEqual([a.target, a.machine], ['local_1234-abcd', 'desktop'], 'a window there');
a = peerLink.parseAddress('wDSP@Desktop', cfg);
assert.deepStrictEqual([a.target, a.machine], ['wDSP', 'desktop'], 'a project there, machine name in any case');
assert.strictEqual(peerLink.parseAddress('wDSP@garage', cfg), null, 'a machine that is not linked is not an address');
assert.strictEqual(peerLink.parseAddress('someone@desktop', none), null, 'nor is anything while no machine is linked');
assert.strictEqual(peerLink.parseAddress('local_1234-abcd', cfg), null);
assert.strictEqual(peerLink.parseAddress('@desktop', cfg), null);
assert.strictEqual(peerLink.parseAddress('', cfg), null);

// Who is let in. The board's own machine: everything. A neighbour: its door only.
// Anybody else on the network: nothing, the door included.
const req = (addr, url) => ({ socket: { remoteAddress: addr }, url });
assert.ok(peerLink.admits(req('127.0.0.1', '/api/post'), cfg), 'this machine posts');
assert.ok(peerLink.admits(req('::1', '/api/board'), cfg));
assert.ok(peerLink.admits(req('::ffff:127.0.0.1', '/'), cfg));
assert.ok(peerLink.admits(req('192.168.1.50', '/api/peer/deliver'), cfg), 'the neighbour at its door');
assert.ok(peerLink.admits(req('::ffff:192.168.1.50', '/api/peer/hello'), cfg), 'the same over an IPv6 socket');
assert.ok(!peerLink.admits(req('192.168.1.50', '/api/post'), cfg), 'the neighbour cannot post as the owner');
assert.ok(!peerLink.admits(req('192.168.1.50', '/api/board'), cfg), 'nor read the whole board');
assert.ok(!peerLink.admits(req('192.168.1.50', '/api/shutdown'), cfg));
assert.ok(!peerLink.admits(req('192.168.1.50', '/'), cfg));
assert.ok(!peerLink.admits(req('192.168.1.77', '/api/peer/hello'), cfg), 'a stranger on the network, even at the door');
assert.ok(!peerLink.admits(req('192.168.1.77', '/api/peer/deliver'), cfg));
assert.ok(!peerLink.admits(req('192.168.1.50', '/api/peer/deliver'), none), 'nobody from outside while no machine is linked');
assert.ok(!peerLink.admits(req(undefined, '/api/peer/hello'), cfg), 'an address that cannot be read is nobody');

console.log('peer-link: all checks passed');
