# Agent Bridge — working notes for Claude Code

This directory is the **bridge home**. The MCP server, the board UI and the helper
scripts all resolve their paths from the folder they sit in, so the board database
and everything around it live right here, beside the code, and are kept out of git
by `.gitignore`.

## First thing in a session

Raise the watchman before anything else. It is session-scoped: it died with the
previous session and does not exist right now. Without it, the human and the other
agent write to the board and nothing answers.

```
Monitor({ command: "python3 watch_board.py --session <your session id> --agent Claude", persistent: true })
```

The `--session` argument is what keeps your orders apart from the session next door.
Drop it and the watchman guesses from the registry, which does not yet contain a
session that has not written to the board — the state every session starts in.

Then read the **content** of the board, not the counters:

```
get_messages({ reader: "Claude", sessionId: "<your session id>" })
```

`board_status` shows how many messages are unread. It does not show what they say,
and it is not a substitute for reading them.

## Editing the package

* Root files and their copies under `skill/agent-bridge/` must stay identical. They
  drifted apart once and agents ended up reading a protocol 509 lines out of date.
  The pre-commit guard refuses a commit that lets them diverge; copy the root file
  across rather than editing one side.
* Documentation never carries an absolute path. Write `{{BRIDGE_HOME}}` (backslashes)
  or `{{BRIDGE_HOME_POSIX}}` (forward slashes); the installer substitutes the real
  path into the copies it writes into each agent's skill folder.
* This repository is public and English. Working notes in other languages belong on
  the board, not in the files. User-facing documentation is the deliberate exception:
  `README.md` carries both languages in one file, and every other README ships a
  `*.uk.md` companion beside it (`README_INSTALL.uk.md`, `skill/README.uk.md`). Touch
  one side and touch the other in the same commit. The guard enforces the rule from
  the other end: Cyrillic is refused everywhere except `README.md` and `*.uk.md`.
* Enable the guard once per clone: `git config core.hooksPath .githooks`

## Handing over, and picking up

Working notes for this machine live in `.agents/`, which is ignored by git because it
holds real paths and session ids. `.agents/HANDOFF.md` is the one to read first when
you take over: what was done, what was decided with the human and what is still open,
the sharp edges, and how to bring the processes back. Keep it current — a session ends
without warning, and the next one starts from that file, not from your memory.

The order that works, first three actions of a session:

```
get_session({ session_id: "self" })    // who you actually are, before you sign anything
Monitor(the watchman, with --session)  // the SessionStart hook prints it filled in
get_messages({ reader, sessionId })    // the CONTENT, not the counters
```

Before starting a topic, `find_session` — several sessions legitimately share a thread,
and re-doing someone's research costs more than reading it.

## Verifying a change to the server without disturbing the clients

An MCP client holds the server it started, so a change to `agent-bridge-mcp.js` is
invisible until that client restarts — and restarting the human's clients to test your
own edit is rude at best. Spawn your own server and speak JSON-RPC to it over stdio:
`initialize`, then `tools/call`. Reads with `peek: true` move no cursors and post
nothing. That is how the identity work was verified while three clients stayed open.

## Restarting after a code change

An MCP client holds the server process it started. Editing `agent-bridge-mcp.js`
does not change what a running agent sees; the client has to be restarted first.
Any report about "what the server does now" taken without that restart is worthless.

Never print to stdout from the MCP server — it speaks JSON-RPC over stdio and a
stray `console.log` kills the connection. Log with `console.error`.
