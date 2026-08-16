import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "./config.ts";
import { run, shq, shqRemotePath } from "./util/shell.ts";
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
 * Root-anchored rsync exclude for the reserved dir: only the workspace-root
 * `.beam` is beam's — a user's nested `x/.beam` still mirrors normally.
 */
export const BEAM_RESERVED_EXCLUDE = `/${BEAM_RESERVED_DIR}`;

/**
 * Merge config excludes with the workspace's .beamignore (rsync patterns).
 *
 * The reserved `.beam` dir is ALWAYS excluded, first. Beam-owned session
 * data (transcript, artifacts, staged-index patch, sync markers) travels
 * exclusively over explicit per-path transfers (sendFile/fetchFile and
 * dedicated artifact syncs) that ignore workspace filters — so no
 * user/global pattern (`.beam/`, `session.jsonl`, `*.jsonl`, `*`, …) can
 * suppress the grown transcript or let stale local scratch masquerade as
 * returned state, and a `--delete` mirror can never erase it on either
 * side. Root-anchoring keeps the invariant precise without simulating
 * rsync wildcard semantics against user patterns.
 *
 * `.git` metadata never rides the filtered mirror, even when the local
 * workspace is not yet a repository: the sandbox may create one, and its
 * config and hooks must not land on the host unquarantined. Git workspaces
 * instead ship a standalone payload and import it through quarantine.
 * The unanchored pattern also keeps nested submodule `.git` entries home.
 */
export function gatherExcludes(localCwd: string, config: Config): string[] {
  const excludes = [BEAM_RESERVED_EXCLUDE, ...(config.excludes ?? []), ".git"];
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
 * segments), and at least two levels deep. Shared by `beam down`
 * (purge-by-default), `beam kill --purge`, and mirrored ships that empty
 * the destination before writing.
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
/*   - the configured root is resolved physically (`cd && pwd -P`). Root-    */
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

interface ContainmentMode {
  /** Compose the workspace as `<physical root>/<name>` (first ship). */
  name?: string;
  /** Verify a previously persisted canonical workspace path. */
  path?: string;
  /** `mkdir -p` the root and workspace once proven safe (up path). */
  create?: boolean;
  /** A provably absent workspace passes (idempotent purge retries). */
  allowMissing?: boolean;
  /** `rm -rf` the workspace in the SAME shell once containment is proven. */
  purge?: boolean;
}

/** Build the remote proof script. Success prints exactly one result line. */
function containmentScript(root: string, mode: ContainmentMode): string {
  const rootQ = shqRemotePath(root);
  const lines: string[] = ["set -u"];
  if (mode.create) {
    lines.push(`mkdir -p -- ${rootQ} || { echo ${shq(`beam: cannot create workspace root ${root}`)} >&2; exit 40; }`);
  }
  lines.push(
    `__bw_rootp=$(cd -- ${rootQ} 2>/dev/null && pwd -P) || { echo ${shq(`beam: workspace root ${root} does not resolve on the target`)} >&2; exit 41; }`,
    `case "$__bw_rootp" in /?*) ;; *) echo "beam: refusing workspace root resolving to '$__bw_rootp'" >&2; exit 42 ;; esac`,
  );
  if (mode.name !== undefined) {
    lines.push(`__bw_ws="$__bw_rootp/"${shq(mode.name)}`);
  } else {
    lines.push(
      `__bw_ws=${shq(mode.path ?? "")}`,
      `case "$__bw_ws" in "$__bw_rootp"/?*) ;; *) echo ${shq(
        `beam: workspace ${mode.path} is not under the physical root of ${root} — refusing (physical containment)`,
      )}" (root resolves to $__bw_rootp)" >&2; exit 43 ;; esac`,
    );
  }
  lines.push(
    // No-follow walk: every component strictly below the physical root.
    `__bw_rel="\${__bw_ws#"$__bw_rootp"/}"`,
    `__bw_p="$__bw_rootp"`,
    `__bw_ifs="\${IFS-}"; IFS=/; set -f`,
    `for __bw_seg in $__bw_rel; do`,
    `  case "$__bw_seg" in ''|.|..) echo "beam: suspicious workspace path segment in $__bw_ws" >&2; exit 44 ;; esac`,
    `  __bw_p="$__bw_p/$__bw_seg"`,
    `  if [ -L "$__bw_p" ]; then echo "beam: refusing symlinked workspace path component: $__bw_p (physical containment)" >&2; exit 45; fi`,
    `done`,
    `set +f; IFS="$__bw_ifs"`,
  );
  if (mode.allowMissing) {
    lines.push(`if [ ! -e "$__bw_ws" ] && [ ! -L "$__bw_ws" ]; then printf '%s\\n' ${shq(WS_ABSENT)}; exit 0; fi`);
  }
  if (mode.create) {
    lines.push(`mkdir -p -- "$__bw_ws" || { echo "beam: cannot create workspace $__bw_ws" >&2; exit 46; }`);
  }
  lines.push(
    // Re-checked after mkdir on purpose: `mkdir -p` succeeds through a
    // symlink-to-directory, so a link raced in between walk and mkdir must
    // still refuse here.
    `if [ -L "$__bw_ws" ]; then echo "beam: workspace is a symlink — refusing (physical containment): $__bw_ws" >&2; exit 45; fi`,
    `if [ ! -e "$__bw_ws" ]; then echo "beam: workspace missing on the target: $__bw_ws" >&2; exit 49; fi`,
    `if [ ! -d "$__bw_ws" ]; then echo "beam: workspace is not a directory: $__bw_ws" >&2; exit 50; fi`,
    `__bw_wsp=$(cd -- "$__bw_ws" 2>/dev/null && pwd -P) || { echo "beam: workspace does not resolve: $__bw_ws" >&2; exit 47; }`,
    `if [ "$__bw_wsp" != "$__bw_ws" ]; then echo "beam: workspace $__bw_ws physically resolves to $__bw_wsp — path swapped or symlinked; refusing" >&2; exit 48; fi`,
  );
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
    containmentScript(root, { ...("name" in ws ? { name: ws.name } : { path: ws.path }), create: true }),
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
 * physical root, or stopped being a directory. With `allowMissing`, a
 * provably absent workspace returns false instead of throwing (idempotent
 * purge retries).
 */
export async function assertContainedWorkspace(
  t: Transport,
  root: string,
  path: string,
  opts: { allowMissing?: boolean } = {},
): Promise<boolean> {
  assertPurgeablePath(path);
  const result = await runContainment(t, containmentScript(root, { path, allowMissing: opts.allowMissing }));
  return result !== WS_ABSENT;
}

/**
 * Erase a workspace with the containment proof and the `rm -rf` in the SAME
 * remote shell — the tightest check-to-use window a shell transport can
 * offer. An unprovable path refuses (the record stays recoverable); a
 * provably absent one reports "absent" so idempotent purge retries finish.
 */
export async function purgeContainedWorkspace(
  t: Transport,
  root: string,
  path: string,
): Promise<"purged" | "absent"> {
  assertPurgeablePath(path);
  const result = await runContainment(t, containmentScript(root, { path, allowMissing: true, purge: true }));
  if (result === WS_ABSENT) return "absent";
  if (result === WS_PURGED) return "purged";
  throw new Error(`beam: purge of ${path} produced no proof (got: ${result || "no output"}) — refusing to continue`);
}

/**
 * Shell fragment for a transport's OWN destructive step: refuse when the
 * sync root's final component is a symlink, in the SAME remote shell as the
 * tar/find that would otherwise write or delete through it. Commands prove
 * full physical containment separately; this closes the exec-to-exec window
 * on the transport's destructive action itself.
 */
export function noFollowSyncRootGuard(remoteDir: string): string {
  const q = shqRemotePath(remoteDir);
  return `if [ -L ${q} ]; then echo ${shq(`beam: refusing to sync through symlinked path: ${remoteDir}`)} >&2; exit 61; fi`;
}

/**
 * Shell fragment refusing to touch the beam-reserved dir (`<ws>/.beam`)
 * when it is a symlink, for use in the SAME remote shell as any write or
 * delete through it. The workspace mirror never touches `.beam`
 * (BEAM_RESERVED_EXCLUDE), so on a reused (--no-purge) workspace the
 * remote agent may have swapped it for a symlink pointing anywhere it can
 * write — every `rm -rf`, move, or write THROUGH it would then land
 * outside the proven workspace.
 */
export function noFollowReservedDirGuard(remoteCwd: string): string {
  const reserved = `${remoteCwd}/${BEAM_RESERVED_DIR}`;
  const q = shqRemotePath(reserved);
  const refuse = shq(
    `beam: ${reserved} is a symlink — refusing to touch session data through it (physical containment)`,
  );
  return `if [ -L ${q} ]; then echo ${refuse} >&2; exit 62; fi`;
}

/**
 * Shell fragment for a commit that WRITES under the reserved dir (session
 * install, staged-patch landing, sync-marker creation): prove `.beam` is a
 * REAL directory in the SAME remote shell as the resets, moves, and writes
 * that follow, creating it when absent. `mkdir -p` succeeds through a
 * symlink-to-directory, so the link check re-runs after it (same pattern
 * as containmentScript).
 */
export function noFollowReservedDirScript(remoteCwd: string): string {
  const reserved = `${remoteCwd}/${BEAM_RESERVED_DIR}`;
  const q = shqRemotePath(reserved);
  return [
    noFollowReservedDirGuard(remoteCwd),
    `mkdir -p -- ${q} || { echo ${shq(`beam: cannot create ${reserved}`)} >&2; exit 63; }`,
    noFollowReservedDirGuard(remoteCwd),
    `if [ ! -d ${q} ]; then echo ${shq(`beam: ${reserved} is not a directory — refusing`)} >&2; exit 64; fi`,
  ].join("\n");
}

/** Best-effort one-line git summary for display. */
export async function gitSummary(localCwd: string): Promise<string | undefined> {
  const branch = await run(["git", "-C", localCwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.code !== 0) return undefined;
  const dirty = await run(["git", "-C", localCwd, "status", "--porcelain"]);
  const dirtyCount = dirty.stdout.split("\n").filter((l) => l.trim() !== "").length;
  return `${branch.stdout.trim()}${dirtyCount > 0 ? ` (+${dirtyCount} dirty)` : ""}`;
}
