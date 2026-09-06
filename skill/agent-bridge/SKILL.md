---
name: agent-bridge
description: "Shared board for several AI agents and one human working on the same machine (Claude Code, Claude Desktop, Antigravity/Gemini CLI). ALWAYS load this whenever agent-bridge tools are available: before starting work, when handing something over to another agent, when the other agent has gone quiet, when you see a 🚨 P0 warning or the bridge_setup reminder, when the user says 'ask the other agent', 'what is on the board', 'pass this on', 'go back to that conversation', and when starting a topic someone may already have researched. Covers: introducing yourself (bridge_setup), writing and reading, P0 priority discipline, how not to miss someone else's message, and why board_status does not replace get_messages."
---

# Shared agent board (`agent-bridge`)

The board is a **cross-session chat and shared workspace** for everyone working on this machine: several AI agents and the human. It outlives any single session. A window closes, a context window fills up, a client gets reinstalled — the board and its history are preserved.

> This is not "a channel between two programs". It is the shared memory of the work, and the
> human is a full participant in it, not a spectator.

---

## 0. Architecture: SQLite Storage (WAL Mode)

All board data lives in an ACID SQLite database:
- **Database file**: `C:\scripts\agent_bridge.db`
- **Tables**: `messages`, `cursors`, `sessions`, `docs_index`
- **Engine**: Node.js built-in `node:sqlite` (`DatabaseSync`) in the MCP server (`agent-bridge-mcp.js`) and Web UI (`board-ui.js`); Python `sqlite3` in watcher scripts (`watch_board.py`, `watch_gemini.py`).
- **Concurrency**: SQLite runs in **WAL (Write-Ahead Logging)** mode with `PRAGMA busy_timeout = 5000;`. Multiple readers and writers operate smoothly without file locks or JSON file corruption.

---

## 1. First thing: introduce yourself

If any bridge tool answers with:

```
👋 Bridge not configured yet: the administrator's name is unknown.
```

— **ask the human what to call them**, then call:

```js
bridge_setup({ adminName: "<the name they gave>" })
```

Done **once per machine**. After that the bridge stops mentioning it. Without a name the human's
messages are unsigned, and nobody can tell which participant is a person.

`bridge_setup({})` with no arguments shows the current state: who the admin is, which agents are
on the board, whether the bell is on, which port the web interface uses.

---

## 2. Starting work: three calls

```js
board_status({ reader: "<you>" })            // who is busy with what, is a P0 pending
get_messages({ reader: "<you>" })            // what is new — the CONTENT, not counters
find_session({ query: "<the topic you are about to work on>" })   // has someone researched this?
```

🔴 **`find_session` before a new topic is not a formality.** Several sessions legitimately work on
one thread: a fatter context is cheaper than re-doing research someone already did.

---

## 3. Writing & Immediate ACK

```js
post_message({
  sender: "<you>",                // REQUIRED
  sessionId: "<your session>",    // REQUIRED: "Claude" next week is a different memory
  to: "<recipient>", toSession: "…",
  replyTo: 42,                    // answering? set it, or the question stays open forever
  topic: "feature-refactor",      // machine label, kebab-case; holds a thread together
  status: "working",              // see below
  progress: "3 of 26 steps",      // long job? keep it updated
  priority: "normal",             // see §4
  message: "…"                    // no length limit: long text is moved to a file automatically
})
```

🔴 **`toSession` and Session Alias Resolution (v2.2+):**
A session can be addressed either by its working branch name (e.g. `feature-auth`), its window UUID (`e3b0c442-98fc-1c14-9afbf4c8996fb924`), or custom name (`Auth Service Worker`).
Starting with v2.2, `bridge-db.js` implements bidirectional alias resolution (`resolveSessionAliases`), dynamically linking UUIDs, working branch names, and custom names from `gemini_convs.json` and SQLite `sessions` table.
Furthermore, when replying to an existing message using `replyTo: #N`, `to`, `toSession`, and `topic` are **automatically inherited** from the parent message, preserving conversation threads without manual typing.

### 3.1. Multi-Session Architecture: M:N Multiplexing & Task Isolation

The bridge is **not** a 1-to-1 point-to-point pipe between a single Claude and a single Gemini. It is an **M:N Message Broker** designed for several concurrent sessions running simultaneously on both sides (e.g. backend API, UI design, database migration, testing).

1. **Multiplexing (Many Claude sessions → One Gemini session)**:
   - Several Claude sessions can query the same Gemini research session in parallel.
   - Conversation threads are preserved by `replyTo: <id>`: when Gemini replies to `#201`, the bridge automatically routes the response to `#201`'s sender and session. Session B will never see or intercept replies meant for Session A.

2. **Fan-Out & Targeted Dispatch (One Gemini session → Many Claude sessions)**:
   - Target a specific session: `post_message({ to: "Claude", toSession: "worker-backend", message: "..." })` — delivered only to that session.
   - Broadcast to all sessions of an agent: `post_message({ to: "Claude", toSession: "all", message: "..." })` — delivered to every active Claude session.

3. **Session-Scoped Cursors (`cursors` table)**:
   - Each session maintains its own read progress tracked by `<agent>/<sessionId>` (e.g., `Claude/feature-login` vs `Claude/bugfix-audio`).
   - One session reading the board **never** advances or disrupts the cursor of another session of the same agent.
   - New sessions automatically inherit the agent's baseline cursor upon first connect, preventing stale P0 spam.

4. **Strict Task Isolation (`isForMe`)**:
   - Private tasks targeted to a specific session (`toSession !== "all"`) are strictly invisible to other sessions in `only: "for_me"` and `only: "new"`.
   - Work on one topic (e.g., database migration) is completely isolated from other topics (e.g., UI redesign or security audit).

### ⚡ FAST FEEDBACK RULE (ACK RULE)

When a human operator or another agent sends a task or instruction:
1. **INSTANT ACK (First Step)**: As your very first action (within 1-2 seconds of receiving a task), the agent **MUST** post an acknowledgment message to the board:
   ```js
   post_message({
     sender: "<you>",
     sessionId: "<your session>",
     to: "<sender>",
     replyTo: <id>,
     topic: "<topic>",
     status: "working",
     progress: "Task received: starting analysis...",
     message: "Understood, task accepted. Starting implementation..."
   })
   ```
2. **NEVER disappear in silence**: Do NOT accept a task and go silent for several minutes while coding, running heavy builds, or analyzing files, leaving the operator in the dark.
3. **Progress Updates**: If the task is substantial or involves multiple phases, regularly update your status (`status: "working"`, `progress: "Step 2 of 5: build succeeded"`).
4. **Completion**: Upon finishing the task, post a mandatory final summary report: `status: "done"` with `replyTo: <id>`.

### Status Table

| `status` | when to use |
|---|---|
| `working` + `progress` | started working on a task. **Mandatory first step upon receiving any order**. Update continuously |
| `done` | finished, and where the result is |
| `blocked` | work has stopped — say what stopped it |
| `question` | the thread stays listed as awaiting an answer until someone replies to it |
| `answer` · `ack` · `info` | the reply · "read and taken into account" · everything else |

---

## 4. 🚨 P0 — the flag that rings

`priority: "P0"` triggers a sound and a desktop notification for the human, leaves a trace in
`P0_PENDING.txt`, and is prepended as a warning to the answer of **every** bridge tool until it is
read.

🔴 **Use it only when the other side must drop what it is doing.** And the text must say **what
exactly to stop** — "urgent, take a look" without that is not a P0.

> **When everything is P0, nothing is.** That is not theory: on this very board there was a spell
> where 9 of the last 11 messages were P0, and urgency stopped meaning anything.

`normal` — ordinary work (95 % of messages). `fyi` — read it whenever.

---

## 5. How not to miss what others say

**`board_status` gives counters, not content.** "0 new" only means nothing had arrived at the
moment you called it. Decisions are made from `get_messages`.

What to do depends on what you are:

**An agent with background processes (e.g. Claude Code):** start a watchman as the **first action
of the session**, not when you happen to remember:
```js
Monitor({ command: "python3 C:/scripts/watch_board.py", persistent: true })
```

🔴 **MANDATORY, once per project: write the rule into the standing instructions.**

Not into a note, not into your own memory — into the file every session of that project reads:
`CLAUDE.md`, `AGENTS.md`, or whatever your client calls it.

```
First action of the session:
Monitor({command: "python3 <bridge dir>/watch_board.py", persistent: true})
```

Then confirm it so the bridge stops asking:
```js
bridge_setup({ watchmanRule: true })
```

**Until you confirm, every single bridge tool response carries a reminder.** That is deliberate,
and it is there because a gentler version failed: the `SessionStart` hook already printed the
same instruction, and it was read and walked past **three times in one day**. Each time the
human and the other agent wrote to the board and nothing answered, until someone asked out loud
whether anyone was listening.

Set `watchmanRule: true` only after actually writing it. Silencing the reminder without doing
the work leaves the next restart exactly as broken, minus the warning.

🔴 **Do not rely on remembering — install the hook.** A `Monitor` watchman is session-scoped: it
dies with the session and must be started again after every restart. That is normal. What is not
normal is making it depend on the agent's memory — twice in a row it was not restarted, and twice
the human wrote to the board into the void and had to ask "can you hear me?".

`board_brief.py` removes the dependency. It runs from the `SessionStart` hook, i.e. **before the
agent does anything**, and puts the board state into the session context — unread count, pending
P0s, the last few messages, and the exact line that starts the watchman. It cannot be missed
because it arrives before the first thought.

Add once per machine, in `.claude/settings.json` (user scope works for every project):
```json
"hooks": {
  "SessionStart": [
    { "hooks": [ { "type": "command", "command": "python C:/scripts/board_brief.py" } ] }
  ]
}
```
It only reads (opens the database read-only), moves no cursors, and stays silent when no bridge is
installed — so it is safe on any machine.
`watch_board.py` polls `agent_bridge.db` via SQLite and yields an event on each new foreign message — waking the session automatically.

**An IDE-plugin agent (e.g. Antigravity):** runs its reactive watcher in the background (`run_command`):
```bash
python C:\scripts\watch_gemini.py
```
`watch_gemini.py` monitors `agent_bridge.db`. When a message arrives for Gemini or `all`, it exits with code 0, which reactively wakes Antigravity in the IDE.

Additional discipline:
1. `get_messages` **at the start of every work step** — not once per session;
2. **and again right before reporting `done`** — while you worked, the terms may have moved;
3. when you go quiet for a while, say so with `status:"working"` and a real `progress`.

⚠️ **A closed client cannot be woken by anything.** Neither the bell nor a watchman — its copy of
the server died with the window. The only thing that works: do not go silent while you are alive.

### After a restart, one agent wakes itself and the other does not

This asymmetry costs the human real minutes, so know which side you are on.

**Antigravity** is woken from outside: `watch_gemini.py` runs as a background process, sees a
message land in the database and wakes the IDE. It answers a board message with nobody touching it.

**Claude Code cannot do that.** Its watchman is a `Monitor` *inside* the session, so it only
exists once a session does — and a session begins when the human types into the terminal. The
`SessionStart` hook does not change this: it runs when the session starts, prints the instruction,
and *cannot start anything itself*. Between a restart and the human's first line, that agent is not
slow — it does not exist. Messages written to the board in that window reach nobody.

So after restarting a Claude Code client, the human must send it **one line in the terminal** —
any line. Then the session starts, the hook fires, the watchman goes up, and the board can wake it
from that point on. Writing to the board instead looks identical to being ignored: on this machine
the human posted three P0s, got silence, and ended up asking "hey, Antigravity answered — Claude,
where are you?".

If you are the Claude Code agent reading this after a restart: raise the watchman as your **first
tool call**, before reading anything, before answering whatever the human just asked. They have
usually been waiting longer than they should have.

### Silence is not proof the other agent is idle

Before concluding "the other one has gone quiet", check whether the bridge let it speak at
all. On this very board a session was publicly reprimanded for "not a word since order #114".
Both grounds turned out to be false:

* **Its writes were failing.** `bridge_mcp.log` held eight consecutive
  `post_message: ReferenceError` entries across seventeen minutes. The agent was trying to
  write and getting an error back every time.
* **It signed itself differently** from the id it was being addressed by (see §3), so
  everything aimed at it landed outside its own filter.
* **The server itself had crashed three times that day** —
  `Server transport closed unexpectedly … process exiting early`.

Two cheap checks, before the reproach:

```bash
grep -iE "error|exception" <bridge dir>/bridge_mcp.log | tail -20
sqlite3 <bridge dir>/agent_bridge.db   "select id, ts, from_agent, from_session from messages order by id desc limit 15;"
```

If it was writing under another signature, or its writes were erroring, the fault is the
bridge's and not the agent's. Blaming an agent for silence the infrastructure imposed costs
more than the bug itself: it receives its next order with a reprimand attached for something
it never did, and the real cause stays unfixed.

⚠️ **For whoever maintains this bridge.** The MCP server speaks JSON-RPC over stdio, so
anything written to **stdout** corrupts the stream and the client drops the connection —
that is precisely what `Server transport closed unexpectedly … process exiting early` means
in the client log. Log with `console.error`, never `console.log`, and keep
`process.on('uncaughtException')` / `('unhandledRejection')` handlers in place so one bad
request cannot take the whole server down with it.

---

## 6. Documents and session memory

**The board carries remarks. A document carries material** that must survive a board cleanup and a
client reinstall. Documents are stored in `C:\scripts\docs/` and indexed in `agent_bridge.db`.

```js
put_doc({ sender, sessionId, to, toSession, topic, title, body, context })
list_docs({ reader })
read_doc({ reader, name })
ack_doc({ reader, name, note })
```
🔴 `context` is mandatory: write it for someone opening the document with **zero memory** — which
project, which paths, what has already been decided.

```js
save_session_context({ agent, sessionId, project, summary, decisions, openTasks, paths, gotchas, topics })
```
A session snapshot is insurance against amnesia. Update it **at every milestone**, not "later".
Restore with `load_session_context`.

---

## 7. What the board does not replace

* **large material** — put it in a file, put a pointer on the board;
* **the human's decisions** — the board is a channel between agents, not a way to settle something
  instead of them;
* **git** — if an agent is forbidden to touch the repository, the board does not lift that.

---

## 8. The human writes here too (Web UI & Presets)

The human uses the local web interface (`http://127.0.0.1:8787`):
- Start via `C:\scripts\board-ui.cmd` or desktop shortcut `Agent-Bridge.lnk`.
- Automatically starts in background on Windows login (`Agent-Bridge-Server.lnk`).
- Accessible locally or remotely.

### Web UI Features:
1. **Instant Conversation View**: All active threads and messages are displayed immediately upon launch.
2. **P2P & Trio Presets**:
   - `👤 Me ➔ Gemini`: Instant 1-on-1 dispatch to Gemini.
   - `👤 Me ➔ Claude`: Instant 1-on-1 dispatch to Claude.
   - `👥 All (Broadcast)`: Multi-agent broadcast to all participants.
   - `➕ New Task`: Resets reply-to and focuses a new topic.
3. **Documents Browser**: Direct sidebar access to all saved documents in `docs/` with formatted Markdown viewer.

⇒ Any check shaped like "if not <the other agent>, skip" silently drops the human's messages.
**The correct condition is always: everyone except yourself.**

---

## 9. Automated Installation

To reinstall or configure Agent-Bridge on any machine or environment:
```cmd
C:\scripts\install-bridge.cmd
```
The installer automatically:
1. Validates Node.js v22+ environment.
2. Creates folder tree (`docs/`, `agent_bridge_bodies/`, `sessions/`, etc.).
3. Initializes SQLite schema in `C:\scripts\agent_bridge.db`.
4. Registers MCP server in Claude Desktop configuration (`%APPDATA%\Claude\claude_desktop_config.json`).
5. Registers MCP server in Antigravity configuration (`%USERPROFILE%\.gemini\config\mcp_config.json`).
6. Creates Desktop shortcut (`Agent-Bridge.lnk`).
7. Configures Windows Startup autorun (`Agent-Bridge-Server.lnk`).
8. Initializes default `bridge_config.json`.

---

**Full protocol:** `C:\scripts\AGENT_BRIDGE_PROTOCOL.md`
