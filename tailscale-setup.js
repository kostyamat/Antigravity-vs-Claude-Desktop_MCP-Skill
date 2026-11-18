#!/usr/bin/env node
'use strict';
// Puts this machine into the owner's Tailscale network, so that a board in another corner of the
// planet can link to it (owner, 18.11.2026: "publish 2.8.12 with an installer that sets up Tailscale").
//
//   install-tailscale.cmd               install Tailscale if missing, then sign in (the browser opens;
//                                       the owner signs in himself — nothing here touches his password)
//   install-tailscale.cmd <auth key>    the same, joining with a one-time key the owner made in Tailscale's
//                                       admin page: how a friend's machine joins without his account
//   --dry-run                           say what would be done, do nothing
//
// Then the board's port is opened to tailnet addresses only (100.64.0.0/10). Nothing else is opened:
// the link between boards has no password, the tailnet is what keeps strangers out.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DRY = process.argv.includes('--dry-run');
const say = s => console.log('  ' + s);
const exe = () => {
  if (process.platform !== 'win32') return 'tailscale';
  const p = path.join(process.env.ProgramFiles || '', 'Tailscale', 'tailscale.exe');
  return process.env.ProgramFiles && fs.existsSync(p) ? p : '';
};
const run = (cmd, args, inherit) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: !inherit, stdio: inherit ? 'inherit' : 'pipe', timeout: 15 * 60000 });

// The tailnet reaches this machine's board and nothing else (owner, 18.11: set the tailnet up so that it gives
// access to the bridge only). From 100.64.0.0/10, on every network profile (Windows may file the Tailscale adapter under
// any): the board's port is allowed, and every other TCP port, all UDP and ping are blocked — a block rule wins
// over any other program's allow rule, so file sharing, remote desktop and the rest stay closed to the tailnet.
// Shared with install-bridge.js, which calls it where Tailscale is installed. One permission prompt for all.
const TAILNET = '100.64.0.0/10';
function tailnetRules(port) {
  const base = `dir=in remoteip=${TAILNET} profile=any`;
  return [
    { name: 'Agent Bridge board (tailnet)', args: `action=allow protocol=TCP localport=${port} ${base}` },
    { name: 'Agent Bridge (tailnet: no other TCP)', args: `action=block protocol=TCP localport=1-${port - 1},${port + 1}-65535 ${base}` },
    { name: 'Agent Bridge (tailnet: no UDP)', args: `action=block protocol=UDP localport=any ${base}` },
    { name: 'Agent Bridge (tailnet: no ping)', args: `action=block protocol=icmpv4:any,any ${base}` }
  ];
}
function ensureTailnetRule(opts) {
  const o = opts || {};
  if (process.platform !== 'win32') return 'not windows';
  if (!exe()) return 'no tailscale';
  const port = Number(process.env.AGENT_BRIDGE_PORT) || 8787;
  const has = name => run('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=' + name]).status === 0;
  const missing = tailnetRules(port).filter(r => !has(r.name));
  if (!missing.length) { say('✅ Windows Firewall: the tailnet reaches the board (port ' + port + ') and nothing else.'); return 'present'; }
  const cmds = missing.map(r => `netsh advfirewall firewall add rule name="${r.name}" ${r.args}`);
  if (o.dry) { say('would add, as administrator:\n    ' + cmds.join('\n    ')); return 'dry'; }
  say('… Windows Firewall: the tailnet gets the board (port ' + port + ') and nothing else. Windows will ask for permission once.');
  run('powershell', ['-NoProfile', '-Command', `Start-Process cmd -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '/c ${cmds.join(' & ').replace(/'/g, "''")}'`]);
  const still = tailnetRules(port).filter(r => !has(r.name));
  if (!still.length) { say('✅ Windows Firewall: from the tailnet only the board is reachable.'); return 'added'; }
  say('⚠️ Windows Firewall: not added: ' + still.map(r => r.name).join(', ') + '. In an administrator console:\n    ' +
    still.map(r => `netsh advfirewall firewall add rule name="${r.name}" ${r.args}`).join('\n    '));
  return 'failed';
}

function main() {
  console.log('\nTailscale for Agent Bridge — linking boards across the internet\n');
  const key = process.argv.slice(2).find(a => !a.startsWith('--')) || '';
  if (key && !/^tskey-[\w-]+$/.test(key)) { say('✖ That is not a Tailscale auth key (it starts with "tskey-").'); return 1; }

  // 1. Tailscale itself.
  if (!exe()) {
    if (process.platform !== 'win32') { say('Install Tailscale for this system: https://tailscale.com/download — then run this again.'); return 1; }
    const winget = run('where', ['winget']).status === 0;
    if (!winget) { say('✖ winget is not here. Install Tailscale from https://tailscale.com/download and run this again.'); return 1; }
    const args = ['install', '--id', 'Tailscale.Tailscale', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'];
    if (DRY) say('would install Tailscale: winget ' + args.join(' '));
    else {
      say('… installing Tailscale (winget). Windows may ask for permission.');
      run('winget', args, true);
      if (!exe()) { say('✖ Tailscale did not install. Install it from https://tailscale.com/download and run this again.'); return 1; }
      say('✅ Tailscale installed.');
    }
  } else say('✅ Tailscale is installed.');

  // 2. In the tailnet: already, or by signing in (the owner, in his browser), or with a one-time key.
  let state = '';
  if (exe()) { try { state = JSON.parse(run(exe(), ['status', '--json']).stdout || '{}').BackendState || ''; } catch (_) {} }
  if (state === 'Running') say('✅ This machine is already in your tailnet.');
  else {
    const args = ['up'].concat(key ? ['--authkey=' + key] : []);
    if (DRY) say('would join the tailnet: tailscale ' + (key ? 'up --authkey=<the key>' : 'up') + (key ? '' : ' (sign in in the browser)'));
    else {
      say(key ? '… joining your tailnet with the one-time key.' : '… signing in: a browser page opens (or a link is printed) — sign in there with your Tailscale account.');
      run(exe() || 'tailscale', args, true);
      try { state = JSON.parse(run(exe(), ['status', '--json']).stdout || '{}').BackendState || ''; } catch (_) {}
      if (state !== 'Running') { say('⚠️ Not in the tailnet yet (' + (state || 'unknown') + '). Finish the sign-in and run this again.'); return 1; }
      say('✅ In your tailnet.');
    }
  }

  // 3. The board's port, to the tailnet only.
  ensureTailnetRule({ dry: DRY });
  console.log('\n  Next: on the board page, Machines → Find. The other machine of your tailnet is listed; Link it, and press Allow');
  console.log('  on that machine. Never open the board\'s port to the internet itself.\n');
  return 0;
}

// ── for the board page (Machines → Tailscale): the owner joins without a console ──────────────────────

// { installed, state, name, ip, peers } — state "Running" when this machine is in the tailnet.
function status() {
  const e = exe();
  if (!e) return { installed: false };
  let s = {};
  try { s = JSON.parse(run(e, ['status', '--json']).stdout || '{}'); } catch (_) {}
  const self = s.Self || {};
  const peers = Object.values(s.Peer || {}).filter(p => p && p.Online !== false).map(p => p.HostName).filter(Boolean);
  return { installed: true, state: s.BackendState || 'unknown', name: self.HostName || '', ip: (self.TailscaleIPs || []).find(ip => /^100\./.test(ip)) || '', peers };
}

const { spawn } = require('child_process');
// Install with winget (Windows asks for permission). Resolves when done.
function install() {
  return new Promise((resolve, reject) => {
    if (exe()) return resolve(status());
    if (process.platform !== 'win32') return reject(new Error('install Tailscale from https://tailscale.com/download'));
    const p = spawn('winget', ['install', '--id', 'Tailscale.Tailscale', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'], { windowsHide: true });
    p.on('error', () => reject(new Error('winget is not here — install Tailscale from https://tailscale.com/download')));
    p.on('close', () => exe() ? resolve(status()) : reject(new Error('Tailscale did not install — https://tailscale.com/download')));
  });
}
// Join with a one-time key made in Tailscale's admin page. Then the board's port is opened to the tailnet.
function join(key) {
  const k = String(key || '').trim();
  if (!/^tskey-[\w-]+$/.test(k)) return Promise.reject(new Error('that is not a Tailscale auth key (it starts with "tskey-")'));
  // A friend's machine usually has no Tailscale yet: the key is all it needs — install first, then join.
  if (!exe()) return install().then(() => join(k));
  return new Promise((resolve, reject) => {
    const p = spawn(exe(), ['up', '--authkey=' + k], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => reject(e));
    p.on('close', () => {
      const s = status();
      if (s.state !== 'Running') return reject(new Error('not in the tailnet: ' + (err.trim().slice(0, 200) || s.state)));
      try { ensureTailnetRule(); } catch (_) {}
      resolve(s);
    });
  });
}
// Sign in in the owner's browser: resolves with the login link Tailscale prints; the sign-in finishes there.
function signIn() {
  return new Promise((resolve, reject) => {
    if (!exe()) return reject(new Error('Tailscale is not installed'));
    if (status().state === 'Running') return resolve({ already: true });
    const p = spawn(exe(), ['up'], { windowsHide: true, detached: true });
    let out = '', done = false;
    const look = d => {
      out += d;
      const m = /https:\/\/login\.tailscale\.com\/\S+/.exec(out);
      if (m && !done) { done = true; resolve({ url: m[0] }); }
    };
    p.stdout.on('data', look); p.stderr.on('data', look);
    p.on('error', e => { if (!done) { done = true; reject(e); } });
    p.on('close', () => { if (!done) { done = true; status().state === 'Running' ? resolve({ already: true }) : reject(new Error(out.trim().slice(0, 200) || 'no sign-in link')); } });
    setTimeout(() => { if (!done) { done = true; reject(new Error('Tailscale gave no sign-in link in time')); } }, 30000).unref();
    p.unref();
  });
}

module.exports = { ensureTailnetRule, tailnetRules, status, install, join, signIn };
if (require.main === module) process.exitCode = main();
