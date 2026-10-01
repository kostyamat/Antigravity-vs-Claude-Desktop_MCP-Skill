'use strict';
// Does the project an agent works in follow the agent-workflow layout? Claude
// Code learns it from the SessionStart hook (board_brief.py, workflow_hint — the
// same rule in Python, because that hook runs before any bridge code). Antigravity
// has no such hook, so the bridge says it once per project, on the first read.

const fs = require('fs');
const path = require('path');

const told = new Set();

function workflowHint(cwd) {
  if (!cwd) return '';
  let d = path.resolve(String(cwd));
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) break;
    const up = path.dirname(d);
    if (up === d) return '';
    d = up;
  }
  if (told.has(d)) return '';
  told.add(d);
  if (fs.existsSync(path.join(d, '.no-agent-workflow'))) return '';
  if (['AGENTS.md', 'HANDOFF.md'].some(f => fs.existsSync(path.join(d, '.agents', f)))) return '';
  return `🧭 This project (${d}) does not follow the agent-workflow skill yet: there is no .agents/. ` +
    'Tell the owner, in one or two lines, that you have the agent-workflow skill and offer to set the ' +
    'project up by it (.agents/AGENTS.md, HANDOFF.md, TODO.md, DEBT.md; move scattered notes there). ' +
    'Do it only after he agrees. If he declines, create an empty .no-agent-workflow file in the project ' +
    'root so the offer is not repeated.';
}

module.exports = { workflowHint };
