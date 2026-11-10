'use strict';
// A consultant in the room: a message addressed to Argon is answered there, by Argon.
//
// "Argon" is whatever deep-reasoning model the owner has put behind an MCP server with an
// `ask_argon` tool. Until now each agent called that tool from its own session and the
// answer stayed in that session. Here the board is the client: a message in a room that
// is addressed to Argon (to: "Argon"), or that begins with "@Argon", is passed on with
// the last few lines of the room as context, and the answer is posted into the same room
// as a reply — so the owner and both agents read one answer, and either agent can ask.
//
// The server is the one already configured on this machine: bridge_config.json →
// "argon": { "command": …, "args": […] }, or, when that is absent, the "gemini-argon"
// entry of the Claude configuration. Nothing configured — the feature is off, and a
// message to Argon gets one line saying so. One question at a time; each room keeps
// its own Argon conversation (`project`), so rooms never mix.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const NAME = 'Argon';
const SESSION = 'argon/room';
const CONTEXT_MESSAGES = 8;
const CONTEXT_CHARS = 1500;
const QUESTION_CHARS = 20000;
const TIMEOUT_S = 600;

function isForArgon(m) {
  if ([SESSION, 'supervisor/board'].includes(String(m.fromSession || ''))) return false;
  if (String(m.to || '').trim().toLowerCase() === 'argon') return true;
  return /^\s*(?:>.*\n|\s)*@argon\b/i.test(String(m.message || ''));
}

function serverConfig(home) {
  try {
    const own = JSON.parse(fs.readFileSync(path.join(home, 'bridge_config.json'), 'utf8')).argon;
    if (own === false || (own && own.enabled === false)) return null;
    if (own && own.command) return { command: own.command, args: own.args || [], env: own.env || {} };
  } catch (_) {}
  const places = [path.join(os.homedir(), '.claude.json'),
                  path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json')];
  for (const p of places) {
    try {
      const s = (JSON.parse(fs.readFileSync(p, 'utf8')).mcpServers || {})['gemini-argon'];
      if (s && s.command) return { command: s.command, args: s.args || [], env: s.env || {} };
    } catch (_) {}
  }
  return null;
}

// One tools/call against a freshly started MCP server over stdio; the server is closed after.
function callTool(cfg, name, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.command, cfg.args, { env: Object.assign({}, process.env, cfg.env), windowsHide: true });
    let buf = '', done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch (_) {} err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error('no answer in ' + Math.round(timeoutMs / 1000) + ' s')), timeoutMs);
    const send = o => child.stdin.write(JSON.stringify(o) + '\n');
    child.on('error', e => finish(e));
    child.on('close', () => finish(new Error('the Argon server closed before answering')));
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
        } else if (msg.id === 2) {
          if (msg.error) return finish(new Error(msg.error.message || 'tool error'));
          const text = ((msg.result || {}).content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
          if ((msg.result || {}).isError) return finish(new Error(text || 'tool error'));
          finish(null, text);
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize',
           params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-bridge-board', version: '1' } } });
  });
}

function createArgonRoom({ bridgeDb, home, post }) {
  let cursor = 0, busy = false, timer = null;
  const queue = [];

  function prompt(m) {
    const room = m.room ? bridgeDb.getRoom(m.room) : null;
    const before = bridgeDb.readAllMessages().filter(x => (x.room || '') === (m.room || '') && x.id < m.id &&
      String(x.fromSession || '') !== 'supervisor/board').slice(-CONTEXT_MESSAGES);
    const cut = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n) + ' […]' : s; };
    return 'You are consulted in a shared work room of AI agents and their owner' + (room ? ` ("${room.name}")` : '') + '. ' +
      'Answer the question at the end. Your answer is posted into the room as it is: be direct, give the reasoning that matters, ' +
      'say what you are unsure of, and do not address anyone by a role they did not sign with.\n\n' +
      (before.length ? '--- The room so far (oldest first) ---\n' +
        before.map(x => `#${x.id} ${x.from}: ${cut(x.message, CONTEXT_CHARS)}`).join('\n\n') + '\n\n' : '') +
      `--- The question, #${m.id}, from ${m.from} ---\n` + cut(String(m.message).replace(/^\s*@argon\b[:,]?\s*/i, ''), QUESTION_CHARS);
  }

  const say = (m, text, status) => post({
    from: NAME, fromSession: SESSION, room: m.room || '', to: m.from, toSession: /^human/i.test(m.fromSession || '') ? '' : (m.fromSession || ''),
    replyTo: m.id, status, topic: m.topic || 'argon', priority: 'normal', text });

  async function work() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const m = queue.shift();
        const cfg = serverConfig(home);
        if (!cfg) { say(m, 'Argon is not connected to this board: no "argon" entry in bridge_config.json and no "gemini-argon" MCP server in the Claude configuration.', 'blocked'); continue; }
        say(m, 'Argon has the question; the answer will be posted here.', 'working');
        try {
          const room = m.room ? bridgeDb.getRoom(m.room) : null;
          const answer = await callTool(cfg, 'ask_argon',
            { prompt: prompt(m), project: 'Board room: ' + (room ? room.name : 'Square'), timeout_seconds: TIMEOUT_S }, (TIMEOUT_S + 60) * 1000);
          say(m, answer || '(Argon returned an empty answer.)', 'answer');
        } catch (e) {
          // Out of quota is the owner's to fix, and only by switching the account: he is told so, urgently.
          if (/out of quota|LIMIT:/i.test(e.message)) {
            say(m, 'Argon is out of quota on the account Gemini Desktop is signed in with: ' + e.message + ' Nothing was sent.', 'blocked');
            post({ from: 'Supervisor', fromSession: 'supervisor/board', room: m.room || '', to: 'all', toSession: 'human/web', priority: 'P0',
                   status: 'blocked', topic: 'supervisor', text: 'Supervisor: switch the Gemini Desktop account — Argon is out of quota (' + e.message + ').' });
          } else {
            say(m, 'Argon did not answer: ' + e.message + '. Is Gemini Desktop running from its "Gemini (Argon)" shortcut?', 'blocked');
          }
        }
      }
    } finally { busy = false; }
  }

  function scan() {
    let fresh = [];
    try { fresh = bridgeDb.readAllMessages({ since: cursor }); } catch (_) { return; }
    for (const m of fresh) {
      cursor = Math.max(cursor, m.id);
      if (isForArgon(m)) queue.push(m);
    }
    if (queue.length) work().catch(() => {});
  }

  function start() {
    try { cursor = bridgeDb.getDb().prepare('SELECT COALESCE(MAX(id), 0) n FROM messages').get().n; } catch (_) {}
    timer = setInterval(scan, 3000);
    if (timer.unref) timer.unref();
  }

  return { start, scan, connected: () => !!serverConfig(home) };
}

module.exports = { createArgonRoom, isForArgon, serverConfig, callTool, NAME, SESSION };
