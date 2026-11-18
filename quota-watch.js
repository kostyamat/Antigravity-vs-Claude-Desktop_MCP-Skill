'use strict';
// The supervisor's quota ticker: the rule half, no model involved.
//
// The owner, 16.11.2026: when the Gemini quota comes down to 10 % the supervisor
// warns; at 5 % it lists every helper, stops them and asks him to switch the account;
// after the switch, on his word on the board, it sets the helpers going again on the
// work they stopped at. The same for the Claude lead sessions: warned in time to drop
// heavy operations and save their context and documentation, stopped at 5 %, started
// again on his word. Every warning is put on his screen by the bridge's own window
// (alert.js) and written in the supervisor's room.
//
// No model is asked anything here. It could not be: the conversation that would do
// the reading runs on the very quota that is running out.

const WARN_LEFT = 10;          // per cent left: warn
const STOP_LEFT = 5;           // per cent left: stop the work, ask for another account
// Claude is warned and stopped earlier: its figure is a report, minutes old, and saving a
// lead's context costs a few per cent of its own — at 5 % there was no room left to save.
const CLAUDE_WARN_LEFT = 25;
const CLAUDE_STOP_LEFT = 12;
const CLAUDE_AHEAD_MIN = 20;   // at the pace measured, would the stop come within this? Then warn now.
const HELPER_ACTIVE_HOURS = 12;   // a helper silent longer than this is not at work: nothing to stop
const LEAD_ACTIVE_HOURS = 3;

// The owner's word, in the languages of the alert texts: the lists are kept with them
// (locales/quota-alert.json, `_words`), since this file holds English only.
const words = k => { try { return require('./alert').words(k); } catch (_) { return []; } };
const rx = (list, head) => new RegExp((head ? '^\\s*(' : '(') + list.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'i');
const RESUME_WORD = rx(['resume', 'continue'].concat(words('resume')), true);
const ONLY_GEMINI = rx(['gemini', 'antigravity', 'helper'].concat(words('gemini')));
const ONLY_CLAUDE = rx(['claude', 'lead'].concat(words('claude')));

function createQuotaWatch({ bridgeDb, cardsLib, router, say, alert, gemini, claude, config, save, isHuman }) {
  const pctLeft = f => Math.round(f * 100);
  const mask = acc => String(acc || '').replace(/^(.{2})[^@]*(@.*)$/, '$1…$2');
  const short = id => String(id || '').slice(0, 8);

  function level(left) { return left <= STOP_LEFT ? 2 : left <= WARN_LEFT ? 1 : 0; }
  function claudeLevel(w) {
    if (w.left <= CLAUDE_STOP_LEFT) return 2;
    return w.left <= CLAUDE_WARN_LEFT || w.left - (w.rate || 0) * CLAUDE_AHEAD_MIN <= CLAUDE_STOP_LEFT ? 1 : 0;
  }

  // One action per level per reset period per account.
  function due(kind, account, lvl, reset) {
    const told = (config().quotaLevel || {})[kind + ':' + account];
    return !(told && told.reset === (reset || '') && told.level >= lvl);
  }
  function mark(kind, account, lvl, reset) {
    const all = Object.assign({}, config().quotaLevel || {});
    all[kind + ':' + account] = { level: lvl, reset: reset || '', at: new Date().toISOString() };
    save({ quotaLevel: all });
  }

  // ── who is at work ───────────────────────────────────────────────────────────────────────

  // Helpers on record that have spoken lately, each with its room and its lead.
  function workingHelpers(now) {
    const since = new Date((now || Date.now()) - HELPER_ACTIVE_HOURS * 3600e3).toISOString();
    const out = [];
    let pairs = [];
    try { pairs = bridgeDb.readHelpers(); } catch (_) {}
    const db = bridgeDb.getDb();
    for (const h of pairs) {
      if (!h.room || router.agentOf(h.helper) !== 'Gemini') continue;
      let last = null;
      try { last = db.prepare('SELECT MAX(ts) t FROM messages WHERE from_session = ? AND ts > ?').get(h.helper, since); } catch (_) {}
      if (!last || !last.t) continue;
      out.push({ helper: h.helper, room: h.room, lead: h.lead, name: router.nameOf(h.helper), leadName: router.nameOf(h.lead) });
    }
    return out;
  }

  // Claude projects with a window of this account that worked lately: the leads.
  function workingLeads(account, now) {
    const t = now || Date.now();
    const lines = new Map();
    let cards = [];
    try { cards = cardsLib.claudeCardsEverywhere(); } catch (_) {}
    for (const c of cards) {
      if (c.archived || (account && c.account !== account)) continue;
      if (t - (Date.parse(c.activeAt || 0) || 0) > LEAD_ACTIVE_HOURS * 3600e3) continue;
      const line = bridgeDb.lineOf(c.id) || c.id;
      if (router.leadOf(c.id)) continue;                 // a Claude window that is somebody's helper is not a lead
      if (!lines.has(line)) lines.set(line, { line, name: router.nameOf(c.id), windows: [] });
      lines.get(line).windows.push(c.id);
    }
    return [...lines.values()];
  }

  // ── Gemini ───────────────────────────────────────────────────────────────────────────────

  async function watchGemini(room) {
    let q;
    try { q = await gemini.read(); } catch (e) { return { error: e.message }; }
    save({ quotaKnown: gemini.remember(config().quotaKnown, q) });
    const pool = q.pools.find(p => !p.stale);
    if (!pool) return { account: q.account, left: null };
    const left = pctLeft(pool.remaining), lvl = level(left);
    const res = { account: q.account, left, level: lvl, pools: q.pools };
    // Back: the quota refilled or another account is in — the helpers go on by themselves.
    const pg = (config().paused || {}).gemini;
    if (pg && !lvl && Date.parse(pg.at) < Date.now() - 60000) {
      res.recovered = resume('gemini', room, null, q.account !== pg.account ? 'the Antigravity account was switched' : 'the Antigravity quota is back');
    }
    if (!lvl || !due('gemini', q.account, lvl, pool.reset)) return res;

    const what = gemini.poolName(pool), acc = mask(q.account);
    const others = gemini.alternatives(config().quotaKnown, q.account).slice(0, 4)
      .map(a => `${mask(a.account)} — ${a.note}`).join('; ');
    const lines = [alert.t('left', { who: 'Gemini (Antigravity)', account: acc, left, what }), alert.t('resets', { when: alert.when(pool.reset) }), ''];
    if (lvl === 1) {
      lines.push(alert.t('next', { stop: STOP_LEFT }));
      say({ to: 'all', toSession: 'human/web', room, status: 'question',
        text: `Supervisor: Antigravity quota is at ${left} % for account ${acc} (${what}; resets ${pool.reset || 'time unknown'}). ` +
          `At ${STOP_LEFT} % I stop the helpers and ask you to switch the account.` + (others ? ` Other accounts: ${others}.` : '') });
    } else {
      const helpers = workingHelpers();
      for (const h of helpers) {
        say({ to: 'Gemini', toSession: h.helper, room: h.room, status: 'blocked',
          text: `Supervisor, for the owner: the Antigravity quota is at ${left} % — STOP. Finish only the step you are in, commit or save it, ` +
            'post here three lines — the task, what is done, the exact next step — and then wait. Start nothing new and answer no ' +
            'task until the board tells you the account was switched.' });
      }
      const byLead = new Map();
      for (const h of helpers) byLead.set(h.lead, (byLead.get(h.lead) || []).concat(h.name));
      for (const [lead, names] of byLead) {
        say({ to: 'Claude', toSession: lead, room, status: 'info',
          text: `Supervisor: Antigravity quota is at ${left} %. Your helper${names.length > 1 ? 's' : ''} ${names.map(n => '"' + n + '"').join(', ')} ` +
            'stop after the step in hand. You do NOT stop: carry on with your own work, and do yourself what cannot wait for them. ' +
            'They are set going again when the quota is back or the account is switched. Do not answer this.' });
      }
      const paused = Object.assign({}, config().paused || {});
      paused.gemini = { at: new Date().toISOString(), account: q.account, left, helpers, resetsAt: pool.reset || '' };
      save({ paused });
      const names = helpers.map(h => h.name).slice(0, 12).join(', ');
      if (helpers.length) lines.push(alert.t('helpers', { n: helpers.length, names }));
      lines.push(alert.t('switch', { who: 'Antigravity' }));
      say({ to: 'all', toSession: 'human/web', room, status: 'blocked',
        text: `Supervisor: Antigravity quota is at ${left} % for account ${acc} (${what}; resets ${pool.reset || 'time unknown'}). ` +
          (helpers.length ? `I stopped ${helpers.length} helper(s): ` + helpers.map(h => `"${h.name}" (of ${h.leadName}, room ${h.room})`).join('; ') + '. '
                          : 'No helper has been at work in the last hours, so nobody was stopped. ') +
          'The leads go on working. Switch the Antigravity account if you want the helpers back before the quota refills: I see it ' +
          'and set them going myself (writing "resume" here does it too).' + (others ? ` Other accounts: ${others}.` : '') });
      res.stopped = helpers.length;
    }
    const no = alert.show(alert.t('head'), lines);
    if (no) res.alertError = no;
    mark('gemini', q.account, lvl, pool.reset);
    return res;
  }

  // ── Claude ───────────────────────────────────────────────────────────────────────────────

  function watchClaude(room) {
    const out = [];
    for (const a of claude.read()) {
      const w = a.exhausted ? { label: a.exhausted.why || 'usage limit', left: 0, rate: 0, resetsAt: a.exhausted.resetsAt || '' } : a.worst;
      const pc = (config().paused || {}).claude;
      // Back: the stopped account's limit refilled (its reset time passed, or a measurement after
      // the stop shows enough) — the leads are told to go on without waiting for the owner's word.
      if (pc && pc.account === a.account && !a.exhausted) {
        const fresh = w && !a.stale && Date.parse(a.at) > Date.parse(pc.at) && claudeLevel(w) === 0;
        const reset = pc.resetsAt && Date.parse(pc.resetsAt) <= Date.now();
        if (fresh || reset) out.push({ account: a.account, recovered: resume('claude', room, null, 'the Claude limit is back') });
      }
      if (!w || (a.stale && !a.exhausted)) { out.push({ account: a.account, left: null, ageMin: a.ageMin }); continue; }
      const lvl = claudeLevel(w);
      const res = { account: a.account, left: w.left, level: lvl, what: w.label, rate: w.rate || 0 };
      out.push(res);
      const period = w.resetsAt || (a.exhausted ? a.exhausted.at.slice(0, 13) : '');
      if (!lvl || !due('claude', a.account, lvl, period)) continue;

      const leads = workingLeads(a.account);
      const names = leads.map(l => l.name).slice(0, 12).join(', ');
      const acc = short(a.account);
      const lines = [alert.t(w.left ? 'left' : 'out', { who: 'Claude', account: acc, left: w.left, what: w.label }),
                     alert.t('resets', { when: alert.when(w.resetsAt) }), ''];
      if (lvl === 1) {
        for (const l of leads) {
          say({ to: 'Claude', toSession: l.line, room, status: 'question',
            text: `Supervisor, for the owner: the Claude quota of this account is at ${w.left} % (${w.label}; resets ${w.resetsAt || 'time unknown'}). ` +
              'Stop heavy operations now — builds, long research, wide refactors, anything that reads much. Commit what is verified, ' +
              'rewrite .agents/HANDOFF.md with the exact next step and bring the documentation up to date. Start no new piece of work. ' +
              `At ${CLAUDE_STOP_LEFT} % you will be told to stop. Do not answer this.` });
        }
        if (leads.length) lines.push(alert.t('leadsWarned', { n: leads.length, names }));
        lines.push(alert.t('next', { stop: STOP_LEFT }));
        say({ to: 'all', toSession: 'human/web', room, status: 'question',
          text: `Supervisor: Claude quota is at ${w.left} % for account ${acc} (${w.label}; resets ${w.resetsAt || 'time unknown'}). ` +
            (leads.length ? `I told ${leads.length} lead(s) to drop heavy work and save: ${names}. ` : '') +
            `At ${CLAUDE_STOP_LEFT} % I tell them to stop and ask you to switch the account.` });
      } else {
        for (const l of leads) {
          say({ to: 'Claude', toSession: l.line, room, status: 'blocked',
            text: `Supervisor, for the owner: the Claude quota of this account is at ${w.left} % (${w.label}) — STOP. Finish only the step ` +
              'you are in, commit it, rewrite .agents/HANDOFF.md now (state, the exact next step, what your helpers hold), then end the ' +
              'turn and wait. Your helpers keep working on what you gave them. The board tells this project when to go on. Do not answer this.' });
        }
        // The other side does not stop: each stopped lead's helpers at work are told to carry on.
        const leadLines = new Set(leads.map(l => l.line));
        for (const h of workingHelpers().filter(h => leadLines.has(h.lead))) {
          say({ to: 'Gemini', toSession: h.helper, room: h.room, status: 'info',
            text: `Supervisor: your lead "${h.leadName}" is out of Claude quota and has stopped for now. Do NOT wait for it: carry on ` +
              'with the task it gave you, finish it, and post the result here — the lead reads it when it is back. Start nothing it did not ask for.' });
        }
        const paused = Object.assign({}, config().paused || {});
        paused.claude = { at: new Date().toISOString(), account: a.account, left: w.left, leads, resetsAt: w.resetsAt || '' };
        save({ paused });
        if (leads.length) lines.push(alert.t('leads', { n: leads.length, names }));
        lines.push(alert.t('switch', { who: 'Claude' }));
        say({ to: 'all', toSession: 'human/web', room, status: 'blocked',
          text: `Supervisor: Claude quota is ${w.left ? 'at ' + w.left + ' %' : 'used up'} for account ${acc} (${w.label}; resets ${w.resetsAt || 'time unknown'}). ` +
            (leads.length ? `I told ${leads.length} lead(s) to save and stop: ${names}. ` : 'No lead of that account worked in the last hours. ') +
            'Their helpers go on working. When the limit is back I tell the leads to go on myself; if you switch the Claude account ' +
            'sooner, write here: resume.' });
        res.stopped = leads.length;
      }
      const no = alert.show(alert.t(w.left ? 'head' : 'headOut'), lines);
      if (no) res.alertError = no;
      mark('claude', a.account, lvl, period);
    }
    return out;
  }

  // ── the owner's word ─────────────────────────────────────────────────────────────────────

  // Set going again whoever was stopped. `only`: 'gemini' | 'claude' | '' (both).
  function resume(only, room, replyTo, because) {
    const paused = Object.assign({}, config().paused || {});
    const done = [];
    if (paused.gemini && only !== 'claude') {
      for (const h of paused.gemini.helpers || []) {
        say({ to: 'Gemini', toSession: h.helper, room: h.room, status: 'question',
          text: `Supervisor, for the owner: ${because || 'the Antigravity account was switched'} — go on. Take up the task you stopped at, from the three ` +
            `lines you posted here (or from your lead's last task in this room if you posted none). You report to your lead, "${h.leadName}", as before.` });
      }
      done.push(`${(paused.gemini.helpers || []).length} helper(s)`);
      delete paused.gemini;
    }
    if (paused.claude && only !== 'gemini') {
      for (const l of paused.claude.leads || []) {
        say({ to: 'Claude', toSession: l.line, room, status: 'question',
          text: `Supervisor, for the owner: ${because || 'the Claude account was switched'} — go on. Read .agents/HANDOFF.md first (another ` +
            'window of this project may have written it), then continue from its exact next step. Your helpers kept working: read their ' +
            'reports in their rooms.' });
      }
      done.push(`${(paused.claude.leads || []).length} lead(s)`);
      delete paused.claude;
      // The limit the leads were stopped on is over: its mark must not stop them again a minute
      // later (17.11: resumed five times in 50 minutes, stopped again within a minute each time).
      try { if (claude.clearExhausted) claude.clearExhausted(); } catch (_) {}
    }
    // A new account starts with a clean sheet: its own warnings are due again.
    save({ paused, quotaLevel: {} });
    say({ to: 'all', toSession: 'human/web', room, replyTo: replyTo || null, status: done.length ? 'done' : 'answer',
      text: done.length ? `Supervisor: resumed${because ? ' (' + because + ')' : ''} — ${done.join(' and ')} were told to go on.`
                        : 'Supervisor: nobody is stopped on a quota right now, so there is nobody to resume.' });
    return done;
  }

  // The owner writes "resume" in the supervisor's room (or presses the button, which
  // calls resume() directly). Looked for only while somebody is stopped.
  function heardResume(room) {
    const paused = config().paused || {};
    if (!paused.gemini && !paused.claude) return null;
    const since = [paused.gemini, paused.claude].filter(Boolean).map(p => p.at).sort()[0];
    let rows = [];
    try {
      rows = bridgeDb.getDb().prepare('SELECT id, message, from_session, room FROM messages WHERE ts > ? ORDER BY id').all(since);
    } catch (_) { return null; }
    const conv = config().conversation || '';
    const word = rows.find(m => isHuman(m.from_session) && RESUME_WORD.test(String(m.message || '').replace(/^(>.*\n)+\s*/, '')) &&
      (String(m.room || '') === String(room || '') || (conv && String(m.message).includes(conv))));
    if (!word) return null;
    const text = String(word.message);
    const only = ONLY_GEMINI.test(text) && !ONLY_CLAUDE.test(text) ? 'gemini' : ONLY_CLAUDE.test(text) && !ONLY_GEMINI.test(text) ? 'claude' : '';
    return { done: resume(only, room, word.id), by: word.id };
  }

  async function tick(room, opts) {
    const out = { at: new Date().toISOString() };
    try { out.resumed = heardResume(room); } catch (e) { out.resumeError = e.message; }
    if (opts && opts.wordsOnly) return out;
    out.gemini = await watchGemini(room);
    try { out.claude = watchClaude(room); } catch (e) { out.claudeError = e.message; }
    out.paused = Object.keys(config().paused || {});
    return out;
  }

  return { tick, resume, workingHelpers, workingLeads, level, claudeLevel };
}

module.exports = { createQuotaWatch, WARN_LEFT, STOP_LEFT, CLAUDE_WARN_LEFT, CLAUDE_STOP_LEFT, RESUME_WORD };
