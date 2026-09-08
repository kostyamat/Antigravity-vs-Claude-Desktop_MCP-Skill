# -*- coding: utf-8 -*-
"""
Board brief — printed at session start so the agent does not depend on its own memory.

WHY THIS EXISTS. A Claude Code watchman (`Monitor`) is session-scoped by nature: it lives
exactly as long as the session and must be started again after every restart. Twice in a row
that did not happen, and twice the human wrote to the board into the void, then had to ask
"can you hear me?".

The problem was never that the watchman dies — that is normal. The problem was that starting
it depended on the agent remembering. This script removes that dependency: it is invoked by
the `SessionStart` hook, i.e. before the agent does anything, and it puts the state of the
board into the session context. It cannot be missed.

Prints only: how much is unread, whether a P0 is pending, the last few messages — and the one
line needed to start the watchman. Changes nothing, moves no read cursors.

Install (once per machine), in .claude/settings.json:

    "hooks": {
      "SessionStart": [
        { "hooks": [ { "type": "command", "command": "python {{BRIDGE_HOME_POSIX}}/board_brief.py" } ] }
      ]
    }
"""
import json
import os
import sqlite3
import sys
import threading

# The database sits next to this script, so the kit works from any folder on any machine.
def _bridge_home():
    """Directory holding the board database.

    Defaults to the directory of this script, which is correct for the copy
    that lives in the bridge home. The copies distributed into agent skill
    folders sit elsewhere, so AGENT_BRIDGE_HOME overrides the guess.
    """
    env = os.environ.get("AGENT_BRIDGE_HOME")
    if env and os.path.isdir(env):
        return env
    return os.path.dirname(os.path.abspath(__file__))


DB = os.path.join(_bridge_home(), "agent_bridge.db")
ME = os.environ.get("BRIDGE_AGENT", "Claude")
SHOW_LAST = 3


def _client_session_id():
    """The session id the client hands its hooks on stdin, or "".

    Identity guessed from the working directory is wrong exactly when it matters
    most — a session that has not yet written to the board is not in the
    registry, which is the state every session starts in. The client knows the
    answer and passes it here; taking it costs nothing and ends the guessing.

    The read is bounded by a thread that is abandoned if it does not return: a
    hook that blocks would hold up the start of the session it is briefing, and
    a convenience must never be able to do that.
    """
    if sys.stdin is None or sys.stdin.closed:
        return ""
    box = {}

    def _read():
        try:
            box["raw"] = sys.stdin.read()
        except Exception:
            pass

    try:
        t = threading.Thread(target=_read)
        t.daemon = True
        t.start()
        t.join(1.5)
        payload = json.loads(box.get("raw") or "{}")
        value = payload.get("session_id") or payload.get("sessionId") or ""
        return str(value).strip()
    except Exception:
        return ""


def main():
    if not os.path.exists(DB):
        return 0                       # no bridge on this machine — stay silent

    try:
        con = sqlite3.connect("file:%s?mode=ro" % DB.replace("\\", "/"), uri=True, timeout=3.0)
        cur = con.cursor()
    except Exception:
        return 0                       # a brief is a convenience; it must never break startup

    # The read cursor lives in `cursors(reader, last_read_id)`. Column names are read from the
    # schema rather than assumed: guessing them once already produced a brief claiming
    # "74 unread" on a board where two were.
    cursor = 0
    try:
        cols = [r[1] for r in cur.execute("PRAGMA table_info(cursors)")]
        who_col = "reader" if "reader" in cols else ("agent" if "agent" in cols else None)
        id_col = "last_read_id" if "last_read_id" in cols else ("value" if "value" in cols else None)
        if who_col and id_col:
            cur.execute("select %s from cursors where %s = ?" % (id_col, who_col), (ME,))
            row = cur.fetchone()
            if row and str(row[0]).isdigit():
                cursor = int(row[0])
    except Exception:
        pass                           # a wrong cursor only makes the brief noisier, never fatal

    try:
        cur.execute("""select count(*),
                              coalesce(sum(case when priority = 'P0' then 1 else 0 end), 0)
                       from messages where id > ? and from_agent <> ?""", (cursor, ME))
        unread, p0 = cur.fetchone()
        cur.execute("""select id, from_agent, coalesce(topic, ''),
                              substr(replace(coalesce(message, ''), char(10), ' '), 1, 80)
                       from messages order by id desc limit ?""", (SHOW_LAST,))
        last = cur.fetchall()

        # Session detection for watchman recommendation (safe non-blocking).
        # The registry is asked first: if the board already knows a session for
        # this working directory, that is the label the agent will keep using,
        # and the watchman must filter on the same one. Only when the board
        # knows nothing does the client's own session id become the answer —
        # and then the brief says to use it on both sides.
        hook_session = ""
        try:
            cwd_base = os.path.basename(os.getcwd()).strip().lower()
            if cwd_base:
                cur.execute("""
                    SELECT session_id, project FROM sessions
                    WHERE lower(agent) = lower(?)
                    ORDER BY last_seen DESC
                """, (ME,))
                for sid, proj in cur.fetchall():
                    if proj and cwd_base in proj.strip().lower():
                        hook_session = sid.strip()
                        break
                    if cwd_base in sid.lower():
                        hook_session = sid.strip()
                        break
        except Exception:
            pass

        from_client = False
        if not hook_session:
            hook_session = (os.environ.get("CLAUDE_SESSION_ID")
                            or os.environ.get("BRIDGE_SESSION")
                            or _client_session_id())
            from_client = bool(hook_session)

        con.close()
    except Exception:
        return 0

    lines = ["agent-bridge board:"]
    if unread:
        lines.append("  unread for %s: %d%s"
                     % (ME, unread, ("   P0 PENDING: %d" % p0) if p0 else ""))
    else:
        lines.append("  nothing new")
    for i, who, topic, head in reversed(last):
        lines.append("  #%-4s %-9s %-20s %s" % (i, who, topic[:20], head[:66]))

    watch = "%s/watch_board.py" % os.path.dirname(DB).replace("\\", "/")
    # The interpreter is named outright rather than left as "python3". On Windows
    # that name resolves to the Microsoft Store stub, which launches the real
    # interpreter as a child of itself: two processes per watchman, and the one
    # holding the board open is not the one the harness can stop. sys.executable
    # is whatever python is running this hook, which is the one the installer found.
    py = sys.executable.replace("\\", "/") if sys.executable else "python"
    if " " in py:
        py = '\\"%s\\"' % py               # the command is quoted inside the Monitor call
    # Filtering by session is what keeps one session's orders apart from a
    # neighbour's. Without the identifier the watchman has to guess it from the
    # working directory and the registry, and a session that has not written to
    # the board yet is not in the registry — which is every session at startup.
    if hook_session:
        cmd_str = "%s %s --session %s --agent %s" % (py, watch, hook_session, ME)
        session_note = []
        if from_client:
            # The board has no session for this directory yet, so this id comes
            # from the client rather than from the board. The two only agree if
            # the agent then signs its messages with the same one.
            session_note = [
                "Use %s as your sessionId in every bridge call too — get_messages, post_message," % hook_session,
                "all of them. The watchman filters on the identifier you pass it, so if you sign",
                "the board with a different name, it will discard the messages addressed to you.",
                "",
            ]
    else:
        cmd_str = "%s %s --session <YOUR SESSION ID> --agent %s" % (py, watch, ME)
        session_note = [
            "Replace <YOUR SESSION ID> with the identifier you use on the board, the same one",
            "you pass to get_messages and post_message. Do not drop the argument: without it the",
            "watchman cannot tell an order addressed to you from one addressed to the session",
            "next door, and it errs in both directions at once.",
            "",
        ]
    lines += [
        "",
        "MANDATORY FIRST ACTION, before anything else in this session:",
        '  Monitor({command: "%s", persistent: true})' % cmd_str,
        "",
    ] + session_note + [
        "This is not a suggestion. The watchman is session-scoped: it died with the previous",
        "session and does not exist right now. Without it, messages from the human and from the",
        "other agent arrive nowhere — they write, nothing answers, and they have to ask whether",
        "anyone is listening. That has already happened three times in one day.",
    ]
    if unread:
        lines.append('Then: get_messages({reader:"%s"}) — the CONTENT, not the counters.' % ME)

    text = "\n".join(lines)

    # 🔴 Return structured JSON output instead of just printing plain text.
    # `additionalContext` enters session context as an instruction, whereas standard stdout
    # is merely command output that is easily ignored. This difference is not cosmetic: because
    # it was "just plain text", it was previously read and ignored three times.
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": text,
        }
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
