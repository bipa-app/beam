#!/usr/bin/env bun
/**
 * Grade one beam-skill eval run from its fixture's observable end state
 * (beam state.json, .beamignore, the local-transport "remote" workspace,
 * staged returns) plus the subagent's report. Writes grading.json shaped
 * for the skill-creator viewer: expectations[] with text/passed/evidence.
 *
 * usage: bun grade.ts --eval <0..7> --fixture <dir> --report <file|-> --out <grading.json>
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    eval: { type: "string" },
    fixture: { type: "string" },
    report: { type: "string" },
    out: { type: "string" },
  },
});
const evalId = Number(values.eval);
const fixture = values.fixture;
const out = values.out;
if (!Number.isInteger(evalId) || fixture === undefined || out === undefined) {
  throw new Error("usage: bun grade.ts --eval <n> --fixture <dir> --report <file> --out <file>");
}

interface Expectation {
  text: string;
  passed: boolean;
  evidence: string;
}

interface RecordShape {
  id: string;
  status: string;
  sessionId?: string;
  kickoff?: string;
  remoteCwd: string;
  resumeArgv?: string[];
  shipPending?: unknown;
  syncedExcludes?: string[];
}

const home = join(fixture, "home");
const beamDir = join(home, ".beam");
const statePath = join(beamDir, "state.json");
const workDir = join(home, "work", "app");
const records: RecordShape[] = existsSync(statePath)
  ? (JSON.parse(readFileSync(statePath, "utf8")).records as RecordShape[])
  : [];
const ups = records.filter((r) => r.status === "up");
const up = ups[0];
const report =
  values.report !== undefined && values.report !== "-" && existsSync(values.report)
    ? readFileSync(values.report, "utf8")
    : "";
const fixtureMetaPath = join(fixture, "fixture.json");
const fixtureMeta: Record<string, string> = existsSync(fixtureMetaPath)
  ? JSON.parse(readFileSync(fixtureMetaPath, "utf8"))
  : {};

function describeRecords(): string {
  if (records.length === 0) return "no beam records exist";
  return records
    .map((r) => `${r.id}:${r.status} session=${r.sessionId} kickoff=${JSON.stringify(r.kickoff)}`)
    .join("; ");
}

function remoteHas(record: RecordShape | undefined, entry: string): boolean {
  if (record === undefined) return false;
  return existsSync(join(record.remoteCwd, entry));
}

function targetExcluded(record: RecordShape | undefined): { ok: boolean; how: string } {
  const ignoreFile = join(workDir, ".beamignore");
  const ignore = existsSync(ignoreFile) ? readFileSync(ignoreFile, "utf8") : "";
  if (/^\/?target\/?$/m.test(ignore)) return { ok: true, how: `.beamignore: ${ignore.trim()}` };
  const synced = record?.syncedExcludes ?? [];
  if (synced.some((e) => /target/.test(e))) {
    return { ok: true, how: `syncedExcludes: ${synced.join(", ")}` };
  }
  return { ok: false, how: `.beamignore=${JSON.stringify(ignore)} synced=${synced.join(",")}` };
}

/** Every staged-return file for a handoff id, relative-path listed. */
const MAX_RETURN_SCAN_DEPTH = 12;
function returnFiles(id: string): string[] {
  const root = join(beamDir, "returns", id);
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > MAX_RETURN_SCAN_DEPTH) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) stack.push({ dir: p, depth: depth + 1 });
      else found.push(p);
    }
  }
  return found;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const expectations: Expectation[] = [];

if (evalId === 0) {
  expectations.push({
    text: "exactly one handoff reached status up",
    passed: ups.length === 1,
    evidence: describeRecords(),
  });
  expectations.push({
    text: "a self-contained kickoff message was journaled (mentions the rename task)",
    passed: up?.kickoff !== undefined && /barclient|rename/i.test(up.kickoff),
    evidence: `kickoff=${JSON.stringify(up?.kickoff)}`,
  });
  const excluded = targetExcluded(up);
  expectations.push({
    text: "the build dir target/ was excluded from the ship",
    passed: excluded.ok && !remoteHas(up, "target"),
    evidence: `${excluded.how}; remote target/ present=${remoteHas(up, "target")}`,
  });
  expectations.push({
    text: "source and session landed remotely",
    passed: remoteHas(up, join("src", "main.ts")) && remoteHas(up, join(".beam", "session.jsonl")),
    evidence: `remoteCwd=${up?.remoteCwd}`,
  });
}

if (evalId === 1) {
  const old = records.find((r) => r.sessionId === "sess-old77");
  expectations.push({
    text: "the stale handoff was retired (killed or down), not left holding the slot",
    passed: old !== undefined && (old.status === "killed" || old.status === "down"),
    evidence: describeRecords(),
  });
  expectations.push({
    text: "a fresh handoff is up with the NEWEST session (sess-new42)",
    passed: ups.length === 1 && ups[0]?.sessionId === "sess-new42",
    evidence: describeRecords(),
  });
  expectations.push({
    text: "the new handoff carries a kickoff mentioning the CSV export task",
    passed: up?.kickoff !== undefined && /csv/i.test(up.kickoff),
    evidence: `kickoff=${JSON.stringify(up?.kickoff)}`,
  });
}

if (evalId === 2) {
  expectations.push({
    text: "a handoff ends up in status up with a kickoff for the retry/backoff task",
    passed: up?.kickoff !== undefined && /retry|backoff/i.test(up.kickoff),
    evidence: describeRecords(),
  });
  expectations.push({
    text: "the report names the missing kickoff/idle prompt as the root cause",
    passed: /kickoff|no message|without a message|idle|waiting for input/i.test(report),
    evidence: report.slice(0, 400) || "no report captured",
  });
}

if (evalId === 3) {
  const oldId = fixtureMeta.oldHandoffId ?? "";
  const old = records.find((r) => r.id === oldId);
  const collected = returnFiles(oldId);
  const resultStaged = collected.some((f) => f.endsWith("REMOTE_RESULT.md"));
  expectations.push({
    text: "the old handoff's remote work was COLLECTED before retiring (staged return holds REMOTE_RESULT.md)",
    passed: resultStaged,
    evidence: collected.length > 0 ? collected.slice(0, 6).join("\n") : "no staged return exists",
  });
  expectations.push({
    text: "the old handoff was then retired (killed), freeing the workspace",
    passed: old !== undefined && old.status === "killed",
    evidence: describeRecords(),
  });
  expectations.push({
    text: "a fresh handoff is up with the NEWEST session (sess-two99) and a parser kickoff",
    passed:
      ups.length === 1 &&
      ups[0]?.sessionId === "sess-two99" &&
      ups[0]?.kickoff !== undefined &&
      /parser/i.test(ups[0].kickoff),
    evidence: describeRecords(),
  });
  const excluded = targetExcluded(up);
  expectations.push({
    text: "the build dir target/ was excluded from the fresh ship",
    passed: excluded.ok && !remoteHas(up, "target"),
    evidence: `${excluded.how}; remote target/ present=${remoteHas(up, "target")}`,
  });
}

if (evalId === 4) {
  const wantedId = fixtureMeta.interruptedHandoffId ?? "";
  const same = records.find((r) => r.id === wantedId);
  expectations.push({
    text: "the interrupted handoff was RESUMED to completion (same record id ends up, journal cleared)",
    passed: same !== undefined && same.status === "up" && same.shipPending === undefined,
    evidence: describeRecords(),
  });
  expectations.push({
    text: "no parallel or replacement handoff was created (exactly one record)",
    passed: records.length === 1,
    evidence: `${records.length} records: ${describeRecords()}`,
  });
  expectations.push({
    text: "the journaled pagination kickoff rode the resumed ship into the resume command",
    passed:
      same?.kickoff !== undefined &&
      /pagination/i.test(same.kickoff) &&
      (same.resumeArgv ?? []).some((a) => /pagination/i.test(a)),
    evidence: `kickoff=${JSON.stringify(same?.kickoff)} resumeArgv=${JSON.stringify(same?.resumeArgv)}`,
  });
  expectations.push({
    text: "the workspace landed remotely",
    passed: remoteHas(same, join("src", "main.ts")),
    evidence: `remoteCwd=${same?.remoteCwd}`,
  });
}

if (evalId === 5) {
  const writerPid = Number(fixtureMeta.writerPid ?? "0");
  expectations.push({
    text: "the interfering writer was found and stopped",
    passed: writerPid > 0 && !processAlive(writerPid),
    evidence: `writer pid ${writerPid} alive=${processAlive(writerPid)}`,
  });
  expectations.push({
    text: "the handoff completed after the writer stopped (status up, generated source shipped)",
    passed: ups.length === 1 && remoteHas(up, join("src", "generated.ts")),
    evidence: describeRecords(),
  });
  expectations.push({
    text: "a kickoff for the codegen task was journaled",
    passed: up?.kickoff !== undefined && /codegen|generat|pipeline/i.test(up.kickoff),
    evidence: `kickoff=${JSON.stringify(up?.kickoff)}`,
  });
  expectations.push({
    text: "the report names the torn-snapshot/staging refusal (not a generic retry)",
    passed: /torn|changed while|staged|staging|coheren|writer|watcher/i.test(report),
    evidence: report.slice(0, 400) || "no report captured",
  });
}

if (evalId === 6) {
  expectations.push({
    text: "the handoff reached up with a kickoff journaled",
    passed: ups.length === 1 && up?.kickoff !== undefined && up.kickoff.length > 0,
    evidence: describeRecords(),
  });
  const excluded = targetExcluded(up);
  expectations.push({
    text: "the 2.1 GiB build dir was EXCLUDED (not shipped via --allow-large)",
    passed: excluded.ok && !remoteHas(up, "target"),
    evidence: `${excluded.how}; remote target/ present=${remoteHas(up, "target")}`,
  });
  expectations.push({
    text: "the report names the size-ceiling refusal",
    passed: /ceiling|would ship|2\.\d+ GiB|oversized|too large|size preflight/i.test(report),
    evidence: report.slice(0, 400) || "no report captured",
  });
}

if (evalId === 7) {
  const finishedId = fixtureMeta.finishedHandoffId ?? "";
  const finished = records.find((r) => r.id === finishedId);
  const localResult = join(workDir, "REMOTE_RESULT.md");
  expectations.push({
    text: "the remote result was integrated into the LOCAL workspace",
    passed:
      existsSync(localResult) && readFileSync(localResult, "utf8").includes("REMOTE_MARKER_DONE"),
    evidence: existsSync(localResult)
      ? readFileSync(localResult, "utf8").slice(0, 120)
      : "REMOTE_RESULT.md missing locally",
  });
  const staged = returnFiles(finishedId);
  const stagedTranscript = staged.find((f) => f.endsWith("session.jsonl"));
  expectations.push({
    text: "the grown remote transcript was collected into the staged return",
    passed:
      stagedTranscript !== undefined &&
      readFileSync(stagedTranscript, "utf8").includes("REMOTE_MARKER_DONE"),
    evidence: stagedTranscript ?? `staged files: ${staged.slice(0, 6).join(", ") || "none"}`,
  });
  expectations.push({
    text: "the handoff was retired after collection (killed — target slot free)",
    passed: finished !== undefined && finished.status === "killed" && ups.length === 0,
    evidence: describeRecords(),
  });
  expectations.push({
    text: "the report hands the user the local resume path (omp --resume of the staged session)",
    passed: /--resume/.test(report) && /returns/.test(report),
    evidence: report.slice(0, 400) || "no report captured",
  });
}

writeFileSync(out, JSON.stringify({ expectations }, null, 2));
const failed = expectations.filter((e) => !e.passed).length;
console.log(`${expectations.length - failed}/${expectations.length} passed -> ${out}`);
