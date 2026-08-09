import { shjoin, shq } from "../util/shell.ts";
import type { Transport } from "../transport/types.ts";

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

  async start(name: string, cwdAbs: string, argv: string[]): Promise<void> {
    const inner = `${shjoin(argv)}; code=$?; echo; echo "[beam] agent exited ($code) - shell below"; exec bash -l`;
    const pane = `bash -lc ${shq(inner)}`;
    await this.t.execChecked(
      `${this.tmux} new-session -d -s ${shq(name)} -c ${shq(cwdAbs)} ${shq(pane)}`,
    );
  }

  async alive(name: string): Promise<boolean> {
    const res = await this.t.exec(`${this.tmux} has-session -t ${shq("=" + name)} 2>/dev/null`);
    return res.code === 0;
  }

  /** Last `lines` of the pane, for a no-attach glimpse. */
  async peek(name: string, lines = 12): Promise<string> {
    return this.t.execChecked(
      `${this.tmux} capture-pane -p -t ${shq("=" + name)} | grep -v '^$' | tail -n ${lines}`,
    );
  }

  /** Send Ctrl-C to the agent (graceful interrupt before kill). */
  async interrupt(name: string): Promise<void> {
    await this.t.exec(`${this.tmux} send-keys -t ${shq("=" + name)} C-c`);
  }

  async kill(name: string): Promise<void> {
    await this.t.exec(`${this.tmux} kill-session -t ${shq("=" + name)} 2>/dev/null`);
  }

  attachCommand(name: string): string {
    return `${this.tmux} attach -t ${shq("=" + name)}`;
  }
}
