# -*- coding: utf-8 -*-
"""
🔔 BOARD WATCHMAN (SQLite) — continuous board monitoring for agent autonomy.

Polls the SQLite database (agent_bridge.db) for new messages and asks mailbox.js
which of them are worth waking this window for. Each stdout line = one alert.
"""
import argparse
import ctypes
import json
import os
import sqlite3
import subprocess
import sys
import time

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


DB_PATH = os.path.join(_bridge_home(), "agent_bridge.db")
POLL_SEC = 10
# While the session is unknown the watchman keeps looking for it. Identity used
# to be decided once, at startup — the exact moment a new session is least
# likely to be in the registry, because the registry is filled from board
# traffic and a session that has not written yet is not in it.
IDENTITY_RETRY_SEC = 60
# Silence and deafness look identical: the watchman prints only when a message
# arrives. So it reports on itself — but only while something is wrong.
HEARTBEAT_SEC = 900


def get_max_id():
    con = sqlite3.connect(DB_PATH, timeout=5.0)
    try:
        cur = con.cursor()
        cur.execute("SELECT COALESCE(MAX(id), 0) FROM messages")
        return cur.fetchone()[0]
    finally:
        con.close()


def get_messages_since(last_id):
    con = sqlite3.connect(DB_PATH, timeout=5.0)
    try:
        cur = con.cursor()
        cur.execute("""
            SELECT id, from_agent, from_session, to_agent, to_session, priority, status, topic, message,
                   COALESCE(room, '')
            FROM messages
            WHERE id > ?
            ORDER BY id ASC
        """, (last_id,))
        return cur.fetchall()
    finally:
        con.close()


def detect_session(agent):
    """Best guess at which registered session this process belongs to.

    A guess is all it can be: the board knows a session by the label the agent
    chose for itself, and nothing ties that label to anything this process can
    read. Pass --session and none of this runs.
    """
    try:
        cwd_base = os.path.basename(os.getcwd()).strip().lower()
        if not cwd_base:
            return ""
        con = sqlite3.connect(DB_PATH, timeout=3.0)
        try:
            cur = con.cursor()
            cur.execute("""
                SELECT session_id, project FROM sessions
                WHERE lower(agent) = lower(?)
                ORDER BY last_seen DESC
            """, (agent.strip(),))
            rows = cur.fetchall()
        finally:
            con.close()
        for sid, proj in rows:
            if proj and proj.strip().lower() == cwd_base:
                return sid.strip()
            if cwd_base in sid.lower():
                return sid.strip()
    except Exception:
        pass
    return ""


def urgent_since(agent, window, after):
    """What arrived after `after` that is worth waking this window for.

    The rule is mailbox.js — the same one the Stop hook and the background watcher
    use. This file used to keep a copy of it, and the copy drifted: it woke a Claude
    window for mail the owner sent to Gemini, and for every "done" posted to a room.
    Raises when the rule cannot be asked, so the caller keeps its place on the board
    and asks again.
    """
    out = subprocess.run(["node", os.path.join(_bridge_home(), "mailbox.js"), "urgent", agent, window, str(after)],
                         capture_output=True, timeout=30)
    data = json.loads(out.stdout.decode("utf-8", "replace") or "{}")
    if "list" not in data:
        raise RuntimeError(data.get("error") or "mailbox.js gave no list")
    return data["list"]


def parent_alive(pid):
    """True while the process that started this watchman is still running.

    A Monitor watchman is session-scoped, but the interpreter behind it is not:
    when the session ends the shell that launched it is killed, and python goes
    on polling the board forever. Seven such orphans were found on one machine,
    the oldest from a session a day dead — each holding the database file open,
    each indistinguishable in the process list from the one that is real.

    Nothing here kills anything. The watchman simply stops when the process it
    was started for is gone.
    """
    if pid <= 0:
        return False
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    SYNCHRONIZE = 0x00100000
    WAIT_OBJECT_0 = 0
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
    if not handle:
        return False                      # no such process: the parent is gone
    try:
        # A process handle becomes signalled when the process exits.
        return kernel32.WaitForSingleObject(handle, 0) != WAIT_OBJECT_0
    finally:
        kernel32.CloseHandle(handle)


def _announce(window):
    """Leave a note that a watchman listens for this window.

    The Stop hook starts a background watcher of its own (bridge-hook.js watch) for
    sessions that never started this one. Two listeners would wake the session twice
    for every message, so that watcher looks for this note and stands down.
    """
    if not window:
        return
    try:
        run = os.path.join(_bridge_home(), "run")
        os.makedirs(run, exist_ok=True)
        safe = "".join(c if (c.isalnum() or c in "_-") else "_" for c in window)
        with open(os.path.join(run, "monitor_%s.json" % safe), "w", encoding="utf-8") as fh:
            json.dump({"pid": os.getpid()}, fh)
    except Exception:
        pass                           # a note, never a reason to fail


def main():
    parser = argparse.ArgumentParser(description="Watch agent-bridge board")
    parser.add_argument("--session", default=os.environ.get("BRIDGE_SESSION", ""), help="Current session identifier")
    parser.add_argument("--agent", default=os.environ.get("BRIDGE_AGENT", "Claude"), help="Agent name")
    # The window id the client issued. The hook finds it and passes it, so the line
    # this window belongs to resolves from the first poll, before the agent has
    # made a single bridge call to register its label against the window.
    parser.add_argument("--window", default=os.environ.get("BRIDGE_WINDOW", ""), help="Client window id")
    args, _ = parser.parse_known_args()

    my_session = args.session.strip()
    if not my_session:
        my_session = detect_session(args.agent)

    parent_pid = os.getppid()
    _announce(args.window)
    # The window id when the hook passed it; a label resolves to the same window.
    me = args.window.strip() or my_session
    last = None
    misses = 0
    now = time.time()
    last_identity_try = now
    last_heartbeat = now
    sess_label = (" [session: %s]" % my_session) if my_session else " [session unknown]"
    while True:
        if not parent_alive(parent_pid):
            print("watchman: the session that started me is gone, exiting", flush=True)
            return 0

        now = time.time()
        # Identity is worth asking for again. A session enters the registry the
        # moment it first writes to the board; from then on this watchman can
        # filter properly instead of showing the whole machine.
        if not me and now - last_identity_try >= IDENTITY_RETRY_SEC:
            last_identity_try = now
            found = detect_session(args.agent)
            if found:
                me = my_session = found
                print("watchman: session recognised as %s — filtering by session is now on"
                      % my_session, flush=True)

        try:
            top = get_max_id()
            if last is None:
                last = top
                # To stderr: every stdout line wakes the session, and "I have started"
                # is not news — the Monitor call that started this already said so.
                print("watchman listening at #%d%s" % (top, sess_label), file=sys.stderr, flush=True)
            elif top > last:
                if me:
                    rows = urgent_since(args.agent, me, last)
                else:
                    # Session unknown: show everything, directed messages
                    # included. Filtering here would hide exactly the orders
                    # meant for this session, and a watchman that misses its
                    # own orders is worse than one that shows a neighbour's.
                    rows = [{"id": r[0], "fromSession": r[2] or "", "toSession": r[4] or "", "priority": r[5],
                             "status": r[6], "topic": r[7], "message": (r[8] or "").replace("\n", " ")[:150]}
                            for r in get_messages_since(last)]
                for m in rows:
                    pri = m.get("priority") or "normal"
                    mark = "🚨 P0" if pri == "P0" else ("· " + pri)
                    to_sess = (m.get("toSession") or "").strip()
                    tgt = (" → [%s]" % to_sess) if to_sess else ""
                    # The owner is answered on the board, in the room he wrote in.
                    owner = " · OWNER — ack first in one line (taken / preparing the answer), then the result; replyTo #%d" % m["id"] \
                        if (m.get("fromSession") or "").lower().startswith("human") else ""
                    print("%s #%d [%s] %s%s%s — %s"
                          % (mark, m["id"], m.get("status") or "-", m.get("topic") or "", tgt, owner, m.get("message") or ""),
                          flush=True)
                last = top
            misses = 0
        except Exception as e:
            misses += 1
            if misses in (5, 30):
                print("watchman: the board could not be read for %d consecutive attempts (%s)"
                      % (misses, type(e).__name__), flush=True)

        # Every line costs the agent context, so the heartbeat speaks only when
        # it has something to report: an identity it never worked out, or a
        # board it cannot read. A healthy watchman stays quiet.
        if time.time() - last_heartbeat >= HEARTBEAT_SEC:
            last_heartbeat = time.time()
            if not me:
                print("watchman alive, board at #%s, session still unknown — a message addressed "
                      "to this session cannot be told from a neighbour's; restart with --session <id>"
                      % (last if last is not None else "?"), flush=True)
            elif misses:
                print("watchman alive, but the board has been unreadable for %d attempts"
                      % misses, flush=True)
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    sys.exit(main())
