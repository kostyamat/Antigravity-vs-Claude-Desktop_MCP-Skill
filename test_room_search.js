'use strict';
// node test_room_search.js — a room is found by its project, its task, its agent and its machine.
const assert = require('assert');
const { createRoomSearch, matches } = require('./room-search');

const lines = { local_a1: 'c:/work/radio', local_b1: 'c:/work/dsp' };
const cardsOf = {
  local_a1: { name: 'Fix the tuner', project: 'C:\\work\\Radio' },
  local_b1: { name: 'DSP presets', project: 'C:\\work\\DSP' },
  'gem-1': { name: 'radio: logo packs' }
};
const bridgeDb = {
  lineOf: c => lines[c] || '',
  lineMembers: c => Object.values(lines).includes(c) ? [{ member: 'x' }] : [],
  getDb: () => ({ prepare: () => ({ all: () => [{ room: 'r-dsp', machine: 'DeskPC' }] }) })
};
const router = {
  agentOf: c => (/^local_/.test(c) || c.startsWith('c:/') ? 'Claude' : 'Gemini'),
  nameOf: c => (lines[c] ? lines[c].split('/').pop() : (cardsOf[c] || {}).name || c),
  cardOf: c => cardsOf[c] || null
};
const rooms = [
  { id: 'r-radio', name: 'radio · logo packs', members: [{ card: 'local_a1', agent: 'Claude' }, { card: 'gem-1', agent: 'Gemini' }] },
  { id: 'r-dsp', name: 'DSP review', members: [{ card: 'c:/work/dsp', agent: 'Claude' }] },
  { id: 'r-far', name: 'Machine: deskpc', members: [{ card: 'unknown-remote', agent: '' }] }
];
const search = createRoomSearch({ bridgeDb, router, machineName: 'Laptop' });
const found = q => search.withFind(rooms).filter(r => matches(r.find, q)).map(r => r.id);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok ' + name); };

t('by project, plainly and exactly', () => {
  assert.deepStrictEqual(found('radio'), ['r-radio']);
  assert.deepStrictEqual(found('project:dsp'), ['r-dsp']);
  assert.deepStrictEqual(found('project:radio'), ['r-radio']);
});
t('by task: the room\'s name and the helper\'s title', () => {
  assert.deepStrictEqual(found('logo packs'), ['r-radio']);
  assert.deepStrictEqual(found('task:radio'), ['r-radio']);
  assert.deepStrictEqual(found('review'), ['r-dsp']);
});
t('by agent, in either of its names', () => {
  assert.deepStrictEqual(found('agent:antigravity'), ['r-radio']);
  assert.deepStrictEqual(found('gemini'), ['r-radio']);
  assert.deepStrictEqual(found('agent:claude'), ['r-radio', 'r-dsp']);
  const words = require('./locales/search.json');
  assert.deepStrictEqual(found(words.antigravity[2]), ['r-radio'], 'and in the owner\'s own language');
  assert.deepStrictEqual(found(words.claude[1]), ['r-radio', 'r-dsp']);
});
t('by machine: this one, a linked one by name, a linked one by the mail exchanged', () => {
  assert.deepStrictEqual(found('machine:laptop'), ['r-radio']);
  assert.deepStrictEqual(found('machine:deskpc'), ['r-dsp', 'r-far']);
});
t('every word must fit; nothing typed fits everything', () => {
  assert.deepStrictEqual(found('radio agent:claude machine:laptop'), ['r-radio']);
  assert.deepStrictEqual(found('radio machine:deskpc'), []);
  assert.strictEqual(found('').length, 3);
  assert.strictEqual(found('   ').length, 3);
});
t('a room\'s line is kept until its name or members change', () => {
  const first = search.withFind(rooms)[1].find;
  lines.local_b1 = 'c:/work/renamed';
  assert.strictEqual(search.withFind(rooms)[1].find, first, 'kept');
  const changed = rooms.map(r => r.id === 'r-dsp' ? Object.assign({}, r, { name: 'DSP review two' }) : r);
  assert.match(search.withFind(changed)[1].find, /review two/);
});
console.log(n + '/6 passed');
