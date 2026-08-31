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
   checkout, and harness session store remain unchanged. `beam integrate`
   itemizes the return, confirms, re-proves the ship-time local base, and
   applies it. The remote stays retained until explicit purge.

The invariant: **session + workspace move as one unit, losslessly, in both
directions.** Outbound they mirror; on return they are collected and
verified — the literal transcript, the literal files — and nothing is ever
silently applied over live local state.

## Architecture: four seams

```
beam CLI (Bun/TS, zero runtime deps)
  up · down · integrate · attach · status · ls · kill · check · setup · skill
        │
        ├── SessionAdapter   what a "session" is for one harness
        │     omp · pi · claude · codex
        │     locate / install / resumeArgv / collect
        │
        ├── SandboxProvider  the lifecycle above a transport
        │     static (ssh, local) · managed SSH (Box, E2B, Modal, Daytona)
        │     agent-sandbox (GKE SandboxClaims)
        │
        ├── Transport        how to reach the sandbox's shell + files
        │     ssh/rsync · kubectl exec (tar streams) · local (tests)
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
  `StaticProvider` because the machine already exists. Box, E2B, Modal, and
  Daytona own one provider resource per handoff; `agent-sandbox` owns one
  SandboxClaim. Commands only talk to this seam — no target-type branching
  outside it.
- **Transport** (`src/transport/types.ts`) — Box, E2B, Modal, Daytona, and raw
  SSH use `ssh`/`rsync`/`scp`. Managed providers supply a pinned key or
  short-lived access token plus re-resolved coordinates; raw targets retain
  normal `~/.ssh/config` aliases, jump hosts, and keys. The kubectl transport
  reaches an Agent Sandbox pod over `kubectl exec` with tar streams for files:
  no sshd, no open port, context/namespace/kubeconfig pinned on every argv.
  Sync-down never deletes local files unless `--delete`, and a
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
   moves out of band as a self-contained standalone `.git` (decision 13).
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
5. **ssh is the data-plane API.** Any server you can ssh into is a static
   target. Managed provisioning stays above that interface: Box, E2B, Modal,
   and Daytona own lifecycle and supply SSH coordinates, while commands and
   the runtime remain unchanged.
6. **Retain by default; destruction is separate and explicit.** `beam down`
   collects everything and RETAINS the remote workspace and sandbox: the
   record stays `up` and reusable, and down has no destructive flag. This
   makes the collection/validation boundary honest: no write a detached
   process lands after collection can be destroyed by a routine return.
   Once the staged return is inspected and integrated, `beam kill <id>
   --purge` is operator-authorized abandonment of every remaining remote
   byte. It does not collect or claim fingerprint safety; it kills the pane,
   removes installed session traces, erases the contained workspace, and
   destroys provisioned resources. Claim or VM deletion is never trusted as
   storage erasure because persistent snapshots and volumes can outlive it.
   Cleanup is checked, and an unreachable sandbox whose record resolved a
   remote cwd fails with the record and resource intact — with one narrow
   exception: when BOTH owner-bound cleanup receipts are already journaled
   (workspace emptied, traces cleaned), the only step a crash can have lost
   is provider deletion or its terminal write. A managed provider may then
   delete only the exact persisted identity: Agent Sandbox uses a pinned
   claim UID; Box, E2B, and Daytona use immutable provider IDs; Modal uses an
   owned Sandbox name plus exact tags and a Volume owner marker. Absence
   converges to `killed`; a replacement or API failure retains. Static
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
   that pair. Non-exclusive providers host distinct workspaces concurrently;
   managed providers give each one its own resource. `beam up` also journals
   the exclude set of every successful ship on the record;
   `beam down` unions it with the
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

9. **Box is managed lifecycle over the existing SSH transport.** `beam init`
   chooses a zero-option Box target. `BoxProvider` runs the documented
   `box --json` protocol: it persists the opaque ID on the `created` line
   before waiting for `ready`, re-reads `box info` on every connect, resumes
   a stopped VM, and never persists an IP. It asks `box ssh <id> -- true` to
   establish the CLI-managed key, then uses `SshTransport` with
   `IdentitiesOnly`, batch mode, `accept-new`, and `HostKeyAlias=<box-id>`;
   rsync receives the same options through `--rsh`. Provisioning verifies and
   installs pinned herdr plus rsync in one remote bootstrap. Omitted
   `ttlSeconds` means `--no-auto-stop`; trials can set 7200. Purge first
   erases Beam-owned bytes, then permanently deletes the exact Box.
   Exclusively owned snapshots go with it; named snapshots and forks created
   outside Beam may retain shared storage and remain the operator's cleanup.
   The CLI rather than `@asciidev/box-sdk` is deliberate: it preserves zero
   runtime dependencies, browser onboarding, and managed SSH keys.

10. **E2B is REST lifecycle plus its documented WebSocket SSH proxy.**
    `E2bProvider` uses built-in `fetch`, not a runtime SDK. Before any API
    effect it persists a random owner token and the SHA-256 fingerprint of a
    per-handoff Ed25519 key. Creation sends the configured template, auto-pause
    policy, and exact `beam.owner` / `beam.record` metadata; crash recovery
    lists by those values before creating anything. Every connect re-reads the
    exact sandbox ID, template, and metadata, then resumes it through
    `/connect`. `SshTransport` reaches the template's port 8081 proxy through
    local `websocat`, pins `HostKeyAlias` to the sandbox ID, and uses only the
    managed key. Purge verifies identity, deletes that ID, then removes the
    local private key. The custom template owns sshd readiness and must place
    the injected public key in `authorized_keys`.

11. **Modal separates replaceable compute from an owned durable Volume.**
    `ModalProvider` drives the authenticated Modal CLI through one bounded
    temporary Python bridge, preserving the zero-runtime-dependency rule. It
    persists an owner token, deterministic Sandbox/Volume names, and the
    per-handoff key fingerprint before remote effects. A named Sandbox carries
    exact owner/record tags; a V2 Volume mounted at `/root` carries an exact
    owner marker. The marker earns a `volumeOwned` receipt before Beam may
    adopt or delete it. Modal's 24-hour Sandbox ceiling is unavoidable, so a
    later connection recreates expired compute around the same Volume and
    reboots pinned herdr when the ephemeral Sandbox ID changes. A raw TCP
    tunnel exposes key-only SSH, with `HostKeyAlias` pinned to that compute
    ID. Purge verifies tags and marker, terminates compute, deletes the owned
    Volume, then removes the local key.

12. **Daytona lifecycle stays behind its authenticated CLI.**
    `DaytonaProvider` persists a random owner token and deterministic name
    before creation, labels the sandbox with owner/record identity, disables
    automatic pause/archive/delete/TTL, and pins the returned immutable ID.
    Every connect and destroy re-read exact ID, name, and labels. The current
    CLI does not expose SSH coordinates directly: `daytona ssh` resolves a
    short-lived token and executes `ssh`. Beam supplies a temporary capture
    executable in `PATH`, accepts only the two documented argv shapes, and
    passes the parsed token destination to `SshTransport` without persisting
    it. A stopped sandbox is started with bounded status polling. Purge deletes
    only the verified ID.


Managed setup is provider-owned (`src/provider/setup.ts`): commands request a
plan or apply it but never branch on provider type. Release builds also pin one
immutable `ghcr.io/bipa-app/beam-coding@sha256:…` identity into the executable.
E2B templates, Modal sandboxes, and Daytona snapshots therefore use the image
published from the same release tag. Source builds must receive an explicit
immutable digest; setup refuses mutable tags and conflicting resources.

The public `https://beamai.sh/install` bootstrap detects the four release
platforms, downloads one binary plus `SHA256SUMS`, enforces byte and time
ceilings, verifies SHA-256, and smoke-runs the binary before replacing
`~/.local/bin/beam`. It never edits shell profiles or installs provider state.

13. **Every Git workspace ships a materialized standalone `.git` — and its
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
   stage is the user's to inspect and integrate. The manifest carries the
   exact effective exclude union and deletion license, so `beam integrate`
   reconstructs one itemized preview and protects every excluded local path.
   Applying over a live tree cannot be atomic; integration re-proves the
   ship-time local base after human confirmation and checks convergence after
   the apply. A writer observed by the base proof refuses; the caller must
   still quiesce local writers because one that starts after the final proof
   can race the non-atomic apply; (4) objects are imported WHOLESALE into the
   common repository — content-addressed and additive, packs before their
   indexes, each file published create-only
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

   `beam integrate` is the only first-class live-worktree writer. It holds
   the record operation lock, binds the latest manifest path through Beam's
   private-directory chain, verifies its state-journaled SHA-256 and staged
   tree fingerprint, then copies that proven return to a fresh immutable
   local source. It itemizes the exact rsync operation before confirmation.
   A non-empty apply proceeds only while the destination directory's
   device/inode and its filtered full-tree digest still match the completed
   `beam up`; a prompt causes that base proof to run again. The apply uses the
   manifest's exact excludes and deletion license, then an empty post-apply
   dry run proves convergence. Repeated integration is an empty, idempotent
   success. Local drift, stage drift, and legacy records without either pin
   refuse without a live-worktree write.

   Beam's local storage is private by construction: `BEAM_DIR` and every
   `returns/<record>/<txn>` parent is proven component-wise to be a real,
   process-owned directory (never a symlink) and closed to group/other
   (0700, retro-tightened when older runs created it wider); manifests and
   `state.json` receipts are 0600. A symlinked or foreign returns path
   refuses before a single byte is staged through it. Files INSIDE a staged
   workspace keep their transported modes — the 0700 ancestors are the
   disclosure boundary.


14. **Physical containment, proven on the target.** Every remote workspace
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

15. **The CLI is moving to Rust.** The port pins at `4fb7680`, grows side by
    side in `rust/`, and replaces the Bun/TS implementation at cutover.
    Behavior is the contract: the four seams, the generated remote shell,
    subprocess argv, persisted JSON shapes, and the `schemaVersion: 1` CLI
    envelope stay compatible, gated by parity goldens generated from the
    TypeScript implementation. See *Rust port (transition record)* below.

## Performance sketch (a budget, not a note)

Back-of-the-envelope, in slowest-resource-first order. The numbers are the
budget every change is measured against; the **bounds** are the invariants a
change may not break. Counts are from the `Transport.exec` / `syncUp` /
`syncDown` call sites, so they move when a phase moves — see *Keeping this
honest* below.

**Network — control plane.** One full round trip per `exec`: a fresh `ssh`
handshake or a fresh `kubectl exec` API call. Nothing is multiplexed or
reused, so per-call cost (tens to low hundreds of ms on a WAN) is paid every
time. Per command, branch-dependent: `check` ≤ 11 probes + ≤ 6 privilege
probes ≈ 17; `up` ≈ 15–20 (workspace establish, containment re-proofs,
fingerprint sandwiches, git pointer, session install, herdr start); `down`
≈ 15–25 (agent stop, git collect, stage probes, session collect, final
combined proof). At 150 ms per call that is ~2.5 s of pure handshake on an
`up`. **Bound: round-trip count is O(1) in workspace size, file count, ref
count, and transcript size — always.** A probe that scales with the tree
belongs inside one generated remote script (the workspace fingerprint is the
pattern), never in a loop of `exec` calls.

Managed providers add a bounded control plane before SSH:

- Box reconnects with `box info` plus key registration. A stopped Box adds
  `box resume` and at most `BOX_READY_ATTEMPTS_MAX` (300) one-second polls.
- E2B reconnects with one identity `GET` and one `/connect` request. Creation
  adds one metadata-filtered recovery list plus one create request.
- Modal runs one bounded bridge process per lifecycle operation; the bridge
  batches the SDK calls needed to find or create the named Sandbox and Volume,
  wait at most 300 seconds for SSH readiness, and resolve one tunnel.
- Daytona reconnects with one `info` plus one SSH-token command. A stopped
  sandbox adds one `start` and at most `DAYTONA_READY_ATTEMPTS_MAX` (300)
  one-second `info` polls.

These counts are O(1) in workspace and repository size. Fresh provision adds
one SSH bootstrap before the ordinary `up` sequence. Modal repeats that
bootstrap only when its replaceable compute ID changes.

`beam setup` adds only provider-CLI control-plane calls: one bounded
inspection in plan mode, then one re-inspection, one create, and one
verification in apply mode. It never provisions a handoff.

The public installer makes exactly two bounded HTTPS data transfers: one
binary of at most 128 MiB and one checksum manifest of at most 1 MiB. Each
connect may take at most 15 seconds and each transfer at most 300 seconds. It
writes one temporary binary beside the destination and replaces `beam` only
after checksum and execution proofs. These costs are O(1) in release count.

**Network — data plane.** Two transfers on `up` (workspace stage, `.git`
payload) plus explicit per-path session transfers; three on `down` (`.git`
quarantine, workspace stage, session collect). `integrate` is local-only: it
copies and fingerprints the returned stage once, runs one initial preview, and
runs up to two copy-plus-fingerprint local-base proofs (the second only after
an interactive prompt), one apply, and one convergence preview. Its temporary
source is one full returned workspace and is always reaped. Bytes on Box, E2B,
Modal, Daytona, and raw SSH
are approximately changed bytes (rsync delta) plus file-list overhead; on the
kubectl transport they are the **whole** tree, compressed, on every sync — an
ordinary re-ship costs a full copy and empties the destination first.
Kubectl bulk transfers stage ONE archive per direction, bind it to a
size+sha256 receipt, and retry the raw copy up to
`SYNC_ARCHIVE_ATTEMPTS_MAX` (6)
times before extracting — the GKE gVisor exec stream was measured
corrupting ~1 in 3 large transfers (2026-08-29), and extraction must only
ever read a verified archive. A Git workspace also ships its full object
closure (`clone --no-hardlinks --dissociate`), so
worst-case outbound ≈ workspace bytes + repository bytes, and a return
collects the same again. **Bound: one batched transfer per logical payload;
no per-file transfers. `beam up` refuses a filtered mirror larger than
`MAX_SHIP_BYTES` (2 GiB) before any remote effect — one local rsync
`--dry-run --stats` metadata walk, no bytes copied — unless `--allow-large`
explicitly licenses the ship (an unnoticed cargo `target/` once rode the
mirror for hours).**

**Peak buffered memory.** Hashing is O(1) in file size: `fileSha256` streams
through one reused 1 MiB buffer because workspace files and Git packs reach
gigabytes. `run()` captures up to `DEFAULT_MAX_OUTPUT_BYTES` (16 MiB) per
stream, and transcript reads load a whole JSONL into one string. **Bound:
peak resident buffers stay O(1) in workspace, repository, and transcript
size; every read whose size is tree-, agent-, or remote-controlled carries a
named `MAX_*` ceiling.** In force today: Box, E2B, Modal, and Daytona control
plane output is capped at 1 MiB; E2B HTTP calls time out after 120 seconds;
Box and Daytona readiness polling stop after 300 one-second attempts; Daytona
SSH argv capture is capped at 16 KiB; `MAX_REFLOG_TOTAL_BYTES` 32 MiB,
`MAX_REFLOG_TOTAL_LINES` 100 000, `MAX_REFLOG_UNIQUE_OIDS` and
`MAX_DANGLING_OBJECTS` 200 000, `MAX_REFLOG_ENUMERATED_FILES` 65 536,
`MAX_REFLOG_FILES` 4 096, `MAX_STASH_REFLOG_LINES` 4 096, and
`HEADER_SCAN_BYTES` 64 KiB. Known gaps, tracked in
`.planning/2026-08-09-tiger-style/findings.md`: the remote fingerprint
manifest (grows with remote file count), whole-transcript reads, and Codex
`locate`'s `CANDIDATE_SCAN_COUNT = 400` whole-file reads.

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

Managed providers add one isolated resource per active workspace. Box and
Daytona keep compute available until explicit purge; E2B auto-pauses after its
configured active timeout; Modal may stop compute after at most 24 hours but
retains the owned Volume. Retention prevents an unattended agent from stopping
mid-task where the provider permits it, but billing and stored state continue
until purge.

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
  `beam kill <id> --purge` to erase every Beam-managed remote trace.
- **openrsync (macOS) vs GNU rsync** — conservative default flags (`-a -z`),
  per-target `rsyncFlags` override.
- **Credentials never travel through Beam.** Beam refuses the
  "copy auth.json to the server" shortcut. Raw SSH and Agent Sandbox users
  authenticate on a reachable target via
  `beam login <target> --tool <harness>`. Box users configure credentials and
  setup in a Box Environment before creation. E2B templates, Modal images, and
  Daytona snapshots install the harness; a live handoff then accepts
  `beam login`. What survives resource replacement is provider-dependent:
  E2B memory snapshots, Modal's `/root` Volume, and Daytona's retained
  sandbox preserve login state; Agent Sandbox depends on its template.
  Beam's purge erases only the workspace and session files it installed, not
  credentials created outside them. Best-effort auth probes surface a login
  gap early; where a harness has no file-detectable auth state, the probe is
  absent rather than wrong.
- **The transport or provider credential is the blast radius.** For raw
  transports (SSH, kubectl) the sandbox boundary is whatever the operator
  configured — Beam cannot create isolation it was not given. Managed
  provider credentials stay local: Box, E2B, Modal, and Daytona credentials
  can create and delete account resources; E2B and Modal receive only a
  per-handoff public SSH key; Daytona's temporary SSH token is never
  persisted. The stance:
  - preach a paved path (README: dedicated unprivileged ssh user; dedicated
    provider project/workspace/organization; a beam-user ServiceAccount
    scoped to claim lifecycle + pods/exec in one namespace for agent-sandbox,
    behind a REQUIRED explicit kubeconfig);
  - probe provider authentication plus dangerous remote postures
    (`src/security.ts`: root login, passwordless sudo, workspace root outside
    the user's home when the box is observably shared, a mounted
    ServiceAccount token, a mounted Docker socket) in `check` and before
    every `up` — warn, never block, since compensating controls exist that
    Beam cannot see;
  - one exception blocks: the agent-sandbox provider REFUSES — fail closed,
    in both `check` and `beam up` before any claim is created — a
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
  Managed providers enforce the compute boundary vendor-side, but configured
  templates, images, snapshots, and account environments still define which
  secrets the agent receives. That is safer than hardening a shared raw
  server, not a reason to inject every account secret.

## Rust port (transition record)

Decided 2026-08-30, pinned at `4fb7680`. The beam CLI moves from Bun/TypeScript
to Rust; the TypeScript binary keeps shipping until the cutover gate passes.

**Why.** A static binary removes the one implicit runtime dependency operators
install today (Bun). Rust adds real integer widths (ending the
`Number.isSafeInteger` validation dance), exhaustive enums over the record
state machine, and compile-time exhaustiveness at every seam. The TypeScript
code is already async/await on one thread, so an async port on a
current-thread runtime is a near-1:1 transliteration — the lowest-risk
mapping. Performance is not the argument: cost lives in network round trips
and moved bytes (see the performance sketch), which a language cannot change.

**What does not change.** The four seams and their contracts. Remote logic
stays generated POSIX sh — the target runs bash, not beam. kubectl, ssh,
rsync, tar, git, and herdr stay subprocesses with pinned argv; kubectl's
stderr text is contract (NotFound/Conflict classification), so no native
Kubernetes client. Every security invariant in AGENTS.md. The
`schemaVersion: 1` JSON envelope, the flag surface, exit codes, and release
asset names.

**Dependency policy.** "Zero runtime dependencies" becomes "zero system
runtime dependencies, and a closed crate allowlist": tokio (current-thread;
features rt, process, io-util, time, signal, macros — never full), serde,
serde_json (preserve_order), sha2, hex, getrandom, rustix, ureq (rustls), and
tempfile. Growing the list is an architecture decision recorded here.
`cargo deny` gates advisories, licenses, sources, and bans in CI;
`Cargo.lock` is committed; `rust/deny.toml`'s license list grows only in the
PR that adds the dependency needing it.
**Rust style.** The beam Tiger rules re-derive for Rust at cutover. The port
adopts four bipa practices (`~/work/bipa/master/AGENTS.md`, `clippy.toml`) and
one Beam convention from day one as review law; the syn-based checker gates
rule 1 mechanically:

1. **Match enums exhaustively — spell out every variant, never `_`.** The
   compiler is the reviewer: adding a variant to `BeamStatus` or
   `TargetSpec` fails the build at every decision point, which is exactly
   the list a port reviewer needs. `==` and `matches!` carry no
   exhaustiveness guarantee; a comparison that decides something must be a
   real `match` on that path. Guards never discharge a variant.
2. **Tests panic with `expect`, not `unwrap`.** `rust/clippy.toml` sets
   `allow-unwrap-in-tests`/`allow-expect-in-tests`; the parity tests assert
   against golden literals, so `expect` with the case name is the panic
   equivalent of a bun:test assertion, not a production shortcut.
3. **`#[derive(Debug)]` only at a use site.** No reflexive derive on every
   struct; add it when a test or error path prints the value.
4. **Shallow over clever.** Fewer branches, fewer locals, fewer helper hops;
   a one-off helper that shuffles data between nearby lines is inlined
   (Tiger DX 10 orders reading; it never licenses wrappers that only rename
   an expression).
5. **Current stable, flat modules.** `rust-toolchain.toml` and
   `package.rust-version` pin the latest stable Rust (1.98.0 at this
   decision), with edition 2024. Module roots use `name.rs` and descendants
   use `name/child.rs`; `mod.rs` is never used. Prefer stable language and
   standard-library features available at the pin when they remove branches
   or boilerplate; never require nightly or rewrite clear code only to look
   new.

What is deliberately NOT adopted: bipa's money-path transaction rules
(`.agents/rules/`, Diesel disallowed-types) bind to a database beam does
not have, and its workspace/hook machinery assumes a multi-crate layout.
The port's allowlist policy stands on its own.

**Concurrency.** One current-thread runtime: no work stealing, no `Send`
infection, and the single-threaded reasoning the TypeScript code was written
under is preserved. Every await carries a timeout — the `MAX_*` ceiling
analogue at suspension points. Hashing stays inline: blocking the loop during
a fingerprint phase is behaviorally identical to today's `readSync` loops.
One licensed exception to Tiger Safety 11 ("run at your own pace"): a
user-entered watch phase (`beam status -w`, `beam ls -w`, building on the
herdr agent state API named in *Later*) may poll until the user stops it —
each tick is one bounded control-plane probe with a stated per-tick timeout
and an explicit interval.

The seam traits stay dyn-compatible because providers select their transport
at runtime. Rust 1.98 still excludes `async fn` and return-position opaque
futures from dyn-compatible traits, so each async seam method returns one
explicit `Pin<Box<dyn Future<…>>>`. That is one bounded allocation per async
seam invocation. Implementations share concrete internal futures so a checked
exec does not box its underlying control-plane call twice. This preserves
extension by implementation instead of widening callers and avoids an
`async-trait` dependency.

**Digest policy: drain before cutover.** No live handoff crosses binaries, so
no receipt or fingerprint is ever compared across implementations. That
licenses two deliberate fixes in the port: transcripts are hashed as raw
bytes (the TypeScript implementation hashes the lossy-UTF-8 decode), and
fingerprint composites move from JS `JSON.stringify` key order to one
canonical serialization.

**Mechanics.** The port grows in `rust/` (the crate moves to the repo root at
cutover, when `src/*.ts`, `scripts/check-style.ts`, `tsconfig.json`, and
`bun.lock` are deleted and AGENTS.md is re-derived for Rust). Parity goldens
generated from the TypeScript implementation gate every seam: generated shell
scripts byte-exact, quoting corpora, fingerprint composites, state-machine
transitions, and JSON envelopes. Port order: util → cli-output/config/state →
transports (local first — it is the hermetic test double) → session adapters
→ herdr runtime → workspace + workspace-git → providers → commands.
TypeScript changes landing after the pin are replayed from a commit ledger
before cutover. The cutover gate: the Rust e2e herdr round trip green on both
OSes, the style gate ported (rustfmt + clippy + a syn-based checker for the
bespoke rules), release assets built by cargo for the same four targets, all
live handoffs drained, then the PATH flip and TypeScript deletion in one
change.

**Current port boundary.** The Rust crate now reaches through all four session
adapters: OMP and Pi use the owner-bound, deterministic `.beam` install
transaction and exact artifact tree; Claude Code and Codex use the no-follow
home-store transaction. Every install and return re-proves transcript identity;
locators follow each harness's native store identity rules. Every return stays
under Beam-owned storage, and returned digests hash the fetched raw bytes. The
TypeScript golden pins adapter metadata, slugs, header rewrites, install keys,
and generated install/collection/cleanup shells byte-exact. Hermetic
local-transport tests cover locate, install, conflict refusal, return, cleanup,
permissions, links, and artifacts. Command orchestration is not yet ported, so
the TypeScript binary still owns every user-visible flow.

## Later

- More providers behind `SandboxProvider`: a `gce` provider (start/stop the
  own-sandbox VM around handoffs — see `docs/own-sandbox.md`) and Fly.
- Drive `beam status` from herdr's agent state API (`herdr agent list` /
  `herdr agent get`): structured working/blocked/idle for every handoff
  instead of a pane-text glimpse.
- `beam sync` — periodic bidirectional sync while the remote agent runs.
- A beam daemon + web dashboard for multi-user servers.
