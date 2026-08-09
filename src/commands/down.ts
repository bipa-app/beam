import { parseArgs } from "node:util";
import { loadConfig, resolveTarget } from "../config.ts";
import { resolveEnv } from "../env.ts";
import { adapterFor } from "../session/index.ts";
import { findRecord, updateRecord } from "../state.ts";
import { createTransport } from "../transport/index.ts";
import { TmuxRuntime } from "../runtime/tmux.ts";
import { gatherExcludes } from "../workspace.ts";

export const DOWN_HELP = `beam down — stop the remote agent, sync the workspace back, re-import the session

usage: beam down [id] [options]
  --keep-remote     leave the remote agent running; just sync current state back
  --delete          mirror remote deletions into the local workspace
  --verbose, -v     stream rsync progress
`;

const STOP_GRACE_MS = 3000;

export async function cmdDown(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      "keep-remote": { type: "boolean" },
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
  const record = findRecord(env, positionals[0]);
  const { spec } = resolveTarget(config, record.target);
  const t = createTransport(spec);
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
  await t.syncDown(record.remoteCwd, record.localCwd, {
    excludes: gatherExcludes(record.localCwd, config),
    delete: values.delete === true,
    verbose: values.verbose === true,
  });

  let hint: string | undefined;
  if (record.tool && record.sessionFile && record.sessionId) {
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

  updateRecord(env, record.id, { status: keepRemote ? "up" : "down" });
  console.log(`\nbeamed down ${record.id}${keepRemote ? " (remote still running)" : ""}`);
  if (hint) console.log(`  continue locally: ${hint}`);
}
