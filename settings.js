'use strict';
// The settings the owner changes on the board page (Settings tab), and the one place their
// defaults live. Each is a key of bridge_config.json; the code that uses one reads it through
// get(), so the page, the default and the behaviour cannot drift apart. Only what really acts is
// listed here: a key that nothing reads would be a switch connected to nothing.
//
// The owner asked for the page on 24.11.2026, when a limit ("20 GB by default, maxFileGB in
// bridge_config.json") turned out to be something he could change only by editing a file.

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'bridge_config.json');

const SCHEMA = [
  { key: 'adminName', type: 'text', def: 'Owner', max: 60,
    label: 'Your name on the board', help: 'How the board signs what you write, and how agents address you.' },
  { key: 'activeWindowMinutes', type: 'number', def: 60, min: 5, max: 1440, unit: 'min',
    label: 'A session counts as active for', help: 'After its last turn. A message to a room, a P0 to all or your word in a room wakes only active sessions; a sleeping one is woken only by a message to it. Applies from each session\'s next turn end.' },
  { key: 'maxHelpersPerLead', type: 'number', def: 3, min: 1, max: 10,
    label: 'Helpers one lead may keep', help: 'Antigravity conversations a lead may start at once. Each open conversation takes memory on this machine.' },
  { key: 'maxFileGB', type: 'number', def: 20, min: 0.1, max: 500, step: 0.1, unit: 'GB',
    label: 'Largest file between machines', help: 'For send_file, both ways: a larger file is refused here before it is sent, and there before it is kept.' },
  { key: 'listenOnNetwork', type: 'bool', def: true,
    label: 'Other machines can reach this board', help: 'Off: the board answers this machine only, and linked machines lose it. Takes effect when the board restarts.', restart: true }
];

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch (_) { return {}; }
}

const spec = key => SCHEMA.find(s => s.key === key);

// The value in force: the configured one when it is valid, else the default.
function get(key, cfg) {
  const s = spec(key);
  const v = (cfg || readConfig())[key];
  if (!s) return v;
  const c = coerce(s, v);
  return c.error || c.value === undefined ? s.def : c.value;
}

function coerce(s, v) {
  if (v === undefined || v === null || v === '') return { value: undefined };
  if (s.type === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) return { error: `${s.label}: a number` };
    if (n < s.min || n > s.max) return { error: `${s.label}: from ${s.min} to ${s.max}` };
    return { value: n };
  }
  if (s.type === 'bool') {
    if (v === true || v === 'true') return { value: true };
    if (v === false || v === 'false') return { value: false };
    return { error: `${s.label}: on or off` };
  }
  const t = String(v).trim();
  if (!t) return { error: `${s.label}: cannot be empty` };
  if (t.length > s.max) return { error: `${s.label}: ${s.max} characters at most` };
  return { value: t };
}

// For the page: every setting with its value in force and its default.
function list() {
  const cfg = readConfig();
  return SCHEMA.map(s => Object.assign({}, s, { value: get(s.key, cfg), set: cfg[s.key] !== undefined }));
}

// One setting changed from the page. null / '' puts the default back (the key is removed).
// The file is written whole through a temporary file, so a crash never leaves half a config.
function set(key, value) {
  const s = spec(key);
  if (!s) return { error: `"${key}" is not a setting of this page` };
  const c = coerce(s, value);
  if (c.error) return { error: c.error };
  const cfg = readConfig();
  if (c.value === undefined) delete cfg[key]; else cfg[key] = c.value;
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return { key, value: get(key, cfg), restart: !!s.restart };
}

module.exports = { SCHEMA, get, list, set };
