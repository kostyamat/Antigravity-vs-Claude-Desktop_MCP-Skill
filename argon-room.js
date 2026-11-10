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
// A deep research is ordered the same way, with the word first: "@Argon research: <topic>".
// It takes ten minutes to an hour, so nobody waits for it: the room is told at once that it
// was ordered and that work goes on, the board keeps the wait, and when the report is ready
// it is written to docs/research/ and posted into the room the order came from, addressed to
// whoever ordered it — that post is the signal that it is finished. The orders in flight are
// kept in argon_jobs.json, so a board restarted in the middle says so instead of going silent.
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
const RESEARCH_TIMEOUT_S = 3600;
const REPORT_CHARS = 200000;
// The words that order a deep research. bridge_config.json → argon.researchWords adds the owner's own
// (in his language) to these.
const RESEARCH_WORDS = ['deep research', 'deep-research', 'research'];
function researchPattern(home) {
  let extra = [];
  try { extra = (JSON.parse(fs.readFileSync(path.join(home, 'bridge_config.json'), 'utf8')).argon || {}).researchWords || []; } catch (_) {}
  const words = RESEARCH_WORDS.concat(extra.filter(w => typeof w === 'string' && w.trim()))
    .sort((a, b) => b.length - a.length).map(w => w.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('^\\s*(?:' + words.join('|') + ')\\s*[:—-]\\s*', 'i');
}

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

// Argon's application is closed: start it from the owner's own shortcut. bridge_config.json →
// argon.launch names it; otherwise a "Gemini (Argon)" shortcut is looked for on the desktop.
function launcher(home) {
  try {
    const own = JSON.parse(fs.readFileSync(path.join(home, 'bridge_config.json'), 'utf8')).argon;
    if (own && own.launch && fs.existsSync(own.launch)) return own.launch;
  } catch (_) {}
  const roots = [path.join(os.homedir(), 'Desktop'), process.env.OneDrive && path.join(process.env.OneDrive, 'Desktop')].filter(Boolean);
  try { for (const d of fs.readdirSync(process.env.OneDrive || '')) roots.push(path.join(process.env.OneDrive, d)); } catch (_) {}
  for (const r of roots) { const f = path.join(r, 'Gemini (Argon).lnk'); if (fs.existsSync(f)) return f; }
  return '';
}
const DOWN = /fetch failed|offline|ECONNREFUSED|not running/i;

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
      `--- The question, #${m.id}, from ${m.from} ---\n` + cut(question(m), QUESTION_CHARS);
  }

  const question = m => String(m.message || '').replace(/^\s*(?:>.*\n|\s)*@argon\b[:,]?\s*/i, '');
  const jobsFile = path.join(home, 'argon_jobs.json');
  const jobs = () => { try { return JSON.parse(fs.readFileSync(jobsFile, 'utf8')); } catch (_) { return {}; } };
  const setJob = (id, v) => { const j = jobs(); if (v) j[id] = v; else delete j[id]; try { fs.writeFileSync(jobsFile, JSON.stringify(j, null, 1), 'utf8'); } catch (_) {} };
  let researching = null;      // { id, since } while a deep research holds Argon

  async function research(m, cfg) {
    const topic = question(m).replace(researchPattern(home), '').trim();
    if (topic.length < 20) return say(m, 'A deep research needs a real question: what to find out, what to look for, what to cite.', 'blocked');
    const dir = path.join(home, 'docs', 'research');
    const file = path.join(dir, `research_${m.id}_${new Date().toISOString().slice(0, 10)}.md`);
    const since = Date.now();
    researching = { id: m.id, since };
    setJob(m.id, { room: m.room || '', from: m.from, fromSession: m.fromSession || '', since: new Date(since).toISOString(), file, topic: topic.slice(0, 200) });
    say(m, 'Deep research ordered. It takes 10–60 minutes; nobody needs to wait — carry on with your work. ' +
      'The report will be posted in this room, addressed to you, when it is ready.', 'working');
    try {
      const out = await callTool(cfg, 'argon_deep_research', { prompt: topic, output_file: file, timeout_seconds: RESEARCH_TIMEOUT_S },
        (RESEARCH_TIMEOUT_S + 120) * 1000);
      let report = '';
      try { report = fs.readFileSync(file, 'utf8'); } catch (_) {}
      const mins = Math.round((Date.now() - since) / 60000);
      const unfinished = /not finished before the timeout/.test(out);
      const chat = (/\[Deep Research chat: ([^\]]+)\]/.exec(out) || [])[1] || '';
      say(m, `Deep research ${unfinished ? 'did not finish in time — what there is so far' : 'finished'}: ${mins} min, ` +
        `${Math.round(Buffer.byteLength(report) / 1024)} KB. File: ${file}` + (chat ? `\nChat: ${chat}` : '') +
        `\nTopic: ${topic.slice(0, 300)}\n\n` + (report.length > REPORT_CHARS ? report.slice(0, REPORT_CHARS) + '\n\n[… the rest is in the file]' : report || out),
        unfinished ? 'blocked' : 'done');
    } finally {
      researching = null;
      setJob(m.id, null);
    }
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
        try {
          if (researchPattern(home).test(question(m))) { await research(m, cfg); continue; }
          say(m, 'Argon has the question; the answer will be posted here.', 'working');
          const room = m.room ? bridgeDb.getRoom(m.room) : null;
          const ask = () => callTool(cfg, 'ask_argon',
            { prompt: prompt(m), project: 'Board room: ' + (room ? room.name : 'Square'), timeout_seconds: TIMEOUT_S }, (TIMEOUT_S + 60) * 1000);
          let answer;
          try { answer = await ask(); }
          catch (e) {
            // Its application is closed: start it, wait until it answers, ask once more.
            const lnk = DOWN.test(e.message) ? launcher(home) : '';
            if (!lnk) throw e;
            spawn('cmd.exe', ['/c', 'start', '""', lnk], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
            let up = false;
            for (let i = 0; i < 18 && !up; i++) {
              await new Promise(r => setTimeout(r, 5000));
              try { await callTool(cfg, 'argon_status', {}, 20000); up = true; } catch (_) {}
            }
            if (!up) throw new Error('Gemini Desktop was started but did not come up in 90 s');
            answer = await ask();
          }
          say(m, answer || '(Argon returned an empty answer.)', 'answer');
        } catch (e) {
          // Out of quota is the owner's to fix, and only by switching the account: he is told so, urgently.
          if (/out of quota|LIMIT:/i.test(e.message)) {
            say(m, 'Argon is out of quota on the account Gemini Desktop is signed in with: ' + e.message + ' Nothing was sent.', 'blocked');
            post({ from: 'Supervisor', fromSession: 'supervisor/board', room: m.room || '', to: 'all', toSession: 'human/web', priority: 'P0',
                   status: 'blocked', topic: 'supervisor', text: 'Supervisor: switch the Gemini Desktop account — Argon is out of quota (' + e.message + ').' });
          } else {
            say(m, 'Argon did not answer: ' + e.message + '.' +
              (DOWN.test(e.message) ? ' Gemini Desktop is not reachable; start it from its "Gemini (Argon)" shortcut.'
                : ' The question reached Gemini Desktop; the failure is on its side (model menu, account or page).'), 'blocked');
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
      if (!isForArgon(m)) continue;
      queue.push(m);
      // Argon is one window: a question that arrives during a deep research waits for it.
      if (researching) {
        say(m, `Argon is busy with a deep research (#${researching.id}, started ${Math.round((Date.now() - researching.since) / 60000)} min ago; ` +
          'they run up to an hour). Your message is queued and will be taken right after it — do not wait for it, carry on.', 'working');
      }
    }
    if (queue.length) work().catch(() => {});
  }

  function start() {
    try { cursor = bridgeDb.getDb().prepare('SELECT COALESCE(MAX(id), 0) n FROM messages').get().n; } catch (_) {}
    // Orders that were in flight when the board last stopped: the wait died with it. Say so.
    for (const [id, j] of Object.entries(jobs())) {
      try {
        post({ from: NAME, fromSession: SESSION, room: j.room || '', to: j.from, toSession: /^human/i.test(j.fromSession || '') ? '' : (j.fromSession || ''),
               replyTo: Number(id), status: 'blocked', topic: 'argon', priority: 'normal',
               text: `The board was restarted while deep research #${id} was running (ordered ${j.since}). The research itself goes on in ` +
                 'Gemini Desktop, in its Deep Research chat, but the board no longer waits for it: open that chat for the report, or order it again.' });
      } catch (_) {}
      setJob(id, null);
    }
    timer = setInterval(scan, 3000);
    if (timer.unref) timer.unref();
  }

  return { start, scan, connected: () => !!serverConfig(home) };
}

module.exports = { createArgonRoom, isForArgon, serverConfig, callTool, NAME, SESSION };
