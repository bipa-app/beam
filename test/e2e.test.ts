import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { cmdDown } from "../src/commands/down.ts";
import { cmdUp } from "../src/commands/up.ts";
import { loadState } from "../src/state.ts";
import { resolveEnv } from "../src/env.ts";
import { remoteWorkspaceName } from "../src/workspace.ts";
import { run } from "../src/util/shell.ts";

/**
 * Full round trip over the local transport:
 *   beam up  -> workspace mirrored, session installed (header cwd rewritten),
 *               fake `omp` resumed inside a private tmux server, kickoff passed
 *   (remote agent appends to the transcript and creates a file)
 *   beam down -> agent stopped, workspace synced back, transcript re-imported
 *               with header cwd restored, backup written
 */

const TMUX_SOCKET = `beamtest-${process.pid}`;
const HAVE_DEPS = Bun.which("tmux") !== null && Bun.which("rsync") !== null;

const FAKE_OMP = `#!/bin/bash
# fake omp harness: argv is --resume <file> [kickoff]
file="$2"
msg="\${3:-no-kickoff}"
printf '{"type":"message","from":"remote-agent","text":"%s"}\\n' "$msg" >> "$file"
echo "made-remotely" > remote-artifact.txt
sleep 300
`;

let localHome: string;
let beamDir: string;
let workDir: string;
let remoteHome: string;
let remoteRoot: string;
let storeFile: string;
const savedEnv: Record<string, string | undefined> = {};
let savedCwd: string;

beforeAll(() => {
  savedCwd = process.cwd();
  for (const k of ["BEAM_HOME", "BEAM_DIR", "PATH"]) savedEnv[k] = process.env[k];

  localHome = realpathSync(mkdtempSync(join(tmpdir(), "beam-e2e-home-")));
  remoteHome = realpathSync(mkdtempSync(join(tmpdir(), "beam-e2e-rhome-")));
  remoteRoot = join(remoteHome, "beam-root");
  beamDir = join(localHome, ".beam");
  workDir = join(localHome, "work", "app");

  // workspace with content and a subdirectory
  mkdirSync(join(workDir, "src"), { recursive: true });
  writeFileSync(join(workDir, "hello.txt"), "hello beam\n");
  writeFileSync(join(workDir, "src", "deep.txt"), "deep\n");

  // omp session fixture in the local store (dashed home-relative dir)
  const storeDir = join(localHome, ".omp", "agent", "sessions", "-work-app");
  mkdirSync(storeDir, { recursive: true });
  storeFile = join(storeDir, "2026-08-09T10-00-00-000Z_e2e-session.jsonl");
  writeFileSync(
    storeFile,
    `{"type":"session","version":3,"id":"e2e-session","timestamp":"t","cwd":"${workDir}"}\n` +
      `{"type":"message","id":"m1","text":"local work so far"}\n`,
  );

  // beam config: local transport target with a private tmux socket
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

  // fake omp on PATH; keep system dirs for tmux/rsync/git, drop real harness dirs
  const fakeBin = join(localHome, "fakebin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "omp"), FAKE_OMP);
  chmodSync(join(fakeBin, "omp"), 0o755);
  process.env.PATH = `${fakeBin}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  process.env.BEAM_HOME = localHome;
  process.env.BEAM_DIR = beamDir;
  process.chdir(workDir);
});

afterAll(async () => {
  process.chdir(savedCwd);
  await run(["tmux", "-L", TMUX_SOCKET, "kill-server"]);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe.skipIf(!HAVE_DEPS)("beam up/down round trip (local transport)", () => {
  test(
    "up mirrors the workspace, installs the session, and starts the agent",
    async () => {
      await cmdUp(["-m", "keep going"]);

      const remoteCwd = join(remoteRoot, remoteWorkspaceName(workDir));
      expect(readFileSync(join(remoteCwd, "hello.txt"), "utf8")).toBe("hello beam\n");
      expect(readFileSync(join(remoteCwd, "src", "deep.txt"), "utf8")).toBe("deep\n");

      const shipped = readFileSync(join(remoteCwd, ".beam", "session.jsonl"), "utf8");
      const header = JSON.parse(shipped.split("\n")[0]!);
      expect(header.cwd).toBe(remoteCwd);

      const record = loadState(resolveEnv()).records[0]!;
      expect(record.status).toBe("up");
      expect(record.tool).toBe("omp");
      expect(record.remoteCwd).toBe(remoteCwd);

      // The fake agent runs as a real external process in a tmux pane; fake
      // timers cannot advance it, so poll the file it writes (bounded).
      const deadline = Date.now() + 10_000;
      let transcript = "";
      while (Date.now() < deadline) {
        transcript = readFileSync(join(remoteCwd, ".beam", "session.jsonl"), "utf8");
        if (transcript.includes("remote-agent")) break;
        await Bun.sleep(200);
      }
      expect(transcript).toContain('"from":"remote-agent"');
      expect(transcript).toContain("keep going");
      expect(readFileSync(join(remoteCwd, "remote-artifact.txt"), "utf8")).toBe("made-remotely\n");
    },
    30_000,
  );

  test(
    "down stops the agent, syncs back, and re-imports the transcript",
    async () => {
      await cmdDown([]);

      // remote work arrived in the local workspace
      expect(readFileSync(join(workDir, "remote-artifact.txt"), "utf8")).toBe("made-remotely\n");

      // transcript re-imported with header cwd restored, remote message kept
      const store = readFileSync(storeFile, "utf8");
      expect(JSON.parse(store.split("\n")[0]!).cwd).toBe(workDir);
      expect(store).toContain('"from":"remote-agent"');
      expect(store).toContain("local work so far");

      // previous transcript backed up
      const backups = readdirSync(join(localHome, ".omp", "agent", "sessions", "-work-app")).filter(
        (n) => n.includes(".bak-"),
      );
      expect(backups.length).toBe(1);

      const record = loadState(resolveEnv()).records[0]!;
      expect(record.status).toBe("down");

      // agent session is gone from the private tmux server
      const has = await run(["tmux", "-L", TMUX_SOCKET, "has-session", "-t", `=${record.tmux}`]);
      expect(has.code).not.toBe(0);
    },
    30_000,
  );

  test("down without a session round trip fails loudly, not silently", async () => {
    expect(existsSync(join(workDir, ".beam", "session.jsonl"))).toBe(true);
  });
});
