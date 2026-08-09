import { parseArgs } from "node:util";
import { loadConfig, resolveTarget } from "../config.ts";
import { resolveEnv } from "../env.ts";
import { adapterFor } from "../session/index.ts";
import { findRecord, updateRecord } from "../state.ts";
import { createTransport } from "../transport/index.ts";
import { TmuxRuntime } from "../runtime/tmux.ts";
import { assertPurgeablePath, gatherExcludes } from "../workspace.ts";
import { shq } from "../util/shell.ts";

export const DOWN_HELP = `beam down — stop the remote agent, sync back, re-import the session, purge the remote copy

usage: beam down [id] [options]
  --keep-remote     leave the remote agent running; just sync current state back
  --no-purge        keep the remote workspace after syncing (faster re-ships)
  --delete          mirror remote deletions into the local workspace
  --verbose, -v     stream rsync progress

by default the remote workspace and any session files beam installed on the
target are deleted once everything is safely back — the mirror carries your
whole working tree (secrets included), so nothing should linger.
`;

const STOP_GRACE_MS = 3000;

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

  const purge = !keepRemote && values["no-purge"] !== true;
  if (purge) {
    assertPurgeablePath(record.remoteCwd);
    await runtime.kill(record.tmux);
    await t.execChecked(`rm -rf ${shq(record.remoteCwd)}`);
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
    console.log(`purged remote workspace ${record.remoteCwd}`);
  }

  updateRecord(env, record.id, { status: keepRemote ? "up" : "down" });
  console.log(`\nbeamed down ${record.id}${keepRemote ? " (remote still running)" : ""}`);
  if (hint) console.log(`  continue locally: ${hint}`);
}
