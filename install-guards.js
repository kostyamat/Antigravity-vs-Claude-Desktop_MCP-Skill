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

// Antigravity has no deny list: it reads ~/.gemini/config/AGENTS.md as its
// standing instructions at the start of every session (its own administrator,
// board #991). So the same commands go there as text, inside a marked block the
// installer owns and replaces; everything outside the block is the user's.
const BEGIN = '<!-- agent-bridge:guards — written by the bridge installer; edit outside this block -->';
const END = '<!-- /agent-bridge:guards -->';

function geminiGuardBlock() {
  const commands = [...new Set(DENY.map(r => r.replace(/^\w+\(/, '').replace(/:\*\)$/, '')))];
  return [
    BEGIN,
    '## Guards (agent-bridge)',
    '',
    '- **Never run destructive commands.** Not one of these, whatever the reason: ' +
      commands.map(c => '`' + c + '`').join(', ') + '. If one seems necessary, stop and ask the owner to run it.',
    '- A damaged file is restored on its own: `git restore <file>` — never the whole repository.',
    '- How to work on a project (the `.agents/` files, the session slice, point changes, one source of truth): ' +
      'the `agent-workflow` skill. The shared board: the `agent-bridge` skill.',
    END
  ].join('\n');
}

function installGeminiRules(agentsMdPath) {
  const block = geminiGuardBlock();
  let text = fs.existsSync(agentsMdPath) ? fs.readFileSync(agentsMdPath, 'utf8') : '';
  const a = text.indexOf(BEGIN), b = text.indexOf(END);
  const next = (a >= 0 && b > a)
    ? text.slice(0, a) + block + text.slice(b + END.length)
    : (text.replace(/\s*$/, '') + (text.trim() ? '\n\n' : '') + block + '\n');
  if (next === text) return { ok: true, changed: false };
  if (text) fs.copyFileSync(agentsMdPath, `${agentsMdPath}.bak-${stamp()}`);
  fs.mkdirSync(path.dirname(agentsMdPath), { recursive: true });
  fs.writeFileSync(agentsMdPath, next, 'utf8');
  return { ok: true, changed: true };
}

module.exports = { installDenyList, installGitHooks, installGeminiRules, DENY };
