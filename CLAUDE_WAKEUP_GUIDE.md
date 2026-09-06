# 🔔 Guide: Claude Wakeup Mechanics (Agent-Bridge)

---

### Claude Code CLI Wakeup & Reactive Background Monitoring

1. **Issue**: Claude Code in terminal does not respond to board messages after startup or restart.
2. **Root Cause**: Claude's watcher (`Monitor`) exists ONLY within an active session prompt cycle. While paused at the `>` prompt, Claude is completely uninstantiated in memory.
3. **Solution**: Type into the terminal:
   👉 **`activate bridge`** (or `check board`)
4. **Result**: Claude starts `Monitor({ command: "python3 C:/scripts/watch_board.py", persistent: true })` and becomes 100% reactive to all incoming board events.
