import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { shq, shqRemotePath } from "../util/shell.ts";
import { noFollowReservedDirScript } from "../workspace.ts";
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
 * Both install the session INSIDE the workspace under `.beam/` so the remote
 * harness can resume it in place — but `.beam` is beam-reserved and NEVER
 * rides the filtered workspace mirror (see gatherExcludes): the transcript
 * and artifacts travel over explicit per-path transfers (sendFile/fetchFile
 * and dedicated artifact syncs) that no user exclude can suppress. Because
 * the mirror leaves `.beam` alone, a reused (--no-purge) workspace comes
 * back with whatever the remote agent left there — so install() never
 * writes or deletes THROUGH an unproven `.beam`: it stages at an
 * unpredictable path under the already-proven workspace and commits in one
 * remote shell that first proves `.beam` is a real directory. The header
 * cwd is rewritten to the destination on install (no re-root prompts);
 * collect() fetches the grown transcript straight off the target, proves
 * it belongs to this handoff, and restores the header, backing up the
 * previous local copy.
 */

export const OMP_WORKSPACE_SESSION = ".beam/session.jsonl";
export const PI_WORKSPACE_SESSION = ".beam/pi-sessions/session.jsonl";
const PI_WORKSPACE_SESSION_DIR = ".beam/pi-sessions";

interface PiFamilySpec {
  tool: ToolName;
  binary: string;
  /** Interactive login command; run over ssh -t by `beam login`. */
  loginArgv: string[];
  /** Optional remote probe: exit 0 = authenticated (best-effort). */
  remoteAuthProbe?: string;
  /** Store root segments under the home directory. */
  storeSegments: string[];
  /** Untrusted fast-path store dir names for a cwd: slugs collide, so every file inside still validates its header cwd. */
  dirCandidates(cwd: string, home: string): string[];
  /** Where the session ships inside the workspace. */
  workspaceSession: string;
  /**
   * Beam-private remote dir wiped wholesale on install (pi's --continue
   * demands exactly one session in it). Absent: only the transcript and
   * artifacts paths are reset.
   */
  privateSessionDir?: string;
  /** Command that resumes the shipped session from the remote workspace. */
  resumeArgv(kickoff?: string): string[];
  /** How the user continues locally after `beam down`. */
  localResumeHint(sessionFile: string, localCwd: string): string;
}

const OMP_SPEC: PiFamilySpec = {
  tool: "omp",
  binary: "omp",
  storeSegments: [".omp", "agent", "sessions"],
  loginArgv: ["omp"],
  // omp keeps auth in its agent db/broker — no file-detectable probe.
  dirCandidates(cwd, home) {
    const candidates: string[] = [];
    if (cwd.startsWith(home)) candidates.push(cwd.slice(home.length).replaceAll("/", "-"));
    // Current OMP builds use pi's wrapped absolute-cwd slug outside $HOME.
    candidates.push(`-${cwd}-`.replaceAll("/", "-") + "-");
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
  loginArgv: ["pi"],
  // pi stores provider keys in a plain file (ground-truthed on pi 0.84).
  remoteAuthProbe: 'test -s "$HOME/.pi/agent/auth.json"',
  dirCandidates(cwd) {
    // /a/b -> --a-b-- : the cwd wrapped in dashes with `/` -> `-`.
    return [`-${cwd}-`.replaceAll("/", "-") + "-"];
  },
  workspaceSession: PI_WORKSPACE_SESSION,
  privateSessionDir: PI_WORKSPACE_SESSION_DIR,
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

/** Read the cwd out of a session header near the top of a transcript. */
function headerCwdOfText(text: string): string | undefined {
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

/**
 * Read the cwd out of a session file's header, if present near the top.
 * Only the leading bytes are read: locate inspects EVERY candidate file and
 * transcripts grow large, while the header is always within the first lines.
 */
const HEADER_SCAN_BYTES = 64 * 1024;

function readHeaderCwd(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(HEADER_SCAN_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return headerCwdOfText(buf.toString("utf8", 0, n));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * macOS aliases /tmp, /var and /etc into /private/* at the filesystem root,
 * so a session may record either spelling of the same workspace. The lexical
 * mapping covers recorded cwds that no longer exist on disk; realpath covers
 * live paths and any other physical alias (symlinked components).
 */
function lexicalCwd(p: string): string {
  for (const alias of ["/tmp", "/var", "/etc"]) {
    if (p === alias || p.startsWith(`${alias}/`)) return `/private${p}`;
  }
  return p;
}

function physicalCwd(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return lexicalCwd(p);
  }
}

/**
 * Newest session in `dir` whose recorded header cwd names `cwd`'s workspace
 * (by path or physical alias). Slug-derived dir names collide (`/a/b` and
 * `/a-b` share one slug) and a store dir can hold foreign or corrupt
 * transcripts, so no file is trusted by location alone: a newest-but-foreign
 * or newest-but-corrupt file is skipped, never shipped, and an older valid
 * session still wins.
 */
function newestSessionIn(
  dir: string,
  cwd: string,
  sessionRef?: string,
): { file: string; mtime: number } | undefined {
  if (!existsSync(dir)) return undefined;
  const cwdPhysical = physicalCwd(cwd);
  const cwdLexical = lexicalCwd(cwd);
  let best: { file: string; mtime: number } | undefined;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    if (sessionRef && !name.includes(sessionRef)) continue;
    const file = join(dir, name);
    const mtime = statSync(file).mtimeMs;
    if (best && mtime <= best.mtime) continue;
    const headerCwd = readHeaderCwd(file);
    if (headerCwd === undefined) continue;
    if (
      headerCwd !== cwd &&
      physicalCwd(headerCwd) !== cwdPhysical &&
      lexicalCwd(headerCwd) !== cwdLexical
    ) {
      continue;
    }
    best = { file, mtime };
  }
  return best;
}

export class PiFamilyAdapter implements SessionAdapter {
  readonly tool: ToolName;
  readonly binary: string;
  readonly loginArgv: string[];
  readonly remoteAuthProbe?: string;

  constructor(private readonly spec: PiFamilySpec) {
    this.tool = spec.tool;
    this.binary = spec.binary;
    this.loginArgv = spec.loginArgv;
    this.remoteAuthProbe = spec.remoteAuthProbe;
  }

  async locate(cwd: string, home: string, sessionRef?: string): Promise<LocalSession | undefined> {
    const root = join(home, ...this.spec.storeSegments);
    if (!existsSync(root)) return undefined;

    // Slug-derived dir names are hints, never proof: distinct cwds can share
    // a slug, so every candidate file must validate its recorded header cwd.
    let best: { file: string; mtime: number } | undefined;
    const tried = new Set<string>();
    for (const name of this.spec.dirCandidates(cwd, home)) {
      tried.add(name);
      const found = newestSessionIn(join(root, name), cwd, sessionRef);
      if (found && (!best || found.mtime > best.mtime)) best = found;
    }

    // Fallback: scan every store dir for a header-cwd match.
    if (!best) {
      for (const name of readdirSync(root)) {
        if (tried.has(name)) continue;
        const dir = join(root, name);
        if (!statSync(dir).isDirectory()) continue;
        const found = newestSessionIn(dir, cwd, sessionRef);
        if (found && (!best || found.mtime > best.mtime)) best = found;
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
    // The beam-reserved session area must be reset before shipping: a reused
    // workspace (--no-purge) may still hold a previous handoff's transcript,
    // artifacts, or extra pi sessions — which collect() would import as if
    // this agent produced them, and which break pi's exactly-one-session
    // --continue. But `.beam` itself is remote-agent territory between
    // handoffs: it can have been swapped for a symlink so that every reset
    // or write through it lands OUTSIDE the workspace. So nothing here ever
    // operates through an unproven `.beam`: the transcript and artifacts
    // stage at an unpredictable sibling path directly under the workspace
    // (whose containment the up flow re-proves immediately before install),
    // then ONE remote shell proves `.beam` is a real directory, resets only
    // the adapter-owned paths, and moves the staged data into place — the
    // tightest check-to-use window a shell transport offers.
    const artifactsDest = this.spec.workspaceSession.slice(0, -".jsonl".length);
    const resetPaths = this.spec.privateSessionDir
      ? [this.spec.privateSessionDir]
      : [this.spec.workspaceSession, artifactsDest];
    const stage = `${remoteCwd}/.beam-stage-${randomBytes(9).toString("hex")}`;
    const stageQ = shqRemotePath(stage);
    try {
      await t.sendFile(tmp, `${stage}/session.jsonl`);
      if (session.artifactsDir) await t.syncUp(session.artifactsDir, `${stage}/artifacts`);
      const commit = [
        "set -u",
        noFollowReservedDirScript(remoteCwd),
        // `rm` never follows a symlink given AS an argument, and `.beam` —
        // the only intermediate component — was just proven a real dir, so
        // the reset cannot reach outside the workspace.
        `rm -rf -- ${resetPaths.map((p) => shqRemotePath(`${remoteCwd}/${p}`)).join(" ")} || { echo ${shq("beam: failed to reset the reserved session area")} >&2; exit 65; }`,
        ...(this.spec.privateSessionDir
          ? [
              `mkdir -p -- ${shqRemotePath(`${remoteCwd}/${this.spec.privateSessionDir}`)} || { echo ${shq("beam: failed to create the private session dir")} >&2; exit 66; }`,
            ]
          : []),
        `mv -- ${shqRemotePath(`${stage}/session.jsonl`)} ${shqRemotePath(`${remoteCwd}/${this.spec.workspaceSession}`)} || { echo ${shq("beam: failed to install the session transcript")} >&2; exit 67; }`,
        ...(session.artifactsDir
          ? [
              `mv -- ${shqRemotePath(`${stage}/artifacts`)} ${shqRemotePath(`${remoteCwd}/${artifactsDest}`)} || { echo ${shq("beam: failed to install the session artifacts")} >&2; exit 67; }`,
            ]
          : []),
        `rm -rf -- ${stageQ}`,
      ].join("\n");
      await t.execChecked(commit);
    } catch (err) {
      // Best-effort stage cleanup: the stage is a SIBLING of `.beam`, never
      // under it, and `rm` does not follow its final component.
      await t.exec(`rm -rf -- ${stageQ}`);
      throw err;
    }
    const notes = [`session -> ${this.spec.workspaceSession} (header cwd rewritten)`];
    if (session.artifactsDir) notes.push(`artifacts -> ${artifactsDest}/`);
    return { resumeArgv: this.spec.resumeArgv(kickoff), notes };
  }

  async collect(
    t: Transport,
    session: LocalSession,
    localCwd: string,
    remoteCwd: string,
  ): Promise<string> {
    // Fetch the grown transcript straight off the target — NEVER from the
    // local workspace mirror. `.beam` is excluded from the filtered mirror
    // (see gatherExcludes), and a pre-existing local `.beam/session.jsonl`
    // is stale scratch from an earlier handoff, not returned state.
    const remoteSession = `${remoteCwd}/${this.spec.workspaceSession}`;
    if (!(await t.exists(remoteSession))) {
      throw new Error(
        `remote session ${remoteSession} not found — was the workspace shipped with a session?`,
      );
    }
    const tmp = join(mkdtempSync(join(tmpdir(), "beam-")), "session.jsonl");
    await t.fetchFile(remoteSession, tmp);
    const grown = readFileSync(tmp, "utf8");
    // Bind the transcript to this handoff before touching the local store:
    // install() rewrote the header cwd to this remote workspace, so anything
    // else is a foreign or corrupt transcript — refuse, do not import.
    const headerCwd = headerCwdOfText(grown);
    if (headerCwd !== remoteCwd) {
      throw new Error(
        `remote transcript ${remoteSession} records cwd ${headerCwd ?? "(none)"}, not this ` +
          `handoff's workspace ${remoteCwd} — refusing to import a foreign session`,
      );
    }
    const backup = `${session.file}.bak-${Date.now()}`;
    if (existsSync(session.file)) copyFileSync(session.file, backup);
    writeFileSync(session.file, rewriteSessionHeaderCwd(grown, localCwd));

    // The remote agent may have CREATED artifacts even when none existed
    // locally at locate time (the harness writes a sibling dir next to the
    // transcript). Always derive the store-side destination from the store
    // file so the pair stays resolvable after the remote purge.
    const remoteArtifacts = `${remoteCwd}/${this.spec.workspaceSession.slice(0, -".jsonl".length)}`;
    if (await t.exists(remoteArtifacts)) {
      const localArtifacts =
        session.artifactsDir ?? join(dirname(session.file), basename(session.file, ".jsonl"));
      // Additive on purpose: a mirrored (delete) return is licensed per
      // transfer root on some transports, and a dir the REMOTE agent created
      // was never syncUp'd from here.
      await t.syncDown(remoteArtifacts, localArtifacts);
    }
    return this.spec.localResumeHint(session.file, localCwd);
  }

  async cleanupRemote(_t: Transport, _session: LocalSession, _remoteCwd: string): Promise<void> {
    // The transcript ships inside the workspace (.beam/), so purging the
    // workspace removes every trace. Nothing lives outside it.
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
