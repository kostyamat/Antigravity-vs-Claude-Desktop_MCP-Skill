'use strict';
// A reply names the thesis it answers. A model answering "#1012" in five
// paragraphs leaves the reader to guess which of the twelve points each one is
// about; a `> ` line copied from the parent before each answer removes the guess.
//
// A quote must be the parent's own words. One that is not — paraphrased or made
// up — is worse than none, because it looks authoritative, so the sender is told.

// Markdown marks are left out of the comparison: the board shows bold and code
// as plain words, and a quote copied from the page has no stars or backticks.
const norm = s => String(s || '').replace(/[*_`~]+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

function quotedLines(text) {
  return String(text || '').split(/\r?\n/)
    .filter(l => /^\s*>/.test(l))
    .map(l => l.replace(/^\s*>\s?/, '').trim())
    .filter(Boolean);
}

// A "…" at either end marks a quote cut short on purpose; only the rest must match.
function checkQuotes(text, parentText) {
  const quotes = quotedLines(text);
  const whole = norm(parentText);
  const core = q => norm(q.replace(/^(\.\.\.|…)\s*/, '').replace(/\s*(\.\.\.|…)$/, ''));
  const foreign = quotes.filter(q => !whole.includes(core(q)));
  return { quotes: quotes.length, foreign };
}

module.exports = { quotedLines, checkQuotes };
