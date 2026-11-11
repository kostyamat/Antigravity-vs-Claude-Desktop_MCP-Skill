'use strict';
// The Claude side of the board as one Claude Code plugin.
//
// Before, the installer merged eight hooks into ~/.claude/settings.json and
// copied the skill beside them: nine pieces with no common switch, and a user
// who wanted the board off had to edit JSON by hand. Claude Code loads a
// folder under ~/.claude/skills/<name>/ that carries .claude-plugin/plugin.json
// as the plugin <name>@skills-dir, straight from disk (no marketplace, no
// cached copy). The agent-bridge skill folder is already written there, so the
// plugin is that folder plus two generated files: the manifest and hooks.json.
// One switch then turns all of it on or off:
//   claude plugin disable agent-bridge@skills-dir
//
// The two files are generated, never tracked: the hook commands carry this
// machine's node and python and the bridge home.

const fs = require('fs');
const path = require('path');

const PLUGIN_NAME = 'agent-bridge';

// Every hook the board needs from a Claude Code session. `needle` finds an
// older copy of the same hook in settings.json (at any path); `also` lists
// names it had before.
//   board_brief   — every session start: who you are on the board, what is new.
//   after_compact — after a compaction only: the slice, last commits, dirty files.
//   pre_compact   — before a compaction: warns when the slice lags the tree.
//   stamp         — signs every bridge call with this window's id.
//   prompt        — every prompt: one line when unread mail waits.
//   stop          — a session about to go idle over unread mail reads it first.
//   watch         — in the background from session start and every stop:
//                   wakes the idle session when something arrives for it.
function bridgeHooks({ nodeExe, scriptsDir, pyCmd }) {
  const posix = p => p.split(path.sep).join('/');
  const py = file => `${pyCmd} "${posix(path.join(scriptsDir, file))}"`;
  const node = mode => `"${nodeExe}" "${posix(path.join(scriptsDir, 'bridge-hook.js'))}" ${mode}`;
  const watch = { type: 'command', command: node('watch'), async: true, asyncRewake: true, timeout: 86700 };
  return [
    { event: 'SessionStart', needle: 'board_brief', hook: { type: 'command', command: py('board_brief.py') } },
    { event: 'SessionStart', needle: 'after_compact', matcher: 'compact',
      hook: { type: 'command', command: py('after_compact.py'), timeout: 30,
              statusMessage: 'Context guard: the session slice after compaction' } },
    { event: 'PreCompact', needle: 'pre_compact',
      hook: { type: 'command', command: py('pre_compact.py'), timeout: 20,
              statusMessage: 'Context guard: is the slice current?' } },
    { event: 'PreToolUse', needle: 'bridge-hook.js" stamp', matcher: 'mcp__agent-bridge__.*',
      hook: { type: 'command', command: node('stamp'), timeout: 10 } },
    { event: 'UserPromptSubmit', needle: 'bridge-hook.js" prompt', also: ['board_brief'],
      hook: { type: 'command', command: node('prompt'), timeout: 10 } },
    { event: 'Stop', needle: 'bridge-hook.js" stop', hook: { type: 'command', command: node('stop'), timeout: 15 } },
    { event: 'Stop', needle: 'bridge-hook.js" watch', hook: watch },
    { event: 'SessionStart', needle: 'bridge-hook.js" watch', hook: Object.assign({}, watch) }
  ];
}

// The hooks.json body: one entry per hook, grouped by event, in list order.
function hooksJson(hooks) {
  const out = {};
  for (const w of hooks) {
    const entry = { hooks: [Object.assign({}, w.hook)] };
    if (w.matcher) entry.matcher = w.matcher;
    (out[w.event] = out[w.event] || []).push(entry);
  }
  return { hooks: out };
}

function manifest(version) {
  return {
    name: PLUGIN_NAME,
    version: version || '0.0.0',
    description: 'Agent Bridge: the shared board for the agents on this machine. ' +
      'Session-start brief, mail check before idle, the watchman that wakes an idle window, ' +
      'call signing and the context guard around compaction, with the agent-bridge skill.',
    skills: ['./']
  };
}

function writeIfChanged(file, body) {
  const text = JSON.stringify(body, null, 2) + '\n';
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch (_) {}
  if (old === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return true;
}

// Writes the manifest and hooks.json into the installed skill folder.
// Returns which of the two changed.
function writePlugin(skillDir, hooks, version) {
  return {
    manifest: writeIfChanged(path.join(skillDir, '.claude-plugin', 'plugin.json'), manifest(version)),
    hooks: writeIfChanged(path.join(skillDir, 'hooks', 'hooks.json'), hooksJson(hooks))
  };
}

// Takes the bridge hooks out of a settings object (they live in the plugin now,
// and a copy left in settings.json would run every hook twice). Only a hook
// whose command carries one of the needles goes; a user's own hook sharing an
// entry stays, and an entry left with no hooks is dropped. Returns the commands
// removed.
function stripFromSettings(settings, hooks) {
  const removed = [];
  if (!settings || !settings.hooks) return removed;
  for (const w of hooks) {
    const list = settings.hooks[w.event];
    if (!Array.isArray(list)) continue;
    const needles = [w.needle].concat(w.also || []);
    for (const entry of list) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      entry.hooks = entry.hooks.filter(h => {
        const hit = h && typeof h.command === 'string' && needles.some(n => h.command.includes(n));
        if (hit) removed.push(`${w.event}: ${h.command}`);
        return !hit;
      });
    }
    settings.hooks[w.event] = list.filter(e => !(e && Array.isArray(e.hooks) && e.hooks.length === 0));
    if (!settings.hooks[w.event].length) delete settings.hooks[w.event];
  }
  return removed;
}

module.exports = { PLUGIN_NAME, bridgeHooks, hooksJson, manifest, writePlugin, stripFromSettings };
