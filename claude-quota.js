'use strict';
// How much of each Claude account's plan limits is left, as far as the board can know.
//
// Antigravity's quota is asked of the application's local service (antigravity-quota.js).
// Claude has no such door: the figures the app shows on its usage card are reachable
// only from inside a Claude session, or with the account's sign-in token — which the
// board does not touch. So the board is told, in three ways, none of which makes a
// session watch its own quota:
//
//   report     A Claude window is asked, in the header of an ordinary get_messages and
//              at most once per ASK_EVERY_MIN per account, to call its own get_usage
//              and hand the result to report_usage: two calls by one window, and the
//              board knows the figures for every lead of that account.
//   failed     The StopFailure hook: a turn that ended on the usage limit says so
//              itself, the moment it happens (bridge-hook.js, mode `failed`).
//   statusline A terminal session's status line carries the same figures
//              (`rate_limits`); the desktop app runs no status line (measured
//              16.11.2026), so this helps only sessions started with the CLI.
//
// Kept in run/claude_usage.json, outside the database: it is a measurement, not board
// state, and it is stale in an hour.

const fs = require('fs');
const path = require('path');

const RUN_DIR = process.env.BRIDGE_RUN_DIR || path.join(__dirname, 'run');
const FILE = () => path.join(RUN_DIR, 'claude_usage.json');
const ASK_EVERY_MIN = 20;      // how old a measurement may get before a window is asked again
const ASK_LOW_MIN = 8;         // …when little is left
const ASK_PAUSE_MIN = 5;       // one window was just asked: do not ask the next one at once
const STALE_MIN = 90;          // older than this, a figure is not acted on

function load() {
  try { return Object.assign({ accounts: {}, sessions: {} }, JSON.parse(fs.readFileSync(FILE(), 'utf8'))); }
  catch (_) { return { accounts: {}, sessions: {} }; }
}
function store(all) {
  try { fs.mkdirSync(RUN_DIR, { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(all, null, 1), 'utf8'); } catch (_) {}
}

// Whatever get_usage returned — an object, its JSON as text, or text with JSON inside
// — as { windows: [{ label, used, resetsAt }], plan, context } or null.
function parseUsage(raw) {
  let u = raw;
  if (typeof u === 'string') {
    const a = u.indexOf('{'), b = u.lastIndexOf('}');
    try { u = JSON.parse(a >= 0 && b > a ? u.slice(a, b + 1) : u); } catch (_) { return null; }
  }
  if (!u || typeof u !== 'object') return null;
  const plan = u.plan && typeof u.plan === 'object' ? u.plan : u;
  const list = Array.isArray(plan.windows) ? plan.windows : [];
  const windows = list.map(w => ({
    label: String(w.label || '').slice(0, 60),
    used: Number(w.percentUsed !== undefined ? w.percentUsed : w.used_percentage),
    resetsAt: w.resetsAt ? new Date(w.resetsAt).toISOString() : (w.resets_at ? new Date(Number(w.resets_at) * 1000).toISOString() : '')
  })).filter(w => w.label && Number.isFinite(w.used));
  const c = u.context && typeof u.context === 'object' ? u.context : null;
  const context = c && Number(c.contextWindow) > 0
    ? { tokens: Number(c.tokensUsed) || 0, size: Number(c.contextWindow), compactAt: Number(c.autoCompactsAtPercent) || 0 } : null;
  if (!windows.length && !context) return null;
  return { windows, plan: typeof plan.plan === 'string' ? plan.plan : '', context };
}

// The status line's `rate_limits` as the same list.
function fromStatusline(j) {
  const r = (j && j.rate_limits) || {};
  const names = { five_hour: '5-hour limit', seven_day: 'Weekly · all models' };
  const windows = Object.keys(names).filter(k => r[k] && Number.isFinite(Number(r[k].used_percentage))).map(k => ({
    label: names[k], used: Number(r[k].used_percentage),
    resetsAt: r[k].resets_at ? new Date(Number(r[k].resets_at) * 1000).toISOString() : '' }));
  const cw = (j && j.context_window) || {};
  const context = Number(cw.context_window_size) > 0 && Number.isFinite(Number(cw.used_percentage))
    ? { tokens: Math.round(Number(cw.context_window_size) * Number(cw.used_percentage) / 100), size: Number(cw.context_window_size), compactAt: 0 } : null;
  return windows.length || context ? { windows, plan: '', context } : null;
}

// Record a measurement. `account` is the account the window runs under; `win` its id.
function report({ account, win, usage, by }) {
  if (!usage) return null;
  const all = load();
  const now = new Date().toISOString();
  if (account && usage.windows.length) {
    all.accounts[account] = { at: now, by: by || 'report', win: win || '', plan: usage.plan || (all.accounts[account] || {}).plan || '',
                              windows: usage.windows, asked: '' };
  }
  if (win && usage.context) all.sessions[win] = Object.assign({ at: now, account: account || '' }, usage.context);
  store(all);
  return all.accounts[account] || null;
}

// A turn ended on the usage limit: that account has nothing left of something, now.
function exhausted({ account, win, why }) {
  if (!account) return;
  const all = load();
  const a = all.accounts[account] || { windows: [], plan: '' };
  a.exhausted = { at: new Date().toISOString(), win: win || '', why: String(why || '').slice(0, 200) };
  all.accounts[account] = a;
  store(all);
}

// What is known of every account, worst window first:
// [{ account, at, ageMin, stale, windows: [{ label, left, resetsAt }], worst, exhausted }]
function read(now) {
  const t = now || Date.now();
  const out = [];
  for (const [account, a] of Object.entries(load().accounts)) {
    const windows = (a.windows || [])
      // A window whose reset time has passed has been refilled since it was measured.
      .filter(w => !(w.resetsAt && Date.parse(w.resetsAt) <= t))
      .map(w => ({ label: w.label, left: Math.max(0, Math.round(100 - w.used)), resetsAt: w.resetsAt }))
      .sort((x, y) => x.left - y.left);
    const ageMin = a.at ? Math.round((t - Date.parse(a.at)) / 60000) : Infinity;
    // An exhausted mark stands until a newer measurement, or two hours.
    const ex = a.exhausted && (!a.at || Date.parse(a.exhausted.at) > Date.parse(a.at)) && t - Date.parse(a.exhausted.at) < 2 * 3600e3
      ? a.exhausted : null;
    out.push({ account, at: a.at || '', ageMin, stale: ageMin > STALE_MIN, plan: a.plan || '', windows,
               worst: windows[0] || null, exhausted: ex });
  }
  return out;
}

// Should this window be asked for a measurement now? Marks the account as asked.
function shouldAsk(account, now) {
  if (!account) return false;
  const t = now || Date.now();
  const all = load();
  const a = all.accounts[account] || {};
  const known = read(t).find(x => x.account === account);
  const every = known && known.worst && known.worst.left <= 20 ? ASK_LOW_MIN : ASK_EVERY_MIN;
  if (a.at && t - Date.parse(a.at) < every * 60000) return false;
  if (a.asked && t - Date.parse(a.asked) < ASK_PAUSE_MIN * 60000) return false;
  all.accounts[account] = Object.assign({ windows: [], plan: '' }, a, { asked: new Date(t).toISOString() });
  store(all);
  return true;
}

const ASK_LINE = '📊 The board supervisor watches this account\'s Claude limits for every lead, and its last figure is old. ' +
  'Call your get_usage tool once and pass what it returns: report_usage({usage: <the result>}). Two calls, no comment ' +
  'needed; you are not asked to watch the quota yourself — the supervisor warns you when it runs low.';

// How full each known session's context window is: [{ win, account, percent, tokens, size, ageMin }]
function sessions(now) {
  const t = now || Date.now();
  return Object.entries(load().sessions).map(([win, s]) => ({
    win, account: s.account || '', tokens: s.tokens, size: s.size, compactAt: s.compactAt || 0,
    percent: s.size ? Math.round(100 * s.tokens / s.size) : 0, ageMin: Math.round((t - Date.parse(s.at)) / 60000) }));
}

module.exports = { parseUsage, fromStatusline, report, exhausted, read, shouldAsk, sessions, ASK_LINE, STALE_MIN };
