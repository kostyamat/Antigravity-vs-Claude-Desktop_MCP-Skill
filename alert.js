'use strict';
// The window that tells the owner what he must not miss: a quota about to run out,
// a session cut off in the middle of its work.
//
// It is a program of the bridge's own (tools/quota-alert, built into bin/), not a
// system notification: a Windows toast is shown for seconds in a corner, is held
// back by Focus Assist and by a full-screen window, and leaves nothing behind when
// it was missed (owner, 16.11.2026: "Windows pop-ups are unreliable"). This window
// stands in the middle of the screen, above everything, until it is closed.
//
// The words are in the owner's language. The board itself is English; what is put
// on his screen follows the system locale, or `alertLanguage` in bridge_config.json
// ("auto" by default; en, uk, ru, de, fr, es). The texts live in
// locales/quota-alert.json — the one place in the repository, beside the README,
// that is meant to hold other languages.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOME = __dirname;
const RUN_DIR = process.env.BRIDGE_RUN_DIR || path.join(HOME, 'run');

let table = null;
function texts() {
  if (!table) {
    try { table = JSON.parse(fs.readFileSync(path.join(HOME, 'locales', 'quota-alert.json'), 'utf8')); }
    catch (_) { table = { en: {} }; }
  }
  return table;
}

function language() {
  let want = 'auto';
  try { want = String(JSON.parse(fs.readFileSync(path.join(HOME, 'bridge_config.json'), 'utf8')).alertLanguage || 'auto'); } catch (_) {}
  if (want === 'auto') {
    try { want = Intl.DateTimeFormat().resolvedOptions().locale || 'en'; } catch (_) { want = 'en'; }
  }
  const two = want.toLowerCase().slice(0, 2);
  return two !== '_w' && texts()[two] ? two : 'en';
}

// One sentence in the owner's language: t('left', { who, account, left, what }).
function t(key, vars, lang) {
  const all = texts();
  const s = (all[lang || language()] || {})[key] || (all.en || {})[key] || key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] !== undefined ? String(vars[k]) : ''));
}

// A time the owner reads at a glance, in his locale and his clock.
function when(iso) {
  const d = new Date(typeof iso === 'number' ? iso * 1000 : iso);
  if (!iso || isNaN(d)) return '?';
  try { return d.toLocaleString(language(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch (_) { return d.toISOString().slice(0, 16).replace('T', ' '); }
}

function binary() {
  const name = process.platform === 'win32' ? 'quota-alert.exe' : 'quota-alert';
  const file = path.join(HOME, 'bin', name);
  return fs.existsSync(file) ? file : '';
}

// Put the window on the screen. `head` is the red line, `lines` the text under it.
// Returns the reason it could not, or ''. Never throws: a warning that fails must
// not take the board's tick with it — the same words are on the board anyway.
function show(head, lines, opts) {
  try {
    const exe = binary();
    if (!exe) return 'the alert program is not in bin/ (build it: tools/quota-alert/build.sh)';
    if (process.platform !== 'win32' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return 'no display to show a window on';
    fs.mkdirSync(RUN_DIR, { recursive: true });
    for (const f of fs.readdirSync(RUN_DIR)) {               // yesterday's texts are of no use to anybody
      if (/^alert_\d+\.txt$/.test(f) && Date.now() - fs.statSync(path.join(RUN_DIR, f)).mtimeMs > 86400e3) fs.unlinkSync(path.join(RUN_DIR, f));
    }
    const file = path.join(RUN_DIR, `alert_${Date.now()}.txt`);
    fs.writeFileSync(file, [head].concat(lines || []).join('\n'), 'utf8');
    const args = [file];
    if (opts && opts.seconds) args.push(String(opts.seconds));
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {});
    child.unref();
    return '';
  } catch (e) { return e.message; }
}

// Words the owner may write to the supervisor, every language at once: words('resume').
function words(key) { const w = (texts()._words || {})[key]; return Array.isArray(w) ? w.slice() : []; }

module.exports = { show, t, when, language, binary, words };

// node alert.js "<head>" "<line>" ["<line>" …]   → the window, for a look at it
if (require.main === module) {
  const [head, ...lines] = process.argv.slice(2);
  const no = show(head || t('head'), lines.length ? lines : [t('next', { stop: 5 })], { seconds: 0 });
  if (no) { console.error('alert: ' + no); process.exitCode = 1; }
}
