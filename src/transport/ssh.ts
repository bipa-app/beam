import { dirname } from "node:path";
import { run, runChecked, shq, shqRemotePath } from "../util/shell.ts";
import { noFollowSyncRootGuard } from "../workspace.ts";
import type { ExecResult, SyncOptions, Transport } from "./types.ts";

const DEFAULT_RSYNC_FLAGS = ["-a", "-z"];

/**
 * Transport over plain `ssh`/`rsync`/`scp`. The host is any ssh destination,
 * so ~/.ssh/config aliases, jump hosts, and keys all work unchanged.
 */
export class SshTransport implements Transport {
  readonly label: string;

  constructor(
    private readonly host: string,
    private readonly rsyncFlags: string[] = DEFAULT_RSYNC_FLAGS,
  ) {
    this.label = `ssh ${host}`;
  }

  /** rsync/scp interpret non-absolute remote paths relative to the remote home. */
  private remoteArg(p: string): string {
    if (p === "~") return ".";
    return p.startsWith("~/") ? p.slice(2) : p;
  }

  async exec(command: string): Promise<ExecResult> {
    return run(["ssh", this.host, "--", "bash", "-lc", shq(command)]);
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

  async syncUp(localDir: string, remoteDir: string, opts: SyncOptions = {}): Promise<void> {
    // No-follow guard in the same remote shell as the mkdir: rsync's
    // trailing-slash destination writes THROUGH a symlinked final component,
    // so a swapped workspace path must refuse before the transfer starts.
    // Commands prove full physical containment separately (workspace.ts);
    // this keeps the guard adjacent to the transfer itself.
    await this.execChecked(`${noFollowSyncRootGuard(remoteDir)}\nmkdir -p ${shqRemotePath(remoteDir)}`);
    await this.rsync(localDir.replace(/\/*$/, "/"), `${this.host}:${this.remoteArg(remoteDir)}/`, opts);
  }

  async syncDown(remoteDir: string, localDir: string, opts: SyncOptions = {}): Promise<void> {
    // Same guard on the source: never read a workspace through a symlink a
    // swap left at its path — the mirror must collect the exact directory
    // the record proved contained.
    await this.execChecked(noFollowSyncRootGuard(remoteDir));
    await runChecked(["mkdir", "-p", localDir]);
    await this.rsync(`${this.host}:${this.remoteArg(remoteDir)}/`, localDir.replace(/\/*$/, "/"), opts);
  }

  async sendFile(localPath: string, remotePath: string): Promise<void> {
    await this.execChecked(`mkdir -p ${shqRemotePath(dirname(remotePath))}`);
    await runChecked(["scp", "-q", localPath, `${this.host}:${this.remoteArg(remotePath)}`]);
  }

  async fetchFile(remotePath: string, localPath: string): Promise<void> {
    await runChecked(["mkdir", "-p", dirname(localPath)]);
    await runChecked(["scp", "-q", `${this.host}:${this.remoteArg(remotePath)}`, localPath]);
  }

  async exists(remotePath: string): Promise<boolean> {
    const probe = `test -e ${shqRemotePath(remotePath)}`;
    const res = await this.exec(probe);
    if (res.code === 0) return true;
    if (res.code === 1) return false;
    // ssh reserves 255 for its own failures (DNS, auth, a dropped
    // connection), and `test` exits >1 on usage errors — neither is a remote
    // "no". Absence answers authorize skipping collection steps and, further
    // up, purging, so anything but a clean yes/no is an outage that must
    // abort the caller instead of masquerading as an absent file.
    const detail = (res.stderr || res.stdout).trim();
    throw new Error(
      `[${this.label}] existence probe did not answer (${res.code}): ${probe}${detail ? `\n${detail}` : ""}`,
    );
  }

  interactiveArgv(command: string): string[] {
    return ["ssh", "-t", this.host, "--", "bash", "-lc", shq(command)];
  }
}
