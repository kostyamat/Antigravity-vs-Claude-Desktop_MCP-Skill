#!/usr/bin/env node
'use strict';

// A window joins the board when it opens, not when its agent first speaks.
//
// Until now the registry row was created only by post_message and get_messages,
// so a freshly opened window was invisible until something inside it touched the
// bridge. After an account switch that is every window at once: the owner looked
// at the board, saw none of his new windows, and read it as "the board cannot see
// the other account". The account was never the barrier — silence was.
//
// The SessionStart hook already knows the window, its account and its title. This
// writes them under the same key the agent will sign with later, so one row ends
// up describing the window, not two: a label with no window beside a window with
// no label is exactly the mess this identity model exists to prevent.
//
// usage: node register-window.js <agent> <sessionId> <windowId> [client] [cwd] [title]

const bridgeDb = require('./bridge-db.js');

function main() {
  const [agent, sessionId, windowId, client, cwd, title] = process.argv.slice(2);
  const who = String(agent || '').trim();
  const sid = String(sessionId || '').trim();
  const win = String(windowId || '').trim();

  // Without a window there is nothing here that the agent will not record itself
  // the first time it reads the board. A terminal session has no window record,
  // and rows for those would only fill the list with names nobody can address.
  if (!who || !sid || !win) return 0;

  const reg = bridgeDb.readSessions();
  const key = who + '/' + sid;
  const prev = reg[key] || {};
  const now = new Date().toISOString();

  bridgeDb.saveSession({
    agent: who,
    sessionId: sid,
    // Everything the session has earned stays as it is: this call fills in
    // identity and the moment the window opened, and claims nothing else.
    customName: prev.customName || '',
    project: prev.project || '',
    summary: prev.summary || '',
    knows: prev.knows || '',
    topics: prev.topics || [],
    contacts: prev.contacts || {},
    hasSnapshot: !!prev.hasSnapshot,
    canonicalId: win,
    client: String(client || '').trim(),
    cwd: String(cwd || '').trim(),
    title: String(title || '').trim(),
    firstSeen: prev.firstSeen || now,
    lastSeen: now
  });
  return 0;
}

try {
  process.exit(main());
} catch (_) {
  // The brief is a convenience and must never break the start of a session;
  // a board that cannot be written to is a reason to stay quiet, not to fail.
  process.exit(0);
}
