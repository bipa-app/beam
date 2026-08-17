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
  /**
   * Mirror deletions (rsync --delete). A transport MUST throw on a
   * `delete` syncUp before any remote mutation unless it implements exact
   * rsync exclude-protected deletion (kubectl tar ships refuse; ssh/local
   * rsync support it). syncDown mirrors are supported everywhere: the
   * deletion always runs as a local rsync.
   */
  delete?: boolean;
  /** Compare file contents, not only size and mtime (rsync --checksum). */
  checksum?: boolean;
  /** Stream rsync output to the terminal. */
  verbose?: boolean;
  /**
   * Earn the transport's mirror license for this exact destination on
   * success (kubectl: the out-of-tree sync marker a later mirrored
   * syncDown of the SAME destination requires). Opt-in: only destinations
   * that are mirrored back set it — staging ships whose trees are moved,
   * published, or discarded must not, so transport metadata can never ride
   * into session stores or byte-exact payloads. Every syncUp attempt still
   * invalidates the destination's existing license first, licensed or not.
   * Transports without marker semantics (ssh, local) ignore it.
   */
  license?: boolean;
  /**
   * Owned-workspace guard: the transfer process itself enters and PINS
   * `root` as its cwd, verifies `<root>/.beam/owner` holds exactly
   * `ownerBytes` in that same shell, and only then transfers against
   * `.`/relative operands inside the held directory. A swapped path or a
   * foreign/replaced owner marker refuses before a single byte moves —
   * a separate pre-assert cannot close that window. For nested
   * destinations (e.g. `.beam/git/<generation>`), `root` stays the
   * workspace and the destination is validated relative below it.
   */
  owned?: { root: string; ownerBytes: string };
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
  /** True when the target path exists. */
  exists(remotePath: string): Promise<boolean>;
  /**
   * Proof that a prior `license: true` syncUp to EXACTLY this destination
   * COMPLETED (its out-of-tree marker is intact and matches), probed on
   * the target — never a local cache. A pre-pointer provisioning retry may
   * skip the destructive mirror ONLY on this proof; transports without
   * marker semantics leave it undefined and such retries fail closed
   * instead of re-running a `--delete` sync over ambiguous partial remote
   * state.
   */
  syncLicense?(remoteDir: string): Promise<boolean>;
  /** Argv for an interactive command on the target (inherits the user's tty). */
  interactiveArgv(command: string): string[];
}
