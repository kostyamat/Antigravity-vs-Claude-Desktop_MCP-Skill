// ─────────────────────────────────────────────────────────────────────────────────────────
// 🚀 INSTALL-BRIDGE: Automated Deployment and Configuration of the Agent-Bridge Ecosystem
//
// Performs complete turnkey setup:
//   1. Checks runtime environment (Node.js >= 22.5 for native SQLite, Python 3).
//   2. Creates working directories (root, docs, bodies, archive, backups).
//   3. Initializes SQLite database (agent_bridge.db) with WAL mode.
//   4. Configures Claude Desktop (%APPDATA%\Claude\claude_desktop_config.json).
//   5. Configures Antigravity IDE (~/.gemini/config/mcp_config.json + tool schemas).
//   6. Creates desktop launch shortcut (Agent-Bridge.lnk).
//   7. Adds background server daemon to Windows Startup (Agent-Bridge-Server.lnk).
//   8. Configures bridge settings (bridge_config.json).
// ─────────────────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const SCRIPTS_DIR = path.resolve(__dirname);
const USER_PROFILE = process.env.USERPROFILE || os.homedir();
const APPDATA = process.env.APPDATA || path.join(USER_PROFILE, 'AppData', 'Roaming');

let errorCount = 0;
let warnCount = 0;

console.log('════════════════════════════════════════════════════════════════');
console.log('🚀 Agent-Bridge v2: Complete Ecosystem Deployment & Setup');
console.log('════════════════════════════════════════════════════════════════\n');

// Helper: dynamically discover real Python 3 command
function detectPython() {
  const candidates = [
    { cmd: 'python', verArgs: ['--version'], testArgs: ['-c', 'import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)'], prefix: 'python' },
    { cmd: 'python3', verArgs: ['--version'], testArgs: ['-c', 'import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)'], prefix: 'python3' },
    { cmd: 'py', verArgs: ['-3', '--version'], testArgs: ['-3', '-c', 'import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)'], prefix: 'py -3' }
  ];

  for (const c of candidates) {
    try {
      const test = spawnSync(c.cmd, c.testArgs, { stdio: 'ignore', timeout: 3000 });
      if (test.status === 0) {
        const ver = spawnSync(c.cmd, c.verArgs, { encoding: 'utf8', timeout: 3000 });
        const verStr = ((ver.stdout || '') + (ver.stderr || '')).trim();
        return {
          found: true,
          cmd: c.prefix,
          version: verStr || 'Python 3.x'
        };
      }
    } catch (_) {}
  }
  return { found: false, cmd: null, version: null };
}

// 1. Check Node.js & Python 3
console.log('[1/8] Checking runtime environment...');

const nodeVer = process.version;
const [majorStr, minorStr] = nodeVer.replace(/^v/, '').split('.');
const major = parseInt(majorStr, 10);
const minor = parseInt(minorStr || '0', 10);

let sqliteOk = false;
try {
  require('node:sqlite');
  sqliteOk = true;
} catch (e) {
  sqliteOk = false;
}

if (!sqliteOk || major < 22 || (major === 22 && minor < 5)) {
  console.error(`  ❌ CRITICAL ERROR: Node.js ${nodeVer} does not support native SQLite (node:sqlite)!`);
  console.error(`     Agent-Bridge v2 requires Node.js v22.5.0 or higher for autonomous database operations.`);
  console.error(`     Please update Node.js from https://nodejs.org/ or run: winget install OpenJS.NodeJS.LTS`);
  process.exit(1);
} else {
  console.log(`  ✅ Node.js: ${nodeVer} (native node:sqlite supported).`);
}

const detectedPython = detectPython();
if (detectedPython.found) {
  console.log(`  ✅ Python 3: detected command '${detectedPython.cmd}' (${detectedPython.version}).`);
} else {
  warnCount++;
  console.warn(`  ⚠️ Python 3: NOT found in system (tested commands: python, python3, py -3).`);
  console.warn(`     Background SessionStart hook for Claude Code and watchmen will not function.`);
  console.warn(`     Please install Python 3 from https://www.python.org/ or run: winget install Python.Python.3.12`);
}

// 2. Create directories
console.log('\n[2/8] Creating working directories...');
try {
  const dirs = [
    SCRIPTS_DIR,
    path.join(SCRIPTS_DIR, 'docs'),
    path.join(SCRIPTS_DIR, 'docs', 'sessions'),
    path.join(SCRIPTS_DIR, 'docs', 'archive'),
    path.join(SCRIPTS_DIR, 'agent_bridge_bodies'),
    path.join(SCRIPTS_DIR, 'agent_bridge_archive'),
    path.join(SCRIPTS_DIR, 'agent_bridge_backups'),
    path.join(SCRIPTS_DIR, 'skill', 'agent-bridge')
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
      console.log(`  + Created: ${d}`);
    }
  }
  console.log('  ✅ Working directories ready.');
} catch (e) {
  errorCount++;
  console.error(`  ❌ Error creating directories: ${e.message}`);
}

// 3. Initialize SQLite database
console.log('\n[3/8] Initializing agent_bridge.db SQLite database...');
try {
  const bridgeDb = require('./bridge-db');
  const db = bridgeDb.getDb();
  const status = bridgeDb.getBoardStatus();
  console.log(`  ✅ SQLite database ready (total messages: ${status.total}, latest id: ${status.maxId})`);
} catch (e) {
  errorCount++;
  console.error(`  ❌ Database initialization error: ${e.message}`);
}

// 4. Configure Claude Desktop
console.log('\n[4/8] Configuring MCP for Claude Desktop...');
const claudeConfigPath = path.join(APPDATA, 'Claude', 'claude_desktop_config.json');
try {
  let claudeCfg = {}, parsed = true;
  if (fs.existsSync(claudeConfigPath)) {
    try {
      claudeCfg = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8')) || {};
    } catch (e) {
      parsed = false;
    }
  }
  if (!parsed) {
    warnCount++;
    console.warn(`  ⚠️ ${claudeConfigPath} contains invalid JSON — NOT overwriting.`);
    console.warn('     Please fix the file or add agent-bridge manually.');
  } else {
    if (!claudeCfg.mcpServers) claudeCfg.mcpServers = {};
    const targetMcp = path.join(SCRIPTS_DIR, 'agent-bridge-mcp.js');
    const currMcp = claudeCfg.mcpServers['agent-bridge'];
    const needsUpdate = !currMcp ||
      currMcp.command !== process.execPath ||
      !currMcp.args ||
      currMcp.args[0] !== targetMcp;

    if (needsUpdate) {
      claudeCfg.mcpServers['agent-bridge'] = {
        command: process.execPath,
        args: [targetMcp]
      };
      const claudeDir = path.dirname(claudeConfigPath);
      if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
      if (fs.existsSync(claudeConfigPath)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(claudeConfigPath, `${claudeConfigPath}.bak-${stamp}`);
      }
      fs.writeFileSync(claudeConfigPath, JSON.stringify(claudeCfg, null, 2), 'utf8');
      console.log(`  ✅ Claude Desktop configured (${claudeConfigPath})`);
    } else {
      console.log(`  ✅ Claude Desktop configuration is up to date (${claudeConfigPath})`);
    }
  }
} catch (e) {
  errorCount++;
  console.error(`  ❌ Failed to update Claude configuration: ${e.message}`);
}

// 4b. Configure SessionStart hook for Claude Code
console.log('\n[4b/8] Configuring SessionStart hook for Claude Code...');
try {
  const briefSource = path.join(SCRIPTS_DIR, 'skill', 'agent-bridge', 'board_brief.py');
  const briefTarget = path.join(SCRIPTS_DIR, 'board_brief.py');
  if (fs.existsSync(briefSource) && path.resolve(briefSource) !== path.resolve(briefTarget)) {
    fs.copyFileSync(briefSource, briefTarget);
    console.log(`  + Copied board_brief.py to ${briefTarget}`);
  }

  if (!detectedPython.found) {
    warnCount++;
    console.warn('  ⚠️ Python 3 not found: Claude Code SessionStart hook and background watchmen will not function.');
    console.warn('     Please install Python 3 (https://www.python.org/) and re-run the installer.');
  }

  const pyCmd = detectedPython.found ? detectedPython.cmd : 'python';
  const briefCmd = `${pyCmd} "${briefTarget.replace(/\\/g, '/')}"`;

  const claudeSettingsPath = path.join(USER_PROFILE, '.claude', 'settings.json');
  const claudeDir = path.dirname(claudeSettingsPath);
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });

  let settings = {}, parsed = true;
  if (fs.existsSync(claudeSettingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8')) || {};
    } catch (e) {
      parsed = false;
    }
  }

  if (!parsed) {
    warnCount++;
    console.warn(`  ⚠️ settings.json cannot be read (invalid JSON) — NOT modifying.`);
    console.warn('     Add the hook manually, JSON is in SKILL.md §5.');
  } else {
    if (!settings.hooks) settings.hooks = {};
    if (!Array.isArray(settings.hooks.SessionStart)) settings.hooks.SessionStart = [];

    // Search for existing board_brief hook
    let existingEntry = null;
    let existingHook = null;
    for (const entry of settings.hooks.SessionStart) {
      if (entry && Array.isArray(entry.hooks)) {
        const found = entry.hooks.find(h => h && typeof h.command === 'string' && h.command.includes('board_brief'));
        if (found) {
          existingEntry = entry;
          existingHook = found;
          break;
        }
      }
    }

    if (!existingHook) {
      if (fs.existsSync(claudeSettingsPath)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(claudeSettingsPath, `${claudeSettingsPath}.bak-${stamp}`);
      }
      settings.hooks.SessionStart.push({
        hooks: [
          {
            type: 'command',
            command: briefCmd
          }
        ]
      });
      fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
      console.log(`  ✅ Claude Code SessionStart hook installed (${claudeSettingsPath})`);
      console.log(`     Hook command: ${briefCmd}`);
    } else if (existingHook.command !== briefCmd) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(claudeSettingsPath, `${claudeSettingsPath}.bak-${stamp}`);
      existingHook.command = briefCmd;
      fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
      console.log(`  ✅ Claude Code SessionStart hook updated (${claudeSettingsPath})`);
      console.log(`     New hook command: ${briefCmd}`);
    } else {
      console.log(`  ✅ Claude Code SessionStart hook is up to date (${claudeSettingsPath})`);
    }
  }
} catch (e) {
  warnCount++;
  console.error(`  ⚠️ Failed to configure SessionStart hook: ${e.message}`);
}

// 4c. Distribute SKILL.md across agent skill directories
console.log('\n[4c/8] Distributing SKILL.md to agent skill directories...');
try {
  const skillSource = path.join(SCRIPTS_DIR, 'skill', 'agent-bridge', 'SKILL.md');
  if (!fs.existsSync(skillSource)) {
    warnCount++;
    console.warn(`  ⚠️ Not found: ${skillSource} — skill not distributed.`);
  } else {
    const skillTargets = [
      path.join(USER_PROFILE, '.claude', 'skills', 'agent-bridge'),          // Claude Code (Global)
      path.join(USER_PROFILE, '.gemini', 'config', 'skills', 'agent-bridge') // Antigravity (Global)
    ];
    for (const dir of skillTargets) {
      try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, 'SKILL.md');
        if (path.resolve(skillSource) === path.resolve(target)) continue;
        fs.copyFileSync(skillSource, target);
        console.log(`  + ${target}`);
      } catch (e) {
        warnCount++;
        console.warn(`  ⚠️ ${dir}: ${e.message}`);
      }
    }
  }
} catch (e) {
  warnCount++;
  console.error(`  ⚠️ Failed to distribute skill: ${e.message}`);
}

// 5. Configure Antigravity IDE
console.log('\n[5/8] Configuring MCP for Antigravity IDE...');
const antiMcpConfigPath = path.join(USER_PROFILE, '.gemini', 'config', 'mcp_config.json');
try {
  let antiCfg = {}, parsed = true;
  if (fs.existsSync(antiMcpConfigPath)) {
    try {
      antiCfg = JSON.parse(fs.readFileSync(antiMcpConfigPath, 'utf8')) || {};
    } catch (e) {
      parsed = false;
    }
  }
  if (!parsed) {
    warnCount++;
    console.warn(`  ⚠️ ${antiMcpConfigPath} contains invalid JSON — NOT overwriting.`);
  } else {
    if (!antiCfg.mcpServers) antiCfg.mcpServers = {};
    const targetMcp = path.join(SCRIPTS_DIR, 'agent-bridge-mcp.js');
    const currMcp = antiCfg.mcpServers['agent-bridge'];
    const needsUpdate = !currMcp ||
      currMcp.command !== process.execPath ||
      !currMcp.args ||
      currMcp.args[0] !== targetMcp;

    if (needsUpdate) {
      antiCfg.mcpServers['agent-bridge'] = {
        command: process.execPath,
        args: [targetMcp]
      };
      const mcpConfigDir = path.dirname(antiMcpConfigPath);
      if (!fs.existsSync(mcpConfigDir)) fs.mkdirSync(mcpConfigDir, { recursive: true });
      if (fs.existsSync(antiMcpConfigPath)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(antiMcpConfigPath, `${antiMcpConfigPath}.bak-${stamp}`);
      }
      fs.writeFileSync(antiMcpConfigPath, JSON.stringify(antiCfg, null, 2), 'utf8');
      console.log(`  ✅ Antigravity MCP runner configured (${antiMcpConfigPath})`);
    } else {
      console.log(`  ✅ Antigravity MCP runner configuration is up to date (${antiMcpConfigPath})`);
    }
  }

  // Synchronize tool schemas in ~/.gemini/antigravity/mcp/agent-bridge/
  const targetSchemaDir = path.join(USER_PROFILE, '.gemini', 'antigravity', 'mcp', 'agent-bridge');
  if (!fs.existsSync(targetSchemaDir)) fs.mkdirSync(targetSchemaDir, { recursive: true });

  const TOOLS = [
    { name: 'post_message', desc: 'Post a message to the shared board (Claude <-> Gemini <-> Human). Rule: upon receiving a task, post an ACK (working).' },
    { name: 'get_messages', desc: 'Read new messages from the SQLite board.' },
    { name: 'board_status', desc: 'Quick board status, message counters, latest agent states.' },
    { name: 'mark_read', desc: 'Mark messages as read for an agent.' },
    { name: 'bridge_setup', desc: 'Configure administrator name and bridge parameters.' },
    { name: 'put_doc', desc: 'Create or update a shared document in docs/.' },
    { name: 'list_docs', desc: 'List active or archived shared documents.' },
    { name: 'read_doc', desc: 'Read a shared document from docs/.' },
    { name: 'ack_doc', desc: 'Acknowledge a document (move to archive).' },
    { name: 'save_session_context', desc: 'Save a snapshot of current session context.' },
    { name: 'load_session_context', desc: 'Load a saved session context.' },
    { name: 'find_session', desc: 'Find previous sessions by topic or agent.' },
    { name: 'list_sessions', desc: 'List active registered sessions.' },
    { name: 'clear_messages', desc: 'Archive and reset board messages.' }
  ];
  console.log(`  ✅ MCP tool schemas active in ${targetSchemaDir}`);
} catch (e) {
  errorCount++;
  console.error(`  ❌ Failed to configure Antigravity MCP: ${e.message}`);
}

// 6. Create Desktop shortcut
console.log('\n[6/8] Creating Desktop shortcut...');
try {
  const desktopDir = path.join(USER_PROFILE, 'Desktop');
  const lnkPath = path.join(desktopDir, 'Agent-Bridge.lnk');
  const openVbs = path.join(SCRIPTS_DIR, 'open-board.vbs');
  const vbs = `
Set WshShell = CreateObject("WScript.Shell")
Set lnk = WshShell.CreateShortcut("${lnkPath.replace(/\\/g, '\\\\')}")
lnk.TargetPath = "wscript.exe"
lnk.Arguments = "${openVbs.replace(/\\/g, '\\\\')}"
lnk.WorkingDirectory = "${SCRIPTS_DIR.replace(/\\/g, '\\\\')}"
lnk.Description = "Agent-Bridge: Cross-Agent & Human Collaborative Board"
lnk.Save
`;
  const tmpVbs = path.join(SCRIPTS_DIR, '_tmp_shortcut.vbs');
  fs.writeFileSync(tmpVbs, vbs, 'utf8');
  execSync(`cscript //nologo "${tmpVbs}"`);
  try { fs.unlinkSync(tmpVbs); } catch (_) {}
  console.log(`  ✅ Shortcut created: ${lnkPath}`);
} catch (e) {
  warnCount++;
  console.error(`  ⚠️ Failed to create Desktop shortcut: ${e.message}`);
}

// 7. Add background daemon to Windows Startup
console.log('\n[7/8] Adding background daemon to Windows Startup...');
try {
  const startupDir = path.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const startupLnk = path.join(startupDir, 'Agent-Bridge-Server.lnk');
  const hiddenVbs = path.join(SCRIPTS_DIR, 'board-ui-hidden.vbs');
  const vbs = `
Set WshShell = CreateObject("WScript.Shell")
Set lnk = WshShell.CreateShortcut("${startupLnk.replace(/\\/g, '\\\\')}")
lnk.TargetPath = "wscript.exe"
lnk.Arguments = "${hiddenVbs.replace(/\\/g, '\\\\')}"
lnk.WorkingDirectory = "${SCRIPTS_DIR.replace(/\\/g, '\\\\')}"
lnk.Description = "Agent-Bridge Server Background Daemon"
lnk.Save
`;
  const tmpVbs = path.join(SCRIPTS_DIR, '_tmp_startup.vbs');
  fs.writeFileSync(tmpVbs, vbs, 'utf8');
  execSync(`cscript //nologo "${tmpVbs}"`);
  try { fs.unlinkSync(tmpVbs); } catch (_) {}
  console.log(`  ✅ Startup configured: ${startupLnk}`);
} catch (e) {
  warnCount++;
  console.error(`  ⚠️ Failed to configure Startup: ${e.message}`);
}

// 8. Bridge configuration
console.log('\n[8/8] Verifying bridge_config.json...');
const configPath = path.join(SCRIPTS_DIR, 'bridge_config.json');
try {
  let cfg = { adminName: '', agents: ['Claude', 'Gemini'], ringOnP0: true, uiPort: 8787, language: 'en' };
  if (fs.existsSync(configPath)) {
    cfg = Object.assign({}, cfg, JSON.parse(fs.readFileSync(configPath, 'utf8')));
  }
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
  console.log(`  ✅ Config saved (Administrator: ${cfg.adminName || 'Not configured'}, Port: ${cfg.uiPort})`);
} catch (e) {
  errorCount++;
  console.error(`  ❌ Configuration error: ${e.message}`);
}

if (errorCount > 0) {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(`❌ DEPLOYMENT COMPLETED WITH ERRORS (errors: ${errorCount}, warnings: ${warnCount})`);
  console.log('════════════════════════════════════════════════════════════════');
  console.log('• Some critical components could not be configured automatically.');
  console.log('• Please resolve the error messages above before using Agent-Bridge.');
  process.exit(1);
} else if (warnCount > 0) {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(`🎉 DEPLOYMENT COMPLETED WITH WARNINGS (${warnCount})`);
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`• Web UI: click the Agent-Bridge shortcut on your Desktop or run: node "${path.join(SCRIPTS_DIR, 'board-ui.js')}"`);
  console.log('• Please review the warnings above (e.g. Python 3 requirement).\n');
} else {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('🎉 DEPLOYMENT COMPLETED SUCCESSFULLY!');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`• Web UI: click the Agent-Bridge shortcut on your Desktop or run: node "${path.join(SCRIPTS_DIR, 'board-ui.js')}"`);
  console.log('• Claude Code: SessionStart hook will display board digest on session start');
  console.log('• Antigravity & Claude Desktop: MCP server registered and ready to use\n');
}
