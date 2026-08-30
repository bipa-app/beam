/**
 * Goal: `beam down` return-staging contracts — removed destructive flags
 * stay rejected; `beam integrate` applies `--delete` returns while protecting
 * every effective exclude plus `.git`/`.beam` metadata; Beam-owned return
 * storage is private (0700 dirs, 0600 receipts) and refuses a symlink-replaced
 * returns path before staging a single byte.
 *
 * Method: Run real `cmdUp`/`cmdDown`/`cmdIntegrate` local-transport round
 * trips inside hermetic BEAM_HOME/BEAM_DIR fixtures, then inspect the bytes,
 * record receipts, and private modes on disk.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdDown } from "../src/commands/down.ts";
import { cmdIntegrate } from "../src/commands/integrate.ts";
import { cmdUp } from "../src/commands/up.ts";
import { resolveEnv } from "../src/env.ts";
import { loadState } from "../src/state.ts";
import { runChecked } from "../src/util/shell.ts";

const HAVE_DEPS = Bun.which("git") !== null && Bun.which("rsync") !== null;
const savedCwd = process.cwd();
const savedBeamHome = process.env.BEAM_HOME;
const savedBeamDir = process.env.BEAM_DIR;
const roots: string[] = [];

afterEach(() => {
  process.chdir(savedCwd);
  if (savedBeamHome === undefined) delete process.env.BEAM_HOME;
  else process.env.BEAM_HOME = savedBeamHome;
  if (savedBeamDir === undefined) delete process.env.BEAM_DIR;
  else process.env.BEAM_DIR = savedBeamDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("beam down rejects every removed destructive/retention option", async () => {
  for (const option of ["--purge", "--no-purge", "--keep-remote"]) {
    await expect(cmdDown([option])).rejects.toThrow(/Unknown option/);
  }
}, 30_000);

describe.skipIf(!HAVE_DEPS)("beam down staged integration", () => {
  /** Collect and prove that down points at the first-class integrate command. */
  async function collectReturn(recordId: string): Promise<void> {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
    try {
      await cmdDown([recordId, "--delete"]);
    } finally {
      console.log = originalLog;
    }
    const integrateLines = output
      .map((line) => line.trim())
      .filter((line) => line.startsWith("next: beam integrate "));
    expect(integrateLines.length).toBeGreaterThan(0);
    expect(new Set(integrateLines)).toEqual(new Set([`next: beam integrate ${recordId}`]));
  }

  test(
    "`beam integrate` protects every effective exclude in delete mode",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "beam-down-integrate-")));
      roots.push(root);
      const beamHome = join(root, "home");
      const beamDir = join(beamHome, ".beam");
      const remoteHome = join(root, "remote-home");
      const remoteRoot = join(remoteHome, "workspaces");
      const localCwd = join(root, "workspace");
      mkdirSync(beamDir, { recursive: true });
      mkdirSync(remoteHome, { recursive: true });
      mkdirSync(localCwd);
      process.env.BEAM_HOME = beamHome;
      process.env.BEAM_DIR = beamDir;

      const configSecret = "config secret's.txt";
      const ignoreSecret = "ignore secret's.txt";
      writeFileSync(
        join(beamDir, "config.json"),
        JSON.stringify({
          defaultTarget: "sandbox",
          excludes: [configSecret],
          targets: { sandbox: { type: "local", root: remoteRoot, home: remoteHome } },
        }),
      );
      writeFileSync(join(localCwd, ".beamignore"), `${ignoreSecret}\n`);
      writeFileSync(join(localCwd, configSecret), "config secret\n");
      writeFileSync(join(localCwd, ignoreSecret), "ignore secret\n");
      writeFileSync(join(localCwd, "eligible-deleted.txt"), "delete me\n");
      process.chdir(localCwd);

      await cmdUp(["--no-session", "--no-start"]);
      const record = loadState(resolveEnv()).records.find(
        (candidate) => candidate.localCwd === localCwd,
      )!;
      rmSync(join(record.remoteCwd, "eligible-deleted.txt"));
      writeFileSync(join(record.remoteCwd, "returned.txt"), "returned\n");

      // This path can appear while the remote works. It is Beam-owned
      // locally only by spelling, and must remain protected during the
      // user's explicit reconciliation.
      expect(readdirSync(record.remoteCwd).sort()).toEqual(
        [".beam", ".beamignore", "returned.txt"],
      );
      mkdirSync(join(localCwd, ".beam"));
      writeFileSync(join(localCwd, ".beam", "local-only"), "keep\n");

      await collectReturn(record.id);

      // A plain handoff cannot already be Git at collection time, but a
      // checkout may be initialized before the user runs the printed
      // command. The canonical Git exclude must protect it too.
      mkdirSync(join(localCwd, ".git"));
      writeFileSync(join(localCwd, ".git", "local-only"), "keep\n");
      await cmdIntegrate([record.id, "--yes"], { json: false });

      expect(existsSync(join(localCwd, "eligible-deleted.txt"))).toBe(false);
      expect(readFileSync(join(localCwd, "returned.txt"), "utf8")).toBe("returned\n");
      expect(readFileSync(join(localCwd, ".git", "local-only"), "utf8")).toBe("keep\n");
      expect(readFileSync(join(localCwd, ".beam", "local-only"), "utf8")).toBe("keep\n");
      expect(readFileSync(join(localCwd, configSecret), "utf8")).toBe("config secret\n");
      expect(readFileSync(join(localCwd, ignoreSecret), "utf8")).toBe("ignore secret\n");
      expect(existsSync(record.remoteCwd)).toBe(true);
      expect(
        loadState(resolveEnv()).records.find((candidate) => candidate.id === record.id)!.status,
      ).toBe("up");
    },
    30_000,
  );

  test(
    "Git return integration preserves repository metadata",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "beam-down-git-integrate-")));
      roots.push(root);
      const beamHome = join(root, "home");
      const beamDir = join(beamHome, ".beam");
      const remoteHome = join(root, "remote-home");
      const remoteRoot = join(remoteHome, "workspaces");
      const localCwd = join(root, "workspace");
      mkdirSync(beamDir, { recursive: true });
      mkdirSync(remoteHome, { recursive: true });
      mkdirSync(localCwd);
      process.env.BEAM_HOME = beamHome;
      process.env.BEAM_DIR = beamDir;

      const configSecret = "git config secret's.txt";
      writeFileSync(
        join(beamDir, "config.json"),
        JSON.stringify({
          defaultTarget: "sandbox",
          excludes: [configSecret],
          targets: { sandbox: { type: "local", root: remoteRoot, home: remoteHome } },
        }),
      );
      await runChecked(["git", "init", "-q", "-b", "main", localCwd]);
      await runChecked(["git", "-C", localCwd, "config", "user.name", "t"]);
      await runChecked(["git", "-C", localCwd, "config", "user.email", "t@example.invalid"]);
      writeFileSync(join(localCwd, "eligible-deleted.txt"), "delete me\n");
      await runChecked(["git", "-C", localCwd, "add", "eligible-deleted.txt"]);
      await runChecked(["git", "-C", localCwd, "commit", "-q", "-m", "base"]);
      writeFileSync(join(localCwd, configSecret), "config secret\n");
      process.chdir(localCwd);

      await cmdUp(["--no-session", "--no-start"]);
      const record = loadState(resolveEnv()).records.find(
        (candidate) => candidate.localCwd === localCwd,
      )!;
      rmSync(join(record.remoteCwd, "eligible-deleted.txt"));
      writeFileSync(join(record.remoteCwd, "returned.txt"), "returned\n");
      mkdirSync(join(localCwd, ".beam"));
      writeFileSync(join(localCwd, ".beam", "local-only"), "keep\n");

      await collectReturn(record.id);

      const head = (await runChecked(["git", "-C", localCwd, "rev-parse", "HEAD"])).stdout;
      const gitConfig = readFileSync(join(localCwd, ".git", "config"));
      await cmdIntegrate([record.id, "--yes"], { json: false });

      expect(existsSync(join(localCwd, "eligible-deleted.txt"))).toBe(false);
      expect(readFileSync(join(localCwd, "returned.txt"), "utf8")).toBe("returned\n");
      expect(readFileSync(join(localCwd, ".git", "config"))).toEqual(gitConfig);
      expect((await runChecked(["git", "-C", localCwd, "rev-parse", "HEAD"])).stdout).toBe(head);
      expect(readFileSync(join(localCwd, ".beam", "local-only"), "utf8")).toBe("keep\n");
      expect(readFileSync(join(localCwd, configSecret), "utf8")).toBe("config secret\n");
      expect(existsSync(record.remoteCwd)).toBe(true);
      expect(
        loadState(resolveEnv()).records.find((candidate) => candidate.id === record.id)!.status,
      ).toBe("up");
    },
    60_000,
  );
});

describe.skipIf(!HAVE_DEPS)("beam down private local storage", () => {
  /** Standard local-target fixture; returns the paths the tests inspect. */
  const makePrivateFixture = (tag: string): { root: string; beamDir: string; localCwd: string } => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `beam-down-${tag}-`)));
    roots.push(root);
    const beamHome = join(root, "home");
    const beamDir = join(beamHome, ".beam");
    const remoteHome = join(root, "remote-home");
    const localCwd = join(root, "workspace");
    // Plain mkdirs under the ambient umask: Beam must retro-tighten its
    // own storage, not rely on how the fixture created it.
    mkdirSync(beamDir, { recursive: true });
    mkdirSync(remoteHome, { recursive: true });
    mkdirSync(localCwd);
    process.env.BEAM_HOME = beamHome;
    process.env.BEAM_DIR = beamDir;
    writeFileSync(
      join(beamDir, "config.json"),
      JSON.stringify({
        defaultTarget: "sandbox",
        targets: {
          sandbox: { type: "local", root: join(remoteHome, "workspaces"), home: remoteHome },
        },
      }),
    );
    writeFileSync(join(localCwd, "work.txt"), "local\n");
    return { root, beamDir, localCwd };
  };

  test(
    "under umask 022 every Beam parent of the return is 0700 and receipts are 0600",
    async () => {
      const savedUmask = process.umask(0o022);
      try {
        const { beamDir, localCwd } = makePrivateFixture("private");
        process.chdir(localCwd);
        await cmdUp(["--no-session", "--no-start"]);
        const record = loadState(resolveEnv()).records.find((c) => c.localCwd === localCwd)!;
        writeFileSync(join(record.remoteCwd, "returned.txt"), "returned\n");
        await cmdDown([record.id]);

        const returnsDir = join(beamDir, "returns");
        const idDir = join(returnsDir, record.id);
        const txns = readdirSync(idDir).sort();
        expect(txns.length).toBe(1);
        const txn = join(idDir, txns[0]!);
        // Beam-owned parents above the returned bytes carry no group/other
        // bits, even though the 022 umask would have left plain mkdirs
        // world-traversable. Workspace files INSIDE keep their transported
        // modes — these ancestors are the protection.
        for (const dir of [beamDir, returnsDir, idDir, txn]) {
          expect(lstatSync(dir).mode & 0o077).toBe(0);
        }
        // Receipts carry remote paths, tokens, and digests: owner-only.
        expect(lstatSync(join(txn, "manifest.json")).mode & 0o777).toBe(0o600);
        expect(lstatSync(join(beamDir, "state.json")).mode & 0o777).toBe(0o600);
        expect(readFileSync(join(txn, "workspace", "returned.txt"), "utf8")).toBe("returned\n");
      } finally {
        process.umask(savedUmask);
      }
    },
    30_000,
  );

  test(
    "a symlink-replaced returns path refuses before staging — zero bytes written" +
      " through it; the retry converges after repair",
    async () => {
      const { root, beamDir, localCwd } = makePrivateFixture("linkret");
      process.chdir(localCwd);
      await cmdUp(["--no-session", "--no-start"]);
      const record = loadState(resolveEnv()).records.find((c) => c.localCwd === localCwd)!;
      writeFileSync(join(record.remoteCwd, "returned.txt"), "returned\n");

      // A foreign process replaced this record's returns path with a
      // symlink into its own directory: following it would write the full
      // private return — workspace mirror, transcript, receipt — outside
      // Beam's 0700 storage.
      const attacker = join(root, "attacker");
      mkdirSync(attacker);
      mkdirSync(join(beamDir, "returns"), { recursive: true });
      symlinkSync(attacker, join(beamDir, "returns", record.id));

      const err = await cmdDown([record.id]).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(String(err)).toMatch(/is a symlink/);
      // Zero writes landed through the link; the remote is intact and the
      // record stays collectible.
      expect(readdirSync(attacker)).toEqual([]);
      expect(readFileSync(join(record.remoteCwd, "returned.txt"), "utf8")).toBe("returned\n");
      expect(loadState(resolveEnv()).records.find((c) => c.id === record.id)!.status).toBe("up");

      // Repair: drop the foreign link; the retry stages normally into a
      // real private directory.
      rmSync(join(beamDir, "returns", record.id), { force: true });
      await cmdDown([record.id]);
      const idDir = join(beamDir, "returns", record.id);
      const txns = readdirSync(idDir);
      expect(txns.length).toBe(1);
      expect(
        readFileSync(join(idDir, txns[0]!, "workspace", "returned.txt"), "utf8"),
      ).toBe("returned\n");
      expect(existsSync(join(idDir, txns[0]!, "manifest.json"))).toBe(true);
    },
    30_000,
  );
});
