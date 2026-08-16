import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { run, runChecked, shqRemotePath } from "./util/shell.ts";
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
 * an index seeded from HEAD — with zero references to local absolute paths.
 * Staged state travels separately as a binary patch
 * (`git diff --cached --binary`) replayed on the target with
 * `git apply --cached`; unstaged and untracked state rides the normal
 * workspace mirror. A ship-time ref snapshot (`beam-shipped-refs`) pins
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
 * purely additive), snapshots every remotely CHANGED ref under disjoint
 * durable subtrees of `refs/beam/return/<id>/`, applies safe moves for
 * `refs/{heads,tags,remotes}` with compare-and-swap against the shipped base,
 * and installs HEAD and the index through git's own lock protocol,
 * compare-and-swapped against the durable pre-return snapshot
 * (`refs/beam/backup/<id>/state`) so concurrent local work is never
 * overwritten. The return refuses up front unless the destination proves
 * (by device+inode of both git dirs) to be the repository that shipped.
 * Any failure aborts before purge, so the remote stays intact and the down
 * is retryable.
 */

/**
 * Local config sections that describe THIS machine's layout, never the repo:
 * they carry absolute paths (`core.hooksPath`, `safe.directory`, includes),
 * per-checkout state (`worktree.*`), or repo-format toggles the clone already
 * settled (`core.*`, `extensions.*`). Everything else — remotes, branches,
 * user identity, signing setup — travels.
 */
const MACHINE_LAYOUT_CONFIG = ["core.", "extensions.", "worktree.", "include.", "includeif.", "safe."];

/**
 * Ship-time ref snapshot filename, written into the materialized `.git` and
 * read back from the collected one. Non-standard names in a Git dir are
 * inert to git itself.
 */
export const SHIPPED_REFS_FILE = "beam-shipped-refs";

/**
 * Deterministic namespace holding what the return preserved instead of (or
 * alongside) applying, in three DISJOINT durable subtrees so no remote ref
 * name can collide with another artifact's name:
 *
 *   values/<ref-minus-refs/>   the remote value of a ref that was not applied
 *   deleted/<ref-minus-refs/>  the shipped tip of a ref the remote deleted
 *   meta/HEAD, meta/stash[-n]  repo-state snapshots (quarantined remote HEAD,
 *                              the remote stash stack top-first)
 *
 * Disjointness is load-bearing: a hostile remote-only `refs/deleted/heads/x`
 * lands at `values/deleted/heads/x` and can never shadow the tombstone
 * `deleted/heads/x`, and a remote `refs/HEAD/meta` lands at
 * `values/HEAD/meta`, never colliding with `meta/HEAD`.
 */
export function returnRefBase(recordId: string): string {
  return `refs/beam/return/${recordId}`;
}

/**
 * Deterministic namespace holding the durable pre-return backup (created
 * once, never overwritten): `<base>/state` is ONE commit object pinning the
 * exact pre-return HEAD state (attached, unborn, or detached — the HEAD
 * commit rides as its parent) and the staged index (as its tree), so the
 * whole snapshot is all-or-nothing and gc-proof.
 */
export function backupRefBase(recordId: string): string {
  return `refs/beam/backup/${recordId}`;
}

/** The single pre-return snapshot ref of one record. */
function returnSnapshotRef(recordId: string): string {
  return `${backupRefBase(recordId)}/state`;
}

/**
 * Ref namespaces that are private to one worktree (git routes them to the
 * worktree git dir). They never ship — the payload is not this worktree's
 * git dir — but remote-created ones come home applied (git routes them into
 * the returning worktree's git dir).
 */
const WORKTREE_SCOPED_REFS = ["refs/bisect/", "refs/worktree/", "refs/rewritten/"];

/** Every shared ref beam trusts to ship: everything but its own bookkeeping and worktree internals. */
function isShippableSharedRef(ref: string): boolean {
  return !ref.startsWith("refs/beam/") && !WORKTREE_SCOPED_REFS.some((p) => ref.startsWith(p));
}

/**
 * Stash stack, newest first (`stash@{0}`, `stash@{1}`, …): the tip is the
 * ref value, the deeper entries are the reflog's "new" shas bottom-up (the
 * file is append-ordered oldest→newest). Computed identically at ship time
 * (to pin the shipped stack) and at return time (to compare the remote's).
 */
function stashStack(tip: string, reflogRaw: string | undefined): string[] {
  const older: string[] = [];
  for (const line of reflogRaw?.split("\n") ?? []) {
    const m = /^[0-9a-f]{40,64} ([0-9a-f]{40,64}) /.exec(line);
    const sha = m?.[1];
    if (sha && !/^0+$/.test(sha) && sha !== tip && !older.includes(sha)) older.push(sha);
  }
  older.reverse();
  return [tip, ...older];
}

/** Snapshot names pinning the shipped stash stack below the tip: `refs/stash@{n}` (never a real ref name — `@{` is illegal in refnames). */
function shippedStashName(n: number): string {
  return `refs/stash@{${n}}`;
}

/**
 * Deterministic worktree-git-dir file recording the operation state a return
 * import installed (content digest + name per entry). Written durably BEFORE
 * an import attempt's first install, so a retry can tell Beam-installed
 * operation state from concurrent local work.
 */
export function installedOpStateFile(recordId: string): string {
  return `beam-installed-opstate-${recordId}`;
}

/**
 * Deterministic worktree-git-dir file recording the HEAD and index states a
 * return import installed (compare-and-swap descriptors). Written durably
 * BEFORE the import's first checkout mutation, so a retry can tell a
 * Beam-installed HEAD/index from concurrent local work (which is refused,
 * byte-for-byte untouched).
 */
export function installedCheckoutFile(recordId: string): string {
  return `beam-installed-checkout-${recordId}`;
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
 * Stable filesystem identity of a Git directory: device and inode at ship
 * time, serialized as decimal strings so 64-bit values survive JSON without
 * numeric precision loss.
 */
export interface GitDirIdentity {
  dev: string;
  ino: string;
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
  /** Filesystem identity of commonDir at ship time (absent on legacy records; the return refuses those). */
  commonDirId?: GitDirIdentity;
  /** Filesystem identity of worktreeGitDir at ship time (absent on legacy records; the return refuses those). */
  worktreeGitDirId?: GitDirIdentity;
}

export interface MaterializedWorktreeGit {
  /** Standalone `.git` directory, ready to sync to `<remoteCwd>/.git`. */
  gitDir: string;
  /** Binary patch reproducing the staged index; absent when index == HEAD. */
  indexPatch: string | undefined;
  /** Ship-time identity `beam down` keys its git-state return off. */
  shipInfo: WtGitShipInfo;
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
 * `file://`), scp-like `host:path` and `helper::address` forms are network,
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

/**
 * A local clone often has a filesystem path as its origin. That path is both
 * unusable on the target and host-layout data, so omit the whole remote when
 * it has no network fetch URL. Mixed remotes keep their network URLs while
 * dropping local fetch/push alternatives. The same rule covers every other
 * path-bearing config form: `submodule.*.url` pinned to a local path, and
 * `url.<base>.insteadOf`/`pushInsteadOf` rewrites where either side names a
 * local path. Multi-valued keys keep their surviving values.
 */
function portableConfig(entries: Array<[key: string, value: string]>): Array<[key: string, value: string]> {
  const remoteFetchUrls = new Map<string, string[]>();
  for (const [key, value] of entries) {
    const match = /^remote\.(.+)\.url$/.exec(key);
    if (!match?.[1]) continue;
    const urls = remoteFetchUrls.get(match[1]) ?? [];
    urls.push(value);
    remoteFetchUrls.set(match[1], urls);
  }
  const localOnlyRemotes = new Set(
    [...remoteFetchUrls].filter(([, urls]) => urls.every(localFilesystemPath)).map(([name]) => name),
  );
  return entries.filter(([key, value]) => {
    const remote = /^remote\.(.+)\.[^.]+$/.exec(key)?.[1];
    if (remote && localOnlyRemotes.has(remote)) return false;
    if (/^remote\..+\.(?:url|pushurl)$/.test(key) && localFilesystemPath(value)) return false;
    if (/^submodule\..+\.url$/.test(key) && localFilesystemPath(value)) return false;
    const insteadOf = /^url\.(.+)\.(?:insteadof|pushinsteadof)$/.exec(key);
    if (insteadOf?.[1] && (localFilesystemPath(insteadOf[1]) || localFilesystemPath(value))) return false;
    return true;
  });
}

interface SourceRef {
  ref: string;
  sha: string;
  /** Set when the ref is symbolic (e.g. refs/remotes/origin/HEAD). */
  symrefTarget: string | undefined;
}

/** Refs visible through the given git invocation prefix (all refs when no pattern). */
async function listRefsWith(gitPrefix: string[], patterns: string[]): Promise<SourceRef[]> {
  const res = await runChecked([
    ...gitPrefix,
    "for-each-ref",
    "--format=%(objectname)%00%(symref)%00%(refname)",
    ...patterns,
  ]);
  const refs: SourceRef[] = [];
  for (const line of res.stdout.split("\n")) {
    if (line === "") continue;
    const [sha, symref, ref] = line.split("\0");
    if (!sha || !ref) continue;
    refs.push({ ref, sha, symrefTarget: symref || undefined });
  }
  return refs;
}


/** Absolute per-worktree git path (`rev-parse --git-path`, resolved against the worktree). */
async function gitPath(localCwd: string, name: string): Promise<string> {
  return resolve(localCwd, (await runChecked(["git", "-C", localCwd, "rev-parse", "--git-path", name])).stdout.trim());
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
  const sparse = await run(["git", "-C", localCwd, "config", "--get", "--type=bool", "core.sparseCheckout"]);
  if (sparse.code === 0 && sparse.stdout.trim() === "true") {
    throw new Error(
      `${when}: this linked worktree uses sparse-checkout, an unsupported layout beam cannot ship faithfully — ` +
        `run \`git sparse-checkout disable\` in ${localCwd} (or hand off a full checkout) and retry`,
    );
  }
  const tags = await runChecked(["git", "-C", localCwd, "ls-files", "-t", "-z"]);
  if (tags.stdout.split("\0").some((entry) => entry.startsWith("S "))) {
    throw new Error(
      `${when}: this linked worktree has skip-worktree entries, an unsupported layout beam cannot ship faithfully — ` +
        `clear them (git ls-files -t | grep '^S '; git update-index --no-skip-worktree <paths>) and retry`,
    );
  }
}

/**
 * The return installs HEAD and the index through git's own lock-file
 * protocol (`HEAD.lock`, `index.lock`) — a real compare-and-swap that only
 * the default files ref backend honors. Any other backend (reftable) would
 * bypass that exclusion, so both directions refuse it before any side
 * effect: a ship that could never come home safely must not leave.
 */
async function assertFilesRefStorage(localCwd: string, when: string): Promise<void> {
  const storage = await run(["git", "-C", localCwd, "config", "--get", "extensions.refstorage"]);
  const value = storage.stdout.trim();
  if (storage.code === 0 && value !== "" && value !== "files") {
    throw new Error(
      `${when}: this repository uses non-default ref storage (extensions.refstorage=${value}) — ` +
        `only the files ref storage backend is supported`,
    );
  }
}

/** Exact HEAD state of a worktree: attached (born), unborn (attached, no commit yet), or detached. */
interface HeadState {
  kind: "attached" | "unborn" | "detached";
  /** Symref target (attached/unborn). */
  ref?: string;
  /** HEAD commit (attached/detached). */
  commit?: string;
}

async function headState(localCwd: string, when: string): Promise<HeadState> {
  const sym = await run(["git", "-C", localCwd, "symbolic-ref", "--quiet", "HEAD"]);
  const sha = await run(["git", "-C", localCwd, "rev-parse", "--verify", "--quiet", "HEAD"]);
  const ref = sym.code === 0 ? sym.stdout.trim() : undefined;
  const commit = sha.code === 0 ? sha.stdout.trim() : undefined;
  if (ref !== undefined) return commit !== undefined ? { kind: "attached", ref, commit } : { kind: "unborn", ref };
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
  const tempRoot = mkdtempSync(join(tmpdir(), "beam-wtgit-"));
  const cleanup = () => rmSync(tempRoot, { recursive: true, force: true });
  try {
    const repoDir = join(tempRoot, "repo");
    const gitDir = join(repoDir, ".git");

    // Snapshot the source identity first — everything below reproduces it.
    // An unborn HEAD (fresh `git init`: a symbolic HEAD with no commit yet)
    // is a shippable state: the payload carries the symbolic HEAD and an
    // explicitly empty index, and the staged patch diffs against the empty
    // tree.
    const head = await headState(localCwd, "beam up");
    const commonDir = resolve(
      localCwd,
      (await runChecked(["git", "-C", localCwd, "rev-parse", "--git-common-dir"])).stdout.trim(),
    );
    // The true per-worktree git dir, plus the filesystem identity (device +
    // inode) of both git dirs: `beam down` refuses to import into any
    // directory but these exact two — a repository re-created at the same
    // path is a different repository.
    const worktreeGitDir = resolve(
      localCwd,
      (await runChecked(["git", "-C", localCwd, "rev-parse", "--absolute-git-dir"])).stdout.trim(),
    );
    // EVERY trusted shared ref of the source — branches, tags,
    // remote-tracking, refs/replace, refs/notes, custom namespaces, the
    // stash — so remote Git semantics (replacements, notes, stash) match
    // local ones. Only beam's own bookkeeping and worktree-scoped internals
    // stay home.
    const sourceRefs = (await listRefsWith(["git", "-C", localCwd], [])).filter((r) => isShippableSharedRef(r.ref));
    // The stash is REFLOG-backed: refs/stash names only the top entry; the
    // stack, its order, and its messages live in the shared reflog. Snapshot
    // both now so the payload can reproduce full stash semantics and the
    // snapshot can pin the whole shipped stack.
    const stashTip = sourceRefs.find((r) => r.ref === "refs/stash" && !r.symrefTarget)?.sha;
    const stashLogPath = await gitPath(localCwd, "logs/refs/stash");
    const stashLogRaw =
      stashTip !== undefined && existsSync(stashLogPath) ? readFileSync(stashLogPath, "utf8") : undefined;
    const shippedStash = stashTip !== undefined ? stashStack(stashTip, stashLogRaw) : [];
    const sourceConfig = parseNulConfig(
      (await runChecked(["git", "-C", localCwd, "config", "--local", "--null", "--list"])).stdout,
    );

    // Clone through the git machinery, which carries objects and refs only —
    // never the common dir's `worktrees/<sibling>/` checkout state, hooks,
    // config, or logs. `--no-hardlinks` keeps the payload self-contained;
    // `--no-checkout` skips the working tree (rsync ships the real one);
    // `--dissociate` absorbs any `objects/info/alternates` borrowing (a
    // common dir built with `clone --shared`/`--reference` would otherwise
    // hand the remote a dangling absolute alternate path instead of its
    // objects).
    await runChecked(["git", "clone", "--quiet", "--no-hardlinks", "--no-checkout", "--dissociate", localCwd, repoDir]);

    // The clone's `origin` is the LOCAL source path. Drop it (with its
    // tracking refs and branch config), then sweep any other non-core key so
    // only the clone's sane standalone core survives the overlay below.
    await runChecked(["git", "-C", repoDir, "remote", "remove", "origin"]);
    const cloneConfig = parseNulConfig(
      (await runChecked(["git", "-C", repoDir, "config", "--local", "--null", "--list"])).stdout,
    );
    const leftoverKeys = new Set(cloneConfig.map(([key]) => key));
    for (const key of leftoverKeys) {
      if (key.startsWith("core.") || key.startsWith("extensions.")) continue;
      await runChecked(["git", "-C", repoDir, "config", "--local", "--unset-all", key]);
    }

    // Mirror every shared ref exactly (direct refs first, then symrefs so
    // their targets exist).
    for (const r of sourceRefs) {
      if (r.symrefTarget) continue;
      await runChecked(["git", "-C", repoDir, "update-ref", "--no-deref", r.ref, r.sha]);
    }
    for (const r of sourceRefs) {
      if (!r.symrefTarget) continue;
      await runChecked(["git", "-C", repoDir, "symbolic-ref", r.ref, r.symrefTarget]);
    }

    // HEAD: exactly the source worktree's — attached branch (born or
    // unborn) or detached SHA.
    if (head.ref !== undefined) {
      await runChecked(["git", "-C", repoDir, "symbolic-ref", "HEAD", head.ref]);
    } else {
      await runChecked(["git", "-C", repoDir, "update-ref", "--no-deref", "HEAD", head.commit!]);
    }

    // Index = HEAD (explicitly empty for an unborn HEAD); the staged delta
    // is replayed remotely from the patch.
    await runChecked(["git", "-C", repoDir, "read-tree", head.commit !== undefined ? "HEAD" : "--empty"]);

    // Restore portable repo config minus machine-layout keys. Local-path
    // remotes are also machine layout: they would be broken on the target and
    // leak the host directory. Values remain NUL-safe and multi-valued keys
    // are preserved via --add.
    for (const [key, value] of portableConfig(sourceConfig)) {
      if (MACHINE_LAYOUT_CONFIG.some((prefix) => key.startsWith(prefix))) continue;
      await runChecked(["git", "-C", repoDir, "config", "--local", "--add", key, value]);
    }

    // Local ignores travel, and `.beam/` (the shipped-session scratch dir)
    // must never show up in remote `git status`.
    const sourceExclude = join(commonDir, "info", "exclude");
    let exclude = existsSync(sourceExclude) ? readFileSync(sourceExclude, "utf8") : "";
    if (!exclude.split("\n").some((l) => l.trim() === ".beam/")) {
      exclude += (exclude === "" || exclude.endsWith("\n") ? "" : "\n") + ".beam/\n";
    }
    mkdirSync(join(gitDir, "info"), { recursive: true });
    writeFileSync(join(gitDir, "info", "exclude"), exclude);

    // Ship-time ref snapshot: `beam down` diffs the remote's final refs
    // against it, so only refs the REMOTE changed are applied locally and a
    // branch deleted locally while the handoff was away is never
    // resurrected by its untouched remote mirror. Every shipped shared ref
    // is pinned, the stash stack below the tip as `refs/stash@{n}`
    // pseudo-entries, so an untouched remote stash is recognized as such.
    writeFileSync(
      join(gitDir, SHIPPED_REFS_FILE),
      sourceRefs
        .filter((r) => !r.symrefTarget)
        .map((r) => `${r.sha} ${r.ref}\n`)
        .join("") +
        shippedStash
          .slice(1)
          .map((sha, i) => `${sha} ${shippedStashName(i + 1)}\n`)
          .join(""),
    );

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

    // Staged changes as a self-contained binary patch, written straight to a
    // file — patch bytes must never round-trip through a text decode. An
    // unborn HEAD has no commit to diff against: staged content diffs
    // against the empty tree.
    const patchFile = join(tempRoot, "staged-index.patch");
    const diffBase =
      head.commit !== undefined
        ? "HEAD"
        : (await runChecked(["git", "-C", localCwd, "mktree"], { stdinText: "" })).stdout.trim();
    await runChecked([
      "git",
      "-C",
      localCwd,
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-color",
      `--output=${patchFile}`,
      diffBase,
    ]);
    const indexPatch = statSync(patchFile).size > 0 ? patchFile : undefined;

    const shipInfo: WtGitShipInfo = {
      head: head.commit,
      branch: head.ref,
      commonDir,
      worktreeGitDir,
      commonDirId: dirIdentity(commonDir),
      worktreeGitDirId: dirIdentity(worktreeGitDir),
    };
    return { gitDir, indexPatch, shipInfo, cleanup };
  } catch (err) {
    cleanup();
    throw err;
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
  "MERGE_MSG",
  "MERGE_MODE",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "ORIG_HEAD",
  "AUTO_MERGE",
  "BISECT_LOG",
  "BISECT_START",
  "BISECT_EXPECTED_REV",
  "BISECT_NAMES",
  "BISECT_TERMS",
  "BISECT_RUN",
  "BISECT_FIRST_PARENT",
];

/** Operation-state directories (rebase and multi-commit sequencer state). */
const OP_STATE_DIRS = ["rebase-merge", "rebase-apply", "sequencer"];

/** Op-state files whose content is one-or-more object ids that must exist after import. */
const OP_STATE_SHA_FILES = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "ORIG_HEAD", "AUTO_MERGE"];

/** The only shared namespaces the return may auto-apply (CAS rules); every other shared ref stays in `values/` quarantine. */
const APPLICABLE_REF_NAMESPACES = ["refs/heads/", "refs/tags/", "refs/remotes/"];

/**
 * Content digest of one op-state entry: a file's bytes, or for a directory
 * every contained regular file (sorted relative path + bytes). Computed the
 * same way on the collected source and on the installed copy, so a retry can
 * prove the local operation state is exactly what a prior partial import
 * installed.
 */
function digestOpState(path: string): string {
  const h = new Bun.CryptoHasher("sha256");
  if (statSync(path).isDirectory()) {
    for (const rel of readdirSync(path, { recursive: true, encoding: "utf8" }).sort()) {
      const abs = join(path, rel);
      if (!lstatSync(abs).isFile()) continue;
      h.update(rel);
      h.update("\0");
      h.update(readFileSync(abs));
      h.update("\0");
    }
  } else {
    h.update(readFileSync(path));
  }
  return h.digest("hex");
}

/**
 * Parse the per-record installed-op-state manifest, if a prior import attempt
 * wrote one. Maps each entry name to the SET of content digests Beam may have
 * installed for it: an entry that is mid-overwrite across attempts carries
 * both the prior and the incoming digest, so a crash between the manifest
 * publish and the overwrite stays retryable.
 */
async function readInstalledOpState(localCwd: string, recordId: string): Promise<Map<string, Set<string>> | undefined> {
  const file = await gitPath(localCwd, installedOpStateFile(recordId));
  if (!existsSync(file)) return undefined;
  const installed = new Map<string, Set<string>>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([0-9a-f]{64}) (.+)$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const digests = installed.get(m[2]) ?? new Set<string>();
    digests.add(m[1]);
    installed.set(m[2], digests);
  }
  return installed;
}

/** HEAD descriptors and index states a prior import attempt published as its own installs. */
interface InstalledCheckout {
  heads: Set<string>;
  indexTrees: Set<string>;
  indexDigests: Set<string>;
}

/**
 * Parse the per-record installed-checkout manifest, if a prior import
 * attempt wrote one: every HEAD and index state beam may have installed
 * itself. States accumulate across attempts (like the op-state manifest),
 * so a crash between any publish and its install stays retryable.
 */
async function readInstalledCheckout(localCwd: string, recordId: string): Promise<InstalledCheckout | undefined> {
  const file = await gitPath(localCwd, installedCheckoutFile(recordId));
  if (!existsSync(file)) return undefined;
  const out: InstalledCheckout = { heads: new Set(), indexTrees: new Set(), indexDigests: new Set() };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^(head|index-tree|index) (.+)$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    if (m[1] === "head") out.heads.add(m[2]);
    else if (m[1] === "index-tree") out.indexTrees.add(m[2]);
    else out.indexDigests.add(m[2]);
  }
  return out;
}

/**
 * Logical content of an index file: its tree (unset while unmerged entries
 * make `write-tree` impossible) and a digest of `ls-files --stage` output —
 * entry modes, object ids, stages, and paths. Both are deliberately
 * insensitive to byte-level index rewrites (stat-cache refresh, cache-tree
 * extensions) that git performs without changing what is staged. With no
 * `indexFile` the worktree's live index is read; a missing file is the
 * empty index.
 */
async function indexContent(
  localCwd: string,
  indexFile?: string,
): Promise<{ tree: string | undefined; digest: string }> {
  const env = indexFile !== undefined ? { GIT_INDEX_FILE: indexFile } : undefined;
  const tree = await run(["git", "-C", localCwd, "write-tree"], { env });
  const ls = await runChecked(["git", "-C", localCwd, "ls-files", "--stage"], { env });
  const h = new Bun.CryptoHasher("sha256");
  h.update(ls.stdout);
  return { tree: tree.code === 0 ? tree.stdout.trim() : undefined, digest: h.digest("hex") };
}

/** Parsed pre-return snapshot: the exact local state the down found. */
interface ReturnSnapshot {
  kind: "attached" | "unborn" | "detached";
  ref: string | undefined;
  commit: string | undefined;
  /** The pre-return staged tree (the snapshot commit's own tree). */
  indexTree: string;
  /** Compare-and-swap descriptor of the pre-return HEAD. */
  headDescriptor: string;
}

/** Read and validate the single pre-return snapshot commit, if one exists. */
async function readReturnSnapshot(localCwd: string, recordId: string): Promise<ReturnSnapshot | undefined> {
  const stateRef = returnSnapshotRef(recordId);
  const body = await run(["git", "-C", localCwd, "cat-file", "commit", stateRef]);
  if (body.code !== 0) return undefined;
  const kind = /^Beam-Head-Kind: (attached|unborn|detached)$/m.exec(body.stdout)?.[1] as
    | ReturnSnapshot["kind"]
    | undefined;
  const ref = /^Beam-Head-Ref: (.+)$/m.exec(body.stdout)?.[1];
  const commit = /^Beam-Head-Commit: ([0-9a-f]{40,64})$/m.exec(body.stdout)?.[1];
  const valid =
    kind === "attached"
      ? ref !== undefined && commit !== undefined
      : kind === "unborn"
        ? ref !== undefined
        : kind === "detached" && commit !== undefined;
  if (!valid) {
    throw new Error(
      `beam down: ${stateRef} exists but is not a recognizable beam pre-return snapshot — refusing to guess. ` +
        `Inspect it (git -C ${localCwd} cat-file commit ${stateRef}); if it is stale, delete it ` +
        `(git -C ${localCwd} update-ref -d ${stateRef}) and retry beam down to take a fresh snapshot`,
    );
  }
  const indexTree = (await runChecked(["git", "-C", localCwd, "rev-parse", `${stateRef}^{tree}`])).stdout.trim();
  return {
    kind: kind!,
    ref,
    commit,
    indexTree,
    headDescriptor:
      kind === "detached" ? `detached ${commit}` : kind === "unborn" ? `unborn ${ref}` : `attached ${ref} ${commit}`,
  };
}

/**
 * Fail-closed local guards + the durable pre-return snapshot. Runs BEFORE
 * any local or remote mutation (the workspace mirror included) so a down
 * that cannot receive the remote Git state aborts with everything — local
 * and remote — exactly as it was.
 *
 * Identity first: the record's ship-time identity (paths plus device+inode
 * of the common AND worktree git dirs) must prove this is still the very
 * repository that shipped. A record without an identity (older beam) and a
 * repository re-created at the same path both refuse — importing into an
 * unverified repository is the exact failure this guard exists for.
 *
 * The snapshot is create-only and ONE object: `refs/beam/backup/<id>/state`
 * points at a beam-made commit whose tree is the pre-return staged tree,
 * whose parent is the pre-return HEAD commit (none when unborn), and whose
 * message records the exact HEAD state (attached/unborn/detached). Created
 * atomically on the FIRST return attempt, never overwritten; any other ref
 * under the backup namespace without `state` (a legacy pair, an interrupted
 * preparation) is untrustworthy and fails the down closed.
 *
 * Retries re-verify EVERYTHING: the in-progress-operation guard, and that
 * the local HEAD and index still match the snapshot — or a state a prior
 * partial import durably published as its own install (the import converges
 * over its own work; concurrent local work is refused, byte-for-byte
 * untouched).
 */
export async function prepareWorktreeGitReturn(
  localCwd: string,
  recordId: string,
  shipInfo: WtGitShipInfo | undefined,
): Promise<void> {
  if (!isGitWorktree(localCwd)) {
    throw new Error(
      `beam down: ${localCwd} is no longer the Git worktree this handoff shipped — restore the checkout, ` +
        `or abandon the handoff with beam kill --purge`,
    );
  }
  // The ship-time identity is the proof this is still the same repository.
  // A record without one cannot be verified, so it refuses — never assumes.
  if (!shipInfo?.worktreeGitDir || !shipInfo.commonDirId || !shipInfo.worktreeGitDirId) {
    throw new Error(
      `beam down: this handoff record carries no ship-time repository identity for ${localCwd} ` +
        `(it was shipped by an older beam) — cannot prove the checkout is still the repository that shipped; ` +
        `refusing to import remote git state`,
    );
  }
  const commonDir = resolve(
    localCwd,
    (await runChecked(["git", "-C", localCwd, "rev-parse", "--git-common-dir"])).stdout.trim(),
  );
  if (safeRealpath(shipInfo.commonDir) !== safeRealpath(commonDir)) {
    throw new Error(
      `beam down: this worktree's common git dir changed since the ship ` +
        `(${shipInfo.commonDir} -> ${commonDir}) — refusing to import remote git state into a different repository`,
    );
  }
  const worktreeGitDir = resolve(
    localCwd,
    (await runChecked(["git", "-C", localCwd, "rev-parse", "--absolute-git-dir"])).stdout.trim(),
  );
  // Same path ≠ same repository: a checkout deleted and re-created (or
  // re-cloned) at the identical path passes every path comparison while
  // being a repository this handoff never shipped from. The device+inode
  // pair of both git dirs pins the actual directories.
  for (const [what, dir, shippedId] of [
    ["common git dir", commonDir, shipInfo.commonDirId],
    ["worktree git dir", worktreeGitDir, shipInfo.worktreeGitDirId],
  ] as const) {
    const now = dirIdentity(dir);
    if (now.dev !== shippedId.dev || now.ino !== shippedId.ino) {
      throw new Error(
        `beam down: the ${what} of ${localCwd} (${dir}) is not the directory this handoff shipped from — ` +
          `it was replaced since the ship; refusing to import remote git state into a different repository`,
      );
    }
  }
  await assertNoSparseLayout(localCwd, "beam down");
  await assertFilesRefStorage(localCwd, "beam down");

  const stateRef = returnSnapshotRef(recordId);
  const snapshot = await readReturnSnapshot(localCwd, recordId);
  if (snapshot === undefined) {
    const strays = (await listRefsWith(["git", "-C", localCwd], [backupRefBase(recordId)])).map((r) => r.ref);
    if (strays.length > 0) {
      throw new Error(
        `beam down: found a partial or legacy pre-return backup for this record (${strays.join(", ")}) without a ` +
          `snapshot at ${stateRef} — refusing to treat it as the pre-return snapshot or overwrite it. Inspect it; ` +
          `if it is stale, delete it (git -C ${localCwd} update-ref -d <ref>) and retry beam down to take a ` +
          `fresh snapshot`,
      );
    }
  }
  if (snapshot !== undefined) {
    // Retry of a prepared return: only operation state the prior partial
    // import recorded as ITS OWN install is expected; anything else is
    // concurrent local work the import would clobber.
    const installed = await readInstalledOpState(localCwd, recordId);
    for (const marker of OP_STATE_MARKERS) {
      const markerPath = await gitPath(localCwd, marker);
      if (!existsSync(markerPath)) continue;
      const expected = installed?.get(marker);
      if (expected === undefined) {
        throw new Error(
          `beam down: the local worktree grew an in-progress git operation (${marker}) after this return was ` +
            `prepared — retrying would clobber it. Finish or abort it locally, then retry beam down`,
        );
      }
      if (!expected.has(digestOpState(markerPath))) {
        throw new Error(
          `beam down: the local ${marker} no longer matches the operation state a prior partial import installed — ` +
            `refusing to overwrite local changes. Finish or abort the local operation, then retry beam down`,
        );
      }
    }
    // The local HEAD and index must still be what the snapshot pinned — or
    // exactly what a prior partial import published, then installed, itself.
    const published = await readInstalledCheckout(localCwd, recordId);
    const curHead = headStateDescriptor(await headState(localCwd, "beam down"));
    if (curHead !== snapshot.headDescriptor && !(published?.heads.has(curHead) ?? false)) {
      throw new Error(
        `beam down: the local HEAD moved after this return was prepared (now ${curHead}) — refusing to overwrite ` +
          `concurrent local work. The pre-return snapshot is pinned at ${stateRef}; restore or reconcile HEAD, ` +
          `then retry beam down`,
      );
    }
    const curIndex = await indexContent(localCwd);
    const indexOk =
      curIndex.tree === snapshot.indexTree ||
      (curIndex.tree !== undefined && (published?.indexTrees.has(curIndex.tree) ?? false)) ||
      (published?.indexDigests.has(curIndex.digest) ?? false);
    if (!indexOk) {
      throw new Error(
        `beam down: the local index changed after this return was prepared — refusing to overwrite concurrent ` +
          `local staged work. The pre-return index tree is pinned at ${stateRef}; restore or reconcile the index, ` +
          `then retry beam down`,
      );
    }
    return;
  }

  // Concurrent local work fails the return closed: an in-progress LOCAL
  // operation would be clobbered by the restored remote one.
  await assertNoOperationInProgress(localCwd, "beam down");

  // ONE create-only snapshot commit pins the whole pre-return state
  // atomically: the staged tree as its tree, the HEAD commit as its parent
  // (none when unborn), the exact HEAD state in its message. A write-tree
  // or commit failure leaves no ref behind, so nothing can mistake an
  // aborted preparation for a complete one.
  const head = await headState(localCwd, "beam down");
  const indexTree = await run(["git", "-C", localCwd, "write-tree"]);
  if (indexTree.code !== 0) {
    throw new Error(
      `beam down: could not snapshot the local index before the return ` +
        `(git write-tree: ${(indexTree.stderr || indexTree.stdout).trim()}) — resolve the local index, then retry`,
    );
  }
  const tree = indexTree.stdout.trim();
  const message =
    `beam pre-return snapshot\n\n` +
    `Beam-Record: ${recordId}\n` +
    `Beam-Head-Kind: ${head.kind}\n` +
    (head.ref !== undefined ? `Beam-Head-Ref: ${head.ref}\n` : "") +
    (head.commit !== undefined ? `Beam-Head-Commit: ${head.commit}\n` : "") +
    `Beam-Index-Tree: ${tree}\n`;
  const snapshotCommit = (
    await runChecked(
      [
        "git",
        "-C",
        localCwd,
        "-c",
        "commit.gpgsign=false",
        "commit-tree",
        tree,
        ...(head.commit !== undefined ? ["-p", head.commit] : []),
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
  await runChecked(["git", "-C", localCwd, "update-ref", "--stdin"], {
    stdinText: `option no-deref\ncreate ${stateRef} ${snapshotCommit}\n`,
  });
}

/** What the return did, for the command's summary output. */
export interface WorktreeGitReturn {
  /** Refs updated, created, or deleted locally, exactly as the remote left them. */
  applied: string[];
  /** Refs preserved under refs/beam/return/<id>/ instead of being applied. */
  quarantined: string[];
  /** Human-facing notes: conflicts, stash hints, restored operation state. */
  notes: string[];
}

function atomicCopy(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true });
  const tmp = `${dst}.beam-tmp`;
  copyFileSync(src, tmp);
  renameSync(tmp, dst);
}

/**
 * Copy the collected object store into the local common repository.
 * Content-addressed and purely additive: existing objects are never touched,
 * every file lands via temp-name + rename, and `.pack` files land before
 * their `.idx` so a crash can never leave an index naming an absent pack.
 * This carries EVERY remote-created object — including staged-only blobs
 * and commits no ref points at anymore — not just the ref-reachable
 * closure a fetch would transfer. `objects/info` (alternates, cached
 * graphs) is deliberately skipped: the collection must arrive
 * self-contained, and fsck enforces that before this runs.
 */
function importObjects(collectedGit: string, commonDir: string): void {
  const src = join(collectedGit, "objects");
  const dst = join(commonDir, "objects");
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f]{2}$/.test(entry.name)) continue;
    for (const f of readdirSync(join(src, entry.name))) {
      const to = join(dst, entry.name, f);
      if (!existsSync(to)) atomicCopy(join(src, entry.name, f), to);
    }
  }
  const packDir = join(src, "pack");
  if (!existsSync(packDir)) return;
  const packs = readdirSync(packDir);
  for (const ext of [".pack", ".rev", ".idx"]) {
    for (const f of packs) {
      if (!f.endsWith(ext)) continue;
      const to = join(dst, "pack", f);
      if (!existsSync(to)) atomicCopy(join(packDir, f), to);
    }
  }
}

/** Parse the ship-time ref snapshot riding inside the collected `.git`. */
function readShippedRefs(collectedGit: string): Map<string, string> | undefined {
  const file = join(collectedGit, SHIPPED_REFS_FILE);
  if (!existsSync(file)) return undefined;
  const shipped = new Map<string, string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([0-9a-f]{40,64}) (.+)$/.exec(line);
    if (m?.[1] && m[2]) shipped.set(m[2], m[1]);
  }
  return shipped;
}

/**
 * Validate a tree received from the sandbox without following any link.
 * Git metadata should contain only directories and regular files; links,
 * devices, sockets, and fifos have no valid return role and could redirect
 * a later local read outside the quarantine root.
 */
function assertInertGitTree(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = lstatSync(path);
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) {
      throw new Error(`beam down: collected Git metadata contains an unsafe filesystem entry: ${path}`);
    }
    if (st.isDirectory()) assertInertGitTree(path);
  }
}

/**
 * Make the collected repository config-inert before any local Git process
 * opens it. Remote config is executable input (`core.fsmonitor` uses a
 * shell), while `commondir`, object alternates, and per-worktree metadata
 * (`worktrees/<name>/{gitdir,commondir}` and friends) can redirect reads to
 * host paths the moment a local git opens the collected dir. None are part
 * of the return contract.
 */
async function neutralizeCollectedGitDir(collected: string, localCwd: string): Promise<void> {
  assertInertGitTree(collected);
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
  const objectFormat = (
    await runChecked(["git", "-C", localCwd, "rev-parse", "--show-object-format"])
  ).stdout.trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error(`beam down: unsupported local Git object format: ${objectFormat}`);
  }
  const extension =
    objectFormat === "sha256" ? "[extensions]\n\tobjectformat = sha256\n" : "";
  writeFileSync(
    join(collected, "config"),
    `[core]\n\trepositoryformatversion = ${objectFormat === "sha256" ? "1" : "0"}\n\tbare = true\n\tfsmonitor = false\n${extension}`,
  );
}

/**
 * Compare-and-swap descriptor of a worktree's CURRENT HEAD, read from the
 * raw HEAD file (`ref: <target>` or a bare object id) with an attached
 * ref resolved to its current position.
 */
async function headFileDescriptor(localCwd: string, headPath: string): Promise<string> {
  const line = readFileSync(headPath, "utf8").trim();
  if (line.startsWith("ref: ")) {
    const ref = line.slice("ref: ".length).trim();
    const sha = await run(["git", "-C", localCwd, "rev-parse", "--verify", "--quiet", ref]);
    return sha.code === 0 ? `attached ${ref} ${sha.stdout.trim()}` : `unborn ${ref}`;
  }
  if (/^[0-9a-f]{40,64}$/.test(line)) return `detached ${line}`;
  throw new Error(`beam down: unrecognized HEAD content at ${headPath} — refusing to touch it`);
}

/**
 * Install new HEAD content through git's own lock protocol: take
 * `HEAD.lock` exclusively, re-read HEAD under the lock, verify it is still
 * a state beam may replace (the pre-return snapshot, or a state a beam
 * import published as its own install), then commit by rename. Concurrent
 * git processes honor the same lock, so a lost race or concurrent local
 * work fails the install closed — never a silent overwrite. (No HEAD
 * reflog entry is written; the durable snapshot ref is the recovery
 * anchor.)
 */
async function installHeadLocked(
  localCwd: string,
  content: string,
  accepted: ReadonlySet<string>,
  recordId: string,
): Promise<void> {
  const headPath = await gitPath(localCwd, "HEAD");
  const lock = `${headPath}.lock`;
  let fd = -1;
  try {
    fd = openSync(lock, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `beam down: ${lock} already exists — another git process is updating HEAD; refusing to race it. ` +
          `Retry beam down once it finishes (or remove the stale lock if no git process is running)`,
      );
    }
    throw err;
  }
  try {
    if (!existsSync(headPath)) {
      throw new Error(`beam down: ${headPath} is missing — refusing to invent a HEAD for this worktree`);
    }
    const current = await headFileDescriptor(localCwd, headPath);
    if (!accepted.has(current)) {
      throw new Error(
        `beam down: the local HEAD moved after this return was prepared (now ${current}) — refusing to overwrite ` +
          `concurrent local work. The pre-return snapshot is pinned at ${returnSnapshotRef(recordId)}; restore or ` +
          `reconcile HEAD, then retry beam down`,
      );
    }
    writeSync(fd, content);
    closeSync(fd);
    fd = -1;
    renameSync(lock, headPath);
  } catch (err) {
    if (fd !== -1) closeSync(fd);
    rmSync(lock, { force: true });
    throw err;
  }
}

/**
 * Install new index bytes through git's own lock protocol: take
 * `index.lock` exclusively, verify the CURRENT index is still a state beam
 * may replace (the pre-return staged tree, or an index a beam import
 * published as its own install), write the incoming bytes into the lock,
 * and commit by rename. write-tree cannot run against the live index while
 * its lock is held, so the verification reads a byte copy.
 */
async function installIndexLocked(
  localCwd: string,
  incomingIndexFile: string,
  snapshotTree: string,
  published: InstalledCheckout,
  tempRoot: string,
  recordId: string,
): Promise<void> {
  const indexPath = await gitPath(localCwd, "index");
  const lock = `${indexPath}.lock`;
  let fd = -1;
  try {
    fd = openSync(lock, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `beam down: ${lock} already exists — another git process is updating the index; refusing to race it. ` +
          `Retry beam down once it finishes (or remove the stale lock if no git process is running)`,
      );
    }
    throw err;
  }
  try {
    const verifyCopy = join(tempRoot, "cas-verify-index");
    rmSync(verifyCopy, { force: true });
    if (existsSync(indexPath)) copyFileSync(indexPath, verifyCopy);
    const current = await indexContent(localCwd, verifyCopy);
    const ok =
      current.tree === snapshotTree ||
      (current.tree !== undefined && published.indexTrees.has(current.tree)) ||
      published.indexDigests.has(current.digest);
    if (!ok) {
      throw new Error(
        `beam down: the local index changed after this return was prepared — refusing to overwrite concurrent ` +
          `local staged work. The pre-return index tree is pinned at ${returnSnapshotRef(recordId)}; restore or ` +
          `reconcile the index, then retry beam down`,
      );
    }
    closeSync(fd);
    fd = -1;
    copyFileSync(incomingIndexFile, lock);
    renameSync(lock, indexPath);
  } catch (err) {
    if (fd !== -1) closeSync(fd);
    rmSync(lock, { force: true });
    throw err;
  }
}

/**
 * Import the remote standalone `.git` into the original worktree and common
 * repository. Idempotent: a retry after a partial import re-collects and
 * converges. Throws on any inconsistency; the caller must not purge unless
 * this returned.
 */
export async function importWorktreeGitReturn(
  t: Transport,
  record: { id: string; localCwd: string; remoteCwd: string },
): Promise<WorktreeGitReturn> {
  const { id, localCwd, remoteCwd } = record;
  const remoteGit = `${remoteCwd}/.git`;
  if (!(await t.exists(remoteGit))) {
    throw new Error(
      `beam down: ${remoteGit} is missing on the target — the remote Git state is gone; ` +
        `refusing to continue toward a purge that cannot be imported first`,
    );
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "beam-wtret-"));
  try {
    // Collect into a local quarantine area first — never directly over
    // anything the local repository uses.
    const collected = join(tempRoot, "collected.git");
    await t.syncDown(remoteGit, collected, { delete: true });
    await neutralizeCollectedGitDir(collected, localCwd);

    // The collection must be a complete, internally consistent repository
    // BEFORE anything local changes: full object integrity plus
    // connectivity from every ref, reflog, and the index (--cache). A torn
    // transfer, or a remote that started borrowing objects through
    // alternates, fails here — with the remote still intact.
    await runChecked(["git", "--git-dir", collected, "fsck", "--cache", "--no-dangling"]);

    // The pre-return snapshot is the import's local-state anchor: every
    // HEAD/index install below is compare-and-swapped against it (or
    // against states a prior attempt published as its own installs).
    // Missing means the return was never prepared — refuse before the
    // first local mutation.
    const snapshot = await readReturnSnapshot(localCwd, id);
    if (snapshot === undefined) {
      throw new Error(
        `beam down: the pre-return snapshot (${returnSnapshotRef(id)}) is missing — the return was never ` +
          `prepared (or the snapshot was deleted); retry beam down`,
      );
    }

    // Operation-state reconciliation with a PRIOR attempt's manifest,
    // resolved before anything local changes. The collected snapshot is
    // authoritative: a marker a prior partial import provably installed
    // that the remote no longer carries (the agent finished or aborted the
    // operation) is stale Beam state — deleted, but ONLY while its content
    // is still byte-for-byte what that import recorded. A diverged marker
    // is the user's: the whole import refuses BEFORE the first deletion.
    // Names outside the known op-state sets are never deleted, whatever a
    // manifest claims — no unrelated local file can be swept up.
    const opStateToInstall: Array<{ name: string; digest: string }> = [];
    for (const name of [...OP_STATE_FILES, ...OP_STATE_DIRS]) {
      const src = join(collected, name);
      if (existsSync(src)) opStateToInstall.push({ name, digest: digestOpState(src) });
    }
    const priorInstalled = await readInstalledOpState(localCwd, id);
    const staleCleared: string[] = [];
    if (priorInstalled) {
      const incoming = new Set(opStateToInstall.map((e) => e.name));
      for (const [name, digests] of priorInstalled) {
        if (incoming.has(name)) continue;
        if (!OP_STATE_FILES.includes(name) && !OP_STATE_DIRS.includes(name)) continue;
        const installedPath = await gitPath(localCwd, name);
        if (!existsSync(installedPath)) continue; // already gone — both sides agree
        if (!digests.has(digestOpState(installedPath))) {
          throw new Error(
            `beam down: the remote no longer carries ${name}, but the local copy no longer matches the ` +
              `operation state a prior partial import installed — refusing to delete local changes. ` +
              `Resolve ${name} locally (finish or abort the operation, or remove it), then retry beam down`,
          );
        }
        staleCleared.push(name);
      }
      // Every stale marker verified BEFORE the first delete. Directories
      // leave atomically (rename away, then remove): a crash can never
      // strand a half-deleted marker a retry's digest check would refuse.
      for (const name of staleCleared) {
        const installedPath = await gitPath(localCwd, name);
        if (statSync(installedPath).isDirectory()) {
          const away = `${installedPath}.beam-del`;
          rmSync(away, { recursive: true, force: true });
          renameSync(installedPath, away);
          rmSync(away, { recursive: true, force: true });
        } else {
          rmSync(installedPath);
        }
      }
    }

    // Provenance before effect: publish what THIS attempt may install —
    // durably, keyed by record, atomically, and even when EMPTY, so the
    // manifest always supersedes a prior attempt's. An entry the prior
    // attempt installed with different content keeps its old digest
    // alongside the new one: a crash between this publish and the install
    // below leaves either content locally, and both must stay recognizably
    // Beam's own on retry — convergence, never a refusal.
    {
      const manifest = await gitPath(localCwd, installedOpStateFile(id));
      const lines: string[] = [];
      for (const e of opStateToInstall) {
        for (const digest of new Set([e.digest, ...(priorInstalled?.get(e.name) ?? [])])) {
          lines.push(`${digest} ${e.name}\n`);
        }
      }
      const tmp = `${manifest}.beam-tmp`;
      writeFileSync(tmp, lines.join(""));
      renameSync(tmp, manifest);
    }

    const commonDir = resolve(
      localCwd,
      (await runChecked(["git", "-C", localCwd, "rev-parse", "--git-common-dir"])).stdout.trim(),
    );
    importObjects(collected, commonDir);

    const applied: string[] = [];
    const quarantined: string[] = [];
    const notes: string[] = [];
    const qbase = returnRefBase(id);
    const shipped = readShippedRefs(collected);
    if (!shipped) {
      notes.push(
        `no ship-time ref snapshot came back (${SHIPPED_REFS_FILE}) — ` +
          `remote refs are preserved under ${qbase} but none were applied`,
      );
    }
    const remoteRefs = await listRefsWith(["git", "--git-dir", collected], []);

    // Which branch is checked out where: moving a branch under a SIBLING
    // checkout would corrupt that worktree's view, so such refs stay
    // quarantined.
    const checkedOut = new Map<string, string>();
    {
      const wl = await runChecked(["git", "-C", localCwd, "worktree", "list", "--porcelain"]);
      let wtPath: string | undefined;
      for (const line of wl.stdout.split("\n")) {
        if (line.startsWith("worktree ")) wtPath = line.slice("worktree ".length);
        else if (line.startsWith("branch ") && wtPath) checkedOut.set(line.slice("branch ".length), wtPath);
      }
    }
    const localCwdReal = safeRealpath(localCwd);

    // The collected HEAD (read once — the quarantine is immutable) and the
    // incoming index BYTES are established up front, so the checkout
    // provenance below is published before the first effect that could
    // change what the local checkout resolves to.
    const headSym = await run(["git", "--git-dir", collected, "symbolic-ref", "--quiet", "HEAD"]);
    const headShaRes = await run(["git", "--git-dir", collected, "rev-parse", "--verify", "--quiet", "HEAD"]);
    const remoteHeadSha = headShaRes.code === 0 ? headShaRes.stdout.trim() : undefined;
    if (remoteHeadSha) {
      await runChecked(["git", "-C", localCwd, "cat-file", "-e", remoteHeadSha]);
    }
    // Incoming index bytes, built in quarantine: the remote's exact index
    // file when one came back (split-index shards land first — they are
    // content-addressed and additive, and both the digest below and the
    // installed index resolve them from the worktree git dir), otherwise an
    // index reconstructed from the remote HEAD, or the empty index for an
    // unborn remote.
    const localIndex = await gitPath(localCwd, "index");
    const collectedIndex = join(collected, "index");
    const incomingIndex = join(tempRoot, "incoming-index");
    if (existsSync(collectedIndex)) {
      for (const f of readdirSync(collected)) {
        if (f.startsWith("sharedindex.")) atomicCopy(join(collected, f), join(dirname(localIndex), f));
      }
      copyFileSync(collectedIndex, incomingIndex);
    } else {
      await runChecked(["git", "-C", localCwd, "read-tree", ...(remoteHeadSha ? [remoteHeadSha] : ["--empty"])], {
        env: { GIT_INDEX_FILE: incomingIndex },
      });
    }
    const incomingIndexContent = await indexContent(localCwd, incomingIndex);

    // Provenance before effect: publish every HEAD and index state this
    // attempt may produce — durably, keyed by record, atomically, unioned
    // with every prior attempt's — BEFORE the first user-visible mutation.
    // That is every FINAL head candidate (attach to the remote branch at
    // the remote position, attach to a still-unborn remote branch, or
    // detach at the remote commit) plus the TRANSITIONAL state where the
    // ref application below moves the branch the local HEAD rides while
    // HEAD itself is untouched. A crash at any later point leaves the
    // local HEAD/index either pre-return or recognizably Beam's own, so a
    // retry's compare-and-swap converges instead of refusing beam's work.
    const priorCheckout = await readInstalledCheckout(localCwd, id);
    const published: InstalledCheckout = {
      heads: new Set(priorCheckout?.heads),
      indexTrees: new Set(priorCheckout?.indexTrees),
      indexDigests: new Set(priorCheckout?.indexDigests),
    };
    if (headSym.code === 0) {
      const branch = headSym.stdout.trim();
      published.heads.add(remoteHeadSha !== undefined ? `attached ${branch} ${remoteHeadSha}` : `unborn ${branch}`);
    } else if (remoteHeadSha !== undefined) {
      published.heads.add(`detached ${remoteHeadSha}`);
    }
    const localHead = await headState(localCwd, "beam down");
    if (localHead.kind !== "detached") {
      const riddenBranchIncoming = remoteRefs.find((r) => r.ref === localHead.ref && !r.symrefTarget)?.sha;
      if (riddenBranchIncoming !== undefined) {
        published.heads.add(`attached ${localHead.ref} ${riddenBranchIncoming}`);
      }
    }
    if (incomingIndexContent.tree !== undefined) published.indexTrees.add(incomingIndexContent.tree);
    published.indexDigests.add(incomingIndexContent.digest);
    {
      const manifest = await gitPath(localCwd, installedCheckoutFile(id));
      const lines = [
        ...[...published.heads].map((d) => `head ${d}\n`),
        ...[...published.indexTrees].map((tr) => `index-tree ${tr}\n`),
        ...[...published.indexDigests].map((d) => `index ${d}\n`),
      ];
      const tmp = `${manifest}.beam-tmp`;
      writeFileSync(tmp, lines.join(""));
      renameSync(tmp, manifest);
    }

    // Shared refs: quarantine-then-apply. The remote value lands under the
    // durable `values/` subtree of refs/beam/return/<id>/ FIRST (update-ref
    // also proves the object is durably local), then a safe move is applied
    // with compare-and-swap against the shipped base — never overwriting
    // local work — and the now-redundant quarantine entry of a cleanly
    // applied ref is dropped. Only refs/{heads,tags,remotes} may apply;
    // every other shared namespace (replace, notes, custom) stays in
    // `values/` quarantine, never auto-applied.
    for (const r of remoteRefs) {
      if (r.symrefTarget) continue;
      if (r.ref.startsWith("refs/beam/") || r.ref === "refs/stash") continue;
      if (WORKTREE_SCOPED_REFS.some((p) => r.ref.startsWith(p))) continue;
      if (shipped?.get(r.ref) === r.sha) continue; // untouched mirror of a shipped ref
      const local = await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", r.ref]);
      const localSha = local.code === 0 ? local.stdout.trim() : undefined;
      if (localSha === r.sha) continue; // already identical locally
      const qref = `${qbase}/values/${r.ref.replace(/^refs\//, "")}`;
      await runChecked(["git", "-C", localCwd, "update-ref", "--no-deref", qref, r.sha]);
      if (!APPLICABLE_REF_NAMESPACES.some((prefix) => r.ref.startsWith(prefix))) {
        notes.push(`${r.ref}: outside the auto-applied namespaces — remote value preserved at ${qref}, not applied`);
        quarantined.push(r.ref);
        continue;
      }
      const base = shipped?.get(r.ref);
      const checkoutPath = checkedOut.get(r.ref);
      const checkedOutElsewhere = checkoutPath !== undefined && safeRealpath(checkoutPath) !== localCwdReal;
      let ok = false;
      if (!shipped) {
        // No base to compare against: preserved above, applied never.
      } else if (checkedOutElsewhere) {
        notes.push(`${r.ref}: checked out in another worktree (${checkoutPath}) — remote value preserved at ${qref}`);
      } else if (localSha === undefined && base !== undefined) {
        notes.push(`${r.ref}: deleted locally since the ship — remote value preserved at ${qref}, not resurrected`);
      } else if (localSha === undefined) {
        ok = (await run(["git", "-C", localCwd, "update-ref", "--no-deref", r.ref, r.sha, ""])).code === 0;
        if (!ok) notes.push(`${r.ref}: appeared locally during the down — remote value preserved at ${qref}`);
      } else if (localSha === base) {
        ok = (await run(["git", "-C", localCwd, "update-ref", "--no-deref", r.ref, r.sha, localSha])).code === 0;
        if (!ok) notes.push(`${r.ref}: moved locally during the down — remote value preserved at ${qref}`);
      } else {
        notes.push(
          `${r.ref}: moved locally since the ship (local ${short(localSha)}, remote ${short(r.sha)}) — ` +
            `remote value preserved at ${qref}`,
        );
      }
      if (ok) {
        applied.push(r.ref);
        await run(["git", "-C", localCwd, "update-ref", "-d", qref, r.sha]);
      } else {
        quarantined.push(r.ref);
      }
    }

    // The reverse diff — a shipped shared ref the REMOTE deleted. The local
    // ref disappears only under the same compare-and-swap discipline: the
    // local value must still be exactly the shipped one, no worktree may
    // have the branch checked out, and git must accept the guarded delete.
    // Every remote deletion first records a durable tombstone (the shipped
    // tip) under the return namespace — the tip must survive gc and the
    // default remote purge whether or not the deletion applies — and a
    // deletion that cannot apply safely keeps the local ref and says so in
    // the notes. A remote deletion is never silently discarded.
    if (shipped) {
      const remoteNames = new Set(remoteRefs.map((r) => r.ref));
      for (const [ref, shippedSha] of shipped) {
        if (remoteNames.has(ref)) continue;
        if (ref.startsWith("refs/beam/") || ref === "refs/stash" || ref.includes("@{")) continue;
        if (WORKTREE_SCOPED_REFS.some((p) => ref.startsWith(p))) continue;
        const local = await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", ref]);
        if (local.code !== 0) continue; // already gone locally — both sides agree
        const localSha = local.stdout.trim();
        const tomb = `${qbase}/deleted/${ref.replace(/^refs\//, "")}`;
        await runChecked(["git", "-C", localCwd, "update-ref", "--no-deref", tomb, shippedSha]);
        if (!APPLICABLE_REF_NAMESPACES.some((prefix) => ref.startsWith(prefix))) {
          // Deletions outside the auto-applied namespaces are as untrusted
          // as writes there: keep the local ref, record the tombstone.
          notes.push(
            `${ref}: deleted remotely but outside the auto-applied namespaces — kept locally; ` +
              `shipped tip preserved at ${tomb}`,
          );
          quarantined.push(ref);
          continue;
        }
        const checkoutPath = checkedOut.get(ref);
        let deleted = false;
        if (checkoutPath !== undefined) {
          notes.push(
            `${ref}: deleted remotely but checked out in ${checkoutPath} — kept locally; ` +
              `shipped tip preserved at ${tomb}`,
          );
        } else if (localSha !== shippedSha) {
          notes.push(
            `${ref}: deleted remotely but moved locally since the ship (local ${short(localSha)}, ` +
              `shipped ${short(shippedSha)}) — kept locally; shipped tip preserved at ${tomb}`,
          );
        } else {
          deleted = (await run(["git", "-C", localCwd, "update-ref", "--no-deref", "-d", ref, shippedSha])).code === 0;
          if (deleted) {
            notes.push(
              `${ref}: deleted remotely and unchanged locally — deleted; ` +
                `restore with: git update-ref ${ref} ${tomb}`,
            );
          } else {
            notes.push(
              `${ref}: deleted remotely but moved locally during the down — kept locally; ` +
                `shipped tip preserved at ${tomb}`,
            );
          }
        }
        if (deleted) applied.push(ref);
        else quarantined.push(ref);
      }
    }

    // Worktree-private refs (bisect state, rebase bookkeeping) belong to the
    // returning worktree by construction — apply directly; git routes them
    // into this worktree's git dir.
    for (const r of remoteRefs) {
      if (r.symrefTarget || !WORKTREE_SCOPED_REFS.some((p) => r.ref.startsWith(p))) continue;
      await runChecked(["git", "-C", localCwd, "update-ref", "--no-deref", r.ref, r.sha]);
      applied.push(r.ref);
    }

    // The stash is never merged into the local one (reflog-backed stacks
    // cannot merge losslessly). The shipped stack is pinned in the ref
    // snapshot (refs/stash plus refs/stash@{n} pseudo-entries), so an
    // untouched round trip is recognized and preserves nothing; any remote
    // stash work preserves the remote's ENTIRE final stack under the
    // `meta/` subtree, top first — order is stash semantics.
    const remoteStashTip = remoteRefs.find((r) => r.ref === "refs/stash" && !r.symrefTarget)?.sha;
    const stashLogFile = join(collected, "logs", "refs", "stash");
    const remoteStash =
      remoteStashTip !== undefined
        ? stashStack(remoteStashTip, existsSync(stashLogFile) ? readFileSync(stashLogFile, "utf8") : undefined)
        : [];
    const shippedStash: string[] = [];
    for (let n = 0; ; n++) {
      const sha = shipped?.get(n === 0 ? "refs/stash" : shippedStashName(n));
      if (sha === undefined) break;
      shippedStash.push(sha);
    }
    const stashUntouched =
      remoteStash.length === shippedStash.length && remoteStash.every((sha, i) => sha === shippedStash[i]);
    if (remoteStash.length > 0 && !stashUntouched) {
      await runChecked(["git", "-C", localCwd, "update-ref", "--no-deref", `${qbase}/meta/stash`, remoteStash[0]!]);
      quarantined.push("refs/stash");
      notes.push(`remote stash preserved at ${qbase}/meta/stash — apply with: git stash apply ${qbase}/meta/stash`);
      for (let n = 1; n < remoteStash.length; n++) {
        await runChecked([
          "git",
          "-C",
          localCwd,
          "update-ref",
          "--no-deref",
          `${qbase}/meta/stash-${n}`,
          remoteStash[n]!,
        ]);
      }
      if (remoteStash.length > 1) {
        notes.push(
          `${remoteStash.length - 1} older remote stash entr${remoteStash.length === 2 ? "y" : "ies"} preserved at ` +
            `${qbase}/meta/stash-1..${remoteStash.length - 1}`,
        );
      }
    } else if (remoteStash.length === 0 && shippedStash.length > 0) {
      notes.push("the remote consumed or dropped every shipped stash entry — the local stash still holds them");
    }

    // HEAD: reattach to the remote's branch only when that branch was
    // safely adopted — it now sits at the remote position and no sibling
    // worktree owns it. A quarantined branch (checked out in a sibling
    // worktree, moved or deleted locally, or a lost compare-and-swap) must
    // not move this worktree's HEAD either: the pre-return HEAD stays
    // exactly where it was — detached or attached — and the remote HEAD
    // commit stays recoverable under the return namespace. Only the
    // DECISION happens here; the mutation goes through the locked
    // compare-and-swap install below.
    /** Raw HEAD file content to install; undefined = leave HEAD untouched. */
    let intendedHead: string | undefined;
    if (headSym.code === 0) {
      const branch = headSym.stdout.trim();
      const localBranch = await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", branch]);
      const branchWt = checkedOut.get(branch);
      const branchElsewhere = branchWt !== undefined && safeRealpath(branchWt) !== localCwdReal;
      if (remoteHeadSha === undefined) {
        // Unborn branch: nothing to adopt, but attaching to a branch a
        // sibling worktree owns would double-check-it-out all the same.
        if (branchElsewhere) {
          notes.push(`HEAD preserved: unborn ${branch} is checked out in another worktree (${branchWt})`);
        } else {
          intendedHead = `ref: ${branch}\n`;
          notes.push(`HEAD attached to unborn ${branch} (the remote never committed on it)`);
        }
      } else if (!branchElsewhere && localBranch.code === 0 && localBranch.stdout.trim() === remoteHeadSha) {
        intendedHead = `ref: ${branch}\n`;
      } else {
        await runChecked(["git", "-C", localCwd, "update-ref", "--no-deref", `${qbase}/meta/HEAD`, remoteHeadSha]);
        quarantined.push("HEAD");
        const why = branchElsewhere
          ? `${branch} is checked out in another worktree (${branchWt})`
          : `${branch} did not adopt the remote position`;
        notes.push(
          `HEAD preserved: ${why} — the remote HEAD commit ${short(remoteHeadSha)} is kept at ${qbase}/meta/HEAD`,
        );
      }
    } else if (remoteHeadSha !== undefined) {
      intendedHead = `${remoteHeadSha}\n`;
    } else {
      throw new Error("beam down: the collected remote .git has neither a symbolic nor a resolvable HEAD");
    }

    // Locked compare-and-swap installs: HEAD, then the index. Each accepts
    // only the pre-return snapshot state or a published Beam install —
    // concurrent local commits, checkouts, or staging fail the install
    // closed instead of being overwritten.
    if (intendedHead !== undefined) {
      const acceptedHeads = new Set([snapshot.headDescriptor, ...published.heads]);
      await installHeadLocked(localCwd, intendedHead, acceptedHeads, id);
    }
    await installIndexLocked(localCwd, incomingIndex, snapshot.indexTree, published, tempRoot, id);
    if (existsSync(collectedIndex)) {
      // Cached-path extensions that could embed donor paths are stripped
      // right after the install.
      await runChecked(["git", "-C", localCwd, "update-index", "--no-untracked-cache"]);
      await run(["git", "-C", localCwd, "update-index", "--no-fsmonitor"]);
    }

    // In-progress operation state (merge/cherry-pick/revert/bisect/rebase):
    // restored file-for-file into this worktree's git dir; SHA-bearing
    // files are verified against the imported object store.
    let opRestored = false;
    for (const name of OP_STATE_FILES) {
      const src = join(collected, name);
      if (!existsSync(src)) continue;
      if (OP_STATE_SHA_FILES.includes(name)) {
        for (const line of readFileSync(src, "utf8").split("\n")) {
          const sha = line.trim();
          if (/^[0-9a-f]{40,64}$/.test(sha)) await runChecked(["git", "-C", localCwd, "cat-file", "-e", sha]);
        }
      }
      atomicCopy(src, await gitPath(localCwd, name));
      opRestored = true;
    }
    for (const name of OP_STATE_DIRS) {
      const src = join(collected, name);
      if (!existsSync(src)) continue;
      const dst = await gitPath(localCwd, name);
      // Staged swap: the copy lands whole beside the target, the old
      // directory leaves by rename, the new one arrives by rename — a
      // crash at any point leaves the marker absent or whole (prior or
      // incoming content, both named by the manifest), never half-written.
      const staged = `${dst}.beam-tmp`;
      const away = `${dst}.beam-del`;
      rmSync(staged, { recursive: true, force: true });
      rmSync(away, { recursive: true, force: true });
      cpSync(src, staged, { recursive: true });
      if (existsSync(dst)) renameSync(dst, away);
      renameSync(staged, dst);
      rmSync(away, { recursive: true, force: true });
      opRestored = true;
    }
    if (opRestored) {
      notes.push("in-progress operation state restored — continue (or abort) the merge/rebase/pick locally");
    }
    if (staleCleared.length > 0) {
      notes.push(
        `stale Beam-installed operation state cleared (${staleCleared.join(", ")}) — ` +
          `the remote finished or aborted the operation`,
      );
    }

    // Usability proof: the worktree must answer `git status` with the
    // imported HEAD, index, and operation state before the remote may be
    // purged.
    await runChecked(["git", "-C", localCwd, "status", "--porcelain"]);

    return { applied, quarantined, notes };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

/**
 * Remote-side twin of `assertNoOperationInProgress`: which in-progress
 * operation markers exist in a remote standalone Git dir. One marker list
 * serves both sides: a re-ship refuses exactly the states a down knows how
 * to bring home.
 *
 * Checked transport semantics: the probe runs through `execChecked`, so a
 * transport failure or an unprovable remote exit THROWS instead of reading
 * as "no operation" — a re-ship can never mistake an unreachable target
 * for a clean one and erase the only copy of remote merge/rebase state.
 * The script itself always exits 0 once it ran; markers are reported on
 * stdout, and the trailing `true` keeps a final absent marker from turning
 * into a nonzero script exit.
 */
export async function remoteGitOperationMarkers(t: Transport, remoteGitDir: string): Promise<string[]> {
  const script = [
    ...OP_STATE_MARKERS.map((m) => `test -e ${shqRemotePath(`${remoteGitDir}/${m}`)} && printf '%s\\n' ${m}`),
    "true",
  ].join("\n");
  const found = new Set(
    (await t.execChecked(script))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
  return OP_STATE_MARKERS.filter((m) => found.has(m));
}
