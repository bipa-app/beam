import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { shqRemotePath } from "../util/shell.ts";
import type { Transport } from "../transport/types.ts";
import type { InstalledSession, LocalSession, SessionAdapter } from "./types.ts";

/**
 * Codex stores sessions as ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl.
 * The first line is a `session_meta` record whose payload carries the session
 * id and cwd. Resume is `codex resume <id>` from any directory, so beam keeps
 * the same home-relative store path on the target.
 */

const SCAN_LIMIT = 400;

interface SessionMeta {
  type?: string;
  payload?: { session_id?: string; id?: string; cwd?: string };
}

export class CodexAdapter implements SessionAdapter {
  readonly tool = "codex" as const;
  readonly binary = "codex";

  async locate(cwd: string, home: string, sessionRef?: string): Promise<LocalSession | undefined> {
    const root = join(home, ".codex", "sessions");
    if (!existsSync(root)) return undefined;
    const files: { file: string; mtime: number }[] = [];
    for (const rel of new Bun.Glob("*/*/*/rollout-*.jsonl").scanSync({ cwd: root })) {
      const file = join(root, rel);
      files.push({ file, mtime: statSync(file).mtimeMs });
    }
    files.sort((a, b) => b.mtime - a.mtime);

    for (const { file, mtime } of files.slice(0, SCAN_LIMIT)) {
      const firstLine = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
      let meta: SessionMeta;
      try {
        meta = JSON.parse(firstLine) as SessionMeta;
      } catch {
        continue;
      }
      if (meta.type !== "session_meta" || meta.payload?.cwd !== cwd) continue;
      const id = meta.payload.session_id ?? meta.payload.id;
      if (!id) continue;
      if (sessionRef && !id.startsWith(sessionRef)) continue;
      return { tool: "codex", id, file, mtime };
    }
    return undefined;
  }

  /** Home-relative store path, reused verbatim on the target. */
  private remoteStorePath(session: LocalSession, home: string): string {
    return `~/${relative(home, session.file)}`;
  }

  async install(
    t: Transport,
    session: LocalSession,
    _remoteCwd: string,
    kickoff?: string,
  ): Promise<InstalledSession> {
    const home = session.file.split("/.codex/")[0]!;
    const remoteStore = this.remoteStorePath(session, home);
    await t.sendFile(session.file, remoteStore);
    return {
      resumeArgv: ["codex", "resume", session.id, ...(kickoff ? [kickoff] : [])],
      notes: [
        `session -> ${remoteStore}`,
        "note: codex records the original cwd in session_meta; it resumes in the current directory",
      ],
    };
  }

  async collect(
    t: Transport,
    session: LocalSession,
    _localCwd: string,
    _remoteCwd: string,
  ): Promise<string> {
    const home = session.file.split("/.codex/")[0]!;
    const remoteStore = this.remoteStorePath(session, home);
    if (!(await t.exists(remoteStore))) {
      throw new Error(`remote session ${remoteStore} not found`);
    }
    if (existsSync(session.file)) {
      copyFileSync(session.file, `${session.file}.bak-${Date.now()}`);
    }
    await t.fetchFile(remoteStore, session.file);
    return `codex resume ${session.id}`;
  }

  async cleanupRemote(t: Transport, session: LocalSession, _remoteCwd: string): Promise<void> {
    const home = session.file.split("/.codex/")[0]!;
    await t.exec(`rm -f ${shqRemotePath(this.remoteStorePath(session, home))}`);
  }
}
