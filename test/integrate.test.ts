/**
 * Goal: Prove verified returns reach the live workspace only after preview
 * and drift guards.
 *
 * Method: Build private return receipts, drive the real CLI, and inspect the
 * resulting files.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BeamEnv } from "../src/env.ts";
import { addRecord, type BeamRecord } from "../src/state.ts";
import { fileSha256 } from "../src/util/digest.ts";
import {
  createReturnStage,
  stageWorkspaceShip,
  stagedWorkspaceTreeFingerprint,
  workspaceReturnFingerprint,
  writeReturnStageManifest,
} from "../src/workspace.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const roots: string[] = [];

type Fixture = {
  env: BeamEnv;
  id: string;
  local: string;
  stage: string;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function makeFixture(options: {
  localFiles: Record<string, string>;
  remoteFiles: Record<string, string>;
  excludes?: string[];
  mirrorDeletes?: boolean;
}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "beam-integrate-test-"));
  roots.push(root);
  const env = { home: join(root, "home"), beamDir: join(root, "beam") };
  const local = join(root, "workspace");
  mkdirSync(local, { recursive: true });
  writeFiles(local, options.localFiles);
  const excludes = options.excludes ?? [];
  const localStage = await stageWorkspaceShip(local, excludes, false);
  const workspaceDigest = stagedWorkspaceTreeFingerprint(localStage.dir).digest;
  localStage.dispose();

  const id = "return1";
  const returned = createReturnStage(env.beamDir, id);
  writeFiles(returned.workspace, options.remoteFiles);
  const fingerprint = workspaceReturnFingerprint(returned.workspace);
  const remoteCwd = "/remote/workspace";
  const manifestFile = writeReturnStageManifest(returned.root, {
    recordId: id,
    localCwd: local,
    remoteCwd,
    fingerprint,
    baseWorkspaceDigest: workspaceDigest,
    excludes,
    mirrorDeletes: options.mirrorDeletes === true,
  });
  const cwd = statSync(local, { bigint: true });
  const now = new Date().toISOString();
  // Records shipped before #17 pinned the device number beside the inode;
  // the stale value must be ignored, so the fixture keeps one on record.
  const localCwdId = { dev: "16777234", ino: cwd.ino.toString() };
  const record: BeamRecord = {
    id,
    target: "local",
    localCwd: local,
    localCwdId,
    remoteCwd,
    remoteCwdResolved: true,
    runtimeSession: `beam-${id}`,
    status: "up",
    createdAt: now,
    updatedAt: now,
    targetSpec: { type: "local", root: join(root, "remote") },
    workspaceKind: "plain",
    workspaceDigest,
    returnReceipt: { manifestFile, manifestDigest: fileSha256(manifestFile) },
  };
  addRecord(env, record);
  return { env, id, local, stage: returned.workspace };
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, content);
  }
}

async function runBeam(
  fixture: Fixture,
  args: string[],
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", join(REPO_ROOT, "src/cli.ts"), ...args], {
    cwd: fixture.local,
    env: {
      ...process.env,
      BEAM_HOME: fixture.env.home,
      BEAM_DIR: fixture.env.beamDir,
    },
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined && child.stdin !== undefined) {
    child.stdin.write(input);
    child.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

describe("beam integrate", () => {
  test("JSON previews before approval, applies, and repeats idempotently", async () => {
    const fixture = await makeFixture({
      localFiles: { "work.txt": "local\n" },
      remoteFiles: { "work.txt": "remote\n" },
    });
    const preview = await runBeam(fixture, ["integrate", fixture.id, "--json"]);
    expect(preview.code).toBe(1);
    expect(JSON.parse(preview.stdout).error.code).toBe("confirmation_required");
    expect(readFileSync(join(fixture.local, "work.txt"), "utf8")).toBe("local\n");

    const applied = await runBeam(fixture, ["integrate", fixture.id, "--yes", "--json"]);
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.stdout).data.status).toBe("integrated");
    expect(readFileSync(join(fixture.local, "work.txt"), "utf8")).toBe("remote\n");

    const repeated = await runBeam(fixture, ["integrate", fixture.id, "--yes", "--json"]);
    expect(repeated.code).toBe(0);
    expect(JSON.parse(repeated.stdout).data.status).toBe("already_integrated");
  });

  test("refuses local drift without changing either copy", async () => {
    const fixture = await makeFixture({
      localFiles: { "work.txt": "local\n" },
      remoteFiles: { "work.txt": "remote\n" },
    });
    writeFileSync(join(fixture.local, "work.txt"), "concurrent local work\n");
    const result = await runBeam(fixture, ["integrate", fixture.id, "--yes", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("local_workspace_changed");
    expect(readFileSync(join(fixture.local, "work.txt"), "utf8")).toBe(
      "concurrent local work\n",
    );
    expect(readFileSync(join(fixture.stage, "work.txt"), "utf8")).toBe("remote\n");
  });

  test("refuses a replaced local workspace directory by inode, never by device", async () => {
    const fixture = await makeFixture({
      localFiles: { "work.txt": "local\n" },
      remoteFiles: { "work.txt": "remote\n" },
    });
    // The fixture record already carries a device number no volume on this
    // machine has (a reboot changes st_dev on APFS); the apply still runs.
    const applied = await runBeam(fixture, ["integrate", fixture.id, "--yes", "--json"]);
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.stdout).data.status).toBe("integrated");

    // A recreated directory at the same path is a different inode: refused.
    const aside = `${fixture.local}.aside`;
    renameSync(fixture.local, aside);
    mkdirSync(fixture.local);
    writeFileSync(join(fixture.local, "work.txt"), "remote\n");
    const replaced = await runBeam(fixture, ["integrate", fixture.id, "--yes", "--json"]);
    expect(replaced.code).toBe(1);
    expect(JSON.parse(replaced.stdout).error.code).toBe("local_workspace_replaced");
  });

  test("refuses matching remote content that was written locally after up", async () => {
    const fixture = await makeFixture({
      localFiles: { "work.txt": "local\n" },
      remoteFiles: { "work.txt": "remote\n" },
    });
    writeFileSync(join(fixture.local, "work.txt"), "remote\n");
    const result = await runBeam(fixture, ["integrate", fixture.id, "--yes", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("local_workspace_changed");
  });

  test("refuses a return stage changed after beam down", async () => {
    const fixture = await makeFixture({
      localFiles: { "work.txt": "local\n" },
      remoteFiles: { "work.txt": "remote\n" },
    });
    writeFileSync(join(fixture.stage, "work.txt"), "tampered\n");
    const result = await runBeam(fixture, ["integrate", fixture.id, "--yes", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("return_tampered");
    expect(readFileSync(join(fixture.local, "work.txt"), "utf8")).toBe("local\n");
  });

  test("interactive mode previews and applies only after yes", async () => {
    const fixture = await makeFixture({
      localFiles: { "work.txt": "local\n" },
      remoteFiles: { "work.txt": "remote\n" },
    });
    const result = await runBeam(fixture, ["integrate", fixture.id], "yes\n");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("return preview: 1 change(s)");
    expect(result.stdout).toContain("Apply this verified return? [y/N]");
    expect(readFileSync(join(fixture.local, "work.txt"), "utf8")).toBe("remote\n");
  });

  test("delete mode removes returned deletions but protects excluded local files", async () => {
    const fixture = await makeFixture({
      localFiles: {
        "keep.txt": "base\n",
        "removed.txt": "base\n",
        "secret.txt": "local secret\n",
      },
      remoteFiles: { "keep.txt": "remote\n" },
      excludes: ["/secret.txt"],
      mirrorDeletes: true,
    });
    const result = await runBeam(fixture, ["integrate", fixture.id, "--yes", "--json"]);
    expect(result.code).toBe(0);
    expect(readFileSync(join(fixture.local, "keep.txt"), "utf8")).toBe("remote\n");
    expect(existsSync(join(fixture.local, "removed.txt"))).toBe(false);
    expect(readFileSync(join(fixture.local, "secret.txt"), "utf8")).toBe("local secret\n");
  });
});
