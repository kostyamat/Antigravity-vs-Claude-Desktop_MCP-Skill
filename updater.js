'use strict';
// Self-update: the board notices a new release and offers it; the owner's click installs it.
//
// A release is a zip published on the project's GitHub page — the same package a person
// unpacks over the old folder before running the installer. The board asks GitHub for the
// latest one a minute after it starts and every six hours (bridge_config.json →
// "updateCheck": false turns that off), and when its version is higher than the VERSION
// file here, shows the offer with what is new. Nothing is downloaded until the owner says so.
//
// Installing is what the owner would do by hand, in the same order and with two checks
// added: the package must match the size and the SHA-256 GitHub publishes for it, and the
// board database is snapshotted first. Then the package is unpacked over this folder and
// install-bridge.js is run, which restarts the board. The database, the documents and the
// settings are not in a package and are not touched.
//
// A folder that is a git checkout is never overwritten: it is somebody's working copy.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const REPO = 'kostyamat/Antigravity-vs-Claude-Desktop_MCP-Skill';
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET_FROM = `https://github.com/${REPO}/releases/download/`;
const EVERY_MS = 6 * 3600e3;
const MAX_BYTES = 50e6;

// "2.10.0" > "2.9.3"
function newer(a, b) {
  const n = v => String(v || '').replace(/^v/, '').split('.').map(x => parseInt(x, 10) || 0);
  const x = n(a), y = n(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

function get(url, { binary, hops = 5 } = {}) {
  return new Promise((resolve, reject) => {
    if (!/^https:\/\//.test(url)) return reject(new Error('not an https address'));
    const rq = https.get(url, { headers: { 'User-Agent': 'agent-bridge-updater', Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json' }, timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (!hops) return reject(new Error('too many redirects'));
        return resolve(get(new URL(res.headers.location, url).toString(), { binary, hops: hops - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('GitHub answered ' + res.statusCode)); }
      const parts = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > MAX_BYTES) { rq.destroy(new Error('the download is too large')); return; } parts.push(c); });
      res.on('end', () => resolve(binary ? Buffer.concat(parts) : Buffer.concat(parts).toString('utf8')));
    });
    rq.on('timeout', () => rq.destroy(new Error('GitHub did not answer')));
    rq.on('error', reject);
  });
}

// The bold lead of each paragraph of the release text — the same lines the changelog opens with.
function leads(body) {
  return (String(body || '').match(/^\*\*[^*\n]+\*\*/gm) || []).map(s => s.replace(/\*\*/g, '').trim()).slice(0, 8);
}

// runInstaller is replaceable so that a test can install into a throw-away folder
// without registering that folder with the agents.
function createUpdater({ home, bridgeDb, dbBackup, runInstaller }) {
  const current = () => { try { return fs.readFileSync(path.join(home, 'VERSION'), 'utf8').trim(); } catch (_) { return ''; } };
  const enabled = () => { try { return JSON.parse(fs.readFileSync(path.join(home, 'bridge_config.json'), 'utf8')).updateCheck !== false; } catch (_) { return true; } };
  const checkout = () => fs.existsSync(path.join(home, '.git'));
  let state = { latest: '', page: '', notes: [], asset: null, checkedAt: '', error: '', installing: false };

  async function check() {
    try {
      const rel = JSON.parse(await get(LATEST));
      const a = (rel.assets || []).find(x => /^Agent-Bridge-v[\d.]+\.zip$/.test(x.name));
      state = Object.assign(state, {
        latest: String(rel.tag_name || '').replace(/^v/, ''), page: rel.html_url || '', notes: leads(rel.body),
        asset: a ? { name: a.name, url: a.browser_download_url, size: a.size, digest: a.digest || '' } : null,
        checkedAt: new Date().toISOString(), error: ''
      });
    } catch (e) {
      state = Object.assign(state, { checkedAt: new Date().toISOString(), error: e.message });
    }
    return view();
  }

  function view() {
    const cur = current();
    return { current: cur, latest: state.latest, available: !!state.latest && newer(state.latest, cur), page: state.page,
             notes: state.notes, checkout: checkout(), enabled: enabled(), checkedAt: state.checkedAt, error: state.error,
             installing: state.installing };
  }

  function unpack(zip, into) {
    const r = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          'Expand-Archive -LiteralPath $env:AB_ZIP -DestinationPath $env:AB_OUT -Force'],
          { env: Object.assign({}, process.env, { AB_ZIP: zip, AB_OUT: into }), windowsHide: true, timeout: 120000, encoding: 'utf8' })
      : spawnSync('unzip', ['-q', '-o', zip, '-d', into], { timeout: 120000, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('could not unpack the package: ' + String(r.stderr || r.error || '').trim().slice(0, 200));
  }

  async function install() {
    if (state.installing) return { error: 'an update is already being installed' };
    await check();
    const v = view();
    if (state.error) return { error: 'could not reach GitHub: ' + state.error };
    if (!v.available) return { error: 'this is the latest version (' + v.current + ')' };
    if (v.checkout) return { error: 'this folder is a git checkout — update it with git pull, then run install-bridge' };
    const a = state.asset;
    if (!a || !a.url.startsWith(ASSET_FROM)) return { error: 'release ' + v.latest + ' has no package to install' };
    if (!/^sha256:[0-9a-f]{64}$/.test(a.digest)) return { error: 'GitHub publishes no checksum for this package; install it by hand from ' + v.page };
    state.installing = true;
    try {
      const data = await get(a.url, { binary: true });
      const sum = 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
      if (data.length !== a.size || sum !== a.digest) return { error: 'the downloaded package does not match its checksum; nothing was changed' };
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-update-'));
      const zip = path.join(work, a.name);
      fs.writeFileSync(zip, data);
      unpack(zip, work);
      const src = path.join(work, 'agent-bridge');
      let inside = '';
      try { inside = fs.readFileSync(path.join(src, 'VERSION'), 'utf8').trim(); } catch (_) {}
      if (inside !== v.latest || !fs.existsSync(path.join(src, 'install-bridge.js'))) {
        return { error: 'the package is not what the release says it is (VERSION "' + inside + '"); nothing was changed' };
      }
      let snapshot = '';
      try { snapshot = dbBackup.snapshot(bridgeDb, home); }
      catch (e) { return { error: 'could not snapshot the database first (' + e.message + '); nothing was changed' }; }
      fs.cpSync(src, home, { recursive: true, force: true });
      // The installer registers the skills and restarts the board — this very process.
      if (runInstaller) runInstaller(home);
      else spawn(process.execPath, [path.join(home, 'install-bridge.js')], { cwd: home, detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return { ok: true, from: v.current, to: v.latest, snapshot };
    } catch (e) {
      return { error: e.message };
    } finally {
      state.installing = false;
    }
  }

  function start() {
    const run = () => { if (enabled()) check().catch(() => {}); };
    setTimeout(run, 60000).unref();
    setInterval(run, EVERY_MS).unref();
  }

  return { start, check, view, install };
}

module.exports = { createUpdater, newer, leads };
