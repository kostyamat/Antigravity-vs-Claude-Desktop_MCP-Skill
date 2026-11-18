'use strict';
// node test_quota_watch.js — what the board knows of Claude's limits, the supervisor's quota
// ticker (Gemini: warn at 30 %, stop at 15 %, sooner at the pace; Claude: 25 % and 12 %, or sooner at the pace it is spent;
// go on when the limit is back or at the owner's word), and the rescue of a session
// that was cut off into its project's slice.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'abqw-'));
process.env.BRIDGE_RUN_DIR = path.join(home, 'run');
process.env.USERPROFILE = home;
const claudeQuota = require('./claude-quota');
const { createQuotaWatch, RESUME_WORD } = require('./quota-watch');
const rescue = require('./rescue');
const alertLib = require('./alert');
let n = 0;
const t = (name, fn) => Promise.resolve(fn()).then(() => { n++; console.log('ok ' + name); });

(async () => {
  try {
    // ── what the board knows of Claude's limits ──
    const soon = new Date(Date.now() + 3600e3).toISOString();
    const result = { plan: { status: 'ok', plan: 'Pro', windows: [
      { label: '5-hour limit', percentUsed: 59, resetsAt: soon }, { label: 'Weekly · all models', percentUsed: 93, resetsAt: soon }] },
      context: { tokensUsed: 288000, contextWindow: 1000000, autoCompactsAtPercent: 97 } };
    await t('get_usage is understood as an object and as text around JSON', () => {
      assert.strictEqual(claudeQuota.parseUsage(result).windows.length, 2);
      assert.strictEqual(claudeQuota.parseUsage('Here: ' + JSON.stringify(result) + ' done').context.size, 1000000);
      assert.strictEqual(claudeQuota.parseUsage('nothing'), null);
      assert.strictEqual(claudeQuota.parseUsage({ plan: { status: 'unavailable' } }), null);
    });
    await t('a window is asked once, and not again after it reported', () => {
      assert.strictEqual(claudeQuota.shouldAsk('acc-1'), true);
      assert.strictEqual(claudeQuota.shouldAsk('acc-1'), false, 'another window is not asked a minute later');
      claudeQuota.report({ account: 'acc-1', win: 'local_w1', usage: claudeQuota.parseUsage(result) });
      assert.strictEqual(claudeQuota.shouldAsk('acc-1'), false);
      assert.strictEqual(claudeQuota.shouldAsk(''), false, 'no account, nobody to ask about');
    });
    await t('two measurements give the pace, and the figure is read as what it has become', () => {
      const all = JSON.parse(fs.readFileSync(path.join(home, 'run', 'claude_usage.json'), 'utf8'));
      const ago = m => new Date(Date.now() - m * 60000).toISOString();
      all.accounts['acc-r'] = { at: ago(10), windows: [{ label: '5-hour limit', used: 60, resetsAt: soon }],
                                prev: { at: ago(20), windows: [{ label: '5-hour limit', used: 50, resetsAt: soon }] } };
      fs.writeFileSync(path.join(home, 'run', 'claude_usage.json'), JSON.stringify(all));
      const w = claudeQuota.read().find(x => x.account === 'acc-r').worst;
      assert.strictEqual(w.measured, 40);
      assert.strictEqual(w.rate, 1, 'one per cent a minute');
      assert.strictEqual(w.left, 30, 'ten minutes later at that pace');
    });
    await t('the limit message names the reset; the same exhaustion seen twice is one event', () => {
      assert.match(claudeQuota.resetFromText("You've hit your 5-hour limit · resets 10pm (Europe/Madrid)", new Date(2026, 10, 17, 21, 7)),
        new RegExp('^' + new Date(2026, 10, 17, 22, 0).toISOString()));
      assert.strictEqual(claudeQuota.resetFromText('rate_limit'), '');
      claudeQuota.exhausted({ account: 'acc-x', win: 'w1', why: 'hit your 5-hour limit · resets 11pm' });
      const first = claudeQuota.read().find(x => x.account === 'acc-x').exhausted;
      claudeQuota.exhausted({ account: 'acc-x', win: 'w2', why: 'hit your 5-hour limit · resets 11pm' });
      assert.strictEqual(claudeQuota.read().find(x => x.account === 'acc-x').exhausted.at, first.at);
      claudeQuota.clearExhausted('acc-x');
      assert.strictEqual(claudeQuota.read().find(x => x.account === 'acc-x').exhausted, null);
    });
    await t('the worst window comes first, as per cent left', () => {
      const a = claudeQuota.read().find(x => x.account === 'acc-1');
      assert.strictEqual(a.worst.label, 'Weekly · all models');
      assert.strictEqual(a.worst.left, 7);
      assert.strictEqual(claudeQuota.sessions()[0].percent, 29);
    });
    await t('a limit whose reset time has passed is not counted', () => {
      const past = new Date(Date.now() - 60000).toISOString();
      claudeQuota.report({ account: 'acc-2', win: 'w', usage: { windows: [{ label: '5-hour limit', used: 99, resetsAt: past }], plan: '' } });
      assert.strictEqual(claudeQuota.read().find(x => x.account === 'acc-2').worst, null);
    });
    await t('a turn that ended on the limit marks the account, until it is measured again', () => {
      claudeQuota.exhausted({ account: 'acc-3', win: 'w', why: 'hit your 5-hour limit' });
      assert.ok(claudeQuota.read().find(x => x.account === 'acc-3').exhausted);
    });
    await t('the status line gives the same figures', () => {
      const u = claudeQuota.fromStatusline({ rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1900000000 } },
        context_window: { context_window_size: 200000, used_percentage: 50 } });
      assert.strictEqual(u.windows[0].label, '5-hour limit');
      assert.strictEqual(u.context.tokens, 100000);
    });

    // ── the ticker ──
    const said = [], shown = [];
    let cfg = { conversation: 'conv-1', room: 'supervisor' };
    const rows = [];                                   // messages the fake database returns
    const active = new Set(['gem-1']);                 // helpers that spoke lately
    const bridgeDb = {
      readHelpers: () => [{ helper: 'gem-1', lead: 'c:/work/app', room: 'r1' }, { helper: 'gem-2', lead: 'c:/work/app', room: 'r2' },
                          { helper: 'gem-3', lead: 'c:/work/app', room: '' }],
      lineOf: id => ({ local_a1: 'c:/work/app', local_a2: 'c:/work/app', local_b1: 'c:/work/b' })[id] || '',
      getDb: () => ({ prepare: sql => ({
        get: id => (/MAX\(ts\)/.test(sql) ? { t: active.has(id) ? 'now' : null } : null),
        all: () => rows.slice() }) })
    };
    const cardsLib = { claudeCardsEverywhere: () => [
      { id: 'local_a1', account: 'acc-1', activeAt: new Date().toISOString() },
      { id: 'local_a2', account: 'acc-1', activeAt: new Date().toISOString() },
      { id: 'local_b1', account: 'acc-1', activeAt: new Date(Date.now() - 9 * 3600e3).toISOString() },   // long idle
      { id: 'local_c1', account: 'acc-9', activeAt: new Date().toISOString() }] };                       // another account
    const router = { agentOf: () => 'Gemini', nameOf: s => 'N:' + s, leadOf: () => null };
    let pool = { remaining: 0.5, reset: 'R1', labels: ['Pro', 'Flash'], stale: false };
    const gemini = { read: async () => ({ account: ['owner', 'example.org'].join('@'), pools: [pool] }), remember: () => ({}),
                     alternatives: () => [], poolName: p => p.labels.join(', ') };
    let claudeNow = [];
    const watch = createQuotaWatch({ bridgeDb, cardsLib, router, gemini, claude: { read: () => claudeNow },
      say: m => { said.push(m); return said.length; }, alert: { t: alertLib.t, when: () => 'soon', show: (h, l) => { shown.push({ h, l }); return ''; } },
      config: () => cfg, save: p => { cfg = Object.assign({}, cfg, p); return cfg; }, isHuman: s => /^human/.test(s) });
    const to = who => said.filter(m => m.toSession === who);

    await t('plenty left: nothing is said and nothing is shown', async () => {
      await watch.tick('supervisor');
      assert.strictEqual(said.length + shown.length, 0);
    });
    await t('25 % of Gemini: the owner is warned once, nobody is stopped', async () => {
      pool = Object.assign({}, pool, { remaining: 0.25 });
      cfg.geminiPace = null;
      await watch.tick('supervisor');
      assert.strictEqual(shown.length, 1);
      assert.strictEqual(to('human/web').length, 1);
      assert.strictEqual(to('gem-1').length, 0);
      await watch.tick('supervisor');
      assert.strictEqual(shown.length, 1, 'not warned twice for the same level');
    });
    await t('12 % of Gemini: working helpers are stopped, their lead is told, the owner is asked to switch', async () => {
      pool = Object.assign({}, pool, { remaining: 0.12 });
      const r = await watch.tick('supervisor');
      assert.strictEqual(r.gemini.stopped, 1);
      assert.match(to('gem-1')[0].text, /STOP/);
      assert.strictEqual(to('gem-1')[0].room, 'r1');
      assert.strictEqual(to('gem-2').length, 0, 'a helper silent for hours is not woken to be stopped');
      assert.strictEqual(to('c:/work/app').length, 1);
      assert.strictEqual(cfg.paused.gemini.helpers.length, 1);
      assert.strictEqual(shown.length, 2);
      assert.match(to('human/web').pop().text, /The leads go on working/);
      assert.match(to('c:/work/app')[0].text, /do NOT take them over/, 'the lead neither stops nor takes over the helper\'s work');
      assert.strictEqual(to('c:/work/app')[0].priority, 'fyi', 'and is not woken for it');
    });
    await t('the owner\'s word in the supervisor room sets them going again', async () => {
      rows.push({ id: 7, message: 'thanks', from_session: 'human/web', room: 'supervisor' });
      assert.strictEqual((await watch.tick('supervisor', { wordsOnly: true })).resumed, null, 'any word is not the word');
      rows.push({ id: 8, message: alertLib.words('resume')[3] + ' gemini', from_session: 'human/web', room: 'supervisor' });
      const r = await watch.tick('supervisor', { wordsOnly: true });
      assert.strictEqual(r.resumed.by, 8);
      assert.match(to('gem-1').pop().text, /go on/);
      assert.match(to('c:/work/app').pop().text, /your helper is back: "N:gem-1"/, 'the lead is told its helper is back');
      assert.strictEqual(cfg.paused.gemini, undefined);
      assert.ok(RESUME_WORD.test('Resume') && !RESUME_WORD.test('do not resume yet'));
    });
    await t('the Antigravity quota coming back sets the helpers going without a word', async () => {
      rows.length = 0;                                 // no word of the owner's this time
      pool = Object.assign({}, pool, { remaining: 0.04 });
      cfg.quotaLevel = {};
      await watch.tick('supervisor');
      assert.ok(cfg.paused.gemini);
      cfg.paused.gemini.at = new Date(Date.now() - 120000).toISOString();
      pool = Object.assign({}, pool, { remaining: 0.9 });
      const r = await watch.tick('supervisor');
      assert.ok(r.gemini.recovered && r.gemini.recovered.length);
      assert.match(to('gem-1').pop().text, /quota is back — go on/);
      assert.strictEqual(cfg.paused.gemini, undefined);
    });
    await t('Gemini at its pace: 40 % falling 2 % a minute is a warning, 20 % falling 3 % a minute a stop', () => {
      assert.strictEqual(watch.level(40, 0), 0);
      assert.strictEqual(watch.level(40, 2), 1, '40 - 2*20 = 0: the stop line within 20 minutes');
      assert.strictEqual(watch.level(20, 3), 2, '20 - 3*8 = -4: gone within 8 minutes');
      assert.strictEqual(watch.level(14, 0), 2);
    });
    await t('Claude is warned at 25 %, or sooner when the pace would reach the stop within 20 minutes', () => {
      assert.strictEqual(watch.claudeLevel({ left: 40, rate: 0 }), 0);
      assert.strictEqual(watch.claudeLevel({ left: 24, rate: 0 }), 1);
      assert.strictEqual(watch.claudeLevel({ left: 40, rate: 1.5 }), 1, '40 - 30 = 10: under the stop within 20 minutes');
      assert.strictEqual(watch.claudeLevel({ left: 12, rate: 0 }), 2);
    });
    await t('20 % of Claude: the leads of that account who are at work are told to save', async () => {
      pool = Object.assign({}, pool, { remaining: 0.9 });
      said.length = 0; shown.length = 0;
      claudeNow = [{ account: 'acc-1', stale: false, ageMin: 2, worst: { label: '5-hour limit', left: 20, resetsAt: soon } }];
      await watch.tick('supervisor');
      assert.strictEqual(to('c:/work/app').length, 1, 'one message per project, not per window');
      assert.match(to('c:/work/app')[0].text, /Stop heavy operations/);
      assert.strictEqual(to('c:/work/b').length, 0, 'an idle project is not disturbed');
      assert.strictEqual(shown.length, 1);
    });
    await t('below 12 % of Claude: told to stop; resume tells them to go on', async () => {
      claudeNow = [{ account: 'acc-1', stale: false, ageMin: 2, worst: { label: '5-hour limit', left: 3, resetsAt: soon } }];
      await watch.tick('supervisor');
      assert.match(to('c:/work/app').pop().text, /STOP/);
      assert.match(to('gem-1').pop().text, /Do NOT wait for it/, 'the stopped lead\'s helper carries on');
      assert.strictEqual(cfg.paused.claude.leads.length, 1);
      assert.deepStrictEqual(watch.resume('claude', 'supervisor'), ['1 lead(s)']);
      assert.match(to('c:/work/app').pop().text, /account was switched/);
      assert.strictEqual(cfg.paused.claude, undefined);
    });
    await t('after the owner\'s resume an exhausted limit does not stop the leads again a minute later', async () => {
      said.length = 0;
      let cleared = 0;
      const ex = { at: new Date().toISOString(), why: 'hit your 5-hour limit', resetsAt: soon };
      let now = [{ account: 'acc-1', stale: false, ageMin: 2, worst: null, exhausted: ex }];
      const w2 = createQuotaWatch({ bridgeDb, cardsLib, router, gemini, claude: { read: () => now, clearExhausted: () => { cleared++; now = []; } },
        say: m => { said.push(m); return said.length; }, alert: { t: alertLib.t, when: () => 'soon', show: () => '' },
        config: () => cfg, save: p => { cfg = Object.assign({}, cfg, p); return cfg; }, isHuman: s => /^human/.test(s) });
      await w2.tick('supervisor');
      assert.match(to('c:/work/app').pop().text, /STOP/);
      w2.resume('claude', 'supervisor');
      assert.strictEqual(cleared, 1, 'the mark is cleared');
      const before = to('c:/work/app').length;
      await w2.tick('supervisor');
      assert.strictEqual(to('c:/work/app').length, before, 'not stopped again');
    });
    await t('the stopped limit reaching its reset time sets the leads going without a word', async () => {
      said.length = 0;
      cfg.quotaLevel = {};
      claudeNow = [{ account: 'acc-1', stale: false, ageMin: 2, worst: { label: '5-hour limit', left: 3, rate: 0, resetsAt: soon } }];
      await watch.tick('supervisor');
      assert.ok(cfg.paused.claude);
      cfg.paused.claude.resetsAt = new Date(Date.now() - 1000).toISOString();
      claudeNow = [{ account: 'acc-1', stale: false, ageMin: 2, worst: null }];
      await watch.tick('supervisor');
      assert.match(to('c:/work/app').pop().text, /limit is back — go on/);
      assert.strictEqual(cfg.paused.claude, undefined);
    });
    await t('an old measurement is not acted on', async () => {
      said.length = 0;
      claudeNow = [{ account: 'acc-5', stale: true, ageMin: 300, worst: { label: '5-hour limit', left: 1, resetsAt: soon } }];
      await watch.tick('supervisor');
      assert.strictEqual(said.length, 0);
    });

    // ── a session cut off ──
    const proj = path.join(home, 'work', 'MyApp');
    fs.mkdirSync(path.join(proj, '.agents'), { recursive: true });
    const slice = path.join(proj, '.agents', 'HANDOFF.md');
    fs.writeFileSync(slice, '# Slice — MyApp\n\nThe lead\'s own words.\n');
    const line = o => JSON.stringify(o) + '\n';
    const tr = path.join(home, 'session.jsonl');
    const head = line({ type: 'user', message: { content: 'port the parser to the new format' } }) +
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Parser ported, running the tests now' },
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] } });
    await t('a turn that stops inside a tool call is cut off; one that ends in words is not', () => {
      fs.writeFileSync(tr, head);
      const e = rescue.ending(tr);
      assert.ok(e.cut && !e.certain);
      assert.match(e.inFlight, /Bash — npm test/);
      assert.strictEqual(e.lastOwner, 'port the parser to the new format');
      fs.writeFileSync(tr, head + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } }) +
        line({ type: 'assistant', message: { content: [{ type: 'text', text: 'All green. Done.' }] } }));
      assert.strictEqual(rescue.ending(tr).cut, false);
    });
    await t('a turn that ends on the limit is cut off for certain', () => {
      fs.writeFileSync(tr, head + line({ type: 'assistant', isApiErrorMessage: true,
        message: { content: [{ type: 'text', text: 'You\'ve hit your 5-hour limit · resets 6:50am' }] } }));
      const e = rescue.ending(tr);
      assert.ok(e.cut && e.certain);
      assert.match(e.why, /5-hour limit/);
    });
    await t('it is written at the top of the slice, the lead\'s words untouched, and replaced, not repeated', () => {
      const r = rescue.rescueProject(proj, { transcript: tr, force: true });
      assert.ok(r.written);
      let s = fs.readFileSync(slice, 'utf8');
      assert.ok(s.startsWith('# Slice — MyApp\n\n' + rescue.START));
      assert.match(s, /port the parser to the new format/);
      assert.match(s, /The lead's own words\./);
      assert.strictEqual(rescue.rescueProject(proj, { transcript: tr, force: true, seen: r.key }), null, 'the same ending is not written twice');
      const future = Date.now() / 1000 + 5;
      fs.utimesSync(tr, future, future);
      rescue.rescueProject(proj, { transcript: tr, force: true, why: 'the usage limit was reached' });
      s = fs.readFileSync(slice, 'utf8');
      assert.strictEqual(s.split(rescue.START).length, 2, 'one block');
      assert.match(s, /the usage limit was reached/);
    });
    await t('a transcript that may still be working, or a slice written after it, is left alone', () => {
      assert.strictEqual(rescue.rescueProject(proj, { transcript: tr }), null, 'young transcript');
      const old = Date.now() / 1000 - 3 * 3600;
      fs.utimesSync(tr, old, old);
      assert.strictEqual(rescue.rescueProject(proj, { transcript: tr }), null, 'the slice is newer than the transcript');
      fs.utimesSync(slice, old - 600, old - 600);
      assert.ok(rescue.rescueProject(proj, { transcript: tr }).written);
    });
    console.log(n + '/24 passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
})();
