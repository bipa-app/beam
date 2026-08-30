/**
 * Goal: prove the Box provider's durable-identity, lifecycle, and SSH
 * contracts without using a paid external sandbox.
 *
 * Method: a canned `box` CLI emits the documented JSONL protocol and stores
 * VM state in a temp directory; canned ssh/rsync binaries record argv. The
 * provider therefore exercises real Bun process streaming, persistence
 * timing, resume/delete convergence, and SSH option construction while all
 * state stays hermetic.
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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BoxProvider } from "../src/provider/box.ts";
import type { SandboxState } from "../src/provider/types.ts";
import { shq } from "../src/util/shell.ts";

const PROCESS_TIMEOUT_MS = 30_000;
const BOX_ID = "bx_fixture1";

function writeScript(path: string, lines: string[]): void {
  writeFileSync(path, lines.join("\n") + "\n");
  chmodSync(path, 0o755);
}

describe("Box provider lifecycle", () => {
  let root: string;
  let binDir: string;
  let boxBin: string;
  let savedPath: string | undefined;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "beam-box-provider-"));
    binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fixture = shq(root);
    boxBin = join(binDir, "box");
    writeScript(boxBin, [
      "#!/bin/sh",
      "set -eu",
      `fixture=${fixture}`,
      'printf "%s\\n" "$*" >> "$fixture/box.log"',
      'mode=$(cat "$fixture/mode")',
      'case "$1" in',
      "  new)",
      `    printf '{"event":"created","id":"${BOX_ID}","ttlSeconds":7200}\\n'`,
      '    touch "$fixture/present"',
      '    if [ "$mode" = fail-after-created ]; then',
      `      echo '{"event":"error","error":"fixture failure","code":"fixture"}'`,
      "      exit 9",
      "    fi",
      '    printf "%s" ready > "$fixture/state"',
      '    if [ "$mode" = invalid-ip ]; then ip=not-an-ip; else ip=203.0.113.10; fi',
      `    printf '{"event":"ready","id":"${BOX_ID}","state":"ready","ip":"%s"}\\n' "$ip"`,
      "    ;;",
      "  info)",
      '    if [ ! -f "$fixture/present" ]; then',
      `      echo '{"event":"error","error":"not found","code":"not_found"}'`,
      "      exit 1",
      "    fi",
      '    state=$(cat "$fixture/state")',
      `    printf '{"box":{"id":"${BOX_ID}","state":"%s","ip":"203.0.113.10"}}\\n' "$state"`,
      "    ;;",
      "  resume)",
      '    printf "%s" ready > "$fixture/state"',
      `    printf '{"event":"action","id":"${BOX_ID}","action":"resume"}\\n'`,
      "    ;;",
      "  delete)",
      '    rm -f "$fixture/present" "$fixture/state"',
      `    printf '{"event":"deleted","id":"${BOX_ID}"}\\n'`,
      "    ;;",
      "  ssh)",
      "    ;;",
      "  limits)",
      `    echo '{"limits":{"maxBoxes":1}}'`,
      "    ;;",
      "  *)",
      '    printf "unexpected command: %s\\n" "$1" >&2',
      "    exit 2",
      "    ;;",
      "esac",
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
    savedPath = process.env.PATH;
    process.env.PATH = `${binDir}:${savedPath ?? ""}`;
  });

  beforeEach(() => {
    for (const name of ["box.log", "ssh.log", "rsync.log", "present", "state"]) {
      rmSync(join(root, name), { force: true });
    }
    writeFileSync(join(root, "mode"), "normal");
  });

  afterAll(() => {
    process.env.PATH = savedPath;
    rmSync(root, { force: true, recursive: true });
  });

  test(
    "persists the created Box id before a later provisioning failure",
    async () => {
      writeFileSync(join(root, "mode"), "fail-after-created");
      const provider = new BoxProvider({ type: "box" }, boxBin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "early" };
      const published: SandboxState[] = [];

      await expect(provider.provision(ref, (state) => published.push(state))).rejects.toThrow(
        /Box creation failed.*fixture failure/,
      );
      expect(ref.sandbox).toEqual({ kind: "box", boxId: BOX_ID });
      expect(published).toEqual([{ kind: "box", boxId: BOX_ID }]);
      expect(existsSync(join(root, "ssh.log"))).toBe(false);
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "creates a no-auto-stop Box, authorizes its key, and bootstraps herdr over pinned SSH argv",
    async () => {
      const provider = new BoxProvider({ type: "box" }, boxBin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "fresh" };
      const published: SandboxState[] = [];
      const transport = await provider.provision(ref, (state) => published.push(state));
      await transport.syncUp(root, "~/beam/fixture");

      expect(published).toEqual([{ kind: "box", boxId: BOX_ID }]);
      expect(readFileSync(join(root, "box.log"), "utf8")).toContain(
        "new --no-auto-stop --json",
      );
      expect(readFileSync(join(root, "box.log"), "utf8")).toContain(
        `ssh ${BOX_ID} -- true`,
      );
      const sshLog = readFileSync(join(root, "ssh.log"), "utf8");
      expect(sshLog).toContain(join(homedir(), ".ssh", "ascii_box_ed25519"));
      expect(sshLog).toContain(`HostKeyAlias=${BOX_ID}`);
      expect(sshLog).toContain("StrictHostKeyChecking=accept-new");
      expect(sshLog).toContain("sha256sum -c -");
      expect(sshLog).toContain("/usr/local/bin/herdr");
      const rsyncLog = readFileSync(join(root, "rsync.log"), "utf8");
      expect(rsyncLog).toContain("--rsh=");
      expect(rsyncLog).toContain(`HostKeyAlias=${BOX_ID}`);
      expect(rsyncLog).toContain("user@203.0.113.10:./");
      expect(transport.label).toBe(`box ${BOX_ID}`);
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "passes explicit environment, size, and TTL through create and resume",
    async () => {
      const provider = new BoxProvider(
        { type: "box", environment: "beam", machineType: "small", ttlSeconds: 7200 },
        boxBin,
      );
      const ref: { id: string; sandbox?: SandboxState } = { id: "trial" };
      await provider.provision(ref);
      writeFileSync(join(root, "state"), "stopped");
      await provider.connect(ref);

      const log = readFileSync(join(root, "box.log"), "utf8");
      expect(log).toContain("new --type small --environment=beam --ttl 7200 --json");
      expect(log).toContain(`resume ${BOX_ID} --ttl 7200 --json`);
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "deletes only the persisted Box and treats a later absence as converged",
    async () => {
      const provider = new BoxProvider({ type: "box" }, boxBin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "purge" };
      await provider.provision(ref);

      await provider.destroyAfterVerifiedCleanupWithoutConnection(ref);
      expect(existsSync(join(root, "present"))).toBe(false);
      await provider.destroy(ref);
      const deletes = readFileSync(join(root, "box.log"), "utf8")
        .split("\n")
        .filter((line) => line.startsWith("delete "));
      expect(deletes).toEqual([`delete ${BOX_ID} --yes --json`]);
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "rejects a malformed ready address after retaining the created identity",
    async () => {
      writeFileSync(join(root, "mode"), "invalid-ip");
      const provider = new BoxProvider({ type: "box" }, boxBin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "bad-ip" };

      await expect(provider.provision(ref)).rejects.toThrow(/no usable IPv4 address/);
      expect(ref.sandbox).toEqual({ kind: "box", boxId: BOX_ID });
      expect(existsSync(join(root, "ssh.log"))).toBe(false);
    },
    PROCESS_TIMEOUT_MS,
  );

  test("rejects another provider's persisted identity before invoking Box", () => {
    const provider = new BoxProvider({ type: "box" }, boxBin);
    expect(() => provider.sandboxState({
      id: "foreign",
      sandbox: {
        claim: "beam-foreign",
        context: "cluster",
        namespace: "sandboxes",
        container: "sandbox",
      },
    })).toThrow(/stores an Agent Sandbox identity/);
    expect(existsSync(join(root, "box.log"))).toBe(false);
  });

  test("check verifies the CLI account and local data-plane tools", async () => {
    const provider = new BoxProvider({ type: "box" }, boxBin);
    const report = await provider.check();
    expect(report.fatal).toBeUndefined();
    expect(report.lines).toContain("Box account: authenticated and able to read limits");
  });
});
