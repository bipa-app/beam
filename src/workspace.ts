import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileSha256 } from "./util/digest.ts";
import { ensurePrivateBeamDir } from "./util/private-dir.ts";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { LocalTransport } from "./transport/local.ts";
import type { Config } from "./config.ts";
import { run, shjoin, shq, shqRemotePath } from "./util/shell.ts";
import type { Transport } from "./transport/types.ts";

/**
 * Deterministic per-workspace directory name under the target root:
 * readable basename plus a cwd digest so distinct checkouts never collide.
 */
export function remoteWorkspaceName(localCwd: string): string {
  const digest = createHash("sha256").update(localCwd).digest("hex").slice(0, 10);
  const base = basename(localCwd).replace(/[^A-Za-z0-9._-]/g, "_") || "workspace";
  return `${base}-${digest}`;
}

/**
 * Beam-reserved workspace metadata root. Session transcripts and artifacts
 * live under it on the target; it NEVER rides the filtered workspace mirror.
 */
export const BEAM_RESERVED_DIR = ".beam";

/**
 * Root-anchored, ASCII-case-folded rsync exclude for the reserved dir:
 * only the workspace-root `.beam` is Beam's. The folded spelling also
 * prevents a case-sensitive target's `.BEAM` from aliasing `.beam` when
 * returned onto a case-insensitive host filesystem.
 */
export const BEAM_RESERVED_EXCLUDE = "/.[bB][eE][aA][mM]";

/** Any-case `.git`, unanchored so nested submodule metadata stays home too. */
export const GIT_METADATA_EXCLUDE = ".[gG][iI][tT]";

/**
 * Root-anchored, case-folded exclude for the journaled `.git` pointer
 * staging temp (`.beam-gitptr-<generation>`): Beam-owned crash-recovery
 * metadata at the workspace root. It must never ride the filtered mirror
 * in either direction — the retry reconciles it on the target, and it
 * never returns into local user state.
 */
export const BEAM_GITPTR_EXCLUDE = "/.[bB][eE][aA][mM]-gitptr-*";

/**
 * Ownership marker inside the reserved dir: `<ws>/.beam/owner`. Its exact
 * content binds the remote workspace to ONE record: the version sentinel,
 * the record id, and a random token persisted on the record BEFORE the
 * first remote effect. A fresh handoff only ever creates the marker into
 * an absent/empty workspace; an existing non-empty directory — legacy,
 * foreign, or retained by an earlier handoff, `.beam` present or not — is
 * NEVER adopted and refuses with zero mutation. Reuse (a resolved record)
 * requires the exact marker bytes back. ALL remote Beam metadata —
 * session data, artifacts, and the shipped Git payload
 * (`.beam/git/<generation>`) — lives under `.beam`, so the single
 * reserved exclude covers every Beam name and no sibling reservation can
 * silently omit a user path from the mirror.
 */
export const BEAM_OWNER_FILE = "owner";

/** Exact `.beam/owner` bytes (sans newline) binding a workspace to a record. */
export function workspaceOwnerContent(recordId: string, workspaceToken: string): string {
  if (!/^[0-9a-f]{32}$/.test(workspaceToken)) {
    throw new Error(`beam: invalid workspace ownership token for ${recordId}`);
  }
  return `beam-workspace-v1 ${recordId} ${workspaceToken}`;
}

/**
 * Shell fragment verifying the exact record-bound `.beam/owner` bytes
 * under an ALREADY pinned workspace cwd (`enterWorkspaceScript` ran in the
 * same shell). Every data-bearing remote script prepends it so a replaced
 * or foreign-owned workspace refuses before the script's first effect.
 * The read happens through a held-cwd descent inside a SUBSHELL — never a
 * multi-component pathname — so a `.beam` swapped to a symlink after its
 * check cannot redirect the read, and the caller's cwd is untouched. One
 * observable refusal for every shape (missing, symlinked, swapped,
 * foreign): exit 52, "not owned by this handoff".
 */
export function ownerGuardScript(owner: string): string {
  const refuse = `echo "beam: the workspace is not owned by this handoff — refusing" >&2; exit 52`;
  return [
    `(`,
    `  __beam_og_root=$(/bin/pwd -P) || { ${refuse}; }`,
    `  if [ -L ./${BEAM_RESERVED_DIR} ] || [ ! -d ./${BEAM_RESERVED_DIR} ]; then ${refuse}; fi`,
    `  cd -P -- ./${BEAM_RESERVED_DIR} 2>/dev/null || { ${refuse}; }`,
    `  if [ "$(/bin/pwd -P)" != "$__beam_og_root/${BEAM_RESERVED_DIR}" ]; then ${refuse}; fi`,
    `  if [ -L ${BEAM_OWNER_FILE} ] || [ ! -f ${BEAM_OWNER_FILE} ]; then ${refuse}; fi`,
    `  if [ "$(cat ${BEAM_OWNER_FILE} 2>/dev/null)" != ${shq(owner)} ]; then ${refuse}; fi`,
    `) || exit $?`,
  ].join("\n");
}

/**
 * Fused owned-destination descent, emitted as blocks (exported for
 * adversarial interleave tests; production joins them). The shell must
 * ALREADY hold the pinned owned workspace root as its cwd.
 *
 * `relFromRoot` names the destination relative to the root: `[]` is the
 * root itself — the owner is verified through the cwd-preserving subshell
 * guard and the transfer runs back in the held root (safe because every
 * root transfer excludes `.beam`). A nested destination MUST start with
 * the reserved dir: the shell enters `.beam` no-follow, proves it the
 * root's physical child, verifies `owner` WHILE HOLDING that inode, then
 * descends the remaining components no-follow — creating each missing one
 * RELATIVE to the held parent when `create` is set — and ENDS with the
 * cwd at the destination, never returning or re-walking. The directory
 * that receives bytes is therefore inode-connected to the very `.beam`
 * whose owner was verified: a `.beam` replaced between check and use
 * cannot receive a byte — the physical-prefix reproof refuses instead.
 */
export function ownedDestinationBlocks(
  owner: string,
  relFromRoot: string[],
  opts: { create: boolean },
): string[] {
  if (relFromRoot.length === 0) return [ownerGuardScript(owner)];
  if (relFromRoot[0] !== BEAM_RESERVED_DIR) {
    throw new Error(
      `beam: an owned nested destination must live under ${BEAM_RESERVED_DIR}/ — got ` +
        relFromRoot.join("/"),
    );
  }
  for (const seg of relFromRoot) {
    if (seg === "" || seg === "." || seg === ".." || seg.includes("/") || /[\r\n\0]/.test(seg)) {
      throw new Error(`beam: invalid owned destination component: ${JSON.stringify(seg)}`);
    }
  }
  const refuse = `echo "beam: the workspace is not owned by this handoff — refusing" >&2; exit 52`;
  const blocks = [
    [
      `__beam_od_prefix=$(/bin/pwd -P) || { ${refuse}; }`,
      `if [ -L ./${BEAM_RESERVED_DIR} ] || [ ! -d ./${BEAM_RESERVED_DIR} ]; then ${refuse}; fi`,
      `cd -P -- ./${BEAM_RESERVED_DIR} 2>/dev/null || { ${refuse}; }`,
      `__beam_od_prefix="$__beam_od_prefix"/${BEAM_RESERVED_DIR}`,
      `if [ "$(/bin/pwd -P)" != "$__beam_od_prefix" ]; then ${refuse}; fi`,
      `if [ -L ${BEAM_OWNER_FILE} ] || [ ! -f ${BEAM_OWNER_FILE} ]; then ${refuse}; fi`,
      `if [ "$(cat ${BEAM_OWNER_FILE} 2>/dev/null)" != ${shq(owner)} ]; then ${refuse}; fi`,
    ].join("\n"),
  ];
  for (const seg of relFromRoot.slice(1)) {
    const q = shq(seg);
    const link =
      `echo ${shq(`beam: ${seg} is a symlink — refusing the owned transfer`)} >&2; exit 61`;
    blocks.push(
      [
        `if [ -L ${q} ]; then ${link}; fi`,
        opts.create
          ? // Nested reserved dirs hold record secrets: Beam-created ones
            // are 0700 REGARDLESS of umask, chmod'd on the held inode
            // right after entering (`.`) and verified with an exact
            // -perm probe. Pre-existing dirs keep their (already
            // Beam-created) modes.
            `__beam_od_new=0; if [ ! -e ${q} ]; then mkdir -- ${q} || { echo ${shq(
              `beam: cannot create ${seg}`,
            )} >&2; exit 66; }; __beam_od_new=1; fi`
          : `if [ ! -e ${q} ]; then echo ${shq(
              `beam: ${seg} is missing under the owned workspace — refusing`,
            )} >&2; exit 67; fi`,
        `if [ -L ${q} ] || [ ! -d ${q} ]; then ${link}; fi`,
        `cd -P -- ${q} 2>/dev/null || { ${link}; }`,
        `__beam_od_prefix="$__beam_od_prefix"/${q}`,
        `if [ "$(/bin/pwd -P)" != "$__beam_od_prefix" ]; then echo ${shq(
          `beam: ${seg} no longer resolves inside the owned workspace — refusing`,
        )} >&2; exit 66; fi`,
        ...(opts.create
          ? [
              `if [ "$__beam_od_new" = 1 ]; then chmod 700 . || { echo ${shq(
                `beam: cannot set the mode of ${seg}`,
              )} >&2; exit 66; }; ` +
                `[ -n "$(find . -prune -perm 700)" ] || { echo ${shq(
                  `beam: the mode of ${seg} did not verify`,
                )} >&2; exit 66; }; fi`,
            ]
          : []),
      ].join("\n"),
    );
  }
  return blocks;
}

/**
 * Joined form of ownedDestinationBlocks — the one helper every transport
 * and payload descent adopts.
 */
export function ownedDestinationScript(
  owner: string,
  relFromRoot: string[],
  opts: { create: boolean },
): string {
  return ownedDestinationBlocks(owner, relFromRoot, opts).join("\n");
}

/**
 * Refuse a local workspace whose root carries the reserved name: the
 * mirror excludes exactly `.beam` (any ASCII case) on both sides, so such
 * a path would be silently omitted from the ship and could alias Beam's
 * remote metadata. Checked BEFORE the record reservation and before any
 * remote effect, for plain and Git workspaces alike. On-disk entries of
 * ANY type (dir/file/symlink/special) and git-tracked names both refuse —
 * a tracked `.beam` path would be re-created on the target by ordinary
 * git operations even when absent locally.
 */
export async function assertNoLocalReservedCollision(localCwd: string): Promise<void> {
  const relocate = (what: string): Error =>
    new Error(
      `beam up: ${what} — beam reserves '.beam' (in any ASCII case) at the workspace ` +
        `root for handoff metadata, and the mirror would silently omit it. Move it ` +
        `aside (e.g. rename it to 'beam-local') and retry`,
    );
  for (const entry of readdirSync(localCwd)) {
    if (entry.toLowerCase() === BEAM_RESERVED_DIR) {
      throw relocate(`this workspace contains '${entry}'`);
    }
  }
  const ls = await run(["git", "-C", localCwd, "ls-files", "--cached", "-z"]);
  if (ls.code === 0) {
    for (const p of ls.stdout.split("\0")) {
      const top = p.split("/")[0] ?? "";
      if (top.toLowerCase() === BEAM_RESERVED_DIR) {
        throw relocate(`this repository tracks '${p}'`);
      }
    }
  }
}

/**
 * Merge config excludes with the workspace's .beamignore (rsync patterns).
 *
 * The reserved `.beam` dir is ALWAYS excluded, first. ALL Beam-owned
 * remote state — session data, artifacts, sync markers, and the shipped
 * Git payload — lives under it and travels exclusively over dedicated
 * guarded transfers that ignore workspace filters, so no user/global
 * pattern (`.beam/`, `session.jsonl`, `*.jsonl`, `*`, …) can suppress the
 * grown transcript or let stale local scratch masquerade as returned
 * state, and a `--delete` mirror can never erase it — or a crashed ship's
 * recovery state — on either side. Root-anchoring keeps the invariant
 * precise without simulating rsync wildcard semantics against user
 * patterns.
 *
 * `.git` metadata (in any ASCII case) never rides the filtered mirror, even
 * when the local workspace is not yet a repository: a case-sensitive
 * sandbox may create `.GIT`, which aliases `.git` on a case-insensitive
 * host, and its config and hooks must not land there unquarantined. Git
 * workspaces instead ship a standalone payload and import it through
 * quarantine. The unanchored pattern also keeps nested submodule metadata
 * home.
 */
export function gatherExcludes(localCwd: string, config: Config): string[] {
  const excludes = [
    BEAM_RESERVED_EXCLUDE,
    BEAM_GITPTR_EXCLUDE,
    ...(config.excludes ?? []),
    GIT_METADATA_EXCLUDE,
  ];
  const ignoreFile = join(localCwd, ".beamignore");
  if (existsSync(ignoreFile)) {
    for (const raw of readFileSync(ignoreFile, "utf8").split("\n")) {
      const line = raw.trim();
      if (line && !line.startsWith("#")) excludes.push(line);
    }
  }
  return excludes;
}

/**
 * Exact, copy-pasteable command for explicitly integrating a verified
 * return stage. Its filter argv is the same effective exclude union used
 * to collect and fingerprint the stage. This is essential with `--delete`:
 * an omitted remote path that was excluded from the return must remain
 * protected at the local destination.
 */
export function returnStageIntegrationCommand(
  stagedWorkspace: string,
  localCwd: string,
  excludes: string[],
  mirrorDeletes: boolean,
): string {
  const argv = ["rsync", "-a", "--checksum"];
  if (mirrorDeletes) argv.push("--delete");
  argv.push(
    ...excludes.map((exclude) => `--exclude=${exclude}`),
    "--",
    `${stagedWorkspace.replace(/\/+$/, "")}/`,
    `${localCwd.replace(/\/+$/, "")}/`,
  );
  return shjoin(argv);
}

/**
 * Keep the shipped-session scratch dir out of git status without touching
 * the repo's tracked .gitignore (local-only exclude file).
 */
export function ensureGitExclude(localCwd: string): void {
  const infoDir = join(localCwd, ".git", "info");
  if (!existsSync(infoDir)) return;
  const excludeFile = join(infoDir, "exclude");
  const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
  if (current.split("\n").some((l) => l.trim() === ".beam/")) return;
  appendFileSync(excludeFile, (current.endsWith("\n") || current === "" ? "" : "\n") + ".beam/\n");
}

/**
 * Refuse to destructively touch anything that does not look like a beam
 * workspace path: absolute, single-line, normalized (no `.`/`..`/empty
 * segments), and at least two levels deep. Shared by `beam kill --purge`
 * and mirrored ships that empty the destination before writing.
 */
export function assertPurgeablePath(remoteCwd: string): void {
  const segments = remoteCwd.slice(1).split("/");
  const suspicious =
    !remoteCwd.startsWith("/") ||
    remoteCwd.length < 8 ||
    /[\r\n\0]/.test(remoteCwd) ||
    segments.length < 2 ||
    segments.some((s) => s === "" || s === "." || s === "..");
  if (suspicious) throw new Error(`refusing to purge suspicious path: ${remoteCwd}`);
}

/* ------------------------------------------------------------------------ */
/* Physical containment                                                      */
/*                                                                           */
/* Lexical checks (assertPurgeablePath) cannot see symlinks: on a reusable   */
/* sandbox the deterministic workspace path can be pre-created as a symlink  */
/* to any writable directory, `mkdir -p` accepts it, and tar/rsync/find      */
/* would then write through (or delete through) it — outside the configured  */
/* root. The helpers below run ON the target through the transport and       */
/* prove PHYSICAL containment instead:                                       */
/*                                                                           */
/*   - the configured root is resolved physically (`cd && /bin/pwd -P`). Root-    */
/*     level symlinks are trusted config and canonicalize (macOS /tmp,       */
/*     /data -> /mnt mounts);                                                */
/*   - every component BELOW the root is no-follow territory: any symlink    */
/*     refuses the operation, even one pointing back inside the root (a      */
/*     swapped workspace must never silently ship/collect/purge a sibling);  */
/*   - the workspace must be a strict physical descendant of the root, and   */
/*     must resolve to ITSELF (`pwd -P` equality) — so the canonical path a  */
/*     ship persists is the exact path every later operation touches;       */
/*   - the proof re-runs immediately before every destructive or data-      */
/*     bearing use, so a path swapped after establishment is refused.       */
/*                                                                           */
/* All checks and the purge `rm -rf` run inside a single remote shell        */
/* invocation, which is the tightest check-to-use window a shell transport   */
/* can offer. The same script runs under `bash -c` (kubectl), `bash -lc`     */
/* (ssh), and the local transport, keeping the three symmetric; `~/` roots   */
/* resolve against the transport's HOME exactly like every other remote      */
/* path.                                                                     */
/* ------------------------------------------------------------------------ */

/** Stdout sentinels for provable non-path outcomes; never valid paths. */
const WS_ABSENT = "__beam_ws_absent__";
const WS_PURGED = "__beam_ws_purged__";
const WS_RELEASED = "__beam_ws_released__";

interface ContainmentMode {
  /** Compose the workspace as `<physical root>/<name>` (first ship). */
  name?: string;
  /** Verify a previously persisted canonical workspace path. */
  path?: string;
  /** `mkdir -p` the root and workspace once proven safe (up path). */
  create?: boolean;
  /** A provably absent workspace passes (idempotent purge retries). */
  allowMissing?: boolean;
  /**
   * Record-bound ownership marker (`.beam/owner`). `adopt: "create"`
   * (fresh ship) claims ONLY an absent/empty workspace — or re-verifies
   * this record's own crashed claim — by planting the exact content
   * create-only; anything else refuses with zero mutation. `adopt:
   * "verify"` (resolved record) requires the exact bytes back and never
   * writes.
   */
  owner?: { content: string; adopt: "create" | "verify" };
  /** `rm -rf` the workspace in the SAME shell once containment is proven. */
  purge?: boolean;
}

/** Build the remote proof script. Success prints exactly one result line. */
function containmentScript(root: string, mode: ContainmentMode): string {
  const lines: string[] = ["set -u"];
  lines.push(...containmentScriptRootLines(root, mode));
  lines.push(...containmentScriptWalkLines());
  if (mode.allowMissing) {
    lines.push(
      `if [ ! -e "$__bw_ws" ] && [ ! -L "$__bw_ws" ]; then` +
        ` printf '%s\\n' ${shq(WS_ABSENT)}; exit 0; fi`,
    );
  }
  if (mode.create) {
    lines.push(...containmentScriptCreateLines());
  } else {
    lines.push(...containmentScriptResolveLines());
  }
  if (mode.owner) {
    lines.push(...containmentScriptOwnerLines(mode.owner));
  }
  if (mode.purge) {
    lines.push(
      `rm -rf -- "$__bw_ws" || { echo "beam: failed to erase $__bw_ws" >&2; exit 51; }`,
      `printf '%s\\n' ${shq(WS_PURGED)}`,
    );
  } else {
    lines.push(`printf '%s\\n' "$__bw_wsp"`);
  }
  return lines.join("\n");
}

/**
 * Resolve the configured root physically and compose the workspace path:
 * `<physical root>/<name>` on a first ship, or the persisted canonical
 * path re-checked lexically against the resolved root.
 */
function containmentScriptRootLines(root: string, mode: ContainmentMode): string[] {
  const rootQ = shqRemotePath(root);
  const lines: string[] = [];
  if (mode.create) {
    lines.push(
      `mkdir -p -- ${rootQ} || { echo ${shq(
        `beam: cannot create workspace root ${root}`,
      )} >&2; exit 40; }`,
    );
  }
  lines.push(
    `__bw_rootp=$(cd -- ${rootQ} 2>/dev/null && /bin/pwd -P) || { echo ${shq(
      `beam: workspace root ${root} does not resolve on the target`,
    )} >&2; exit 41; }`,
    `case "$__bw_rootp" in /?*) ;; *) echo "beam: refusing workspace root resolving to` +
      ` '$__bw_rootp'" >&2; exit 42 ;; esac`,
  );
  if (mode.name !== undefined) {
    lines.push(`__bw_ws="$__bw_rootp/"${shq(mode.name)}`);
  } else {
    lines.push(
      `__bw_ws=${shq(mode.path ?? "")}`,
      `case "$__bw_ws" in "$__bw_rootp"/?*) ;; *) echo ${shq(
        `beam: workspace ${mode.path} is not under the physical root of ${root} — ` +
          `refusing (physical containment)`,
      )}" (root resolves to $__bw_rootp)" >&2; exit 43 ;; esac`,
    );
  }
  return lines;
}

/** No-follow walk: every component strictly below the physical root. */
function containmentScriptWalkLines(): string[] {
  return [
    `__bw_rel="\${__bw_ws#"$__bw_rootp"/}"`,
    `__bw_p="$__bw_rootp"`,
    `__bw_ifs="\${IFS-}"; IFS=/; set -f`,
    `for __bw_seg in $__bw_rel; do`,
    `  case "$__bw_seg" in ''|.|..) echo "beam: suspicious workspace path segment in` +
      ` $__bw_ws" >&2; exit 44 ;; esac`,
    `  __bw_p="$__bw_p/$__bw_seg"`,
    `  if [ -L "$__bw_p" ]; then echo "beam: refusing symlinked workspace path component:` +
      ` $__bw_p (physical containment)" >&2; exit 45; fi`,
    `done`,
    `set +f; IFS="$__bw_ifs"`,
  ];
}

/**
 * Held-cwd creation walk (the remote twin of the local transport's
 * createWalkBlocks): enter the PHYSICAL root once, then create and
 * enter each missing component with a RELATIVE mkdir in the held
 * parent inode, re-proving `pwd -P` against the accumulated prefix
 * after every hop. No absolute pathname is ever mutated after a
 * proof — a parent swapped to a symlink mid-walk redirects nothing:
 * the relative mkdir lands inside the held (verified) parent and
 * the reproof refuses before anything else runs.
 */
function containmentScriptCreateLines(): string[] {
  return [
    `cd -P -- "$__bw_rootp" 2>/dev/null || { echo "beam: cannot enter workspace root` +
      ` $__bw_rootp" >&2; exit 41; }`,
    `if [ "$(/bin/pwd -P)" != "$__bw_rootp" ]; then echo "beam: workspace root moved` +
      ` during creation — refusing" >&2; exit 41; fi`,
    `__bw_p="$__bw_rootp"`,
    `__bw_ifs="\${IFS-}"; IFS=/; set -f`,
    `set -- $__bw_rel`,
    `set +f; IFS="$__bw_ifs"`,
    `for __bw_seg in "$@"; do`,
    `  if [ -L "./$__bw_seg" ]; then echo "beam: refusing to create through symlinked` +
      ` workspace path component: $__bw_p/$__bw_seg (physical containment)" >&2;` +
      ` exit 45; fi`,
    `  if [ ! -e "./$__bw_seg" ]; then mkdir -- "./$__bw_seg" || { echo "beam: cannot` +
      ` create workspace $__bw_ws" >&2; exit 46; }; fi`,
    `  if [ -L "./$__bw_seg" ] || [ ! -d "./$__bw_seg" ]; then echo "beam: workspace path` +
      ` component is not a real directory: $__bw_p/$__bw_seg — refusing" >&2; exit 45; fi`,
    `  cd -P -- "./$__bw_seg" 2>/dev/null || { echo "beam: cannot enter` +
      ` $__bw_p/$__bw_seg" >&2; exit 46; }`,
    `  __bw_p="$__bw_p/$__bw_seg"`,
    `  if [ "$(/bin/pwd -P)" != "$__bw_p" ]; then echo "beam: workspace path moved during` +
      ` creation — refusing (physical containment)" >&2; exit 45; fi`,
    `done`,
    // The shell HOLDS the final workspace inode; its physical identity
    // is the accumulated proof, never a fresh absolute re-walk.
    `__bw_wsp="$__bw_p"`,
  ];
}

/** Verify an existing workspace: no-follow probes, then `pwd -P` self-identity. */
function containmentScriptResolveLines(): string[] {
  return [
    `if [ -L "$__bw_ws" ]; then echo "beam: workspace is a symlink — refusing (physical` +
      ` containment): $__bw_ws" >&2; exit 45; fi`,
    `if [ ! -e "$__bw_ws" ]; then echo "beam: workspace missing on the target: $__bw_ws"` +
      ` >&2; exit 49; fi`,
    `if [ ! -d "$__bw_ws" ]; then echo "beam: workspace is not a directory: $__bw_ws"` +
      ` >&2; exit 50; fi`,
    `__bw_wsp=$(cd -- "$__bw_ws" 2>/dev/null && /bin/pwd -P) || { echo "beam: workspace` +
      ` does not resolve: $__bw_ws" >&2; exit 47; }`,
    `if [ "$__bw_wsp" != "$__bw_ws" ]; then echo "beam: workspace $__bw_ws physically` +
      ` resolves to $__bw_wsp — path swapped or symlinked; refusing" >&2; exit 48; fi`,
  ];
}

/**
 * Record-bound ownership proof/claim inside the PINNED physical workspace
 * (see ContainmentMode.owner). Exit 91 translates to the "not owned"
 * refusal, any other nonzero to the establish failure.
 */
function containmentScriptOwnerLines(owner: {
  content: string;
  adopt: "create" | "verify";
}): string[] {
  const reserved = BEAM_RESERVED_DIR;
  return [
    `__bw_owner=${shq(owner.content)}`,
    // Ownership is decided inside the PINNED physical workspace: cd -P
    // holds the proven inode as cwd. The marker is probed and planted
    // through a HELD single-component descent — lstat the reserved dir
    // no-follow, enter it with cd -P, prove its physical identity, and
    // only then touch `./owner` as one component. Never a two-component
    // `./.beam/owner` after the proof: a `.beam` swapped to a symlink
    // between check and use would draw that write outside; the held
    // inode cannot be redirected.
    `(`,
    `  cd -P -- "$__bw_wsp" || exit 90`,
    `  [ "$(/bin/pwd -P)" = "$__bw_wsp" ] || exit 90`,
    `  __bw_have=""`,
    `  if [ ! -L ./${reserved} ] && [ -d ./${reserved} ]; then`,
    `    if ( cd -P -- ./${reserved} 2>/dev/null && ` +
      `[ "$(/bin/pwd -P)" = "$__bw_wsp/${reserved}" ] && ` +
      `[ ! -L ./${BEAM_OWNER_FILE} ] && [ -f ./${BEAM_OWNER_FILE} ] && ` +
      `[ "$(cat ./${BEAM_OWNER_FILE} 2>/dev/null)" = "$__bw_owner" ] ); then` +
      ` __bw_have=1; fi`,
    `  fi`,
    // The reserved dir holds record secrets (owner token, session
    // transcripts, Git payloads): it is 0700 and the marker 0600
    // REGARDLESS of umask. An existing exact-owner claim with looser
    // group/other bits is demonstrably Beam's own — tighten it (held
    // inode: chmod '.' and the lstat-proven single component) and
    // VERIFY with an exact -perm probe before anything secret lands;
    // an unverifiable mode refuses.
    `  if [ -n "$__bw_have" ]; then`,
    `    ( cd -P -- ./${reserved} 2>/dev/null || exit 1`,
    `      [ "$(/bin/pwd -P)" = "$__bw_wsp/${reserved}" ] || exit 1`,
    `      chmod 700 . 2>/dev/null || exit 1`,
    `      chmod 600 ./${BEAM_OWNER_FILE} 2>/dev/null || exit 1`,
    `      [ -n "$(find . -prune -perm 700)" ] || exit 1`,
    `      [ -n "$(find ./${BEAM_OWNER_FILE} -prune -perm 600)" ] || exit 1 ) || exit 93`,
    `  fi`,
    ...(owner.adopt === "verify"
      ? [`  [ -n "$__bw_have" ] || exit 91`]
      : containmentScriptOwnerClaimLines()),
    `)`,
    `__bw_oc=$?`,
    `if [ "$__bw_oc" = 91 ]; then echo "beam: workspace $__bw_ws exists and is not owned` +
      ` by this handoff — refusing with it untouched (purge or retire the handoff that` +
      ` owns it, or move the directory aside)" >&2; exit 52; fi`,
    `if [ "$__bw_oc" != 0 ]; then echo "beam: cannot establish beam ownership of` +
      ` $__bw_ws" >&2; exit 53; fi`,
  ];
}

/**
 * Fresh establish NEVER adopts existing content: only an absent/empty
 * workspace (or one holding nothing but an empty `.beam` from this
 * record's own crashed establish) may be claimed; the exact marker means
 * the claim already succeeded.
 */
function containmentScriptOwnerClaimLines(): string[] {
  const reserved = BEAM_RESERVED_DIR;
  return [
    `  if [ -z "$__bw_have" ]; then`,
    `    __bw_entries="$(ls -A . 2>/dev/null)"`,
    `    if [ -z "$__bw_entries" ]; then`,
    `      mkdir ./${reserved} || exit 92`,
    `    elif [ "$__bw_entries" = "${reserved}" ] && [ ! -L ./${reserved} ] && ` +
      `[ -d ./${reserved} ] && [ -z "$(ls -A ./${reserved} 2>/dev/null)" ]; then`,
    `      :`,
    `    else`,
    `      exit 91`,
    `    fi`,
    `    if [ -L ./${reserved} ] || [ ! -d ./${reserved} ]; then exit 91; fi`,
    `    cd -P -- ./${reserved} 2>/dev/null || exit 92`,
    `    [ "$(/bin/pwd -P)" = "$__bw_wsp/${reserved}" ] || exit 91`,
    `    chmod 700 . 2>/dev/null || exit 92`,
    `    (set -C; printf '%s\\n' "$__bw_owner" > ./${BEAM_OWNER_FILE}) 2>/dev/null ||` +
      ` exit 92`,
    `    [ ! -L ./${BEAM_OWNER_FILE} ] && [ -f ./${BEAM_OWNER_FILE} ] && ` +
      `[ "$(cat ./${BEAM_OWNER_FILE})" = "$__bw_owner" ] || exit 91`,
    `    chmod 600 ./${BEAM_OWNER_FILE} 2>/dev/null || exit 92`,
    `    [ -n "$(find . -prune -perm 700)" ] || exit 92`,
    `    [ -n "$(find ./${BEAM_OWNER_FILE} -prune -perm 600)" ] || exit 92`,
    `  fi`,
  ];
}

/** Run a proof script; return its single result line (last non-empty line —
 * `bash -lc` transports may leak profile noise into stdout). */
async function runContainment(t: Transport, script: string): Promise<string> {
  const out = await t.execChecked(script);
  const lines = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return lines[lines.length - 1] ?? "";
}

/**
 * Establish (or re-establish, for a resolved record being re-shipped) the
 * remote workspace with physical containment proven, creating it if absent.
 * A pre-existing symlink at the deterministic workspace path fails HERE —
 * before any local byte ships. Returns the canonical physical path, which
 * is what the record must persist: every later operation re-proves
 * containment of exactly that path.
 */
export async function establishContainedWorkspace(
  t: Transport,
  root: string,
  ws: { name: string } | { path: string },
  owner: { content: string; adopt: "create" | "verify" },
): Promise<string> {
  if ("name" in ws) {
    if (!/^[A-Za-z0-9._-]+$/.test(ws.name) || ws.name === "." || ws.name === "..") {
      throw new Error(`invalid remote workspace name: ${ws.name}`);
    }
  } else {
    assertPurgeablePath(ws.path);
  }
  const result = await runContainment(
    t,
    containmentScript(root, {
      ...("name" in ws ? { name: ws.name } : { path: ws.path }),
      create: true,
      owner,
    }),
  );
  // Fail closed on anything that is not a plausible canonical workspace path.
  assertPurgeablePath(result);
  return result;
}

/**
 * Re-prove no-follow physical containment of a persisted canonical
 * workspace path immediately before using it (sync, staged-patch
 * extraction, session install/cleanup/collect). Throws if the path — or
 * any component below the root — was swapped for a symlink, escaped the
 * physical root, or stopped being a directory. `owner` additionally
 * requires the exact record-bound `.beam/owner` bytes back in the SAME
 * proof: a replaced real directory (foreign or another record's) refuses
 * exactly like a symlink swap. With `allowMissing`, a provably absent
 * workspace returns false instead of throwing (idempotent purge retries).
 */
export async function assertContainedWorkspace(
  t: Transport,
  root: string,
  path: string,
  opts: { allowMissing?: boolean; owner?: string } = {},
): Promise<boolean> {
  assertPurgeablePath(path);
  const result = await runContainment(
    t,
    containmentScript(root, {
      path,
      allowMissing: opts.allowMissing,
      ...(opts.owner !== undefined
        ? { owner: { content: opts.owner, adopt: "verify" as const } }
        : {}),
    }),
  );
  return result !== WS_ABSENT;
}

/**
 * Phase A of the two-phase kill purge: destroy a workspace's contents
 * from one enterWorkspaceScript shell, pinned by cwd AND the exact
 * record-bound owner marker — EXCEPT the marker itself. Every deletion is
 * `./`-relative to the held inode and the root directory is never
 * `rm -rf`ed or rmdir'd by pathname — a swapped-in replacement path (real
 * dir or symlink target, foreign owner bytes included) stays byte-
 * untouched because the ownership proof fails before any deletion.
 *
 * The owner marker deliberately SURVIVES this phase: the same shell then
 * verifies the exact end state (root holds exactly `.beam`; the held
 * `.beam` holds exactly `owner` with the exact bytes) and only that proof
 * licenses the caller to persist the `workspaceContentsPurged` receipt.
 * Releasing the marker is Phase B (`releaseOwnedWorkspace`), which runs
 * ONLY under that persisted receipt — so no state this phase can crash in
 * is ever ambiguous with an absent or foreign-replaced workspace.
 *
 * `acceptConverged` is for the RECEIPTED retry path only (the caller
 * holds this record's own `workspaceContentsPurged` receipt): a provably
 * absent workspace, an exactly-empty root, or the emptied layout (empty
 * `.beam`, or `.beam` holding exactly the exact-byte owner marker) all
 * return without effect — those are precisely the states this record's
 * own later phases produce. WITHOUT the receipt those states refuse
 * exactly like a foreign path: a journaled `killing` intent alone never
 * licenses reading emptiness as "already erased" (the empty directory
 * could be a same-path replacement). The one exception needs no flag:
 * the emptied layout WITH the exact owner marker is this phase's own
 * postcondition — the normal owner-proof path re-converges through it.
 */
export async function purgeOwnedWorkspaceContents(
  t: Transport,
  remoteCwd: string,
  owner: string,
  opts: { acceptConverged?: boolean } = {},
): Promise<"purged" | "absent"> {
  assertPurgeablePath(remoteCwd);
  const notOwned = `{ echo ${shq(
    `beam: ${remoteCwd} is not owned by this handoff — refusing to purge it ` +
      `(nothing was deleted)`,
  )} >&2; exit 52; }`;
  const script = [
    "set -u",
    // Absence is convergence evidence ONLY under this record's own
    // receipt; on a first attempt a missing workspace is as suspicious as
    // a foreign one (the sandbox may have swapped storage under the path)
    // and refuses with the claim retained.
    opts.acceptConverged === true
      ? `if [ ! -e ${shqRemotePath(remoteCwd)} ] && [ ! -L ${shqRemotePath(remoteCwd)} ];` +
        ` then printf '%s\\n' ${shq(WS_ABSENT)}; exit 0; fi`
      : `if [ ! -e ${shqRemotePath(remoteCwd)} ] && [ ! -L ${shqRemotePath(remoteCwd)} ];` +
        ` then ${notOwned}; fi`,
    enterWorkspaceScript(remoteCwd),
    `__bp_ws="$(/bin/pwd -P)"`,
    ...(opts.acceptConverged === true ? purgeOwnedWorkspaceConvergedLines(owner) : []),
    ...purgeOwnedWorkspaceEraseLines({ remoteCwd, owner, notOwned }),
    `printf '%s\\n' ${shq(WS_PURGED)}`,
  ].join("\n");
  const result = await runContainment(t, script);
  if (result === WS_ABSENT) return "absent";
  if (result === WS_PURGED) return "purged";
  throw new Error(
    `beam: purge of ${remoteCwd} produced no proof (got: ${result || "no output"}) — ` +
      `refusing to continue`,
  );
}

/**
 * Receipted-retry convergence probes: the states Phase A/B provably leave
 * behind read as converged with zero effect. Anything else — foreign
 * owner bytes included — falls through to the full proof that follows.
 */
function purgeOwnedWorkspaceConvergedLines(owner: string): string[] {
  return [
    `__bp_entries="$(ls -A . 2>/dev/null)"`,
    `if [ -z "$__bp_entries" ]; then printf '%s\\n' ${shq(WS_PURGED)}; exit 0; fi`,
    `if [ "$__bp_entries" = "${BEAM_RESERVED_DIR}" ] && [ ! -L ./${BEAM_RESERVED_DIR} ] && ` +
      `[ -d ./${BEAM_RESERVED_DIR} ]; then`,
    // The reserved dir is probed through the same held single-
    // component descent in a cwd-preserving subshell: empty (mid-B
    // crash after the owner unlink) or exactly the exact-byte owner
    // marker (crash after Phase A's receipt) are both converged.
    `  if ( cd -P -- ./${BEAM_RESERVED_DIR} 2>/dev/null && ` +
      `[ "$(/bin/pwd -P)" = "$__bp_ws/${BEAM_RESERVED_DIR}" ] && ` +
      `__bp_be="$(ls -A . 2>/dev/null)" && { [ -z "$__bp_be" ] || ` +
      `{ [ "$__bp_be" = "${BEAM_OWNER_FILE}" ] && ` +
      `[ ! -L ./${BEAM_OWNER_FILE} ] && [ -f ./${BEAM_OWNER_FILE} ] && ` +
      `[ "$(cat ./${BEAM_OWNER_FILE} 2>/dev/null)" = ${shq(owner)} ]; }; } ); ` +
      `then printf '%s\\n' ${shq(WS_PURGED)}; exit 0; fi`,
    `fi`,
  ];
}

/**
 * Owner-proven erase inside the held workspace: user contents first, then
 * Beam metadata except the marker, then the exact emptied end-state proof
 * that licenses the `workspaceContentsPurged` receipt.
 */
function purgeOwnedWorkspaceEraseLines(opts: {
  remoteCwd: string;
  owner: string;
  notOwned: string;
}): string[] {
  const { owner, notOwned } = opts;
  const endStateBroken = `{ echo ${shq(
    `beam: the purge of ${opts.remoteCwd} cannot prove its emptied end state — ` +
      `refusing to receipt it`,
  )} >&2; exit 51; }`;
  return [
    // Owner proof INSIDE the pinned reserved dir: lstat the single
    // component, enter it with cd -P, and require its physical path to be
    // exactly the held workspace's `.beam` — the marker is then read
    // `./`-relative to THAT held inode, never through a multi-component
    // pathname a concurrent swap could redirect.
    `if [ -L ./${BEAM_RESERVED_DIR} ] || [ ! -d ./${BEAM_RESERVED_DIR} ]; then` +
      ` ${notOwned}; fi`,
    `cd -P -- ./${BEAM_RESERVED_DIR} 2>/dev/null || ${notOwned}`,
    `if [ "$(/bin/pwd -P)" != "$__bp_ws/${BEAM_RESERVED_DIR}" ]; then ${notOwned}; fi`,
    `if [ -L ./${BEAM_OWNER_FILE} ] || [ ! -f ./${BEAM_OWNER_FILE} ] || ` +
      `[ "$(cat ./${BEAM_OWNER_FILE} 2>/dev/null)" != ${shq(owner)} ]; then ${notOwned}; fi`,
    // Back to the held workspace via the INODE parent (`..` of the held
    // reserved dir), re-proven physically — never a pathname re-walk.
    `cd .. || exit 51`,
    `if [ "$(/bin/pwd -P)" != "$__bp_ws" ]; then echo 'beam: workspace moved during the` +
      ` purge — refusing' >&2; exit 51; fi`,
    // Contents first: single-component entries under the held cwd; rm of a
    // top-level symlink removes the LINK, never its target.
    `find . -mindepth 1 -maxdepth 1 ! -name ${shq(BEAM_RESERVED_DIR)} -exec rm -rf -- {} +` +
      ` || { echo 'beam: failed to erase workspace contents' >&2; exit 51; }`,
    // Re-enter the reserved dir with the SAME single-component proof AND
    // repeat the exact owner proof — a real-directory replacement raced in
    // at this seam (same path, foreign or missing owner) must lose zero
    // bytes: type/path equality alone cannot tell a rebuilt directory from
    // the claimed one, only the owner bytes can.
    `if [ -L ./${BEAM_RESERVED_DIR} ] || [ ! -d ./${BEAM_RESERVED_DIR} ]; then` +
      ` ${notOwned}; fi`,
    `cd -P -- ./${BEAM_RESERVED_DIR} 2>/dev/null || ${notOwned}`,
    `if [ "$(/bin/pwd -P)" != "$__bp_ws/${BEAM_RESERVED_DIR}" ]; then ${notOwned}; fi`,
    `if [ -L ./${BEAM_OWNER_FILE} ] || [ ! -f ./${BEAM_OWNER_FILE} ] || ` +
      `[ "$(cat ./${BEAM_OWNER_FILE} 2>/dev/null)" != ${shq(owner)} ]; then ${notOwned}; fi`,
    `find . -mindepth 1 -maxdepth 1 ! -name ${shq(BEAM_OWNER_FILE)} -exec rm -rf -- {} +` +
      ` || { echo 'beam: failed to erase beam metadata' >&2; exit 51; }`,
    // Phase A STOPS at the owner marker: it survives as the workspace's
    // identity until Phase B releases it under the persisted receipt.
    // End-state proof in the SAME shell, still holding the reserved-dir
    // inode: it must hold EXACTLY the exact-byte marker, and the root
    // (re-proven via the inode parent) EXACTLY the reserved dir — the
    // receipt this success licenses asserts precisely this layout.
    `if [ "$(ls -A . 2>/dev/null)" != "${BEAM_OWNER_FILE}" ] || [ -L ./${BEAM_OWNER_FILE} ]` +
      ` || [ ! -f ./${BEAM_OWNER_FILE} ] || ` +
      `[ "$(cat ./${BEAM_OWNER_FILE} 2>/dev/null)" != ${shq(owner)} ]; then` +
      ` ${endStateBroken}; fi`,
    `cd .. || exit 51`,
    `if [ "$(/bin/pwd -P)" != "$__bp_ws" ]; then echo 'beam: workspace moved during the` +
      ` purge — refusing' >&2; exit 51; fi`,
    `if [ "$(ls -A . 2>/dev/null)" != "${BEAM_RESERVED_DIR}" ]; then ${endStateBroken}; fi`,
  ];
}

/**
 * Phase B of the two-phase kill purge: release the surviving `.beam/owner`
 * marker of an ALREADY emptied workspace. The caller MUST hold this
 * record's persisted `workspaceContentsPurged` receipt — that receipt is
 * the only license for reading the already-released states (absent
 * workspace, empty root, empty `.beam`, absent marker) as convergence of
 * this record's own crashed release rather than as a foreign replacement.
 *
 * The shell re-enters the workspace, requires the root to hold AT MOST
 * the reserved dir, descends into `.beam` held single-component, requires
 * it to hold AT MOST the exact-byte owner marker, unlinks `./owner`
 * against the held inode, re-proves the root via the inode parent, and
 * best-effort rmdirs `.beam` and the emptied workspace dir itself (each a
 * held single-component `rmdir`, which never follows symlinks and only
 * removes an empty directory). A FOREIGN owner or ANY extra content
 * refuses byte-untouched: receipts license absence, never deletion of
 * bytes the emptied layout should not contain.
 */
export async function releaseOwnedWorkspace(
  t: Transport,
  remoteCwd: string,
  owner: string,
): Promise<"released" | "absent"> {
  assertPurgeablePath(remoteCwd);
  const notOwned = `{ echo ${shq(
    `beam: ${remoteCwd} is not owned by this handoff — refusing to release it ` +
      `(nothing was deleted)`,
  )} >&2; exit 52; }`;
  // assertPurgeablePath proved the path absolute, normalized, and at least
  // two segments deep, so this lexical split names the real parent.
  const parentDir = remoteCwd.slice(0, remoteCwd.lastIndexOf("/")) || "/";
  const baseName = remoteCwd.slice(remoteCwd.lastIndexOf("/") + 1);
  const script = [
    "set -u",
    // Receipt-gated by contract: an absent workspace is this record's own
    // completed release (or the provider already reclaimed the root).
    `if [ ! -e ${shqRemotePath(remoteCwd)} ] && [ ! -L ${shqRemotePath(remoteCwd)} ];` +
      ` then printf '%s\\n' ${shq(WS_ABSENT)}; exit 0; fi`,
    enterWorkspaceScript(remoteCwd),
    `__br_ws="$(/bin/pwd -P)"`,
    // The root may hold AT MOST the reserved dir: Phase A receipted
    // exactly that layout, and this phase's own crash can only have
    // removed entries from it. Anything else is foreign — refuse.
    `__br_entries="$(ls -A . 2>/dev/null)"`,
    `if [ -n "$__br_entries" ] && [ "$__br_entries" != "${BEAM_RESERVED_DIR}" ];` +
      ` then ${notOwned}; fi`,
    ...releaseOwnedWorkspaceReservedLines({ owner, notOwned }),
    // Best-effort removal of the emptied workspace dir itself, relative-
    // held from its physical parent: rmdir never follows a symlink and
    // only removes an EMPTY directory, so the worst a same-name race can
    // lose is an empty shell. The release itself already converged —
    // failure here is not an error (the provider destroy owns the root).
    `if cd .. 2>/dev/null && [ "$(/bin/pwd -P)" = ${shq(parentDir)} ]; then` +
      ` rmdir ./${shq(baseName)} 2>/dev/null || true; fi`,
    `printf '%s\\n' ${shq(WS_RELEASED)}`,
  ].join("\n");
  const result = await runContainment(t, script);
  if (result === WS_ABSENT) return "absent";
  if (result === WS_RELEASED) return "released";
  throw new Error(
    `beam: release of ${remoteCwd} produced no proof (got: ${result || "no output"}) — ` +
      `refusing to continue`,
  );
}

/**
 * Held single-component descent into the reserved dir (lstat no-follow,
 * cd -P, physical-identity proof), the exact-owner unlink of `./owner`
 * against the held inode, and the inode-parent return with a best-effort
 * rmdir of the emptied reserved dir.
 */
function releaseOwnedWorkspaceReservedLines(opts: {
  owner: string;
  notOwned: string;
}): string[] {
  const { owner, notOwned } = opts;
  return [
    `if [ -n "$__br_entries" ]; then`,
    // Held single-component descent into the reserved dir (lstat
    // no-follow, cd -P, physical-identity proof) before touching
    // `./owner` — never a two-component pathname after the proof.
    `  if [ -L ./${BEAM_RESERVED_DIR} ] || [ ! -d ./${BEAM_RESERVED_DIR} ]; then` +
      ` ${notOwned}; fi`,
    `  cd -P -- ./${BEAM_RESERVED_DIR} 2>/dev/null || ${notOwned}`,
    `  if [ "$(/bin/pwd -P)" != "$__br_ws/${BEAM_RESERVED_DIR}" ]; then ${notOwned}; fi`,
    `  __br_be="$(ls -A . 2>/dev/null)"`,
    // At most the exact marker: empty means this record's own release
    // already unlinked it (mid-B crash) — converged, nothing to delete.
    `  if [ -n "$__br_be" ] && [ "$__br_be" != "${BEAM_OWNER_FILE}" ]; then ${notOwned}; fi`,
    `  if [ -n "$__br_be" ]; then`,
    `    if [ -L ./${BEAM_OWNER_FILE} ] || [ ! -f ./${BEAM_OWNER_FILE} ] || ` +
      `[ "$(cat ./${BEAM_OWNER_FILE} 2>/dev/null)" != ${shq(owner)} ]; then ${notOwned}; fi`,
    `    rm -f ./${BEAM_OWNER_FILE} || { echo 'beam: failed to release the owner marker'` +
      ` >&2; exit 51; }`,
    `  fi`,
    // Back to the held workspace via the INODE parent, re-proven
    // physically, then best-effort rmdir of the now-empty reserved dir.
    `  cd .. || exit 51`,
    `  if [ "$(/bin/pwd -P)" != "$__br_ws" ]; then echo 'beam: workspace moved during the` +
      ` release — refusing' >&2; exit 51; fi`,
    `  rmdir ./${BEAM_RESERVED_DIR} 2>/dev/null || true`,
    `fi`,
  ];
}

/**
 * Strict full-tree manifest of one uploaded workspace: `d <path>` per
 * directory, `f <sha256> <path>` per regular file, `l <sha256-of-target>
 * <path>` per symlink, whole-line byte-sorted, digested. ONLY the exact
 * Beam-owned `./.beam` subtree is pruned — source-config excludes are
 * deliberately NOT applied, because the materialized ship stage already
 * omits excluded paths, so ANY remote extra (an excluded-name secret
 * included) shows up as a mismatch. Non-regular specials and
 * manifest-breaking names refuse: a tree that cannot be byte-proven never
 * licenses an agent start. Computable identically on the target (shell)
 * and over the local stage.
 */
export interface WorkspaceTreeFingerprint {
  digest: string;
  entries: number;
}

const WS_FP_SENTINEL = "__beam_ws_fp_v1__";

export async function remoteWorkspaceTreeFingerprint(
  t: Transport,
  remoteCwd: string,
): Promise<WorkspaceTreeFingerprint> {
  const prune = `-path ./.beam -prune -o`;
  const script = [
    "set -u",
    enterWorkspaceScript(remoteCwd),
    `__beam_odd=$(find . ${prune} ! -type f ! -type d ! -type l -print | LC_ALL=C sort)`,
    `if [ -n "$__beam_odd" ]; then printf '%s\\n' ${shq(
      `beam: the shipped workspace contains non-regular entries (device/fifo/socket)` +
        ` — refusing to prove it:`,
    )} "$__beam_odd" >&2; exit 82; fi`,
    `__beam_nl='*`,
    `*'`,
    `if [ -n "$(find . ${prune} -name "$__beam_nl" -print)" ] || ` +
      `[ -n "$(find . ${prune} -name '*\\\\*' -print)" ]; then echo ${shq(
      `beam: the shipped workspace contains file names with newlines or backslashes` +
        ` — refusing to prove an unprovable tree`,
    )} >&2; exit 82; fi`,
    `if command -v sha256sum >/dev/null 2>&1; then __beam_hash=sha256sum; ` +
      `elif command -v shasum >/dev/null 2>&1; then __beam_hash='shasum -a 256'; ` +
      `else echo ${shq(
        `beam: no sha256 tool (sha256sum or shasum) on the target — cannot prove the` +
          ` uploaded workspace`,
      )} >&2; exit 80; fi`,
    `__beam_manifest=$({ find . ${prune} -type d -print | sed 's/^/d /'; ` +
      `find . ${prune} -type f -exec $__beam_hash {} + | ` +
      `sed -n 's/^\\([0-9a-f]\\{64\\}\\)[ ][ *]\\(.*\\)$/f \\1 \\2/p'; ` +
      `find . ${prune} -type l -print | while IFS= read -r __beam_link; do ` +
      `printf 'l %s %s\\n' "$(printf '%s' "$(readlink -- "$__beam_link")" | ` +
      `$__beam_hash | awk '{print $1}')" "$__beam_link"; done; } | LC_ALL=C sort)`,
    `__beam_fc=$(find . ${prune} -type f -print | wc -l)`,
    `__beam_fm=$(printf '%s\\n' "$__beam_manifest" | grep -c '^f ' || true)`,
    `if [ "$((__beam_fc))" -ne "$((__beam_fm))" ]; then echo "beam: the workspace proof` +
      ` hashed $__beam_fm of $__beam_fc files — refusing an incomplete proof" >&2;` +
      ` exit 81; fi`,
    `__beam_digest=$(printf '%s\\n' "$__beam_manifest" | $__beam_hash | awk '{print $1}')`,
    `__beam_total=$(printf '%s\\n' "$__beam_manifest" | wc -l)`,
    `printf '%s %s %s\\n' ${shq(WS_FP_SENTINEL)} "$__beam_digest" "$((__beam_total))"`,
  ].join("\n");
  const out = await t.execChecked(script);
  const lines = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const last = lines[lines.length - 1] ?? "";
  const m = new RegExp(`^${WS_FP_SENTINEL} ([0-9a-f]{64}) ([0-9]+)$`).exec(last);
  // The count crosses a trust boundary as raw digits: only a safe
  // nonnegative integer is a usable proof — a digit run past 2^53-1 would
  // round silently and could mask a mismatched tree.
  const entries = m === null ? Number.NaN : Number(m[2]!);
  if (m === null || !Number.isSafeInteger(entries) || entries < 0) {
    throw new Error(
      `beam: the uploaded-workspace proof produced no result (got: ${last || "no output"})` +
        ` — refusing`,
    );
  }
  return { digest: m[1]!, entries };
}

/**
 * Directory-depth ceiling for the explicit tree-walk stacks below. Real
 * filesystems cap a whole path near PATH_MAX (4096 bytes on Linux, 1024 on
 * macOS), so a walk deeper than this means a cycle or a runaway tree —
 * refuse instead of walking forever.
 */
const MAX_TREE_DEPTH = 4096;

/** One directory being scanned by an explicit preorder tree walk. */
interface TreeWalkFrame {
  dir: string;
  label: string;
  /** Child names in readdir order; `next` is the first not yet visited. */
  entries: string[];
  next: number;
}

/** The exact same manifest computed over the local materialized ship stage. */
export function stagedWorkspaceTreeFingerprint(stageDir: string): WorkspaceTreeFingerprint {
  const lines: Buffer[] = [];
  // Explicit preorder stack (Tiger: no recursion). The top frame is the
  // directory being scanned; entering a subdirectory pushes a frame, so
  // stack depth equals directory depth and MAX_TREE_DEPTH bounds it. Each
  // iteration consumes one child name or pops a frame, so the walk over a
  // finite tree terminates.
  lines.push(Buffer.from("d .", "utf8"));
  const stack: TreeWalkFrame[] = [
    { dir: stageDir, label: ".", entries: readdirSync(stageDir), next: 0 },
  ];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.next === top.entries.length) {
      stack.pop();
      continue;
    }
    const entry = top.entries[top.next]!;
    top.next += 1;
    if (entry.includes("\n") || entry.includes("\\")) {
      throw new Error(
        `beam: the ship stage contains an unprovable file name under ${top.dir} — refusing`,
      );
    }
    const path = join(top.dir, entry);
    const label = `${top.label}/${entry}`;
    const st = lstatSync(path);
    if (st.isDirectory()) {
      if (stack.length === MAX_TREE_DEPTH) {
        throw new Error(
          `beam: the ship stage is deeper than ${MAX_TREE_DEPTH} directories at ${path}` +
            ` — refusing to walk a cyclic or runaway tree`,
        );
      }
      lines.push(Buffer.from(`d ${label}`, "utf8"));
      stack.push({ dir: path, label, entries: readdirSync(path), next: 0 });
    } else {
      if (st.isFile()) {
        lines.push(Buffer.from(`f ${fileSha256(path)} ${label}`, "utf8"));
      } else {
        if (st.isSymbolicLink()) {
          const h = new Bun.CryptoHasher("sha256");
          h.update(readlinkSync(path, "buffer"));
          lines.push(Buffer.from(`l ${h.digest("hex")} ${label}`, "utf8"));
        } else {
          throw new Error(
            `beam: the ship stage contains an unsafe filesystem entry: ${path}`,
          );
        }
      }
    }
  }
  lines.sort(Buffer.compare);
  const h = new Bun.CryptoHasher("sha256");
  const nl = Buffer.from("\n");
  for (const line of lines) {
    h.update(line);
    h.update(nl);
  }
  return { digest: h.digest("hex"), entries: lines.length };
}

/**
 * Shell fragment that enters the persisted canonical workspace and holds
 * its inode as the shell's cwd: every later line in the SAME shell that
 * uses `./`-relative paths binds to the proven directory even if the
 * lexical workspace path is swapped for a symlink concurrently. Absolute
 * paths do NOT inherit this pin — they re-walk the (possibly replaced)
 * lexical chain — so everything after this fragment must stay relative.
 */
export function enterWorkspaceScript(remoteCwd: string): string {
  const expected = shqRemotePath(remoteCwd);
  return [
    `cd -P -- ${expected} || { echo ${shq(
      `beam: cannot enter workspace ${remoteCwd}`,
    )} >&2; exit 62; }`,
    `__beam_actual=$(/bin/pwd -P)`,
    `if [ "$__beam_actual" != ${expected} ]; then echo ${shq(
      `beam: workspace path no longer resolves to ${remoteCwd}`,
    )} >&2; exit 62; fi`,
  ].join("\n");
}

/*
 * ------------------------------------------------------------------------
 * Reserved workspace upload stage (beam up, every handoff)
 *
 * The workspace mirror NEVER syncs into the live workspace root: rsync/tar
 * receivers overwrite by name, so a foreign same-name file created after
 * the establish emptiness/ownership check would be silently replaced. A
 * ship instead lands the exact staged mirror in an owner-held reserved
 * stage — `.beam/uploads/<generation>/workspace`, generation = the
 * journaled strict workspace digest, so a crashed attempt's retry
 * converges onto the SAME stage — and one owner-held shell then PUBLISHES
 * the stage into the held root strictly CREATE-ONLY: mkdir(2) for
 * directories, link(2) for regular files (same filesystem — content and
 * mode ride the shared inode), symlink(2) for symlinks. All three fail
 * EEXIST instead of following or replacing an existing entry, so a
 * concurrent foreign file at any seam survives byte-for-byte and the ship
 * refuses. An existing entry is accepted ONLY when it already IS the
 * staged one — exact bytes (`cmp -s`) AND exact mode for regular files,
 * exact `readlink` target for symlinks (link modes are not portable
 * state, matching the tree fingerprint's semantics), a real non-link
 * directory for dirs — which is exactly what makes a retried publish
 * idempotent.
 *
 * Mode identity is the `ls -ld` permission field (columns 1-10: type plus
 * nine perm chars, setuid/setgid/sticky included) — the one portable
 * POSIX rendering of a mode; both sides are rendered by the SAME ls on
 * the SAME target, and ACL/xattr markers (column 11+) are deliberately
 * outside the identity. A directory this script CREATES replicates the
 * staged mode by translating that field into absolute symbolic
 * `u=,g=,o=` clauses for `mkdir -m` (`=` clauses, so the target umask is
 * irrelevant); regular files never need a chmod (the hardlink IS the
 * staged inode), and nothing this script did not create is ever chmod'd.
 *
 * Trust posture inside the ONE shell: the live-root side of every publish
 * is reached by a fresh single-component no-follow descent from the HELD
 * root inode, re-proven with `$(/bin/pwd -P)` per hop (the pwd BUILTIN
 * canonicalizes the cached $PWD and misses a rename+replacement). The
 * stage side is read through the physical stage path captured after the
 * fused owner-proven descent — stage reads are Beam-reserved territory
 * (same class as the session-install commit's relative `.beam/...`
 * reads), and a swapped stage can only change what is READ, never where
 * a byte lands; the strict stage-vs-live fingerprint proof that follows
 * every publish refuses any such game.
 * ------------------------------------------------------------------------
 */

/** Guard an upload-stage generation as one safe path component (a journaled workspace digest). */
function assertUploadGeneration(generation: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(generation)) {
    throw new Error(`beam: invalid workspace upload generation: ${JSON.stringify(generation)}`);
  }
}

/**
 * Reserved per-generation upload stage, relative to the workspace root.
 * Lives under `.beam`, so the single reserved mirror exclude protects it
 * in both directions, the workspace tree fingerprint prunes it, and no
 * sibling name can collide with user paths.
 */
export function workspaceUploadStagePath(generation: string): string {
  assertUploadGeneration(generation);
  return `${BEAM_RESERVED_DIR}/uploads/${generation}/workspace`;
}

/**
 * Test-only interposition: runs immediately before the create-only publish
 * walks the landed stage into the live root.
 */
export const workspacePublishTestSeam: {
  beforePublish?: (remoteCwd: string) => void | Promise<void>;
} = {};

/**
 * Publish one generation's landed upload stage into the live workspace
 * root — ONE owner-held shell, strictly create-only (see the section
 * comment above). Idempotent: re-running it over a partial landing
 * completes it, over a complete one proves it, and over any divergent
 * entry refuses with the entry byte-intact.
 */
export async function publishWorkspaceUploadStage(
  t: Transport,
  remoteCwd: string,
  generation: string,
  owner: string,
): Promise<void> {
  await workspacePublishTestSeam.beforePublish?.(remoteCwd);
  const rel = workspaceUploadStagePath(generation);
  const script = [
    "set -u",
    enterWorkspaceScript(remoteCwd),
    ...publishWorkspaceUploadStageProbeLines({ owner, rel }),
    ...publishWorkspaceUploadStageShellLines(),
    ...publishWorkspaceUploadStageDirPassLines(),
    ...publishWorkspaceUploadStageFilePassLines(),
    ...publishWorkspaceUploadStageLinkPassLines(),
  ].join("\n");
  await t.execChecked(script);
}

/**
 * Enter the owner-proven stage, refuse unprovable trees before any
 * live-root effect, then return to the HELD root and pin the stage paths.
 */
function publishWorkspaceUploadStageProbeLines(opts: { owner: string; rel: string }): string[] {
  const hops = opts.rel.split("/");
  return [
    // Owner proven WHILE HOLDING the `.beam` inode, then a no-follow
    // descent into the stage: the shell ends INSIDE the very stage whose
    // chain it just proved — never a rewalk.
    ownedDestinationScript(opts.owner, hops, { create: false }),
    "__beam_pw_stage=$(/bin/pwd -P) || exit 66",
    // Same unprovable-tree posture as the workspace fingerprint: special
    // entries and names with newlines or backslashes refuse BEFORE any
    // live-root effect.
    "__beam_pw_odd=$(find . ! -type f ! -type d ! -type l -print | LC_ALL=C sort)",
    `if [ -n "$__beam_pw_odd" ]; then printf '%s\\n' ${shq(
      "beam: the staged workspace upload contains non-regular entries (device/fifo/socket)" +
        " — refusing to publish it:",
    )} "$__beam_pw_odd" >&2; exit 82; fi`,
    "__beam_nl='*",
    "*'",
    `if [ -n "$(find . -name "$__beam_nl" -print)" ] || ` +
      `[ -n "$(find . -name '*\\\\*' -print)" ]; then echo ${shq(
      "beam: the staged workspace upload contains file names with newlines or backslashes" +
        " — refusing to publish an unprovable tree",
    )} >&2; exit 82; fi`,
    // Back to the HELD root via the proven chain's inode parents — a
    // pathname rewalk could follow a raced swap; `..` of held inodes
    // cannot.
    `cd ${hops.map(() => "..").join("/")} || exit 66`,
    `if [ "$(/bin/pwd -P)" != "$__beam_actual" ]; then echo ${shq(
      "beam: the workspace moved during the publish — refusing",
    )} >&2; exit 66; fi`,
    `__beam_pw_root=${shq(`./${opts.rel}`)}`,
  ];
}

/**
 * Shell function definitions shared by the three publish passes: the
 * re-proven no-follow live-root descent and the `ls -ld` mode identity
 * helpers (see the section comment above).
 */
function publishWorkspaceUploadStageShellLines(): string[] {
  return [
    // Enter live directory $1 (root-relative, possibly empty) from the
    // held root: one no-follow component per hop, each re-proven
    // physically. Runs inside a per-entry subshell, so `exit` refuses just
    // that entry's publication and the pipeline propagates the code.
    "__beam_pw_enter() {",
    "  __beam_pw_prefix=$(/bin/pwd -P) || exit 66",
    '  [ -z "$1" ] && return 0',
    "  __beam_pw_oifs=$IFS; IFS=/; set -f; set -- $1; set +f; IFS=$__beam_pw_oifs",
    '  for __beam_pw_c in "$@"; do',
    '    if [ -L "./$__beam_pw_c" ] || [ ! -d "./$__beam_pw_c" ]; then echo "beam:' +
      ' $__beam_pw_c is not a real directory in the live workspace — refusing the' +
      ' publish" >&2; exit 78; fi',
    '    cd -P -- "./$__beam_pw_c" 2>/dev/null || { echo "beam: cannot enter $__beam_pw_c' +
      ' in the live workspace — refusing the publish" >&2; exit 78; }',
    '    __beam_pw_prefix="$__beam_pw_prefix/$__beam_pw_c"',
    '    if [ "$(/bin/pwd -P)" != "$__beam_pw_prefix" ]; then echo "beam: $__beam_pw_c no' +
      ' longer resolves inside the live workspace — refusing the publish" >&2; exit 78; fi',
    "  done",
    "}",
    // THE portable mode identity: type char + nine perm chars off ls -ld.
    '__beam_pw_lsmode() { ls -ldn -- "$1" | cut -c1-10; }',
    // One ls triplet -> chmod perm letters (s/S/t/T expanded exactly);
    // anything else is an unsupported mode and refuses fail-closed.
    "__beam_pw_perm() {",
    '  __beam_pw_pp=""',
    '  case "$1" in (r??) __beam_pw_pp=r ;; (-??) ;; (*) exit 81 ;; esac',
    '  case "$1" in (?w?) __beam_pw_pp="${__beam_pw_pp}w" ;; (?-?) ;; (*) exit 81 ;; esac',
    '  case "$1" in (??x) __beam_pw_pp="${__beam_pw_pp}x" ;;' +
      ' (??s) __beam_pw_pp="${__beam_pw_pp}xs" ;; (??S) __beam_pw_pp="${__beam_pw_pp}s" ;;' +
      ' (??t) __beam_pw_pp="${__beam_pw_pp}xt" ;; (??T) __beam_pw_pp="${__beam_pw_pp}t" ;;' +
      " (??-) ;; (*) exit 81 ;; esac",
    '  printf %s "$__beam_pw_pp"',
    "}",
    // Staged ls mode field -> absolute symbolic mkdir -m mode.
    "__beam_pw_dirmode() {",
    '  __beam_pw_du=$(__beam_pw_perm "$(printf %s "$1" | cut -c2-4)") || exit 81',
    '  __beam_pw_dg=$(__beam_pw_perm "$(printf %s "$1" | cut -c5-7)") || exit 81',
    '  __beam_pw_do=$(__beam_pw_perm "$(printf %s "$1" | cut -c8-10)") || exit 81',
    '  printf "u=%s,g=%s,o=%s" "$__beam_pw_du" "$__beam_pw_dg" "$__beam_pw_do"',
    "}",
  ];
}

/**
 * Pass 1: directories, parents first (byte order sorts a strict prefix
 * before its children). Created dirs replicate the staged mode at
 * creation (`mkdir -m` — never a chmod on an entry that might not be
 * ours); an existing entry is accepted ONLY as a real non-link dir.
 */
function publishWorkspaceUploadStageDirPassLines(): string[] {
  return [
    'find "$__beam_pw_root" -type d -print | LC_ALL=C sort | {',
    "  while IFS= read -r __beam_pw_p; do",
    '    [ "$__beam_pw_p" = "$__beam_pw_root" ] && continue',
    '    __beam_pw_r=${__beam_pw_p#"$__beam_pw_root"/}',
    "    (",
    '      case "$__beam_pw_r" in (*/*) __beam_pw_parent=${__beam_pw_r%/*} ;;' +
      " (*) __beam_pw_parent= ;; esac",
    "      __beam_pw_b=${__beam_pw_r##*/}",
    '      __beam_pw_m=$(__beam_pw_lsmode "$__beam_pw_stage/$__beam_pw_r")',
    '      case "$__beam_pw_m" in (d?????????) ;; (*) echo "beam: staged entry $__beam_pw_r' +
      ' is no longer a directory — refusing the publish" >&2; exit 78 ;; esac',
    '      __beam_pw_sym=$(__beam_pw_dirmode "$__beam_pw_m") || { echo "beam: unsupported' +
      ' staged directory mode $__beam_pw_m on $__beam_pw_r — refusing the publish" >&2;' +
      " exit 81; }",
    '      __beam_pw_enter "$__beam_pw_parent"',
    '      if mkdir -m "$__beam_pw_sym" -- "./$__beam_pw_b" 2>/dev/null; then :;' +
      ' elif [ ! -L "./$__beam_pw_b" ] && [ -d "./$__beam_pw_b" ]; then :; else',
    '        echo "beam: $__beam_pw_r already exists in the live workspace and is not a' +
      ' real directory — refusing the publish (nothing was overwritten)" >&2; exit 79',
    "      fi",
    "    ) || exit $?",
    "  done",
    "} || exit $?",
  ];
}

/**
 * Pass 2: regular files via link(2) — create-only, and the live entry IS
 * the staged inode (bytes and mode by construction). EEXIST accepts only
 * exact bytes AND exact mode; a foreign file survives byte-intact behind
 * the refusal.
 */
function publishWorkspaceUploadStageFilePassLines(): string[] {
  return [
    'find "$__beam_pw_root" -type f -print | {',
    "  while IFS= read -r __beam_pw_p; do",
    '    __beam_pw_r=${__beam_pw_p#"$__beam_pw_root"/}',
    "    (",
    '      case "$__beam_pw_r" in (*/*) __beam_pw_parent=${__beam_pw_r%/*} ;;' +
      " (*) __beam_pw_parent= ;; esac",
    "      __beam_pw_b=${__beam_pw_r##*/}",
    '      __beam_pw_enter "$__beam_pw_parent"',
    '      if ln -- "$__beam_pw_stage/$__beam_pw_r" "./$__beam_pw_b" 2>/dev/null; then :;' +
      " else",
    '        if [ ! -e "./$__beam_pw_b" ] && [ ! -L "./$__beam_pw_b" ]; then echo "beam:' +
      ' cannot hardlink $__beam_pw_r into the live workspace — refusing the publish" >&2;' +
      " exit 78; fi",
    '        if [ -L "./$__beam_pw_b" ] || [ ! -f "./$__beam_pw_b" ]; then echo "beam:' +
      ' $__beam_pw_r already exists in the live workspace and is not a regular file —' +
      ' refusing the publish (nothing was overwritten)" >&2; exit 79; fi',
    '        cmp -s -- "$__beam_pw_stage/$__beam_pw_r" "./$__beam_pw_b" || { echo "beam:' +
      ' $__beam_pw_r already exists in the live workspace with different content —' +
      ' refusing the publish (the existing file was left byte-intact)" >&2; exit 79; }',
    '        __beam_pw_sm=$(__beam_pw_lsmode "$__beam_pw_stage/$__beam_pw_r")',
    '        case "$__beam_pw_sm" in (-?????????) ;; (*) echo "beam: staged entry' +
      ' $__beam_pw_r is no longer a regular file — refusing the publish" >&2;' +
      " exit 78 ;; esac",
    '        if [ "$__beam_pw_sm" != "$(__beam_pw_lsmode "./$__beam_pw_b")" ]; then echo' +
      ' "beam: $__beam_pw_r already exists in the live workspace with a different mode —' +
      ' refusing the publish (nothing was overwritten)" >&2; exit 79; fi',
    "      fi",
    "    ) || exit $?",
    "  done",
    "} || exit $?",
  ];
}

/**
 * Pass 3: symlinks — create-only; EEXIST accepts only a symlink with the
 * exact staged target.
 */
function publishWorkspaceUploadStageLinkPassLines(): string[] {
  return [
    'find "$__beam_pw_root" -type l -print | {',
    "  while IFS= read -r __beam_pw_p; do",
    '    __beam_pw_r=${__beam_pw_p#"$__beam_pw_root"/}',
    "    (",
    '      case "$__beam_pw_r" in (*/*) __beam_pw_parent=${__beam_pw_r%/*} ;;' +
      " (*) __beam_pw_parent= ;; esac",
    "      __beam_pw_b=${__beam_pw_r##*/}",
    '      __beam_pw_t=$(readlink -- "$__beam_pw_stage/$__beam_pw_r") || { echo "beam:' +
      ' cannot read the staged symlink $__beam_pw_r — refusing the publish" >&2;' +
      " exit 78; }",
    '      __beam_pw_enter "$__beam_pw_parent"',
    '      if ln -s -- "$__beam_pw_t" "./$__beam_pw_b" 2>/dev/null; then :; else',
    '        if [ ! -L "./$__beam_pw_b" ]; then echo "beam: $__beam_pw_r already exists in' +
      ' the live workspace and is not a symlink — refusing the publish (nothing was' +
      ' overwritten)" >&2; exit 79; fi',
    '        [ "$(readlink -- "./$__beam_pw_b")" = "$__beam_pw_t" ] || { echo "beam:' +
      ' $__beam_pw_r already exists in the live workspace with a different symlink' +
      ' target — refusing the publish (nothing was overwritten)" >&2; exit 79; }',
    "      fi",
    "    ) || exit $?",
    "  done",
    "} || exit $?",
  ];
}

/** Stdout sentinel for the provable present/absent stage probe result. */
const UPLOAD_STAGE_SENTINEL = "__beam_upload_stage_v1__";

/**
 * Whether one generation's reserved upload stage exists on the target,
 * proven through the fused owner-held no-follow descent. Only a cleanly
 * MISSING chain component (exit 67) reads as absent; an owner refusal or
 * a swapped/symlinked chain stays fatal — an unprovable stage is never
 * reported "absent".
 */
export async function remoteWorkspaceUploadStagePresent(
  t: Transport,
  remoteCwd: string,
  generation: string,
  owner: string,
): Promise<boolean> {
  const script = [
    "set -u",
    enterWorkspaceScript(remoteCwd),
    "__beam_us_rc=0",
    "(",
    ownedDestinationScript(owner, workspaceUploadStagePath(generation).split("/"), {
      create: false,
    }),
    ") >/dev/null 2>&1 || __beam_us_rc=$?",
    `if [ "$__beam_us_rc" = 0 ]; then printf '%s present\\n' ${shq(UPLOAD_STAGE_SENTINEL)};`,
    `elif [ "$__beam_us_rc" = 67 ]; then printf '%s absent\\n' ${shq(UPLOAD_STAGE_SENTINEL)};`,
    `elif [ "$__beam_us_rc" = 52 ]; then echo ${shq(
      "beam: the workspace is not owned by this handoff — refusing",
    )} >&2; exit 52;`,
    `else echo ${shq("beam: the reserved upload stage cannot be proven — refusing")} >&2;` +
      ` exit "$__beam_us_rc"; fi`,
  ].join("\n");
  const lines = (await t.execChecked(script))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const last = lines[lines.length - 1] ?? "";
  if (last === `${UPLOAD_STAGE_SENTINEL} present`) return true;
  if (last === `${UPLOAD_STAGE_SENTINEL} absent`) return false;
  throw new Error(
    `beam: the upload-stage probe produced no result (got: ${last || "no output"}) — refusing`,
  );
}

/**
 * Reap one generation's reserved upload stage after its publish PROOF was
 * journaled: `./`-relative `rm -rf` of the generation dir inside the
 * owner-held `uploads` dir, one shell, fused owner proof. Idempotent — an
 * already-missing chain (exit 67) or generation dir is a converged reap,
 * never an error.
 */
export async function removeWorkspaceUploadStage(
  t: Transport,
  remoteCwd: string,
  generation: string,
  owner: string,
): Promise<void> {
  assertUploadGeneration(generation);
  const genQ = shq(generation);
  const script = [
    "set -u",
    enterWorkspaceScript(remoteCwd),
    "__beam_ur_rc=0",
    "(",
    ownedDestinationScript(owner, [BEAM_RESERVED_DIR, "uploads"], { create: false }),
    `if [ -L ./${genQ} ]; then echo ${shq(
      "beam: the reserved upload stage is a symlink — refusing its removal",
    )} >&2; exit 61; fi`,
    `rm -rf -- ./${genQ}`,
    ") || __beam_ur_rc=$?",
    'if [ "$__beam_ur_rc" != 0 ] && [ "$__beam_ur_rc" != 67 ]; then exit "$__beam_ur_rc"; fi',
  ].join("\n");
  await t.execChecked(script);
}

/*
 * ------------------------------------------------------------------------
 * Staged workspace return (beam down, every handoff)
 *
 * `beam down` NEVER mutates the live local workspace or checkout. The
 * remote filtered worktree is collected into a Beam-owned
 * staging directory, proven to be ONE stable remote snapshot, and then
 * PERSISTED create-only under Beam's trusted storage
 * (`<beamDir>/returns/<record>/<txn>/workspace`) with a manifest receipt.
 * Integrating the returned files into the live worktree is the user's
 * explicit act (rsync/diff from the persisted stage) — an automatic apply
 * over a live tree cannot be made atomic on any portable filesystem, and
 * beam does not pretend otherwise. A remote workspace that was deleted,
 * recreated, or replaced therefore can never land a byte in (or delete a
 * byte from) the local worktree.
 *
 * The exclusion filter is never reimplemented: every collection below runs
 * through the transport's own syncDown with the exact synced exclude
 * union, so the staged tree and every verification probe see precisely
 * the mirrored namespace — paths eligible for the workspace return, with
 * `.git`, the Beam reserved dir, the re-ship transaction entries, and all
 * config/.beamignore patterns excluded by the same engine that excluded
 * them outbound. Any divergence between two collections shows up as a
 * fingerprint mismatch and refuses; it can never silently widen or shrink
 * the returned set.
 * ------------------------------------------------------------------------
 */

/**
 * One byte-level fingerprint of a staged mirrored namespace: every
 * directory, regular file content hash, symlink target hash, and special
 * entry, NUL-separated and byte-sorted, digested. Records contain no NUL
 * (filesystems forbid NUL in names) and the separator is NUL, so the
 * encoding is injective — no crafted file name can make two different
 * trees fold to one manifest. Permission modes (`mode & 0o7777`) are
 * included for files and directories: every transport preserves them
 * (`rsync -a`, tar streams), so a chmod-only remote change is returned
 * state and must mismatch — and a later chmod inside a persisted stage is
 * detectable against its receipt. Symlink/special modes are excluded
 * (platform-defined, not meaningfully transported), as is the ROOT
 * directory's mode: the stage and probe roots are beam-created container
 * directories, and root-permission propagation into a pre-existing
 * destination is not portable across rsync implementations. mtimes are
 * excluded: they do not survive every transport and carry no return
 * semantics.
 */
export interface WorkspaceReturnFingerprint {
  /** sha256 over the sorted NUL-separated manifest records. */
  digest: string;
  /** Total manifest entries — a cheap diagnostic for mismatch messages. */
  entries: number;
}

export function workspaceReturnFingerprint(dir: string): WorkspaceReturnFingerprint {
  const records: Buffer[] = [];
  const modeOf = (mode: number): string => (mode & 0o7777).toString(8).padStart(4, "0");
  // Explicit preorder stack (Tiger: no recursion) — bound and termination
  // argument as in stagedWorkspaceTreeFingerprint above. The ROOT record
  // carries no mode (see the doc comment above).
  records.push(Buffer.from("d .", "utf8"));
  const stack: TreeWalkFrame[] = [{ dir, label: ".", entries: readdirSync(dir), next: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.next === top.entries.length) {
      stack.pop();
      continue;
    }
    const entry = top.entries[top.next]!;
    top.next += 1;
    const path = join(top.dir, entry);
    const st = lstatSync(path);
    const childLabel = `${top.label}/${entry}`;
    if (st.isDirectory()) {
      if (stack.length === MAX_TREE_DEPTH) {
        throw new Error(
          `beam: the return stage is deeper than ${MAX_TREE_DEPTH} directories at ${path} ` +
            `— refusing to walk a cyclic or runaway tree`,
        );
      }
      records.push(Buffer.from(`d ${modeOf(st.mode)} ${childLabel}`, "utf8"));
      stack.push({ dir: path, label: childLabel, entries: readdirSync(path), next: 0 });
    } else {
      if (st.isFile()) {
        const hash = fileSha256(path);
        records.push(Buffer.from(`f ${modeOf(st.mode)} ${hash} ${childLabel}`, "utf8"));
      } else {
        if (st.isSymbolicLink()) {
          // The target is hashed, not embedded: link targets are arbitrary
          // bytes and must not be able to forge record boundaries.
          const target = createHash("sha256")
            .update(readlinkSync(path, "buffer"))
            .digest("hex");
          records.push(Buffer.from(`l ${target} ${childLabel}`, "utf8"));
        } else {
          // Fifos/sockets ride `rsync -a` type-only; devices need root. Pin
          // their existence and name — they have no readable content.
          records.push(Buffer.from(`s ${childLabel}`, "utf8"));
        }
      }
    }
  }
  records.sort(Buffer.compare);
  const h = createHash("sha256");
  const nul = Buffer.from([0]);
  for (const record of records) {
    h.update(record);
    h.update(nul);
  }
  return { digest: h.digest("hex"), entries: records.length };
}

/** A collected remote worktree, staged locally and pinned by fingerprint. */
export interface StagedWorkspaceReturn {
  /** Staging directory holding exactly the mirrored namespace. */
  dir: string;
  /** Pinned fingerprint of the staged tree — the return's authority. */
  fingerprint: WorkspaceReturnFingerprint;
  /** Remove the staging directory (collect-failure cleanup only). */
  dispose(): void;
}

/**
 * Create-only per-attempt return-stage transaction directory under Beam's
 * trusted storage: `<beamDir>/returns/<recordId>/<txn>`. The returned
 * workspace lands in `<txn>/workspace`; the manifest receipt is written
 * LAST, only after every stability proof passed — a directory without a
 * manifest is an unverified partial and never trusted data.
 *
 * Every parent down to the txn root is proven private (0700, real
 * directory, owned by this process) BEFORE any staging write: a returned
 * stage holds the full workspace mirror — secrets included — and the
 * default umask would otherwise leave it traversable by any local user.
 * A symlinked or foreign `returns/<recordId>` refuses here, before a
 * single byte is written through it. Transferred file modes INSIDE
 * `workspace` stay as the transport delivered them; the 0700 ancestors
 * are what block foreign traversal.
 */
export function createReturnStage(
  beamDir: string,
  recordId: string,
): { root: string; workspace: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const parent = ensurePrivateBeamDir(beamDir, "returns", recordId);
  const root = join(parent, `${stamp}-${randomBytes(4).toString("hex")}`);
  // Create-only: a collision (astronomically unlikely) must fail the
  // attempt rather than ever share or reuse a stage.
  mkdirSync(root, { mode: 0o700 });
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  return { root, workspace };
}

/**
 * Collect the remote filtered worktree into `dir` (fresh and empty) and
 * pin its fingerprint. The collect is strictly ADDITIVE (`delete: false`):
 * the destination is a fresh private stage, so there is nothing to
 * delete, and the ship no longer earns (or needs) a live-root mirror
 * license — a delete-licensed transfer would demand exactly that marker
 * and refuse. Exactness never rides rsync semantics anyway: the caller's
 * pre/stage/post fingerprint sandwich proves the collected bytes ARE the
 * stable remote namespace.
 */
export async function stageWorkspaceReturn(
  t: Transport,
  remoteCwd: string,
  dir: string,
  opts: { excludes: string[]; verbose: boolean; owner?: string },
): Promise<StagedWorkspaceReturn> {
  await t.syncDown(remoteCwd, dir, {
    excludes: opts.excludes,
    checksum: true,
    delete: false,
    verbose: opts.verbose,
    ...(opts.owner !== undefined ? { owned: { root: remoteCwd, ownerBytes: opts.owner } } : {}),
  });
  return {
    dir,
    fingerprint: workspaceReturnFingerprint(dir),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Persist the verification receipt beside a fully-proven stage. Its
 * presence marks the stage as verified returned data; every field lets a
 * later reader re-prove the bytes.
 */
export function writeReturnStageManifest(
  root: string,
  manifest: {
    recordId: string;
    remoteCwd: string;
    fingerprint: WorkspaceReturnFingerprint;
    excludes: string[];
    mirrorDeletes: boolean;
  },
): string {
  const file = join(root, "manifest.json");
  // 0600: the receipt names remote paths and the exact exclude set — and
  // sits beside private return data. The 0700 txn root already blocks
  // traversal; the explicit mode keeps the receipt closed even if a stage
  // is later moved out of it.
  writeFileSync(
    file,
    `${JSON.stringify({ ...manifest, createdAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return file;
}

/**
 * Capture the current filtered remote namespace into a fresh local probe
 * and return its byte-level fingerprint. The transport itself applies the
 * exact effective excludes, so this proof cannot drift from syncDown's
 * wildcard semantics. Callers use it immediately before the authoritative
 * stage transfer; equality of pre-probe, stage, and post-probe proves the
 * stage is one stable remote snapshot rather than a torn traversal.
 */
export async function remoteWorkspaceReturnFingerprint(
  t: Transport,
  remoteCwd: string,
  excludes: string[],
  owner?: string,
): Promise<WorkspaceReturnFingerprint> {
  const probe = mkdtempSync(join(tmpdir(), "beam-wsverify-"));
  try {
    await t.syncDown(remoteCwd, probe, {
      excludes,
      checksum: true,
      ...(owner !== undefined ? { owned: { root: remoteCwd, ownerBytes: owner } } : {}),
    });
    return workspaceReturnFingerprint(probe);
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/**
 * Re-prove that the remote mirrored namespace still IS the pinned staged
 * snapshot: a fresh full collection into an empty probe directory,
 * fingerprinted with the same manifest. An empty destination gives the
 * transport no basis to skip against, so the proof is byte-authoritative —
 * a remote writer that preserves sizes, mtimes, or weak rolling checksums
 * still changes this digest.
 *
 * Three copies bracket the return: a probe immediately before staging, the
 * authoritative stage itself, and a probe immediately after staging. The
 * caller requires pre == stage, and this helper requires stage == post, so
 * a detached writer changing any eligible byte anywhere in the collection
 * window refuses instead of publishing a torn or superseded stage. Any work
 * that lands after the final proof remains safe because `beam down` retains
 * the remote; a later down collects it as a new immutable stage.
 */
export async function assertWorkspaceReturnUnchanged(
  t: Transport,
  remoteCwd: string,
  pinned: WorkspaceReturnFingerprint,
  opts: { excludes: string[]; when: string; owner?: string },
): Promise<void> {
  const fp = await remoteWorkspaceReturnFingerprint(t, remoteCwd, opts.excludes, opts.owner);
  if (fp.digest !== pinned.digest || fp.entries !== pinned.entries) {
    throw new Error(
      `beam down: the remote workspace changed ${opts.when} ` +
        `(fingerprint ${pinned.digest.slice(0, 12)} -> ${fp.digest.slice(0, 12)}) — ` +
        `a background process is still writing to it. Refusing to continue past an ` +
        `unstable remote; it is intact, new work included. Stop the remote writer ` +
        `(or just retry beam down to collect the newer state)`,
    );
  }
}

/** A local filtered worktree snapshot, quarantined and proven coherent. */
export interface StagedWorkspaceShip {
  /** Beam-owned immutable staging directory the upload reads from. */
  dir: string;
  /** Remove the staging directory. Idempotent; safe on every outcome. */
  dispose(): void;
}

/**
 * Stage the local mirrored namespace into a fresh quarantine directory and
 * prove the snapshot is COHERENT before anything ships: pass 1 filters the
 * workspace with the exact outbound patterns; pass 2 re-reads every source
 * byte (`--checksum`) into the same stage; the tree fingerprint must be
 * identical after both. A background writer that changes any mirrored byte
 * during the window — even preserving sizes and mtimes — refuses here,
 * BEFORE any remote mutation, instead of shipping a torn multi-file state
 * (file A from before its paired write, file B from after) that the remote
 * would present as one coherent workspace while every Git-level check
 * still passes. The upload then reads ONLY this immutable stage, so the
 * transfer window itself can tear nothing.
 */
export async function stageWorkspaceShip(
  localCwd: string,
  excludes: string[],
  verbose: boolean,
): Promise<StagedWorkspaceShip> {
  // realpath: the tmp root may sit behind a trusted symlink (macOS /var),
  // and the pinned local walk requires a fully canonical destination.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "beam-shipstage-")));
  const pass = (checksum: boolean): Promise<void> =>
    new LocalTransport().syncUp(localCwd, dir, { excludes, checksum, delete: true, verbose });
  try {
    await pass(false);
    const first = workspaceReturnFingerprint(dir);
    await pass(true);
    const second = workspaceReturnFingerprint(dir);
    if (first.digest !== second.digest || first.entries !== second.entries) {
      throw new Error(
        `beam up: the workspace changed while it was being staged for the mirror ` +
          `(fingerprint ${first.digest.slice(0, 12)} -> ${second.digest.slice(0, 12)}) — ` +
          `refusing to ship a torn multi-file snapshot. Stop the local writer ` +
          `(or just retry beam up to stage the newer state)`,
      );
    }
    return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Best-effort one-line git summary for display. */
export async function gitSummary(localCwd: string): Promise<string | undefined> {
  const branch = await run(["git", "-C", localCwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.code !== 0) return undefined;
  const dirty = await run(["git", "-C", localCwd, "status", "--porcelain"]);
  const dirtyCount = dirty.stdout.split("\n").filter((l) => l.trim() !== "").length;
  return `${branch.stdout.trim()}${dirtyCount > 0 ? ` (+${dirtyCount} dirty)` : ""}`;
}
