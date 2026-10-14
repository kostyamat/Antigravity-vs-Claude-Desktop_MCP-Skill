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

// A "…" marks text left out on purpose, at either end or in the middle.
function checkQuotes(text, parentText) {
  const quotes = quotedLines(text);
  const whole = norm(parentText);
  // "…" in the middle joins two pieces of the same passage; each must be there, in order.
  const found = q => {
    let at = 0;
    for (const piece of q.split(/\.\.\.|…/).map(norm).filter(Boolean)) {
      const i = whole.indexOf(piece, at);
      if (i < 0) return false;
      at = i + piece.length;
    }
    return true;
  };
  const foreign = quotes.filter(q => !found(q));
  return { quotes: quotes.length, foreign };
}

module.exports = { quotedLines, checkQuotes };
