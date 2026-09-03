import { join } from "node:path";
import { run } from "./util/shell.ts";

declare const BEAM_RELEASE_VERSION: string | undefined;

/** Where this beam runs from and which code it is — the answer to "is my beam stale?". */
export interface BeamVersion {
  /** Release tag of a compiled binary, or `dev` for a source checkout. */
  version: string;
  /** `release` for a compiled binary, else the source checkout directory. */
  source: string;
  /** Short HEAD of a source checkout with a Git history; `-dirty` when it has local edits. */
  commit?: string;
}

/**
 * Release builds inject the tag (`--define BEAM_RELEASE_VERSION`), so a
 * compiled binary names itself exactly. A `bun link` install has no tag:
 * it runs whatever the checkout holds, and only the checkout's commit says
 * how old that is (#37: a three-week-stale link was silently missing a
 * merged fix, with no way to tell). Git is asked best-effort — a checkout
 * without history still reports its directory.
 */
export async function beamVersion(): Promise<BeamVersion> {
  if (typeof BEAM_RELEASE_VERSION === "string" && BEAM_RELEASE_VERSION !== "") {
    return { version: BEAM_RELEASE_VERSION, source: "release" };
  }
  const root = join(import.meta.dir, "..");
  const head = await run(["git", "-C", root, "rev-parse", "--short", "HEAD"]);
  if (head.code !== 0) return { version: "dev", source: root };
  const status = await run(["git", "-C", root, "status", "--porcelain", "--untracked-files=no"]);
  const dirty = status.code === 0 && status.stdout.trim() !== "" ? "-dirty" : "";
  return { version: "dev", source: root, commit: `${head.stdout.trim()}${dirty}` };
}

/** One line for humans: `beam v0.2.0 (release binary)` or `beam dev at <dir> (commit abc1234)`. */
export function beamVersionLine(identity: BeamVersion): string {
  if (identity.source === "release") return `beam ${identity.version} (release binary)`;
  const commit = identity.commit === undefined ? "" : ` (commit ${identity.commit})`;
  return `beam ${identity.version} at ${identity.source}${commit}`;
}
