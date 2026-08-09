# beam — design

## The use case

> "I need to turn off my computer, but I want the agent to continue working on
> what I am doing."

1. **Leave.** Quit the local harness mid-task, run
   `beam up -m "keep going: finish the migration"`. beam mirrors the working
   directory to a sandbox server, ships the session transcript, and resumes the
   agent there with the steering message. Laptop off.
2. **Watch.** `beam attach` (ssh → tmux, the full TUI) from any machine, or
   `beam status` for a no-attach glimpse of the pane. omp users can ask the
   remote agent to run `/collab` and watch from a browser.
3. **Return.** `beam down`. The remote agent stops, the workspace delta-syncs
   back, and the grown transcript is re-imported into the local store. Resume
   locally and the conversation contains everything the agent did remotely.

The invariant: **session + workspace move as one unit, in both directions.**
Nothing is summarized or lossy — the literal transcript, the literal files.

## Architecture: three seams

```
beam CLI (Bun/TS, zero runtime deps)
  up · down · attach · status · ls · kill · doctor · init · targets
        │
        ├── SessionAdapter   what a "session" is for one harness
        │     omp · claude · codex
        │     locate / install / resumeArgv / collect
        │
        ├── Transport        how to reach the sandbox's shell + files
        │     ssh (v1 remote) · local (tests, container mounts)
        │     exec / syncUp / syncDown / sendFile / fetchFile
        │
        └── Runtime          where the agent process lives
              tmux: start / alive / peek / interrupt / kill / attach
```

- **SessionAdapter** (`src/session/types.ts`) — find the session for a cwd,
  place it on the target, produce the resume command, and import the grown
  transcript back. A new harness is one new adapter (~100 lines).
- **Transport** (`src/transport/types.ts`) — v1 remote is plain `ssh`/`rsync`/
  `scp`, so `~/.ssh/config` aliases, jump hosts, and keys work unchanged and
  the server needs no daemon. Other sandbox providers (docker exec, k8s exec,
  E2B/Fly/Modal provisioners) implement the same interface.
- **Runtime** (`src/runtime/tmux.ts`) — detached tmux: survives disconnects,
  attachable from anywhere, pane capture powers `beam status`, and on agent
  exit the pane drops to a shell so the aftermath stays inspectable.

Local state: `~/.beam/state.json` (one record per handoff). Config:
`~/.beam/config.json` (named targets). Both respect `BEAM_DIR`/`BEAM_HOME`
overrides, which is how tests isolate themselves.

## Key decisions

1. **Full workspace mirror, not git bundles.** rsync the entire dev folder —
   dirty tree, untracked files, `.env`, `.git`. Delta transfer makes re-ships
   cheap. Excludes via `.beamignore` + config. Caveat: build artifacts do not
   cross OS/arch; exclude `target/`, `node_modules/` when shipping from macOS
   to Linux and let the sandbox rebuild.
2. **The omp session rides inside the workspace.** It ships to
   `<workspace>/.beam/session.jsonl` with the JSONL header `cwd` rewritten to
   the remote path, so `omp --resume .beam/session.jsonl` needs no re-root
   prompt — and the growing transcript automatically rides the workspace rsync
   back on `beam down` (header rewritten back on import; previous local copy
   backed up). Claude/Codex sessions must live in their `~/.claude`/`~/.codex`
   stores remotely, so those adapters send/fetch explicitly.
3. **tmux is the process manager.** No daemon to install; `beam attach` is
   `ssh -t … tmux attach`.
4. **Kickoff prompt in the resume argv.** `beam up -m "…"` appends the message
   to the resume command so the agent starts working unattended.
5. **ssh is the server API.** Any box you can ssh into is a target. A richer
   backend (HTTP daemon, provisioning API) slots in later as another
   Transport+Runtime pair without touching commands.

## Session store formats (ground truth)

| Harness | Store | Resume |
|---|---|---|
| omp | `~/.omp/agent/sessions/<dir>/<ts>_<uuid>.jsonl`; `<dir>` is the dashed home-relative cwd (legacy) or `<scope>-<basename>-<sha256(cwd)>` (hashed); header line `{"type":"session",…,"cwd":…}`; sibling dir = artifacts | `omp --resume <path>` |
| Claude Code | `~/.claude/projects/<slug>/<uuid>.jsonl`; slug = abs cwd with `/` and `.` → `-` (older versions also dashed `_`) | `claude --resume <uuid>` from the cwd |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`; line 1 `session_meta` carries id + cwd | `codex resume <id>` |

Locating is defensive: omp tries both dir schemes, then falls back to scanning
store dirs for a matching header cwd; claude tries current + legacy slugs;
codex scans newest-first and parses `session_meta`.

## Risks and stances

- **Divergence** — resuming locally while a session is beamed advances both
  transcripts. `beam down` always backs up the local copy before overwriting.
  The intended workflow is stop-local-then-beam.
- **Secrets travel by design** — the target must be trusted like the laptop.
- **openrsync (macOS) vs GNU rsync** — conservative default flags (`-a -z`),
  per-target `rsyncFlags` override.
- **Harness auth on the server** is a one-time manual step (`omp`/`claude`/
  `codex` login). `beam doctor` reports which binaries are present.

## Later

- Docker-container-per-handoff runtime (same Runtime seam).
- Provisioning transports: spin up a sandbox on demand (E2B, Fly, Modal, k8s).
- `beam sync` — periodic bidirectional sync while the remote agent runs.
- A beam daemon + web dashboard for multi-user servers.
