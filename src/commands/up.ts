import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  loadConfig,
  resolveTarget,
  targetRoot,
  type Config,
  type TargetSpec,
} from "../config.ts";
import { sessionInstallKey } from "../session/ship-bundle.ts";
import { resolveEnv, type BeamEnv } from "../env.ts";
import {
  detectSession,
  type LocalSession,
  type SessionAdapter,
  type ToolName,
} from "../session/index.ts";
import { fileSha256 } from "../util/digest.ts";
import {
  acquireOperationLock,
  findRecoverableHandoff,
  getRecordForUp,
  isRemoteCwdResolved,
  planSessionIdentity,
  recordSpec,
  reserveTarget,
  updateRecord,
  type BeamRecord,
} from "../state.ts";
import { createProvider, type SandboxProvider } from "../provider/index.ts";
import type { Transport } from "../transport/index.ts";
import { TmuxRuntime } from "../runtime/tmux.ts";
import { probePrivilege } from "../security.ts";
import {
  assertContainedWorkspace,
  assertNoLocalReservedCollision,
  assertPurgeablePath,
  ensureGitExclude,
  establishContainedWorkspace,
  gatherExcludes,
  gitSummary,
  remoteWorkspaceName,
  stageWorkspaceShip,
  workspaceOwnerContent,
  remoteWorkspaceTreeFingerprint,
  stagedWorkspaceTreeFingerprint,
  publishWorkspaceUploadStage,
  remoteWorkspaceUploadStagePresent,
  removeWorkspaceUploadStage,
  workspaceUploadStagePath,
  workspaceReturnFingerprint,
  type StagedWorkspaceShip,
} from "../workspace.ts";
import {
  collectedGitTreeFingerprint,
  gitPayloadPath,
  gitPointerBytes,
  installRemoteGitPointer,
  isGitDirAtCwd,
  isGitWorktree,
  materializeWorktreeGit,
  reconcileGitPointerTemp,
  remoteGitPointerState,
  remoteGitTreeFingerprint,
  workspaceGitEntryKind,
  type MaterializedWorktreeGit,
  type WtGitShipInfo,
} from "../workspace-git.ts";

export const UP_HELP =
  `beam up — ship this workspace + session to a target and resume the agent there

usage: beam up [options]
  --target, -t <name>     configured target (default: config defaultTarget)
  --tool <omp|pi|claude|codex>  harness to hand off (default: auto-detect newest)
  --session <ref>         session id/filename prefix (default: newest for cwd)
  --message, -m <text>    kickoff prompt so the agent starts working unattended
  --no-session            ship the workspace only
  --no-start              install but do not start the remote agent
  --verbose, -v           stream rsync progress
`;

/** Parsed `beam up` CLI values, threaded to the phase helpers that need them. */
type UpValues = {
  target?: string;
  tool?: string;
  session?: string;
  message?: string;
  "no-session"?: boolean;
  "no-start"?: boolean;
  verbose?: boolean;
  help?: boolean;
};

/** A located harness session bound to its adapter — what `detectSession` returns. */
type DetectedSession = { adapter: SessionAdapter; session: LocalSession };

/** The pending-generation journal of an interrupted ship (record.shipPending). */
type ShipPendingJournal = NonNullable<BeamRecord["shipPending"]>;

/** The journaled identity of a staged session bundle (shipPending.session). */
type StagedSessionJournal = NonNullable<ShipPendingJournal["session"]>;

export async function cmdUp(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: "string", short: "t" },
      tool: { type: "string" },
      session: { type: "string" },
      message: { type: "string", short: "m" },
      "no-session": { type: "boolean" },
      "no-start": { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(UP_HELP);
    return;
  }

  const env = resolveEnv();
  const config = loadConfig(env);
  const localCwd = process.cwd();
  // Pure local checks first: an unshippable Git layout must fail before
  // the reservation claims a (possibly exclusive) target or pins a
  // misleading "plain" layout that a later repaired retry would trip over.
  assertShippableGitLayout(localCwd);
  // The reserved `.beam` name (any ASCII case, on disk or git-tracked)
  // would be silently omitted from the mirror — refuse before the record
  // reservation and before any remote effect.
  await assertNoLocalReservedCollision(localCwd);

  const resolved = resolveUpTarget({ env, config, localCwd, requested: values.target });
  const detected = values["no-session"]
    ? undefined
    : await detectSession(localCwd, env.home, values.tool as ToolName | undefined, values.session);
  if (detected) {
    console.log(`session: ${detected.adapter.tool} ${detected.session.id}`);
  }

  const currentProvider = createProvider(resolved.spec);
  const { record: reserved, reused } = reserveUpTarget({
    env,
    localCwd,
    targetName: resolved.targetName,
    spec: resolved.spec,
    provider: currentProvider,
    recovering: resolved.recovering,
    detected,
    message: values.message,
  });

  const releaseOp = acquireOperationLock(env, reserved.id);
  try {
    await upUnderOperationLock({
      env,
      config,
      localCwd,
      values,
      detected,
      targetName: resolved.targetName,
      currentProvider,
      reserved,
      reused,
    });
  } finally {
    releaseOp();
  }
}

/**
 * Side-effect-free local Git-layout preflights, run BEFORE the target
 * reservation (a refused workspace must not claim a scarce target or pin a
 * misleading layout) and re-run under the operation lock (the entry can
 * change between them):
 *  - `.git` must be a real directory or a linked-worktree pointer file.
 *    Anything else (a symlink to a repository elsewhere, a socket, …)
 *    classifies as "plain" while the mirror excludes `.git` in every
 *    ASCII case — the workspace would land remotely with its Git state
 *    silently stripped, and a mirrored re-ship would delete the remote
 *    copy.
 *  - a bare repository (the cwd IS the Git directory) also classifies as
 *    "plain", and the raw mirror would copy config, hooks, alternates,
 *    and objects across the sandbox boundary unquarantined.
 */
function assertShippableGitLayout(localCwd: string): void {
  if (workspaceGitEntryKind(localCwd) === "unsupported") {
    throw new Error(
      `beam up: ${localCwd}/.git is a symlink or special file — beam ships standard repositories ` +
        `(.git directory) and linked worktrees (.git pointer file) only. Run beam up from the ` +
        `real worktree, or convert .git to a supported layout first`,
    );
  }
  if (isGitDirAtCwd(localCwd)) {
    throw new Error(
      `beam up: ${localCwd} is a bare repository (or a repository's Git directory) — shipping ` +
        `it would raw-copy config, hooks, and objects to the target. beam ships worktrees; ` +
        `create one (git worktree add) and run beam up from there`,
    );
  }
}

/**
 * Resolve the target through the CURRENT config. When the entry was
 * removed or renamed, fall back to this workspace's own live handoff and
 * bind through its persisted snapshot: finishing an existing handoff
 * never depends on config, only a NEW one does (`recovering` makes the
 * reservation refuse to author a fresh record).
 */
function resolveUpTarget(o: {
  env: BeamEnv;
  config: Config;
  localCwd: string;
  requested: string | undefined;
}): { targetName: string; spec: TargetSpec; recovering: boolean } {
  try {
    const { name, spec } = resolveTarget(o.config, o.requested);
    return { targetName: name, spec, recovering: false };
  } catch (err) {
    // Recovery covers REMOVAL only — the requested (or default) name no
    // longer resolves. A config that merely demands disambiguation
    // (several targets, no default, no --target) keeps its own error:
    // guessing between configured targets is never recovery.
    const requested = o.requested ?? o.config.defaultTarget;
    if (requested === undefined && Object.keys(o.config.targets).length > 0) throw err;
    const live = findRecoverableHandoff(o.env, requested, o.localCwd);
    if (!live?.targetSpec) throw err;
    console.log(
      `target ${live.target} is gone from the config — recovering handoff ${live.id} through ` +
        `its recorded spec`,
    );
    return { targetName: live.target, spec: live.targetSpec, recovering: true };
  }
}

/** What `reserveUpTarget` needs to author (or re-adopt) the handoff record. */
type UpReserveOptions = {
  env: BeamEnv;
  localCwd: string;
  targetName: string;
  spec: TargetSpec;
  provider: SandboxProvider;
  recovering: boolean;
  detected: DetectedSession | undefined;
  message: string | undefined;
};

/**
 * Reserve the target BEFORE anything remote happens. The record — status
 * `provisioning`, full spec snapshot, session identity, sandbox
 * coordinates, candidate remote cwd — is persisted before
 * provider.provision, so a crash or Ready timeout leaves a handoff that
 * `beam up` resumes and `beam kill --purge` abandons: never an orphaned
 * claim or a started agent whose transcript beam cannot collect. On a
 * provisioned target the reservation is target-wide and atomic across
 * concurrent beam processes — one active handoff per target, ever.
 */
function reserveUpTarget(o: UpReserveOptions): { record: BeamRecord; reused: boolean } {
  return reserveTarget(o.env, {
    target: o.targetName,
    localCwd: o.localCwd,
    exclusive: o.provider.reusesSandbox,
    make: (id) => {
      // Recovery substitutes a live record's snapshot for the missing
      // config entry — it may finish that handoff but never author a new
      // one. If the live record vanished between the lookup and this lock
      // (a concurrent down/kill finished it), fail closed.
      if (o.recovering) {
        throw new Error(
          `target ${o.targetName} is not in the current config and its live handoff just ended — ` +
            `a new handoff needs a configured target (re-add "${o.targetName}" or pass --target)`,
        );
      }
      const now = new Date().toISOString();
      const root = targetRoot(o.spec);
      return {
        id,
        target: o.targetName,
        tool: o.detected?.adapter.tool,
        sessionId: o.detected?.session.id,
        sessionFile: o.detected?.session.file,
        artifactsDir: o.detected?.session.artifactsDir,
        localCwd: o.localCwd,
        // Candidate until `pwd` resolves it.
        remoteCwd: `${root}/${remoteWorkspaceName(o.localCwd)}`,
        remoteCwdResolved: false,
        // Pinned atomically WITH the reservation, from side-effect-free
        // detection: a transient materialize failure must never strand a
        // fresh `provisioning` record without a layout pin — the retry
        // would hit the ambiguous-layout refusal forever even though
        // nothing remote ever happened. The post-materialize persist
        // re-journals the same kind together with the Git payload identity.
        workspaceKind: isGitWorktree(o.localCwd) ? ("git" as const) : ("plain" as const),
        // Random ownership token, persisted create-only WITH the
        // reservation — before any remote effect. The remote `.beam/owner`
        // is created atomically from it; only exact bytes are ever
        // re-adopted.
        workspaceToken: randomBytes(16).toString("hex"),
        tmux: `beam-${id}`,
        status: "provisioning",
        createdAt: now,
        updatedAt: now,
        kickoff: o.message,
        targetSpec: o.spec,
        sandbox: o.provider.sandboxState({ id }),
        exclusiveTarget: o.provider.reusesSandbox,
      };
    },
  });
}

/** Everything `cmdUp` resolved before taking the per-record operation lock. */
type UpLockedOptions = {
  env: BeamEnv;
  config: Config;
  localCwd: string;
  values: UpValues;
  detected: DetectedSession | undefined;
  targetName: string;
  currentProvider: SandboxProvider;
  reserved: BeamRecord;
  reused: boolean;
};

/**
 * Everything `beam up` does while holding the per-record operation lock.
 * The reservation hands out the record; the OPERATION lock hands out the
 * right to act on it. Two same-workspace `beam up`s resume the SAME
 * record, so the reservation alone cannot stop them from interleaving
 * remote effects (double ship, two agents, forked transcripts). The
 * per-record pid lock is held across the whole remote sequence; a live
 * owner is refused immediately, a dead one is named for manual removal.
 *
 * The reservation's copy predates the lock: the previous owner may have
 * finished a down/kill (terminal) or advanced the phase in that window,
 * so the record is re-bound under the lock — a terminal handoff is never
 * resurrected by shipping through a stale reservation. The kickoff a
 * retried ship runs with: an explicit -m wins, an omitted one keeps what
 * the record stored — the agent must start with the SAME kickoff the
 * record journals. The pure layout preflights also re-run under the lock:
 * the `.git` entry can change between the pre-reservation check and here,
 * and every remote effect (provisioning included) is still ahead.
 *
 * Git metadata never rides the workspace mirror: both standard and
 * linked-worktree layouts ship through a standalone payload so host
 * paths, config, and hooks cannot cross the sandbox boundary. On a FRESH
 * handoff the payload is built and persisted FIRST — if the handoff
 * cannot carry its Git identity, it must fail before any remote side
 * effect, provisioning included. A REUSED record defers the PERSIST until
 * the liveness, session-identity, and remote-operation gates have passed:
 * a refused re-ship must leave the prior ship's `wtGit` byte-for-byte
 * untouched, because `beam down` still has to return exactly what that
 * ship sent out. The payload is built at most once per up and removed in
 * `finally` on every outcome.
 */
async function upUnderOperationLock(o: UpLockedOptions): Promise<void> {
  const record = getRecordForUp(o.env, o.reserved.id);
  const kickoff = o.values.message ?? record.kickoff;
  assertShippableGitLayout(o.localCwd);
  let wtGit: MaterializedWorktreeGit | undefined;
  try {
    if (!o.reused) {
      wtGit = await upMaterializeWtGit({ wtGit, localCwd: o.localCwd });
      updateRecord(o.env, record.id, {
        wtGit: wtGit?.shipInfo,
        workspaceKind: wtGit === undefined ? "plain" : "git",
      });
    }
    const pinned = await upPinShipIdentity({
      env: o.env,
      record,
      reused: o.reused,
      localCwd: o.localCwd,
      detected: o.detected,
      values: o.values,
      currentProvider: o.currentProvider,
      wtGit,
    });
    wtGit = pinned.wtGit;
    const screened = await upProvisionAndScreen({
      env: o.env,
      record,
      spec: pinned.spec,
      provider: pinned.provider,
      reused: o.reused,
      targetName: o.targetName,
    });
    if (screened === undefined) return;
    // Build the next payload after all refusal gates, but do not replace
    // the completed generation recorded for `beam down` yet. Provisioning
    // and auth may take minutes; a late source verifier must still be able
    // to fail while the prior remote Git contract remains intact. A retry
    // carrying a pending generation journal defers materialization to the
    // landing detection below: a landed generation resumes with NO new
    // materialize and NO new generation — local Git state, even an
    // in-progress local operation, must never block finalizing a ship
    // whose bytes are already on the target.
    if (o.reused && record.shipPending === undefined) {
      wtGit = await upMaterializeWtGit({ wtGit, localCwd: o.localCwd });
      await wtGit?.assertSourceUnchanged();
    }
    await upExecuteShip({
      env: o.env,
      config: o.config,
      record,
      spec: pinned.spec,
      t: screened.t,
      runtime: screened.runtime,
      detected: pinned.detected,
      wtGit,
      kickoff,
      reused: o.reused,
      localCwd: o.localCwd,
      targetName: o.targetName,
      expectedWorkspaceKind: pinned.expectedWorkspaceKind,
      values: o.values,
    });
  } finally {
    wtGit?.cleanup();
  }
}

/**
 * Build the standalone `.git` payload once: a defined `wtGit` passes
 * through untouched, a plain workspace yields undefined, and a Git
 * worktree materializes exactly once. The caller owns the returned
 * value's cleanup.
 */
async function upMaterializeWtGit(o: {
  wtGit: MaterializedWorktreeGit | undefined;
  localCwd: string;
}): Promise<MaterializedWorktreeGit | undefined> {
  if (o.wtGit !== undefined) return o.wtGit;
  if (!isGitWorktree(o.localCwd)) return undefined;
  const wtGit = await materializeWorktreeGit(o.localCwd);
  console.log("git workspace: materialized standalone .git");
  return wtGit;
}

/** Inputs for pinning the spec, session identity, and workspace layout. */
type UpPinShipIdentityOptions = {
  env: BeamEnv;
  record: BeamRecord;
  reused: boolean;
  localCwd: string;
  detected: DetectedSession | undefined;
  values: UpValues;
  currentProvider: SandboxProvider;
  wtGit: MaterializedWorktreeGit | undefined;
};

/** The identity every later phase binds through, pinned before provisioning. */
type UpPinnedShipIdentity = {
  spec: TargetSpec;
  provider: SandboxProvider;
  detected: DetectedSession | undefined;
  expectedWorkspaceKind: "git" | "plain";
  wtGit: MaterializedWorktreeGit | undefined;
};

/**
 * Pin everything the ship must not drift on, before any remote effect:
 * the record's spec snapshot (a config edit cannot retarget an in-flight
 * handoff — everything after this binds through it), the session
 * identity, and the Git/plain workspace layout.
 */
async function upPinShipIdentity(o: UpPinShipIdentityOptions): Promise<UpPinnedShipIdentity> {
  const spec = recordSpec(o.record);
  const provider = o.reused ? createProvider(spec) : o.currentProvider;
  // Session identity is load-bearing record state — pin it before any
  // remote effect (provisioning included). A `starting` record never
  // pins: it never re-ships, it only finalizes, identity untouched.
  const explicitSession =
    o.values.tool !== undefined ||
    o.values.session !== undefined ||
    o.values["no-session"] === true;
  let detected = o.detected;
  if (o.reused && o.record.status !== "starting") {
    detected = await upPinSessionIdentity({
      env: o.env,
      record: o.record,
      localCwd: o.localCwd,
      detected,
      explicitSession,
    });
  }
  const expectedWorkspaceKind = upExpectedWorkspaceKind(o.record, o.reused, o.localCwd);
  if (!o.reused || o.record.status !== "starting") {
    assertPinnedWorkspaceLayout({
      id: o.record.id,
      localCwd: o.localCwd,
      expected: expectedWorkspaceKind,
    });
  }
  // A reused provisioning record re-runs a ship that never completed. It
  // must pass the same local shippability guards as a fresh one before
  // provider.provision; only persistence of a replacement Git identity
  // waits for the remote refusal gates ahead.
  let wtGit = o.wtGit;
  if (o.reused && o.record.status === "provisioning" && o.record.shipPending === undefined) {
    wtGit = await upMaterializeWtGit({ wtGit, localCwd: o.localCwd });
  }
  return { spec, provider, detected, expectedWorkspaceKind, wtGit };
}

/**
 * Resolve the session a reused record retains. A `retain` plan re-detects
 * the exact pinned session; a missing one refuses with the collect-first
 * escape hatch. A `refuse` plan carries its own reason.
 */
async function upPinSessionIdentity(o: {
  env: BeamEnv;
  record: BeamRecord;
  localCwd: string;
  detected: DetectedSession | undefined;
  explicitSession: boolean;
}): Promise<DetectedSession | undefined> {
  const plan = planSessionIdentity(
    o.record,
    o.detected && { tool: o.detected.adapter.tool, sessionId: o.detected.session.id },
    o.explicitSession,
  );
  if (plan.kind === "refuse") throw new Error(plan.reason);
  if (plan.kind !== "retain") return o.detected;
  let detected: DetectedSession;
  try {
    detected = await detectSession(o.localCwd, o.env.home, plan.tool, plan.sessionId);
  } catch (err) {
    throw new Error(
      `handoff ${o.record.id} was shipped with session ${plan.tool} ${plan.sessionId}, which no ` +
        `longer exists locally — beam down ${o.record.id} to collect it, then beam kill ` +
        `${o.record.id} --purge to retire the handoff before shipping a different session\n` +
        `  cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.log(`session: ${plan.tool} ${plan.sessionId} (retained from handoff ${o.record.id})`);
  return detected;
}

/**
 * Git/plain layout is part of the return contract from the moment it is
 * pinned, before provisioning. Pivoting either way can strand shipped Git
 * state or overwrite a repository created remotely. An old provisioning
 * record without an explicit pin is ambiguous, so fail closed rather
 * than guess.
 */
function upExpectedWorkspaceKind(
  record: BeamRecord,
  reused: boolean,
  localCwd: string,
): "git" | "plain" {
  const localHasGit = isGitWorktree(localCwd);
  if (reused && record.status === "provisioning" && record.workspaceKind === undefined) {
    throw new Error(
      `handoff ${record.id} has no pinned workspace layout from its interrupted provisioning ` +
        `attempt — refusing to guess whether remote Git state exists. beam kill ${record.id} ` +
        `--purge, then ship a fresh handoff`,
    );
  }
  if (!reused || record.status === "starting") {
    return localHasGit ? "git" : "plain";
  }
  if (record.workspaceKind !== undefined) {
    return record.workspaceKind;
  }
  return record.wtGit === undefined ? "plain" : "git";
}

/** The local workspace must still be the layout the handoff pinned. */
function assertPinnedWorkspaceLayout(o: {
  id: string;
  localCwd: string;
  expected: "git" | "plain";
}): void {
  const actual = isGitWorktree(o.localCwd) ? "git" : "plain";
  if (actual === o.expected) return;
  throw new Error(
    `handoff ${o.id} was pinned as a ${o.expected} workspace, but ${o.localCwd} is now ` +
      `${actual} — re-shipping across a Git layout change could lose remote Git state. ` +
      `beam down ${o.id} to bring the prior handoff home, then beam kill ${o.id} --purge ` +
      `to retire it first`,
  );
}

/** Inputs for provisioning the transport and screening a reused record. */
type UpProvisionScreenOptions = {
  env: BeamEnv;
  record: BeamRecord;
  spec: TargetSpec;
  provider: SandboxProvider;
  reused: boolean;
  targetName: string;
};

/** The provisioned transport and runtime a ship proceeds through. */
type UpScreenedTransport = { t: Transport; runtime: TmuxRuntime };

/**
 * Provision the transport, then screen the reused record's status before
 * a single ship byte moves: a `starting` record is finalized (its ship
 * completed), an `up` record is restarted in place or refused, and a live
 * agent on any other record refuses. Returns undefined when the handoff
 * was handled entirely here.
 *
 * The provider publishes the verified claim identity (server-assigned
 * UID) the moment it exists — BEFORE the long Ready wait — and it is
 * persisted synchronously here, so a timeout or crash mid-wait still
 * leaves a record pinned to exactly the claim this handoff created:
 * every later connect, destroy, and retried up binds to that UID.
 */
async function upProvisionAndScreen(
  o: UpProvisionScreenOptions,
): Promise<UpScreenedTransport | undefined> {
  const t = await o.provider.provision(o.record, (sandbox) => {
    updateRecord(o.env, o.record.id, { sandbox });
  });
  const runtime = new TmuxRuntime(t, o.spec.tmuxSocket);
  const agentAlive = o.reused && (await runtime.alive(o.record.tmux));
  if (o.reused && o.record.status === "starting") {
    upFinalizeInterruptedStart({ env: o.env, record: o.record, agentAlive });
    return undefined;
  }
  if (o.reused && o.record.status === "up") {
    await upRestartRetainedAgent({
      record: o.record,
      spec: o.spec,
      t,
      runtime,
      agentAlive,
      targetName: o.targetName,
    });
    return undefined;
  }
  // Reusing a live sandbox: never clobber a running agent's workspace.
  if (agentAlive) {
    throw new Error(
      `handoff ${o.record.id} already has a live agent (tmux ${o.record.tmux}) on ` +
        `${o.targetName} — beam attach ${o.record.id} to watch it, or collect it ` +
        `(beam down ${o.record.id}) and retire it (beam kill ${o.record.id} --purge) ` +
        `before re-shipping`,
    );
  }
  return { t, runtime };
}

/**
 * A previous up died between starting tmux and journaling `up`. The ship
 * itself had already completed — mirror, git payload, and session install
 * all precede the `starting` write — so whatever liveness says, this is a
 * COMPLETED handoff whose agent may have run: finalize it, never re-ship
 * over it. Alive, the agent owns this record's session; absent, the agent
 * may have started, worked, and exited inside the crash window, and only
 * `beam down` can tell — a re-ship would replace the remote workspace,
 * `.git`, and transcript with the stale local side, irreversibly
 * discarding whatever that agent did.
 */
function upFinalizeInterruptedStart(o: {
  env: BeamEnv;
  record: BeamRecord;
  agentAlive: boolean;
}): void {
  const id = o.record.id;
  // The pending generation journal survived through install and start;
  // promote it atomically with the final `up` state so the completed
  // ship's identity is exactly what `beam down` collects against.
  updateRecord(o.env, id, {
    status: "up",
    shipPending: undefined,
    ...(o.record.shipPending?.git !== undefined
      ? { wtGit: o.record.shipPending.git.shipInfo, workspaceKind: "git" as const }
      : {}),
  });
  // The completed ship's journal is cleared with the flip above; reap its
  // immutable session bundle stage exactly like the normal `up` tail does
  // — the journal it backed no longer exists.
  rmSync(sessionStageRoot(o.env, id), { recursive: true, force: true });
  if (o.agentAlive) {
    console.log(
      `\nfinalized interrupted handoff ${id} (agent already running, nothing re-shipped)`,
    );
    console.log(`  watch:   beam attach ${id}   (detach: ctrl-b d)`);
    console.log(`  return:  beam down ${id}`);
  } else {
    console.log(
      `\nfinalized interrupted handoff ${id} — the ship completed, but its agent is no longer ` +
        `running (it may have started, worked, and exited; nothing was re-shipped)`,
    );
    console.log(
      `  collect: beam down ${id}   (retains the remote); retire with beam kill ${id} --purge ` +
        `before shipping again`,
    );
    console.log(`  discard: beam kill ${id} --purge`);
  }
}

/**
 * A reused record that reached `up` had a COMPLETE ship whose agent owned
 * this workspace. Whether that agent is still running or has already
 * exited, the remote side may hold work — commits, files, an in-progress
 * git operation, an advanced transcript — that exists nowhere else, and a
 * re-ship would replace the workspace, `.git`, and transcript with the
 * stale local side. Without an exact remote-generation proof there is no
 * safe automatic reset: collect first, always. (`starting` records are
 * finalized by the caller; `provisioning` records are interrupted ships
 * whose retry is the ONLY re-ship path.)
 */
async function upRestartRetainedAgent(o: {
  record: BeamRecord;
  spec: TargetSpec;
  t: Transport;
  runtime: TmuxRuntime;
  agentAlive: boolean;
  targetName: string;
}): Promise<void> {
  const record = o.record;
  if (o.agentAlive) {
    throw new Error(
      `handoff ${record.id} already has a live agent (tmux ${record.tmux}) on ${o.targetName} — ` +
        `beam attach ${record.id} to watch it, or collect it (beam down ${record.id}) and ` +
        `retire it (beam kill ${record.id} --purge) before re-shipping`,
    );
  }
  // Retained handoff whose agent exited: when the ship journaled its
  // resume argv, restart the agent IN PLACE on the retained remote
  // generation — zero sync, zero install, not one local byte shipped
  // over the retained work. A fresh ship requires retiring the
  // handoff explicitly.
  if (record.resumeArgv && record.resumeArgv.length > 0 && isRemoteCwdResolved(record)) {
    if (record.workspaceToken === undefined) {
      throw new Error(
        `handoff ${record.id} has no workspace ownership token on record — retire it ` +
          `(beam kill ${record.id} --purge)`,
      );
    }
    await assertContainedWorkspace(o.t, targetRoot(o.spec), record.remoteCwd, {
      owner: workspaceOwnerContent(record.id, record.workspaceToken),
    });
    await o.runtime.start(record.tmux, record.remoteCwd, record.resumeArgv);
    console.log(
      `\nrestarted handoff ${record.id}'s agent in place on ${o.targetName} — nothing was ` +
        `re-shipped`,
    );
    console.log(`  (local changes stay local: beam down ${record.id} collects the remote work;`);
    console.log(`   retire with beam kill ${record.id} --purge before shipping fresh)`);
    console.log(`  watch:   beam attach ${record.id}   (detach: ctrl-b d)`);
    return;
  }
  throw new Error(
    `handoff ${record.id} is already up on ${o.targetName} and its agent is no longer running — ` +
      `it may have finished work that exists only there. beam down ${record.id} collects it ` +
      `(remote retained); retire with beam kill ${record.id} --purge before shipping again`,
  );
}

/** Inputs for the ship execution once every reuse/refusal gate has passed. */
type UpExecuteShipOptions = {
  env: BeamEnv;
  config: Config;
  record: BeamRecord;
  spec: TargetSpec;
  t: Transport;
  runtime: TmuxRuntime;
  detected: DetectedSession | undefined;
  wtGit: MaterializedWorktreeGit | undefined;
  kickoff: string | undefined;
  reused: boolean;
  localCwd: string;
  targetName: string;
  expectedWorkspaceKind: "git" | "plain";
  values: UpValues;
};

/**
 * Immutable per-ship coordinates every upload/install phase binds through,
 * fixed the moment the owned workspace is established.
 */
type UpShipContext = {
  env: BeamEnv;
  id: string;
  t: Transport;
  root: string;
  remoteCwd: string;
  owner: string;
  targetName: string;
  verbose: boolean;
};

/**
 * The ship itself: establish the owned remote workspace, journal intent,
 * stage, upload (fresh generation or pending retry), land Git state,
 * install the session, start the agent, and flip the record to `up`.
 * No automatic re-ship exists anymore: a completed (`up`) record never
 * syncs again and a provisioning retry either proves the journaled stage
 * fully landed or fails closed — so there is no probe→sync window for a
 * remote writer to race, and no quiescence license is taken here.
 */
async function upExecuteShip(o: UpExecuteShipOptions): Promise<void> {
  const root = targetRoot(o.spec);
  const workspace = await upEstablishOwnedWorkspace({
    env: o.env,
    record: o.record,
    t: o.t,
    root,
    detected: o.detected,
    targetName: o.targetName,
  });
  const ship: UpShipContext = {
    env: o.env,
    id: o.record.id,
    t: o.t,
    root,
    remoteCwd: workspace.remoteCwd,
    owner: workspace.owner,
    targetName: o.targetName,
    verbose: o.values.verbose === true,
  };
  const excludes = await upJournalShipIntent(ship, {
    config: o.config,
    record: o.record,
    detected: o.detected,
    kickoff: o.kickoff,
    reused: o.reused,
    localCwd: o.localCwd,
    expectedWorkspaceKind: o.expectedWorkspaceKind,
    wtGit: o.wtGit,
  });
  const staged = await upStageAttempt(ship, {
    record: o.record,
    reused: o.reused,
    detected: o.detected,
    localCwd: o.localCwd,
    excludes,
  });
  const upload = await upUploadGeneration(ship, { staged, detected: o.detected, wtGit: o.wtGit });
  // Journal the exclude set THIS successful upload ran with: `beam down`
  // unions it into its inbound excludes, so a path excluded outbound
  // (never shipped) can never be read as a remote deletion and erased
  // locally after config/.beamignore drift. A pending resume ran no
  // upload, so it keeps the crashed attempt's journaled union.
  if (staged.pending === undefined) {
    updateRecord(o.env, o.record.id, { syncedExcludes: excludes });
  }
  // Ship identity promoted by the final `up` write (a Git ship's completed
  // generation); pending retries promote the JOURNALED one.
  const promoteShipInfo =
    staged.pending !== undefined ? staged.pending.git?.shipInfo : o.wtGit?.shipInfo;
  await upLandGitState(ship, {
    pending: staged.pending,
    wtGit: o.wtGit,
    pointerOwedGeneration: upload.pointerOwedGeneration,
    promoteShipInfo,
  });
  const started = await upInstallSessionAndStart(ship, {
    record: o.record,
    detected: o.detected,
    runtime: o.runtime,
    kickoff: o.kickoff,
    pending: staged.pending,
    stagedSession: staged.stagedSession,
    noStart: o.values["no-start"] === true,
  });
  upPromoteToUp(ship, { detected: o.detected, started, promoteShipInfo });
}

/**
 * Physical containment, proven ON the target: canonicalize the configured
 * root (root-level symlinks are trusted config), refuse any symlinked
 * component below it, and create the workspace only once it is proven a
 * strict physical descendant of the root. A pre-existing symlink at the
 * deterministic workspace path — the pre-created trap in a reusable
 * sandbox — fails HERE, before any local byte ships. What gets persisted
 * is the CANONICAL physical path: every later sync, install, cleanup, and
 * purge re-proves containment of exactly that path, so a post-hoc swap is
 * refused instead of followed. Ownership is decided in the SAME proof: a
 * fresh claim only ever lands on an absent/empty directory (planting
 * `.beam/owner` create-only with this record's token), a resolved record
 * requires its exact marker back, and an existing non-empty directory —
 * legacy, foreign, `.beam` or not — refuses with zero mutation.
 */
async function upEstablishOwnedWorkspace(o: {
  env: BeamEnv;
  record: BeamRecord;
  t: Transport;
  root: string;
  detected: DetectedSession | undefined;
  targetName: string;
}): Promise<{ owner: string; remoteCwd: string }> {
  // Credentials never travel with the workspace — probe the target's auth
  // state (best-effort) so a login gap surfaces before the mirror ships.
  if (o.detected?.adapter.remoteAuthProbe) {
    const probe = await o.t.exec(o.detected.adapter.remoteAuthProbe);
    if (probe.code !== 0) {
      console.warn(
        `warning: ${o.detected.adapter.binary} looks NOT logged in on ${o.targetName}.\n` +
          `         run: beam login ${o.targetName} --tool ${o.detected.adapter.tool}\n` +
          `         (shipping anyway — the agent will sit at a login prompt and your kickoff ` +
          `may be lost)`,
      );
    }
  }
  // The record's ownership token is the workspace claim: persisted with
  // the reservation, before any remote effect. No token on a reused
  // record means a pre-ownership handoff — refuse rather than guess.
  if (o.record.workspaceToken === undefined) {
    throw new Error(
      `handoff ${o.record.id} has no workspace ownership token on record — retire it ` +
        `(beam kill ${o.record.id} --purge) and ship fresh`,
    );
  }
  const owner = workspaceOwnerContent(o.record.id, o.record.workspaceToken);
  const remoteCwd = await establishContainedWorkspace(
    o.t,
    o.root,
    isRemoteCwdResolved(o.record)
      ? { path: o.record.remoteCwd } // reused handoffs re-prove their canonical cwd
      : { name: remoteWorkspaceName(o.record.localCwd) },
    { content: owner, adopt: isRemoteCwdResolved(o.record) ? "verify" : "create" },
  );
  // Persist the canonical remote cwd before anything lands under it — from
  // here on, every remote side effect has a collectable address on record,
  // and a later purge knows the path is real (remoteCwdResolved).
  updateRecord(o.env, o.record.id, { remoteCwd, remoteCwdResolved: true });
  // The transport credential is the blast radius — surface a dangerous
  // posture before the mirror (secrets included) ships. Warn, never block.
  const posture = await probePrivilege(o.t, remoteCwd);
  for (const warning of posture.warnings) {
    console.warn(`warning: ${warning}`);
  }
  return { owner, remoteCwd };
}

/**
 * Announce the ship, re-prove the pinned layout immediately before the
 * first workspace byte moves (provisioning/auth may have taken minutes —
 * the static Git payload must still describe the source at the instant
 * the mirror starts; the Git verifier ahead protects the finer-grained
 * HEAD/index/ref/config state), journal the retry boundary, and journal
 * the protection UNION of excludes.
 */
async function upJournalShipIntent(
  ship: UpShipContext,
  o: {
    config: Config;
    record: BeamRecord;
    detected: DetectedSession | undefined;
    kickoff: string | undefined;
    reused: boolean;
    localCwd: string;
    expectedWorkspaceKind: "git" | "plain";
    wtGit: MaterializedWorktreeGit | undefined;
  },
): Promise<string[]> {
  ensureGitExclude(o.localCwd);
  const excludes = gatherExcludes(o.localCwd, o.config);
  const git = await gitSummary(o.localCwd);
  console.log(
    `shipping ${o.localCwd}${git ? ` [${git}]` : ""}\n      -> ${ship.t.label}:${ship.remoteCwd}` +
      (excludes.length > 0 ? `\n      excludes: ${excludes.join(", ")}` : ""),
  );
  assertPinnedWorkspaceLayout({
    id: ship.id,
    localCwd: o.localCwd,
    expected: o.expectedWorkspaceKind,
  });
  await o.wtGit?.assertSourceUnchanged();
  if (o.reused) {
    // This write is the retry journal boundary. No workspace byte has
    // moved yet; after it, any failed sync is an interrupted new ship.
    // Keep the prior wtGit until the workspace mirror and its second
    // source check complete, because the remote still has the old `.git`.
    updateRecord(ship.env, ship.id, {
      tool: o.detected?.adapter.tool,
      sessionId: o.detected?.session.id,
      sessionFile: o.detected?.session.file,
      artifactsDir: o.detected?.session.artifactsDir,
      kickoff: o.kickoff,
      status: "provisioning",
    });
  }
  // remoteCwd is what a mirrored ship empties and a later purge rm -rfs —
  // vet it before the first destructive remote command.
  assertPurgeablePath(ship.remoteCwd);
  // Journal the protection UNION before the first workspace byte moves:
  // a partial (or complete but not-yet-journaled) mirror honors the
  // ATTEMPTED excludes, so a crash right after it — followed by
  // config/.beamignore drift — must never leave `beam down` free to
  // overwrite or mirror-delete a newer local path this ship never read.
  // Prior protection is never dropped mid-handoff; only the
  // completed-ship journal narrows the set to what the finished mirror
  // actually ran with.
  updateRecord(ship.env, ship.id, {
    syncedExcludes: [...new Set([...(o.record.syncedExcludes ?? []), ...excludes])],
  });
  return excludes;
}

/** The staged local snapshots of this attempt, plus its pending journal. */
type UpStagedAttempt = {
  shipStage: StagedWorkspaceShip;
  pending: ShipPendingJournal | undefined;
  stagedSession: StagedSessionJournal | undefined;
};

/**
 * Stage the mirrored namespace into a LOCAL quarantine and prove the
 * snapshot coherent (double-pass fingerprint) BEFORE any remote byte
 * moves: a background writer mid-mirror would otherwise ship a torn
 * multi-file state that every Git-level check waves through. The upload
 * reads only the immutable stage. The session source is snapshotted the
 * same way: into an IMMUTABLE Beam-private stage NOW — before the pending
 * journal and before any remote byte of this attempt. The journal
 * references the stage, the install reads ONLY the stage, and a crashed
 * attempt's retry re-proves the stage — never the live harness store,
 * which may advance or be rewritten underneath a running local agent.
 */
async function upStageAttempt(
  ship: UpShipContext,
  o: {
    record: BeamRecord;
    reused: boolean;
    detected: DetectedSession | undefined;
    localCwd: string;
    excludes: string[];
  },
): Promise<UpStagedAttempt> {
  const shipStage = await stageWorkspaceShip(o.localCwd, o.excludes, ship.verbose);
  const pending = o.reused ? o.record.shipPending : undefined;
  let stagedSession: StagedSessionJournal | undefined;
  if (pending === undefined) {
    // No journal references any stage of this record: whatever ship-stage
    // residue exists (an attempt that crashed between staging and its
    // journal write) is orphaned Beam-private scratch — clear it before
    // staging anew. A pending retry NEVER clears: its journal still
    // points into this directory.
    rmSync(sessionStageRoot(ship.env, ship.id), { recursive: true, force: true });
    if (o.detected) {
      stagedSession = {
        tool: o.detected.adapter.tool,
        id: o.detected.session.id,
        ...stageSessionBundle(ship.env, ship.id, o.detected.session),
      };
    }
  }
  return { shipStage, pending, stagedSession };
}

/** Fixed entry names inside a journaled session ship-stage bundle dir. */
const STAGED_TRANSCRIPT = "transcript.jsonl";
const STAGED_ARTIFACTS = "artifacts";

/** Root of a record's Beam-private session bundle stages. */
function sessionStageRoot(env: BeamEnv, id: string): string {
  return join(env.beamDir, "ship-stage", id);
}

/** One digest binding the transcript and artifacts identities of a bundle. */
function sessionBundleDigest(transcriptDigest: string, artifactsDigest: string | null): string {
  return new Bun.CryptoHasher("sha256")
    .update(`${transcriptDigest}\n${artifactsDigest ?? "absent"}\n`)
    .digest("hex");
}

/** Fingerprint equality for optional artifacts manifests (null = ships none). */
function artifactsEqual(
  a: { digest: string; entries: number } | null,
  b: { digest: string; entries: number } | null,
): boolean {
  return a === null ? b === null : b !== null && a.digest === b.digest && a.entries === b.entries;
}

/**
 * Deeper than any tree PATH_MAX (4096 on Linux) can address even with
 * one-character segments, and matching the sibling tree-walk ceilings: a
 * walk this deep can only be a cycle (a directory replaced mid-copy) —
 * refuse, never spin.
 */
const MAX_SESSION_TREE_DEPTH = 4096;

/**
 * Byte/mode/symlink-faithful tree copy for the artifacts bundle — exactly
 * the entry classes `workspaceReturnFingerprint` pins, so a faithful copy
 * re-fingerprints to the source's digest and the stage proof is exact.
 * lstat-driven: symlinks are re-created (never followed); special entries
 * (fifos, sockets, devices) refuse — they cannot be copied byte-faithfully
 * and must never silently vanish from a journaled bundle. Iterative DFS
 * with an explicit, depth-bounded stack: entries are pushed in reverse
 * readdir order so they pop — and copy — in exactly readdir order, a
 * directory's contents before its later siblings.
 */
function copySessionTree(source: string, destination: string): void {
  mkdirSync(destination);
  chmodSync(destination, lstatSync(source).mode & 0o7777);
  const stack: Array<{ from: string; to: string; depth: number }> = [];
  for (const entry of readdirSync(source).reverse()) {
    stack.push({ from: join(source, entry), to: join(destination, entry), depth: 1 });
  }
  while (stack.length > 0) {
    const item = stack.pop()!; // non-null: emptiness is the loop condition
    const st = lstatSync(item.from);
    if (st.isDirectory()) {
      if (item.depth >= MAX_SESSION_TREE_DEPTH) {
        throw new Error(
          `beam up: session artifacts tree exceeds ${MAX_SESSION_TREE_DEPTH} levels at ` +
            `${item.from} — refusing what can only be a cycle`,
        );
      }
      mkdirSync(item.to);
      chmodSync(item.to, st.mode & 0o7777);
      for (const entry of readdirSync(item.from).reverse()) {
        stack.push({
          from: join(item.from, entry),
          to: join(item.to, entry),
          depth: item.depth + 1,
        });
      }
      continue;
    }
    if (st.isSymbolicLink()) {
      symlinkSync(readlinkSync(item.from), item.to);
      continue;
    }
    if (st.isFile()) {
      copyFileSync(item.from, item.to);
      chmodSync(item.to, st.mode & 0o7777);
      continue;
    }
    throw new Error(
      `beam up: session artifacts hold an unsupported filesystem entry ` +
        `(fifo/socket/device): ${item.from}`,
    );
  }
}

/**
 * Stage the local session source into an IMMUTABLE Beam-private bundle
 * (`<beamDir>/ship-stage/<recordId>/<random hex>`) and prove the copy
 * coherent — BEFORE the attempt's pending journal and before any remote
 * byte of the attempt moves. This closes the fresh-session TOCTOU:
 *
 *  - PRE manifest: digest the live transcript + artifacts tree;
 *  - copy into a create-only op dir (random leaf, EEXIST refuses — the
 *    journal's stage reference must be exclusively this attempt's);
 *  - POST manifest: the LIVE source must still digest identically — a
 *    harness writing mid-copy tears the snapshot and must refuse;
 *  - STAGE manifest: the copy itself must digest identically.
 *
 * The pending journal then references the STAGE, the install reads ONLY
 * the stage, and a crashed attempt's retry re-proves the stage instead of
 * the live store — local harness drift after this instant is irrelevant.
 */
function stageSessionBundle(
  env: BeamEnv,
  id: string,
  session: LocalSession,
): {
  stage: string;
  digest: string;
  artifacts: { digest: string; entries: number } | null;
  bundleDigest: string;
} {
  const preTranscript = fileSha256(session.file);
  const preArtifacts =
    session.artifactsDir !== undefined ? workspaceReturnFingerprint(session.artifactsDir) : null;
  const parent = sessionStageRoot(env, id);
  mkdirSync(parent, { recursive: true });
  // Create-only leaf: a collision on 8 random bytes is astronomically
  // unlikely and MUST fail (EEXIST) rather than ever share or reuse a
  // stage — and the collided dir is left untouched.
  const stage = join(parent, randomBytes(8).toString("hex"));
  mkdirSync(stage);
  try {
    copyFileSync(session.file, join(stage, STAGED_TRANSCRIPT));
    if (session.artifactsDir !== undefined) {
      copySessionTree(session.artifactsDir, join(stage, STAGED_ARTIFACTS));
    }
    const postTranscript = fileSha256(session.file);
    const postArtifacts =
      session.artifactsDir !== undefined
        ? workspaceReturnFingerprint(session.artifactsDir)
        : null;
    const stagedTranscript = fileSha256(join(stage, STAGED_TRANSCRIPT));
    const stagedArtifacts =
      session.artifactsDir !== undefined
        ? workspaceReturnFingerprint(join(stage, STAGED_ARTIFACTS))
        : null;
    if (
      preTranscript !== postTranscript ||
      postTranscript !== stagedTranscript ||
      !artifactsEqual(preArtifacts, postArtifacts) ||
      !artifactsEqual(postArtifacts, stagedArtifacts)
    ) {
      throw new Error(
        `beam up: the local session source for ${session.tool}/${session.id} changed while its ` +
          `bundle was being staged — a torn snapshot never ships. Wait for the local harness ` +
          `to settle, then retry beam up`,
      );
    }
    return {
      stage,
      digest: stagedTranscript,
      artifacts:
        stagedArtifacts === null
          ? null
          : { digest: stagedArtifacts.digest, entries: stagedArtifacts.entries },
      bundleDigest: sessionBundleDigest(stagedTranscript, stagedArtifacts?.digest ?? null),
    };
  } catch (err) {
    // Pre-journal scratch nothing references yet — never leave an unproven
    // stage behind (a copy failure and a torn source discard identically).
    rmSync(stage, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Re-prove a journaled stage before a pending retry touches the remote:
 * the staged transcript and artifacts must re-fingerprint to EXACTLY the
 * journaled digests (bundle digest included). A missing, truncated, or
 * tampered stage fails closed BEFORE any remote write — the remote keeps
 * the crashed attempt's bytes, and only a purge can retire them.
 */
function assertJournaledSessionStage(id: string, s: StagedSessionJournal): void {
  // Journals written before staged bundles existed carry digests only —
  // their attempt's exact bytes were never preserved and cannot be proven.
  const legacy = s as Partial<StagedSessionJournal>;
  if (
    legacy.stage === undefined ||
    legacy.bundleDigest === undefined ||
    legacy.artifacts === undefined
  ) {
    throw new Error(
      `handoff ${id} was journaled before staged session bundles and its interrupted attempt ` +
        `cannot be re-proven — beam kill ${id} --purge, then ship fresh`,
    );
  }
  const stale = (why: string): Error =>
    new Error(
      `handoff ${id}: the staged session bundle of its interrupted ship ${why} — refusing to ` +
        `install an unproven transcript over the journaled generation (nothing remote was ` +
        `touched). beam kill ${id} --purge, then ship fresh`,
    );
  let transcript: string;
  try {
    transcript = fileSha256(join(s.stage, STAGED_TRANSCRIPT));
  } catch {
    throw stale("is missing its transcript");
  }
  if (transcript !== s.digest) throw stale("no longer matches its journaled transcript digest");
  let artifactsDigest: string | null = null;
  if (s.artifacts !== null) {
    let fp: { digest: string; entries: number };
    try {
      fp = workspaceReturnFingerprint(join(s.stage, STAGED_ARTIFACTS));
    } catch {
      throw stale("is missing its artifacts tree");
    }
    if (fp.digest !== s.artifacts.digest || fp.entries !== s.artifacts.entries) {
      throw stale("no longer matches its journaled artifacts fingerprint");
    }
    artifactsDigest = fp.digest;
  }
  if (sessionBundleDigest(transcript, artifactsDigest) !== s.bundleDigest) {
    throw stale("no longer matches its journaled bundle digest");
  }
}

/**
 * Upload phase behind the ship-stage dispose guard. A pending retry NEVER
 * rematerializes and NEVER syncs the LIVE root: every phase is proven
 * create-only / exact-accept on the target, or the retry fails closed
 * with the remote byte-identical. The ONLY thing a retry may re-sync is
 * the Beam-owned reserved upload stage of its own journaled generation —
 * never user-visible paths. The session installs from the attempt's
 * journaled IMMUTABLE stage, so live-store drift is irrelevant. Returns
 * the journaled generation whose `.git` pointer publish is still owed,
 * when the retry proved both uploads landed but the pointer did not.
 */
async function upUploadGeneration(
  ship: UpShipContext,
  o: {
    staged: UpStagedAttempt;
    detected: DetectedSession | undefined;
    wtGit: MaterializedWorktreeGit | undefined;
  },
): Promise<{ pointerOwedGeneration: string | undefined }> {
  try {
    if (o.staged.pending !== undefined) {
      return await upResumePendingUpload(ship, {
        pending: o.staged.pending,
        detected: o.detected,
        shipStageDir: o.staged.shipStage.dir,
      });
    }
    await upUploadFreshGeneration(ship, {
      wtGit: o.wtGit,
      stagedSession: o.staged.stagedSession,
      shipStageDir: o.staged.shipStage.dir,
    });
    return { pointerOwedGeneration: undefined };
  } finally {
    o.staged.shipStage.dispose();
  }
}

/**
 * Resume an interrupted ship from its pending journal: re-prove the
 * session identity and staged bundle, reconcile a crashed pointer
 * publish's staging temp, converge the workspace, and prove the Git
 * landing — or fail closed with the remote byte-identical.
 */
async function upResumePendingUpload(
  ship: UpShipContext,
  o: {
    pending: ShipPendingJournal;
    detected: DetectedSession | undefined;
    shipStageDir: string;
  },
): Promise<{ pointerOwedGeneration: string | undefined }> {
  const pending = o.pending;
  upAssertPendingSessionIdentity(ship, { pending, detected: o.detected });
  if (pending.session !== undefined) assertJournaledSessionStage(ship.id, pending.session);
  // A crashed pointer publish may have left its journaled SINGLE-component
  // staging temp at the workspace root; reconcile it BEFORE the strict
  // full-tree proof (exactly our bytes — removed; anything else — a
  // divergent collision that refuses, byte-intact, for manual inspection).
  if (pending.git !== undefined) {
    const generation = pending.git.shipInfo.generation;
    await reconcileGitPointerTemp(ship.t, ship.remoteCwd, generation, ship.owner);
  }
  const wsProven = await upConvergePendingWorkspace(ship, {
    pending,
    shipStageDir: o.shipStageDir,
  });
  if (pending.git !== undefined) {
    return await upProvePendingGit(ship, { git: pending.git, wsProven });
  }
  if (!wsProven) {
    throw new Error(
      `handoff ${ship.id}: the interrupted ship cannot be proven complete on ${ship.targetName} ` +
        `(workspace mirror unproven) — refusing to re-run a sync over it. ` +
        `Retire the handoff (beam kill ${ship.id} --purge) and ship fresh`,
    );
  }
  console.log(
    `resuming interrupted handoff ${ship.id} — its workspace already landed on ` +
      `${ship.targetName}; re-shipping nothing`,
  );
  return { pointerOwedGeneration: undefined };
}

/**
 * Only the session IDENTITY must still be the one the record pinned; the
 * staged bundle is then re-proven against the journal before any remote
 * write.
 */
function upAssertPendingSessionIdentity(
  ship: UpShipContext,
  o: { pending: ShipPendingJournal; detected: DetectedSession | undefined },
): void {
  const pending = o.pending;
  const detected = o.detected;
  if (
    (pending.session === undefined) !== (detected === undefined) ||
    (pending.session !== undefined &&
      detected !== undefined &&
      (pending.session.tool !== detected.adapter.tool ||
        pending.session.id !== detected.session.id))
  ) {
    throw new Error(
      `handoff ${ship.id}: the session identity changed (or was switched on/off) since the ` +
        `interrupted ship — refusing to install a different session over its journaled ` +
        `generation. Retire the handoff (beam kill ${ship.id} --purge) and ship fresh`,
    );
  }
}

/**
 * Workspace phase of a pending retry. The journaled generation's reserved
 * upload stage (`.beam/uploads/<workspaceDigest>`) tells the retry where
 * it crashed: while the stage still exists on the target, the retry
 * re-converges it (additive checksum re-sync into Beam-owned scratch —
 * never the live root, never a mirrored deletion) and re-runs the
 * create-only publish, which is idempotent through its exact-accept
 * EEXIST path — a partial landing completes, a complete one re-proves,
 * and any divergent live entry refuses byte-intact. An extraneous stage
 * entry (only foreign interference can plant one) would publish and then
 * fail the strict stage-vs-live proof — fail-closed, remote intact. Once
 * a proof journaled `workspaceInstalled` and the stage was reaped, the
 * retry proves the LIVE root against the journaled digest instead —
 * nothing is ever synced over unproven remote state.
 */
async function upConvergePendingWorkspace(
  ship: UpShipContext,
  o: { pending: ShipPendingJournal; shipStageDir: string },
): Promise<boolean> {
  const pending = o.pending;
  const stagePresent = await remoteWorkspaceUploadStagePresent(
    ship.t,
    ship.remoteCwd,
    pending.workspaceDigest,
    ship.owner,
  );
  if (!stagePresent) {
    return (
      pending.workspaceInstalled === true &&
      (await remoteWorkspaceTreeFingerprint(ship.t, ship.remoteCwd)).digest ===
        pending.workspaceDigest
    );
  }
  const stagedWs = stagedWorkspaceTreeFingerprint(o.shipStageDir);
  if (stagedWs.digest !== pending.workspaceDigest) {
    throw new Error(
      `handoff ${ship.id}: the workspace changed since the interrupted ship — refusing to ` +
        `publish a different tree over its journaled generation. Retire the handoff ` +
        `(beam kill ${ship.id} --purge) and ship fresh`,
    );
  }
  const stagePath = `${ship.remoteCwd}/${workspaceUploadStagePath(pending.workspaceDigest)}`;
  await ship.t.syncUp(o.shipStageDir, stagePath, {
    checksum: true,
    delete: false,
    owned: { root: ship.remoteCwd, ownerBytes: ship.owner },
    verbose: ship.verbose,
  });
  await publishWorkspaceUploadStage(ship.t, ship.remoteCwd, pending.workspaceDigest, ship.owner);
  const remoteWs = await remoteWorkspaceTreeFingerprint(ship.t, ship.remoteCwd);
  if (remoteWs.digest !== stagedWs.digest || remoteWs.entries !== stagedWs.entries) {
    throw new Error(
      `handoff ${ship.id}: the uploaded workspace does not match the staged mirror ` +
        `(${remoteWs.entries} vs ${stagedWs.entries} entries) — something else is writing in ` +
        `${ship.remoteCwd}; refusing to continue (nothing was deleted). Inspect the target, ` +
        `then retry beam up or retire the handoff (beam kill ${ship.id} --purge)`,
    );
  }
  // Proof first, then the journal flip, then the reap: a crash between
  // any two leaves a state the next retry converges from.
  updateRecord(ship.env, ship.id, { shipPending: { ...pending, workspaceInstalled: true } });
  await removeWorkspaceUploadStage(ship.t, ship.remoteCwd, pending.workspaceDigest, ship.owner);
  return true;
}

/**
 * Git phase of a pending retry. The pointer only ever publishes after the
 * strict workspace proof and the payload proof of its own attempt — a
 * published pointer with the journaled payload intact proves BOTH upload
 * phases (resume at the session phase). A pointer still owed publishes
 * ONLY when both uploads are proven complete — the workspace through its
 * journaled stage receipt/digest, the Git payload through its
 * payload-scoped out-of-tree license marker plus the byte-level
 * fingerprint. Anything ambiguous — no marker support, a partial upload,
 * a diverged tree — fails closed instead of re-running a sync over
 * unknown remote state.
 */
async function upProvePendingGit(
  ship: UpShipContext,
  o: { git: GitPendingJournal; wsProven: boolean },
): Promise<{ pointerOwedGeneration: string | undefined }> {
  const priorGen = o.git.shipInfo.generation;
  const payloadRel = gitPayloadPath(priorGen);
  const state = await remoteGitPointerState(ship.t, ship.remoteCwd, priorGen, ship.owner);
  if (state.git === "foreign") {
    throw new Error(
      `handoff ${ship.id} found a .git in ${ship.remoteCwd} that is not its journaled ship — ` +
        `refusing to touch it. Collect (beam down ${ship.id}) and retire ` +
        `(beam kill ${ship.id} --purge) the handoff, then ship fresh`,
    );
  }
  const payloadIntact =
    state.payloadPresent &&
    (await remoteGitTreeFingerprint(ship.t, ship.remoteCwd, payloadRel, ship.owner)).digest ===
      o.git.payloadDigest;
  if (state.git === "ours") {
    if (!payloadIntact) {
      throw new Error(
        `handoff ${ship.id}: the published remote .git of the interrupted ship does not match ` +
          `its journal — refusing to touch it (remote intact). Retire the handoff ` +
          `(beam kill ${ship.id} --purge) and ship fresh`,
      );
    }
    console.log(
      `resuming interrupted handoff ${ship.id} — its workspace and Git payload already landed ` +
        `on ${ship.targetName}; re-shipping nothing (local changes since then stay local)`,
    );
    return { pointerOwedGeneration: undefined };
  }
  const payloadProven =
    (await ship.t.syncLicense?.(`${ship.remoteCwd}/${payloadRel}`)) === true && payloadIntact;
  if (!o.wsProven || !payloadProven) {
    throw new Error(
      `handoff ${ship.id}: the interrupted ship cannot be proven complete on ${ship.targetName} ` +
        `(workspace mirror ${o.wsProven ? "proven" : "unproven"}, Git payload ${
          payloadProven ? "proven" : "unproven"
        }) — refusing to re-run a sync over it. ` +
        `Retire the handoff (beam kill ${ship.id} --purge) and ship fresh`,
    );
  }
  console.log(
    `resuming interrupted handoff ${ship.id} — its mirror and Git payload are proven landed ` +
      `on ${ship.targetName}; publishing the .git pointer only`,
  );
  return { pointerOwedGeneration: priorGen };
}

/** The fresh attempt's journaled Git payload identity (shipPending.git). */
type GitPendingJournal = NonNullable<ShipPendingJournal["git"]>;

/**
 * Fresh attempt (no pending journal): journal, then upload. The workspace
 * mirror NEVER lands in the live root directly: a receiving rsync/tar
 * overwrites by name, so a foreign same-name file created after the
 * establish check would be replaced. The exact staged mirror ships into
 * this generation's Beam-owned reserved stage instead — ADDITIVE
 * (`delete: false`, the kubectl tar transport refuses mirrored deletion
 * and the per-generation stage needs none: it is fresh or a crashed
 * attempt's partial copy of the SAME immutable tree, and `checksum`
 * overwrites any divergent Beam-owned residue in place; no excludes — the
 * stage tree is already filtered). One owner-held shell then publishes it
 * into the held root strictly CREATE-ONLY: mkdir/link/symlink all fail
 * EEXIST rather than follow or replace, so a concurrent foreign entry
 * survives byte-for-byte and the strict proof below refuses with it
 * intact.
 */
async function upUploadFreshGeneration(
  ship: UpShipContext,
  o: {
    wtGit: MaterializedWorktreeGit | undefined;
    stagedSession: StagedSessionJournal | undefined;
    shipStageDir: string;
  },
): Promise<void> {
  // The Git payload and the staged workspace must describe ONE coherent
  // checkout instant: Git state may not have moved across the staging
  // window.
  await o.wtGit?.assertSourceUnchanged();
  const stagedWs = stagedWorkspaceTreeFingerprint(o.shipStageDir);
  const gitPending = await upJournalFreshGeneration(ship, {
    wtGit: o.wtGit,
    stagedSession: o.stagedSession,
    workspaceDigest: stagedWs.digest,
  });
  const stagePath = `${ship.remoteCwd}/${workspaceUploadStagePath(stagedWs.digest)}`;
  await ship.t.syncUp(o.shipStageDir, stagePath, {
    checksum: true,
    delete: false,
    owned: { root: ship.remoteCwd, ownerBytes: ship.owner },
    verbose: ship.verbose,
  });
  await publishWorkspaceUploadStage(ship.t, ship.remoteCwd, stagedWs.digest, ship.owner);
  // Strict full-tree proof: the remote workspace must BE the staged
  // mirror, with only Beam's own `.beam` pruned. Source excludes are NOT
  // applied remotely — the stage already omits them, so any concurrent
  // extra (a raced `.git`, an excluded-name secret) shows as a mismatch
  // and refuses BEFORE the Git landing and before any agent starts, with
  // the extra preserved.
  const remoteWs = await remoteWorkspaceTreeFingerprint(ship.t, ship.remoteCwd);
  if (remoteWs.digest !== stagedWs.digest || remoteWs.entries !== stagedWs.entries) {
    throw new Error(
      `handoff ${ship.id}: the uploaded workspace does not match the staged mirror ` +
        `(${remoteWs.entries} vs ${stagedWs.entries} entries) — something else is writing in ` +
        `${ship.remoteCwd}; refusing to continue (nothing was deleted). Inspect the target, ` +
        `then retry beam up or retire the handoff (beam kill ${ship.id} --purge)`,
    );
  }
  // The publish is proven: flip `workspaceInstalled` (a retry may now skip
  // the upload entirely and re-prove the live root against the journaled
  // digest) BEFORE reaping the reserved stage — a crash between the two
  // leaves the stage behind and the retry re-converges it.
  updateRecord(ship.env, ship.id, {
    shipPending: {
      workspaceDigest: stagedWs.digest,
      session: o.stagedSession,
      git: gitPending,
      workspaceInstalled: true,
    },
  });
  await removeWorkspaceUploadStage(ship.t, ship.remoteCwd, stagedWs.digest, ship.owner);
}

/**
 * Journal the COMPLETE next generation — strict workspace digest, exact
 * session snapshot, and (for Git ships) the full ship identity, payload
 * fingerprint, and pointer bytes — BEFORE the first remote byte of this
 * attempt. It stays on record through the session install and the agent
 * start; ONLY the final `up` write clears it.
 */
async function upJournalFreshGeneration(
  ship: UpShipContext,
  o: {
    wtGit: MaterializedWorktreeGit | undefined;
    stagedSession: StagedSessionJournal | undefined;
    workspaceDigest: string;
  },
): Promise<GitPendingJournal | undefined> {
  let gitPending: GitPendingJournal | undefined;
  if (o.wtGit) {
    const state = await remoteGitPointerState(
      ship.t,
      ship.remoteCwd,
      o.wtGit.shipInfo.generation,
      ship.owner,
    );
    if (state.git !== "absent") {
      throw new Error(
        `handoff ${ship.id} found an existing .git in ${ship.remoteCwd} that this attempt ` +
          `cannot prove it landed — refusing to touch it. Collect (beam down ${ship.id}) and ` +
          `retire (beam kill ${ship.id} --purge) the handoff, then ship fresh`,
      );
    }
    gitPending = {
      shipInfo: o.wtGit.shipInfo,
      payloadDigest: collectedGitTreeFingerprint(o.wtGit.gitDir).digest,
      pointer: gitPointerBytes(o.wtGit.shipInfo.generation),
    };
  }
  updateRecord(ship.env, ship.id, {
    workspaceKind: o.wtGit === undefined ? "plain" : "git",
    shipPending: {
      workspaceDigest: o.workspaceDigest,
      session: o.stagedSession,
      git: gitPending,
    },
  });
  return gitPending;
}

/**
 * Git payload landing for a fresh attempt: additive payload upload,
 * byte-level proof against the journal, then the atomic create-only
 * pointer publish. A publish-only resume proved the uploads already and
 * owes exactly the pointer. Every Git ship then re-proves owner +
 * published pointer + payload through the fused held chain immediately
 * before the session installs and the agent starts: a `.beam` replaced
 * (real dir or symlink) after the publish proof would swap the payload
 * the agent runs on — it is caught here with zero writes.
 */
async function upLandGitState(
  ship: UpShipContext,
  o: {
    pending: ShipPendingJournal | undefined;
    wtGit: MaterializedWorktreeGit | undefined;
    pointerOwedGeneration: string | undefined;
    promoteShipInfo: WtGitShipInfo | undefined;
  },
): Promise<void> {
  if (o.pending === undefined && o.wtGit !== undefined) {
    await upLandFreshGitPayload(ship, { wtGit: o.wtGit });
  }
  // A pointer can only be owed by a pending retry, never by a fresh ship,
  // so this publish and the fresh landing above are mutually exclusive.
  if (o.pointerOwedGeneration !== undefined) {
    await assertContainedWorkspace(ship.t, ship.root, ship.remoteCwd, { owner: ship.owner });
    await installRemoteGitPointer(ship.t, ship.remoteCwd, o.pointerOwedGeneration, ship.owner);
  }
  // Post-pointer gate for every Git ship (fresh, pointer-only, and a
  // resume whose pointer already landed).
  if (o.promoteShipInfo !== undefined) {
    const generation = o.promoteShipInfo.generation;
    const post = await remoteGitPointerState(ship.t, ship.remoteCwd, generation, ship.owner);
    if (post.git !== "ours" || !post.payloadPresent) {
      throw new Error(
        `handoff ${ship.id}: the published Git state changed under ${ship.remoteCwd} before ` +
          `the agent could start (pointer ${post.git}, payload ` +
          `${post.payloadPresent ? "present" : "missing"}) — refusing to ` +
          `install or start anything. Inspect the target, then retry beam up`,
      );
    }
  }
}

/**
 * The workspace upload ran behind the transport's own no-follow guard;
 * re-prove full physical containment before Git state lands under the
 * workspace, prove the staged remote payload IS the journaled payload —
 * byte-level, on the target — and only then publish the pointer.
 */
async function upLandFreshGitPayload(
  ship: UpShipContext,
  o: { wtGit: MaterializedWorktreeGit },
): Promise<void> {
  await assertContainedWorkspace(ship.t, ship.root, ship.remoteCwd, { owner: ship.owner });
  await o.wtGit.assertSourceUnchanged();
  const generation = o.wtGit.shipInfo.generation;
  const payloadRel = gitPayloadPath(generation);
  await ship.t.syncUp(o.wtGit.gitDir, `${ship.remoteCwd}/${payloadRel}`, {
    checksum: true,
    license: true,
    owned: { root: ship.remoteCwd, ownerBytes: ship.owner },
    verbose: ship.verbose,
  });
  // The staged remote payload must BE the journaled payload — proven
  // byte-level on the target — before the pointer publishes it.
  const staged = await remoteGitTreeFingerprint(ship.t, ship.remoteCwd, payloadRel, ship.owner);
  const journaled = collectedGitTreeFingerprint(o.wtGit.gitDir).digest;
  if (staged.digest !== journaled) {
    throw new Error(
      `handoff ${ship.id}: the remote Git payload does not match the journaled ship after ` +
        `staging — retry beam up`,
    );
  }
  await installRemoteGitPointer(ship.t, ship.remoteCwd, generation, ship.owner);
}

/**
 * Install the journaled staged session bundle and start the agent. A
 * fresh attempt staged the bundle in this run; a pending retry re-proved
 * it — the live store is never read past this point. Session bytes land
 * under the workspace (`.beam/…`): containment is re-proven immediately
 * before the install writes them, and the exact-owner bracket re-proves
 * the SAME owner after the install, before any agent starts.
 */
async function upInstallSessionAndStart(
  ship: UpShipContext,
  o: {
    record: BeamRecord;
    detected: DetectedSession | undefined;
    runtime: TmuxRuntime;
    kickoff: string | undefined;
    pending: ShipPendingJournal | undefined;
    stagedSession: StagedSessionJournal | undefined;
    noStart: boolean;
  },
): Promise<boolean> {
  if (o.detected === undefined) return false;
  const journaled = o.pending !== undefined ? o.pending.session : o.stagedSession;
  if (journaled === undefined) {
    // Unreachable: a sessioned fresh attempt always staged, and a
    // sessionless pending journal with a detected session was refused
    // earlier. Fail closed rather than fall back to the live store.
    throw new Error(
      `handoff ${ship.id}: no staged session bundle on record for this attempt — retry beam up`,
    );
  }
  const staged: LocalSession = {
    ...o.detected.session,
    file: join(journaled.stage, STAGED_TRANSCRIPT),
    // The stage is the CONTENT source; the live store path stays the
    // LAYOUT source for adapters that mirror it remotely (codex).
    storeFile: o.detected.session.file,
    artifactsDir:
      journaled.artifacts !== null ? join(journaled.stage, STAGED_ARTIFACTS) : undefined,
  };
  await assertContainedWorkspace(ship.t, ship.root, ship.remoteCwd, { owner: ship.owner });
  const installed = await o.detected.adapter.install(ship.t, staged, ship.remoteCwd, {
    kickoff: o.kickoff,
    // Deterministic remote install-stage key from the JOURNALED bundle: a
    // retry of this exact attempt converges onto the same reserved remote
    // `.beam/session-install/<key>` stage instead of littering the
    // workspace.
    installKey: sessionInstallKey({
      tool: journaled.tool,
      id: journaled.id,
      transcriptSha256: journaled.digest,
      artifactsSha256: journaled.artifacts?.digest,
    }),
    // The exact `.beam/owner` bytes: the adapter re-proves ownership
    // inside the same shells that move session bytes, not only in the
    // pre/post containment brackets here.
    owner: ship.owner,
  });
  for (const note of installed.notes) console.log(`  ${note}`);
  // Exact-owner bracket: the install wrote session bytes under the
  // workspace — prove the SAME owner is still there before any agent
  // starts. A mismatch refuses; the start never runs.
  await assertContainedWorkspace(ship.t, ship.root, ship.remoteCwd, { owner: ship.owner });
  if (o.noStart) return false;
  // Journal `starting` BEFORE tmux runs: a crash between the start and
  // the `up` flip leaves a status telling the retry that an agent may
  // already be running — finalize it, never re-ship over it.
  updateRecord(ship.env, ship.id, { status: "starting", resumeArgv: installed.resumeArgv });
  await o.runtime.start(o.record.tmux, ship.remoteCwd, installed.resumeArgv);
  return true;
}

/**
 * Only now — session installed, agent started, nothing left to fail — is
 * the handoff `up` and eligible for target-scoped selection. This ONE
 * atomic write clears the pending generation journal and, for a Git ship,
 * promotes the completed identity `beam down` collects against: a crash
 * anywhere earlier leaves `provisioning` WITH the journal, so the retry
 * can still prove and resume the exact landed generation.
 */
function upPromoteToUp(
  ship: UpShipContext,
  o: {
    detected: DetectedSession | undefined;
    started: boolean;
    promoteShipInfo: WtGitShipInfo | undefined;
  },
): void {
  updateRecord(ship.env, ship.id, {
    status: "up",
    shipPending: undefined,
    ...(o.promoteShipInfo !== undefined
      ? { wtGit: o.promoteShipInfo, workspaceKind: "git" as const }
      : {}),
  });
  // The completed ship's journal is gone; its immutable session stage has
  // no referent left. Reaped only HERE and in the starting-finalize path —
  // every crash path retains the stage so the journal it backs stays
  // provable. Order matters: flip first, then reap, so a crash between
  // the two leaves a resumable record, never a journal pointing at a
  // deleted stage.
  rmSync(sessionStageRoot(ship.env, ship.id), { recursive: true, force: true });

  console.log(`\nbeamed up as ${ship.id} (target: ${ship.targetName})`);
  if (o.started) {
    console.log(`  watch:   beam attach ${ship.id}   (detach: ctrl-b d)`);
    console.log(`  glimpse: beam status ${ship.id}`);
    if (o.detected?.adapter.tool === "omp") {
      console.log(`  browser: attach once and run /collab for a web link`);
    }
  } else {
    if (o.detected) {
      console.log(`  agent not started (--no-start); resume manually in ${ship.remoteCwd}`);
    }
  }
  console.log(`  return:  beam down ${ship.id}`);
}
