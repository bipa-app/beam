#!/usr/bin/env bun
/**
 * Build one hermetic eval fixture for the beam skill evals: a BEAM_HOME with
 * a local-transport target, a planted omp session store, a stub `omp`
 * binary, and — depending on the case — a pre-created handoff in a specific
 * state (idle, holding remote work, interrupted mid-ship, contended by a
 * live writer). Prints fixture paths and planted ids as JSON on stdout.
 *
 * Cases:
 *   0 first handoff, fat build dir            3 stale slot holding REAL remote work
 *   1 exclusive slot held by stale handoff    4 interrupted ship (pending journal)
 *   2 idle remote agent (no kickoff)          5 torn snapshot under a live writer
 *                                             6 oversized mirror (>2 GiB guard)
 *                                             7 finished remote work: full round trip
 *
 * usage: bun setup.ts --eval <0..7> --dest <empty-or-new dir>
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { eval: { type: "string" }, dest: { type: "string" } },
});
const evalId = Number(values.eval);
const dest = values.dest;
if (!Number.isInteger(evalId) || evalId < 0 || evalId > 7 || dest === undefined) {
  throw new Error("usage: bun setup.ts --eval <0..7> --dest <dir>");
}

const home = join(dest, "home");
const beamDir = join(home, ".beam");
const workDir = join(home, "work", "app");
const binDir = join(dest, "bin");
const remoteHome = join(dest, "remote-home");
const remoteRoot = join(remoteHome, "beam-root");

for (const d of [beamDir, join(workDir, "src"), join(workDir, "target"), binDir, remoteHome]) {
  mkdirSync(d, { recursive: true });
}

writeFileSync(
  join(beamDir, "config.json"),
  JSON.stringify(
    {
      defaultTarget: "sandbox",
      targets: { sandbox: { type: "local", root: remoteRoot, home: remoteHome } },
    },
    null,
    2,
  ),
);

// The workspace: plausible source plus a build dir sized per case.
writeFileSync(
  join(workDir, "src", "main.ts"),
  `export class FooClient {\n  get(url: string) {\n    return fetch(url);\n  }\n}\n`,
);
writeFileSync(
  join(workDir, "src", "http.ts"),
  `export async function request(url: string) {\n  return fetch(url);\n}\n`,
);
writeFileSync(join(workDir, "package.json"), `{ "name": "app", "scripts": { "test": "true" } }\n`);

// Build-dir weight: eval 0 makes exclusion visibly matter; eval 6 crosses
// the 2 GiB refusal ceiling; the rest stay light. Written in 128 MiB
// chunks to keep peak memory bounded.
const CHUNK_BYTES = 128 * 1024 * 1024;
function writeBlob(path: string, chunks: number): void {
  writeFileSync(path, "");
  const chunk = Buffer.alloc(CHUNK_BYTES);
  for (let i = 0; i < chunks; i += 1) appendFileSync(path, chunk);
}
if (evalId === 0) writeBlob(join(workDir, "target", "debug.bin"), 2); // 256 MiB
else if (evalId === 6) writeBlob(join(workDir, "target", "release.bin"), 17); // 2.125 GiB
else writeFileSync(join(workDir, "target", "debug.bin"), Buffer.alloc(16 * 1024 * 1024));

// Stub harnesses. "idle" mimics a resumed agent waiting at its prompt;
// "worker" mimics an agent that finishes real work: it writes a result
// file into its cwd (the remote workspace), appends a line to the shipped
// transcript, then idles. Both are lifetime-bounded.
const IDLE_STUB = `#!/bin/bash
echo "omp (stub) resumed session $*"
echo "> waiting for input"
exec sleep 600
`;
const WORKER_STUB = `#!/bin/bash
echo "omp (stub) resumed session $*"
printf '# Remote result\\n\\nREMOTE_MARKER_DONE: parser notes and migration plan.\\n' \\
  > "$PWD/REMOTE_RESULT.md"
printf '%s\\n' '{"type":"message","id":"r-done","text":"REMOTE_MARKER_DONE work finished"}' \\
  >> "$PWD/.beam/session.jsonl"
echo "task complete; results written"
exec sleep 600
`;
const stub = evalId === 3 || evalId === 7 ? WORKER_STUB : IDLE_STUB;
writeFileSync(join(binDir, "omp"), stub);
chmodSync(join(binDir, "omp"), 0o755);

/** Plant an omp session transcript the adapter will locate for workDir. */
function plantSession(id: string, stamp: string, ageSeconds: number): void {
  const storeDir = join(home, ".omp", "agent", "sessions", "-work-app");
  mkdirSync(storeDir, { recursive: true });
  const file = join(storeDir, `${stamp}_${id}.jsonl`);
  writeFileSync(
    file,
    `{"type":"session","version":3,"id":"${id}","timestamp":"t","cwd":"${workDir}"}\n` +
      `{"type":"message","id":"m1","text":"local work in progress"}\n`,
  );
  const when = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(file, when, when);
}

/** Run the installed beam CLI against the fixture (fixture bin first on PATH). */
async function beam(
  args: string[],
  o: { extraPathDir?: string; expectFailure?: boolean } = {},
): Promise<string> {
  const prefix = o.extraPathDir === undefined ? "" : `${o.extraPathDir}:`;
  const proc = Bun.spawn(["beam", ...args], {
    cwd: workDir,
    env: {
      ...process.env,
      BEAM_HOME: home,
      BEAM_DIR: beamDir,
      PATH: `${prefix}${binDir}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  if (!o.expectFailure && code !== 0) {
    throw new Error(`setup beam ${args[0]} failed:\n${stderr}`);
  }
  if (o.expectFailure && code === 0) {
    throw new Error(`setup beam ${args.join(" ")} unexpectedly succeeded`);
  }
  return (await new Response(proc.stdout).text()) + stderr;
}

interface PlantedRecord {
  id: string;
  status: string;
  remoteCwd: string;
  shipPending?: unknown;
}

function records(): PlantedRecord[] {
  const statePath = join(beamDir, "state.json");
  if (!existsSync(statePath)) return [];
  return JSON.parse(readFileSync(statePath, "utf8")).records as PlantedRecord[];
}

/** Bounded wait for the worker stub's remote side effect. */
const REMOTE_WORK_WAIT_MS = 15_000;
async function waitForRemoteFile(remoteCwd: string, name: string): Promise<void> {
  const deadline = Date.now() + REMOTE_WORK_WAIT_MS;
  while (Date.now() < deadline) {
    if (existsSync(join(remoteCwd, name))) return;
    await Bun.sleep(200);
  }
  throw new Error(`setup: ${name} never appeared in ${remoteCwd}`);
}

const extra: Record<string, string> = {};

if (evalId === 0) {
  plantSession("sess-aaa11", "2026-08-28T10-00-00-000Z", 300);
}
if (evalId === 1) {
  plantSession("sess-old77", "2026-08-27T09-00-00-000Z", 86_400);
  await beam(["up", "--tool", "omp", "--session", "sess-old77"]);
  plantSession("sess-new42", "2026-08-28T11-00-00-000Z", 60);
  extra.priorHandoffNote = "a handoff from yesterday holds the sandbox slot";
}
if (evalId === 2) {
  plantSession("sess-idle9", "2026-08-28T09-30-00-000Z", 3_600);
  await beam(["up", "--tool", "omp", "--session", "sess-idle9"]);
  extra.priorHandoffNote = "an up handoff exists; it was shipped without any kickoff";
}
if (evalId === 3) {
  // Stale handoff that DID produce remote work: retiring it blindly loses
  // REMOTE_RESULT.md; the correct path collects before purging.
  plantSession("sess-one88", "2026-08-27T08-00-00-000Z", 86_400);
  await beam([
    "up",
    "--tool",
    "omp",
    "--session",
    "sess-one88",
    "-m",
    "Refactor the parser and write up your notes.",
  ]);
  const shipped = records()[0];
  if (shipped === undefined) throw new Error("setup: eval 3 ship left no record");
  await waitForRemoteFile(shipped.remoteCwd, "REMOTE_RESULT.md");
  plantSession("sess-two99", "2026-08-28T11-00-00-000Z", 60);
  extra.oldHandoffId = shipped.id;
}
if (evalId === 4) {
  // Interrupt the ship AFTER the pending-generation journal: a scripted
  // rsync fails only the upload leg (its argv carries the immutable
  // beam-shipstage- source; the size preflight and stage passes do not).
  plantSession("sess-pag55", "2026-08-28T09-00-00-000Z", 1_800);
  const failBin = join(dest, "failbin");
  mkdirSync(failBin, { recursive: true });
  const realRsync = Bun.which("rsync");
  if (realRsync === null) throw new Error("setup: rsync not installed");
  writeFileSync(
    join(failBin, "rsync"),
    `#!/bin/bash\ncase "$*" in *beam-shipstage-*) exit 23;; esac\nexec "${realRsync}" "$@"\n`,
  );
  chmodSync(join(failBin, "rsync"), 0o755);
  await beam(
    [
      "up",
      "--tool",
      "omp",
      "--session",
      "sess-pag55",
      "-m",
      "Add pagination to the list endpoints and update the tests.",
    ],
    { extraPathDir: failBin, expectFailure: true },
  );
  const interrupted = records()[0];
  if (interrupted === undefined) throw new Error("setup: eval 4 left no record");
  if (interrupted.status !== "provisioning" || interrupted.shipPending === undefined) {
    throw new Error(
      `setup: eval 4 expected an interrupted ship (provisioning + shipPending), got ` +
        `${interrupted.status} pending=${interrupted.shipPending !== undefined}`,
    );
  }
  extra.interruptedHandoffId = interrupted.id;
}
if (evalId === 5) {
  // A live writer keeps mutating the tree: every stage attempt refuses as
  // a torn snapshot until the writer dies. Lifetime-bounded to 15 min.
  plantSession("sess-gen33", "2026-08-28T10-30-00-000Z", 900);
  const writerScript = join(dest, "codegen-watch.sh");
  writeFileSync(
    writerScript,
    `#!/bin/bash\n# codegen watcher (eval fixture): regenerates src/generated.ts continuously.\n` +
      `end=$((SECONDS+900))\nwhile [ $SECONDS -lt $end ]; do\n` +
      `  date +%s%N > "${workDir}/src/generated.ts"\n  sleep 0.02\ndone\n`,
  );
  chmodSync(writerScript, 0o755);
  const writer = Bun.spawn(["bash", writerScript], {
    cwd: workDir,
    stdout: "ignore",
    stderr: "ignore",
  });
  writer.unref();
  writeFileSync(join(dest, "writer.pid"), String(writer.pid));
  extra.writerPid = String(writer.pid);
  extra.writerHint = "the user's codegen watcher may still be running (see codegen-watch.sh)";
}
if (evalId === 6) {
  plantSession("sess-big66", "2026-08-28T10-15-00-000Z", 600);
}
if (evalId === 7) {
  // A finished remote handoff: the worker stub already wrote its result
  // and grew the transcript. The task is the return leg.
  plantSession("sess-rt110", "2026-08-28T08-00-00-000Z", 7_200);
  await beam([
    "up",
    "--tool",
    "omp",
    "--session",
    "sess-rt110",
    "-m",
    "Write the migration plan into REMOTE_RESULT.md.",
  ]);
  const shipped = records()[0];
  if (shipped === undefined) throw new Error("setup: eval 7 ship left no record");
  await waitForRemoteFile(shipped.remoteCwd, "REMOTE_RESULT.md");
  extra.finishedHandoffId = shipped.id;
}

console.log(JSON.stringify({ home, beamDir, workDir, binDir, remoteRoot, ...extra }, null, 2));
