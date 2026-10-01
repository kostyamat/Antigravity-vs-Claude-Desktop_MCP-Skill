"""SessionStart hook for the "compact" matcher: the context guard.

Claude Code compacts a session when its window fills up, and the session wakes
with its working memory gone. This hook hands back the only state that matters:
the project's slice (.agents/HANDOFF.md), the last commits and the uncommitted
files, plus what to do next. Whatever it prints enters the session's context.

Works in any project: the root is the nearest folder above the working directory
that holds .agents/HANDOFF.md or .git. It never raises — a broken hook must not
break a session start.
"""
import io
import json
import os
import subprocess
import sys

MAX_SLICE = 6000  # the standard caps a slice at 4 KB; this is only the safety net


def find_root(start):
    path = os.path.abspath(start)
    while True:
        if os.path.isfile(os.path.join(path, ".agents", "HANDOFF.md")) or os.path.isdir(os.path.join(path, ".git")):
            return path
        parent = os.path.dirname(path)
        if parent == path:
            return os.path.abspath(start)
        path = parent


def read_slice(root):
    try:
        text = io.open(os.path.join(root, ".agents", "HANDOFF.md"), encoding="utf-8").read().strip()
    except OSError:
        return None
    if len(text) <= MAX_SLICE:
        return text
    return text[:MAX_SLICE] + "\n… (the slice is longer than the standard allows — cut it to 4 KB)"


def git(root, *args):
    try:
        out = subprocess.run(["git", "-C", root] + list(args), capture_output=True, timeout=20)
        return out.stdout.decode("utf-8", "replace").strip()
    except Exception as e:  # never fail the session start
        return "(git %s: %s)" % (" ".join(args), e)


def main():
    root = find_root(os.getcwd())
    slice_text = read_slice(root)
    lines = [
        "THE CONTEXT WAS JUST COMPACTED. What to do:",
        "1) If the session-start hook printed a watchman line for the board, run it again: the watchman died.",
        "2) Read the slice below — it is the current state. Details: .agents/TODO.md, .agents/DEBT.md, .agents/INDEX.md.",
        "3) Carry on from where you stopped. Do not ask the user what is already decided in the slice.",
        "4) After every verified step: a commit, and the slice rewritten (never appended to).",
        "",
        "=== Project: %s ===" % root,
    ]
    if slice_text:
        lines += ["", "=== .agents/HANDOFF.md ===", slice_text]
    else:
        lines += ["", "(no .agents/HANDOFF.md — take the state from git log, and set the slice up by the agent-workflow skill)"]
    lines += [
        "",
        "=== git log -6 ===",
        git(root, "log", "--oneline", "-6"),
        "",
        "=== git status --short ===",
        git(root, "status", "--short") or "(clean)",
    ]
    out = json.dumps(
        {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "\n".join(lines)}},
        ensure_ascii=False,
    )
    sys.stdout.buffer.write(out.encode("utf-8"))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
