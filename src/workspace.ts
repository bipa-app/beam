import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "./config.ts";
import { run } from "./util/shell.ts";

/**
 * Deterministic per-workspace directory name under the target root:
 * readable basename plus a cwd digest so distinct checkouts never collide.
 */
export function remoteWorkspaceName(localCwd: string): string {
  const digest = createHash("sha256").update(localCwd).digest("hex").slice(0, 10);
  const base = basename(localCwd).replace(/[^A-Za-z0-9._-]/g, "_") || "workspace";
  return `${base}-${digest}`;
}

/** Merge config excludes with the workspace's .beamignore (rsync patterns). */
export function gatherExcludes(localCwd: string, config: Config): string[] {
  const excludes = [...(config.excludes ?? [])];
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
 * Refuse to rm -rf anything that does not look like a beam workspace path.
 * Shared by `beam down` (purge-by-default) and `beam kill --purge`.
 */
export function assertPurgeablePath(remoteCwd: string): void {
  const suspicious =
    remoteCwd === "/" || remoteCwd.length < 8 || !remoteCwd.includes("/") || remoteCwd.includes("..");
  if (suspicious) throw new Error(`refusing to purge suspicious path: ${remoteCwd}`);
}

/** Best-effort one-line git summary for display. */
export async function gitSummary(localCwd: string): Promise<string | undefined> {
  const branch = await run(["git", "-C", localCwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.code !== 0) return undefined;
  const dirty = await run(["git", "-C", localCwd, "status", "--porcelain"]);
  const dirtyCount = dirty.stdout.split("\n").filter((l) => l.trim() !== "").length;
  return `${branch.stdout.trim()}${dirtyCount > 0 ? ` (+${dirtyCount} dirty)` : ""}`;
}
