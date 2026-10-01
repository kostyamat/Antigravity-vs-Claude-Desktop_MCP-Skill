'use strict';
// Guards the installer puts around every agent on the machine: git hooks that
// keep history clean, and a list of commands Claude Code may not run.
//
// Both touch the user's global configuration, so both are careful: they add,
// never replace what the user set up, and back up a file before changing it.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Commands that destroy work or history. An agent that needs one asks the human,
// who runs it. Prefix rules: "git push --force" also covers "--force origin main".
const DENY = [
  'Bash(rm -rf:*)', 'Bash(rm -fr:*)', 'Bash(rm -r -f:*)',
  'Bash(git reset --hard:*)', 'Bash(git clean -f:*)', 'Bash(git clean -fd:*)', 'Bash(git clean -fdx:*)',
  'Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(git push --force-with-lease:*)',
  'Bash(git push --delete:*)', 'Bash(git branch -D:*)',
  'Bash(git checkout -- .:*)', 'Bash(git restore .:*)',
  'Bash(git stash drop:*)', 'Bash(git stash clear:*)',
  'Bash(git commit --amend:*)', 'Bash(git commit --no-verify:*)',
  'Bash(git filter-branch:*)', 'Bash(git update-ref -d:*)',
  'PowerShell(Remove-Item -Recurse:*)', 'PowerShell(Remove-Item -Force -Recurse:*)',
  'PowerShell(rm -r:*)', 'PowerShell(rmdir /s:*)', 'PowerShell(Format-Volume:*)'
];

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

// Add the deny list to Claude Code's user settings. Entries the user already has
// stay; only the missing ones are added.
function installDenyList(settingsPath) {
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {}; }
    catch (e) { return { ok: false, why: 'settings.json is not valid JSON — not modified' }; }
  }
  settings.permissions = settings.permissions || {};
  const have = new Set(Array.isArray(settings.permissions.deny) ? settings.permissions.deny : []);
  const missing = DENY.filter(r => !have.has(r));
  if (!missing.length) return { ok: true, added: 0 };
  if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, `${settingsPath}.bak-${stamp()}`);
  settings.permissions.deny = [...have, ...missing];
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return { ok: true, added: missing.length };
}

// Point git's global hooksPath at the bridge's hooks. A user who has their own
// global hooks keeps them; a path that holds an earlier copy of these same hooks
// (recognised by their helper) is moved to this one.
function installGitHooks(hooksDir) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
  try { git('--version'); } catch (_) { return { ok: false, why: 'git is not installed' }; }
  const want = hooksDir.split(path.sep).join('/');
  let current = '';
  try { current = git('config', '--global', '--get', 'core.hooksPath'); } catch (_) { current = ''; }
  if (current && path.resolve(current) === path.resolve(hooksDir)) return { ok: true, state: 'up to date', path: want };
  const ours = dir => {
    try { return /detect_agent\(\)/.test(fs.readFileSync(path.join(dir, '_agent.sh'), 'utf8')); }
    catch (_) { return false; }
  };
  if (current && !ours(current)) {
    return { ok: true, state: 'kept yours', path: current, ours: want };
  }
  git('config', '--global', 'core.hooksPath', want);
  return { ok: true, state: current ? 'moved from ' + current : 'enabled', path: want };
}

// Antigravity has no deny list, but it has hooks and plugins (its own docs, built
// into the language server). The bridge installs itself there as a plugin it
// owns entirely: ~/.gemini/config/plugins/agent-bridge/ with
//   hooks.json      PreToolUse on run_command -> command-guard.js, which refuses
//                   destructive commands however they are spelled;
//   rules/AGENTS.md the same rules in words, merged into Gemini's rule set.
// Nothing of the user's is edited. An earlier release wrote the rules as a block
// into ~/.gemini/config/AGENTS.md; that block is removed here.
const BEGIN = '<!-- agent-bridge:guards';
const END = '<!-- /agent-bridge:guards -->';

function guardRulesText(sandboxDir) {
  const { RULES } = require('./command-guard');
  return [
    '# Guards (agent-bridge)',
    '',
    '- **Never run destructive commands**, however they are spelled: ' +
      RULES.map(r => '`' + r.label + '`').join(', ') + '. A hook blocks them anyway; looking for another way ' +
      'to do the same thing is not allowed. If one is really needed, stop and ask the owner to run it.',
    '- A damaged file is restored on its own: `git restore <file>` — never the whole repository.',
    '',
    '# Where files go (agent-bridge)',
    '',
    '- **Before a task that makes files, ask the owner** (unless it is already decided): where to work — the project, ' +
      'a folder he names, or the sandbox' + (sandboxDir ? ' `' + sandboxDir + '`' : '') + '; where the result goes; ' +
      'whether to keep the tools and intermediate files afterwards. "Here and now, in this folder" is a valid answer.',
    '- **A project is its folder.** Nothing you make goes next to where an input lay, onto the device under ' +
      'test, into a package, Downloads or another drive.',
    '- **The smallest change**: one condition patched, not a whole app decompiled into a project. One working copy, ' +
      'no `_v2`/`_final` siblings.',
    '- **When done, say where everything is**: the result (full path, what changed, how to check it), the tools and ' +
      'intermediate files (where, roughly how big), what you cleaned up. Then keep or clean them as the owner chose.',
    '- How to work on a project (the `.agents/` files, the session slice, point changes, one source of truth): ' +
      'the `agent-workflow` skill. The shared board: the `agent-bridge` skill.',
    ''
  ].join('\n');
}

function writeIfChanged(file, text) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return true;
}

function installGeminiPlugin(geminiConfigDir, bridgeDir, nodePath, sandboxDir) {
  const dir = path.join(geminiConfigDir, 'plugins', 'agent-bridge');
  const guard = path.join(bridgeDir, 'command-guard.js');
  // Antigravity runs a hook as `cmd /c <command>` and escapes every quote in it
  // with a backslash, so a quoted path — and node usually lives under "Program
  // Files" — reaches cmd as \"C:\Program Files\…\" and is not found. The first
  // release did exactly that and blocked every command Gemini ran. The command
  // therefore carries no quotes and no path at all: a launcher beside
  // hooks.json, which is where a hook's working directory is, holds them.
  const launcher = '@echo off\r\n"' + nodePath + '" "' + guard + '"\r\n';
  const hooks = {
    'agent-bridge-guard': {
      PreToolUse: [{
        matcher: 'run_command',
        // A full path when it has no spaces (no quotes needed), so the hook
        // does not depend on the working directory; otherwise .\guard.cmd —
        // explicitly relative, because cmd may be told not to search the
        // current directory (NoDefaultCurrentDirectoryInExePath).
        hooks: [{ type: 'command', command: /\s/.test(dir) ? '.\\guard.cmd' : path.join(dir, 'guard.cmd'), timeout: 10 }]
      }]
    }
  };
  // Someone who switched the guard off by hand keeps it off: a re-install must
  // not quietly turn back on what was disabled because it broke.
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
    if (prev && prev['agent-bridge-guard'] && prev['agent-bridge-guard'].enabled === false) {
      hooks['agent-bridge-guard'].enabled = false;
    }
  } catch (_) {}
  let changed = false;
  changed = writeIfChanged(path.join(dir, 'plugin.json'), JSON.stringify({ name: 'agent-bridge' }, null, 2) + '\n') || changed;
  changed = writeIfChanged(path.join(dir, 'guard.cmd'), launcher) || changed;
  changed = writeIfChanged(path.join(dir, 'hooks.json'), JSON.stringify(hooks, null, 2) + '\n') || changed;
  changed = writeIfChanged(path.join(dir, 'rules', 'AGENTS.md'), guardRulesText(sandboxDir)) || changed;

  // The block an earlier release put into the user's own AGENTS.md.
  const userRules = path.join(geminiConfigDir, 'AGENTS.md');
  if (fs.existsSync(userRules)) {
    // Every copy of it: an edit by hand once duplicated the block.
    const text = fs.readFileSync(userRules, 'utf8');
    let next = text;
    for (;;) {
      const a = next.indexOf(BEGIN), b = next.indexOf(END, a);
      if (a < 0 || b < 0) break;
      next = next.slice(0, a).replace(/\s*$/, '') + '\n\n' + next.slice(b + END.length).replace(/^\s*/, '');
    }
    next = next.replace(/\s*$/, '\n');
    if (next !== text) {
      fs.copyFileSync(userRules, `${userRules}.bak-${stamp()}`);
      fs.writeFileSync(userRules, next, 'utf8');
      changed = true;
    }
  }
  return { ok: true, changed, dir };
}

// The same guard for Claude Code, as a PreToolUse hook on Bash and PowerShell.
// The deny list above stays as a second line: it costs nothing, and a hook that
// fails to start must not leave the door open.
function installClaudeGuardHook(settingsPath, nodePath, bridgeDir) {
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {}; }
    catch (e) { return { ok: false, why: 'settings.json is not valid JSON — not modified' }; }
  }
  const command = `"${nodePath}" "${path.join(bridgeDir, 'command-guard.js').split(path.sep).join('/')}"`;
  settings.hooks = settings.hooks || {};
  const list = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : (settings.hooks.PreToolUse = []);
  let found = null;
  for (const e of list) {
    const h = e && Array.isArray(e.hooks) ? e.hooks.find(x => x && typeof x.command === 'string' && x.command.includes('command-guard')) : null;
    if (h) { found = { e, h }; break; }
  }
  if (found && found.h.command === command && found.e.matcher === 'Bash|PowerShell') return { ok: true, changed: false };
  if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, `${settingsPath}.bak-${stamp()}`);
  if (found) { found.h.command = command; found.e.matcher = 'Bash|PowerShell'; }
  else list.push({ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command, timeout: 10 }] });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return { ok: true, changed: true };
}

module.exports = { installDenyList, installGitHooks, installGeminiPlugin, installClaudeGuardHook, DENY };
