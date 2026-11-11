'use strict';
// Skills served through the board's MCP server, read live from this machine's
// installed copies — so no client needs a copy of its own.
//
// The Claude chat app has no skills folder on disk: a skill reaches it only by
// being uploaded into the account, by hand. An uploaded copy is frozen at the
// day it was uploaded and is seen by Claude Code too, beside the current one on
// disk; the two drifted, and agents read the old one. Instead the chat reads the
// installed skill through read_skill, the same files Claude Code reads, always
// the version that is installed. Nothing needs uploading.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILLS_DIR = path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'skills');
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const MAX_BYTES = 200 * 1024;

function listSkills() {
  let names = [];
  try { names = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch (_) {}
  return names.filter(n => NAME.test(n) && fs.existsSync(path.join(SKILLS_DIR, n, 'SKILL.md'))).sort().map(n => {
    let description = '';
    try {
      const head = fs.readFileSync(path.join(SKILLS_DIR, n, 'SKILL.md'), 'utf8').slice(0, 3000);
      const m = head.match(/^description:\s*"?(.+?)"?\s*$/m);
      if (m) description = m[1];
    } catch (_) {}
    return { name: n, description };
  });
}

// SKILL.md, or another text file of the skill (PROTOCOL.md, references/DETAILS.md).
// Only inside that skill's folder; never a path that climbs out of it.
function readSkill(name, file) {
  if (!NAME.test(String(name || ''))) throw new Error('read_skill: no skill named "' + name + '"');
  const root = path.join(SKILLS_DIR, name);
  if (!fs.existsSync(path.join(root, 'SKILL.md'))) {
    const known = listSkills().map(s => s.name).join(', ');
    throw new Error('read_skill: "' + name + '" is not installed on this machine. Installed: ' + (known || 'none'));
  }
  const rel = String(file || 'SKILL.md').replace(/\\/g, '/');
  const target = path.resolve(root, rel);
  const inside = path.relative(root, target);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('read_skill: "' + rel + '" is outside the skill');
  if (!/\.(md|txt|json|py|js)$/i.test(target)) throw new Error('read_skill: only text files of a skill are served');
  if (!fs.existsSync(target)) {
    const files = [];
    const walk = (d, p) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(path.join(d, e.name), p + e.name + '/'); else if (/\.md$/i.test(e.name)) files.push(p + e.name);
    } };
    try { walk(root, ''); } catch (_) {}
    throw new Error('read_skill: ' + name + ' has no "' + rel + '". Its documents: ' + files.join(', '));
  }
  const buf = fs.readFileSync(target);
  return buf.length > MAX_BYTES ? buf.slice(0, MAX_BYTES).toString('utf8') + '\n…(cut at 200 KB)' : buf.toString('utf8');
}

// Claude Code and Antigravity load the skills from disk themselves; telling
// them again would only cost every session the same rules twice. Every other
// client — the Claude chat app first of all — is pointed at read_skill.
function hasSkillsOnDisk(clientName) {
  return /claude-code|antigravity|gemini|jetski|windsurf|codeium/i.test(String(clientName || ''));
}

function instructionsFor(clientName) {
  if (hasSkillsOnDisk(clientName)) return '';
  return 'Agent Bridge is the shared board of the AI agents on this machine and their owner. ' +
    'Before your first board action in this conversation, call read_skill({name: "agent-bridge"}) and follow it: ' +
    'it is read live from this machine, so it is always the installed version. For keeping a project\'s state ' +
    '(.agents/, the session slice) read_skill({name: "agent-workflow"}); read_skill with no name lists every ' +
    'installed skill. If this account also holds an uploaded copy of any of these skills, ignore it: it is older.';
}

module.exports = { SKILLS_DIR, listSkills, readSkill, hasSkillsOnDisk, instructionsFor };
