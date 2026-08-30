/**
 * Goal: Provider setup is a side-effect-free plan until explicit apply,
 * then creates the provider resource and merges Beam config idempotently.
 *
 * Method: A fake Box CLI records environment creation in a disposable
 * directory while the real CLI runs with isolated BEAM_HOME and BEAM_DIR.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
const CLI = resolve(import.meta.dir, "../src/cli.ts");

interface SetupDocument {
  ok: boolean;
  data?: {
    mode: string;
    actions: Array<{ id: string; status: string }>;
  };
  error?: { code: string };
}

function fixture(): { root: string; marker: string } {
  const root = mkdtempSync(join(tmpdir(), "beam-setup-"));
  roots.push(root);
  const marker = join(root, "box-environment");
  const box = join(root, "box");
  writeFileSync(
    box,
    [
      "#!/bin/sh",
      "set -eu",
      'if [ "$1" = limits ]; then echo "{}"; exit 0; fi',
      'if [ "$1 $2" = "env list" ]; then',
      `  if [ -f ${JSON.stringify(marker)} ]; then echo '[{"name":"beam"}]'; else echo '[]'; fi`,
      "  exit 0",
      "fi",
      'if [ "$1 $2" = "env new" ]; then',
      `  : > ${JSON.stringify(marker)}`,
      "  echo '{\"name\":\"beam\"}'",
      "  exit 0",
      "fi",
      'echo "unexpected box args: $*" >&2',
      "exit 2",
    ].join("\n") + "\n",
  );
  chmodSync(box, 0o755);
  return { root, marker };
}

async function runSetup(root: string, args: string[]): Promise<{
  code: number;
  document: SetupDocument;
}> {
  const child = Bun.spawn([process.execPath, CLI, "setup", "box", ...args, "--json"], {
    cwd: root,
    env: {
      ...process.env,
      BEAM_HOME: root,
      BEAM_DIR: join(root, ".beam-state"),
      PATH: `${root}:${process.env.PATH ?? ""}`,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  return { code, document: JSON.parse(stdout) as SetupDocument };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("beam setup", () => {
  test("plan has no side effects; apply creates and verifies once", async () => {
    const { root, marker } = fixture();
    const planned = await runSetup(root, []);
    expect(planned.code).toBe(0);
    expect(planned.document.data?.mode).toBe("plan");
    expect(
      planned.document.data?.actions.some(
        (action) => action.id === "provider.resource" && action.status === "planned",
      ),
    ).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, ".beam-state", "config.json"))).toBe(false);

    const applied = await runSetup(root, ["--apply", "--yes"]);
    expect(applied.code).toBe(0);
    expect(applied.document.data?.mode).toBe("applied");
    expect(existsSync(marker)).toBe(true);
    const config = JSON.parse(
      readFileSync(join(root, ".beam-state", "config.json"), "utf8"),
    ) as unknown;
    expect(config).toEqual({
      defaultTarget: "box",
      targets: { box: { type: "box", environment: "beam" } },
    });

    const repeated = await runSetup(root, ["--apply", "--yes"]);
    expect(repeated.code).toBe(0);
    expect(
      repeated.document.data?.actions.some(
        (action) => action.id === "provider.resource" && action.status === "passed",
      ),
    ).toBe(true);
  });

  test("apply without approval refuses before creating anything", async () => {
    const { root, marker } = fixture();
    const refused = await runSetup(root, ["--apply"]);
    expect(refused.code).toBe(1);
    expect(refused.document.error?.code).toBe("confirmation_required");
    expect(existsSync(marker)).toBe(false);
  });
});
