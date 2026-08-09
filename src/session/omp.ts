import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runChecked } from "../util/shell.ts";
import type { Transport } from "../transport/types.ts";
import type { InstalledSession, LocalSession, SessionAdapter } from "./types.ts";

/**
 * omp stores sessions as JSONL under ~/.omp/agent/sessions/<dir>/, where
 * <dir> is derived from the session's cwd. Two naming schemes exist:
 *
 *  - legacy dashed: home-relative cwd with `/` -> `-`
 *    (/Users/x/work/app with home /Users/x -> "-work-app")
 *  - hashed: <scope>-<basename>-<sha256(canonical cwd)>
 *
 * A `{"type":"session",...,"cwd":...}` header line inside the JSONL records
 * the cwd; resume from a foreign machine triggers an interactive re-root
 * prompt when that cwd does not exist. beam avoids the prompt by rewriting
 * the header cwd to the destination path (and back on collect).
 *
 * The session ships INSIDE the workspace at .beam/session.jsonl (with its
 * artifacts dir at .beam/session/), so the growing transcript rides the
 * normal workspace rsync back on `beam down`.
 */

export const OMP_WORKSPACE_SESSION = ".beam/session.jsonl";
const OMP_WORKSPACE_ARTIFACTS = ".beam/session";

/** Rewrite the cwd recorded in the `{"type":"session"}` header line. */
export function rewriteOmpHeaderCwd(jsonl: string, newCwd: string): string {
  const lines = jsonl.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes('"type":"session"')) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.type !== "session") continue;
    parsed.cwd = newCwd;
    lines[i] = JSON.stringify(parsed);
    return lines.join("\n");
  }
  throw new Error("omp session header (type=session) not found in transcript");
}

/** Read the cwd out of a session file's header, if present near the top. */
function readHeaderCwd(file: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n", 20)) {
    if (!line.includes('"type":"session"')) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string; cwd?: string };
      if (parsed.type === "session") return parsed.cwd;
    } catch {
      // keep scanning
    }
  }
  return undefined;
}

function newestSessionIn(dir: string, sessionRef?: string): { file: string; mtime: number } | undefined {
  if (!existsSync(dir)) return undefined;
  let best: { file: string; mtime: number } | undefined;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    if (sessionRef && !name.includes(sessionRef)) continue;
    const file = join(dir, name);
    const mtime = statSync(file).mtimeMs;
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  return best;
}

export class OmpAdapter implements SessionAdapter {
  readonly tool = "omp" as const;
  readonly binary = "omp";

  async locate(cwd: string, home: string, sessionRef?: string): Promise<LocalSession | undefined> {
    const root = join(home, ".omp", "agent", "sessions");
    if (!existsSync(root)) return undefined;

    const candidates: string[] = [];
    if (cwd.startsWith(home)) {
      candidates.push(join(root, cwd.slice(home.length).replaceAll("/", "-")));
    }
    const sha = createHash("sha256").update(cwd).digest("hex");
    const base = basename(cwd);
    for (const scope of ["home", "abs", "tmp"]) {
      candidates.push(join(root, `${scope}-${base}-${sha}`));
    }

    let best: { file: string; mtime: number } | undefined;
    for (const dir of candidates) {
      const found = newestSessionIn(dir, sessionRef);
      if (found && (!best || found.mtime > best.mtime)) best = found;
    }

    // Fallback: scan every store dir and match by recorded header cwd.
    if (!best) {
      for (const name of readdirSync(root)) {
        const dir = join(root, name);
        if (!statSync(dir).isDirectory()) continue;
        const found = newestSessionIn(dir, sessionRef);
        if (!found || (best && found.mtime <= best.mtime)) continue;
        if (readHeaderCwd(found.file) === cwd) best = found;
      }
    }
    if (!best) return undefined;

    const fileBase = basename(best.file, ".jsonl");
    const artifactsDir = join(best.file, "..", fileBase);
    const underscore = fileBase.lastIndexOf("_");
    return {
      tool: "omp",
      id: underscore >= 0 ? fileBase.slice(underscore + 1) : fileBase,
      file: best.file,
      artifactsDir: existsSync(artifactsDir) ? artifactsDir : undefined,
      mtime: best.mtime,
    };
  }

  async install(
    t: Transport,
    session: LocalSession,
    remoteCwd: string,
    kickoff?: string,
  ): Promise<InstalledSession> {
    const rewritten = rewriteOmpHeaderCwd(readFileSync(session.file, "utf8"), remoteCwd);
    const tmp = join(mkdtempSync(join(tmpdir(), "beam-")), "session.jsonl");
    writeFileSync(tmp, rewritten);
    await t.sendFile(tmp, `${remoteCwd}/${OMP_WORKSPACE_SESSION}`);
    const notes = [`session -> ${OMP_WORKSPACE_SESSION} (header cwd rewritten)`];
    if (session.artifactsDir) {
      await t.syncUp(session.artifactsDir, `${remoteCwd}/${OMP_WORKSPACE_ARTIFACTS}`);
      notes.push(`artifacts -> ${OMP_WORKSPACE_ARTIFACTS}/`);
    }
    return {
      resumeArgv: ["omp", "--resume", OMP_WORKSPACE_SESSION, ...(kickoff ? [kickoff] : [])],
      notes,
    };
  }

  async collect(
    _t: Transport,
    session: LocalSession,
    localCwd: string,
    _remoteCwd: string,
  ): Promise<string> {
    const grown = join(localCwd, OMP_WORKSPACE_SESSION);
    if (!existsSync(grown)) {
      throw new Error(`${OMP_WORKSPACE_SESSION} missing after sync — was the workspace shipped with a session?`);
    }
    const backup = `${session.file}.bak-${Date.now()}`;
    if (existsSync(session.file)) copyFileSync(session.file, backup);
    writeFileSync(session.file, rewriteOmpHeaderCwd(readFileSync(grown, "utf8"), localCwd));

    const grownArtifacts = join(localCwd, OMP_WORKSPACE_ARTIFACTS);
    if (existsSync(grownArtifacts) && session.artifactsDir) {
      await runChecked(["rsync", "-a", grownArtifacts + "/", session.artifactsDir + "/"]);
    }
    return `omp --resume ${session.file}`;
  }
}
