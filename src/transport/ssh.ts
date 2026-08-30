import { run, runChecked, shjoin, shq, shqRemotePath } from "../util/shell.ts";
import { ownedDestinationScript } from "../workspace.ts";
import type { ExecResult, SyncOptions, Transport } from "./types.ts";

const DEFAULT_RSYNC_FLAGS = ["-a", "-z"];

export interface SshTransportOptions {
  rsyncFlags?: string[];
  /** Provider-owned SSH argv inserted before the destination. */
  sshOptions?: string[];
  /** Provider-facing label when a raw address is only an implementation detail. */
  label?: string;
}

/**
 * Transport over plain `ssh`/`rsync`/`scp`. The host is any ssh destination,
 * so ~/.ssh/config aliases, jump hosts, and keys all work unchanged.
 */
export class SshTransport implements Transport {
  readonly label: string;
  private readonly rsyncFlags: string[];
  private readonly sshOptions: string[];

  constructor(
    private readonly host: string,
    options: SshTransportOptions = {},
  ) {
    // The host is config-sourced and becomes a positional ssh/rsync/scp
    // argument. Refuse anything ssh would parse as an option BEFORE any
    // argv is built — `-oProxyCommand=...` as a "host" is command injection.
    if (host === "") {
      throw new Error(
        "beam: ssh host is empty — set the target's host to an ssh destination " +
          "(host, user@host, or a ~/.ssh/config alias)",
      );
    }
    if (host.startsWith("-")) {
      throw new Error(
        `beam: ssh host ${JSON.stringify(host)} starts with '-' and would be read ` +
          "as an ssh option, not a destination — use a plain host, user@host, or " +
          "a ~/.ssh/config alias",
      );
    }
    this.label = options.label ?? `ssh ${host}`;
    this.rsyncFlags = options.rsyncFlags ?? DEFAULT_RSYNC_FLAGS;
    this.sshOptions = options.sshOptions ?? [];
  }

  /**
   * No-follow descent to `$__beam_expected` (assigned by the caller), with
   * the shell's own cwd as the pin. Starting at `/`, every component is
   * checked and entered RELATIVELY from the already-verified parent, and
   * each hop is re-proven with `pwd -P` equality against the accumulated
   * expected path — so no step ever passes through a replaced symlink, and
   * a swap of any ancestor between the check and the `cd` still fails on
   * the physical mismatch. With `create`, a missing component is made with
   * plain `mkdir` relative to the pinned parent cwd — never `mkdir -p` on
   * an unverified absolute path, so nothing is ever created outside a
   * verified parent (the P1 window the old precheck left open). The shell
   * ends inside the proven directory; later lines MUST stay `./`-relative.
   */
  private pinnedWalkScript(create: boolean): string {
    const verb = create ? "create" : "enter";
    const missingExit = create ? "46" : "47";
    return [
      `case "$__beam_expected" in /?*) ;; *) echo` +
        ` "beam: remote path is not absolute: $__beam_expected" >&2; exit 62;; esac`,
      `cd / || exit 47`,
      `__beam_path=`,
      `__beam_ifs="\${IFS-}"; IFS=/; set -f`,
      `for __beam_seg in \${__beam_expected#/}; do`,
      `  set +f; IFS="$__beam_ifs"`,
      `  case "$__beam_seg" in ''|.|..)` +
        ` echo "beam: suspicious path segment in $__beam_expected" >&2; exit 44 ;; esac`,
      `  __beam_path="$__beam_path/$__beam_seg"`,
      `  if [ -L "./$__beam_seg" ]; then echo` +
        ` "beam: refusing to sync through symlinked path: $__beam_path" >&2; exit 61; fi`,
      ...(create
        ? [`  if [ ! -e "./$__beam_seg" ]; then mkdir -- "./$__beam_seg" 2>/dev/null || true; fi`]
        : []),
      `  if [ -L "./$__beam_seg" ]; then echo` +
        ` "beam: refusing to sync through symlinked path: $__beam_path" >&2; exit 61; fi`,
      `  if [ ! -e "./$__beam_seg" ]; then echo` +
        ` "beam: cannot ${verb} workspace $__beam_path" >&2; exit ${missingExit}; fi`,
      `  cd -- "./$__beam_seg" 2>/dev/null` +
        ` || { echo "beam: cannot enter workspace $__beam_path" >&2; exit 47; }`,
      `  if [ "$(/bin/pwd -P)" != "$__beam_path" ]; then echo` +
        ` "beam: workspace $__beam_path physically resolves to $(/bin/pwd -P) — refusing"` +
        ` >&2; exit 48; fi`,
      `done`,
      `set +f; IFS="$__beam_ifs"`,
      `if [ "$(/bin/pwd -P)" != "$__beam_expected" ]; then echo` +
        ` "beam: workspace $__beam_expected physically resolves to $(/bin/pwd -P) — refusing"` +
        ` >&2; exit 48; fi`,
    ].join("\n");
  }


  /**
   * Enter the proved workspace inside the remote rsync process itself.
   *
   * The endpoint passed to rsync is always `.`. The pinned walk descends
   * to the persisted absolute path component-by-component without ever
   * following (or creating through) a replaced symlink; once it holds the
   * directory inode as cwd, a later rename/symlink swap cannot redirect
   * the transfer. `--rsync-path` makes this proof and the transfer one SSH
   * operation instead of two raceable connections. With `owned`, the SAME
   * process first pins the owned workspace root, verifies the exact
   * record-bound `.beam/owner` bytes there, and only then descends the
   * validated relative remainder to the destination — a foreign or
   * replaced workspace refuses before rsync ever runs.
   */
  private pinnedRsyncPath(
    remoteDir: string,
    create: boolean,
    owned?: { root: string; ownerBytes: string },
  ): string {
    // shqRemotePath lets a `~/`-prefixed target expand against the remote
    // $HOME into an absolute path before the walk; absolute paths embed
    // byte-identically to shq.
    let entry: string;
    if (owned !== undefined) {
      if (remoteDir !== owned.root && !remoteDir.startsWith(`${owned.root}/`)) {
        throw new Error(
          `beam: sync destination ${remoteDir} is not under its owned workspace ` +
            `${owned.root} — refusing`,
        );
      }
      const rel = remoteDir === owned.root ? [] : remoteDir.slice(owned.root.length + 1).split("/");
      entry = [
        `__beam_expected=${shqRemotePath(owned.root)}`,
        this.pinnedWalkScript(false),
        // Fused owner + destination descent (shared with every transport):
        // the owner bytes are verified while HOLDING the `.beam` inode and
        // the remaining components are entered no-follow from it — never a
        // guard-then-rewalk split a swap could slip between. The shell
        // ENDS at the destination.
        ownedDestinationScript(owned.ownerBytes, rel, { create }),
        // Nested reserved destinations stay 0700 THROUGH the transfer:
        // rsync `-a` re-applies the SOURCE root's mode to the held leaf,
        // so the shell re-tightens and re-verifies after rsync returns
        // (root transfers never chmod the user-owned workspace root).
        ...(rel.length === 0 || !create
          ? []
          : [
              `__beam_od_tighten() { chmod 700 .` +
                ` && [ -n "$(find . -prune -perm 700)" ]; }`,
            ]),
      ].join("\n");
      if (rel.length > 0 && create) {
        const script = [
          entry,
          `rsync "$@" <&3`,
          `__beam_rc=$?`,
          `__beam_od_tighten` +
            ` || { echo "beam: the reserved dir mode did not verify" >&2; exit 66; }`,
          `exit "$__beam_rc"`,
        ].join("\n");
        const payload = Buffer.from(script).toString("base64");
        return `exec 3<&0; printf %s ${payload} | base64 -d | bash -s --`;
      }
    } else {
      entry = [
        `__beam_expected=${shqRemotePath(remoteDir)}`,
        this.pinnedWalkScript(create),
      ].join("\n");
    }
    const script = [entry, `exec rsync "$@"`].join("\n");
    // rsync tokenizes --rsync-path before ssh joins those argv back into one
    // remote command. Send code as an alphanumeric payload. fd 3 preserves
    // SSH's protocol stdin while bash reads the decoded script from its pipe;
    // the script restores fd 3 for the final rsync process.
    const payload = Buffer.from(
      script.replace('exec rsync "$@"', 'exec rsync "$@" <&3'),
    ).toString("base64");
    return `exec 3<&0; printf %s ${payload} | base64 -d | bash -s --`;
  }

  async exec(command: string): Promise<ExecResult> {
    return run([
      "ssh", ...this.sshOptions, this.host, "--", "bash", "-lc", shq(command),
    ]);
  }

  async execChecked(command: string): Promise<string> {
    const res = await this.exec(command);
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim();
      throw new Error(
        `[${this.label}] command failed (${res.code}): ` +
          `${command}${detail ? `\n${detail}` : ""}`,
      );
    }
    return res.stdout.trim();
  }

  private async rsync(
    source: string,
    dest: string,
    opts: SyncOptions,
    remoteProgram?: string,
  ): Promise<void> {
    const argv = [
      "rsync",
      ...this.rsyncFlags,
      ...(opts.delete ? ["--delete"] : []),
      ...(opts.checksum ? ["--checksum"] : []),
      ...(opts.excludes ?? []).map((e) => `--exclude=${e}`),
      ...(remoteProgram === undefined ? [] : [`--rsync-path=${remoteProgram}`]),
      ...(this.sshOptions.length === 0
        ? []
        : [`--rsh=${shjoin(["ssh", ...this.sshOptions])}`]),
      source,
      dest,
    ];
    await runChecked(argv, { interactive: opts.verbose === true });
  }

  async syncUp(localDir: string, remoteDir: string, opts: SyncOptions = {}): Promise<void> {
    await this.rsync(
      localDir.replace(/\/*$/, "/"),
      `${this.host}:./`,
      opts,
      this.pinnedRsyncPath(remoteDir, true, opts.owned),
    );
  }

  async syncDown(remoteDir: string, localDir: string, opts: SyncOptions = {}): Promise<void> {
    await runChecked(["mkdir", "-p", localDir]);
    await this.rsync(
      `${this.host}:./`,
      localDir.replace(/\/*$/, "/"),
      opts,
      this.pinnedRsyncPath(remoteDir, false, opts.owned),
    );
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
      `[${this.label}] existence probe did not answer (${res.code}): ` +
        `${probe}${detail ? `\n${detail}` : ""}`,
    );
  }

  interactiveArgv(command: string): string[] {
    return [
      "ssh",
      ...this.sshOptions,
      "-t",
      this.host,
      "--",
      "bash",
      "-lc",
      shq(command),
    ];
  }
}
