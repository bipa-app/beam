import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probePrivilege } from "../src/security.ts";
import { LocalTransport } from "../src/transport/local.ts";
import type { ExecResult, SyncOptions, Transport } from "../src/transport/types.ts";

/**
 * Canned-exec transport double: probePrivilege only calls exec(), and these
 * postures (root login, passwordless sudo) cannot be reproduced hermetically
 * with a real shell in CI.
 */
class CannedTransport implements Transport {
  readonly label = "canned";
  constructor(private readonly responses: Record<string, ExecResult>) {}

  async exec(command: string): Promise<ExecResult> {
    for (const [needle, result] of Object.entries(this.responses)) {
      if (command.includes(needle)) return result;
    }
    return { code: 1, stdout: "", stderr: `no canned response for: ${command}` };
  }

  async execChecked(): Promise<string> {
    throw new Error("not used by probePrivilege");
  }
  async syncUp(_l: string, _r: string, _o?: SyncOptions): Promise<void> {}
  async syncDown(_r: string, _l: string, _o?: SyncOptions): Promise<void> {}
  async sendFile(): Promise<void> {}
  async fetchFile(): Promise<void> {}
  async exists(): Promise<boolean> {
    return false;
  }
  interactiveArgv(command: string): string[] {
    return ["true", command];
  }
}

const ok: ExecResult = { code: 0, stdout: "", stderr: "" };

describe("privilege probes", () => {
  test("root login is flagged and sudo is not double-reported", async () => {
    const t = new CannedTransport({
      whoami: { ...ok, stdout: "root\n" },
      "$HOME": { ...ok, stdout: "/root" },
    });
    const report = await probePrivilege(t, "/root/beam/ws-1234");
    expect(report.user).toBe("root");
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toMatch(/root/);
  });

  test("passwordless sudo is flagged for non-root users", async () => {
    const t = new CannedTransport({
      whoami: { ...ok, stdout: "beam-agent\n" },
      "sudo -n true": ok,
      "$HOME": { ...ok, stdout: "/home/beam-agent" },
    });
    const report = await probePrivilege(t, "/home/beam-agent/beam/ws");
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toMatch(/passwordless sudo/);
  });

  test("workspace root outside the user's home is flagged when tenancy is unprovable", async () => {
    const t = new CannedTransport({
      whoami: { ...ok, stdout: "beam-agent\n" },
      "sudo -n true": { code: 1, stdout: "", stderr: "" },
      "$HOME": { ...ok, stdout: "/home/beam-agent" },
      // no passwd response: the probe fails, so beam assumes a shared box
    });
    const report = await probePrivilege(t, "/srv/shared/beam");
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toMatch(/outside the target user's home/);
  });

  test("an observably single-tenant box suppresses the outside-home warning", async () => {
    const t = new CannedTransport({
      whoami: { ...ok, stdout: "agent\n" },
      "sudo -n true": { code: 1, stdout: "", stderr: "" },
      "$HOME": { ...ok, stdout: "/home/agent" },
      passwd: { ...ok, stdout: "root:x:0:0::/root:/bin/sh\nagent:x:1000:1000::/home/agent:/bin/bash\n" },
    });
    const report = await probePrivilege(t, "/data/bipa/ws");
    expect(report.warnings).toEqual([]);
  });

  test("a second human user makes the box shared — outside-home warning stays", async () => {
    const t = new CannedTransport({
      whoami: { ...ok, stdout: "agent\n" },
      "sudo -n true": { code: 1, stdout: "", stderr: "" },
      "$HOME": { ...ok, stdout: "/home/agent" },
      passwd: {
        ...ok,
        stdout:
          "root:x:0:0::/root:/bin/sh\nagent:x:1000:1000::/home/agent:/bin/bash\nother:x:1001:1001::/home/other:/bin/bash\n",
      },
    });
    const report = await probePrivilege(t, "/data/bipa/ws");
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toMatch(/outside the target user's home/);
  });

  test("a mounted ServiceAccount token and Docker socket are flagged", async () => {
    const t = new CannedTransport({
      whoami: { ...ok, stdout: "agent\n" },
      "sudo -n true": { code: 1, stdout: "", stderr: "" },
      "$HOME": { ...ok, stdout: "/home/agent" },
      "serviceaccount/token": ok,
      "docker.sock": ok,
    });
    const report = await probePrivilege(t, "/home/agent/beam/ws");
    expect(report.warnings.length).toBe(2);
    expect(report.warnings.some((w) => w.includes("ServiceAccount token"))).toBe(true);
    expect(report.warnings.some((w) => w.includes("docker.sock"))).toBe(true);
  });

  test("a hardened posture over a real shell yields no warnings", async () => {
    const home = mkdtempSync(join(tmpdir(), "beam-sec-"));
    // Real bash via LocalTransport: whoami is the CI user (never root in CI),
    // HOME is overridden to the fixture, and the root sits under it. sudo, a
    // host Docker socket, or a mounted SA token are properties of the machine
    // running the tests, not of the fixture posture under test — filter them.
    const report = await probePrivilege(new LocalTransport(home), join(home, "beam", "ws"));
    const relevant = report.warnings.filter(
      (w) => !w.includes("sudo") && !w.includes("docker.sock") && !w.includes("ServiceAccount"),
    );
    expect(report.user).not.toBe("");
    expect(relevant).toEqual([]);
  });
});
