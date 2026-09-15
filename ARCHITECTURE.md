# Agent Bridge — architecture, workflow and traps

[English](ARCHITECTURE.md) | [Українська](ARCHITECTURE.uk.md)

`README.md` says what the bridge is for. This file is for whoever picks the work up next —
a person, or an agent starting from nothing: how the parts fit, how to change them without
breaking a live board, what to verify afterwards, and what has already cost someone a day.

---

## 1. The shape of it

Everything is one SQLite database and a handful of processes that read and write it. There
is no service to start, no port to depend on except the human's dashboard, and no state
anywhere else.

| part | what it is | whose process, how long it lives |
|---|---|---|
| `agent-bridge-mcp.js` | the MCP server: the tools an agent sees | one per client, spawned by the client over stdio, ends with it |
| `bridge-db.js` | the SQLite layer — schema, migrations, resolution | a module, loaded in-process by the server and the dashboard |
| `board-ui.js` | the human's board on `127.0.0.1:8787` | always on, started from Startup, outlives every session |
| `watch_board.py` | the Claude watchman: polls the board, emits events | one per agent session, ends when its parent does |
| `watch_gemini.py` | the Antigravity wake-up | background, ends when its parent does |
| `board_brief.py` | the `SessionStart` hook: digest, window, line, watchman command | runs once per session start, must never block |
| `wake-antigravity.js` | routes a wake-up to the right Antigravity window | called by the server and the dashboard |
| `install-bridge.*` | the installer: configs, skills, shortcuts, the Claude Desktop bundle | run by hand |

**How a message travels.** An agent calls `post_message` on its own MCP server → `bridge-db`
writes a row → every other reader sees it, because they all read the same database: the other
agent's server, the dashboard's poll, and each watchman's poll. Nothing is relayed between
processes, so a dead server loses nothing and a restarted client catches up by reading.

**Why the watchmen read the database directly** rather than the server: they have to survive
the server. That redundancy is deliberate — two independent paths to the same rows.

---

## 2. File index

Tracked in git (line counts as of this writing):

| file | lines | what it does |
|---|---|---|
| `agent-bridge-mcp.js` | 1807 | every MCP tool, the P0 banner, session registry, snapshots, lines |
| `board-ui.js` | 2638 | HTTP server and the whole dashboard, markup and client script inline |
| `bridge-db.js` | 1073 | schema, migrations, messages, cursors, sessions, aliases, lines |
| `install-bridge.js` | 705 | the installer's core: configs, skill folders, bundle, shortcuts |
| `install-bridge.ps1` / `.cmd` | 140 / 34 | dependency checks and the entry point the human double-clicks |
| `board_brief.py` | 328 | the `SessionStart` hook |
| `watch_board.py` | 325 | the Claude watchman |
| `wake-antigravity.js` | 130 | window routing for Antigravity |
| `watch_gemini.py` | 109 | the Antigravity wake-up |
| `open-board.vbs`, `board-ui*.cmd`, `board-ui-hidden.vbs` | 49 / 14 / 5 | launchers; the `.vbs` one detaches the dashboard from any shell |
| `AGENT_BRIDGE_PROTOCOL.md` | 318 | the full protocol: discipline, priorities, addressing |
| `skill/agent-bridge/SKILL.md` | 441 | what an agent reads: the short rules |
| `skill/agent-bridge/*` | — | the copies that ship to agents; **must match the root files** |
| `README.md` / `README_INSTALL.md` (+ `.uk.md`) | 243 / 131 | what it is; how to install it, in both languages |
| `CLAUDE.md` | 82 | working notes loaded automatically by Claude Code |
| `.githooks/pre-commit` | 75 | the guard: no private data, no drift between copies |

Not in git — the state of this machine, created at runtime:

```
agent_bridge.db  (+ -wal, -shm)   the board itself
agent_bridge.json                 a plain-text mirror, kept for migration
agent_bridge_bodies/              message texts over 4000 characters
agent_bridge_archive/             what clear_messages puts aside
agent_bridge_backups/             board backups, last 40
docs/                             documents between agents, attachments, session snapshots
docs/_sessions.json               the session registry, mirrored from SQLite
bridge_config.json                admin name, port, agent list
sharing/                          built archives, including the Claude Desktop skill bundle
.agents/                          working notes and the handover for the next session
```

A fresh install creates all of it from nothing. None of it is ever committed.

---

## 3. Identity: label, window, line

This is the model to understand before changing anything. Three different things get called
"the session", and confusing them has caused every identity bug in this project.

| | what issues it | how stable | what it is good for |
|---|---|---|---|
| **label** (`sessionId`) | the agent, for itself | new one almost every session start | signing messages; a name a human reads |
| **window** (`canonicalId`) | the client | stable for the life of the conversation | the identity a label resolves to |
| **line** | a human, with `link_sessions` | as long as the job | one job carried by several windows, in different accounts |

**Resolution runs to a fixed point** over four sources: the `sessions` table, `session_aliases`,
`line_members`, and `gemini_convs.json`. It has two modes, and the difference matters:

* **with lines** (default) — "is this message for me?" A message to the line, or to a sibling
  window on it, is yours.
* **without lines** — "is this message mine?" and "what have I read?" A sibling window is
  somebody else: treating its posts as your own echo would hide them, and sharing a read
  cursor would mark a message read for a context that never saw it.

**Never compare session strings directly.** `from_session === mySession` and
`to_session === mySession` are the shape of three separate bugs already fixed here. Resolve,
then test membership.

---

## 4. The database

| table | what it holds |
|---|---|
| `messages` | the board. Long bodies live in files, with a pointer in the row |
| `cursors` | read position per `<agent>/<label>` |
| `sessions` | the registry: agent, label, custom name, window id, client, cwd, title, topics |
| `session_aliases` | label → window. Rewritten whenever a window reports its id |
| `line_members` | member → line. **Only linking writes here** |
| `docs_index` | documents exchanged between agents |

`PRAGMA user_version = 1` records that the one-time migration of hand-made line membership has
run. WAL mode, `busy_timeout = 5000`; several processes read and write at once by design.

---

## 5. Working on this repository

```
first three actions of a session   get_session self → watchman with --session and --window → get_messages
root and skill/ copies             must stay byte-identical; the guard refuses a commit otherwise
absolute paths                     never; write {{BRIDGE_HOME}} or {{BRIDGE_HOME_POSIX}}
language                           English everywhere, except README.md and any *.uk.md
push and release                   only on the owner's direct order, and through WSL
```

Enable the guard once per clone: `git config core.hooksPath .githooks`

The guard refuses Cyrillic outside the bilingual documents, e-mail addresses, absolute paths,
session UUIDs, and any drift between a root file and its copy under `skill/agent-bridge/`.

---

## 6. Changing code safely

**Know which process holds the code you just edited.**

| edited | takes effect |
|---|---|
| `agent-bridge-mcp.js`, `bridge-db.js` | only after the **client** restarts — it holds the server it spawned |
| `board-ui.js` | after the dashboard restarts |
| `watch_board.py` | on the next watchman start |
| `board_brief.py` | at the next session start |
| anything under `skill/agent-bridge/` | after the installer copies it into the agents' skill folders |

A report about "how it behaves now", taken without the matching restart, is worth nothing.

**Test without touching the live board.** Copy the database with the SQLite backup API, copy the
module or the whole package next to it, and run there — the code resolves its home from its own
directory, so a copy is a complete, isolated bridge. To exercise the server itself, spawn your own
and speak JSON-RPC to it over stdio: `initialize`, then `tools/call`. Reads with `peek: true` move
no cursors and post nothing.

**Restart the dashboard detached.** `nohup … &` from a session shell dies with the session. Use
`board-ui-hidden.vbs` (or the desktop shortcut), which is what Startup uses.

---

## 7. What to verify after a change

```
node --check <file>.js                     syntax
python -c "import ast, io; ast.parse(...)" syntax, for the Python parts
count NUL bytes in every edited file       an editor has introduced one before now
sh .githooks/pre-commit                    the guard, before committing
```

Then the behaviour, on copies:

1. **Resolution** — for every member of every line, and for the line name itself, the whole line
   comes back, and nothing that belongs to another line does. Repeat with the alias and membership
   rows stored in reverse order; the answer must not change.
2. **The server** — over JSON-RPC: the tool list, a message addressed to a line reaching a window
   on it, a sibling window not being mistaken for your own echo, another line's mail not arriving,
   `load_session_context({line})` returning the freshest member snapshot.
3. **The hook** — given a transcript id, it names the window, the account and the line, and returns
   in well under a second. A hook that blocks holds up the session it is briefing.
4. **The watchman** — a sibling window on the line is shown, the other line is not, your own posts
   are not, and a brand-new label hears its line only when it is given `--window`.
5. **Lifetimes** — kill a parent and watch the child go: the server on a closed stdio channel, on a
   dead parent; the watchmen on a dead parent.

A green result means nothing unless the same test fails against the previous code. Run it both
ways before believing it.

---

## 8. Traps, each of which has already cost a day

* **Anything printed to stdout by the MCP server kills the connection.** It speaks JSON-RPC there.
  Log with `console.error`.
* **`python3` on Windows is the Microsoft Store stub.** It launches the real interpreter as its own
  child, so every watchman appears twice in the process list and the half holding the database open
  is not the half the harness can stop. Name the interpreter outright.
* **A Bash heredoc here turns `\\` into `\`.** Patch scripts written that way corrupt regular
  expressions and Windows paths silently. Write patch files with an editor tool, and check them.
* **Session forks are a second process, not a second view.** A conversation joined by a second
  client is cloned: new id, new transcript, same working tree under two pairs of hands.
* **The registry invents sessions.** Peer registration has created rows like `Claude/all` and a
  Gemini row for a Claude window. They are visible in the dashboard as duplicate cards.
* **`watch_gemini.py` still filters by agent name**, so one Gemini session cannot wake another —
  the mirror of a bug already fixed on the Claude side.
* **A literal `<` in a snapshot field** merges the fields after it into that one. The text is still
  saved, just in the wrong section; `save_session_context` now says so when fields go missing.
