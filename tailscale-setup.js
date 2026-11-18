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

// The board's port, to tailnet addresses only, on every network profile (Windows may file the Tailscale
// adapter under any). Shared with install-bridge.js, which calls it where Tailscale is installed.
function ensureTailnetRule(opts) {
  const o = opts || {};
  if (process.platform !== 'win32') return 'not windows';
  if (!exe()) return 'no tailscale';
  const port = Number(process.env.AGENT_BRIDGE_PORT) || 8787;
  const name = 'Agent Bridge board (tailnet)';
  const has = () => run('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=' + name]).status === 0;
  if (has()) { say('✅ Windows Firewall: the tailnet rule is in place (port ' + port + ', 100.64.0.0/10).'); return 'present'; }
  const args = `advfirewall firewall add rule name="${name}" dir=in action=allow protocol=TCP localport=${port} remoteip=100.64.0.0/10 profile=any`;
  if (o.dry) { say('would add the firewall rule: netsh ' + args); return 'dry'; }
  say('… Windows Firewall: a rule for your tailnet only (port ' + port + ', 100.64.0.0/10). Windows will ask for permission.');
  run('powershell', ['-NoProfile', '-Command', `Start-Process netsh -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '${args}'`]);
  if (has()) { say('✅ Windows Firewall: tailnet rule added.'); return 'added'; }
  say('⚠️ Windows Firewall: the tailnet rule was not added. In an administrator console: netsh ' + args);
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

module.exports = { ensureTailnetRule };
if (require.main === module) process.exitCode = main();
