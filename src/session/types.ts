import type { Transport } from "../transport/types.ts";

export type ToolName = "omp" | "pi" | "claude" | "codex";

/** A session found in a harness's local store. */
export interface LocalSession {
  tool: ToolName;
  /** Harness-native session id. */
  id: string;
  /** Absolute path of the session transcript in the local store. */
  file: string;
  /**
   * Original store path when `file` points at a Beam-private staged copy
   * (the immutable ship-stage): `file` is the CONTENT source, this is the
   * LAYOUT source for adapters that mirror the local store layout on the
   * target (codex). Absent when `file` is the live store path itself.
   */
  storeFile?: string;
  /** omp: sibling artifacts directory (subagent transcripts, blobs). */
  artifactsDir?: string;
  mtime: number;
}

export interface InstalledSession {
  /** argv to run inside the remote workspace to resume the session. */
  resumeArgv: string[];
  notes: string[];
}

/** What `stageReturn` collected into the durable return stage. */
export interface StagedReturn {
  /**
   * How the user resumes from the returned session. omp/pi resume directly
   * against the staged path; Claude Code and Codex cannot resume from an
   * isolated path, so their hint is the exact MANUAL import command — beam
   * never writes into a live harness store.
   */
  hint: string;
  /**
   * sha256 of the remote transcript's RAW bytes as fetched (before any
   * header rewrite). The collection records it so a retry can re-fetch and
   * prove whether the remote advanced since the durable return was taken.
   */
  remoteSessionSha256: string;
}

/** Named options for `SessionAdapter.install`. */
export interface InstallOptions {
  /** First prompt handed to the harness's resume command. */
  kickoff?: string;
  /**
   * Deterministic reserved-stage key (the ship's journaled session
   * digest) for adapters that stage inside the workspace; a crashed
   * attempt's retry converges onto the same stage.
   */
  installKey?: string;
  /**
   * Exact `.beam/owner` bytes: the adapter re-proves ownership inside
   * the same shells that move session bytes.
   */
  owner?: string;
}

/**
 * SessionAdapter: everything beam needs to know about one coding harness.
 *
 * Adding support for a new harness means implementing this interface —
 * roughly: where sessions live, how to place one on the target, what
 * command resumes it, and how to import the grown transcript back.
 */
export interface SessionAdapter {
  readonly tool: ToolName;
  /** Binary expected on the target (checked by `beam doctor`). */
  readonly binary: string;
  /**
   * Interactive command that authenticates the harness on the target.
   * beam NEVER copies credentials between machines; `beam login` runs this
   * over the transport's interactive channel (ssh -t) instead.
   */
  readonly loginArgv: string[];
  /**
   * Optional cheap remote probe: exit 0 = authenticated. Best-effort —
   * absent when a harness has no file-detectable auth state.
   */
  readonly remoteAuthProbe?: string;
  /**
   * Find the session for `cwd` in the local store under `home`.
   * `sessionRef` narrows by id/filename prefix; otherwise newest wins.
   */
  locate(cwd: string, home: string, sessionRef?: string): Promise<LocalSession | undefined>;
  /**
   * Place the session on the target so it can be resumed from
   * `remoteCwd` (absolute). Returns the resume command. Idempotent and
   * create-only; adapters that stage inside the workspace key their
   * reserved stage by `options.installKey` (the ship's journaled session
   * digest), so a crashed attempt's retry converges onto the same stage
   * instead of littering the workspace.
   */
  install(
    t: Transport,
    session: LocalSession,
    remoteCwd: string,
    options?: InstallOptions,
  ): Promise<InstalledSession>;
  /**
   * Stage the (grown) remote session into `stageDir` — the durable
   * Beam-owned return home: validate its identity (session id + workspace),
   * then write the EXACT final transcript bytes to
   * `<stageDir>/session.jsonl` (header localized for local resume) and the
   * exact artifacts tree to `<stageDir>/artifacts` when the remote has one.
   * MUST NOT read or write the local harness store: the return lives and
   * stays under beam's own storage.
   */
  stageReturn(
    t: Transport,
    session: LocalSession,
    localCwd: string,
    remoteCwd: string,
    stageDir: string,
  ): Promise<StagedReturn>;
  /**
   * Remove every trace the install left OUTSIDE the workspace (the
   * workspace itself is purged by `beam kill --purge`). Transcripts
   * carry the whole conversation, so leaving them on the target is a leak.
   */
  cleanupRemote(t: Transport, session: LocalSession, remoteCwd: string): Promise<void>;
}
