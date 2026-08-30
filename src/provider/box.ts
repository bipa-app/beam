import { existsSync } from "node:fs";
import { isIPv4 } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BoxTargetSpec } from "../config.ts";
import { SshTransport } from "../transport/ssh.ts";
import type { Transport } from "../transport/types.ts";
import { run } from "../util/shell.ts";
import type {
  BoxSandboxState,
  ProviderCheckReport,
  SandboxProvider,
  SandboxRef,
  SandboxState,
} from "./types.ts";
import { bootstrapManagedLinux } from "./managed-ssh.ts";

const BOX_ID_SHAPE = /^bx_[a-z0-9]{1,120}$/;
const BOX_OUTPUT_BYTES_MAX = 1024 * 1024;
const BOX_OUTPUT_LINES_MAX = 256;
const BOX_READY_ATTEMPTS_MAX = 300;
const BOX_READY_POLL_MS = 1_000;
const BOX_TTL_SECONDS_MAX = 30 * 24 * 60 * 60;

interface BoxConnection {
  id: string;
  ip: string;
}

interface NewProgress {
  ref: SandboxRef;
  persist?: (sandbox: SandboxState) => void;
  created?: BoxSandboxState;
  ready?: BoxConnection;
  error?: string;
}

class BoxCliError extends Error {
  constructor(message: string, readonly boxCode?: string) {
    super(message);
  }
}

function parseJsonRecord(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Box CLI returned malformed JSON for ${what}: ${text}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Box CLI returned non-object JSON for ${what}`);
  }
  return value as Record<string, unknown>;
}

function assertBoxId(value: unknown, what: string): string {
  if (typeof value !== "string" || !BOX_ID_SHAPE.test(value)) {
    throw new Error(`Box CLI returned malformed ${what}: ${JSON.stringify(value)}`);
  }
  return value;
}

function parseConnection(value: Record<string, unknown>, what: string): BoxConnection {
  const id = assertBoxId(value.id, `${what} id`);
  if (typeof value.ip !== "string" || !isIPv4(value.ip)) {
    throw new Error(`Box CLI returned no usable IPv4 address for ${id} during ${what}`);
  }
  return { id, ip: value.ip };
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  options: { onLine?: (line: string) => void },
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let lines = 0;
  let output = "";
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes > BOX_OUTPUT_BYTES_MAX) {
        throw new Error(`Box CLI output exceeded ${BOX_OUTPUT_BYTES_MAX} bytes`);
      }
      const text = decoder.decode(value, { stream: true });
      output += text;
      pending += text;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        lines += 1;
        if (lines > BOX_OUTPUT_LINES_MAX) {
          throw new Error(`Box CLI output exceeded ${BOX_OUTPUT_LINES_MAX} lines`);
        }
        if (line !== "") options.onLine?.(line);
        newline = pending.indexOf("\n");
      }
    }
    const final = decoder.decode();
    output += final;
    pending += final;
    if (pending !== "") {
      lines += 1;
      if (lines > BOX_OUTPUT_LINES_MAX) {
        throw new Error(`Box CLI output exceeded ${BOX_OUTPUT_LINES_MAX} lines`);
      }
      options.onLine?.(pending);
    }
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function runStreaming(
  argv: string[],
  onLine: (line: string) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    cwd: process.cwd(),
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [stdout, stderr, code] = await Promise.all([
      readBoundedStream(proc.stdout as ReadableStream<Uint8Array>, { onLine }),
      readBoundedStream(proc.stderr as ReadableStream<Uint8Array>, {}),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (error) {
    proc.kill("SIGKILL");
    await proc.exited;
    throw error;
  }
}

function handleNewLine(progress: NewProgress, line: string): void {
  const value = parseJsonRecord(line, "box new");
  if (value.event === "error") {
    progress.error = typeof value.error === "string" ? value.error : line;
    return;
  }
  if (value.event === "created") {
    const next: BoxSandboxState = { kind: "box", boxId: assertBoxId(value.id, "created id") };
    if (progress.created !== undefined && progress.created.boxId !== next.boxId) {
      throw new Error("Box CLI reported two different ids for one creation");
    }
    if (progress.created === undefined) {
      progress.created = next;
      progress.ref.sandbox = next;
      progress.persist?.(next);
    }
    return;
  }
  if (value.event === "ready") {
    progress.ready = parseConnection(value, "ready event");
  }
}

/** Managed box.ascii.dev lifecycle; data still moves over Beam's SSH transport. */
export class BoxProvider implements SandboxProvider {
  readonly label = "box.ascii.dev";
  readonly reusesSandbox = false;

  constructor(
    private readonly spec: BoxTargetSpec,
    private readonly bin: string = "box",
  ) {
    if (spec.machineType !== undefined) {
      if (!["small", "default", "large"].includes(spec.machineType)) {
        throw new Error(`box target machineType is invalid: ${JSON.stringify(spec.machineType)}`);
      }
    }
    if (spec.environment !== undefined && spec.environment.trim() === "") {
      throw new Error("box target environment cannot be empty");
    }
    if (spec.ttlSeconds !== undefined) {
      if (!Number.isSafeInteger(spec.ttlSeconds) || spec.ttlSeconds <= 0) {
        throw new Error(`box target ttlSeconds must be a positive integer, got ${spec.ttlSeconds}`);
      }
      if (spec.ttlSeconds > BOX_TTL_SECONDS_MAX) {
        throw new Error(`box target ttlSeconds exceeds Box's 30-day ceiling: ${spec.ttlSeconds}`);
      }
    }
  }

  sandboxState(ref: SandboxRef): BoxSandboxState | undefined {
    const persisted = ref.sandbox;
    if (persisted === undefined) return undefined;
    if (persisted.kind !== "box") {
      throw new Error(
        `handoff ${ref.id} stores an Agent Sandbox identity but its target snapshot is box — ` +
          "state.json tampered or corrupted?",
      );
    }
    assertBoxId(persisted.boxId, "persisted box id");
    return persisted;
  }

  async provision(
    ref: SandboxRef,
    persist?: (sandbox: SandboxState) => void,
  ): Promise<Transport> {
    const persisted = this.sandboxState(ref);
    if (persisted !== undefined) return await this.connect(ref);
    const connection = await this.create(ref, persist);
    const transport = await this.transport(connection);
    await this.bootstrap(transport);
    return transport;
  }

  async connect(ref?: SandboxRef): Promise<Transport> {
    if (ref === undefined) {
      throw new Error("no live Box for this target — run `beam up` to provision one first");
    }
    const state = this.sandboxState(ref);
    if (state === undefined) {
      throw new Error(
        `handoff ${ref.id} has no persisted Box id — provisioning did not reach creation; ` +
          "run `beam up` to retry",
      );
    }
    return await this.transport(await this.waitReady(state));
  }

  async destroy(ref: SandboxRef): Promise<void> {
    const state = this.sandboxState(ref);
    if (state === undefined) return;
    try {
      await this.boxJson(["info", state.boxId, "--json"], `inspect ${state.boxId}`);
    } catch (error) {
      if (error instanceof BoxCliError && error.boxCode === "not_found") return;
      throw error;
    }
    try {
      await this.boxJson(["delete", state.boxId, "--yes", "--json"], `delete ${state.boxId}`);
    } catch (error) {
      if (error instanceof BoxCliError && error.boxCode === "not_found") return;
      throw error;
    }
  }

  async destroyAfterVerifiedCleanupWithoutConnection(ref: SandboxRef): Promise<void> {
    await this.destroy(ref);
  }

  async check(): Promise<ProviderCheckReport> {
    const lines: string[] = [];
    const boxExists = this.bin.includes("/") ? existsSync(this.bin) : Bun.which(this.bin) !== null;
    lines.push(`Box CLI:     ${boxExists ? this.bin : "MISSING"}`);
    lines.push(`local ssh:   ${Bun.which("ssh") ?? "MISSING"}`);
    lines.push(`local rsync: ${Bun.which("rsync") ?? "MISSING"}`);
    if (!boxExists) {
      return {
        lines,
        fatal:
          "install Box with `curl -fsSL https://box.ascii.dev/install | sh`, " +
          "then run `box onboard`",
      };
    }
    const status = await run(
      [this.bin, "limits", "--json"],
      { maxOutputBytes: BOX_OUTPUT_BYTES_MAX },
    );
    if (status.code !== 0) {
      return { lines, fatal: "Box is not ready — run `box onboard`, then retry `beam check`" };
    }
    lines.push("Box account: authenticated and able to read limits");
    if (Bun.which("ssh") === null || Bun.which("rsync") === null) {
      return { lines, fatal: "install local ssh and rsync before using a Box target" };
    }
    return { lines };
  }

  private createArgs(): string[] {
    return [
      "new",
      ...(this.spec.machineType === undefined ? [] : ["--type", this.spec.machineType]),
      ...(this.spec.environment === undefined
        ? []
        : [`--environment=${this.spec.environment}`]),
      ...(this.spec.ttlSeconds === undefined
        ? ["--no-auto-stop"]
        : ["--ttl", String(this.spec.ttlSeconds)]),
      "--json",
    ];
  }

  private async create(
    ref: SandboxRef,
    persist?: (sandbox: SandboxState) => void,
  ): Promise<BoxConnection> {
    const progress: NewProgress = { ref, persist };
    const argv = [this.bin, ...this.createArgs()];
    console.log("sandbox: provisioning a Box…");
    const result = await runStreaming(argv, (line) => handleNewLine(progress, line));
    if (result.code !== 0) {
      const trialFix = result.stdout.includes("trial_auto_stop_required")
        ? " Set `ttlSeconds: 7200` on the target while using the Box trial."
        : "";
      const detail = progress.error ?? result.stderr.trim() ?? result.stdout.trim();
      throw new Error(`Box creation failed (${result.code}): ${detail}.${trialFix}`);
    }
    if (progress.created === undefined || progress.ready === undefined) {
      throw new Error("Box creation exited successfully without both created and ready events");
    }
    if (progress.created.boxId !== progress.ready.id) {
      throw new Error("Box ready event did not match the id persisted from its created event");
    }
    console.log(`sandbox: Box ${progress.ready.id} ready`);
    return progress.ready;
  }

  private async boxJson(args: string[], what: string): Promise<Record<string, unknown>> {
    const result = await run(
      [this.bin, ...args],
      { maxOutputBytes: BOX_OUTPUT_BYTES_MAX },
    );
    const lines = result.stdout.trim().split("\n").filter((line) => line !== "");
    if (lines.length > BOX_OUTPUT_LINES_MAX) {
      throw new Error(
        `Box CLI output exceeded ${BOX_OUTPUT_LINES_MAX} lines while trying to ${what}`,
      );
    }
    const value = lines.length === 0
      ? undefined
      : parseJsonRecord(lines[lines.length - 1]!, what);
    if (result.code !== 0) {
      const code = typeof value?.code === "string" ? value.code : undefined;
      const detail = typeof value?.error === "string"
        ? value.error
        : result.stderr.trim() || result.stdout.trim() || "no diagnostic output";
      throw new BoxCliError(`Box CLI could not ${what} (${result.code}): ${detail}`, code);
    }
    if (value === undefined) throw new Error(`Box CLI returned no JSON while trying to ${what}`);
    return value;
  }

  private async boxInfo(state: BoxSandboxState): Promise<Record<string, unknown>> {
    const value = await this.boxJson(["info", state.boxId, "--json"], `inspect ${state.boxId}`);
    const box = value.box;
    if (typeof box !== "object" || box === null || Array.isArray(box)) {
      throw new Error(`Box CLI returned no box object while inspecting ${state.boxId}`);
    }
    const record = box as Record<string, unknown>;
    const id = assertBoxId(record.id, "info id");
    if (id !== state.boxId) {
      throw new Error(`Box CLI returned ${id} while Beam requested ${state.boxId} — refusing`);
    }
    return record;
  }

  private resumeArgs(boxId: string): string[] {
    return [
      "resume",
      boxId,
      ...(this.spec.ttlSeconds === undefined
        ? ["--no-auto-stop"]
        : ["--ttl", String(this.spec.ttlSeconds)]),
      "--json",
    ];
  }

  private async waitReady(state: BoxSandboxState): Promise<BoxConnection> {
    let resumed = false;
    for (let attempt = 1; attempt <= BOX_READY_ATTEMPTS_MAX; attempt += 1) {
      const box = await this.boxInfo(state);
      const current = typeof box.state === "string" ? box.state : "(unreadable)";
      if (["ready", "idle", "running"].includes(current)) {
        return parseConnection(box, "box info");
      }
      if (current === "stopped" && !resumed) {
        console.log(`sandbox: resuming Box ${state.boxId}…`);
        await this.boxJson(this.resumeArgs(state.boxId), `resume ${state.boxId}`);
        resumed = true;
      } else {
        if (current === "error") {
          throw new Error(
            `Box ${state.boxId} is in error state — inspect it with \`box info\``,
          );
        }
      }
      if (attempt < BOX_READY_ATTEMPTS_MAX) await Bun.sleep(BOX_READY_POLL_MS);
    }
    throw new Error(
      `Box ${state.boxId} did not become ready after ` +
        `${BOX_READY_ATTEMPTS_MAX * BOX_READY_POLL_MS}ms`,
    );
  }

  private async transport(connection: BoxConnection): Promise<SshTransport> {
    const authorized = await run(
      [this.bin, "ssh", connection.id, "--", "true"],
      { maxOutputBytes: BOX_OUTPUT_BYTES_MAX },
    );
    if (authorized.code !== 0) {
      const detail = authorized.stderr.trim() || authorized.stdout.trim();
      throw new Error(`Box ${connection.id} SSH setup failed: ${detail}`);
    }
    const identity = join(homedir(), ".ssh", "ascii_box_ed25519");
    return new SshTransport(`user@${connection.ip}`, {
      label: `box ${connection.id}`,
      sshOptions: [
        "-i",
        identity,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        `HostKeyAlias=${connection.id}`,
      ],
    });
  }

  private async bootstrap(transport: SshTransport): Promise<void> {
    await bootstrapManagedLinux(transport, { provider: "Box", useSudo: true });
  }
}
