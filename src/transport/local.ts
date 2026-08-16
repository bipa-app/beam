import { copyFileSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { run, runChecked } from "../util/shell.ts";
import type { ExecResult, SyncOptions, Transport } from "./types.ts";

const DEFAULT_RSYNC_FLAGS = ["-a"];

/**
 * Transport where the "remote" is a directory on this machine.
 * Useful for tests and for sandboxing into a local container mount.
 *
 * `home` substitutes for the remote home directory: `~/x` resolves under it,
 * and `bash -lc` runs with HOME overridden so harness stores land there.
 */
export class LocalTransport implements Transport {
  readonly label: string;

  constructor(
    private readonly home: string = homedir(),
    private readonly rsyncFlags: string[] = DEFAULT_RSYNC_FLAGS,
  ) {
    this.label = `local (home=${home})`;
  }

  /** Resolve a `~/`-prefixed path against the transport's home. */
  resolve(p: string): string {
    if (p === "~") return this.home;
    return p.startsWith("~/") ? join(this.home, p.slice(2)) : p;
  }

  async exec(command: string): Promise<ExecResult> {
    return run(["bash", "-lc", command], { env: { HOME: this.home } });
  }

  async execChecked(command: string): Promise<string> {
    const res = await this.exec(command);
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim();
      throw new Error(`[${this.label}] command failed (${res.code}): ${command}${detail ? `\n${detail}` : ""}`);
    }
    return res.stdout.trim();
  }

  private async rsync(source: string, dest: string, opts: SyncOptions): Promise<void> {
    const argv = [
      "rsync",
      ...this.rsyncFlags,
      ...(opts.delete ? ["--delete"] : []),
      ...(opts.checksum ? ["--checksum"] : []),
      ...(opts.excludes ?? []).map((e) => `--exclude=${e}`),
      source,
      dest,
    ];
    await runChecked(argv, { interactive: opts.verbose === true });
  }

  /**
   * No-follow guard mirroring the remote transports: rsync's trailing-slash
   * form writes through (or reads through) a symlinked final component, so
   * a workspace path swapped for a symlink refuses here. Commands prove
   * full physical containment under the configured root separately
   * (workspace.ts); this guards the transfer's own destination/source hop.
   */
  private assertNoFollowSyncRoot(dir: string): void {
    if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`[${this.label}] refusing to sync through symlinked path: ${dir}`);
    }
  }

  async syncUp(localDir: string, remoteDir: string, opts: SyncOptions = {}): Promise<void> {
    const dest = this.resolve(remoteDir);
    this.assertNoFollowSyncRoot(dest);
    mkdirSync(dest, { recursive: true });
    await this.rsync(localDir.replace(/\/*$/, "/"), dest.replace(/\/*$/, "/"), opts);
  }

  async syncDown(remoteDir: string, localDir: string, opts: SyncOptions = {}): Promise<void> {
    const src = this.resolve(remoteDir);
    this.assertNoFollowSyncRoot(src);
    mkdirSync(localDir, { recursive: true });
    await this.rsync(src.replace(/\/*$/, "/"), localDir.replace(/\/*$/, "/"), opts);
  }

  async sendFile(localPath: string, remotePath: string): Promise<void> {
    const dest = this.resolve(remotePath);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(localPath, dest);
  }

  async fetchFile(remotePath: string, localPath: string): Promise<void> {
    mkdirSync(dirname(localPath), { recursive: true });
    copyFileSync(this.resolve(remotePath), localPath);
  }

  async exists(remotePath: string): Promise<boolean> {
    return existsSync(this.resolve(remotePath));
  }

  /**
   * Argv for an interactive command on the target. `env HOME=...` pins the
   * isolated home exactly like `exec` does, so an interactive login writes
   * harness auth into the target home, never the caller's. argv is spawned
   * without a shell, so the assignment needs no quoting — spaces and shell
   * metacharacters in `home` survive verbatim — and `command` stays a
   * single untouched argument to `bash -lc` (same tty semantics as before).
   */
  interactiveArgv(command: string): string[] {
    return ["env", `HOME=${this.home}`, "bash", "-lc", command];
  }
}
