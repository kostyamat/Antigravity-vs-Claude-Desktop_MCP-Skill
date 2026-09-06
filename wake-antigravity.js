const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

const SCRIPTS_DIR = path.resolve(__dirname);
let lastWokenId = 0;

function wakeAntigravity(rec) {
  try {
    const id = Number(rec.id || 0);
    if (id && id <= lastWokenId) return;
    const to = (rec.to || 'all').toLowerCase();
    const from = (rec.from || '').toLowerCase();
    if (to !== 'gemini' && to !== 'all') return;

    if (id) lastWokenId = id;

    // Resolve target conversation IDs
    const targetConvIds = new Set();
    const isUuid = s => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s || '');

    const toSess = (rec.toSession || '').trim();

    if (toSess && toSess !== 'all') {
      // Direct addressing to a specific session or alias
      if (isUuid(toSess)) {
        targetConvIds.add(toSess);
      }
      try {
        const bridgeDb = require('./bridge-db');
        const aliases = bridgeDb.resolveSessionAliases(toSess);
        for (const a of aliases) {
          if (isUuid(a)) targetConvIds.add(a);
        }
      } catch (_) {}

      const convsFile = path.join(SCRIPTS_DIR, 'gemini_convs.json');
      if (fs.existsSync(convsFile)) {
        try {
          const convs = JSON.parse(fs.readFileSync(convsFile, 'utf8'));
          if (convs[toSess] && isUuid(convs[toSess])) {
            targetConvIds.add(convs[toSess]);
          }
        } catch (_) {}
      }
    } else {
      // Broadcast addressing: to: "all" or no specific toSession.
      // Do NOT wake all sessions on normal messages! Injecting prompts into
      // every open IDE window interrupts unrelated tasks and burns LLM tokens.
      // ONLY wake on explicit P0 broadcast emergency.
      if ((rec.priority || '').toUpperCase() === 'P0') {
        const convsFile = path.join(SCRIPTS_DIR, 'gemini_convs.json');
        if (fs.existsSync(convsFile)) {
          try {
            const convs = JSON.parse(fs.readFileSync(convsFile, 'utf8'));
            for (const [k, v] of Object.entries(convs)) {
              if (isUuid(v)) targetConvIds.add(v);
              if (isUuid(k)) targetConvIds.add(k);
            }
          } catch (_) {}
        }

        try {
          const bridgeDb = require('./bridge-db');
          const sessions = bridgeDb.readSessions();
          for (const [k, s] of Object.entries(sessions)) {
            if (s && (s.agent || '').toLowerCase() === 'gemini') {
              if (isUuid(s.sessionId)) targetConvIds.add(s.sessionId);
              const aliases = bridgeDb.resolveSessionAliases(s.sessionId);
              for (const a of aliases) {
                if (isUuid(a)) targetConvIds.add(a);
              }
            }
          }
        } catch (_) {}
      }
    }

    // Do not wake sender session if sender is Gemini
    if (from.startsWith('gemini')) {
      const fromSess = (rec.fromSession || '').trim();
      if (isUuid(fromSess)) targetConvIds.delete(fromSess);
      try {
        const bridgeDb = require('./bridge-db');
        const aliases = bridgeDb.resolveSessionAliases(fromSess);
        for (const a of aliases) {
          if (isUuid(a)) targetConvIds.delete(a);
        }
      } catch (_) {}
    }

    if (!targetConvIds.size) return;

    // Extract CSRF token from language_server.exe
    const cmd = "powershell -NoProfile -Command \"Get-WmiObject Win32_Process -Filter 'name = ''language_server.exe''' | Select-Object -ExpandProperty CommandLine\"";
    const cmdline = execSync(cmd, { encoding: 'utf8', windowsHide: true });
    const csrfMatch = cmdline.match(/--csrf_token\s+([0-9a-fA-F-]+)/);
    if (!csrfMatch) return;
    const csrf = csrfMatch[1];

    // Extract HTTP port from language_server.log
    const logPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Antigravity', 'logs', 'language_server.log');
    if (!fs.existsSync(logPath)) return;
    const log = fs.readFileSync(logPath, 'utf8');
    const matches = [...log.matchAll(/listening on random port at (\d+) for HTTP$/gm)];
    if (!matches.length) return;
    const port = matches[matches.length - 1][1];

    const bodyText = rec.text || rec.message || '';
    const prompt = `🔔 [NEW BOARD MESSAGE #${rec.id}]\nFrom: ${rec.from} (topic: ${rec.topic || 'no topic'})\n"${bodyText.slice(0, 300)}"\nGive immediate ACK with status: "working" or reply.`;
    const lsExe = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe');

    const env = Object.assign({}, process.env, {
      ANTIGRAVITY_LS_ADDRESS: `localhost:${port}`,
      ANTIGRAVITY_CSRF_TOKEN: csrf
    });

    for (const convId of targetConvIds) {
      const child = spawn(lsExe, ['agentapi', 'send-message', convId, prompt], { env, windowsHide: true, stdio: 'ignore' });
      child.unref();
    }
  } catch (e) {
    try {
      fs.appendFileSync(path.join(SCRIPTS_DIR, 'bridge_mcp.log'), `${new Date().toISOString()} wakeAntigravity error: ${e.message}\n`);
    } catch (_) {}
  }
}

module.exports = { wakeAntigravity };
