# beam

Hand a live coding-agent session to a remote sandboxed server — and bring it
back. Supports **omp**, **pi**, **Claude Code**, and **Codex** sessions.

The use case: *you need to turn off your computer, but you want the agent to
continue working on what you're doing.*

```
laptop                                sandbox server (any ssh box)
──────                                ───────────────────────────
beam up -m "keep going"   ─────────►  workspace mirrored (rsync)
                                      session transcript installed
                                      agent resumed in detached tmux
        (laptop off)                  … agent keeps working …
beam attach / beam status ─────────►  watch or steer from anywhere
beam down                 ◄─────────  agent stopped, workspace synced back,
                                      grown transcript re-imported locally
omp --resume …                        continue exactly where the agent left off
```

Everything moves: the dirty tree, untracked files, `.git`, `.env` — and the
literal session transcript. Nothing is summarized or lossy. Linked
`git worktree` checkouts round-trip too: beam ships a materialized,
self-contained `.git` instead of the worktree's pointer file, and `beam
down` imports every remote commit, ref, stash, and staged byte back into
your repository before it purges the remote copy.

## Install

```bash
git clone https://github.com/bipa-app/beam && cd beam
bun install
bun link        # exposes `beam`
```

Requirements — local: [Bun](https://bun.sh), rsync, ssh. Server: sshd, rsync,
tmux, and the harness you use (`omp` / `pi` / `claude` / `codex`) installed.
Shipping a linked `git worktree` additionally needs `git` on the server.
Authenticate each harness **on the target** with `beam login` — beam never
copies credentials between machines.

> Self-hosting the sandbox? Read [docs/own-sandbox.md](docs/own-sandbox.md)
> — VM + OS Login + IAP, in-cluster + Tailscale, or the built-in
> `agent-sandbox` target for GKE Agent Sandbox clusters (configuration below).

### Least-privilege server setup

The ssh user you give beam **is the blast radius**: the mirrored tree
(secrets included) lands in its home, and the agent executes as it. Never
point beam at `root` or a sudo-capable login on a machine you care about.
`beam doctor` and `beam up` probe for the dangerous postures (root login,
passwordless sudo, workspace outside the user's home on an observably shared
box, a mounted Kubernetes ServiceAccount token, a mounted Docker socket) and
warn.

```bash
# on the server, once, as an admin — a dedicated, unprivileged user:
sudo adduser --disabled-password --gecos "" beam-agent
sudo -u beam-agent mkdir -p /home/beam-agent/.ssh
cat ~/.ssh/id_ed25519.pub | sudo -u beam-agent tee -a /home/beam-agent/.ssh/authorized_keys
# do NOT add beam-agent to the sudo group.
```

Needs docker? Membership in the `docker` group is root-equivalent on that
host — use rootless docker, or accept that this target must be a disposable
VM dedicated to beam. Managed sandbox providers (Daytona, E2B, Modal, …)
enforce this boundary for you; that is a real argument for them.

Pointing beam at Kubernetes? The `agent-sandbox` target's kubeconfig is the
blast radius — an explicit `kubeconfig` is REQUIRED (beam never falls back
to your ambient `~/.kube/config`). Give beam a ServiceAccount that can only
manage SandboxClaims and exec into pods in ONE namespace
(create/get/list/watch/delete claims; get sandboxes; get/list pods;
create pods/exec). `beam doctor` and `beam up` probe the credential with
`kubectl auth can-i` and REFUSE — fail closed, before any claim is created
— one holding any of these escape capabilities: cluster-wide claim
create/list/delete or exec/port-forward access; claim patch/update; Secret
access of any kind (get/list/watch/create/patch/update/delete/deletecollection);
plain pod create; pod patch/update; pods/attach, namespaced
pods/portforward, or ephemeral-container injection; create/patch/update/delete
on Sandboxes or SandboxTemplates; create/patch/update on workload
controllers (Deployments, StatefulSets, DaemonSets, ReplicaSets,
ReplicationControllers, Jobs, CronJobs); ServiceAccount token minting;
RBAC bind/escalate; impersonation. A probe that cannot be answered is
refused the same way — an admin kubeconfig in beam's hands gives the
beamed agent the same power. This is a denylist of known escape hatches,
not proof the role is minimal: bind the published beam Role rather than
trimming a wider one until the probes pass.

Claims bind by identity, not name: `beam up` records the created
SandboxClaim's UID, and every later command re-reads the claim and refuses
to wait on, exec into, or delete one that does not carry the exact name,
the `app.kubernetes.io/managed-by=beam` label, the configured template,
and that UID (the claim → Sandbox → pod owner chain is UID-verified too) —
a deleted-and-recreated claim under the same name is someone else's
workload. The delete itself carries a Kubernetes UID precondition (raw
`DeleteOptions` — kubectl has no high-level flag for it), so a claim
replaced mid-delete survives untouched and `beam kill <id> --purge` retires
the record without touching anything beam cannot prove it created.

## Quickstart

```bash
beam init                      # writes ~/.beam/config.json
$EDITOR ~/.beam/config.json    # point "host" at any ssh destination
beam doctor                    # verifies ssh, rsync, tmux, harnesses
beam login --tool omp          # authenticate the harness ON the target (one-time)

cd ~/work/my-project           # the project you're working on
# …quit your omp/claude/codex session…
beam up -m "continue the task: finish the API migration and run the tests"
# laptop off. later, from anywhere:
beam status                    # last lines of the remote pane
beam attach                    # full TUI over ssh (ctrl-b d to detach)
# when you're back:
beam down                      # stop remote agent, sync back, re-import session
omp --resume <printed path>    # continue locally with everything it did
```

## Commands

| Command | What it does |
|---|---|
| `beam init` | write a sample config |
| `beam targets` | list configured targets |
| `beam doctor [target]` | verify a target: transport, tools, harnesses, credential posture |
| `beam login [target]` | interactive harness login on the target (`ssh -t`, or `kubectl exec -it` for agent-sandbox; `--tool` to pick; credentials never travel) |
| `beam up` | ship workspace + session, resume the agent remotely (`-m` kickoff prompt, `--tool`, `--session`, `--target`, `--no-start`, `--no-session`, `--no-delete`, `-v`) |
| `beam ls` | list handoffs |
| `beam status [id]` | remote liveness + a glimpse of the pane |
| `beam attach [id]` | attach to the remote agent's tmux |
| `beam down [id]` | stop remote agent, sync workspace back, re-import the transcript, purge the remote copy (`--no-purge` keeps it; `--keep-remote` snapshots while it keeps running) |
| `beam kill [id]` | kill the remote agent (`--purge` also deletes the remote workspace) |

### In-session: `/beam` from inside your agent

Instead of quitting the harness first, install the thin integrations under
[`integrations/`](integrations/README.md): a `/beam` slash-command extension
for **omp**/**pi**, a `/beam-up` command for **Claude Code**, and a prompt for
**Codex**. They shell out to this CLI, wait for the agent to go idle, ship,
and (omp/pi) switch the local window to a fresh session so the shipped
transcript stops growing locally.

## Configuration

`~/.beam/config.json`:

```json
{
  "defaultTarget": "sandbox",
  "targets": {
    "sandbox": { "type": "ssh", "host": "my-sandbox", "root": "~/beam" },
    "k8s": {
      "type": "agent-sandbox",
      "context": "gke_bipa-278720_us-central1_satoshi-sandbox",
      "namespace": "beam-luiz",
      "template": "beam-coding",
      "kubeconfig": "/path/to/beam-user.kubeconfig",
      "root": "/data/beam"
    },
    "loopback": { "type": "local", "root": "/tmp/beam-root" }
  },
  "excludes": [".DS_Store"]
}
```

- `host` is any ssh destination — `~/.ssh/config` aliases, `user@host`, jump
  hosts and keys all work unchanged. The server needs no daemon: **ssh is the
  API**.
- `agent-sandbox` targets provision a GKE Agent Sandbox pod per handoff:
  `beam up` creates one namespaced SandboxClaim named `beam-<id>` from
  `template`, waits for it to become Ready, and reaches the pod through
  `kubectl exec` (tar streams — no sshd, no daemon, no open port). `context`,
  `namespace`, and the required explicit `kubeconfig` are pinned on every
  kubectl call; `container` defaults to `sandbox`. Re-running `beam up` for
  the same workspace reuses the claim (and refuses one that references a
  different template). `beam down` deletes the claim only after workspace
  and transcript are safely back (`--no-purge` / `--keep-remote` keep it;
  `beam kill <id> --purge` abandons it). Claim deletion is never trusted as
  storage erasure: the purge first removes the session files beam
  installed and `rm -rf`s the shipped workspace inside the pod, then
  deletes the claim — on persistent-home templates nothing beam put there
  outlives the handoff. Harness logins are still **template-dependent**:
  on ephemeral-pod templates they die with the claim (run `beam login` per
  sandbox); on persistent-home templates credentials you logged in stay
  until the volume is recycled.
- A `.beamignore` in the project root adds rsync exclude patterns for that
  project. The exclude set of every successful ship is remembered on the
  handoff record, and `beam down` honors the union of the recorded and the
  current set — so a path that never shipped (excluded on the way out)
  cannot be deleted locally by `beam down --delete` after you edit the
  excludes mid-handoff. Shipping from macOS to Linux? Exclude build
  artifacts — they don't cross OS/arch:

```
# .beamignore
target/
node_modules/
```

## How it works

- The workspace is mirrored with rsync (delta transfer — re-ships are cheap)
  on ssh/local targets, and as tar streams over `kubectl exec` on
  agent-sandbox targets (full copy per ship — the same mechanism as
  `kubectl cp`). Sync-down never deletes local files unless you pass
  `--delete`.
- `.git` never rides the workspace mirror, even when the local directory is
  not yet a repository. A sandbox-created `.git` may contain executable
  config and hooks, so Beam leaves it remote instead of copying it home.
- Every Git workspace ships self-contained. `beam up` keeps both standard
  `.git` directories and linked-worktree pointer files out of the workspace
  mirror, then materializes a standalone `.git` — same HEAD (attached branch,
  including an unborn branch, or detached commit), every shared ref
  (branches, tags, remote-tracking refs, `refs/replace`, `refs/notes`, custom
  namespaces, and the full stash stack with its order — only Beam bookkeeping
  and worktree-internal refs stay home), your remotes and local config minus
  local-path config (filesystem remotes, `submodule.*.url` paths, and URL
  rewrites naming a local path). Object alternates are absorbed so the
  payload owns its full history; staged changes replay as a binary patch, so
  remote `git status` matches home byte for byte. A materialization failure
  aborts before anything ships.
- `beam down` brings the remote **Git state** home losslessly before the
  default purge. Every Git layout ships through a standalone `.git`; the
  return rejects links and special files, removes remote config, hooks,
  common-dir/worktree pointers, and object alternates before local Git opens
  it, then verifies the inert repository whole (`git fsck`). Every
  remote-created object — commits, tags, stash commits, staged-only blobs —
  is imported, and then:
  - a `refs/{heads,tags,remotes}` ref only the REMOTE moved (or created) is
    applied exactly, with a compare-and-swap against its ship-time value — a
    concurrent local move always wins;
  - a ref that conflicts with local work (moved on both sides, deleted
    locally, checked out in a sibling worktree) — or any changed ref outside
    those namespaces (`refs/replace`, `refs/notes`, custom refs) — is
    **never overwritten or auto-applied**: the remote value is preserved at
    `refs/beam/return/<id>/values/…` instead (e.g.
    `refs/beam/return/<id>/values/heads/main`), and the down says so;
  - a ref the remote **deleted** is deleted locally the same way — only a
    `refs/{heads,tags,remotes}` ref that still sits at its ship-time value
    with no worktree holding it checked out; the shipped tip is kept at
    `refs/beam/return/<id>/deleted/…` either way, so the deletion stays
    recoverable after the purge, and a conflicting (or out-of-namespace)
    deletion keeps your local ref and just says so;
  - a remotely changed stash is preserved whole at
    `refs/beam/return/<id>/meta/stash` (older entries at `…/meta/stash-1..n`,
    order intact) — apply with `git stash apply <ref>`; an untouched shipped
    stash re-imports nothing;
  - before any return I/O, Beam verifies the device and inode of both the
    source common Git directory and this worktree's Git directory; a checkout
    deleted and re-created at the same path is a different repository and the
    down refuses it;
  - the worktree's HEAD, index (staged state), and any in-progress
    merge/rebase/cherry-pick/bisect are restored, so local `git status`
    matches the remote's final state byte for byte; if the checked-out
    branch conflicted, your HEAD stays exactly where it was and the remote
    HEAD commit is kept at `refs/beam/return/<id>/meta/HEAD`;
  - the exact pre-return HEAD state (attached, detached, or unborn) and staged
    tree are pinned first by the single create-only snapshot at
    `refs/beam/backup/<id>/state`; HEAD and index installation use Git's own
    lock files and compare against that snapshot or a prior Beam install, so
    concurrent local commits and staged work always win.
  The purge runs only after all of this is durably local and the worktree
  answers `git status`; an import failure aborts the down with the remote
  intact, and re-running `beam down` retries it. A local in-progress git
  operation in the worktree fails the down closed before anything is
  touched — finish or abort it first. Clean up `refs/beam/*` leftovers
  whenever you are done with them:
  `git for-each-ref --format='%(refname)' refs/beam | xargs -n1 git update-ref -d`.
- Limitations: submodules arrive as plain file trees (their `.git` links and
  object stores stay home), and sparse-checkout / skip-worktree layouts are
  refused before anything ships (`git sparse-checkout disable` to hand them
  off).
- omp/pi sessions are installed *inside* the workspace at
  `.beam/session.jsonl` with the transcript's recorded cwd rewritten to the
  remote path, so resume needs no prompts. `.beam` is beam-reserved: it never
  rides the filtered workspace mirror — the grown transcript and its
  artifacts are fetched back explicitly on `beam down` (and verified to
  belong to that handoff), so no exclude pattern can suppress them and no
  stale local scratch can pass for returned state (your previous local copy
  is backed up first). Claude Code and Codex sessions are placed into their
  `~/.claude` / `~/.codex` stores on the server and fetched back explicitly.
- The agent runs in a detached tmux session; it survives ssh drops, and when
  it exits the pane drops to a shell so you can inspect what happened.

See [docs/DESIGN.md](docs/DESIGN.md) for the full architecture.

## Extending

Four seams, all small interfaces:

- **New harness** → implement `SessionAdapter`
  (`src/session/types.ts`): locate the session for a cwd, install it on the
  target, produce the resume command, collect the grown transcript back.
- **New transport** (docker exec, …) → implement `Transport`
  (`src/transport/types.ts`): exec, sync up/down, send/fetch file.
- **New sandbox provider** (E2B/Fly/Modal/Daytona, …) → implement
  `SandboxProvider` (`src/provider/types.ts`): provision/connect/destroy
  yielding a Transport. ssh/local are the trivial provider; `agent-sandbox`
  owns a full claim lifecycle.
- **New process manager** → the tmux runtime (`src/runtime/tmux.ts`) is the
  template: start/alive/peek/interrupt/kill/attach.

## Security

`beam up` copies your working directory **as-is** — including `.env` files and
any secrets in the tree — to the target, and the harness on the target runs
with whatever credentials it is logged in with. Only beam to servers you trust
like your own laptop. `beam down` purges the remote workspace and any session
files beam installed by default, so nothing lingers after the work is home
(`--no-purge` opts out).

Remote workspace paths are held to **physical containment**: beam resolves the
configured `root` physically on the target, refuses any symlinked path
component below it, and only ever ships to / collects from / purges the proven
canonical directory. A workspace path pre-created as a symlink (or swapped for
one later) fails the operation before any byte moves in either direction, and
a purge refuses any path it cannot prove — deleting a sandbox is never trusted
as storage erasure, and `rm -rf` never follows a link out of the root.

## Development

```bash
bun test          # unit + full up/down round trip over the local transport
bunx tsc --noEmit # typecheck
```

MIT.
