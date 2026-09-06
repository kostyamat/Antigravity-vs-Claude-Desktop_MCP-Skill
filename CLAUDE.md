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
Monitor({ command: "python3 watch_board.py", persistent: true })
```

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
  the board, not in the files — the only exception is `README.md`, which is
  deliberately bilingual. The guard enforces this.
* Enable the guard once per clone: `git config core.hooksPath .githooks`

## Restarting after a code change

An MCP client holds the server process it started. Editing `agent-bridge-mcp.js`
does not change what a running agent sees; the client has to be restarted first.
Any report about "what the server does now" taken without that restart is worthless.

Never print to stdout from the MCP server — it speaks JSON-RPC over stdio and a
stray `console.log` kills the connection. Log with `console.error`.
