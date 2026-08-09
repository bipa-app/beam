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
import type { InstalledSession, LocalSession, SessionAdapter, ToolName } from "./types.ts";

/**
 * The pi family: omp is built on pi, and both store sessions as JSONL with a
 * `{"type":"session",...,"cwd":...}` header line. What differs per harness is
 * captured in a PiFamilySpec:
 *
 *  - where the store lives and how its per-cwd directory is named
 *    (omp: dashed home-relative or `<scope>-<basename>-<sha256(cwd)>`;
 *     pi: the absolute cwd wrapped in dashes, `/` -> `-`),
 *  - how to resume the shipped transcript from the remote workspace
 *    (omp resumes by explicit path; pi's --resume is a picker, so beam gives
 *     pi a private --session-dir holding exactly one session and uses
 *     --continue, which deterministically picks it),
 *  - the local resume hint printed after `beam down`.
 *
 * Both ship the session INSIDE the workspace under .beam/, so the growing
 * transcript rides the normal workspace rsync back on `beam down`. The header
 * cwd is rewritten to the destination on install (no re-root prompts) and
 * restored on collect, with the previous local copy backed up.
 */

export const OMP_WORKSPACE_SESSION = ".beam/session.jsonl";
export const PI_WORKSPACE_SESSION = ".beam/pi-sessions/session.jsonl";
const PI_WORKSPACE_SESSION_DIR = ".beam/pi-sessions";

interface PiFamilySpec {
  tool: ToolName;
  binary: string;
  /** Store root segments under the home directory. */
  storeSegments: string[];
  /** Fast-path store directory names for a cwd; a header-cwd scan backs them up. */
  dirCandidates(cwd: string, home: string): string[];
  /** Where the session ships inside the workspace. */
  workspaceSession: string;
  /** Command that resumes the shipped session from the remote workspace. */
  resumeArgv(kickoff?: string): string[];
  /** How the user continues locally after `beam down`. */
  localResumeHint(sessionFile: string, localCwd: string): string;
}

const OMP_SPEC: PiFamilySpec = {
  tool: "omp",
  binary: "omp",
  storeSegments: [".omp", "agent", "sessions"],
  dirCandidates(cwd, home) {
    const candidates: string[] = [];
    if (cwd.startsWith(home)) candidates.push(cwd.slice(home.length).replaceAll("/", "-"));
    const sha = createHash("sha256").update(cwd).digest("hex");
    const base = basename(cwd);
    for (const scope of ["home", "abs", "tmp"]) candidates.push(`${scope}-${base}-${sha}`);
    return candidates;
  },
  workspaceSession: OMP_WORKSPACE_SESSION,
  resumeArgv(kickoff) {
    return ["omp", "--resume", OMP_WORKSPACE_SESSION, ...(kickoff ? [kickoff] : [])];
  },
  localResumeHint(sessionFile) {
    return `omp --resume ${sessionFile}`;
  },
};

const PI_SPEC: PiFamilySpec = {
  tool: "pi",
  binary: "pi",
  storeSegments: [".pi", "agent", "sessions"],
  dirCandidates(cwd) {
    // /a/b -> --a-b-- : the cwd wrapped in dashes with `/` -> `-`.
    return [`-${cwd}-`.replaceAll("/", "-")];
  },
  workspaceSession: PI_WORKSPACE_SESSION,
  resumeArgv(kickoff) {
    // pi --resume is an interactive picker; --continue inside a private
    // session dir holding exactly one transcript is deterministic.
    return [
      "pi",
      "--session-dir",
      PI_WORKSPACE_SESSION_DIR,
      "--continue",
      ...(kickoff ? [kickoff] : []),
    ];
  },
  localResumeHint(_sessionFile, localCwd) {
    // collect() just rewrote the store file, making it the most recent.
    return `pi --continue   (from ${localCwd})`;
  },
};

/** Rewrite the cwd recorded in the `{"type":"session"}` header line. */
export function rewriteSessionHeaderCwd(jsonl: string, newCwd: string): string {
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
  throw new Error("session header (type=session) not found in transcript");
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

export class PiFamilyAdapter implements SessionAdapter {
  readonly tool: ToolName;
  readonly binary: string;

  constructor(private readonly spec: PiFamilySpec) {
    this.tool = spec.tool;
    this.binary = spec.binary;
  }

  async locate(cwd: string, home: string, sessionRef?: string): Promise<LocalSession | undefined> {
    const root = join(home, ...this.spec.storeSegments);
    if (!existsSync(root)) return undefined;

    let best: { file: string; mtime: number } | undefined;
    for (const name of this.spec.dirCandidates(cwd, home)) {
      const found = newestSessionIn(join(root, name), sessionRef);
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
      tool: this.tool,
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
    const rewritten = rewriteSessionHeaderCwd(readFileSync(session.file, "utf8"), remoteCwd);
    const tmp = join(mkdtempSync(join(tmpdir(), "beam-")), "session.jsonl");
    writeFileSync(tmp, rewritten);
    await t.sendFile(tmp, `${remoteCwd}/${this.spec.workspaceSession}`);
    const notes = [`session -> ${this.spec.workspaceSession} (header cwd rewritten)`];
    if (session.artifactsDir) {
      const artifactsDest = this.spec.workspaceSession.slice(0, -".jsonl".length);
      await t.syncUp(session.artifactsDir, `${remoteCwd}/${artifactsDest}`);
      notes.push(`artifacts -> ${artifactsDest}/`);
    }
    return { resumeArgv: this.spec.resumeArgv(kickoff), notes };
  }

  async collect(
    _t: Transport,
    session: LocalSession,
    localCwd: string,
    _remoteCwd: string,
  ): Promise<string> {
    const grown = join(localCwd, this.spec.workspaceSession);
    if (!existsSync(grown)) {
      throw new Error(
        `${this.spec.workspaceSession} missing after sync — was the workspace shipped with a session?`,
      );
    }
    const backup = `${session.file}.bak-${Date.now()}`;
    if (existsSync(session.file)) copyFileSync(session.file, backup);
    writeFileSync(session.file, rewriteSessionHeaderCwd(readFileSync(grown, "utf8"), localCwd));

    const grownArtifacts = join(localCwd, this.spec.workspaceSession.slice(0, -".jsonl".length));
    if (existsSync(grownArtifacts) && session.artifactsDir) {
      await runChecked(["rsync", "-a", grownArtifacts + "/", session.artifactsDir + "/"]);
    }
    return this.spec.localResumeHint(session.file, localCwd);
  }
}

export class OmpAdapter extends PiFamilyAdapter {
  constructor() {
    super(OMP_SPEC);
  }
}

export class PiAdapter extends PiFamilyAdapter {
  constructor() {
    super(PI_SPEC);
  }
}
