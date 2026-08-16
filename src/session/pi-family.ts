import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { shq } from "../util/shell.ts";
import { treeManifest } from "../util/digest.ts";
import type { TreeManifestEntry } from "../util/digest.ts";
import { enterWorkspaceScript, ownerGuardScript } from "../workspace.ts";
import type { Transport } from "../transport/types.ts";
import { sessionInstallKey, sessionShipBundle } from "./ship-bundle.ts";
import type {
  InstalledSession,
  InstallOptions,
  LocalSession,
  SessionAdapter,
  StagedReturn,
  ToolName,
} from "./types.ts";

/**
 * Ceiling on entries walked while proving downloaded session data inert.
 * The tree is remote-agent-grown, so the walk is bounded: a tree this
 * large is not a plausible session return and is refused outright.
 */
const MAX_SESSION_TREE_ENTRIES = 65_536;

/** Refuse links/devices in downloaded reserved session data before local I/O. */
function assertInertSessionTree(path: string): void {
  // Depth-first with an explicit stack; children are pushed reversed so
  // entries are checked in the exact order a recursive walk would use.
  const pending: string[] = [path];
  let walked = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    walked += 1;
    if (walked > MAX_SESSION_TREE_ENTRIES) {
      throw new Error(
        `remote session data holds over ${MAX_SESSION_TREE_ENTRIES} entries — refusing`,
      );
    }
    const st = lstatSync(entry);
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) {
      throw new Error(`remote session data contains an unsafe filesystem entry: ${entry}`);
    }
    if (st.isDirectory()) {
      const names = readdirSync(entry);
      for (let i = names.length - 1; i >= 0; i--) pending.push(join(entry, names[i]!));
    }
  }
}

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
 * and artifacts travel over dedicated guarded stage syncs that no user
 * exclude can suppress. Because
 * the mirror leaves `.beam` alone, a retained (default-down) workspace comes
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
  /**
   * Untrusted fast-path store dir names for a cwd: slugs collide, so every
   * file inside still validates its header cwd.
   */
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
  /** How the user resumes from the durable returned session directory. */
  localResumeHint(returnDir: string, localCwd: string): string;
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
  localResumeHint(returnDir) {
    // omp resumes by explicit transcript path — straight off the return.
    return `omp --resume ${shq(join(returnDir, "session.jsonl"))}`;
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
  localResumeHint(returnDir, localCwd) {
    // pi --resume is an interactive picker; --session-dir on the return
    // (holding exactly one transcript) resumes deterministically.
    return `cd ${shq(localCwd)} && pi --session-dir ${shq(returnDir)} --continue`;
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

/** The stable identity fields of a pi-family `{"type":"session"}` header. */
interface SessionHeader {
  id?: string;
  cwd?: string;
}

/** Parse the session header near the top of a transcript. */
function headerOfText(text: string): SessionHeader | undefined {
  for (const line of text.split("\n", 20)) {
    if (!line.includes('"type":"session"')) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string; id?: string; cwd?: string };
      if (parsed.type === "session") return { id: parsed.id, cwd: parsed.cwd };
    } catch (err) {
      // A non-JSON line is expected mid-scan; anything else is a real bug.
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  return undefined;
}

/** omp/pi store filenames are `<timestamp>_<sessionId>.jsonl`. */
function sessionIdOfFile(name: string): string {
  const base = basename(name, ".jsonl");
  const underscore = base.lastIndexOf("_");
  return underscore >= 0 ? base.slice(underscore + 1) : base;
}

/**
 * Read the session header out of a file's leading bytes, if present near the
 * top. Only the leading bytes are read: locate inspects EVERY candidate file
 * and transcripts grow large, while the header is always within the first
 * lines.
 */
const HEADER_SCAN_BYTES = 64 * 1024;

function readHeader(file: string): SessionHeader | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(HEADER_SCAN_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return headerOfText(buf.toString("utf8", 0, n));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Fallback locate scans store directories whose slug-derived names did not
 * match any direct cwd candidate. The store root accumulates one directory
 * per workspace forever, so the fallback orders directories newest-modified
 * first and opens at most this many — a bounded scan over an unbounded
 * root, mirroring Codex's SCAN_LIMIT over rollout files. A match living in
 * a directory older than every capped candidate is treated as absent.
 */
const FALLBACK_DIR_SCAN_COUNT = 400;

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
 * Newest session in `dir` whose recorded header proves BOTH identities: the
 * header cwd names `cwd`'s workspace (by path or physical alias) and the
 * header id equals the filename-derived session id. Slug-derived dir names
 * collide (`/a/b` and `/a-b` share one slug) and a store dir can hold
 * foreign, renamed, or corrupt transcripts, so no file is trusted by
 * location alone: a newest-but-foreign or newest-but-corrupt file is
 * skipped, never shipped, and an older valid session still wins.
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
    const header = readHeader(file);
    if (!header || header.cwd === undefined) continue;
    // A transcript whose header id disagrees with its filename was renamed
    // or planted: filename identity alone is never proof.
    if (header.id !== sessionIdOfFile(name)) continue;
    if (
      header.cwd !== cwd &&
      physicalCwd(header.cwd) !== cwdPhysical &&
      lexicalCwd(header.cwd) !== cwdLexical
    ) {
      continue;
    }
    best = { file, mtime };
  }
  return best;
}

/**
 * Deterministic, owner-verified reserved stage for one install: the local
 * transcript must prove the session id it claims, its header cwd is
 * rewritten to the destination (no re-root prompts), and the staged copy
 * is keyed by the journaled ship's bundle digest (fallback: the digest of
 * the exact source being shipped), so a crashed attempt's retry converges
 * onto the SAME stage instead of littering the workspace with random
 * top-level dirs that wedge the strict workspace fingerprint. `.beam`
 * never rides the workspace mirror or its proofs.
 */
function installLocalStage(options: {
  session: LocalSession;
  remoteCwd: string;
  installKey?: string;
}): { localStage: string; key: string } {
  const { session, remoteCwd, installKey } = options;
  const text = readFileSync(session.file, "utf8");
  const header = headerOfText(text);
  if (!header || header.id !== session.id) {
    throw new Error(
      `local transcript ${session.file} records session id ` +
        `${header?.id ?? "(none)"}, not ${session.id} — ` +
        `refusing to ship a mismatched session`,
    );
  }
  const rewritten = rewriteSessionHeaderCwd(text, remoteCwd);
  const localStage = mkdtempSync(join(tmpdir(), "beam-session-stage-"));
  writeFileSync(join(localStage, "session.jsonl"), rewritten);
  const key = installKey ?? sessionInstallKey(sessionShipBundle(session));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) {
    throw new Error("beam: invalid session install key");
  }
  return { localStage, key };
}

/** Identity facts shared by the commit-script phase builders below. */
interface InstallCommitOptions {
  workspaceSession: string;
  artifactsDest: string;
  stageParent: string;
  stageName: string;
  key: string;
  manifest: TreeManifestEntry[];
  hasArtifacts: boolean;
}

/**
 * Guard lines run before any verify or publish: `.beam` and the
 * deterministic stage chain must be REAL directories holding a real staged
 * transcript — never followed as links. Session bytes are confidential:
 * Beam-created dirs are 0700 no matter the remote umask.
 */
function installGuardScript(options: InstallCommitOptions): string[] {
  const { stageParent, stageName } = options;
  const beamQ = shq(".beam");
  const stagedQ = shq(`${stageName}/session.jsonl`);
  return [
    `if [ -L ${beamQ} ]; then ` +
      `echo ${shq("beam: .beam is a symlink — refusing session install")} >&2; exit 63; fi`,
    `mkdir -p -- ${beamQ} || { echo ${shq("beam: cannot create .beam")} >&2; exit 63; }`,
    `if [ -L ${beamQ} ] || [ ! -d ${beamQ} ]; then ` +
      `echo ${shq("beam: .beam is not a real directory")} >&2; exit 64; fi`,
    `chmod 700 ${beamQ} || { echo ${shq("beam: cannot secure .beam")} >&2; exit 64; }`,
    installReadModeScript(beamQ),
    `if [ "$__m" != 700 ]; then ` +
      `echo ${shq("beam: .beam is not private (0700)")} >&2; exit 64; fi`,
    `if [ -L ${shq(stageParent)} ] || [ -L ${shq(stageName)} ] || [ ! -d ${shq(stageName)} ]; ` +
      `then echo ${shq("beam: session install stage is not a real directory")} >&2; exit 65; fi`,
    `if [ -L ${stagedQ} ] || [ ! -f ${stagedQ} ]; ` +
      `then echo ${shq("beam: staged transcript is missing or unsafe")} >&2; exit 65; fi`,
    `chmod 700 ${shq(stageParent)} ${shq(stageName)} || ` +
      `{ echo ${shq("beam: cannot secure the install stage")} >&2; exit 65; }`,
    installReadModeScript(shq(stageName)),
    `if [ "$__m" != 700 ]; then ` +
      `echo ${shq("beam: install stage is not private (0700)")} >&2; exit 65; fi`,
  ];
}

/**
 * Additive only: pi's beam-private session dir may exist from a crashed
 * attempt, but --continue needs it to hold EXACTLY this session — any
 * unexpected entry refuses untouched.
 */
function installPrivateDirScript(options: {
  privateSessionDir: string;
  workspaceSession: string;
  artifactsDest: string;
}): string[] {
  const { privateSessionDir, workspaceSession, artifactsDest } = options;
  const dirQ = shq(privateSessionDir);
  return [
    `if [ -L ${dirQ} ]; then ` +
      `echo ${shq("beam: private session dir is a symlink — refusing")} >&2; exit 63; fi`,
    `mkdir -p -- ${dirQ} || ` +
      `{ echo ${shq("beam: failed to create the private session dir")} >&2; exit 66; }`,
    `chmod 700 ${dirQ} || ` +
      `{ echo ${shq("beam: cannot secure the private session dir")} >&2; exit 66; }`,
    installReadModeScript(dirQ),
    `if [ "$__m" != 700 ]; then ` +
      `echo ${shq("beam: private session dir is not private (0700)")} >&2; exit 66; fi`,
    `extra=$(find ${dirQ} -mindepth 1 ! -path ${shq(workspaceSession)} ` +
      `! -path ${shq(artifactsDest)} ! -path ${shq(`${artifactsDest}/*`)} | head -n 1)`,
    `if [ -n "$extra" ]; then echo ${shq(
      `beam: private session dir ${privateSessionDir} holds unexpected entries — ` +
        `inspect and remove them manually, then retry beam up`,
    )} >&2; exit 68; fi`,
  ];
}

/**
 * Phase 1 — VERIFY every component before any publish: a refusal must
 * leave the reserved area byte-identical, publish nothing. Ownership
 * ladder for an existing artifacts destination: OUR marked in-progress
 * publication (exact sentinel — resume), exactly the shipped tree
 * (accept), or foreign (refuse, zero writes). When this ship carries no
 * artifacts the reserved path must be empty of foreign data — it would
 * otherwise be collected later as this session's return.
 */
function installVerifyPhaseScript(options: InstallCommitOptions): string[] {
  const { workspaceSession, artifactsDest, stageName, key, manifest } = options;
  const sessQ = shq(workspaceSession);
  const artsDiffer = (what: string) =>
    installDiffersScript(`artifacts ${artifactsDest} (${what})`);
  const verify = installVerifyArtifactsScript({ manifest, fail: artsDiffer });
  return [
    `if [ -L ${sessQ} ] || { [ -e ${sessQ} ] && [ ! -f ${sessQ} ]; }; then ` +
      `echo ${shq("beam: reserved transcript path is not a regular file")} >&2; exit 66; fi`,
    `if [ -e ${sessQ} ]; then`,
    `  cmp -s -- ${shq(`${stageName}/session.jsonl`)} ${sessQ} || ` +
      `{ ${installDiffersScript(`transcript ${workspaceSession}`)}; }`,
    `fi`,
    `__stage_arts=${shq(`${stageName}/artifacts`)}`,
    `__dest_arts=${shq(artifactsDest)}`,
    `__sentinel="$__dest_arts/.beam-install-owner"`,
    `__owner_line=${shq(`beam-artifacts-v1 ${key}`)}`,
    `__arts_done=0`,
    ...(options.hasArtifacts
      ? [
          `if [ -L "$__dest_arts" ]; then echo ${shq(
            "beam: reserved artifacts path is a symlink — refusing",
          )} >&2; exit 66; fi`,
          `if [ -e "$__dest_arts" ]; then`,
          `  [ -d "$__dest_arts" ] || { echo ${shq(
            "beam: reserved artifacts path is not a directory",
          )} >&2; exit 66; }`,
          `  if [ -f "$__sentinel" ] && ` +
            `[ "$(cat "$__sentinel" 2>/dev/null)" = "$__owner_line" ]; then`,
          `    :`,
          `  else`,
          ...verify.map((l) => `    ${l}`),
          `    __arts_done=1`,
          `  fi`,
          `fi`,
        ]
      : [
          `if [ -e "$__dest_arts" ] || [ -L "$__dest_arts" ]; then ` +
            `${artsDiffer("this ship carries none")}; fi`,
        ]),
  ];
}

/**
 * Phase 2 — PUBLISH the absent components, create-only. The transcript is
 * confidential: private no matter the remote umask, verified so the
 * receipt never blesses a readable copy. Stage cleanup runs only AFTER
 * the exact destination commit; an empty parent leaves no reserved
 * residue behind.
 */
function installPublishPhaseScript(options: InstallCommitOptions): string[] {
  const { workspaceSession, artifactsDest, stageParent, stageName, manifest } = options;
  const sessQ = shq(workspaceSession);
  const transaction = options.hasArtifacts
    ? installArtifactsTransactionScript({ manifest, artifactsDest })
    : [];
  return [
    `if [ ! -e ${sessQ} ]; then`,
    `  ln -- ${shq(`${stageName}/session.jsonl`)} ${sessQ} || { echo ${shq(
      "beam: transcript target appeared concurrently — refusing to overwrite it",
    )} >&2; exit 67; }`,
    `fi`,
    `chmod 600 ${sessQ} || { echo ${shq("beam: cannot secure the transcript")} >&2; exit 67; }`,
    installReadModeScript(sessQ),
    `if [ "$__m" != 600 ]; then ` +
      `echo ${shq("beam: transcript did not land private (0600)")} >&2; exit 67; fi`,
    ...transaction,
    `rm -rf -- ${shq(stageName)}`,
    `rmdir -- ${shq(stageParent)} 2>/dev/null || true`,
  ];
}

/**
 * Create-owned directory transaction — NEVER a directory mv (a rename can
 * silently replace a concurrently recreated empty destination). Atomic
 * mkdir claims the dest (EEXIST refuses), the deterministic sentinel
 * marks the claim so an exact crash retry resumes, every manifest entry
 * publishes create-only with its shipped mode set explicitly, and the
 * final manifest verification (after the sentinel is retired) proves the
 * published tree is EXACTLY the shipped one — bytes, kinds, link targets,
 * modes, no extras — before the install receipt or any agent start. The
 * artifact root is Beam-created and 0700: it shields the preserved child
 * modes from group/other despite any umask. Known crash rule: dying
 * between mkdir and the sentinel write strands an EMPTY unowned dest that
 * a retry refuses — remove it manually.
 */
function installArtifactsTransactionScript(options: {
  manifest: TreeManifestEntry[];
  artifactsDest: string;
}): string[] {
  const { manifest, artifactsDest } = options;
  const artsDiffer = (what: string) =>
    installDiffersScript(`artifacts ${artifactsDest} (${what})`);
  const postVerify = installVerifyArtifactsScript({
    manifest,
    fail: (what) => artsDiffer(`post-publish verification: ${what}`),
  });
  return [
    `if [ "$__arts_done" != 1 ]; then`,
    `  if [ ! -e "$__dest_arts" ]; then`,
    `    mkdir -- "$__dest_arts" || { echo ${shq(
      "beam: artifacts destination appeared concurrently — refusing to overwrite it",
    )} >&2; exit 67; }`,
    `    ( set -C; printf '%s\\n' "$__owner_line" > "$__sentinel" ) 2>/dev/null || { echo ${shq(
      "beam: failed to claim the artifacts destination",
    )} >&2; exit 67; }`,
    `  fi`,
    `  chmod 700 "$__dest_arts" || exit 67`,
    `  ${installReadModeScript('"$__dest_arts"')}`,
    `  if [ "$__m" != 700 ]; then ` +
      `echo ${shq("beam: artifacts destination is not private (0700)")} >&2; exit 67; fi`,
    ...installPublishArtifactsScript({ manifest, artifactsDest }),
    `  rm -f -- "$__sentinel"`,
    ...postVerify.map((l) => `  ${l}`),
    `fi`,
  ];
}

/**
 * Exact tree fidelity: the local artifacts manifest (paths, kinds, link
 * targets, normalized modes) is embedded literally in the commit script,
 * and every acceptance re-proves byte+kind+target+mode with no extras —
 * never diff -r, which is content-only and accepts chmod drift.
 */
function installVerifyArtifactsScript(options: {
  manifest: TreeManifestEntry[];
  fail: (what: string) => string;
}): string[] {
  const { manifest, fail } = options;
  return [
    `__n=$(find "$__dest_arts" -mindepth 1 | wc -l | tr -d '[:space:]') || exit 67`,
    `if [ "$__n" != ${manifest.length} ]; then ${fail("unexpected extra entries")}; fi`,
    ...manifest.flatMap((e) => {
      const d = `"$__dest_arts/"${shq(e.path)}`;
      const s = `"$__stage_arts/"${shq(e.path)}`;
      if (e.kind === "link") {
        return [
          `if [ ! -L ${d} ] || [ "$(readlink ${d})" != ${shq(e.target!)} ]; ` +
            `then ${fail(e.path)}; fi`,
        ];
      }
      if (e.kind === "dir") {
        return [
          `if [ -L ${d} ] || [ ! -d ${d} ]; then ${fail(e.path)}; fi`,
          installReadModeScript(d),
          `if [ "$__m" != ${installModeOctal(e.mode!)} ]; then ${fail(`${e.path} (mode)`)}; fi`,
        ];
      }
      return [
        `if [ -L ${d} ] || [ ! -f ${d} ]; then ${fail(e.path)}; fi`,
        `cmp -s -- ${s} ${d} || { ${fail(e.path)}; }`,
        installReadModeScript(d),
        `if [ "$__m" != ${installModeOctal(e.mode!)} ]; then ${fail(`${e.path} (mode)`)}; fi`,
      ];
    }),
  ];
}

/**
 * Publish lines for one manifest, create-only per entry: an existing
 * identical entry is accepted, any other occupant refuses. Lines carry
 * their own two-space indent — they run inside the transaction's
 * `if [ "$__arts_done" != 1 ]` block.
 */
function installPublishArtifactsScript(options: {
  manifest: TreeManifestEntry[];
  artifactsDest: string;
}): string[] {
  const { manifest, artifactsDest } = options;
  return manifest.flatMap((e) => {
    const d = `"$__dest_arts/"${shq(e.path)}`;
    const s = `"$__stage_arts/"${shq(e.path)}`;
    const conflict = installDiffersScript(
      `artifacts ${artifactsDest} (conflicting entry ${e.path})`,
    );
    if (e.kind === "link") {
      return [
        `  if [ -L ${d} ]; then [ "$(readlink ${d})" = ${shq(e.target!)} ] || { ${conflict}; };`,
        `  elif [ -e ${d} ]; then ${conflict};`,
        `  else ln -s -- ${shq(e.target!)} ${d} || exit 67; fi`,
      ];
    }
    if (e.kind === "dir") {
      return [
        `  if [ -L ${d} ]; then ${conflict}; fi`,
        `  if [ ! -e ${d} ]; then mkdir -- ${d} || exit 67; fi`,
        `  [ -d ${d} ] || { ${conflict}; }`,
        `  chmod ${installModeOctal(e.mode!)} ${d} || exit 67`,
      ];
    }
    return [
      `  if [ -L ${d} ]; then ${conflict}; fi`,
      `  if [ ! -e ${d} ]; then ( set -C; cat ${s} > ${d} ) 2>/dev/null || exit 67; fi`,
      `  [ -f ${d} ] || { ${conflict}; }`,
      `  cmp -s -- ${s} ${d} || { ${conflict}; }`,
      `  chmod ${installModeOctal(e.mode!)} ${d} || exit 67`,
    ];
  });
}

/** Refusal (exit 68): the reserved `what` differs and may hold unsaved remote work. */
function installDiffersScript(what: string): string {
  const message =
    `beam: remote ${what} already exists with different content — ` +
    `it may hold unsaved remote work; inspect and remove it manually, then retry beam up`;
  return `echo ${shq(message)} >&2; exit 68`;
}

/** Shell line reading `quoted`'s permission bits into `__m` (GNU stat, BSD fallback). */
function installReadModeScript(quoted: string): string {
  return `__m=$(stat -c %a ${quoted} 2>/dev/null || stat -f %Lp ${quoted}) || exit 67`;
}

/**
 * Octal permission-bits text (mode & 0o7777) as commit scripts embed and
 * compare it — shared vocabulary of the verify and publish builders.
 */
function installModeOctal(mode: number): string {
  return (mode & 0o7777).toString(8);
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

    // Fallback: scan store dirs for a header-cwd match. Directories are
    // ranked by mtime and sliced to FALLBACK_DIR_SCAN_COUNT BEFORE any is
    // opened, so the loop never scales with an unbounded store root.
    if (!best) {
      const candidates: { dir: string; mtime: number }[] = [];
      for (const name of readdirSync(root)) {
        if (tried.has(name)) continue;
        const dir = join(root, name);
        const info = statSync(dir);
        if (!info.isDirectory()) continue;
        candidates.push({ dir, mtime: info.mtimeMs });
      }
      candidates.sort((a, b) => b.mtime - a.mtime);
      for (const { dir } of candidates.slice(0, FALLBACK_DIR_SCAN_COUNT)) {
        const found = newestSessionIn(dir, cwd, sessionRef);
        if (found && (!best || found.mtime > best.mtime)) best = found;
      }
    }
    if (!best) return undefined;

    const fileBase = basename(best.file, ".jsonl");
    const artifactsDir = join(best.file, "..", fileBase);
    return {
      tool: this.tool,
      // Proven equal to the header id by newestSessionIn.
      id: sessionIdOfFile(best.file),
      file: best.file,
      artifactsDir: existsSync(artifactsDir) ? artifactsDir : undefined,
      mtime: best.mtime,
    };
  }

  /**
   * Stage through the transport's guarded directory sync (owner-pinned in
   * the transfer shell when the caller supplies the workspace owner
   * bytes), then commit entirely through relative paths after one shell
   * has cd -P'd into and re-proved BOTH the physical workspace and its
   * owner marker. The commit is IDEMPOTENT and CREATE-ONLY per component:
   * an absent destination is published, a destination holding EXACTLY the
   * shipped bytes/tree is accepted (a provisioning retry after a crash),
   * and ANY difference refuses with the remote intact — an existing
   * reserved session path may hold unsaved remote work and is NEVER reset
   * or overwritten; recovery is manual.
   */
  async install(
    t: Transport,
    session: LocalSession,
    remoteCwd: string,
    { kickoff, installKey, owner }: InstallOptions = {},
  ): Promise<InstalledSession> {
    const { localStage, key } = installLocalStage({ session, remoteCwd, installKey });
    const artifactsDest = this.spec.workspaceSession.slice(0, -".jsonl".length);
    const stageParent = ".beam/session-install";
    const stageName = `${stageParent}/${key}`;
    const stage = `${remoteCwd}/${stageName}`;
    const owned = owner !== undefined ? { owned: { root: remoteCwd, ownerBytes: owner } } : {};
    try {
      // Create-or-converge WITHOUT rsync deletion (kubectl refuses mirrored
      // deletes into the reserved tree): the checksum sync makes every
      // shipped file in a crashed attempt's partial stage byte-exact again —
      // that IS the resume. Stale extras in the stage are harmless: the
      // commit engine is manifest-literal (it never enumerates the stage),
      // the transcript publishes through an exact cmp, and the whole stage
      // is removed after the destination commit.
      await t.syncUp(localStage, stage, { checksum: true, ...owned });
      if (session.artifactsDir) {
        await t.syncUp(session.artifactsDir, `${stage}/artifacts`, { checksum: true, ...owned });
      }
      const phase: InstallCommitOptions = {
        workspaceSession: this.spec.workspaceSession,
        artifactsDest,
        stageParent,
        stageName,
        key,
        manifest: session.artifactsDir ? treeManifest(session.artifactsDir) : [],
        hasArtifacts: Boolean(session.artifactsDir),
      };
      const commit = [
        "set -u",
        enterWorkspaceScript(remoteCwd),
        ...(owner !== undefined ? [ownerGuardScript(owner)] : []),
        ...installGuardScript(phase),
        ...(this.spec.privateSessionDir
          ? installPrivateDirScript({
              privateSessionDir: this.spec.privateSessionDir,
              workspaceSession: this.spec.workspaceSession,
              artifactsDest,
            })
          : []),
        ...installVerifyPhaseScript(phase),
        ...installPublishPhaseScript(phase),
      ].join("\n");
      await t.execChecked(commit);
    } catch (err) {
      // Keep the stage: it is deterministic, beam-reserved, and excluded
      // from every workspace proof — the retry converges onto it and
      // resumes. It is removed only after an exact destination commit.
      throw err;
    } finally {
      rmSync(localStage, { recursive: true, force: true });
    }
    const notes = [`session -> ${this.spec.workspaceSession} (header cwd rewritten)`];
    if (session.artifactsDir) notes.push(`artifacts -> ${artifactsDest}/`);
    return { resumeArgv: this.spec.resumeArgv(kickoff), notes };
  }

  async stageReturn(
    t: Transport,
    session: LocalSession,
    localCwd: string,
    remoteCwd: string,
    stageDir: string,
  ): Promise<StagedReturn> {
    // `.beam` is excluded from the ordinary mirror. Fetch the whole reserved
    // tree through ONE guarded directory sync: unlike exists()+scp, the
    // transport proves the physical source in the same process that reads
    // it. Validate every downloaded entry before following any local path.
    // Everything lands under the caller's stage — the local session store
    // is never touched here (the collect transaction publishes later).
    const remoteBeam = `${remoteCwd}/.beam`;
    const fetched = join(stageDir, ".beam-tree");
    await t.syncDown(remoteBeam, fetched, { checksum: true });
    assertInertSessionTree(fetched);
    const sessionRel = this.spec.workspaceSession.slice(".beam/".length);
    const collectedSession = join(fetched, sessionRel);
    if (!existsSync(collectedSession) || !lstatSync(collectedSession).isFile()) {
      throw new Error(
        `remote session ${remoteCwd}/${this.spec.workspaceSession} not found — ` +
          `was the workspace shipped with a session?`,
      );
    }
    const grown = readFileSync(collectedSession, "utf8");
    const header = headerOfText(grown);
    if (!header || header.id !== session.id) {
      throw new Error(
        `remote transcript ${remoteCwd}/${this.spec.workspaceSession} records ` +
          `session id ${header?.id ?? "(none)"}, ` +
          `not this handoff's session ${session.id} — refusing to import a foreign session`,
      );
    }
    if (header.cwd !== remoteCwd) {
      throw new Error(
        `remote transcript ${remoteCwd}/${this.spec.workspaceSession} records ` +
          `cwd ${header.cwd ?? "(none)"}, not this ` +
          `handoff's workspace ${remoteCwd} — refusing to import a foreign session`,
      );
    }
    writeFileSync(join(stageDir, "session.jsonl"), rewriteSessionHeaderCwd(grown, localCwd));

    const artifactsRel = this.spec.workspaceSession.slice(".beam/".length, -".jsonl".length);
    const collectedArtifacts = join(fetched, artifactsRel);
    if (existsSync(collectedArtifacts)) {
      // Same filesystem (both inside the stage): a plain rename.
      renameSync(collectedArtifacts, join(stageDir, "artifacts"));
    }
    rmSync(fetched, { recursive: true, force: true });
    return {
      hint: this.spec.localResumeHint(stageDir, localCwd),
      remoteSessionSha256: createHash("sha256").update(grown).digest("hex"),
    };
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
