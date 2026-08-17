/**
 * Goal: `probePrivilege` flags dangerous remote postures — root login,
 * passwordless sudo, a root-owned home, sudo tokens, a reachable docker
 * socket — with actionable warnings from ONE fused script exec, and its
 * sentinel parser's trust boundary fails closed on hostile, truncated, or
 * forged output instead of reporting a benign posture.
 *
 * Method: a canned Transport double returns hand-built fused streams for
 * the single exec (root/sudo postures cannot be reproduced hermetically
 * with a real shell in CI, and hostile output can only be exercised with
 * hand-built frames); `parseProbeRecords` is driven directly as a pure
 * function, and one probe runs through real bash via LocalTransport.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProbeRecords, PRIVILEGE_SENTINEL, probePrivilege } from "../src/security.ts";
import { LocalTransport } from "../src/transport/local.ts";
import type { ExecResult, SyncOptions, Transport } from "../src/transport/types.ts";

/**
 * probePrivilege issues ONE fused script exec and parses sentinel records
 * out of its stdout. The double below returns a canned stdout for that
 * single exec: postures (root login, passwordless sudo) cannot be
 * reproduced hermetically with a real shell in CI, and the parser's trust
 * boundary (hostile/truncated output) can only be exercised with
 * hand-built streams.
 */
class FusedTransport implements Transport {
  readonly label = "canned";
  execCount = 0;
  constructor(private readonly result: ExecResult) {}

  async exec(_command: string): Promise<ExecResult> {
    this.execCount++;
    return this.result;
  }

  async execChecked(): Promise<string> {
    throw new Error("not used by probePrivilege");
  }
  async syncUp(_l: string, _r: string, _o?: SyncOptions): Promise<void> {}
  async syncDown(_r: string, _l: string, _o?: SyncOptions): Promise<void> {}
  async exists(): Promise<boolean> {
    return false;
  }
  interactiveArgv(command: string): string[] {
    return ["true", command];
  }
}

type Rec = [key: string, code: number, value: string];

function recordLine(sentinel: string, [key, code, value]: Rec): string {
  return `${sentinel} ${key} ${code} ${Buffer.byteLength(value, "utf8")} ${value}`;
}

function fused(records: Rec[], trailerCount = records.length): string {
  const lines = records.map((r) => recordLine(PRIVILEGE_SENTINEL, r));
  lines.push(`${PRIVILEGE_SENTINEL} end ${trailerCount}`);
  return lines.join("\n") + "\n";
}

/** Benign non-root posture; tests override individual probes. */
const BASE: readonly Rec[] = [
  ["user", 0, "agent"],
  ["sudo", 1, ""],
  ["home", 0, "/home/agent"],
  ["passwd", 0, "1"],
  ["satoken", 1, ""],
  ["dockersock", 1, ""],
];

function posture(over: Record<string, [code: number, value: string]> = {}): Rec[] {
  return BASE.map(([k, c, v]): Rec => {
    const o = over[k];
    return o === undefined ? [k, c, v] : [k, o[0], o[1]];
  });
}

function cannedProbe(stdout: string): FusedTransport {
  return new FusedTransport({ code: 0, stdout, stderr: "" });
}

describe("privilege probes", () => {
  test("the whole battery is exactly one transport exec", async () => {
    const t = cannedProbe(fused(posture()));
    await probePrivilege(t, "/home/agent/beam/ws");
    expect(t.execCount).toBe(1);
  });

  test("root login is flagged and sudo is not double-reported", async () => {
    // sudo answers 0 too: the root warning must still be the only one.
    const t = cannedProbe(fused(posture({ user: [0, "root"], sudo: [0, ""], home: [0, "/root"] })));
    const report = await probePrivilege(t, "/root/beam/ws-1234");
    expect(report.user).toBe("root");
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toMatch(/root/);
  });

  test("passwordless sudo is flagged for non-root users", async () => {
    const t = cannedProbe(fused(posture({ sudo: [0, ""] })));
    const report = await probePrivilege(t, "/home/agent/beam/ws");
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toMatch(/passwordless sudo/);
  });

  test("workspace root outside the user's home is flagged when tenancy is unprovable", async () => {
    // passwd probe unanswerable (nonzero code): beam assumes a shared box.
    const t = cannedProbe(fused(posture({ passwd: [1, ""] })));
    const report = await probePrivilege(t, "/srv/shared/beam");
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toMatch(/outside the target user's home/);
  });

  test("an observably single-tenant box suppresses the outside-home warning", async () => {
    // BSD wc pads its count with spaces; the parser must tolerate that.
    const t = cannedProbe(fused(posture({ passwd: [0, "       1"] })));
    const report = await probePrivilege(t, "/data/beam/ws");
    expect(report.warnings).toEqual([]);
  });

  test("a second human user makes the box shared — outside-home warning stays", async () => {
    const t = cannedProbe(fused(posture({ passwd: [0, "2"] })));
    const report = await probePrivilege(t, "/data/beam/ws");
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toMatch(/outside the target user's home/);
  });

  test("a malformed human count fails toward the shared-box warning", async () => {
    const t = cannedProbe(fused(posture({ passwd: [0, "not-a-number"] })));
    const report = await probePrivilege(t, "/data/beam/ws");
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toMatch(/outside the target user's home/);
  });

  test("an empty home skips the outside-home tenancy check entirely", async () => {
    const t = cannedProbe(fused(posture({ home: [0, ""], passwd: [0, "5"] })));
    const report = await probePrivilege(t, "/data/beam/ws");
    expect(report.warnings).toEqual([]);
  });

  test("a mounted ServiceAccount token and Docker socket are flagged", async () => {
    const t = cannedProbe(fused(posture({ satoken: [0, ""], dockersock: [0, ""] })));
    const report = await probePrivilege(t, "/home/agent/beam/ws");
    expect(report.warnings.length).toBe(2);
    expect(report.warnings.some((w) => w.includes("ServiceAccount token"))).toBe(true);
    expect(report.warnings.some((w) => w.includes("docker.sock"))).toBe(true);
  });

  test("login-shell banner noise around the records is ignored", async () => {
    const stdout = "Welcome to the box!\nmotd line two\n" + fused(posture()) + "trailing noise\n";
    const report = await probePrivilege(cannedProbe(stdout), "/home/agent/beam/ws");
    expect(report.user).toBe("agent");
    expect(report.warnings).toEqual([]);
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

describe("privilege probe trust boundary (fails closed)", () => {
  const cases: Array<[name: string, stdout: string]> = [
    [
      "missing end trailer (truncation)",
      posture().map((r) => recordLine(PRIVILEGE_SENTINEL, r)).join("\n") + "\n",
    ],
    ["trailer count mismatch", fused(posture(), 5)],
    ["duplicate record", fused([...posture(), ["user", 0, "agent"]], 7)],
    [
      "value byte-length mismatch",
      [`${PRIVILEGE_SENTINEL} user 0 99 agent`, ...fused(posture().slice(1), 6).split("\n")].join(
        "\n",
      ),
    ],
    [
      "records after the trailer",
      fused(posture()) + recordLine(PRIVILEGE_SENTINEL, ["late", 0, ""]) + "\n",
    ],
    ["missing probe with a consistent trailer", fused(posture().slice(0, 5))],
    [
      "an unexpected key displacing a required one",
      fused([...posture().slice(0, 5), ["bogus", 0, ""]]),
    ],
    ["exit code out of range", fused([...posture().slice(1), ["user", 999, "agent"]])],
    ["garbage on a sentinel line", `${PRIVILEGE_SENTINEL} !!!\n` + fused(posture())],
  ];
  for (const [name, stdout] of cases) {
    test(name, async () => {
      await expect(probePrivilege(cannedProbe(stdout), "/home/agent/beam/ws")).rejects.toThrow(
        /refusing/,
      );
    });
  }

  test("a failing probe script never degrades into a report", async () => {
    const t = new FusedTransport({ code: 1, stdout: "", stderr: "bash: boom" });
    await expect(probePrivilege(t, "/home/agent/beam/ws")).rejects.toThrow(
      /privilege probe script failed \(1\)/,
    );
  });
});

describe("parseProbeRecords", () => {
  test("multibyte values validate against UTF-8 byte length, not characters", () => {
    const line = `__t__ k 0 ${Buffer.byteLength("café", "utf8")} café\n__t__ end 1\n`;
    const records = parseProbeRecords("__t__", line);
    expect(records.get("k")).toEqual({ code: 0, value: "café" });
    // Character count (4) instead of byte count (5) must be rejected.
    const wrongBytes = "__t__ k 0 4 café\n__t__ end 1\n";
    expect(() => parseProbeRecords("__t__", wrongBytes)).toThrow(/refusing/);
  });
});
