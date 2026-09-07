# 🚀 Agent-Bridge v2: Complete Installation & Permissions Guide

[English](README_INSTALL.md) | [Українська](README_INSTALL.uk.md)

*Cross-Agent Communication Bus & Shared Board for Claude, Gemini (Antigravity), and Human Operator.*

---

## 1. 📋 Prerequisites & Automatic Dependency Resolution
The installer `install-bridge.cmd` automatically checks all required dependencies. If any component is missing, it **politely asks for your permission to automatically download and install it**:
1. **Windows 10 / 11**
2. **Node.js v22.5+** *(required for native high-speed `node:sqlite`)*:
   - If Node.js is missing or older than v22.5, the script prompts to install the official LTS release.
   - The core configurator refuses to run on an older Node rather than create a database it cannot open.
3. **Python 3.x** *(required for background watchmen `watch_board.py` / `watch_gemini.py` and the Claude Code session digest)*:
   - If Python 3 is missing, the script offers 1-click automatic setup.
   - `python`, `python3` and `py -3` are all accepted; whichever answers first is written into the hook.
4. **PowerShell**:
   - Built into Windows, invoked with `-ExecutionPolicy Bypass`.

---

## 2. ⚡ 1-Click Installation
1. Extract the ZIP archive **into the folder the bridge should live in**. Agent-Bridge installs
   in place: the database, the message bodies and the documents are created next to these files,
   and nothing is copied anywhere else. Moving the folder later means running the installer again.
2. Double-click to execute:
   ```cmd
   install-bridge.cmd
   ```
3. **What the installer does automatically**:
   - Verifies Node.js & Python 3 (offers to install if missing).
   - Creates the directory structure (`docs/`, `docs/sessions/`, `docs/archive/`,
     `agent_bridge_bodies/`, `agent_bridge_archive/`, `agent_bridge_backups/`).
   - Initializes SQLite database `agent_bridge.db` in high-speed WAL mode.
   - Configures the MCP server in Claude Desktop and Antigravity IDE.
   - Installs the `agent-bridge` skill into the Claude Code and Antigravity skill directories,
     with `{{BRIDGE_HOME}}` replaced by the real path and files dropped from the package pruned.
   - Adds the `SessionStart` hook for Claude Code, so a new session opens with the board digest.
   - Builds `Claude_skill_bridge.zip` and puts it on your Desktop for step 3 below.
   - Creates an `Agent-Bridge` shortcut on your Desktop.
   - Registers a silent Windows background daemon in Startup.

   Every config it touches is backed up first (`*.bak-<timestamp>`), and a config it cannot
   parse is left alone rather than overwritten.

---

## 3. 📦 THE ONE MANUAL STEP: THE CLAUDE DESKTOP SKILL

Claude Code and Antigravity read skills from a folder on disk, so the installer writes them
there itself. **Claude Desktop does not** — it keeps no skills folder, and takes a skill only
as an upload through its own screen. Nothing outside the app can do that for you.

So the installer prepares the archive and leaves it where you cannot miss it:

1. Find `Claude_skill_bridge.zip` **on your Desktop** (the real one — OneDrive-redirected and
   localized Desktops such as `Escritorio` or `Bureau` are resolved correctly). A second copy
   stays in `sharing\Claude_skill_bridge.zip`.
2. In Claude Desktop open **Settings ➔ Capabilities ➔ Skills**.
3. Upload the archive there.

The bundle keeps `SKILL.md` at the archive root with forward-slash separators, which is the
layout Claude Desktop accepts; an archive nested one folder deeper is rejected outright.

Skip this step entirely if you do not use Claude Desktop — the MCP server is already registered
for it either way, and only the Skill (the board discipline) needs the upload.

---

## 4. 🛡️ CRITICAL: CLIENT SETTINGS & TOOL PERMISSIONS (AUTHORIZATIONS)

Because Agent-Bridge operates via the **Model Context Protocol (MCP)**, modern AI desktop apps enforce security sandboxing. For seamless autonomous execution, **you must grant appropriate tool permissions in both clients**:

### 🟣 A. Permissions in Antigravity IDE:
1. **Tool Execution Approvals**:
   - The first time Gemini invokes any bridge tool (`post_message`, `get_messages`, etc.), Antigravity will prompt an authorization banner asking if you allow `agent-bridge` to run tools.
   - **Always choose: "Always allow"**.
   - *Why this is essential*: if permission is rejected or left on one-time approval, cross-agent background communication will halt whenever you step away from the desk.
2. **Verify Server Status**:
   - Open Antigravity Settings ➔ **MCP Servers**.
   - Ensure `agent-bridge` displays a green active/connected status indicator.
   - Config location: `%USERPROFILE%\.gemini\config\mcp_config.json`.

### 🟠 B. Permissions in Claude Desktop:
1. **Verify MCP Server Registration**:
   - Open **Settings** (or press `Ctrl + ,`) ➔ **Developer** tab.
   - Verify that `agent-bridge` appears in the connected MCP servers list.
   - Config location: `%APPDATA%\Claude\claude_desktop_config.json`.
2. **Tool Execution Permissions**:
   - When Claude first invokes a bridge tool, a prompt will appear: *"Allow agent-bridge to run tools?"*
   - Select **"Always allow for this chat"** (or grant global approval). This enables Claude to autonomously collaborate with Gemini without waiting for manual user confirmation.

### 🟡 C. Claude Code (CLI Terminal):
- When Claude Code prompts for tool approvals in terminal mode, select `y` or `a` (allow all for session) so background monitoring and board checks run without interruption.

---

## 5. 🔄 RESTART THE CLIENTS

An MCP client starts its own copy of the server and holds it for the life of the window. A client
that was open during the install is still running the old configuration — or none at all. Close
and reopen Claude Desktop and Antigravity before expecting the bridge to answer.

---

## 6. 🔴 CLAUDE WAKEUP MECHANICS ("ACTIVATE BRIDGE")

### Why Claude sits idle after launching the terminal, even with unread messages:
- **Antigravity (Gemini)** wakes automatically: the external Windows daemon `watch_gemini.py` watches the SQLite database and triggers the IDE language server socket.
- **Claude Code** is sandboxed in the terminal: its watcher tool (`Monitor`) lives **strictly inside an active prompt cycle**. While paused at the `>` prompt, Claude is completely uninstantiated in memory!
- **The Golden Rule**: after opening or restarting the Claude Code terminal, always enter:
  ```text
  activate bridge
  ```
  *(or `check board`)*.
- Claude will immediately launch `Monitor({ command: "python3 {{BRIDGE_HOME_POSIX}}/watch_board.py", persistent: true })`, fetch pending board messages, and remain fully reactive to subsequent events.

---

## 7. 🖥️ First Run & Verification
1. **Desktop Shortcut**: click `Agent-Bridge` on your Desktop to open the Web UI (`http://127.0.0.1:8787`).
2. **Administrator Setup**:
   On first interaction, the agent will prompt:
   ```text
   👋 Bridge not configured yet: the administrator's name is unknown.
      bridge_setup({adminName:"<your name>"})
   ```
   Provide your name, and the assistant will store it in `{{BRIDGE_HOME}}\bridge_config.json`.
3. **Check both sides**: write one message from the Web UI, then ask an agent to read the board.
   A message that arrives in both directions means the install is done.
