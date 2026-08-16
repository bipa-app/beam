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
import type { WtGitShipInfo } from "../src/workspace-git.ts";

/**
 * Reused-record wtGit deferral: a record that already carries a
 * linked-worktree ship identity (`wtGit`) must keep it BYTE-FOR-BYTE
 * unchanged through every refused re-ship — `beam down` keys its git-state
 * return off that identity, and the remote side still holds exactly what
 * the prior ship sent out. Only a re-ship that actually begins (all
 * liveness, session-identity, and remote-operation gates passed, record
 * dropping back to `provisioning`) may update or clear it.
 *
 * The refusal paths exercised, in order:
 *   - explicit session switch          (pre-provision identity gate)
 *   - --no-session orphan              (pre-provision identity gate)
 *   - live agent on a reused sandbox   (tmux liveness gate)
 *   - starting + live agent finalize   (early return, nothing re-shipped)
 *   - retained session missing         (pre-provision identity gate)
 *   - starting + dead agent finalize   (early return — an answerable
 *     `starting` is a COMPLETED ship either way; recovery is `beam down`,
 *     never a re-ship over remote work)
 *
 * The workspace here is a PLAIN directory, which is exactly the trigger:
 * before the fix, `beam up` cleared `wtGit` unconditionally at the top of
 * the command (layout-change clear), so every refusal above wiped the
 * stored identity.
 */

const TMUX_SOCKET = `beamwtgit-${process.pid}`;
const HAVE_DEPS = Bun.which("tmux") !== null && Bun.which("rsync") !== null;

// fake omp: --no-start means the resume path is never taken in these tests.
const FAKE_OMP = `#!/bin/bash
exit 0
`;

const SEEDED_WTGIT: WtGitShipInfo = {
  head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  branch: "refs/heads/main",
  commonDir: "/prior/ship/common/.git",
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

function tmux(...args: string[]): void {
  const res = Bun.spawnSync(["tmux", "-L", TMUX_SOCKET, ...args]);
  if (res.exitCode !== 0) {
    throw new Error(`tmux ${args.join(" ")} exited ${res.exitCode}: ${res.stderr.toString()}`);
  }
}

describe.skipIf(!HAVE_DEPS)("reused-record wtGit survives every refused re-ship (local transport)", () => {
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

    // Simulate the prior ship having been a linked worktree.
    updateRecord(resolveEnv(), record.id, { wtGit: SEEDED_WTGIT });
    expect(wtGitBytes()).toBe(SEEDED_BYTES);
  });

  test("explicit session switch refusal leaves wtGit byte-for-byte unchanged", async () => {
    writeSession("sess-bbb", "2026-08-02T10-00-00-000Z", 0);

    await expect(cmdUp(["--no-start", "--session", "sess-bbb"])).rejects.toThrow(/already shipped session/);

    expect(wtGitBytes()).toBe(SEEDED_BYTES);
    expect(theRecord().status).toBe("up");
  });

  test("--no-session orphan refusal leaves wtGit unchanged", async () => {
    await expect(cmdUp(["--no-start", "--no-session"])).rejects.toThrow(/--no-session would orphan/);

    expect(wtGitBytes()).toBe(SEEDED_BYTES);
  });

  test("live-agent refusal leaves wtGit unchanged", async () => {
    tmux("new-session", "-d", "-s", theRecord().tmux, "sleep 300");

    await expect(cmdUp(["--no-start"])).rejects.toThrow(/already has a live agent/);

    expect(wtGitBytes()).toBe(SEEDED_BYTES);
    expect(theRecord().status).toBe("up");
  });

  test("finalizing an interrupted handoff (starting + live agent) never touches wtGit", async () => {
    const record = theRecord();
    updateRecord(resolveEnv(), record.id, { status: "starting" });

    await cmdUp(["--no-start"]); // finalize path: nothing re-shipped

    const after = theRecord();
    expect(after.status).toBe("up");
    expect(after.sessionId).toBe("sess-aaa"); // identity untouched by the finalize
    expect(wtGitBytes()).toBe(SEEDED_BYTES);

    tmux("kill-session", "-t", `=${record.tmux}`);
  });

  test("missing retained session refuses before any wtGit mutation (pre-provision gate)", async () => {
    rmSync(join(storeDir, "2026-08-01T10-00-00-000Z_sess-aaa.jsonl"));

    await expect(cmdUp(["--no-start"])).rejects.toThrow(/no longer exists locally/);

    expect(wtGitBytes()).toBe(SEEDED_BYTES);
    expect(theRecord().status).toBe("up");
  });

  test("starting + dead agent finalizes to up — remote work preserved, nothing re-shipped", async () => {
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
  });

  test("a permitted re-ship clears the stale wtGit exactly when it begins", async () => {
    writeSession("sess-aaa", "2026-08-01T10-00-00-000Z", 600); // retained session is back

    // Status `up`, dead agent, gates pass: this re-ship really runs. The
    // remote-operation probe answers "none" (a plain-dir ship landed no
    // remote `.git`), and the workspace being a plain directory now means
    // the re-ship must CLEAR the stale linked-worktree identity so `beam
    // down` won't key a git return off a layout this ship never had.
    await cmdUp(["--no-start"]);

    const record = theRecord();
    expect(record.status).toBe("up");
    expect(record.sessionId).toBe("sess-aaa"); // retained, not the newer sess-bbb
    expect(record.wtGit).toBeUndefined();
  });

  test("beam down recovers the live handoff's remote work", async () => {
    const record = theRecord();
    // Remote agent work made after the re-ship: down must bring it home.
    writeFileSync(join(record.remoteCwd, "remote-work-2.txt"), "made remotely\n");

    await cmdDown([record.id]);

    expect(theRecord().status).toBe("down");
    expect(readFileSync(join(workDir, "remote-work-2.txt"), "utf8")).toBe("made remotely\n");
    expect(existsSync(record.remoteCwd)).toBe(false); // collected, then purged
  });
});
