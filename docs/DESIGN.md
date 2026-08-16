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

## Architecture: four seams

```
beam CLI (Bun/TS, zero runtime deps)
  up · down · attach · status · ls · kill · doctor · init · targets
        │
        ├── SessionAdapter   what a "session" is for one harness
        │     omp · pi · claude · codex
        │     locate / install / resumeArgv / collect
        │
        ├── SandboxProvider  the lifecycle above a transport
        │     static (ssh, local) · agent-sandbox (GKE SandboxClaims)
        │     sandboxState / provision / connect / destroy / doctor
        │
        ├── Transport        how to reach the sandbox's shell + files
        │     ssh (v1 remote) · kubectl exec (tar streams) · local (tests)
        │     exec / syncUp / syncDown / sendFile / fetchFile
        │
        └── Runtime          where the agent process lives
              tmux: start / alive / peek / interrupt / kill / attach
```

- **SessionAdapter** (`src/session/types.ts`) — find the session for a cwd,
  place it on the target, produce the resume command, and import the grown
  transcript back. A new harness is one new adapter (~100 lines).
- **SandboxProvider** (`src/provider/types.ts`) — create the place a handoff
  ships to, rebind to it later, tear it down. ssh/local are the trivial
  `StaticProvider` (the machine already exists; provision = the transport).
  `agent-sandbox` owns one SandboxClaim per handoff record. Commands only
  talk to this seam — no target-type branching outside it.
- **Transport** (`src/transport/types.ts`) — v1 remote is plain `ssh`/`rsync`/
  `scp`, so `~/.ssh/config` aliases, jump hosts, and keys work unchanged and
  the server needs no daemon. The kubectl transport reaches an Agent Sandbox
  pod over `kubectl exec` with tar streams for files (the `kubectl cp`
  mechanism): no sshd, no open port, context/namespace/kubeconfig pinned on
  every argv. Sync-down never deletes local files unless `--delete`, and a
  kubectl mirrored (`--delete`) sync-down is licensed by a remote marker
  that attests only to the latest COMPLETED syncUp attempt: every ship
  invalidates it as its first remote action and re-earns it only on full
  success, so a failed re-ship never leaves a stale license.
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
   to Linux and let the sandbox rebuild. Linked `git worktree` checkouts get
   a materialized standalone `.git` instead of their pointer file (decision 9).
2. **The omp session lives inside the workspace; `.beam` moves out of band.**
   It installs to `<workspace>/.beam/session.jsonl` with the JSONL header
   `cwd` rewritten to the remote path, so `omp --resume .beam/session.jsonl`
   needs no re-root prompt. The reserved `.beam` dir is force-excluded from
   the filtered workspace mirror in both directions: the transcript and its
   artifacts travel over explicit per-path transfers instead, so no
   user/global exclude (`.beam/`, `*.jsonl`, `*`, …) can suppress or stale
   them, and `beam down` fetches the grown transcript straight off the
   target, refuses one whose header cwd is not this handoff's workspace,
   restores the header, and backs up the previous local copy. A
   remote-created artifacts dir is imported next to the store file even when
   none existed at ship time. Claude/Codex sessions must live in their
   `~/.claude`/`~/.codex` stores remotely, so those adapters send/fetch
   explicitly.
3. **tmux is the process manager.** No daemon to install; `beam attach` is
   `ssh -t … tmux attach`.
4. **Kickoff prompt in the resume argv.** `beam up -m "…"` appends the message
   to the resume command so the agent starts working unattended.
5. **ssh is the server API.** Any box you can ssh into is a target. A richer
   backend (HTTP daemon, provisioning API) slots in later as another
   Transport+Runtime pair without touching commands.
6. **Purge by default.** The mirror carries the whole working tree — secrets
   included — so `beam down` deletes the remote workspace and any session
   files beam installed outside it (claude/codex home stores) once everything
   is safely back. Once collection succeeds the record journals `purging`,
   so an interrupted cleanup is retried by repeating the idempotent remote
   erase — never by re-collecting over a fresher local transcript. Trace
   removal is checked (a failure aborts before the sandbox is destroyed),
   and the workspace `rm -rf` runs whenever the remote cwd actually
   resolved: destroying a sandbox is never trusted as storage erasure
   (persistent volumes outlive it), while a record whose cwd never resolved
   provably shipped nothing — skipping its rm keeps an abandoned handoff
   from wedging in `purging`. `--no-purge` trades that hygiene for faster
   re-ships; `--keep-remote` (still running) implies no purge. `kill
   --purge` covers the abandon path: it runs the same checked cleanup,
   journals `killing` once erasure is proven (or provably unnecessary), and
   only then deletes the claim — an interrupted destroy is retried
   destroy-only, and an unreachable sandbox whose record ever resolved a
   remote cwd FAILS the kill with the record and claim intact rather than
   deleting the claim under unerased storage. Adapters own their
   out-of-workspace traces via `cleanupRemote`.
7. **One owner per record, and a phase matrix for recovery.** `beam up`,
   `beam down`, and `beam kill` all take the record's operation lock
   (`op-<id>.lock`) across their whole remote-effect sequence and re-read
   the record under it, so a down can never collect a half-extracted tree
   mid-ship and a kill can never destroy a claim under a live up; a live
   owner is refused promptly. Each lifecycle state names its one legal
   recovery: `provisioning` is never collectable (`beam down` refuses —
   retry `beam up` or `beam kill <id> --purge`), `starting`/`up` collect,
   `purging`/`teardown` repeat only their idempotent cleanup/destroy,
   `killing` repeats only the destroy, and `down`/`killed` are terminal and
   monotonic. A retried `beam up` treats an answerable `starting` as a
   COMPLETED ship — the mirror, git payload, and session install all
   precede that journal write — so alive or dead it finalizes the record
   to `up` and never re-ships over it: a dead agent's recovery is
   `beam down`, the only path that brings the crash window's remote work
   home. Selection never guesses destructively: a no-ref `beam kill`
   refuses when more than one record still owns remote resources. One
   `(target, localCwd)` pair maps to one active record regardless of
   provider exclusivity — the remote workspace path is derived from exactly
   that pair — while non-exclusive targets (ssh/local) still host distinct
   workspaces concurrently. `beam up` also journals the exclude set of
   every successful ship on the record; `beam down` unions it with the
   current excludes, so a path excluded outbound (never shipped) can never
   be mirrored away locally by `--delete` after config/`.beamignore` drift.

8. **One claim per handoff record, created-if-absent.** The agent-sandbox
   provider names its SandboxClaim `beam-<record-id>` and persists the
   record *before* provisioning: a crash or Ready timeout leaves a handoff
   that `beam up` resumes (same claim, boot continues) and
   `beam kill <id> --purge` abandons — never an orphaned claim wedged against
   the namespace's one-claim quota. Creation is `get` + `create`, never
   `kubectl apply` — the least-privilege role has no patch/update. A claim
   beam is about to reuse — found by `get`, or surfaced by losing the create
   race to a concurrent process — is validated first: exact name
   (`beam-<record-id>`, which persisted state must also match exactly) and
   exact configured template, else beam refuses and names the record's
   `beam kill <id> --purge`. Pods are
   ephemeral and re-resolved from the claim (claim → Sandbox → pod) on every
   command; a stored pod name is never trusted. Teardown mirrors `down`'s
   order: sync/collect first, erase the workspace and installed traces,
   delete the claim last and only on the successful purge path
   (`--no-purge`, `--keep-remote`, or any failure keeps it). tar has no
   delta transfer, so re-ships are full copies and a mirrored ship empties
   the destination first — remote build artifacts inside the workspace do
   not survive a mirrored re-ship.

9. **Every Git workspace ships a materialized standalone `.git` — and its
   Git state round-trips losslessly.** A linked worktree's `.git` is a host
   path pointer; a standard checkout's `.git` contains config and hooks the
   sandbox must never copy back onto the host. `gatherExcludes` therefore
   keeps `.git` out of both workspace sync directions even when the local
   workspace is not yet a repository: a sandbox-created repository is
   untrusted return metadata, not ordinary workspace content. When
   `<cwd>/.git` is a file or directory, `beam up` builds a temp standalone
   Git dir instead:
   `git clone --no-hardlinks --no-checkout --dissociate` (the clone
   machinery carries objects and refs only — never the common dir's
   `worktrees/<sibling>/` state — and `--dissociate` absorbs any
   `objects/info/alternates` borrowing so the payload owns its full object
   closure instead of a dangling absolute alternate path), then an explicit
   restore of HEAD (attached branch, including an unborn branch, or detached
   SHA), EVERY trusted shared ref — branches, tags, remote-tracking refs,
   `refs/replace`, `refs/notes`, custom namespaces, and the stash (its
   full reflog stack travels verbatim, so `stash@{n}` order and messages
   survive; only `refs/beam/` bookkeeping and worktree-scoped internals
   stay home) — and the repo's local config minus machine-layout
   keys (`core.*`, `extensions.*`, `worktree.*`, `include.*`, `safe.*`) and
   every path-bearing form (filesystem remote URLs in absolute,
   `~`-relative, `./`, or bare-relative shape; `submodule.*.url` local
   paths; `url.<base>.insteadOf`/`pushInsteadOf` rewrites where either side
   names a local path — multi-valued keys keep their surviving values);
   clone reflogs and the clone-path `origin` are erased so no local path
   travels, and the staged `.git/info/exclude` ignores `.beam/`. The index
   is seeded from HEAD (or the empty tree while unborn) and the staged delta
   rides as a binary patch (`git diff --cached --binary --full-index`)
   applied on the target with `git apply --cached --binary` — the shipped
   patch is removed whether the apply succeeds or fails, and any failure
   aborts before the agent starts. A ship-time ref snapshot
   (`beam-shipped-refs`) pinning every shipped shared ref (the stash stack
   below the tip as `refs/stash@{n}` pseudo-entries) rides inside the payload.
   The persisted ship identity (`wtGit`) records optional HEAD, branch, the
   absolute common and worktree Git dirs, and bigint-safe device+inode pairs
   for both dirs.
   Materialization is fatal-first: it runs before ANY remote side effect
   (provisioning included), so a worktree whose Git state cannot travel never
   half-ships; sparse-checkout and skip-worktree layouts are refused there
   (they cannot round-trip faithfully — the payload would present a full
   checkout and the return would clobber the
   sparse index); temp state is cleaned up on every outcome. Retried
   `provisioning` records re-run those local guards BEFORE
   `provider.provision`, so an unshippable retry never creates a scarce
   sandbox claim it then refuses to use, and a re-ship of a prior Git
   handoff first probes the remote `.git` for the same
   in-progress-operation marker set with checked transport semantics (a
   transport failure throws — it is never read as "no operation") and
   refuses before any outbound byte: that operation state exists only in
   the remote `.git` a mirrored re-ship would replace, and `beam down` is
   its way home. Submodules arrive as plain trees — their `.git` links and
   object stores stay home.

   The RETURN (`beam down`, `src/workspace-git.ts`) makes remote Git state
   lossless before the default purge, in this order: (1) fail-closed local
   guards BEFORE any local or remote mutation — both Git directory paths and
   device+inode identities must still match the ship, with no local
   in-progress operation or sparse state. A single create-only snapshot
   commit at `refs/beam/backup/<id>/state` pins the exact local HEAD state
   (attached, detached, or unborn), staged tree, and any HEAD commit; retries
   accept only this state or checkout state a prior Beam import published as
   its own install; (2) the remote standalone `.git` is collected into a
   local temp quarantine; links and special files are rejected; remote
   config, hooks, common-dir/worktree pointers, and object alternates are
   removed; and only then does local Git verify the inert bare repository
   whole with `git fsck --cache` (torn transfers abort here, remote intact);
   (3) objects are imported WHOLESALE into the common repository —
   content-addressed,
   additive, atomic per file, packs before their indexes — which carries
   staged-only blobs and dangling commits a fetch would drop; (4) every
   remotely CHANGED ref (diffed against the shipped snapshot) is first
   recorded under the DISJOINT durable subtrees of
   `refs/beam/return/<id>/` — remote values at `values/…`, deletion
   tombstones at `deleted/…`, repo-state snapshots at `meta/…`, so no
   hostile remote-only ref name (`refs/deleted/heads/x`, `refs/HEAD/meta`)
   can shadow another artifact — then applied only when safe AND only in
   the `refs/{heads,tags,remotes}` namespaces: compare-and-swap against
   the shipped base for moved refs, create-if-absent for new refs, and
   never applied when the ref moved locally, was deleted locally, is
   checked out in a sibling worktree, or the snapshot is missing —
   conflicts and every other shared namespace (replace, notes, custom)
   stay in `values/…` quarantine, and cleanly applied refs drop their
   redundant quarantine entry; a shipped ref the remote DELETED is
   deleted locally under the same compare-and-swap (only in the
   auto-applied namespaces, only while still at the shipped value and
   checked out nowhere), its shipped tip first tombstoned at
   `refs/beam/return/<id>/deleted/…` so the deletion is recoverable
   after the purge — a conflicting or out-of-namespace deletion keeps
   the local ref, with tombstone and note only; the stash is never
   merged — an untouched stack (recognized by its snapshot pins)
   re-imports nothing, and any remote stash work preserves the remote's
   entire final stack, order intact, under
   `refs/beam/return/<id>/meta/stash[-n]`; (5) checkout provenance is
   published before effect in `beam-installed-checkout-<id>`, then HEAD and
   the exact index are installed through Git's own `HEAD.lock` / `index.lock`
   protocol after rechecking them against the pre-return snapshot or a prior
   Beam install. A local commit, checkout, staged change, or competing Git
   lock makes the return fail closed. HEAD reattaches only when its branch
   safely adopted the remote position; otherwise local HEAD stays untouched
   and the remote commit remains at `refs/beam/return/<id>/meta/HEAD`.
   In-progress merge/rebase/cherry-pick/bisect state is restored separately,
   with SHA-bearing files verified against the imported store — and what will
   be installed is first reconciled against, then published over, a durable
   per-record manifest in the worktree git dir
   (`beam-installed-opstate-<id>`, one digest + name per entry, written
   atomically even when empty): a marker a prior partial import provably
   installed that the remote no longer carries is deleted only while
   byte-for-byte what that import recorded; anything diverged refuses before
   the first deletion, and names outside the known op-state sets are never
   deleted; (6) the worktree must answer `git status`. Only then may the purge
   run — any failure aborts with the remote intact, and a retry converges.
   Records without the ship-time directory identity and legacy partial backup
   layouts refuse; Beam never guesses which local repository should receive
   remote Git state.

10. **Physical containment, proven on the target.** Every remote workspace
    path must be a strict *physical* descendant of the configured root —
    lexical checks cannot see symlinks, and on a reusable sandbox the
    deterministic workspace path can be pre-created as a symlink to any
    writable directory. `beam up` therefore establishes the workspace ON the
    target (`src/workspace.ts`): the root is resolved physically
    (`cd && pwd -P` — root-level symlinks are trusted config and
    canonicalize, e.g. `/data` → a mount), every component BELOW the root is
    no-follow territory (any symlink refuses, even one pointing back inside
    the root — a swapped workspace must never silently ship, collect, or
    purge a sibling), and the workspace must resolve to itself. A
    pre-existing symlink at the workspace path fails the ship before any
    local byte leaves. What the record persists is the CANONICAL physical
    path, and every later operation — sync in either direction, staged-patch
    extraction, session install/collect/cleanup, and purge — re-proves
    no-follow containment of exactly that path immediately before acting, so
    a path swapped after establishment is refused instead of followed. The
    purge runs its containment proof and the `rm -rf` in the SAME remote
    shell; an unprovable path refuses (the record stays retryable) and only
    a provably absent workspace lets an idempotent retry finish. Transports
    add a same-shell no-follow guard on their own destructive step (`tar
    -C`/`find -delete`/rsync destination), closing the exec-to-exec window.
    The checks are plain POSIX shell, so ssh, kubectl, and the local
    transport stay symmetric, `~/` roots included.

## Session store formats (ground truth)

| Harness | Store | Resume |
|---|---|---|
| omp | `~/.omp/agent/sessions/<dir>/<ts>_<uuid>.jsonl`; `<dir>` is the dashed home-relative cwd (legacy) or `<scope>-<basename>-<sha256(cwd)>` (hashed); header line `{"type":"session",…,"cwd":…}`; sibling dir = artifacts | `omp --resume <path>` |
| pi | `~/.pi/agent/sessions/<dir>/<ts>_<uuid>.jsonl`; `<dir>` = the absolute cwd wrapped in dashes with `/` → `-` (`/a/b` → `--a-b--`); same JSONL header as omp | `pi --resume` is a picker only; beam ships into a private dir and runs `pi --session-dir .beam/pi-sessions --continue "<kickoff>"` |
| Claude Code | `~/.claude/projects/<slug>/<uuid>.jsonl`; slug = abs cwd with `/` and `.` → `-` (older versions also dashed `_`) | `claude --resume <uuid>` from the cwd |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`; line 1 `session_meta` carries id + cwd | `codex resume <id>` |

Locating is defensive: omp tries both dir schemes, then falls back to scanning
store dirs for a matching header cwd; claude tries current + legacy slugs;
codex scans newest-first and parses `session_meta`.

## Risks and stances

- **Divergence** — resuming locally while a session is beamed advances both
  transcripts. `beam down` always backs up the local copy before overwriting.
  The intended workflow is stop-local-then-beam.
- **Secrets travel by design** — the target must be trusted like the laptop,
  and `beam down` purges the remote copy by default so nothing lingers.
- **openrsync (macOS) vs GNU rsync** — conservative default flags (`-a -z`),
  per-target `rsyncFlags` override.
- **Credentials never travel.** beam refuses the "copy auth.json to the
  server" shortcut on principle: the session moves, the user re-authenticates
  on the target via `beam login <target> --tool <harness>` (interactive over
  `ssh -t`, or `kubectl exec -it` on agent-sandbox targets). What outlives an
  agent-sandbox claim is template-dependent: with ephemeral pods, auth dies
  with the claim; with a persistent home, logins survive — beam's purge
  erases the workspace and session files it installed before the claim is
  deleted, but not credentials the user created.
  Best-effort auth probes in `beam doctor` and `beam up` surface a login gap
  early; where a harness has no file-detectable auth state (omp), the probe
  is absent rather than wrong.
- **The transport credential is the blast radius.** For raw transports (ssh,
  kubectl) the sandbox boundary is whatever the operator configured — beam
  cannot create isolation it was not given. The stance:
  - preach a paved path (README: dedicated unprivileged ssh user; a
    beam-user ServiceAccount scoped to claim lifecycle + pods/exec in one
    namespace for agent-sandbox, behind a REQUIRED explicit kubeconfig);
  - probe for dangerous postures (`src/security.ts`: root login,
    passwordless sudo, workspace root outside the user's home when the box
    is observably shared, a mounted ServiceAccount token, a mounted Docker
    socket) in `doctor` and before every `up` — warn, never block, since
    compensating controls exist that beam cannot see;
  - one exception blocks: the agent-sandbox provider REFUSES — fail closed,
    in both `doctor` and `beam up` before any claim is created — a
    credential holding any of the enumerated escape capabilities:
    cluster-wide claim create/list/delete, claim patch/update, any Secret
    access (get/list/watch/create/patch/update/delete/deletecollection),
    plain pod create, pod patch/update, pods/attach, cluster-wide pods/exec,
    pods/portforward anywhere (beam is exec-only), ephemeral-container
    injection, create/patch/update/delete on Sandboxes or SandboxTemplates,
    create/patch/update on workload controllers (Deployments, StatefulSets,
    DaemonSets, ReplicaSets, ReplicationControllers, Jobs, CronJobs),
    ServiceAccount token minting, RBAC bind/escalate, impersonation
    (`kubectl auth can-i`; subresources probed via `--subresource=`, since
    kubectl ≥1.36 answers the `pods/exec` spelling incorrectly). An
    unanswerable probe is refused the same way — that is an admin
    kubeconfig, and a beamed agent would inherit it. The check is a
    denylist of known template/secret/cluster escape hatches, not proof of
    minimality — the paved path is binding the published beam Role.
  - the agent-sandbox provider also binds every operation to claim
    IDENTITY, not name: the created claim's metadata.uid is persisted on
    the record, every command re-reads the claim and requires the exact
    name + `app.kubernetes.io/managed-by=beam` label + configured template
    + that UID before any exec/wait/delete (the claim → Sandbox → pod
    owner chain is UID-verified as well), and the claim delete carries a
    UID precondition through the raw DeleteOptions API. A same-name
    foreign, replaced, or recreated claim is never connected to, never
    deleted, and never named as a destructive-remediation target —
    `beam kill <id> --purge` retires the record while leaving such a claim
    untouched.
  Managed providers (Daytona, E2B, Modal) enforce the boundary vendor-side,
  which stays an argument for more provider implementations over
  ever-fancier raw-transport hardening.

## Later

- More providers behind `SandboxProvider`: a `gce` provider (start/stop the
  own-sandbox VM around handoffs — see `docs/own-sandbox.md`), box.ascii.dev
  (native ssh + snapshot/fork, CLI `--json`, zero new deps — parked as the
  managed-provider experiment), Daytona, E2B.
- A `herdr` Runtime (github.com/herdrdev/herdr) beside tmux: structured
  working/blocked/idle state for `beam status` via its socket API, and
  reattach lands in an agent dashboard instead of a bare pane.
- `beam sync` — periodic bidirectional sync while the remote agent runs.
- A beam daemon + web dashboard for multi-user servers.
