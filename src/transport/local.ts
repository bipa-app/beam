import { copyFileSync, existsSync, mkdirSync } from "node:fs";
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
      ...(opts.excludes ?? []).map((e) => `--exclude=${e}`),
      source,
      dest,
    ];
    await runChecked(argv, { interactive: opts.verbose === true });
  }

  async syncUp(localDir: string, remoteDir: string, opts: SyncOptions = {}): Promise<void> {
    const dest = this.resolve(remoteDir);
    mkdirSync(dest, { recursive: true });
    await this.rsync(localDir.replace(/\/*$/, "/"), dest.replace(/\/*$/, "/"), opts);
  }

  async syncDown(remoteDir: string, localDir: string, opts: SyncOptions = {}): Promise<void> {
    mkdirSync(localDir, { recursive: true });
    await this.rsync(this.resolve(remoteDir).replace(/\/*$/, "/"), localDir.replace(/\/*$/, "/"), opts);
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

  interactiveArgv(command: string): string[] {
    return ["bash", "-lc", command];
  }
}
