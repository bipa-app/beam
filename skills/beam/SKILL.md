---
name: beam
description: >
  Hand a live coding-agent session (omp, Claude Code, pi, Codex) to a remote
  sandbox with the beam CLI and bring it back. Use this whenever the user
  says "beam up", "beam down", "hand off this session", "continue this
  session remotely / in the sandbox / on the server", "park this session
  somewhere and keep working", or asks an agent to ship its OWN current
  session to a remote target. Also use it to recover a stuck or failed
  handoff: a target slot held by a stale handoff, an oversized ship, a torn
  git snapshot error, a remote agent sitting idle, or expired sandbox
  credentials. Prefer this skill over improvising with raw kubectl/ssh.
---

# beam — remote session handoff for coding agents

beam ships this workspace plus a harness session to a remote sandbox,
resumes the agent there under herdr, and later brings the grown transcript
and workspace back. One handoff owns one (workspace, target) pair; sandbox
targets are usually **exclusive** — one slot, so stale handoffs block new
ones.

```
beam ls                      # what exists, and who holds the slot
beam doctor [target]         # transport, tools, credential posture
beam up ...                  # ship + resume remotely
beam status <id>             # pod liveness + last agent output
beam attach <id>             # watch/steer (detach: ctrl+b q)
beam down <id>               # stop agent, stage the return locally
beam kill <id> --purge       # abandon and erase all remote state
```

## The golden path

Run these as separate steps and read each result — most "beam never
worked" reports are one skipped step below.

### 1. Preflight (cheap, do it every time)

- `beam ls` — if a handoff is already `up` for this workspace/target,
  do NOT run `beam up` again. Decide its fate first (step 6).
- `beam doctor <target>` — proves kubeconfig/ssh, rsync, herdr, and
  harness credential posture. A GKE auth error here means the local
  token expired: run `gcloud auth login` and retry doctor.

### 2. Keep build artifacts out of the mirror

beam ships the working tree as-is. A cargo `target/` or `node_modules/`
turns a 2-minute ship into hours (the kubectl transport has no rsync
delta — it re-ships whole trees) — and compiled artifacts are usually
dead weight anyway: a macOS/arm64 `target/` is invisible to cargo on a
Linux/amd64 sandbox, which rebuilds from scratch regardless. Keeping
build dirs in the ship only ever pays on a same-OS, same-arch target
(`--allow-large` exists for that). Before the FIRST `beam up` from a
workspace, write a `.beamignore` at its root (rsync patterns, one per
line):

```
/target
/node_modules
/.venv
```

`beam up` refuses mirrors over 2 GiB and names the largest directories —
follow its hint rather than passing `--allow-large` blindly.

### 3. Ship with a kickoff message — always

```
beam up --target <t> --tool omp --session <id-prefix> \
  -m 'Self-contained kickoff: what to do, how to verify, what done means.'
```

- **`-m` is not optional in practice.** Without it the remote agent
  resumes at an input prompt and idles forever — it looks exactly like
  "beam didn't work". Write the kickoff like a task brief for an agent
  with no access to you.
- Provisioning a cold sandbox can take up to ~25 minutes; a warm ship is
  2–10. Run `beam up` as a background/long-timeout command, never under a
  short exec ceiling. If it is interrupted mid-ship, just rerun the same
  `beam up` — it resumes the journaled attempt; never start a second one
  in parallel.
- Shipping your OWN live session: beam snapshots the session at ship
  time. Do not edit files while the ship stages (the coherence guard
  refuses a torn snapshot — if you see "workspace changed while it was
  being staged", stop local writes and retry once). After a successful
  up, the REMOTE copy is the working session; stop doing local work it
  will redo.

### 4. Verify the agent is actually working

`beam up` exiting 0 is not proof of progress. Run `beam status <id>` and
read the pane output:

- agent output advancing → good.
- a login prompt → credentials never travel with the ship; run
  `beam login <target> --tool <tool>` (interactive), then re-kick.
- an empty input box → it resumed without a kickoff. Interactively:
  `beam attach <id>` and type the task. Headless: a restart can NEVER
  apply a new `-m` (the journaled resume command replays verbatim — beam
  refuses a changed message), so run `beam down <id>`, then
  `beam kill <id> --purge`, then a fresh `beam up -m '<task>'`.

### 5. Bring the work back

```
beam down <id>
```

`beam down` is non-destructive: it stops the remote agent and stages the
returned workspace + transcript under `~/.beam/returns/<id>/<txn>/`,
printing the exact integration command and an
`omp --resume <staged session.jsonl>` hint. Nothing local is overwritten
until you run those. After integrating, free the slot:

```
beam kill <id> --purge
```

### 6. Don't park handoffs for days

Sandbox workspaces can live on tmpfs — a pod restart silently wipes them
while the claim still looks Ready. Collect (`beam down`) the same day
when possible. A week-old `up` handoff whose workspace evaporated will
refuse `beam down`; abandon it with `beam kill <id> --purge`.

## Failure playbook

| Symptom | Meaning | Action |
|---|---|---|
| `already up on <target>` | exclusive slot held | `beam status <id>`; stale → `beam down` (keep work) or `beam kill <id> --purge` (abandon) |
| `would ship N GiB (ceiling 2.0 GiB)` | build artifacts in mirror | add the named dirs to `.beamignore`, re-up |
| `workspace changed while it was being staged` | local writer during ship | stop writes (pause watchers/builds), retry once |
| `beam down: … is not the directory this handoff shipped from` | local repo identity changed since ship | if remote work matters, recover per error text; else `beam kill <id> --purge` |
| `beam kill --purge` fails at herdr / unreachable sandbox | pod gone or image drift | retry once; if the record never resolved a workspace it takes a destroy-only path and succeeds |
| kube auth errors on any command | expired GKE token | `gcloud auth login`, retry |
| remote omp reports port 1455 in use at login | gVisor image without IPv6 loopback (omp < 17.3.8) | use the device-code login flow instead of the callback flow |

## Hard rules for agents

- Never copy or ship harness credentials; `beam login` on the target is
  the only auth path.
- Never run two beam commands against the same handoff concurrently, and
  never `beam up` while another up for that record is in flight — attach
  or wait instead.
- `beam down` before `beam kill --purge` whenever remote work might
  exist; `--purge` erases all remote state unrecoverably.
- Treat `beam up` output as a checklist: it prints the attach, status,
  and return commands for the new handoff — surface them to the user.
