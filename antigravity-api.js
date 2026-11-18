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

// Where the running Antigravity listens. Throws with the reason when it cannot
// be reached — the caller decides whether that is worth a line in a log.
function locate() {
  if (!fs.existsSync(EXE)) throw new Error('Antigravity is not installed (' + EXE + ')');
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

module.exports = { locate, send, create, remove };
