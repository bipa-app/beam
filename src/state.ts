import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BeamEnv } from "./env.ts";
import type { ToolName } from "./session/types.ts";

export type BeamStatus = "up" | "down" | "killed";

/** One shipped handoff. */
export interface BeamRecord {
  id: string;
  target: string;
  tool?: ToolName;
  sessionId?: string;
  /** Local store path of the shipped session (adapter collect target). */
  sessionFile?: string;
  /** omp: local artifacts dir shipped alongside the session. */
  artifactsDir?: string;
  localCwd: string;
  remoteCwd: string;
  tmux: string;
  status: BeamStatus;
  createdAt: string;
  updatedAt: string;
  kickoff?: string;
}

interface StateFile {
  records: BeamRecord[];
}

function statePath(env: BeamEnv): string {
  return join(env.beamDir, "state.json");
}

export function loadState(env: BeamEnv): StateFile {
  const path = statePath(env);
  if (!existsSync(path)) return { records: [] };
  return JSON.parse(readFileSync(path, "utf8")) as StateFile;
}

function saveState(env: BeamEnv, state: StateFile): void {
  mkdirSync(env.beamDir, { recursive: true });
  writeFileSync(statePath(env), JSON.stringify(state, null, 2) + "\n");
}

export function newRecordId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function addRecord(env: BeamEnv, record: BeamRecord): void {
  const state = loadState(env);
  state.records.push(record);
  saveState(env, state);
}

export function updateRecord(env: BeamEnv, id: string, patch: Partial<BeamRecord>): BeamRecord {
  const state = loadState(env);
  const record = state.records.find((r) => r.id === id);
  if (!record) throw new Error(`no record ${id}`);
  Object.assign(record, patch, { updatedAt: new Date().toISOString() });
  saveState(env, state);
  return record;
}

/**
 * Find a record by id prefix; with no ref, return the most recent record
 * still `up` (or the most recent overall when none are up).
 */
export function findRecord(env: BeamEnv, ref?: string): BeamRecord {
  const { records } = loadState(env);
  if (records.length === 0) throw new Error("no beamed sessions yet — run `beam up`");
  if (ref) {
    const matches = records.filter((r) => r.id.startsWith(ref));
    if (matches.length === 0) throw new Error(`no record matching "${ref}"`);
    if (matches.length > 1) throw new Error(`ambiguous ref "${ref}": ${matches.map((r) => r.id).join(", ")}`);
    return matches[0]!;
  }
  const byRecency = [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return byRecency.find((r) => r.status === "up") ?? byRecency[0]!;
}
