import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, parse, resolve } from "node:path";
import { homedir } from "node:os";
import { run, runChecked, shq } from "../util/shell.ts";
import type { ExecResult, SyncOptions, Transport } from "./types.ts";
import { ownedDestinationScript } from "../workspace.ts";

/**
 * Held-cwd component walk that creates the missing tail of `absolute`,
 * emitted as per-component blocks (exported for adversarial interleave
 * tests; production joins them into ONE bash invocation). Each component
 * is lstat'd no-follow, created with a RELATIVE `mkdir -- <segment>` in
 * the held parent inode when absent, entered with `cd -P`, and re-proven
 * as the exact physical child of the accumulated prefix. No absolute
 * pathname is ever mutated after a proof: a parent swapped to a symlink
 * mid-walk redirects nothing — the relative mkdir lands inside the held
 * (verified) parent inode and the reproof refuses before anything else.
 */
export function createWalkBlocks(absolute: string): string[] {
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split("/").filter(Boolean);
  const blocks = [
    [
      `cd -P -- ${shq(root)} 2>/dev/null` +
        ` || { echo ${shq(`beam: cannot enter ${root}`)} >&2; exit 66; }`,
      `__beam_prefix=${shq(root === "/" ? "" : root.replace(/\/+$/, ""))}`,
    ].join("\n"),
  ];
  for (const segment of segments) {
    const q = shq(segment);
    const refuseLink = shq(
      `beam: refusing to create through symlinked path component: ${segment}`,
    );
    const refuseKind = shq(
      `beam: refusing to create through non-directory path component: ${segment}`,
    );
    const cannotCreate = shq(`beam: cannot create ${segment}`);
    const cannotEnter = shq(`beam: cannot enter ${segment}`);
    blocks.push(
      [
        `if [ -L ${q} ]; then echo ${refuseLink} >&2; exit 61; fi`,
        `if [ ! -e ${q} ]; then mkdir -- ${q} || { echo ${cannotCreate} >&2; exit 66; }; fi`,
        `if [ -L ${q} ] || [ ! -d ${q} ]; then echo ${refuseKind} >&2; exit 61; fi`,
        `cd -P -- ${q} 2>/dev/null || { echo ${cannotEnter} >&2; exit 66; }`,
        `__beam_prefix="$__beam_prefix"/${q}`,
        `if [ "$(/bin/pwd -P)" != "$__beam_prefix" ]; then echo ${shq(
          `beam: ${segment} no longer resolves to its pinned physical directory — refusing`,
        )} >&2; exit 66; fi`,
      ].join("\n"),
    );
  }
  return blocks;
}

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

  /** Canonical (realpath) home — the authority for path resolution and physical pins. */
  private readonly home: string;
  /** Home exactly as configured — the string surfaced to child processes as $HOME. */
  private readonly lexicalHome: string;

  constructor(
    home: string = homedir(),
    private readonly rsyncFlags: string[] = DEFAULT_RSYNC_FLAGS,
  ) {
    this.lexicalHome = resolve(home);
    try {
      this.home = realpathSync(home);
    } catch (err) {
      // Config-sourced path, so a missing directory is the user's fault,
      // not a beam invariant: name the path and the remedy, keep the
      // filesystem error attached for diagnosis.
      throw new Error(
        `beam: local transport home does not resolve: ${this.lexicalHome} — ` +
          "create that directory or point the target's home at an existing one",
        { cause: err },
      );
    }
    this.label = `local (home=${this.lexicalHome})`;
  }

  /** Resolve a `~/`-prefixed path against the transport's home. */
  resolve(p: string): string {
    if (p === "~") return this.home;
    if (p.startsWith("~/")) return join(this.home, p.slice(2));
    const absolute = resolve(p);
    if (absolute === this.lexicalHome) return this.home;
    if (absolute.startsWith(`${this.lexicalHome}/`)) {
      return join(this.home, absolute.slice(this.lexicalHome.length + 1));
    }
    return absolute;
  }

  async exec(command: string): Promise<ExecResult> {
    // Child processes see the home AS CONFIGURED (it aliases the same
    // physical directory); canonicalization stays an internal concern of
    // path resolution and the pinned-directory proofs.
    return run(["bash", "-lc", command], { env: { HOME: this.lexicalHome } });
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

  private rsyncArgs(opts: SyncOptions): string[] {
    return [
      "rsync",
      ...this.rsyncFlags,
      ...(opts.delete ? ["--delete"] : []),
      ...(opts.checksum ? ["--checksum"] : []),
      ...(opts.excludes ?? []).map((e) => `--exclude=${e}`),
    ];
  }

  /**
   * Create the missing tail of a destination in ONE bash process holding
   * each verified parent as its cwd (see createWalkBlocks) — never an
   * absolute mkdir after a separate precheck, so a parent swapped to a
   * symlink mid-walk cannot draw a create outside the verified tree.
   */
  private async createMissing(absolute: string): Promise<void> {
    await runChecked(["bash", "-c", createWalkBlocks(absolute).join("\n")]);
  }

  /**
   * Reject every symlinked component and require the directory to BE its
   * own physical path — the persisted expected canonical path is the
   * authority, never a realpath computed after the fact (a swapped path
   * must fail, not relabel the destination as whatever the link points
   * at). Verification only — creation goes through createMissing's
   * held-cwd walk. The transfer then enters the directory and checks
   * `pwd -P` in the SAME shell that execs rsync, so a swap after this
   * walk still cannot redirect the operation.
   */
  private pinnedDirectory(dir: string): string {
    const absolute = resolve(dir);
    const root = parse(absolute).root;
    let cursor = root;
    for (const component of absolute.slice(root.length).split("/").filter(Boolean)) {
      cursor = join(cursor, component);
      const st = lstatSync(cursor, { throwIfNoEntry: false });
      if (st?.isSymbolicLink()) {
        throw new Error(
          `[${this.label}] refusing to sync through symlinked path component: ${cursor}`,
        );
      }
      if (st === undefined) break; // reported as missing below
    }
    const st = lstatSync(absolute, { throwIfNoEntry: false });
    if (!st?.isDirectory() || st.isSymbolicLink()) {
      const kind = st === undefined
        ? "No such file or directory"
        : "refusing to sync through non-directory path";
      throw new Error(`[${this.label}] ${kind}: ${absolute}`);
    }
    const physical = realpathSync(absolute);
    if (physical !== absolute) {
      throw new Error(
        `[${this.label}] ${absolute} physically resolves to ${physical}` +
          ` — path swapped or symlinked; refusing`,
      );
    }
    return absolute;
  }

  /**
   * Enter the walked directory and re-prove its identity in the SAME shell
   * that execs rsync: `cd -P` + kernel-truth `/bin/pwd -P` equality (the
   * pwd BUILTIN canonicalizes the cached $PWD and misses renames) against
   * the pinned path is the final authority, so a swap between the walk and
   * the transfer fails
   * instead of redirecting it. `argv` references the directory only as `.`.
   * With `owned`, the same shell FIRST pins the owned workspace root and
   * verifies the exact record-bound `.beam/owner` bytes there before
   * entering the (validated-relative) destination — a foreign or replaced
   * workspace refuses before rsync ever runs.
   */
  private async rsyncThroughPinnedDir(
    pinnedDir: string,
    argv: string[],
    opts: SyncOptions,
    ensureLocalDir?: string,
  ): Promise<void> {
    // Collections create the local destination INSIDE the same shell,
    // AFTER the pin — a refused source leaves zero local bytes.
    const ensure =
      ensureLocalDir === undefined ? "" : `mkdir -p -- ${shq(ensureLocalDir)} || exit 66; `;
    const script =
      'dir=$1; shift; cd -P -- "$dir" || exit 66; ' +
      '[ "$(/bin/pwd -P)" = "$dir" ] || { echo "beam: local sync path changed" >&2; exit 66; }; ' +
      `${ensure}exec "$@"`;
    await runChecked(["bash", "-c", script, "beam-local-rsync", pinnedDir, ...argv], {
      interactive: opts.verbose === true,
    });
  }

  /**
   * Owned transfer: ONE shell pins the owned workspace root, then runs the
   * fused owner + destination descent (shared with every transport) — the
   * record's owner bytes are verified while HOLDING the `.beam` inode and
   * the remaining components are entered no-follow from it, created
   * relative to their held parent on the upload side. The shell ENDS at
   * the destination and execs rsync there (`.`), so nothing between the
   * proof and the transfer can rewalk a pathname.
   */
  private async rsyncThroughOwnedDir(
    absolute: string,
    owned: { root: string; ownerBytes: string },
    argv: string[],
    opts: SyncOptions,
    create: boolean,
    ensureLocalDir?: string,
  ): Promise<void> {
    const ownedRoot = this.pinnedDirectory(this.resolve(owned.root));
    if (absolute !== ownedRoot && !absolute.startsWith(`${ownedRoot}/`)) {
      throw new Error(
        `[${this.label}] sync destination ${absolute} is not under its owned workspace ` +
          `${ownedRoot} — refusing`,
      );
    }
    const rel = absolute === ownedRoot ? [] : absolute.slice(ownedRoot.length + 1).split("/");
    // Nested reserved destinations stay 0700 THROUGH the transfer: rsync
    // `-a` re-applies the SOURCE root's mode to the held leaf, so the
    // shell re-tightens and re-verifies after rsync returns (root
    // transfers never chmod the user-owned workspace root).
    const run_ =
      rel.length === 0 || !create
        ? 'exec "$@"'
        : [
            '"$@"',
            "__beam_rc=$?",
            'chmod 700 . || { echo "beam: cannot restore the reserved dir mode" >&2; exit 66; }',
            '[ -n "$(find . -prune -perm 700)" ]' +
              ' || { echo "beam: the reserved dir mode did not verify" >&2; exit 66; }',
            'exit "$__beam_rc"',
          ].join("\n");
    const script = [
      'root=$1; shift; cd -P -- "$root" || exit 66',
      '[ "$(/bin/pwd -P)" = "$root" ] || { echo "beam: local sync path changed" >&2; exit 66; }',
      ownedDestinationScript(owned.ownerBytes, rel, { create }),
      // Collections create the local destination only AFTER the fused
      // owner + destination proof — a refusal leaves zero local bytes.
      ...(ensureLocalDir === undefined ? [] : [`mkdir -p -- ${shq(ensureLocalDir)} || exit 66`]),
      run_,
    ].join("\n");
    await runChecked(["bash", "-c", script, "beam-local-rsync", ownedRoot, ...argv], {
      interactive: opts.verbose === true,
    });
  }

  async syncUp(localDir: string, remoteDir: string, opts: SyncOptions = {}): Promise<void> {
    const absolute = resolve(this.resolve(remoteDir));
    const argv = [...this.rsyncArgs(opts), localDir.replace(/\/*$/, "/"), "./"];
    if (opts.owned !== undefined) {
      // Creation happens INSIDE the owned chain (relative to held,
      // owner-proven parents — Beam-created reserved dirs land 0700).
      await this.rsyncThroughOwnedDir(absolute, opts.owned, argv, opts, true);
      return;
    }
    await this.createMissing(absolute);
    await this.rsyncThroughPinnedDir(this.pinnedDirectory(absolute), argv, opts);
  }

  async syncDown(remoteDir: string, localDir: string, opts: SyncOptions = {}): Promise<void> {
    const absolute = resolve(this.resolve(remoteDir));
    // The local destination is created by the transfer shell AFTER every
    // remote-side proof (pin, ownership) — never before, so any refusal
    // leaves the local tree untouched. Resolved now: the shell cd's away.
    const localAbs = resolve(localDir);
    const argv = [...this.rsyncArgs(opts), "./", localAbs.replace(/\/*$/, "/")];
    if (opts.owned !== undefined) {
      await this.rsyncThroughOwnedDir(absolute, opts.owned, argv, opts, false, localAbs);
      return;
    }
    await this.rsyncThroughPinnedDir(this.pinnedDirectory(absolute), argv, opts, localAbs);
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
    return ["env", `HOME=${this.lexicalHome}`, "bash", "-lc", command];
  }
}
