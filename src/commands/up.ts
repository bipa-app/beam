import { parseArgs } from "node:util";
import { loadConfig, resolveTarget, targetRoot, type TargetSpec } from "../config.ts";
import { resolveEnv } from "../env.ts";
import { detectSession, type ToolName } from "../session/index.ts";
import {
  acquireOperationLock,
  findRecoverableHandoff,
  getRecordForUp,
  isRemoteCwdResolved,
  planSessionIdentity,
  recordSpec,
  reserveTarget,
  updateRecord,
} from "../state.ts";
import { createProvider } from "../provider/index.ts";
import { TmuxRuntime } from "../runtime/tmux.ts";
import { shq, shqRemotePath } from "../util/shell.ts";
import { probePrivilege } from "../security.ts";
import {
  assertContainedWorkspace,
  assertPurgeablePath,
  BEAM_RESERVED_DIR,
  ensureGitExclude,
  establishContainedWorkspace,
  gatherExcludes,
  gitSummary,
  noFollowReservedDirGuard,
  noFollowReservedDirScript,
  remoteWorkspaceName,
} from "../workspace.ts";
import {
  isGitWorktree,
  materializeWorktreeGit,
  remoteGitOperationMarkers,
  type MaterializedWorktreeGit,
} from "../workspace-git.ts";

export const UP_HELP = `beam up — ship this workspace + session to a target and resume the agent there

usage: beam up [options]
  --target, -t <name>     configured target (default: config defaultTarget)
  --tool <omp|pi|claude|codex>  harness to hand off (default: auto-detect newest)
  --session <ref>         session id/filename prefix (default: newest for cwd)
  --message, -m <text>    kickoff prompt so the agent starts working unattended
  --no-session            ship the workspace only
  --no-start              install but do not start the remote agent
  --no-delete             do not mirror deletions on the target
  --verbose, -v           stream rsync progress
`;

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
      "no-delete": { type: "boolean" },
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

  // Resolve the target through the CURRENT config. When the entry was
  // removed or renamed, fall back to this workspace's own live handoff and
  // bind through its persisted snapshot: finishing an existing handoff
  // never depends on config, only a NEW one does (`recovering` makes the
  // reservation below refuse to author a fresh record).
  let targetName: string;
  let currentSpec: TargetSpec;
  let recovering = false;
  try {
    ({ name: targetName, spec: currentSpec } = resolveTarget(config, values.target));
  } catch (err) {
    // Recovery covers REMOVAL only — the requested (or default) name no
    // longer resolves. A config that merely demands disambiguation
    // (several targets, no default, no --target) keeps its own error:
    // guessing between configured targets is never recovery.
    const requested = values.target ?? config.defaultTarget;
    if (requested === undefined && Object.keys(config.targets).length > 0) throw err;
    const live = findRecoverableHandoff(env, requested, localCwd);
    if (!live?.targetSpec) throw err;
    targetName = live.target;
    currentSpec = live.targetSpec;
    recovering = true;
    console.log(
      `target ${targetName} is gone from the config — recovering handoff ${live.id} through its recorded spec`,
    );
  }

  let detected = values["no-session"]
    ? undefined
    : await detectSession(localCwd, env.home, values.tool as ToolName | undefined, values.session);
  if (detected) {
    console.log(`session: ${detected.adapter.tool} ${detected.session.id}`);
  }

  // Reserve the target BEFORE anything remote happens. The record — status
  // `provisioning`, full spec snapshot, session identity, sandbox
  // coordinates, candidate remote cwd — is persisted before
  // provider.provision, so a crash or Ready timeout leaves a handoff that
  // `beam up` resumes and `beam kill --purge` abandons: never an orphaned
  // claim or a started agent whose transcript beam cannot collect. On a
  // provisioned target the reservation is target-wide and atomic across
  // concurrent beam processes — one active handoff per target, ever.
  const currentProvider = createProvider(currentSpec);
  const { record: reserved, reused } = reserveTarget(env, {
    target: targetName,
    localCwd,
    exclusive: currentProvider.reusesSandbox,
    make: (id) => {
      // Recovery substitutes a live record's snapshot for the missing
      // config entry — it may finish that handoff but never author a new
      // one. If the live record vanished between the lookup and this lock
      // (a concurrent down/kill finished it), fail closed.
      if (recovering) {
        throw new Error(
          `target ${targetName} is not in the current config and its live handoff just ended — ` +
            `a new handoff needs a configured target (re-add "${targetName}" or pass --target)`,
        );
      }
      const now = new Date().toISOString();
      const root = targetRoot(currentSpec);
      return {
        id,
        target: targetName,
        tool: detected?.adapter.tool,
        sessionId: detected?.session.id,
        sessionFile: detected?.session.file,
        artifactsDir: detected?.session.artifactsDir,
        localCwd,
        remoteCwd: `${root}/${remoteWorkspaceName(localCwd)}`, // candidate until `pwd` resolves it
        remoteCwdResolved: false,
        tmux: `beam-${id}`,
        status: "provisioning",
        createdAt: now,
        updatedAt: now,
        kickoff: values.message,
        targetSpec: currentSpec,
        sandbox: currentProvider.sandboxState({ id }),
        exclusiveTarget: currentProvider.reusesSandbox,
      };
    },
  });

  // The reservation hands out the record; the OPERATION lock hands out the
  // right to act on it. Two same-workspace `beam up`s resume the SAME
  // record, so the reservation alone cannot stop them from interleaving
  // remote effects (double ship, two agents, forked transcripts). The
  // per-record pid lock is held across the whole remote sequence; a live
  // owner is refused immediately, a dead one is reclaimed.
  const releaseOp = acquireOperationLock(env, reserved.id);
  let wtGit: MaterializedWorktreeGit | undefined;
  try {
    // The reservation's copy predates the lock: the previous owner may
    // have finished a down/kill (terminal) or advanced the phase in that
    // window. Re-bind through the exact record under the lock — a terminal
    // handoff is never resurrected by shipping through a stale reservation.
    const record = getRecordForUp(env, reserved.id);
    const { id, tmux: tmuxName } = record;
    // The kickoff a retried ship runs with: an explicit -m wins, an omitted
    // one keeps what the record stored — the agent must start with the SAME
    // kickoff the record journals.
    const kickoff = values.message ?? record.kickoff;

    // Git metadata never rides the workspace mirror. Both standard and
    // linked-worktree layouts ship through a standalone payload so host
    // paths, config, and hooks cannot cross the sandbox boundary.
    // Idempotent: the payload is built at most once per up and removed in
    // `finally` on every outcome.
    const materializeWtGit = async (): Promise<void> => {
      if (wtGit === undefined && isGitWorktree(localCwd)) {
        wtGit = await materializeWorktreeGit(localCwd);
        console.log(`git workspace: materialized standalone .git${wtGit.indexPatch ? " (+staged index patch)" : ""}`);
      }
    };
    // FRESH handoff: build and persist the payload FIRST — if the handoff
    // cannot carry its Git identity, it must fail here, before any remote
    // side effect, provisioning included. A REUSED record defers the
    // PERSIST until the liveness, session-identity, and remote-operation
    // gates below have passed: a refused re-ship (live agent, explicit
    // session mismatch, missing retained session, in-progress remote git
    // operation) must leave the prior ship's `wtGit` byte-for-byte
    // untouched, because `beam down` still has to return exactly what that
    // ship sent out.
    if (!reused) {
      await materializeWtGit();
      updateRecord(env, reserved.id, { wtGit: wtGit?.shipInfo });
    }

    // Everything below binds through the record's snapshot: a config edit
    // (type/root/template/tmuxSocket) cannot retarget an in-flight handoff.
    const spec = recordSpec(record, config);
    const provider = reused ? createProvider(spec) : currentProvider;

    // Session identity is load-bearing record state — pin it before any
    // remote effect (provisioning included). A `starting` record never
    // pins: it never re-ships, it only finalizes below, identity untouched.
    const explicitSession =
      values.tool !== undefined || values.session !== undefined || values["no-session"] === true;
    const pinSession = async (): Promise<void> => {
      const plan = planSessionIdentity(
        record,
        detected && { tool: detected.adapter.tool, sessionId: detected.session.id },
        explicitSession,
      );
      if (plan.kind === "refuse") throw new Error(plan.reason);
      if (plan.kind === "retain") {
        try {
          detected = await detectSession(localCwd, env.home, plan.tool, plan.sessionId);
        } catch (err) {
          throw new Error(
            `handoff ${id} was shipped with session ${plan.tool} ${plan.sessionId}, which no longer exists locally — ` +
              `beam down ${id} (or beam kill ${id} --purge) before shipping a different session\n` +
              `  cause: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        console.log(`session: ${plan.tool} ${plan.sessionId} (retained from handoff ${id})`);
      }
    };
    if (reused && record.status !== "starting") await pinSession();

    // A reused `provisioning` record re-runs a ship that never completed,
    // so it must pass the SAME local shippability guards as a fresh one —
    // sparse layout, in-progress local git operation — BEFORE
    // provider.provision: an unshippable retry must never create (or sit
    // out the Ready wait of) a scarce sandbox claim it then refuses to
    // use. Only the PERSIST of the new identity waits for the gates below.
    if (reused && record.status === "provisioning") await materializeWtGit();

    // The provider publishes the verified claim identity (server-assigned
    // UID) the moment it exists — BEFORE the long Ready wait — and it is
    // persisted synchronously here, so a timeout or crash mid-wait still
    // leaves a record pinned to exactly the claim this handoff created:
    // every later connect, destroy, and retried up binds to that UID.
    const t = await provider.provision(record, (sandbox) => {
      updateRecord(env, id, { sandbox });
    });
    const runtime = new TmuxRuntime(t, spec.tmuxSocket);

    const agentAlive = reused && (await runtime.alive(record.tmux));

    // A previous up died between starting tmux and journaling `up`. The
    // ship itself had already completed — mirror, git payload, and session
    // install all precede the `starting` write — so whatever liveness says,
    // this is a COMPLETED handoff whose agent may have run: finalize it,
    // never re-ship over it. Alive, the agent owns this record's session;
    // absent, the agent may have started, worked, and exited inside the
    // crash window, and only `beam down` can tell — a re-ship would replace
    // the remote workspace, `.git`, and transcript with the stale local
    // side, irreversibly discarding whatever that agent did.
    if (reused && record.status === "starting") {
      updateRecord(env, id, { status: "up" });
      if (agentAlive) {
        console.log(`\nfinalized interrupted handoff ${id} (agent already running, nothing re-shipped)`);
        console.log(`  watch:   beam attach ${id}   (detach: ctrl-b d)`);
        console.log(`  return:  beam down ${id}`);
      } else {
        console.log(
          `\nfinalized interrupted handoff ${id} — the ship completed, but its agent is no longer running ` +
            `(it may have started, worked, and exited; nothing was re-shipped)`,
        );
        console.log(`  collect: beam down ${id}   (brings the remote work home; ship again afterwards)`);
        console.log(`  discard: beam kill ${id} --purge`);
      }
      return;
    }

    // Reusing a live sandbox: never clobber a running agent's workspace.
    if (agentAlive) {
      throw new Error(
        `handoff ${record.id} already has a live agent (tmux ${record.tmux}) on ${targetName} — ` +
          `beam attach ${record.id} to watch it, or beam down/kill it before re-shipping`,
      );
    }

    // Re-shipping over a prior linked handoff replaces the remote `.git`
    // wholesale (delete:true below): an in-progress remote merge/rebase/
    // cherry-pick/revert/bisect/sequencer — state that exists ONLY in that
    // remote `.git` — would be erased along with the work it carries.
    // Probe with checked transport semantics (a transport failure or an
    // unprovable remote exit throws; it is never read as "no operation")
    // and refuse BEFORE the status drops back to `provisioning` and before
    // any outbound byte moves.
    if (reused && record.status === "up" && record.wtGit && isRemoteCwdResolved(record)) {
      const markers = await remoteGitOperationMarkers(t, `${record.remoteCwd}/.git`);
      if (markers.length > 0) {
        throw new Error(
          `handoff ${id} has an in-progress git operation on ${targetName} (${markers.join(", ")}) — ` +
            `re-shipping would erase it. beam down ${id} to bring the remote work home first ` +
            `(or beam kill ${id} --purge to discard it)`,
        );
      }
    }

    // Re-shipping through an existing record: persist this ship's pinned
    // session and isolated Git identities, then return to provisioning
    // before any remote effect. A crash mid-ship still leaves a record that
    // can collect this transcript; an omitted -m keeps the stored kickoff.
    if (reused) {
      await materializeWtGit();
      updateRecord(env, id, {
        tool: detected?.adapter.tool,
        sessionId: detected?.session.id,
        sessionFile: detected?.session.file,
        artifactsDir: detected?.session.artifactsDir,
        kickoff,
        wtGit: wtGit?.shipInfo,
        status: "provisioning",
      });
    }

    // Credentials never travel with the workspace — probe the target's auth
    // state (best-effort) so a login gap surfaces before the mirror ships.
    if (detected?.adapter.remoteAuthProbe) {
      const probe = await t.exec(detected.adapter.remoteAuthProbe);
      if (probe.code !== 0) {
        console.warn(
          `warning: ${detected.adapter.binary} looks NOT logged in on ${targetName}.\n` +
            `         run: beam login ${targetName} --tool ${detected.adapter.tool}\n` +
            `         (shipping anyway — the agent will sit at a login prompt and your kickoff may be lost)`,
        );
      }
    }

    // Physical containment, proven ON the target: canonicalize the
    // configured root (root-level symlinks are trusted config), refuse any
    // symlinked component below it, and create the workspace only once it
    // is proven a strict physical descendant of the root. A pre-existing
    // symlink at the deterministic workspace path — the pre-created trap in
    // a reusable sandbox — fails HERE, before any local byte ships. What
    // gets persisted is the CANONICAL physical path: every later sync,
    // install, cleanup, and purge re-proves containment of exactly that
    // path, so a post-hoc swap is refused instead of followed.
    const root = targetRoot(spec);
    const remoteCwd = await establishContainedWorkspace(
      t,
      root,
      isRemoteCwdResolved(record)
        ? { path: record.remoteCwd } // reused handoffs re-prove their canonical cwd
        : { name: remoteWorkspaceName(record.localCwd) },
    );
    // Persist the canonical remote cwd before anything lands under it — from
    // here on, every remote side effect has a collectable address on record,
    // and a later purge knows the path is real (remoteCwdResolved).
    updateRecord(env, id, { remoteCwd, remoteCwdResolved: true });

    // The transport credential is the blast radius — surface a dangerous
    // posture before the mirror (secrets included) ships. Warn, never block.
    const posture = await probePrivilege(t, remoteCwd);
    for (const warning of posture.warnings) {
      console.warn(`warning: ${warning}`);
    }

    ensureGitExclude(localCwd);
    const excludes = gatherExcludes(localCwd, config);
    const git = await gitSummary(localCwd);
    console.log(
      `shipping ${localCwd}${git ? ` [${git}]` : ""}\n      -> ${t.label}:${remoteCwd}` +
        (excludes.length > 0 ? `\n      excludes: ${excludes.join(", ")}` : ""),
    );
    // remoteCwd is what a mirrored ship empties and a later purge rm -rfs —
    // vet it before the first destructive remote command.
    assertPurgeablePath(remoteCwd);
    await t.syncUp(localCwd, remoteCwd, {
      excludes,
      checksum: true,
      delete: values["no-delete"] !== true,
      verbose: values.verbose === true,
    });
    // Journal the exclude set THIS successful ship ran with: `beam down`
    // unions it into its inbound excludes, so a path excluded outbound
    // (never shipped) can never be read as a remote deletion and erased
    // locally after config/.beamignore drift. Only a completed syncUp may
    // replace the last known-good protection set.
    updateRecord(env, id, { syncedExcludes: excludes });
    // Git workspace: the mirror above shipped without `.git`. Land the
    // standalone Git dir exactly, then replay the staged index and remove
    // the patch on every outcome. A staged-only blob may exist nowhere but
    // that patch; an unprovable cleanup aborts before the agent starts.
    if (wtGit) {
      // The mirror above ran behind the transport's own no-follow guard;
      // re-prove full physical containment before Git state and the staged
      // patch land under the workspace.
      await assertContainedWorkspace(t, root, remoteCwd);
      await t.syncUp(wtGit.gitDir, `${remoteCwd}/.git`, {
        delete: true,
        checksum: true,
        verbose: values.verbose === true,
      });
      if (wtGit.indexPatch) {
        // The reserved `.beam` dir never rides the mirror, so on a reused
        // workspace the remote agent may have swapped it for a symlink —
        // sendFile's `mkdir -p && cat >` would write straight through it.
        // Stage the patch at a fixed sibling path OUTSIDE `.beam`, directly
        // under the just-proven workspace root; only the guarded shell
        // below — which first proves `.beam` is a REAL directory — moves it
        // in and applies it, so no step ever follows a `.beam` symlink.
        // The cleanup scope opens BEFORE sendFile: a send that dies after
        // writing remote bytes still owes the removal.
        const remoteStage = `${remoteCwd}/.beam-staged-index.patch`;
        const remotePatch = `${remoteCwd}/${BEAM_RESERVED_DIR}/staged-index.patch`;
        let shipErr: unknown;
        try {
          await t.sendFile(wtGit.indexPatch, remoteStage);
          await t.execChecked(
            [
              noFollowReservedDirScript(remoteCwd),
              `mv -f -- ${shqRemotePath(remoteStage)} ${shqRemotePath(remotePatch)} || { echo ${shq(
                `beam: cannot move the staged-index patch into ${remoteCwd}/${BEAM_RESERVED_DIR}`,
              )} >&2; exit 65; }`,
              `git -C ${shqRemotePath(remoteCwd)} apply --cached --binary ${shqRemotePath(remotePatch)}`,
            ].join("\n"),
          );
        } catch (err) {
          shipErr = err;
        }
        // Removal on EVERY outcome — the staging file unconditionally (it
        // sits outside `.beam`), the landed patch behind the same-shell
        // no-follow guard, so even the cleanup cannot delete through a
        // swapped `.beam`. A staged-only blob may exist nowhere but that
        // patch, so an unprovable removal aborts before the agent starts.
        try {
          await t.execChecked(
            [
              `rm -f -- ${shqRemotePath(remoteStage)} || { echo ${shq(`beam: cannot remove ${remoteStage}`)} >&2; exit 66; }`,
              noFollowReservedDirGuard(remoteCwd),
              `rm -f -- ${shqRemotePath(remotePatch)}`,
            ].join("\n"),
          );
        } catch (cleanupErr) {
          if (shipErr !== undefined) {
            throw new AggregateError(
              [shipErr, cleanupErr],
              `staged-index patch failed AND its removal could not be proven — ` +
                `delete ${remoteStage} and ${remotePatch} on the target before retrying`,
            );
          }
          throw cleanupErr;
        }
        if (shipErr !== undefined) throw shipErr;
      }
    }

    let started = false;
    if (detected) {
      // Session bytes land under the workspace (.beam/…) — re-prove
      // containment immediately before the install writes them.
      await assertContainedWorkspace(t, root, remoteCwd);
      const installed = await detected.adapter.install(t, detected.session, remoteCwd, kickoff);
      for (const note of installed.notes) console.log(`  ${note}`);
      if (values["no-start"] !== true) {
        // Journal `starting` BEFORE tmux runs: a crash between the start
        // and the `up` flip leaves a status telling the retry that an agent
        // may already be running — finalize it, never re-ship over it.
        updateRecord(env, id, { status: "starting" });
        await runtime.start(tmuxName, remoteCwd, installed.resumeArgv);
        started = true;
      }
    }

    // Only now — session installed, agent started, nothing left to fail — is
    // the handoff `up` and eligible for target-scoped selection.
    updateRecord(env, id, { status: "up" });

    console.log(`\nbeamed up as ${id} (target: ${targetName})`);
    if (started) {
      console.log(`  watch:   beam attach ${id}   (detach: ctrl-b d)`);
      console.log(`  glimpse: beam status ${id}`);
      if (detected?.adapter.tool === "omp") {
        console.log(`  browser: attach once and run /collab for a web link`);
      }
    } else if (detected) {
      console.log(`  agent not started (--no-start); resume manually in ${remoteCwd}`);
    }
    console.log(`  return:  beam down ${id}`);
  } finally {
    wtGit?.cleanup();
    releaseOp();
  }
}
