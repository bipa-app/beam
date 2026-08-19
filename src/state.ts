import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ensurePrivateBeamDir } from "./util/private-dir.ts";
import { unreachable } from "./util/invariant.ts";
import type { TargetSpec } from "./config.ts";
import type { BeamEnv } from "./env.ts";
import type { SandboxState } from "./provider/types.ts";
import type { ToolName } from "./session/types.ts";
import type { WtGitShipInfo } from "./workspace-git.ts";
import type { CollectReceipt } from "./session/collect-txn.ts";

/**
 * Handoff lifecycle. `provisioning`, `starting`, and `killing` are
 * in-flight phases that still own remote resources (and hold the target
 * reservation); only `up` is a completed live handoff.
 *
 * - `starting` is journaled before the remote runtime starts, so a retried
 *   `beam up` finalizes instead of re-shipping.
 * - `killing` is journaled by `beam kill --purge` once checked remote
 *   erasure is complete; retry repeats provider destroy only.
 *
 * Terminal states (`down`, `killed`) are monotonic. `down` remains readable
 * for records written by older Beam releases; current `beam down` always
 * retains the handoff as `up`, and only kill performs destruction.
 */
export type BeamStatus = "provisioning" | "starting" | "up" | "killing" | "down" | "killed";

/** Statuses that still own remote resources (and hence the target reservation). */
const ACTIVE: readonly BeamStatus[] = ["provisioning", "starting", "up", "killing"];


/** One shipped handoff. */
export interface BeamRecord {
  id: string;
  target: string;
  tool?: ToolName;
  sessionId?: string;
  /** Local store path of the shipped session (adapter collect target). */
  sessionFile?: string;
  /** omp: local artifacts dir shipped alongside the session. */
  artifactsDir?: string;
  localCwd: string;
  remoteCwd: string;
  /** Name of the handoff's herdr session on the target (`beam-<id>`). */
  runtimeSession: string;
  status: BeamStatus;
  createdAt: string;
  updatedAt: string;
  kickoff?: string;
  /**
   * True once the candidate remoteCwd was resolved on the target (`pwd`)
   * and persisted — only then can anything have shipped under it. Absent on
   * records from older beams; `isRemoteCwdResolved` infers those.
   */
  remoteCwdResolved?: boolean;
  /**
   * Snapshot of the target spec this handoff was created against. Every
   * later operation (repeated up, down, status, attach, kill, login) binds
   * through it, so editing the config (type/root/template) can
   * never retarget a live handoff. Absent only on records written by older
   * beams; remote operations refuse those (`recordSpec`) — the current
   * config cannot prove where they live. Read-only listings label them.
   */
  targetSpec?: TargetSpec;
  /** agent-sandbox: provider-owned resources backing this handoff. */
  sandbox?: SandboxState;
  /**
   * Whether this record's provider owns the whole target while active
   * (one sandbox claim per target). Persisted at creation so a later config
   * edit (agent-sandbox → ssh/local) can never create a second record
   * beside a live claim. Absent on older records; inferred from the
   * snapshot by `holdsTargetExclusively`.
   */
  exclusiveTarget?: boolean;
  /**
   * The effective outbound exclude set of the last SUCCESSFUL workspace
   * ship. Journaled only after `syncUp` returns, never by a failed attempt.
   * `beam down` unions it with the current excludes so a path that never
   * shipped (excluded on the way out) can never become a local `--delete`
   * victim after config/.beamignore drift.
   */
  syncedExcludes?: string[];
  /**
   * Present when this ship materialized a Git workspace's standalone `.git`.
   * `beam down` keys its quarantined Git return off this common-repository
   * identity and must finish the import before any purge.
   */
  wtGit?: WtGitShipInfo;
  /**
   * Git/plain layout, pinned atomically with the fresh reservation (from
   * side-effect-free detection) and re-journaled by every completed ship.
   * Unlike `wtGit`, this records the plain case explicitly, so a crashed
   * provisioning retry cannot pivot across layouts and strand or overwrite
   * remote Git state — and a materialize failure before any remote effect
   * never strands a record without a layout pin.
   */
  workspaceKind?: "git" | "plain";
  /**
   * Immutable pending-generation journal for EVERY up (plain and Git),
   * written BEFORE the first remote byte of the attempt it describes. It
   * carries the strict full-tree digest of the staged workspace mirror,
   * the attempt's STAGED session bundle (tool + id + the Beam-private
   * stage dir holding the exact transcript/artifacts copy the attempt
   * installs, pinned by transcript digest, artifacts fingerprint, and one
   * combined bundle digest), and — for Git ships — the full ship identity
   * (generation included), the byte-level payload fingerprint, and the
   * exact `.git` pointer bytes. A provisioning retry NEVER rematerializes,
   * NEVER re-syncs, and NEVER re-reads the live harness store: each phase
   * is proven create-only / exact-accept on the target (licensed workspace
   * upload matching the journaled digest, published pointer matching the
   * journaled payload) and the session installs from the journaled stage
   * after re-proving it against these digests — live-store drift after the
   * bundle was staged is irrelevant, a tampered or missing stage fails
   * closed. Cleared ONLY by the final `up` write, atomically with the
   * completed-generation promote (which also reaps the stage dir).
   */
  shipPending?: {
    workspaceDigest: string;
    /**
     * True ONLY after the exact stage-vs-live publish proof of THIS
     * journaled generation: the workspace mirror landed in the reserved
     * upload stage, the create-only publish walked it into the live root,
     * and the remote full-tree fingerprint came back equal to
     * `workspaceDigest`. It licenses a provisioning retry whose reserved
     * stage is already reaped to SKIP the re-upload and re-prove the LIVE
     * root against the journaled digest instead; while the stage still
     * exists the retry re-converges and re-publishes it regardless of
     * this flag (the publish is idempotent through its exact-accept
     * EEXIST path). Never set by a failed or unproven attempt.
     */
    workspaceInstalled?: boolean;
    session?: {
      tool: ToolName;
      id: string;
      /**
       * Beam-private immutable stage dir (`<beamDir>/ship-stage/<id>/<hex>`)
       * holding the exact transcript (+ artifacts tree) this attempt
       * installs — the ONLY session source any retry may read.
       */
      stage: string;
      /** sha256 of the staged transcript bytes. */
      digest: string;
      /**
       * Staged artifacts tree fingerprint (byte/mode/symlink manifest —
       * `workspaceReturnFingerprint`), or null when the session ships none.
       */
      artifacts: { digest: string; entries: number } | null;
      /** sha256 binding transcript digest + artifacts digest into one bundle identity. */
      bundleDigest: string;
    };
    git?: { shipInfo: WtGitShipInfo; payloadDigest: string; pointer: string };
  };
  /**
   * Random ownership token persisted create-only BEFORE the first remote
   * effect of a fresh handoff. The remote workspace's `.beam/owner` is
   * created atomically with exactly `beam-workspace-v1 <id> <token>`;
   * every later establish of this record requires those exact bytes back.
   * A deterministic path that exists without them — legacy, foreign, or
   * another record's — is never adopted.
   */
  workspaceToken?: string;
  /**
   * The exact argv the ship's session install produced for resuming the
   * remote agent, journaled with the `starting` status write. It lets a
   * later `beam up` on a retained handoff whose agent has exited restart
   * the agent IN PLACE — zero sync, zero install, no local byte shipped
   * over the retained remote work.
   */
  resumeArgv?: string[];
  /**
   * Durable pointer to the latest collected session return
   * (`<beamDir>/returns/<id>/<txn>/session`): exact returned transcript
   * digest, artifacts tree, raw remote digest, and the resume/import hint.
   * Journaled only after the return is fully staged and stability-proven,
   * and it PERSISTS after a completed down — the local harness store is
   * never mutated, so the receipt is the one authoritative reference to
   * what came back.
   */
  collect?: CollectReceipt;
  /**
   * Persisted kill phases, journaled with the `killing` intent and bound
   * to the record's exact owner bytes. The purge is TWO receipted phases
   * so a journaled intent alone can never license accepting an absent or
   * empty workspace as erased:
   *
   *   - `workspaceContentsPurged` flips only after Phase A converged: one
   *     owner-pinned shell erased every byte EXCEPT the exact
   *     `.beam/owner` marker and verified that exact end state.
   *   - `sessionTracesCleaned` flips only after the adapter's checked
   *     remote-trace cleanup.
   *   - `workspaceReleased` flips only after Phase B — which runs ONLY
   *     under a persisted `workspaceContentsPurged` receipt — re-proved
   *     the emptied layout and unlinked the owner marker.
   *
   * Receipts are convergence evidence for THIS record's own crashed
   * phases: they authorize a retry to read the absent/exactly-emptied
   * states its own earlier phases provably produced. They NEVER replace
   * the current owner proof when the target is reachable — a reachable
   * workspace with content still demands the exact marker bytes, and a
   * foreign or marker-less replacement refuses regardless of receipts.
   */
  killReceipt?: {
    owner: string;
    workspaceContentsPurged: boolean;
    sessionTracesCleaned: boolean;
    workspaceReleased: boolean;
  };
}

interface StateFile {
  records: BeamRecord[];
}

export function loadState(env: BeamEnv): StateFile {
  const path = join(env.beamDir, "state.json");
  if (!existsSync(path)) return { records: [] };
  const bytes = readFileSync(path, "utf8");
  const recover = "restore it from a backup, or delete it to forget every recorded handoff";
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`beam: state file ${path} is not valid JSON (${why}) — ${recover}`);
  }
  if (typeof parsed !== "object" || parsed === null || !("records" in parsed)) {
    throw new Error(
      `beam: state file ${path} is malformed — expected a {"records": [...]} object; ${recover}`,
    );
  }
  const records: unknown = parsed.records;
  if (!Array.isArray(records)) {
    throw new Error(
      `beam: state file ${path} is malformed — "records" is not an array; ${recover}`,
    );
  }
  // Per-record fields are trusted past this boundary: state.json is
  // beam-private (0600, atomic rename) and record discriminants are still
  // checked where they are switched on. One read-time migration: records
  // written before the herdr runtime named the session field `tmux`.
  for (const record of records) {
    if (typeof record !== "object" || record === null) continue;
    const rec = record as Record<string, unknown>;
    if (rec.runtimeSession === undefined && typeof rec.tmux === "string") {
      rec.runtimeSession = rec.tmux;
    }
  }
  return { records: records as BeamRecord[] };
}

function saveState(env: BeamEnv, state: StateFile): void {
  ensurePrivateBeamDir(env.beamDir);
  const path = join(env.beamDir, "state.json");
  // Write-then-rename: a concurrent reader (or a crash mid-write) never
  // sees a torn state.json. Records carry ownership tokens and collect
  // receipts — created 0600, and the rename carries that mode over any
  // looser pre-existing file.
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Parse a lock file's owner pid. Only the two byte-shapes beam has ever
 * written are recognized: `<pid> <nonce>\n` (current — the 16-hex random
 * nonce makes every acquisition's bytes unique, so a pid-reusing successor
 * can never be mistaken for a predecessor) and bare `<pid>` (legacy,
 * pre-nonce). Anything else — including empty — is residue, never an owner.
 * Zero and negative pids are never owners either: `process.kill(0, …)`/
 * `kill(-n, …)` signal process GROUPS, so probing them "succeeds" forever
 * and a garbage lock would deadlock every future beam.
 */
function parseLockOwner(bytes: string): number | undefined {
  const m = /^(\d{1,15}) [0-9a-f]{16}\n$/.exec(bytes) ?? /^(\d{1,15})$/.exec(bytes);
  if (!m) return undefined;
  const owner = Number(m[1]);
  return owner > 0 ? owner : undefined;
}

const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 25;
/** Consecutive identical spaced re-reads before unrecognized content counts as stable residue. */
const RESIDUE_CONFIRM_READS = 2;

/**
 * What this process knows about one lock file: the exact bytes plus the
 * identity (dev+ino) of the inode the pathname named when they were read.
 * Release re-proves this identity right before unlinking, so it can never
 * delete a successor's lock published at the same path.
 */
export interface LockIdentity {
  path: string;
  bytes: string;
  dev: number;
  ino: number;
}

/** A fully written, fsynced lock inode not yet visible at its destination. */
export interface StagedLock extends LockIdentity {
  stagePath: string;
}

/**
 * Stage a lock: write full pid+nonce bytes to a unique same-directory file
 * and fsync them. The destination pathname is untouched — no observer can
 * reach this inode until {@link publishStagedLock} links it, and by then
 * its bytes are complete and never mutated again. (Exported only for
 * deterministic pause-mid-publish tests.)
 */
export function stageLock(path: string): StagedLock {
  const nonce = randomBytes(8).toString("hex");
  const bytes = `${process.pid} ${nonce}\n`;
  const stagePath = `${path}.stage.${process.pid}.${nonce}`;
  const fd = openSync(stagePath, "wx");
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
    const { dev, ino } = fstatSync(fd);
    return { path, bytes, dev, ino, stagePath };
  } catch (err) {
    rmSync(stagePath, { force: true });
    throw err;
  } finally {
    closeSync(fd);
  }
}

/**
 * Publish a staged lock with `link(2)` — atomic and create-only, so the
 * destination transitions in a single namespace effect from absent to a
 * lock holding full owner identity; a partial lock can never exist there.
 * Returns the owned identity, or undefined when another process holds the
 * destination. The stage name is removed either way. (Exported only for
 * deterministic pause-mid-publish tests.)
 */
export function publishStagedLock(staged: StagedLock): LockIdentity | undefined {
  try {
    linkSync(staged.stagePath, staged.path);
  } catch (err) {
    rmSync(staged.stagePath, { force: true });
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw err;
  }
  rmSync(staged.stagePath, { force: true });
  return { path: staged.path, bytes: staged.bytes, dev: staged.dev, ino: staged.ino };
}

/**
 * One consistent observation of the lock at `path`: bytes and inode
 * identity are read through the same fd, so they describe the same inode
 * even while the pathname churns. Undefined when no lock exists.
 */
function observeLock(path: string): LockIdentity | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    const { dev, ino } = fstatSync(fd);
    return { path, bytes: readFileSync(fd, "utf8"), dev, ino };
  } finally {
    closeSync(fd);
  }
}

/** Same lock? Exact bytes AND the same inode behind the pathname. */
function sameLock(a: LockIdentity, b: LockIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.bytes === b.bytes;
}

/**
 * Whether unrecognized lock content is stable residue (same inode, same
 * bytes across spaced re-reads) rather than a transient glimpse. Link-
 * published locks are never partial, so residue only comes from a pre-nonce
 * beam or outside interference — but a single read is still never trusted.
 */
function isStableResidue(obs: LockIdentity): boolean {
  for (let i = 0; i < RESIDUE_CONFIRM_READS; i++) {
    Bun.sleepSync(LOCK_POLL_MS);
    const again = observeLock(obs.path);
    if (!again || !sameLock(again, obs)) return false;
  }
  return true;
}

/**
 * Release an owned lock, but only while the pathname still names the exact
 * inode+bytes this process published. On ownership loss (the lock vanished
 * or a successor replaced it — possible only through outside interference)
 * the successor is left byte-for-byte intact and the loss is surfaced:
 * mutual exclusion may have been violated while we held it.
 */
export function releaseLock(owned: LockIdentity): void {
  const obs = observeLock(owned.path);
  if (!obs || !sameLock(obs, owned)) {
    console.error(
      `beam: lock ${owned.path} ${obs ? "changed hands" : "vanished"} ` +
        `while pid ${process.pid} held it — ` +
        `leaving it untouched; concurrent beam processes may have overlapped`,
    );
    return;
  }
  try {
    unlinkSync(owned.path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Shared acquisition for every beam lock file (state, per-record operation,
 * per-destination publication). Acquire = stage full pid+nonce bytes,
 * fsync, then link-publish, so no observer ever sees a partial lock. On
 * contention a live owner is waited on or refused per `waitForLiveOwner`;
 * every other shape — dead owner, unrecognized bytes — fails with the exact
 * path and manual recovery guidance. Beam NEVER unlinks a lock it does not
 * own: POSIX has no "unlink only if still this inode", so any auto-reclaim
 * can race a concurrent reclaim-and-republish and delete an innocent
 * successor's lock. The deliberate cost is that a crashed beam leaves its
 * lock behind until an operator confirms nothing is running and removes it
 * by hand — the error names the exact file.
 */
export function acquireLockFile(
  path: string,
  opts: { waitMs: number; waitForLiveOwner: boolean; liveOwnerError: (owner: number) => string },
): LockIdentity {
  const deadline = Date.now() + opts.waitMs;
  for (;;) {
    const owned = publishStagedLock(stageLock(path));
    if (owned) return owned;
    const obs = observeLock(path);
    if (!obs) continue; // holder released between our publish attempt and read — retry
    const owner = parseLockOwner(obs.bytes);
    if (owner === undefined) {
      if (isStableResidue(obs)) {
        throw new Error(
          `lock file ${obs.path} holds content no beam wrote — ` +
            `if no beam process is running, remove it manually and retry`,
        );
      }
      continue; // transient glimpse — never act on a single read
    }
    if (!pidAlive(owner)) {
      throw new Error(
        `lock file ${obs.path} names pid ${owner}, which is no longer running — beam never ` +
          `auto-reclaims a crashed owner's lock; confirm no beam process is running, ` +
          `then remove it manually and retry`,
      );
    }
    if (!opts.waitForLiveOwner || Date.now() >= deadline) {
      throw new Error(opts.liveOwnerError(owner));
    }
    Bun.sleepSync(LOCK_POLL_MS);
  }
}

/**
 * Exclusive local mutation lock over state.json. Held only across an
 * in-memory read-modify-write — never network I/O — so contention lasts
 * milliseconds and a live holder is briefly waited on. Only the owner ever
 * unlinks its lock; one left by a crashed process fails acquisition with
 * manual removal guidance.
 */
function acquireLock(env: BeamEnv, waitMs: number): LockIdentity {
  ensurePrivateBeamDir(env.beamDir);
  const path = join(env.beamDir, "state.lock");
  return acquireLockFile(path, {
    waitMs,
    waitForLiveOwner: true,
    liveOwnerError: (owner) =>
      `another beam process (pid ${owner}) holds the state lock at ${path} — retry in a moment`,
  });
}

function withStateLock<T>(env: BeamEnv, fn: () => T, waitMs = LOCK_WAIT_MS): T {
  const lock = acquireLock(env, waitMs);
  try {
    return fn();
  } finally {
    releaseLock(lock);
  }
}

/**
 * Per-record operation lock: exactly one beam process may run a record's
 * remote effect sequence (provision → ship → install → start) at a time.
 * Same primitive as the state lock, but held across the WHOLE remote
 * sequence, so a live owner is refused immediately — remote effects run
 * for minutes and waiting behind them would just double-ship the
 * workspace. Returns the release function; callers release in `finally`.
 */
export function acquireOperationLock(env: BeamEnv, recordId: string): () => void {
  ensurePrivateBeamDir(env.beamDir);
  const lock = acquireLockFile(join(env.beamDir, `op-${recordId}.lock`), {
    waitMs: 0,
    waitForLiveOwner: false,
    liveOwnerError: (owner) =>
      `another beam process (pid ${owner}) is already operating on handoff ${recordId} — ` +
      `wait for it to finish and retry`,
  });
  return () => releaseLock(lock);
}

export function newRecordId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function addRecord(env: BeamEnv, record: BeamRecord): void {
  withStateLock(env, () => {
    const state = loadState(env);
    state.records.push(record);
    saveState(env, state);
  });
}

export function updateRecord(env: BeamEnv, id: string, patch: Partial<BeamRecord>): BeamRecord {
  return withStateLock(env, () => {
    const state = loadState(env);
    const record = state.records.find((r) => r.id === id);
    if (!record) throw new Error(`no record ${id}`);
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    saveState(env, state);
    return record;
  });
}

export interface ReserveOptions {
  target: string;
  localCwd: string;
  /**
   * Provisioned targets (one sandbox claim per handoff, quota'd per-user
   * namespaces) own at most one active record per target across ALL
   * workspaces. The same workspace ALWAYS resumes its own active record
   * regardless of this flag — the remote path is a pure function of
   * (target root, localCwd), so a second record for the pair would share
   * the directory. Non-exclusive targets (ssh/local) merely allow OTHER
   * workspaces to hold the target concurrently.
   * This is the CURRENT config's policy — an active record whose persisted
   * snapshot is exclusive enforces exclusivity regardless (config drift).
   */
  exclusive: boolean;
  /** Build the new record: status provisioning, spec snapshot, session identity. */
  make: (id: string) => BeamRecord;
  /** Test hook: how long to wait on a lock held by a live process. */
  lockWaitMs?: number;
}

/**
 * Whether an active record owns its whole target (one sandbox claim per
 * target), judged by what the RECORD persisted — never by the current
 * config: editing a target from agent-sandbox to ssh/local must not
 * release the hold while the claim is still alive. Older records that
 * persisted neither the policy nor a snapshot fall back to their sandbox
 * coordinates (only provisioned sandboxes have them).
 */
function holdsTargetExclusively(r: BeamRecord): boolean {
  if (r.exclusiveTarget !== undefined) return r.exclusiveTarget;
  if (r.targetSpec) return r.targetSpec.type === "agent-sandbox";
  return r.sandbox !== undefined;
}

/**
 * Whether record.remoteCwd was actually resolved on the target (`pwd`),
 * i.e. remote effects may exist under it. Records from older beams never
 * persisted the flag; for those, an absolute path is treated as resolved
 * (matches what older purges did) while a `~`-relative candidate was
 * provably never resolved — nothing can have shipped under it.
 */
export function isRemoteCwdResolved(record: BeamRecord): boolean {
  return record.remoteCwdResolved ?? record.remoteCwd.startsWith("/");
}

/**
 * Atomically reserve a target for this workspace: resume the workspace's
 * own provisioning/up record, refuse with the blocking id when another
 * workspace holds an exclusive target, otherwise persist a fresh
 * `provisioning` record — all under the exclusive lock with atomic state
 * replacement, so concurrent beam processes can neither double-reserve a
 * target nor lose each other's records. The lock guards only this
 * read-modify-write; provisioning (network I/O) happens after release.
 *
 * Same-workspace reuse is UNCONDITIONAL: one `(target, localCwd)` pair maps
 * to one active record regardless of provider exclusivity, because the
 * remote workspace path is derived from exactly that pair — two records
 * over the same pair would share a remote directory while holding
 * different operation locks. Exclusivity only decides whether OTHER
 * workspaces may hold the same target concurrently (ssh/local: yes,
 * provisioned sandboxes: no).
 */
export function reserveTarget(
  env: BeamEnv,
  opts: ReserveOptions,
): { record: BeamRecord; reused: boolean } {
  return withStateLock(
    env,
    () => {
      const state = loadState(env);
      const actives = state.records.filter(
        (r) => r.target === opts.target && ACTIVE.includes(r.status),
      );
      const mine = actives.find((r) => r.localCwd === opts.localCwd);
      if (mine?.status === "killing") {
        throw new Error(
          `handoff ${mine.id} on ${opts.target} is mid-kill — ` +
            `run \`beam kill ${mine.id} --purge\` to finish it first`,
        );
      }
      if (mine) return { record: mine, reused: true };
      // Exclusivity is a property of the sandbox a record OWNS, not of what
      // the config says today: an active agent-sandbox record keeps its
      // target-wide hold even after the target is edited to ssh/local.
      if (opts.exclusive || actives.some(holdsTargetExclusively)) {
        const blocker = actives[0];
        if (blocker) {
          throw new Error(
            `target ${opts.target} is already held by handoff ${blocker.id} ` +
              `(${blocker.status}, workspace ${blocker.localCwd}) — beam down ${blocker.id} first`,
          );
        }
      }
      const record = opts.make(newRecordId());
      state.records.push(record);
      saveState(env, state);
      return { record, reused: false };
    },
    opts.lockWaitMs,
  );
}

/**
 * The spec a record's remote operations must bind through: its persisted
 * snapshot, never the mutable config. Records written before snapshots
 * existed are refused — a config edit could have repointed their target
 * name at a different machine, and connecting to (or purging) it through
 * the current config could hit the wrong host. Read-only listings label
 * such records unresolved instead of calling this.
 */
export function recordSpec(record: BeamRecord): TargetSpec {
  if (record.targetSpec) return record.targetSpec;
  throw new Error(
    `handoff ${record.id} predates recorded target specs, so target "${record.target}" ` +
      `in the current config cannot be proven to be the machine it shipped to — ` +
      `beam refuses to touch a remote through it. Finish it manually on its original host ` +
      `(herdr session delete ${record.runtimeSession}; remove ${record.remoteCwd} if unwanted), ` +
      `then delete its entry from state.json in the beam dir`,
  );
}

/**
 * Find a record by id prefix; with no ref, return the most recent record
 * still `up` (or the most recent overall when none are up — that keeps
 * half-provisioned or half-torn-down handoffs reachable for recovery).
 */
export function findRecord(env: BeamEnv, ref?: string): BeamRecord {
  const { records } = loadState(env);
  if (records.length === 0) throw new Error("no beamed sessions yet — run `beam up`");
  if (ref) {
    const matches = records.filter((r) => r.id.startsWith(ref));
    if (matches.length === 0) throw new Error(`no record matching "${ref}"`);
    if (matches.length > 1) {
      throw new Error(`ambiguous ref "${ref}": ${matches.map((r) => r.id).join(", ")}`);
    }
    return matches[0]!;
  }
  const byRecency = [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return byRecency.find((r) => r.status === "up") ?? byRecency[0]!;
}

/**
 * Exact-id lookup, for re-reading a record AFTER acquiring its operation
 * lock: the copy selected before the lock may have been advanced by the
 * previous lock holder (status, remoteCwd, session identity), so every
 * command re-binds through this before acting.
 */
export function getRecord(env: BeamEnv, id: string): BeamRecord {
  const record = loadState(env).records.find((r) => r.id === id);
  if (!record) throw new Error(`no record ${id}`);
  return record;
}

/**
 * Re-bind a `beam up` to its record AFTER acquiring the operation lock.
 * The reservation copy predates the lock: a prior owner may have completed
 * a terminal kill in that window. Terminal records never resurrect, and a
 * concurrent `killing` record routes to the command that owns recovery.
 */
export function getRecordForUp(env: BeamEnv, id: string): BeamRecord {
  const record = getRecord(env, id);
  switch (record.status) {
    case "down":
    case "killed":
      throw new Error(
        `handoff ${record.id} became ${record.status} while this up was acquiring its lock — ` +
          `terminal handoffs never restart; run \`beam up\` again for a fresh one`,
      );
    case "killing":
      throw new Error(
        `handoff ${record.id} is mid-kill — ` +
          `run \`beam kill ${record.id} --purge\` to finish it first`,
      );
    case "provisioning":
    case "starting":
    case "up":
      return record;
    default:
      return unreachable(record.status, `status on handoff ${record.id}`);
  }
}

/**
 * Destructive no-ref selection for `beam kill`: never guess between live
 * handoffs. With more than one record still owning remote resources
 * (`up` or any in-flight phase), a default pick could destroy a handoff
 * the user did not mean — refuse and demand the exact id. A single active
 * record is chosen even when a terminal record is newer (kill is the
 * recovery tool for exactly that record); with no active records, fall
 * back to plain recency (kill on a terminal record is a no-op).
 */
export function findRecordForKill(env: BeamEnv, ref?: string): BeamRecord {
  if (ref) return findRecord(env, ref);
  const { records } = loadState(env);
  const actives = records.filter((r) => ACTIVE.includes(r.status));
  if (actives.length > 1) {
    const list = actives.map((r) => `${r.id} (${r.status}, ${r.localCwd})`).join(", ");
    throw new Error(
      `multiple live handoffs — refusing to pick a kill target by default: ${list}\n` +
        `name the exact one: beam kill <id> --purge`,
    );
  }
  return actives[0] ?? findRecord(env);
}

/**
 * Newest record still `up` on a target — target-scoped commands (login,
 * doctor) bind through it. In-flight states are deliberately excluded.
 */
export function latestUpForTarget(env: BeamEnv, target: string): BeamRecord | undefined {
  return [...loadState(env).records]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .find((r) => r.status === "up" && r.target === target);
}

/**
 * Recovery lookup for `beam up` when the current config no longer resolves
 * a target (removed/renamed entry, deleted config): the workspace's own
 * still-active handoff can be finished through its persisted spec snapshot
 * — only a NEW handoff needs current config. Binding stays exact: a named
 * target must match the record's recorded name; with no name, the
 * workspace must have exactly one live handoff. Records without a snapshot
 * cannot be recovered this way (nothing to bind through).
 */
export function findRecoverableHandoff(
  env: BeamEnv,
  target: string | undefined,
  localCwd: string,
): BeamRecord | undefined {
  const live = loadState(env).records.filter(
    (r) => ACTIVE.includes(r.status) && r.localCwd === localCwd && r.targetSpec !== undefined,
  );
  const candidates = target === undefined ? live : live.filter((r) => r.target === target);
  if (candidates.length > 1) {
    throw new Error(
      `multiple live handoffs for ${localCwd} ` +
        `(${candidates.map((r) => `${r.id} on ${r.target}`).join(", ")}) — ` +
        `pass --target to name one`,
    );
  }
  return candidates[0];
}

/**
 * Recovery lookup for `beam login` when the current config no longer
 * resolves a target: the newest `up` handoff (optionally filtered by the
 * requested target name) still names its sandbox through the persisted
 * snapshot. With no name, the live handoffs must all be on one target —
 * login never guesses between sandboxes.
 */
export function findRecoverableUp(
  env: BeamEnv,
  target: string | undefined,
): BeamRecord | undefined {
  const ups = loadState(env)
    .records.filter(
      (r) =>
        r.status === "up" &&
        r.targetSpec !== undefined &&
        (target === undefined || r.target === target),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const targets = [...new Set(ups.map((r) => r.target))];
  if (target === undefined && targets.length > 1) {
    throw new Error(
      `live handoffs exist on several targets (${targets.join(", ")}) ` +
        `— name one: beam login <target>`,
    );
  }
  return ups[0];
}

/** What a re-ship through an existing record may do with its session identity. */
export type SessionIdentityPlan =
  | { kind: "adopt" }
  | { kind: "retain"; tool: ToolName; sessionId: string }
  | { kind: "refuse"; reason: string };

/**
 * Decide the session identity a re-ship through an existing record uses.
 * The stored identity is the ONLY address of the transcript/agent beam may
 * already have installed remotely — `beam down` collects and `beam kill
 * --purge` cleans through it — so it is never silently replaced or cleared:
 *
 *  - nothing stored yet, or the request names the stored session: adopt;
 *  - args omitted but auto-detection drifted to a different (newer)
 *    session: retain — the caller ships the STORED session, not whatever
 *    happens to be newest now;
 *  - an explicit switch/clear while the record may own remote traces
 *    (remote cwd resolved): refuse — switching needs a fresh record, via
 *    `beam down`/`beam kill` first;
 *  - an explicit switch/clear on a record that provably never shipped
 *    (remote cwd never resolved): adopt — nothing remote exists to orphan;
 *    the reservation simply carries the new intent.
 */
export function planSessionIdentity(
  record: BeamRecord,
  requested: { tool: ToolName; sessionId: string } | undefined,
  explicit: boolean,
): SessionIdentityPlan {
  if (record.sessionId === undefined || record.tool === undefined) return { kind: "adopt" };
  if (requested && requested.tool === record.tool && requested.sessionId === record.sessionId) {
    return { kind: "adopt" };
  }
  if (!explicit) return { kind: "retain", tool: record.tool, sessionId: record.sessionId };
  if (!isRemoteCwdResolved(record)) return { kind: "adopt" };
  const stored = `${record.tool} ${record.sessionId}`;
  return {
    kind: "refuse",
    reason: requested
      ? `handoff ${record.id} already shipped session ${stored} — refusing to replace it with ` +
        `${requested.tool} ${requested.sessionId}: the transcript beam installed remotely ` +
        `would be orphaned. beam down ${record.id} (or beam kill ${record.id} --purge) first, ` +
        `or drop --tool/--session to keep the stored session`
      : `handoff ${record.id} already shipped session ${stored} — --no-session would orphan ` +
        `the transcript beam installed remotely. beam down ${record.id} (or beam kill ` +
        `${record.id} --purge) first`,
  };
}
