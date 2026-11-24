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

// Only Google's own models. Antigravity also offers Claude and GPT-OSS, but Google gives very little
// quota for those, and they are what the helper is there to spare (owner, 24.11.2026: leads turned on
// Claude Sonnet in Antigravity: Google's own models are to be used).
const isGoogle = m => /^gemini\b/i.test(m.label) || /^gemini-/i.test(m.id);

// Kind of work → family and effort: the ladder, cheapest rung first. The owner, 24.11.2026: Flash
// often gets code wrong, so code goes to Hydrogen (low, medium for hard code); Hydrogen at its
// highest is as strong as Fable and eats the quota fast, so it is for very deep research only; Argon
// is not a helper model at all but a consultant (the argon-review skill). Neither everything on
// Flash nor everything on the strongest.
const KINDS = {
  ui:        { family: 'flash',    effort: 'minimal', what: 'simple actions: tapping a screen, running a known command, copying files' },
  translate: { family: 'flash',    effort: 'medium',  what: 'translation (a short one: effort "minimal")' },
  routine:   { family: 'flash',    effort: 'medium',  what: 'logs, searches, renames by a known recipe — no code that ships' },
  code:      { family: 'hydrogen', effort: 'low',     what: 'code by a clear spec: a known change, a pattern already in the project' },
  complex:   { family: 'hydrogen', effort: 'medium',  what: 'hard code: a new mechanism, threads, native or smali patches, a bug Flash got wrong' },
  analysis:  { family: 'hydrogen', effort: 'medium',  what: 'analysis: reading code or firmware, finding a cause' },
  deep:      { family: 'hydrogen', effort: 'high',    what: 'big analytical work: a subsystem, a protocol, a long investigation' },
  research:  { family: 'hydrogen', effort: 'xhigh',   what: 'very deep research, as strong as Fable and as costly: only when "deep" fell short' }
};

// How a lead climbs it; said with the list every time a lead asks for the models.
const LADDER = 'Start on the lowest kind that fits; go one rung up only after a wrong or shallow result, and back ' +
  'down once the hard part is done. Flash never writes code that ships. "research" (Hydrogen xhigh) burns the ' +
  'quota fastest: say in the task why "deep" is not enough. Argon is no helper model: consult it through the ' +
  'argon-review skill for a second opinion, a review before a release, or the hardest reasoning — never for doing the work.';

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
  return (configs || []).filter(c => c && !c.disabled && c.modelId && c.modelOrAlias && c.modelOrAlias.model && isGoogle({ label: c.label, id: c.modelId }))
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
  if (/claude|sonnet|opus|haiku|gpt|oss/.test(asked)) {
    return { error: `"${asked}" is not a Google model: a helper runs only on Google's own (Hydrogen, Flash) — Antigravity ` +
      'gives very little quota for the others' };
  }
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
    Object.entries(KINDS).map(([k, v]) => `${k} = ${v.family} ${v.effort} (${v.what})`).join('; ') + '. ' + LADDER;
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

// What a helper conversation really runs on, and what the board is to answer it on from now.
// Read from its latest step. A model of Google's own that is offered → kept as it is; anything else
// (Claude, GPT-OSS, a model no longer offered, or none yet) → Hydrogen medium, and `note` says so.
// → { seen: label or '', id: what to record as standing, own: what it was on, note }.
async function check(conversationId, where) {
  const list = await catalogue();
  let name = '';
  try { name = await require('./antigravity-api').lastModel(conversationId, where); } catch (_) {}
  const all = (await allLabels().catch(() => ({}))) || {};
  const hit = list.find(m => m.name === name);
  if (hit) return { seen: hit.label, id: hit.id, own: hit.id, note: `It runs on ${hit.label}.` };
  const fallback = resolve(list, { model: 'hydrogen', effort: 'medium' });
  if (fallback.error) return { seen: all[name] || name, id: '', own: '', note: '' };
  const was = all[name] || name;
  return { seen: was, id: fallback.model.id, own: was ? String(all[name] ? all[name] : name) : '',
    note: was
      ? `It was running on ${was}, which is not a Google model offered to helpers: the board answers it on ${fallback.model.label} from now on.`
      : `It has not answered yet: the board answers it on ${fallback.model.label}.` };
}

// Every model the application lists, Google's or not: internal name → label (for the note above).
async function allLabels() {
  const j = await require('./antigravity-quota').call('GetUserStatus',
    { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } });
  const out = {};
  for (const c of (((j.userStatus || {}).cascadeModelConfigData) || {}).clientModelConfigs || []) {
    if (c && c.modelOrAlias && c.modelOrAlias.model) out[c.modelOrAlias.model] = c.label;
  }
  return out;
}

// "ui = flash minimal, …": the kinds in one line, for the tool schema.
function kindsLine() { return Object.entries(KINDS).map(([k, v]) => `${k} = ${v.family} ${v.effort}`).join(', '); }

module.exports = { EFFORTS, KINDS, LADDER, kindsLine, isGoogle, parseLabel, fromConfigs, resolve, families, describe, catalogue, check };
