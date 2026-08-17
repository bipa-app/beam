/**
 * Goal: `beam doctor`'s remote checks run as ONE fused script per battery
 * whose sentinel-framed stdout parses into per-probe verdicts — privilege
 * postures and adapter auth probes surface as WARNING/MISSING lines with
 * their remedies, the remote round-trip count stays constant across the
 * adapter roster and probe outcomes, and truncated or hostile frames fail
 * closed instead of manufacturing a clean bill of health.
 *
 * Method: a counting Transport double returns canned fused stdout routed
 * by the sentinel embedded in each script (postures cannot be reproduced
 * hermetically with a real shell in CI); one suite runs the generated
 * scripts end to end through real bash behind a counting LocalTransport
 * wrapper, all inside mkdtemp fixture homes.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCTOR_SENTINEL, doctorRemoteChecks } from "../src/commands/misc.ts";
import { PRIVILEGE_SENTINEL } from "../src/security.ts";
import { ADAPTERS } from "../src/session/index.ts";
import { LocalTransport } from "../src/transport/local.ts";
import type { ExecResult, SyncOptions, Transport } from "../src/transport/types.ts";

type Rec = [key: string, code: number, value: string];

function fused(sentinel: string, records: Rec[]): string {
  const lines = records.map(
    ([key, code, value]) =>
      `${sentinel} ${key} ${code} ${Buffer.byteLength(value, "utf8")} ${value}`,
  );
  lines.push(`${sentinel} end ${records.length}`);
  return lines.join("\n") + "\n";
}

/** Benign privilege posture: probePrivilege reports no warnings. */
const BENIGN_PRIVILEGE: Rec[] = [
  ["user", 0, "agent"],
  ["sudo", 1, ""],
  ["home", 0, "/home/agent"],
  ["passwd", 0, "1"],
  ["satoken", 1, ""],
  ["dockersock", 1, ""],
];

/**
 * Counting double for the fused doctor flow. Each exec is routed by the
 * sentinel embedded in its script, so the test also proves doctor sends
 * exactly one script per battery — the count can never scale with the
 * adapter roster or probe outcomes.
 */
class CannedDoctorTransport implements Transport {
  readonly label = "canned";
  execCount = 0;
  privilegeCount = 0;
  constructor(
    private readonly doctor: ExecResult,
    private readonly privilege: ExecResult,
  ) {}

  async exec(command: string): Promise<ExecResult> {
    this.execCount++;
    if (command.includes(DOCTOR_SENTINEL)) return this.doctor;
    if (command.includes(PRIVILEGE_SENTINEL)) {
      this.privilegeCount++;
      return this.privilege;
    }
    throw new Error(`unexpected exec: ${command}`);
  }

  async execChecked(): Promise<string> {
    throw new Error("not used by doctor");
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

function canned(doctorRecords: Rec[], privilegeRecords: Rec[] = BENIGN_PRIVILEGE) {
  return new CannedDoctorTransport(
    { code: 0, stdout: fused(DOCTOR_SENTINEL, doctorRecords), stderr: "" },
    { code: 0, stdout: fused(PRIVILEGE_SENTINEL, privilegeRecords), stderr: "" },
  );
}

/**
 * Doctor records for a uniform adapter outcome. `installed` plants a
 * binary path per adapter; auth records appear if and only if the adapter
 * defines a probe and its binary resolved — the shape the parser demands.
 */
function doctorRecords(opts: { installed: boolean; authCode?: number; rootCode?: number }): Rec[] {
  const records: Rec[] = [
    ["tool.rsync", opts.installed ? 0 : 1, opts.installed ? "/usr/bin/rsync" : ""],
    ["tool.tmux", opts.installed ? 0 : 1, opts.installed ? "/usr/bin/tmux" : ""],
  ];
  for (const adapter of ADAPTERS) {
    records.push([
      `bin.${adapter.binary}`,
      opts.installed ? 0 : 1,
      opts.installed ? `/opt/${adapter.binary}` : "",
    ]);
    if (opts.installed && adapter.remoteAuthProbe) {
      records.push([`auth.${adapter.binary}`, opts.authCode ?? 0, ""]);
    }
  }
  const rootCode = opts.rootCode ?? 0;
  records.push(["root", rootCode, rootCode === 0 ? "/home/agent/beam" : ""]);
  return records;
}

async function captureLog<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = original;
  }
}

const pad = (b: string) => " ".repeat(Math.max(1, 6 - b.length));

describe("doctor remote checks (fused)", () => {
  test("exactly two execs — constant across adapter roster and probe outcomes", async () => {
    const everything = canned(doctorRecords({ installed: true }));
    await captureLog(() => doctorRemoteChecks(everything, "prod", "~/beam"));
    expect(everything.execCount).toBe(2);
    expect(everything.privilegeCount).toBe(1);

    // Nothing installed: same round-trip count, never one probe per tool.
    const nothing = canned(doctorRecords({ installed: false }));
    await captureLog(() => doctorRemoteChecks(nothing, "prod", "~/beam"));
    expect(nothing.execCount).toBe(2);
  });

  test("user-visible lines are preserved exactly (installed + authenticated)", async () => {
    const t = canned(doctorRecords({ installed: true }));
    const { value, lines } = await captureLog(() => doctorRemoteChecks(t, "prod", "~/beam"));
    expect(value).toBe(true);
    const expected = [
      "  connectivity: ok",
      "  remote rsync: /usr/bin/rsync",
      "  remote tmux:  /usr/bin/tmux",
      ...ADAPTERS.map(
        (a) =>
          `  remote ${a.binary}:${pad(a.binary)}/opt/${a.binary}` +
          (a.remoteAuthProbe ? " · authenticated" : ""),
      ),
      "  root:         /home/agent/beam",
      "  privilege:    ok (user agent, no dangerous posture)",
    ];
    expect(lines).toEqual(expected);
  });

  test("a failed auth probe points at beam login with the adapter's tool", async () => {
    const t = canned(doctorRecords({ installed: true, authCode: 1 }));
    const { lines } = await captureLog(() => doctorRemoteChecks(t, "prod", "~/beam"));
    for (const adapter of ADAPTERS) {
      const line = lines.find((l) => l.startsWith(`  remote ${adapter.binary}:`));
      if (adapter.remoteAuthProbe) {
        expect(line).toBe(
          `  remote ${adapter.binary}:${pad(adapter.binary)}/opt/${adapter.binary}` +
            ` · NOT LOGGED IN → beam login prod --tool ${adapter.tool}`,
        );
      } else {
        expect(line).toBe(
          `  remote ${adapter.binary}:${pad(adapter.binary)}/opt/${adapter.binary}`,
        );
      }
    }
  });

  test("missing tools and harnesses render MISSING / not installed", async () => {
    const t = canned(doctorRecords({ installed: false }));
    const { lines } = await captureLog(() => doctorRemoteChecks(t, "prod", "~/beam"));
    expect(lines).toContain("  remote rsync: MISSING");
    expect(lines).toContain("  remote tmux:  MISSING");
    for (const adapter of ADAPTERS) {
      expect(lines).toContain(`  remote ${adapter.binary}:${pad(adapter.binary)}not installed`);
    }
  });

  test("a failed root probe reports it and skips the privilege battery", async () => {
    const t = canned(doctorRecords({ installed: true, rootCode: 1 }));
    const { value, lines } = await captureLog(() => doctorRemoteChecks(t, "prod", "~/beam"));
    expect(value).toBe(true);
    expect(lines).toContain("  root:         cannot create ~/beam");
    expect(lines.some((l) => l.startsWith("  privilege:"))).toBe(false);
    expect(t.execCount).toBe(1);
  });

  test("privilege warnings surface as WARNING lines", async () => {
    const posture = BENIGN_PRIVILEGE.map(
      ([k, c, v]): Rec => (k === "sudo" ? [k, 0, ""] : [k, c, v]),
    );
    const t = canned(doctorRecords({ installed: true }), posture);
    const { lines } = await captureLog(() => doctorRemoteChecks(t, "prod", "~/beam"));
    expect(
      lines.some((l) => l.startsWith("  privilege:    WARNING — ") && l.includes("sudo")),
    ).toBe(true);
  });

  test("a failing probe script reports connectivity FAILED with its stderr", async () => {
    const t = new CannedDoctorTransport(
      { code: 255, stdout: "", stderr: "ssh: connect refused\n" },
      { code: 0, stdout: "", stderr: "" },
    );
    const { value, lines } = await captureLog(() => doctorRemoteChecks(t, "prod", "~/beam"));
    expect(value).toBe(false);
    expect(lines).toEqual(["  connectivity: FAILED — ssh: connect refused"]);
    expect(t.execCount).toBe(1);
  });

  test("truncated probe output fails closed before any per-tool line", async () => {
    const whole = fused(DOCTOR_SENTINEL, doctorRecords({ installed: true }));
    const truncated = whole.slice(0, whole.lastIndexOf(`${DOCTOR_SENTINEL} end`));
    const t = new CannedDoctorTransport(
      { code: 0, stdout: truncated, stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    );
    const { value, lines } = await captureLog(() => doctorRemoteChecks(t, "prod", "~/beam"));
    expect(value).toBe(false);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/connectivity: FAILED — .*truncated.*refusing/);
    expect(t.execCount).toBe(1);
  });

  test("an auth record for an uninstalled harness is hostile — fails closed", async () => {
    const withProbe = ADAPTERS.find((a) => a.remoteAuthProbe !== undefined);
    if (withProbe === undefined) throw new Error("no adapter with a remote auth probe");
    const stray: Rec = [`auth.${withProbe.binary}`, 0, ""];
    const records = [...doctorRecords({ installed: false }), stray];
    const t = canned(records);
    const { value, lines } = await captureLog(() => doctorRemoteChecks(t, "prod", "~/beam"));
    expect(value).toBe(false);
    expect(lines[0]).toMatch(/connectivity: FAILED — .*unexpected record.*refusing/);
  });

  test("a missing auth record for an installed probing harness fails closed", async () => {
    const records = doctorRecords({ installed: true }).filter(([k]) => !k.startsWith("auth."));
    const t = canned(records);
    const { value, lines } = await captureLog(() => doctorRemoteChecks(t, "prod", "~/beam"));
    expect(value).toBe(false);
    expect(lines[0]).toMatch(/connectivity: FAILED — .*missing auth\..*refusing/);
  });

  test("the generated scripts run end to end over a real shell in two execs", async () => {
    const home = mkdtempSync(join(tmpdir(), "beam-doctor-"));
    const counting = new (class implements Transport {
      readonly label = "counting-local";
      execCount = 0;
      private readonly inner = new LocalTransport(home);
      async exec(command: string): Promise<ExecResult> {
        this.execCount++;
        return this.inner.exec(command);
      }
      async execChecked(command: string): Promise<string> {
        return this.inner.execChecked(command);
      }
      async syncUp(l: string, r: string, o?: SyncOptions): Promise<void> {
        return this.inner.syncUp(l, r, o);
      }
      async syncDown(r: string, l: string, o?: SyncOptions): Promise<void> {
        return this.inner.syncDown(r, l, o);
      }
      async exists(p: string): Promise<boolean> {
        return this.inner.exists(p);
      }
      interactiveArgv(command: string): string[] {
        return this.inner.interactiveArgv(command);
      }
    })();
    const { value, lines } = await captureLog(() =>
      doctorRemoteChecks(counting, "local", "~/beam/ws"),
    );
    expect(value).toBe(true);
    expect(counting.execCount).toBe(2);
    expect(lines[0]).toBe("  connectivity: ok");
    // Real bash created the root and pwd'd into it.
    const rootLine = lines.find((l) => l.startsWith("  root:"));
    expect(rootLine).toMatch(/beam\/ws$/);
    expect(lines.some((l) => l.startsWith("  privilege:"))).toBe(true);
  });
});
