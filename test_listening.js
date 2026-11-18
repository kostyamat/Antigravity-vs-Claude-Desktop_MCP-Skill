'use strict';
// node test_listening.js — whether a Claude window hears the board (a live watchman lock in run/), and
// the hint post_message gives a Claude sender when its addressee does not: ring it with SendMessage.
// The MCP server is spoken to over stdio on a fresh board in a temporary folder; the live board is not touched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { listening } = require('./listening');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-listen-'));
const run = path.join(tmp, 'run');
fs.mkdirSync(run);
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok ' + name); };

(async () => {
  await t('no lock: not listening; a lock with a live pid: listening; a dead pid: not', () => {
    assert.strictEqual(listening('local_a', run), false);
    fs.writeFileSync(path.join(run, 'rewake_local_a.json'), JSON.stringify({ pid: process.pid }));
    assert.strictEqual(listening('local_a', run), true);
    fs.writeFileSync(path.join(run, 'rewake_local_a.json'), JSON.stringify({ pid: 999999 }));
    assert.strictEqual(listening('local_a', run), false);
    assert.strictEqual(listening('gem-uuid', run), null, 'only Claude windows are judged');
  });

  // The real server on a board copy.
  const home = path.join(tmp, 'board');
  fs.mkdirSync(home);
  for (const f of fs.readdirSync(__dirname)) if (/\.(js|json|md)$/.test(f) && !/^test_/.test(f) && f !== 'bridge_config.json') fs.copyFileSync(path.join(__dirname, f), path.join(home, f));
  for (const d of ['locales', 'skill']) if (fs.existsSync(path.join(__dirname, d))) fs.cpSync(path.join(__dirname, d), path.join(home, d), { recursive: true });
  const env = Object.assign({}, process.env, { USERPROFILE: tmp, HOME: tmp, AGENT_BRIDGE_NO_WAKE: '1', BRIDGE_RUN_DIR: path.join(home, 'run') });
  const srv = spawn(process.execPath, [path.join(home, 'agent-bridge-mcp.js')], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', id = 0; const wait = {};
  srv.stdout.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const j = JSON.parse(l); if (wait[j.id]) wait[j.id](j); } catch (_) {} } });
  const call = (method, params) => new Promise(r => { const k = ++id; wait[k] = r; srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n'); });
  const post = async args => { const r = await call("tools/call", { name: "post_message", arguments: args }); return r.result ? r.result.content[0].text : JSON.stringify(r.error); };
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    await call('tools/call', { name: 'create_room', arguments: { sender: 'Claude', sessionId: 'local_sender-x', name: 'pair', cards: ['local_sender-x', 'local_sleeper-y'] } });
    await t('a Claude sender writing to a window that is not listening is told to ring it', async () => {
      const text = await post({ sender: 'Claude', sessionId: 'local_sender-x', to: 'Claude', toSession: 'local_sleeper-y', message: 'please look' });
      assert.match(text, /Recorded as #/);
      assert.match(text, /is not listening to the board[\s\S]*SendMessage/);
    });
    await t('…and not when that window is listening', async () => {
      fs.mkdirSync(path.join(home, 'run'), { recursive: true });
      fs.writeFileSync(path.join(home, 'run', 'rewake_local_sleeper-y.json'), JSON.stringify({ pid: process.pid }));
      const text = await post({ sender: 'Claude', sessionId: 'local_sender-x', to: 'Claude', toSession: 'local_sleeper-y', message: 'second look' });
      assert.doesNotMatch(text, /not listening/);
    });
  } finally {
    srv.kill();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(n + '/3 passed');
})().catch(e => { console.error(e); process.exit(1); });
