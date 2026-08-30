import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { cliAccent } from "../cli-output.ts";
import { loadConfig, targetRoot, type Config } from "../config.ts";
import { resolveEnv, type BeamEnv } from "../env.ts";
import { adapterFor } from "../session/index.ts";
import { collectSessionReturn } from "../session/collect-txn.ts";
import {
  acquireOperationLock,
  findRecord,
  getRecord,
  recordSpec,
  updateRecord,
  type BeamRecord,
} from "../state.ts";
import { createProvider } from "../provider/index.ts";
import { HerdrRuntime } from "../runtime/herdr.ts";
import { fileSha256 } from "../util/digest.ts";
import type { Transport } from "../transport/index.ts";
import {
  assertContainedWorkspace,
  assertWorkspaceReturnUnchanged,
  createReturnStage,
  gatherExcludes,
  remoteWorkspaceReturnFingerprint,
  stageWorkspaceReturn,
  workspaceOwnerContent,
  writeReturnStageManifest,
  type WorkspaceReturnFingerprint,
} from "../workspace.ts";
import {
  collectWorktreeGitReturn,
  prepareWorktreeGitReturn,
  remoteGitEntryKind,
  type CollectedWorktreeGitReturn,
} from "../workspace-git.ts";

export const DOWN_HELP =
  `beam down — stop the remote agent, collect + verify + stage its work, and retain the remote

usage: beam down [id] [options]
  --delete          license beam integrate to mirror remote deletions while
                    protecting every excluded local path
  --verbose, -v     stream rsync progress

\`beam down\` is non-destructive by contract. It NEVER mutates your live
workspace, worktree, or checkout, and it NEVER erases the remote. Every
returned workspace — plain or Git — is verified and persisted create-only
under ~/.beam/returns/<record>/<txn>/workspace (manifest.json beside it is
the verification receipt). For Git handoffs, remote commits and blobs land
additively in your object store, while every remote ref value, deletion,
stash, HEAD, index, and reflog is pinned append-only under a namespace keyed
by the exact collected snapshot, refs/beam/return/<id>/<fingerprint> (its
\`manifest\` blob maps every ref to its state and pin — earlier fingerprints
are history, never the latest); no branch is created, moved, or deleted, and HEAD and
the index stay exactly where you left them.
Run \`beam integrate <id>\` to inspect an itemized preview and confirm the
apply. It reuses the exact excludes from collection and, with \`--delete\`,
protects excluded local paths. Applying over a live tree cannot be atomic,
so quiesce local writers first.
Beam never deletes a persisted stage; remove old ~/.beam/returns stages
yourself after integration.

The remote workspace and sandbox remain up and collectible. Run another
\`beam down\` to collect newer work. Only after you have inspected and
integrated the return, \`beam kill <id> --purge\` explicitly abandons and
deletes ALL remaining remote state — including concurrent/detached writes;
it does not recollect or claim fingerprint safety.
`;

const STOP_GRACE_MS = 3000;

export async function cmdDown(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      delete: { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(DOWN_HELP);
    return;
  }

  const env = resolveEnv();
  const config = loadConfig(env);
  const selected = findRecord(env, positionals[0]);

  // Exactly one process may run this record's remote effects: a down that
  // interleaved with an in-flight up (or another down/kill) could collect
  // a half-extracted tree as an apparently authoritative return stage, or
  // destroy the claim under a live ship whose final `up` write lands last.
  // A live owner is refused promptly; the lock is held through the final state write.
  const releaseOp = acquireOperationLock(env, selected.id);
  try {
    // Re-read under the lock: the pre-lock copy may predate the previous
    // owner's final state write (status, resolved cwd, session identity).
    const record = getRecord(env, selected.id);
    const spec = recordSpec(record);
    const root = targetRoot(spec);
    const provider = createProvider(spec);
    if (!downCanCollect(record)) return;

    const wtReturn = record.wtGit !== undefined;
    const { excludes, owner } = await downProveReturnGuards({ record, config });
    const mirrorDeletes = values.delete === true;
    const verbose = values.verbose === true;

    const t = await provider.connect(record);
    const runtime = new HerdrRuntime(t);
    // Refuse before stopping the agent or reading any workspace byte.
    if (!wtReturn) {
      const when = "before stopping the agent";
      await downAssertPlainRemoteGitAbsent({ t, root, record, owner, when });
    }
    await downStopAgent({ runtime, session: record.runtimeSession });

    console.log(`collecting ${t.label}:${record.remoteCwd}`);
    const collect = { env, t, root, record, owner, excludes, mirrorDeletes, verbose };
    const outcome = wtReturn
      ? await downCollectGitReturn(collect)
      : await downCollectPlainReturn(collect);
    downRecordAndReport({ env, record, t, outcome });
  } finally {
    releaseOp();
  }
}

/**
 * Phase matrix — every state names its one legal recovery:
 *   provisioning        → refuse (retry `beam up` / abandon via kill)
 *   starting, up        → collect (the normal path)
 *   killing             → belongs to `beam kill --purge` (destroy-only)
 *   down, killed        → terminal, monotonic: nothing to bring back
 * Reports the terminal states and returns false; throws for the states
 * whose recovery belongs to another command.
 */
function downCanCollect(record: BeamRecord): boolean {
  if (record.status === "provisioning") {
    // The ship never completed — the remote tree is absent or partial.
    // Collecting it (worse: mirroring its absences with --delete) would
    // corrupt the local workspace with a half-shipped snapshot.
    throw new Error(
      `handoff ${record.id} is still provisioning — nothing complete to bring back. ` +
        `retry \`beam up\` to finish the ship, or \`beam kill ${record.id} --purge\` to abandon it`,
    );
  }
  if (record.status === "killing") {
    throw new Error(
      `handoff ${record.id} is mid-kill — run \`beam kill ${record.id} --purge\` ` +
        `to finish the destroy`,
    );
  }
  if (record.status === "down" || record.status === "killed") {
    console.log(`handoff ${record.id} is already ${record.status} — nothing to bring back`);
    return false;
  }
  return true;
}

/**
 * Every local proof that must pass before any remote effect: the plain
 * checkout-identity guard, the inbound exclude union, the Git repository
 * identity re-proof, and the record-bound workspace ownership token.
 */
async function downProveReturnGuards(options: {
  record: BeamRecord;
  config: Config;
}): Promise<{ excludes: string[]; owner: string }> {
  const { record, config } = options;
  // Legacy and plain-workspace records carry no Git identity. If such a
  // record's path now holds ANY `.git` entry — a standard checkout, a
  // linked worktree, or an unsupported layout — the return cannot prove
  // the checkout is the one it shipped: syncing the old remote bytes back
  // could overwrite an unrelated repository. Refuse before the agent is
  // stopped, before any sync, before any mutation on either side. Only a
  // truly non-Git working directory may take the plain return.
  if (record.wtGit === undefined) {
    if (lstatSync(join(record.localCwd, ".git"), { throwIfNoEntry: false }) !== undefined) {
      throw new Error(
        `beam down: ${record.localCwd} now contains a .git entry, but handoff ${record.id} ` +
          `carries no Git identity (it was shipped as a plain workspace, or by an older beam) ` +
          `— syncing the old remote bytes back could overwrite a repository this handoff ` +
          `cannot prove it owns. Move the current checkout aside and restore the original ` +
          `plain workspace at that path, then retry beam down — or abandon the handoff ` +
          `with \`beam kill ${record.id} --purge\` (both sides stay intact until then)`,
      );
    }
  }
  // Inbound excludes are the union of what the LAST SUCCESSFUL ship
  // excluded on the way out (persisted on the record) and the current
  // config/.beamignore set: anything excluded outbound never reached the
  // target, so a `--delete` mirror that stopped protecting it after
  // config drift would read its remote absence as a deletion and erase
  // the local copy.
  const excludes = [
    ...new Set([...(record.syncedExcludes ?? []), ...gatherExcludes(record.localCwd, config)]),
  ];
  // Git return guard, before any remote read: prove the repository
  // identity (paths plus device+inode of both git dirs, pinned by
  // create-only tokens) is still the one this record shipped.
  if (record.wtGit !== undefined) {
    await prepareWorktreeGitReturn(record.localCwd, record.id, record.wtGit);
  }
  // Record-bound workspace ownership: every containment re-proof below
  // requires the exact `.beam/owner` bytes back. A record without a
  // token cannot prove the remote workspace is its own — refuse ALL
  // collection and mutation instead of syncing foreign bytes home.
  if (record.workspaceToken === undefined) {
    throw new Error(
      `beam down: handoff ${record.id} has no workspace ownership token on record — it cannot ` +
        `prove the remote workspace is its own. Retire it with beam kill ${record.id} --purge`,
    );
  }
  return {
    excludes,
    owner: workspaceOwnerContent(record.id, record.workspaceToken),
  };
}

/**
 * A plain-origin handoff may have become a repository remotely at ANY
 * point — before this down, while the agent was being stopped, or
 * during the (potentially long) session collection. Every workspace
 * mirror excludes `.git`, so a plain return that "succeeded" past such
 * a creation would look complete while silently omitting the
 * commits/refs/index — and a later purge would destroy the only copy.
 * Owner-bound and containment-proven; re-run at every phase boundary.
 * ANY entry kind (directory, file, symlink, special) refuses with the
 * remote intact.
 */
async function downAssertPlainRemoteGitAbsent(options: {
  t: Transport;
  root: string;
  record: BeamRecord;
  owner: string;
  when: string;
}): Promise<void> {
  const { t, root, record, owner, when } = options;
  await assertContainedWorkspace(t, root, record.remoteCwd, { owner });
  const remoteGit = await remoteGitEntryKind(t, record.remoteCwd, owner);
  if (remoteGit !== "absent") {
    throw new Error(
      `beam down: handoff ${record.id} was shipped as a plain workspace but now has remote Git ` +
        `metadata (${remoteGit}: .git or a case-respelled .beam, in some ASCII case; detected ` +
        `${when}) — the mirror excludes those names, so a plain return cannot collect the ` +
        `repository state. It remains intact at ${t.label}:${record.remoteCwd}; recover or ` +
        `archive it there, then remove it and retry beam down`,
    );
  }
}

/** Stop the remote agent pane: interrupt, grace period, then kill. */
async function downStopAgent(options: {
  runtime: HerdrRuntime;
  session: string;
}): Promise<void> {
  const { runtime, session } = options;
  const agentAlive = await runtime.alive(session);
  if (agentAlive) {
    console.log(`stopping remote agent (${session})…`);
    await runtime.interrupt(session);
    await Bun.sleep(STOP_GRACE_MS);
    await runtime.kill(session);
  } else {
    console.log("remote agent already exited");
  }
}

/** Inputs shared by the Git and plain return-collection phases. */
interface DownCollectOptions {
  env: BeamEnv;
  t: Transport;
  root: string;
  record: BeamRecord;
  owner: string;
  excludes: string[];
  mirrorDeletes: boolean;
  verbose: boolean;
}

/** What a completed collection hands the final record/report phase. */
interface DownReturnOutcome {
  /** Local-resume hint from the session return, when one was collected. */
  hint: string | undefined;
  /** Staged-return summary lines, re-printed in the completion summary. */
  /** Latest verified workspace return, bound by the manifest digest. */
  receipt: { manifestFile: string; manifestDigest: string };
  stagedSummary: string[];
}

/**
 * Git handoff: the automatic return NEVER mutates the live local
 * workspace or checkout — no portable filesystem offers an atomic
 * apply over a live tree, and beam does not pretend otherwise. The
 * remote worktree is staged and proven stable, then PERSISTED
 * create-only under beam's own storage; the local repository
 * receives only non-destructive imports (objects, refs/beam/*
 * quarantine pins) plus the session store's own CAS transaction.
 * Integrating the returned files into the live worktree is the
 * user's explicit act, from the persisted stage.
 */
async function downCollectGitReturn(options: DownCollectOptions): Promise<DownReturnOutcome> {
  const { env, t, root, record, owner, excludes } = options;
  await assertContainedWorkspace(t, root, record.remoteCwd, { owner });
  const gitReturn = await collectWorktreeGitReturn(t, record);
  let stage: { root: string; workspace: string } | undefined;
  let stageVerified = false;
  // Set once a FRESH session receipt was journaled into THIS run's stage
  // txn: from that point the txn root is durable retry evidence (the
  // record's receipt points into it) and must survive a later refusal —
  // the missing workspace manifest still marks the stage untrusted.
  let sessionInStage = false;
  try {
    // Early local identity proof, before any staging work: the local
    // repository at localCwd must still be the one this record shipped
    // (paths plus device+inode of both git dirs). apply() re-proves the
    // same gate before its own effects; this call fails a same-path
    // repository swap cheaply, before the transfer.
    await gitReturn.assertLocalPrepared();
    stage = createReturnStage(env.beamDir, record.id);
    const fingerprint = await downStageStableWorkspace({
      ...options,
      stageWorkspace: stage.workspace,
    });
    // Cross-namespace coherence, in EVERY mode: the remote `.git` must
    // STILL be the collected snapshot now that the workspace is
    // staged. A writer that committed between the Git collection and
    // the workspace staging would otherwise persist a worktree/Git
    // pair that never coexisted remotely.
    await gitReturn.assertRemoteGitUnchanged("while the workspace was being staged");
    const session = await downCollectSession({ ...options, stageRoot: stage.root });
    if (session.freshlyStaged) sessionInStage = true;
    // Final combined-snapshot proof, immediately before the trusted
    // receipt: the (potentially long) session collection re-opened the
    // race window after the staging proofs. The mirrored namespace AND
    // the collected `.git` must still be exactly the staged snapshot —
    // a detached writer that landed during the session fetch refuses
    // here with nothing trusted, the remote intact (new work included),
    // and the record still collectible.
    await assertContainedWorkspace(t, root, record.remoteCwd, { owner });
    await assertWorkspaceReturnUnchanged(t, record.remoteCwd, fingerprint, {
      excludes,
      owner,
      when: "while the session was collected",
    });
    await gitReturn.assertRemoteGitUnchanged("while the session was collected");
    const published = downPublishReturnStage({
      ...options,
      stageRoot: stage.root,
      stageWorkspace: stage.workspace,
      fingerprint,
    });
    stageVerified = true;
    for (const line of published.stagedSummary) console.log(line);
    await downApplyGitState(gitReturn);
    return { hint: session.hint, ...published };
  } finally {
    // The verified stage is PERSISTED — never deleted by beam. An
    // unverified partial is removed UNLESS a fresh session receipt was
    // journaled into it: then the txn root is durable retry evidence
    // and the missing manifest alone marks the workspace untrusted.
    if (stage && !stageVerified && !sessionInStage) {
      rmSync(stage.root, { recursive: true, force: true });
    }
    gitReturn.dispose();
  }
}

/**
 * Plain workspace: the SAME safe root as Git handoffs, minus the Git
 * phases — the live local workspace is NEVER written. The filtered
 * remote tree is staged create-only under beam's own storage, proven
 * to be one stable remote snapshot, and persisted with a receipt;
 * integrating it is the user's explicit act from the printed path.
 */
async function downCollectPlainReturn(options: DownCollectOptions): Promise<DownReturnOutcome> {
  const { env, t, root, record, owner, excludes } = options;
  let stage: { root: string; workspace: string } | undefined;
  let stageVerified = false;
  // Set once a FRESH session receipt was journaled into THIS run's stage
  // txn: from that point the txn root is durable retry evidence (the
  // record's receipt points into it) and must survive a later refusal —
  // the missing workspace manifest still marks the stage untrusted.
  let sessionInStage = false;
  try {
    // The agent may have created a repository while it was being
    // stopped: re-prove plain-ness after the stop, before any
    // collection read.
    await downAssertPlainRemoteGitAbsent({ ...options, when: "after the agent was stopped" });
    stage = createReturnStage(env.beamDir, record.id);
    const fingerprint = await downStageStableWorkspace({
      ...options,
      stageWorkspace: stage.workspace,
    });
    const session = await downCollectSession({ ...options, stageRoot: stage.root });
    if (session.freshlyStaged) sessionInStage = true;
    // Final combined-snapshot proof, immediately before the trusted
    // receipt: the (potentially long) session collection re-opened the
    // race window after the staging proofs. The `.git` re-check rides
    // with it — a repository created during the session collection is
    // invisible to the (git-excluding) workspace fingerprint and must
    // refuse here, with nothing trusted and the remote intact.
    await assertContainedWorkspace(t, root, record.remoteCwd, { owner });
    await assertWorkspaceReturnUnchanged(t, record.remoteCwd, fingerprint, {
      excludes,
      owner,
      when: "while the session was collected",
    });
    await downAssertPlainRemoteGitAbsent({
      ...options,
      when: "immediately before publishing the return",
    });
    const published = downPublishReturnStage({
      ...options,
      stageRoot: stage.root,
      stageWorkspace: stage.workspace,
      fingerprint,
    });
    stageVerified = true;
    for (const line of published.stagedSummary) console.log(line);
    return { hint: session.hint, ...published };
  } finally {
    // The verified stage is PERSISTED — never deleted by beam. An
    // unverified partial is removed UNLESS a fresh session receipt was
    // journaled into it: then the txn root is durable retry evidence
    // and the missing manifest alone marks the workspace untrusted.
    if (stage && !stageVerified && !sessionInStage) {
      rmSync(stage.root, { recursive: true, force: true });
    }
  }
}

/**
 * Stage the filtered remote workspace into the create-only stage — the
 * transport never points at the local workspace. No-follow physical
 * containment is re-proven immediately before every remote read: a
 * workspace path swapped for a symlink must never be collected.
 * Stable-collection sandwich: the filtered namespace immediately
 * before the transfer, the collected stage, and a fresh post-probe
 * must all be byte-identical.
 */
async function downStageStableWorkspace(options: {
  t: Transport;
  root: string;
  record: BeamRecord;
  owner: string;
  excludes: string[];
  verbose: boolean;
  stageWorkspace: string;
}): Promise<WorkspaceReturnFingerprint> {
  const { t, root, record, owner, excludes, verbose } = options;
  await assertContainedWorkspace(t, root, record.remoteCwd, { owner });
  const preStage = await remoteWorkspaceReturnFingerprint(t, record.remoteCwd, excludes, owner);
  await assertContainedWorkspace(t, root, record.remoteCwd, { owner });
  const staged = await stageWorkspaceReturn(t, record.remoteCwd, options.stageWorkspace, {
    excludes,
    owner,
    verbose,
  });
  if (
    staged.fingerprint.digest !== preStage.digest ||
    staged.fingerprint.entries !== preStage.entries
  ) {
    throw new Error(
      `beam down: the remote workspace changed while it was being staged ` +
        `(fingerprint ${preStage.digest.slice(0, 12)} -> ` +
        `${staged.fingerprint.digest.slice(0, 12)}) — ` +
        `a background process is still writing to it. Refusing to publish an unstable return; ` +
        `the remote is intact, new work included. Retry beam down`,
    );
  }
  await assertContainedWorkspace(t, root, record.remoteCwd, { owner });
  await assertWorkspaceReturnUnchanged(t, record.remoteCwd, staged.fingerprint, {
    excludes,
    owner,
    when: "while it was being staged",
  });
  return staged.fingerprint;
}

/**
 * Session return collection: the grown transcript (and artifacts) land
 * create-only under this run's return-stage txn root, identity- and
 * stability-proven, and the record's receipt points at them. The local
 * harness store is NEVER touched — it can keep mutating concurrently.
 * `freshlyStaged` is true only when a FRESH session receipt was
 * journaled into THIS run's stage txn (false when the durable return
 * already held exactly the current remote state).
 */
async function downCollectSession(options: {
  env: BeamEnv;
  t: Transport;
  root: string;
  record: BeamRecord;
  owner: string;
  stageRoot: string;
}): Promise<{ hint: string | undefined; freshlyStaged: boolean }> {
  const { env, t, root, record, owner, stageRoot } = options;
  if (!record.tool || !record.sessionFile || !record.sessionId) {
    return { hint: undefined, freshlyStaged: false };
  }
  // The transcript fetch reads under the workspace too — re-prove
  // containment after the (potentially long) transfers before it.
  await assertContainedWorkspace(t, root, record.remoteCwd, { owner });
  const collected = await collectSessionReturn(env, record, adapterFor(record.tool), t, stageRoot);
  console.log(
    collected.alreadyCollected
      ? `session return already collected (verified byte-identical): ${collected.returnDir}`
      : `session return staged at ${collected.returnDir} ` +
        `(your local session store was not touched)`,
  );
  return { hint: collected.hint, freshlyStaged: !collected.alreadyCollected };
}

/**
 * Every proof passed: the stage is verified returned data. The manifest
 * receipt marks it trusted — a stage directory without one is an
 * unverified partial. Returns the staged-return summary lines the
 * command prints (immediately, and again in the completion summary).
 */
function downPublishReturnStage(options: {
  record: BeamRecord;
  excludes: string[];
  mirrorDeletes: boolean;
  stageRoot: string;
  stageWorkspace: string;
  fingerprint: WorkspaceReturnFingerprint;
}): {
  stagedSummary: string[];
  receipt: { manifestFile: string; manifestDigest: string };
} {
  const { record, excludes, mirrorDeletes, stageWorkspace } = options;
  const manifestFile = writeReturnStageManifest(options.stageRoot, {
    recordId: record.id,
    localCwd: record.localCwd,
    remoteCwd: record.remoteCwd,
    fingerprint: options.fingerprint,
    baseWorkspaceDigest: record.workspaceDigest ?? null,
    excludes,
    mirrorDeletes,
  });
  const receipt = { manifestFile, manifestDigest: fileSha256(manifestFile) };
  return {
    receipt,
    stagedSummary: [
      `returned workspace staged at ${stageWorkspace}`,
      `  verified receipt: ${manifestFile}`,
      `  next: beam integrate ${record.id}`,
    ],
  };
}

/**
 * Local Git import — non-destructive only: objects land additively in
 * the common repository, every remote ref value, deletion, symref,
 * stash, HEAD, index, and reflog is pinned append-only under a
 * per-collection namespace (refs/beam/return/<id>/<fp>), and NOTHING
 * outside refs/beam/* and the object store is written: no branch/tag
 * moves, no HEAD or index install. The live checkout stays
 * byte-identical.
 */
async function downApplyGitState(gitReturn: CollectedWorktreeGitReturn): Promise<void> {
  const ret = await gitReturn.apply();
  for (const note of ret.notes) console.log(`  ${note}`);
  console.log(
    `  git state home: objects imported additively, ` +
      `${ret.quarantined.length} ref value(s) preserved under ` +
      `${ret.qbase} — the local checkout is untouched`,
  );
}

/**
 * A completed down always remains `up` and collectible: the remote
 * workspace/sandbox is retained, and the session receipt persists — it
 * points at the durable return under beam's own storage; the local
 * harness store was never mutated, so there is nothing to reconcile.
 */
function downRecordAndReport(options: {
  env: BeamEnv;
  record: BeamRecord;
  t: Transport;
  outcome: DownReturnOutcome;
}): void {
  const { env, record, t, outcome } = options;
  updateRecord(env, record.id, { status: "up", returnReceipt: outcome.receipt });
  console.log(`\n${cliAccent("returned")} ${record.id} (remote retained)`);
  // The staged return comes FIRST in the completion summary: the live
  // worktree was not touched, so inspecting/integrating the stage is the
  // step before resuming local work.
  for (const line of outcome.stagedSummary) console.log(line);
  console.log(
    `  remote workspace retained: ${t.label}:${record.remoteCwd} — after ` +
      `inspecting/integrating the stage, discard it explicitly with ` +
      `beam kill ${record.id} --purge`,
  );
  if (outcome.hint) console.log(`  continue locally: ${outcome.hint}`);
}
