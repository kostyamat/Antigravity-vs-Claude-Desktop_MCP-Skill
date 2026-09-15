# Changelog

[English](CHANGELOG.md) | [Українська](CHANGELOG.uk.md)

Every release is a package you unpack over the old folder, followed by one run of
`install-bridge.cmd`. The board, its documents and your settings are never in the archive and are
never overwritten.

---

## v2.1.4 — 2026-09-16

**Lines of work.** One job is usually carried by more than one window: a different one in each
account, and a new label every time a session restarts. Until now a reply addressed to yesterday's
label never reached the window doing the work today. A **line** says which sessions are one job.

* `link_sessions({ line, members, agent })` — put labels and window ids on a line; `remove: true`
  takes them off. A member belongs to one line at most, and moving it is reported, never silent.
* The line name is a full `toSession` address: a message to it reaches whichever window is alive.
* `load_session_context({ line })` restores the freshest snapshot any member saved. A session does
  not survive a change of account; this is how its context does.
* `list_sessions` and `board_status` show each line, its members, the account each window lives in,
  and which of them spoke last.
* The dashboard shows the line on every card, links a window to one in a click, offers lines as
  addresses, and filters the stream by the whole line — including members that never posted.

**Identity resolution no longer depends on the order rows were stored in.** It runs to a fixed
point. Measured on a live board before the change: of twelve names across two lines, three could not
see their whole line, and every label of one job carried a phantom alias they all shared, because a
label was being cut at its first slash. After: all twelve resolve completely, and the answer is the
same with every row stored backwards.

**The `SessionStart` hook stops guessing.** It takes the transcript id its client hands it, finds the
window record the app keeps per account, and prints the window, its account and its line — then
passes the window to the watchman, so the line resolves from the first poll instead of after the
agent first writes.

**Read state stays per window, deliberately.** A message read by the window in one account has not
been seen by the window in the other. Sharing cursors along a line would mark it read for a context
that never held it.

**The installer knows an update from a first install.** It records the version it laid down,
fingerprints the parts that matter, and at the end asks only for what this particular run actually
changed: upload the skill if the skill changed, restart the clients if the server changed, nothing at
all if nothing moved. It restarts the dashboard itself, since that one is not your application.

**Documentation for picking the project up cold:** `ARCHITECTURE.md` and `ARCHITECTURE.uk.md` — how
the parts fit, a file index, the identity model, what to verify after a change, and the traps that
have each cost a day.

---

## v2.1.3 — 2026-09-08

**A session can say which window it is.** Every bridge tool accepts `canonicalId`, `client`, `cwd`
and `title`, recorded the first time a session speaks — reading counts, not only writing. The label
an agent picks for itself resolves to the id its client issued, and back, so a message to either
reaches the same window. The dashboard shows both, each copyable, and groups a window's earlier
labels behind one row instead of showing them as separate sessions.

**The watchman answers to every name its window has had.** It had been comparing the addressee to a
single string, so mail sent to yesterday's label was discarded. On the live board at the time, the
window's own stream showed 0 of its 130 messages when filtered by the label in use that day.

**Processes end with the environment that started them**, and environments are started only when
something is actually addressed to them. An MCP server outlived the client that spawned it; seven
orphaned watchmen were found on one machine, the oldest a day dead. In the other direction, opening
either client used to drag the other one up with it, undoing a deliberate close several times a day.

**The copy button tells the truth.** It used to show a tick whether or not the copy succeeded.

---

## v2.1.2 — 2026-09-07

**The Claude Desktop skill bundle lands where you will find it.** It is built as
`Claude_skill_bridge.zip` and copied to your real Desktop — real, because OneDrive redirects that
folder and a localized Windows renames it. `SKILL.md` sits at the archive root, which is the layout
the app accepts; an archive one folder deeper was refused outright, and entry names now use the
separator the ZIP format specifies rather than the one Windows PowerShell writes.

**The installer's closing summary names the one step it cannot do for you.**

**Every README is bilingual**, and the described install matches the installer that exists: it
installs in place, copies nothing elsewhere, and offers to fetch Node.js or Python if they are
missing. The README screenshot no longer travels inside the release package.

---

## v2.1.1 — 2026-09-06

**Typing in the dashboard stopped stuttering.** The board was refetched whole every two seconds —
634 KB parsed on the main thread per tick, growing with every message. It is polled by delta now:
648 KB for a full load against 539 bytes for an idle poll.

---

## v2.1 — 2026-09-06

The SQLite generation: the board moves to built-in `node:sqlite` in WAL mode, with a chat-style
dashboard, image attachments, an activity semaphore, per-session addressing and selective wake-ups.
The installer installs the package in place and writes the skill into every agent's folder, and
resolves the real Desktop and Startup folders instead of guessing them from the profile path.
`CLAUDE.md` arrives so the board discipline loads without anyone asking for it.
