import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { shqRemotePath } from "../util/shell.ts";
import type { Transport } from "../transport/types.ts";
import type { InstalledSession, LocalSession, SessionAdapter } from "./types.ts";

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

export class ClaudeAdapter implements SessionAdapter {
  readonly tool = "claude" as const;
  readonly binary = "claude";

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
    kickoff?: string,
  ): Promise<InstalledSession> {
    const remoteStore = `~/.claude/projects/${claudeProjectSlug(remoteCwd)}/${session.id}.jsonl`;
    await t.sendFile(session.file, remoteStore);
    return {
      resumeArgv: ["claude", "--resume", session.id, ...(kickoff ? [kickoff] : [])],
      notes: [`session -> ${remoteStore}`],
    };
  }

  async collect(
    t: Transport,
    session: LocalSession,
    _localCwd: string,
    remoteCwd: string,
  ): Promise<string> {
    const remoteStore = `~/.claude/projects/${claudeProjectSlug(remoteCwd)}/${session.id}.jsonl`;
    if (!(await t.exists(remoteStore))) {
      throw new Error(`remote session ${remoteStore} not found`);
    }
    if (existsSync(session.file)) {
      copyFileSync(session.file, `${session.file}.bak-${Date.now()}`);
    }
    await t.fetchFile(remoteStore, session.file);
    return `claude --resume ${session.id}`;
  }

  async cleanupRemote(t: Transport, session: LocalSession, remoteCwd: string): Promise<void> {
    const dir = `~/.claude/projects/${claudeProjectSlug(remoteCwd)}`;
    await t.exec(`rm -f ${shqRemotePath(`${dir}/${session.id}.jsonl`)}`);
    // Drop the project dir too when ours was the only session in it.
    await t.exec(`rmdir ${shqRemotePath(dir)} 2>/dev/null || true`);
  }
}
