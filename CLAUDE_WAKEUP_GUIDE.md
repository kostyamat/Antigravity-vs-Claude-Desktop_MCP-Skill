# 🔔 Guide: Claude Wakeup Mechanics (Agent-Bridge)

---

### How Claude Code Is Woken (Hooks & Plugin Architecture)

In current versions of Agent Bridge (v2.7+), Claude Code sessions running in known windows wake automatically via Claude Code plugin hooks (`claude-plugin.js` and `bridge-hook.js`), without requiring manual `Monitor` commands.

1. **Background Watcher Hook (`bridge-hook.js watch`)**:
   - Registered under both `SessionStart` and `Stop` events as an async hook (`claude-plugin.js` lines 37, 51-52):
     `{ type: 'command', command: node('watch'), async: true, asyncRewake: true, timeout: 86700 }`
   - Runs in the background and polls SQLite via `mailbox.urgentFor()` every 3 seconds (`bridge-hook.js` lines 34, 191).
   - When urgent mail arrives for the window or its project line, it prints the notification to stderr and exits with **code 2** (`bridge-hook.js` lines 194-198).
   - With `asyncRewake: true`, Claude Code automatically awakens from idle and feeds the stderr prompt into the active session.

2. **Idle Guard Hook (`bridge-hook.js stop`)**:
   - Runs synchronously on `Stop` events (`claude-plugin.js` line 50).
   - If unread urgent mail addressed to this window is still waiting, it blocks Claude from going idle (`decision: 'block'`, `bridge-hook.js` line 152), directing the agent to read and answer immediately.

3. **Prompt Reminder Hook (`bridge-hook.js prompt`)**:
   - Injected on `UserPromptSubmit` (`claude-plugin.js` line 49).
   - Surfaces unread mail and handover lines from previous sessions (`bridge-hook.js` lines 116-144).

4. **When is `Monitor` needed?**:
   - For windows known to the client (`local_...`), the session-start brief (`board_brief.py` lines 682-683) explicitly instructs:
     *"A hook watches the board for this window: it wakes you when mail for it or its project arrives, and checks again before you go idle. Do not start a watchman (Monitor) for the board."*
   - Only for anonymous terminal sessions without an identified window record does `board_brief.py` (lines 686-687) print a fallback `Monitor({command: "...", timeout_ms: 1800000})` command.
