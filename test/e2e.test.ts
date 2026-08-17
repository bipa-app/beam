/**
 * Goal: the full round trip over the local transport proves up → remote
 * work → down fidelity (the merge gate): `beam up` mirrors the workspace,
 * installs the session with its header cwd rewritten, and resumes a fake
 * `omp` inside a private tmux server with the kickoff passed; the remote
 * agent appends to the transcript and creates a file; `beam down` stops
 * the agent and verifies the workspace AND the grown transcript into a
 * persisted return stage, leaving the live workspace and session store
 * untouched and resumable straight off the returned path.
 *
 * Method: real `cmdUp`/`cmdDown` against a LocalTransport, a bash fake-omp
 * on a private `tmux -L` socket, and hermetic BEAM_HOME/BEAM_DIR fixtures;
 * `describe.skipIf` skips when tmux/rsync are absent, and a bounded poll
 * with an explicit timeout awaits the genuinely external tmux agent.
 */
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
import { run, shq } from "../src/util/shell.ts";

const TMUX_SOCKET = `beamtest-${process.pid}`;
const HAVE_DEPS = Bun.which("tmux") !== null && Bun.which("rsync") !== null;

const FAKE_OMP = `#!/bin/bash
# fake omp harness: argv is --resume <file> [kickoff]
file="$2"
msg="\${3:-no-kickoff}"
printf '{"type":"message","from":"remote-agent","text":"%s"}\\n' "$msg" >> "$file"
# real omp writes a sibling artifacts dir next to the transcript
mkdir -p "\${file%.jsonl}"
echo "artifact-blob" > "\${file%.jsonl}/note.txt"
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
      // timers cannot advance it, so poll for its LAST write (bounded) —
      // once remote-artifact.txt exists, the transcript append and the
      // artifacts dir are already on disk.
      const deadline = Date.now() + 10_000;
      let transcript = "";
      while (Date.now() < deadline) {
        transcript = readFileSync(join(remoteCwd, ".beam", "session.jsonl"), "utf8");
        if (transcript.includes("remote-agent")) {
          if (existsSync(join(remoteCwd, "remote-artifact.txt"))) break;
        }
        await Bun.sleep(200);
      }
      expect(transcript).toContain('"from":"remote-agent"');
      expect(transcript).toContain("keep going");
      expect(readFileSync(join(remoteCwd, "remote-artifact.txt"), "utf8")).toBe("made-remotely\n");
    },
    30_000,
  );

  test(
    "down stops the agent, stages workspace AND session returns durably, and never" +
      " touches local stores",
    async () => {
      const storeBefore = readFileSync(storeFile, "utf8");
      await cmdDown([]);

      const record = loadState(resolveEnv()).records[0]!;
      const txn = readdirSync(join(beamDir, "returns", record.id)).sort().at(-1)!;
      const stagedWorkspace = join(beamDir, "returns", record.id, txn, "workspace");
      // Remote work is in the verified stage; the live workspace was never
      // pointed at by the return transport.
      expect(existsSync(join(workDir, "remote-artifact.txt"))).toBe(false);
      expect(
        readFileSync(join(stagedWorkspace, "remote-artifact.txt"), "utf8"),
      ).toBe("made-remotely\n");

      // The session return shares the same txn root: grown transcript with
      // the header localized for local resume, artifacts alongside.
      expect(record.collect).toBeDefined();
      const returnDir = record.collect!.returnDir;
      expect(returnDir).toBe(join(beamDir, "returns", record.id, txn, "session"));
      const returned = readFileSync(join(returnDir, "session.jsonl"), "utf8");
      expect(JSON.parse(returned.split("\n")[0]!).cwd).toBe(workDir);
      expect(returned).toContain('"from":"remote-agent"');
      expect(returned).toContain("local work so far");
      // remote-created artifacts (none existed locally) came back in the return
      expect(
        readFileSync(join(returnDir, "artifacts", "note.txt"), "utf8"),
      ).toBe("artifact-blob\n");
      // the hint resumes straight off the durable return
      expect(record.collect!.hint).toBe(`omp --resume ${shq(join(returnDir, "session.jsonl"))}`);

      // The local harness store was NEVER touched: same bytes, no backups,
      // no artifacts imported next to it.
      expect(readFileSync(storeFile, "utf8")).toBe(storeBefore);
      const storeEntries = readdirSync(join(localHome, ".omp", "agent", "sessions", "-work-app"));
      expect(storeEntries.filter((n) => n.includes(".bak-"))).toEqual([]);
      expect(existsSync(storeFile.slice(0, -".jsonl".length))).toBe(false);

      expect(record.status).toBe("up");

      // agent session is gone from the private tmux server
      const has = await run(["tmux", "-L", TMUX_SOCKET, "has-session", "-t", `=${record.tmux}`]);
      expect(has.code).not.toBe(0);

      // Down is non-destructive: the verified remote mirror stays available
      // for another collection until an explicit `beam kill --purge`.
      expect(existsSync(join(remoteRoot, remoteWorkspaceName(workDir)))).toBe(true);
    },
    30_000,
  );

  test("beam-reserved scratch never lands in the local workspace — the transcript" +
    " lives in the store", () => {
    // The grown transcript was fetched over the transport's file channel
    // into the durable return stage; the filtered mirror never carries
    // `.beam`, so no stale scratch is left behind to shadow a future
    // handoff's state.
    expect(existsSync(join(workDir, ".beam"))).toBe(false);
  }, 30_000);
});
