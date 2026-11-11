'use strict';
// The state of a project's work has one home: the slice, .agents/HANDOFF.md in
// the project's folder. The board used to keep a second copy (a "context
// snapshot" per session), and the two drifted apart — a window restored the
// snapshot and worked from a state the slice had already left behind. The owner
// decided on 11.11.2026: one copy, in the project, and every project in git.
//
// So the board stores nothing. It only knows where a project's slice is, because
// a project is a folder (project-line.js) and a window knows its project.

const fs = require('fs');
const path = require('path');
const { projectKey, isProjectKey } = require('./project-line');

// The project folder behind what was asked for: a folder, a line of work, or any
// window on one. '' when it leads to no folder (a hand-made line with a name).
function folderOf(bridgeDb, asked) {
  const a = String(asked || '').trim();
  if (!a) return '';
  const key = projectKey(a);
  if (isProjectKey(key)) return key;
  const line = bridgeDb.lineOf(a);
  return isProjectKey(line) ? line : '';
}

// { folder, file, text, mtime, git } — text is '' when the project has no slice,
// folder is '' when there is no project folder to look in.
function find(bridgeDb, asked) {
  const folder = folderOf(bridgeDb, asked);
  if (!folder || !fs.existsSync(folder)) return { folder: '', file: '', text: '', mtime: 0, git: false };
  const file = path.join(folder, '.agents', 'HANDOFF.md');
  let text = '', mtime = 0;
  try { text = fs.readFileSync(file, 'utf8'); mtime = fs.statSync(file).mtimeMs; } catch (_) {}
  return { folder, file, text, mtime, git: fs.existsSync(path.join(folder, '.git')) };
}

module.exports = { folderOf, find };
