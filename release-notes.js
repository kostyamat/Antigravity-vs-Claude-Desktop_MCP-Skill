'use strict';
// What changed in the bridge, told once to every window that is already running.
//
// A session reads its skill when it starts and keeps that copy for its whole
// life. A release rewrites the skill files, but a window that started before it
// has no reason to think its copy is stale, so it goes on by the old rules until
// somebody tells it — as an agent put it: "a line in the room is cheaper than a
// quiet file update". The line comes from the server, once per window and
// version, at the top of get_messages: no broadcast, nobody woken.
//
// The text is the changelog's own: the bold lead of each paragraph of this
// version's section. Nothing is written twice.

const fs = require('fs');
const path = require('path');

const DIR = __dirname;

function currentVersion() {
  try { return fs.readFileSync(path.join(DIR, 'VERSION'), 'utf8').trim(); } catch (_) { return ''; }
}

function highlights(version) {
  try {
    const text = fs.readFileSync(path.join(DIR, 'CHANGELOG.md'), 'utf8');
    const start = text.indexOf('\n## v' + version);
    if (start < 0) return [];
    const rest = text.slice(start + 1);
    const end = rest.indexOf('\n## ', 4);
    const section = end > 0 ? rest.slice(0, end) : rest;
    return [...section.matchAll(/^\*\*([^*\n]+)\*\*/gm)].map(m => m[1].trim().replace(/\.$/, ''));
  } catch (_) { return []; }
}

// The line for a window that has not been told about this version, or null.
// `seen` is the version it was last told about; marking it is the caller's job,
// so a peek tells without spending the news.
function updateNotice(seen) {
  const v = currentVersion();
  if (!v || seen === v) return null;
  const points = highlights(v);
  return `🆕 The bridge is now ${v}` +
    (points.length ? `: ${points.join('; ')}` : '') +
    '. If this session started before the update, your copy of the agent-bridge skill is older — read it again ' +
    '(CHANGELOG.md has the details).';
}

module.exports = { currentVersion, highlights, updateNotice };
