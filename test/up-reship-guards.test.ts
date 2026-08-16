import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { cmdUp } from "../src/commands/up.ts";
import { resolveEnv } from "../src/env.ts";
import { loadState, updateRecord, type BeamRecord } from "../src/state.ts";
import { LocalTransport } from "../src/transport/local.ts";
import { run, runChecked } from "../src/util/shell.ts";
import { remoteGitOperationMarkers } from "../src/workspace-git.ts";

/**
 * Re-ship lifecycle guards for linked-worktree handoffs:
 *
 *  - a prior `up` handoff whose remote `.git` holds an in-progress
 *    operation (merge, rebase, sequencer) refuses the re-ship BEFORE the
 *    status drops back to `provisioning` and before any outbound byte —
 *    that remote operation state exists nowhere else, and the re-ship's
 *    delete-mirroring `.git` sync would erase it wholesale;
 *
 *  - a reused `provisioning` record (the crash window between reservation
 *    and the ship) re-runs the LOCAL shippability guards before any remote
 *    interaction — provisioning included — so an unshippable retry can
 *    never create a scarce sandbox claim it then refuses to use, and a
 *    refused retry leaks no temp payload and persists no new identity.
 */

const HAVE_DEPS = Bun.which("git") !== null && Bun.which("rsync") !== null && Bun.which("tmux") !== null;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

async function git(cwd: string, ...args: string[]) {
  return runChecked(["git", "-C", cwd, ...args], { env: GIT_ENV });
}

/** Temp dirs the materializer creates — must never outlive a refused up. */
function materializerTemps(): string[] {
  return readdirSync(tmpdir())
    .filter((n) => n.startsWith("beam-wtgit-"))
    .sort();
}

/** Every file under a directory, path -> bytes: proves zero remote mutation. */
function remoteManifest(dir: string): Map<string, string> {
  const manifest = new Map<string, string>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else manifest.set(relative(dir, p), readFileSync(p, "latin1"));
    }
  };
  walk(dir);
  return manifest;
}

interface IsolatedBeam {
  remoteRoot: string;
  savedCwd: string;
  savedEnv: Record<string, string | undefined>;
}

function isolatedBeam(tag: string): IsolatedBeam {
  const savedCwd = process.cwd();
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of ["BEAM_HOME", "BEAM_DIR"]) savedEnv[k] = process.env[k];
  const beamHome = realpathSync(mkdtempSync(join(tmpdir(), `beam-${tag}-home-`)));
  const remoteHome = realpathSync(mkdtempSync(join(tmpdir(), `beam-${tag}-rhome-`)));
  const remoteRoot = join(remoteHome, "beam-root");
  const beamDir = join(beamHome, ".beam");
  mkdirSync(beamDir, { recursive: true });
  writeFileSync(
    join(beamDir, "config.json"),
    JSON.stringify({
      defaultTarget: "sandbox",
      targets: { sandbox: { type: "local", root: remoteRoot, home: remoteHome } },
    }),
  );
  process.env.BEAM_HOME = beamHome;
  process.env.BEAM_DIR = beamDir;
  return { remoteRoot, savedCwd, savedEnv };
}

function restoreBeam(iso: IsolatedBeam): void {
  process.chdir(iso.savedCwd);
  for (const [k, v] of Object.entries(iso.savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function theRecord(): BeamRecord {
  const { records } = loadState(resolveEnv());
  expect(records.length).toBe(1);
  return records[0]!;
}

interface WtFixture {
  base: string;
  wt: string;
  commonGit: string;
}

/**
 * Linked worktree on a CLEAN `main`, plus a sibling branch `other` with two
 * commits: `other~1` ("theirs") conflicts with main on conflict.txt, `other`
 * ("extra") is clean — a two-commit cherry-pick whose first step conflicts
 * leaves the multi-commit sequencer alive between steps.
 */
async function makeWtFixture(): Promise<WtFixture> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-reshipfix-")));
  const seed = join(base, "seed");
  mkdirSync(seed);
  await git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "conflict.txt"), "base\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-q", "-m", "base");
  await git(seed, "checkout", "-q", "-b", "other");
  writeFileSync(join(seed, "conflict.txt"), "theirs\n");
  await git(seed, "commit", "-q", "-am", "theirs");
  writeFileSync(join(seed, "extra.txt"), "clean addition\n");
  await git(seed, "add", "extra.txt");
  await git(seed, "commit", "-q", "-m", "extra");
  await git(seed, "checkout", "-q", "main");
  writeFileSync(join(seed, "conflict.txt"), "ours\n");
  await git(seed, "commit", "-q", "-am", "ours");
  const commonGit = join(base, "common.git");
  await runChecked(["git", "clone", "-q", "--bare", seed, commonGit], { env: GIT_ENV });
  rmSync(seed, { recursive: true, force: true });
  await git(commonGit, "remote", "set-url", "origin", "https://example.invalid/reship.git");
  const wt = join(base, "wt");
  await git(commonGit, "worktree", "add", "-q", wt, "main");
  return { base, wt, commonGit };
}

describe.skipIf(!HAVE_DEPS)("re-ship refuses while the remote linked .git has an in-progress operation", () => {
  let iso: IsolatedBeam;
  let f: WtFixture;
  let remoteCwd: string;

  beforeAll(async () => {
    iso = isolatedBeam("reship");
    f = await makeWtFixture();
    process.chdir(f.wt);
  });
  afterAll(() => restoreBeam(iso));

  /**
   * The refusal must be a pure read: record byte-identical (status still
   * `up`, `wtGit` untouched, not even `updatedAt` moved), remote workspace
   * — `.git` and operation state included — byte-identical.
   */
  async function expectRefusedReship(marker: string): Promise<void> {
    const recordBytes = JSON.stringify(theRecord());
    const manifest = remoteManifest(remoteCwd);
    await expect(cmdUp(["--no-session"])).rejects.toThrow(
      new RegExp(`in-progress git operation on sandbox \\(${marker}\\)[\\s\\S]*beam down`),
    );
    expect(JSON.stringify(theRecord())).toBe(recordBytes);
    expect(remoteManifest(remoteCwd)).toEqual(manifest);
  }

  test(
    "ships once, then an in-progress remote merge fails the re-ship closed",
    async () => {
      await cmdUp(["--no-session"]);
      const record = theRecord();
      expect(record.status).toBe("up");
      expect(record.wtGit).toBeDefined();
      remoteCwd = record.remoteCwd;

      // Remote agent work: a merge that conflicts and stays in progress.
      expect((await run(["git", "-C", remoteCwd, "merge", "other"], { env: GIT_ENV })).code).not.toBe(0);
      expect(existsSync(join(remoteCwd, ".git", "MERGE_HEAD"))).toBe(true);

      await expectRefusedReship("MERGE_HEAD");
      expect(existsSync(join(remoteCwd, ".git", "MERGE_HEAD"))).toBe(true); // operation intact

      await git(remoteCwd, "merge", "--abort");
    },
    60_000,
  );

  test(
    "an in-progress remote rebase fails the re-ship closed",
    async () => {
      expect((await run(["git", "-C", remoteCwd, "rebase", "other"], { env: GIT_ENV })).code).not.toBe(0);
      expect(existsSync(join(remoteCwd, ".git", "rebase-merge"))).toBe(true);

      await expectRefusedReship("rebase-merge");
      expect(existsSync(join(remoteCwd, ".git", "rebase-merge"))).toBe(true);

      await git(remoteCwd, "rebase", "--abort");
    },
    60_000,
  );

  test(
    "a multi-commit sequencer run between steps — no CHERRY_PICK_HEAD — fails the re-ship closed",
    async () => {
      // First pick ("theirs") conflicts; resolving it with plain `git commit`
      // consumes CHERRY_PICK_HEAD while sequencer/todo still holds the
      // second pick — git itself reports "Cherry-pick currently in progress".
      expect((await run(["git", "-C", remoteCwd, "cherry-pick", "other~1", "other"], { env: GIT_ENV })).code).not.toBe(
        0,
      );
      writeFileSync(join(remoteCwd, "conflict.txt"), "resolved\n");
      await git(remoteCwd, "add", "conflict.txt");
      await git(remoteCwd, "commit", "-q", "--no-edit");
      expect(existsSync(join(remoteCwd, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
      expect(existsSync(join(remoteCwd, ".git", "sequencer"))).toBe(true);

      await expectRefusedReship("sequencer");
      expect(existsSync(join(remoteCwd, ".git", "sequencer"))).toBe(true);

      await git(remoteCwd, "cherry-pick", "--quit");
    },
    60_000,
  );

  test(
    "with the remote operation finished, the same re-ship goes through",
    async () => {
      await cmdUp(["--no-session"]);
      const record = theRecord();
      expect(record.status).toBe("up");
      // The re-ship landed THIS ship's `.git`: remote main is the local tip
      // again and no operation marker survived the mirrored payload.
      const localMain = (await git(f.wt, "rev-parse", "main")).stdout.trim();
      expect((await git(remoteCwd, "rev-parse", "main")).stdout.trim()).toBe(localMain);
      expect(await remoteGitOperationMarkers(new LocalTransport(), join(remoteCwd, ".git"))).toEqual([]);
    },
    60_000,
  );
});

describe.skipIf(!HAVE_DEPS)("reused provisioning record: local git guards precede any remote interaction", () => {
  let iso: IsolatedBeam;
  let f: WtFixture;
  let savedPath: string | undefined;

  beforeAll(async () => {
    iso = isolatedBeam("reprov");
    f = await makeWtFixture();
    savedPath = process.env.PATH;
  });
  afterAll(() => {
    if (savedPath !== undefined) process.env.PATH = savedPath;
    restoreBeam(iso);
  });

  test(
    "an in-progress local merge refuses the retry before provisioning or liveness, leaking nothing",
    async () => {
      process.chdir(f.wt);
      await cmdUp(["--no-session"]);
      const shipped = theRecord();
      expect(shipped.status).toBe("up");
      const shippedWtGit = JSON.stringify(shipped.wtGit);

      // The crash window: a fresh up died after reserving — before (or
      // during) provisioning — leaving a reusable `provisioning` record.
      updateRecord(resolveEnv(), shipped.id, { status: "provisioning" });

      // A local operation begins before the retry…
      expect((await run(["git", "-C", f.wt, "merge", "other"], { env: GIT_ENV })).code).not.toBe(0);

      // …and the first remote act after provisioning — the tmux liveness
      // probe — is booby-trapped with a shim that cannot answer. If the
      // retry reached ANY remote step (provision is inert on a static
      // target), it would die with the probe error, not the local guard's.
      const fakeBin = join(f.base, "fakebin");
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(fakeBin, "tmux"), "#!/bin/bash\nexit 42\n");
      chmodSync(join(fakeBin, "tmux"), 0o755);
      process.env.PATH = `${fakeBin}:${process.env.PATH}`;

      const temps = materializerTemps();
      await expect(cmdUp(["--no-session"])).rejects.toThrow(/in-progress git operation \(MERGE_HEAD\)/);

      const after = theRecord();
      expect(after.status).toBe("provisioning"); // the refusal advanced nothing
      expect(JSON.stringify(after.wtGit)).toBe(shippedWtGit); // persist stayed deferred
      expect(materializerTemps()).toEqual(temps); // temp payload cleaned in finally

      // Recovery: finish the local operation, drop the trap, retry cleanly.
      await git(f.wt, "merge", "--abort");
      process.env.PATH = savedPath!;
      await cmdUp(["--no-session"]);
      expect(theRecord().status).toBe("up");
    },
    60_000,
  );
});

describe.skipIf(!HAVE_DEPS)("remoteGitOperationMarkers", () => {
  test("reports exactly the present markers, in canonical order, files or dirs", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "beam-probe-")));
    const gitDir = join(home, "ws", ".git");
    mkdirSync(gitDir, { recursive: true });
    const t = new LocalTransport(home);

    expect(await remoteGitOperationMarkers(t, gitDir)).toEqual([]);

    mkdirSync(join(gitDir, "rebase-merge"));
    writeFileSync(join(gitDir, "MERGE_HEAD"), "");
    expect(await remoteGitOperationMarkers(t, gitDir)).toEqual(["MERGE_HEAD", "rebase-merge"]);
  });

  test("a git dir path needing shell quoting still probes correctly", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "beam-probe-q-")));
    const gitDir = join(home, "with space's", ".git");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "sequencer"), "");
    const t = new LocalTransport(home);

    expect(await remoteGitOperationMarkers(t, gitDir)).toEqual(["sequencer"]);
  });
});
