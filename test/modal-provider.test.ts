/**
 * Goal: prove Modal's durable-Volume receipts, replaceable compute bootstrap,
 * lifecycle, and SSH transport contract without using a paid workspace.
 *
 * Method: a canned Modal CLI implements Beam's machine bridge protocol and
 * canned ssh/rsync binaries record data-plane argv. Real ssh-keygen writes
 * only fixture-scoped keys under BEAM_DIR.
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
import { ModalProvider } from "../src/provider/modal.ts";
import type { ModalSandboxState, SandboxState } from "../src/provider/types.ts";
import { shq } from "../src/util/shell.ts";

const PROCESS_TIMEOUT_MS = 30_000;
const SANDBOX_ID = "sb-fixture001";
const REPLACEMENT_ID = "sb-fixture002";

function writeScript(path: string, lines: string[]): void {
  writeFileSync(path, lines.join("\n") + "\n");
  chmodSync(path, 0o755);
}

function modalState(value: SandboxState | undefined): ModalSandboxState {
  if (value?.kind !== "modal") throw new Error("test expected Modal state");
  return value;
}

describe("Modal provider lifecycle", () => {
  let root: string;
  let binDir: string;
  let modalBin: string;
  let savedBeamDir: string | undefined;
  let savedPath: string | undefined;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "beam-modal-provider-"));
    binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    modalBin = join(binDir, "modal");
    const fixture = shq(root);
    writeScript(modalBin, [
      "#!/bin/sh",
      "set -eu",
      `fixture=${fixture}`,
      'printf "%s\\n" "$*" >> "$fixture/modal.log"',
      "op=",
      "previous=",
      'for argument in "$@"; do',
      '  if [ "$previous" = --op ]; then op=$argument; break; fi',
      "  previous=$argument",
      "done",
      'if [ "$op" = check ]; then',
      "  echo 'BEAM_MODAL_JSON:{\"ok\":true}'",
      "  exit 0",
      "fi",
      'if [ "$op" = destroy ]; then',
      "  echo 'BEAM_MODAL_JSON:{\"deleted\":true}'",
      "  exit 0",
      "fi",
      'sandbox_id=$(cat "$fixture/sandbox-id")',
      "printf 'BEAM_MODAL_JSON:{\"host\":\"tunnel.modal.test\",'",
      "printf '\"port\":2222,\"sandboxId\":\"%s\",' \"$sandbox_id\"",
      "echo '\"volumeOwned\":true}'",
    ]);
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
    savedBeamDir = process.env.BEAM_DIR;
    savedPath = process.env.PATH;
    process.env.BEAM_DIR = join(root, "beam-home");
    process.env.PATH = `${binDir}:${savedPath ?? ""}`;
  });

  beforeEach(() => {
    for (const name of ["modal.log", "ssh.log", "rsync.log"]) {
      rmSync(join(root, name), { force: true });
    }
    rmSync(join(root, "beam-home"), { force: true, recursive: true });
    writeFileSync(join(root, "sandbox-id"), SANDBOX_ID);
  });

  afterAll(() => {
    if (savedBeamDir === undefined) delete process.env.BEAM_DIR;
    else process.env.BEAM_DIR = savedBeamDir;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(root, { force: true, recursive: true });
  });

  test(
    "journals Volume ownership and compute bootstrap before returning SSH",
    async () => {
      const provider = new ModalProvider(
        {
          type: "modal",
          app: "beam-test",
          image: "ghcr.io/example/coding@sha256:fixture",
          timeoutSeconds: 7200,
        },
        modalBin,
      );
      const ref: { id: string; sandbox?: SandboxState } = { id: "fresh1" };
      const published: SandboxState[] = [];
      const transport = await provider.provision(ref, (state) => published.push(state));
      await transport.syncUp(root, "~/beam/fixture");

      const state = modalState(ref.sandbox);
      expect(state.volumeOwned).toBe(true);
      expect(state.bootstrappedSandboxId).toBe(SANDBOX_ID);
      expect(state.sshKeySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(published).toHaveLength(4);
      const modalLog = readFileSync(join(root, "modal.log"), "utf8");
      expect(modalLog).toContain("--allow-initialize true");
      expect(modalLog).toContain("--app-name beam-test");
      expect(modalLog).toContain("--image-name ghcr.io/example/coding@sha256:fixture");
      expect(modalLog).toContain("--timeout-seconds 7200");
      const sshLog = readFileSync(join(root, "ssh.log"), "utf8");
      expect(sshLog).toContain("-p 2222");
      expect(sshLog).toContain(`HostKeyAlias=modal-${SANDBOX_ID}`);
      expect(sshLog).toContain("sha256sum -c -");
      expect(readFileSync(join(root, "rsync.log"), "utf8")).toContain(
        "root@tunnel.modal.test:./",
      );
      expect(transport.label).toBe(`Modal ${state.sandboxName}`);
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "reuses a bootstrapped compute and bootstraps a replacement id",
    async () => {
      const provider = new ModalProvider({ type: "modal" }, modalBin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "renew1" };
      await provider.provision(ref, (state) => {
        ref.sandbox = state;
      });
      rmSync(join(root, "ssh.log"), { force: true });

      await provider.connect(ref);
      expect(existsSync(join(root, "ssh.log"))).toBe(false);
      writeFileSync(join(root, "sandbox-id"), REPLACEMENT_ID);
      await provider.connect(ref);
      const sshLog = readFileSync(join(root, "ssh.log"), "utf8");
      expect(sshLog).toContain("sha256sum -c -");
      expect(sshLog).toContain(`HostKeyAlias=modal-${REPLACEMENT_ID}`);
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "deletes the owner-marked Volume and its local capability key",
    async () => {
      const provider = new ModalProvider({ type: "modal" }, modalBin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "purge1" };
      await provider.provision(ref, (state) => {
        ref.sandbox = state;
      });
      const state = modalState(ref.sandbox);
      const keyPath = join(
        root,
        "beam-home",
        "keys",
        `modal-${state.ownerToken}.ed25519`,
      );
      expect(existsSync(keyPath)).toBe(true);

      await provider.destroyAfterVerifiedCleanupWithoutConnection(ref);
      expect(existsSync(keyPath)).toBe(false);
      const modalLog = readFileSync(join(root, "modal.log"), "utf8");
      expect(modalLog).toContain("--op destroy");
      expect(modalLog).toContain("--allow-unowned-cleanup false");
    },
    PROCESS_TIMEOUT_MS,
  );

  test("allows destroy-only cleanup for an initial unreceipted Volume", async () => {
    const provider = new ModalProvider({ type: "modal" }, modalBin);
    const ref: { id: string; sandbox?: SandboxState } = { id: "early1" };
    ref.sandbox = provider.sandboxState(ref);

    await provider.destroy(ref);
    expect(readFileSync(join(root, "modal.log"), "utf8")).toContain(
      "--allow-unowned-cleanup true",
    );
  });

  test("refuses persisted Modal names that do not derive from the owner token", () => {
    const provider = new ModalProvider({ type: "modal" }, modalBin);
    expect(() => provider.sandboxState({
      id: "wrong1",
      sandbox: {
        kind: "modal",
        ownerToken: "a".repeat(48),
        sandboxName: "foreign",
        volumeName: "foreign",
      },
    })).toThrow(/resource names do not match/);
  });

  test("check executes an authenticated bridge probe", async () => {
    const provider = new ModalProvider({ type: "modal" }, modalBin);
    const report = await provider.check();
    expect(report.fatal).toBeUndefined();
    expect(report.lines).toContain(
      "Modal account:       authenticated; token can manage Apps, Sandboxes, and Volumes",
    );
  });
});
