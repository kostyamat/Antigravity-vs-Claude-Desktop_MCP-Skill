'use strict';
// node test_guard_heredoc.js — in Claude Code's Bash a heredoc is refused when it would lose a
// backslash (unquoted delimiter, or a doubled backslash) and let through when it would not;
// for Antigravity a heredoc with any backslash is refused.
const assert = require('assert');
const { main, heredocWithBackslash, heredocTrouble } = require('./command-guard');

const nl = String.fromCharCode(10), bs = String.fromCharCode(92);
const quotedSingle = "cat > x.js <<'EOF'" + nl + 'const re = /' + bs + 'd+/; // C:' + bs + 'repos' + nl + 'EOF';
const quotedDoubled = "cat > x.js <<'EOF'" + nl + "const p = 'C:" + bs + bs + "repos';" + nl + 'EOF';
const unquoted = 'cat > x.sh <<EOF' + nl + 'echo ' + bs + '$HOME' + nl + 'EOF';
const plain = 'git commit -q -F - <<EOF' + nl + 'docs: plain message' + nl + 'EOF';
const claude = cmd => JSON.parse(main(JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } })) || '{}');
const denied = cmd => (claude(cmd).hookSpecificOutput || {}).permissionDecision === 'deny';
let n = 0;
const ok = (cond, name) => { assert.ok(cond, name); n++; };

// Claude Code: what is lost is refused, what arrives as written is not.
ok(heredocTrouble(quotedSingle) === '', 'quoted, single backslashes: safe');
ok(heredocTrouble(quotedDoubled) === 'doubled', 'quoted, a doubled backslash: lost');
ok(heredocTrouble(unquoted) === 'unquoted', 'unquoted with a backslash: rewritten by the shell');
ok(heredocTrouble(plain) === '', 'no backslash at all');
ok(heredocTrouble('echo a ' + bs + bs + '| b') === '', 'no heredoc, no opinion');
ok(heredocTrouble('cat <<"END"' + nl + 'C:' + bs + 'repos' + nl + 'END') === '', 'a double-quoted delimiter is quoted too');
ok(heredocTrouble("cat <<'A'" + nl + 'x' + nl + 'A' + nl + 'cat <<B' + nl + bs + 'd' + nl + 'B') === 'unquoted', 'the second heredoc counts');
ok(!denied(quotedSingle), 'a safe quoted heredoc runs');
ok(denied(quotedDoubled) && /doubled backslash/.test(claude(quotedDoubled).hookSpecificOutput.permissionDecisionReason), 'refused, with the reason');
ok(denied(unquoted) && /quote the delimiter/.test(claude(unquoted).hookSpecificOutput.permissionDecisionReason), 'refused, told to quote');
ok(main(JSON.stringify({ tool_name: 'Bash', tool_input: { command: plain } })) === '', 'a commit message runs');
ok(main(JSON.stringify({ tool_name: 'PowerShell', tool_input: { command: quotedDoubled } })) === '', 'Bash only');

// Antigravity: one more layer of quoting on the way, so any backslash is refused; an
// ordinary command still gets its decision.
const gemini = cmd => JSON.parse(main(JSON.stringify({ toolCall: { args: { CommandLine: cmd } } })));
const viaWsl = 'wsl -u root -e bash -c "cat > /tmp/x.py <<' + "'EOF'" + nl + 'print(' + "'a" + bs + "nb')" + nl + 'EOF"';
ok(heredocWithBackslash(viaWsl) === true);
ok(gemini(viaWsl).decision === 'deny');
ok(/file-writing tool/.test(gemini(viaWsl).reason));
ok(gemini(plain).decision === 'ask', 'a heredoc without a backslash is not refused');
ok(gemini("@'" + nl + 'C:' + bs + 'repos' + nl + "'@ | Set-Content x.txt").decision === 'ask', 'a PowerShell here-string keeps its backslashes');
ok(gemini('git status').decision === 'ask');
console.log('ok ' + n + '/18');
