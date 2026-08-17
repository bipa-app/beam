import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
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
 * Codex stores sessions as ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl.
 * The first line is a `session_meta` record whose payload carries the session
 * id and cwd. Resume is `codex resume <id>` from any directory, so beam keeps
 * the same home-relative store path on the target.
 */

const CANDIDATE_SCAN_COUNT = 400;

/**
 * Read only the leading bytes of a transcript and return its first line —
 * the `session_meta` record. locate inspects up to CANDIDATE_SCAN_COUNT
 * candidates and transcripts grow to many megabytes, so no candidate is
 * ever read whole.
 * A first line longer than the cap comes back truncated, parses as malformed
 * JSON, and the candidate is skipped — the same outcome as any other corrupt
 * header. Read errors propagate, exactly as a whole-file read's would.
 */
export const HEADER_SCAN_BYTES = 64 * 1024;

function readHeaderLine(file: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(HEADER_SCAN_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.toString("utf8", 0, n).split("\n", 1)[0] ?? "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

interface SessionMeta {
  type?: string;
  payload?: { session_id?: string; id?: string; cwd?: string };
}
function assertCodexTranscript(text: string, sessionId: string, expectedCwd?: string): void {
  const firstLine = text.split("\n", 1)[0] ?? "";
  let meta: SessionMeta;
  try {
    meta = JSON.parse(firstLine) as SessionMeta;
  } catch {
    throw new Error("remote Codex transcript contains invalid session metadata");
  }
  const identity = meta.payload?.session_id ?? meta.payload?.id;
  if (meta.type !== "session_meta" || identity !== sessionId) {
    throw new Error(`remote Codex transcript does not belong to session ${sessionId}`);
  }
  if (expectedCwd !== undefined && meta.payload?.cwd !== expectedCwd) {
    throw new Error(
      `remote Codex transcript records cwd ${meta.payload?.cwd ?? "(none)"}, ` +
      `not the shipped workspace ${expectedCwd}`,
    );
  }
}

export class CodexAdapter implements SessionAdapter {
  readonly tool = "codex" as const;
  readonly binary = "codex";
  readonly loginArgv = ["codex", "login"];
  readonly remoteAuthProbe = 'test -s "$HOME/.codex/auth.json"';

  async locate(cwd: string, home: string, sessionRef?: string): Promise<LocalSession | undefined> {
    const root = join(home, ".codex", "sessions");
    if (!existsSync(root)) return undefined;
    const files: { file: string; mtime: number }[] = [];
    for (const rel of new Bun.Glob("*/*/*/rollout-*.jsonl").scanSync({ cwd: root })) {
      const file = join(root, rel);
      files.push({ file, mtime: statSync(file).mtimeMs });
    }
    files.sort((a, b) => b.mtime - a.mtime);

    for (const { file, mtime } of files.slice(0, CANDIDATE_SCAN_COUNT)) {
      const firstLine = readHeaderLine(file);
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

  /** Home-relative store segments, reused verbatim on the target. */
  private storePath(source: string): string[] {
    const home = source.split("/.codex/")[0]!;
    return relative(home, source).split("/");
  }

  async install(
    t: Transport,
    session: LocalSession,
    _remoteCwd: string,
    { kickoff }: InstallOptions = {},
  ): Promise<InstalledSession> {
    // `file` is the staged CONTENT source; the remote layout mirrors the
    // LIVE store path (a ship-stage path has no `/.codex/` component).
    const path = this.storePath(session.storeFile ?? session.file);
    assertCodexTranscript(readFileSync(session.file, "utf8"), session.id);
    const remoteStore = await installGuardedHomeFile(t, session.file, path);
    return {
      resumeArgv: ["codex", "resume", session.id, ...(kickoff ? [kickoff] : [])],
      notes: [
        `session -> ${remoteStore}`,
        "note: codex records the original cwd in session_meta; it resumes in the current directory",
      ],
    };
  }

  async stageReturn(
    t: Transport,
    session: LocalSession,
    localCwd: string,
    _remoteCwd: string,
    stageDir: string,
  ): Promise<StagedReturn> {
    const path = this.storePath(session.storeFile ?? session.file);
    const returned = await collectGuardedHomeFile(t, path);
    assertCodexTranscript(returned, session.id, localCwd);
    // Codex resumes by id from its own store only — the hint is the exact
    // manual import; beam itself never writes into the live ~/.codex store.
    writeFileSync(join(stageDir, "session.jsonl"), returned);
    const hint =
      `manual import (codex cannot resume an isolated path): ` +
      `cp ${shq(join(stageDir, "session.jsonl"))} ` +
      `${shq(session.file)} && codex resume ${shq(session.id)} ` +
      `# replaces your local copy of this session; it was left untouched`;
    return {
      hint,
      remoteSessionSha256: createHash("sha256").update(returned).digest("hex"),
    };
  }

  async cleanupRemote(t: Transport, session: LocalSession, _remoteCwd: string): Promise<void> {
    await cleanupGuardedHomeFile(t, this.storePath(session.storeFile ?? session.file));
  }
}
