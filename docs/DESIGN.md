# beam — design

## The use case

> "I need to turn off my computer, but I want the agent to continue working on
> what I am doing."

1. **Leave.** Quit the local harness mid-task, run
   `beam up -m "keep going: finish the migration"`. beam mirrors the working
   directory to a sandbox server, ships the session transcript, and resumes the
   agent there with the steering message. Laptop off.
2. **Watch.** `beam attach` (ssh → herdr, the full TUI) from any machine, or
   `beam status` for a no-attach glimpse of the pane. omp users can ask the
   remote agent to run `/collab` and watch from a browser.
3. **Return.** `beam down`. The remote agent stops, and the returned
   workspace AND grown transcript are collected, verified, and persisted as
   a local stage under `~/.beam/returns/<id>/<txn>/` — the live repository,
   checkout, and harness session store are left byte-for-byte unchanged, and
   the remote copy is retained. Inspect and integrate the workspace stage
   (beam prints the exact path and command) and resume the session straight
   off the returned transcript (omp/pi) or via the printed manual import
   (Claude Code/Codex): the conversation contains everything the agent did
   remotely.

The invariant: **session + workspace move as one unit, losslessly, in both
directions.** Outbound they mirror; on return they are collected and
verified — the literal transcript, the literal files — and nothing is ever
silently applied over live local state.

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
              herdr: start / alive / peek / interrupt / kill / attach
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
- **Runtime** (`src/runtime/herdr.ts`) — one named herdr session per handoff:
  survives disconnects, attachable from anywhere, pane reads power
  `beam status`. `start` wraps the agent argv in a `.beam/agent-start.sh`
  script typed into the pane's shell, so the pane prints a
  `[beam] agent exited ($code)` marker and returns to a shell on exit — the
  aftermath stays inspectable.

Local state: `~/.beam/state.json` (one record per handoff). Config:
`~/.beam/config.json` (named targets). Both respect `BEAM_DIR`/`BEAM_HOME`
overrides, which is how tests isolate themselves.

## Key decisions

1. **Full workspace mirror, not git bundles.** rsync the dev folder — dirty
   tree, untracked files, `.env` — while `.git` always stays out of the
   filtered mirror. When the source is a Git workspace, its trusted state
   moves out of band as a self-contained standalone `.git` (decision 9).
   Delta transfer makes re-ships cheap. Excludes via `.beamignore` + config.
   Caveat: build artifacts do not cross OS/arch; exclude `target/` and
   `node_modules/` when shipping from macOS to Linux and let the sandbox
   rebuild.
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
3. **herdr is the process manager.** One pinned static binary, no daemon to
   hand-configure; sessions carry structured agent state
   (working / blocked / idle), each handoff gets a named session, and
   `beam attach` is `ssh -t … herdr session attach`.
4. **Kickoff prompt in the resume argv.** `beam up -m "…"` appends the message
   to the resume command so the agent starts working unattended.
5. **ssh is the server API.** Any box you can ssh into is a target. A richer
   backend (HTTP daemon, provisioning API) slots in later as another
   Transport+Runtime pair without touching commands.
6. **Retain by default; destruction is separate and explicit.** `beam down`
   collects everything and RETAINS the remote workspace and sandbox: the
   record stays `up` and reusable, and down has no destructive flag. This
   makes the collection/validation boundary honest: no write a detached
   process lands after collection can be destroyed by a routine return.
   Once the staged return is inspected and integrated, `beam kill <id>
   --purge` is operator-authorized abandonment of every remaining remote
   byte. It does not collect or claim fingerprint safety; it kills the pane,
   removes installed session traces, erases the contained workspace, and
   destroys provisioned resources. Claim deletion is never trusted as
   storage erasure because persistent volumes can outlive it. Cleanup is
   checked, and an unreachable sandbox whose record resolved a remote cwd
   fails with the record and claim intact — with one narrow exception:
   when BOTH owner-bound cleanup receipts are already journaled (workspace
   emptied, traces cleaned), the only step a crash can have lost is the
   claim delete or its terminal write, and the agent-sandbox provider
   finishes that delete by pinned UID alone — absence converges to
   `killed`, a same-name replacement or API failure retains. Static
   targets have no managed lifecycle and always refuse unreachable purges.
   Once erasure completes, the
   record journals `killing` before provider destruction, so an interrupted
   destroy retries destroy-only. Records whose cwd never resolved provably
   shipped nothing and may enter that destroy-only phase without a
   transport. Adapters own out-of-workspace traces via `cleanupRemote`.
7. **One owner per record, and a phase matrix for recovery.** `beam up`,
   `beam down`, and `beam kill` all take the record's operation lock
   (`op-<id>.lock`) across their whole remote-effect sequence and re-read
   the record under it, so a down can never collect a half-extracted tree
   mid-ship and a kill can never destroy a claim under a live up; a live
   owner is refused promptly. Each lifecycle state names its one legal
   recovery: `provisioning` is never collectable (`beam down` refuses —
   retry `beam up` or `beam kill <id> --purge`), `starting`/`up` collect,
   `killing` repeats only provider destruction, and legacy terminal
   `down`/`killed` records are monotonic. A retried `beam up` treats an
   answerable `starting` as a
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
   beam is about to reuse (found by `get`) is validated first: exact name
   (`beam-<record-id>`, which persisted state must also match exactly),
   exact configured template, and the record's pinned UID — else beam
   refuses and names the record's `beam kill <id> --purge`. Losing the
   create race to a concurrent creator always refuses: the racing record
   has no pinned UID yet, and an unpinned record adopts nothing. Pods are
   ephemeral and re-resolved from the claim (claim → Sandbox → pod) on every
   command; a stored pod name is never trusted. Destruction belongs only to
   `beam kill <id> --purge`: it erases the workspace and installed traces,
   then deletes the claim. The default down and every return failure retain
   it. tar has no
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
   stay home) — and the repo's local config minus machine-layout keys
   (`core.*`, `extensions.*`, `worktree.*`, `include.*`, `safe.*`), every
   credential-bearing family (credential helpers, HTTP/LFS auth and cookies,
   mail passwords, proxy commands), URLs with embedded credentials, and
   every local path-bearing form (filesystem remote URLs in absolute,
   `~`-relative, `./`, or bare-relative shape; `submodule.*.url` local paths;
   `url.<base>.insteadOf`/`pushInsteadOf` rewrites where either side names a
   local path — multi-valued keys keep their surviving values). Clone
   reflogs and the clone-path `origin` are erased so no local path travels,
   and the staged `.git/info/exclude` ignores `.beam/`. The payload carries
   the source index FILE itself, byte for byte, so intent-to-add,
   assume-unchanged, REUC, and extended flags all survive — split-index
   shards travel beside it and are collapsed in the temp repository, and
   cache-only path-bearing extensions (untracked cache, fsmonitor) are
   stripped there, never from the source. A workspace with no index file is
   seeded from HEAD instead, or explicitly empty while HEAD is unborn. There
   is no sidecar patch and no second source of index truth, and any failure
   aborts before the agent starts. A ship-time ref snapshot
   (`beam-shipped-refs`) pinning every shipped shared ref (the stash stack
   below the tip as `refs/stash@{n}` pseudo-entries) rides inside the
   payload. The persisted ship identity
   (`wtGit`) records optional HEAD, branch, the absolute common and worktree
   Git dirs, bigint-safe device+inode pairs for both dirs, create-only
   identity tokens, and the ref-snapshot digest.
   Fresh materialization is fatal-first: it runs before any remote side
   effect, so a worktree whose Git state cannot travel never half-ships;
   sparse-checkout and skip-worktree layouts are refused (the payload would
   present a full checkout and the return would clobber the sparse index);
   temp state is cleaned up on every outcome. The payload also carries a
   source verifier over HEAD, index, refs, stash, config, layout, and both
   repository identities. `beam up` runs it after any long sandbox boot,
   immediately before the workspace mirror, and again after that mirror
   before the static `.git` payload lands. A change fails closed instead of
   pairing current workspace bytes with stale Git state. Retried
   `provisioning` records re-run local guards before `provider.provision`,
   while a re-ship of a prior Git handoff first probes the remote `.git` for
   the same in-progress-operation marker set with checked transport
   semantics (a transport failure throws — it is never read as "no
   operation"). The old completed `wtGit` identity remains recorded until
   the pre-sync verifier passes; the next identity is journaled only after
   the workspace mirror and its second check. Submodules arrive as plain
   trees — their `.git` links and object stores stay home.

   The RETURN (`beam down`, `src/workspace-git.ts` + `src/workspace.ts`)
   makes remote Git state lossless WITHOUT ever mutating the live local
   worktree or checkout, in this order: (1) fail-closed local identity
   guards BEFORE any remote read — both Git directory paths, device+inode
   identities, and create-only tokens must still match the ship; (2) the
   remote `.git` is collected into a local temp quarantine and proven to be
   ONE stable remote snapshot (byte fingerprint before == after == over the
   collected copy, with any foreign Git lock refusing the probe); links and
   special files are rejected; remote config, hooks, common-dir/worktree
   pointers, and object alternates are removed; and only then does local
   Git verify the inert bare repository whole with `git fsck --cache` (torn
   transfers abort here, remote intact). The collected `.git` must also
   carry this record's pinned ship-time ref-snapshot and stash-reflog
   identity tokens byte-for-byte — a deleted-and-recreated workspace or a
   swapped-in unrelated repository refuses before anything else happens;
   (3) the remote WORKTREE is staged through the transport's own exclude
   engine into a create-only transaction under `<beamDir>/returns/<record>/
   <txn>/workspace`. A full filtered-namespace probe immediately before the
   stage transfer, the staged tree itself, and a fresh probe immediately
   afterward must all carry the same byte fingerprint (content, symlink
   targets, AND permission modes; a chmod-only remote change mismatches).
   This also cross-checks against the Git fingerprint: a detached writer or
   a commit landing between collections refuses, so neither a torn worktree
   nor a worktree/Git pair that never coexisted is persisted. After the
   session collection — the longest transfer of the return — one FINAL
   combined proof re-fingerprints the mirrored namespace and the collected
   `.git` (and re-runs the plain-origin `.git`-absent check, which also
   runs before and after the agent stop: a repository created at any point
   in a plain return would be silently omitted by the git-excluding
   mirror). Only then is the proven stage sealed with a `manifest.json`
   receipt; a stage without one is never trusted, and a txn root that
   already journaled a session receipt is retained as retry evidence. The
   stage is the user's to inspect and
   integrate. The exact printed `rsync` argv carries the same effective
   exclude union as collection/fingerprinting, so `--delete` protects every
   locally excluded path. Applying over a live tree cannot be made atomic,
   so beam never does it, and a racing local editor can never lose a byte
   to a down; (4) objects are imported WHOLESALE into the common repository
   — content-addressed and
   additive, packs before their indexes, each file published create-only
   via link(2) after streaming-digest verification, so concurrent imports
   into one common repository converge on identical content and refuse
   divergent content with the destination untouched — carrying
   staged-only blobs and dangling commits a fetch would drop; (5)
   EVERYTHING else lands append-only under
   `refs/beam/return/<id>/<collected-fingerprint>/` — a namespace keyed by
   the exact collected payload-tree fingerprint, so retries of one
   snapshot converge onto identical refs while any different later
   collection (including one restored to the ship baseline) opens its own
   namespace: no pin from an earlier collection is ever overwritten or
   presented as current, and no moving "latest" pointer exists — the notes
   of the last successful down name the only current namespace, whose
   immutable `manifest` blob maps every source ref to its state relative
   to the ship and to its pin, plus HEAD and the stash. Nothing lands
   ANYWHERE else: no local branch, tag,
   remote-tracking ref, HEAD, index, or operation state is ever created,
   moved, deleted, or installed (a forced sibling checkout — or a sibling's
   unborn HEAD naming an absent branch — can adopt any branch name at any
   instant, so no branch write is race-free; beam therefore makes none).
   Within a namespace, remote values live at
   `values/<sha256(source-ref)>/value` (hashing keeps hostile or
   case-colliding names inert; the manifest reverses the hash); remote
   deletions keep the local ref and land
   tombstones at `deleted/…` (same shape); the remote stash stack is
   preserved whole and in order at `meta/stash[-n]`; the remote HEAD commit
   at `meta/HEAD` (unborn symbolic targets as blobs at `meta/HEAD-symref`)
   and the exact returned index under `meta/state`; remote reflogs are
   captured in quarantine (strict grammar, exact SHA width, hard caps,
   every referenced object proven present) and preserved as raw blobs at
   `meta/reflogs/…` with durability pins batched through one
   `update-ref --stdin` run — reflog-referenced objects at
   `meta/reflog-pins/<oid>` and every collected object unreachable from all
   durable roots at `meta/object-pins/<oid>` — so the wholesale import of
   (4) survives `git reflog expire --expire=now --all` + `git gc
   --prune=now`. All of it is BOUND to the proven directories: the process
   enters the worktree git dir (device+inode plus create-only token proven
   through the handle itself), every effect resolves relative to that cwd
   or through `--git-dir=.`, and every common-repository effect runs inside
   a proof-gated transition into the proven common dir — a same-path
   replacement or a re-parented git dir is refused, never written to;
   (6) the remote is RETAINED. Any failure anywhere aborts with the remote
   intact and the record retryable; retries are convergent because every
   local Git effect is append-only and content-addressed. In-progress Git
   operation state is preserved remotely and surfaced in the return notes;
   it is never installed into the local checkout. Records without the
   ship-time directory identity refuse; Beam never guesses which local
   repository should receive remote Git state.

   Plain-workspace returns use the identical create-only workspace stage,
   stability sandwich, manifest receipt, and no-live-worktree rule, simply
   omitting the Git collection/import phases. `beam down` NEVER erases
   remote state. After the user inspects and integrates the staged return,
   `beam kill <id> --purge` is a separate, explicit, irreversible
   abandonment: it performs checked containment/trace cleanup and provider
   destruction, but does not recollect or claim return-fingerprint safety.
   Detached or concurrent writes after the last down are discarded.

   Beam's local storage is private by construction: `BEAM_DIR` and every
   `returns/<record>/<txn>` parent is proven component-wise to be a real,
   process-owned directory (never a symlink) and closed to group/other
   (0700, retro-tightened when older runs created it wider); manifests and
   `state.json` receipts are 0600. A symlinked or foreign returns path
   refuses before a single byte is staged through it. Files INSIDE a staged
   workspace keep their transported modes — the 0700 ancestors are the
   disclosure boundary.


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
    extraction, session install/collect/cleanup, and explicit kill cleanup —
    re-proves no-follow containment of exactly that path immediately before
    acting, so a path swapped after establishment is refused instead of
    followed. `beam kill --purge` erases in TWO receipted phases, each of
    which runs its containment and exact-owner proof and its deletions in
    the SAME remote shell: Phase A empties the workspace but leaves the
    `.beam/owner` marker standing and verifies that exact end state; only
    the persisted receipt for that converged phase licenses Phase B (the
    marker release) — or a retry reading an absent/exactly-empty root as
    already erased. An unprovable path refuses (the record stays
    retryable), and a journaled kill intent alone never accepts a
    same-path empty replacement as purged. Transports
    add a same-shell no-follow guard on their own destructive step (`tar
    -C`/`find -delete`/rsync destination), closing the exec-to-exec window.
    The checks are plain POSIX shell, so ssh, kubectl, and the local
    transport stay symmetric, `~/` roots included.

## Performance sketch (a budget, not a note)

Back-of-the-envelope, in slowest-resource-first order. The numbers are the
budget every change is measured against; the **bounds** are the invariants a
change may not break. Counts are from the `Transport.exec` / `syncUp` /
`syncDown` call sites, so they move when a phase moves — see *Keeping this
honest* below.

**Network — control plane.** One full round trip per `exec`: a fresh `ssh`
handshake or a fresh `kubectl exec` API call. Nothing is multiplexed or
reused, so per-call cost (tens to low hundreds of ms on a WAN) is paid every
time. Per command, branch-dependent: `doctor` ≤ 11 probes + ≤ 6 privilege
probes ≈ 17; `up` ≈ 15–20 (workspace establish, containment re-proofs,
fingerprint sandwiches, git pointer, session install, herdr start); `down`
≈ 15–25 (agent stop, git collect, stage probes, session collect, final
combined proof). At 150 ms per call that is ~2.5 s of pure handshake on an
`up`. **Bound: round-trip count is O(1) in workspace size, file count, ref
count, and transcript size — always.** A probe that scales with the tree
belongs inside one generated remote script (the workspace fingerprint is the
pattern), never in a loop of `exec` calls.

**Network — data plane.** Two transfers on `up` (workspace stage, `.git`
payload) plus explicit per-path session transfers; three on `down` (`.git`
quarantine, workspace stage, session collect). Bytes on the ssh transport ≈
changed bytes (rsync delta) + file-list overhead; on the kubectl transport ≈
the **whole** tree, compressed, on every sync — tar has no delta, so a
re-ship costs a full copy and empties the destination first. kubectl bulk
transfers stage ONE archive per direction, bind it to a size+sha256
receipt, and retry the raw copy up to `SYNC_ARCHIVE_ATTEMPTS_MAX` (6)
times before extracting — the GKE gVisor exec stream was measured
corrupting ~1 in 3 large transfers (2026-08-29), and extraction must only
ever read a verified archive. A git workspace
also ships its full object closure (`clone --no-hardlinks --dissociate`), so
worst-case outbound ≈ workspace bytes + repository bytes, and a return
collects the same again. **Bound: one batched transfer per logical payload;
no per-file transfers. `beam up` refuses a filtered mirror larger than
`MAX_SHIP_BYTES` (2 GiB) before any remote effect — one local rsync
`--dry-run --stats` metadata walk, no bytes copied — unless `--allow-large`
explicitly licenses the ship (an unnoticed cargo `target/` once rode the
mirror for hours).**

**Peak buffered memory.** Hashing is O(1) in file size: `fileSha256` streams
through one reused 1 MiB buffer because workspace files and git packs reach
gigabytes. Everything else is where the risk lives — `run()` buffers each
subprocess's stdout/stderr whole, and transcript reads load a whole JSONL
into one string. **Bound: peak resident buffers stay O(1) in workspace, repo,
and transcript size; every read whose size is tree-, agent-, or
remote-controlled carries a named `MAX_*` ceiling.** In force today:
`MAX_REFLOG_TOTAL_BYTES` 32 MiB, `MAX_REFLOG_TOTAL_LINES` 100 000,
`MAX_REFLOG_UNIQUE_OIDS` and `MAX_DANGLING_OBJECTS` 200 000,
`MAX_REFLOG_ENUMERATED_FILES` 65 536, `MAX_REFLOG_FILES` 4 096,
`MAX_STASH_REFLOG_LINES` 4 096, `HEADER_SCAN_BYTES` 64 KiB. Known gaps,
tracked in `.planning/2026-08-09-tiger-style/findings.md`: the remote
fingerprint manifest (grows with remote file count), generic `run()` capture,
whole-transcript reads, and codex `locate`'s `CANDIDATE_SCAN_COUNT = 400`
whole-file reads.

**Disk.** Local per `up`: one immutable ship stage (≈ workspace bytes after
excludes) plus one temp standalone `.git` (≈ object closure), both removed on
every outcome. Local per `down`: one create-only stage under
`~/.beam/returns/<id>/<txn>/` (≈ remote workspace + collected `.git`), a
wholesale object import into the common repository, and append-only
`refs/beam/return/…` pins. Nothing is overwritten in place, so worst-case
local growth is one workspace plus one object closure per successful return,
retained until the user deletes the stage. `state.json` and `config.json` are
bounded by handoff-record count. Remote: one workspace + one `.git` payload +
the transcript. **Bound: no unbounded accumulation — every temp path is
cleaned on all outcomes, and retained stages are the user's explicit
inventory, never implicit growth.**

**CPU and subprocesses.** Beam is thin orchestration: cost is spawn count
plus sha256 over moved bytes. The stability proofs are deliberately
expensive — a git return fingerprints the workspace namespace three times
(pre-stage, staged tree, post-stage) and the `.git` twice, so hashing scales
linearly with returned bytes and that is the accepted price of proving one
coherent snapshot. **Bound: spawns per logical operation are O(1) — bulk git
work rides `update-ref --stdin`, `hash-object --stdin-paths`, or
`cat-file --batch-check`, never one spawn per ref, OID, or config key.**

**Keeping this honest.** The latency figures are estimates and must be
replaced by a measurement before they justify an optimization; the first
measurement to take is exec-call count per command plus the wall-clock split
between handshake and transfer. Update this section in the same PR that (a)
adds or removes a control-plane `exec` or a data transfer on any command
path, (b) introduces a buffer or read that is not O(1) in tree, repo, or
transcript size, (c) adds a transport whose data plane has different delta
semantics, or (d) changes a `MAX_*` ceiling.

## Session store formats (ground truth)

**omp** — store `~/.omp/agent/sessions/<dir>/<ts>_<uuid>.jsonl`, where `<dir>`
is the dashed home-relative cwd (legacy) or `<scope>-<basename>-<sha256(cwd)>`
(hashed); header line `{"type":"session",…,"cwd":…}`; a sibling dir of the
same name holds artifacts. Resume: `omp --resume <path>`.

**pi** — store `~/.pi/agent/sessions/<dir>/<ts>_<uuid>.jsonl`, where `<dir>`
is the absolute cwd wrapped in dashes with `/` → `-` (`/a/b` → `--a-b--`);
same JSONL header as omp. `pi --resume` is a picker only, so beam ships into
a private dir and runs
`pi --session-dir .beam/pi-sessions --continue "<kickoff>"`.

**Claude Code** — store `~/.claude/projects/<slug>/<uuid>.jsonl`, where the
slug is the absolute cwd with `/` and `.` → `-` (older versions also dashed
`_`). Resume: `claude --resume <uuid>` from the cwd.

**Codex** — store `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`;
line 1 `session_meta` carries the id and cwd. Resume: `codex resume <id>`.

Locating is defensive: omp tries both dir schemes, then falls back to scanning
store dirs for a matching header cwd; claude tries current + legacy slugs;
codex scans newest-first and parses `session_meta`.

## Risks and stances

- **Divergence** — resuming locally while a session is beamed advances both
  transcripts. `beam down` always backs up the local copy before overwriting.
  The intended workflow is stop-local-then-beam.
- **Secrets travel by design** — the target must be trusted like the laptop.
  The default `beam down` RETAINS the remote workspace (secrets included) so
  no concurrent write can be destroyed unseen. Once you have integrated the
  staged return — or accepted abandoning any later remote state — run
  `beam kill <id> --purge` to erase every remote trace.
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
    untouched. A record that predates the pin (no stored UID) can never
    prove an existing claim is its own — label and template say "a beam
    made this", never "this record made it" — so it authorizes nothing
    that exists: it may only create a provably absent claim (pinning the
    returned UID immediately) and otherwise fails closed, with the error
    naming the manual recovery (inspect, delete by hand if yours, then
    `beam kill --purge` retires the record).
  Managed providers (Daytona, E2B, Modal) enforce the boundary vendor-side,
  which stays an argument for more provider implementations over
  ever-fancier raw-transport hardening.

## Later

- More providers behind `SandboxProvider`: a `gce` provider (start/stop the
  own-sandbox VM around handoffs — see `docs/own-sandbox.md`), box.ascii.dev
  (native ssh + snapshot/fork, CLI `--json`, zero new deps — parked as the
  managed-provider experiment), Daytona, E2B.
- Drive `beam status` from herdr's agent state API (`herdr agent list` /
  `herdr agent get`): structured working/blocked/idle for every handoff
  instead of a pane-text glimpse.
- `beam sync` — periodic bidirectional sync while the remote agent runs.
- A beam daemon + web dashboard for multi-user servers.
