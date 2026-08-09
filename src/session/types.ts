import type { Transport } from "../transport/types.ts";

export type ToolName = "omp" | "pi" | "claude" | "codex";

/** A session found in a harness's local store. */
export interface LocalSession {
  tool: ToolName;
  /** Harness-native session id. */
  id: string;
  /** Absolute path of the session transcript in the local store. */
  file: string;
  /** omp: sibling artifacts directory (subagent transcripts, blobs). */
  artifactsDir?: string;
  mtime: number;
}

export interface InstalledSession {
  /** argv to run inside the remote workspace to resume the session. */
  resumeArgv: string[];
  notes: string[];
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
   * `remoteCwd` (absolute). Returns the resume command.
   */
  install(
    t: Transport,
    session: LocalSession,
    remoteCwd: string,
    kickoff?: string,
  ): Promise<InstalledSession>;
  /**
   * After `beam down` synced the workspace back, import the (grown)
   * transcript into the local store. Returns a resume hint for the user.
   */
  collect(
    t: Transport,
    session: LocalSession,
    localCwd: string,
    remoteCwd: string,
  ): Promise<string>;
  /**
   * Remove every trace the install left OUTSIDE the workspace (the
   * workspace itself is purged by `beam down`/`kill --purge`). Transcripts
   * carry the whole conversation, so leaving them on the target is a leak.
   */
  cleanupRemote(t: Transport, session: LocalSession, remoteCwd: string): Promise<void>;
}
