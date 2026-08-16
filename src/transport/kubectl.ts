import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { run, runChecked, shjoin, shq, shqRemotePath } from "../util/shell.ts";
import { ownedDestinationScript, ownerGuardScript } from "../workspace.ts";
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
 * Mirror license: a marker a LICENSED syncUp (opts.license) drops on full
 * success, which a mirrored syncDown (`delete`) of the SAME destination
 * requires — so pointing beam at a wrong, empty, or never-shipped remote
 * directory can never empty the local workspace. The marker attests ONLY
 * to the latest completed attempt: every syncUp attempt to a destination
 * (licensed or not, delete or not) invalidates its marker as the FIRST
 * remote action and only a licensed full success re-earns it, so a ship
 * that fails part-way leaves no license. The content is a fixed public
 * string plus the destination, so a compromised pod forges it trivially —
 * it gates ACCIDENTS, not a malicious pod (see the class doc).
 *
 * The marker lives OUT of every synced tree, under the owning root's
 * reserved dir — `<root>/.beam/transport/kubectl-synced/<key>.v1`, where
 * the root is the destination itself or, for a destination nested inside a
 * `.beam` (the shipped Git payload), the workspace above it, and the key
 * digests the normalized destination. Synced bytes therefore stay
 * byte-exact in BOTH directions (no injection on the way up, no stripping
 * on the way back — nested payload digests hold with zero carve-outs),
 * purging the workspace destroys every license with it, and unlicensed
 * staging ships never grow transport metadata at all.
 */
export const SYNC_MARKER_VERSION = "beam kubectl sync v1";
const SYNC_MARKER_DIRS = [".beam", "transport", "kubectl-synced"];

export interface SyncMarker {
  /** Normalized destination this license is keyed to. */
  dest: string;
  /**
   * Root whose reserved dir holds the marker (the destination, or the
   * workspace above a nested `.beam` path).
   */
  root: string;
  /** Marker path relative to that root. */
  rel: string;
  /** Marker file basename — the only operand marker actions may name after the held-cwd walk. */
  file: string;
  /** Exact expected marker bytes. */
  content: string;
}

/** Resolve the out-of-tree mirror-license marker for a sync destination. */
export function syncMarkerFor(remoteDir: string): SyncMarker {
  let dest: string;
  if (remoteDir === "~") {
    dest = "~";
  } else {
    if (remoteDir.startsWith("~/")) {
      dest = `~${posix.normalize(`/${remoteDir.slice(2)}`)}`;
    } else {
      dest = posix.normalize(remoteDir);
    }
  }
  const nested = dest.indexOf("/.beam/");
  let root: string;
  if (nested >= 0) {
    root = dest.slice(0, nested);
  } else {
    if (dest.endsWith("/.beam")) {
      root = dest.slice(0, -"/.beam".length);
    } else {
      root = dest;
    }
  }
  const key = createHash("sha256").update(dest).digest("hex").slice(0, 32);
  return {
    dest,
    root,
    rel: `${SYNC_MARKER_DIRS.join("/")}/${key}.v1`,
    file: `${key}.v1`,
    content: `${SYNC_MARKER_VERSION} ${dest}`,
  };
}

/** Resolve a remote path to the exact physical pathname every sync shell must prove. */
function remotePathSetup(remoteDir: string): string {
  if (remoteDir.includes("\0") || remoteDir.includes("\n") || remoteDir.includes("\r")) {
    throw new Error(
      `beam: remote sync path is not a single pathname: ${JSON.stringify(remoteDir)}`,
    );
  }
  if (remoteDir === "~" || remoteDir.startsWith("~/")) {
    const suffix = remoteDir === "~" ? "" : posix.normalize(`/${remoteDir.slice(2)}`);
    return [
      `__beam_home=$(cd -P -- "$HOME" 2>/dev/null && /bin/pwd -P)` +
        ` || { echo ${shq("beam: cannot pin remote HOME")} >&2; exit 65; }`,
      `__beam_expected="$__beam_home"${shq(suffix)}`,
    ].join("\n");
  }
  if (!remoteDir.startsWith("/")) {
    throw new Error(`beam: remote sync path must be absolute or home-relative: ${remoteDir}`);
  }
  return `__beam_expected=${shq(posix.normalize(remoteDir))}`;
}

/**
 * Enter one exact directory by inode and leave the shell cwd there. Every
 * later transfer action uses `.` only, so an agent swapping any pathname
 * component cannot redirect find/tar after this proof.
 */
function pinRemoteDirScript(remoteDir: string, create: boolean): string {
  const setup = remotePathSetup(remoteDir);
  const refuseLink =
    `echo ${shq(`beam: refusing to sync through symlinked path: ${remoteDir}`)} >&2; exit 61`;
  const refusePhysical = `echo ${shq(
    `beam: remote sync path no longer resolves to its pinned physical directory: ${remoteDir}`,
  )} >&2; exit 66`;
  if (!create) {
    return [
      setup,
      `if [ -L "$__beam_expected" ]; then ${refuseLink}; fi`,
      `cd -P -- "$__beam_expected" 2>/dev/null || { ${refusePhysical}; }`,
      `__beam_actual=$(/bin/pwd -P) || { ${refusePhysical}; }`,
      `if [ "$__beam_actual" != "$__beam_expected" ]; then ${refusePhysical}; fi`,
    ].join("\n");
  }
  const homeRelative = remoteDir === "~" || remoteDir.startsWith("~/");
  let normalized: string;
  if (remoteDir === "~") {
    normalized = "";
  } else {
    if (homeRelative) {
      normalized = posix.normalize(`/${remoteDir.slice(2)}`).slice(1);
    } else {
      normalized = posix.normalize(remoteDir).slice(1);
    }
  }
  const segments = normalized.split("/").filter((part) => part !== "");
  if (segments.length === 0) {
    throw new Error(`beam: refusing to use remote sync root: ${remoteDir}`);
  }
  const lines = [
    setup,
    homeRelative
      ? `cd -P -- "$__beam_home" 2>/dev/null || { ${refusePhysical}; }`
      : `cd -P -- / 2>/dev/null || { ${refusePhysical}; }`,
    homeRelative ? `__beam_prefix="$__beam_home"` : `__beam_prefix=`,
  ];
  for (const segment of segments) {
    const q = shq(segment);
    lines.push(
      `if [ -L ${q} ]; then ${refuseLink}; fi`,
      `if [ ! -e ${q} ]; then mkdir -- ${q} || { ${refusePhysical}; }; fi`,
      `if [ -L ${q} ] || [ ! -d ${q} ]; then ${refuseLink}; fi`,
      `cd -P -- ${q} 2>/dev/null || { ${refusePhysical}; }`,
      `__beam_prefix="$__beam_prefix"/${q}`,
      `__beam_actual=$(/bin/pwd -P) || { ${refusePhysical}; }`,
      `if [ "$__beam_actual" != "$__beam_prefix" ]; then ${refusePhysical}; fi`,
    );
  }
  return lines.join("\n");
}

/**
 * Held-cwd component walk into the reserved marker directory, emitted as
 * per-component blocks (exported for adversarial interleave tests; prod
 * joins them). The shell must already sit in the pinned workspace root;
 * each component is lstat'd no-follow, entered with `cd -P`, and re-proven
 * as the exact physical child of the held parent — and in `create` mode an
 * absent component is created RELATIVE to the held parent inode first. No
 * multi-component pathname is ever named after a proof, so a component
 * swapped to a symlink mid-walk redirects nothing: the reproof refuses and
 * any created directory already lies inside the held verified parent. The
 * walk ends with the cwd in the marker directory; marker-file actions MUST
 * follow as single-component operands. At an absent component `probe`
 * exits 61 (no license) and `invalidate` exits 0 (nothing to invalidate).
 */
export function markerWalkBlocks(mode: "create" | "probe" | "invalidate"): string[] {
  const blocks = [`__beam_mprefix=$(/bin/pwd -P) || exit 66`];
  for (const dir of SYNC_MARKER_DIRS) {
    const q = shq(dir);
    const link = `echo ${shq(
      `beam: ${dir} is a symlink — refusing to touch transport metadata through it`,
    )} >&2; exit 62`;
    let absent: string;
    if (mode === "create") {
      absent =
        `mkdir -- ${q} || { echo ${shq(`beam: cannot create ${dir}`)} >&2; exit 63; }` +
        `; __beam_mk_new=1`;
    } else {
      if (mode === "probe") {
        absent = `exit 61`;
      } else {
        absent = `exit 0`;
      }
    }
    blocks.push(
      [
        `if [ -L ${q} ]; then ${link}; fi`,
        `__beam_mk_new=0`,
        `if [ ! -e ${q} ]; then ${absent}; fi`,
        `if [ -L ${q} ] || [ ! -d ${q} ]; then ${link}; fi`,
        `cd -P -- ${q} 2>/dev/null || { ${link}; }`,
        `__beam_mprefix="$__beam_mprefix"/${q}`,
        `if [ "$(/bin/pwd -P)" != "$__beam_mprefix" ]; then echo ${shq(
          `beam: ${dir} no longer resolves inside its workspace` +
            ` — refusing to touch transport metadata`,
        )} >&2; exit 66; fi`,
        // Beam-created reserved dirs are 0700 REGARDLESS of umask, chmod'd
        // on the held inode and verified with an exact -perm probe;
        // pre-existing dirs keep their (already Beam-created) modes.
        ...(mode === "create"
          ? [
              `if [ "$__beam_mk_new" = 1 ]; then chmod 700 .` +
                ` || { echo ${shq(`beam: cannot set the mode of ${dir}`)} >&2; exit 63; }; ` +
                `[ -n "$(find . -prune -perm 700)" ]` +
                ` || { echo ${shq(`beam: the mode of ${dir} did not verify`)} >&2; exit 63; }; fi`,
            ]
          : []),
      ].join("\n"),
    );
  }
  return blocks;
}

/**
 * Validate an owned-transfer request and derive the destination's
 * components relative to the owned root ([] = the root itself). Throws
 * locally — before any exec — when the destination is not the owned root
 * or a beam-reserved path nested inside it.
 */
function ownedRelFromRoot(
  remoteDir: string,
  owned: { root: string; ownerBytes: string },
): string[] {
  const marker = syncMarkerFor(remoteDir);
  const ownedRoot = syncMarkerFor(owned.root).dest;
  if (ownedRoot !== marker.root) {
    throw new Error(
      `beam: destination ${remoteDir} is not the owned workspace ${owned.root}` +
        ` or a beam-reserved path inside it — refusing the owned transfer`,
    );
  }
  return marker.dest === ownedRoot ? [] : marker.dest.slice(ownedRoot.length + 1).split("/");
}

/**
 * Root-level owned guard: pin the owned workspace root and run the shared
 * cwd-preserving owner verification (workspace.ts ownerGuardScript) IN THE
 * SAME shell as the marker action it precedes. Data transfers use the
 * FUSED ownedDestinationScript instead — this form is only for shells
 * that act at the root (marker invalidation/write, post-stream reverify).
 */
function ownedRootGuardScript(
  remoteDir: string,
  owned: { root: string; ownerBytes: string },
): string {
  ownedRelFromRoot(remoteDir, owned); // validates the pairing
  return [
    pinRemoteDirScript(syncMarkerFor(owned.root).dest, false),
    ownerGuardScript(owned.ownerBytes),
  ].join("\n");
}

/**
 * Fused owned data-shell prelude: pin the owned root, then run the shared
 * ownedDestinationScript — owner verified while HOLDING `.beam`, remaining
 * components descended no-follow from that same inode, shell ENDING at the
 * destination (or back at the held root for a root transfer, which
 * excludes `.beam` from its stream). The transfer that follows operates on
 * `.` only, so a `.beam` replaced between check and use can never receive
 * a byte.
 */
function ownedDestPrelude(
  remoteDir: string,
  owned: { root: string; ownerBytes: string },
  opts: { create: boolean },
): string {
  const rel = ownedRelFromRoot(remoteDir, owned);
  const ownedRoot = syncMarkerFor(owned.root).dest;
  return [
    pinRemoteDirScript(ownedRoot, false),
    ownedDestinationScript(owned.ownerBytes, rel, opts),
  ].join("\n");
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
 * tar has no delta transfer and no receiver: syncUp is strictly ADDITIVE
 * (overwrite-in-place, never a deletion) and REFUSES `delete` before any
 * remote mutation — no tar-side emptying can reproduce rsync's
 * exclude-protected deletion, and an excluded-but-present remote path (a
 * raced `.git`, retained secrets) must never be erased where the ssh and
 * local transports would protect it. Mirror-shaped ships instead target
 * fresh owned paths. syncDown DOES support `delete`: the mirror runs as a
 * single local rsync with exact exclude semantics.
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
 * pre-existing symlinks), and remote data-stream commands run
 * fixed /usr/bin binaries (tar) so an agent-writable PATH cannot
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
    let streamFlags: string[];
    if (opts.tty === true) {
      streamFlags = ["-it"];
    } else {
      if (opts.stdin === true) {
        streamFlags = ["-i"];
      } else {
        streamFlags = [];
      }
    }
    return [
      ...this.base(),
      "exec",
      ...streamFlags,
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
  private async pipeline(
    producer: string[],
    consumer: string[],
    interactive: boolean,
  ): Promise<void> {
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
   * class doc). Streaming paths (pipeline) stay
   * unwrapped on purpose: their stdout/stdin are data streams a trailer
   * would corrupt, and they run under runChecked where both failure
   * classes abort — no exit code of theirs is ever interpreted.
   */
  async exec(command: string): Promise<ExecResult> {
    const trailer = `__beam_rc_${randomBytes(8).toString("hex")}:`;
    const wrapped =
      `(\n${command}\n)\n__beam_rc=$?\n` +
      `printf '\\n%s%d\\n' ${shq(trailer)} "$__beam_rc"\nexit 0`;
    const res = await run(this.execArgv(wrapped));
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim();
      throw new Error(
        `[${this.label}] kubectl exec failed before the remote exit status could be read ` +
          `(kubectl exit ${res.code}) running: ${command}${detail ? `\n${detail}` : ""}`,
      );
    }
    // The nonce is hex + [_:] — regex-safe by construction. A real shell
    // exit status is one byte (0..255): any other digit run in the trailer
    // slot is a corrupted or forged stream, never a code to trust.
    const m = new RegExp(`\\n${trailer}(\\d+)\\n$`).exec(res.stdout);
    const code = m === null ? Number.NaN : Number(m[1]);
    if (m === null || !Number.isSafeInteger(code) || code < 0 || code > 255) {
      const detail = res.stderr.trim();
      throw new Error(
        `[${this.label}] kubectl exec exited 0 but the remote exit-status trailer is ` +
          `missing or malformed — output stream truncated or the remote shell never ran; ` +
          `treating as a transport failure: ${command}${detail ? `\n${detail}` : ""}`,
      );
    }
    return {
      code,
      stdout: res.stdout.slice(0, res.stdout.length - m[0].length),
      stderr: res.stderr,
    };
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

  async syncUp(localDir: string, remoteDir: string, opts: SyncOptions = {}): Promise<void> {
    // Mirrored deletion is REFUSED on this transport, before any remote
    // mutation: a tar ship has no receiver-side delta, so the destination
    // would have to be emptied first — and no emptying can reproduce
    // rsync's exclude-protected deletion. An excluded-but-present remote
    // path (a raced `.git`, retained secrets) would be erased where the
    // ssh/local transports would protect it. Ships are additive; callers
    // that need mirror semantics ship into a fresh owned path instead.
    if (opts.delete) {
      throw new Error(
        `[${this.label}] syncUp cannot mirror deletions into ${remoteDir}: kubectl tar ` +
          `ships do not implement rsync's exclude-protected deletion — ship additively ` +
          `into a fresh owned path instead`,
      );
    }
    const marker = syncMarkerFor(remoteDir);
    // An owned request must pair the destination with its owning root —
    // validated locally before ANY exec (the marker shells pin marker.root,
    // which equals the owned root only for a valid pairing).
    if (opts.owned) ownedRelFromRoot(remoteDir, opts.owned);
    // Every remote action enters and pins the exact physical directory in
    // the SAME shell as the action. Creation pins the parent first and
    // creates only a basename relative to that cwd. An OWNED transfer
    // (opts.owned) proves the exact `.beam/owner` bytes in every shell
    // that mutates — and its DATA shell uses the fused destination
    // descent: owner verified while holding `.beam`, the nested
    // destination entered (and created) from that same held inode, never
    // re-walked, so a `.beam` replaced between check and use cannot
    // receive a byte.
    // Owned marker shells use the FUSED descent to the marker directory
    // itself: owner verified while HOLDING `.beam`, transport/kubectl-synced
    // entered (and created) from that same inode, marker file ops as
    // single-component operands in the final held dir — never a
    // guard-then-rewalk a same-path replacement could slip between.
    const ownedMarkerShell = opts.owned
      ? [
          pinRemoteDirScript(marker.root, false),
          ownedDestinationScript(opts.owned.ownerBytes, [...SYNC_MARKER_DIRS], { create: true }),
        ].join("\n")
      : undefined;
    const pinCreate = pinRemoteDirScript(remoteDir, true);
    const pinExisting = pinRemoteDirScript(remoteDir, false);
    const pinMarkerRoot = pinRemoteDirScript(marker.root, false);
    await this.syncUpInvalidateLicense({ marker, ownedMarkerShell, pinCreate, pinMarkerRoot });
    await this.syncUpShipStaged({ localDir, remoteDir, pinExisting, opts });
    // Only a licensed, fully successful ship re-earns the mirror license;
    // written last so a partial ship cannot leave one.
    if (opts.license) {
      await this.syncUpEarnLicense({ marker, ownedMarkerShell, pinMarkerRoot });
    }
  }

  /**
   * The license attests only to the latest COMPLETED attempt on this
   * destination, so it is invalidated as the first remote action of
   * every attempt, licensed or not. The marker lives out-of-tree under
   * the owning root's reserved dir; for UNLICENSED stage ships nothing
   * of that chain is created (rm -f tolerates absent parents), so they
   * never grow a `.beam`. Owned ships run the fused marker shell — the
   * ownership proof comes first and stays inode-connected to the rm, so
   * even the invalidation touches nothing in a foreign or replaced tree.
   * Owned dest creation is deferred to the fused data shell.
   */
  private async syncUpInvalidateLicense(step: {
    marker: SyncMarker;
    ownedMarkerShell: string | undefined;
    pinCreate: string;
    pinMarkerRoot: string;
  }): Promise<void> {
    const remove = `rm -f -- ${shq(step.marker.file)}`;
    const shell =
      step.ownedMarkerShell === undefined
        ? [step.pinCreate, step.pinMarkerRoot, ...markerWalkBlocks("invalidate"), remove]
        : [step.ownedMarkerShell, remove];
    await this.execChecked(shell.join("\n"));
  }

  /**
   * A local rsync filters the workspace into a fresh staging tree with
   * the original patterns (root-anchored `/build`, slash-carrying
   * `src/build`, and `dir/` all keep their exact rsync meaning); tar then
   * ships that tree verbatim, never a translated pattern.
   */
  private async syncUpShipStaged(step: {
    localDir: string;
    remoteDir: string;
    pinExisting: string;
    opts: SyncOptions;
  }): Promise<void> {
    const { opts } = step;
    const staging = mkdtempSync(join(tmpdir(), "beam-syncup-"));
    try {
      await runChecked(
        [
          "rsync",
          "-a",
          ...(opts.verbose ? ["-v"] : []),
          ...(opts.excludes ?? []).map((e) => `--exclude=${e}`),
          step.localDir.replace(/\/*$/, "/"),
          staging.replace(/\/*$/, "/"),
        ],
        { interactive: opts.verbose === true },
      );
      // Additive extraction only: nothing on the destination is ever
      // deleted, so an excluded remote path can never be lost. The shell
      // operates on its pinned cwd (`.`) under `set -e`.
      const prelude =
        opts.owned === undefined
          ? step.pinExisting
          : ownedDestPrelude(step.remoteDir, opts.owned, { create: true });
      await this.pipeline(
        ["tar", "-czf", "-", ...(opts.verbose ? ["-v"] : []), "-C", staging, "."],
        this.execArgv(`set -e\n${prelude}\n/usr/bin/tar -xzf - -C .`, { stdin: true }),
        opts.verbose === true,
      );
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  /**
   * Earn the mirror license. The chain guard proves every reserved level
   * is a REAL directory in the same shell as the write — a level swapped
   * for a symlink mid-ship fails here, so the attempt ends unlicensed
   * instead of planting metadata outside the root. Owned ships re-verify
   * ownership AFTER the transfer, fused with the marker-directory descent
   * in the same shell that earns the license — a workspace swapped or
   * replaced mid-ship ends the attempt unlicensed with the replacement
   * untouched.
   */
  private async syncUpEarnLicense(step: {
    marker: SyncMarker;
    ownedMarkerShell: string | undefined;
    pinMarkerRoot: string;
  }): Promise<void> {
    const file = shq(step.marker.file);
    const refuseSymlink = shq(
      "beam: the mirror-license marker is a symlink — refusing to write through it",
    );
    const cannotEarn = shq("beam: could not earn the mirror license");
    const cannotChmod = shq("beam: could not set the mirror-license mode");
    const modeUnverified = shq("beam: the mirror-license mode did not verify");
    const guard =
      step.ownedMarkerShell === undefined
        ? [step.pinMarkerRoot, ...markerWalkBlocks("create")]
        : [step.ownedMarkerShell];
    await this.execChecked(
      [
        ...guard,
        `if [ -L ${file} ]; then echo ${refuseSymlink} >&2; exit 62; fi`,
        `rm -f -- ${file}`,
        `(set -C; printf '%s' ${shq(step.marker.content)} > ${file}) 2>/dev/null` +
          ` || { echo ${cannotEarn} >&2; exit 63; }`,
        `if [ -L ${file} ] || [ ! -f ${file} ]; then echo ${cannotEarn} >&2; exit 63; fi`,
        // Reserved metadata files are 0600 regardless of umask, verified
        // with an exact -perm probe — same policy as `.beam/owner`.
        `chmod 600 ${file} || { echo ${cannotChmod} >&2; exit 63; }`,
        `[ -n "$(find ${file} -prune -perm 600)" ] || { echo ${modeUnverified} >&2; exit 63; }`,
      ].join("\n"),
    );
  }

  /**
   * Probe a destination's mirror license straight off the pod (never a
   * local cache) through the same pinned-root chain guard every marker
   * action uses. A transport failure THROWS (the exec trailer machinery) —
   * an unreachable pod is never read as "unlicensed".
   */
  private async probeLicense(
    remoteDir: string,
  ): Promise<{ valid: boolean; missing: boolean; marker: SyncMarker }> {
    const marker = syncMarkerFor(remoteDir);
    // Plain `cat` on purpose: the license gates wrong/empty-path accidents
    // only (see the marker doc), and macOS — the local-transport test
    // authority — has no /usr/bin/cat.
    const probe = await this.exec(
      [
        pinRemoteDirScript(marker.root, false),
        ...markerWalkBlocks("probe"),
        `cat ${shq(marker.file)}`,
      ].join("\n"),
    );
    return {
      valid: probe.code === 0 && probe.stdout === marker.content,
      missing: probe.code !== 0,
      marker,
    };
  }

  /**
   * True iff a prior LICENSED syncUp to exactly this destination fully
   * completed and its mirror license is intact on the pod. Provisioning
   * retries use this to prove a landed ship instead of re-running a
   * destructive mirror; it is an accident gate, not a hostile-pod proof
   * (see the marker doc).
   */
  async syncLicense(remoteDir: string): Promise<boolean> {
    return (await this.probeLicense(remoteDir)).valid;
  }

  async syncDown(remoteDir: string, localDir: string, opts: SyncOptions = {}): Promise<void> {
    // An OWNED collection uses the fused destination descent in the SAME
    // shell that reads the tree — owner verified while holding `.beam`,
    // nested source entered from that same inode, never re-walked — and
    // re-proves ownership after the stream, BEFORE the local rsync applies
    // any effect.
    const rootGuard = opts.owned ? ownedRootGuardScript(remoteDir, opts.owned) : undefined;
    const pinExisting = pinRemoteDirScript(remoteDir, false);
    if (opts.delete) {
      // The mirror license is read straight off the pod before anything is
      // fetched or any local byte changes. It lives OUT of the synced tree
      // — under the owning root's reserved dir — so it is independent of
      // user content filters AND of the synced bytes themselves: excluding
      // `.beam/` can never block a valid mirrored return, and payload
      // trees come back byte-exact.
      const { valid, missing, marker } = await this.probeLicense(remoteDir);
      if (!valid) {
        const cause = missing ? "missing" : "not this destination's license";
        throw new Error(
          `[${this.label}] refusing to mirror deletions from ${remoteDir}: ` +
            `the mirror license ${marker.root}/${marker.rel} is ${cause} — ` +
            `only a destination a successful licensed beam syncUp shipped ` +
            `can mirror back with delete`,
        );
      }
    }
    mkdirSync(localDir, { recursive: true });
    // Hostile-pod stance: the remote stream is only ever extracted into a
    // fresh empty staging directory — extracting over the live workspace
    // would let a crafted stream write through pre-existing symlinks. The
    // remote tar ships the FULL tree (no remote excludes) and the staging
    // bytes are returned untouched: the single local rsync below owns
    // filtering AND `--delete` mirroring, so an excluded path is protected
    // from deletion by the exact same pattern and unfiltered trees (the
    // Git payload) come back byte-exact.
    const staging = mkdtempSync(join(tmpdir(), "beam-syncdown-"));
    try {
      const prelude =
        opts.owned === undefined
          ? pinExisting
          : ownedDestPrelude(remoteDir, opts.owned, { create: false });
      await this.pipeline(
        this.execArgv(`${prelude}\n/usr/bin/tar -czf - -C . .`),
        ["tar", "-xzf", "-", ...(opts.verbose ? ["-v"] : []), "-C", staging],
        opts.verbose === true,
      );
      // A workspace swapped WHILE the stream ran must not reach the local
      // tree: re-prove ownership before the first local byte changes.
      if (rootGuard) await this.execChecked(rootGuard);
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

  async exists(remotePath: string): Promise<boolean> {
    const res = await this.exec(`test -e ${shqRemotePath(remotePath)}`);
    return res.code === 0;
  }

  interactiveArgv(command: string): string[] {
    return this.execArgv(command, { tty: true });
  }
}
