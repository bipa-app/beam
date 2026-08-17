import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  run,
  runChecked,
  shq,
  shqRemotePath,
  type RunOptions,
  type RunResult,
} from "./util/shell.ts";
import { fileSha256 } from "./util/digest.ts";
import {
  BEAM_OWNER_FILE,
  BEAM_RESERVED_DIR,
  enterWorkspaceScript,
  ownedDestinationScript,
  ownerGuardScript,
  workspaceOwnerContent,
} from "./workspace.ts";
import type { Transport } from "./transport/types.ts";

/**
 * Git workspace materialization (beam up) and return (beam down).
 *
 * A linked worktree (`git worktree add`) has no `.git` directory:
 * `<cwd>/.git` is a pointer file into a common Git dir shared with sibling
 * checkouts. A standard checkout has a `.git` directory, but mirroring it
 * from a sandbox would let remote config and hooks cross the host boundary.
 * Beam therefore handles both layouts through the same standalone payload.
 *
 * OUTBOUND, beam builds a STANDALONE `.git` directory in a temp dir that
 * reproduces this worktree's Git identity — same HEAD (attached branch or
 * detached SHA), EVERY trusted shared ref (branches, tags, remote-tracking
 * refs, `refs/replace`, `refs/notes`, custom namespaces, and the stash with
 * its full reflog stack — only `refs/beam/` bookkeeping and worktree-scoped
 * internals stay home), the repo's local config minus machine-layout keys,
 * and the source index file byte for byte — with zero references to local
 * absolute paths. Shipping the index itself carries intent-to-add,
 * assume-unchanged, REUC and extended flags; split-index shards are
 * collapsed and cache-only extensions stripped in the temp repository. A
 * workspace with no index file is seeded from HEAD instead, or explicitly
 * empty while HEAD is unborn. Unstaged and untracked state rides the
 * normal workspace mirror. A ship-time ref snapshot (`beam-shipped-refs`) pins
 * every shipped shared ref (stash stack included) so the return can tell
 * remote work from untouched mirrors. Every step is fatal: a handoff that
 * cannot carry its Git state must fail before anything remote happens.
 *
 * INBOUND, `beam down` collects the remote standalone `.git` into quarantine,
 * rejects links and special files, then removes all remote config, hooks,
 * common-dir pointers, and object alternates before invoking local Git.
 * Remote Git metadata can never select a host executable or host path.
 * Beam verifies the inert repository whole (`git fsck`), imports every
 * remote-created object into the local common repository (content-addressed,
 * purely additive, published create-only), and pins every remotely CHANGED
 * ref, deletion, symref, stash entry, reflog, and the remote HEAD/index
 * under disjoint durable subtrees of `refs/beam/return/<id>/`. The return
 * is QUARANTINE-ONLY: no local ref, HEAD, index, operation state, or
 * worktree byte is ever written — the returned working tree is persisted
 * as a verified stage under beam's own storage, and integrating it (or
 * adopting a pinned ref value) is the user's explicit act, guided by the
 * printed notes. The return refuses up front unless the destination proves
 * by device+inode to be the repository that shipped. Any failure leaves
 * the verified stage/local checkout boundary and retained remote intact.
 */

/**
 * Environment variables through which the PROCESS CALLER could retarget a
 * Git subprocess away from the repository beam names explicitly (`-C`,
 * `--git-dir`), splice a foreign object store, index, or history boundary
 * into verification, or inject arbitrary config. Every internal Git
 * subprocess runs with these stripped; deliberate per-operation values (an
 * isolated GIT_INDEX_FILE, snapshot author identity) are layered back AFTER
 * the strip, per call. The indexed `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`
 * family is matched by pattern; everything else by exact name.
 */
const GIT_REPO_SELECTION_ENV = new Set([
  // Repository / worktree selection and discovery.
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  // Object store selection: fsck/cat-file must judge the named repo alone.
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_QUARANTINE_PATH",
  // Object identity remapping.
  "GIT_REPLACE_REF_BASE",
  "GIT_NO_REPLACE_OBJECTS",
  // Index selection and write format.
  "GIT_INDEX_FILE",
  "GIT_INDEX_VERSION",
  // History-boundary files beam explicitly refuses to ship.
  "GIT_GRAFT_FILE",
  "GIT_SHALLOW_FILE",
  // Config file selection and inline config injection.
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  // New-repo template and format selection (`git clone` builds the payload
  // repo; a template plants executable hooks in it).
  "GIT_TEMPLATE_DIR",
  "GIT_DEFAULT_HASH",
  "GIT_DEFAULT_REF_FORMAT",
]);
const GIT_CONFIG_INDEXED_ENV = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

/**
 * Copy of the process environment with every repository/config/object/index
 * selection variable removed. Everything else — PATH, HOME, locale — passes
 * through untouched.
 */
export function sanitizedGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (GIT_REPO_SELECTION_ENV.has(name) || GIT_CONFIG_INDEXED_ENV.test(name)) continue;
    env[name] = value;
  }
  return env;
}

/** `run` for internal Git subprocesses: identical contract, sanitized base env. */
function runGit(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run(argv, { ...opts, baseEnv: sanitizedGitEnv() });
}

/** `runChecked` for internal Git subprocesses: identical contract, sanitized base env. */
function runGitChecked(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  return runChecked(argv, { ...opts, baseEnv: sanitizedGitEnv() });
}

/**
 * Local config sections that describe THIS machine's layout, never the repo:
 * they carry absolute paths (`core.hooksPath`, `safe.directory`, includes),
 * per-checkout state (`worktree.*`), or repo-format toggles the clone already
 * settled (`core.*`, `extensions.*`). Everything else — remotes, branches,
 * user identity, signing setup — travels.
 */
const MACHINE_LAYOUT_CONFIG = [
  "core.",
  "extensions.",
  "worktree.",
  "include.",
  "includeif.",
  "safe.",
];

/**
 * Ship-time ref snapshot filename, written into the materialized `.git` and
 * read back from the collected one. Non-standard names in a Git dir are
 * inert to git itself.
 */
export const SHIPPED_REFS_FILE = "beam-shipped-refs";
export const SHIPPED_STASH_LOG_FILE = "beam-shipped-stash-log";

/** Create-only local identity markers; neither file enters the standalone payload. */
const REPOSITORY_ID_FILE = "beam-repository-id";
const WORKTREE_ID_FILE = "beam-worktree-id";

/**
 * Deterministic namespace holding what the return preserved instead of (or
 * alongside) applying. Each source ref name is SHA-256 encoded into ONE
 * path component. That invariant is load-bearing across retries: legal Git
 * refs `refs/heads/a` and `refs/heads/a/value` can replace one another
 * without either quarantine ref becoming a file/directory prefix of the
 * other. The exact source name remains in notes and symbolic metadata.
 */
export type ReturnValueKind =
  | "values"
  | "deleted"
  | "meta/ref-targets"
  | "meta/remote-beam"
  | "meta/symrefs/values"
  | "meta/symrefs/targets"
  | "meta/symrefs/deleted";

/**
 * Per-collection quarantine namespace: every artifact of one down lands
 * under the exact collected Git tree fingerprint, so retries of the SAME
 * remote snapshot converge onto identical refs while a different later
 * snapshot (including one restored to the ship baseline) gets its own
 * append-only namespace. An older collection's pins can therefore never
 * be mistaken for the latest state — the notes of the last successful
 * down name the only current namespace, and each namespace carries its
 * own immutable `manifest` blob describing exactly what that collection
 * contained. Crash safety needs no moving pointer: refs are append-only
 * across namespaces and all pinned data is content-addressed.
 */
export function returnQbase(recordId: string, gitDigest: string): string {
  return `${returnRefBase(recordId)}/${gitDigest}`;
}

export function returnValueRef(
  recordId: string,
  gitDigest: string,
  kind: ReturnValueKind,
  sourceRef: string,
): string {
  return `${returnQbase(recordId, gitDigest)}/${kind}/${contentDigest(sourceRef)}/value`;
}

function returnValueRefAtBase(qbase: string, kind: ReturnValueKind, sourceRef: string): string {
  return `${qbase}/${kind}/${contentDigest(sourceRef)}/value`;
}
export function returnRefBase(recordId: string): string {
  return `refs/beam/return/${recordId}`;
}
/** Key one record's Git artifacts by its successful ship generation. */
export function worktreeGitReturnKey(
  recordId: string,
  shipInfo: WtGitShipInfo | undefined,
): string {
  const generation = shipInfo?.generation;
  if (generation === undefined || !/^[0-9a-f]{16}$/.test(generation)) {
    throw new Error(
      `beam: handoff ${recordId} has no valid Git payload generation on record — ` +
        `refusing to key its return`,
    );
  }
  return `${recordId}-${generation}`;
}

/**
 * Reserved remote payload directory for one Git ship generation, relative
 * to the workspace root. Lives under `.beam`, so the single reserved
 * mirror exclude protects it in both directions and no sibling name can
 * collide with user paths.
 */
export function gitPayloadPath(generation: string): string {
  if (!/^[0-9a-f]{16}$/.test(generation)) {
    throw new Error(`beam: invalid Git payload generation: ${generation}`);
  }
  return `${BEAM_RESERVED_DIR}/git/${generation}`;
}

/** Exact bytes of the `.git` gitdir pointer file publishing one generation. */
export function gitPointerBytes(generation: string): string {
  return `gitdir: ${gitPayloadPath(generation)}\n`;
}

/**
 * Recovery namespace for exact raw remote reflogs. BOTH the source ref name
 * and the raw content are SHA-256 keyed into one path component each, so a
 * hostile ref name can never traverse or D/F-conflict, and a retried down
 * that collects a GROWN reflog lands beside the prior capture instead of
 * forking or overwriting it. The exact source name remains in notes.
 */
export function returnReflogRef(
  recordId: string,
  gitDigest: string,
  sourceRef: string,
  rawReflog: string | Uint8Array,
): string {
  const qbase = returnQbase(recordId, gitDigest);
  return `${qbase}/meta/reflogs/${contentDigest(sourceRef)}/${contentDigest(rawReflog)}`;
}

/**
 * Durable pin keeping one reflog-referenced object gc-proof; key = value =
 * the object id, so a retry can only rewrite the identical value.
 */
export function returnReflogPinRef(recordId: string, gitDigest: string, oid: string): string {
  return `${returnQbase(recordId, gitDigest)}/meta/reflog-pins/${oid}`;
}

/**
 * Durable pin keeping one unreferenced collected object gc-proof; key =
 * value = the object id, so a retry can only rewrite the identical value.
 */
export function returnObjectPinRef(recordId: string, gitDigest: string, oid: string): string {
  return `${returnQbase(recordId, gitDigest)}/meta/object-pins/${oid}`;
}


/**
 * Ref namespaces that are private to one worktree (git routes them to the
 * worktree git dir). They never ship — the payload is not this worktree's
 * git dir — and remote-created ones come home as durable quarantine pins
 * like every other changed ref; the local worktree's own are untouched.
 */
const WORKTREE_SCOPED_REFS = ["refs/bisect/", "refs/worktree/", "refs/rewritten/"];

/**
 * Every shared ref beam trusts to ship: everything but its own bookkeeping
 * and worktree internals.
 */
function isShippableSharedRef(ref: string): boolean {
  return !ref.startsWith("refs/beam/") && !WORKTREE_SCOPED_REFS.some((p) => ref.startsWith(p));
}

/**
 * Stash current ref plus every reflog position, newest first. Reflogs may
 * legally contain the same OID more than once with distinct messages; those
 * are distinct stack positions and must never be deduplicated.
 */
function stashStack(tip: string, reflogRaw: Uint8Array | undefined): string[] {
  const positions: string[] = [];
  // Parse-only latin1 view: OIDs are ASCII and latin1 preserves byte
  // positions; the raw bytes are NEVER round-tripped through this string.
  const text = reflogRaw === undefined ? "" : Buffer.from(reflogRaw).toString("latin1");
  for (const line of text.split("\n")) {
    const match = /^[0-9a-f]{40,64} ([0-9a-f]{40,64}) /.exec(line);
    if (match?.[1] !== undefined) positions.push(match[1]);
  }
  positions.reverse();
  if (positions[0] !== tip) positions.unshift(tip);
  return positions;
}

/**
 * Snapshot names pinning the shipped stash stack below the tip:
 * `refs/stash@{n}` (never a real ref name — `@{` is illegal in refnames).
 */
function shippedStashName(n: number): string {
  return `refs/stash@{${n}}`;
}


/** True when `<cwd>/.git` is a regular file — a linked `git worktree` pointer. */
export function isLinkedWorktree(localCwd: string): boolean {
  const st = lstatSync(join(localCwd, ".git"), { throwIfNoEntry: false });
  return st?.isFile() ?? false;
}

/** True when `<cwd>/.git` is a standard directory or linked-worktree pointer. */
export function isGitWorktree(localCwd: string): boolean {
  const st = lstatSync(join(localCwd, ".git"), { throwIfNoEntry: false });
  return st?.isDirectory() === true || st?.isFile() === true;
}

/**
 * Classify the `<cwd>/.git` entry WITHOUT following links. Only a real
 * directory (standard repository) or a regular file (linked-worktree
 * pointer) can make the round trip: the workspace mirror excludes `.git`
 * in every ASCII case, so a workspace whose `.git` is anything else — a
 * symlink to a repository elsewhere, a socket, a fifo — would silently
 * ship as plain with its Git state stripped, and a mirrored re-ship would
 * even delete the remote copy. Callers must refuse "unsupported" BEFORE
 * any remote effect.
 */
export function workspaceGitEntryKind(
  localCwd: string,
): "absent" | "directory" | "file" | "unsupported" {
  const st = lstatSync(join(localCwd, ".git"), { throwIfNoEntry: false });
  if (st === undefined) return "absent";
  if (st.isSymbolicLink()) return "unsupported";
  if (st.isDirectory()) return "directory";
  if (st.isFile()) return "file";
  return "unsupported";
}

/**
 * True when the cwd ITSELF looks like a Git directory — a bare repository
 * or a repository's git-dir (git's own discovery signature: a regular
 * `HEAD` file plus `objects/` and `refs/` directories, no `.git` child).
 * Such a workspace must never ship: it classifies as "plain", so the raw
 * mirror would copy config, hooks, alternates, and objects across the
 * sandbox boundary unquarantined. Detection is pure-filesystem so the
 * refusal cannot depend on a local `git` binary.
 */
export function isGitDirAtCwd(localCwd: string): boolean {
  if (workspaceGitEntryKind(localCwd) !== "absent") return false;
  const head = lstatSync(join(localCwd, "HEAD"), { throwIfNoEntry: false });
  if (head?.isFile() !== true || head.isSymbolicLink()) return false;
  const objects = lstatSync(join(localCwd, "objects"), { throwIfNoEntry: false });
  const refs = lstatSync(join(localCwd, "refs"), { throwIfNoEntry: false });
  return objects?.isDirectory() === true && refs?.isDirectory() === true;
}

/**
 * Stable filesystem identity of a Git directory: device and inode at ship
 * time, serialized as decimal strings so 64-bit values survive JSON without
 * numeric precision loss.
 */
export interface GitDirIdentity {
  dev: string;
  ino: string;
}

/** Content-pinned local identity that survives inode reuse but not repository replacement. */
function ensureGitIdentityToken(dir: string, name: string): string {
  const path = join(dir, name);
  try {
    writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if (!err || typeof err !== "object" || !("code" in err) || err.code !== "EEXIST") throw err;
  }
  const st = lstatSync(path);
  const token = st.isFile() ? readFileSync(path, "utf8").trim() : "";
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new Error(`beam up: ${path} is not a valid Beam repository identity marker`);
  }
  return token;
}

function readGitIdentityToken(dir: string, name: string): string | undefined {
  const path = join(dir, name);
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st?.isFile()) return undefined;
  const token = readFileSync(path, "utf8").trim();
  return /^[0-9a-f]{64}$/.test(token) ? token : undefined;
}

function contentDigest(content: string | Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(content);
  return h.digest("hex");
}

/** Filesystem identity of a directory (bigint stat — precision-safe). */
function dirIdentity(path: string): GitDirIdentity {
  const st = statSync(path, { bigint: true });
  return { dev: st.dev.toString(), ino: st.ino.toString() };
}

/** Ship-time identity of a materialized Git handoff, persisted on the record. */
export interface WtGitShipInfo {
  /** HEAD commit at ship time; absent when the repository was unborn (no commit yet). */
  head?: string;
  /** Attached branch ref at ship time (absent when detached). */
  branch?: string;
  /** Absolute common Git dir of the source worktree at ship time. */
  commonDir: string;
  /**
   * Absolute per-worktree Git dir at ship time (`rev-parse
   * --absolute-git-dir`; equals commonDir for a standard checkout). Absent
   * only on records shipped by older beam versions — the return refuses those.
   */
  worktreeGitDir?: string;
  /**
   * Filesystem identity of commonDir at ship time (absent on legacy
   * records; the return refuses those).
   */
  commonDirId?: GitDirIdentity;
  /**
   * Filesystem identity of worktreeGitDir at ship time (absent on legacy
   * records; the return refuses those).
   */
  worktreeGitDirId?: GitDirIdentity;
  /** Create-only token stored in commonDir (absent on legacy records; the return refuses those). */
  commonDirToken?: string;
  /**
   * Create-only token stored in worktreeGitDir (absent on legacy records;
   * the return refuses those).
   */
  worktreeGitDirToken?: string;
  /** SHA-256 pins of ship-time ref names/values and raw stash reflog. */
  shippedRefsDigest?: string;
  shippedStashLogDigest?: string;
  /**
   * Unique per-ship payload generation, assigned at materialize for EVERY
   * Git payload (fresh included) — it names the remote payload directory
   * (`.beam/git/<generation>`) and keys the return/quarantine namespace.
   */
  generation: string;
}

export interface MaterializedWorktreeGit {
  /** Standalone `.git` directory, ready to sync to `<remoteCwd>/.git`. */
  gitDir: string;
  /** Ship-time identity `beam down` keys its git-state return off. */
  shipInfo: WtGitShipInfo;
  /** Fail closed unless source and completed payload still match one coherent snapshot. */
  assertSourceUnchanged(): Promise<void>;
  /** Remove all temp state. Idempotent; safe on every outcome. */
  cleanup(): void;
}

/**
 * `git config --local --null --list` output: entries are NUL-terminated,
 * key and value split by the FIRST newline (values may span lines). An entry
 * with no newline is the implicit-true shorthand (`[section] key`).
 */
function parseNulConfig(raw: string): Array<[key: string, value: string]> {
  const entries: Array<[string, string]> = [];
  for (const chunk of raw.split("\0")) {
    if (chunk === "") continue;
    const nl = chunk.indexOf("\n");
    if (nl === -1) entries.push([chunk, "true"]);
    else entries.push([chunk.slice(0, nl), chunk.slice(nl + 1)]);
  }
  return entries;
}

/**
 * Whether a git URL/path value names THIS machine's filesystem. Mirrors
 * git's own URL classification: an explicit scheme is network (except
 * `file://`), scp-like `host:path` and `helper::address` forms are not
 * local paths (helper forms are refused separately by `unshippableUrl`),
 * and everything else — absolute, `~`/`~user`-relative, `./`/`../`, or bare
 * relative — is a local path git would resolve on this machine.
 */
function localFilesystemPath(value: string): boolean {
  if (value === "") return false;
  if (value.startsWith("file://")) return true;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return false;
  if (value.startsWith("~") || isAbsolute(value)) return true;
  const colon = value.indexOf(":");
  if (colon > 0 && !value.slice(0, colon).includes("/")) return false;
  return true;
}

/** Config families whose values are credentials, credential helpers, auth
 * headers/cookies/client keys, or service passwords. None may cross the
 * sandbox boundary, even when a particular value looks harmless. */
function secretBearingConfig(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    /^(?:credential|http|https|sendemail|imap|lfs)(?:\.|$)/.test(lower) ||
    /^remote\..+\.(?:proxy|proxycommand)$/.test(lower)
  );
}

/** Reject credentials embedded in a network URL. HTTP(S) usernames are
 * commonly OAuth tokens; passwords and auth-like query params are secrets
 * under every scheme. Malformed explicit URLs fail closed. */
function credentialBearingUrl(value: string): boolean {
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.password !== "") return true;
    if ((url.protocol === "http:" || url.protocol === "https:") && url.username !== "") return true;
    for (const key of url.searchParams.keys()) {
      // Substring `token` covers access_token, private_token, id_token…
      if (/(?:token|auth|credential|key|pass|secret|signature)/i.test(key)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * A config URL value beam refuses to ship: it names this machine's
 * filesystem, routes through a remote helper, or carries credentials.
 * The `::` test is `<transport>::<address>` remote-helper syntax
 * (gitremote-helpers(1)), matched exactly the way git detects it: a
 * scheme-shaped transport name followed by `::`. `ext::` executes an
 * arbitrary command (git-remote-ext), and every helper address is opaque
 * free text that may embed commands, secrets, or host paths — none of it
 * verifiable here. No helper form ships.
 */
function unshippableUrl(value: string): boolean {
  return (
    localFilesystemPath(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*::/.test(value) ||
    credentialBearingUrl(value)
  );
}

/**
 * A local clone often has a filesystem path as its origin. That path is both
 * unusable on the target and host-layout data, so omit the whole remote when
 * it has no shippable network fetch URL. Mixed remotes keep their network
 * URLs while dropping local fetch/push alternatives. The same rule covers
 * every other path-bearing config form: `submodule.*.url` pinned to a local
 * path, and `url.<base>.insteadOf`/`pushInsteadOf` rewrites where either
 * side is unshippable. Remote-helper (`transport::address`) forms are
 * deliberately omitted wholesale — see `unshippableUrl`. Multi-valued keys
 * keep their surviving values.
 */
function portableConfig(
  entries: Array<[key: string, value: string]>,
): Array<[key: string, value: string]> {
  const remoteFetchUrls = new Map<string, string[]>();
  for (const [key, value] of entries) {
    const match = /^remote\.(.+)\.url$/.exec(key);
    if (!match?.[1]) continue;
    const urls = remoteFetchUrls.get(match[1]) ?? [];
    urls.push(value);
    remoteFetchUrls.set(match[1], urls);
  }
  const unusableRemotes = new Set(
    [...remoteFetchUrls]
      .filter(([, urls]) => urls.every(unshippableUrl))
      .map(([name]) => name),
  );
  return entries.filter(([key, value]) => {
    if (secretBearingConfig(key)) return false;
    const remote = /^remote\.(.+)\.[^.]+$/i.exec(key)?.[1];
    if (remote && unusableRemotes.has(remote)) return false;
    if (/^remote\..+\.(?:url|pushurl)$/i.test(key)) {
      if (unshippableUrl(value)) return false;
    }
    if (/^submodule\..+\.url$/i.test(key)) {
      if (unshippableUrl(value)) return false;
    }
    const insteadOf = /^url\.(.+)\.(?:insteadof|pushinsteadof)$/i.exec(key);
    if (insteadOf?.[1] && (unshippableUrl(insteadOf[1]) || unshippableUrl(value))) {
      return false;
    }
    return true;
  });
}

/** The exact non-machine, non-secret config contract installed remotely. */
function outboundConfig(entries: Array<[string, string]>): Array<[string, string]> {
  return portableConfig(entries).filter(
    ([key]) => !MACHINE_LAYOUT_CONFIG.some((prefix) => key.startsWith(prefix)),
  );
}

interface SourceRef {
  ref: string;
  sha: string;
  /** Set when the ref is symbolic (e.g. refs/remotes/origin/HEAD). */
  symrefTarget: string | undefined;
}

interface LooseSymbolicRef extends SourceRef {
  file: string;
}

function refMatchesPatterns(ref: string, patterns: string[]): boolean {
  return (
    patterns.length === 0 ||
    patterns.some((pattern) => ref === pattern || ref.startsWith(`${pattern.replace(/\/$/, "")}/`))
  );
}

/**
 * The files backend keeps symbolic refs as loose `ref: <target>` files.
 * `for-each-ref` omits them when the target is missing, so enumerate only
 * these validated files as well. Packed refs cannot be symbolic; reftable is
 * refused by assertFilesRefStorage.
 */
async function listLooseSymbolicRefs(
  gitPrefix: string[],
  patterns: string[],
): Promise<LooseSymbolicRef[]> {
  const commonDir = (
    await runGitChecked([...gitPrefix, "rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).stdout.trim();
  const worktreeDir = (
    await runGitChecked([...gitPrefix, "rev-parse", "--absolute-git-dir"])
  ).stdout.trim();
  const refsRoots = [...new Set([join(commonDir, "refs"), join(worktreeDir, "refs")])];
  const objectFormat = (
    await runGitChecked([...gitPrefix, "rev-parse", "--show-object-format"])
  ).stdout.trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error(
      `beam: unsupported Git object format while reading symbolic refs: ${objectFormat}`,
    );
  }
  const zeroOid = objectFormat === "sha256" ? "0".repeat(64) : "0".repeat(40);
  const symbolic = new Map<string, LooseSymbolicRef>();
  for (const refsRoot of refsRoots) {
    if (!existsSync(refsRoot)) continue;
    for (const { file, ref } of enumerateLooseRefFiles(refsRoot)) {
      const raw = readFileSync(file, "utf8");
      if (!raw.startsWith("ref:")) continue;
      const match = /^ref: (refs\/[^\r\n]+)\n?$/.exec(raw);
      if (!match?.[1]) throw new Error(`beam: malformed loose symbolic ref: ${ref}`);
      if (!refMatchesPatterns(ref, patterns)) continue;
      for (const candidate of [ref, match[1]]) {
        const valid = await runGit([...gitPrefix, "check-ref-format", candidate]);
        if (valid.code !== 0) {
          throw new Error(`beam: invalid loose symbolic ref name or target: ${ref}`);
        }
      }
      const resolved = await runGit([...gitPrefix, "rev-parse", "--verify", "--quiet", ref]);
      const resolvedSha = resolved.stdout.trim();
      const sha = /^[0-9a-f]{40,64}$/.test(resolvedSha) ? resolvedSha : zeroOid;
      symbolic.set(ref, { ref, sha, symrefTarget: match[1], file });
    }
  }
  return [...symbolic.values()];
}

/**
 * Ceiling on entries one loose-ref enumeration may visit. A real refs tree
 * holds at most a few thousand loose files; exceeding this bound means
 * runaway growth or a crafted tree, and fails closed.
 */
const MAX_LOOSE_REF_ENTRIES = 1_000_000;

/**
 * Lazily enumerate every regular file under one refs root with an explicit
 * depth-first stack, in the exact order of the recursive walk it replaces:
 * one directory's entries in sorted order, a subdirectory fully visited
 * before its later siblings (children push reversed so pops come out
 * sorted). Entries are lstat'd — links are never followed — and anything
 * that is neither a directory nor a regular file refuses.
 */
function* enumerateLooseRefFiles(refsRoot: string): Generator<{ file: string; ref: string }> {
  const stack: Array<{ file: string; parts: string[] }> = [];
  for (const name of readdirSync(refsRoot).sort().reverse()) {
    stack.push({ file: join(refsRoot, name), parts: [name] });
  }
  let entriesVisited = 0;
  while (stack.length > 0) {
    entriesVisited += 1;
    if (entriesVisited > MAX_LOOSE_REF_ENTRIES) {
      throw new Error(
        `beam: the Git refs tree at ${refsRoot} exceeds ${MAX_LOOSE_REF_ENTRIES} entries — ` +
          `refusing to enumerate it`,
      );
    }
    const { file, parts } = stack.pop()!;
    const st = lstatSync(file);
    if (st.isDirectory()) {
      for (const name of readdirSync(file).sort().reverse()) {
        stack.push({ file: join(file, name), parts: [...parts, name] });
      }
      continue;
    }
    if (!st.isFile()) {
      throw new Error(`beam: Git refs contain an unsupported filesystem entry: ${file}`);
    }
    yield { file, ref: `refs/${parts.join("/")}` };
  }
}

/** All direct refs plus loose symbolic refs whose targets may be missing. */
async function listRefsWith(gitPrefix: string[], patterns: string[]): Promise<SourceRef[]> {
  const res = await runGitChecked([
    ...gitPrefix,
    "for-each-ref",
    "--format=%(objectname)%00%(symref)%00%(refname)",
    ...patterns,
  ]);
  const refs = new Map<string, SourceRef>();
  for (const line of res.stdout.split("\n")) {
    if (line === "") continue;
    const [sha, symref, ref] = line.split("\0");
    if (!sha || !ref) continue;
    refs.set(ref, { ref, sha, symrefTarget: symref || undefined });
  }
  for (const symbolic of await listLooseSymbolicRefs(gitPrefix, patterns)) {
    refs.set(symbolic.ref, symbolic);
  }
  return [...refs.values()].sort((a, b) => a.ref.localeCompare(b.ref));
}


/** Absolute per-worktree git path (`rev-parse --git-path`, resolved against the worktree). */
async function gitPath(localCwd: string, name: string): Promise<string> {
  const out = await runGitChecked(["git", "-C", localCwd, "rev-parse", "--git-path", name]);
  return resolve(localCwd, out.stdout.trim());
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

/**
 * Sparse layouts cannot round-trip: the materialized payload would hand the
 * remote a FULL checkout (sparse index state does not survive the
 * clone+read-tree reconstruction), and the return would clobber the local
 * sparse index with a full one. Refuse before any side effect, naming the
 * exact way out.
 */
async function assertNoSparseLayout(localCwd: string, when: string): Promise<void> {
  const sparse = await runGit(
    ["git", "-C", localCwd, "config", "--get", "--type=bool", "core.sparseCheckout"],
  );
  if (sparse.code === 0 && sparse.stdout.trim() === "true") {
    throw new Error(
      `${when}: this linked worktree uses sparse-checkout, an unsupported layout ` +
        `beam cannot ship faithfully — run \`git sparse-checkout disable\` in ` +
        `${localCwd} (or hand off a full checkout) and retry`,
    );
  }
  const tags = await runGitChecked(["git", "-C", localCwd, "ls-files", "-t", "-z"]);
  if (tags.stdout.split("\0").some((entry) => entry.startsWith("S "))) {
    throw new Error(
      `${when}: this linked worktree has skip-worktree entries, an unsupported ` +
        `layout beam cannot ship faithfully — clear them (git ls-files -t | ` +
        `grep '^S '; git update-index --no-skip-worktree <paths>) and retry`,
    );
  }
}

/**
 * Both directions assume the default files ref backend: the ship
 * materializes and snapshots refs by reading the files layout, and the
 * return's stability fingerprint and shipped-ref verification parse raw
 * ref files in quarantine. Any other backend (reftable) would make shipped
 * refs unreadable or look deleted, so both directions refuse it before any
 * side effect: a ship that could never come home safely must not leave.
 */
async function assertFilesRefStorage(localCwd: string, when: string): Promise<void> {
  const storage = await runGit(["git", "-C", localCwd, "config", "--get", "extensions.refstorage"]);
  const value = storage.stdout.trim();
  if (storage.code === 0 && value !== "" && value !== "files") {
    throw new Error(
      `${when}: this repository uses non-default ref storage (extensions.refstorage=${value}) — ` +
        `only the files ref storage backend is supported`,
    );
  }
}

/**
 * Exact HEAD state of a worktree: attached (born), unborn (attached, no
 * commit yet), or detached.
 */
interface HeadState {
  kind: "attached" | "unborn" | "detached";
  /** Symref target (attached/unborn). */
  ref?: string;
  /** HEAD commit (attached/detached). */
  commit?: string;
}

async function headState(
  localCwd: string,
  when: string,
  gitArgv: string[] = ["git", "-C", localCwd],
): Promise<HeadState> {
  const sym = await runGit([...gitArgv, "symbolic-ref", "--quiet", "HEAD"]);
  const sha = await runGit([...gitArgv, "rev-parse", "--verify", "--quiet", "HEAD"]);
  const ref = sym.code === 0 ? sym.stdout.trim() : undefined;
  const commit = sha.code === 0 ? sha.stdout.trim() : undefined;
  if (ref !== undefined) {
    if (commit !== undefined) return { kind: "attached", ref, commit };
    return { kind: "unborn", ref };
  }
  if (commit !== undefined) return { kind: "detached", commit };
  throw new Error(`${when}: ${localCwd} has neither a symbolic nor a resolvable HEAD`);
}

/**
 * Compare-and-swap descriptor of a HEAD state: the symref target AND its
 * current position for an attached HEAD (a commit on the ridden branch is
 * concurrent local work), the symref target alone while unborn, and the
 * commit for a detached HEAD (reachable only through HEAD, so any move is
 * concurrent local work).
 */
function headStateDescriptor(h: HeadState): string {
  if (h.kind === "detached") return `detached ${h.commit}`;
  if (h.kind === "unborn") return `unborn ${h.ref}`;
  return `attached ${h.ref} ${h.commit}`;
}

/**
 * Files/dirs in the worktree-level git dir whose presence means "a git
 * operation is in progress here": merge, single-commit cherry-pick/revert,
 * the multi-commit sequencer (which outlives CHERRY_PICK_HEAD/REVERT_HEAD
 * between steps), bisect, and both rebase backends.
 */
const OP_STATE_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
];

/**
 * An in-progress operation cannot make the round trip from HERE: the up's
 * materialized clone drops op state, handing the remote a checkout that
 * looks clean but silently left the merge/rebase behind; the down's import
 * would clobber the local operation with the remote's. Both directions
 * refuse before any side effect.
 */
async function assertNoOperationInProgress(localCwd: string, when: string): Promise<void> {
  for (const marker of OP_STATE_MARKERS) {
    if (existsSync(await gitPath(localCwd, marker))) {
      throw new Error(
        `${when}: the local worktree has an in-progress git operation (${marker}) — ` +
          `finish or abort it locally, then retry ${when}`,
      );
    }
  }
}
/** History-boundary files can make fsck bless commits whose parents are absent. */
async function assertNoHistoryBoundary(localCwd: string, when: string): Promise<void> {
  const shallow = await gitPath(localCwd, "shallow");
  const commonDir = resolve(
    localCwd,
    (await runGitChecked(["git", "-C", localCwd, "rev-parse", "--git-common-dir"])).stdout.trim(),
  );
  for (const path of [shallow, join(commonDir, "info", "grafts")]) {
    if (existsSync(path)) {
      throw new Error(
        `${when}: Git history boundary ${path} is unsupported — ` +
          `refusing a handoff that may omit parent objects`,
      );
    }
  }
}

async function portableGitSemantic(
  localCwd: string,
): Promise<{
  semantic: string;
  index: { tree: string | undefined; digest: string };
  configRaw: string;
}> {
  const refs = (await listRefsWith(["git", "-C", localCwd], []))
    .filter((r) => isShippableSharedRef(r.ref))
    .map((r) => [r.ref, r.sha, r.symrefTarget]);
  const stashLogPath = await gitPath(localCwd, "logs/refs/stash");
  const stashLog = existsSync(stashLogPath) ? readFileSync(stashLogPath) : Buffer.alloc(0);
  const configRaw = (
    await runGitChecked(["git", "-C", localCwd, "config", "--local", "--null", "--list"])
  ).stdout;
  const index = await indexContent(localCwd);
  return {
    semantic: JSON.stringify({
      head: headStateDescriptor(await headState(localCwd, "beam up")),
      indexTree: index.tree,
      indexEntries: await indexSemanticDigest(localCwd),
      refs,
      stashLog: contentDigest(stashLog),
      config: outboundConfig(parseNulConfig(configRaw)),
    }),
    index,
    configRaw,
  };
}

interface SourceGitFingerprint {
  value: string;
  /** Portable semantic state the completed payload must reproduce. */
  semantic: string;
  commonDirId: GitDirIdentity;
  worktreeGitDirId: GitDirIdentity;
}

async function sourceGitFingerprint(
  localCwd: string,
  commonDir: string,
  worktreeGitDir: string,
): Promise<SourceGitFingerprint> {
  await assertNoSparseLayout(localCwd, "beam up");
  await assertNoOperationInProgress(localCwd, "beam up");
  await assertFilesRefStorage(localCwd, "beam up");
  await assertNoHistoryBoundary(localCwd, "beam up");
  const currentCommonDir = resolve(
    localCwd,
    (await runGitChecked(["git", "-C", localCwd, "rev-parse", "--git-common-dir"])).stdout.trim(),
  );
  const currentWorktreeGitDir = resolve(
    localCwd,
    (await runGitChecked(["git", "-C", localCwd, "rev-parse", "--absolute-git-dir"])).stdout.trim(),
  );
  const commonMoved = safeRealpath(currentCommonDir) !== safeRealpath(commonDir);
  const worktreeMoved = safeRealpath(currentWorktreeGitDir) !== safeRealpath(worktreeGitDir);
  if (commonMoved || worktreeMoved) {
    throw new Error(
      "beam up: the source repository layout changed while Beam prepared the Git handoff",
    );
  }
  const state = await portableGitSemantic(localCwd);
  const { semantic, index, configRaw } = state;
  const commonDirId = dirIdentity(currentCommonDir);
  const worktreeGitDirId = dirIdentity(currentWorktreeGitDir);
  return {
    semantic,
    value: JSON.stringify({
      semantic,
      indexDigest: index.digest,
      config: contentDigest(configRaw),
      commonDir: safeRealpath(currentCommonDir),
      worktreeGitDir: safeRealpath(currentWorktreeGitDir),
      commonDirId,
      worktreeGitDirId,
      commonDirToken: readGitIdentityToken(commonDir, REPOSITORY_ID_FILE),
      worktreeGitDirToken: readGitIdentityToken(worktreeGitDir, WORKTREE_ID_FILE),
    }),
    commonDirId,
    worktreeGitDirId,
  };
}

/**
 * Test-only seam: invoked after the payload is fully built, immediately
 * before its completeness fsck — lets a regression model the clone racing
 * a source gc/repack by tampering with the finished payload. Never set in
 * production code.
 */
export const materializeTestSeam: {
  afterPayloadBuilt?: (gitDir: string) => void | Promise<void>;
} = {};

/**
 * Build the standalone `.git` payload for any Git worktree. Fatal on any
 * inconsistency; the temp state is removed on failure and via `cleanup()`
 * on success. Runs before any remote side effect, so an unshippable layout
 * never half-ships.
 */
export async function materializeWorktreeGit(localCwd: string): Promise<MaterializedWorktreeGit> {
  await assertNoSparseLayout(localCwd, "beam up");
  await assertNoOperationInProgress(localCwd, "beam up");
  await assertFilesRefStorage(localCwd, "beam up");
  await assertNoHistoryBoundary(localCwd, "beam up");
  const liveIndex = await gitPath(localCwd, "index");
  if (existsSync(liveIndex) && (await indexContent(localCwd, liveIndex)).tree === undefined) {
    throw new Error(
      "beam up: the Git index has unmerged entries without a supported operation state — " +
        "resolve or reset them before handoff",
    );
  }
  const tempRoot = mkdtempSync(join(tmpdir(), "beam-wtgit-"));
  const cleanup = () => rmSync(tempRoot, { recursive: true, force: true });
  try {
    const repoDir = join(tempRoot, "repo");
    const gitDir = join(repoDir, ".git");
    const source = await materializeSourceSnapshot(localCwd);
    const { commonDir, worktreeGitDir, head, fingerprintBefore } = source;
    const { sourceRefs, shippedStash, stashLogRaw, sourceConfig } = source;
    await materializeClonePayload({ localCwd, tempRoot, repoDir, gitDir });
    await materializeMirrorRefs({ repoDir, sourceRefs, shippedStash, head });
    await materializeShipIndex({ localCwd, repoDir, gitDir, head });
    await materializeInstallConfig({ repoDir, gitDir, commonDir, sourceConfig });
    const shippedRefsContent = await materializeSealPayload(
      { gitDir, sourceRefs, shippedStash, stashLogRaw },
    );
    await materializeProvePayloadComplete({ repoDir, gitDir, sourceRefs });
    const assertSourceUnchanged = (): Promise<void> =>
      materializeAssertSourceUnchanged(
        { localCwd, repoDir, commonDir, worktreeGitDir, fingerprintBefore },
      );
    await assertSourceUnchanged();
    const shipInfo: WtGitShipInfo = {
      head: head.commit,
      branch: head.ref,
      commonDir,
      worktreeGitDir,
      commonDirId: fingerprintBefore.commonDirId,
      worktreeGitDirId: fingerprintBefore.worktreeGitDirId,
      commonDirToken: source.commonDirToken,
      worktreeGitDirToken: source.worktreeGitDirToken,
      shippedRefsDigest: contentDigest(shippedRefsContent),
      shippedStashLogDigest: contentDigest(stashLogRaw ?? Buffer.alloc(0)),
      generation: randomBytes(8).toString("hex"),
    };
    return { gitDir, shipInfo, assertSourceUnchanged, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** One coherent ship-time snapshot of the source repository, taken before any payload work. */
interface MaterializeSourceSnapshot {
  commonDir: string;
  worktreeGitDir: string;
  commonDirToken: string;
  worktreeGitDirToken: string;
  fingerprintBefore: SourceGitFingerprint;
  head: HeadState;
  sourceRefs: SourceRef[];
  stashLogRaw: Buffer | undefined;
  shippedStash: string[];
  sourceConfig: Array<[key: string, value: string]>;
}

/**
 * Snapshot the source identity first — every later phase reproduces it.
 * An unborn HEAD (fresh `git init`: a symbolic HEAD with no commit yet)
 * is a shippable state: the payload carries the symbolic HEAD and an
 * explicitly empty index, and the staged patch diffs against the empty
 * tree.
 */
async function materializeSourceSnapshot(localCwd: string): Promise<MaterializeSourceSnapshot> {
  const commonDir = resolve(
    localCwd,
    (await runGitChecked(["git", "-C", localCwd, "rev-parse", "--git-common-dir"])).stdout.trim(),
  );
  // The true per-worktree git dir, plus two independent identity proofs:
  // device+inode catches moves while the original still exists; a
  // create-only random marker catches delete/recreate even if the
  // filesystem recycles the same inode.
  const worktreeGitDir = resolve(
    localCwd,
    (await runGitChecked(["git", "-C", localCwd, "rev-parse", "--absolute-git-dir"])).stdout.trim(),
  );
  const commonDirToken = ensureGitIdentityToken(commonDir, REPOSITORY_ID_FILE);
  const worktreeGitDirToken = ensureGitIdentityToken(worktreeGitDir, WORKTREE_ID_FILE);
  const fingerprintBefore = await sourceGitFingerprint(localCwd, commonDir, worktreeGitDir);
  const head = await headState(localCwd, "beam up");
  // EVERY trusted shared ref of the source — branches, tags,
  // remote-tracking, refs/replace, refs/notes, custom namespaces, the
  // stash — so remote Git semantics (replacements, notes, stash) match
  // local ones. Only beam's own bookkeeping and worktree-scoped internals
  // stay home.
  const sourceRefs = (await listRefsWith(["git", "-C", localCwd], [])).filter((r) =>
    isShippableSharedRef(r.ref),
  );
  // The stash is REFLOG-backed: refs/stash names only the top entry; the
  // stack, its order, and its messages live in the shared reflog. Snapshot
  // both now so the payload can reproduce full stash semantics and the
  // snapshot can pin the whole shipped stack.
  const stashTip = sourceRefs.find((r) => r.ref === "refs/stash" && !r.symrefTarget)?.sha;
  const stashLogPath = await gitPath(localCwd, "logs/refs/stash");
  const stashLogRaw =
    stashTip !== undefined && existsSync(stashLogPath) ? readFileSync(stashLogPath) : undefined;
  const shippedStash = stashTip !== undefined ? stashStack(stashTip, stashLogRaw) : [];
  const sourceConfig = parseNulConfig(
    (await runGitChecked(["git", "-C", localCwd, "config", "--local", "--null", "--list"])).stdout,
  );
  return {
    commonDir,
    worktreeGitDir,
    commonDirToken,
    worktreeGitDirToken,
    fingerprintBefore,
    head,
    sourceRefs,
    stashLogRaw,
    shippedStash,
    sourceConfig,
  };
}

/**
 * Clone through the git machinery, which carries objects and refs only —
 * never the common dir's `worktrees/<sibling>/` checkout state, config,
 * or logs. `--no-hardlinks` keeps the payload self-contained;
 * `--no-checkout` skips the working tree (rsync ships the real one);
 * `--dissociate` absorbs any `objects/info/alternates` borrowing (a
 * common dir built with `clone --shared`/`--reference` would otherwise
 * hand the remote a dangling absolute alternate path instead of its
 * objects). Hooks are the one thing a clone DOES invent: the repository
 * template (ambient GIT_TEMPLATE_DIR — stripped by the sanitized env —
 * but equally `init.templateDir` in the caller's global/system config,
 * which beam deliberately leaves readable) copies executable hook files
 * into the fresh `.git`, and they would ride the payload and run in the
 * sandbox. Clone against a Beam-owned, verified-empty template so no
 * config can re-enable that channel, then fail closed if hook content
 * appears anyway. The clone's `origin` is the LOCAL source path: drop it
 * (with its tracking refs and branch config), then sweep any other
 * non-core key so only the clone's sane standalone core survives the
 * config overlay applied later.
 */
async function materializeClonePayload(opts: {
  localCwd: string;
  tempRoot: string;
  repoDir: string;
  gitDir: string;
}): Promise<void> {
  const { localCwd, tempRoot, repoDir, gitDir } = opts;
  const emptyTemplate = join(tempRoot, "template");
  mkdirSync(emptyTemplate);
  if (readdirSync(emptyTemplate).length !== 0) {
    throw new Error(
      "beam up: the Git payload template staging directory is not empty — " +
        "refusing to clone through it",
    );
  }
  await runGitChecked([
    "git",
    "clone",
    "--quiet",
    "--no-hardlinks",
    "--no-checkout",
    "--dissociate",
    `--template=${emptyTemplate}`,
    localCwd,
    repoDir,
  ]);
  const hooksDir = join(gitDir, "hooks");
  const payloadHooks = existsSync(hooksDir) ? readdirSync(hooksDir) : [];
  if (payloadHooks.length > 0) {
    throw new Error(
      `beam up: the Git payload unexpectedly contains hooks (${payloadHooks.join(", ")}) — ` +
        `refusing to ship executable hook content to the sandbox`,
    );
  }
  await runGitChecked(["git", "-C", repoDir, "remote", "remove", "origin"]);
  const cloneConfig = parseNulConfig(
    (await runGitChecked(["git", "-C", repoDir, "config", "--local", "--null", "--list"])).stdout,
  );
  const leftoverKeys = new Set(cloneConfig.map(([key]) => key));
  for (const key of leftoverKeys) {
    if (key.startsWith("core.") || key.startsWith("extensions.")) continue;
    await runGitChecked(["git", "-C", repoDir, "config", "--local", "--unset-all", key]);
  }
}

/**
 * Mirror every shared ref exactly (direct refs first, then symrefs so
 * their targets exist), pin baseline reachability, and set HEAD to
 * exactly the source worktree's — attached branch (born or unborn) or
 * detached SHA.
 */
async function materializeMirrorRefs(opts: {
  repoDir: string;
  sourceRefs: SourceRef[];
  shippedStash: string[];
  head: HeadState;
}): Promise<void> {
  const { repoDir, sourceRefs, shippedStash, head } = opts;
  for (const r of sourceRefs) {
    if (r.symrefTarget) continue;
    await runGitChecked(["git", "-C", repoDir, "update-ref", "--no-deref", r.ref, r.sha]);
  }
  for (const r of sourceRefs) {
    if (!r.symrefTarget) continue;
    await runGitChecked(["git", "-C", repoDir, "symbolic-ref", r.ref, r.symrefTarget]);
  }
  // Baseline reachability: the plaintext shipped-ref manifest is the diff
  // contract, while these Beam-private refs keep every shipped direct OID
  // (including older stash entries) alive if the sandbox deletes the user
  // ref, expires reflogs, and prunes before return.
  const shippedOids = [...new Set([
    ...sourceRefs.filter((r) => r.symrefTarget === undefined).map((r) => r.sha),
    ...shippedStash,
  ])].sort();
  for (let i = 0; i < shippedOids.length; i++) {
    await runGitChecked([
      "git",
      "-C",
      repoDir,
      "update-ref",
      "--no-deref",
      `refs/beam/shipped/${String(i).padStart(8, "0")}`,
      shippedOids[i]!,
    ]);
  }
  if (head.ref !== undefined) {
    await runGitChecked(["git", "-C", repoDir, "symbolic-ref", "HEAD", head.ref]);
  } else {
    await runGitChecked(["git", "-C", repoDir, "update-ref", "--no-deref", "HEAD", head.commit!]);
  }
}

/**
 * Ship the exact logical index, including intent-to-add, assume-unchanged,
 * REUC, and extended flags. Split-index shards are copied beside it and
 * collapsed in the temp repository; cache-only path-bearing extensions are
 * stripped there, never from the source.
 */
async function materializeShipIndex(opts: {
  localCwd: string;
  repoDir: string;
  gitDir: string;
  head: HeadState;
}): Promise<void> {
  const { localCwd, repoDir, gitDir, head } = opts;
  const sourceIndex = await gitPath(localCwd, "index");
  if (existsSync(sourceIndex)) {
    for (const f of readdirSync(dirname(sourceIndex))) {
      if (!f.startsWith("sharedindex.")) continue;
      copyFileSync(join(dirname(sourceIndex), f), join(gitDir, f));
    }
    copyFileSync(sourceIndex, join(gitDir, "index"));
    await runGitChecked(["git", "-C", repoDir, "update-index", "--no-split-index"]);
    await runGitChecked(["git", "-C", repoDir, "update-index", "--no-untracked-cache"]);
    await runGit(["git", "-C", repoDir, "update-index", "--no-fsmonitor"]);
    for (const f of readdirSync(gitDir)) {
      if (f.startsWith("sharedindex.")) rmSync(join(gitDir, f), { force: true });
    }
  } else {
    const seed = head.commit !== undefined ? "HEAD" : "--empty";
    await runGitChecked(["git", "-C", repoDir, "read-tree", seed]);
  }
}

/**
 * Restore portable repo config minus machine-layout keys. Local-path
 * remotes are also machine layout: they would be broken on the target and
 * leak the host directory. Values remain NUL-safe and multi-valued keys
 * are preserved via --add. Local ignores travel, and `.beam/` (the
 * shipped-session scratch dir) must never show up in remote `git status`.
 */
async function materializeInstallConfig(opts: {
  repoDir: string;
  gitDir: string;
  commonDir: string;
  sourceConfig: Array<[key: string, value: string]>;
}): Promise<void> {
  const { repoDir, gitDir, commonDir, sourceConfig } = opts;
  for (const [key, value] of outboundConfig(sourceConfig)) {
    await runGitChecked(["git", "-C", repoDir, "config", "--local", "--add", key, value]);
  }
  const sourceExclude = join(commonDir, "info", "exclude");
  let exclude = existsSync(sourceExclude) ? readFileSync(sourceExclude, "utf8") : "";
  if (!exclude.split("\n").some((l) => l.trim() === ".beam/")) {
    exclude += (exclude === "" || exclude.endsWith("\n") ? "" : "\n") + ".beam/\n";
  }
  mkdirSync(join(gitDir, "info"), { recursive: true });
  writeFileSync(join(gitDir, "info", "exclude"), exclude);
}

/**
 * Write the ship-time ref snapshot and stash log, erase local-path
 * metadata, and install the one traveling reflog. Returns the exact
 * snapshot content whose SHA-256 pin the ship record carries.
 */
async function materializeSealPayload(opts: {
  gitDir: string;
  sourceRefs: SourceRef[];
  shippedStash: string[];
  stashLogRaw: Buffer | undefined;
}): Promise<string> {
  const { gitDir, sourceRefs, shippedStash, stashLogRaw } = opts;
  // Ship-time ref snapshot: `beam down` verifies its local SHA-256 pin,
  // then diffs the remote's final refs against it. Only refs the REMOTE
  // changed may apply locally; an untouched mirror never resurrects a
  // local deletion. Every shared direct ref and symbolic ref is recorded;
  // deeper stash entries use `refs/stash@{n}` pseudo-names.
  const refLine = (r: SourceRef): string => {
    const target = r.symrefTarget !== undefined ? ` ${r.symrefTarget}` : "";
    return `${r.sha} ${r.ref}${target}\n`;
  };
  const shippedRefsContent =
    sourceRefs.map(refLine).join("") +
    shippedStash
      .slice(1)
      .map((sha, i) => `${sha} ${shippedStashName(i + 1)}\n`)
      .join("");
  writeFileSync(join(gitDir, SHIPPED_REFS_FILE), shippedRefsContent);
  writeFileSync(join(gitDir, SHIPPED_STASH_LOG_FILE), stashLogRaw ?? Buffer.alloc(0));
  // Last, after all ref surgery: erase metadata that embeds the local
  // source path (reflogs say "clone: from /local/path") or transient
  // fetch state. Then install the ONE reflog that must travel: the stash
  // reflog (verbatim — it carries branch names and commit subjects, never
  // local paths), so `git stash list/apply/pop stash@{n}` behave on the
  // target exactly as they would here.
  rmSync(join(gitDir, "logs"), { recursive: true, force: true });
  rmSync(join(gitDir, "FETCH_HEAD"), { force: true });
  if (stashLogRaw !== undefined) {
    mkdirSync(join(gitDir, "logs", "refs"), { recursive: true });
    writeFileSync(join(gitDir, "logs", "refs", "stash"), stashLogRaw);
  }
  return shippedRefsContent;
}

/**
 * Prove the payload's completeness on its OWN objects alone — full
 * connectivity from every ref, the private shipped/stash pins, the
 * installed stash reflog, and the index — before anything ships. The
 * clone copies the source object store while the source may be gc'ing or
 * repacking concurrently: a torn copy can lose objects while every final
 * semantic fingerprint (refs, HEAD, index, config) still matches.
 * Failure aborts the up with zero remote side effects.
 *
 * git's fsck reports every dangling loose symref as a fatal ref error
 * ("invalid sha1 pointer 0000…") while iterating refs. Dangling symbolic
 * refs are legitimate shippable state — the payload carries them by NAME
 * and they contribute no objects to connectivity — and the mirror phase
 * installed exactly the ones the source snapshot enumerated. So EXACTLY
 * those known ref errors are tolerated; any other fsck complaint (torn
 * objects, unexpected refs, stdout reports) stays fatal, in the same
 * `command failed` shape a checked subprocess would raise.
 */
async function materializeProvePayloadComplete(opts: {
  repoDir: string;
  gitDir: string;
  sourceRefs: SourceRef[];
}): Promise<void> {
  const { repoDir, gitDir, sourceRefs } = opts;
  await materializeTestSeam.afterPayloadBuilt?.(gitDir);
  const fsck = await runGit([
    "git",
    "--no-replace-objects",
    "-C",
    repoDir,
    "fsck",
    "--full",
    "--cache",
    "--no-dangling",
  ]);
  if (fsck.code === 0) return;
  const danglingSymrefs = new Set(
    sourceRefs
      .filter((r) => r.symrefTarget !== undefined && /^0+$/.test(r.sha))
      .map((r) => r.ref),
  );
  const expectedDanglingError = (line: string): boolean => {
    const match = /^error: (.+): invalid (?:sha1|sha256) pointer 0+$/.exec(line);
    if (match?.[1] === undefined) return false;
    return danglingSymrefs.has(match[1]);
  };
  const stderrLines = fsck.stderr.split("\n").filter((line) => line !== "");
  const tolerable =
    stderrLines.length > 0 &&
    stderrLines.every(expectedDanglingError) &&
    fsck.stdout.trim() === "";
  if (!tolerable) {
    const detail = (fsck.stderr || fsck.stdout).trim();
    throw new Error(`command failed (${fsck.code}): git${detail ? `\n${detail}` : ""}`);
  }
}

/**
 * Fail closed unless the source and the completed payload still match the
 * one coherent snapshot taken when the handoff was materialized.
 */
async function materializeAssertSourceUnchanged(opts: {
  localCwd: string;
  repoDir: string;
  commonDir: string;
  worktreeGitDir: string;
  fingerprintBefore: SourceGitFingerprint;
}): Promise<void> {
  const { localCwd, repoDir, commonDir, worktreeGitDir, fingerprintBefore } = opts;
  const [current, payload] = await Promise.all([
    sourceGitFingerprint(localCwd, commonDir, worktreeGitDir),
    portableGitSemantic(repoDir),
  ]);
  if (current.value !== fingerprintBefore.value) {
    throw new Error(
      `beam up: the local Git HEAD, index, refs, config, operation state, ` +
        `layout, or repository identity changed since Beam materialized the ` +
        `handoff — refusing to ship a torn Git snapshot; retry beam up`,
    );
  }
  if (payload.semantic !== fingerprintBefore.semantic) {
    throw new Error(
      `beam up: the completed Git payload does not match the source snapshot — ` +
        `refusing to ship a mixed or torn repository`,
    );
  }
}

/*
 * ------------------------------------------------------------------------
 * Return path (beam down)
 * ------------------------------------------------------------------------
 */

/**
 * Operation-state files that live in the worktree-level git dir and carry an
 * in-progress merge/cherry-pick/revert/bisect across the round trip.
 */
const OP_STATE_FILES = [
  "MERGE_HEAD",
  "MERGE_AUTOSTASH",
  "MERGE_MSG",
  "MERGE_MODE",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "ORIG_HEAD",
  "AUTO_MERGE",
  "REBASE_HEAD",
  "SQUASH_MSG",
  "BISECT_HEAD",
  "BISECT_LOG",
  "BISECT_START",
  "BISECT_EXPECTED_REV",
  "BISECT_NAMES",
  "BISECT_TERMS",
  "BISECT_RUN",
  "BISECT_FIRST_PARENT",
  "BISECT_ANCESTORS_OK",
];

/** Operation-state directories (rebase and multi-commit sequencer state). */
const OP_STATE_DIRS = ["rebase-merge", "rebase-apply", "sequencer"];

/**
 * Exact content of an index file: tree for diagnostics/recovery, plus the
 * SHA-256 of its bytes. The byte digest is the authorization boundary:
 * intent-to-add, assume-unchanged, REUC, and extension state can differ
 * while `write-tree` and `ls-files --stage` remain identical.
 */
async function indexContent(
  localCwd: string,
  indexFile?: string,
  gitArgv: string[] = ["git", "-C", localCwd],
): Promise<{ tree: string | undefined; digest: string }> {
  const resolvedIndex = indexFile ?? (await gitPath(localCwd, "index"));
  const env = { GIT_INDEX_FILE: resolvedIndex };
  const tree = await runGit([...gitArgv, "write-tree"], { env });
  const bytes = existsSync(resolvedIndex) ? readFileSync(resolvedIndex) : new Uint8Array();
  return { tree: tree.code === 0 ? tree.stdout.trim() : undefined, digest: contentDigest(bytes) };
}

/**
 * Canonical observable index entries and user-controlled flags. Cache
 * refreshes may rewrite stat and fsmonitor-valid bits without changing Git
 * state, so neither belongs in this retry authorization view.
 */
async function indexSemanticDigest(
  localCwd: string,
  indexFile?: string,
  gitArgv: string[] = ["git", "-C", localCwd],
): Promise<string> {
  const resolvedIndex = indexFile ?? (await gitPath(localCwd, "index"));
  const env = { GIT_INDEX_FILE: resolvedIndex };
  const emptyTree = (
    await runGitChecked([...gitArgv, "hash-object", "-t", "tree", "--stdin"], { stdinText: "" })
  ).stdout.trim();
  const commands = [
    ["ls-files", "--stage", "-z"],
    ["ls-files", "-v", "-z"],
    ["ls-files", "--resolve-undo", "-z"],
    // CE_INTENT_TO_ADD is invisible in every ls-files view above. Against
    // the empty tree this raw diff is HEAD-independent and lists every
    // ordinary entry while omitting intent-to-add entries.
    [
      "diff",
      "--cached",
      "--raw",
      "-z",
      "--no-ext-diff",
      "--ita-invisible-in-index",
      emptyTree,
    ],
  ];
  const outputs: string[] = [];
  for (const args of commands) {
    outputs.push((await runGitChecked([...gitArgv, ...args], { env })).stdout);
  }
  return contentDigest(outputs.join("\0beam-index-view\0"));
}

/** Tree that keeps every non-empty index stage object reachable, including conflicted indexes. */
async function indexEntryObjectsTree(
  gitArgv: string[],
  indexFile: string,
): Promise<string | undefined> {
  const listed = await runGitChecked([...gitArgv, "ls-files", "--stage", "-z"], {
    env: { GIT_INDEX_FILE: indexFile },
  });
  const entries: string[] = [];
  let n = 0;
  for (const entryLine of listed.stdout.split("\0")) {
    if (entryLine === "") continue;
    const match = /^([0-7]{6}) ([0-9a-f]{40,64}) [0-3]\t/.exec(entryLine);
    if (!match?.[1] || !match[2] || /^0+$/.test(match[2])) continue;
    const type = match[1] === "160000" ? "commit" : "blob";
    entries.push(`${match[1]} ${type} ${match[2]}\tentry-${String(n).padStart(8, "0")}\n`);
    n++;
  }
  if (entries.length === 0) return undefined;
  return (
    await runGitChecked([...gitArgv, "mktree"], {
      stdinText: entries.join(""),
    })
  ).stdout.trim();
}
/**
 * Prove this is still the very repository that shipped. Runs before the
 * collection and again before the apply phase binds to it.
 *
 * The record's ship-time identity (paths plus device+inode of the common
 * AND worktree git dirs, pinned by create-only random tokens) must match. A
 * record without an identity (older beam) and a repository re-created at
 * the same path both refuse — importing into an unverified repository is
 * the exact failure this guard exists for. Local checkout state is not
 * examined: the return is quarantine-only and never contends with it.
 */
async function assertWorktreeIdentity(
  localCwd: string,
  shipInfo: WtGitShipInfo | undefined,
): Promise<void> {
  if (!isGitWorktree(localCwd)) {
    throw new Error(
      `beam down: ${localCwd} is no longer the Git worktree this handoff shipped — ` +
        `restore the checkout, or abandon the handoff with beam kill --purge`,
    );
  }
  // The ship-time identity is the proof this is still the same repository.
  // A record without one cannot be verified, so it refuses — never assumes.
  if (
    !shipInfo?.worktreeGitDir ||
    !shipInfo.commonDirId ||
    !shipInfo.worktreeGitDirId ||
    !shipInfo.commonDirToken ||
    !shipInfo.worktreeGitDirToken
  ) {
    throw new Error(
      `beam down: this handoff record carries no ship-time repository identity for ${localCwd} ` +
        `(it was shipped by an older beam) — cannot prove the checkout is still ` +
        `the repository that shipped; refusing to import remote git state`,
    );
  }
  const commonDir = resolve(
    localCwd,
    (await runGitChecked(["git", "-C", localCwd, "rev-parse", "--git-common-dir"])).stdout.trim(),
  );
  if (safeRealpath(shipInfo.commonDir) !== safeRealpath(commonDir)) {
    throw new Error(
      `beam down: this worktree's common git dir changed since the ship ` +
        `(${shipInfo.commonDir} -> ${commonDir}) — refusing to import remote ` +
        `git state into a different repository`,
    );
  }
  const worktreeGitDir = resolve(
    localCwd,
    (await runGitChecked(["git", "-C", localCwd, "rev-parse", "--absolute-git-dir"])).stdout.trim(),
  );
  // Same path and even the same recycled inode do not prove identity. Pin
  // both git dirs by device+inode AND by create-only random local markers.
  assertWorktreeIdentityPins(localCwd, [
    {
      what: "common git dir",
      dir: commonDir,
      shippedId: shipInfo.commonDirId,
      marker: REPOSITORY_ID_FILE,
      shippedToken: shipInfo.commonDirToken,
    },
    {
      what: "worktree git dir",
      dir: worktreeGitDir,
      shippedId: shipInfo.worktreeGitDirId,
      marker: WORKTREE_ID_FILE,
      shippedToken: shipInfo.worktreeGitDirToken,
    },
  ]);
  await assertNoSparseLayout(localCwd, "beam down");
  await assertFilesRefStorage(localCwd, "beam down");
}

/** One ship-time directory pin: device+inode plus its create-only marker token. */
interface WorktreeIdentityPin {
  what: string;
  dir: string;
  shippedId: GitDirIdentity;
  marker: string;
  shippedToken: string;
}

function assertWorktreeIdentityPins(localCwd: string, pins: WorktreeIdentityPin[]): void {
  for (const { what, dir, shippedId, marker, shippedToken } of pins) {
    const now = dirIdentity(dir);
    if (
      now.dev !== shippedId.dev ||
      now.ino !== shippedId.ino ||
      readGitIdentityToken(dir, marker) !== shippedToken
    ) {
      throw new Error(
        `beam down: the ${what} of ${localCwd} (${dir}) is not the directory ` +
          `this handoff shipped from — it was replaced since the ship; ` +
          `refusing to import remote git state into a different repository`,
      );
    }
  }
}
export async function prepareWorktreeGitReturn(
  localCwd: string,
  _recordId: string,
  shipInfo: WtGitShipInfo | undefined,
): Promise<void> {
  // The automatic return never mutates the local checkout, so there is no
  // pre-return snapshot to take and nothing to lock: the only preparation
  // is proving this is still the very repository that shipped. Local
  // commits, checkouts, and staging between downs are the user's business
  // and never refuse a retained record's return.
  await assertWorktreeIdentity(localCwd, shipInfo);
}

/** What the return did, for the command's summary output. */
export interface WorktreeGitReturn {
  /**
   * The exact per-collection namespace this down wrote:
   * refs/beam/return/<key>/<collected-fingerprint>.
   */
  qbase: string;
  /**
   * Refs whose remote values are preserved under the collection namespace —
   * never applied locally.
   */
  quarantined: string[];
  /** Human-facing notes: conflicts, stash hints, restored operation state. */
  notes: string[];
}


/**
 * Publish `source` at `destination` create-only, safe under CONCURRENT
 * imports into a shared object store (sibling records of one common
 * repository): each attempt copies into its own unique create-only
 * same-directory temp, fsyncs it, verifies it byte-matches the source,
 * and publishes with link(2) — first writer wins, whole files only. A
 * raced destination is validated against the source digest and NEVER
 * rename-overwritten: identical content is the content-addressed winner
 * (converge silently); different content refuses with the destination
 * byte-for-byte intact.
 */
function atomicCopy(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  const tmp = `${destination}.beam-tmp-${randomBytes(8).toString("hex")}`;
  try {
    copyFileSync(source, tmp, fsConstants.COPYFILE_EXCL);
    // Read-only open: the copy preserves the source mode, and loose git
    // objects are 0444 — fsync needs a descriptor, not write permission.
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const sourceDigest = fileSha256(source);
    if (fileSha256(tmp) !== sourceDigest) {
      throw new Error(
        `beam down: the staged copy of ${source} does not match its source ` +
          `— refusing to publish it`,
      );
    }
    try {
      linkSync(tmp, destination);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Raced: another import published this name first. Content-addressed
      // convergence — an identical winner is this import's own outcome; any
      // other bytes stay untouched and fail the import closed.
      if (fileSha256(destination) !== sourceDigest) {
        throw new Error(
          `beam down: ${destination} already exists with different content — refusing to ` +
            `overwrite it; verify the repository (git fsck), remove or repair the entry, ` +
            `then retry beam down`,
        );
      }
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Test-only interposition: runs after each destination existence check, before its publication. */
export const importObjectsTestSeam: { beforePublish?: (destination: string) => void } = {};

/**
 * Copy the collected object store into the local common repository.
 * Content-addressed and purely additive: existing objects are never touched,
 * every file is copied to a unique create-only temp, digest-verified, and
 * published with link(2) (first concurrent writer wins; a diverged
 * destination refuses untouched), and `.pack` files land before
 * their `.idx` so a crash can never leave an index naming an absent pack.
 * This carries EVERY remote-created object — including staged-only blobs
 * and commits no ref points at anymore — not just the ref-reachable
 * closure a fetch would transfer. `objects/info` (alternates, cached
 * graphs) is deliberately skipped: the collection must arrive
 * self-contained, and fsck enforces that before this runs.
 */
export function importObjects(collectedGit: string, commonDir: string): void {
  const source = join(collectedGit, "objects");
  const destination = join(commonDir, "objects");
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f]{2}$/.test(entry.name)) continue;
    for (const f of readdirSync(join(source, entry.name))) {
      const to = join(destination, entry.name, f);
      if (existsSync(to)) continue;
      importObjectsTestSeam.beforePublish?.(to);
      atomicCopy(join(source, entry.name, f), to);
    }
  }
  const packDir = join(source, "pack");
  if (!existsSync(packDir)) return;
  const packs = readdirSync(packDir);
  for (const ext of [".pack", ".rev", ".idx"]) {
    for (const f of packs) {
      if (!f.endsWith(ext)) continue;
      const to = join(destination, "pack", f);
      if (existsSync(to)) continue;
      importObjectsTestSeam.beforePublish?.(to);
      atomicCopy(join(packDir, f), to);
    }
  }
}

/** A return mutation transaction bound to the PROVEN git directories by inode. */
interface BoundReturnRepo {
  /**
   * argv prefix addressing the repository through the bound WORKTREE cwd.
   * Valid only in the worktree phase.
   */
  git: string[];
  /** Bound-cwd-relative path to the common git dir ("." for a standard checkout). */
  commonPrefix: string;
  /**
   * Run common-repository effects with the process cwd bound to the PROVEN
   * common dir inode: the transition traverses one hop and immediately
   * re-proves device+inode plus the create-only token THROUGH the new cwd
   * before `fn` runs, so a worktree git dir re-parented after binding can
   * never lend its new `..` to an effect. `common` addresses the common
   * repository as `--git-dir=.` (hooks and HEAD semantics of the real
   * repository). The worktree cwd is re-proven on the way back.
   */
  inCommon<T>(fn: (common: string[]) => Promise<T>): Promise<T>;
  /** Restore the process cwd; every relative path derived from this binding dies here. */
  restore(): void;
}

/**
 * Enter the worktree git dir and prove — THROUGH the binding, never through
 * pathnames — that it and the common dir are the ship-time directories:
 * device+inode plus create-only tokens, read via `.`-relative paths whose
 * resolution starts at the bound cwd inode. Every subsequent effect (git
 * subprocess via `--git-dir=.`, fs write via a relative path — children
 * inherit the parent's working directory by inode, never by name) follows
 * the validated directories wherever they are renamed; a same-path
 * replacement after this point can never receive a byte. Cross-directory
 * transitions (worktree ⇄ common) traverse one relative hop and re-prove
 * the destination identity through the new cwd BEFORE any effect, so a
 * re-parented held directory is refused, never silently followed.
 */
export async function bindReturnRepo(
  localCwd: string,
  shipInfo: WtGitShipInfo | undefined,
): Promise<BoundReturnRepo> {
  const identity = bindReturnRepoShipIdentity(localCwd, shipInfo);
  const worktreeGitDir = resolve(
    localCwd,
    (await runGitChecked(["git", "-C", localCwd, "rev-parse", "--absolute-git-dir"])).stdout.trim(),
  );
  const prevCwd = process.cwd();
  const proveWorktree = (): void =>
    proveBoundDirIdentity({
      what: "worktree git dir",
      path: ".",
      localCwd,
      shippedId: identity.worktreeGitDirId,
      marker: WORKTREE_ID_FILE,
      token: identity.worktreeGitDirToken,
    });
  const proveCommonAt = (path: string): void =>
    proveBoundDirIdentity({
      what: "common git dir",
      path,
      localCwd,
      shippedId: identity.commonDirId,
      marker: REPOSITORY_ID_FILE,
      token: identity.commonDirToken,
    });
  process.chdir(worktreeGitDir);
  try {
    proveWorktree();
    const commonPrefix = bindReturnRepoCommonPrefix(worktreeGitDir);
    // Prove the common dir through the traversal ONCE to learn the hop
    // back; every later transition re-proves both sides.
    proveCommonAt(commonPrefix);
    const commonAbsAtBind = resolve(process.cwd(), commonPrefix);
    const wtHop = commonPrefix === "." ? "." : relative(commonAbsAtBind, process.cwd());
    const phases = bindReturnRepoPhases({
      commonPrefix,
      wtHop,
      prevCwd,
      proveWorktree,
      proveCommon: () => proveCommonAt("."),
    });
    return {
      git: ["git", "--git-dir", ".", "--work-tree", localCwd],
      commonPrefix,
      inCommon: phases.inCommon,
      restore: phases.restore,
    };
  } catch (err) {
    process.chdir(prevCwd);
    throw err;
  }
}

/** The four ship-time identity facts a bound return needs; legacy records refuse. */
interface BindReturnShipIdentity {
  commonDirId: GitDirIdentity;
  worktreeGitDirId: GitDirIdentity;
  commonDirToken: string;
  worktreeGitDirToken: string;
}

function bindReturnRepoShipIdentity(
  localCwd: string,
  shipInfo: WtGitShipInfo | undefined,
): BindReturnShipIdentity {
  if (
    !shipInfo?.commonDirId ||
    !shipInfo.worktreeGitDirId ||
    !shipInfo.commonDirToken ||
    !shipInfo.worktreeGitDirToken
  ) {
    throw new Error(
      `beam down: this handoff record carries no ship-time repository identity for ${localCwd}`,
    );
  }
  return {
    commonDirId: shipInfo.commonDirId,
    worktreeGitDirId: shipInfo.worktreeGitDirId,
    commonDirToken: shipInfo.commonDirToken,
    worktreeGitDirToken: shipInfo.worktreeGitDirToken,
  };
}

/**
 * Prove that one directory of the bound return is a ship-time git
 * directory: device and inode plus the create-only token, read via a
 * cwd-relative path whose resolution starts at the bound cwd inode.
 */
function proveBoundDirIdentity(opts: {
  what: string;
  path: string;
  localCwd: string;
  shippedId: GitDirIdentity;
  marker: string;
  token: string;
}): void {
  const now = dirIdentity(opts.path);
  if (
    now.dev !== opts.shippedId.dev ||
    now.ino !== opts.shippedId.ino ||
    readGitIdentityToken(opts.path, opts.marker) !== opts.token
  ) {
    throw new Error(
      `beam down: the ${opts.what} of ${opts.localCwd} is not the directory ` +
        `this handoff shipped from — it was replaced or moved since the ship; ` +
        `refusing to touch git state through an unproven directory`,
    );
  }
}

/**
 * Read the bound worktree's `commondir` hop ("." for a standard checkout).
 * Runs with the process cwd bound to the worktree git dir. git re-resolves
 * an absolute commondir by PATH on every call — that can never be
 * inode-bound. Standard `git worktree` layouts record a relative commondir;
 * anything else fails closed.
 */
function bindReturnRepoCommonPrefix(worktreeGitDir: string): string {
  if (!existsSync("commondir")) return ".";
  const commonPrefix = readFileSync("commondir", "utf8").trim();
  if (isAbsolute(commonPrefix)) {
    throw new Error(
      `beam down: ${worktreeGitDir}/commondir records an absolute path — beam ` +
        `cannot bind the common repository by identity; re-create the linked ` +
        `worktree with git worktree add, then retry beam down`,
    );
  }
  return commonPrefix;
}

/**
 * The worktree ⇄ common transition machine of one bound return: each
 * transition traverses one relative hop and re-proves the destination
 * identity through the new cwd BEFORE any effect, and the worktree cwd is
 * re-proven on the way back. A failed proof restores the caller's original
 * cwd and rethrows.
 */
function bindReturnRepoPhases(opts: {
  commonPrefix: string;
  wtHop: string;
  prevCwd: string;
  proveWorktree: () => void;
  proveCommon: () => void;
}): Pick<BoundReturnRepo, "inCommon" | "restore"> {
  const { commonPrefix, wtHop, prevCwd, proveWorktree, proveCommon } = opts;
  let phase: "worktree" | "common" = "worktree";
  const inCommon = async <T>(fn: (common: string[]) => Promise<T>): Promise<T> => {
    if (phase !== "worktree") {
      throw new Error("beam down: nested common-phase transition — refusing");
    }
    if (commonPrefix !== ".") {
      process.chdir(commonPrefix);
      try {
        proveCommon();
      } catch (err) {
        process.chdir(prevCwd);
        throw err;
      }
    } else {
      proveCommon();
    }
    phase = "common";
    try {
      return await fn(["git", "--git-dir", "."]);
    } finally {
      if (commonPrefix !== ".") {
        process.chdir(wtHop);
      }
      try {
        proveWorktree();
      } catch (err) {
        process.chdir(prevCwd);
        throw err;
      }
      phase = "worktree";
    }
  };
  return { inCommon, restore: () => process.chdir(prevCwd) };
}

/**
 * Per-worktree git path resolved THROUGH the bound cwd: with `--git-dir=.`
 * rev-parse answers relative to the bound directory, so later resolution
 * follows its inode. A defensively-rebased absolute answer collapses onto
 * the bound cwd's current location.
 */
async function gitPathBound(localCwd: string, name: string): Promise<string> {
  const argv = ["git", "--git-dir", ".", "--work-tree", localCwd, "rev-parse", "--git-path", name];
  const out = (await runGitChecked(argv)).stdout.trim();
  return isAbsolute(out) ? relative(process.cwd(), out) : out;
}

interface ShippedRef {
  sha: string;
  symrefTarget: string | undefined;
}

/** Verify and parse the locally-pinned ship-time ref snapshot. */
function readShippedRefs(collectedGit: string, expectedDigest: string): Map<string, ShippedRef> {
  const file = join(collectedGit, SHIPPED_REFS_FILE);
  if (!existsSync(file)) {
    throw new Error(
      `beam down: the remote Git state no longer carries ${SHIPPED_REFS_FILE} — ` +
        `refusing to trust a ref base`,
    );
  }
  const content = readFileSync(file, "utf8");
  if (contentDigest(content) !== expectedDigest) {
    throw new Error(
      `beam down: the remote modified ${SHIPPED_REFS_FILE} — refusing to trust its ref baseline`,
    );
  }
  const shipped = new Map<string, ShippedRef>();
  for (const line of content.split("\n")) {
    if (line === "") continue;
    const m = /^([0-9a-f]{40,64}) ([^ ]+)(?: ([^ ]+))?$/.exec(line);
    if (!m?.[1] || !m[2] || shipped.has(m[2])) {
      throw new Error(`beam down: invalid entry in the pinned ${SHIPPED_REFS_FILE}: ${line}`);
    }
    shipped.set(m[2], { sha: m[1], symrefTarget: m[3] });
  }
  return shipped;
}

/**
 * Pin non-object metadata as a blob behind a durable quarantine ref.
 * Within one per-collection namespace the content is deterministic, so a
 * converging retry rewrites the identical blob; distinct collections land
 * in distinct namespaces and never overwrite each other.
 */
async function quarantineText(
  gitArgv: string[],
  ref: string,
  content: string | Uint8Array,
): Promise<void> {
  const blob = (
    await runGitChecked(
      [...gitArgv, "hash-object", "-w", "--stdin"],
      typeof content === "string" ? { stdinText: content } : { stdinBytes: content },
    )
  ).stdout.trim();
  await runGitChecked([...gitArgv, "update-ref", "--no-deref", ref, blob]);
}

/** Test-only capture point for the exact normalized index bytes pinned below. */
export const pinIncomingCheckoutTestSeam: { beforeHash?: (incomingIndex: string) => void } = {};

/**
 * Pin the complete incoming checkout as quarantine metadata. The state
 * commit keeps raw index bytes, its staged tree, every conflict-stage
 * object, and remote HEAD reachable after the sandbox is purged. A retry
 * chains the prior pin as a parent, so a newer collection cannot orphan an
 * earlier preserved index.
 */
async function pinIncomingCheckout(
  gitArgv: string[],
  stateRef: string,
  incomingIndex: string,
  index: { tree: string | undefined; digest: string },
  indexSemantic: string,
  remoteHeadSha: string | undefined,
): Promise<void> {
  pinIncomingCheckoutTestSeam.beforeHash?.(incomingIndex);
  const indexBlob = (
    await runGitChecked([...gitArgv, "hash-object", "-w", "--no-filters", incomingIndex])
  ).stdout.trim();
  const entriesTree = await indexEntryObjectsTree(gitArgv, incomingIndex);
  const treeLines = [`100644 blob ${indexBlob}\tindex\n`];
  if (index.tree !== undefined) treeLines.push(`040000 tree ${index.tree}\tstaged\n`);
  if (entriesTree !== undefined) treeLines.push(`040000 tree ${entriesTree}\tentries\n`);
  const metadataTree = (
    await runGitChecked([...gitArgv, "mktree"], { stdinText: treeLines.join("") })
  ).stdout.trim();
  const prior = await runGit([...gitArgv, "rev-parse", "--verify", "--quiet", stateRef]);
  const priorSha = prior.code === 0 ? prior.stdout.trim() : undefined;
  const parents = [
    ...new Set([priorSha, remoteHeadSha].filter((sha): sha is string => sha !== undefined)),
  ];
  const message =
    `beam incoming checkout\n\n` +
    `Beam-Incoming-Index-Blob: ${indexBlob}\n` +
    (index.tree !== undefined ? `Beam-Incoming-Index-Tree: ${index.tree}\n` : "") +
    `Beam-Incoming-Index-Digest: ${index.digest}\n` +
    `Beam-Incoming-Index-Semantic-Digest: ${indexSemantic}\n` +
    (remoteHeadSha !== undefined ? `Beam-Incoming-Head: ${remoteHeadSha}\n` : "");
  const commit = (
    await runGitChecked(
      [
        ...gitArgv,
        "-c",
        "commit.gpgsign=false",
        "commit-tree",
        metadataTree,
        ...parents.flatMap((sha) => ["-p", sha]),
        "-m",
        message,
      ],
      {
        env: {
          GIT_AUTHOR_NAME: "beam",
          GIT_AUTHOR_EMAIL: "beam@beam.invalid",
          GIT_COMMITTER_NAME: "beam",
          GIT_COMMITTER_EMAIL: "beam@beam.invalid",
          GIT_AUTHOR_DATE: "2005-04-07T22:13:13 +0000",
          GIT_COMMITTER_DATE: "2005-04-07T22:13:13 +0000",
        },
      },
    )
  ).stdout.trim();
  await runGitChecked([...gitArgv, "update-ref", "--no-deref", stateRef, commit, priorSha ?? ""]);
}

/**
 * Depth ceiling for the explicit collected-tree walks below. No plausible
 * repository nests this deep; beyond it the walk refuses fail-closed so the
 * bound stays visible instead of scanning without one.
 */
const MAX_COLLECTED_TREE_DEPTH = 4096;

/**
 * Validate a tree received from the sandbox without following any link.
 * Git metadata should contain only directories and regular files; links,
 * devices, sockets, and fifos have no valid return role and could redirect
 * a later local read outside the quarantine root.
 */
function assertInertGitTree(dir: string): void {
  // Explicit preorder walk (no recursion): each frame is one directory
  // being scanned; entering a subdirectory pushes a frame, so stack depth
  // equals directory depth and MAX_COLLECTED_TREE_DEPTH bounds it. Each
  // iteration consumes one child name or pops a frame, so the walk over a
  // finite tree terminates.
  const stack: Array<{ dir: string; names: string[]; next: number }> = [
    { dir, names: readdirSync(dir), next: 0 },
  ];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.next === top.names.length) {
      stack.pop();
      continue;
    }
    const entry = top.names[top.next]!;
    top.next += 1;
    const path = join(top.dir, entry);
    const st = lstatSync(path);
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) {
      throw new Error(
        `beam down: collected Git metadata contains an unsafe filesystem entry: ${path}`,
      );
    }
    if (st.isDirectory()) {
      if (stack.length === MAX_COLLECTED_TREE_DEPTH) {
        throw new Error(
          `beam down: collected Git metadata nests deeper than ` +
            `${MAX_COLLECTED_TREE_DEPTH} directories at ${path} — refusing`,
        );
      }
      stack.push({ dir: path, names: readdirSync(path), next: 0 });
    }
  }
}

/**
 * Repository-format extensions the return path understands. Everything the
 * import reads — loose refs, packed-refs, HEAD symrefs, the index — assumes
 * the files ref backend and the local object format; `worktreeConfig` only
 * governs `config.worktree`, which never survives quarantine. Any other
 * extension (reftable ref storage, partial-clone promisors, compat object
 * formats, future ones) changes what the collected bytes MEAN, so it fails
 * closed while the data is still inert and the remote intact.
 */
const SUPPORTED_COLLECTED_EXTENSIONS: Record<string, true> = {
  objectformat: true,
  refstorage: true,
  worktreeconfig: true,
};

/**
 * Validate the collected repository's format contract from its config BYTES
 * before that config is deleted — afterwards the evidence is gone and a
 * reftable or sha256 repository would be silently misread as an empty
 * files/sha1 one, turning every shipped ref into an apparent deletion.
 * `git config --file` with includes disabled never opens the collected
 * repository and executes nothing: the file is parsed as inert data with
 * Git's own config parser (no homegrown parser to disagree with it).
 * Layout signals are checked independently so a tampered or absent config
 * cannot hide a migrated ref database.
 */
async function assertSupportedCollectedRepoFormat(
  collected: string,
  localObjectFormat: string,
): Promise<void> {
  const refuse = (why: string): never => {
    throw new Error(
      `beam down: the collected Git repository ${why} — beam can only return the files ref ` +
        `backend with a full ${localObjectFormat} object store; refusing before any local ` +
        `change (the remote is intact)`,
    );
  };
  // Layout signals first: they hold even when the config lies or is gone.
  if (existsSync(join(collected, "reftable"))) {
    refuse(`carries a reftable ref database (${join(collected, "reftable")})`);
  }
  for (const name of ["refs", join("refs", "heads")]) {
    const path = join(collected, name);
    if (existsSync(path) && !lstatSync(path).isDirectory()) {
      refuse(
        `replaces "${name}" with a non-directory — the reftable-format stub of a migrated ` +
          `ref database`,
      );
    }
  }
  const configPath = join(collected, "config");
  const listArgv = ["git", "config", "--no-includes", "--file", configPath, "--null", "--list"];
  const entries = existsSync(configPath)
    ? parseNulConfig((await runGitChecked(listArgv)).stdout)
    : [];
  // Absent keys mean Git's defaults: format version 0, files refs, sha1.
  let objectFormat = "sha1";
  for (const [key, value] of entries) {
    if (key === "core.repositoryformatversion" && value.trim() !== "0" && value.trim() !== "1") {
      refuse(`declares an unsupported repository format version (${value.trim() || "<empty>"})`);
    }
    if (!key.startsWith("extensions.")) continue;
    const extension = key.slice("extensions.".length);
    if (SUPPORTED_COLLECTED_EXTENSIONS[extension] !== true) {
      refuse(`enables a repository extension beam cannot parse (${key})`);
    }
    if (extension === "refstorage" && value !== "files") {
      refuse(
        `uses "${value || "<empty>"}" ref storage (extensions.refStorage) instead of ` +
          `the files backend`,
      );
    }
    if (extension === "objectformat") {
      if (value !== "sha1" && value !== "sha256") {
        refuse(`declares an unknown object format (${value || "<empty>"})`);
      }
      objectFormat = value;
    }
  }
  if (objectFormat !== localObjectFormat) {
    refuse(`stores ${objectFormat} objects while the local repository stores ${localObjectFormat}`);
  }
}

/**
 * Refuse a collected index that hides paths: skip-worktree bits (sparse
 * checkout, `git update-index --skip-worktree`, sparse-index directory
 * entries) make Git treat those files as absent-but-unchanged, so installing
 * such an index locally would silently mask real files in the returned
 * checkout. Reads only quarantined data — the neutralized collected dir with
 * an explicit owned GIT_INDEX_FILE under the sanitized env — and runs before
 * `importObjects` or any local ref/index/HEAD/op-state effect.
 */
async function assertNoSparseCollectedIndex(collected: string, localCwd: string): Promise<void> {
  const collectedIndex = join(collected, "index");
  if (!existsSync(collectedIndex)) return;
  const listed = await runGitChecked(
    ["git", "--git-dir", collected, "--work-tree", localCwd, "ls-files", "-t", "-z"],
    { env: { GIT_INDEX_FILE: collectedIndex } },
  );
  for (const entry of listed.stdout.split("\0")) {
    if (entry === "") continue;
    const tag = entry.slice(0, 2);
    if (tag === "S ") {
      throw new Error(
        `beam down: the collected Git index marks "${entry.slice(2)}" skip-worktree ` +
          `(sparse checkout) — installing it would silently hide files in the returned ` +
          `checkout; sparse layouts do not round-trip (run \`git sparse-checkout disable\` ` +
          `or \`git update-index --no-skip-worktree\` on the target, then retry)`,
      );
    }
    if (tag !== "H " && tag !== "M ") {
      throw new Error(
        `beam down: the collected Git index contains an entry beam cannot classify ` +
          `(${JSON.stringify(entry)}) — refusing`,
      );
    }
  }
}

/**
 * Make the collected repository config-inert before any local Git process
 * opens it. Remote config is executable input (`core.fsmonitor` uses a
 * shell), while `commondir`, object alternates, and per-worktree metadata
 * (`worktrees/<name>/{gitdir,commondir}` and friends) can redirect reads to
 * host paths the moment a local git opens the collected dir. None are part
 * of the return contract. The repository FORMAT is validated from the inert
 * bytes first: replacing the config must never reinterpret a repository
 * whose refs or objects are stored in a layout the import cannot parse.
 */
async function neutralizeCollectedGitDir(collected: string, localCwd: string): Promise<void> {
  assertInertGitTree(collected);
  for (const path of [join(collected, "shallow"), join(collected, "info", "grafts")]) {
    if (existsSync(path)) {
      throw new Error(
        `beam down: collected Git metadata contains an unsupported history boundary: ${path}`,
      );
    }
  }
  const objectFormat = (
    await runGitChecked(["git", "-C", localCwd, "rev-parse", "--show-object-format"])
  ).stdout.trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error(`beam down: unsupported local Git object format: ${objectFormat}`);
  }
  await assertSupportedCollectedRepoFormat(collected, objectFormat);
  for (const path of [
    join(collected, "config"),
    join(collected, "config.worktree"),
    join(collected, "commondir"),
    join(collected, "hooks"),
    join(collected, "worktrees"),
    join(collected, "objects", "info", "alternates"),
    join(collected, "objects", "info", "http-alternates"),
  ]) {
    rmSync(path, { recursive: true, force: true });
  }
  const extension =
    objectFormat === "sha256" ? "[extensions]\n\tobjectformat = sha256\n" : "";
  const version = objectFormat === "sha256" ? "1" : "0";
  writeFileSync(
    join(collected, "config"),
    `[core]\n\trepositoryformatversion = ${version}\n\tbare = true\n` +
      `\tfsmonitor = false\n${extension}`,
  );
}

/**
 * Shared refusal for collected remote Git state that exceeds one of the
 * hard caps below: always BEFORE any local change, with the remote —
 * hostile or honest — still intact.
 */
function refuseOversizedCollection(what: string, subject: "history" | "stash"): never {
  throw new Error(
    `beam down: ${what} — refusing before any local change; ` +
      `salvage the sandbox manually if this ${subject} is legitimate`,
  );
}

/**
 * Run fsck without letting valid dangling loose symrefs masquerade as broken
 * object refs, and enumerate every collected object unreachable from ALL
 * durable roots (refs, reflogs, the index): exactly what a remote created
 * without any surviving reference — reflogs disabled/expired/deleted, raw
 * `commit-tree`/`hash-object` writes. The return pins each of them, so the
 * lossless object copy cannot be silently undone by a later local gc.
 * Capped fail-closed: a hostile store cannot force an unbounded pin set.
 */
async function fsckCollectedGit(collected: string, tempRoot: string): Promise<Set<string>> {
  const loose = await listLooseSymbolicRefs(["git", "--git-dir", collected], []);
  const dangling = loose.filter((r) => /^0+$/.test(r.sha));
  const parked: Array<{ from: string; to: string }> = [];
  try {
    for (const ref of dangling) {
      const to = join(tempRoot, "dangling-symrefs", ...ref.ref.split("/"));
      mkdirSync(dirname(to), { recursive: true });
      renameSync(ref.file, to);
      parked.push({ from: ref.file, to });
    }
    const out = await runGitChecked([
      "git",
      "--no-replace-objects",
      "--git-dir",
      collected,
      "fsck",
      "--cache",
      "--no-dangling",
      "--unreachable",
    ]);
    const unreachable = new Set<string>();
    for (const line of out.stdout.split("\n")) {
      if (!line.startsWith("unreachable ")) continue;
      const m = /^unreachable [a-z]+ ([0-9a-f]{40,64})$/.exec(line);
      if (m === null) {
        throw new Error(
          `beam down: unparseable fsck unreachable-object report (${line}) — refusing`,
        );
      }
      unreachable.add(m[1]!);
      if (unreachable.size > MAX_DANGLING_OBJECTS) {
        refuseOversizedCollection(
          `the collected remote Git state carries more than ${MAX_DANGLING_OBJECTS} ` +
            `unreferenced objects`,
          "history",
        );
      }
    }
    return unreachable;
  } finally {
    for (const { from, to } of parked.reverse()) {
      mkdirSync(dirname(from), { recursive: true });
      renameSync(to, from);
    }
  }
}


/*
 * ------------------------------------------------------------------------
 * Remote reflog preservation
 * ------------------------------------------------------------------------
 *
 * Reflogs are the ONLY place a remote commit→reset/amend/rebase leaves its
 * old tips. The object copy below brings those objects home, but nothing
 * local references them: a later `git reflog expire --expire=now --all &&
 * git gc --prune=now` would erase remote-only history after the sandbox is
 * purged. So the down captures the exact raw reflog bytes for HEAD and
 * every shared ref, validates them in quarantine, and pins every referenced
 * object under the return namespace BEFORE the purge can run.
 */

/**
 * Hard ceilings on the collected reflogs Beam is willing to parse and pin.
 * A hostile remote controls every byte under `logs/`; each cap turns an
 * attempted blowup (of parse memory, of published refs, of update-ref
 * transaction size) into an actionable refusal BEFORE any local mutation,
 * with the remote still intact. The ship erases `logs/` from the outbound
 * payload (only the stash reflog travels), so every remote reflog line is
 * remote-session history — legitimate sessions sit orders of magnitude
 * below all of these.
 */
const MAX_REFLOG_ENUMERATED_FILES = 65_536;
const MAX_REFLOG_FILES = 4096;
const MAX_REFLOG_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_REFLOG_TOTAL_LINES = 100_000;
const MAX_REFLOG_UNIQUE_OIDS = 200_000;
/**
 * Ceiling on collected objects unreachable from every durable root (refs,
 * reflogs, index). Each gets an OID-keyed pin so the lossless object copy
 * survives local gc; over the cap the down refuses before any local change —
 * pins are never silently dropped.
 */
const MAX_DANGLING_OBJECTS = 200_000;
/**
 * Tighter per-file ceiling for `refs/stash`: the stash import path below
 * publishes one ref PER reflog position, so its input must stay too small
 * to weaponize that per-entry publication.
 */
const MAX_STASH_REFLOG_LINES = 4096;

/** One remote reflog captured from quarantine, byte-exact. */
interface CapturedReflog {
  /**
   * Source name: "HEAD" or a full "refs/..." name — path-derived, digested
   * before any local use.
   */
  ref: string;
  /** Quarantine file holding the exact raw bytes (hashed via --stdin-paths, never re-encoded). */
  file: string;
  /** The exact raw bytes, for digest keying. */
  raw: Buffer;
  /** False for refs/stash: the stash flow owns its raw-reflog publication. */
  publishRaw: boolean;
}

/**
 * Explicit preorder walk of the collected `logs/refs/**` tree (no
 * recursion): each frame is one directory being scanned; entering a
 * subdirectory pushes a frame, so stack depth equals directory depth and
 * MAX_COLLECTED_TREE_DEPTH bounds it. Each iteration consumes one child
 * name or pops a frame, so the walk over a finite tree terminates.
 */
function walkCollectedReflogTree(opts: {
  root: string;
  /** Reflog entries already enumerated (logs/HEAD) — counted against the cap. */
  baseCount: number;
}): Array<{ ref: string; file: string }> {
  const { root, baseCount } = opts;
  const found: Array<{ ref: string; file: string }> = [];
  const stack: Array<{ dir: string; segments: string[]; names: string[]; next: number }> = [
    { dir: root, segments: [], names: readdirSync(root), next: 0 },
  ];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.next === top.names.length) {
      stack.pop();
      continue;
    }
    const entry = top.names[top.next]!;
    top.next += 1;
    const label = `logs/refs/${[...top.segments, entry].join("/")}`;
    if (entry === "" || entry === "." || entry === ".." || /[\x00-\x1f\x7f]/.test(entry)) {
      throw new Error(
        `beam down: collected reflog tree contains an invalid path segment (${label}) — refusing`,
      );
    }
    if (baseCount + found.length >= MAX_REFLOG_ENUMERATED_FILES) {
      refuseOversizedCollection(
        `the collected remote Git state carries more than ` +
          `${MAX_REFLOG_ENUMERATED_FILES} reflog entries`,
        "history",
      );
    }
    const path = join(top.dir, entry);
    const st = lstatSync(path);
    if (st.isDirectory()) {
      if (stack.length === MAX_COLLECTED_TREE_DEPTH) {
        throw new Error(
          `beam down: collected reflog tree nests deeper than ` +
            `${MAX_COLLECTED_TREE_DEPTH} directories (${label}) — refusing`,
        );
      }
      const segments = [...top.segments, entry];
      stack.push({ dir: path, segments, names: readdirSync(path), next: 0 });
      continue;
    }
    if (st.isFile()) {
      found.push({ ref: ["refs", ...top.segments, entry].join("/"), file: path });
      continue;
    }
    throw new Error(
      `beam down: collected reflog tree contains an unsafe filesystem entry ` +
        `(${label}) — refusing`,
    );
  }
  return found;
}

/**
 * Enumerate reflog files from the two known reflog roots of the collected
 * dir — `logs/HEAD` and `logs/refs/**` — trusting nothing about the tree:
 * every entry is lstat-classified without following links (symlinks,
 * devices, sockets, fifos refuse), and path segments that cannot be reflog
 * components refuse. The derived source name is never used as a filesystem
 * path or a raw ref name; it is digested wherever it keys anything.
 */
function enumerateCollectedReflogs(collected: string): Array<{ ref: string; file: string }> {
  const out: Array<{ ref: string; file: string }> = [];
  const headLog = join(collected, "logs", "HEAD");
  const headSt = lstatSync(headLog, { throwIfNoEntry: false });
  if (headSt !== undefined) {
    if (!headSt.isFile()) {
      throw new Error(
        "beam down: collected logs/HEAD is not a regular file — refusing to import; " +
          "the remote is untouched",
      );
    }
    out.push({ ref: "HEAD", file: headLog });
  }
  const root = join(collected, "logs", "refs");
  const rootSt = lstatSync(root, { throwIfNoEntry: false });
  if (rootSt === undefined) return out;
  if (!rootSt.isDirectory()) {
    throw new Error(
      "beam down: collected logs/refs is not a directory — refusing to import; " +
        "the remote is untouched",
    );
  }
  const walked = walkCollectedReflogTree({ root, baseCount: out.length });
  return [...out, ...walked];
}

/**
 * Read and validate every enumerated reflog in quarantine — the caps above
 * plus the exact line grammar documented on `captureRemoteReflogs` below —
 * returning the byte-exact captures and every referenced non-zero object
 * id. Purely local reads; any violation refuses the whole import before
 * the first local effect, with the remote intact.
 */
function validateCollectedReflogs(
  opts: { collected: string; oidLen: number },
): { reflogs: CapturedReflog[]; oids: Set<string> } {
  const { collected, oidLen } = opts;
  const reflogs: CapturedReflog[] = [];
  const oids = new Set<string>();
  let totalBytes = 0;
  let totalLines = 0;
  for (const { ref, file } of enumerateCollectedReflogs(collected)) {
    if (ref.startsWith("refs/beam/")) continue;
    const raw = readFileSync(file);
    if (raw.length === 0) continue;
    if (reflogs.length >= MAX_REFLOG_FILES) {
      refuseOversizedCollection(
        `the collected remote Git state carries more than ${MAX_REFLOG_FILES} non-empty reflogs`,
        "history",
      );
    }
    totalBytes += raw.length;
    if (totalBytes > MAX_REFLOG_TOTAL_BYTES) {
      refuseOversizedCollection(
        `the collected remote reflogs exceed ${MAX_REFLOG_TOTAL_BYTES} total bytes`,
        "history",
      );
    }
    const text = raw.toString("latin1");
    if (!text.endsWith("\n")) {
      throw new Error(
        `beam down: malformed remote reflog for ${ref} (missing trailing newline) — ` +
          `refusing to import; the remote is untouched`,
      );
    }
    const lines = text.slice(0, -1).split("\n");
    totalLines += lines.length;
    if (totalLines > MAX_REFLOG_TOTAL_LINES) {
      refuseOversizedCollection(
        `the collected remote reflogs exceed ${MAX_REFLOG_TOTAL_LINES} total entries`,
        "history",
      );
    }
    if (ref === "refs/stash" && lines.length > MAX_STASH_REFLOG_LINES) {
      refuseOversizedCollection(
        `the collected remote stash reflog exceeds ${MAX_STASH_REFLOG_LINES} entries`,
        "stash",
      );
    }
    for (let n = 0; n < lines.length; n++) {
      const m = /^([0-9a-f]+) ([0-9a-f]+) [^\t]* \d+ [+-]\d{4}(?:\t.*)?$/.exec(lines[n]!);
      if (m === null || m[1]!.length !== oidLen || m[2]!.length !== oidLen) {
        throw new Error(
          `beam down: malformed remote reflog for ${ref} (entry ${n + 1}) — ` +
            `refusing to import; the remote is untouched`,
        );
      }
      for (const oid of [m[1]!, m[2]!]) {
        if (/^0+$/.test(oid)) continue;
        oids.add(oid);
        if (oids.size > MAX_REFLOG_UNIQUE_OIDS) {
          refuseOversizedCollection(
            `the collected remote reflogs reference more than ${MAX_REFLOG_UNIQUE_OIDS} ` +
              `distinct objects`,
            "history",
          );
        }
      }
    }
    reflogs.push({ ref, file, raw, publishRaw: ref !== "refs/stash" });
  }
  return { reflogs, oids };
}

/**
 * Capture and validate remote reflogs while everything is still quarantine:
 * the exact grammar is enforced line by line (`<old> SP <new> SP <ident>
 * <epoch> <tz>[TAB <msg>]`, old/new exactly the collected object format's
 * width — SHA-1 and SHA-256 stores both supported), every cap above is
 * enforced, and every referenced non-zero object id is proven to exist in
 * the collected store through ONE `cat-file --batch-check` run (replace
 * refs disabled — a replace ref must not vouch for an absent object). Any
 * violation refuses the whole import before the first local effect, with
 * the remote intact. Validation reads bytes losslessly (latin1 decoding),
 * so a non-UTF-8 committer identity is not mangled and not refused.
 *
 * Only Beam's own bookkeeping (`refs/beam/`) is skipped: it is never user
 * work, and capturing a prior return's own pins would grow across round
 * trips. Worktree-scoped reflogs (`refs/bisect/`, `refs/worktree/`,
 * `refs/rewritten/`) ARE captured: fsck treats every reflog as a
 * reachability root, so their objects never land in the unreachable set —
 * these reflog pins are the only durability those objects get.
 * `refs/stash` is validated and capped here (it feeds the per-entry stash
 * publication below) but its raw bytes are published by the stash flow,
 * not twice.
 */
async function captureRemoteReflogs(
  collected: string,
): Promise<{ reflogs: CapturedReflog[]; oids: Set<string> }> {
  const objectFormat = (
    await runGitChecked(["git", "--git-dir", collected, "rev-parse", "--show-object-format"])
  ).stdout.trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error(`beam down: unsupported collected Git object format: ${objectFormat}`);
  }
  const oidLen = objectFormat === "sha256" ? 64 : 40;
  const captured = validateCollectedReflogs({ collected, oidLen });
  if (captured.oids.size > 0) {
    const check = await runGitChecked(
      ["git", "--no-replace-objects", "--git-dir", collected, "cat-file", "--batch-check"],
      { stdinText: `${[...captured.oids].join("\n")}\n` },
    );
    for (const line of check.stdout.split("\n")) {
      if (line === "") continue;
      if (!/^[0-9a-f]+ [a-z]+ \d+$/.test(line)) {
        throw new Error(
          `beam down: a remote reflog references an object absent from the collected store ` +
            `(${line.split(" ")[0]}) — refusing to import; the remote is untouched`,
        );
      }
    }
  }
  return captured;
}

function returnReflogRefAtBase(qbase: string, sourceRef: string, rawReflog: Uint8Array): string {
  return `${qbase}/meta/reflogs/${contentDigest(sourceRef)}/${contentDigest(rawReflog)}`;
}

/**
 * Publish the captured reflogs and dangling objects durably, BEFORE the
 * purge can run: one pin ref per reflog-referenced object, one raw-bytes
 * blob ref per reflog, and one pin ref per collected object no durable
 * root reaches (`dangling`, from the quarantine fsck). Every
 * value is deterministic from its key (pins: key = value = the object id;
 * raw blobs: the key embeds the content digest), so retries converge on
 * identical writes — a retried down can neither fork nor overwrite a prior
 * pin. All blobs land in ONE `hash-object --stdin-paths` run and all refs
 * in ONE `update-ref --stdin` run: subprocess count stays constant however
 * large the (already capped) input is. The referenced objects exist locally
 * — the object import above copied the fsck-proven collected store.
 */
async function publishCapturedReflogs(
  gitArgv: string[],
  qbase: string,
  captured: { reflogs: CapturedReflog[]; oids: Set<string> },
  dangling: Set<string>,
  notes: string[],
): Promise<void> {
  const raws = captured.reflogs.filter((r) => r.publishRaw);
  const blobByFile = new Map<string, string>();
  if (raws.length > 0) {
    const hashed = await runGitChecked(
      [...gitArgv, "hash-object", "-w", "--no-filters", "--stdin-paths"],
      { stdinText: `${raws.map((r) => r.file).join("\n")}\n` },
    );
    const ids = hashed.stdout.split("\n").filter((l) => l !== "");
    if (ids.length !== raws.length) {
      throw new Error(
        "beam down: reflog blob publication returned an unexpected object count — refusing",
      );
    }
    raws.forEach((r, i) => blobByFile.set(r.file, ids[i]!));
  }
  const updates: string[] = [];
  for (const oid of [...captured.oids].sort()) {
    updates.push(`option no-deref\nupdate ${qbase}/meta/reflog-pins/${oid} ${oid}\n`);
  }
  for (const r of raws) {
    const qref = returnReflogRefAtBase(qbase, r.ref, r.raw);
    updates.push(`option no-deref\nupdate ${qref} ${blobByFile.get(r.file)!}\n`);
  }
  for (const oid of [...dangling].sort()) {
    updates.push(`option no-deref\nupdate ${qbase}/meta/object-pins/${oid} ${oid}\n`);
  }
  if (updates.length === 0) return;
  await runGitChecked([...gitArgv, "update-ref", "--stdin"], { stdinText: updates.join("") });
  if (raws.length <= 16) {
    for (const r of raws) {
      const qref = returnReflogRefAtBase(qbase, r.ref, r.raw);
      notes.push(
        `reflog for ${r.ref}: exact remote reflog preserved at ${qref} — ` +
          `inspect with: git cat-file blob ${shq(qref)}`,
      );
    }
  } else {
    notes.push(
      `${raws.length} remote reflogs preserved under ${qbase}/meta/reflogs/ — ` +
        `list with: git for-each-ref ${shq(`${qbase}/meta/reflogs`)}`,
    );
  }
  if (captured.oids.size > 0) {
    notes.push(
      `${captured.oids.size} reflog-referenced object(s) pinned under ` +
        `${qbase}/meta/reflog-pins/ — remote-only history survives reflog expiry ` +
        `and git gc --prune=now`,
    );
  }
  if (dangling.size > 0) {
    notes.push(
      `${dangling.size} unreferenced remote object(s) pinned under ${qbase}/meta/object-pins/ — ` +
        `remote objects with no surviving reference survive reflog expiry and git gc --prune=now`,
    );
  }
}

/**
 * A collected, quarantine-validated remote Git return. Produced with ZERO
 * local effect: until apply() runs, the local worktree and repository are
 * byte-identical to before the collection, and a failure at any phase
 * removes nothing but the Beam-owned quarantine.
 */
export interface CollectedWorktreeGitReturn {
  /** Local quarantine root holding the validated collected `.git`; alive until dispose(). */
  readonly tempRoot: string;
  /**
   * Read-only re-proof that the local repository is still the shipped one
   * (paths, device+inode, create-only tokens). The down runs it before
   * creating the persisted workspace stage; apply() repeats the proof
   * immediately before its first local Git effect.
   */
  assertLocalPrepared(): Promise<void>;
  /** Run every local Git effect through the bound-inode transaction. */
  apply(): Promise<WorktreeGitReturn>;
  /**
   * Pinned remote re-proof: the remote `.git` still IS the collected
   * fingerprint. The down runs it after the workspace staging proof and
   * BEFORE any local effect, so a writer that commits between the Git
   * collection and workspace staging can never publish a torn
   * worktree/Git pair. A late change refuses with the remote intact and
   * record retryable; `when` names the guarded window in the error.
   */
  assertRemoteGitUnchanged(when?: string): Promise<void>;
  /** Remove the quarantine. Idempotent; safe on every outcome. */
  dispose(): void;
}

/** The handoff-record slice the worktree-Git return phases need. */
interface WorktreeGitReturnRecord {
  id: string;
  localCwd: string;
  remoteCwd: string;
  wtGit?: WtGitShipInfo;
  workspaceToken?: string;
}

/**
 * Pinned pre-collection proof, before anything else touches this record:
 * the `.git` pointer must be EXACTLY this record's published bytes (a
 * foreign or missing pointer means the remote Git state is not this
 * handoff's — refuse with everything intact), then fingerprint the whole
 * payload tree from inside the physical workspace (a swapped path fails
 * there, never here), refusing any foreign Git lock. The identical probe
 * re-runs after the transfer; only `before == after == collected` lets a
 * byte of the collection near the local repository (see the sandwich in
 * the caller).
 */
async function assertCollectionSourceBound(opts: {
  t: Transport;
  id: string;
  remoteCwd: string;
  generation: string;
  payloadRel: string;
  workspaceToken: string | undefined;
}): Promise<{ recordOwner: string; preCollect: GitTreeFingerprint }> {
  const { t, id, remoteCwd, generation, payloadRel, workspaceToken } = opts;
  if (workspaceToken === undefined) {
    throw new Error(
      `beam down: handoff ${id} has no workspace ownership token on record — it cannot ` +
        `prove the remote Git state is its own; retire it with beam kill ${id} --purge`,
    );
  }
  const recordOwner = workspaceOwnerContent(id, workspaceToken);
  const pointer = await remoteGitPointerState(t, remoteCwd, generation, recordOwner);
  if (pointer.git !== "ours" || !pointer.payloadPresent) {
    throw new Error(
      `beam down: the remote .git of handoff ${id} is ${
        pointer.git === "absent" ? "missing" : "not this handoff's published pointer"
      }${pointer.payloadPresent ? "" : " and its Git payload is gone"} — the remote Git ` +
        `state cannot be proven to be this ship's; refusing to collect it ` +
        `(the remote is untouched)`,
    );
  }
  const preCollect = await remoteGitTreeFingerprint(t, remoteCwd, payloadRel, recordOwner);
  return { recordOwner, preCollect };
}

/**
 * The stable-collection sandwich: the pinned remote fingerprint must be
 * unchanged across the transfer, and the collected quarantine must BE that
 * fingerprinted tree. A recursive read racing a background writer (one
 * that survived the tmux kill: nohup, disowned, a daemon) can assemble a
 * "repository" mixing bytes from two moments that never coexisted remotely
 * — internally consistent, fsck-clean, and wrong. Equality of all three
 * manifests proves the import candidate is one remote semantic snapshot:
 * HEAD bytes, index bytes, every loose and packed ref and symref, reflogs,
 * operation-state markers, config/ref backend, and the object-store
 * layout. Any mutation across the collection refuses HERE — remote intact,
 * retryable. Even a matching sandwich cannot admit a lock: the remote
 * scans bracket the manifest hash, but a lock flapping precisely between
 * probe boundaries can still ride the transfer, and a collected lock means
 * the collection raced a writer — refuse while the data is inert.
 */
async function assertStableCollectedSnapshot(opts: {
  t: Transport;
  remoteCwd: string;
  payloadRel: string;
  generation: string;
  recordOwner: string;
  preCollect: GitTreeFingerprint;
  collected: string;
}): Promise<void> {
  const { t, remoteCwd, payloadRel, generation, recordOwner, preCollect, collected } = opts;
  const postCollect = await remoteGitTreeFingerprint(t, remoteCwd, payloadRel, recordOwner);
  const postPointer = await remoteGitPointerState(t, remoteCwd, generation);
  if (postPointer.git !== "ours" || !postPointer.payloadPresent) {
    const payload = postPointer.payloadPresent ? "present" : "missing";
    throw new Error(
      `beam down: the remote .git pointer changed while its repository was being collected ` +
        `(pointer ${postPointer.git}, payload ${payload}) — refusing to import a snapshot ` +
        `no longer bound to this handoff; the remote is intact`,
    );
  }
  if (preCollect.digest !== postCollect.digest || preCollect.entries !== postCollect.entries) {
    throw new Error(
      `beam down: the remote Git repository changed while it was being collected ` +
        `(fingerprint ${short(preCollect.digest)} -> ${short(postCollect.digest)}) — ` +
        `a background process is still writing to it. Refusing to import a torn snapshot; ` +
        `the remote is intact. Stop the remote writer and retry beam down`,
    );
  }
  assertNoCollectedGitLocks(collected);
  const collectedFp = collectedGitTreeFingerprint(collected);
  if (collectedFp.digest !== preCollect.digest || collectedFp.entries !== preCollect.entries) {
    throw new Error(
      `beam down: the collected Git quarantine does not match the proven remote snapshot ` +
        `(fingerprint ${short(collectedFp.digest)} != ${short(preCollect.digest)}) — ` +
        `refusing to import bytes that never existed as one remote state; the remote is ` +
        `intact. Retry beam down`,
    );
  }
}

/**
 * Validate the collected quarantine end to end — still with ZERO local
 * effect. In order: neutralize executable/redirecting metadata; prove full
 * object integrity and connectivity from every durable root (fsck with
 * --cache), enumerating every collected object unreachable from ALL of
 * them so the apply can pin what no ref, reflog, or index entry reaches;
 * refuse index entries that hide paths (skip-worktree/sparse); parse the
 * returned index plus all known operation metadata as a worktree,
 * rejecting malformed or torn merge/rebase/sequencer/bisect state while
 * the recursive operation directories can still be restored whole; capture
 * and validate the exact raw remote reflogs; and verify the record's
 * pinned ship-time ref and stash identity tokens byte-for-byte. A remote
 * workspace that was deleted and recreated, or whose `.git` was replaced
 * by an unrelated (even valid) repository, fails here with nothing staged
 * toward the local worktree.
 */
async function validateCollectedGitReturn(opts: {
  collected: string;
  localCwd: string;
  tempRoot: string;
  wtGit: WtGitShipInfo | undefined;
}): Promise<{
  capturedReflogs: { reflogs: CapturedReflog[]; oids: Set<string> };
  unreachableObjects: Set<string>;
  shipped: Map<string, ShippedRef>;
  shippedStashLogRaw: Uint8Array;
  remoteRefs: SourceRef[];
}> {
  const { collected, localCwd, tempRoot, wtGit } = opts;
  await neutralizeCollectedGitDir(collected, localCwd);
  const unreachableObjects = await fsckCollectedGit(collected, tempRoot);
  await assertNoSparseCollectedIndex(collected, localCwd);
  await runGitChecked([
    "git", "--git-dir", collected, "--work-tree", localCwd,
    "status", "--porcelain=v1", "--ignore-submodules=all", "--untracked-files=no",
  ]);
  const capturedReflogs = await captureRemoteReflogs(collected);
  const expectedRefsDigest = wtGit?.shippedRefsDigest;
  if (!expectedRefsDigest) {
    throw new Error(`beam down: this handoff record has no pinned ship-time ref snapshot`);
  }
  const shipped = readShippedRefs(collected, expectedRefsDigest);
  const shippedStashLogFile = join(collected, SHIPPED_STASH_LOG_FILE);
  const shippedStashLogRaw = existsSync(shippedStashLogFile)
    ? readFileSync(shippedStashLogFile)
    : undefined;
  if (
    shippedStashLogRaw === undefined ||
    wtGit?.shippedStashLogDigest === undefined ||
    contentDigest(shippedStashLogRaw) !== wtGit.shippedStashLogDigest
  ) {
    throw new Error(
      "beam down: the pinned ship-time stash reflog snapshot is missing or changed — refusing",
    );
  }
  const remoteRefs = await listRefsWith(["git", "--git-dir", collected], []);
  return { capturedReflogs, unreachableObjects, shipped, shippedStashLogRaw, remoteRefs };
}

/**
 * Pinned remote re-proof: the remote `.git` still IS the collected
 * fingerprint. Proves BOTH namespaces as one binding: this generation's
 * exact `.git` pointer brackets the full payload-tree fingerprint, so a
 * replaced workspace pointer cannot authenticate a stale hidden payload
 * belonging to Beam. A late change refuses with the remote intact and the
 * record retryable; `when` names the guarded window in the error.
 */
async function assertRemoteGitStillCollected(opts: {
  t: Transport;
  remoteCwd: string;
  payloadRel: string;
  generation: string;
  recordOwner: string;
  preCollect: GitTreeFingerprint;
  when: string | undefined;
}): Promise<void> {
  const { t, remoteCwd, payloadRel, generation, recordOwner, preCollect, when } = opts;
  const window = when ?? "while the workspace was being staged";
  const pointerBefore = await remoteGitPointerState(t, remoteCwd, generation);
  if (pointerBefore.git !== "ours" || !pointerBefore.payloadPresent) {
    const payload = pointerBefore.payloadPresent ? "present" : "missing";
    throw new Error(
      `beam down: the remote .git pointer changed after its repository was collected, ` +
        `${window} (pointer ${pointerBefore.git}, payload ${payload}) — refusing to publish ` +
        `a return no longer bound to this handoff; the remote is intact`,
    );
  }
  const finalRemote = await remoteGitTreeFingerprint(t, remoteCwd, payloadRel, recordOwner);
  const pointerAfter = await remoteGitPointerState(t, remoteCwd, generation);
  if (pointerAfter.git !== "ours" || !pointerAfter.payloadPresent) {
    const payload = pointerAfter.payloadPresent ? "present" : "missing";
    throw new Error(
      `beam down: the remote .git pointer changed during its final repository proof, ` +
        `${window} (pointer ${pointerAfter.git}, payload ${payload}) — refusing to publish ` +
        `a return no longer bound to this handoff; the remote is intact`,
    );
  }
  if (finalRemote.digest !== preCollect.digest || finalRemote.entries !== preCollect.entries) {
    throw new Error(
      `beam down: the remote Git repository changed after it was collected, ${window} ` +
        `(fingerprint ${short(preCollect.digest)} -> ${short(finalRemote.digest)}) — ` +
        `a background process is still writing to it. Refusing to publish a torn remote ` +
        `return; the remote is intact, new work included. Retry beam down to collect and ` +
        `import the newer state`,
    );
  }
}

/**
 * Collect the remote standalone `.git` into a local quarantine and prove —
 * before ANY local effect — that it is one stable remote snapshot
 * (pre == post == collected fingerprint), a complete self-consistent
 * repository (fsck from every durable root), and the very repository this
 * record shipped (pinned ship-time ref and stash identity tokens). The
 * caller sequences the returned phases; a failure here removes only the
 * quarantine and leaves both sides byte-identical.
 */
export async function collectWorktreeGitReturn(
  t: Transport,
  record: WorktreeGitReturnRecord,
): Promise<CollectedWorktreeGitReturn> {
  const { id, localCwd, remoteCwd } = record;
  const returnKey = worktreeGitReturnKey(id, record.wtGit);
  const generation = record.wtGit!.generation;
  const payloadRel = gitPayloadPath(generation);
  const remoteGit = `${remoteCwd}/${payloadRel}`;
  const { recordOwner, preCollect } = await assertCollectionSourceBound({
    t, id, remoteCwd, generation, payloadRel, workspaceToken: record.workspaceToken,
  });
  const tempRoot = mkdtempSync(join(tmpdir(), "beam-wtret-"));
  try {
    // Collect into a local quarantine area first — never directly over
    // anything the local repository uses. Strictly ADDITIVE: the quarantine
    // is fresh (nothing to delete) and a delete-licensed transfer would
    // demand a mirror marker the payload upload no longer earns; the
    // three-way fingerprint sandwich is the exactness proof, never rsync
    // semantics.
    const collected = join(tempRoot, "collected.git");
    await t.syncDown(remoteGit, collected, {
      delete: false,
      owned: { root: remoteCwd, ownerBytes: recordOwner },
    });
    await assertStableCollectedSnapshot({
      t, remoteCwd, payloadRel, generation, recordOwner, preCollect, collected,
    });
    const validated = await validateCollectedGitReturn({
      collected, localCwd, tempRoot, wtGit: record.wtGit,
    });
    return {
      tempRoot,
      assertLocalPrepared: async (): Promise<void> => {
        // The apply phase is quarantine-only, so the sole local
        // precondition is identity: prove — through the same binding
        // discipline the apply uses — that this is still the repository
        // that shipped. Local checkout state is deliberately NOT examined:
        // the return never overwrites it, so it cannot refuse over it.
        await assertWorktreeIdentity(localCwd, record.wtGit);
        const bound = await bindReturnRepo(localCwd, record.wtGit);
        bound.restore();
      },
      apply: () =>
        applyCollectedWorktreeGit({
          localCwd,
          wtGit: record.wtGit,
          returnKey,
          collectedDigest: preCollect.digest,
          tempRoot,
          collected,
          ...validated,
        }),
      assertRemoteGitUnchanged: (when?: string): Promise<void> =>
        assertRemoteGitStillCollected({
          t, remoteCwd, payloadRel, generation, recordOwner, preCollect, when,
        }),
      dispose: () => rmSync(tempRoot, { recursive: true, force: true }),
    };
  } catch (err) {
    // A collect/validate failure removes only the Beam-owned quarantine:
    // no local byte changed, the remote — hostile or honest — is intact,
    // and the record stays retryable.
    rmSync(tempRoot, { recursive: true, force: true });
    throw err;
  }
}

/** Everything the local apply phase needs from a validated collection. */
interface CollectedGitApplyContext {
  localCwd: string;
  wtGit: WtGitShipInfo | undefined;
  /** Ship-generation return key (worktreeGitReturnKey). */
  returnKey: string;
  /** Collected payload-tree fingerprint — the per-collection namespace key. */
  collectedDigest: string;
  /** Quarantine root and the validated collected `.git` inside it. */
  tempRoot: string;
  collected: string;
  capturedReflogs: { reflogs: CapturedReflog[]; oids: Set<string> };
  unreachableObjects: Set<string>;
  shipped: Map<string, ShippedRef>;
  shippedStashLogRaw: Uint8Array;
  remoteRefs: SourceRef[];
}

/**
 * The local half of the Git return — QUARANTINE-ONLY by contract: the
 * object import is additive and content-addressed, and every other effect
 * lands under `refs/beam/return/<key>/` as durable recovery pins with
 * actionable notes. The local worktree, HEAD, index, operation state, and
 * every ref outside `refs/beam/` are NEVER written. All effects are bound
 * by inode to the proven directories. Idempotent: pins are deterministic
 * and objects content-addressed, so a retry converges over its own work.
 */
async function applyCollectedWorktreeGit(
  ctx: CollectedGitApplyContext,
): Promise<WorktreeGitReturn> {
  const { localCwd, wtGit, returnKey, collectedDigest, tempRoot, collected } = ctx;
  const { capturedReflogs, unreachableObjects, shipped, shippedStashLogRaw, remoteRefs } = ctx;
  const quarantined: string[] = [];
  const notes: string[] = [];
  const qbase = returnQbase(returnKey, collectedDigest);

  // Re-run the ship-time directory identity proof, then bind every effect
  // to the proven inodes for the whole transaction.
  await assertWorktreeIdentity(localCwd, wtGit);
  const bound = await bindReturnRepo(localCwd, wtGit);
  try {
    // Objects first: additive, content-addressed, inode-bound. Everything
    // pinned below stays reachable through the return namespace.
    await bound.inCommon(async () => importObjects(collected, "."));
    // Pin every reflog-referenced object and the exact raw reflog bytes
    // durably under the return namespace, so a later local
    // `git reflog expire --expire=now --all && git gc --prune=now` cannot
    // erase remote-only history the lossless return still owes.
    await bound.inCommon((common) =>
      publishCapturedReflogs(common, qbase, capturedReflogs, unreachableObjects, notes),
    );
    // The collected HEAD, read once from the immutable quarantine.
    const collectedArgv = ["git", "--git-dir", collected];
    const headSym = await runGit([...collectedArgv, "symbolic-ref", "--quiet", "HEAD"]);
    const headShaRes = await runGit(
      [...collectedArgv, "rev-parse", "--verify", "--quiet", "HEAD"],
    );
    const remoteHeadSha = headShaRes.code === 0 ? headShaRes.stdout.trim() : undefined;
    if (remoteHeadSha !== undefined) {
      await runGitChecked([...bound.git, "cat-file", "-e", remoteHeadSha]);
    }
    const headBranch = headSym.code === 0 ? headSym.stdout.trim() : undefined;
    notes.push(
      await applyCollectedIndex({ bound, qbase, localCwd, tempRoot, collected, remoteHeadSha }),
    );
    const refs = await applyCollectedRemoteRefs({ bound, qbase, remoteRefs, shipped });
    quarantined.push(...refs.quarantined);
    notes.push(...refs.notes);
    const remoteNames = new Set(remoteRefs.map((r) => r.ref));
    const deleted = await applyCollectedDeletedRefs({ bound, qbase, shipped, remoteNames });
    quarantined.push(...deleted.quarantined);
    notes.push(...deleted.notes);
    const stash = await applyCollectedStash({
      bound, qbase, collected, remoteRefs, shipped, shippedStashLogRaw,
    });
    quarantined.push(...stash.quarantined);
    notes.push(...stash.notes);
    const head = await applyCollectedHead({
      bound, qbase, shippedBranch: wtGit?.branch, shipped, headBranch, remoteHeadSha,
    });
    quarantined.push(...head.quarantined);
    notes.push(...head.notes);
    const opStateNote = applyCollectedOperationStateNote(collected);
    if (opStateNote !== undefined) notes.push(opStateNote);
    notes.push(
      await applyCollectedManifest({
        bound, qbase, returnKey, collectedDigest, remoteRefs, shipped, remoteNames,
        headBranch, remoteHeadSha, headPin: head.headPin, stash,
      }),
    );
    return { qbase, quarantined, notes };
  } finally {
    bound.restore();
  }
}

/**
 * Canonicalize the incoming index entirely in quarantine (split shards
 * collapsed, cache-only extensions removed) and pin it as recovery data —
 * raw bytes, staged tree, and every conflict-stage object — NEVER
 * installed over the local index. Returns the user-facing note.
 */
async function applyCollectedIndex(opts: {
  bound: BoundReturnRepo;
  qbase: string;
  localCwd: string;
  tempRoot: string;
  collected: string;
  remoteHeadSha: string | undefined;
}): Promise<string> {
  const { bound, qbase, localCwd, tempRoot, collected, remoteHeadSha } = opts;
  const collectedIndex = join(collected, "index");
  const incomingIndex = join(tempRoot, "incoming-index");
  if (existsSync(collectedIndex)) {
    for (const f of readdirSync(collected)) {
      if (f.startsWith("sharedindex.")) copyFileSync(join(collected, f), join(tempRoot, f));
    }
    copyFileSync(collectedIndex, incomingIndex);
    await runGitChecked([...bound.git, "update-index", "--no-split-index"], {
      env: { GIT_INDEX_FILE: incomingIndex },
    });
    await runGitChecked([...bound.git, "update-index", "--no-untracked-cache"], {
      env: { GIT_INDEX_FILE: incomingIndex },
    });
    await runGit([...bound.git, "update-index", "--no-fsmonitor"], {
      env: { GIT_INDEX_FILE: incomingIndex },
    });
  } else {
    const tree = remoteHeadSha ? [remoteHeadSha] : ["--empty"];
    await runGitChecked([...bound.git, "read-tree", ...tree], {
      env: { GIT_INDEX_FILE: incomingIndex },
    });
  }
  const incomingIndexContent = await bound.inCommon((common) =>
    indexContent(localCwd, incomingIndex, common),
  );
  const incomingIndexSemanticDigest = await bound.inCommon((common) =>
    indexSemanticDigest(localCwd, incomingIndex, common),
  );
  await bound.inCommon((common) =>
    pinIncomingCheckout(
      common,
      `${qbase}/meta/state`,
      incomingIndex,
      incomingIndexContent,
      incomingIndexSemanticDigest,
      remoteHeadSha,
    ),
  );
  return (
    `remote index and HEAD preserved at ${qbase}/meta/state — the local checkout is never ` +
    `modified; inspect with: git cat-file commit ${shq(`${qbase}/meta/state`)}`
  );
}

/**
 * Preserve every remote ref that changed since the ship under the return
 * namespace — heads, tags, remotes, and worktree-private names alike.
 * Nothing outside refs/beam/ is created, moved, or deleted.
 */
async function applyCollectedRemoteRefs(opts: {
  bound: BoundReturnRepo;
  qbase: string;
  remoteRefs: SourceRef[];
  shipped: Map<string, ShippedRef>;
}): Promise<{ quarantined: string[]; notes: string[] }> {
  const { bound, qbase, remoteRefs, shipped } = opts;
  const quarantined: string[] = [];
  const notes: string[] = [];
  for (const r of remoteRefs) {
    if (r.ref === "refs/stash") continue;
    const base = shipped.get(r.ref);
    // EVERY final ref target is a durable root of this exact collection.
    // A locally deleted "same" ref, or a remote refs/beam/* root hidden
    // from the divergence loop, must not let its object die after purge.
    const targetPin = returnTargetPin(qbase, r);
    if (targetPin !== undefined) {
      await bound.inCommon((common) =>
        runGitChecked([...common, "update-ref", "--no-deref", targetPin, r.sha]),
      );
    }
    if (r.symrefTarget !== undefined) {
      const same = base?.symrefTarget === r.symrefTarget;
      if (!same) {
        const qref = returnValueRefAtBase(qbase, "meta/symrefs/values", r.ref);
        await bound.inCommon((common) =>
          quarantineText(
            common,
            qref,
            `symbolic-ref ${r.ref}\ntarget ${r.symrefTarget}\nresolved ${r.sha}\n`,
          ),
        );
        notes.push(
          `${r.ref}: remote symbolic target ${r.symrefTarget} preserved at ${qref}` +
            (targetPin === undefined
              ? " (target is unborn)"
              : `; resolved object ${short(r.sha)} pinned at ${targetPin}`) +
            `; inspect with: git cat-file -p ${shq(qref)}`,
        );
        quarantined.push(r.ref);
      }
      continue;
    }
    if (r.ref.startsWith("refs/beam/")) {
      // The source name is deliberately never recreated locally: it may
      // collide with Beam's own bookkeeping. Its resolved object still
      // gets a digest-keyed root so fsck reachability cannot hide it.
      continue;
    }
    if (base?.symrefTarget === undefined && base?.sha === r.sha) continue;
    const qref = returnValueRefAtBase(qbase, "values", r.ref);
    await bound.inCommon((common) =>
      runGitChecked([...common, "update-ref", "--no-deref", qref, r.sha]),
    );
    quarantined.push(r.ref);
    notes.push(
      `${r.ref}: remote value ${short(r.sha)} preserved at ${qref} — the local ref is ` +
        `untouched; adopt it after review with: git update-ref ${shq(r.ref)} ${shq(qref)}`,
    );
  }
  return { quarantined, notes };
}

/**
 * Durable per-collection pin name for one collected final ref value.
 * EVERY resolved final target (including "same" refs and refs/beam/*
 * roots) gets a digest-keyed root so a later local gc cannot erase the
 * object after purge; an all-zero (unborn) value has no object to pin.
 */
function returnTargetPin(qbase: string, r: SourceRef): string | undefined {
  const resolved = !/^0+$/.test(r.sha);
  if (!resolved) return undefined;
  let kind: ReturnValueKind = "meta/symrefs/targets";
  if (r.symrefTarget === undefined) kind = "meta/ref-targets";
  if (r.ref.startsWith("refs/beam/")) kind = "meta/remote-beam";
  return returnValueRefAtBase(qbase, kind, r.ref);
}

/**
 * Reverse diff: a shipped ref the remote deleted. The shipped tip is
 * pinned as a durable tombstone; the local ref is never deleted.
 */
async function applyCollectedDeletedRefs(opts: {
  bound: BoundReturnRepo;
  qbase: string;
  shipped: Map<string, ShippedRef>;
  remoteNames: Set<string>;
}): Promise<{ quarantined: string[]; notes: string[] }> {
  const { bound, qbase, shipped, remoteNames } = opts;
  const quarantined: string[] = [];
  const notes: string[] = [];
  for (const [ref, shippedRef] of shipped) {
    if (remoteNames.has(ref)) continue;
    if (ref.startsWith("refs/beam/") || ref === "refs/stash" || ref.includes("@{")) continue;
    if (shippedRef.symrefTarget !== undefined) {
      const tomb = returnValueRefAtBase(qbase, "meta/symrefs/deleted", ref);
      await bound.inCommon((common) =>
        quarantineText(
          common,
          tomb,
          `deleted-symbolic-ref ${ref}\ntarget ${shippedRef.symrefTarget}\n` +
            `resolved ${shippedRef.sha}\n`,
        ),
      );
      notes.push(
        `${ref}: symbolic ref deleted remotely — shipped target ${shippedRef.symrefTarget} ` +
          `preserved at ${tomb}; the local ref is untouched`,
      );
      quarantined.push(ref);
      continue;
    }
    const tomb = returnValueRefAtBase(qbase, "deleted", ref);
    await bound.inCommon((common) =>
      runGitChecked([...common, "update-ref", "--no-deref", tomb, shippedRef.sha]),
    );
    quarantined.push(ref);
    notes.push(
      `${ref}: deleted remotely — the local ref is untouched; shipped tip preserved at ` +
        `${tomb}; delete locally after review with: git update-ref -d ${shq(ref)}`,
    );
  }
  return { quarantined, notes };
}

/** Pinned remote stash stack state, carried from the stash phase to the manifest. */
interface CollectedStashState {
  quarantined: string[];
  notes: string[];
  remoteStash: string[];
  remoteStashLogRaw: Buffer;
  stashUntouched: boolean;
  shippedStashLength: number;
}

/**
 * The stash is never merged (reflog-backed stacks cannot merge
 * losslessly). EVERY collected final stack is pinned under this exact
 * collection namespace, even when unchanged since ship: the user may
 * have deleted the local stash and pruned its objects in the meantime.
 */
async function applyCollectedStash(opts: {
  bound: BoundReturnRepo;
  qbase: string;
  collected: string;
  remoteRefs: SourceRef[];
  shipped: Map<string, ShippedRef>;
  shippedStashLogRaw: Uint8Array;
}): Promise<CollectedStashState> {
  const { bound, qbase, collected, remoteRefs, shipped, shippedStashLogRaw } = opts;
  const quarantined: string[] = [];
  const notes: string[] = [];
  const remoteStashTip = remoteRefs.find((r) => r.ref === "refs/stash" && !r.symrefTarget)?.sha;
  const stashLogFile = join(collected, "logs", "refs", "stash");
  const remoteStashLogRaw = existsSync(stashLogFile)
    ? readFileSync(stashLogFile)
    : Buffer.alloc(0);
  const remoteStash =
    remoteStashTip !== undefined ? stashStack(remoteStashTip, remoteStashLogRaw) : [];
  const shippedStash: string[] = [];
  for (let n = 0; ; n++) {
    const entry = shipped.get(n === 0 ? "refs/stash" : shippedStashName(n));
    if (entry === undefined || entry.symrefTarget !== undefined) break;
    shippedStash.push(entry.sha);
  }
  const stashUntouched =
    remoteStashLogRaw.equals(shippedStashLogRaw) &&
    remoteStash.length === shippedStash.length &&
    remoteStash.every((sha, i) => sha === shippedStash[i]);
  for (let n = 0; n < remoteStash.length; n++) {
    const pin = n === 0 ? `${qbase}/meta/stash` : `${qbase}/meta/stash-${n}`;
    await bound.inCommon((common) =>
      runGitChecked([...common, "update-ref", "--no-deref", pin, remoteStash[n]!]),
    );
  }
  if (remoteStash.length > 0 && !stashUntouched) {
    const reflogRef = `${qbase}/meta/stash-reflogs/${contentDigest(remoteStashLogRaw)}`;
    await bound.inCommon((common) => quarantineText(common, reflogRef, remoteStashLogRaw));
    quarantined.push("refs/stash");
    notes.push(
      `remote stash preserved at ${qbase}/meta/stash with its raw reflog at ${reflogRef} — ` +
        `apply an entry with: git stash apply ${shq(`${qbase}/meta/stash`)}`,
    );
    if (remoteStash.length > 1) {
      const plural = remoteStash.length === 2 ? "y" : "ies";
      notes.push(
        `${remoteStash.length - 1} older remote stash entr${plural} preserved at ` +
          `${qbase}/meta/stash-1..${remoteStash.length - 1}`,
      );
    }
  }
  if (remoteStash.length === 0 && shippedStash.length > 0) {
    notes.push(
      "the remote consumed or dropped every shipped stash entry — the local stash still holds " +
        "them",
    );
  }
  return {
    quarantined,
    notes,
    remoteStash,
    remoteStashLogRaw,
    stashUntouched,
    shippedStashLength: shippedStash.length,
  };
}

/**
 * The remote HEAD: preserved, never installed. The local HEAD — wherever
 * it points — is not Beam's to move. `headBranch` is the collected
 * symbolic target (undefined when the remote HEAD was detached).
 */
async function applyCollectedHead(opts: {
  bound: BoundReturnRepo;
  qbase: string;
  shippedBranch: string | undefined;
  shipped: Map<string, ShippedRef>;
  headBranch: string | undefined;
  remoteHeadSha: string | undefined;
}): Promise<{ headPin: string | undefined; quarantined: string[]; notes: string[] }> {
  const { bound, qbase, shippedBranch, shipped, headBranch, remoteHeadSha } = opts;
  const quarantined: string[] = [];
  const notes: string[] = [];
  let headPin: string | undefined;
  if (headBranch !== undefined) {
    const branch = headBranch;
    if (remoteHeadSha === undefined) {
      if (branch !== shippedBranch) {
        // The symbolic target is the ONLY carrier of an unborn retarget
        // (git branch -m, git switch --orphan): pin the exact target.
        const headSymRef = `${qbase}/meta/HEAD-symref`;
        await bound.inCommon((common) =>
          quarantineText(common, headSymRef, `symbolic-ref HEAD\ntarget ${branch}\n`),
        );
        headPin = headSymRef;
        quarantined.push("HEAD");
        notes.push(
          `remote HEAD points at unborn ${branch} — preserved at ${headSymRef} ` +
            `(git cat-file blob ${shq(headSymRef)}); apply here with ` +
            `\`git symbolic-ref HEAD ${shq(branch)}\` if intended`,
        );
      }
    } else {
      if (branch !== shippedBranch || remoteHeadSha !== shipped.get(branch)?.sha) {
        const pin = `${qbase}/meta/HEAD`;
        headPin = pin;
        await bound.inCommon((common) =>
          runGitChecked([...common, "update-ref", "--no-deref", pin, remoteHeadSha]),
        );
        quarantined.push("HEAD");
        notes.push(
          `remote HEAD was attached to ${branch} at ${short(remoteHeadSha)} — preserved at ` +
            `${qbase}/meta/HEAD; the local HEAD is untouched`,
        );
      }
    }
  } else {
    if (remoteHeadSha !== undefined) {
      const pin = `${qbase}/meta/HEAD`;
      headPin = pin;
      await bound.inCommon((common) =>
        runGitChecked([...common, "update-ref", "--no-deref", pin, remoteHeadSha]),
      );
      quarantined.push("HEAD");
      notes.push(
        `remote HEAD was detached at ${short(remoteHeadSha)} — preserved at ` +
          `${qbase}/meta/HEAD; the local HEAD is untouched`,
      );
    } else {
      throw new Error(
        "beam down: the collected remote .git has neither a symbolic nor a resolvable HEAD",
      );
    }
  }
  return { headPin, quarantined, notes };
}

/**
 * Operation state stays remote-only: it cannot be installed without
 * mutating the local checkout, so it is surfaced for explicit handling.
 */
function applyCollectedOperationStateNote(collected: string): string | undefined {
  const remoteMarkers = [...OP_STATE_FILES, ...OP_STATE_DIRS].filter((name) =>
    existsSync(join(collected, name)),
  );
  if (remoteMarkers.length === 0) return undefined;
  return (
    `the remote has a git operation in progress (${remoteMarkers.join(", ")}) — it stays ` +
    `remote-only; finish or abort it on the remote (the automatic return never installs ` +
    `operation state locally)`
  );
}

/**
 * One immutable manifest per collection namespace: the authoritative map
 * of THIS collected snapshot — every ref relative to ship, plus the
 * durable target pin for EVERY final resolved value (including "same"
 * refs and refs/beam/* roots), HEAD, and the full stash stack. Content
 * is deterministic for a given (ship, collection) pair, so a converging
 * retry rewrites identical bytes; namespaces of EARLIER collections
 * remain untouched history and are never the latest state. Returns the
 * user-facing note.
 */
async function applyCollectedManifest(opts: {
  bound: BoundReturnRepo;
  qbase: string;
  returnKey: string;
  collectedDigest: string;
  remoteRefs: SourceRef[];
  shipped: Map<string, ShippedRef>;
  remoteNames: Set<string>;
  headBranch: string | undefined;
  remoteHeadSha: string | undefined;
  headPin: string | undefined;
  stash: CollectedStashState;
}): Promise<string> {
  const { bound, qbase, returnKey, collectedDigest, headPin, stash } = opts;
  const { headBranch, remoteHeadSha } = opts;
  const refLines = returnManifestRefLines(opts);
  let headLine = `head detached ${remoteHeadSha}`;
  if (headBranch !== undefined && remoteHeadSha !== undefined) {
    headLine = `head attached ${remoteHeadSha} ${headBranch}`;
  }
  if (headBranch !== undefined && remoteHeadSha === undefined) {
    headLine = `head unborn ${headBranch}`;
  }
  const { remoteStash, remoteStashLogRaw, stashUntouched } = stash;
  const stashPinned = remoteStash.length > 0;
  let stashLine: string;
  if (remoteStash.length === 0) {
    const shippedRel = stash.shippedStashLength === 0 ? "same" : "changed";
    stashLine = `stash none ${shippedRel}`;
  } else {
    const stashRel = stashUntouched ? "same" : "changed";
    stashLine =
      `stash ${stashRel} ${remoteStash[0]} ${contentDigest(remoteStashLogRaw)} ` +
      `${remoteStash.length}`;
  }
  const stashTargetLines = remoteStash.map((sha, n) => {
    const pin = n === 0 ? `${qbase}/meta/stash` : `${qbase}/meta/stash-${n}`;
    return `stash-target-pin ${n} ${sha} ${pin}`;
  });
  const manifestText =
    [
      "beam-return-manifest v1",
      `record ${returnKey}`,
      `collected-fingerprint ${collectedDigest}`,
      headLine,
      ...(headPin !== undefined ? [`head-pin ${headPin}`] : []),
      stashLine,
      ...(stashPinned ? [`stash-pin ${qbase}/meta/stash`] : []),
      ...stashTargetLines,
      ...refLines,
    ].join("\n") + "\n";
  await bound.inCommon((common) => quarantineText(common, `${qbase}/manifest`, manifestText));
  return (
    `collection manifest: git cat-file blob ${shq(`${qbase}/manifest`)} — this namespace is ` +
    `keyed by the exact collected Git fingerprint; any other ` +
    `refs/beam/return/${returnKey}/<digest> namespaces are earlier collections (history), ` +
    `never the latest state`
  );
}

/**
 * Manifest `ref …` lines: every remote ref relative to ship, then every
 * shipped ref the remote deleted — whole-list sorted for determinism.
 */
function returnManifestRefLines(opts: {
  qbase: string;
  remoteRefs: SourceRef[];
  shipped: Map<string, ShippedRef>;
  remoteNames: Set<string>;
}): string[] {
  const { qbase, remoteRefs, shipped, remoteNames } = opts;
  const refLines: string[] = [];
  for (const r of remoteRefs) {
    if (r.ref === "refs/stash") continue;
    const base = shipped.get(r.ref);
    const isRemoteBeamRef = r.ref.startsWith("refs/beam/");
    const beamPrefix = isRemoteBeamRef ? "remote-beam-" : "";
    const targetPin = returnTargetPin(qbase, r);
    if (r.symrefTarget !== undefined) {
      let rel = "changed";
      if (base === undefined) rel = "new";
      if (base !== undefined && base.symrefTarget === r.symrefTarget) rel = "same";
      let metadataPin = "";
      if (rel !== "same") {
        metadataPin = ` pin ${returnValueRefAtBase(qbase, "meta/symrefs/values", r.ref)}`;
      }
      let targetNote = " target-unborn";
      if (targetPin !== undefined) targetNote = ` target-pin ${targetPin}`;
      refLines.push(
        `ref ${beamPrefix}symref ${rel} ${r.symrefTarget} ${r.ref}${metadataPin}${targetNote}`,
      );
    } else {
      let rel = "changed";
      if (base === undefined) rel = "new";
      if (base !== undefined && base.symrefTarget === undefined && base.sha === r.sha) {
        rel = "same";
      }
      let valuePin = "";
      if (rel !== "same" && !isRemoteBeamRef) {
        valuePin = ` pin ${returnValueRefAtBase(qbase, "values", r.ref)}`;
      }
      refLines.push(
        `ref ${beamPrefix}direct ${rel} ${r.sha} ${r.ref}${valuePin} target-pin ${targetPin}`,
      );
    }
  }
  for (const [ref, shippedRef] of shipped) {
    if (remoteNames.has(ref)) continue;
    if (ref.startsWith("refs/beam/") || ref === "refs/stash" || ref.includes("@{")) continue;
    if (shippedRef.symrefTarget !== undefined) {
      refLines.push(
        `ref deleted-symref ${shippedRef.symrefTarget} ${ref} pin ` +
          returnValueRefAtBase(qbase, "meta/symrefs/deleted", ref),
      );
    } else {
      refLines.push(
        `ref deleted ${shippedRef.sha} ${ref} pin ${returnValueRefAtBase(qbase, "deleted", ref)}`,
      );
    }
  }
  refLines.sort();
  return refLines;
}

/**
 * Import the remote standalone `.git` into the original worktree and
 * common repository: collect + validate in quarantine, apply locally, then
 * re-prove the remote is still the collected snapshot. Idempotent: a retry
 * after a partial import re-collects and converges.
 */
export async function importWorktreeGitReturn(
  t: Transport,
  record: {
    id: string;
    localCwd: string;
    remoteCwd: string;
    wtGit?: WtGitShipInfo;
    workspaceToken?: string;
  },
): Promise<WorktreeGitReturn> {
  const collectedReturn = await collectWorktreeGitReturn(t, record);
  try {
    const ret = await collectedReturn.apply();
    await collectedReturn.assertRemoteGitUnchanged();
    return ret;
  } finally {
    collectedReturn.dispose();
  }
}


/**
 * Detect Git metadata at the workspace root without following a symlink,
 * probing `./`-relative from the pinned workspace cwd — a swapped workspace
 * path must fail here, never answer "absent". Enumerating the directory and
 * comparing each actual entry name is mandatory: probing every case-folded
 * spelling would make Beam's own `.beam` appear as `.BEAM` on a
 * case-insensitive filesystem. Returns "directory" only for a real
 * directory named exactly `.git` with no other excluded metadata spelling;
 * anything else that exists is "other". Checked transport failures
 * propagate.
 */
export async function remoteGitEntryKind(
  t: Transport,
  remoteCwd: string,
  owner?: string,
): Promise<"absent" | "directory" | "other"> {
  const script = [
    enterWorkspaceScript(remoteCwd),
    ...(owner === undefined ? [] : [ownerGuardScript(owner)]),
    `__beam_dir=0; __beam_other=0`,
    `for __beam_entry in ./.[!.]*; do`,
    `  if ! test -e "$__beam_entry" && ! test -L "$__beam_entry"; then continue; fi`,
    `  __beam_name=\${__beam_entry#./}`,
    `  case "$__beam_name" in`,
    `    .git) if test ! -L "$__beam_entry" && test -d "$__beam_entry"; ` +
      `then __beam_dir=1; else __beam_other=1; fi ;;`,
    `    .[gG][iI][tT]) __beam_other=1 ;;`,
    `    .[bB][eE][aA][mM]) if test "$__beam_name" != .beam; then __beam_other=1; fi ;;`,
    `  esac`,
    `done`,
    `if [ "$__beam_other" = 1 ]; then printf '%s\\n' other; ` +
      `elif [ "$__beam_dir" = 1 ]; then printf '%s\\n' directory; ` +
      `else printf '%s\\n' absent; fi`,
  ].join("\n");
  const out = await t.execChecked(script);
  const lines = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const kind = lines[lines.length - 1] ?? "";
  if (kind !== "absent" && kind !== "directory" && kind !== "other") {
    throw new Error(
      `beam: remote Git layout probe returned an invalid result: ${JSON.stringify(kind)}`,
    );
  }
  return kind;
}

/**
 * One byte-level fingerprint of an entire `.git` tree: every directory and
 * every regular file's content hash, whole-line byte-sorted, digested. The
 * same manifest is computable remotely (shell) and locally (quarantine
 * walk), so `remote-before == remote-after == collected` proves the
 * collection is ONE stable remote semantic snapshot — HEAD bytes (symbolic
 * or detached), index bytes, loose and packed refs, symrefs, reflogs,
 * operation-state markers, config/ref-backend files, and the full
 * object-store closure/layout all live inside the manifest. Modes and
 * mtimes are deliberately excluded (they do not survive every transport
 * and carry no return semantics); any content or shape change refuses.
 */
export interface GitTreeFingerprint {
  /** sha256 over the sorted manifest (one line per entry, trailing newline). */
  digest: string;
  /** Total manifest entries (directories plus files) — a cheap diagnostic. */
  entries: number;
}

/** Stdout sentinel prefixing the single fingerprint result line. */
const GIT_FP_SENTINEL = "__beam_git_fp_v1__";

/**
 * Fingerprint one Git payload directory ON the target, `./`-relative from
 * the pinned workspace cwd — the same-shell physical pin means a
 * workspace path swapped for a symlink fails in `enterWorkspaceScript`
 * before any probe output could be trusted. `gitDirRel` names the payload
 * relative to the workspace root (`.beam/git/<generation>`); manifest
 * labels are normalized to `./.git` so the digest is byte-comparable with
 * `collectedGitTreeFingerprint` and with any other generation's payload
 * carrying identical content. Refuses, before any effect:
 *
 *   - a missing, symlinked, or non-directory payload;
 *   - ANY live Git lock under it — `index.lock`, `HEAD.lock`,
 *     `packed-refs.lock`, `config.lock`, `shallow.lock`, object-store
 *     locks, every `*.lock` under `refs/`, and linked-worktree locks under
 *     `worktrees/` — a foreign lock is a live (or dead) writer Beam must
 *     never race, and never removes;
 *   - non-regular entries and manifest-breaking file names (a tree that
 *     cannot be byte-proven stable is never collected).
 *
 * The per-file hashes and the manifest digest use sha256 through whichever
 * of `sha256sum`/`shasum` the target has (coreutils, busybox, macOS, and
 * perl builds all qualify); a target with neither fails closed.
 */
export async function remoteGitTreeFingerprint(
  t: Transport,
  remoteCwd: string,
  gitDirRel: string,
  owner?: string,
): Promise<GitTreeFingerprint> {
  const segs = gitDirRel.split("/");
  const badSeg = segs.some((s) => s === "" || s === "." || s === "..");
  if (!/^[A-Za-z0-9._/-]+$/.test(gitDirRel) || badSeg) {
    throw new Error(`beam: invalid remote Git payload path: ${gitDirRel}`);
  }
  const gitPath = `${remoteCwd}/${gitDirRel}`;
  if (owner !== undefined && segs[0] !== BEAM_RESERVED_DIR) {
    throw new Error(
      `beam: an owned Git payload must live under ${BEAM_RESERVED_DIR}/ — got ${gitDirRel}`,
    );
  }
  const script = [
    "set -u",
    enterWorkspaceScript(remoteCwd),
    ...remoteGitFingerprintDescent({ gitPath, segs, gitDirRel, owner }),
    ...remoteGitFingerprintProbe(gitPath),
  ].join("\n");
  const out = await t.execChecked(script);
  const lines = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const last = lines[lines.length - 1] ?? "";
  const m = new RegExp(`^${GIT_FP_SENTINEL} ([0-9a-f]{64}) ([0-9]+)$`).exec(last);
  // The count crosses a trust boundary as raw digits: only a safe
  // nonnegative integer is a usable proof — a digit run past 2^53-1 would
  // round silently and could mask a mismatched tree.
  const entries = m === null ? Number.NaN : Number(m[2]!);
  if (m === null || !Number.isSafeInteger(entries) || entries < 0) {
    throw new Error(
      `beam: the remote Git fingerprint probe produced no proof ` +
        `(got: ${last || "no output"}) — refusing`,
    );
  }
  return { digest: m[1]!, entries };
}

/**
 * Fused held descent WITH the fingerprint's own fail-closed reports: the
 * record's owner bytes are verified WHILE HOLDING the `.beam` inode,
 * every hop is lstat'd no-follow and entered with `cd -P`, and the final
 * physical path must be exactly the held workspace's payload path. Every
 * scan the probe runs afterwards operates on `.` — the held inode —
 * never a multi-component rewalk a swapped intermediate could redirect.
 */
function remoteGitFingerprintDescent(opts: {
  gitPath: string;
  segs: string[];
  gitDirRel: string;
  owner: string | undefined;
}): string[] {
  const { gitPath, segs, gitDirRel, owner } = opts;
  const descend: string[] = [`__bg_root="$(/bin/pwd -P)"`];
  segs.forEach((seg, i) => {
    descend.push(
      `if test -L ./${seg}; then echo ${shq(
        `beam: ${gitPath} is symlinked at ${seg} — refusing to collect through it`,
      )} >&2; exit 77; fi`,
      `if test ! -e ./${seg}; then echo ${shq(
        `beam: ${gitPath} is missing on the target — the remote Git state is gone; ` +
          `refusing to collect a return that cannot be authenticated`,
      )} >&2; exit 78; fi`,
      `if test ! -d ./${seg}; then echo ${shq(
        `beam: ${gitPath} is not a directory on the target — refusing to collect it`,
      )} >&2; exit 77; fi`,
      `cd -P -- ./${seg} 2>/dev/null || { echo ${shq(
        `beam: cannot enter ${gitPath} — refusing to collect it`,
      )} >&2; exit 77; }`,
    );
    if (i === 0 && owner !== undefined) {
      descend.push(
        `if [ -L ${BEAM_OWNER_FILE} ] || [ ! -f ${BEAM_OWNER_FILE} ] || ` +
          `[ "$(cat ${BEAM_OWNER_FILE} 2>/dev/null)" != ${shq(owner)} ]; then ` +
          `echo "beam: the workspace is not owned by this handoff — refusing" >&2; exit 52; fi`,
      );
    }
  });
  descend.push(
    `if [ "$(/bin/pwd -P)" != "$__bg_root/${gitDirRel}" ]; then echo ${shq(
      `beam: ${gitPath} physically escapes the workspace — refusing to collect it`,
    )} >&2; exit 77; fi`,
  );
  return descend;
}

/**
 * Fingerprint probe body, run while HOLDING the payload inode. Labels
 * are computed from INSIDE the held payload (`find .`), then rewritten
 * to the stable `./.git` prefix so the digest is byte-comparable with
 * collectedGitTreeFingerprint and with any other generation's payload
 * carrying identical content.
 */
function remoteGitFingerprintProbe(gitPath: string): string[] {
  const relabel = `sed "s|^\\\\.|./.git|"`;
  const relabelHashed = `sed "s|^f \\\\([0-9a-f]*\\\\) \\\\.|f \\\\1 ./.git|"`;
  return [
    // Foreign-lock scan: any *.lock at any depth (index, HEAD, packed-refs,
    // config, shallow, refs, objects, linked-worktree layouts). Runs BEFORE
    // and AFTER the manifest hash below, so a lock present at any boundary
    // of this probe refuses — and a lock alive only DURING the hash is a
    // file the manifest itself records, so the fingerprint mismatches.
    `__beam_lockscan() {`,
    `  __beam_locks=$(find . -name '*.lock' -print | LC_ALL=C sort)`,
    `  if [ -n "$__beam_locks" ]; then`,
    `    printf '%s\\n' ${shq(
      `beam: live Git lock file(s) under ${gitPath} — another process (a background or ` +
        `nohup job that survived the agent stop?) may still be mutating the repository:`,
    )} "$__beam_locks" ${shq(
      `beam never removes a foreign lock. Stop the remote writer (or remove a provably ` +
        `stale lock on the target yourself), then retry — the remote is intact.`,
    )} >&2`,
    `    exit 79`,
    `  fi`,
    `}`,
    `__beam_lockscan`,
    `__beam_odd=$(find . ! -type f ! -type d -print | LC_ALL=C sort)`,
    `if [ -n "$__beam_odd" ]; then printf '%s\\n' ${shq(
      `beam: ${gitPath} contains non-regular entries (symlink/device/fifo/socket) — ` +
        `refusing to collect:`,
    )} "$__beam_odd" >&2; exit 77; fi`,
    // The manifest is line-based: refuse names that could split a line (a
    // newline) or trip hash-tool output escaping (a backslash). The glob
    // below really contains a newline — fnmatch treats it as an ordinary
    // character.
    `__beam_nl='*`,
    `*'`,
    `if [ -n "$(find . -name "$__beam_nl" -print)" ] || ` +
      `[ -n "$(find . -name '*\\\\*' -print)" ]; then echo ${shq(
        `beam: ${gitPath} contains file names with newlines or backslashes — refusing to ` +
          `collect an unprovable tree`,
      )} >&2; exit 77; fi`,
    `if command -v sha256sum >/dev/null 2>&1; then __beam_hash=sha256sum; ` +
      `elif command -v shasum >/dev/null 2>&1; then __beam_hash='shasum -a 256'; ` +
      `else echo ${shq(
        `beam: no sha256 tool (sha256sum or shasum) on the target — cannot prove a ` +
          `stable Git collection`,
      )} >&2; exit 80; fi`,
    // Manifest: `d <path>` per directory, `f <hash> <path>` per file,
    // whole-line byte order, labels normalized to `./.git`. `-exec {} +`
    // batches without word-splitting paths; the sed normalizes both
    // `HASH  PATH` and `HASH *PATH` forms.
    `__beam_manifest=$({ find . -type d -print | ${relabel} | sed 's/^/d /'; ` +
      `find . -type f -exec $__beam_hash {} + | ` +
      `sed -n 's/^\\([0-9a-f]\\{64\\}\\)[ ][ *]\\(.*\\)$/f \\1 \\2/p' | ` +
      `${relabelHashed}; } | LC_ALL=C sort)`,
    // A file the hash pass silently missed (vanished mid-scan, unreadable,
    // unparsed output line) must fail the proof, not shrink it.
    `__beam_fc=$(find . -type f -print | wc -l)`,
    `__beam_fm=$(printf '%s\\n' "$__beam_manifest" | grep -c '^f ')`,
    `if [ "$((__beam_fc))" -ne "$((__beam_fm))" ]; then echo ` +
      `"beam: the remote Git fingerprint hashed $__beam_fm of $__beam_fc files` +
      ` — refusing an incomplete proof" >&2; exit 81; fi`,
    `__beam_digest=$(printf '%s\\n' "$__beam_manifest" | $__beam_hash | awk '{print $1}')`,
    `__beam_total=$(printf '%s\\n' "$__beam_manifest" | wc -l)`,
    `__beam_lockscan`,
    `printf '%s %s %s\\n' ${shq(GIT_FP_SENTINEL)} "$__beam_digest" "$((__beam_total))"`,
  ];
}
/**
 * Reject ANY `*.lock` entry — file, directory, symlink, or special, at any
 * depth — in the pristine collected tree, before any local effect. The
 * remote lock scans bracket the manifest hash, but a lock flapping
 * precisely between probe boundaries can still ride the transfer; a
 * collected lock is proof the collection raced a live writer, whatever
 * the remote proofs later say. Never deleted, never imported: the down
 * refuses and the retry re-collects.
 */
export function assertNoCollectedGitLocks(collectedGit: string): void {
  // Explicit bounded stack in the exact pre-order of the recursion it
  // replaces: entries are checked in readdir order and a directory is
  // entered immediately, so the first offending lock reported is
  // unchanged.
  const stack = [
    { dir: collectedGit, entries: readdirSync(collectedGit, { withFileTypes: true }), next: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.next >= frame.entries.length) {
      stack.pop();
      continue;
    }
    const entry = frame.entries[frame.next]!;
    frame.next += 1;
    const path = join(frame.dir, entry.name);
    if (entry.name.endsWith(".lock")) {
      throw new Error(
        `beam down: the collected Git quarantine contains a live lock (${path}) — the ` +
          `collection raced a remote writer; refusing before any local effect (the remote is ` +
          `intact). Stop the remote writer and retry beam down`,
      );
    }
    if (!entry.isDirectory()) continue;
    if (stack.length >= MAX_COLLECTED_TREE_DEPTH) {
      throw new Error(
        `beam down: the collected Git quarantine nests more than ` +
          `${MAX_COLLECTED_TREE_DEPTH} directories — refusing to walk it`,
      );
    }
    stack.push({ dir: path, entries: readdirSync(path, { withFileTypes: true }), next: 0 });
  }
}


/**
 * The exact same manifest computed over the collected local quarantine —
 * the third leg of the collection proof (`collected == remote-before`).
 * Refuses links/specials and manifest-breaking names with the same posture
 * as the remote probe: a tree that cannot be byte-proven is never
 * imported. Must run on the PRISTINE quarantine, before
 * `neutralizeCollectedGitDir` rewrites it.
 */
export function collectedGitTreeFingerprint(collectedGit: string): GitTreeFingerprint {
  const lines: Buffer[] = [];
  // Explicit bounded stack in the exact pre-order of the recursion it
  // replaces: a directory's `d` line is emitted when it is entered and
  // its entries are examined in readdir order, so the first unprovable
  // entry reported is unchanged (the digest itself is order-free: the
  // manifest lines are byte-sorted below).
  const stack: { dir: string; label: string; entries: string[]; next: number }[] = [];
  const enter = (dir: string, label: string): void => {
    if (stack.length >= MAX_COLLECTED_TREE_DEPTH) {
      throw new Error(
        `beam down: the collected Git quarantine nests more than ` +
          `${MAX_COLLECTED_TREE_DEPTH} directories — refusing to walk it`,
      );
    }
    lines.push(Buffer.from(`d ${label}`, "utf8"));
    stack.push({ dir, label, entries: readdirSync(dir), next: 0 });
  };
  enter(collectedGit, "./.git");
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.next >= frame.entries.length) {
      stack.pop();
      continue;
    }
    const entry = frame.entries[frame.next]!;
    frame.next += 1;
    if (entry.includes("\n") || entry.includes("\\")) {
      throw new Error(
        `beam down: collected Git metadata contains an unprovable file name under ` +
          `${frame.dir} — refusing`,
      );
    }
    const path = join(frame.dir, entry);
    const st = lstatSync(path);
    if (st.isDirectory()) {
      enter(path, `${frame.label}/${entry}`);
    } else {
      if (st.isFile()) {
        lines.push(Buffer.from(`f ${fileSha256(path)} ${frame.label}/${entry}`, "utf8"));
      } else {
        throw new Error(
          `beam down: collected Git metadata contains an unsafe filesystem entry: ${path}`,
        );
      }
    }
  }
  lines.sort(Buffer.compare);
  const h = new Bun.CryptoHasher("sha256");
  const nl = Buffer.from("\n");
  for (const line of lines) {
    h.update(line);
    h.update(nl);
  }
  return { digest: h.digest("hex"), entries: lines.length };
}

/**
 * Fused, held descent from the workspace cwd into the reserved payload
 * chain (`.beam` → `git` → `<generation>`): captures the held root as
 * `__bg_root`, then adopts the shared ownedDestinationScript — the
 * record's owner bytes are verified WHILE HOLDING the `.beam` inode and
 * the remaining components are descended no-follow from that same inode,
 * one shell, one chain, no rewalk. Without an owner (legacy probes) the
 * same no-follow chain runs minus the owner proof. The shell ends INSIDE
 * the payload; callers return to the held workspace via `..` inode hops
 * re-proven against `$__bg_root` with `/bin/pwd -P` (the builtin lies
 * about a renamed+replaced parent), never an absolute rewalk.
 */
function heldPayloadDescentScript(generation: string, owner?: string): string {
  const rel = gitPayloadPath(generation);
  const lines = [`__bg_root="$(/bin/pwd -P)"`];
  if (owner !== undefined) {
    lines.push(ownedDestinationScript(owner, rel.split("/"), { create: false }));
  } else {
    for (const seg of rel.split("/")) {
      lines.push(
        `if [ -L ./${seg} ] || [ ! -d ./${seg} ]; then echo 'beam: the reserved Git ` +
          `payload chain is swapped or missing — refusing' >&2; exit 71; fi`,
        `cd -P -- ./${seg} 2>/dev/null || ` +
          `{ echo 'beam: cannot enter the reserved Git payload — refusing' >&2; exit 71; }`,
      );
    }
  }
  lines.push(
    `if [ "$(/bin/pwd -P)" != "$__bg_root/${rel}" ]; then echo 'beam: the reserved Git ` +
      `payload chain physically escapes the workspace — refusing' >&2; exit 71; fi`,
  );
  return lines.join("\n");
}

/**
 * State of one generation's remote Git landing, read under the pinned
 * workspace cwd. `.git` is only ever a Beam-published REGULAR gitdir
 * pointer file: `git === "ours"` means a regular, non-symlink `.git`
 * holding EXACTLY this generation's pointer bytes; anything else that
 * exists is `"foreign"` and is never adopted, deleted, or written
 * through. `payloadPresent` reports a real directory at this generation's
 * reserved payload path, proven through the component-wise pinned chain,
 * never a multi-component pathname.
 */
export interface RemoteGitPointerState {
  git: "absent" | "ours" | "foreign";
  payloadPresent: boolean;
}

export async function remoteGitPointerState(
  t: Transport,
  remoteCwd: string,
  generation: string,
  owner?: string,
): Promise<RemoteGitPointerState> {
  const pointer = gitPointerBytes(generation);
  const script = [
    "set -eu",
    enterWorkspaceScript(remoteCwd),
    // Owner and payload are proven through ONE fused held chain (the
    // owner bytes are verified while HOLDING the `.beam` inode the
    // payload descends from — never a separate guard a swap could split).
    // Owner refusal (52) aborts the whole probe; any other descent
    // failure is a provable "payload absent".
    `__beam_prc=0`,
    `( ${heldPayloadDescentScript(generation, owner).replaceAll("\n", "; ")} ) ` +
      `>/dev/null 2>&1 || __beam_prc=$?`,
    `if [ "$__beam_prc" = 52 ]; then echo 'beam: the workspace is not owned by this ` +
      `handoff — refusing' >&2; exit 52; fi`,
    `__beam_ptr=${shq(pointer.trimEnd())}`,
    `if test -L ./.git; then printf 'git foreign\\n'; ` +
      `elif test -f ./.git; then if [ "$(cat ./.git 2>/dev/null)" = "$__beam_ptr" ]; ` +
      `then printf 'git ours\\n'; else printf 'git foreign\\n'; fi; ` +
      `elif test -e ./.git; then printf 'git foreign\\n'; ` +
      `else printf 'git absent\\n'; fi`,
    `if [ "$__beam_prc" = 0 ]; then printf 'payload 1\\n'; else printf 'payload 0\\n'; fi`,
  ].join("\n");
  const lines = (await t.execChecked(script))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const field = (name: string): string | undefined =>
    lines
      .filter((l) => l.startsWith(`${name} `))
      .at(-1)
      ?.slice(name.length + 1);
  const git = field("git");
  const payloadPresent = field("payload");
  if ((git !== "absent" && git !== "ours" && git !== "foreign") || payloadPresent === undefined) {
    throw new Error("beam: the remote git pointer probe returned an incomplete result — refusing");
  }
  return { git, payloadPresent: payloadPresent === "1" };
}


/**
 * Deterministic, journaled staging name for one generation's `.git`
 * pointer publish: a SINGLE component in the owner-held workspace root.
 * Never a pathname under `.beam` — after the owner/payload proof a
 * swapped reserved dir must not receive the staging write, and a held
 * single component cannot be redirected. The name is derived from the
 * journaled generation, so a crashed attempt's leftover is exactly
 * reconcilable by the retry (and excluded from the workspace mirror).
 */
export function gitPointerTempName(generation: string): string {
  gitPayloadPath(generation); // validates the generation shape
  return `.beam-gitptr-${generation}`;
}

/**
 * Reconcile a crashed pointer publish's staging leftover BEFORE the
 * strict workspace proofs run (the temp is workspace-root content the
 * full-tree manifest would otherwise flag). Exactly this generation's
 * pointer bytes in a regular non-link file are OUR crashed attempt —
 * removed; anything else occupying the name is a divergent collision
 * left byte-intact for manual inspection.
 */
export async function reconcileGitPointerTemp(
  t: Transport,
  remoteCwd: string,
  generation: string,
  owner?: string,
): Promise<void> {
  const tmp = gitPointerTempName(generation);
  const ptr = shq(gitPointerBytes(generation).trimEnd());
  await t.execChecked(
    [
      "set -eu",
      enterWorkspaceScript(remoteCwd),
      ...(owner === undefined ? [] : [ownerGuardScript(owner)]),
      `if [ -L ./${tmp} ] || [ -d ./${tmp} ]; then echo 'beam: a foreign entry occupies ` +
        `the pointer staging name ${tmp} — refusing (workspace left for inspection)' ` +
        `>&2; exit 78; fi`,
      `if [ -e ./${tmp} ]; then if [ -f ./${tmp} ] && ` +
        `[ "$(cat ./${tmp} 2>/dev/null)" = ${ptr} ]; then rm -f ./${tmp}; ` +
        `else echo 'beam: a divergent pointer staging file ${tmp} exists — refusing ` +
        `(workspace left for inspection)' >&2; exit 78; fi; fi`,
    ].join("\n"),
  );
}

/**
 * Publish one generation's `.git` gitdir pointer file, CREATE-ONLY and
 * portably atomic. Owner and payload are proven through ONE fused held
 * chain (never a guard-then-rewalk split), the shell returns to the HELD
 * workspace inode via `..` hops re-proven with `/bin/pwd -P`, and the
 * pointer content is staged create-only (`set -C`) into the journaled
 * SINGLE-component temp in the held root — never under `.beam` after the
 * proof. The staged bytes are fully re-read before publishing. The
 * publish is `ln` — link(2) fails with EEXIST for ANY existing `.git`
 * (file, directory, or symlink), never follows a planted symlink, and
 * never nests into a raced directory, so a lost race means ZERO mutation
 * of the foreign entry. The outcome is verified by identity in the SAME
 * shell (`-ef` inode equality plus exact bytes); the temp is unlinked
 * ONLY while provably ours (regular, non-link, exact bytes) — a raced
 * occupant of the name is never deleted, and the deterministic retry
 * reconciles it. No directory is renamed and no feature probe is needed:
 * this is plain POSIX on every transport.
 */
export async function installRemoteGitPointer(
  t: Transport,
  remoteCwd: string,
  generation: string,
  owner?: string,
): Promise<void> {
  const pointer = gitPointerBytes(generation);
  const hops = gitPayloadPath(generation).split("/");
  const tmp = gitPointerTempName(generation);
  const ptr = shq(pointer.trimEnd());
  await t.execChecked(
    [
      "set -eu",
      enterWorkspaceScript(remoteCwd),
      `test ! -e ./.git && test ! -L ./.git || ` +
        `{ echo 'beam: a .git already exists in the remote workspace — ` +
        `refusing to touch it' >&2; exit 72; }`,
      // Prove owner + payload through the fused held chain; the shell now
      // holds the payload inode.
      heldPayloadDescentScript(generation, owner),
      // Return to the held workspace via the chain's INODE parents — a
      // pathname re-walk could follow a raced swap; `..` of held inodes
      // cannot.
      `cd ${hops.map(() => "..").join("/")} || exit 71`,
      `if [ "$(/bin/pwd -P)" != "$__bg_root" ]; then echo 'beam: the workspace moved ` +
        `during the pointer publish — refusing' >&2; exit 71; fi`,
      // Reconcile this generation's crashed leftover in the SAME held
      // shell: exact bytes are ours (re-staged below); anything else is a
      // divergent collision left byte-intact.
      `if [ -L ./${tmp} ] || [ -d ./${tmp} ]; then echo 'beam: a foreign entry occupies ` +
        `the pointer staging name ${tmp} — refusing (workspace left for inspection)' ` +
        `>&2; exit 78; fi`,
      `if [ -e ./${tmp} ]; then if [ -f ./${tmp} ] && ` +
        `[ "$(cat ./${tmp} 2>/dev/null)" = ${ptr} ]; then rm -f ./${tmp}; ` +
        `else echo 'beam: a divergent pointer staging file ${tmp} exists — refusing ` +
        `(workspace left for inspection)' >&2; exit 78; fi; fi`,
      `(set -C; printf 'gitdir: %s\\n' ${shq(gitPayloadPath(generation))} > ./${tmp}) ` +
        `2>/dev/null || { echo 'beam: cannot stage the .git pointer' >&2; exit 74; }`,
      // The cleanup unlinks ONLY a provably-ours temp (regular, non-link,
      // exact bytes) — never whatever raced into the name.
      `__bg_tmp_cleanup() { if [ ! -L ./${tmp} ] && [ -f ./${tmp} ] && ` +
        `[ "$(cat ./${tmp} 2>/dev/null)" = ${ptr} ]; then rm -f ./${tmp}; fi; }`,
      `trap __bg_tmp_cleanup EXIT HUP INT TERM`,
      // Full-content verify of the staged bytes before they are published.
      `[ ! -L ./${tmp} ] && [ -f ./${tmp} ] && [ "$(cat ./${tmp})" = ${ptr} ] || ` +
        `{ echo 'beam: the staged pointer bytes did not verify — refusing' >&2; exit 74; }`,
      // link(2): atomic create-only publish from the held workspace root.
      // EEXIST (raced entry of any type) leaves the raced entry untouched;
      // the identity postcheck then refuses.
      `ln ./${tmp} ./.git 2>/dev/null || true`,
      `test ! -L ./.git && test -f ./.git && [ ./.git -ef ./${tmp} ] && ` +
        `[ "$(cat ./.git)" = ${ptr} ] || ` +
        `{ echo 'beam: the .git pointer landing did not publish this ship — refusing ` +
        `(workspace left for inspection)' >&2; exit 77; }`,
      `__bg_tmp_cleanup`,
      `trap - EXIT HUP INT TERM`,
    ].join("\n"),
  );
}
