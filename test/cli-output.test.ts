/**
 * Goal: Beam exposes one stable JSON document for headless callers and keeps
 * interactive commands out of that contract.
 *
 * Method: Spawn the real CLI for help, docs, and an interactive refusal;
 * parse stdout as one document and assert the public envelope and exit code.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliRun> {
  const child = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("CLI machine-readable output", () => {
  test("help is one versioned JSON document with command metadata", async () => {
    const result = await runCli(["--json", "help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("\u001b[");
    const document = JSON.parse(result.stdout) as {
      schemaVersion: number;
      ok: boolean;
      command: string;
      data: Record<string, unknown>;
    };
    expect(document.schemaVersion).toBe(1);
    expect(document.ok).toBe(true);
    expect(document.command).toBe("help");
    expect(document.data.check).toBeDefined();
    expect(document.data.doctor).toBeUndefined();
  });

  test("agent docs return executable steps and invariants", async () => {
    const result = await runCli(["docs", "agent", "--json"]);
    expect(result.code).toBe(0);
    const document = JSON.parse(result.stdout) as {
      ok: boolean;
      data: { steps: string[]; invariants: string[] };
    };
    expect(document.ok).toBe(true);
    expect(document.data.steps.some((step) => step.includes("beam check --json"))).toBe(true);
    expect(document.data.invariants.length).toBeGreaterThan(0);
  });

  test("human docs without a topic list the available manuals", async () => {
    const result = await runCli(["docs"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Beam operational topics:");
    expect(result.stdout).toContain("agent");
    expect(result.stdout).toContain("return");
  });

  test("interactive commands return a typed refusal without terminal output", async () => {
    const result = await runCli(["attach", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    const document = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { code: string; details: { nextCommand: string } };
    };
    expect(document.ok).toBe(false);
    expect(document.error.code).toBe("interactive_required");
    expect(document.error.details.nextCommand).toBe("beam attach");
  });

  test("human help presents check and omits the retired doctor command", async () => {
    const result = await runCli(["help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("beam check");
    expect(result.stdout).toContain("━━━ beam ai");
    expect(result.stdout).toContain("your coding agent keeps moving");
    expect(result.stdout).not.toContain("doctor");
  });
});
