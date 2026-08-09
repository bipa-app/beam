import { parseArgs } from "node:util";
import { configPath, loadConfig, resolveTarget, writeSampleConfig, DEFAULT_ROOT } from "../config.ts";
import { resolveEnv } from "../env.ts";
import { ADAPTERS } from "../session/index.ts";
import { findRecord, loadState, updateRecord } from "../state.ts";
import { createTransport } from "../transport/index.ts";
import { TmuxRuntime } from "../runtime/tmux.ts";
import { run, shq, shqRemotePath } from "../util/shell.ts";

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
    console.log("edit the sandbox target's `host` to any ssh destination (~/.ssh/config aliases work),");
    console.log("then run: beam doctor");
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
    const where = spec.type === "ssh" ? `ssh ${spec.host}` : `local ${spec.root}`;
    const marker = name === config.defaultTarget ? "*" : " ";
    console.log(`${marker} ${name.padEnd(16)} ${where}  root=${spec.root ?? DEFAULT_ROOT}`);
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
      `${r.id}  ${r.status.padEnd(6)} ${(r.tool ?? "-").padEnd(6)} ${r.target.padEnd(12)} ${r.localCwd}  (${r.createdAt})`,
    );
  }
}

/** beam status [id] — remote liveness plus a glimpse of the pane. */
export async function cmdStatus(args: string[]): Promise<void> {
  const env = resolveEnv();
  const config = loadConfig(env);
  const record = findRecord(env, args[0]);
  const { spec } = resolveTarget(config, record.target);
  const t = createTransport(spec);
  const runtime = new TmuxRuntime(t, spec.tmuxSocket);

  console.log(`${record.id}: ${record.tool ?? "workspace-only"} on ${record.target} (${record.status})`);
  console.log(`  local:  ${record.localCwd}`);
  console.log(`  remote: ${record.remoteCwd}`);
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

/** beam attach [id] — interactive tmux attach on the target. */
export async function cmdAttach(args: string[]): Promise<void> {
  const env = resolveEnv();
  const config = loadConfig(env);
  const record = findRecord(env, args[0]);
  const { spec } = resolveTarget(config, record.target);
  const t = createTransport(spec);
  const runtime = new TmuxRuntime(t, spec.tmuxSocket);
  if (!(await runtime.alive(record.tmux))) {
    console.error(`agent for ${record.id} is not running (tmux ${record.tmux})`);
    process.exitCode = 1;
    return;
  }
  const res = await run(t.interactiveArgv(runtime.attachCommand(record.tmux)), { interactive: true });
  process.exitCode = res.code;
}

/** beam kill [id] [--purge] — stop the remote agent; optionally delete the workspace. */
export async function cmdKill(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { purge: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  const env = resolveEnv();
  const config = loadConfig(env);
  const record = findRecord(env, positionals[0]);
  const { spec } = resolveTarget(config, record.target);
  const t = createTransport(spec);
  const runtime = new TmuxRuntime(t, spec.tmuxSocket);

  await runtime.kill(record.tmux);
  console.log(`killed remote agent for ${record.id}`);
  if (values.purge) {
    if (!record.remoteCwd.includes("/") || record.remoteCwd.length < 8 || record.remoteCwd === "/") {
      throw new Error(`refusing to purge suspicious path: ${record.remoteCwd}`);
    }
    await t.execChecked(`rm -rf ${shq(record.remoteCwd)}`);
    console.log(`purged ${record.remoteCwd}`);
  }
  updateRecord(env, record.id, { status: "killed" });
}

/** beam doctor [target] — verify the pieces a handoff needs. */
export async function cmdDoctor(args: string[]): Promise<void> {
  const env = resolveEnv();
  const config = loadConfig(env);
  const { name, spec } = resolveTarget(config, args[0]);
  const t = createTransport(spec);
  console.log(`target ${name} (${t.label})`);

  const local = await run(["rsync", "--version"]);
  console.log(`  local rsync:  ${local.code === 0 ? "ok" : "MISSING — install rsync"}`);

  const conn = await t.exec("echo ok");
  console.log(`  connectivity: ${conn.code === 0 ? "ok" : `FAILED — ${conn.stderr.trim()}`}`);
  if (conn.code !== 0) return;

  for (const bin of ["rsync", "tmux"]) {
    const res = await t.exec(`command -v ${bin}`);
    console.log(`  remote ${bin}:${" ".repeat(Math.max(1, 6 - bin.length))}${res.code === 0 ? res.stdout.trim() : "MISSING"}`);
  }
  for (const adapter of ADAPTERS) {
    const res = await t.exec(`command -v ${shq(adapter.binary)}`);
    console.log(`  remote ${adapter.binary}:${" ".repeat(Math.max(1, 6 - adapter.binary.length))}${res.code === 0 ? res.stdout.trim() : "not installed"}`);
  }
  const root = spec.root ?? DEFAULT_ROOT;
  const rootRes = await t.exec(`mkdir -p ${shqRemotePath(root)} && cd ${shqRemotePath(root)} && pwd`);
  console.log(`  root:         ${rootRes.code === 0 ? rootRes.stdout.trim() : `cannot create ${root}`}`);
  console.log("\nremember: the harness on the target must be logged in (omp/claude/codex auth is per-machine).");
}
