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

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent_bridge.db")
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

    last = None
    misses = 0
    sess_label = (" [session: %s]" % my_session) if my_session else ""
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
