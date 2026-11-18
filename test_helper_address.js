'use strict';
// node test_helper_address.js — a helper's post that names nobody goes to its lead, and answers
// the lead's open question; a post that names someone, replies, or goes elsewhere is left alone.
const assert = require('assert');
const { toLead } = require('./helper-address');

const boss = { lead: 'c:/work/app', room: 'app-helper' };
const base = { boss, mine: 'gem-1', toSession: '', replyTo: null, namedRoom: '', square: false, roomName: 'App + helper',
               same: (a, b) => a === b };
const ask = (id, extra) => Object.assign({ id, fromSession: 'c:/work/app', toSession: 'gem-1', status: 'question' }, extra || {});
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok ' + name); };

t('to "all" in its own room, the lead waiting on #6227: to the lead, as the reply to #6227', () => {
  const r = toLead(Object.assign({}, base, { toSession: 'all', namedRoom: 'app-helper', recent: [ask(6227)] }));
  assert.deepStrictEqual(r, { toSession: 'c:/work/app', replyTo: 6227 });
});
t('the room named by its name works the same', () => {
  assert.strictEqual(toLead(Object.assign({}, base, { namedRoom: 'App + helper', recent: [] })).toSession, 'c:/work/app');
});
t('a question the helper already answered is not answered again', () => {
  const r = toLead(Object.assign({}, base, { recent: [ask(10), { id: 11, fromSession: 'gem-1', status: 'answer' }] }));
  assert.deepStrictEqual(r, { toSession: 'c:/work/app', replyTo: null });
});
t('the lead\'s question to another window is not this helper\'s to answer', () => {
  const r = toLead(Object.assign({}, base, { recent: [ask(12, { toSession: 'gem-2' })] }));
  assert.strictEqual(r.replyTo, null);
});
t('a named addressee, a reply, another room or the Square: left as written', () => {
  assert.strictEqual(toLead(Object.assign({}, base, { toSession: 'human/web' })), null);
  assert.strictEqual(toLead(Object.assign({}, base, { replyTo: 5 })), null);
  assert.strictEqual(toLead(Object.assign({}, base, { namedRoom: 'other-room' })), null);
  assert.strictEqual(toLead(Object.assign({}, base, { square: true })), null);
  assert.strictEqual(toLead(Object.assign({}, base, { boss: null })), null, 'not a helper');
});
console.log(n + '/5 passed');
