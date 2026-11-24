'use strict';
// Talking to Antigravity from outside: start a conversation, send it a message.
//
// The application ships its own command for this — language_server.exe agentapi —
// and that command needs to be told where the running application listens and
// with which token. Both change on every start of Antigravity, so they are read
// from the live process each time, never kept.
//
//   agentapi new-conversation [--model=flash_lite|flash|pro|<id>] [--title=…] <prompt>
//   agentapi send-message <conversation id> <text>

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const HOME = process.env.USERPROFILE || os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const EXE = path.join(LOCALAPPDATA, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe');

const DAEMON_DIR = path.join(HOME, '.gemini', 'antigravity', 'daemon');

// Antigravity 2.34 (21.11.2026) no longer puts the token on the language server's command
// line: it reads it from stdin, and the bridge could not start a helper. For local clients
// it writes daemon/hub_<port>.json — { pid, httpsPort, httpPort, lsVersion, csrfToken } —
// one per start, old ones left behind. The newest whose language server is still alive.
function fromDaemonFile() {
  let files = [];
  try { files = fs.readdirSync(DAEMON_DIR).filter(f => /^hub_\d+\.json$/.test(f)); } catch (_) { return null; }
  const list = files.map(f => {
    const p = path.join(DAEMON_DIR, f);
    try { return { p, t: fs.statSync(p).mtimeMs }; } catch (_) { return null; }
  }).filter(Boolean).sort((a, b) => b.t - a.t);
  for (const { p } of list) {
    let j;
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { continue; }
    if (!j || !j.csrfToken || !Number(j.httpPort)) continue;
    try { process.kill(Number(j.pid), 0); } catch (e) { if (e.code !== 'EPERM') continue; }   // that start is gone
    return { port: Number(j.httpPort), csrf: String(j.csrfToken) };
  }
  return null;
}

// Where the running Antigravity listens. Throws with the reason when it cannot
// be reached — the caller decides whether that is worth a line in a log.
function locate() {
  if (!fs.existsSync(EXE)) throw new Error('Antigravity is not installed (' + EXE + ')');
  const d = fromDaemonFile();
  if (d) {
    return { exe: EXE, env: Object.assign({}, process.env, {
      ANTIGRAVITY_LS_ADDRESS: `localhost:${d.port}`, ANTIGRAVITY_CSRF_TOKEN: d.csrf }) };
  }
  // Before 2.34: the token on the command line, the port in the log.
  const cmd = "powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter 'name = ''language_server.exe''' | Select-Object -ExpandProperty CommandLine\"";
  const cmdline = execSync(cmd, { encoding: 'utf8', windowsHide: true });
  const csrf = cmdline.match(/--csrf_token\s+([0-9a-fA-F-]+)/);
  if (!csrf) throw new Error('no csrf token on the language_server command line — is Antigravity running?');
  const logPath = path.join(APPDATA, 'Antigravity', 'logs', 'language_server.log');
  if (!fs.existsSync(logPath)) throw new Error('no language_server log at ' + logPath);
  const ports = [...fs.readFileSync(logPath, 'utf8').matchAll(/listening on random port at (\d+) for HTTP$/gm)];
  if (!ports.length) throw new Error('no HTTP port line in the language_server log');
  return {
    exe: EXE,
    env: Object.assign({}, process.env, {
      ANTIGRAVITY_LS_ADDRESS: `localhost:${ports[ports.length - 1][1]}`,
      ANTIGRAVITY_CSRF_TOKEN: csrf[1]
    })
  };
}

// Deliver a message into a conversation. Fire and forget: the conversation
// answers on the board, not here.
function send(conversationId, text, where) {
  const at = where || locate();
  const child = spawn(at.exe, ['agentapi', 'send-message', conversationId, text], { env: at.env, windowsHide: true, stdio: 'ignore' });
  // Still fire and forget, but a refused delivery leaves a line instead of vanishing.
  child.on('exit', code => {
    if (code) try {
      fs.appendFileSync(path.join(__dirname, 'bridge_mcp.log'),
        `${new Date().toISOString()} agentapi send-message ${conversationId} exited ${code}` + '\n');
    } catch (_) {}
  });
  child.on('error', () => {});
  child.unref();
}

// One call to the application's local service (the one its own window uses).
function rpc(at, method, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const [host, port] = String(at.env.ANTIGRAVITY_LS_ADDRESS).split(':');
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = require('http').request({ host, port, method: 'POST', timeout: timeoutMs || 15000,
      path: '/exa.language_server_pb.LanguageServerService/' + method,
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1',
                 'x-codeium-csrf-token': at.env.ANTIGRAVITY_CSRF_TOKEN, 'Content-Length': data.length } }, res => {
      let s = '';
      res.on('data', c => { s += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Antigravity answered ' + res.statusCode + ': ' + s.slice(0, 200)));
        try { resolve(JSON.parse(s || '{}')); } catch (_) { reject(new Error('unreadable answer from Antigravity')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Antigravity did not answer in time')));
    req.on('error', reject);
    req.end(data);
  });
}

// Is the conversation at work now? 'running' | 'idle' | '' (not known). A light call: the
// summaries of all conversations, a few kilobytes, never a trajectory.
async function runState(conversationId, where) {
  const at = where || locate();
  const j = await rpc(at, 'GetAllCascadeTrajectories', {}, 8000);
  const s = ((j.trajectorySummaries || {})[conversationId] || {}).status || '';
  return /RUNNING/.test(s) ? 'running' : /IDLE/.test(s) ? 'idle' : '';
}

// Deliver a message to be answered on a model the sender picks — the internal name from the
// application's list (helper-models.js), e.g. MODEL_PLACEHOLDER_M526 for Gemini 4 Hydrogen (Medium).
// Measured 24.11 on Antigravity 2.34: a message with requestedModel runs on that model only when
// the conversation is idle; sent while it works, it is queued and runs on the conversation's own
// model. So this waits for idle (one waiter per conversation), up to waitMs, then sends; when it
// cannot — still busy at the limit, or the call refused — it delivers the plain way, on the
// conversation's own model, and leaves a line in the log. Fire and forget, like send().
const queues = new Map();
function sendAs(conversationId, text, modelName, opts) {
  const o = opts || {};
  const waitMs = o.waitMs === undefined ? 10 * 60e3 : o.waitMs;
  const log = line => { try { fs.appendFileSync(path.join(__dirname, 'bridge_mcp.log'), `${new Date().toISOString()} sendAs ${conversationId}: ${line}\n`); } catch (_) {} };
  const run = async () => {
    let at;
    try { at = o.where || locate(); } catch (e) { return log('not delivered - ' + e.message); }
    const until = Date.now() + waitMs;
    try {
      for (;;) {
        const st = await runState(conversationId, at).catch(() => '');
        if (st !== 'running') break;
        if (Date.now() >= until) { log(`still at work after ${Math.round(waitMs / 1000)} s: delivered on its own model`); return send(conversationId, text, at); }
        await new Promise(r => setTimeout(r, o.pollMs || 5000));
      }
      await rpc(at, 'SendUserCascadeMessage', { cascadeId: conversationId, items: [{ text }],
        cascadeConfig: { plannerConfig: { requestedModel: { model: modelName } } } });
    } catch (e) {
      log(`${modelName} refused (${e.message}): delivered on its own model`);
      send(conversationId, text, at);
    }
  };
  const next = (queues.get(conversationId) || Promise.resolve()).then(run, run);
  queues.set(conversationId, next);
  next.then(() => { if (queues.get(conversationId) === next) queues.delete(conversationId); });
  return next;
}

// Start a conversation and return its id.
function create({ model, title, prompt }) {
  return new Promise((resolve, reject) => {
    let at;
    try { at = locate(); } catch (e) { return reject(e); }
    const args = ['agentapi', 'new-conversation'];
    if (model) args.push('--model=' + model);
    if (title) args.push('--title=' + title);
    args.push(prompt);
    const child = spawn(at.exe, args, { env: at.env, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error('agentapi exited with ' + code + ': ' + err.trim().slice(0, 300)));
      try {
        const id = (((JSON.parse(out).response || {}).newConversation || {}).conversationId) || '';
        if (!id) throw new Error('no conversation id in: ' + out.slice(0, 200));
        resolve(id);
      } catch (e) { reject(e); }
    });
  });
}

// Delete a conversation for good, with the call the application's own UI makes
// (LanguageServerService/DeleteCascadeTrajectory; agentapi has no delete). Only an id shaped like
// an Antigravity conversation is ever sent: an empty or odd one is refused here, never passed on.
function remove(conversationId) {
  return new Promise((resolve, reject) => {
    const id = String(conversationId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return reject(new Error('not an Antigravity conversation id: "' + id + '"'));
    }
    let at;
    try { at = locate(); } catch (e) { return reject(e); }
    const [host, port] = at.env.ANTIGRAVITY_LS_ADDRESS.split(':');
    const data = Buffer.from(JSON.stringify({ cascadeId: id }));
    const req = require('http').request({ host, port, method: 'POST', timeout: 15000,
      path: '/exa.language_server_pb.LanguageServerService/DeleteCascadeTrajectory',
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1',
                 'x-codeium-csrf-token': at.env.ANTIGRAVITY_CSRF_TOKEN, 'Content-Length': data.length } }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => res.statusCode === 200 ? resolve(true) : reject(new Error('Antigravity answered ' + res.statusCode + ': ' + body.slice(0, 200))));
    });
    req.on('timeout', () => req.destroy(new Error('Antigravity did not answer in time')));
    req.on('error', reject);
    req.end(data);
  });
}

module.exports = { locate, send, sendAs, runState, create, remove };
