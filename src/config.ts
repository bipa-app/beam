import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateBeamDir } from "./util/private-dir.ts";
import type { BeamEnv } from "./env.ts";

/** A remote (or local, for testing) place beam can ship workspaces to. */
export type TargetSpec = SshTargetSpec | LocalTargetSpec | AgentSandboxTargetSpec;

export interface SshTargetSpec {
  type: "ssh";
  /** ssh destination: host alias from ~/.ssh/config, user@host, etc. */
  host: string;
  /** Remote directory that holds shipped workspaces. Default: ~/beam. */
  root?: string;
  /** Extra rsync flags (default: -a -z). */
  rsyncFlags?: string[];
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
}

/**
 * A GKE Agent Sandbox target: beam provisions one SandboxClaim per handoff
 * and reaches the pod over `kubectl exec` (tar streams for files). The
 * kubeconfig given here is the blast radius — it is REQUIRED (beam never
 * falls back to the ambient kubeconfig) and must hold the least-privilege
 * beam-user credential: both `beam doctor` and `beam up` refuse, fail
 * closed, a credential holding any of the enumerated escape capabilities
 * (template-bypassing pod/workload/Sandbox mutation, Secret access, RBAC
 * escalation, impersonation, cluster-wide reach) or one whose capabilities
 * cannot be verified.
 */
export interface AgentSandboxTargetSpec {
  type: "agent-sandbox";
  /** kubectl context name — pinned on every call; the ambient current-context is never used. */
  context: string;
  /**
   * Namespace holding this user's SandboxClaims (one namespace per user is
   * the isolation boundary). Must be a DNS label.
   */
  namespace: string;
  /** SandboxTemplate each handoff's claim instantiates. Must be a DNS subdomain. */
  template: string;
  /** Explicit kubeconfig path holding ONLY the least-privilege beam credential. Required. */
  kubeconfig: string;
  /** Container to exec into (default: "sandbox"). */
  container?: string;
  /** Directory inside the sandbox holding shipped workspaces, e.g. /data/bipa. Default: ~/beam. */
  root?: string;
}

export interface Config {
  defaultTarget?: string;
  targets: Record<string, TargetSpec>;
  /** rsync exclude patterns applied to every ship (merged with .beamignore). */
  excludes?: string[];
}

export const DEFAULT_ROOT = "~/beam";

/**
 * The workspace root a spec ships under. Every workspace operation —
 * establishment, sync, install, purge — proves physical containment under
 * this root (see workspace.ts), so it is the single authority a record's
 * spec snapshot binds through.
 */
export function targetRoot(spec: TargetSpec): string {
  return spec.root ?? DEFAULT_ROOT;
}

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
  ensurePrivateBeamDir(env.beamDir);
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
