import { parseArgs } from "node:util";
import {
  configPath,
  loadConfig,
  resolveTarget,
  targetRoot,
  writeSampleConfig,
  type Config,
  type TargetSpec,
} from "../config.ts";
import { resolveEnv, type BeamEnv } from "../env.ts";
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
import { createProvider, type SandboxProvider } from "../provider/index.ts";
import type { Transport } from "../transport/index.ts";
import { TmuxRuntime } from "../runtime/tmux.ts";
import {
  assertContainedWorkspace,
  purgeOwnedWorkspaceContents,
  releaseOwnedWorkspace,
  workspaceOwnerContent,
} from "../workspace.ts";
import {
  parseProbeRecords,
  probePrivilege,
  probeScriptPrelude,
  probeScriptTrailer,
  requireProbeRecord,
  type ProbeRecord,
} from "../security.ts";
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
      `${r.id}  ${r.status.padEnd(12)} ${(r.tool ?? "-").padEnd(6)} ` +
        `${r.target.padEnd(12)} ${r.localCwd}  (${r.createdAt})`,
    );
  }
}

/** beam status [id] — remote liveness plus a glimpse of the pane. */
export async function cmdStatus(args: string[]): Promise<void> {
  const env = resolveEnv();
  const record = findRecord(env, args[0]);

  console.log(
    `${record.id}: ${record.tool ?? "workspace-only"} on ${record.target} (${record.status})`,
  );
  console.log(`  local:  ${record.localCwd}`);
  console.log(`  remote: ${record.remoteCwd}`);
  // Read-only: a record without a spec snapshot (older beam) is labeled,
  // never connected — the current config cannot prove where it lives.
  const spec = record.targetSpec;
  if (!spec) {
    console.log(
      `  target: unresolved — record predates target snapshots; not connecting ` +
        `(the current "${record.target}" entry may be a different machine)`,
    );
    return;
  }
  const provider = createProvider(spec);
  let t: Transport;
  try {
    t = await provider.connect(record);
  } catch (err) {
    console.log(`  agent:  unreachable — ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  // The record's workspace must still be the one this handoff claimed —
  // a swapped or foreign-owned workspace never gets its pane read as if
  // it were Beam's agent.
  if (isRemoteCwdResolved(record) && record.workspaceToken !== undefined) {
    await assertContainedWorkspace(t, targetRoot(spec), record.remoteCwd, {
      allowMissing: true,
      owner: workspaceOwnerContent(record.id, record.workspaceToken),
    });
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
  const record = findRecord(env, args[0]);
  const spec = recordSpec(record);
  const provider = createProvider(spec);
  const t = await provider.connect(record);
  // Same exact-owner guard as status: never attach a tty to an agent
  // whose workspace beam cannot prove it owns.
  if (isRemoteCwdResolved(record) && record.workspaceToken !== undefined) {
    await assertContainedWorkspace(t, targetRoot(spec), record.remoteCwd, {
      allowMissing: true,
      owner: workspaceOwnerContent(record.id, record.workspaceToken),
    });
  }
  const runtime = new TmuxRuntime(t, spec.tmuxSocket);
  if (!(await runtime.alive(record.tmux))) {
    console.error(`agent for ${record.id} is not running (tmux ${record.tmux})`);
    process.exitCode = 1;
    return;
  }
  const res = await run(t.interactiveArgv(runtime.attachCommand(record.tmux)), {
    interactive: true,
  });
  process.exitCode = res.code;
}

export const KILL_HELP = `beam kill — kill the remote agent; --purge erases every remote trace

usage: beam kill [id] [options]
  --purge    checked cleanup, then destroy: remove installed session traces,
             delete the remote workspace, destroy provisioned resources

without --purge only the agent's tmux session is killed — the sandbox,
workspace, target reservation, and shipped generation stay RETAINED: a
later \`beam up\` restarts the exact remote generation in place with ZERO
local re-ship (a provisioning retry resumes only its journaled same
generation). To ship new local bytes, collect first (\`beam down\`), then
explicitly abandon the remote with \`beam kill <id> --purge\` and run a
new \`beam up\`.
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
    const spec = recordSpec(record);
    const provider = createProvider(spec);

    // Terminal states are monotonic: the remote side is already gone and
    // proven clean — nothing to kill, nothing to re-destroy.
    if (record.status === "down" || record.status === "killed") {
      console.log(`handoff ${record.id} is already ${record.status} — nothing to kill`);
      return;
    }

    // `killing`: the purge intent was journaled BEFORE the erasure effect,
    // so a retry re-runs the checked purge (accepting a provably absent or
    // exactly-empty root as already erased — the crash may have landed
    // after the owner unlink) and then repeats the destroy.
    const wasKilling = record.status === "killing";
    if (wasKilling && !values.purge) {
      throw new Error(
        `handoff ${record.id} is mid-kill — run \`beam kill ${record.id} --purge\` ` +
          `to finish the destroy`,
      );
    }

    // provisioning / starting / up / killing-retry from here on.
    const context: KillContext = { env, provider, spec, record, wasKilling };
    if (!values.purge) {
      await killPaneOnly(context);
      return;
    }
    await killPurge(context);
  } finally {
    releaseOp();
  }
}

/** Lock-held state cmdKill's phase helpers act on. */
interface KillContext {
  env: BeamEnv;
  provider: SandboxProvider;
  spec: TargetSpec;
  record: BeamRecord;
  /** True when this run resumes a journaled `killing` purge. */
  wasKilling: boolean;
}

/** Owner-bound receipt of the purge phases that already converged. */
type KillReceipt = NonNullable<BeamRecord["killReceipt"]>;

/**
 * Plain kill: best-effort pane kill only. The status never changes —
 * terminal records stay terminal, half-provisioned records stay incomplete
 * (their sandbox still needs `up` or `kill --purge`), and an `up` record
 * stays up: only the pane died; the sandbox, workspace, and reservation are
 * all still real — a later `beam up` restarts the exact retained generation
 * in place.
 */
async function killPaneOnly(context: KillContext): Promise<void> {
  const { provider, spec, record } = context;
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
}

/**
 * --purge: the claim delete is never a substitute for storage erasure
 * (persistent volumes outlive it). A record whose remote cwd RESOLVED may
 * hold a shipped workspace and installed traces, so it must connect and
 * prove the erasure — an unreachable sandbox fails the kill with the record
 * and claim intact, retryable once the pod settles. Only a record that
 * provably never shipped (cwd never resolved) may be destroyed without a
 * transport.
 */
async function killPurge(context: KillContext): Promise<void> {
  const { env, provider, record, wasKilling } = context;
  if (!isRemoteCwdResolved(record)) {
    // No workspace or session path was ever published, so there is
    // nothing inside the sandbox to stop or erase. In particular, do not
    // require a working image/tmux from the claim whose provisioning
    // failed: journal the destroy-only phase and delete the claim.
    updateRecord(env, record.id, { status: "killing" });
    await provider.destroy(record);
    updateRecord(env, record.id, { status: "killed" });
    console.log(`abandoned ${record.id} (nothing was ever shipped)`);
    return;
  }
  const owner =
    record.workspaceToken !== undefined
      ? workspaceOwnerContent(record.id, record.workspaceToken)
      : undefined;
  if (owner === undefined) {
    throw new Error(
      `handoff ${record.id} has no workspace ownership token on record — refusing ` +
        `to purge a workspace beam cannot prove it owns; remove ${record.remoteCwd} ` +
        `on the target manually if intended`,
    );
  }
  // A prior attempt's receipts count ONLY when they were bound to this
  // exact owner — anything else is treated as no receipt at all.
  const receipt =
    wasKilling && record.killReceipt !== undefined && record.killReceipt.owner === owner
      ? { ...record.killReceipt }
      : {
          owner,
          workspaceContentsPurged: false,
          sessionTracesCleaned: false,
          workspaceReleased: false,
        };
  const t = await killPurgeConnect(context, receipt);
  if (t === undefined) return;
  await killPurgeErase(t, context, owner, receipt);
}

/**
 * Connect for the checked purge, or finish the destroy without a
 * connection. Receipts are PAST evidence, never a license by themselves —
 * and no provider can prove its destroy erases the data: an Agent Sandbox
 * template may mount persistent volumes that outlive the claim (the
 * least-privilege credential cannot even read the template to check), and a
 * static target's destroy is a no-op. An unreachable purge therefore
 * refuses and retains the claim — the recovery handle to whatever storage
 * still holds the workspace and traces — until a connected retry proves the
 * checked erasure. ONE narrow exception: when BOTH owner-bound receipts are
 * already journaled, erasure and trace cleanup provably converged and the
 * only step a crash can have lost is the claim delete or its terminal write
 * — a provider with an exact-UID managed lifecycle may finish that delete
 * by identity alone (absence converges; the pinned UID deletes under a
 * server-side precondition; a replacement or API failure throws and the
 * record is retained). Returns undefined when that identity-only path
 * completed the kill.
 */
async function killPurgeConnect(
  context: KillContext,
  receipt: KillReceipt,
): Promise<Transport | undefined> {
  const { env, provider, record } = context;
  try {
    return await provider.connect(record);
  } catch (err) {
    if (
      provider.destroyAfterVerifiedCleanupWithoutConnection === undefined ||
      !receipt.workspaceContentsPurged ||
      !receipt.sessionTracesCleaned
    ) {
      throw new Error(
        `sandbox for ${record.id} is unreachable — refusing to delete the claim: ` +
          `its storage may outlive it (persistent volumes), so the workspace and ` +
          `session traces must be erased through a connected ` +
          `\`beam kill ${record.id} --purge\` once the target is reachable\n` +
          `  cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    console.log(
      "sandbox unreachable, but the workspace and trace receipts are verified — " +
        "finishing the destroy by claim identity",
    );
    await provider.destroyAfterVerifiedCleanupWithoutConnection(record);
    updateRecord(env, record.id, { status: "killed" });
    console.log(`purged ${record.remoteCwd}`);
    return undefined;
  }
}

/**
 * Connected checked erasure, then the destroy. Receipts record what
 * converged, but a REACHABLE retry never skips current cleanup: the
 * owner-pinned emptying and the trace cleanup are idempotent and re-run on
 * every connected attempt immediately before the destroy — bytes written
 * since a crashed attempt's receipt still die here. Erasure is TWO
 * receipted phases so the journaled `killing` intent alone can never
 * license reading an absent or empty workspace as erased.
 */
async function killPurgeErase(
  t: Transport,
  context: KillContext,
  owner: string,
  receipt: KillReceipt,
): Promise<void> {
  const { env, provider, spec, record } = context;
  await new TmuxRuntime(t, spec.tmuxSocket).kill(record.tmux);
  console.log(`killed remote agent for ${record.id}`);
  // Journal the purge intent (with the owner-bound phase receipt)
  // BEFORE the first erasure effect: a crash anywhere below leaves
  // `killing` plus exactly the phases that CONVERGED.
  updateRecord(env, record.id, { status: "killing", killReceipt: receipt });
  // Phase A empties the workspace EXCEPT the owner marker: one pinned
  // shell holds the workspace inode as cwd, proves the exact record-
  // bound owner marker, deletes `./`-relative, verifies the exact
  // emptied end state in the same shell, and never `rm -rf`s the root
  // pathname — a swapped-in replacement path (symlink or foreign real
  // dir, foreign owner bytes included) refuses byte-untouched. ONLY
  // this record's own persisted contents receipt licenses accepting
  // an absent or exactly-emptied state as already converged; anything
  // non-empty still demands the exact owner.
  await purgeOwnedWorkspaceContents(t, record.remoteCwd, owner, {
    acceptConverged: receipt.workspaceContentsPurged === true,
  });
  receipt.workspaceContentsPurged = true;
  updateRecord(env, record.id, { killReceipt: { ...receipt } });
  // Session traces can live OUTSIDE the workspace (Claude/Codex
  // stores in the remote home). Cleanup is checked: a trace that
  // cannot be proven gone aborts BEFORE the claim is deleted.
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
  receipt.sessionTracesCleaned = true;
  updateRecord(env, record.id, { killReceipt: { ...receipt } });
  // Phase B — runs ONLY because the contents receipt is now held:
  // re-proves the emptied layout and the exact owner bytes, unlinks
  // the marker against the held inode, and tolerates its own crashed
  // states (absent marker, absent `.beam`, absent workspace) as
  // convergence. A foreign owner or ANY extra content refuses with
  // the claim retained.
  await releaseOwnedWorkspace(t, record.remoteCwd, owner);
  receipt.workspaceReleased = true;
  updateRecord(env, record.id, { killReceipt: { ...receipt } });
  // Checked erasure is complete (or provably unnecessary). The destroy
  // deletes the provider claim (removing whatever holds the emptied
  // root); `killing` is already journaled, so an interrupted destroy
  // retries through the same checked path.
  await provider.destroy(record);
  updateRecord(env, record.id, { status: "killed" });
  console.log(
    isRemoteCwdResolved(record)
      ? `purged ${record.remoteCwd}`
      : `abandoned ${record.id} (nothing was ever shipped)`,
  );
}

/** Both doctor exits end on the same reminder: log in on the target, never copy credentials. */
const DOCTOR_LOGIN_HINT =
  "\ncredentials never travel with beam — authenticate each harness on the target " +
  "with `beam login`.";

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
  // A legacy active record (no snapshot) is never bound: audit the current
  // config alone rather than guess which machine the record meant.
  const bound = active?.targetSpec !== undefined ? active : undefined;
  const live = bound ? createProvider(recordSpec(bound)) : provider;
  let t: Transport;
  try {
    t = await live.connect(bound);
  } catch (err) {
    console.log(`  sandbox:      ${err instanceof Error ? err.message : String(err)}`);
    console.log(DOCTOR_LOGIN_HINT);
    return;
  }

  // Live checks bind through the spec beam would actually use: the active
  // handoff's snapshot when one exists, else the current config.
  const liveSpec = bound ? recordSpec(bound) : spec;
  const root = targetRoot(liveSpec);
  if (!(await doctorRemoteChecks(t, name, root))) return;
  console.log(DOCTOR_LOGIN_HINT);
}

export const DOCTOR_SENTINEL = "__beam_doctor_v1__";

/** Record keys embed adapter binaries; the static set must stay key-safe. */
const BINARY_KEY_SHAPE = /^[a-z][a-z0-9._-]*$/;

/** Non-adapter binaries a handoff needs on the target. */
const REMOTE_TOOLS = ["rsync", "tmux"] as const;

/**
 * Every remote doctor question fused into one script: tool/harness
 * presence, adapter-driven auth probes (only when the harness binary
 * resolved, mirroring the historical per-exec flow), and workspace-root
 * creation. Auth probe snippets come from the adapters verbatim.
 */
function doctorProbeScript(root: string): string {
  const lines = [...probeScriptPrelude(DOCTOR_SENTINEL)];
  for (const bin of REMOTE_TOOLS) {
    lines.push(
      `__beam_v=$(command -v ${bin} 2>/dev/null); __beam_rc=$?`,
      `__beam_emit tool.${bin} "$__beam_rc" "$__beam_v"`,
    );
  }
  for (const adapter of ADAPTERS) {
    if (!BINARY_KEY_SHAPE.test(adapter.binary)) {
      throw new Error(`beam: adapter binary is not probe-key safe: ${adapter.binary}`);
    }
    lines.push(
      `__beam_v=$(command -v ${shq(adapter.binary)} 2>/dev/null); __beam_rc=$?`,
      `__beam_emit bin.${adapter.binary} "$__beam_rc" "$__beam_v"`,
    );
    if (adapter.remoteAuthProbe) {
      lines.push(
        `if [ "$__beam_rc" = 0 ]; then`,
        `  (${adapter.remoteAuthProbe}) >/dev/null 2>&1`,
        `  __beam_emit auth.${adapter.binary} "$?" ""`,
        `fi`,
      );
    }
  }
  lines.push(
    `__beam_v=$({ mkdir -p ${shqRemotePath(root)} &&`,
    `  cd ${shqRemotePath(root)} && pwd; } 2>/dev/null)`,
    `__beam_emit root "$?" "$__beam_v"`,
    ...probeScriptTrailer(DOCTOR_SENTINEL),
  );
  return lines.join("\n");
}

/**
 * The fused doctor result must contain EXACTLY the expected records: every
 * tool, every adapter binary, the root probe, and an auth record if and
 * only if that adapter defines a probe AND its binary resolved. Anything
 * else — missing, extra, or inconsistent — is malformed (fail closed).
 */
function checkDoctorRecordSet(records: Map<string, ProbeRecord>): void {
  const expected = new Set<string>(["root"]);
  for (const bin of REMOTE_TOOLS) expected.add(`tool.${bin}`);
  for (const adapter of ADAPTERS) {
    expected.add(`bin.${adapter.binary}`);
    const bin = requireProbeRecord(records, `bin.${adapter.binary}`);
    if (adapter.remoteAuthProbe && bin.code === 0) expected.add(`auth.${adapter.binary}`);
  }
  for (const key of expected) requireProbeRecord(records, key);
  for (const key of records.keys()) {
    if (!expected.has(key)) {
      throw new Error(`beam: malformed probe output (unexpected record ${key}) — refusing`);
    }
  }
}

/**
 * Remote half of `beam doctor`: exactly TWO transport round trips
 * regardless of adapter or probe count — one fused probe script for
 * connectivity/tools/harnesses/root, then probePrivilege's single fused
 * script. Returns false when connectivity failed (the caller skips the
 * trailing login hint, matching the historical early return). Exported
 * for transport-double tests.
 */
export async function doctorRemoteChecks(
  t: Transport,
  name: string,
  root: string,
): Promise<boolean> {
  const probe = await t.exec(doctorProbeScript(root));
  if (probe.code !== 0) {
    console.log(`  connectivity: FAILED — ${probe.stderr.trim()}`);
    return false;
  }
  let records: Map<string, ProbeRecord>;
  try {
    records = parseProbeRecords(DOCTOR_SENTINEL, probe.stdout);
    checkDoctorRecordSet(records);
  } catch (err) {
    console.log(`  connectivity: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  console.log("  connectivity: ok");
  for (const bin of REMOTE_TOOLS) {
    const rec = requireProbeRecord(records, `tool.${bin}`);
    const pad = " ".repeat(Math.max(1, 6 - bin.length));
    console.log(`  remote ${bin}:${pad}${rec.code === 0 ? rec.value.trim() : "MISSING"}`);
  }
  for (const adapter of ADAPTERS) {
    const rec = requireProbeRecord(records, `bin.${adapter.binary}`);
    const pad = " ".repeat(Math.max(1, 6 - adapter.binary.length));
    if (rec.code !== 0) {
      console.log(`  remote ${adapter.binary}:${pad}not installed`);
      continue;
    }
    let auth = "";
    if (adapter.remoteAuthProbe) {
      const authRec = requireProbeRecord(records, `auth.${adapter.binary}`);
      auth =
        authRec.code === 0
          ? " · authenticated"
          : ` · NOT LOGGED IN → beam login ${name} --tool ${adapter.tool}`;
    }
    console.log(`  remote ${adapter.binary}:${pad}${rec.value.trim()}${auth}`);
  }
  const rootRec = requireProbeRecord(records, "root");
  const rootLine = rootRec.code === 0 ? rootRec.value.trim() : `cannot create ${root}`;
  console.log(`  root:         ${rootLine}`);
  if (rootRec.code === 0) {
    const posture = await probePrivilege(t, rootRec.value.trim());
    if (posture.warnings.length === 0) {
      console.log(`  privilege:    ok (user ${posture.user}, no dangerous posture)`);
    } else {
      for (const w of posture.warnings) console.log(`  privilege:    WARNING — ${w}`);
    }
  }
  return true;
}

export const LOGIN_HELP =
  `beam login — interactive harness login on a target (credentials never travel)

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
  const { name, active, spec } = loginBindTarget(env, config, { ref: positionals[0] });
  const provider = createProvider(spec);
  const t = await provider.connect(active);

  let tool = values.tool as ToolName | undefined;
  if (!tool) {
    const detected = await detectSession(process.cwd(), env.home).catch(() => undefined);
    tool = detected?.adapter.tool;
  }
  if (!tool) {
    throw new Error(
      "pass --tool omp|pi|claude|codex (no session in this directory to infer it from)",
    );
  }
  const adapter = adapterFor(tool);

  console.log(
    `opening interactive ${shjoin(adapter.loginArgv)} on ${name} — complete the login, then exit`,
  );
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

/**
 * Bind through the live handoff's recorded spec — a config edit cannot
 * redirect the login to a different sandbox than the one running. When
 * the entry was removed or renamed outright, the live handoff's snapshot
 * alone still names its sandbox: login recovers an existing handoff, it
 * never authors a new one, so only a fresh target needs current config.
 */
function loginBindTarget(
  env: BeamEnv,
  config: Config,
  options: { ref: string | undefined },
): { name: string; active: BeamRecord | undefined; spec: TargetSpec } {
  try {
    const resolved = resolveTarget(config, options.ref);
    let active = latestUpForTarget(env, resolved.name);
    // A legacy record (no snapshot) is never bound through the mutable
    // config: log into the target's current config without a record ref.
    if (active?.targetSpec === undefined) active = undefined;
    const spec = active !== undefined ? recordSpec(active) : resolved.spec;
    return { name: resolved.name, active, spec };
  } catch (err) {
    // Recovery covers REMOVAL only — the requested (or default) name no
    // longer resolves. A config that merely demands disambiguation
    // (several targets, no default, no argument) keeps its own error.
    const requested = options.ref ?? config.defaultTarget;
    if (requested === undefined && Object.keys(config.targets).length > 0) throw err;
    const live = findRecoverableUp(env, requested);
    if (!live?.targetSpec) throw err;
    return { name: live.target, active: live, spec: live.targetSpec };
  }
}
