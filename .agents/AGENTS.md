# Agent Bridge — rules for an agent working on this repository

A shared board for the AI agents on this machine and the human. An MCP server gives the
agents the tools, a Skill tells them how to behave, a local web board gives the human a
chat, and SQLite underneath keeps the history when a window closes.

Published at `github.com/kostyamat/Antigravity-vs-Claude-Desktop_MCP-Skill`, branch
`master`. The repository is public; treat everything in it as readable by strangers.

## Layout

Everything resolves from the folder it sits in, so the board database and the working
files live beside the code. `{{BRIDGE_HOME}}` below means that folder.

```
agent-bridge-mcp.js      MCP server: the tools the agents see
bridge-db.js             SQLite layer (node:sqlite, WAL), shared by server and board
board-ui.js              the human's board, 127.0.0.1:8787, normally always up
watch_board.py           watchman for Claude Code
watch_gemini.py          waker for Antigravity
board_brief.py           SessionStart hook: digest, window, line, watchman command
skill/agent-bridge/      the copies shipped to agents; must match the root files
.agents/                 working notes for this machine; only this file is tracked
```

## Running and verifying

The board comes up with `board-ui.cmd`, the desktop shortcut, or
`wscript board-ui-hidden.vbs`. Use the vbs, not `nohup … &` from a session shell: a
process started from the shell dies with the session, and the board must outlive it.

Never start `agent-bridge-mcp.js` by hand. An MCP client owns the server it started;
the way to reload it is to restart that client.

**An edit to the server is invisible until the client restarts.** Any statement about
"what the server does now" made without that restart is worthless. To check your own
change without disturbing the human's clients, start your own server and speak JSON-RPC
to it over stdio: `initialize`, then `tools/call`. A read with `peek: true` moves no
cursor and posts nothing.

**Never write to stdout from the MCP server.** It speaks JSON-RPC over stdio and one
stray `console.log` kills the connection. Log with `console.error`.

Before claiming a size, a count or a payload, measure it. The interesting numbers here
have all been different from the ones that were assumed.

## Prohibitions

* **Push only on a direct order**, and through WSL — the key lives there, not on the
  Windows side. A release is an order of its own.
* **No absolute path in a tracked file.** Write `{{BRIDGE_HOME}}` for backslashes or
  `{{BRIDGE_HOME_POSIX}}` for forward slashes; the installer substitutes the real path
  into the copies it writes into each agent's skill folder.
* **Root files and their `skill/agent-bridge/` copies must stay identical.** They
  drifted once and agents read a protocol 509 lines out of date. Copy the root file
  across; never edit one side alone.
* **English only in tracked files.** Working notes in another language belong on the
  board. User-facing documentation is the deliberate exception: `README.md` carries both
  languages, and every other README ships a `*.uk.md` companion. Touch one side and
  touch the other in the same commit.
* **The database is the only store of board state.** Messages, documents, sessions,
  lines and rooms live in `agent_bridge.db`; no JSON file beside it is read or written.
* **A name labels; it never addresses or groups.** An address is a window id or the
  label an agent signs with; grouping is a line of work. A name typed on the board is
  often the name of one task, and must not become the window's identity.
* **Take only what is addressed to your own session.** Another session's task is not
  yours to pick up.

The pre-commit guard enforces the path, language and copy-sync rules, and refuses an
e-mail address or a session identifier. Enable it once per clone:
`git config core.hooksPath .githooks`

A patch is written to a file and then checked — `node --check`, `ast.parse`, and a count
of NUL bytes. A heredoc in Bash mangles doubled backslashes here, and an in-place edit
once turned a space inside a template string into a NUL byte.

## Dependencies

Nothing in this repository depends on another project, and no cross-application
contract covers it. The dependency runs the other way: every agent session on
this machine depends on the board being up and on the Skill being current in
`~/.claude/skills/agent-bridge` and `~/.gemini/config/skills/agent-bridge`. The installer
writes both, and rebuilds the archive Claude Desktop needs, since that client takes a
Skill only through its own upload screen.

Requires Node.js 22.5 or newer, for the built-in SQLite, and Python 3 on PATH.
