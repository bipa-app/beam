/**
 * Transport: how beam reaches a target's filesystem and shell.
 *
 * Implementations must accept remote paths with a leading `~/` (resolved
 * against the remote home directory).
 */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SyncOptions {
  excludes?: string[];
  /** Mirror deletions (rsync --delete). */
  delete?: boolean;
  /** Compare file contents, not only size and mtime (rsync --checksum). */
  checksum?: boolean;
  /** Stream rsync output to the terminal. */
  verbose?: boolean;
}

export interface Transport {
  /** Human-readable destination, e.g. "ssh sandbox" or "local (home=…)". */
  readonly label: string;
  /**
   * Run a shell command on the target. Never throws on a nonzero REMOTE
   * exit — that comes back as `code`. MAY throw when the transport itself
   * fails to deliver the command or to prove the remote exit status
   * (see KubectlTransport's sentinel trailer), so an unreachable target is
   * never mistaken for a command that ran and said "no".
   */
  exec(command: string): Promise<ExecResult>;
  /** exec() that throws on nonzero exit and returns trimmed stdout. */
  execChecked(command: string): Promise<string>;
  /** Recursively sync a local directory to the target (trailing-slash semantics). */
  syncUp(localDir: string, remoteDir: string, opts?: SyncOptions): Promise<void>;
  /** Recursively sync a target directory back to a local one. */
  syncDown(remoteDir: string, localDir: string, opts?: SyncOptions): Promise<void>;
  /** Copy one local file to the target, creating parent directories. */
  sendFile(localPath: string, remotePath: string): Promise<void>;
  /** Copy one target file to a local path, creating parent directories. */
  fetchFile(remotePath: string, localPath: string): Promise<void>;
  /** True when the target path exists. */
  exists(remotePath: string): Promise<boolean>;
  /** Argv for an interactive command on the target (inherits the user's tty). */
  interactiveArgv(command: string): string[];
}
