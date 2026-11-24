'use strict';
// Which Antigravity model a helper runs on, and with how much effort.
//
// Antigravity has no effort setting of its own: each effort is a model of its own in the list
// the application reports — "Gemini 4 Hydrogen (Low)", "(Medium)", "(High)", "(XHigh)",
// "Gemini 3.8 Flash (Low)" … — each with its id (gemini-4-hydrogen-medium) and the internal
// name a message asks for (MODEL_PLACEHOLDER_M526). The list is read from the running
// application, never written down here: models come and go with its updates.
//
// The owner, 24.11.2026: a lead picks its helper by what the work needs, and its effort to spare
// the quota — simple actions (tapping a screen) on the least effort, analysis and code on medium,
// high for big analytical work; the same for Flash (a translation does not need high, a short
// one not even medium). KINDS below is that rule; a lead may always name family and effort itself.

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

// Kind of work → family and effort. Family: the one that is enough for it.
const KINDS = {
  ui:        { family: 'flash',    effort: 'minimal', what: 'simple actions: tapping a screen, running a known command, copying files' },
  translate: { family: 'flash',    effort: 'medium',  what: 'translation (a short one: effort "minimal")' },
  routine:   { family: 'flash',    effort: 'medium',  what: 'routine edits, logs, searches by a known recipe' },
  code:      { family: 'hydrogen', effort: 'medium',  what: 'writing and fixing code' },
  analysis:  { family: 'hydrogen', effort: 'medium',  what: 'analysis: reading code or firmware, finding a cause' },
  deep:      { family: 'hydrogen', effort: 'high',    what: 'big analytical work: a subsystem, a protocol, a long investigation' }
};

// "Gemini 4 Hydrogen (Medium)" → { family: 'gemini 4 hydrogen', effort: 'medium' }; no effort in
// the label → effort ''.
function parseLabel(label) {
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(String(label || ''));
  const effort = m ? m[2].trim().toLowerCase().replace(/[^a-z]/g, '') : '';
  if (m && EFFORTS.includes(effort)) return { family: m[1].trim().toLowerCase(), effort };
  return { family: String(label || '').trim().toLowerCase(), effort: '' };
}

// The application's model list → [{ label, id, name, family, effort, remaining }], usable only.
function fromConfigs(configs) {
  return (configs || []).filter(c => c && !c.disabled && c.modelId && c.modelOrAlias && c.modelOrAlias.model)
    .map(c => Object.assign({ label: c.label, id: c.modelId, name: c.modelOrAlias.model,
      remaining: c.quotaInfo && typeof c.quotaInfo.remainingFraction === 'number' ? c.quotaInfo.remainingFraction : null },
      parseLabel(c.label)));
}

// { model?, effort?, kind? } → { model: <one entry of the list> } or { error }.
// model: an exact id (gemini-4-hydrogen-medium) or a word of the family ("hydrogen", "flash").
// effort: minimal | low | medium | high | xhigh; "minimal" is the least the family has, and an
// effort the family lacks is the nearest below it, else the nearest above.
function resolve(list, want) {
  const w = want || {};
  const kind = w.kind ? KINDS[String(w.kind).toLowerCase()] : null;
  if (w.kind && !kind) return { error: `unknown kind "${w.kind}" — one of ${Object.keys(KINDS).join(', ')}` };
  const asked = String(w.model || (kind && kind.family) || '').trim().toLowerCase();
  let effort = String(w.effort || (kind && kind.effort) || '').trim().toLowerCase();
  if (effort && !EFFORTS.includes(effort)) return { error: `unknown effort "${w.effort}" — one of ${EFFORTS.join(', ')}` };
  if (!asked) return { error: 'name the model ("hydrogen", "flash" or an exact id) or the kind of work' };
  const exact = list.find(m => m.id.toLowerCase() === asked);
  if (exact && !w.effort) return { model: exact };
  const fam = exact ? exact.family : asked;
  const mine = list.filter(m => m.family === fam || m.family.split(/\s+/).includes(fam) || m.family.endsWith(' ' + fam));
  if (!mine.length) return { error: `no usable model "${asked}" in Antigravity now — ${families(list)}` };
  const fams = [...new Set(mine.map(m => m.family))];
  if (fams.length > 1) return { error: `"${asked}" names several models (${fams.join(', ')}) — name one` };
  const ranked = mine.filter(m => m.effort).sort((a, b) => EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(b.effort));
  if (!ranked.length) return { model: mine[0] };
  if (!effort) effort = ranked.some(m => m.effort === 'medium') ? 'medium' : ranked[0].effort;
  if (effort === 'minimal') return { model: ranked[0] };
  const at = EFFORTS.indexOf(effort);
  const below = ranked.filter(m => EFFORTS.indexOf(m.effort) <= at);
  return { model: below.length ? below[below.length - 1] : ranked[0] };
}

// One line per family, efforts in order, quota left where the application gives it.
function families(list) {
  const by = new Map();
  for (const m of list) {
    if (!by.has(m.family)) by.set(m.family, []);
    by.get(m.family).push(m);
  }
  return [...by.entries()].map(([f, ms]) => {
    const effs = ms.filter(m => m.effort).sort((a, b) => EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(b.effort)).map(m => m.effort);
    const left = ms.find(m => m.remaining !== null);
    return `${ms[0].label.replace(/\s*\([^)]*\)\s*$/, '')}${effs.length ? ' (' + effs.join(', ') + ')' : ''}` +
      (left ? `, ${Math.round(left.remaining * 100)} % quota left` : '');
  }).join('; ');
}

function describe(list) {
  return 'Models in Antigravity now: ' + families(list) + '. Kinds of work: ' +
    Object.entries(KINDS).map(([k, v]) => `${k} = ${v.family} ${v.effort} (${v.what})`).join('; ') + '.';
}

let cache = null;
// The list from the running application, kept a few minutes.
async function catalogue() {
  if (cache && Date.now() - cache.at < 5 * 60e3) return cache.list;
  const j = await require('./antigravity-quota').call('GetUserStatus',
    { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } });
  const list = fromConfigs((((j.userStatus || {}).cascadeModelConfigData) || {}).clientModelConfigs);
  cache = { at: Date.now(), list };
  return list;
}

module.exports = { EFFORTS, KINDS, parseLabel, fromConfigs, resolve, families, describe, catalogue };
