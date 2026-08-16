import { parseArgs } from "node:util";
import { loadConfig, targetRoot } from "../config.ts";
import { resolveEnv, type BeamEnv } from "../env.ts";
import { adapterFor } from "../session/index.ts";
import {
  acquireOperationLock,
  findRecord,
  getRecord,
  isRemoteCwdResolved,
  recordSpec,
  updateRecord,
  type BeamRecord,
} from "../state.ts";
import { createProvider, type SandboxProvider } from "../provider/index.ts";
import { TmuxRuntime } from "../runtime/tmux.ts";
import type { Transport } from "../transport/index.ts";
import {
  assertContainedWorkspace,
  gatherExcludes,
  purgeContainedWorkspace,
} from "../workspace.ts";
import {
  importWorktreeGitReturn,
  isLinkedWorktree,
  prepareWorktreeGitReturn,
  returnRefBase,
} from "../workspace-git.ts";

export const DOWN_HELP = `beam down — stop the remote agent, sync back, re-import the session, purge the remote copy

usage: beam down [id] [options]
  --keep-remote     leave the remote agent running; just sync current state back
  --no-purge        keep the remote workspace after syncing (faster re-ships)
  --delete          mirror remote deletions into the local workspace
  --verbose, -v     stream rsync progress

by default the remote workspace and any session files beam installed on the
target are deleted once everything is safely back — the mirror carries your
whole working tree (secrets included), so nothing should linger.

a linked git worktree handoff additionally imports ALL remote git state
(commits, branches, tags, stashes, staged blobs, index, HEAD, in-progress
merge/rebase state) back into the local repository BEFORE the purge; refs
that conflict with local work are preserved under refs/beam/return/<id>
instead of overwriting anything.
`;

const STOP_GRACE_MS = 3000;

/**
 * The idempotent post-collection remote cleanup, entered only once the
 * workspace and transcript are safely home (status `purging`): kill the
 * pane, remove session traces living OUTSIDE the workspace (Claude/Codex
 * home stores — checked, so an unproven removal aborts BEFORE the claim
 * delete), erase the workspace itself (claim deletion is never trusted as
 * storage erasure — persistent volumes outlive it), then journal
 * `teardown` and destroy the sandbox. Every step tolerates repetition, so
 * an interrupted purge is finished by running it again.
 */
async function purgeRemote(
  env: BeamEnv,
  t: Transport,
  runtime: TmuxRuntime,
  record: BeamRecord,
  provider: SandboxProvider,
  root: string,
): Promise<void> {
  await runtime.kill(record.tmux);
  // Prove physical containment BEFORE any cleanup touches under the
  // workspace: a path swapped for a symlink since the collect must abort
  // the purge here — nothing below may write or delete through it. A
  // provably ABSENT workspace passes (an earlier purge attempt already
  // erased it); every remaining step tolerates repetition.
  if (isRemoteCwdResolved(record)) {
    await assertContainedWorkspace(t, root, record.remoteCwd, { allowMissing: true });
  }
  if (record.tool && record.sessionFile && record.sessionId) {
    await adapterFor(record.tool).cleanupRemote(
      t,
      {
        tool: record.tool,
        id: record.sessionId,
        file: record.sessionFile,
        artifactsDir: record.artifactsDir,
        mtime: 0,
      },
      record.remoteCwd,
    );
  }
  // The workspace rm runs only when the remote cwd was actually resolved
  // (established canonical and persisted) — an unresolved `~/…` candidate
  // means nothing ever shipped, and letting it reach the path guard would
  // throw on every retry and wedge the record in `purging` forever.
  if (isRemoteCwdResolved(record)) {
    // The containment proof and the `rm -rf` run in the SAME remote shell:
    // an unprovable path refuses (the record stays in `purging`,
    // retryable); an already-erased one reports absent so retries finish.
    await purgeContainedWorkspace(t, root, record.remoteCwd);
  }
  // Workspace and transcript are back and the remote is clean; the only
  // remaining ambiguity is the provider DELETE itself. Persist `teardown`
  // first so an interrupted destroy is finished idempotently by the next
  // `beam down` without reconnecting.
  updateRecord(env, record.id, { status: "teardown" });
  await provider.destroy(record);
}

export async function cmdDown(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      "keep-remote": { type: "boolean" },
      "no-purge": { type: "boolean" },
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
  // interleaved with an in-flight up (or another down/kill) would collect
  // a half-extracted tree over the local workspace, or destroy the claim
  // under a live ship whose final `up` write then lands last. A live owner
  // is refused promptly; the lock is held through the final state write.
  const releaseOp = acquireOperationLock(env, selected.id);
  try {
    // Re-read under the lock: the pre-lock copy may predate the previous
    // owner's final state write (status, resolved cwd, session identity).
    const record = getRecord(env, selected.id);
    const spec = recordSpec(record, config);
    const root = targetRoot(spec);
    const provider = createProvider(spec);

    // Phase matrix — every state names its one legal recovery:
    //   provisioning        → refuse (retry `beam up` / abandon via kill)
    //   starting, up        → collect (the normal path below)
    //   purging             → repeat idempotent cleanup, never re-collect
    //   teardown            → repeat the destroy alone, never reconnect
    //   killing             → belongs to `beam kill --purge` (destroy-only)
    //   down, killed        → terminal, monotonic: nothing to bring back
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
        `handoff ${record.id} is mid-kill — run \`beam kill ${record.id} --purge\` to finish the destroy`,
      );
    }
    if (record.status === "down" || record.status === "killed") {
      console.log(`handoff ${record.id} is already ${record.status} — nothing to bring back`);
      return;
    }

    // A prior down already synced everything back and cleaned the remote, but
    // died inside the provider DELETE — acknowledged or not is ambiguous, and
    // the sandbox may be half-gone. Never reconnect or re-sync: finish the
    // idempotent destroy and close the record.
    if (record.status === "teardown") {
      console.log(`finishing interrupted teardown of ${record.id}`);
      await provider.destroy(record);
      updateRecord(env, record.id, { status: "down" });
      console.log(`\nbeamed down ${record.id}`);
      return;
    }

    // A prior down got everything home and journaled `purging`, then died
    // mid-cleanup. Never re-collect (the local transcript may have moved on
    // since) — repeat the idempotent cleanup and finish the teardown.
    if (record.status === "purging") {
      console.log(`finishing interrupted purge of ${record.id}`);
      const t = await provider.connect(record);
      await purgeRemote(env, t, new TmuxRuntime(t, spec.tmuxSocket), record, provider, root);
      updateRecord(env, record.id, { status: "down" });
      console.log(`purged remote workspace ${record.remoteCwd}`);
      console.log(`\nbeamed down ${record.id}`);
      return;
    }

    // Legacy records from before every Git layout used an isolated payload
    // have no wtGit identity. If such a record's path is now a linked
    // worktree, refuse before any local or remote mutation: the checkout may
    // belong to a different repository.
    const wtReturn = record.wtGit !== undefined;
    if (!wtReturn && isLinkedWorktree(record.localCwd)) {
      throw new Error(
        `beam down: ${record.localCwd} is now a linked git worktree, but handoff ${record.id} shipped it as a ` +
          `standard checkout — refusing to sync back over a different layout. Restore the original checkout ` +
          `at that path, or abandon the handoff with \`beam kill ${record.id} --purge\``,
      );
    }
    // Git return guards run before the workspace mirror: verify the
    // repository identity (paths plus device+inode of both git dirs),
    // refuse concurrent local operations, and pin the durable pre-return
    // snapshot (refs/beam/backup/<id>/state).
    if (wtReturn) {
      await prepareWorktreeGitReturn(record.localCwd, record.id, record.wtGit);
    }

    const t = await provider.connect(record);
    const runtime = new TmuxRuntime(t, spec.tmuxSocket);
    const keepRemote = values["keep-remote"] === true;

    if (await runtime.alive(record.tmux)) {
      if (keepRemote) {
        console.log(`remote agent still running (${record.tmux}); syncing a snapshot back`);
      } else {
        console.log(`stopping remote agent (${record.tmux})…`);
        await runtime.interrupt(record.tmux);
        await Bun.sleep(STOP_GRACE_MS);
        await runtime.kill(record.tmux);
      }
    } else if (!keepRemote) {
      console.log("remote agent already exited");
    }

    console.log(`syncing ${t.label}:${record.remoteCwd}\n      -> ${record.localCwd}`);
    // Inbound excludes are the union of what the LAST SUCCESSFUL ship
    // excluded on the way out (persisted on the record) and the current
    // config/.beamignore set: anything excluded outbound never reached the
    // target, so a `--delete` mirror that stopped protecting it after
    // config drift would read its remote absence as a deletion and erase
    // the local copy.
    // Re-prove no-follow physical containment immediately before reading
    // the tree home: a workspace path swapped for a symlink must never be
    // collected (mirrored or not) over the local workspace.
    await assertContainedWorkspace(t, root, record.remoteCwd);
    await t.syncDown(record.remoteCwd, record.localCwd, {
      excludes: [...new Set([...(record.syncedExcludes ?? []), ...gatherExcludes(record.localCwd, config)])],
      checksum: true,
      delete: values.delete === true,
      verbose: values.verbose === true,
    });

    let hint: string | undefined;
    if (record.tool && record.sessionFile && record.sessionId) {
      // The transcript fetch reads under the workspace too — re-prove
      // containment after the (potentially long) mirror above.
      await assertContainedWorkspace(t, root, record.remoteCwd);
      const adapter = adapterFor(record.tool);
      hint = await adapter.collect(
        t,
        {
          tool: record.tool,
          id: record.sessionId,
          file: record.sessionFile,
          artifactsDir: record.artifactsDir,
          mtime: 0,
        },
        record.localCwd,
        record.remoteCwd,
      );
      console.log(`session re-imported (previous copy backed up next to it)`);
    }

    // The workspace mirror leaves `.git` behind for every Git layout.
    // Import the quarantined standalone payload now, before purge: objects
    // land additively in the common repository; remote ref moves use
    // compare-and-swap; conflicts stay under refs/beam/return/<id>; and
    // HEAD, index, stash, and operation state return without trusting remote
    // config or hooks. Any failure leaves the remote intact for a retry.
    if (wtReturn) {
      await assertContainedWorkspace(t, root, record.remoteCwd);
      const ret = await importWorktreeGitReturn(t, record);
      for (const note of ret.notes) console.log(`  ${note}`);
      console.log(
        `  git state home: ${ret.applied.length} ref(s) applied, ` +
          `${ret.quarantined.length} preserved under ${returnRefBase(record.id)}`,
      );
    }

    // Teardown order is load-bearing: purge only after the workspace and
    // transcript are safely back (any failure above aborts before this), and
    // the claim is deleted only on the successful purge path — `--no-purge`
    // and `--keep-remote` keep the sandbox, a failed sync keeps everything.
    const purge = !keepRemote && values["no-purge"] !== true;
    if (purge) {
      // Journal `purging` BEFORE the first destructive remote step: a crash
      // anywhere below is retried by repeating the cleanup — never by
      // re-collecting over a fresher local transcript.
      updateRecord(env, record.id, { status: "purging" });
      await purgeRemote(env, t, runtime, record, provider, root);
      console.log(`purged remote workspace ${record.remoteCwd}`);
    }

    const retainedSandbox = provider.reusesSandbox && !purge;
    updateRecord(env, record.id, { status: keepRemote || retainedSandbox ? "up" : "down" });
    console.log(`\nbeamed down ${record.id}${keepRemote ? " (remote still running)" : ""}`);
    if (hint) console.log(`  continue locally: ${hint}`);
  } finally {
    releaseOp();
  }
}
