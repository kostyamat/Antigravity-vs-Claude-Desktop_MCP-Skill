'use strict';
// Antigravity conversations that are done: deleted, and the board cleaned after them.
//
// The owner, 18.11.2026: helpers multiply; one that has done its work should go — "worked, goodbye" —
// because each open conversation grows Antigravity's context, listens to the bridge and answers when
// nobody needs it. And the bridge must see at once which conversation was deleted and take its room
// away with it.
//
// Deleting: the application's own language server, DeleteCascadeTrajectory (antigravity-api.remove),
// the same call its UI makes. Its CLI (agentapi) has no delete. Measured on a throwaway conversation:
// exactly that one folder under ~/.gemini/antigravity/brain went, nothing else (344 → 345 → 344).
//
// Seeing a deletion: a conversation lives in ~/.gemini/antigravity/brain/<id>. One that is gone —
// deleted here, by a lead, or by the owner in the application — is taken off the board: its pair
// ends, it leaves every room, and a room left to one participant (its pair room among them) is
// archived into a zip, never deleted. Never wider than the target: only ids shaped like Antigravity
// conversations, only when the folder of conversations is there and populated, and never more than
// MAX_AT_ONCE in one sweep — more would mean the folder is not where it was, and the owner is told.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_AT_ONCE = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function brainDir() {
  return path.join(process.env.USERPROFILE || os.homedir(), '.gemini', 'antigravity', 'brain');
}

// Is this Antigravity conversation gone from this machine? null when that cannot be told.
function gone(id, dir) {
  const d = dir || brainDir();
  if (!UUID.test(String(id || ''))) return null;
  let n = 0;
  try { n = fs.readdirSync(d).length; } catch (_) { return null; }
  if (n < 3) return null;                              // not the folder we know: say nothing
  return !fs.existsSync(path.join(d, String(id)));
}

// Take the gone conversations off the board. deps: { bridgeDb, archiveRoom(id) -> {file}, say(msg) }.
// Returns { gone: [ids], archived: [rooms], refused?: reason }.
function sweep(deps, opts) {
  const { bridgeDb } = deps;
  const dir = (opts && opts.dir) || brainDir();
  const only = opts && opts.only ? new Set(opts.only) : null;
  const out = { gone: [], archived: [] };
  const candidates = new Set();
  for (const h of bridgeDb.readHelpers() || []) if (UUID.test(h.helper)) candidates.add(h.helper);
  for (const r of bridgeDb.readRooms() || []) for (const m of r.members || []) if (UUID.test(m.card)) candidates.add(m.card);
  const lost = [...candidates].filter(id => (!only || only.has(id)) && gone(id, dir) === true);
  if (!lost.length) return out;
  if (lost.length > MAX_AT_ONCE && !(opts && opts.force)) {
    out.refused = `${lost.length} Antigravity conversations look gone at once (more than ${MAX_AT_ONCE}); nothing was changed`;
    return out;
  }
  const helpers = bridgeDb.readHelpers() || [];
  for (const id of lost) {
    const pair = helpers.find(h => h.helper === id);
    if (pair) bridgeDb.dropHelper(id);
    for (const r of bridgeDb.readRooms() || []) {
      if (!(r.members || []).some(m => m.card === id)) continue;
      bridgeDb.removeRoomMember(r.id, id);
      const left = ((bridgeDb.getRoom(r.id) || {}).members || []).filter(m => !/^machine:/.test(m.card));
      const special = /^Machine: |^Supervisor/.test(r.name || '');
      if (!special && (left.length < 2 || (pair && pair.room === r.id))) {
        try { const a = deps.archiveRoom(r.id); out.archived.push({ room: r.id, name: r.name, file: a && a.file }); } catch (_) {}
      }
    }
    out.gone.push(id);
    if (pair && deps.say) {
      deps.say({ to: 'Claude', toSession: pair.lead, status: 'info', priority: 'fyi',
        text: `Board: your helper ${id} is gone from Antigravity (deleted). The pair is ended` +
          (out.archived.length ? `; its room ${out.archived.map(a => `"${a.name}"`).join(', ')} is archived (a zip with the conversation and documents).` : '.') });
    }
  }
  return out;
}

module.exports = { gone, sweep, brainDir, UUID, MAX_AT_ONCE };
