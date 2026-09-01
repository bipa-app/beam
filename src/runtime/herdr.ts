import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shjoin, shq } from "../util/shell.ts";
import type { ExecResult, Transport } from "../transport/types.ts";
import { BEAM_RESERVED_DIR, ownedDestinationBlocks } from "../workspace.ts";

export interface PreparedRuntimeEnvironment {
  /** Remote location and ownership proof only; never the secret values. */
  readonly path: string;
  readonly cwdAbs: string;
  readonly owner: string;
}

export interface RuntimeStartOptions {
  /** Secret values exported only inside the launched coding-client process. */
  environment?: Readonly<Record<string, string>>;
  /** Environment staged before a fresh handoff enters its `starting` phase. */
  preparedEnvironment?: PreparedRuntimeEnvironment;
  /** Exact `.beam/owner` bytes authorizing the environment upload. */
  owner?: string;
}

/** An observed launch failure whose remote runtime was proven removed. */
export class RetryableRuntimeStartError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("runtime start failed and was cleaned up; retry beam up");
    this.name = "RetryableRuntimeStartError";
    this.cause = cause;
  }
}

/** Provider session tokens are small; refuse a hostile environment before staging it. */
const RUNTIME_ENVIRONMENT_BYTES_MAX = 64 * 1024;
const RUNTIME_ENVIRONMENT_NAMES: Readonly<Record<string, true>> = {
  CLAUDE_CODE_OAUTH_TOKEN: true,
  LLM_PROXY_SESSION_TOKEN: true,
};
/** Agent startup must consume its staged environment promptly or fail closed. */
const RUNTIME_ENVIRONMENT_CONSUME_ATTEMPTS_MAX = 50;

function runtimeEnvironmentText(environment: Readonly<Record<string, string>>): string {
  const assignments: string[] = [];
  for (const [name, value] of Object.entries(environment).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new Error(`runtime environment variable has an unsafe name: ${name}`);
    }
    if (RUNTIME_ENVIRONMENT_NAMES[name] !== true) {
      throw new Error(`runtime environment variable is not allowed: ${name}`);
    }
    if (value.includes("\0")) {
      throw new Error(`runtime environment variable ${name} contains a null byte`);
    }
    assignments.push(`${name}=${shq(value)}`);
  }
  const text = assignments.length === 0 ? "" : `${assignments.join("\n")}\n`;
  if (Buffer.byteLength(text) > RUNTIME_ENVIRONMENT_BYTES_MAX) {
    throw new Error(
      `runtime environment exceeds ${RUNTIME_ENVIRONMENT_BYTES_MAX} bytes — refusing to stage it`,
    );
  }
  return text;
}

function agentStartScript(argv: string[], environmentFile: string | undefined): string {
  const environmentPrelude =
    environmentFile === undefined
      ? ""
      : [
          `__beam_env_file=${shq(environmentFile)}`,
          '[ -f "$__beam_env_file" ]' +
            ' || { echo "beam: runtime credential environment is missing" >&2; exit 66; }',
          "set -a",
          '. "$__beam_env_file"',
          "__beam_env_rc=$?",
          "set +a",
          'rm -f -- "$__beam_env_file"' +
            ' || { echo "beam: could not remove runtime credential environment" >&2; exit 67; }',
          'if [ -e "$__beam_env_file" ] || [ -L "$__beam_env_file" ]; then ' +
            'echo "beam: runtime credential environment still exists after removal" >&2; ' +
            "exit 67; fi",
          '[ "$__beam_env_rc" -eq 0 ] || exit "$__beam_env_rc"',
          "unset __beam_env_file __beam_env_rc",
        ].join("; ") + "; ";
  return (
    environmentPrelude +
    `${shjoin(argv)}; code=$?; echo; ` +
    `echo "[beam] agent exited ($code) - shell below"`
  );
}

function environmentConsumeScript(environmentFile: string): string {
  return [
    "attempts=0",
    `while [ -e ${shq(environmentFile)} ] || [ -L ${shq(environmentFile)} ]; do`,
    "  attempts=$((attempts + 1))",
    `  if [ "$attempts" -ge ${RUNTIME_ENVIRONMENT_CONSUME_ATTEMPTS_MAX} ]; then`,
    '    echo "beam: coding client did not consume its runtime environment" >&2',
    "    exit 1",
    "  fi",
    "  sleep 0.1",
    "done",
  ].join("\n");
}

function environmentDiscardScript(prepared: PreparedRuntimeEnvironment): string {
  const refuse = 'echo "beam: cannot enter the runtime credential workspace" >&2; exit 68';
  return [
    `cd -P -- ${shq(prepared.cwdAbs)} 2>/dev/null || { ${refuse}; }`,
    ...ownedDestinationBlocks(prepared.owner, [BEAM_RESERVED_DIR, "runtime-environment"], {
      create: true,
    }),
    'rm -f -- environment || { echo "beam: cannot remove runtime credentials" >&2; exit 68; }',
    '[ ! -e environment ] && [ ! -L environment ]' +
      ' || { echo "beam: runtime credentials still exist after cleanup" >&2; exit 68; }',
  ].join("\n");
}

function environmentSecureScript(prepared: PreparedRuntimeEnvironment): string {
  const refuse = 'echo "beam: cannot secure runtime credentials" >&2; exit 69';
  return [
    `cd -P -- ${shq(prepared.cwdAbs)} 2>/dev/null || { ${refuse}; }`,
    ...ownedDestinationBlocks(prepared.owner, [BEAM_RESERVED_DIR, "runtime-environment"], {
      create: false,
    }),
    `[ ! -L environment ] && [ -f environment ] || { ${refuse}; }`,
    `chmod 600 environment || { ${refuse}; }`,
    `[ -n "$(find environment -prune -type f -perm 600)" ] || { ${refuse}; }`,
  ].join("\n");
}

/** Trimmed diagnostic output of a failed herdr invocation, for error messages. */
function detail(res: ExecResult): string {
  const text = (res.stderr || res.stdout).trim();
  return text === "" ? "(no output)" : text;
}

/**
 * Nonzero exit proves absence only with herdr's machine-readable
 * `server_not_running` error code (a JSON envelope on stderr, verified on
 * herdr 0.8.0). Panes cannot outlive their session server, so a dead server
 * is proven absence of the agent. Every other failure stays unknown.
 */
function provesServerDown(res: ExecResult): boolean {
  return `${res.stderr}\n${res.stdout}`.includes('"code":"server_not_running"');
}

/**
 * The `result` object of a herdr success envelope (`{"id":…,"result":{…}}`
 * on stdout); undefined when the output is not shaped that way.
 */
function parseResult(stdout: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const result = (parsed as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null) return undefined;
  return result as Record<string, unknown>;
}

/** One `pane_id` field out of an object in a herdr response. */
function paneIdOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const id = (value as Record<string, unknown>).pane_id;
  if (typeof id !== "string" || id === "") return undefined;
  return id;
}

/**
 * Pane ids from a `pane list` response (`result.panes[].pane_id`);
 * undefined when any part of the shape is wrong, so a malformed listing
 * can never pass for an empty one.
 */
function paneIds(stdout: string): string[] | undefined {
  const result = parseResult(stdout);
  if (result === undefined || !Array.isArray(result.panes)) return undefined;
  const ids: string[] = [];
  for (const pane of result.panes) {
    const id = paneIdOf(pane);
    if (id === undefined) return undefined;
    ids.push(id);
  }
  return ids;
}

/** Root pane id from a `workspace create` response (`result.root_pane.pane_id`). */
function rootPaneIdOf(stdout: string): string | undefined {
  const result = parseResult(stdout);
  if (result === undefined) return undefined;
  return paneIdOf(result.root_pane);
}

/**
 * POSIX fragment prefixed to every emitted script: compute the uid-scoped
 * socket dir, create it 0700, and refuse fail-closed unless this user owns
 * it — a squatted dir must never be trusted. Single-quote-free by
 * construction so `attachCommand` can embed it inside a `bash -c '…'`
 * payload that any login shell (fish included) passes through verbatim.
 */
const SOCKET_DIR_PREP =
  'dir="${TMPDIR:-/tmp}/herdr-$(id -u)"; mkdir -p -m 700 "$dir" && [ -O "$dir" ] || ' +
  '{ echo "beam: herdr socket dir $dir is not owned by uid $(id -u); remove it and retry"' +
  " >&2; exit 1; }";

/**
 * Env pair scoping one herdr invocation to the handoff's own server: the
 * session name plus its socket under the prep-verified dir. Session names
 * are beam-generated (`beam-<id>`, no shell metacharacters), so the raw
 * name is safe inside the double-quoted socket path.
 */
function sockEnv(name: string): string {
  return `HERDR_SESSION=${shq(name)} HERDR_SOCKET_PATH="$dir/${name}.sock"`;
}

/**
 * HerdrRuntime: the remote agent lives in a named, detached herdr session
 * (one per handoff, `beam-<id>`). It survives ssh disconnects, is
 * attachable from anywhere, and its pane can be read for `beam status`.
 *
 * Every invocation carries `HERDR_SESSION=<name>` plus
 * `HERDR_SOCKET_PATH=${TMPDIR:-/tmp}/herdr-<uid>/<name>.sock`: each
 * handoff gets its own server and socket, so handoffs never see each
 * other's panes. The socket deliberately leaves herdr's HOME-derived
 * default (`$XDG_CONFIG_HOME|$HOME/.config/herdr/sessions/<name>/
 * herdr.sock`): `sun_path` in `sockaddr_un` caps Unix socket paths at
 * 104 bytes on macOS (108 on Linux), so a deep remote HOME overflows the
 * default and every herdr call dies before it can answer. The uid-scoped
 * tmp dir is the tmux precedent (`/tmp/tmux-<uid>`: short path under a
 * world-writable parent, one private subdir per user). Every emitted
 * script creates the dir `0700` and fail-closed verifies ownership
 * (`[ -O ]`) before touching the socket — a squatted dir owned by
 * another user is refused with an actionable error, never trusted.
 * Session registry state (`session list`/`delete`) stays under the
 * HOME-derived config dir; only the socket moves.
 *
 * Panes are shell-wrapped: `workspace create` opens the user's default
 * shell, and the agent argv is written to `<cwd>/.beam/agent-start.sh` so
 * the one typed line — `bash .beam/agent-start.sh`, deliberately
 * quote-free — parses identically under any pane shell (bash, fish, zsh).
 * The script appends the exit-marker convention other beam surfaces rely
 * on: `[beam] agent exited ($code) - shell below`. When the agent exits,
 * the pane returns to its shell, so the aftermath stays inspectable.
 */
export class HerdrRuntime {
  constructor(private readonly t: Transport) {}

  /** Bind a herdr command to the handoff's own named session and socket. */
  private cmd(name: string, rest: string): string {
    return `${SOCKET_DIR_PREP}; ${sockEnv(name)} herdr ${rest}`;
  }

  /**
   * One bash script that guarantees the session's server answers: prepare
   * the socket dir, probe via `pane list` (exit 0 iff the server responds;
   * `session list --json` exits 0 even with no server, so it cannot carry
   * an exit-code probe), spawn a detached server when absent, then
   * bounded-poll — 50 probes at 200ms, failing loud instead of hanging on
   * a server that never binds.
   */
  private ensureServerScript(name: string): string {
    const probe = `${sockEnv(name)} herdr pane list >/dev/null 2>&1`;
    const spawn = `nohup env ${sockEnv(name)} herdr server >/dev/null 2>&1 &`;
    const exhausted =
      `beam: herdr server for session ${name} did not answer after 50 probes (10s)`;
    return [
      SOCKET_DIR_PREP,
      `if ! ${probe}; then`,
      `  ${spawn}`,
      `  tries=0`,
      `  until ${probe}; do`,
      `    tries=$((tries + 1))`,
      `    if [ "$tries" -ge 50 ]; then`,
      `      echo "${exhausted}" >&2`,
      `      exit 1`,
      `    fi`,
      `    sleep 0.2`,
      `  done`,
      `fi`,
    ].join("\n");
  }

  /** First pane of the session's single workspace: the agent pane. */
  private async rootPane(name: string): Promise<string> {
    const out = await this.t.execChecked(this.cmd(name, "pane list"));
    const ids = paneIds(out);
    if (ids === undefined) {
      throw new Error(`herdr pane list for ${name} returned unparseable output`);
    }
    const first = ids[0];
    if (first === undefined) throw new Error(`herdr session ${name} has no panes`);
    return first;
  }

  /**
   * Upload one private, read-once environment file through the transport's
   * owned sync channel. Callers with a journaled start phase prepare this
   * before that phase transition, so an upload failure cannot leave an idle
   * pane that recovery mistakes for a running coding client.
   */
  async prepareEnvironment(
    cwdAbs: string,
    environment: Readonly<Record<string, string>>,
    owner: string | undefined,
  ): Promise<PreparedRuntimeEnvironment | undefined> {
    const text = runtimeEnvironmentText(environment);
    if (text === "") return undefined;
    if (owner === undefined) {
      throw new Error("runtime environment delivery requires workspace ownership bytes");
    }
    const localStage = mkdtempSync(join(tmpdir(), "beam-runtime-env-"));
    const path = `${cwdAbs}/.beam/runtime-environment/environment`;
    const prepared = { path, cwdAbs, owner };
    try {
      chmodSync(localStage, 0o700);
      writeFileSync(join(localStage, "environment"), text, { mode: 0o600 });
      await this.t.syncUp(localStage, `${cwdAbs}/.beam/runtime-environment`, {
        checksum: true,
        owned: { root: cwdAbs, ownerBytes: owner },
      });
      await this.t.execChecked(environmentSecureScript(prepared));
      return prepared;
    } catch (error) {
      await this.rethrowAfterDiscard(prepared, error);
    } finally {
      rmSync(localStage, { recursive: true, force: true });
    }
  }

  /** Guarded, idempotent removal; a failure is security-relevant and surfaces. */
  async discardEnvironment(prepared: PreparedRuntimeEnvironment | undefined): Promise<void> {
    if (prepared === undefined) return;
    await this.t.execChecked(environmentDiscardScript(prepared));
  }

  private async rethrowAfterDiscard(
    prepared: PreparedRuntimeEnvironment | undefined,
    error: unknown,
  ): Promise<never> {
    try {
      await this.discardEnvironment(prepared);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "runtime credential operation and guarded cleanup both failed",
      );
    }
    throw error;
  }

  async start(
    name: string,
    cwdAbs: string,
    argv: string[],
    options: RuntimeStartOptions = {},
  ): Promise<void> {
    if (options.environment !== undefined && options.preparedEnvironment !== undefined) {
      throw new Error("runtime start cannot stage and reuse an environment simultaneously");
    }
    const prepared =
      options.preparedEnvironment ??
      (await this.prepareEnvironment(cwdAbs, options.environment ?? {}, options.owner));
    const script = agentStartScript(argv, prepared?.path);
    const beamDir = `${cwdAbs}/.beam`;
    let workspaceCreated = false;
    try {
      await this.t.execChecked(
        `mkdir -p ${shq(beamDir)} && ` +
          `printf '%s\\n' ${shq(script)} > ${shq(`${beamDir}/agent-start.sh`)}`,
      );
      await this.t.execChecked(this.ensureServerScript(name));
      const created = await this.t.execChecked(
        this.cmd(name, `workspace create --cwd ${shq(cwdAbs)} --no-focus`),
      );
      workspaceCreated = true;
      const paneId = rootPaneIdOf(created);
      if (paneId === undefined) {
        throw new Error(
          `herdr workspace create for ${name} returned no root pane id: ` +
            `${created.trim() || "(no output)"}`,
        );
      }
      await this.t.execChecked(
        this.cmd(name, `pane run ${shq(paneId)} 'bash .beam/agent-start.sh'`),
      );
      if (prepared !== undefined) {
        await this.t.execChecked(environmentConsumeScript(prepared.path));
      }
    } catch (error) {
      const failures: unknown[] = [error];
      if (workspaceCreated) {
        try {
          await this.kill(name);
        } catch (killError) {
          failures.push(killError);
        }
      }
      try {
        await this.discardEnvironment(prepared);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "runtime start failed without proven cleanup");
      }
      throw new RetryableRuntimeStartError(error);
    }
  }

  /**
   * Liveness is three-valued. Exit 0 with panes proves presence; exit 0
   * with zero panes proves absence. A nonzero exit proves absence only
   * with herdr's `server_not_running` error code — a dead server has no
   * panes. Every other outcome (including unparseable success output) is
   * unknown and throws, so no caller can sync or purge over a
   * possibly-live agent.
   */
  async alive(name: string): Promise<boolean> {
    const res = await this.t.exec(this.cmd(name, "pane list"));
    if (res.code === 0) {
      const ids = paneIds(res.stdout);
      if (ids !== undefined) return ids.length > 0;
      throw new Error(
        `cannot determine whether herdr session ${name} is alive ` +
          `(pane list succeeded with unparseable output): ${detail(res)}`,
      );
    }
    if (provesServerDown(res)) return false;
    throw new Error(
      `cannot determine whether herdr session ${name} is alive ` +
        `(pane list exited ${res.code}): ${detail(res)}`,
    );
  }

  /** Last `lines` of the rendered pane viewport, for a no-attach glimpse. */
  async peek(name: string, lines = 12): Promise<string> {
    const paneId = await this.rootPane(name);
    const out = await this.t.execChecked(
      this.cmd(
        name,
        `pane read ${shq(paneId)} --source visible --lines ${lines} --format text`,
      ),
    );
    const rows = out.split("\n").filter((row) => row.trim() !== "");
    return rows.slice(-lines).join("\n");
  }

  /**
   * Send Ctrl-C to the agent (graceful interrupt before kill). Checked: the
   * one tolerated failure is a session separately PROVEN absent (it exited
   * in the race window since the caller's liveness check). An unknown
   * outcome propagates — alive() itself throws when the transport can't
   * answer, so a failed interrupt never passes silently.
   */
  async interrupt(name: string): Promise<void> {
    const list = await this.t.exec(this.cmd(name, "pane list"));
    const ids = list.code === 0 ? paneIds(list.stdout) : undefined;
    const paneId = ids === undefined ? undefined : ids[0];
    if (paneId === undefined) {
      if (!(await this.alive(name))) return;
      throw new Error(
        `herdr interrupt of ${name} failed: cannot resolve pane (${detail(list)})`,
      );
    }
    const res = await this.t.exec(this.cmd(name, `pane send-keys ${shq(paneId)} ctrl+c`));
    if (res.code === 0) return;
    if (!(await this.alive(name))) return;
    throw new Error(`herdr interrupt of ${name} failed (exit ${res.code}): ${detail(res)}`);
  }

  /**
   * Destroy the session: stop its server (which ends every pane process),
   * then delete its persisted registry state. The stop is `server stop`,
   * which reaches the server through `HERDR_SOCKET_PATH` directly;
   * `session stop <name>` cannot — it resolves the target socket from the
   * HOME-derived registry, which never learns the override (verified on
   * herdr 0.8.0). Idempotent, but only through proof: a failed stop is
   * tolerated solely when a separate liveness probe confirms the session
   * is absent (already dead, or lost the race) — the plain "server is not
   * running" diagnostic alone is ambiguous about reachability. A failed
   * delete is tolerated on a proven-dead server or a negative liveness
   * probe; handoff ids are never reused, so leftover persisted session
   * state after such a delete is acceptable. A still-alive session or an
   * unanswerable probe throws, so callers abort before any destructive
   * follow-on (sync, state rewrite, purge).
   */
  async kill(name: string): Promise<void> {
    const stop = await this.t.exec(this.cmd(name, "server stop"));
    if (stop.code !== 0 && (await this.alive(name))) {
      throw new Error(
        `herdr kill of ${name} failed and the session is still alive ` +
          `(stop exited ${stop.code}): ${detail(stop)}`,
      );
    }
    const del = await this.t.exec(this.cmd(name, `session delete ${shq(name)} --json`));
    if (del.code === 0) return;
    if (provesServerDown(del)) return;
    if (!(await this.alive(name))) return;
    throw new Error(
      `herdr kill of ${name} failed and the session is still alive ` +
        `(delete exited ${del.code}): ${detail(del)}`,
    );
  }

  /**
   * One string ANY login shell an ssh target might run (fish included)
   * hands to bash intact: fish passes a single-quoted string through
   * literally (only `\'` and `\\` escape), so the payload holds NO single
   * quotes — just double quotes, `$(…)` and `${…}` — and the
   * beam-generated session name rides unquoted. The inner bash prepares
   * the socket dir fail-closed, then execs the attach bound to the
   * session's own socket.
   */
  attachCommand(name: string): string {
    const attach =
      `HERDR_SESSION=${name} HERDR_SOCKET_PATH="$dir/${name}.sock" ` +
      `exec herdr session attach ${name}`;
    return `bash -c '${SOCKET_DIR_PREP}; ${attach}'`;
  }
}
