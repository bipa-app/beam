---
description: Beam this session to a remote sandbox so the agent keeps working there
allowed-tools: Bash(beam:*)
---

Hand this Claude Code session to the configured beam target.

Steps:

1. Run `beam up --tool claude -m "$ARGUMENTS"` (omit `-m` entirely when no
   arguments were given). Use the Bash tool; do not modify any files.
2. If beam is not installed or no target is configured, show the error and
   point the user at `beam init` / `beam doctor` — do not improvise a fix.
3. On success, report back exactly:
   - the beam id and target from beam's output,
   - the watch commands: `beam status <id>` and `beam attach <id>`,
   - that `beam down <id>` brings everything back and purges the remote copy.
4. Remind the user to EXIT this local session now — the transcript was
   shipped, and anything typed here afterward will not exist on the sandbox
   (beam backs up on return, but divergence is best avoided).
