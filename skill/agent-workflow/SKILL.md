---
name: agent-workflow
description: "How to work on a project so that nothing is lost and no tokens are wasted: the .agents/ files and what goes in each, the session slice (HANDOFF.md) that survives compaction and account switches, commits as the only history, context economy, one source of truth. Use at the start of every session in a project, before a long autonomous stretch, at every milestone (commit, install, decision), when the context is filling up, and whenever a project's notes look like a pile."
---

# Working on a project

The context window is the scarce resource, and it is wiped by compaction, by a window reset, by an
account switch. **Whatever is not on disk is lost.** So the state of the work lives in the project's
files, never in your memory of the conversation — and those files stay small, because every session
pays to read them.

The user's own instructions win. Where the project has none, work like this. Where it has a pile —
a WORKLOG, a CLAUDE.md that grew into a diary, notes in five places — do not add to the pile:
propose moving it into the layout below, and do it once the user agrees.

**The first time you work with this skill in a project without `.agents/`**, say so to the user in
a line or two and offer to set the project up by it. Do it only after they agree. If they decline,
leave an empty `.no-agent-workflow` file in the project root, so no session asks again. (The
session-start hook and the bridge remind you of this; one offer per project is enough.)

## `.agents/` — one purpose per file

| file | what is in it | read | size |
|---|---|---|---|
| `AGENTS.md` | stable rules: what the project is, build / install / verify, bans, dependencies on other projects, where things live | every session (imported) | ≤ 8 KB |
| `HANDOFF.md` | **the slice**: date and who; branch, commit, what is deployed; ✅ done but not committed; ⏳ in progress with the exact next step; 📋 next few items; ❓ questions for the user | every session (imported) | ≤ 4 KB |
| `TODO.md` | the task queue with priorities; finished items are deleted | when picking a task | — |
| `DEBT.md` | known defects and unfinished work: symptom, where, why postponed | when touching that code | — |
| `<TOPIC>.md` + `INDEX.md` | project knowledge by topic | through the index only | — |
| `DECISIONS.md` | why a rule exists, when that is worth keeping | rarely | — |

`CLAUDE.md` (or the client's equivalent) = an import of `AGENTS.md` and `HANDOFF.md` plus whatever is
specific to one client. Rules are never duplicated between files: another agent reads `AGENTS.md`
directly.

`AGENTS.md` holds no history, no "status as of…", no changelog — one line per rule in force.

## The slice

- **Rewritten, never appended to.** A ✅ line lives until its commit, then disappears: history is git.
- Refresh it after every verified step, before any long autonomous stretch, before the user switches
  accounts or windows — the next session starts from it and from nothing else.
- It is a handover, not a diary. Not in it: what git already says (file lists, diffs, finished
  work), measurements and logs (they go in the commit or a topic file), rules from `AGENTS.md`.

## Commits are the notes

No chronicles, no WORKLOG. One commit after every verified step:

- subject `area: what was done`;
- body: **what** changed, **why** (which problem), **what it touches**, **how it was verified**
  (build, test, device), **related** items, and what stays open;
- `fix`, `wip`, `update` as a whole message, and `--amend`, are banned;
- code, resources and documentation go in separate commits.

A rejected commit means fixing the message or the content — never bypassing a hook.

## Context economy

- Do not re-read what you do not need. `AGENTS.md` and `HANDOFF.md` arrive by import; `TODO.md`,
  `DEBT.md` and topic files only when the task touches them; never a knowledge file "just in case".
- Keep big output outside the context: filter logs and dumps with a script, read only the lines you
  act on, write long artifacts to a file and pass the path.
- Prefer one wide command over several narrow ones, and answer from what you already read.
- Write a finding down once, at the end of a logical step, in its one canonical place.
- Rules agents read are best in English: other scripts cost up to twice the tokens. What the user
  reads — the slice, the queue, commit messages — is in the user's language.
- Memory files hold facts that outlive the current task (who the user is, what was learned the hard
  way). Never the state of the work: that is the slice's job.

## The program is a living organism

A change in one place is felt everywhere that place is used. Code is changed like surgery, not
like a rewrite.

**Before a change**
- **Read the real file**, not your memory of it: parallel sessions may have changed it, and its
  comments and measurements are someone's paid-for work.
- **Find every use** of what you are about to change — every caller of the function, every reader
  and writer of the flag or field, across the whole project (code, manifests, resources, configs,
  build and obfuscation rules). Decide how the change affects each of them **before** making it.
  Trace a bug through the whole chain of state, from the source of the data to what the user sees.

**Making it**
- **Point changes only.** Change the lines the task needs. Never regenerate a whole class or file
  from memory: it silently drops half the code — the edge cases, the fixes, the comments nobody
  remembers.
- **One source of truth.** Every state, rule or decision has exactly one canonical function, class
  or method; everyone else calls it. Never a second copy "just here".
- **No island logic, no crutches.** No local patches, hardcoded values, stubs or one-off database
  writes that fix a symptom while bending the shared state machine. Change the source of truth, not
  the place where the symptom shows.
- **Island logic first.** Finding two places that hold or handle the same state — a file and a
  database mirroring each other, the same decision coded twice — stop the feature, merge them into
  one source, commit, then return to the feature. They drift apart, always.
- **Preserve prior work.** Never disable, simplify or replace with a stub something another session
  built and that works, just to get past your problem.
- **No god files.** Pull complete, reusable blocks into their own modules, helpers or managers before
  a file grows past what one reader can hold; keep responsibilities apart.

**After it**
- **Verify, including the neighbours.** Build, run, check on the real target — and check that what
  sits next to the change still works. Say plainly what you could not verify.
- **The environment you test in behaves like the user's.** Do not fake what the user would have to
  grant or have (permissions forced from a shell, root slipped in, test-only shortcuts): it hides the
  very defects the user will hit.
- **Clean up after yourself.** Deleting something, grep the whole tree for its traces and list every
  candidate before removing any. Update the documentation in the same step. Stage only your own
  work. Your report names everything that changed and matches `git status`.
- **Never destructive git.** No `reset --hard`, `clean`, `checkout -- .`, `stash` to "get back to a
  clean state", no force-push. A damaged file is restored on its own: `git restore <file>`.
- **Do not delete the user's data** to make room or tidy up: rename or move it, and say where.

**Findings**
- **Write a finding down the moment you have it**, even if that interrupts the task, and come back
  to the task after. An unwritten finding lives only until the next compaction; writing costs a
  minute, finding it again costs days.
- **Mark how each fact is known**: 🔬 read in code or firmware, 📻 measured, 🧩 inferred, ❓ unverified.
  An honest ❓ beats a confident sentence that turns out wrong.

**Working with tools and other sessions**
- **Hand research to another session** (a room on the board) instead of filling your own context
  with it; keep your context on the task.
- **Write a non-trivial patch to a file and run it**, rather than inlining it in a shell command:
  every layer of quoting eats its own share of backslashes. Check the result's syntax after.
- **A syntax check is not a check of behaviour.** A page is checked by looking at it, a device
  feature on the device.

## Between projects

- Agreements between applications live in the shared contracts folder (see the `agent-bridge`
  skill), never copied into one project's notes. Link to them.
- Every project's `AGENTS.md` has a "Dependencies" section: who it depends on, who depends on it,
  which contracts.
