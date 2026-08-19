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
 * reused sandbox (herdr liveness gate), starting + live agent finalize
 * (early return, nothing re-shipped), retained session missing
 * (pre-provision identity gate), and starting + dead agent finalize
 * (an answerable `starting` is a COMPLETED ship either way; recovery is
 * `beam down`, never a re-ship over remote work).
 *
 * Method: real `cmdUp`/`cmdDown` over the local transport against a PLAIN
 * directory workspace — exactly the pre-fix trigger, where `beam up`
 * cleared `wtGit` unconditionally at the top of the command — inside
 * hermetic BEAM_HOME/BEAM_DIR fixtures with a stub `omp` and real herdr
 * sessions isolated under the fixture's remote HOME; suites are
 * `describe.skipIf`-gated on herdr/rsync/git with explicit 30s/60s
 * real-process timeouts.
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
import { dirname, join, relative } from "node:path";
import { cmdUp } from "../src/commands/up.ts";
import { cmdDown } from "../src/commands/down.ts";
import { resolveEnv } from "../src/env.ts";
import { loadState, updateRecord, type BeamRecord } from "../src/state.ts";
import { run, runChecked, type RunResult } from "../src/util/shell.ts";
import type { WtGitShipInfo } from "../src/workspace-git.ts";

const HERDR = Bun.which("herdr");
const HAVE_DEPS =
  HERDR !== null && Bun.which("rsync") !== null && Bun.which("git") !== null;

// Explicit real-process budgets: 30s covers a local rsync ship/collect plus
// herdr probes (the e2e.test.ts cost class); 60s adds real git init/commit
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

/**
 * The same uid-scoped socket path the runtime's emitted scripts compute
 * (`${TMPDIR:-/tmp}/herdr-<uid>/<name>.sock`) — the planted server MUST
 * bind there and probes MUST connect there, or beam's alive() and these
 * fixtures would talk past each other. The dir is uid-global and shared
 * across fixtures; beam-<id> session names keep entries disjoint.
 */
function herdrSocketEnv(name: string): Record<string, string> {
  const dir = join(process.env.TMPDIR ?? "/tmp", `herdr-${process.getuid!()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { HERDR_SESSION: name, HERDR_SOCKET_PATH: join(dir, `${name}.sock`) };
}

/**
 * Run the real herdr with the session's uid-scoped socket pinned and the
 * fixture's remote home as the registry — the same pair beam's
 * transport-driven probes resolve.
 */
async function herdrCtl(session: string, ...args: string[]): Promise<RunResult> {
  return run([HERDR!, ...args], { env: { HOME: remoteHome, ...herdrSocketEnv(session) } });
}

/**
 * Plant a live herdr session: a real background per-session server plus one
 * workspace pane — exactly what beam's alive() sees for a running agent.
 * Bounded readiness poll, mirroring the runtime's own ensure-server window.
 */
async function plantLiveSession(session: string): Promise<void> {
  const proc = Bun.spawn([HERDR!, "server"], {
    env: { ...process.env, HOME: remoteHome, ...herdrSocketEnv(session) },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  proc.unref();
  const deadline = Date.now() + 10_000;
  // Real wall-clock poll: the awaited condition is a genuinely external
  // server process answering its socket — fake timers cannot advance it.
  while ((await herdrCtl(session, "pane", "list")).code !== 0) {
    if (Date.now() > deadline) throw new Error(`herdr server for ${session} never answered`);
    await Bun.sleep(200);
  }
  const created = await herdrCtl(
    session, "workspace", "create", "--cwd", remoteHome, "--no-focus",
  );
  if (created.code !== 0) {
    throw new Error(`herdr workspace create for ${session} failed: ${created.stderr}`);
  }
}

/** Stop (checked — the plant must still be running) and delete a session. */
async function killPlantedSession(session: string): Promise<void> {
  // `server stop` reaches the uid-scoped socket directly; `session stop`
  // only resolves HOME-registry sockets and cannot see the planted server.
  const stopped = await herdrCtl(session, "server", "stop");
  if (stopped.code !== 0) {
    throw new Error(`herdr server stop for ${session} failed: ${stopped.stderr}`);
  }
  await herdrCtl(session, "session", "delete", session, "--json");
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
      for (const k of ["BEAM_HOME", "BEAM_DIR", "PATH", "XDG_CONFIG_HOME"]) {
        savedEnv[k] = process.env[k];
      }
      // herdr resolves its session REGISTRY from XDG_CONFIG_HOME before
      // HOME; the transport pins HOME only, so an ambient XDG value would
      // escape the fixture's remote home.
      delete process.env.XDG_CONFIG_HOME;

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
            sandbox: { type: "local", root: remoteRoot, home: remoteHome },
          },
        }),
      );

      const fakeBin = join(localHome, "fakebin");
      mkdirSync(fakeBin);
      writeFileSync(join(fakeBin, "omp"), FAKE_OMP);
      chmodSync(join(fakeBin, "omp"), 0o755);
      const herdrPrefix = HERDR === null ? "" : `${dirname(HERDR)}:`;
      process.env.PATH =
        `${fakeBin}:${herdrPrefix}/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
      process.env.BEAM_HOME = localHome;
      process.env.BEAM_DIR = beamDir;
      process.chdir(workDir);
    });

    afterAll(async () => {
      // Best-effort: a failed test may leak a planted herdr server on the
      // uid-scoped socket — stop it there (`session stop` never reaches
      // the override socket) and delete every recorded session's registry
      // entry (delete is idempotent).
      if (HERDR !== null) {
        for (const record of loadState(resolveEnv()).records) {
          const name = record.runtimeSession;
          await herdrCtl(name, "server", "stop");
          await herdrCtl(name, "session", "delete", name, "--json");
        }
      }
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
        await plantLiveSession(theRecord().runtimeSession);

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

        await killPlantedSession(record.runtimeSession);
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
