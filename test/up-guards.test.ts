/**
 * Goal: behavioral contracts of the up/kill/login command layer:
 *  - a retry with omitted args retains the record's stored session identity
 *    and kickoff, even when auto-detection would pick a newer session;
 *  - an explicit identity switch/clear on a shipped record fails BEFORE any
 *    remote effect — nothing ships, the record is untouched;
 *  - `beam up`/`beam login` recover a live handoff through its persisted
 *    spec snapshot after the config target was removed, while a NEW handoff
 *    still requires current config;
 *  - `--help`/`-h` on kill and login are inert: help text only, no state,
 *    no lock, no transport.
 *
 * Method: real `cmdUp`/`cmdKill`/`cmdLogin` over the local transport inside
 * hermetic BEAM_HOME/BEAM_DIR temp fixtures, with a stub `omp` (bare exit 0)
 * and real-herdr liveness probes hitting the runtime's uid-scoped socket
 * (`$TMPDIR/herdr-<uid>/<session>.sock`; registry under the fixture's
 * remote HOME);
 * console output is captured by wrapping console.log; suites needing
 * herdr/rsync are `describe.skipIf`-gated with an explicit 30s
 * real-process timeout.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cmdKill, cmdLogin } from "../src/commands/misc.ts";
import { cmdUp } from "../src/commands/up.ts";
import { resolveEnv, type BeamEnv } from "../src/env.ts";
import {
  acquireOperationLock,
  addRecord,
  getRecord,
  loadState,
  type BeamRecord,
} from "../src/state.ts";
import { remoteWorkspaceName } from "../src/workspace.ts";

const HERDR = Bun.which("herdr");
const HAVE_DEPS = HERDR !== null && Bun.which("rsync") !== null;

// Explicit real-process budget for every gated test below: a local rsync
// ship plus herdr probes — the same cost class e2e.test.ts budgets at 30s.
const ROUND_TRIP_TIMEOUT_MS = 30_000;

// fake omp: `beam login` runs it bare (exit 0 = done); --no-start means the
// resume path is never taken in these tests.
const FAKE_OMP = `#!/bin/bash
exit 0
`;

let localHome: string;
let beamDir: string;
let workDir: string;
let otherWorkDir: string;
let remoteHome: string;
let remoteRoot: string;
let remoteCwd: string;
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

/** Capture console.log output around one call (bun's spyOn misses console writes). */
async function captureLog<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const value = await fn();
    return { value, out: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

function theRecord(): BeamRecord {
  const { records } = loadState(resolveEnv());
  expect(records.length).toBe(1);
  return records[0]!;
}

describe.skipIf(!HAVE_DEPS)(
  "up identity/kickoff retention and target recovery (local transport)",
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

      localHome = realpathSync(mkdtempSync(join(tmpdir(), "beam-guards-home-")));
      remoteHome = realpathSync(mkdtempSync(join(tmpdir(), "beam-guards-rhome-")));
      remoteRoot = join(remoteHome, "beam-root");
      beamDir = join(localHome, ".beam");
      workDir = join(localHome, "work", "app");
      otherWorkDir = join(localHome, "work", "other");
      remoteCwd = join(remoteRoot, remoteWorkspaceName(workDir));

      mkdirSync(join(workDir, "src"), { recursive: true });
      mkdirSync(otherWorkDir, { recursive: true });
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

    afterAll(() => {
      process.chdir(savedCwd);
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    test("first up persists session identity and kickoff", async () => {
      await cmdUp(["--no-start", "-m", "first kickoff"]);

      const record = theRecord();
      expect(record.status).toBe("up");
      expect(record.tool).toBe("omp");
      expect(record.sessionId).toBe("sess-aaa");
      expect(record.kickoff).toBe("first kickoff");
      expect(readFileSync(join(remoteCwd, ".beam", "session.jsonl"), "utf8")).toContain("sess-aaa");
    }, ROUND_TRIP_TIMEOUT_MS);

    test(
      "an omitted-argument retry keeps stored identity but refuses to overwrite a shipped handoff",
      async () => {
        // A newer session appears locally: auto-detection would now pick it.
        writeSession("sess-bbb", "2026-08-02T10-00-00-000Z", 0);

        await expect(cmdUp(["--no-start"])).rejects.toThrow(/already up on sandbox/);

        const record = theRecord();
        expect(record.sessionId).toBe("sess-aaa"); // retained, not the newest
        expect(record.kickoff).toBe("first kickoff"); // omitted -m keeps the stored kickoff
        expect(record.status).toBe("up");
        expect(readFileSync(join(remoteCwd, ".beam", "session.jsonl"), "utf8")).toContain(
          "sess-aaa",
        );
      },
      ROUND_TRIP_TIMEOUT_MS,
    );

    test(
      "an explicit session switch on a shipped record fails without any remote mutation",
      async () => {
        writeFileSync(join(workDir, "not-shipped.txt"), "must never land remotely\n");
        const before = theRecord();

        await expect(cmdUp(["--no-start", "--session", "sess-bbb"])).rejects.toThrow(
          /already shipped session omp sess-aaa/,
        );

        const after = theRecord();
        expect(after.sessionId).toBe("sess-aaa");
        expect(after.kickoff).toBe("first kickoff");
        expect(after.status).toBe(before.status);
        // The refusal fired before the ship: the new local file never landed.
        expect(existsSync(join(remoteCwd, "not-shipped.txt"))).toBe(false);
        expect(readFileSync(join(remoteCwd, ".beam", "session.jsonl"), "utf8")).toContain(
          "sess-aaa",
        );
      },
      ROUND_TRIP_TIMEOUT_MS,
    );

    test("--no-session cannot clear the sole identity of a shipped record", async () => {
      await expect(cmdUp(["--no-start", "--no-session"])).rejects.toThrow(
        /--no-session would orphan/,
      );

      const record = theRecord();
      expect(record.sessionId).toBe("sess-aaa");
      expect(record.tool).toBe("omp");
      expect(existsSync(join(remoteCwd, "not-shipped.txt"))).toBe(false);
    }, ROUND_TRIP_TIMEOUT_MS);

    test("--no-session with a kickoff refuses up front: no agent could receive it", async () => {
      // Refused at argument parsing, before the reservation or any remote
      // effect: the record and the retained remote are untouched (#37).
      const before = JSON.stringify(theRecord());
      await expect(cmdUp(["--no-session", "-m", "go"])).rejects.toThrow(
        /--no-session ships the workspace only.*a kickoff message \(-m\) has nothing to receive/,
      );
      expect(JSON.stringify(theRecord())).toBe(before);
      expect(existsSync(join(remoteCwd, "not-shipped.txt"))).toBe(false);
    }, ROUND_TRIP_TIMEOUT_MS);

    test(
      "a NEW --message on a completed handoff refuses instead of silently dropping it",
      async () => {
        // The restart-in-place path replays the journaled resume argv
        // verbatim; an explicit different kickoff cannot ride it and must
        // refuse with the retire-first fix, never be silently ignored.
        await expect(cmdUp(["--no-start", "-m", "a different kickoff"])).rejects.toThrow(
          /a new --message cannot be applied/,
        );
        const record = theRecord();
        expect(record.kickoff).toBe("first kickoff"); // journaled kickoff untouched
        expect(record.status).toBe("up");
      },
      ROUND_TRIP_TIMEOUT_MS,
    );

    test(
      "up resolves the retained target snapshot after config removal and still refuses re-shipping",
      async () => {
        writeFileSync(join(beamDir, "config.json"), JSON.stringify({ targets: {} }));

        await expect(cmdUp(["--no-start"])).rejects.toThrow(/already up on sandbox/);

        const record = theRecord(); // still the SAME handoff, no second record
        expect(record.status).toBe("up");
        expect(record.sessionId).toBe("sess-aaa");
        // Recovery used the persisted target, but the completed ship remained
        // immutable: the local-only file never overwrote the retained remote.
        expect(existsSync(join(remoteCwd, "not-shipped.txt"))).toBe(false);
      },
      ROUND_TRIP_TIMEOUT_MS,
    );

    test(
      "a new handoff still requires current config — recovery never authors records",
      async () => {
        process.chdir(otherWorkDir);
        try {
          await expect(cmdUp(["--no-start", "--no-session"])).rejects.toThrow(
            /no targets configured/,
          );
        } finally {
          process.chdir(workDir);
        }
        expect(loadState(resolveEnv()).records.length).toBe(1);
      },
      ROUND_TRIP_TIMEOUT_MS,
    );

    test(
      "login recovers through the live handoff's snapshot when the config target is gone",
      async () => {
        const { out } = await captureLog(() => cmdLogin([]));
        expect(out).toContain("on sandbox"); // bound to the recorded target name
      },
      ROUND_TRIP_TIMEOUT_MS,
    );
  },
);

describe("kill/login --help is inert", () => {
  test("beam kill --help prints help without touching state, locks, or records", async () => {
    const saved = process.env.BEAM_DIR;
    const home = mkdtempSync(join(tmpdir(), "beam-help-"));
    const env: BeamEnv = { home, beamDir: join(home, ".beam") };
    process.env.BEAM_DIR = env.beamDir;
    try {
      // No state at all: previously this threw "no beamed sessions yet".
      const first = await captureLog(() => cmdKill(["--help"]));
      expect(existsSync(env.beamDir)).toBe(false); // nothing created
      expect(first.out).toContain("beam kill —");
      expect(first.out).toContain("--purge");
      // The retained-generation contract is user-facing help text: kill
      // without --purge retains the shipped generation, a later `beam up`
      // restarts it in place with ZERO local re-ship, and new local bytes
      // require collect + explicit kill --purge + a new up.
      expect(first.out).toContain("RETAINED");
      expect(first.out).toContain("ZERO");
      expect(first.out).toContain("restarts the exact remote generation in place");
      expect(first.out).toContain("collect first");
      expect(first.out).toMatch(/kill <id> --purge/);
      expect(first.out).not.toContain("down --purge");

      // A live record whose operation lock is HELD: help must not contend
      // the lock, select the record, or change its status.
      const now = new Date().toISOString();
      addRecord(env, {
        id: "livekl",
        target: "sandbox",
        localCwd: "/w",
        remoteCwd: "/r/ws",
        runtimeSession: "beam-livekl",
        status: "up",
        createdAt: now,
        updatedAt: now,
      });
      const release = acquireOperationLock(env, "livekl");
      try {
        const second = await captureLog(() => cmdKill(["-h"]));
        expect(second.out).toContain("beam kill —");
      } finally {
        release();
      }
      expect(getRecord(env, "livekl").status).toBe("up");
    } finally {
      if (saved === undefined) delete process.env.BEAM_DIR;
      else process.env.BEAM_DIR = saved;
    }
  });

  test("beam login --help prints help without config, targets, or transport", async () => {
    const saved = process.env.BEAM_DIR;
    const home = mkdtempSync(join(tmpdir(), "beam-help-"));
    process.env.BEAM_DIR = join(home, ".beam");
    try {
      // No config at all: previously this threw "no targets configured".
      const long = await captureLog(() => cmdLogin(["--help"]));
      const short = await captureLog(() => cmdLogin(["-h"]));
      expect(existsSync(join(home, ".beam"))).toBe(false);
      expect(long.out).toContain("beam login —");
      expect(long.out).toContain("--tool");
      expect(short.out).toContain("beam login —");
    } finally {
      if (saved === undefined) delete process.env.BEAM_DIR;
      else process.env.BEAM_DIR = saved;
    }
  });
});

describe("kill --purge finalization", () => {
  test("an unshipped record's kill reaps its pending journal and stage", async () => {
    const saved = process.env.BEAM_DIR;
    const home = mkdtempSync(join(tmpdir(), "beam-killfinal-"));
    const env: BeamEnv = { home, beamDir: join(home, ".beam") };
    process.env.BEAM_DIR = env.beamDir;
    try {
      // A provisioning record whose remote cwd never resolved: kill --purge
      // takes the destroy-only path (no transport), but the record still
      // carries a pending-ship journal and its local stage from the crashed
      // attempt — both must die with the handoff, not outlive it forever.
      const now = new Date().toISOString();
      addRecord(env, {
        id: "kf1",
        target: "sandbox",
        localCwd: join(home, "work"),
        remoteCwd: "/never/resolved",
        remoteCwdResolved: false,
        runtimeSession: "beam-kf1",
        status: "provisioning",
        createdAt: now,
        updatedAt: now,
        targetSpec: { type: "local", root: join(home, "remote-root"), home },
        shipPending: { workspaceDigest: "d".repeat(64) },
      });
      const stage = join(env.beamDir, "ship-stage", "kf1");
      mkdirSync(stage, { recursive: true });
      writeFileSync(join(stage, "transcript.jsonl"), "{}\n");

      await captureLog(() => cmdKill(["kf1", "--purge"]));

      const record = getRecord(env, "kf1");
      expect(record.status).toBe("killed");
      expect(record.shipPending).toBeUndefined();
      expect(existsSync(stage)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.BEAM_DIR;
      else process.env.BEAM_DIR = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
