/**
 * Goal: prove Daytona's reservation recovery, owner labels, lifecycle, and
 * ephemeral SSH-token transport without using a paid organization sandbox.
 *
 * Method: a canned Daytona CLI stores sandbox state in a fixture directory
 * and invokes whatever `ssh` is first on PATH, exactly like the real CLI.
 * Beam's capture shim therefore sees the issued argv before canned ssh/rsync
 * binaries record the resulting data-plane commands.
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
import { DaytonaProvider } from "../src/provider/daytona.ts";
import type { DaytonaSandboxState, SandboxState } from "../src/provider/types.ts";
import { shq } from "../src/util/shell.ts";

const PROCESS_TIMEOUT_MS = 30_000;
const SANDBOX_ID = "daytona_fixture_001";

function writeScript(path: string, lines: string[]): void {
  writeFileSync(path, lines.join("\n") + "\n");
  chmodSync(path, 0o755);
}

function daytonaState(value: SandboxState | undefined): DaytonaSandboxState {
  if (value?.kind !== "daytona") throw new Error("test expected Daytona state");
  return value;
}

function daytonaFixtureLines(fixture: string): string[] {
  return [
    "#!/bin/sh",
    "set -eu",
    `fixture=${fixture}`,
    'printf "%s\\n" "$*" >> "$fixture/daytona.log"',
    'case "$1" in',
    "  create)",
    "    shift",
    '    while [ "$#" -gt 0 ]; do',
    '      case "$1" in',
    '        --name) shift; printf "%s" "$1" > "$fixture/name" ;;',
    "        --label)",
    "          shift",
    '          case "$1" in',
    '            beam.owner=*) printf "%s" "${1#beam.owner=}" > "$fixture/owner" ;;',
    '            beam.record=*) printf "%s" "${1#beam.record=}" > "$fixture/record" ;;',
    "          esac",
    "          ;;",
    "      esac",
    "      shift",
    "    done",
    '    printf "%s" started > "$fixture/state"',
    '    touch "$fixture/present"',
    "    echo created",
    "    ;;",
    "  info)",
    '    if [ ! -f "$fixture/present" ]; then echo "not found" >&2; exit 1; fi',
    '    name=$(cat "$fixture/name")',
    '    owner=$(cat "$fixture/owner")',
    '    record=$(cat "$fixture/record")',
    '    state=$(cat "$fixture/state")',
    `    printf '{"id":"${SANDBOX_ID}","name":"%s","state":"%s",' "$name" "$state"`,
    '    printf \'"labels":{"beam.owner":"%s","beam.record":"%s"}}\\n\' "$owner" "$record"',
    "    ;;",
    "  start)",
    '    printf "%s" started > "$fixture/state"',
    "    echo started",
    "    ;;",
    "  delete)",
    '    rm -f "$fixture/present" "$fixture/name" "$fixture/owner" "$fixture/record"',
    '    rm -f "$fixture/state"',
    "    echo deleted",
    "    ;;",
    "  ssh)",
    '    if [ "$(cat "$fixture/mode")" = bad-ssh ]; then',
    "      ssh -o ProxyCommand=foreign token_fixture@ssh.daytona.test",
    "    else",
    "      ssh -p 2222 token_fixture@ssh.daytona.test",
    "    fi",
    "    ;;",
    "  list)",
    "    echo '{\"items\":[],\"nextCursor\":null}'",
    "    ;;",
    "  *) echo unexpected >&2; exit 2 ;;",
    "esac",
  ];
}

describe("Daytona provider lifecycle", () => {
  let root: string;
  let binDir: string;
  let daytonaBin: string;
  let savedPath: string | undefined;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "beam-daytona-provider-"));
    binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    daytonaBin = join(binDir, "daytona");
    const fixture = shq(root);
    writeScript(daytonaBin, daytonaFixtureLines(fixture));
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
    for (const name of [
      "daytona.log",
      "ssh.log",
      "rsync.log",
      "present",
      "name",
      "owner",
      "record",
      "state",
    ]) {
      rmSync(join(root, name), { force: true });
    }
    writeFileSync(join(root, "mode"), "normal");
  });

  afterAll(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(root, { force: true, recursive: true });
  });

  test(
    "creates, pins, bootstraps, and reaches Daytona through a captured token",
    async () => {
      const provider = new DaytonaProvider(
        { type: "daytona", snapshot: "beam-snapshot", target: "us" },
        daytonaBin,
      );
      const ref: { id: string; sandbox?: SandboxState } = { id: "fresh1" };
      const published: SandboxState[] = [];
      const transport = await provider.provision(ref, (state) => published.push(state));
      await transport.syncUp(root, "~/beam/fixture");

      const state = daytonaState(ref.sandbox);
      expect(state.sandboxId).toBe(SANDBOX_ID);
      expect(published).toHaveLength(2);
      const daytonaLog = readFileSync(join(root, "daytona.log"), "utf8");
      expect(daytonaLog).toContain("--auto-pause 0 --auto-archive 0 --auto-delete -1 --ttl 0");
      expect(daytonaLog).toContain("--snapshot beam-snapshot --target us");
      expect(daytonaLog).toContain(`ssh ${SANDBOX_ID} --expires 1440`);
      const sshLog = readFileSync(join(root, "ssh.log"), "utf8");
      expect(sshLog).toContain("-p 2222");
      expect(sshLog).toContain(`HostKeyAlias=daytona-${SANDBOX_ID}`);
      expect(sshLog).toContain("token_fixture@ssh.daytona.test");
      expect(sshLog).toContain("sha256sum -c -");
      expect(readFileSync(join(root, "rsync.log"), "utf8")).toContain(
        "token_fixture@ssh.daytona.test:./",
      );
      expect(transport.label).toBe(`Daytona ${state.sandboxName}`);
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "recovers one reserved owner-labelled sandbox without a duplicate create",
    async () => {
      const provider = new DaytonaProvider({ type: "daytona" }, daytonaBin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "retry1" };
      ref.sandbox = provider.sandboxState(ref);
      const state = daytonaState(ref.sandbox);
      writeFileSync(join(root, "name"), state.sandboxName);
      writeFileSync(join(root, "owner"), state.ownerToken);
      writeFileSync(join(root, "record"), ref.id);
      writeFileSync(join(root, "state"), "started");
      writeFileSync(join(root, "present"), "");
      const published: SandboxState[] = [];

      await provider.provision(ref, (next) => published.push(next));
      expect(daytonaState(ref.sandbox).sandboxId).toBe(SANDBOX_ID);
      expect(published).toHaveLength(1);
      const creates = readFileSync(join(root, "daytona.log"), "utf8")
        .split("\n")
        .filter((line) => line.startsWith("create "));
      expect(creates).toEqual([]);
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "starts a stopped sandbox and refreshes the SSH access token",
    async () => {
      const provider = new DaytonaProvider({ type: "daytona" }, daytonaBin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "stopd1" };
      await provider.provision(ref, (state) => {
        ref.sandbox = state;
      });
      writeFileSync(join(root, "state"), "stopped");
      rmSync(join(root, "daytona.log"), { force: true });

      await provider.connect(ref);
      const log = readFileSync(join(root, "daytona.log"), "utf8");
      expect(log).toContain(`start ${SANDBOX_ID}`);
      expect(log).toContain(`ssh ${SANDBOX_ID} --expires 1440`);
    },
    PROCESS_TIMEOUT_MS,
  );

  test("deletes only the persisted owner-labelled sandbox and converges", async () => {
    const provider = new DaytonaProvider({ type: "daytona" }, daytonaBin);
    const ref: { id: string; sandbox?: SandboxState } = { id: "purge1" };
    await provider.provision(ref, (state) => {
      ref.sandbox = state;
    });

    await provider.destroyAfterVerifiedCleanupWithoutConnection(ref);
    expect(existsSync(join(root, "present"))).toBe(false);
    await provider.destroy(ref);
    const deletes = readFileSync(join(root, "daytona.log"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("delete "));
    expect(deletes).toEqual([`delete ${SANDBOX_ID}`]);
  });

  test("refuses a same-id sandbox whose owner label changed", async () => {
    const provider = new DaytonaProvider({ type: "daytona" }, daytonaBin);
    const ref: { id: string; sandbox?: SandboxState } = { id: "guard1" };
    await provider.provision(ref, (state) => {
      ref.sandbox = state;
    });
    writeFileSync(join(root, "owner"), "0".repeat(48));

    await expect(provider.destroy(ref)).rejects.toThrow(/does not carry this handoff's owner/);
    expect(existsSync(join(root, "present"))).toBe(true);
  });

  test("rejects provider SSH arguments outside Daytona's documented shapes", async () => {
    const provider = new DaytonaProvider({ type: "daytona" }, daytonaBin);
    const ref: { id: string; sandbox?: SandboxState } = { id: "sshbad" };
    writeFileSync(join(root, "mode"), "bad-ssh");

    await expect(provider.provision(ref, (state) => {
      ref.sandbox = state;
    })).rejects.toThrow(/unsupported SSH argv shape/);
    expect(existsSync(join(root, "ssh.log"))).toBe(false);
  });

  test("check verifies the CLI account and local data-plane tools", async () => {
    const provider = new DaytonaProvider({ type: "daytona" }, daytonaBin);
    const report = await provider.check();
    expect(report.fatal).toBeUndefined();
    expect(report.lines).toContain(
      "Daytona account: authenticated; credential can manage organization sandboxes",
    );
  });
});
