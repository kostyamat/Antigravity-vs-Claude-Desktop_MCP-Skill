#!/usr/bin/env node
'use strict';
// A PreToolUse hook that refuses commands which destroy work or history.
//
// One script serves both clients. It reads the hook payload on stdin and answers
// in the dialect of whoever called it:
//   Antigravity  {"toolCall":{"name":"run_command","args":{"CommandLine":"…"}}}
//                → {"decision":"deny","reason":"…"}; no opinion → {}
//   Claude Code  {"tool_name":"Bash"|"PowerShell","tool_input":{"command":"…"}}
//                → {"hookSpecificOutput":{…,"permissionDecision":"deny"}}; no opinion → nothing
//
// Text rules ("never run git reset --hard") are read and then argued with: an
// agent that decides a reset is the simpler way back finds a spelling the rule
// did not list. So this does not match prefixes. It splits the command line into
// separate commands, looks inside `powershell -Command "…"` and `cmd /c …`, and
// judges each by what it does: git with any options before the subcommand, rm
// with its flags in any order and form, Remove-Item with -Recurse anywhere.
//
// It never throws and never blocks on its own failure: a guard that crashes must
// not take the agent's terminal with it.

const RULES = [
  { label: 'git reset --hard', test: g => g.sub === 'reset' && g.has('--hard') },
  { label: 'git clean -f', test: g => g.sub === 'clean' && (g.flag('f') || g.has('--force')) },
  { label: 'git push --force / -f / --force-with-lease', test: g => g.sub === 'push' && (g.flag('f') || g.hasPrefix('--force')) },
  { label: 'git push --delete', test: g => g.sub === 'push' && (g.has('--delete') || g.flag('d') || g.args.some(a => /^:/.test(a))) },
  { label: 'git branch -D', test: g => g.sub === 'branch' && (g.args.includes('-D') || (g.has('--delete') && g.has('--force'))) },
  { label: 'git checkout -- .', test: g => g.sub === 'checkout' && g.args.includes('--') && g.args.some(a => a === '.' || a === '*') },
  { label: 'git restore .', test: g => g.sub === 'restore' && g.args.some(a => a === '.' || a === '*' || a === ':/') },
  { label: 'git stash drop / clear', test: g => g.sub === 'stash' && ['drop', 'clear'].includes(g.args[0]) },
  { label: 'git commit --amend', test: g => g.sub === 'commit' && g.hasPrefix('--amend') },
  { label: 'git commit --no-verify', test: g => g.sub === 'commit' && (g.has('--no-verify') || g.flag('n')) },
  { label: 'git filter-branch / filter-repo', test: g => g.sub === 'filter-branch' || g.sub === 'filter-repo' },
  { label: 'git update-ref -d', test: g => g.sub === 'update-ref' && g.flag('d') },
  // Recursive delete, with or without -f: that is how a project directory goes.
  { label: 'rm -r / rm -rf (recursive delete)', test: c => c.cmd === 'rm' && c.posixRecursive },
  { label: 'Remove-Item -Recurse', test: c => ['remove-item', 'ri', 'rm', 'rmdir', 'del', 'erase', 'rd'].includes(c.cmd) && c.args.some(a => /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(a)) && c.isPowerShellish },
  { label: 'rmdir /s · rd /s · del /s', test: c => ['rmdir', 'rd', 'del', 'erase'].includes(c.cmd) && c.args.some(a => /^\/s$/i.test(a)) },
  { label: 'Format-Volume / format', test: c => c.cmd === 'format-volume' || (c.cmd === 'format' && c.args.some(a => /^[a-z]:$/i.test(a))) }
];

// Split a command line into words, honouring quotes.
function words(s) {
  const out = [];
  let cur = '', q = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// Separate commands: ; && || | and newlines, outside quotes.
function segments(s) {
  const out = [];
  let cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function base(word) {
  return String(word || '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

// Every command a line runs, including the ones wrapped in a shell call.
function commands(line, depth) {
  const all = [];
  for (const seg of segments(line)) {
    const w = words(seg);
    if (!w.length) continue;
    const cmd = base(w[0]);
    const args = w.slice(1);
    if (depth < 3 && ['powershell', 'pwsh'].includes(cmd)) {
      const i = args.findIndex(a => /^-(c|command)$/i.test(a));
      if (i >= 0) { all.push(...commands(args.slice(i + 1).join(' '), depth + 1)); continue; }
    }
    if (depth < 3 && cmd === 'cmd') {
      const i = args.findIndex(a => /^\/[ck]$/i.test(a));
      if (i >= 0) { all.push(...commands(args.slice(i + 1).join(' '), depth + 1)); continue; }
    }
    if (depth < 3 && ['bash', 'sh', 'wsl'].includes(cmd)) {
      const i = args.findIndex(a => a === '-c' || a === '-lc' || a === '-e');
      if (i >= 0) { all.push(...commands(args.slice(i + 1).join(' '), depth + 1)); continue; }
    }
    all.push({ cmd, args });
  }
  return all;
}

function judge(line) {
  for (const c of commands(String(line || ''), 0)) {
    let subject;
    if (c.cmd === 'git') {
      // Skip options that come before the subcommand: -C dir, -c k=v, --git-dir=…
      let i = 0;
      while (i < c.args.length && c.args[i].startsWith('-')) {
        if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(c.args[i])) i += 2; else i += 1;
      }
      const args = c.args.slice(i + 1);
      const shortFlags = args.filter(a => /^-[a-zA-Z]+$/.test(a)).join('');
      subject = {
        sub: c.args[i], args,
        has: x => args.includes(x),
        hasPrefix: x => args.some(a => a.startsWith(x)),
        flag: ch => shortFlags.includes(ch)
      };
    } else {
      const short = c.args.filter(a => /^-[a-zA-Z]+$/.test(a)).join('');
      subject = {
        cmd: c.cmd, args: c.args,
        posixRecursive: /[rR]/.test(short) || c.args.includes('--recursive'),
        isPowerShellish: true
      };
    }
    for (const r of RULES) {
      try { if (r.test(subject)) return r.label; } catch (_) {}
    }
  }
  return null;
}

function reasonFor(label) {
  return `Blocked by the agent-bridge guard: ${label} destroys work or history. ` +
    'Do not look for another way to do the same. If it really is needed, stop and ask the owner to run it. ' +
    'A damaged file is restored on its own: git restore <file>.';
}

function main(input) {
  let p = {};
  try { p = JSON.parse(input || '{}'); } catch (_) { return ''; }
  if (p.toolCall) {                                   // Antigravity
    const line = (p.toolCall.args || {}).CommandLine || (p.toolCall.args || {}).commandLine || '';
    const hit = judge(line);
    if (hit) return JSON.stringify({ decision: 'deny', reason: reasonFor(hit) });
    // Antigravity requires a decision for every call: {} reads as a denial with
    // no reason, and every command fails (tested on the board, #1008). So a
    // command the guard has nothing against gets the owner's choice, set at
    // install time: "ask" (Antigravity asks, honouring "Always Allow") or
    // "allow" (it runs, as with auto-execution on). "ask" unless told otherwise:
    // a guard must never quietly loosen someone's review setting.
    return JSON.stringify({ decision: process.env.AGENT_BRIDGE_SAFE_COMMANDS === 'allow' ? 'allow' : 'ask' });
  }
  if (p.tool_input) {                                 // Claude Code
    const hit = judge(p.tool_input.command || '');
    if (!hit) return '';
    return JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reasonFor(hit) } });
  }
  return '';
}

if (require.main === module) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { buf += d; });
  process.stdin.on('end', () => {
    let out = '';
    try { out = main(buf); } catch (_) { out = ''; }
    if (out) process.stdout.write(out);
  });
}

module.exports = { judge, main, RULES };
