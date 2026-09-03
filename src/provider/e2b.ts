import { existsSync } from "node:fs";
import type { E2bTargetSpec } from "../config.ts";
import { SshTransport } from "../transport/ssh.ts";
import type { Transport } from "../transport/types.ts";
import { shq } from "../util/shell.ts";
import type {
  E2bSandboxState,
  ProviderCheckReport,
  SandboxProvider,
  SandboxRef,
  SandboxState,
} from "./types.ts";
import {
  assertOwnerToken,
  bootstrapManagedLinux,
  ensureManagedSshIdentity,
  managedSshCheckLines,
  managedSshToolsReady,
  newOwnerToken,
  removeManagedSshIdentity,
} from "./managed-ssh.ts";

const E2B_API_BASE = "https://api.e2b.app";
const E2B_HTTP_TIMEOUT_MS = 120_000;
const E2B_OUTPUT_BYTES_MAX = 1024 * 1024;
const E2B_SANDBOX_ID_SHAPE = /^[A-Za-z0-9_-]{6,128}$/;
const E2B_SSH_KEY_SHA256_SHAPE = /^[a-f0-9]{64}$/;
const E2B_TIMEOUT_SECONDS_DEFAULT = 24 * 60 * 60;
const E2B_TIMEOUT_SECONDS_MAX = 30 * 24 * 60 * 60;
const E2B_USER_SHAPE = /^[a-z_][a-z0-9_-]{0,31}$/;

interface E2bProviderOptions {
  apiBaseUrl?: string;
  apiKey?: string;
  websocatBin?: string;
}

interface E2bApiResult {
  status: number;
  value?: unknown;
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes > E2B_OUTPUT_BYTES_MAX) {
        await reader.cancel();
        throw new Error(`E2B API response exceeded ${E2B_OUTPUT_BYTES_MAX} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function parseJson(text: string, what: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`E2B API returned malformed JSON while trying to ${what}`);
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`E2B API returned non-object JSON while trying to ${what}`);
  }
  return value as Record<string, unknown>;
}

function sandboxId(value: unknown, what: string): string {
  if (typeof value !== "string" || !E2B_SANDBOX_ID_SHAPE.test(value)) {
    throw new Error(`E2B API returned malformed ${what}: ${JSON.stringify(value)}`);
  }
  return value;
}

function errorDetail(value: unknown, fallback: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  return fallback;
}

/** E2B lifecycle over its API; shell and files use the documented SSH proxy. */
export class E2bProvider implements SandboxProvider {
  readonly label = "E2B";
  readonly reusesSandbox = false;
  private readonly apiBaseUrl: string;
  private readonly apiKeyOverride?: string;
  private readonly timeoutSeconds: number;
  private readonly user: string;
  private readonly websocatBin: string;

  constructor(
    private readonly spec: E2bTargetSpec,
    options: E2bProviderOptions = {},
  ) {
    if (spec.template.trim() === "" || spec.template.length > 128) {
      throw new Error("e2b target template must be a non-empty id or alias of at most 128 bytes");
    }
    this.user = spec.user ?? "user";
    if (!E2B_USER_SHAPE.test(this.user)) {
      throw new Error(`e2b target user is invalid: ${JSON.stringify(this.user)}`);
    }
    this.timeoutSeconds = spec.timeoutSeconds ?? E2B_TIMEOUT_SECONDS_DEFAULT;
    if (!Number.isSafeInteger(this.timeoutSeconds) || this.timeoutSeconds <= 0) {
      throw new Error("e2b target timeoutSeconds must be a positive integer");
    }
    if (this.timeoutSeconds > E2B_TIMEOUT_SECONDS_MAX) {
      throw new Error("e2b target timeoutSeconds exceeds Beam's 30-day ceiling");
    }
    this.apiBaseUrl = options.apiBaseUrl ?? E2B_API_BASE;
    this.apiKeyOverride = options.apiKey;
    this.websocatBin = options.websocatBin ?? "websocat";
  }

  sandboxState(ref: SandboxRef): E2bSandboxState {
    if (ref.sandbox === undefined) {
      return { kind: "e2b", ownerToken: newOwnerToken() };
    }
    if (ref.sandbox.kind !== "e2b") {
      throw new Error(
        `handoff ${ref.id} stores another provider identity but its target snapshot is e2b`,
      );
    }
    const state = ref.sandbox;
    assertOwnerToken(state.ownerToken, "E2B");
    if (state.sandboxId !== undefined) sandboxId(state.sandboxId, "persisted sandbox id");
    if (
      state.sshKeySha256 !== undefined &&
      !E2B_SSH_KEY_SHA256_SHAPE.test(state.sshKeySha256)
    ) {
      throw new Error("E2B SSH key fingerprint is malformed — state.json corrupted?");
    }
    return state;
  }

  async provision(
    ref: SandboxRef,
    persist?: (sandbox: SandboxState) => void,
  ): Promise<Transport> {
    let state = this.sandboxState(ref);
    if (ref.sandbox === undefined) {
      if (persist === undefined) throw new Error("E2B provisioning needs a state journal callback");
      ref.sandbox = state;
      persist(state);
    }
    const identity = await ensureManagedSshIdentity(
      "e2b",
      state.ownerToken,
      state.sshKeySha256,
    );
    if (state.sshKeySha256 === undefined) {
      if (persist === undefined) throw new Error("E2B provisioning needs a state journal callback");
      state = { ...state, sshKeySha256: identity.sha256 };
      ref.sandbox = state;
      persist(state);
    }
    state = await this.ensureSandbox(ref, state, identity.publicKey, persist);
    const transport = await this.connectState(ref, state, identity.path);
    await bootstrapManagedLinux(transport, { provider: "E2B", useSudo: true });
    return transport;
  }

  async connect(ref?: SandboxRef): Promise<Transport> {
    if (ref === undefined) {
      throw new Error("no live E2B sandbox for this target — run `beam up` first");
    }
    const state = this.sandboxState(ref);
    if (state.sandboxId === undefined || state.sshKeySha256 === undefined) {
      throw new Error(
        `handoff ${ref.id} has incomplete E2B provisioning state — run \`beam up\` to recover`,
      );
    }
    const identity = await ensureManagedSshIdentity(
      "e2b",
      state.ownerToken,
      state.sshKeySha256,
    );
    return await this.connectState(ref, state, identity.path);
  }

  async destroy(ref: SandboxRef): Promise<void> {
    const state = this.sandboxState(ref);
    const id = state.sandboxId ?? await this.recoverSandboxId(ref, state);
    if (id !== undefined) {
      const info = await this.getSandbox(id);
      if (info !== undefined) {
        this.verifySandbox(info, { ref, state, sandboxId: id });
        await this.api(`/sandboxes/${encodeURIComponent(id)}`, {
          method: "DELETE",
          expectedStatuses: [204, 404],
          what: `delete sandbox ${id}`,
        });
      }
    }
    removeManagedSshIdentity("e2b", state.ownerToken);
  }

  async destroyAfterVerifiedCleanupWithoutConnection(ref: SandboxRef): Promise<void> {
    await this.destroy(ref);
  }

  async check(): Promise<ProviderCheckReport> {
    const apiKey = this.apiKey();
    const websocatExists = this.websocatBin.includes("/")
      ? existsSync(this.websocatBin)
      : Bun.which(this.websocatBin) !== null;
    const lines = [
      `E2B API key:     ${apiKey === undefined ? "MISSING" : "set"}`,
      `local websocat:  ${websocatExists ? this.websocatBin : "MISSING"}`,
      ...managedSshCheckLines(),
    ];
    if (apiKey === undefined) {
      return { lines, fatal: "set E2B_API_KEY before using an E2B target" };
    }
    if (!managedSshToolsReady() || !websocatExists) {
      return { lines, fatal: "install local ssh, rsync, ssh-keygen, and websocat" };
    }
    await this.api("/v2/sandboxes?state=running%2Cpaused&limit=1", {
      method: "GET",
      expectedStatuses: [200],
      what: "verify account access",
    });
    lines.push("E2B account:     authenticated; key can manage team sandboxes");
    return { lines };
  }

  private apiKey(): string | undefined {
    const value = this.apiKeyOverride ?? process.env.E2B_API_KEY;
    return value === undefined || value.trim() === "" ? undefined : value;
  }

  private async api(
    path: string,
    options: {
      method: string;
      expectedStatuses: number[];
      what: string;
      body?: unknown;
    },
  ): Promise<E2bApiResult> {
    const apiKey = this.apiKey();
    if (apiKey === undefined) throw new Error("E2B_API_KEY is not set");
    let response: Response;
    try {
      response = await fetch(new URL(path, this.apiBaseUrl), {
        method: options.method,
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(E2B_HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`E2B API could not ${options.what}: ${String(error)}`);
    }
    const text = await readBoundedResponse(response);
    const value = parseJson(text, options.what);
    if (!options.expectedStatuses.includes(response.status)) {
      const fallback = text || `HTTP ${response.status}`;
      throw new Error(`E2B API could not ${options.what}: ${errorDetail(value, fallback)}`);
    }
    return { status: response.status, value };
  }

  private async ensureSandbox(
    ref: SandboxRef,
    state: E2bSandboxState,
    publicKey: string,
    persist?: (sandbox: SandboxState) => void,
  ): Promise<E2bSandboxState & { sandboxId: string }> {
    const recovered = state.sandboxId ?? await this.recoverSandboxId(ref, state);
    if (recovered !== undefined) {
      const next = { ...state, sandboxId: recovered };
      if (state.sandboxId === undefined) this.persistState(ref, next, persist);
      return next;
    }
    const created = await this.api("/sandboxes", {
      method: "POST",
      expectedStatuses: [201],
      what: "create a sandbox",
      body: this.createBody(ref, state, publicKey),
    });
    const record = asRecord(created.value, "create a sandbox");
    const id = sandboxId(record.sandboxID, "created sandbox id");
    this.verifyTemplate(record, id);
    const next = { ...state, sandboxId: id };
    this.persistState(ref, next, persist);
    return next;
  }

  private createBody(
    ref: SandboxRef,
    state: E2bSandboxState,
    publicKey: string,
  ): Record<string, unknown> {
    return {
      templateID: this.spec.template,
      timeout: this.timeoutSeconds,
      autoPause: true,
      autoPauseMemory: true,
      autoResume: { enabled: false },
      network: { allowPublicTraffic: true },
      metadata: { "beam.owner": state.ownerToken, "beam.record": ref.id },
      envVars: { BEAM_SSH_PUBLIC_KEY: publicKey },
    };
  }

  private persistState(
    ref: SandboxRef,
    state: E2bSandboxState,
    persist?: (sandbox: SandboxState) => void,
  ): void {
    if (persist === undefined) {
      throw new Error("E2B learned durable identity without a state journal callback");
    }
    ref.sandbox = state;
    persist(state);
  }

  private async recoverSandboxId(
    ref: SandboxRef,
    state: E2bSandboxState,
  ): Promise<string | undefined> {
    const result = await this.api(this.recoveryPath(ref, state), {
      method: "GET",
      expectedStatuses: [200],
      what: "recover a reserved sandbox",
    });
    if (!Array.isArray(result.value)) {
      throw new Error("E2B API returned non-array JSON while recovering a sandbox");
    }
    if (result.value.length > 1) {
      throw new Error(`E2B owner token for handoff ${ref.id} matched several sandboxes`);
    }
    const candidate = result.value[0];
    if (candidate === undefined) return undefined;
    const record = asRecord(candidate, "recover a reserved sandbox");
    const id = sandboxId(record.sandboxID, "recovered sandbox id");
    this.verifySandbox(record, { ref, state, sandboxId: id });
    return id;
  }

  private recoveryPath(ref: SandboxRef, state: E2bSandboxState): string {
    const query = new URLSearchParams({
      metadata: `beam.owner=${state.ownerToken}&beam.record=${ref.id}`,
      state: "running,paused",
      limit: "2",
    });
    return `/v2/sandboxes?${query}`;
  }

  private async getSandbox(id: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.api(`/sandboxes/${encodeURIComponent(id)}`, {
      method: "GET",
      expectedStatuses: [200, 404],
      what: `inspect sandbox ${id}`,
    });
    if (result.status === 404) return undefined;
    return asRecord(result.value, `inspect sandbox ${id}`);
  }

  private verifyTemplate(record: Record<string, unknown>, id: string): void {
    const matches = record.templateID === this.spec.template || record.alias === this.spec.template;
    if (!matches) {
      throw new Error(`E2B sandbox ${id} does not use configured template ${this.spec.template}`);
    }
  }

  private verifySandbox(
    record: Record<string, unknown>,
    expected: { ref: SandboxRef; state: E2bSandboxState; sandboxId: string },
  ): void {
    const id = sandboxId(record.sandboxID, "sandbox id");
    if (id !== expected.sandboxId) {
      throw new Error(`E2B returned sandbox ${id} while Beam requested ${expected.sandboxId}`);
    }
    this.verifyTemplate(record, id);
    const metadata = asRecord(record.metadata, `inspect metadata for ${id}`);
    if (metadata["beam.owner"] !== expected.state.ownerToken) {
      throw new Error(`E2B sandbox ${id} does not carry this handoff's owner token`);
    }
    if (metadata["beam.record"] !== expected.ref.id) {
      throw new Error(`E2B sandbox ${id} belongs to another Beam record`);
    }
  }

  private async connectState(
    ref: SandboxRef,
    state: E2bSandboxState,
    identityPath: string,
  ): Promise<SshTransport> {
    if (state.sandboxId === undefined) {
      throw new Error("E2B transport needs a persisted sandbox id");
    }
    const info = await this.getSandbox(state.sandboxId);
    if (info === undefined) {
      throw new Error(`E2B sandbox ${state.sandboxId} is gone — run beam kill --purge`);
    }
    this.verifySandbox(info, { ref, state, sandboxId: state.sandboxId });
    const result = await this.api(
      `/sandboxes/${encodeURIComponent(state.sandboxId)}/connect`,
      {
        method: "POST",
        expectedStatuses: [200, 201],
        what: `resume sandbox ${state.sandboxId}`,
        body: { timeout: this.timeoutSeconds },
      },
    );
    const record = asRecord(result.value, `resume sandbox ${state.sandboxId}`);
    const id = sandboxId(record.sandboxID, "connected sandbox id");
    if (id !== state.sandboxId) throw new Error("E2B connect returned a different sandbox id");
    this.verifyTemplate(record, id);
    return new SshTransport(`${this.user}@${id}`, {
      label: `E2B ${id}`,
      sshOptions: this.sshOptions(id, identityPath),
    });
  }

  private sshOptions(id: string, identityPath: string): string[] {
    const proxy = `${shq(this.websocatBin)} --binary -B 65536 - wss://8081-%h.e2b.app`;
    return [
      "-i",
      identityPath,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `HostKeyAlias=e2b-${id}`,
      "-o",
      `ProxyCommand=${proxy}`,
    ];
  }
}
