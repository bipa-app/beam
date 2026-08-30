/**
 * Goal: prove E2B reservation recovery, identity checks, lifecycle, and SSH
 * transport construction without creating a paid sandbox.
 *
 * Method: a local HTTP server implements the documented E2B lifecycle API;
 * canned ssh/rsync/websocat binaries record the data-plane argv. Real
 * ssh-keygen creates only fixture-scoped Beam keys.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2bProvider } from "../src/provider/e2b.ts";
import type { E2bSandboxState, SandboxState } from "../src/provider/types.ts";
import { shq } from "../src/util/shell.ts";

const PROCESS_TIMEOUT_MS = 30_000;
const SANDBOX_ID = "sbx_fixture_001";
const TEMPLATE_ALIAS = "beam-ssh";
const TEMPLATE_ID = "tpl_fixture_001";

interface ApiSandbox {
  alias: string;
  metadata: Record<string, string>;
  sandboxID: string;
  state: "paused" | "running";
  templateID: string;
}

function writeScript(path: string, lines: string[]): void {
  writeFileSync(path, lines.join("\n") + "\n");
  chmodSync(path, 0o755);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

interface E2bApiFixture {
  create: () => void;
  getSandboxes: () => Map<string, ApiSandbox>;
  shouldFailCreate: () => boolean;
}

function startE2bApiServer(fixture: E2bApiFixture): Bun.Server<undefined> {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.headers.get("X-API-Key") !== "fixture-key") {
        return json({ message: "unauthorized" }, 401);
      }
      const url = new URL(request.url);
      const sandboxes = fixture.getSandboxes();
      if (request.method === "GET" && url.pathname === "/v2/sandboxes") {
        return json([...sandboxes.values()]);
      }
      if (request.method === "POST" && url.pathname === "/sandboxes") {
        fixture.create();
        if (fixture.shouldFailCreate()) return json({ message: "fixture capacity" }, 503);
        const body = await request.json() as Record<string, unknown>;
        const metadata = body.metadata as Record<string, string>;
        const sandbox: ApiSandbox = {
          alias: TEMPLATE_ALIAS,
          metadata,
          sandboxID: SANDBOX_ID,
          state: "running",
          templateID: TEMPLATE_ID,
        };
        sandboxes.set(SANDBOX_ID, sandbox);
        return json({
          alias: sandbox.alias,
          clientID: "fixture",
          envdVersion: "fixture",
          sandboxID: sandbox.sandboxID,
          templateID: sandbox.templateID,
        }, 201);
      }
      const match = url.pathname.match(/^\/sandboxes\/([^/]+)(\/connect)?$/);
      const id = match?.[1];
      if (id === undefined) return json({ message: "unknown route" }, 404);
      const sandbox = sandboxes.get(id);
      if (sandbox === undefined) return json({ message: "not found" }, 404);
      if (request.method === "GET" && match?.[2] === undefined) return json(sandbox);
      if (request.method === "POST" && match?.[2] === "/connect") {
        sandbox.state = "running";
        return json({
          alias: sandbox.alias,
          clientID: "fixture",
          envdVersion: "fixture",
          sandboxID: sandbox.sandboxID,
          templateID: sandbox.templateID,
        });
      }
      if (request.method === "DELETE" && match?.[2] === undefined) {
        sandboxes.delete(id);
        return new Response(null, { status: 204 });
      }
      return json({ message: "unsupported" }, 405);
    },
  });
}

function e2bState(value: SandboxState | undefined): E2bSandboxState {
  if (value?.kind !== "e2b") throw new Error("test expected E2B state");
  return value;
}

describe("E2B provider lifecycle", () => {
  let root: string;
  let binDir: string;
  let server: Bun.Server<undefined>;
  let apiBaseUrl: string;
  let savedBeamDir: string | undefined;
  let savedPath: string | undefined;
  let sandboxes: Map<string, ApiSandbox>;
  let createCount: number;
  let failCreate: boolean;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "beam-e2b-provider-"));
    binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    writeScript(join(binDir, "ssh"), [
      "#!/bin/sh",
      "set -eu",
      `printf '%s\\n' "$*" >> ${shq(join(root, "ssh.log"))}`,
    ]);
    writeScript(join(binDir, "rsync"), [
      "#!/bin/sh",
      "set -eu",
      `printf '%s\\n' "$*" >> ${shq(join(root, "rsync.log"))}`,
    ]);
    writeScript(join(binDir, "websocat"), ["#!/bin/sh", "exit 0"]);
    savedBeamDir = process.env.BEAM_DIR;
    savedPath = process.env.PATH;
    process.env.BEAM_DIR = join(root, "beam-home");
    process.env.PATH = `${binDir}:${savedPath ?? ""}`;
    server = startE2bApiServer({
      create: () => {
        createCount += 1;
      },
      getSandboxes: () => sandboxes,
      shouldFailCreate: () => failCreate,
    });
    apiBaseUrl = `http://127.0.0.1:${server.port}`;
  });
  beforeEach(() => {
    sandboxes = new Map();
    createCount = 0;
    failCreate = false;
    rmSync(join(root, "ssh.log"), { force: true });
    rmSync(join(root, "rsync.log"), { force: true });
    rmSync(join(root, "beam-home"), { force: true, recursive: true });
  });

  afterAll(() => {
    server.stop(true);
    if (savedBeamDir === undefined) delete process.env.BEAM_DIR;
    else process.env.BEAM_DIR = savedBeamDir;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(root, { force: true, recursive: true });
  });

  test(
    "journals reservation and key identity before a failed API creation",
    async () => {
      failCreate = true;
      const provider = new E2bProvider(
        { type: "e2b", template: TEMPLATE_ALIAS },
        { apiBaseUrl, apiKey: "fixture-key", websocatBin: join(binDir, "websocat") },
      );
      const ref: { id: string; sandbox?: SandboxState } = { id: "early" };
      const published: SandboxState[] = [];

      await expect(provider.provision(ref, (state) => published.push(state))).rejects.toThrow(
        /fixture capacity/,
      );
      const state = e2bState(ref.sandbox);
      expect(state.sandboxId).toBeUndefined();
      expect(state.sshKeySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(published).toHaveLength(2);
      expect(existsSync(join(root, "ssh.log"))).toBe(false);
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "creates, pins, connects, bootstraps, and deletes the exact sandbox",
    async () => {
      const provider = new E2bProvider(
        { type: "e2b", template: TEMPLATE_ALIAS, timeoutSeconds: 7200 },
        { apiBaseUrl, apiKey: "fixture-key", websocatBin: join(binDir, "websocat") },
      );
      const ref: { id: string; sandbox?: SandboxState } = { id: "fresh" };
      const published: SandboxState[] = [];
      const transport = await provider.provision(ref, (state) => published.push(state));
      await transport.syncUp(root, "~/beam/fixture");

      const state = e2bState(ref.sandbox);
      expect(state.sandboxId).toBe(SANDBOX_ID);
      expect(published).toHaveLength(3);
      expect(createCount).toBe(1);
      const sshLog = readFileSync(join(root, "ssh.log"), "utf8");
      expect(sshLog).toContain(`ProxyCommand='${join(binDir, "websocat")}' --binary -B 65536`);
      expect(sshLog).toContain(`HostKeyAlias=e2b-${SANDBOX_ID}`);
      expect(sshLog).toContain("sha256sum -c -");
      const rsyncLog = readFileSync(join(root, "rsync.log"), "utf8");
      expect(rsyncLog).toContain(`user@${SANDBOX_ID}:./`);
      expect(transport.label).toBe(`E2B ${SANDBOX_ID}`);

      const keyPath = join(
        root,
        "beam-home",
        "keys",
        `e2b-${state.ownerToken}.ed25519`,
      );
      expect(existsSync(keyPath)).toBe(true);
      await provider.destroyAfterVerifiedCleanupWithoutConnection(ref);
      expect(sandboxes.size).toBe(0);
      expect(existsSync(keyPath)).toBe(false);
      await provider.destroy(ref);
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "recovers one owner-labelled sandbox without creating a duplicate",
    async () => {
      const provider = new E2bProvider(
        { type: "e2b", template: TEMPLATE_ALIAS },
        { apiBaseUrl, apiKey: "fixture-key", websocatBin: join(binDir, "websocat") },
      );
      const ref: { id: string; sandbox?: SandboxState } = { id: "recover" };
      ref.sandbox = provider.sandboxState(ref);
      const reservation = e2bState(ref.sandbox);
      sandboxes.set(SANDBOX_ID, {
        alias: TEMPLATE_ALIAS,
        metadata: { "beam.owner": reservation.ownerToken, "beam.record": ref.id },
        sandboxID: SANDBOX_ID,
        state: "paused",
        templateID: TEMPLATE_ID,
      });
      const published: SandboxState[] = [];

      await provider.provision(ref, (state) => published.push(state));
      expect(e2bState(ref.sandbox).sandboxId).toBe(SANDBOX_ID);
      expect(createCount).toBe(0);
      expect(published.at(-1)).toMatchObject({ kind: "e2b", sandboxId: SANDBOX_ID });
    },
    PROCESS_TIMEOUT_MS,
  );

  test("refuses a same-id sandbox whose owner metadata changed", async () => {
    const provider = new E2bProvider(
      { type: "e2b", template: TEMPLATE_ALIAS },
      { apiBaseUrl, apiKey: "fixture-key", websocatBin: join(binDir, "websocat") },
    );
    const ref: { id: string; sandbox?: SandboxState } = { id: "foreign" };
    const reservation = provider.sandboxState(ref);
    ref.sandbox = { ...reservation, sandboxId: SANDBOX_ID };
    sandboxes.set(SANDBOX_ID, {
      alias: TEMPLATE_ALIAS,
      metadata: { "beam.owner": "0".repeat(48), "beam.record": ref.id },
      sandboxID: SANDBOX_ID,
      state: "running",
      templateID: TEMPLATE_ID,
    });

    await expect(provider.destroy(ref)).rejects.toThrow(/does not carry this handoff's owner/);
    expect(sandboxes.has(SANDBOX_ID)).toBe(true);
  });

  test("check verifies account access and every local transport tool", async () => {
    const provider = new E2bProvider(
      { type: "e2b", template: TEMPLATE_ALIAS },
      { apiBaseUrl, apiKey: "fixture-key", websocatBin: join(binDir, "websocat") },
    );
    const report = await provider.check();
    expect(report.fatal).toBeUndefined();
    expect(report.lines).toContain(
      "E2B account:     authenticated; key can manage team sandboxes",
    );
  });
});
