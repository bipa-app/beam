import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BeamEnv } from "./env.ts";

/** A remote (or local, for testing) place beam can ship workspaces to. */
export type TargetSpec = SshTargetSpec | LocalTargetSpec;

export interface SshTargetSpec {
  type: "ssh";
  /** ssh destination: host alias from ~/.ssh/config, user@host, etc. */
  host: string;
  /** Remote directory that holds shipped workspaces. Default: ~/beam. */
  root?: string;
  /** Extra rsync flags (default: -a -z). */
  rsyncFlags?: string[];
  /** Named tmux socket (-L) on the remote; mostly for isolation. */
  tmuxSocket?: string;
}

export interface LocalTargetSpec {
  type: "local";
  /** Local directory acting as the "remote" root. */
  root: string;
  /**
   * Directory acting as the remote home (session stores land under it).
   * Defaults to the real home — set it for tests and sandboxed layouts.
   */
  home?: string;
  rsyncFlags?: string[];
  tmuxSocket?: string;
}

export interface Config {
  defaultTarget?: string;
  targets: Record<string, TargetSpec>;
  /** rsync exclude patterns applied to every ship (merged with .beamignore). */
  excludes?: string[];
}

export const DEFAULT_ROOT = "~/beam";

const SAMPLE_CONFIG: Config = {
  defaultTarget: "sandbox",
  targets: {
    sandbox: { type: "ssh", host: "my-sandbox-server", root: "~/beam" },
  },
  excludes: [".DS_Store"],
};

export function configPath(env: BeamEnv): string {
  return join(env.beamDir, "config.json");
}

export function loadConfig(env: BeamEnv): Config {
  const path = configPath(env);
  if (!existsSync(path)) return { targets: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Config;
  if (!parsed.targets || typeof parsed.targets !== "object") parsed.targets = {};
  return parsed;
}

export function writeSampleConfig(env: BeamEnv): string {
  const path = configPath(env);
  if (existsSync(path)) return path;
  mkdirSync(env.beamDir, { recursive: true });
  writeFileSync(path, JSON.stringify(SAMPLE_CONFIG, null, 2) + "\n");
  return path;
}

/** Resolve a target by name, falling back to default / sole target. */
export function resolveTarget(
  config: Config,
  name?: string,
): { name: string; spec: TargetSpec } {
  const names = Object.keys(config.targets);
  const chosen = name ?? config.defaultTarget ?? (names.length === 1 ? names[0] : undefined);
  if (!chosen) {
    throw new Error(
      names.length === 0
        ? "no targets configured — run `beam init` and edit the config"
        : `multiple targets configured (${names.join(", ")}) — pass --target or set defaultTarget`,
    );
  }
  const spec = config.targets[chosen];
  if (!spec) throw new Error(`unknown target "${chosen}" (have: ${names.join(", ") || "none"})`);
  return { name: chosen, spec };
}
