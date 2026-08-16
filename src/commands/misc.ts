import { parseArgs } from "node:util";
import {
  configPath,
  loadConfig,
  resolveTarget,
  targetRoot,
  writeSampleConfig,
  type TargetSpec,
} from "../config.ts";
import { resolveEnv } from "../env.ts";
import { ADAPTERS, adapterFor, detectSession, type ToolName } from "../session/index.ts";
import {
  acquireOperationLock,
  findRecord,
  findRecordForKill,
  findRecoverableUp,
  getRecord,
  isRemoteCwdResolved,
  latestUpForTarget,
  loadState,
  recordSpec,
  updateRecord,
  type BeamRecord,
} from "../state.ts";
import { createProvider } from "../provider/index.ts";
import type { Transport } from "../transport/index.ts";
import { TmuxRuntime } from "../runtime/tmux.ts";
import { assertContainedWorkspace, purgeContainedWorkspace } from "../workspace.ts";
import { probePrivilege } from "../security.ts";
import { run, shjoin, shq, shqRemotePath } from "../util/shell.ts";

/** beam init — write a sample config when none exists. */
export async function cmdInit(): Promise<void> {
  const env = resolveEnv();
  const path = configPath(env);
  const existed = Object.keys(loadConfig(env).targets).length > 0;
  writeSampleConfig(env);
  console.log(`config: ${path}`);
  if (existed) {
    console.log("config already exists — left untouched");
  } else {
    console.log("edit it: set your sandbox host (any ssh destination works)");
    console.log("then verify with `beam doctor`");
  }
}

/** beam targets — list configured targets. */
export async function cmdTargets(): Promise<void> {
  const env = resolveEnv();
  const config = loadConfig(env);
  const names = Object.keys(config.targets);
  if (names.length === 0) {
    console.log("no targets — run `beam init`");
    return;
  }
  for (const name of names) {
    const spec = config.targets[name]!;
    const marker = name === config.defaultTarget ? "*" : " ";
    // Listing must survive one bad target (a provider constructor fails
    // closed on invalid config) — commands that would USE it still refuse.
    let label: string;
    try {
      label = createProvider(spec).label;
    } catch (err) {
      label = `INVALID — ${err instanceof Error ? err.message : String(err)}`;
    }
    console.log(`${marker} ${name.padEnd(16)} ${label}  root=${targetRoot(spec)}`);
  }
}

/** beam ls — list handoff records. */
export async function cmdLs(): Promise<void> {
  const env = resolveEnv();
  const { records } = loadState(env);
  if (records.length === 0) {
    console.log("no beamed sessions yet — run `beam up`");
    return;
  }
  for (const r of [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    console.log(
      `${r.id}  ${r.status.padEnd(12)} ${(r.tool ?? "-").padEnd(6)} ${r.target.padEnd(12)} ${r.localCwd}  (${r.createdAt})`,
    );
  }
}

/** beam status [id] — remote liveness plus a glimpse of the pane. */
export async function cmdStatus(args: string[]): Promise<void> {
  const env = resolveEnv();
  const config = loadConfig(env);
  const record = findRecord(env, args[0]);
  const spec = recordSpec(record, config);
  const provider = createProvider(spec);

  console.log(`${record.id}: ${record.tool ?? "workspace-only"} on ${record.target} (${record.status})`);
  console.log(`  local:  ${record.localCwd}`);
  console.log(`  remote: ${record.remoteCwd}`);
  let t: Transport;
  try {
    t = await provider.connect(record);
  } catch (err) {
    console.log(`  agent:  unreachable — ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const runtime = new TmuxRuntime(t, spec.tmuxSocket);
  const alive = await runtime.alive(record.tmux);
  console.log(`  agent:  ${alive ? "running" : "not running"} (tmux ${record.tmux})`);
  if (alive) {
    const pane = await runtime.peek(record.tmux).catch(() => "");
    if (pane) {
      console.log("  ── last output ──");
      for (const line of pane.split("\n")) console.log(`  │ ${line}`);
    }
  }
}

/** beam attach [id] — interactive attach to the remote agent's tmux. */
export async function cmdAttach(args: string[]): Promise<void> {
  const env = resolveEnv();
  const config = loadConfig(env);
  const record = findRecord(env, args[0]);
  const spec = recordSpec(record, config);
  const provider = createProvider(spec);
  const t = await provider.connect(record);
  const runtime = new TmuxRuntime(t, spec.tmuxSocket);
  if (!(await runtime.alive(record.tmux))) {
    console.error(`agent for ${record.id} is not running (tmux ${record.tmux})`);
    process.exitCode = 1;
    return;
  }
  const res = await run(t.interactiveArgv(runtime.attachCommand(record.tmux)), { interactive: true });
  process.exitCode = res.code;
}

export const KILL_HELP = `beam kill — kill the remote agent; --purge erases every remote trace

usage: beam kill [id] [options]
  --purge    checked cleanup, then destroy: remove installed session traces,
             delete the remote workspace, destroy provisioned resources

without --purge only the agent's tmux session is killed — the sandbox,
workspace, and target reservation stay; \`beam up\` re-ships over them and
\`beam kill --purge\` abandons them.
`;

/** beam kill [id] [--purge] — stop the remote agent; optionally delete the workspace. */
export async function cmdKill(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { purge: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  // --help is inert by contract: print and return before ANY effect —
  // no state read, no record selection, no lock, no transport.
  if (values.help) {
    console.log(KILL_HELP);
    return;
  }
  const env = resolveEnv();
  const config = loadConfig(env);
  // Destructive selection never guesses: with no ref and more than one
  // record still owning remote resources, refuse and demand the exact id —
  // a default pick could destroy a live handoff the user did not mean.
  const selected = findRecordForKill(env, positionals[0]);

  // Same ownership rule as up/down: kill's remote effects (pane kill, trace
  // cleanup, workspace erase, claim destroy) must never interleave with an
  // in-flight up or down on this record. A live owner is refused promptly;
  // the lock is held through the final state write.
  const releaseOp = acquireOperationLock(env, selected.id);
  try {
    // Re-read under the lock: the pre-lock copy may predate the previous
    // owner's final state write.
    const record = getRecord(env, selected.id);
    const spec = recordSpec(record, config);
    const provider = createProvider(spec);

    // Terminal states are monotonic: the remote side is already gone and
    // proven clean — nothing to kill, nothing to re-destroy.
    if (record.status === "down" || record.status === "killed") {
      console.log(`handoff ${record.id} is already ${record.status} — nothing to kill`);
      return;
    }

    // `beam down` owns the purging/teardown recovery: everything is already
    // collected there, only its idempotent cleanup remains — a kill that
    // also destroyed would race the same steps under different bookkeeping.
    if (record.status === "purging" || record.status === "teardown") {
      throw new Error(
        `handoff ${record.id} is mid-teardown — run \`beam down ${record.id}\` to finish it ` +
          `(everything is already collected; only remote cleanup remains)`,
      );
    }

    // `killing`: checked erasure already completed (or was provably
    // unnecessary — nothing ever shipped). The destroy is the ONLY step
    // left, so the retry repeats it alone: never reconnect, never re-clean.
    if (record.status === "killing") {
      if (!values.purge) {
        throw new Error(
          `handoff ${record.id} is mid-kill — run \`beam kill ${record.id} --purge\` to finish the destroy`,
        );
      }
      await provider.destroy(record);
      updateRecord(env, record.id, { status: "killed" });
      console.log(`finished interrupted kill of ${record.id}`);
      return;
    }

    // provisioning / starting / up from here on.
    if (!values.purge) {
      // Plain kill: best-effort pane kill only. The status never changes —
      // terminal records stay terminal, half-provisioned records stay
      // incomplete (their sandbox still needs `up` or `kill --purge`), and
      // an `up` record stays up: only the pane died; the sandbox,
      // workspace, and reservation are all still real.
      let t: Transport | undefined;
      try {
        t = await provider.connect(record);
      } catch (err) {
        console.log(`sandbox unreachable — ${err instanceof Error ? err.message : String(err)}`);
      }
      if (t) {
        await new TmuxRuntime(t, spec.tmuxSocket).kill(record.tmux);
        console.log(`killed remote agent for ${record.id}`);
      }
      return;
    }

    // --purge: the claim delete is never a substitute for storage erasure
    // (persistent volumes outlive it). A record whose remote cwd RESOLVED
    // may hold a shipped workspace and installed traces, so it must connect
    // and prove the erasure — an unreachable sandbox fails the kill with
    // the record and claim intact, retryable once the pod settles. Only a
    // record that provably never shipped (cwd never resolved) may be
    // destroyed without a transport.
    let t: Transport | undefined;
    try {
      t = await provider.connect(record);
    } catch (err) {
      if (isRemoteCwdResolved(record)) {
        throw new Error(
          `sandbox for ${record.id} is unreachable but its workspace may still exist at ` +
            `${record.remoteCwd} — refusing to delete the claim without proving the erasure. ` +
            `retry \`beam kill ${record.id} --purge\` once the sandbox is reachable\n` +
            `  cause: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      console.log(`sandbox unreachable — ${err instanceof Error ? err.message : String(err)}`);
    }
    if (t) {
      await new TmuxRuntime(t, spec.tmuxSocket).kill(record.tmux);
      console.log(`killed remote agent for ${record.id}`);
      // Prove physical containment BEFORE any cleanup touches under the
      // workspace: a path swapped for a symlink must abort the kill here —
      // nothing below may write or delete through it. A provably absent
      // workspace passes (idempotent retries).
      if (isRemoteCwdResolved(record)) {
        await assertContainedWorkspace(t, targetRoot(spec), record.remoteCwd, { allowMissing: true });
      }
      // Session traces can live OUTSIDE the workspace (Claude/Codex stores
      // in the remote home). Cleanup is checked: a trace that cannot be
      // proven gone aborts BEFORE the claim is deleted.
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
      // Erase the workspace whenever one can exist; the containment proof
      // and the `rm -rf` run in the SAME remote shell (see workspace.ts),
      // and an unresolved candidate path can never wedge the kill.
      if (isRemoteCwdResolved(record)) {
        await purgeContainedWorkspace(t, targetRoot(spec), record.remoteCwd);
      }
    }
    // Checked erasure is complete (or provably unnecessary). Journal
    // `killing` BEFORE the destroy: an interrupted destroy is retried
    // destroy-only — the erased workspace is never "re-proven" through a
    // sandbox that may already be half-gone.
    updateRecord(env, record.id, { status: "killing" });
    await provider.destroy(record);
    updateRecord(env, record.id, { status: "killed" });
    console.log(
      isRemoteCwdResolved(record)
        ? `purged ${record.remoteCwd}`
        : `abandoned ${record.id} (nothing was ever shipped)`,
    );
  } finally {
    releaseOp();
  }
}

/** beam doctor [target] — verify the pieces a handoff needs. */
export async function cmdDoctor(args: string[]): Promise<void> {
  const env = resolveEnv();
  const config = loadConfig(env);
  const { name, spec } = resolveTarget(config, args[0]);
  const provider = createProvider(spec);
  console.log(`target ${name} (${provider.label})`);

  const report = await provider.doctor();
  for (const line of report.lines) console.log(`  ${line}`);
  if (report.fatal) {
    console.error(`  REJECTED:     ${report.fatal}`);
    process.exitCode = 1;
    return;
  }

  // The provider report above audits the CURRENT config; the optional
  // sandbox connectivity/tool checks below run against the live handoff,
  // which stays bound to its recorded spec snapshot.
  const active = latestUpForTarget(env, name);
  const live = active ? createProvider(recordSpec(active, config)) : provider;
  let t: Transport;
  try {
    t = await live.connect(active);
  } catch (err) {
    console.log(`  sandbox:      ${err instanceof Error ? err.message : String(err)}`);
    console.log("\ncredentials never travel with beam — authenticate each harness on the target with `beam login`.");
    return;
  }

  const conn = await t.exec("echo ok");
  console.log(`  connectivity: ${conn.code === 0 ? "ok" : `FAILED — ${conn.stderr.trim()}`}`);
  if (conn.code !== 0) return;

  for (const bin of ["rsync", "tmux"]) {
    const res = await t.exec(`command -v ${bin}`);
    console.log(`  remote ${bin}:${" ".repeat(Math.max(1, 6 - bin.length))}${res.code === 0 ? res.stdout.trim() : "MISSING"}`);
  }
  for (const adapter of ADAPTERS) {
    const res = await t.exec(`command -v ${shq(adapter.binary)}`);
    const pad = " ".repeat(Math.max(1, 6 - adapter.binary.length));
    if (res.code !== 0) {
      console.log(`  remote ${adapter.binary}:${pad}not installed`);
      continue;
    }
    let auth = "";
    if (adapter.remoteAuthProbe) {
      const probe = await t.exec(adapter.remoteAuthProbe);
      auth =
        probe.code === 0
          ? " · authenticated"
          : ` · NOT LOGGED IN → beam login ${name} --tool ${adapter.tool}`;
    }
    console.log(`  remote ${adapter.binary}:${pad}${res.stdout.trim()}${auth}`);
  }
  // Live checks bind through the spec beam would actually use: the active
  // handoff's snapshot when one exists, else the current config.
  const liveSpec = active ? recordSpec(active, config) : spec;
  const root = targetRoot(liveSpec);
  const rootRes = await t.exec(`mkdir -p ${shqRemotePath(root)} && cd ${shqRemotePath(root)} && pwd`);
  console.log(`  root:         ${rootRes.code === 0 ? rootRes.stdout.trim() : `cannot create ${root}`}`);
  if (rootRes.code === 0) {
    const posture = await probePrivilege(t, rootRes.stdout.trim());
    if (posture.warnings.length === 0) {
      console.log(`  privilege:    ok (user ${posture.user}, no dangerous posture)`);
    } else {
      for (const w of posture.warnings) console.log(`  privilege:    WARNING — ${w}`);
    }
  }
  console.log("\ncredentials never travel with beam — authenticate each harness on the target with `beam login`.");
}

export const LOGIN_HELP = `beam login — interactive harness login on a target (credentials never travel)

usage: beam login [target] [options]
  --tool <omp|pi|claude|codex>   harness to log in (default: inferred from
                                 this directory's newest session)
`;

/** beam login [target] — interactive harness login on the target (never copies credentials). */
export async function cmdLogin(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { tool: { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  // --help is inert by contract: print and return before ANY effect —
  // no state read, no target resolution, no transport.
  if (values.help) {
    console.log(LOGIN_HELP);
    return;
  }

  const env = resolveEnv();
  const config = loadConfig(env);
  // Bind through the live handoff's recorded spec — a config edit cannot
  // redirect the login to a different sandbox than the one running. When
  // the entry was removed or renamed outright, the live handoff's snapshot
  // alone still names its sandbox: login recovers an existing handoff, it
  // never authors a new one, so only a fresh target needs current config.
  let name: string;
  let active: BeamRecord | undefined;
  let spec: TargetSpec;
  try {
    const resolved = resolveTarget(config, positionals[0]);
    name = resolved.name;
    active = latestUpForTarget(env, name);
    spec = active ? recordSpec(active, config) : resolved.spec;
  } catch (err) {
    // Recovery covers REMOVAL only — the requested (or default) name no
    // longer resolves. A config that merely demands disambiguation
    // (several targets, no default, no argument) keeps its own error.
    const requested = positionals[0] ?? config.defaultTarget;
    if (requested === undefined && Object.keys(config.targets).length > 0) throw err;
    const live = findRecoverableUp(env, requested);
    if (!live?.targetSpec) throw err;
    name = live.target;
    active = live;
    spec = live.targetSpec;
  }
  const provider = createProvider(spec);
  const t = await provider.connect(active);

  let tool = values.tool as ToolName | undefined;
  if (!tool) {
    const detected = await detectSession(process.cwd(), env.home).catch(() => undefined);
    tool = detected?.adapter.tool;
  }
  if (!tool) {
    throw new Error("pass --tool omp|pi|claude|codex (no session in this directory to infer it from)");
  }
  const adapter = adapterFor(tool);

  console.log(`opening interactive ${shjoin(adapter.loginArgv)} on ${name} — complete the login, then exit`);
  const res = await run(t.interactiveArgv(shjoin(adapter.loginArgv)), { interactive: true });
  if (res.code !== 0) console.error(`login command exited ${res.code}`);
  if (adapter.remoteAuthProbe) {
    const probe = await t.exec(adapter.remoteAuthProbe);
    console.log(
      probe.code === 0
        ? `${adapter.binary}: authenticated on ${name}`
        : `${adapter.binary}: still not authenticated on ${name}`,
    );
  }
}
