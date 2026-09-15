# -*- coding: utf-8 -*-
"""
🔔 BOARD WATCHMAN (SQLite) — continuous board monitoring for agent autonomy.

Reads the SQLite database (agent_bridge.db) directly via sqlite3.
Each stdout line = one alert, kept concise to highlight items requiring response.
"""
import argparse
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
            SELECT id, from_agent, from_session, to_agent, to_session, priority, status, topic, message
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


def session_aliases(session_id, agent, lines=True):
    """Every name this session answers to.

    A window collects labels — the client issues a fresh one each time a session
    starts — and a line of work collects windows, one per account. Resolution runs
    to a fixed point over all of it, so the order the rows happen to be stored in
    does not decide what closes.

    lines=True   the addressee side: a message to the line, or to any window on
                 it, is for us.
    lines=False  the sender side: only our own window's names. A sibling window on
                 the same line is somebody else posting, and discarding it as "our
                 own replica" would hide exactly the conversation the line exists
                 to carry.
    """
    names = {session_id}
    try:
        con = sqlite3.connect(DB_PATH, timeout=3.0)
        try:
            cur = con.cursor()
            try:
                line_rows = cur.execute("SELECT member, line FROM line_members").fetchall()
            except sqlite3.Error:
                line_rows = []                # a board from before lines existed
            line_names = {line for _, line in line_rows if line}
            for _ in range(32):
                before = len(names)
                marks = list(names)
                q = ",".join("?" * len(marks))
                # Scoped to this agent: a label can be shared by a Claude session
                # and a Gemini one, and they are not the same participant.
                if lines:
                    cur.execute(
                        "SELECT session_id, canonical_id, custom_name FROM sessions "
                        "WHERE lower(agent) = lower(?) AND "
                        "(session_id IN (%s) OR canonical_id IN (%s) OR custom_name IN (%s))" % (q, q, q),
                        [agent.strip()] + marks + marks + marks)
                else:
                    cur.execute(
                        "SELECT session_id, canonical_id, '' FROM sessions "
                        "WHERE lower(agent) = lower(?) AND (session_id IN (%s) OR canonical_id IN (%s))" % (q, q),
                        [agent.strip()] + marks + marks)
                for sid, canon, cname in cur.fetchall():
                    for value in (sid, canon, cname):
                        if value and value.strip():
                            names.add(value.strip())
                marks = list(names)
                q = ",".join("?" * len(marks))
                cur.execute(
                    "SELECT alias, canonical_id FROM session_aliases "
                    "WHERE alias IN (%s) OR canonical_id IN (%s)" % (q, q),
                    marks + marks)
                for alias, canon in cur.fetchall():
                    if not lines and (alias in line_names or canon in line_names):
                        continue              # line membership kept in the alias table
                    for value in (alias, canon):
                        if value and value.strip():
                            names.add(value.strip())
                if lines:
                    for member, line in line_rows:
                        if member in names or line in names:
                            names.add(member)
                            names.add(line)
                if len(names) == before:
                    break
        finally:
            con.close()
    except Exception:
        pass
    return names


def names_of(session_id, window_id, agent, lines):
    """The union of what the label and the window each resolve to."""
    names = set()
    for seed in (session_id, window_id):
        if seed:
            names |= session_aliases(seed, agent, lines=lines)
    return names


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
    my_agent = args.agent.strip().lower()
    if not my_session:
        my_session = detect_session(args.agent)

    parent_pid = os.getppid()
    my_names = names_of(my_session, args.window, args.agent, True)
    my_window = names_of(my_session, args.window, args.agent, False)
    last = None
    misses = 0
    now = time.time()
    last_identity_try = now
    last_alias_refresh = now
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
        if not my_session and now - last_identity_try >= IDENTITY_RETRY_SEC:
            last_identity_try = now
            found = detect_session(args.agent)
            if found:
                my_session = found
                print("watchman: session recognised as %s — filtering by session is now on"
                      % my_session, flush=True)
                my_names = names_of(my_session, args.window, args.agent, True)
                my_window = names_of(my_session, args.window, args.agent, False)

        # Labels accumulate: a window keeps the one it was given today and every
        # one it was given before. Re-reading them costs one query a minute and
        # is what keeps yesterday's address working.
        if my_session and now - last_alias_refresh >= IDENTITY_RETRY_SEC:
            last_alias_refresh = now
            my_names = names_of(my_session, args.window, args.agent, True)
            my_window = names_of(my_session, args.window, args.agent, False)


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

                    # Identity is the session, never the agent name. Several
                    # sessions of one agent run on this machine at once, so
                    # "from Claude" says nothing about whose message it is.
                    # Matching on the name alone silenced every other Claude
                    # session along with this one's own replicas, and a reply
                    # addressed to this very session lay unseen for hours.
                    if my_session:
                        if who.lower().startswith(my_agent) and from_sess in my_window:
                            continue
                        # Addressed to one specific other session: not ours.
                        if to_sess and to_sess != "all" and to_sess not in my_names:
                            continue
                    # Session unknown: show everything, directed messages
                    # included. Filtering here would hide exactly the orders
                    # meant for this session, and a watchman that misses its
                    # own orders is worse than one that shows a neighbour's.

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

        # Every line costs the agent context, so the heartbeat speaks only when
        # it has something to report: an identity it never worked out, or a
        # board it cannot read. A healthy watchman stays quiet.
        if time.time() - last_heartbeat >= HEARTBEAT_SEC:
            last_heartbeat = time.time()
            if not my_session:
                print("watchman alive, board at #%s, session still unknown — a message addressed "
                      "to this session cannot be told from a neighbour's; restart with --session <id>"
                      % (last if last is not None else "?"), flush=True)
            elif misses:
                print("watchman alive, but the board has been unreadable for %d attempts"
                      % misses, flush=True)
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    sys.exit(main())
