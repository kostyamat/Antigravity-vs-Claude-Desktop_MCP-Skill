# -*- coding: utf-8 -*-
import sqlite3
import sys
import time

DB_PATH = "C:/scripts/agent_bridge.db"
POLL_SEC = 2.0


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
            SELECT id, from_agent, to_agent, priority, message
            FROM messages
            WHERE id > ?
            ORDER BY id ASC
        """, (last_id,))
        return cur.fetchall()
    finally:
        con.close()


def main():
    try:
        last = get_max_id()
    except Exception:
        last = 0

    while True:
        try:
            top = get_max_id()
            if top > last:
                rows = get_messages_since(last)
                for r in rows:
                    i, who, to_agent, pri, body = r
                    who = who or "?"
                    if who.lower().startswith("gemini"):
                        continue
                    to = (to_agent or "all").lower()
                    if to in ("gemini", "all"):
                        clean_body = (body or "").replace("\n", " ")[:200]
                        print(f"🔔 [BRIDGE_WAKEUP] #{i} vid {who} -> {to_agent}: {clean_body}", flush=True)
                        return 0
                last = top
        except Exception:
            pass
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    sys.exit(main())
