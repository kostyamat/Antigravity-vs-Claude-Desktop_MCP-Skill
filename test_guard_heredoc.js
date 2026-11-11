'use strict';
// node test_guard_heredoc.js — a Bash heredoc with a backslash is refused, one without is not.
const assert = require('assert');
const { main, heredocWithBackslash } = require('./command-guard');

const nl = String.fromCharCode(10), bs = String.fromCharCode(92);
const withBs = "cat > x.js <<'EOF'" + nl + "const re = /" + bs + "d+/;" + nl + 'EOF';
const plain = 'git commit -q -F - <<EOF' + nl + 'docs: plain message' + nl + 'EOF';
const deny = cmd => JSON.parse(main(JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } })) || '{}');

assert.strictEqual(heredocWithBackslash(withBs), true);
assert.strictEqual(heredocWithBackslash('cat <<"END"' + nl + 'C:' + bs + 'repos' + nl + 'END'), true);
assert.strictEqual(heredocWithBackslash(plain), false);
assert.strictEqual(heredocWithBackslash('echo a ' + bs + '| b'), false, 'no heredoc, no opinion');
assert.strictEqual(deny(withBs).hookSpecificOutput.permissionDecision, 'deny');
assert.strictEqual(main(JSON.stringify({ tool_name: 'Bash', tool_input: { command: plain } })), '');
assert.strictEqual(main(JSON.stringify({ tool_name: 'PowerShell', tool_input: { command: withBs } })), '', 'Bash only');
console.log('ok 7/7');
