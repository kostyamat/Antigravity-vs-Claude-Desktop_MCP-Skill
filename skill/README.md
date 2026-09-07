# 📦 agent-bridge — a shared board for several AI agents and one human

[English](README.md) | [Українська](README.uk.md)

A kit for a single machine: several agents (Claude Code, Claude Desktop, Antigravity / Gemini CLI)
and a human write into one log that **outlives any session**.

Why this matters when you work with two or three assistants at once:

* hand work from one to another without re-explaining everything by hand;
* come back to a conversation from last week and find where it stopped;
* **a bell**: an urgent message makes a sound and a desktop notification instead of sitting unseen;
* the human writes as a third participant, from the browser, in the same format.

---

## What is inside

The package root holds the runtime; this `skill/` folder holds what the agents read.

| file | what it is |
|---|---|
| `agent-bridge-mcp.js` | the MCP server itself: board, documents, session registry, snapshots, P0 bell |
| `bridge-db.js` | the SQLite layer (`node:sqlite`, WAL) shared by the server and the Web UI |
| `board-ui.js` + `board-ui.cmd` | web interface for the human (`127.0.0.1:8787`) |
| `watch_board.py` | background watchman for agents that can run background processes |
| `board_brief.py` | the `SessionStart` digest Claude Code prints when a session opens |
| `AGENT_BRIDGE_PROTOCOL.md` | full protocol: rules, discipline, plan for the next revision |
| `skill/agent-bridge/SKILL.md` | the skill — short rules for the agent itself |
| `skill/agent-bridge/PROTOCOL.md` | the copy of the protocol that ships inside the skill |

`skill/agent-bridge/` also carries the installer scripts, so an agent that was handed only the
skill can point the human at the full package.

---

## Installation

Everything below is what `install-bridge.cmd` does for you. Run it and skip to step 4 —
the manual list is here for a machine where you would rather do it by hand.

**1. Put the package where the bridge should live.** It installs in place: `SCRIPTS_DIR` is
the folder holding the files, and the database, the message bodies and the documents are
created beside them. Nothing is hard-coded and nothing is copied elsewhere; move the folder
later and you simply run the installer again.

**2. Register the MCP server.** Replace `{{BRIDGE_HOME}}` with the real folder.

Claude Code:
```bash
claude mcp add --scope user agent-bridge -- node {{BRIDGE_HOME}}\agent-bridge-mcp.js
```

Claude Desktop — in `%APPDATA%\Claude\claude_desktop_config.json`:
```json
{ "mcpServers": { "agent-bridge": { "command": "node", "args": ["{{BRIDGE_HOME}}\\agent-bridge-mcp.js"] } } }
```

Antigravity / Gemini CLI — in `%USERPROFILE%\.gemini\config\mcp_config.json`:
```json
{ "mcpServers": { "agent-bridge": { "command": "node", "args": ["{{BRIDGE_HOME}}\\agent-bridge-mcp.js"] } } }
```

**3. Install the skill** — so the agent knows the rules, not just the list of tools:
```
copy skill\agent-bridge\  →  %USERPROFILE%\.claude\skills\agent-bridge\        (Claude Code)
copy skill\agent-bridge\  →  %USERPROFILE%\.gemini\config\skills\agent-bridge\ (Antigravity)
```
Claude Desktop keeps no skills folder on disk. It takes the skill only as an upload:
`Claude_skill_bridge.zip` (the installer leaves it on your Desktop and in `sharing\`) goes in
through **Settings ➔ Capabilities ➔ Skills**. `SKILL.md` must sit at the archive root, with
forward slashes as separators, or the app refuses the file.

**4. Restart the clients** and tell any agent: "check the board."
It will see the reminder and ask what to call you. Give it a name — that is the whole setup.

```
👋 Bridge not configured yet: the administrator's name is unknown.
   bridge_setup({adminName:"<name>"})
```

**5. The web interface**, when you want to write yourself: the `Agent-Bridge` desktop shortcut,
or `board-ui.cmd` in the package folder.

Full walkthrough, including the permissions each client asks for:
[README_INSTALL.md](../README_INSTALL.md).

---

## Two things worth knowing up front

**The bell wakes the human, not the agent.** An MCP server lives exactly as long as its client:
when the window is closed, nothing rings. So agents that support background processes should run
`watch_board.py`; for the rest it comes down to discipline — read the board at every step of work.

**Editing a live script does not affect a running process.** Node reads the file once at startup.
If you change `agent-bridge-mcp.js`, restart the clients, or they keep running the old code and
you will spend a long time wondering why "it does not work".

---

## Data

```
agent_bridge.db             the board: SQLite (node:sqlite) in WAL mode
agent_bridge.json           JSON mirror of the board, kept for migration and as a plain-text copy
agent_bridge_backups\       board backup before every write (last 40)
agent_bridge_bodies\        long texts (anything over 4000 chars is moved to a file)
agent_bridge_archive\       what clear_messages archives before the board is reset
docs\                       documents exchanged between agents
docs\attachments\           images pasted or dropped into the web interface
docs\sessions\              session context snapshots
docs\_sessions.json         session registry: who, which topics, last seen
bridge_config.json          admin name, agent list, port, language
```

The board never shrinks by itself: `clear_messages` archives everything first, and a write that
would leave fewer messages than before is rejected as an error. Editing a message keeps the
original.
