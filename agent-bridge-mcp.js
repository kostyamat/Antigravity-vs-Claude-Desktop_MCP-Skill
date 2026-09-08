// ─────────────────────────────────────────────────────────────────────────────────────────
// 📡 AGENT BRIDGE v2 — Cross-Agent & Human Collaborative Message Board
//
// Connected to both AI clients on this machine:
//   Claude      — %APPDATA%\Claude\claude_desktop_config.json
//   Antigravity — %USERPROFILE%\.gemini\config\mcp_config.json
//
// Protocol features:
//   - Unique message IDs, directed routing (from/fromSession -> to/toSession)
//   - Structured reply threading (replyTo) and topic filtering
//   - Priority levels (P0, normal, fyi) and execution statuses (working, done, blocked)
//   - Per-session read cursors in SQLite WAL mode
//   - External file backing for long messages (>4000 chars)
//   - Context snapshots and document exchange
// ─────────────────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');
const bridgeDb = require('./bridge-db');
const { wakeAntigravity } = require('./wake-antigravity');

const SCRIPTS_DIR  = path.resolve(__dirname);
const BRIDGE_FILE  = path.join(SCRIPTS_DIR, 'agent_bridge.json');
const CURSOR_FILE  = path.join(SCRIPTS_DIR, 'agent_bridge_cursors.json');
const ARCHIVE_DIR  = path.join(SCRIPTS_DIR, 'agent_bridge_archive');
const BODIES_DIR   = path.join(SCRIPTS_DIR, 'agent_bridge_bodies');
const LOG_FILE     = path.join(SCRIPTS_DIR, 'bridge_mcp.log');
const PROTOCOL_DOC = path.join(SCRIPTS_DIR, 'AGENT_BRIDGE_PROTOCOL.md');

//
const DOCS_DIR     = path.join(SCRIPTS_DIR, 'docs');
const DOCS_ARCHIVE = path.join(SCRIPTS_DIR, 'docs', 'archive');
const DOCS_INDEX   = path.join(SCRIPTS_DIR, 'docs', '_index.json');

// ═════════════════════════════════════════════════════════════════════════════════════════
//
//
//
// ═════════════════════════════════════════════════════════════════════════════════════════
const P0_FLAG_FILE = path.join(SCRIPTS_DIR, 'P0_PENDING.txt');

// ═════════════════════════════════════════════════════════════════════════════════════════
//
//
// ═════════════════════════════════════════════════════════════════════════════════════════
const CONFIG_FILE  = path.join(SCRIPTS_DIR, 'bridge_config.json');
const CONFIG_DEFAULTS = {
  adminName: '',                       // Human administrator name
  agents: ['Claude', 'Gemini'],        // Agents on the board
  ringOnP0: true,
  uiPort: 8787,
  language: 'en'
};

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return Object.assign({}, CONFIG_DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    }
  } catch (e) { logError(`readConfig: ${e.message}`); }
  return Object.assign({}, CONFIG_DEFAULTS);
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

/**
 *
 */
/**
 *
 *
 *
 *
 */
function watchmanRuleBanner() {
  try {
    const cfg = readConfig();
    if (cfg.watchmanRule) return '';
    const watchPath = path.join(SCRIPTS_DIR, 'watch_board.py').replace(/\\/g, '/');
    return '🔔 THE WATCHMAN RULE IS NOT YET IN PROJECT INSTRUCTIONS.\n'
      + '   Write it into CLAUDE.md (or AGENTS.md — standing instructions read by EVERY session):\n'
      + `     "First action of session: Monitor({command:\"python3 ${watchPath}\", persistent:true})"\n`
      + '   The hook reminds you, but its output can be missed — that happened multiple times.\n'
      + '   Once written, confirm: bridge_setup({watchmanRule: true}). Until then this stays.\n'
      + '──────────────────────────────────────────────\n';
  } catch (e) { return ''; }
}

function setupBanner() {
  try {
    const cfg = readConfig();
    if (cfg.adminName) return '';
    return '👋 Bridge not configured yet: the administrator\'s name is unknown.\n'
      + '   Ask the human what to call them, then call:\n'
      + '   bridge_setup({adminName:"<name>"})\n'
      + '   Done ONCE per machine; the bridge stops mentioning it afterwards.\n'
      + '──────────────────────────────────────────────\n';
  } catch (e) { return ''; }
}

let myAgent = null;
let mySession = null;
function rememberAgent(who, session) {
  if (who && !myAgent) myAgent = who;
  if (session && !mySession) mySession = String(session).trim();
}

function ringBell(rec) {
  try {
    const who = rec.from || '?';
    const topic = (rec.topic || '').replace(/["'`$]/g, '');
    const head = (rec.message || '').replace(/\s+/g, ' ').slice(0, 120).replace(/["'`$]/g, '');
    const title = `P0 from ${who}${topic ? ' · ' + topic : ''}`;

    try {
      fs.writeFileSync(P0_FLAG_FILE,
        `${new Date().toISOString()}\t#${rec.id}\t${who} → ${rec.to || 'all'}\t${topic}\n${head}\n`,
        { flag: 'a' });
    } catch (_) {}

    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
      "try{(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\Alarm02.wav').PlaySync()}catch{[console]::beep(880,250);[console]::beep(660,250)};",
      "$n=New-Object System.Windows.Forms.NotifyIcon;",
      "$n.Icon=[System.Drawing.SystemIcons]::Exclamation;$n.Visible=$true;",
      `$n.BalloonTipTitle='${title}';$n.BalloonTipText='${head}';`,
      "$n.ShowBalloonTip(15000);Start-Sleep -Seconds 12;$n.Dispose()"
    ].join(' ');

    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    logError(`🔔 bell alert on P0 #${rec.id} from ${who}`);
  } catch (e) {
    try { logError(`bell alert failed (non-critical): ${e.message}`); } catch (_) {}
  }
}

//
let lastSeenId = null;
function startWatch() {
  try {
    const scan = () => {
      try {
        const board = readBoard();
        const top = board.reduce((mx, m) => Math.max(mx, m.id || 0), 0);
        if (lastSeenId === null) { lastSeenId = top; return; }
        if (top <= lastSeenId) return;
        for (const m of board) {
          if ((m.id || 0) <= lastSeenId) continue;
          if (m.priority !== 'P0') continue;
          if (myAgent && m.from === myAgent) continue;
          ringBell(m);
        }
        lastSeenId = top;
      } catch (_) {}
    };
    scan();
    setInterval(scan, 15000).unref();
    logError('server watcher active (P0 check every 15s)');
  } catch (e) {
    try { logError(`server watcher failed to start: ${e.message}`); } catch (_) {}
  }
}
const SESSIONS_DIR = path.join(SCRIPTS_DIR, 'docs', 'sessions');

//
//
const SESSIONS_REG = path.join(SCRIPTS_DIR, 'docs', '_sessions.json');

const INLINE_LIMIT = 4000;
const DEFAULT_LIMIT = 20;

const PRIORITIES = ['P0', 'normal', 'fyi'];
const STATUSES = ['info', 'question', 'answer', 'working', 'done', 'blocked', 'ack'];

function logError(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`, 'utf8');
  } catch (e) {  }
}

function ensureDir(d) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {  }
}


function readBoard() {
  try {
    return bridgeDb.readAllMessages();
  } catch (err) {
    logError(`readBoard: ${err.message}`);
    return [];
  }
}

function writeBoard(data) {
  try {
    fs.writeFileSync(BRIDGE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

function readCursors() {
  try {
    return bridgeDb.readCursors();
  } catch (e) { return {}; }
}

function writeCursors(c) {
  try {
    for (const [reader, val] of Object.entries(c)) {
      bridgeDb.writeCursor(reader, val);
    }
  } catch (e) { /* */ }
}


function normAgent(s) {
  if (!s || typeof s !== 'string') return '';
  const t = s.trim().toLowerCase();
  if (t.startsWith('claude')) return 'Claude';
  if (t.startsWith('gemini') || t.startsWith('antigravity')) return 'Gemini';
  if (t === 'all' || t === '*') return 'all';
  return s.trim();
}

function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms) || ms < 0) return '?';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function mark(m) {
  if (m.priority === 'P0') return '🚨';
  if (m.status === 'blocked') return '⛔';
  if (m.status === 'question') return '❓';
  if (m.status === 'done') return '✅';
  if (m.status === 'working') return '⏳';
  if (m.status === 'ack') return '👍';
  if (m.priority === 'fyi') return '💬';
  return '•';
}

function bodyOf(m, full) {
  if (m.file) {
    if (full) {
      try { return fs.readFileSync(m.file, 'utf8'); } catch (e) {  }
    }
    return `${m.message}\n📄 FULL TEXT STORED IN: ${m.file}\n   (read this file to view full content)`;
  }
  return m.message;
}

function renderOne(m, full, isNew) {
  const head = [];
  head.push(`${mark(m)} #${m.id}${isNew ? ' 🆕' : ''}`);
  head.push(`${m.from}${m.fromSession ? ` (session ${m.fromSession})` : ''}`);
  head.push(`→ ${m.to || 'all'}${m.toSession ? ` (session ${m.toSession})` : ''}`);
  const meta = [];
  if (m.priority && m.priority !== 'normal') meta.push(m.priority);
  if (m.status && m.status !== 'info') meta.push(m.status);
  if (m.progress) meta.push(`progress: ${m.progress}`);
  if (m.topic) meta.push(`topic: ${m.topic}`);
  if (m.replyTo) meta.push(`replying to #${m.replyTo}`);
  const line2 = meta.length ? `   [${meta.join(' · ')}]\n` : '';
  return `${head.join('  ')}   ${ago(m.ts)}\n${line2}${bodyOf(m, full)}`;
}

// ── MCP ──────────────────────────────────────────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════════════════════════════════
//
//
//
process.on('uncaughtException', (err) => {
  try { logError(`UNCAUGHT EXCEPTION (server remains active): ${err && err.stack || err}`); } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
  try { logError(`UNHANDLED REJECTION (server remains active): ${reason && reason.stack || reason}`); } catch (_) {}
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

// ═════════════════════════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════════════════════

function isProcessRunning(pattern) {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('tasklist', ['/NH'], { encoding: 'utf8', windowsHide: true });
    return (r.stdout || '').toLowerCase().includes(pattern.toLowerCase());
  } catch (_) {
    return false;
  }
}

function isClaudeDesktopRunning() {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/V', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
    return (r.stdout || '').toLowerCase().includes('claude.exe') && (r.stdout || '').includes('"Claude"');
  } catch (_) {
    return false;
  }
}

function ensureAgentsRunning() {
  try {
    // 1. Antigravity IDE
    if (!isProcessRunning('Antigravity.exe')) {
      const antPath = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'antigravity', 'Antigravity.exe');
      if (fs.existsSync(antPath)) {
        spawn('cmd.exe', ['/c', 'start', '""', antPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        logError('auto-start: launched Antigravity.exe');
      }
    }
    // 2. Claude Desktop (GUI Windows App)
    if (!isClaudeDesktopRunning()) {
      spawn('cmd.exe', ['/c', 'start', '""', 'explorer.exe', 'shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref();
      logError('auto-start: launched Claude Desktop');
    }
  } catch (e) {
    logError(`ensureAgentsRunning: ${e.message}`);
  }
}

function ensureVisualizerRunning() {
  try {
    const net = require('net');
    const port = readConfig().uiPort || 8787;
    const s = net.createConnection({ port, host: '127.0.0.1' });
    s.once('connect', () => {
      s.destroy();
    });
    s.once('error', () => {
      s.destroy();
      const script = path.join(SCRIPTS_DIR, 'board-ui.js');
      if (!fs.existsSync(script)) return;
      const child = spawn(process.execPath || 'node', [script], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
      logError('auto-start: launched board-ui.js');
    });
  } catch (e) {
    logError(`ensureVisualizerRunning: ${e.message}`);
  }
}

startWatch();
ensureAgentsRunning();
ensureVisualizerRunning();

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    handleRequest(JSON.parse(line));
  } catch (err) {
    logError(`parse: ${err.message} — ${line.slice(0, 300)}`);
  }
});

function sendResponse(response) {
  process.stdout.write(JSON.stringify(response) + '\n');
}

// ═════════════════════════════════════════════════════════════════════════════════════════
//
//
//
// ═════════════════════════════════════════════════════════════════════════════════════════
function pendingP0Banner() {
  try {
    if (!myAgent) return '';
    const board = readBoard();
    const cursor = mySession ? bridgeDb.getCursor(myAgent, mySession) : (readCursors()[myAgent] || 0);
    const myAliases = mySession ? bridgeDb.resolveSessionAliases(mySession) : new Set();
    const mine = board.filter(m => {
      if ((m.id || 0) <= cursor) return false;
      if (m.priority !== 'P0') return false;

      if (mySession) {
        let isOwn = false;
        if (m.from === myAgent) {
          const fromLower = String(m.fromSession || '').trim().toLowerCase();
          for (const a of myAliases) {
            if (String(a).trim().toLowerCase() === fromLower) { isOwn = true; break; }
          }
        }
        if (isOwn) return false;
      } else {
        if (m.from === myAgent) return false;
      }

      if (m.to !== myAgent && m.to !== 'all' && m.to) return false;
      if (m.toSession && m.toSession !== 'all') {
        if (!mySession) return false;
        const toLower = String(m.toSession).trim().toLowerCase();
        let match = false;
        for (const a of myAliases) {
          if (String(a).trim().toLowerCase() === toLower) { match = true; break; }
        }
        if (!match) return false;
      }
      return true;
    });
    if (!mine.length) return '';
    const lines = mine.slice(-3).map(m =>
      `   #${m.id} from ${m.from}${m.topic ? ' · ' + m.topic : ''} — ${(m.message || '').replace(/\s+/g, ' ').slice(0, 90)}`);
    const sessionLabel = mySession ? ` (${mySession})` : '';
    const head = `🚨 UNREAD P0 FOR YOU${sessionLabel}: ${mine.length}. Read: get_messages({reader:"${myAgent}", sessionId:"${mySession || ''}"})`;
    return head + '\n' + lines.join('\n')
         + '\n──────────────────────────────────────────────\n';
  } catch (e) { return ''; }
}

function ok(id, text) {
  sendResponse({ jsonrpc: '2.0', id,
    result: { content: [{ type: 'text',
      text: setupBanner() + watchmanRuleBanner() + pendingP0Banner() + text }] } });
}

function fail(id, message) {
  sendResponse({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}

const TOOLS = [
  {
    name: 'post_message',
    description:
      'Post a message to the shared board for another agent (Claude <-> Gemini) or the human administrator. ' +
      'MANDATORY fields: `sender`, `sessionId` (your session identifier), and `message`; empty calls are rejected. ' +
      'If replying to an existing message — ALWAYS set `replyTo: #N`. When `replyTo` is provided, `to`, `toSession`, ' +
      'and `topic` are automatically inherited from the parent message to maintain thread continuity. ' +
      'If starting a new topic — explicitly specify `to`, `toSession`, and `topic`. ' +
      'Urgent tasks must use `priority: "P0"`, and the message must explain what needs immediate attention or halt. ' +
      'Report execution state with `status`: `working` (in progress; provide `progress` indicating current step), ' +
      '`done` (completed), `blocked` (stuck; explain blocker), `question` (awaiting answer), `answer` (replying), ' +
      '`ack` (read and acknowledged). ' +
      'Long text is never truncated: messages exceeding 4000 chars are stored in a file, leaving a pointer on the board. ' +
      'Full protocol reference: AGENT_BRIDGE_PROTOCOL.md',
    inputSchema: {
      type: 'object',
      properties: {
        sender: { type: 'string', description: 'Sender identifier: "Claude", "Gemini", or human name.' },
        message: { type: 'string', description: 'Message content. Unlimited length.' },
        sessionId: { type: 'string', description: 'Your session/branch identifier (e.g. "main", "feature/refactor", or UUID). Required so recipients know where to route replies.' },
        canonicalId: { type: 'string', description: 'The id your client issued for this window (Claude Code: get_session({session_id:"self"}).sessionId). Send it once and the human can address this window by it from the board.' },
        client: { type: 'string', description: 'Which application this session runs in: claude-code | claude-desktop | antigravity.' },
        cwd: { type: 'string', description: 'Working directory of this session. Stays on this machine; the database is never published.' },
        title: { type: 'string', description: 'Window title, so the human recognises the session in the board.' },
        to: { type: 'string', description: 'Recipient: "Claude", "Gemini", or "all" (default is "all" unless replying).' },
        toSession: { type: 'string', description: 'Target session of recipient (if replyTo is not specified).' },
        replyTo: { type: 'number', description: 'Message ID (#N) being replied to. Automatically links thread and routes to parent author.' },
        topic: { type: 'string', description: 'Short topic/category (e.g. "auth", "refactoring") for filtering.' },
        priority: { type: 'string', enum: PRIORITIES, description: 'P0 = immediate attention/stop; normal; fyi = for information only.' },
        status: { type: 'string', enum: STATUSES, description: 'info | question | answer | working | done | blocked | ack' },
        progress: { type: 'string', description: 'Current progress description, e.g. "step 3 of 5" or "awaiting build".' }
      },
      required: ['sender', 'message']
    }
  },
  {
    name: 'get_messages',
    description:
      'Read messages from the board. By default returns ONLY NEW messages for your session (tracked by personal cursor) ' +
      'plus a few recent messages for context. ' +
      'MANDATORY: pass `reader` ("Claude"/"Gemini") and `sessionId` (your session identifier) so your read cursor is ' +
      'maintained independently of parallel sessions and you do not consume tasks intended for other sessions. ' +
      'The response header indicates unread counts, pending P0s, and unanswered questions. ' +
      'Use `only: "for_me"` for directly addressed messages; `thread: N` for the complete thread around message #N; ' +
      '`full: true` to fetch full body text for file-backed messages. ' +
      'Reading automatically advances your read cursor unless `peek: true` is passed.',
    inputSchema: {
      type: 'object',
      properties: {
        reader: { type: 'string', description: 'Reader identifier: "Claude" or "Gemini". Required for cursor tracking.' },
        sessionId: { type: 'string', description: 'Your session/branch identifier (e.g. "main", "feature/refactor", or UUID).' },
        canonicalId: { type: 'string', description: 'The id your client issued for this window (Claude Code: get_session({session_id:"self"}).sessionId). Send it once and the human can address this window by it from the board.' },
        client: { type: 'string', description: 'Which application this session runs in: claude-code | claude-desktop | antigravity.' },
        cwd: { type: 'string', description: 'Working directory of this session. Stays on this machine; the database is never published.' },
        title: { type: 'string', description: 'Window title, so the human recognises the session in the board.' },
        only: { type: 'string', enum: ['new', 'for_me', 'all'], description: 'Filter: new (default) | for_me | all' },
        thread: { type: 'number', description: 'Retrieve complete discussion thread around message #N.' },
        topic: { type: 'string', description: 'Filter by specific topic.' },
        since: { type: 'number', description: 'Retrieve messages with ID greater than this value.' },
        limit: { type: 'number', description: 'Maximum number of messages to return (default 20).' },
        full: { type: 'boolean', description: 'Fetch full content for long file-backed messages.' },
        peek: { type: 'boolean', description: 'Do not advance read cursor.' }
      }
    }
  },
  {
    name: 'bridge_setup',
    description:
      '⚙️ FIRST ACTION ON A NEW MACHINE. Configures the administrator (human user) name. ' +
      'Until configured, the bridge includes a setup reminder in every response. ' +
      'Call this tool with `adminName` once to complete setup. Calling without arguments returns current configuration. ' +
      'Optionally configure `agents` (list of participating agents) and `uiPort` (web UI port, default 8787).',
    inputSchema: {
      type: 'object',
      properties: {
        adminName: { type: 'string', description: 'Human administrator name, e.g. "Alex (Admin)".' },
        agents: { type: 'array', items: { type: 'string' }, description: 'List of agent names participating on the board.' },
        uiPort: { type: 'number', description: 'Web UI port (board-ui).' },
        language: { type: 'string', description: 'Preferred language code, e.g. "en".' },
        watchmanRule: { type: 'boolean', description: 'Confirmation that the rule "FIRST ACTION OF SESSION — start watcher" is recorded in project persistent rules (CLAUDE.md / AGENTS.md).' }
      }
    }
  },
  {
    name: 'board_status',
    description:
      'Quick board overview without message bodies: unread counts per agent/session, pending P0 alerts, ' +
      'open threads awaiting reply, and current agent activity (latest working/done state with timestamp). ' +
      'Use this to check if another agent is actively working and at what stage, without reading full messages.',
    inputSchema: { type: 'object', properties: { reader: { type: 'string', description: 'Reader identifier.' } } }
  },
  {
    name: 'mark_read',
    description: 'Explicitly mark messages as read up to a specified message ID. Rarely needed directly since `get_messages` advances cursors automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        reader: { type: 'string', description: 'Reader identifier.' },
        sessionId: { type: 'string', description: 'Session identifier.' },
        upTo: { type: 'number', description: 'Message ID up to which messages are marked read.' }
      },
      required: ['reader']
    }
  },
  {
    name: 'put_doc',
    description:
      'Publish a persistent DOCUMENT for another agent (report, specification, review, plan, architecture RFC). ' +
      'Unlike ephemeral board messages, documents survive board clear operations and complete environment reinstalls. ' +
      'The file name is composed automatically from both sessions and topic. ' +
      'A new document for the same pair and topic supersedes the older version (which is moved to archive, never deleted). ' +
      'MANDATORY: provide `context` with all details needed to understand the document from a clean slate ' +
      '(project path, goals, status, architectural decisions already made).',
    inputSchema: {
      type: 'object',
      properties: {
        sender: { type: 'string', description: '"Claude" or "Gemini".' },
        sessionId: { type: 'string', description: 'Your session identifier (used in filename).' },
        to: { type: 'string', description: 'Target agent: "Claude" or "Gemini".' },
        toSession: { type: 'string', description: 'Recipient session identifier (used in filename).' },
        topic: { type: 'string', description: 'Kebab-case topic (e.g. "architecture-review").' },
        title: { type: 'string', description: 'Human-readable document title.' },
        body: { type: 'string', description: 'Document body in Markdown format. Unlimited length.' },
        context: { type: 'string', description: 'MANDATORY context restoration block: project, paths, current state, decisions made.' },
        priority: { type: 'string', enum: PRIORITIES, description: 'P0 = read immediately; normal.' },
        announce: { type: 'boolean', description: 'True (default) = post an announcement on the board so the recipient notices.' }
      },
      required: ['sender', 'to', 'topic', 'body']
    }
  },
  {
    name: 'list_docs',
    description:
      'List available documents. By default returns active (non-archived) documents addressed to you: ' +
      'author, session, topic, timestamp, and read status. Set `mine: false` to list all active documents; ' +
      '`archived: true` to inspect archived documents.',
    inputSchema: {
      type: 'object',
      properties: {
        reader: { type: 'string', description: '"Claude" or "Gemini".' },
        mine: { type: 'boolean', description: 'Only show documents addressed to me (default true).' },
        topic: { type: 'string', description: 'Filter by topic.' },
        archived: { type: 'boolean', description: 'Show archive instead of active documents.' }
      }
    }
  },
  {
    name: 'read_doc',
    description:
      'Read a document in full by filename or list index. Marks the document as read. ' +
      'Reading does NOT archive the document — use `ack_doc` once you have incorporated the content.',
    inputSchema: {
      type: 'object',
      properties: {
        reader: { type: 'string', description: '"Claude" or "Gemini".' },
        name: { type: 'string', description: 'Document filename (from `list_docs`).' },
        topic: { type: 'string', description: 'Or topic name — retrieves the latest active document for that topic.' }
      }
    }
  },
  {
    name: 'ack_doc',
    description:
      'Acknowledge document: "read and incorporated". Moves the document to archive (retained permanently, ' +
      'can be accessed via `list_docs({archived:true})`). ' +
      'MANDATORY: provide `note` explaining key takeaways or why suggestions were adopted/declined.',
    inputSchema: {
      type: 'object',
      properties: {
        reader: { type: 'string', description: 'Reader identifier.' },
        name: { type: 'string', description: 'Document filename.' },
        note: { type: 'string', description: 'Takeaway notes or rationale for changes.' }
      },
      required: ['reader', 'name']
    }
  },
  {
    name: 'find_session',
    description:
      'Search for existing sessions that already investigated a topic. ' +
      'CALL THIS BEFORE OPENING A NEW BRANCH to avoid duplicating research and token spend. ' +
      'Searches topics, descriptions, decisions, and gotchas across all registered sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords, e.g. "auth service", "database migration", "api endpoints".' }
      },
      required: ['query']
    }
  },
  {
    name: 'list_sessions',
    description:
      'Shared registry of sessions across all agents: active sessions, topics covered, last activity timestamp, ' +
      'and whether a context snapshot is available. Registry updates automatically from board traffic and documents.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', description: 'Filter by agent: "Claude" or "Gemini".' } }
    }
  },
  {
    name: 'save_session_context',
    description:
      'Save a session context snapshot — safeguards against context loss or window reset. ' +
      'Snapshots are stored in docs/sessions/ and are never auto-archived. ' +
      'Update at major work milestones. Restore using `load_session_context`.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: '"Claude" or "Gemini".' },
        sessionId: { type: 'string', description: 'Session identifier, e.g. "task-refactor-worker".' },
        project: { type: 'string', description: 'Project path or workspace.' },
        summary: { type: 'string', description: 'Session purpose and current progress.' },
        decisions: { type: 'string', description: 'Key architectural decisions and constraints.' },
        openTasks: { type: 'string', description: 'Remaining tasks in priority order.' },
        paths: { type: 'string', description: 'Key files and directories.' },
        gotchas: { type: 'string', description: 'Known pitfalls and edge cases encountered.' },
        topics: { type: 'string', description: 'Comma-separated keywords for discovery by find_session.' }
      },
      required: ['agent', 'sessionId', 'summary']
    }
  },
  {
    name: 'load_session_context',
    description:
      'Load a session context snapshot. Use when resuming work after a restart or context compaction. ' +
      'Omit `sessionId` to list all available saved snapshots.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: '"Claude" or "Gemini".' },
        sessionId: { type: 'string', description: 'Session identifier to restore. Omit to list snapshots.' }
      }
    }
  },
  {
    name: 'clear_messages',
    description:
      'Archive and clear board messages. Nothing is deleted: all messages are moved into a dated archive file. ' +
      'Use when board history becomes excessively large.',
    inputSchema: { type: 'object', properties: { reason: { type: 'string', description: 'Reason for archiving.' } } }
  }
];

function handleRequest(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    sendResponse({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-bridge', version: '2.0.0' }
      }
    });
    return;
  }

  if (method === 'tools/list') {
    sendResponse({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method !== 'tools/call') {
    if (id !== undefined) fail(id, `Method not found: ${method}`);
    return;
  }

  const toolName = params && params.name;
  const args = (params && params.arguments) || {};

  rememberAgent(normAgent(args.reader || args.sender), args.sessionId);

  try {
    if (toolName === 'bridge_setup') return doSetup(id, args);
    if (toolName === 'post_message') return doPost(id, args);
    if (toolName === 'get_messages') return doGet(id, args);
    if (toolName === 'board_status') return doStatus(id, args);
    if (toolName === 'mark_read') return doMarkRead(id, args);
    if (toolName === 'clear_messages') return doClear(id, args);
    if (toolName === 'put_doc') return doPutDoc(id, args);
    if (toolName === 'list_docs') return doListDocs(id, args);
    if (toolName === 'read_doc') return doReadDoc(id, args);
    if (toolName === 'ack_doc') return doAckDoc(id, args);
    if (toolName === 'save_session_context') return doSaveCtx(id, args);
    if (toolName === 'load_session_context') return doLoadCtx(id, args);
    if (toolName === 'list_sessions') return doListSessions(id, args);
    if (toolName === 'find_session') return doFindSession(id, args);
  } catch (err) {
    logError(`${toolName}: ${err.stack || err.message}`);
    return fail(id, `${toolName} failed: ${err.message}`);
  }

  fail(id, `Tool not found: ${toolName}`);
}

// ── bridge_setup ─────────────────────────────────────────────────────────────────────────

function doSetup(id, a) {
  const cfg = readConfig();
  const changed = [];
  if (typeof a.adminName === 'string' && a.adminName.trim()) {
    cfg.adminName = a.adminName.trim(); changed.push('adminName');
  }
  if (Array.isArray(a.agents) && a.agents.length) {
    cfg.agents = a.agents.map(String); changed.push('agents');
  }
  if (typeof a.uiPort === 'number' && a.uiPort > 0) { cfg.uiPort = a.uiPort; changed.push('uiPort'); }
  if (typeof a.language === 'string' && a.language.trim()) {
    cfg.language = a.language.trim(); changed.push('language');
  }
  if (a.watchmanRule === true) { cfg.watchmanRule = true; changed.push('watchmanRule'); }

  if (!changed.length) {
    return ok(id,
      `⚙️ Bridge status:\n` +
      `   administrator: ${cfg.adminName || '❗ not configured'}\n` +
      `   agents:        ${cfg.agents.join(', ')}\n` +
      `   ring on P0:    ${cfg.ringOnP0 ? 'enabled' : 'disabled'}\n` +
      `   web UI:        http://127.0.0.1:${cfg.uiPort}/\n` +
      `   language:      ${cfg.language}\n` +
      `   watchman rule: ${cfg.watchmanRule ? 'recorded' : '❗ NOT RECORDED — reminder remains'}\n` +
      (cfg.adminName ? '' : '\nAsk the human what to call them, then call bridge_setup({adminName:"…"}).'));
  }

  try { writeConfig(cfg); }
  catch (e) { return fail(id, `bridge_setup: failed to write ${CONFIG_FILE}: ${e.message}`); }

  logError(`bridge_setup: modified ${changed.join(', ')}; admin=${cfg.adminName}`);
  ok(id,
    `✅ Bridge configured (${changed.join(', ')}).\n` +
    `   Administrator: ${cfg.adminName}\n` +
    `   Agents on board: ${cfg.agents.join(', ')}\n\n` +
    `Setup complete. Helpful commands to get started:\n` +
    `   board_status({reader:"<you>"}) — see who is doing what\n` +
    `   get_messages({reader:"<you>"}) — read new messages (CONTENT, not counters)\n` +
    `   find_session({query:"…"})     — check if topic was already researched\n` +
    `Full protocol: ${PROTOCOL_DOC}`);
}

// ── post_message ─────────────────────────────────────────────────────────────────────────

function doPost(id, a) {
  const from = normAgent(a.sender);
  if (!from) return fail(id, 'post_message: `sender` is required. Message NOT recorded.');
  const text = typeof a.message === 'string' ? a.message : '';
  if (!text.trim()) return fail(id, 'post_message: empty `message`. Message NOT recorded.');

  const priority = PRIORITIES.includes(a.priority) ? a.priority : 'normal';
  const status = STATUSES.includes(a.status) ? a.status : 'info';

  const storedMessage = text.length > INLINE_LIMIT ? (text.slice(0, INLINE_LIMIT) + '\n…') : text;

  const dup = bridgeDb.findRecentDuplicate(from, storedMessage, 60);
  if (dup) {
    return ok(id, `↩️ Already on the board as #${dup.id} — duplicate not recorded.`);
  }

  let toAgent = normAgent(a.to) || '';
  let toSession = (a.toSession || '').trim();
  let topic = (a.topic || '').trim();
  const replyTo = typeof a.replyTo === 'number' ? a.replyTo : null;

  if (replyTo) {
    const parent = bridgeDb.getMessageById(replyTo);
    if (parent) {
      if (!toAgent || toAgent === 'all') toAgent = parent.from;
      if (!toSession) toSession = parent.fromSession || '';
      if (!topic && parent.topic) topic = parent.topic;
    }
  }
  if (!toAgent) toAgent = 'all';

  const rec = {
    ts: new Date().toISOString(),
    from,
    fromSession: (a.sessionId || '').trim(),
    to: toAgent,
    toSession: toSession,
    replyTo: replyTo,
    topic: topic,
    priority,
    status,
    progress: a.progress || '',
    message: storedMessage,
    file: null,
    readBy: []
  };
  const saved = bridgeDb.addMessage(rec);
  const nextId = saved.id;
  rec.id = nextId;

  if (text.length > INLINE_LIMIT) {
    ensureDir(BODIES_DIR);
    const file = path.join(BODIES_DIR, `msg_${String(nextId).padStart(4, '0')}.md`);
    fs.writeFileSync(file, text, 'utf8');
    bridgeDb.updateMessage(nextId, { file });
    rec.file = file;
  }

  noteSession(from, rec.fromSession, rec.topic, rec.to, rec.toSession, sessionIdentity(a));

  rememberAgent(from);
  if (priority === 'P0') {
    try {
      fs.writeFileSync(P0_FLAG_FILE,
        `${rec.ts}\t#${rec.id}\t${from} → ${rec.to || 'all'}\t${rec.topic || ''}\n`,
        { flag: 'a' });
    } catch (_) {}
  }

  wakeAntigravity(rec);

  const hints = [];
  if (!rec.fromSession) hints.push('⚠️ `sessionId` not specified — recipient will not know which session to reply to');
  if (rec.to === 'all') hints.push('ℹ️ addressed to all (`to: "all"`)');
  if (rec.file) hints.push(`📄 long text stored completely in ${rec.file}`);

  ok(id, `✅ Recorded as #${nextId}${rec.to !== 'all' ? ` for ${rec.to}` : ''}` +
        `${rec.toSession ? ` [session: ${rec.toSession}]` : ''}` +
        `${priority === 'P0' ? ' 🚨 P0' : ''}${status !== 'info' ? ` [${status}]` : ''}.` +
        (hints.length ? `\n${hints.join('\n')}` : ''));
}

// ── get_messages ─────────────────────────────────────────────────────────────────────────

function doGet(id, a) {
  rememberAgent(normAgent(a.reader), a.sessionId);
  // Reading is usually a session's first contact with the bridge, and a session
  // that only reads used to leave no trace at all: it existed for the board
  // only once it wrote something. Everything that has to know where to send a
  // reply — the watchman's filter, the human looking for a window to address —
  // was waiting on that first message.
  if (a.sessionId) {
    noteSession(normAgent(a.reader), a.sessionId, a.topic || '', '', '', sessionIdentity(a));
  }
  const board = readBoard();
  if (!board.length) return ok(id, 'Board is empty.');

  let reader = normAgent(a.reader);
  const sessionId = a.sessionId ? String(a.sessionId).trim() : '';
  if (!reader && sessionId) {
    try {
      const row = bridgeDb.getDb().prepare(
        'SELECT agent FROM sessions WHERE session_id = ? OR key = ?'
      ).get(sessionId, `Gemini/${sessionId}`) || bridgeDb.getDb().prepare(
        'SELECT agent FROM sessions WHERE session_id = ? OR key = ?'
      ).get(sessionId, `Claude/${sessionId}`);
      if (row && row.agent) reader = normAgent(row.agent);
    } catch (_) {}
  }
  const myAliases = sessionId ? bridgeDb.resolveSessionAliases(sessionId) : new Set();
  const cursor = reader ? bridgeDb.getCursor(reader, sessionId) : 0;
  const only = a.only || (reader ? 'new' : 'all');
  const limit = typeof a.limit === 'number' && a.limit > 0 ? a.limit : DEFAULT_LIMIT;

  if (typeof a.thread === 'number') {
    const root = rootOf(board, a.thread);
    const chain = board.filter(m => rootOf(board, m.id) === root);
    return ok(id, `🧵 Thread #${root} — ${chain.length} messages\n\n` +
      chain.map(m => renderOne(m, !!a.full)).join('\n\n───\n\n'));
  }

  const isForMe = (m) => {
    if (m.toSession && m.toSession !== 'all') {
      if (!sessionId) return false;
      const targetLower = String(m.toSession).trim().toLowerCase();
      let match = false;
      for (const a of myAliases) {
        if (String(a).trim().toLowerCase() === targetLower) { match = true; break; }
      }
      if (!match) return false;
    }
    if (reader) {
      if (m.to !== reader && m.to !== 'all') return false;
    }
    return true;
  };

  const isMyOwn = (m) => {
    if (!reader) return false;
    if (sessionId) {
      if (m.from !== reader) return false;
      const fromLower = String(m.fromSession || '').trim().toLowerCase();
      for (const a of myAliases) {
        if (String(a).trim().toLowerCase() === fromLower) return true;
      }
      return false;
    }
    return m.from === reader;
  };

  let list = board.slice();
  if (a.topic) list = list.filter(m => (m.topic || '').toLowerCase() === String(a.topic).toLowerCase());
  if (typeof a.since === 'number') list = list.filter(m => m.id > a.since);
  if (only === 'for_me') list = list.filter(m => isForMe(m));
  if (only === 'new') list = list.filter(m => m.id > cursor && isForMe(m) && !isMyOwn(m));

  const header = [];
  if (reader) {
    const mine = board.filter(m => isForMe(m) && !isMyOwn(m));
    const unread = mine.filter(m => m.id > cursor);
    const p0 = unread.filter(m => m.priority === 'P0');
    const asks = unread.filter(m => m.status === 'question' || m.status === 'blocked');
    const sessTag = sessionId ? ` [session: ${sessionId}]` : '';
    header.push(`📬 ${reader}${sessTag}: ${unread.length} new` +
      (p0.length ? ` · 🚨 P0: ${p0.map(m => '#' + m.id).join(', ')}` : '') +
      (asks.length ? ` · ❓ awaiting reply: ${asks.map(m => '#' + m.id).join(', ')}` : ''));
  }

  if (!list.length) {
    return ok(id, (header.length ? header.join('\n') + '\n\n' : '') +
      'Nothing new for you. (To view older messages, use `only: "all"`.)');
  }

  const shown = list.slice(-limit);
  const body = shown.map(m => {
    const isNew = cursor > 0 && (m.id > cursor) && isForMe(m) && !isMyOwn(m);
    return renderOne(m, !!a.full, isNew);
  }).join('\n\n───\n\n');
  const tailNote = list.length > shown.length
    ? `\n\n(showing ${shown.length} of ${list.length}; older messages omitted — increase \`limit\`)`
    : '';

  if (reader && !a.peek) {
    const maxSeen = shown.reduce((mx, m) => Math.max(mx, m.id || 0), cursor);
    if (sessionId) {
      for (const a of myAliases) {
        bridgeDb.writeCursor(`${reader}/${a}`, maxSeen);
      }
    } else if (reader) {
      bridgeDb.writeCursor(reader, maxSeen);
    }
    shown.forEach(m => {
      const readKey = sessionId ? `${reader}/${sessionId}` : reader;
      if (!m.readBy.includes(readKey)) {
        m.readBy.push(readKey);
        bridgeDb.updateMessage(m.id, { readBy: m.readBy });
      }
    });
  }

  ok(id, (header.length ? header.join('\n') + '\n\n' : '') + body + tailNote);
}

function rootOf(board, msgId) {
  const byId = new Map(board.map(m => [m.id, m]));
  let cur = byId.get(msgId);
  const seen = new Set();
  while (cur && cur.replyTo && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = byId.get(cur.replyTo);
    if (!parent) break;
    cur = parent;
  }
  return cur ? cur.id : msgId;
}

// ── board_status ─────────────────────────────────────────────────────────────────────────

function doStatus(id, a) {
  const dbStatus = bridgeDb.getBoardStatus(a.reader);
  const board = readBoard();
  if (!board.length) return ok(id, 'Board is empty.');
  const out = [];

  const lastMsg = board[board.length - 1];
  out.push(`📡 BOARD: ${board.length} messages, latest #${lastMsg.id} ${ago(lastMsg.ts)}`);
  out.push('');

  for (const agent of ['Claude', 'Gemini']) {
    const stats = (dbStatus.unreadStats && dbStatus.unreadStats[agent]) || { unread: 0, p0: 0 };
    out.push(`👤 ${agent}: new ${stats.unread}${stats.p0 ? ` · 🚨 P0: ${stats.p0}` : ''}`);
  }
  out.push('');

  out.push('⏳ ACTIVE SESSIONS ACTIVITY:');
  if (dbStatus.sessionStates && dbStatus.sessionStates.length) {
    for (const s of dbStatus.sessionStates) {
      const st = s.status === 'working' ? '⏳ in progress' : s.status === 'done' ? '✅ completed' : '⛔ blocked';
      const name = s.sessionCustomName ? ` «${s.sessionCustomName}»` : '';
      const sessId = s.fromSession ? ` [${s.fromSession}]` : '';
      out.push(`   ${s.from}${name}${sessId}: ${st}${s.progress ? ' — ' + s.progress : ''}` +
               `${s.topic ? ` (${s.topic})` : ''}, #${s.id}, ${ago(s.ts)}`);
      if (s.status === 'working') {
        const mins = Math.floor((Date.now() - new Date(s.ts).getTime()) / 60000);
        if (mins > 30) out.push(`      ⚠️ silent for ${mins} min — check if alive`);
      }
    }
  } else {
    out.push('   (no active sessions in working/done/blocked status)');
  }
  out.push('');

  if (dbStatus.openQuestions && dbStatus.openQuestions.length) {
    out.push('❓ UNANSWERED QUESTIONS:');
    dbStatus.openQuestions.forEach(m => {
      const sess = m.fromSession ? ` [${m.fromSession}]` : '';
      out.push(`   #${m.id} from ${m.from}${sess} → ${m.to}${m.topic ? ` (${m.topic})` : ''}, ${ago(m.ts)}`);
    });
  } else {
    out.push('❓ No unanswered questions.');
  }

  ok(id, out.join('\n'));
}

// ── mark_read / clear ────────────────────────────────────────────────────────────────────

function doMarkRead(id, a) {
  const reader = normAgent(a.reader);
  if (!reader) return fail(id, 'mark_read: `reader` is required.');
  const upTo = bridgeDb.markRead(reader, typeof a.upTo === 'number' ? a.upTo : undefined, a.sessionId);
  ok(id, `Marked read up to #${upTo} for ${reader}${a.sessionId ? ' (' + a.sessionId + ')' : ''}.`);
}


function readDocsIndex() {
  try {
    if (!fs.existsSync(DOCS_INDEX)) return [];
    const d = JSON.parse(fs.readFileSync(DOCS_INDEX, 'utf8'));
    return Array.isArray(d) ? d : [];
  } catch (e) { logError(`readDocsIndex: ${e.message}`); return []; }
}

function writeDocsIndex(d) {
  ensureDir(DOCS_DIR);
  fs.writeFileSync(DOCS_INDEX, JSON.stringify(d, null, 2), 'utf8');
  try {
    if (Array.isArray(d)) {
      d.forEach(item => bridgeDb.saveDocIndex(item));
    }
  } catch (_) {}
}

function slug(s, fallback) {
  const v = String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return v || fallback || 'unknown';
}

function docFileName(from, fromSession, to, toSession, topic) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${slug(from, 'from')}__${slug(fromSession, 'nosession')}` +
         `--to--${slug(to, 'to')}__${slug(toSession, 'nosession')}` +
         `__${slug(topic, 'notopic')}__${stamp}.md`;
}

function doPutDoc(id, a) {
  const from = normAgent(a.sender);
  if (!from) return fail(id, 'put_doc: `sender` is required.');
  const to = normAgent(a.to);
  if (!to || to === 'all') return fail(id, 'put_doc: document must be addressed to a specific agent — specify `to`.');
  const topic = String(a.topic || '').trim();
  if (!topic) return fail(id, 'put_doc: `topic` is required (used in filename).');
  const body = typeof a.body === 'string' ? a.body : '';
  if (!body.trim()) return fail(id, 'put_doc: empty `body`.');

  ensureDir(DOCS_DIR);
  ensureDir(DOCS_ARCHIVE);

  const index = readDocsIndex();
  const fromSession = a.sessionId || '';
  const toSession = a.toSession || '';

  const superseded = [];
  for (const rec of index) {
    if (rec.archived) continue;
    if (rec.topic.toLowerCase() !== topic.toLowerCase()) continue;
    const samePair = (rec.from === from && rec.to === to) || (rec.from === to && rec.to === from);
    if (!samePair) continue;
    archiveDoc(rec, `superseded by newer document on topic "${topic}"`);
    superseded.push(rec.name);
  }

  const name = docFileName(from, fromSession, to, toSession, topic);
  const file = path.join(DOCS_DIR, name);
  const now = new Date().toISOString();

  const header =
`---
doc: ${name}
title: ${a.title || topic}
from: ${from}${fromSession ? ` (session ${fromSession})` : ''}
to: ${to}${toSession ? ` (session ${toSession})` : ''}
topic: ${topic}
created: ${now}
priority: ${PRIORITIES.includes(a.priority) ? a.priority : 'normal'}
${superseded.length ? `supersedes: ${superseded.join(', ')}` : ''}
---

## 🧭 CONTEXT RESTORATION
> This section is written in case Claude or Antigravity was reinstalled from scratch and
> no conversation memory remains. Read this first.

${a.context && String(a.context).trim() ? a.context : '⚠️ AUTHOR DID NOT PROVIDE CONTEXT. Document may lack necessary background.'}

---

`;

  fs.writeFileSync(file, header + body, 'utf8');

  const rec = {
    name, file, from, fromSession, to, toSession, topic,
    title: a.title || topic,
    created: now,
    priority: PRIORITIES.includes(a.priority) ? a.priority : 'normal',
    readBy: [],
    ackedBy: [],
    archived: false,
    supersedes: superseded
  };
  index.push(rec);
  writeDocsIndex(index);
  noteSession(from, fromSession, topic, to, toSession, sessionIdentity(a));

  if (a.announce !== false) {
    const board = readBoard();
    const nextId = board.reduce((mx, m) => Math.max(mx, m.id || 0), 0) + 1;
    board.push({
      id: nextId, ts: now, from, fromSession, to, toSession,
      replyTo: null, topic,
      priority: rec.priority, status: 'info', progress: '',
      message: `📄 Document "${rec.title}"\n   ${file}\n   Read: read_doc({reader:"${to}", name:"${name}"})`, 
      file: null, readBy: []
    });
    writeBoard(board);
  }

  ok(id, `📄 Document stored: ${name}\n   ${file}` +
        (superseded.length ? `\n♻️ Superseded into archive: ${superseded.join(', ')}` : '') +
        (a.context && String(a.context).trim() ? '' : '\n⚠️ `context` not filled — document will be difficult to understand from a clean slate') +
        (a.announce === false ? '' : '\n🔔 Announcement posted to board.'));
}

function archiveDoc(rec, why) {
  try {
    ensureDir(DOCS_ARCHIVE);
    let dest = path.join(DOCS_ARCHIVE, rec.name);
    let n = 1;
    while (fs.existsSync(dest)) {
      dest = path.join(DOCS_ARCHIVE, rec.name.replace(/\.md$/, '') + `__${n}.md`);
      n++;
    }
    if (fs.existsSync(rec.file)) {
      let txt = fs.readFileSync(rec.file, 'utf8');
      txt += `\n\n---\n📦 ARCHIVED ${new Date().toISOString()}: ${why}\n`;
      fs.writeFileSync(dest, txt, 'utf8');
      fs.unlinkSync(rec.file);
    }
    rec.archived = true;
    rec.archivedAt = new Date().toISOString();
    rec.archivedWhy = why;
    rec.file = dest;
  } catch (e) {
    logError(`archiveDoc ${rec.name}: ${e.message}`);
  }
}

function doListDocs(id, a) {
  const index = readDocsIndex();
  const reader = normAgent(a.reader);
  const wantArchived = !!a.archived;
  let list = index.filter(r => !!r.archived === wantArchived);
  if (a.topic) list = list.filter(r => r.topic.toLowerCase() === String(a.topic).toLowerCase());
  if (reader && a.mine !== false) list = list.filter(r => r.to === reader);

  if (!list.length) {
    return ok(id, wantArchived ? 'Document archive is empty (for this filter).'
                               : 'No active documents found (for this filter).');
  }
  const lines = list.map(r => {
    const flags = [];
    if (r.priority === 'P0') flags.push('🚨P0');
    if (reader && r.readBy.includes(reader)) flags.push('read');
    if (reader && r.ackedBy.includes(reader)) flags.push('acknowledged');
    if (r.archived) flags.push(`archived: ${r.archivedWhy || ''}`);
    return `${r.priority === 'P0' ? '🚨' : '📄'} ${r.title}\n` +
           `   ${r.from}${r.fromSession ? ` (${r.fromSession})` : ''} → ${r.to}${r.toSession ? ` (${r.toSession})` : ''}` +
           `  ·  topic: ${r.topic}  ·  ${ago(r.created)}${flags.length ? `  ·  ${flags.join(', ')}` : ''}\n` +
           `   name: ${r.name}`;
  });
  ok(id, `${wantArchived ? '📦 ARCHIVE' : '📄 ACTIVE DOCUMENTS'} — ${list.length}\n\n${lines.join('\n\n')}`);
}

function doReadDoc(id, a) {
  const index = readDocsIndex();
  const reader = normAgent(a.reader);
  let rec = null;
  if (a.name) {
    rec = index.find(r => r.name === a.name) || null;
  } else if (a.topic) {
    const cands = index.filter(r => !r.archived && r.topic.toLowerCase() === String(a.topic).toLowerCase()
      && (!reader || r.to === reader));
    rec = cands.length ? cands[cands.length - 1] : null;
  }
  if (!rec) return fail(id, 'read_doc: document not found — see `list_docs`.');
  let text;
  try { text = fs.readFileSync(rec.file, 'utf8'); }
  catch (e) { return fail(id, `read_doc: failed to read ${rec.file}: ${e.message}`); }

  if (reader && !rec.readBy.includes(reader)) {
    rec.readBy.push(reader);
    writeDocsIndex(index);
  }
  ok(id, text + `\n\n───\n✅ Read. When incorporated, call ack_doc({reader:"${reader || '…'}", name:"${rec.name}", note:"takeaways"}), and the document will be moved to archive.`);
}

function doAckDoc(id, a) {
  const reader = normAgent(a.reader);
  if (!reader) return fail(id, 'ack_doc: `reader` is required.');
  const index = readDocsIndex();
  const rec = index.find(r => r.name === a.name);
  if (!rec) return fail(id, 'ack_doc: document not found.');
  if (!rec.ackedBy.includes(reader)) rec.ackedBy.push(reader);
  if (!rec.readBy.includes(reader)) rec.readBy.push(reader);
  rec.ackNote = a.note || '';

  if (rec.to === reader && !rec.archived) {
    archiveDoc(rec, `acknowledged by ${reader}${a.note ? `: ${a.note}` : ''}`);
  }
  writeDocsIndex(index);
  ok(id, `👍 ${rec.name} acknowledged${rec.archived ? ' and moved to archive' : ''}.` +
        `${a.note ? `\nNote: ${a.note}` : '\n⚠️ Without `note` — reasons and takeaways will not be preserved.'}` +
        `\nRetrieve from archive: list_docs({archived:true})`);
}


function readReg() {
  try {
    if (!fs.existsSync(SESSIONS_REG)) return {};
    return JSON.parse(fs.readFileSync(SESSIONS_REG, 'utf8')) || {};
  } catch (e) { logError(`readReg: ${e.message}`); return {}; }
}

function writeReg(r) {
  ensureDir(DOCS_DIR);
  try {
    fs.writeFileSync(SESSIONS_REG, JSON.stringify(r, null, 2), 'utf8');
    for (const s of Object.values(r)) {
      bridgeDb.saveSession(s);
    }
  } catch (e) { logError(`writeReg: ${e.message}`); }
}

// The identity fields every bridge tool may carry. They are optional: an agent
// that cannot learn its own window id (Claude Desktop has no way to) simply
// keeps working under its label, and the board shows what it has.
function sessionIdentity(a) {
  if (!a) return null;
  return {
    canonicalId: a.canonicalId || a.canonical_id || '',
    client: a.client || '',
    cwd: a.cwd || '',
    title: a.title || ''
  };
}

function sessKey(agent, sessionId) {
  return `${normAgent(agent) || 'unknown'}/${String(sessionId || '').trim()}`;
}

/**
 *
 */
function noteSession(agent, sessionId, topic, peerAgent, peerSession, identity) {
  const sid = String(sessionId || '').trim();
  if (!sid) return;
  const reg = readReg();
  const key = sessKey(agent, sid);
  const now = new Date().toISOString();
  const rec = reg[key] || { agent: normAgent(agent), sessionId: sid, topics: [], contacts: {}, firstSeen: now };
  rec.lastSeen = now;
  if (topic && !rec.topics.includes(topic)) rec.topics.push(topic);

  // Whatever the client knows about this window, recorded the first time the
  // session speaks to the bridge and never overwritten with nothing. The label
  // above is chosen by the agent; this is issued by the application, which is
  // why the human can copy it from the board and address the window by it.
  if (identity) {
    for (const field of ['canonicalId', 'client', 'cwd', 'title']) {
      const value = String(identity[field] || '').trim();
      if (value) rec[field] = value;
    }
  }

  const peerSid = String(peerSession || '').trim();
  if (peerSid) {
    const pkey = sessKey(peerAgent, peerSid);
    const c = rec.contacts[pkey] || { count: 0, topics: [] };
    c.count += 1;
    c.lastAt = now;
    if (topic && !c.topics.includes(topic)) c.topics.push(topic);
    rec.contacts[pkey] = c;

    const prec = reg[pkey] || { agent: normAgent(peerAgent), sessionId: peerSid, topics: [], contacts: {}, firstSeen: now };
    const pc = prec.contacts[key] || { count: 0, topics: [] };
    pc.count += 1;
    pc.lastAt = now;
    if (topic && !pc.topics.includes(topic)) pc.topics.push(topic);
    prec.contacts[key] = pc;
    if (topic && !prec.topics.includes(topic)) prec.topics.push(topic);
    prec.lastSeen = prec.lastSeen || now;
    reg[pkey] = prec;
  }

  reg[key] = rec;
  writeReg(reg);
}

function doListSessions(id, a) {
  const reg = readReg();
  const keys = Object.keys(reg);
  if (!keys.length) return ok(id, 'Session registry is empty.');
  const agent = normAgent(a.agent);
  const rows = keys
    .filter(k => !agent || reg[k].agent === agent)
    .sort((x, y) => String(reg[y].lastSeen || '').localeCompare(String(reg[x].lastSeen || '')))
    .map(k => {
      const r = reg[k];
      const contacts = Object.keys(r.contacts || {});
      return `👤 ${k}` +
             (r.title ? `   «${r.title}»` : '') + '\n' +
             // Both, always: the label is what a human reads, the canonical id
             // is what actually addresses the window. Showing only one of them
             // is how a mistyped label became a session of its own.
             (r.canonicalId ? `   id: ${r.canonicalId}${r.client ? `   (${r.client})` : ''}\n` : '') +
             (r.cwd ? `   cwd: ${r.cwd}\n` : '') +
             `   topics: ${r.topics && r.topics.length ? r.topics.join(', ') : '—'}\n` +
             `   last active: ${r.lastSeen ? ago(r.lastSeen) : '?'}` +
             (r.summary ? `\n   summary: ${r.summary}` : '') +
             (contacts.length ? `\n   contacted: ${contacts.join(', ')}` : '') +
             (r.hasSnapshot ? '\n   💾 has context snapshot' : '');
    });
  ok(id, `🗂️ SESSION REGISTRY — ${rows.length}\n\n${rows.join('\n\n')}\n\n` +
        '🔴 Before opening a NEW session on a topic already investigated, find an existing one ' +
        '(`find_session`) and communicate with it.');
}

function doFindSession(id, a) {
  const q = String(a.query || '').trim().toLowerCase();
  if (!q) return fail(id, 'find_session: empty `query`.');
  const reg = readReg();
  const hits = [];
  for (const k of Object.keys(reg)) {
    const r = reg[k];
    const hay = [k, (r.topics || []).join(' '), r.summary || '', r.knows || '', r.project || '']
      .join(' ').toLowerCase();
    let score = 0;
    for (const w of q.split(/\s+/)) {
      if (w.length >= 3 && hay.includes(w)) score++;
    }
    if (score) hits.push({ k, r, score });
  }
  if (!hits.length) {
    return ok(id, `No sessions found for query "${a.query}".\n` +
      'Topic has not been investigated yet — you may open a new session/branch, ' +
      'and register it with `save_session_context`.');
  }
  hits.sort((x, y) => y.score - x.score || String(y.r.lastSeen || '').localeCompare(String(x.r.lastSeen || '')));
  const rows = hits.slice(0, 8).map(h =>
    `👤 ${h.k}  (score: ${h.score}, active ${h.r.lastSeen ? ago(h.r.lastSeen) : '?'})\n` +
    `   topics: ${(h.r.topics || []).join(', ') || '—'}` +
    (h.r.summary ? `\n   summary: ${h.r.summary}` : '') +
    (h.r.hasSnapshot ? `\n   💾 context: load_session_context({agent:"${h.r.agent}", sessionId:"${h.r.sessionId}"})` : ''));
  ok(id, `🔎 Sessions found: ${hits.length}\n\n${rows.join('\n\n')}\n\n` +
        '🔴 Route questions to an existing session when possible: it already retains relevant context.');
}

//

function ctxFile(agent, sessionId) {
  return path.join(SESSIONS_DIR, `${slug(agent, 'agent')}__${slug(sessionId, 'session')}.md`);
}

function doSaveCtx(id, a) {
  const agent = normAgent(a.agent);
  if (!agent) return fail(id, 'save_session_context: `agent` is required.');
  const sid = String(a.sessionId || '').trim();
  if (!sid) return fail(id, 'save_session_context: `sessionId` is required.');
  const summary = String(a.summary || '').trim();
  if (!summary) return fail(id, 'save_session_context: empty `summary` — snapshot without summary is unusable.');

  ensureDir(SESSIONS_DIR);
  const file = ctxFile(agent, sid);
  const now = new Date().toISOString();

  if (fs.existsSync(file)) {
    ensureDir(DOCS_ARCHIVE);
    const stamp = now.replace(/[:.]/g, '-');
    const dest = path.join(DOCS_ARCHIVE, `${path.basename(file, '.md')}__${stamp}.md`);
    try { fs.copyFileSync(file, dest); } catch (e) { logError(`ctx archive: ${e.message}`); }
  }

  const parts = [];
  parts.push(`# 💾 Session Context Snapshot — ${agent} / ${sid}`);
  parts.push('');
  parts.push(`> Updated: ${now}`);
  parts.push('> This file is a context safeguard. If a session loses memory or is re-instantiated,');
  parts.push('> read this file FIRST to resume work without starting over.');
  parts.push('');
  if (a.project) { parts.push('## 📁 Project'); parts.push(String(a.project)); parts.push(''); }
  parts.push('## 🧭 Scope & Current Progress');
  parts.push(summary);
  parts.push('');
  if (a.decisions) { parts.push('## ⚖️ Architectural Decisions & Constraints (Do Not Overturn)'); parts.push(String(a.decisions)); parts.push(''); }
  if (a.openTasks) { parts.push('## 📋 Remaining Tasks'); parts.push(String(a.openTasks)); parts.push(''); }
  if (a.paths) { parts.push('## 🗂️ Key Paths & Files'); parts.push(String(a.paths)); parts.push(''); }
  if (a.gotchas) { parts.push('## 🪤 Pitfalls & Disproven Hypotheses'); parts.push(String(a.gotchas)); parts.push(''); }

  fs.writeFileSync(file, parts.join('\n'), 'utf8');

  try {
    const reg = readReg();
    const key = sessKey(agent, sid);
    const r = reg[key] || { agent, sessionId: sid, topics: [], contacts: {}, firstSeen: now };
    r.lastSeen = now;
    r.summary = summary.split(/\r?\n/)[0].slice(0, 200);
    r.project = a.project || r.project || '';
    r.knows = [a.decisions || '', a.gotchas || ''].join(' ').slice(0, 500);
    r.hasSnapshot = true;
    if (a.topics) {
      String(a.topics).split(/[,;]+/).map(t => t.trim()).filter(Boolean)
        .forEach(t => { if (!r.topics.includes(t)) r.topics.push(t); });
    }
    reg[key] = r;
    writeReg(reg);
  } catch (e) { logError(`reg from ctx: ${e.message}`); }

  const missing = [];
  if (!a.decisions) missing.push('`decisions`');
  if (!a.openTasks) missing.push('`openTasks`');
  if (!a.paths) missing.push('`paths`');
  ok(id, `💾 Snapshot saved: ${file}` +
        (missing.length ? `\n⚠️ Missing fields: ${missing.join(', ')} — context restoration may be incomplete.` : ''));
}

function doLoadCtx(id, a) {
  ensureDir(SESSIONS_DIR);
  const agent = normAgent(a.agent);
  const sid = String(a.sessionId || '').trim();

  if (!sid) {
    let files = [];
    try { files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.md')); } catch (e) { /* */ }
    if (!files.length) return ok(id, 'No saved session context snapshots found.');
    const lines = files.map(f => {
      let when = '';
      try { when = ago(fs.statSync(path.join(SESSIONS_DIR, f)).mtime.toISOString()); } catch (e) { /* */ }
      return `   ${f}${when ? `  ·  updated ${when}` : ''}`;
    });
    return ok(id, `💾 Saved session context snapshots (${files.length}):\n${lines.join('\n')}\n\n` +
      'To load: load_session_context({agent:"…", sessionId:"…"})');
  }

  const file = ctxFile(agent, sid);
  if (!fs.existsSync(file)) {
    return fail(id, `load_session_context: snapshot not found for ${agent}/${sid}. Call without sessionId to list snapshots.`);
  }
  try {
    ok(id, fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(id, `load_session_context: failed to read ${file}: ${e.message}`);
  }
}

function doClear(id, a) {
  ensureDir(ARCHIVE_DIR);
  const count = bridgeDb.clearBoard(a.reason || '', ARCHIVE_DIR);
  if (!count) return ok(id, 'Board is already empty.');
  ok(id, `Board cleared. Nothing lost — ${count} messages archived into ${ARCHIVE_DIR}`);
}
