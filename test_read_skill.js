'use strict';
// node test_read_skill.js — the chat app is pointed at read_skill, Claude Code is not,
// and read_skill serves the installed skill and nothing outside it. Speaks JSON-RPC
// to its own server over stdio; nothing is posted.
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

function session(clientName, calls) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, { AGENT_BRIDGE_NO_WAKE: '1' });
    const srv = spawn(process.execPath, [path.join(__dirname, 'agent-bridge-mcp.js')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const out = {}; let buf = '';
    srv.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        out[msg.id] = msg;
        if (Object.keys(out).length === calls.length + 1) { srv.kill(); resolve(out); }
      }
    });
    setTimeout(() => { srv.kill(); reject(new Error('no answer from the server')); }, 20000);
    const send = o => srv.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: clientName, version: '1' } } });
    calls.forEach((c, k) => send({ jsonrpc: '2.0', id: k + 1, method: 'tools/call', params: { name: 'read_skill', arguments: c } }));
  });
}
const text = r => (r.result && r.result.content && r.result.content[0].text) || (r.error && r.error.message) || JSON.stringify(r);

(async () => {
  const chat = await session('claude-ai', [{}, { name: 'agent-bridge' }, { name: 'agent-bridge', file: '../agent-workflow/SKILL.md' }, { name: 'no-such-skill' }]);
  assert.ok(/read_skill/.test(chat[0].result.instructions || ''), 'the chat app is told about read_skill');
  assert.ok(/^agent-bridge — /m.test(text(chat[1])), 'list names agent-bridge');
  assert.ok(/^name: agent-bridge/m.test(text(chat[2])), 'SKILL.md served');
  assert.ok(/outside the skill/.test(text(chat[3])), 'no climbing out of the skill folder');
  assert.ok(/not installed/.test(text(chat[4])), 'unknown skill named as such');
  console.log('ok chat app: instructions, list, read, refusals');

  const code = await session('claude-code', [{ name: 'agent-bridge', file: 'PROTOCOL.md' }]);
  assert.strictEqual(code[0].result.instructions, undefined, 'Claude Code is not told again');
  assert.ok(text(code[1]).length > 1000, 'PROTOCOL.md served');
  console.log('ok claude-code: no instructions, files readable');
})().catch(e => { console.error(e.message); process.exit(1); });
