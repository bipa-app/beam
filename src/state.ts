import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTarget, type Config, type TargetSpec } from "./config.ts";
import type { BeamEnv } from "./env.ts";
import type { SandboxState } from "./provider/types.ts";
import type { ToolName } from "./session/types.ts";
import type { WtGitShipInfo } from "./workspace-git.ts";

/**
 * Handoff lifecycle. `provisioning`, `starting`, `purging`, `teardown`, and
 * `killing` are in-flight phases that still own remote resources (they hold
 * the target reservation) but are not eligible for default selection — only
 * `up` is a completed, running handoff.
 *
 *  - `starting`  — journaled right before the remote tmux session is
 *    started: a crash here leaves an agent that may already be running, so
 *    a retried `beam up` finalizes the record instead of re-shipping.
 *  - `purging`   — journaled right after `beam down` has the workspace and
 *    transcript safely back: a crash during remote cleanup is retried by
 *    repeating the idempotent cleanup, never by re-collecting.
 *  - `killing`   — journaled by `beam kill --purge` only once checked
 *    remote erasure is complete (or provably unnecessary: the remote cwd
 *    never resolved, so nothing ever shipped). The only thing left is the
 *    provider destroy, so a retry repeats the destroy alone — it never
 *    reconnects, re-cleans, or re-erases.
 *
 * Terminal states (`down`, `killed`) are monotonic: no command moves a
 * record out of them.
 */
export type BeamStatus = "provisioning" | "starting" | "up" | "purging" | "teardown" | "killing" | "down" | "killed";

/** Statuses that still own remote resources (and hence the target reservation). */
const ACTIVE: readonly BeamStatus[] = ["provisioning", "starting", "up", "purging", "teardown", "killing"];

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
  tmux: string;
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
   * through it, so editing the config (type/root/template/tmuxSocket) can
   * never retarget a live handoff. Absent only on records written by older
   * beams; those fall back to the current config entry.
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
}

interface StateFile {
  records: BeamRecord[];
}

export function loadState(env: BeamEnv): StateFile {
  const path = join(env.beamDir, "state.json");
  if (!existsSync(path)) return { records: [] };
  return JSON.parse(readFileSync(path, "utf8")) as StateFile;
}

function saveState(env: BeamEnv, state: StateFile): void {
  mkdirSync(env.beamDir, { recursive: true });
  const path = join(env.beamDir, "state.json");
  // Write-then-rename: a concurrent reader (or a crash mid-write) never
  // sees a torn state.json.
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
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
 * A lock file names a live owner only when it holds a strictly positive
 * integer pid that answers signal 0. Zero and negatives are never owners:
 * `process.kill(0, …)`/`kill(-n, …)` signal process GROUPS, so probing them
 * "succeeds" forever and a garbage lock would deadlock every future beam.
 */
function lockOwnerAlive(raw: string): { owner: number; alive: boolean } {
  const owner = Number(raw);
  return { owner, alive: Number.isInteger(owner) && owner > 0 && pidAlive(owner) };
}

const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 25;

/**
 * Exclusive local mutation lock over state.json (O_EXCL create with the
 * holder's pid inside). Held only across an in-memory read-modify-write —
 * never network I/O — so contention lasts milliseconds. A lock left by a
 * crashed process is detected by its dead pid and reclaimed; a lock owned
 * by a live process is never deleted.
 */
function acquireLock(env: BeamEnv, waitMs: number): void {
  mkdirSync(env.beamDir, { recursive: true });
  const path = join(env.beamDir, "state.lock");
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let raw = "";
    try {
      raw = readFileSync(path, "utf8").trim();
    } catch {
      continue; // holder released between our create attempt and read — retry
    }
    const { owner, alive } = lockOwnerAlive(raw);
    if (!alive) {
      // Stale: the holder is gone. Re-check the content right before
      // reclaiming so a lock a live process just took over is never deleted.
      try {
        if (readFileSync(path, "utf8").trim() === raw) rmSync(path, { force: true });
      } catch {
        // already gone — retry the create
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`another beam process (pid ${owner}) holds the state lock at ${path} — retry in a moment`);
    }
    Bun.sleepSync(LOCK_POLL_MS);
  }
}

function withStateLock<T>(env: BeamEnv, fn: () => T, waitMs = LOCK_WAIT_MS): T {
  acquireLock(env, waitMs);
  try {
    return fn();
  } finally {
    rmSync(join(env.beamDir, "state.lock"), { force: true });
  }
}

/**
 * Per-record operation lock: exactly one beam process may run a record's
 * remote effect sequence (provision → ship → install → start) at a time.
 * Same shape as the state lock (O_EXCL create, holder's pid inside, dead
 * or garbage owners reclaimed) but held across the WHOLE remote sequence,
 * so a live owner is refused immediately — remote effects run for minutes
 * and waiting behind them would just double-ship the workspace. Returns
 * the release function; callers release in `finally`.
 */
export function acquireOperationLock(env: BeamEnv, recordId: string): () => void {
  mkdirSync(env.beamDir, { recursive: true });
  const path = join(env.beamDir, `op-${recordId}.lock`);
  for (;;) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return () => rmSync(path, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let raw = "";
    try {
      raw = readFileSync(path, "utf8").trim();
    } catch {
      continue; // holder released between our create attempt and read — retry
    }
    const { owner, alive } = lockOwnerAlive(raw);
    if (!alive) {
      // Stale: reclaim only if the content is still what we judged dead.
      try {
        if (readFileSync(path, "utf8").trim() === raw) rmSync(path, { force: true });
      } catch {
        // already gone — retry the create
      }
      continue;
    }
    throw new Error(
      `another beam process (pid ${owner}) is already operating on handoff ${recordId} — ` +
        `wait for it to finish; if it crashed, retry once that pid is gone`,
    );
  }
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
export function reserveTarget(env: BeamEnv, opts: ReserveOptions): { record: BeamRecord; reused: boolean } {
  return withStateLock(
    env,
    () => {
      const state = loadState(env);
      const actives = state.records.filter((r) => r.target === opts.target && ACTIVE.includes(r.status));
      const mine = actives.find((r) => r.localCwd === opts.localCwd);
      if (mine?.status === "teardown" || mine?.status === "purging") {
        throw new Error(
          `handoff ${mine.id} on ${opts.target} is mid-teardown — run \`beam down ${mine.id}\` to finish it first`,
        );
      }
      if (mine?.status === "killing") {
        throw new Error(
          `handoff ${mine.id} on ${opts.target} is mid-kill — run \`beam kill ${mine.id} --purge\` to finish it first`,
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
 * The spec a record's operations must bind through: its persisted snapshot.
 * Old records (written before snapshots existed) fall back to the current
 * config entry for their target.
 */
export function recordSpec(record: BeamRecord, config: Config): TargetSpec {
  return record.targetSpec ?? resolveTarget(config, record.target).spec;
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
    if (matches.length > 1) throw new Error(`ambiguous ref "${ref}": ${matches.map((r) => r.id).join(", ")}`);
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
 * The copy the reservation handed out predates the lock: in that window
 * the previous owner may have finished a `beam down`/`beam kill` (terminal)
 * or advanced the record into a teardown phase, and shipping through the
 * stale copy would resurrect a handoff whose remote side is already gone.
 * Terminal states are monotonic — this up fails and a re-run reserves a
 * fresh record — and the teardown phases keep routing to the command that
 * owns their recovery, exactly as `reserveTarget` does before the lock.
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
    case "purging":
    case "teardown":
      throw new Error(`handoff ${record.id} is mid-teardown — run \`beam down ${record.id}\` to finish it first`);
    case "killing":
      throw new Error(`handoff ${record.id} is mid-kill — run \`beam kill ${record.id} --purge\` to finish it first`);
    default:
      return record;
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
 * doctor) bind through it. Deliberately excludes the in-flight phases
 * (provisioning/starting/purging/teardown/killing): a handoff mid-flight
 * has no dependable sandbox to talk to.
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
      `multiple live handoffs for ${localCwd} (${candidates.map((r) => `${r.id} on ${r.target}`).join(", ")}) — ` +
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
export function findRecoverableUp(env: BeamEnv, target: string | undefined): BeamRecord | undefined {
  const ups = loadState(env)
    .records.filter(
      (r) => r.status === "up" && r.targetSpec !== undefined && (target === undefined || r.target === target),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const targets = [...new Set(ups.map((r) => r.target))];
  if (target === undefined && targets.length > 1) {
    throw new Error(
      `live handoffs exist on several targets (${targets.join(", ")}) — name one: beam login <target>`,
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
        `${requested.tool} ${requested.sessionId}: the transcript beam installed remotely would be orphaned. ` +
        `beam down ${record.id} (or beam kill ${record.id} --purge) first, or drop --tool/--session to keep the stored session`
      : `handoff ${record.id} already shipped session ${stored} — --no-session would orphan the transcript ` +
        `beam installed remotely. beam down ${record.id} (or beam kill ${record.id} --purge) first`,
  };
}
