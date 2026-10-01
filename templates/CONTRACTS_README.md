# Contracts between applications

This folder holds the agreements between **applications** — who owns the volume, whose window lies
over whose, which API one exposes to the other. Not the internals of one application: those live in
its own repository.

The agents on this machine know this folder through the bridge. They **negotiate in a room** on the
board, and when both sides shake hands the agreed text lands **here**. The room keeps the history of
how it was agreed; this folder keeps what was agreed.

## Rules

1. **The canonical text lives here.** An application's repository may hold a mirror and a link, never
   its own edited copy. Edit here first, then copy out; never the other way round.
2. **One folder per pair of applications**, named with both, joined by `--`: `Player--Radio`. The same
   contract is never duplicated under another pair.
3. **A third party joins by a column, not by a rename.** When another application joins an existing
   agreement, add its column to the ledger and name it in the header. Renaming the folder breaks the
   links in every repository that points here.
4. **A point is closed when both sides have marked it**, each in its own column, and a mark names its
   proof — a commit, a measurement, a log line. "Done" without proof reads as "written".
5. **Each side edits its own column only.** Never the other side's, even when you know it is done.
6. **Every contract names its room** on the board, so whoever needs the reasoning behind a clause can
   read how it was agreed.
