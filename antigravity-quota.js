'use strict';
// How much of the signed-in Antigravity account's quota is left, model by model.
//
// Antigravity shows this in its own settings; the numbers come from the application's
// local service, the same one antigravity-api.js talks to (address and token read from
// the running process each time). One call, GetUserStatus, returns for every model a
// remaining fraction and the time the quota resets. Nothing leaves the machine.
//
// Only the account that is signed in can be asked. The owner switches between several,
// so the board remembers what it last saw of each: when he must switch, it can say
// which of the others has quota again.

const http = require('http');
const antigravity = require('./antigravity-api');

const WARN_AT = 0.20;      // a fifth left: time to plan the switch
const SWITCH_AT = 0.05;    // nearly nothing: switch now

function call(method, body) {
  return new Promise((resolve, reject) => {
    let at;
    try { at = antigravity.locate(); } catch (e) { return reject(e); }
    const [host, port] = String(at.env.ANTIGRAVITY_LS_ADDRESS).split(':');
    const data = JSON.stringify(body || {});
    const rq = http.request({ host, port, method: 'POST', timeout: 8000,
      path: '/exa.language_server_pb.LanguageServerService/' + method,
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1',
                 'x-codeium-csrf-token': at.env.ANTIGRAVITY_CSRF_TOKEN, 'Content-Length': Buffer.byteLength(data) } }, res => {
      let s = '';
      res.on('data', d => { s += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Antigravity answered ' + res.statusCode));
        try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('unreadable answer from Antigravity')); }
      });
    });
    rq.on('timeout', () => rq.destroy(new Error('Antigravity did not answer')));
    rq.on('error', reject);
    rq.end(data);
  });
}

// { account, plan, models: [{ label, remaining, reset }], pools: [{ remaining, reset, labels }], lowest }
async function read() {
  const j = await call('GetUserStatus', { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } });
  const u = j.userStatus || {};
  const models = ((u.cascadeModelConfigData || {}).clientModelConfigs || [])
    .filter(m => m.quotaInfo && typeof m.quotaInfo.remainingFraction === 'number' || (m.quotaInfo && m.quotaInfo.resetTime))
    .map(m => ({ label: m.label, remaining: Number(m.quotaInfo.remainingFraction) || 0, reset: m.quotaInfo.resetTime || '' }));
  // Models that share a quota report the same fraction and the same reset: one pool.
  const pools = [];
  for (const m of models) {
    let p = pools.find(x => x.reset === m.reset && Math.abs(x.remaining - m.remaining) < 1e-6);
    if (!p) pools.push(p = { remaining: m.remaining, reset: m.reset, labels: [] });
    p.labels.push(m.label);
  }
  pools.sort((a, b) => a.remaining - b.remaining);
  // Models the application reports no figure for: not counted, and not called empty.
  const unmetered = ((u.cascadeModelConfigData || {}).clientModelConfigs || [])
    .filter(m => !m.quotaInfo || (typeof m.quotaInfo.remainingFraction !== 'number' && !m.quotaInfo.resetTime)).map(m => m.label);
  return { unmetered, account: u.email || u.name || 'unknown', plan: ((u.planStatus || {}).planInfo || {}).planName || '',
           models, pools, lowest: pools.length ? pools[0].remaining : 1, at: new Date().toISOString() };
}

const pct = f => Math.round(f * 100) + '%';
const poolName = p => p.labels.length > 2 ? p.labels.slice(0, 2).join(', ') + ' +' + (p.labels.length - 2) : p.labels.join(', ');

// What the board remembers of every account it has seen: { account: { at, pools } }.
function remember(known, q) {
  const out = Object.assign({}, known || {});
  out[q.account] = { at: q.at, pools: q.pools.map(p => ({ remaining: p.remaining, reset: p.reset, labels: p.labels.slice(0, 3) })) };
  return out;
}

// The other accounts, best first: one whose quota has reset since it was last seen is full again.
function alternatives(known, current, now) {
  now = now || Date.now();
  return Object.entries(known || {}).filter(([acc]) => acc !== current).map(([account, k]) => {
    const worst = (k.pools || []).slice().sort((a, b) => a.remaining - b.remaining)[0];
    if (!worst) return { account, remaining: 1, note: 'not measured' };
    const resetDone = worst.reset && Date.parse(worst.reset) <= now;
    return { account, remaining: resetDone ? 1 : worst.remaining,
             note: resetDone ? 'quota has reset since it was last seen' : pct(worst.remaining) + ' left when last seen, resets ' + worst.reset };
  }).sort((a, b) => b.remaining - a.remaining);
}

// The warning due now, if any. `told` = { account: { level, reset } } — one warning per level
// per reset period. Returns { text, level, told } or null.
function warning(q, known, told) {
  const low = q.pools.filter(p => p.remaining <= WARN_AT);
  if (!low.length) return null;
  const worst = low[0];
  const level = worst.remaining <= SWITCH_AT ? 2 : 1;
  const prev = (told || {})[q.account];
  if (prev && prev.reset === worst.reset && prev.level >= level) return null;
  const alt = alternatives(known, q.account);
  const text = (level === 2 ? 'Switch the Antigravity account now: ' : 'Antigravity quota is running low: ') +
    `account ${q.account} has ` + low.map(p => `${pct(p.remaining)} of ${poolName(p)}`).join('; ') +
    ` (resets ${worst.reset || 'time unknown'}).` +
    (alt.length ? ' Other accounts: ' + alt.slice(0, 5).map(a => `${a.account} — ${a.note}`).join('; ') + '.'
                : ' No other account has been seen by the board yet: it learns each one the first time it is signed in.');
  return { text, level, told: Object.assign({}, told || {}, { [q.account]: { level, reset: worst.reset } }) };
}

module.exports = { read, remember, alternatives, warning, pct, poolName, WARN_AT, SWITCH_AT };

// node antigravity-quota.js → the pools of the signed-in account
if (require.main === module) {
  read().then(q => {
    console.log(q.account.replace(/^(.{2}).*(@.*)$/, '$1…$2'), q.plan);
    for (const p of q.pools) console.log('  ' + pct(p.remaining).padStart(4), 'resets', p.reset, '·', p.labels.join(', '));
  }).catch(e => { console.error('quota: ' + e.message); process.exitCode = 1; });
}
