import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run, runChecked, shjoin, shq, shqRemotePath } from "../util/shell.ts";
import {
  assertPurgeablePath,
  noFollowReservedDirGuard,
  noFollowReservedDirScript,
  noFollowSyncRootGuard,
} from "../workspace.ts";
import type { ExecResult, SyncOptions, Transport } from "./types.ts";

/** Where a kubectl-reached sandbox lives. Every argv pins all of these. */
export interface KubectlCoords {
  context: string;
  namespace: string;
  container: string;
  /** Explicit kubeconfig path; omitted = kubectl's normal resolution. */
  kubeconfig?: string;
}

/**
 * Sentinel a successful syncUp drops at the shipped root. A mirrored
 * syncDown (`delete`) refuses to run unless the remote tree carries it, so
 * pointing beam at a wrong or empty remote directory can never empty the
 * local workspace. The marker attests ONLY to the latest completed syncUp
 * attempt: every attempt (delete and non-delete alike) invalidates it as
 * its FIRST remote action and re-earns it only on full success, so a ship
 * that fails part-way — even an overlay after an earlier successful ship —
 * leaves no marker and a later mirrored syncDown refuses. That is the whole
 * claim: the content is a fixed public string, so a compromised pod forges
 * it trivially — the marker gates wrong/empty-path or stale-ship ACCIDENTS,
 * not a malicious pod (see the class doc). It is checked straight off the
 * pod — independent of user excludes — and lives on a beam-reserved path
 * distinct from `.beam/session.jsonl`, stripped from every staging tree so
 * it never lands locally.
 */
const SYNC_MARKER_FILE = "kubectl-synced.v1";
export const SYNC_MARKER_PATH = `.beam/${SYNC_MARKER_FILE}`;
export const SYNC_MARKER_CONTENT = "beam kubectl sync v1";

/**
 * Drop every sync marker from an extracted staging tree (any depth —
 * nested ships like session artifacts leave their own) so markers stay
 * transport bookkeeping and never reach the local workspace.
 */
function stripSyncMarkers(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(dir, entry.name);
    if (entry.name === ".beam") rmSync(join(child, SYNC_MARKER_FILE), { recursive: true, force: true });
    stripSyncMarkers(child);
  }
}

/**
 * Transport into an Agent Sandbox pod over `kubectl exec`. Files move as
 * tar streams on the exec channel (the same mechanism as `kubectl cp`), so
 * the pod needs no sshd, no daemon, and no open port — the Kubernetes API
 * server is the only path in. Context, namespace, and (when configured)
 * kubeconfig are pinned on every argv; the ambient current-context is never
 * trusted. Remote roots are plain absolute paths (`/data/bipa`); a leading
 * `~/` also works, resolved by the container's own shell.
 *
 * tar has no delta transfer: every ship is a full copy, and a mirrored ship
 * (`delete`) empties the destination first. Remote-built artifacts inside
 * the workspace do not survive a mirrored re-ship.
 *
 * Excludes are rsync patterns and only a local rsync ever applies them —
 * tar never sees a translated pattern (tar matches unanchored, so a
 * faithful translation does not exist: `/build` would also drop nested
 * `src/build`). syncUp filters the workspace into a fresh staging tree and
 * ships that verbatim; syncDown fetches the full remote tree into staging
 * and lets one local rsync do filtering and `--delete` mirroring together,
 * so an excluded path is protected from deletion by the exact same pattern,
 * root-anchoring and slashes included.
 *
 * The pod is treated as hostile for the extraction step: syncDown extracts
 * the remote stream only into a fresh empty staging directory (never over
 * the live workspace, so a crafted stream cannot write through
 * pre-existing symlinks), and remote destructive/data-stream commands run
 * fixed /usr/bin binaries (tar, find) so an agent-writable PATH cannot
 * substitute its own. The marker probe uses plain `cat` (macOS has no
 * /usr/bin/cat and the pod gains nothing by shadowing it — a hostile pod
 * forges the content anyway). The `delete` mirror is additionally licensed
 * by the syncUp marker — an accident gate (wrong or never-shipped remote
 * root), NOT a hostile-pod defense: a compromised pod controls the stream
 * and can forge the marker, so whatever it feeds a mirrored return is
 * trusted like the workspace itself.
 */
export class KubectlTransport implements Transport {
  readonly label: string;

  constructor(
    private readonly coords: KubectlCoords,
    private readonly pod: string,
    private readonly bin: string = "kubectl",
  ) {
    this.label = `k8s ${coords.namespace}/${pod}`;
  }

  private base(): string[] {
    return [
      this.bin,
      "--context",
      this.coords.context,
      "--namespace",
      this.coords.namespace,
      ...(this.coords.kubeconfig ? ["--kubeconfig", this.coords.kubeconfig] : []),
    ];
  }

  /**
   * argv that runs `command` through `bash -c` inside the sandbox
   * container. A non-login shell preserves the image/template PATH and
   * avoids sourcing agent-writable profile files. kubectl passes argv
   * verbatim, so unlike ssh the command string needs no extra quoting layer.
   */
  private execArgv(command: string, opts: { tty?: boolean; stdin?: boolean } = {}): string[] {
    return [
      ...this.base(),
      "exec",
      ...(opts.tty ? ["-it"] : opts.stdin ? ["-i"] : []),
      this.pod,
      "-c",
      this.coords.container,
      "--",
      "bash",
      "-c",
      command,
    ];
  }

  /** Run `producer | consumer` locally; pipefail surfaces either side's failure. */
  private async pipeline(producer: string[], consumer: string[], interactive: boolean): Promise<void> {
    const cmd = `set -o pipefail; ${shjoin(producer)} | ${shjoin(consumer)}`;
    await runChecked(["bash", "-c", cmd], { interactive });
  }

  /**
   * kubectl exec collapses failure classes: a remote command exiting 1 and
   * kubectl itself failing (API server unreachable, pod gone, exec stream
   * torn down mid-flight) can both surface locally as exit 1. Callers that
   * interpret exit codes — tmux liveness, `exists`, the sync-marker probe —
   * must never read an API failure as a clean remote "no", so every
   * non-interactive exec wraps the command with a per-call sentinel trailer:
   *
   *   ( command ); rc=$?; printf '\n<trailer>%d\n' rc; exit 0
   *
   * The subshell captures even a bare `exit N` (the no-follow guards exit
   * 61); the forced `exit 0` means kubectl succeeds ONLY after the trailer
   * reached us, so any nonzero kubectl exit is kubectl's own failure and
   * throws. The trailer is stripped before returning, byte-exact: the
   * leading newline is added unconditionally and removed with the trailer,
   * so stdout — trailing newline or not — comes back unchanged. The random
   * nonce guards against ACCIDENTAL collisions (a command echoing its own
   * text); a hostile pod can forge exit codes with or without it (see the
   * class doc). Streaming paths (pipeline, sendFile, fetchFile) stay
   * unwrapped on purpose: their stdout/stdin are data streams a trailer
   * would corrupt, and they run under runChecked where both failure
   * classes abort — no exit code of theirs is ever interpreted.
   */
  async exec(command: string): Promise<ExecResult> {
    const trailer = `__beam_rc_${randomBytes(8).toString("hex")}:`;
    const wrapped = `(\n${command}\n)\n__beam_rc=$?\nprintf '\\n%s%d\\n' ${shq(trailer)} "$__beam_rc"\nexit 0`;
    const res = await run(this.execArgv(wrapped));
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim();
      throw new Error(
        `[${this.label}] kubectl exec failed before the remote exit status could be read ` +
          `(kubectl exit ${res.code}) running: ${command}${detail ? `\n${detail}` : ""}`,
      );
    }
    // The nonce is hex + [_:] — regex-safe by construction.
    const m = new RegExp(`\\n${trailer}(\\d+)\\n$`).exec(res.stdout);
    if (!m) {
      const detail = res.stderr.trim();
      throw new Error(
        `[${this.label}] kubectl exec exited 0 but the remote exit-status trailer is missing or malformed — ` +
          `output stream truncated or the remote shell never ran; treating as a transport failure: ` +
          `${command}${detail ? `\n${detail}` : ""}`,
      );
    }
    return {
      code: Number(m[1]),
      stdout: res.stdout.slice(0, res.stdout.length - m[0].length),
      stderr: res.stderr,
    };
  }

  async execChecked(command: string): Promise<string> {
    const res = await this.exec(command);
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim();
      throw new Error(`[${this.label}] command failed (${res.code}): ${command}${detail ? `\n${detail}` : ""}`);
    }
    return res.stdout.trim();
  }

  async syncUp(localDir: string, remoteDir: string, opts: SyncOptions = {}): Promise<void> {
    // Emptying the destination is destructive — refuse remote roots that do
    // not look like a beam workspace path before anything runs remotely.
    if (opts.delete) assertPurgeablePath(remoteDir);
    const dir = shqRemotePath(remoteDir);
    // Every remote step below runs behind a same-shell no-follow guard: a
    // destination whose final component is (or was swapped for) a symlink
    // is refused in the SAME bash invocation as the action — `tar -C` and
    // `find -delete` must never write or delete through it. Commands prove
    // full physical containment under the configured root separately (see
    // workspace.ts); this closes the exec-to-exec window on the transport's
    // own destructive steps.
    const guard = noFollowSyncRootGuard(remoteDir);
    // The marker attests only to the latest COMPLETED sync attempt, so it
    // is invalidated as the first remote action of every attempt — before
    // staging, before any byte ships. A ship that then fails anywhere
    // leaves no marker, and a later mirrored syncDown refuses before
    // mutating a single local byte. The marker lives under the reserved
    // `.beam` dir, which the mirror never touches — a remote agent may
    // have swapped it for a symlink, so the same-shell no-follow guard
    // refuses before the `rm` could delete through it. Plain `rm` for the
    // same reason the probe uses plain `cat`: the marker gates accidents,
    // not a hostile pod (which forges the content anyway). Failure aborts
    // the ship.
    await this.execChecked(`${guard}\n${noFollowReservedDirGuard(remoteDir)}\nrm -f ${dir}/${SYNC_MARKER_PATH}`);
    // A local rsync filters the workspace into a fresh staging tree with
    // the original patterns (root-anchored `/build`, slash-carrying
    // `src/build`, and `dir/` all keep their exact rsync meaning); tar then
    // ships that tree verbatim, never a translated pattern.
    const staging = mkdtempSync(join(tmpdir(), "beam-syncup-"));
    try {
      await runChecked(
        [
          "rsync",
          "-a",
          ...(opts.verbose ? ["-v"] : []),
          ...(opts.excludes ?? []).map((e) => `--exclude=${e}`),
          localDir.replace(/\/*$/, "/"),
          staging.replace(/\/*$/, "/"),
        ],
        { interactive: opts.verbose === true },
      );
      // tar ships everything, so a mirrored ship empties the destination
      // first — a stale remote file must not survive a `delete` ship.
      const prep = opts.delete
        ? `${guard}\nmkdir -p ${dir} && /usr/bin/find ${dir} -mindepth 1 -delete`
        : `${guard}\nmkdir -p ${dir}`;
      await this.pipeline(
        ["tar", "-czf", "-", ...(opts.verbose ? ["-v"] : []), "-C", staging, "."],
        this.execArgv(`${prep} && /usr/bin/tar -xzf - -C ${dir}`, { stdin: true }),
        opts.verbose === true,
      );
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    // Only a fully successful ship re-earns the marker that later licenses
    // a mirrored syncDown; written last so a partial ship cannot leave one.
    // The reserved-dir script proves `.beam` is a REAL directory in the
    // same shell as the write — a `.beam` swapped for a symlink mid-ship
    // fails here, so the attempt ends marker-less instead of planting one
    // outside the workspace.
    await this.execChecked(
      `${guard}\n${noFollowReservedDirScript(remoteDir)}\nprintf '%s' ${shq(SYNC_MARKER_CONTENT)} > ${dir}/${SYNC_MARKER_PATH}`,
    );
  }

  async syncDown(remoteDir: string, localDir: string, opts: SyncOptions = {}): Promise<void> {
    const dir = shqRemotePath(remoteDir);
    if (opts.delete) {
      // The mirror license is read straight off the pod before anything is
      // fetched or any local byte changes. Checking it remotely keeps the
      // guard independent of user content filters: excluding `.beam/` (or
      // the marker name itself) from the transfer can never block a valid
      // mirrored return. Plain `cat` on purpose: the marker gates
      // wrong/empty-path accidents only (see the marker doc), and macOS —
      // the local-transport test authority — has no /usr/bin/cat.
      const probe = await this.exec(`cat ${dir}/${SYNC_MARKER_PATH}`);
      if (probe.code !== 0 || probe.stdout !== SYNC_MARKER_CONTENT) {
        throw new Error(
          `[${this.label}] refusing to mirror deletions from ${remoteDir}: ` +
            `${SYNC_MARKER_PATH} is ${probe.code !== 0 ? "missing" : "not a beam sync marker"} — ` +
            `only a workspace a successful beam syncUp shipped can mirror back with delete`,
        );
      }
    }
    mkdirSync(localDir, { recursive: true });
    // Hostile-pod stance: the remote stream is only ever extracted into a
    // fresh empty staging directory — extracting over the live workspace
    // would let a crafted stream write through pre-existing symlinks. The
    // remote tar ships the FULL tree (no remote excludes): the single local
    // rsync below owns filtering AND `--delete` mirroring, so an excluded
    // path is protected from deletion by the exact same pattern.
    const staging = mkdtempSync(join(tmpdir(), "beam-syncdown-"));
    try {
      await this.pipeline(
        this.execArgv(`${noFollowSyncRootGuard(remoteDir)}\n/usr/bin/tar -czf - -C ${dir} .`),
        ["tar", "-xzf", "-", ...(opts.verbose ? ["-v"] : []), "-C", staging],
        opts.verbose === true,
      );
      stripSyncMarkers(staging);
      await runChecked(
        [
          "rsync",
          "-a",
          ...(opts.delete ? ["--delete"] : []),
          ...(opts.checksum ? ["--checksum"] : []),
          ...(opts.excludes ?? []).map((e) => `--exclude=${e}`),
          staging.replace(/\/*$/, "/"),
          localDir.replace(/\/*$/, "/"),
        ],
        { interactive: opts.verbose === true },
      );
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  async sendFile(localPath: string, remotePath: string): Promise<void> {
    const write = `mkdir -p ${shqRemotePath(dirname(remotePath))} && cat > ${shqRemotePath(remotePath)}`;
    await runChecked(["bash", "-c", `${shjoin(this.execArgv(write, { stdin: true }))} < ${shq(localPath)}`]);
  }

  async fetchFile(remotePath: string, localPath: string): Promise<void> {
    mkdirSync(dirname(localPath), { recursive: true });
    await runChecked(["bash", "-c", `${shjoin(this.execArgv(`cat ${shqRemotePath(remotePath)}`))} > ${shq(localPath)}`]);
  }

  async exists(remotePath: string): Promise<boolean> {
    const res = await this.exec(`test -e ${shqRemotePath(remotePath)}`);
    return res.code === 0;
  }

  interactiveArgv(command: string): string[] {
    return this.execArgv(command, { tty: true });
  }
}
