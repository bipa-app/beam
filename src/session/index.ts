import { ClaudeAdapter } from "./claude.ts";
import { CodexAdapter } from "./codex.ts";
import { OmpAdapter } from "./omp.ts";
import type { LocalSession, SessionAdapter, ToolName } from "./types.ts";

export type { InstalledSession, LocalSession, SessionAdapter, ToolName } from "./types.ts";

export const ADAPTERS: readonly SessionAdapter[] = [
  new OmpAdapter(),
  new ClaudeAdapter(),
  new CodexAdapter(),
];

export function adapterFor(tool: ToolName): SessionAdapter {
  const adapter = ADAPTERS.find((a) => a.tool === tool);
  if (!adapter) throw new Error(`unknown tool "${tool}"`);
  return adapter;
}

/**
 * Detect which harness owns the most recent session for this cwd.
 * With `tool` set, only that adapter is consulted.
 */
export async function detectSession(
  cwd: string,
  home: string,
  tool?: ToolName,
  sessionRef?: string,
): Promise<{ adapter: SessionAdapter; session: LocalSession }> {
  const pool = tool ? [adapterFor(tool)] : [...ADAPTERS];
  const found: { adapter: SessionAdapter; session: LocalSession }[] = [];
  for (const adapter of pool) {
    const session = await adapter.locate(cwd, home, sessionRef);
    if (session) found.push({ adapter, session });
  }
  if (found.length === 0) {
    throw new Error(
      `no ${tool ?? "omp/claude/codex"} session found for ${cwd}` +
        (sessionRef ? ` matching "${sessionRef}"` : "") +
        " — run the harness here first, or pass --tool/--session",
    );
  }
  found.sort((a, b) => b.session.mtime - a.session.mtime);
  return found[0]!;
}
