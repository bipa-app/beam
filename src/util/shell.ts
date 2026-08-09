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
  env?: Record<string, string>;
  /** Inherit the parent's stdio (interactive commands like `ssh -t`). */
  interactive?: boolean;
}

/** Run an argv. Never throws on nonzero exit; inspect `code`. */
export async function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdin: opts.interactive ? "inherit" : "ignore",
    stdout: opts.interactive ? "inherit" : "pipe",
    stderr: opts.interactive ? "inherit" : "pipe",
  });
  const code = await proc.exited;
  const stdout = opts.interactive ? "" : await new Response(proc.stdout as ReadableStream).text();
  const stderr = opts.interactive ? "" : await new Response(proc.stderr as ReadableStream).text();
  return { code, stdout, stderr };
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
