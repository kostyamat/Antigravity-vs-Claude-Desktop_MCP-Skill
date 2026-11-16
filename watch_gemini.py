# -*- coding: utf-8 -*-
import ctypes
import os
import sqlite3
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
POLL_SEC = 2.0


def board_paused(db_path):
    """True while the owner has pressed Stop work on the board (table board_pause)."""
    try:
        con = sqlite3.connect(db_path, timeout=3.0)
        try:
            return con.execute("SELECT 1 FROM board_pause WHERE id = 1").fetchone() is not None
        finally:
            con.close()
    except Exception:
        return False


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
            SELECT id, from_agent, from_session, to_agent, to_session, priority, message
            FROM messages
            WHERE id > ?
            ORDER BY id ASC
        """, (last_id,))
        return cur.fetchall()
    finally:
        con.close()


def parent_alive(pid):
    """True while the process that started this watcher is still running.

    This watcher exits on the first wake-up, but a quiet board means it polls
    for as long as the machine is on. When the IDE that started it is gone,
    there is nobody left to wake: it should go too, rather than join the pile
    of orphans holding the database open.
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
        return False
    try:
        return kernel32.WaitForSingleObject(handle, 0) != WAIT_OBJECT_0
    finally:
        kernel32.CloseHandle(handle)


def is_wake(row, me):
    """Should this message wake the Gemini window `me`?

    Its own posts never do. With the window known, that is decided by the session, so a
    message from another Gemini window wakes it (DEBT: the name filter meant one Gemini
    could never wake another). Without it, the old guess by name is all there is.
    """
    _i, who, from_session, to_agent, to_session, _pri, _body = row
    to = (to_agent or "all").lower()
    if to not in ("gemini", "all"):
        return False
    if me:
        if (from_session or "").strip().lower() == me.lower():
            return False
        target = (to_session or "").strip().lower()
        return target in ("", "all", me.lower())
    return not (who or "").lower().startswith("gemini")


def main():
    me = ""
    for k, a in enumerate(sys.argv[1:]):
        if a == "--session" and k + 2 < len(sys.argv):
            me = sys.argv[k + 2].strip()
        elif a.startswith("--session="):
            me = a.split("=", 1)[1].strip()
    me = me or os.environ.get("BRIDGE_SESSION", "").strip()
    try:
        last = get_max_id()
    except Exception:
        last = 0

    parent_pid = os.getppid()
    while True:
        if not parent_alive(parent_pid):
            return 0
        try:
            top = get_max_id()
            if top > last and board_paused(DB_PATH):
                last = top          # the owner stopped the work: wake nobody, now or after
            elif top > last:
                rows = get_messages_since(last)
                for r in rows:
                    i, who, _fs, to_agent, _ts, pri, body = r
                    who = who or "?"
                    if is_wake(r, me):
                        clean_body = (body or "").replace("\n", " ")[:200]
                        print(f"🔔 [BRIDGE_WAKEUP] #{i} vid {who} -> {to_agent}: {clean_body}", flush=True)
                        return 0
                last = top
        except Exception:
            pass
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    sys.exit(main())
