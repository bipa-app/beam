---
name: beam
description: >
  Hand a live coding-agent session to a remote sandbox with Beam and bring
  its workspace and transcript back safely. Use for beam up/down, remote
  continuation, handoff recovery, setup checks, and return integration.
---

<!-- beam-cli-owned-skill:v1 -->

# Beam remote handoff

Use Beam's version-matched CLI manual. Do not rely on memorized flags.

1. Read `beam docs agent --json`.
2. Run `beam check --json`; stop on any failed check.
3. Exit the local harness so its transcript is settled.
4. Run `beam up --json --tool <tool> --message '<self-contained goal>'`.
5. Observe with `beam status --json`; `beam attach` is human-only.
6. Return with `beam down --json`, then `beam integrate --yes --json`.
7. Purge only after integration: `beam kill --purge --json`.

## Hard rules

- Never start a second fresh handoff for a live record. Inspect or attach.
- Never copy harness credentials. Use interactive `beam login` on the target.
- Never purge before returned work is integrated or intentionally discarded.
- Never edit Beam state or return manifests to bypass an ownership refusal.
- Surface every failed check, refusal, and next command to the user.
