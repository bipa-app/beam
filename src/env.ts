import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolved local environment. Injectable so tests never touch the real
 * home directory or beam state.
 *
 * - BEAM_HOME overrides where session stores (~/.omp, ~/.claude, ~/.codex)
 *   are looked up.
 * - BEAM_DIR overrides where beam keeps config.json and state.json
 *   (default: <home>/.beam).
 */
export interface BeamEnv {
  /** Home directory used to locate harness session stores. */
  home: string;
  /** Directory holding beam's own config.json and state.json. */
  beamDir: string;
}

export function resolveEnv(overrides: Partial<BeamEnv> = {}): BeamEnv {
  const home = overrides.home ?? process.env.BEAM_HOME ?? homedir();
  const beamDir = overrides.beamDir ?? process.env.BEAM_DIR ?? join(home, ".beam");
  return { home, beamDir };
}

/** Expand a leading `~` against a concrete home directory. */
export function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}
