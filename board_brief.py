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

Installed by install-bridge.js as one of the hooks of the Claude Code plugin agent-bridge@skills-dir
(claude-plugin.js); nothing to add to settings.json by hand.
"""
import json
import subprocess
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
    # stdin can be read only once, and more than one part of this hook asks.
    if "_SID" in globals():
        return _SID
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
        globals()["_SID"] = str(value).strip()
        return _SID
    except Exception:
        globals()["_SID"] = ""
        return ""


def _claude_session_roots():
    """Every folder Claude Desktop may keep its window records in, the live one first.

    The same list as claude-home.js, which explains why there is a list at all: the
    app has moved its data folder more than once, and a path written down here left
    every window unrecognised on the day it moved. Kept in Python too because this
    hook runs on every session start and cannot wait for node to tell it a path.
    """
    home = os.path.expanduser("~")
    appdata = os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming")
    local = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
    cands = []
    forced = os.environ.get("AGENT_BRIDGE_CLAUDE_DATA", "")
    cands += [p for p in forced.split(os.pathsep) if p]

    def subdirs(d):
        try:
            return [os.path.join(d, n) for n in os.listdir(d) if os.path.isdir(os.path.join(d, n))]
        except OSError:
            return []

    cands += subdirs(os.path.join(local, "Claude-Data"))
    cands.append(os.path.join(appdata, "Claude"))
    for pkg in subdirs(os.path.join(local, "Packages")):
        if os.path.basename(pkg).lower().startswith("claude_"):
            cands.append(os.path.join(pkg, "LocalCache", "Roaming", "Claude"))
    cands.append(os.path.join(home, "Library", "Application Support", "Claude"))
    cands.append(os.path.join(home, ".config", "Claude"))

    def stamp(root):
        try:
            return os.path.getmtime(os.path.join(root, "config.json"))
        except OSError:
            return 0

    roots, seen = [], set()
    for root in sorted(cands, key=stamp, reverse=True):
        sess = os.path.join(root, "claude-code-sessions")
        key = os.path.normcase(os.path.abspath(sess))
        if key not in seen and os.path.isdir(sess):
            seen.add(key)
            roots.append(sess)
    return roots


def _find_window(cli_id):
    """The Claude Desktop window this session runs in, and the account it lives under.

    Claude Desktop keeps one folder of window records per account, and every record
    names the transcript it writes — the very id this hook receives. So the window a
    session belongs to can be looked up instead of asked for: the agent does not
    have to remember a label, or call anything, to be recognised as that window.
    """
    # Claude Desktop hands the window id to everything it starts. That is the
    # answer whenever it is there; the folder scan below only adds the title, and
    # is the whole answer for a client that sets nothing.
    env_window = os.environ.get("CLAUDE_CODE_HOST_SESSION_ID", "").strip()
    if not env_window.startswith("local_"):
        env_window = ""
    if not cli_id and not env_window:
        return None
    for root in _claude_session_roots():
        try:
            accounts = [d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d))]
        except OSError:
            continue
        for acc in accounts:
            acc_dir = os.path.join(root, acc)
            try:
                subs = [d for d in os.listdir(acc_dir) if os.path.isdir(os.path.join(acc_dir, d))]
            except OSError:
                continue
            for sub in subs:
                sub_dir = os.path.join(acc_dir, sub)
                try:
                    names = [f for f in os.listdir(sub_dir) if f.startswith("local_") and f.endswith(".json")]
                except OSError:
                    continue
                for name in names:
                    if env_window and name[:-5] != env_window:
                        continue
                    try:
                        with open(os.path.join(sub_dir, name), encoding="utf-8") as fh:
                            raw = fh.read()
                    except (OSError, UnicodeDecodeError):
                        continue
                    if not env_window and cli_id not in raw:
                        continue
                    try:
                        rec = json.loads(raw)
                    except ValueError:
                        continue
                    if not env_window and str(rec.get("cliSessionId", "")).strip() != cli_id:
                        continue
                    return {
                        "window": str(rec.get("sessionId") or name[:-5]),
                        "account": acc,
                        "title": str(rec.get("title") or ""),
                        "project": str(rec.get("originCwd") or rec.get("cwd") or ""),
                    }
    if env_window:
        return {"window": env_window, "account": os.environ.get("CLAUDE_CODE_ACCOUNT_UUID", ""),
                "title": "", "project": ""}
    return None


def workflow_hint(start):
    """A line asking the agent to offer the agent-workflow layout, or None.

    The project is the nearest folder above the working directory that holds a
    .git. It follows the layout when it has .agents/AGENTS.md or .agents/HANDOFF.md.
    An owner who said no leaves .no-agent-workflow in the project root, and is not
    asked again.
    """
    d = os.path.abspath(start or os.getcwd())
    while True:
        if os.path.exists(os.path.join(d, ".git")):
            break
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent
    if os.path.exists(os.path.join(d, ".no-agent-workflow")):
        return None
    for name in ("AGENTS.md", "HANDOFF.md"):
        if os.path.exists(os.path.join(d, ".agents", name)):
            return None
    return ("This project (%s) does not follow the agent-workflow skill yet: there is no .agents/. "
            "Tell the owner, in one or two lines, that you have the agent-workflow skill and offer to set "
            "the project up by it (.agents/AGENTS.md, HANDOFF.md, TODO.md, DEBT.md; move scattered notes "
            "there). Do it only after he agrees. If he declines, create an empty .no-agent-workflow file "
            "in the project root so the offer is not repeated." % d)


def window_state():
    """(P0 still pending, read cursor) for this window. P0 by the one rule in p0.js:
    addressed to it, admitted by its room, unread, less than a day old. Counting
    every P0 above the agent's oldest cursor showed thirty, days old, from rooms
    this window is not in."""
    try:
        sid = _client_session_id() or ""
        win = _find_window(sid) if sid else None
        args = ["node", os.path.join(_bridge_home(), "p0.js"), ME, sid]
        if win and win.get("window"):
            args.append(win["window"])
        out = subprocess.run(args, capture_output=True, timeout=15)
        data = json.loads(out.stdout.decode("utf-8", "replace") or "{}")
        return int(data.get("count", 0)), data.get("cursor")
    except Exception:
        return 0, None


def window_mail(window):
    """What waits on the board for this window, by the one rule in mailbox.js:
    {"fresh", "cursor", "unread", "urgent", "last"} or None when it cannot be asked.
    Counted here from the agent-wide cursor it was "1006 unread" for a window that
    had nothing of its own: that cursor stops moving once windows keep theirs, and
    the count took the whole board, other projects' rooms included."""
    try:
        out = subprocess.run(["node", os.path.join(_bridge_home(), "mailbox.js"), "brief", ME, window],
                             capture_output=True, timeout=15)
        data = json.loads(out.stdout.decode("utf-8", "replace") or "{}")
        return data if "unread" in data else None
    except Exception:
        return None


def previous_window(sid):
    """How the previous window of this project ended, when it went on after the slice
    was written: an account switch or a cut-off session leaves the slice behind, and the
    transcript in the shared ~/.claude/projects says what happened (handover.js)."""
    try:
        args = ["node", os.path.join(_bridge_home(), "handover.js"), os.getcwd(), sid or ""]
        out = subprocess.run(args, capture_output=True, timeout=15)
        return [l for l in out.stdout.decode("utf-8", "replace").splitlines() if l.strip()]
    except Exception:
        return []


def rooms_of_window(sid, win):
    """The rooms this window is in and the invitations it has not acted on, by the
    one rule in room-invite.js. A window that was closed when the owner invited it
    finds the invitation here, so "go to the room you were invited to" is enough."""
    try:
        args = ["node", os.path.join(_bridge_home(), "window-brief.js"), ME, sid or "", win or "",
                os.environ.get("CLAUDE_CODE_ACCOUNT_UUID", "")]
        out = subprocess.run(args, capture_output=True, timeout=15)
        return [l for l in out.stdout.decode("utf-8", "replace").splitlines() if l.strip()]
    except Exception:
        return []


def register_window(session_id, window):
    """Record this window in the board registry before the agent has said anything.

    The registry only ever learned of a window when something inside it called the
    bridge, so a window that had just opened was missing from the board — and after
    an account switch, all of them at once, which reads as "the board cannot see the
    new account". The hook already knows the window and its title, so recording them
    costs one short call and makes the window appear by itself.

    Written under the label the brief tells the agent to sign with, so the agent's
    own first call updates this row instead of creating a second one.
    """
    if not session_id or not window or not window.get("window"):
        return
    try:
        subprocess.run(
            ["node", os.path.join(_bridge_home(), "register-window.js"), ME, str(session_id),
             window["window"], "claude-code", os.getcwd(), window.get("title", "")],
            capture_output=True, timeout=15)
    except Exception:
        pass                           # the board is a convenience, never a gate


def prompt_invites():
    """UserPromptSubmit: an invitation reaches a window that was asleep.

    A Claude window cannot be woken from outside; the owner wakes it by writing to
    it, whatever he writes. From that first word it must know where it was invited,
    without being told the room. This runs on every prompt, so it stays silent and
    quick unless an invitation for this session exists: one indexed query first,
    the window lookup and the canonical rule (room-invite.js) only after a hit."""
    sid = _client_session_id()
    if not sid or not os.path.exists(DB):
        return 0
    win = _find_window(sid)
    ids = [x for x in (sid, win and win["window"]) if x]
    try:
        con = sqlite3.connect("file:%s?mode=ro" % DB.replace("\\", "/"), uri=True, timeout=2.0)
        hit = con.execute("SELECT 1 FROM messages WHERE message LIKE 'Room invitation%%' AND to_session IN (%s) LIMIT 1"
                          % ",".join("?" * len(ids)), ids).fetchone()
        con.close()
    except Exception:
        return 0
    if not hit:
        return 0
    invited = [l for l in rooms_of_window(sid, win and win["window"]) if l.startswith("\U0001F4E8")]
    if not invited:
        return 0
    text = invited[0] + "\nJoin it now, before anything else: read the room and its documents, post one line there " \
        "that you have joined, then do what the owner asked."
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": text}},
                     ensure_ascii=False))
    return 0


SOURCE_LINE = "source:"


def check_finding(path):
    """Does a finding name evidence that can be looked up? -> (ok, verdict in one line).

    A finding proves itself with lines of the form
        Source: <file>[:<line>] | <text that stands in that file, word for word>
    For each one the file must exist and hold the text (near the line, when a line is given). A stand
    log counts once it is saved to a file. This cannot tell a true fact from a false one; it refuses the
    cheap kind of invention - a command, a constant or a log line that is not where the finding says.
    """
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except Exception as e:
        return False, "cannot be read (%s)" % e
    good, bad = 0, []
    for raw in lines:
        s = raw.strip().lstrip("-*> ").strip()
        if not s.lower().startswith(SOURCE_LINE):
            continue
        ref, _, quote = s[len(SOURCE_LINE):].partition("|")
        ref, quote = ref.strip().strip("`"), quote.strip().strip("`")
        line_no = 0
        head, sep, last = ref.rpartition(":")
        if sep and last.isdigit() and len(head) > 2:
            ref, line_no = head, int(last)
        if not quote:
            bad.append("no quoted text for %s" % os.path.basename(ref)); continue
        if not os.path.isfile(ref):
            bad.append("no such file: %s" % ref); continue
        try:
            with open(ref, encoding="utf-8", errors="replace") as f:
                body = f.read().splitlines()
        except Exception:
            bad.append("unreadable: %s" % ref); continue
        scope = body[max(0, line_no - 6):line_no + 5] if line_no else body
        if any(quote in l for l in scope):
            good += 1
        elif line_no and any(quote in l for l in body):
            bad.append("'%s' is in %s, but not near line %d" % (quote[:40], os.path.basename(ref), line_no))
        else:
            bad.append("'%s' is NOT in %s" % (quote[:40], os.path.basename(ref)))
    if bad:
        return False, "EVIDENCE DOES NOT HOLD: " + "; ".join(bad[:3]) + (" (+%d ok)" % good if good else "")
    if not good:
        return False, "NO CHECKABLE SOURCE (no 'Source: <file>[:<line>] | <text>' line) - treat as a guess"
    return True, "%d source(s) found where stated - still read them" % good


def _helper_skill_files(cfg):
    """{relative path: sha1} of the markdown in the helper's own skill folder; links to the store are skipped."""
    import hashlib
    root = cfg.get("helperSkills") or ""
    skip = set(x.lower() for x in (cfg.get("helperSkillsIgnore") or []))
    out = {}
    if not root or not os.path.isdir(root):
        return out
    is_junction = getattr(os.path, "isjunction", lambda p: False)
    for name in sorted(os.listdir(root)):
        top = os.path.join(root, name)
        if not os.path.isdir(top) or name.lower() in skip or os.path.islink(top) or is_junction(top):
            continue
        for r, dirs, files in os.walk(top):
            dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "state")]
            for f in files:
                if f.lower().endswith(".md"):
                    fp = os.path.join(r, f)
                    try:
                        with open(fp, "rb") as fh:
                            out[os.path.relpath(fp, root).replace("\\", "/")] = hashlib.sha1(fh.read().replace(b"\r\n", b"\n")).hexdigest()
                    except Exception:
                        pass
    return out


def _helper_seen_path():
    return os.path.join(_bridge_home(), "helper_skills_seen.json")


def helper_skills_changed(cfg):
    """Skill files the helper wrote or changed in its own folder since a lead last reviewed them."""
    now = _helper_skill_files(cfg)
    if not now:
        return []
    try:
        with open(_helper_seen_path(), encoding="utf-8") as f:
            seen = json.load(f)
    except Exception:
        seen = {}
    return sorted(k for k, v in now.items() if seen.get(k) != v)


def accept_helper_skills():
    """The lead has read the changed skill files: remember their state as reviewed."""
    try:
        with open(os.path.join(_bridge_home(), "bridge_config.json"), encoding="utf-8") as f:
            cfg = (json.load(f) or {}).get("canonReview") or {}
    except Exception:
        cfg = {}
    now = _helper_skill_files(cfg)
    with open(_helper_seen_path(), "w", encoding="utf-8") as f:
        json.dump(now, f, indent=1, sort_keys=True)
    print("reviewed state saved: %d file(s)" % len(now))
    return 0


def canon_review():
    """Findings waiting for the lead's review, where the owner keeps one verified canon.

    bridge_config.json -> "canonReview": {"inbox": "<folder>", "repos": ["<repo>", ...]}. A helper may
    not commit into those repositories: it leaves a finding in the inbox, or an edit uncommitted. Both
    are shown to every Claude session at its start, so that the work the helper did is checked and
    committed instead of being walked past. Nothing configured, nothing waiting - no line.
    """
    try:
        with open(os.path.join(_bridge_home(), "bridge_config.json"), encoding="utf-8") as f:
            cfg = (json.load(f) or {}).get("canonReview") or {}
    except Exception:
        return []
    waiting = []
    inbox = cfg.get("inbox") or ""
    if inbox and os.path.isdir(inbox):
        files = sorted(f for f in os.listdir(inbox) if f.lower().endswith(".md") and f.lower() != "readme.md")
        if files:
            waiting.append("%d finding(s) in %s:" % (len(files), inbox))
            for f in files[:8]:
                waiting.append("  %s - %s" % (f, check_finding(os.path.join(inbox, f))[1]))
            if len(files) > 8:
                waiting.append("  ... and %d more" % (len(files) - 8))
    changed = helper_skills_changed(cfg)
    if changed:
        waiting.append("%d skill file(s) in the helper's own folder are new or changed since the last review: %s" %
                       (len(changed), ", ".join(changed[:6]) + (" ..." if len(changed) > 6 else "")))
        waiting.append("  read them: a platform fact there goes to the canon after a check, or is replaced by a pointer; "
                       "then: python board_brief.py --accept-helper-skills")
    for repo in cfg.get("repos") or []:
        try:
            out = subprocess.run(["git", "-C", repo, "-c", "core.quotepath=off", "status", "--porcelain"],
                                 capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10).stdout
        except Exception:
            continue
        changed = [l[3:].strip().strip('"') for l in out.splitlines()
                   if l.strip() and not l[3:].strip().strip('"').replace("\\", "/").startswith(os.path.basename(inbox.rstrip("/\\")) + "/")]
        if changed:
            waiting.append("%d uncommitted change(s) in %s: %s" % (len(changed), repo, ", ".join(changed[:5]) + (" ..." if len(changed) > 5 else "")))
    if not waiting or ME != "Claude":
        return []
    return ["Canon review is waiting - the owner's rule: what the helper found is verified and committed by Claude, never walked past:"] + \
           ["  " + w for w in waiting] + \
           ["  Before platform work in this session: check each against its evidence, write what holds into the canon in your own words, "
            "commit, delete the inbox file; answer what does not hold in the helper's room."]


def main():
    if "--accept-helper-skills" in sys.argv:
        return accept_helper_skills()
    if "--check-finding" in sys.argv:
        target = sys.argv[sys.argv.index("--check-finding") + 1] if len(sys.argv) > sys.argv.index("--check-finding") + 1 else ""
        ok, verdict = check_finding(target)
        print(verdict)
        return 0 if ok else 1
    if "--prompt" in sys.argv:
        return prompt_invites()
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

    window, line, line_members = None, "", []
    try:
        # The window's own read cursor when the bridge can tell it: the agent-wide
        # one lags far behind and made every session start with hundreds "unread".
        p0, win_cursor = window_state()
        if isinstance(win_cursor, int) and win_cursor > cursor:
            cursor = win_cursor
        cur.execute("select count(*) from messages where id > ? and from_agent <> ?", (cursor, ME))
        unread = cur.fetchone()[0]
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

        # Read once: stdin can only be read once, and the id is needed below whether
        # or not the registry already knew a label for this directory.
        client_id = (os.environ.get("CLAUDE_SESSION_ID")
                     or os.environ.get("BRIDGE_SESSION")
                     or _client_session_id())

        # Which window this is. When the client can say, that id is the signature:
        # a label guessed from the folder name was shared by every window of the
        # project, and the id of a run dies with the run.
        window = _find_window(client_id)
        if window and window.get("window"):
            hook_session = window["window"]
        if not hook_session:
            hook_session = client_id

        try:
            names = [n for n in (hook_session, client_id, window and window["window"]) if n]
            cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='line_members'")
            if cur.fetchone() and names:
                q = ",".join("?" * len(names))
                # a label points at its window, and the window is what joins a line
                cur.execute("SELECT canonical_id FROM session_aliases WHERE alias IN (%s)" % q, names)
                names += [r[0] for r in cur.fetchall() if r[0]]
                q = ",".join("?" * len(names))
                cur.execute("SELECT line FROM line_members WHERE member IN (%s) LIMIT 1" % q, names)
                row = cur.fetchone()
                if row:
                    line = row[0]
                    cur.execute("SELECT member FROM line_members WHERE line = ? ORDER BY member", (line,))
                    line_members = [r[0] for r in cur.fetchall()]
        except Exception:
            line, line_members = "", []

        con.close()
    except Exception:
        return 0

    # Outside the block above on purpose: a registry that cannot be written to
    # must still leave the human with a brief.
    register_window(hook_session, window)

    # For a window the client names, the count and the digest are its own mail.
    # The whole-board figures below remain only for a session with no window id.
    mail = window_mail(window["window"]) if window and window.get("window") else None
    if mail:
        if mail["fresh"]:
            state = "new window on the board, nothing read yet" + \
                ((" - %d urgent for it from the last day" % mail["urgent"]) if mail["urgent"] else "")
        elif mail["unread"]:
            state = "%d unread for this window" % mail["unread"] + \
                ((", %d of them urgent" % mail["urgent"]) if mail["urgent"] else "")
        else:
            state = "nothing new for this window"
        lines = ["agent-bridge: %s%s" % (state, ("   P0 PENDING: %d" % p0) if p0 else "")]
        lines += ["  " + l for l in mail["last"]]
    else:
        lines = ["agent-bridge: %s%s" % (
            ("%d unread for %s" % (unread, ME)) if unread else "nothing new",
            ("   P0 PENDING: %d" % p0) if p0 else "")]
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
    # One identity, stated once. The watchman filters on --session, so the agent
    # must sign the board with exactly the same id. Project instruction files defer
    # to this line instead of repeating it: repeated, the copies drifted and
    # contradicted each other, and every session paid to reconcile them.
    sid = hook_session or "<YOUR SESSION ID>"
    cmd_str = "%s %s --session %s --agent %s" % (py, watch, sid, ME)
    if window:
        # the window from the first second: its line resolves before any label is registered
        cmd_str += " --window %s" % window["window"]
    if window:
        lines.append("Your board sessionId: %s — this window%s. A hook signs your bridge calls with it;"
                     " never sign with anything else." % (hook_session, (" «%s»" % window["title"]) if window.get("title") else ""))
    elif hook_session:
        lines.append("Your board sessionId: %s — sign every bridge call with it; do not invent another."
                     % hook_session)
    else:
        lines.append("No sessionId found: use the label list_sessions shows for this project,"
                     " the same one in the watchman and in every bridge call.")
    if window:
        # The background hook (bridge-hook.js watch) wakes this window by the same
        # rule. A Monitor watchman beside it added nothing but wakes of its own: it
        # expires every half hour, and each expiry and each restart cost the
        # session a turn - in a day of measurements, every wake a window got from
        # its watchman was one of those and none was mail.
        lines.append("A hook watches the board for this window: it wakes you when mail for it or its project arrives, "
                     "and checks again before you go idle. Do not start a watchman (Monitor) for the board.")
    else:
        lines += [
            "First action (the watchman died with the previous session):",
            '  Monitor({command: "%s", timeout_ms: 1800000}) - re-arm it when it expires' % cmd_str,
            "Before you go idle a hook checks the board for you; unread mail addressed to you is read first, not later.",
        ]
    if line:
        lines.append('Line of work «%s» (%d windows): load_session_context({line: "%s"}) before reading;'
                     " keep signing with your own sessionId." % (line, len(line_members), line))
    extra = (', canonicalId:"%s", client:"claude-code"' % window["window"]) if window else ""
    if not mail or mail["fresh"] or mail["unread"]:
        lines.append('Then: get_messages({reader:"%s", sessionId:"%s"%s})' % (ME, sid, extra))

    lines += rooms_of_window(hook_session, window and window["window"])
    lines += previous_window(hook_session)

    hint = workflow_hint(os.getcwd())
    if hint:
        lines.append(hint)

    lines += canon_review()

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
