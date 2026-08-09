import { parseArgs } from "node:util";
import { loadConfig, DEFAULT_ROOT, resolveTarget } from "../config.ts";
import { resolveEnv } from "../env.ts";
import { detectSession, type ToolName } from "../session/index.ts";
import { addRecord, newRecordId } from "../state.ts";
import { createTransport } from "../transport/index.ts";
import { TmuxRuntime } from "../runtime/tmux.ts";
import { shqRemotePath } from "../util/shell.ts";
import { ensureGitExclude, gatherExcludes, gitSummary, remoteWorkspaceName } from "../workspace.ts";

export const UP_HELP = `beam up — ship this workspace + session to a target and resume the agent there

usage: beam up [options]
  --target, -t <name>     configured target (default: config defaultTarget)
  --tool <omp|claude|codex>  harness to hand off (default: auto-detect newest)
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
  const { name: targetName, spec } = resolveTarget(config, values.target);
  const t = createTransport(spec);
  const localCwd = process.cwd();

  const detected = values["no-session"]
    ? undefined
    : await detectSession(localCwd, env.home, values.tool as ToolName | undefined, values.session);
  if (detected) {
    console.log(`session: ${detected.adapter.tool} ${detected.session.id}`);
  }

  const root = spec.root ?? DEFAULT_ROOT;
  const wsDir = `${root}/${remoteWorkspaceName(localCwd)}`;
  await t.execChecked(`mkdir -p ${shqRemotePath(wsDir)}`);
  const remoteCwd = await t.execChecked(`cd ${shqRemotePath(wsDir)} && pwd`);

  ensureGitExclude(localCwd);
  const excludes = gatherExcludes(localCwd, config);
  const git = await gitSummary(localCwd);
  console.log(
    `shipping ${localCwd}${git ? ` [${git}]` : ""}\n      -> ${t.label}:${remoteCwd}` +
      (excludes.length > 0 ? `\n      excludes: ${excludes.join(", ")}` : ""),
  );
  await t.syncUp(localCwd, remoteCwd, {
    excludes,
    delete: values["no-delete"] !== true,
    verbose: values.verbose === true,
  });

  const id = newRecordId();
  const tmuxName = `beam-${id}`;
  let started = false;
  if (detected) {
    const installed = await detected.adapter.install(t, detected.session, remoteCwd, values.message);
    for (const note of installed.notes) console.log(`  ${note}`);
    if (values["no-start"] !== true) {
      const runtime = new TmuxRuntime(t, spec.tmuxSocket);
      await runtime.start(tmuxName, remoteCwd, installed.resumeArgv);
      started = true;
    }
  }

  const now = new Date().toISOString();
  addRecord(env, {
    id,
    target: targetName,
    tool: detected?.adapter.tool,
    sessionId: detected?.session.id,
    sessionFile: detected?.session.file,
    artifactsDir: detected?.session.artifactsDir,
    localCwd,
    remoteCwd,
    tmux: tmuxName,
    status: "up",
    createdAt: now,
    updatedAt: now,
    kickoff: values.message,
  });

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
}
