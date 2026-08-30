/**
 * Goal: Beam installs and removes its agent skill idempotently without
 * overwriting a foreign skill unless the caller explicitly approves it.
 *
 * Method: Run the real CLI against disposable project-scope roots and
 * inspect the exact files and structured result after each lifecycle step.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BEAM_SKILL } from "../src/skill-content.ts";

const roots: string[] = [];
const CLI = resolve(import.meta.dir, "../src/cli.ts");

interface CliResult {
  code: number;
  document: {
    ok: boolean;
    data?: { changes: Array<{ status: string }> };
    error?: { code: string };
  };
}

async function runSkill(root: string, args: string[]): Promise<CliResult> {
  const child = Bun.spawn(["bun", CLI, "skill", ...args, "--json"], {
    cwd: root,
    env: { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  return { code, document: JSON.parse(stdout) as CliResult["document"] };
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "beam-skill-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("beam skill", () => {
  test("install is exact and idempotent, then remove is idempotent", async () => {
    const root = fixture();
    const args = ["install", "--tool", "omp", "--scope", "project"];
    const installed = await runSkill(root, args);
    expect(installed.code).toBe(0);
    expect(installed.document.data?.changes[0]?.status).toBe("installed");
    const path = join(root, ".omp", "skills", "beam", "SKILL.md");
    expect(readFileSync(path, "utf8")).toBe(BEAM_SKILL);

    const unchanged = await runSkill(root, args);
    expect(unchanged.document.data?.changes[0]?.status).toBe("unchanged");
    const removed = await runSkill(root, ["remove", "--tool", "omp", "--scope", "project"]);
    expect(removed.document.data?.changes[0]?.status).toBe("removed");
    const absent = await runSkill(root, ["remove", "--tool", "omp", "--scope", "project"]);
    expect(absent.document.data?.changes[0]?.status).toBe("absent");
  });

  test("a foreign skill blocks installation until replace is explicit", async () => {
    const root = fixture();
    const directory = join(root, ".omp", "skills", "beam");
    const path = join(directory, "SKILL.md");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, "foreign skill\n");
    const args = ["install", "--tool", "omp", "--scope", "project"];
    const refused = await runSkill(root, args);
    expect(refused.code).toBe(1);
    expect(refused.document.error?.code).toBe("skill_conflict");
    expect(readFileSync(path, "utf8")).toBe("foreign skill\n");

    const replaced = await runSkill(root, [...args, "--replace"]);
    expect(replaced.code).toBe(0);
    expect(replaced.document.data?.changes[0]?.status).toBe("updated");
    expect(readFileSync(path, "utf8")).toBe(BEAM_SKILL);
  });

  test("the repository package matches the embedded standalone skill", () => {
    const packaged = readFileSync(resolve(import.meta.dir, "../skills/beam/SKILL.md"), "utf8");
    expect(packaged).toBe(BEAM_SKILL);
  });
});
