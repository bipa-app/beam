import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import { fileSha256 } from "../util/digest.ts";
import { ensurePrivateBeamDir } from "../util/private-dir.ts";
import type { BeamEnv } from "../env.ts";
import { updateRecord, type BeamRecord } from "../state.ts";
import type { Transport } from "../transport/types.ts";
import type { LocalSession, SessionAdapter, StagedReturn } from "./types.ts";

/**
 * Durable session-return collection for `beam down`.
 *
 * The returned transcript and artifacts NEVER touch the local harness store:
 * like the workspace return, every collection lands create-only under Beam's
 * trusted storage — `<beamDir>/returns/<recordId>/<txn>/session/` — and the
 * record's receipt points at it. The original transcript and artifacts can
 * mutate concurrently (a live local harness, open fds, anything) and remain
 * byte-for-byte and inode-for-inode untouched; there is no publication step,
 * no backup, no restore, and no local race to close.
 *
 * What the transaction still proves:
 *  1. Identity — the adapter validates the remote transcript belongs to this
 *     handoff's session (id + workspace) before a byte is staged.
 *  2. Stability — the remote is fetched TWICE and both fetches must agree
 *     (raw transcript digest + artifacts tree); a detached writer still
 *     appending refuses collection with everything intact.
 *  3. Completeness — the receipt (journaled AFTER the stage is fully
 *     written and proven) records the exact returned digests plus the raw
 *     remote digest. It is the completion marker: a crash before it leaves
 *     an unreferenced partial directory that is never trusted.
 *  4. Idempotence — a retry re-fetches and compares against the receipt:
 *     an unchanged remote verifies the durable return and reports it
 *     already collected; an advanced remote lands as a NEW return (the old
 *     one is retained on disk); a damaged return directory is simply
 *     recollected.
 *
 * Resume: omp/pi resume directly from the returned path (omp by explicit
 * JSONL path, pi via --session-dir on the return directory). Claude Code
 * and Codex cannot resume from an isolated path, so beam prints the exact
 * manual import command instead of ever writing into their live stores.
 */

/** One entry of an artifacts-tree manifest (sorted by path). */
export type TreeEntry =
  | { path: string; kind: "file"; sha256: string; mode: number }
  | { path: string; kind: "dir"; mode: number }
  | { path: string; kind: "link"; target: string };

/**
 * The durable receipt for the latest collected return. Persisted on the
 * record (atomic state.json write) only after the return directory is fully
 * staged and stability-proven; it survives the down and points the user at
 * the collected data.
 */
/** Strictly-current receipt schema version; older persisted receipts are never intact. */
export const RECEIPT_VERSION = 3;

export interface CollectReceipt {
  /** Always {@link RECEIPT_VERSION} when written by this build. */
  version: number;
  /** Return-stage transaction id (the directory name under returns/<record>/). */
  txn: string;
  /** Absolute durable home of this return: .../returns/<record>/<txn>/session */
  returnDir: string;
  /**
   * Exact returned transcript: digest of the staged bytes (header already
   * localized) plus its normalized permission bits — the executable bit and
   * friends are part of the returned identity.
   */
  session: { sha256: string; mode: number };
  /** Exact returned artifacts tree; absent when the remote had none. */
  artifacts?: TreeEntry[];
  /** Raw remote transcript digest (pre header-rewrite): the retry re-fetches
   *  and binds this before reporting the return already collected. */
  remoteSession: { sha256: string };
  /** How to resume from (or manually import) the returned session. */
  hint: string;
  createdAt: string;
}

/** What a collection hands back to `beam down`. */
export interface CollectOutcome {
  hint: string;
  /** True when the durable return already held exactly the current remote state. */
  alreadyCollected: boolean;
  /** The durable return directory the receipt points at. */
  returnDir: string;
}


/** Normalized permission bits (mode & 0o7777) of an lstat result. */
const MODE_MASK = 0o7777;

/**
 * Directory-depth ceiling of the manifest walk, matching util/digest's tree
 * walks: real filesystems cap a whole path near PATH_MAX (4096 bytes on
 * Linux, 1024 on macOS), so a deeper walk means a cycle or a runaway tree —
 * refuse instead of walking forever.
 */
const MAX_TREE_DEPTH = 4096;

/** One in-progress directory of the explicit (non-recursive) manifest walk. */
interface TreeWalkFrame {
  dir: string;
  prefix: string;
  names: string[];
  nextIndex: number;
}

/**
 * Exact manifest of a real directory tree in depth-first name order:
 * content digests plus normalized modes for regular files and directories
 * (symlinks carry their target; their modes follow transport semantics and
 * are not compared). Walked with an explicit stack bounded by
 * MAX_TREE_DEPTH; the walk terminates because lstat never follows
 * symlinks, so every frame is a distinct real directory with finitely
 * many entries.
 */
function treeEntries(root: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  const stack: TreeWalkFrame[] = [
    { dir: root, prefix: "", names: readdirSync(root).sort(), nextIndex: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.nextIndex >= frame.names.length) {
      stack.pop();
      continue;
    }
    const name = frame.names[frame.nextIndex]!;
    frame.nextIndex += 1;
    const rel = frame.prefix === "" ? name : `${frame.prefix}/${name}`;
    const abs = join(frame.dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      out.push({ path: rel, kind: "link", target: readlinkSync(abs) });
      continue;
    }
    if (st.isDirectory()) {
      out.push({ path: rel, kind: "dir", mode: st.mode & MODE_MASK });
      if (stack.length >= MAX_TREE_DEPTH) {
        throw new Error(
          `beam: returned artifacts nest deeper than ${MAX_TREE_DEPTH} levels: ${abs}`,
        );
      }
      stack.push({ dir: abs, prefix: rel, names: readdirSync(abs).sort(), nextIndex: 0 });
      continue;
    }
    if (st.isFile()) {
      out.push({ path: rel, kind: "file", sha256: fileSha256(abs), mode: st.mode & MODE_MASK });
      continue;
    }
    throw new Error(`beam: returned artifacts contain an unsupported filesystem entry: ${abs}`);
  }
  return out;
}

function entriesEqual(a: TreeEntry[], b: TreeEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.path !== y.path || x.kind !== y.kind) return false;
    if (x.kind === "file" && y.kind === "file") {
      if (x.sha256 !== y.sha256 || x.mode !== y.mode) return false;
    }
    if (x.kind === "dir" && y.kind === "dir" && x.mode !== y.mode) return false;
    if (x.kind === "link" && y.kind === "link" && x.target !== y.target) return false;
  }
  return true;
}

/** Returned artifacts manifest of a staged dir, or undefined when none came back. */
function stagedArtifacts(stageDir: string): TreeEntry[] | undefined {
  const dir = join(stageDir, "artifacts");
  return existsSync(dir) ? treeEntries(dir) : undefined;
}

function artifactsEqual(a: TreeEntry[] | undefined, b: TreeEntry[] | undefined): boolean {
  if ((a === undefined) !== (b === undefined)) return false;
  return a === undefined || entriesEqual(a, b!);
}

/**
 * Prove the remote sat still across the fetch window: stage it a SECOND
 * time and require byte-identical results (raw transcript digest and
 * artifacts tree). A detached writer (nohup, a process that survived the
 * agent stop) still appending would otherwise hand the collection a torn
 * snapshot recorded as if it were one coherent remote state. Two agreeing
 * fetches bound the exposure to a writer that paused across both; the
 * receipt then pins those exact bytes and every retry re-fetches and
 * re-binds them.
 */
async function assertRemoteStable(
  adapter: SessionAdapter,
  t: Transport,
  session: LocalSession,
  record: BeamRecord,
  staged: StagedReturn,
  stageDir: string,
): Promise<void> {
  const verifyDir = `${stageDir}.verify`;
  rmSync(verifyDir, { recursive: true, force: true });
  mkdirSync(verifyDir, { recursive: true, mode: 0o700 });
  try {
    const second = await adapter.stageReturn(
      t,
      session,
      record.localCwd,
      record.remoteCwd,
      verifyDir,
    );
    const agree =
      staged.remoteSessionSha256 === second.remoteSessionSha256 &&
      (lstatSync(join(stageDir, "session.jsonl")).mode & MODE_MASK) ===
        (lstatSync(join(verifyDir, "session.jsonl")).mode & MODE_MASK) &&
      artifactsEqual(stagedArtifacts(stageDir), stagedArtifacts(verifyDir));
    if (!agree) {
      throw new Error(
        "beam down: the remote session changed between two consecutive fetches — " +
          `a writer is still active on ${t.label}:${record.remoteCwd}. ` +
          `Stop the remote agent (\`beam attach ${record.id}\`) and retry beam down`,
      );
    }
  } finally {
    rmSync(verifyDir, { recursive: true, force: true });
  }
}

/**
 * Does the durable return a receipt points at still hold its exact
 * receipted content — bytes AND normalized modes? A chmod'd return is
 * damaged and gets recollected. Only strictly current receipt versions are
 * ever intact. Only outright absence (ENOENT — the user deleted the
 * return) reads as not-intact; any other filesystem fault (EACCES, EIO,
 * ENOTDIR, ...) is a real error and propagates instead of silently
 * triggering a recollection over a return that may still exist.
 */
function returnIntact(receipt: CollectReceipt): boolean {
  if (receipt.version !== RECEIPT_VERSION) return false;
  const file = join(receipt.returnDir, "session.jsonl");
  try {
    if (fileSha256(file) !== receipt.session.sha256) return false;
    if ((lstatSync(file).mode & MODE_MASK) !== receipt.session.mode) return false;
    return artifactsEqual(stagedArtifacts(receipt.returnDir), receipt.artifacts);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return false;
  }
}

/**
 * The return-stage transaction root: shared with the workspace stage when
 * `beam down` created one for this run, otherwise created here with the
 * same convention. Either way the caller's `session/` subdirectory is
 * exclusively its own, created create-only — a collision must fail loudly,
 * never reuse.
 */
function collectReturnRoot(options: {
  env: BeamEnv;
  recordId: string;
  stageRoot?: string;
}): { root: string; ownsRoot: boolean } {
  const { env, recordId, stageRoot } = options;
  if (stageRoot === undefined) {
    // Every parent down to the txn root is a proven private (0700) Beam
    // directory; the transcript must never be readable by other local users.
    const parent = ensurePrivateBeamDir(env.beamDir, "returns", recordId);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const root = join(parent, `${stamp}-${randomBytes(4).toString("hex")}`);
    mkdirSync(root, { mode: 0o700 }); // non-recursive: throws on the (astronomical) collision
    return { root, ownsRoot: true };
  }
  // A shared txn root (the workspace stage) must satisfy the same private
  // chain: 0700 owned real directories end to end, no symlinked or
  // foreign component — insecure pre-existing paths refuse.
  ensurePrivateBeamDir(env.beamDir, "returns", recordId);
  ensurePrivateBeamDir(stageRoot);
  return { root: stageRoot, ownsRoot: false };
}

/**
 * The durable receipt for a freshly staged and proven return directory:
 * exact returned digests plus the raw remote digest that retries re-bind.
 */
function collectReturnReceipt(options: {
  txn: string;
  dir: string;
  staged: StagedReturn;
}): CollectReceipt {
  const { txn, dir, staged } = options;
  const receipt: CollectReceipt = {
    version: RECEIPT_VERSION,
    txn,
    returnDir: dir,
    session: {
      sha256: fileSha256(join(dir, "session.jsonl")),
      mode: lstatSync(join(dir, "session.jsonl")).mode & MODE_MASK,
    },
    remoteSession: { sha256: staged.remoteSessionSha256 },
    hint: staged.hint,
    createdAt: new Date().toISOString(),
  };
  const artifacts = stagedArtifacts(dir);
  if (artifacts) receipt.artifacts = artifacts;
  return receipt;
}

/**
 * Collect the remote session return into a fresh create-only transaction
 * directory under `<beamDir>/returns/<recordId>/`, prove identity and
 * stability, then either journal it as the record's durable return or —
 * when it is byte-identical to the intact return the record already points
 * at — discard the duplicate and report the collection already done. The
 * local harness store is never read for authority and never written.
 */
export async function collectSessionReturn(
  env: BeamEnv,
  record: BeamRecord,
  adapter: SessionAdapter,
  t: Transport,
  stageRoot?: string,
): Promise<CollectOutcome> {
  const { tool, sessionId, sessionFile } = record;
  if (!tool || !sessionId || !sessionFile) {
    throw new Error(`handoff ${record.id} carries no session to collect`);
  }
  const session: LocalSession = {
    tool,
    id: sessionId,
    file: sessionFile,
    artifactsDir: record.artifactsDir,
    mtime: 0,
  };

  const { root, ownsRoot } = collectReturnRoot({ env, recordId: record.id, stageRoot });
  const txn = basename(root);
  const dir = join(root, "session");
  mkdirSync(dir, { mode: 0o700 });

  let staged: StagedReturn;
  try {
    staged = await adapter.stageReturn(t, session, record.localCwd, record.remoteCwd, dir);
    await assertRemoteStable(adapter, t, session, record, staged, dir);
    // The returned transcript is private data: 0600, like every receipt.
    // (Artifact entries keep their returned modes — the 0700 directory
    // chain above already blocks disclosure — so executable bits survive.)
    chmodSync(join(dir, "session.jsonl"), 0o600);
  } catch (err) {
    // Nothing was journaled: an unreferenced partial is never trusted data.
    rmSync(ownsRoot ? root : dir, { recursive: true, force: true });
    throw err;
  }

  // An intact prior return holding exactly this remote state makes the new
  // fetch a duplicate: keep the durable original, drop the copy.
  const prior = record.collect;
  if (
    prior &&
    returnIntact(prior) &&
    staged.remoteSessionSha256 === prior.remoteSession.sha256 &&
    artifactsEqual(stagedArtifacts(dir), prior.artifacts)
  ) {
    rmSync(ownsRoot ? root : dir, { recursive: true, force: true });
    return { hint: prior.hint, alreadyCollected: true, returnDir: prior.returnDir };
  }

  const receipt = collectReturnReceipt({ txn, dir, staged });
  // The receipt is the completion marker: journaled only now, with the
  // return fully staged and proven. Prior returns stay on disk untouched.
  updateRecord(env, record.id, { collect: receipt });
  return { hint: receipt.hint, alreadyCollected: false, returnDir: dir };
}
