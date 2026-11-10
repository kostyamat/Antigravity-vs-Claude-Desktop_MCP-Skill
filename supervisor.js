'use strict';
// The supervisor: what keeps the board working when nobody is looking at it.
//
// It has two halves, and the split is the point.
//
// What can be decided by a rule is decided here, in the board's own process,
// with no model involved: which project is asleep on mail addressed to it, which
// stand has been held too long, which attachment still has no description, which
// project's session went quiet with work its handover slice does not cover. A
// sleeping project is nudged from here — a message addressed to it is what wakes
// a Claude window (bridge-hook.js watch), and a second message is the only
// second chance there is.
//
// What needs reading and judgement goes to one Antigravity conversation on a
// fast, cheap model (Gemini Flash by default), started by the board itself and
// held to a short written rule sheet (SUPERVISOR.md): describe a picture, write
// a rescue note for a project whose session died at its limits, answer the owner
// in its own room. It is told what to do by the board, task by task; it does not
// roam.
//
// All of it is the owner's to switch: bridge_config.json → supervisor, and the
// switch on the board. Off means off — no tick, no conversation, no nudge.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const antigravity = require('./antigravity-api');
const { createMailbox } = require('./mailbox');
const { projectName } = require('./project-line');
const { STALE_HOURS } = require('./stands');

const ME = 'supervisor/board';
const DEFAULTS = { enabled: false, model: 'flash', everyMinutes: 10, nudgeAfterMinutes: 10, conversation: '', room: '', handled: {} };
const NUDGE_EVERY_MIN = 30;
const NUDGE_MAX = 3;
const DAY = 24 * 3600e3;

function createSupervisor({ bridgeDb, cardsLib, router, home, wake }) {
  const configFile = path.join(home, 'bridge_config.json');
  const mailbox = createMailbox(bridgeDb, router);
  const nudged = new Map();            // project → { at, count, top }
  let status = { lastTick: '', sleepers: [], stands: [], describing: 0, rescues: [], lastError: '', sent: '' };
  let timer = null;

  const readAll = () => { try { return JSON.parse(fs.readFileSync(configFile, 'utf8')) || {}; } catch (_) { return {}; } };
  const config = () => Object.assign({}, DEFAULTS, readAll().supervisor || {});
  function save(patch) {
    const all = readAll();
    all.supervisor = Object.assign({}, DEFAULTS, all.supervisor || {}, patch);
    fs.writeFileSync(configFile, JSON.stringify(all, null, 2), 'utf8');
    return all.supervisor;
  }

  // A line on the board from the supervisor itself (the rule half, not the model).
  function say({ to, toSession, room, text, status: st }) {
    const rec = {
      ts: new Date().toISOString(), from: 'Supervisor', fromSession: ME, room: room || '', to: to || 'all',
      toSession: toSession || '', replyTo: null, topic: 'supervisor', priority: 'normal', status: st || 'info',
      progress: '', message: text, file: null, readBy: []
    };
    rec.id = bridgeDb.addMessage(rec).id;
    if (rec.room) bridgeDb.touchRoom(rec.room);
    try { if (wake) wake(rec); } catch (_) {}
    return rec.id;
  }

  // ── what a rule can see ────────────────────────────────────────────────────────────────

  function digest() {
    const cfg = config();
    const now = Date.now();
    const cards = new Map();
    try { for (const c of cardsLib.claudeCardsEverywhere()) cards.set(c.id, c); } catch (_) {}
    let floor = 0;
    try {
      const r = bridgeDb.getDb().prepare('SELECT COALESCE(MIN(id), 0) n FROM messages WHERE ts > ?').get(new Date(now - DAY).toISOString());
      floor = Math.max(0, (r.n || 1) - 1);
    } catch (_) {}

    const sleepers = [], rescues = [];
    let lines = new Map();
    try { lines = bridgeDb.readLines(); } catch (_) {}
    for (const [line, members] of lines) {
      const windows = members.map(m => m.member).filter(w => /^local_/.test(w) && cards.has(w));
      if (!windows.length) continue;
      const lastActive = Math.max(...windows.map(w => Date.parse(cards.get(w).activeAt || 0) || 0));
      const live = windows.filter(w => now - (Date.parse(cards.get(w).activeAt || 0) || 0) < 14 * DAY);
      if (!live.length) continue;

      // Unread by the project: unread by every one of its windows. A broadcast on
      // the Square (no room, no addressee window) is nobody's task in particular:
      // one old urgent notice there would otherwise make every project a sleeper.
      let unread = null;
      for (const w of live) {
        const box = mailbox.open('Claude', w, w);
        const ids = new Map(mailbox.urgentFor('Claude', w, w, Math.max(box.cursor, floor))
          .filter(m => m.fromSession !== ME && (m.room || m.toSession)).map(m => [m.id, m]));
        if (unread === null) unread = ids;
        else for (const id of [...unread.keys()]) if (!ids.has(id)) unread.delete(id);
        if (!unread.size) break;
      }
      if (unread && unread.size) {
        const list = [...unread.values()].sort((a, b) => a.id - b.id);
        const minutes = Math.round((now - Date.parse(list[0].ts)) / 60000);
        if (minutes >= cfg.nudgeAfterMinutes) {
          sleepers.push({ line, name: projectName(line) || line, ids: list.map(m => m.id), minutes,
                          rooms: [...new Set(list.map(m => m.room).filter(Boolean))] });
        }
      }

      // Work the slice does not cover, in a project whose session went quiet.
      const idle = now - lastActive;
      if (idle > 30 * 60000 && idle < DAY && fs.existsSync(path.join(line, '.git'))) {
        const r = rescueState(line);
        if (r && cfg.handled['rescue:' + line] !== r.key) rescues.push(Object.assign({ line, name: projectName(line) || line,
          idleMinutes: Math.round(idle / 60000) }, r));
      }
    }

    const stands = bridgeDb.readStands()
      .filter(s => now - Date.parse(s.since) > STALE_HOURS * 3600e3)
      .map(s => ({ stand: s.stand, holder: router.nameOf(s.holder), hours: Math.round((now - Date.parse(s.since)) / 3600e3) }));
    // A description that was asked for and has been written is done.
    for (const q of bridgeDb.readDescriptions('asked')) {
      let written = true;
      try { written = !fs.readFileSync(q.md, 'utf8').includes('_Not described yet.'); } catch (_) {}
      if (written) bridgeDb.setDescriptionState(q.md, 'done');
    }
    const describing = bridgeDb.readDescriptions('pending');
    return { sleepers, rescues, stands, describing };
  }

  // Dirty files, or commits made after the handover slice was last written.
  function rescueState(folder) {
    const git = (...args) => {
      const r = spawnSync('git', ['-C', folder, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      return r.status === 0 ? String(r.stdout || '').trim() : null;
    };
    const dirty = git('status', '--porcelain');
    const head = git('log', '-1', '--format=%H %ct');
    if (dirty === null || !head) return null;
    const [sha, when] = head.split(' ');
    let sliceAt = 0;
    try { sliceAt = fs.statSync(path.join(folder, '.agents', 'HANDOFF.md')).mtimeMs; } catch (_) {}
    const files = dirty ? dirty.split('\n').length : 0;
    const lagging = sliceAt > 0 && Number(when) * 1000 > sliceAt + 60000;
    if (!files && !lagging) return null;
    return { key: sha.slice(0, 12) + ':' + files, dirty: files, slice: sliceAt ? (lagging ? 'older than the last commit' : 'current') : 'none' };
  }

  // ── what a rule can do ─────────────────────────────────────────────────────────────────

  function nudge(sleepers, room) {
    const now = Date.now();
    const out = [];
    for (const s of sleepers) {
      const top = s.ids[s.ids.length - 1];
      const prev = nudged.get(s.line) || { at: 0, count: 0, top: 0 };
      if (top > prev.top) { prev.count = 0; prev.top = top; }          // new mail: start over
      s.nudges = prev.count;
      if (prev.count >= NUDGE_MAX) { s.gaveUp = true; nudged.set(s.line, prev); continue; }
      if (now - prev.at < NUDGE_EVERY_MIN * 60000) { nudged.set(s.line, prev); continue; }
      say({ to: 'Claude', toSession: s.line, room, status: 'question',
        text: `Supervisor: project "${s.name}" has ${s.ids.length} unread on the board for ${s.minutes} min: ` +
          s.ids.slice(-6).map(i => '#' + i).join(', ') + '. Read them now with get_messages and answer each in its own room' +
          (s.rooms.length ? ` (${s.rooms.join(', ')})` : '') + '. Do not answer this reminder.' });
      prev.at = now; prev.count += 1; s.nudges = prev.count;
      nudged.set(s.line, prev);
      out.push(s.name);
    }
    return out;
  }

  // ── the model half ─────────────────────────────────────────────────────────────────────

  async function ensureConversation() {
    let cfg = config();
    const known = id => { try { return cardsLib.geminiCards().some(c => c.id === id); } catch (_) { return false; } };
    if (!cfg.conversation || !known(cfg.conversation)) {
      const rules = path.join(home, 'skill', 'agent-bridge', 'references', 'SUPERVISOR.md');
      const id = await antigravity.create({
        model: cfg.model || 'flash', title: 'Board supervisor',
        prompt: 'You are the supervisor of the agent-bridge board on this machine. Read the file ' + rules +
          ' now, completely, and follow it exactly from here on. Do nothing else yet: the board will send you your ' +
          'conversation id, your room and your first tasks in the next message. Reply with the single word READY.'
      });
      cfg = save({ conversation: id, room: '' });
    }
    if (!cfg.room || !bridgeDb.getRoom(cfg.room)) {
      const room = bridgeDb.createRoom('Supervisor', [{ card: cfg.conversation, agent: 'Gemini' }], '');
      cfg = save({ room: room.id });
    }
    return cfg;
  }

  function tasksFor(d) {
    const tasks = [];
    for (const q of d.describing.slice(0, 3)) {
      tasks.push({ kind: 'describe', key: q.md, text: `DESCRIBE — source: ${q.source} — write into: ${q.md}` });
    }
    for (const r of d.rescues.slice(0, 2)) {
      tasks.push({ kind: 'rescue', key: 'rescue:' + r.line, value: r.key,
        text: `RESCUE — project "${r.name}" — folder: ${r.line} — toSession: ${r.line} — its session has been silent for ` +
          `${r.idleMinutes} min; uncommitted files: ${r.dirty}; handover slice: ${r.slice}` });
    }
    return tasks;
  }

  async function tick(force) {
    const cfg0 = config();
    if (!cfg0.enabled && !force) return status;
    const next = { lastTick: new Date().toISOString(), sleepers: [], stands: [], describing: 0, rescues: [], lastError: '', sent: '' };
    try {
      const d = digest();
      next.sleepers = d.sleepers; next.stands = d.stands; next.describing = d.describing.length;
      next.rescues = d.rescues.map(r => ({ name: r.name, dirty: r.dirty, slice: r.slice, idleMinutes: r.idleMinutes }));
      const tasks = tasksFor(d);
      let cfg = cfg0;
      if (tasks.length || d.sleepers.length) {
        try { cfg = await ensureConversation(); }
        catch (e) { next.lastError = 'Antigravity: ' + e.message; }
      }
      next.nudged = nudge(d.sleepers, cfg.room || '');
      if (tasks.length && cfg.conversation && !next.lastError) {
        antigravity.send(cfg.conversation,
          `Board supervisor tasks. Your sessionId: ${cfg.conversation}. Your room: ${cfg.room}. ` +
          'Do these in order, exactly as SUPERVISOR.md says, then stop.\n' +
          tasks.map((t, i) => `${i + 1}. ${t.text}`).join('\n'));
        const handled = Object.assign({}, cfg.handled || {});
        for (const t of tasks) {
          if (t.kind === 'describe') bridgeDb.setDescriptionState(t.key, 'asked');
          if (t.kind === 'rescue') handled[t.key] = t.value;
        }
        save({ handled });
        next.sent = `${tasks.length} task(s) to the supervisor conversation`;
      }
    } catch (e) {
      next.lastError = e.message;
    }
    status = next;
    return status;
  }

  function schedule() {
    if (timer) { clearInterval(timer); timer = null; }
    const cfg = config();
    if (!cfg.enabled) return;
    const every = Math.max(2, Number(cfg.everyMinutes) || 10) * 60000;
    timer = setInterval(() => { tick(false).catch(() => {}); }, every);
    if (timer.unref) timer.unref();
    setTimeout(() => { tick(false).catch(() => {}); }, 45000).unref();
  }

  // The owner's switch. Only these keys are his to set from the board.
  function configure(patch) {
    const clean = {};
    if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
    if (typeof patch.model === 'string' && /^[A-Za-z0-9_.-]{2,60}$/.test(patch.model)) clean.model = patch.model;
    if (Number(patch.everyMinutes) >= 2) clean.everyMinutes = Math.round(Number(patch.everyMinutes));
    if (Number(patch.nudgeAfterMinutes) >= 1) clean.nudgeAfterMinutes = Math.round(Number(patch.nudgeAfterMinutes));
    if (patch.newConversation === true) { clean.conversation = ''; clean.room = ''; }
    const cfg = save(clean);
    schedule();
    return cfg;
  }

  function view() {
    const cfg = config();
    return { enabled: cfg.enabled, model: cfg.model, everyMinutes: cfg.everyMinutes, nudgeAfterMinutes: cfg.nudgeAfterMinutes,
             conversation: cfg.conversation, room: cfg.room, status };
  }

  return { start: schedule, tick, digest, configure, view, ME };
}

module.exports = { createSupervisor, ME };
