import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaytonaTargetSpec } from "../config.ts";
import { SshTransport } from "../transport/ssh.ts";
import type { Transport } from "../transport/types.ts";
import { run } from "../util/shell.ts";
import {
  assertOwnerToken,
  bootstrapManagedLinux,
  newOwnerToken,
} from "./managed-ssh.ts";
import type {
  DaytonaSandboxState,
  ProviderCheckReport,
  SandboxProvider,
  SandboxRef,
  SandboxState,
} from "./types.ts";

const DAYTONA_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;
const DAYTONA_NAME_SHAPE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const DAYTONA_OUTPUT_BYTES_MAX = 1024 * 1024;
const DAYTONA_READY_ATTEMPTS_MAX = 300;
const DAYTONA_READY_POLL_MS = 1_000;
const DAYTONA_SSH_ARGV_BYTES_MAX = 16 * 1024;
const DAYTONA_VALUE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,510}$/;
const RECORD_ID_SHAPE = /^[a-z0-9]{1,12}$/;
const SSH_DESTINATION_SHAPE = /^([A-Za-z0-9._~-]{1,256})@([A-Za-z0-9.-]{1,253})$/;

interface DaytonaInfo {
  id: string;
  labels: Record<string, unknown>;
  name: string;
  state: string;
}

interface DaytonaSshConnection {
  destination: string;
  port?: number;
}

function parseJsonRecord(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Daytona CLI returned malformed JSON while trying to ${what}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Daytona CLI returned non-object JSON while trying to ${what}`);
  }
  return value as Record<string, unknown>;
}

function sandboxName(ref: SandboxRef, ownerToken: string): string {
  if (!RECORD_ID_SHAPE.test(ref.id)) {
    throw new Error(`Daytona cannot derive a sandbox name from malformed record id ${ref.id}`);
  }
  return `beam-${ref.id}-${ownerToken.slice(0, 12)}`;
}

function assertDaytonaId(value: unknown, what: string): string {
  if (typeof value !== "string" || !DAYTONA_ID_SHAPE.test(value)) {
    throw new Error(`Daytona CLI returned malformed ${what}: ${JSON.stringify(value)}`);
  }
  return value;
}

function isNotFound(output: string): boolean {
  return /(?:404|not found|does not exist|could not find)/i.test(output);
}

function parseSshArgv(bytes: Buffer): DaytonaSshConnection {
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 0) {
    throw new Error("Daytona SSH bridge did not return a complete NUL-delimited argv");
  }
  const argv = bytes.toString("utf8").split("\0").slice(0, -1);
  let destination: string;
  let port: number | undefined;
  if (argv.length === 1) {
    destination = argv[0]!;
  } else {
    if (argv.length !== 3 || argv[0] !== "-p") {
      throw new Error(
        `Daytona returned an unsupported SSH argv shape (${argv.length} arguments)`,
      );
    }
    port = Number(argv[1]);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
      throw new Error("Daytona returned an invalid SSH port");
    }
    destination = argv[2]!;
  }
  if (!SSH_DESTINATION_SHAPE.test(destination)) {
    throw new Error("Daytona returned a malformed SSH token destination");
  }
  return port === undefined ? { destination } : { destination, port };
}

/** Daytona lifecycle over its CLI; fresh access tokens feed Beam's SSH transport. */
export class DaytonaProvider implements SandboxProvider {
  readonly label = "Daytona";
  readonly reusesSandbox = false;

  constructor(
    private readonly spec: DaytonaTargetSpec,
    private readonly bin: string = "daytona",
  ) {
    this.assertOptionalValue(spec.snapshot, "snapshot");
    this.assertOptionalValue(spec.target, "target");
  }

  sandboxState(ref: SandboxRef): DaytonaSandboxState {
    if (ref.sandbox === undefined) {
      const ownerToken = newOwnerToken();
      return { kind: "daytona", ownerToken, sandboxName: sandboxName(ref, ownerToken) };
    }
    if (ref.sandbox.kind !== "daytona") {
      throw new Error(`handoff ${ref.id} stores another provider identity, not Daytona state`);
    }
    const state = ref.sandbox;
    assertOwnerToken(state.ownerToken, "Daytona");
    const expectedName = sandboxName(ref, state.ownerToken);
    if (state.sandboxName !== expectedName || !DAYTONA_NAME_SHAPE.test(state.sandboxName)) {
      throw new Error("Daytona sandbox name does not match this handoff — state.json corrupted?");
    }
    if (state.sandboxId !== undefined) {
      assertDaytonaId(state.sandboxId, "persisted sandbox id");
    }
    return state;
  }

  async provision(
    ref: SandboxRef,
    persist?: (sandbox: SandboxState) => void,
  ): Promise<Transport> {
    let state = this.sandboxState(ref);
    if (ref.sandbox === undefined) {
      if (persist === undefined) {
        throw new Error("Daytona provisioning needs a state journal callback");
      }
      ref.sandbox = state;
      persist(state);
    }
    const info = await this.ensureSandbox(ref, state);
    if (state.sandboxId === undefined) {
      state = { ...state, sandboxId: info.id };
      this.persistState(ref, state, persist);
    }
    const ready = await this.ensureStarted(ref, state, info);
    const transport = await this.transport(state, ready);
    await bootstrapManagedLinux(transport, { provider: "Daytona", useSudo: true });
    return transport;
  }

  async connect(ref?: SandboxRef): Promise<Transport> {
    if (ref === undefined) {
      throw new Error("no live Daytona sandbox for this target — run `beam up` first");
    }
    const state = this.sandboxState(ref);
    if (state.sandboxId === undefined) {
      throw new Error(
        `handoff ${ref.id} has incomplete Daytona state — run \`beam up\` to recover`,
      );
    }
    const info = await this.info(state.sandboxId);
    if (info === undefined) {
      throw new Error(`Daytona sandbox ${state.sandboxId} is gone — run beam kill --purge`);
    }
    this.verifyInfo(ref, state, info);
    const ready = await this.ensureStarted(ref, state, info);
    return await this.transport(state, ready);
  }

  async destroy(ref: SandboxRef): Promise<void> {
    const state = this.sandboxState(ref);
    const info = await this.info(state.sandboxId ?? state.sandboxName);
    if (info === undefined) return;
    this.verifyInfo(ref, state, info);
    const result = await run(
      [this.bin, "delete", info.id],
      { maxOutputBytes: DAYTONA_OUTPUT_BYTES_MAX },
    );
    if (result.code === 0) return;
    const detail = result.stderr.trim() || result.stdout.trim();
    if (isNotFound(detail)) return;
    throw new Error(`Daytona could not delete sandbox ${info.id}: ${detail}`);
  }

  async destroyAfterVerifiedCleanupWithoutConnection(ref: SandboxRef): Promise<void> {
    await this.destroy(ref);
  }

  async check(): Promise<ProviderCheckReport> {
    const daytonaExists = this.bin.includes("/")
      ? existsSync(this.bin)
      : Bun.which(this.bin) !== null;
    const lines = [
      `Daytona CLI:  ${daytonaExists ? this.bin : "MISSING"}`,
      `local ssh:    ${Bun.which("ssh") ?? "MISSING"}`,
      `local rsync:  ${Bun.which("rsync") ?? "MISSING"}`,
    ];
    if (!daytonaExists) {
      return { lines, fatal: "install Daytona, then run `daytona login`" };
    }
    if (Bun.which("ssh") === null || Bun.which("rsync") === null) {
      return { lines, fatal: "install local ssh and rsync before using Daytona" };
    }
    const result = await run(
      [this.bin, "list", "--limit", "1", "--format", "json"],
      { maxOutputBytes: DAYTONA_OUTPUT_BYTES_MAX },
    );
    if (result.code !== 0) {
      return { lines, fatal: "Daytona is not ready — run `daytona login`" };
    }
    parseJsonRecord(result.stdout, "verify account access");
    lines.push("Daytona account: authenticated; credential can manage organization sandboxes");
    return { lines };
  }

  private assertOptionalValue(value: string | undefined, name: string): void {
    if (value === undefined) return;
    if (!DAYTONA_VALUE_SHAPE.test(value) || value.startsWith("-")) {
      throw new Error(`daytona target ${name} is invalid: ${JSON.stringify(value)}`);
    }
  }

  private persistState(
    ref: SandboxRef,
    state: DaytonaSandboxState,
    persist?: (sandbox: SandboxState) => void,
  ): void {
    if (persist === undefined) {
      throw new Error("Daytona learned durable identity without a state journal callback");
    }
    ref.sandbox = state;
    persist(state);
  }

  private createArgs(state: DaytonaSandboxState, ref: SandboxRef): string[] {
    return [
      "create",
      "--name",
      state.sandboxName,
      "--label",
      `beam.owner=${state.ownerToken}`,
      "--label",
      `beam.record=${ref.id}`,
      "--auto-pause",
      "0",
      "--auto-archive",
      "0",
      "--auto-delete",
      "-1",
      "--ttl",
      "0",
      ...(this.spec.snapshot === undefined ? [] : ["--snapshot", this.spec.snapshot]),
      ...(this.spec.target === undefined ? [] : ["--target", this.spec.target]),
    ];
  }

  private async ensureSandbox(ref: SandboxRef, state: DaytonaSandboxState): Promise<DaytonaInfo> {
    const existing = await this.info(state.sandboxId ?? state.sandboxName);
    if (existing !== undefined) {
      this.verifyInfo(ref, state, existing);
      return existing;
    }
    console.log("sandbox: provisioning a Daytona sandbox…");
    const created = await run(
      [this.bin, ...this.createArgs(state, ref)],
      { maxOutputBytes: DAYTONA_OUTPUT_BYTES_MAX },
    );
    if (created.code !== 0) {
      const detail = created.stderr.trim() || created.stdout.trim();
      throw new Error(`Daytona sandbox creation failed (${created.code}): ${detail}`);
    }
    const info = await this.info(state.sandboxName);
    if (info === undefined) {
      throw new Error("Daytona create succeeded but the named sandbox could not be read back");
    }
    this.verifyInfo(ref, state, info);
    return info;
  }

  private async info(idOrName: string): Promise<DaytonaInfo | undefined> {
    const result = await run(
      [this.bin, "info", idOrName, "--format", "json"],
      { maxOutputBytes: DAYTONA_OUTPUT_BYTES_MAX },
    );
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      if (isNotFound(detail)) return undefined;
      throw new Error(`Daytona could not inspect sandbox ${idOrName}: ${detail}`);
    }
    const value = parseJsonRecord(result.stdout, `inspect sandbox ${idOrName}`);
    const labels = value.labels;
    if (typeof labels !== "object" || labels === null || Array.isArray(labels)) {
      throw new Error(`Daytona sandbox ${idOrName} has malformed labels`);
    }
    if (typeof value.name !== "string" || typeof value.state !== "string") {
      throw new Error(`Daytona sandbox ${idOrName} has malformed name or state`);
    }
    return {
      id: assertDaytonaId(value.id, "sandbox id"),
      labels: labels as Record<string, unknown>,
      name: value.name,
      state: value.state,
    };
  }

  private verifyInfo(
    ref: SandboxRef,
    state: DaytonaSandboxState,
    info: DaytonaInfo,
  ): void {
    if (state.sandboxId !== undefined && info.id !== state.sandboxId) {
      throw new Error(
        `Daytona returned sandbox ${info.id} while Beam requested ${state.sandboxId}`,
      );
    }
    if (info.name !== state.sandboxName) {
      throw new Error(`Daytona sandbox ${info.id} has a different reserved name`);
    }
    if (info.labels["beam.owner"] !== state.ownerToken) {
      throw new Error(`Daytona sandbox ${info.id} does not carry this handoff's owner token`);
    }
    if (info.labels["beam.record"] !== ref.id) {
      throw new Error(`Daytona sandbox ${info.id} belongs to another Beam record`);
    }
  }

  private async ensureStarted(
    ref: SandboxRef,
    state: DaytonaSandboxState,
    initial: DaytonaInfo,
  ): Promise<DaytonaInfo> {
    let current = initial;
    let started = false;
    for (let attempt = 1; attempt <= DAYTONA_READY_ATTEMPTS_MAX; attempt += 1) {
      this.verifyInfo(ref, state, current);
      if (current.state === "started") return current;
      if (["error", "build_failed", "destroyed"].includes(current.state)) {
        throw new Error(`Daytona sandbox ${current.id} entered ${current.state} state`);
      }
      if (["stopped", "archived", "paused"].includes(current.state) && !started) {
        await this.start(current.id);
        started = true;
      }
      if (attempt < DAYTONA_READY_ATTEMPTS_MAX) await Bun.sleep(DAYTONA_READY_POLL_MS);
      const next = await this.info(current.id);
      if (next === undefined) throw new Error(`Daytona sandbox ${current.id} disappeared`);
      current = next;
    }
    throw new Error(
      `Daytona sandbox ${initial.id} did not start after ` +
        `${DAYTONA_READY_ATTEMPTS_MAX * DAYTONA_READY_POLL_MS}ms`,
    );
  }

  private async start(id: string): Promise<void> {
    const result = await run(
      [this.bin, "start", id],
      { maxOutputBytes: DAYTONA_OUTPUT_BYTES_MAX },
    );
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new Error(`Daytona could not start sandbox ${id}: ${detail}`);
    }
  }

  private async transport(
    state: DaytonaSandboxState,
    info: DaytonaInfo,
  ): Promise<SshTransport> {
    const connection = await this.captureSsh(info.id);
    const sshOptions = [
      ...(connection.port === undefined ? [] : ["-p", String(connection.port)]),
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `HostKeyAlias=daytona-${info.id}`,
    ];
    return new SshTransport(connection.destination, {
      label: `Daytona ${state.sandboxName}`,
      sshOptions,
    });
  }

  private async captureSsh(id: string): Promise<DaytonaSshConnection> {
    const directory = mkdtempSync(join(tmpdir(), "beam-daytona-ssh-"));
    const capturePath = join(directory, "argv");
    const sshPath = join(directory, "ssh");
    writeFileSync(sshPath, [
      "#!/bin/sh",
      "set -eu",
      ': > "$BEAM_DAYTONA_SSH_CAPTURE"',
      'for argument in "$@"; do printf "%s\\0" "$argument"; done' +
        ' >> "$BEAM_DAYTONA_SSH_CAPTURE"',
    ].join("\n") + "\n", { mode: 0o700 });
    chmodSync(sshPath, 0o700);
    try {
      const result = await run(
        [this.bin, "ssh", id, "--expires", "1440"],
        {
          env: {
            BEAM_DAYTONA_SSH_CAPTURE: capturePath,
            PATH: `${directory}:${process.env.PATH ?? ""}`,
          },
          maxOutputBytes: DAYTONA_OUTPUT_BYTES_MAX,
        },
      );
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        throw new Error(`Daytona could not issue SSH access for ${id}: ${detail}`);
      }
      if (!existsSync(capturePath)) {
        throw new Error("Daytona did not invoke SSH after issuing access");
      }
      if (statSync(capturePath).size > DAYTONA_SSH_ARGV_BYTES_MAX) {
        throw new Error("Daytona returned oversized SSH access arguments");
      }
      return parseSshArgv(readFileSync(capturePath));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }
}
