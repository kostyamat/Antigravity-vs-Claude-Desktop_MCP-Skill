'use strict';
// node test_project_line.js — a line named by hand is folded into its project's folder,
// and the lead of a pair is a project, never one window of it.
const assert = require('assert');
const pl = require('./project-line');

function board() {
  const lines = new Map([
    ['Claude App', ['local_a1', 'local_old', 'run-77', 'app-label']],     // named by hand, one live folder
    ['c:/work/app', ['local_a2']],                                         // the same project, by its folder
    ['Two Projects', ['local_b1', 'local_c1']],                            // joins two folders on purpose
    ['Ghosts', ['run-1', 'label-x']]                                       // nothing says where it lives
  ]);
  const helpers = [
    { helper: 'gem-1', lead: 'Claude App' },
    { helper: 'gem-2', lead: 'local_a2' },
    { helper: 'gem-3', lead: 'c:/work/other' }
  ];
  const sql = [];
  const db = {
    readLines: () => new Map([...lines].map(([l, ms]) => [l, ms.map(m => ({ member: m }))])),
    lineOf: m => { for (const [l, ms] of lines) if (ms.includes(m)) return l; return ''; },
    linkSessions: (line, members) => {
      for (const ms of lines.values()) for (const m of members) { const i = ms.indexOf(m); if (i >= 0) ms.splice(i, 1); }
      lines.set(line, (lines.get(line) || []).concat(members));
      for (const [l, ms] of [...lines]) if (!ms.length) lines.delete(l);
    },
    readHelpers: () => helpers.map(h => Object.assign({}, h)),
    getDb: () => ({ prepare: q => ({ run: (a, b) => {
      sql.push(q);
      if (/UPDATE helpers SET lead = \? WHERE lead = \?/.test(q)) for (const h of helpers) if (h.lead === b) h.lead = a;
      if (/UPDATE helpers SET lead = \? WHERE helper = \?/.test(q)) for (const h of helpers) if (h.helper === b) h.lead = a;
    } }) })
  };
  const cards = { claudeCardsEverywhere: () => [
    { id: 'local_a1', project: 'C:\\Work\\App', archived: false },
    { id: 'local_a2', project: 'C:\\Work\\App', archived: false },
    { id: 'local_old', project: 'C:\\Work\\Elsewhere', archived: true },   // archived: does not say where the project is
    { id: 'local_b1', project: 'C:\\Work\\B', archived: false },
    { id: 'local_c1', project: 'C:\\Work\\C', archived: false }
  ] };
  return { db, cards, lines, helpers };
}

// A dry run says what would happen and changes nothing.
let b = board();
let out = pl.foldNamedLines(b.db, b.cards, { dry: true });
assert.deepStrictEqual(out.filter(x => x.into).map(x => x.line + ' -> ' + x.into), ['Claude App -> c:/work/app']);
assert.strictEqual(out.filter(x => x.skipped).length, 2, 'the two it will not touch are named');
assert.ok(b.lines.has('Claude App'), 'nothing moved');

// Folding moves every member, the archived window and the labels included, and the pair follows.
b = board();
out = pl.foldNamedLines(b.db, b.cards);
assert.deepStrictEqual(out.map(x => x.line), ['Claude App']);
assert.ok(!b.lines.has('Claude App'), 'the named line is gone');
assert.deepStrictEqual(b.lines.get('c:/work/app').slice().sort(), ['app-label', 'local_a1', 'local_a2', 'local_old', 'run-77']);
assert.strictEqual(b.helpers[0].lead, 'c:/work/app', 'the helper of the named line is the helper of the project');
assert.ok(b.lines.has('Two Projects') && b.lines.has('Ghosts'), 'a line across folders, or with no known folder, is left alone');

// `only` touches one line.
b = board();
assert.deepStrictEqual(pl.foldNamedLines(b.db, b.cards, { only: 'Ghosts' }), []);
assert.ok(b.lines.has('Claude App'));

// The lead of a pair is the project of the window that was written down.
b = board();
out = pl.leadsToProjects(b.db);
assert.deepStrictEqual(out, [{ helper: 'gem-2', from: 'local_a2', to: 'c:/work/app' }]);
assert.strictEqual(b.helpers[1].lead, 'c:/work/app');
assert.strictEqual(b.helpers[2].lead, 'c:/work/other', 'a lead that is already a project stays');

console.log('project-line: all checks passed');
