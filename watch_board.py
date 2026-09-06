# -*- coding: utf-8 -*-
"""
🔔 BOARD WATCHMAN (SQLite) — continuous board monitoring for agent autonomy.

Reads the SQLite database (agent_bridge.db) directly via sqlite3.
Each stdout line = one alert, kept concise to highlight items requiring response.
"""
import argparse
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
POLL_SEC = 10


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
            SELECT id, from_agent, from_session, to_agent, to_session, priority, status, topic, message
            FROM messages
            WHERE id > ?
            ORDER BY id ASC
        """, (last_id,))
        return cur.fetchall()
    finally:
        con.close()


def main():
    parser = argparse.ArgumentParser(description="Watch agent-bridge board")
    parser.add_argument("--session", default=os.environ.get("BRIDGE_SESSION", ""), help="Current session identifier")
    parser.add_argument("--agent", default=os.environ.get("BRIDGE_AGENT", "Claude"), help="Agent name")
    args, _ = parser.parse_known_args()

    my_session = args.session.strip()
    my_agent = args.agent.strip().lower()

    # If session not explicitly given via CLI or env, auto-detect from cwd and active sessions
    if not my_session:
        try:
            cwd_base = os.path.basename(os.getcwd()).strip().lower()
            if cwd_base:
                con = sqlite3.connect(DB_PATH, timeout=3.0)
                cur = con.cursor()
                cur.execute("""
                    SELECT session_id, project FROM sessions
                    WHERE lower(agent) = lower(?)
                    ORDER BY last_seen DESC
                """, (args.agent.strip(),))
                rows = cur.fetchall()
                con.close()
                for sid, proj in rows:
                    if proj and proj.strip().lower() == cwd_base:
                        my_session = sid.strip()
                        break
                    if cwd_base in sid.lower():
                        my_session = sid.strip()
                        break
        except Exception:
            pass

    last = None
    misses = 0
    sess_label = (" [session: %s]" % my_session) if my_session else " [session unknown - no filtering]"
    while True:
        try:
            top = get_max_id()
            if last is None:
                last = top
                print("watchman listening at #%d%s" % (top, sess_label), flush=True)
            elif top > last:
                rows = get_messages_since(last)
                for r in rows:
                    i, who, from_sess, to_agent, to_sess, pri, status, topic, body = r
                    who = who or "?"
                    from_sess = (from_sess or "").strip()
                    to_sess = (to_sess or "").strip()

                    # Filter: do not display replicas from own session
                    if my_session:
                        if who.lower().startswith(my_agent) and from_sess == my_session:
                            continue
                        # If message is addressed to another specific session, skip
                        if to_sess and to_sess != "all" and to_sess != my_session:
                            continue
                    else:
                        if who.lower().startswith(my_agent):
                            continue
                        # Session unknown: show everything, directed messages
                        # included. Filtering them out here would hide exactly
                        # the orders meant for this session, and a watchman that
                        # misses its own orders is worse than one that shows a
                        # neighbour's. Pass --session to get the filtering.

                    pri = pri or "normal"
                    mark = "🚨 P0" if pri == "P0" else ("· " + pri)
                    clean_body = (body or "").replace("\n", " ")[:150]
                    tgt = (" → [%s]" % to_sess) if to_sess else ""
                    print("%s #%d [%s] %s%s — %s"
                          % (mark, i, status or "-", topic or "", tgt, clean_body),
                          flush=True)
                last = top
            misses = 0
        except Exception as e:
            misses += 1
            if misses in (5, 30):
                print("watchman: SQLite read error for %d consecutive attempts (%s)"
                      % (misses, type(e).__name__), flush=True)
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    sys.exit(main())
