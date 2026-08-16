import { shjoin, shq } from "../util/shell.ts";
import type { ExecResult, Transport } from "../transport/types.ts";

/** Trimmed diagnostic output of a failed tmux invocation, for error messages. */
function detail(res: ExecResult): string {
  const text = (res.stderr || res.stdout).trim();
  return text === "" ? "(no output)" : text;
}
/** Exit 1 is absence only when tmux itself says session/server is absent. */
function provesAbsence(res: ExecResult): boolean {
  const text = `${res.stderr}\n${res.stdout}`;
  return (
    /^can't find session: .+$/m.test(text) ||
    /^no server running on .+$/m.test(text) ||
    /^error connecting to .+ \(No such file or directory\)$/m.test(text)
  );
}

/**
 * TmuxRuntime: the remote agent lives in a detached tmux session.
 * It survives ssh disconnects, is attachable from anywhere, and its pane
 * can be captured for `beam status`. When the agent exits, the pane drops
 * to a login shell so the aftermath stays inspectable.
 */
export class TmuxRuntime {
  private readonly tmux: string;

  constructor(
    private readonly t: Transport,
    socket?: string,
  ) {
    this.tmux = socket ? `tmux -L ${shq(socket)}` : "tmux";
  }

  /**
   * Exact-match target for PANE-scoped commands (send-keys, capture-pane).
   * A colon-less pane target is resolved as a pane/window name first, where
   * the `=` marker never matches — tmux 3.6a fails with "can't find pane:
   * =name" (verified empirically). The trailing colon forces the
   * session:window parse: exact-match session, current window, active pane.
   */
  private paneTarget(name: string): string {
    return shq("=" + name + ":");
  }

  async start(name: string, cwdAbs: string, argv: string[]): Promise<void> {
    const inner =
      `${shjoin(argv)}; code=$?; echo; ` +
      `echo "[beam] agent exited ($code) - shell below"; exec bash -l`;
    const pane = `bash -c ${shq(inner)}`;
    await this.t.execChecked(
      `${this.tmux} new-session -d -s ${shq(name)} -c ${shq(cwdAbs)} ${shq(pane)}`,
    );
  }

  /**
   * Liveness is three-valued. Exit 0 proves presence. Exit 1 proves absence
   * only with tmux's known missing-session/server diagnostic; tmux also uses
   * 1 for socket, permission, and protocol errors. Every other outcome is
   * unknown and throws, so no caller can sync or purge over a possibly-live
   * agent.
   */
  async alive(name: string): Promise<boolean> {
    const res = await this.t.exec(`${this.tmux} has-session -t ${shq("=" + name)}`);
    if (res.code === 0) return true;
    if (res.code === 1 && provesAbsence(res)) return false;
    throw new Error(
      `cannot determine whether tmux session ${name} is alive ` +
        `(has-session exited ${res.code}): ${detail(res)}`,
    );
  }

  /** Last `lines` of the pane, for a no-attach glimpse. */
  async peek(name: string, lines = 12): Promise<string> {
    return this.t.execChecked(
      `${this.tmux} capture-pane -p -t ${this.paneTarget(name)} | grep -v '^$' | tail -n ${lines}`,
    );
  }

  /**
   * Send Ctrl-C to the agent (graceful interrupt before kill). Checked: the
   * one tolerated failure is a session separately PROVEN absent (it exited
   * in the race window since the caller's liveness check). An unknown
   * outcome propagates — alive() itself throws when the transport can't
   * answer, so a failed interrupt never passes silently.
   */
  async interrupt(name: string): Promise<void> {
    const res = await this.t.exec(`${this.tmux} send-keys -t ${this.paneTarget(name)} C-c`);
    if (res.code === 0) return;
    if (!(await this.alive(name))) return;
    throw new Error(`tmux interrupt of ${name} failed (exit ${res.code}): ${detail(res)}`);
  }

  /**
   * Destroy the session. Idempotent, but only through proof: a failed
   * kill-session is tolerated solely when a separate has-session probe
   * confirms the session is absent (already dead, or lost the race).
   * A still-alive session or an unanswerable probe throws, so callers
   * abort before any destructive follow-on (sync, state rewrite, purge).
   */
  async kill(name: string): Promise<void> {
    const res = await this.t.exec(`${this.tmux} kill-session -t ${shq("=" + name)}`);
    if (res.code === 0) return;
    if (!(await this.alive(name))) return;
    throw new Error(
      `tmux kill of ${name} failed and the session is still alive ` +
        `(exit ${res.code}): ${detail(res)}`,
    );
  }

  attachCommand(name: string): string {
    return `${this.tmux} attach -t ${shq("=" + name)}`;
  }
}
