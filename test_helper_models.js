'use strict';
// node test_helper_models.js — a helper's model and effort: the list Antigravity reports is read
// into families and efforts, a lead's wish (model, effort, kind of work) is resolved against it,
// and a message on a chosen model waits for a busy helper and then asks for that model. The
// application is a fake local server here; nothing live is touched.
const assert = require('assert');
const http = require('http');
const models = require('./helper-models');
const api = require('./antigravity-api');

const cfg = (label, id, name, extra) => Object.assign({ label, modelId: id, modelOrAlias: { model: name } }, extra || {});
const configs = [
  cfg('Gemini 4 Hydrogen (High)', 'gemini-4-hydrogen-high', 'M525', { quotaInfo: { remainingFraction: 0.8 } }),
  cfg('Gemini 4 Hydrogen (XHigh)', 'gemini-4-hydrogen-xhigh', 'M528'),
  cfg('Gemini 4 Hydrogen (Medium)', 'gemini-4-hydrogen-medium', 'M526'),
  cfg('Gemini 4 Hydrogen (Low)', 'gemini-4-hydrogen-low', 'M527'),
  cfg('Gemini 3.8 Flash (High)', 'gemini-3.8-flash-high', 'M318'),
  cfg('Gemini 3.8 Flash (Medium)', 'gemini-3.8-flash-medium', 'M319'),
  cfg('Gemini 3.8 Flash (Low)', 'gemini-3.8-flash-low', 'M320'),
  cfg('Claude Opus 4.6 (Thinking)', 'claude-opus-4-6-thinking', 'M26'),
  cfg('Gemini 4 Argon', 'gemini-4-argon-disabled', 'M421', { disabled: true })
];
let n = 0;
const t = (name, fn) => Promise.resolve(fn()).then(() => { n++; console.log('ok ' + name); });

(async () => {
  const list = models.fromConfigs(configs);
  const pick = w => { const r = models.resolve(list, w); return r.error ? 'ERR ' + r.error : r.model.id; };

  await t('the list: usable models only, family and effort from the label', () => {
    assert.strictEqual(list.length, 7, 'a disabled model is left out, and so is one not of Google\'s own');
    assert.deepStrictEqual(models.parseLabel('Gemini 4 Hydrogen (XHigh)'), { family: 'gemini 4 hydrogen', effort: 'xhigh' });
    assert.deepStrictEqual(models.parseLabel('Claude Opus 4.6 (Thinking)'), { family: 'claude opus 4.6 (thinking)', effort: '' });
  });
  await t('family and effort: exact, the least for "minimal", the nearest below for one the family lacks', () => {
    assert.strictEqual(pick({ model: 'hydrogen', effort: 'medium' }), 'gemini-4-hydrogen-medium');
    assert.strictEqual(pick({ model: 'hydrogen', effort: 'minimal' }), 'gemini-4-hydrogen-low');
    assert.strictEqual(pick({ model: 'flash', effort: 'xhigh' }), 'gemini-3.8-flash-high');
    assert.strictEqual(pick({ model: 'hydrogen' }), 'gemini-4-hydrogen-medium', 'no effort named: medium');
    assert.strictEqual(pick({ model: 'gemini-3.8-flash-low' }), 'gemini-3.8-flash-low', 'an exact id stays as it is');
    assert.strictEqual(pick({ model: 'gemini-3.8-flash-low', effort: 'high' }), 'gemini-3.8-flash-high', 'an id with an effort: its family');
  });
  await t('the owner\'s kinds of work (24.11): taps least, translation Flash medium, code and analysis medium, big analysis high', () => {
    assert.strictEqual(pick({ kind: 'ui' }), 'gemini-3.8-flash-low');
    assert.strictEqual(pick({ kind: 'translate' }), 'gemini-3.8-flash-medium');
    assert.strictEqual(pick({ kind: 'code' }), 'gemini-4-hydrogen-medium');
    assert.strictEqual(pick({ kind: 'analysis' }), 'gemini-4-hydrogen-medium');
    assert.strictEqual(pick({ kind: 'deep' }), 'gemini-4-hydrogen-high');
    assert.strictEqual(pick({ kind: 'translate', effort: 'minimal' }), 'gemini-3.8-flash-low', 'a short translation');
    assert.strictEqual(pick({ kind: 'code', model: 'flash' }), 'gemini-3.8-flash-medium', 'the lead\'s model wins over the kind\'s');
  });
  await t('what is not there is refused with the list, never guessed', () => {
    assert.match(pick({ model: 'neon' }), /^ERR no usable model "neon".*Hydrogen \(low, medium, high, xhigh\), 80 % quota left/);
    assert.match(pick({ model: 'gemini' }), /^ERR "gemini" names several models/);
    assert.match(pick({ model: 'claude-opus-4-6-thinking' }), /^ERR .* is not a Google model/, 'Claude in Antigravity: refused (owner, 24.11)');
    assert.match(pick({ model: 'sonnet', effort: 'low' }), /not a Google model/);
    assert.match(pick({ model: 'gpt-oss-120b-medium' }), /not a Google model/);
    assert.ok(!/Claude|GPT/.test(models.describe(list)), 'nor offered in the list a lead sees');
    assert.match(pick({ model: 'hydrogen', effort: 'turbo' }), /^ERR unknown effort/);
    assert.match(pick({ kind: 'poetry' }), /^ERR unknown kind/);
    assert.match(models.describe(list), /Kinds of work: ui = flash minimal/);
  });

  await t('a pair is checked: a helper found on Claude is recorded on Hydrogen medium, one on Flash kept', async () => {
    const quota = require('./antigravity-quota');
    const realCall = quota.call, realLast = api.lastModel;
    const all = configs.concat([cfg('Claude Sonnet 4.6 (Thinking)', 'claude-sonnet-4-6', 'M35')]);
    let on = 'M35';
    quota.call = async () => ({ userStatus: { cascadeModelConfigData: { clientModelConfigs: all } } });
    api.lastModel = async () => on;
    try {
      let c = await models.check('conv-x');
      assert.strictEqual(c.id, 'gemini-4-hydrogen-medium');
      assert.strictEqual(c.seen, 'Claude Sonnet 4.6 (Thinking)');
      assert.match(c.note, /not a Google model .* Gemini 4 Hydrogen \(Medium\) from now on/);
      on = 'M319';
      c = await models.check('conv-x');
      assert.deepStrictEqual([c.id, c.own], ['gemini-3.8-flash-medium', 'gemini-3.8-flash-medium']);
      on = '';
      c = await models.check('conv-x');
      assert.strictEqual(c.id, 'gemini-4-hydrogen-medium', 'no answer yet: Hydrogen medium');
    } finally { quota.call = realCall; api.lastModel = realLast; }
  });

  // ── delivery on a chosen model ──
  let state = 'running', polls = 0;
  const sent = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      const method = req.url.split('/').pop();
      if (method === 'GetAllCascadeTrajectories') {
        if (++polls >= 3) state = 'idle';
        res.end(JSON.stringify({ trajectorySummaries: { 'conv-1': { status: state === 'running' ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE' } } }));
      } else if (method === 'GetCascadeTrajectory') {
        res.end(JSON.stringify({ trajectory: { steps: [{ metadata: { generatorModel: 'M26' } }, { metadata: {} }, { metadata: { generatorModel: 'M319' } }, {}] } }));
      } else if (method === 'SendUserCascadeMessage') {
        sent.push(JSON.parse(b)); res.end('{}');
      } else { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const where = { exe: 'none', env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:' + srv.address().port, ANTIGRAVITY_CSRF_TOKEN: 'tok' } };
  try {
    await t('a busy helper is waited for, then the message asks for the chosen model', async () => {
      await api.sendAs('conv-1', 'hello', 'M526', { where, pollMs: 20, waitMs: 5000 });
      assert.ok(polls >= 3, 'it asked until the conversation was idle');
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].cascadeId, 'conv-1');
      assert.strictEqual(sent[0].items[0].text, 'hello');
      assert.strictEqual(sent[0].cascadeConfig.plannerConfig.requestedModel.model, 'M526');
    });
    await t('the model a conversation really runs on: its latest step that names one', async () => {
      assert.strictEqual(await api.lastModel('conv-1', where), 'M319');
    });
    await t('two messages to one helper go one after the other, in order', async () => {
      sent.length = 0;
      await Promise.all([api.sendAs('conv-1', 'a', 'M527', { where, pollMs: 20 }), api.sendAs('conv-1', 'b', 'M525', { where, pollMs: 20 })]);
      assert.deepStrictEqual(sent.map(x => x.items[0].text + ':' + x.cascadeConfig.plannerConfig.requestedModel.model), ['a:M527', 'b:M525']);
    });
    await t('the sender\'s pick for one message wins; otherwise the lead\'s standing choice when it differs', () => {
      // A copy of the code in a temporary folder: the board database lives beside the code.
      const fs = require('fs'), os = require('os'), path = require('path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-models-'));
      try {
        for (const f of fs.readdirSync(__dirname)) if (/\.js$/.test(f) && !/^test_/.test(f)) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
        const db = require(path.join(dir, 'bridge-db.js'));
        const wake = require(path.join(dir, 'wake-antigravity.js'));
        db.setHelper('conv-h', 'c:/work/app', 'r1');
        db.setHelperModel('conv-h', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-medium');
        assert.deepStrictEqual(wake.modelFor('conv-h', {}), { model: 'gemini-4-hydrogen-medium' },
          'still on the model it began on: named all the same, so the picker in Antigravity cannot move it (owner, 24.11)');
        db.setHelperModel('conv-h', 'gemini-3.8-flash-low');
        assert.deepStrictEqual(wake.modelFor('conv-h', {}), { model: 'gemini-3.8-flash-low' });
        assert.strictEqual(db.readHelpers()[0].own_model, 'gemini-4-hydrogen-medium', 'the model it began on is kept');
        assert.deepStrictEqual(wake.modelFor('conv-h', { modelWant: { effort: 'high' } }), { effort: 'high' });
        assert.strictEqual(wake.modelFor('not-a-helper', {}), null, 'nobody\'s helper: its own model');
        db.setHelper('conv-c', 'c:/work/app', 'r2');
        db.setHelperModel('conv-c', 'claude-sonnet-4-6', 'claude-sonnet-4-6');
        assert.deepStrictEqual(wake.modelFor('conv-c', {}), { model: 'hydrogen', effort: 'medium' }, 'begun on Claude: answered on Hydrogen');
        try { db.getDb().close(); } catch (_) {}
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      }
    });
  } finally {
    srv.close();
  }
  console.log(n + '/9 passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
