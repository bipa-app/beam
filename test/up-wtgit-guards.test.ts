/**
 * Goal: reused-record wtGit deferral — a record that already carries a
 * linked-worktree ship identity (`wtGit`) keeps it BYTE-FOR-BYTE unchanged
 * through every refused re-ship, because `beam down` keys its git-state
 * return off that identity and the remote side still holds exactly what
 * the prior ship sent out; only a re-ship that actually begins (all
 * liveness, session-identity, and remote-operation gates passed, the
 * record dropping back to `provisioning`) may update or clear it. The
 * refusal paths exercised, in order: explicit session switch and
 * --no-session orphan (pre-provision identity gate), live agent on a
 * reused sandbox (tmux liveness gate), starting + live agent finalize
 * (early return, nothing re-shipped), retained session missing
 * (pre-provision identity gate), and starting + dead agent finalize
 * (an answerable `starting` is a COMPLETED ship either way; recovery is
 * `beam down`, never a re-ship over remote work).
 *
 * Method: real `cmdUp`/`cmdDown` over the local transport against a PLAIN
 * directory workspace — exactly the pre-fix trigger, where `beam up`
 * cleared `wtGit` unconditionally at the top of the command — inside
 * hermetic BEAM_HOME/BEAM_DIR fixtures with a stub `omp` and a private
 * tmux socket; suites are `describe.skipIf`-gated on tmux/rsync/git with
 * explicit 30s/60s real-process timeouts.
 */
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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { cmdUp } from "../src/commands/up.ts";
import { cmdDown } from "../src/commands/down.ts";
import { resolveEnv } from "../src/env.ts";
import { loadState, updateRecord, type BeamRecord } from "../src/state.ts";
import { runChecked } from "../src/util/shell.ts";
import type { WtGitShipInfo } from "../src/workspace-git.ts";

const TMUX_SOCKET = `beamwtgit-${process.pid}`;
const HAVE_DEPS =
  Bun.which("tmux") !== null && Bun.which("rsync") !== null && Bun.which("git") !== null;

// Explicit real-process budgets: 30s covers a local rsync ship/collect plus
// tmux probes (the e2e.test.ts cost class); 60s adds real git init/commit
// sequences (the down-staged-return.test.ts git class).
const ROUND_TRIP_TIMEOUT_MS = 30_000;
const GIT_FLOW_TIMEOUT_MS = 60_000;

// fake omp: --no-start means the resume path is never taken in these tests.
const FAKE_OMP = `#!/bin/bash
exit 0
`;

const SEEDED_WTGIT: WtGitShipInfo = {
  head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  branch: "refs/heads/main",
  commonDir: "/prior/ship/common/.git",
  generation: "ab".repeat(8),
};
const SEEDED_BYTES = JSON.stringify(SEEDED_WTGIT);

let localHome: string;
let beamDir: string;
let workDir: string;
let remoteHome: string;
let remoteRoot: string;
let storeDir: string;
const savedEnv: Record<string, string | undefined> = {};
let savedCwd: string;

function writeSession(id: string, timestamp: string, ageSeconds: number): string {
  const file = join(storeDir, `${timestamp}_${id}.jsonl`);
  writeFileSync(
    file,
    `{"type":"session","version":3,"id":"${id}","timestamp":"t","cwd":"${workDir}"}\n` +
      `{"type":"message","id":"m1","text":"local work"}\n`,
  );
  const when = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(file, when, when);
  return file;
}

function theRecord(): BeamRecord {
  const { records } = loadState(resolveEnv());
  expect(records.length).toBe(1);
  return records[0]!;
}

/** The persisted wtGit exactly as state.json round-trips it. */
function wtGitBytes(): string | undefined {
  const wtGit = theRecord().wtGit;
  return wtGit === undefined ? undefined : JSON.stringify(wtGit);
}

/** Every file under a directory, path -> bytes: proves zero remote mutation. */
function remoteManifest(dir: string): Map<string, string> {
  const manifest = new Map<string, string>();
  // Explicit bounded stack instead of recursion (depth capped by entry count);
  // children are pushed in reverse so pops replay the recursive preorder
  // byte-for-byte: a directory's contents land before its later siblings.
  const stack: Array<{ path: string; isDir: boolean }> = [{ path: dir, isDir: true }];
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === undefined) break;
    if (top.isDir) {
      const entries = readdirSync(top.path, { withFileTypes: true });
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i]!;
        stack.push({ path: join(top.path, entry.name), isDir: entry.isDirectory() });
      }
    } else {
      manifest.set(relative(dir, top.path), readFileSync(top.path, "latin1"));
    }
  }
  return manifest;
}

function tmux(...args: string[]): void {
  const res = Bun.spawnSync(["tmux", "-L", TMUX_SOCKET, ...args]);
  if (res.exitCode !== 0) {
    throw new Error(`tmux ${args.join(" ")} exited ${res.exitCode}: ${res.stderr.toString()}`);
  }
}

/** Current HEAD of a repository — the remote-work fingerprint refusals must preserve. */
async function remoteHeadOf(repoDir: string): Promise<string> {
  return (await runChecked(["git", "-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();
}

describe.skipIf(!HAVE_DEPS)(
  "reused-record wtGit survives every refused re-ship (local transport)",
  () => {
    beforeAll(() => {
      savedCwd = process.cwd();
      for (const k of ["BEAM_HOME", "BEAM_DIR", "PATH"]) savedEnv[k] = process.env[k];

      localHome = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtgit-home-")));
      remoteHome = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtgit-rhome-")));
      remoteRoot = join(remoteHome, "beam-root");
      beamDir = join(localHome, ".beam");
      workDir = join(localHome, "work", "app");

      mkdirSync(join(workDir, "src"), { recursive: true });
      writeFileSync(join(workDir, "hello.txt"), "hello beam\n");

      // Stored session (older). A newer drifted session is added mid-suite.
      storeDir = join(localHome, ".omp", "agent", "sessions", "-work-app");
      mkdirSync(storeDir, { recursive: true });
      writeSession("sess-aaa", "2026-08-01T10-00-00-000Z", 600);

      mkdirSync(beamDir, { recursive: true });
      writeFileSync(
        join(beamDir, "config.json"),
        JSON.stringify({
          defaultTarget: "sandbox",
          targets: {
            sandbox: { type: "local", root: remoteRoot, home: remoteHome, tmuxSocket: TMUX_SOCKET },
          },
        }),
      );

      const fakeBin = join(localHome, "fakebin");
      mkdirSync(fakeBin);
      writeFileSync(join(fakeBin, "omp"), FAKE_OMP);
      chmodSync(join(fakeBin, "omp"), 0o755);
      process.env.PATH = `${fakeBin}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
      process.env.BEAM_HOME = localHome;
      process.env.BEAM_DIR = beamDir;
      process.chdir(workDir);
    });

    afterAll(() => {
      Bun.spawnSync(["tmux", "-L", TMUX_SOCKET, "kill-server"]); // best-effort
      process.chdir(savedCwd);
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    test("first up ships clean; a prior-ship wtGit identity is seeded on the record", async () => {
      await cmdUp(["--no-start", "-m", "first kickoff"]);

      const record = theRecord();
      expect(record.status).toBe("up");
      expect(record.wtGit).toBeUndefined(); // plain directory: fresh up persists no identity
      expect(record.workspaceKind).toBe("plain");

      // Simulate the prior ship having been a linked worktree.
      updateRecord(resolveEnv(), record.id, { wtGit: SEEDED_WTGIT, workspaceKind: "git" });
      expect(wtGitBytes()).toBe(SEEDED_BYTES);
    }, ROUND_TRIP_TIMEOUT_MS);

    test("explicit session switch refusal leaves wtGit byte-for-byte unchanged", async () => {
      writeSession("sess-bbb", "2026-08-02T10-00-00-000Z", 0);

      await expect(cmdUp(["--no-start", "--session", "sess-bbb"])).rejects.toThrow(
        /already shipped session/,
      );

      expect(wtGitBytes()).toBe(SEEDED_BYTES);
      expect(theRecord().status).toBe("up");
    }, ROUND_TRIP_TIMEOUT_MS);

    test("--no-session orphan refusal leaves wtGit unchanged", async () => {
      await expect(cmdUp(["--no-start", "--no-session"])).rejects.toThrow(
        /--no-session would orphan/,
      );

      expect(wtGitBytes()).toBe(SEEDED_BYTES);
    }, ROUND_TRIP_TIMEOUT_MS);

    test(
      "layout refusal leaves the prior Git identity unchanged even with a live remote agent",
      async () => {
        tmux("new-session", "-d", "-s", theRecord().tmux, "sleep 300");

        await expect(cmdUp(["--no-start"])).rejects.toThrow(/pinned as a git workspace/);

        expect(wtGitBytes()).toBe(SEEDED_BYTES);
        expect(theRecord().status).toBe("up");
      },
      ROUND_TRIP_TIMEOUT_MS,
    );

    test(
      "finalizing an interrupted handoff (starting + live agent) never touches wtGit",
      async () => {
        const record = theRecord();
        updateRecord(resolveEnv(), record.id, { status: "starting" });

        await cmdUp(["--no-start"]); // finalize path: nothing re-shipped

        const after = theRecord();
        expect(after.status).toBe("up");
        expect(after.sessionId).toBe("sess-aaa"); // identity untouched by the finalize
        expect(wtGitBytes()).toBe(SEEDED_BYTES);

        tmux("kill-session", "-t", `=${record.tmux}`);
      },
      ROUND_TRIP_TIMEOUT_MS,
    );

    test(
      "missing retained session refuses before any wtGit mutation (pre-provision gate)",
      async () => {
        rmSync(join(storeDir, "2026-08-01T10-00-00-000Z_sess-aaa.jsonl"));

        await expect(cmdUp(["--no-start"])).rejects.toThrow(/no longer exists locally/);

        expect(wtGitBytes()).toBe(SEEDED_BYTES);
        expect(theRecord().status).toBe("up");
      },
      ROUND_TRIP_TIMEOUT_MS,
    );

    test(
      "starting + dead agent finalizes to up — remote work preserved, nothing re-shipped",
      async () => {
        const record = theRecord();
        updateRecord(resolveEnv(), record.id, { status: "starting" });

        // Remote-only work the interrupted ship's agent may have produced
        // before exiting: a re-ship's delete-mirroring syncUp would erase it
        // (it exists nowhere locally). The finalize must not move a byte.
        writeFileSync(join(record.remoteCwd, "remote-work.txt"), "made remotely\n");
        const before = remoteManifest(record.remoteCwd);

        // The retained session is still MISSING locally (removed above): the
        // finalize path must not depend on it — the transcript that matters
        // now lives remotely, and only `beam down` collects it.
        await cmdUp(["--no-start"]);

        const after = theRecord();
        expect(after.status).toBe("up"); // answerable `starting` = completed ship
        expect(after.sessionId).toBe("sess-aaa"); // identity untouched by the finalize
        expect(wtGitBytes()).toBe(SEEDED_BYTES);
        expect(remoteManifest(record.remoteCwd)).toEqual(before); // zero remote mutation
      },
      ROUND_TRIP_TIMEOUT_MS,
    );

    test(
      "a Git-to-plain layout transition refuses instead of clearing the prior ship identity",
      async () => {
        writeSession("sess-aaa", "2026-08-01T10-00-00-000Z", 600); // retained session is back
        const record = theRecord();
        const before = remoteManifest(record.remoteCwd);

        await expect(cmdUp(["--no-start"])).rejects.toThrow(
          /re-shipping across a Git layout change could lose remote Git state/,
        );

        expect(theRecord().status).toBe("up");
        expect(wtGitBytes()).toBe(SEEDED_BYTES);
        expect(remoteManifest(record.remoteCwd)).toEqual(before);

        // This suite seeded a legacy identity on a genuinely plain handoff only
        // to exercise refusal ordering. Restore the real prior layout so the
        // final down can collect that plain handoff.
        updateRecord(resolveEnv(), record.id, { wtGit: undefined, workspaceKind: "plain" });
      },
      ROUND_TRIP_TIMEOUT_MS,
    );

    test("beam down recovers the live handoff's remote work", async () => {
      const record = theRecord();
      // Remote agent work made after the re-ship: down must preserve it in a
      // verified return stage without touching the live plain workspace.
      writeFileSync(join(record.remoteCwd, "remote-work-2.txt"), "made remotely\n");

      await cmdDown([record.id]);

      expect(theRecord().status).toBe("up");
      expect(existsSync(join(workDir, "remote-work-2.txt"))).toBe(false);
      const txn = readdirSync(join(beamDir, "returns", record.id)).sort().at(-1)!;
      const returned = join(beamDir, "returns", record.id, txn, "workspace", "remote-work-2.txt");
      expect(readFileSync(returned, "utf8")).toBe("made remotely\n");
      expect(existsSync(record.remoteCwd)).toBe(true); // retained for explicit kill
    }, ROUND_TRIP_TIMEOUT_MS);

    test(
      "a plain-to-Git transition preserves a remote-created repository and refuses the re-ship",
      async () => {
        const plainDir = join(localHome, "work", "plain-to-git");
        mkdirSync(plainDir);
        writeFileSync(join(plainDir, "plain.txt"), "plain ship\n");
        process.chdir(plainDir);
        await cmdUp(["--no-session", "--no-start"]);
        const record = loadState(resolveEnv()).records.find((r) => r.localCwd === plainDir)!;
        expect(record.wtGit).toBeUndefined();
        expect(record.workspaceKind).toBe("plain");

        // The remote agent creates a repository and commits work that exists
        // nowhere locally.
        await runChecked(["git", "-C", record.remoteCwd, "init", "-q", "-b", "main"]);
        await runChecked(["git", "-C", record.remoteCwd, "config", "user.name", "remote"]);
        await runChecked(
          ["git", "-C", record.remoteCwd, "config", "user.email", "remote@example.invalid"],
        );
        writeFileSync(join(record.remoteCwd, "remote-only.txt"), "remote commit\n");
        await runChecked(["git", "-C", record.remoteCwd, "add", "-A"]);
        await runChecked(["git", "-C", record.remoteCwd, "commit", "-q", "-m", "remote only"]);
        const remoteHead = await remoteHeadOf(record.remoteCwd);

        // Meanwhile the local plain directory becomes a different repository.
        await runChecked(["git", "-C", plainDir, "init", "-q", "-b", "main"]);
        await runChecked(["git", "-C", plainDir, "config", "user.name", "local"]);
        await runChecked(["git", "-C", plainDir, "config", "user.email", "local@example.invalid"]);
        await runChecked(["git", "-C", plainDir, "add", "-A"]);
        await runChecked(["git", "-C", plainDir, "commit", "-q", "-m", "local only"]);
        const before = remoteManifest(record.remoteCwd);

        await expect(cmdUp(["--no-session", "--no-start"])).rejects.toThrow(
          /re-shipping across a Git layout change could lose remote Git state/,
        );

        expect(remoteManifest(record.remoteCwd)).toEqual(before);
        expect(await remoteHeadOf(record.remoteCwd)).toBe(remoteHead);
        const after = loadState(resolveEnv()).records.find((r) => r.id === record.id)!;
        expect(after.status).toBe("up");
        expect(after.wtGit).toBeUndefined();
        await expect(cmdDown([record.id])).rejects.toThrow(/carries no Git identity/);
        expect(remoteManifest(record.remoteCwd)).toEqual(before);
        expect(await remoteHeadOf(record.remoteCwd)).toBe(remoteHead);
      },
      GIT_FLOW_TIMEOUT_MS,
    );
  },
);
