import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shq } from "../util/shell.ts";
import type { Transport } from "../transport/types.ts";
import {
  cleanupGuardedHomeFile,
  collectGuardedHomeFile,
  installGuardedHomeFile,
} from "./guarded-store.ts";
import type {
  InstalledSession,
  InstallOptions,
  LocalSession,
  SessionAdapter,
  StagedReturn,
} from "./types.ts";

/**
 * Claude Code stores sessions as ~/.claude/projects/<slug>/<uuid>.jsonl,
 * where <slug> is the absolute cwd with `/` and `.` replaced by `-`
 * (older versions also replaced `_`). Resume is `claude --resume <uuid>`
 * run from the matching cwd, so beam places the file under the slug of
 * the REMOTE workspace path.
 */

/** Claude Code project-directory slug for a cwd. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}
function claudeStorePath(remoteCwd: string, sessionId: string): string[] {
  return [".claude", "projects", claudeProjectSlug(remoteCwd), `${sessionId}.jsonl`];
}

function assertClaudeTranscript(text: string, sessionId: string): void {
  let sawIdentity = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error("remote Claude transcript contains invalid JSONL");
    }
    if (typeof entry !== "object" || entry === null) continue;
    const identity = (entry as { sessionId?: unknown }).sessionId;
    if (identity === undefined) continue;
    if (identity !== sessionId) {
      throw new Error(
        `remote Claude transcript belongs to session ${String(identity)}, not ${sessionId}`,
      );
    }
    sawIdentity = true;
  }
  if (!sawIdentity) {
    throw new Error(`remote Claude transcript does not prove session identity ${sessionId}`);
  }
}

export class ClaudeAdapter implements SessionAdapter {
  readonly tool = "claude" as const;
  readonly binary = "claude";
  readonly loginArgv = ["claude"];
  // Linux stores OAuth in a credentials file; macOS uses the Keychain, so
  // Darwin is treated as indeterminate-pass rather than blocking real users.
  readonly remoteAuthProbe =
    '[ -f "$HOME/.claude/.credentials.json" ] || [ "$(uname)" = "Darwin" ]';

  async locate(cwd: string, home: string, sessionRef?: string): Promise<LocalSession | undefined> {
    const projects = join(home, ".claude", "projects");
    const primary = claudeProjectSlug(cwd);
    const legacy = primary.replaceAll("_", "-");
    const slugs = legacy === primary ? [primary] : [primary, legacy];
    let best: { file: string; id: string; mtime: number } | undefined;
    for (const slug of slugs) {
      const dir = join(projects, slug);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const id = name.slice(0, -".jsonl".length);
        if (sessionRef && !id.startsWith(sessionRef)) continue;
        const file = join(dir, name);
        const mtime = statSync(file).mtimeMs;
        if (!best || mtime > best.mtime) best = { file, id, mtime };
      }
    }
    if (!best) return undefined;
    return { tool: "claude", id: best.id, file: best.file, mtime: best.mtime };
  }

  async install(
    t: Transport,
    session: LocalSession,
    remoteCwd: string,
    { kickoff }: InstallOptions = {},
  ): Promise<InstalledSession> {
    const path = claudeStorePath(remoteCwd, session.id);
    assertClaudeTranscript(readFileSync(session.file, "utf8"), session.id);
    const remoteStore = await installGuardedHomeFile(t, session.file, path);
    return {
      resumeArgv: ["claude", "--resume", session.id, ...(kickoff ? [kickoff] : [])],
      notes: [`session -> ${remoteStore}`],
    };
  }

  async stageReturn(
    t: Transport,
    session: LocalSession,
    localCwd: string,
    remoteCwd: string,
    stageDir: string,
  ): Promise<StagedReturn> {
    const path = claudeStorePath(remoteCwd, session.id);
    const returned = await collectGuardedHomeFile(t, path);
    assertClaudeTranscript(returned, session.id);
    writeFileSync(join(stageDir, "session.jsonl"), returned);
    // Claude Code has no isolated-path resume: the hint is the exact manual
    // import — beam itself never writes into the live ~/.claude store.
    const hint =
      `manual import (claude cannot resume an isolated path): ` +
      `cp ${shq(join(stageDir, "session.jsonl"))} ${shq(session.file)} && cd ${shq(localCwd)} && ` +
      `claude --resume ${shq(session.id)} ` +
      `# replaces your local copy of this session; it was left untouched`;
    return {
      hint,
      remoteSessionSha256: createHash("sha256").update(returned).digest("hex"),
    };
  }

  async cleanupRemote(t: Transport, session: LocalSession, remoteCwd: string): Promise<void> {
    await cleanupGuardedHomeFile(t, claudeStorePath(remoteCwd, session.id), true);
  }
}
