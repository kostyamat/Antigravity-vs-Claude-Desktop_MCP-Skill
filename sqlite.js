// The bridge's one door to node:sqlite: every module loads DatabaseSync from here, never directly.
//
// Node 22 prints "ExperimentalWarning: SQLite is an experimental feature" on stderr the first time
// node:sqlite is loaded. A hook that stops the agent (exit 2) hands its whole stderr to the agent,
// so this warning reached every window as a "Stop hook blocking error" in front of the real message.
// Only that one warning is dropped, and only while the module loads; every other warning still goes out.
'use strict';

const emit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type;
  const text = String((warning && warning.message) || warning);
  if (type === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
  return emit.call(process, warning, ...rest);
};
try {
  module.exports = require('node:sqlite');
} finally {
  process.emitWarning = emit;
}
