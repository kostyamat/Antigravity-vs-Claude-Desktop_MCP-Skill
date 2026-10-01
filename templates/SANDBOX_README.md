# Sandbox

Where agents work on anything that is not a project: patching an APK, trying a tool, unpacking a
firmware, a one-off script. A project lives in its own folder; nothing for it goes here, and nothing
from here goes anywhere else.

## Layout

One folder per task, named by date and task: `2026-10-01-dialer-autocall/`.

```
input/   a copy of what the agent was given — the original is never touched
work/    whatever it unpacks, decompiles, tries
out/     the result, and nothing else
NOTES.md what the task was, what changed (the exact lines), how it was built and verified
```

## Rules

- The smallest change that does the job: one condition, not a decompiled project.
- One working copy: no `_v2`, `_final`, `_new` siblings. More than a step or two — `git init` the task folder.
- Clean up inside the task folder before reporting; never touch anything outside it.
- The report names the full path of the result in `out/`, what changed, and how to install or check it.
- A finished task folder can be deleted by its owner whenever they like; nothing else depends on it.
