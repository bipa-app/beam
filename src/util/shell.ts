/** Shell quoting and process helpers. Zero dependencies; Bun runtime. */

/** Single-quote a string for POSIX shells. Safe for any content. */
export function shq(s: string): string {
  return "'" + s.replaceAll("'", "'\\''") + "'";
}

/** Quote an argv into a single shell command string. */
export function shjoin(argv: string[]): string {
  return argv.map(shq).join(" ");
}

/**
 * Quote a remote path for use inside a `bash -lc` command string.
 * A leading `~/` must survive quoting so the remote shell expands it,
 * so it is rewritten to `"$HOME/..."` with double-quote escaping.
 */
export function shqRemotePath(p: string): string {
  if (p === "~") return '"$HOME"';
  if (p.startsWith("~/")) {
    const rest = p.slice(2).replace(/([\\"$`])/g, "\\$1");
    return `"$HOME/${rest}"`;
  }
  return shq(p);
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Extra variables layered over the base environment. */
  env?: Record<string, string>;
  /**
   * Base environment `env` layers onto, INSTEAD of the inherited
   * `process.env`. A key absent here is genuinely unset in the child —
   * the only way to DELETE an inherited variable.
   */
  baseEnv?: Record<string, string>;
  /** Inherit the parent's stdio (interactive commands like `ssh -t`). */
  interactive?: boolean;
  /** Feed this string to the child's stdin (non-interactive runs only). */
  stdinText?: string;
  /** Feed these exact bytes to the child's stdin (non-interactive runs only). */
  stdinBytes?: Uint8Array;
  /**
   * Per-stream capture ceiling in bytes, applied to stdout and stderr
   * INDEPENDENTLY. Exceeding it kills the child and throws — output is
   * never silently truncated. Defaults to `DEFAULT_MAX_OUTPUT_BYTES`;
   * set an explicit ceiling only for commands with a justified larger
   * output.
   */
  maxOutputBytes?: number;
}

/**
 * Default per-stream ceiling for captured child output: 16 MiB.
 * Generous for every internal command Beam runs (git plumbing listings,
 * kubectl JSON, tmux captures) while keeping a hostile or runaway child
 * from growing Beam's heap without bound.
 */
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

interface StreamCapture {
  text: string;
  overflowed: boolean;
}

/**
 * Incrementally drain one child stream, refusing to hold more than
 * `maxOutputBytes`. On overflow, `onOverflow` runs (the caller kills the
 * child), the stream is cancelled, and the partial capture is discarded —
 * the caller throws, so nothing truncated ever masquerades as output.
 */
async function captureStream(
  stream: ReadableStream<Uint8Array>,
  maxOutputBytes: number,
  onOverflow: () => void,
): Promise<StreamCapture> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let capturedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      if (capturedBytes + value.byteLength > maxOutputBytes) {
        onOverflow();
        await reader.cancel().catch(() => {});
        return { text: "", overflowed: true };
      }
      chunks.push(value);
      capturedBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks, capturedBytes).toString("utf8"), overflowed: false };
}

/** Run an argv. Never throws on nonzero exit; inspect `code`. */
export async function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error(`run: maxOutputBytes must be a positive integer, got ${maxOutputBytes}`);
  }
  const base = opts.baseEnv ?? process.env;
  const stdinPipe =
    opts.stdinBytes ?? (opts.stdinText !== undefined ? Buffer.from(opts.stdinText) : "ignore");
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env ? { ...base, ...opts.env } : base,
    stdin: opts.interactive ? "inherit" : stdinPipe,
    stdout: opts.interactive ? "inherit" : "pipe",
    stderr: opts.interactive ? "inherit" : "pipe",
  });
  if (opts.interactive) {
    return { code: await proc.exited, stdout: "", stderr: "" };
  }
  // Drain BOTH pipes concurrently before awaiting exit: a child that fills
  // one pipe buffer while Beam waits on the other (or on exit) deadlocks.
  const killChild = () => proc.kill("SIGKILL");
  let stdout: StreamCapture;
  let stderr: StreamCapture;
  try {
    [stdout, stderr] = await Promise.all([
      captureStream(proc.stdout as ReadableStream<Uint8Array>, maxOutputBytes, killChild),
      captureStream(proc.stderr as ReadableStream<Uint8Array>, maxOutputBytes, killChild),
    ]);
  } catch (err) {
    killChild();
    await proc.exited;
    throw err;
  }
  const code = await proc.exited;
  if (stdout.overflowed || stderr.overflowed) {
    const streams = [stdout.overflowed ? "stdout" : "", stderr.overflowed ? "stderr" : ""]
      .filter((name) => name !== "")
      .join("+");
    throw new Error(
      `command output exceeded the ${maxOutputBytes}-byte per-stream cap on ${streams}: ${argv[0]}`,
    );
  }
  return { code, stdout: stdout.text, stderr: stderr.text };
}

/** Run an argv and throw with stderr context on nonzero exit. */
export async function runChecked(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  const res = await run(argv, opts);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    throw new Error(`command failed (${res.code}): ${argv[0]}${detail ? `\n${detail}` : ""}`);
  }
  return res;
}
