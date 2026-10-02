"""PreCompact hook: the context guard's first half.

A compaction keeps only the slice (.agents/HANDOFF.md) and whatever git holds. When it fires while the
slice lags behind the work - commits made after the slice was last committed, or files left uncommitted -
the session wakes from the compaction trusting a slice that no longer describes the tree.

This hook does not block: an auto-compaction fires because the window is full, and refusing it would
stall the session. It checks the slice, warns the owner, and leaves a note that after_compact.py reads
back into the woken session, so the gap is named instead of discovered later.

Reads the hook input from stdin (session_id, cwd, trigger). It never raises.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from after_compact import find_root, git  # one root finder, one git runner

NOTE_DIR = os.path.join(tempfile.gettempdir(), "claude-precompact")
SLICE = ".agents/HANDOFF.md"


def note_path(session_id):
    safe = "".join(c for c in (session_id or "unknown") if c.isalnum() or c in "-_")
    return os.path.join(NOTE_DIR, safe + ".json")


def check(root):
    """What the slice is missing, as owner-readable lines; empty when it is current."""
    if not os.path.isfile(os.path.join(root, SLICE)):
        return []  # a project without the slice standard: nothing to guard
    problems = []
    last_slice = git(root, "log", "-1", "--format=%H", "--", SLICE)
    if last_slice and not last_slice.startswith("("):
        after = git(root, "log", "--oneline", last_slice + "..HEAD")
        if after:
            n = len(after.splitlines())
            problems.append("commits after the slice was last committed (%d):\n%s" % (n, after))
    dirty = git(root, "status", "--short")
    if dirty and not dirty.startswith("("):
        problems.append("uncommitted files (%d):\n%s" % (len(dirty.splitlines()), dirty))
    return problems


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace") or "{}")
    except ValueError:
        data = {}
    root = find_root(data.get("cwd") or os.getcwd())
    problems = check(root)
    path = note_path(data.get("session_id"))
    if not problems:
        try:
            os.remove(path)  # a stale note from an earlier compaction must not speak for this one
        except OSError:
            pass
        return
    os.makedirs(NOTE_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"root": root, "trigger": data.get("trigger"), "ts": int(time.time()),
                   "problems": problems}, f, ensure_ascii=False)
    msg = "⚠️ Compacting with a stale slice (%s): %s. The session will be told after the compaction." % (
        root, "; ".join(p.splitlines()[0].rstrip(":") for p in problems))
    sys.stdout.buffer.write(json.dumps({"systemMessage": msg}, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
