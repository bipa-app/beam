import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { CliError } from "../cli-output.ts";
import { resolveEnv, type BeamEnv } from "../env.ts";
import {
  acquireOperationLock,
  findRecord,
  getRecord,
  updateRecord,
  type BeamRecord,
} from "../state.ts";
import { run, runChecked } from "../util/shell.ts";
import { assertPrivateBeamDir } from "../util/private-dir.ts";
import {
  stageWorkspaceShip,
  stagedWorkspaceTreeFingerprint,
  workspaceReturnFingerprint,
  type StagedWorkspaceShip,
  type WorkspaceReturnFingerprint,
} from "../workspace.ts";
import { prepareWorktreeGitReturn } from "../workspace-git.ts";

export const INTEGRATE_HELP = `beam integrate — preview and apply the latest verified return

usage: beam integrate [id] [options]
  --yes             apply after the preview without an interactive prompt

Beam refuses if the local workspace changed since beam up. The persisted
return stage and its receipt are re-proven before any live-workspace write.
Quiesce local editors and generators because the final rsync is not atomic.
`;

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_EXCLUDES = 4096;
const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_PREVIEW_LINES = 10_000;
const MAX_DISPLAY_LINES = 200;
const MAX_MANIFEST_READS = 1024;

type ReturnManifest = {
  version: 1;
  recordId: string;
  localCwd: string;
  remoteCwd: string;
  fingerprint: WorkspaceReturnFingerprint;
  baseWorkspaceDigest: string | null;
  excludes: string[];
  mirrorDeletes: boolean;
  createdAt: string;
};

type TrustedReturn = {
  manifestFile: string;
  manifest: ReturnManifest;
  source: StagedWorkspaceShip;
};

export type IntegrateResult = {
  recordId: string;
  manifestFile: string;
  status: "integrated" | "already_integrated" | "cancelled";
  changes: string[];
};

export async function cmdIntegrate(
  args: string[],
  context: { json: boolean },
): Promise<IntegrateResult | undefined> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      yes: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(INTEGRATE_HELP);
    return undefined;
  }
  if (positionals.length > 1) {
    throw new CliError("invalid_arguments", "beam integrate accepts at most one handoff id");
  }
  const env = resolveEnv();
  const selected = findRecord(env, positionals[0]);
  const release = acquireOperationLock(env, selected.id);
  try {
    return await integrateUnderLock(env, getRecord(env, selected.id), {
      approved: values.yes === true,
      json: context.json,
    });
  } finally {
    release();
  }
}

async function integrateUnderLock(
  env: BeamEnv,
  record: BeamRecord,
  options: { approved: boolean; json: boolean },
): Promise<IntegrateResult> {
  assertLocalWorkspaceIdentity(record);
  const trusted = await loadTrustedReturn(env, record);
  try {
    const changes = await integrationPreview(trusted.source.dir, trusted.manifest);
    if (changes.length === 0) {
      if (record.returnReceipt?.integratedAt === undefined) {
        await assertLocalWorkspaceAtBase(record, trusted.manifest);
      }
      markIntegrated(env, record, trusted.manifestFile);
      console.log(`handoff ${record.id}: latest return is already integrated`);
      return resultFor(record, trusted.manifestFile, "already_integrated", changes);
    }
    printPreview(changes, trusted.manifest.mirrorDeletes);
    await assertLocalWorkspaceAtBase(record, trusted.manifest);
    if (!options.approved && options.json) {
      throw new CliError(
        "confirmation_required",
        `beam integrate ${record.id} needs --yes to apply ${changes.length} change(s)`,
        { changes, nextCommand: `beam integrate ${record.id} --yes --json` },
      );
    }
    if (!options.approved && !(await confirmApply())) {
      console.log("integration cancelled; the verified return stage was retained");
      return resultFor(record, trusted.manifestFile, "cancelled", changes);
    }
    if (!options.approved) await assertLocalWorkspaceAtBase(record, trusted.manifest);
    await integrationApply(trusted.source.dir, trusted.manifest);
    const remaining = await integrationPreview(trusted.source.dir, trusted.manifest);
    if (remaining.length !== 0) {
      throw new CliError(
        "integration_incomplete",
        `beam integrate ${record.id} left ${remaining.length} unapplied change(s)`,
        { changes: remaining },
      );
    }
    markIntegrated(env, record, trusted.manifestFile);
    console.log(`integrated verified return for handoff ${record.id}`);
    return resultFor(record, trusted.manifestFile, "integrated", changes);
  } finally {
    trusted.source.dispose();
  }
}

function resultFor(
  record: BeamRecord,
  manifestFile: string,
  status: IntegrateResult["status"],
  changes: string[],
): IntegrateResult {
  return { recordId: record.id, manifestFile, status, changes };
}

async function loadTrustedReturn(env: BeamEnv, record: BeamRecord): Promise<TrustedReturn> {
  const receipt = record.returnReceipt;
  if (receipt === undefined) {
    throw new CliError(
      "return_not_found",
      `handoff ${record.id} has no verified return — run beam down ${record.id} first`,
    );
  }
  const manifestFile = trustedManifestPath(env, record, receipt.manifestFile);
  const bytes = readManifestBytes(manifestFile);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== receipt.manifestDigest) {
    throw new CliError(
      "return_tampered",
      `verified return manifest ${manifestFile} changed after beam down; refusing to apply it`,
    );
  }
  const manifest = parseReturnManifest(bytes, manifestFile, record);
  const workspace = join(dirname(manifestFile), "workspace");
  assertWorkspaceDirectory(workspace);
  const source = await stageWorkspaceShip(workspace, [], false);
  const actual = workspaceReturnFingerprint(source.dir);
  if (!sameFingerprint(actual, manifest.fingerprint)) {
    source.dispose();
    throw new CliError(
      "return_tampered",
      `verified return workspace ${workspace} changed after beam down; refusing to apply it`,
    );
  }
  const localMode = statSync(record.localCwd).mode & 0o7777;
  chmodSync(source.dir, localMode);
  return { manifestFile, manifest, source };
}

function trustedManifestPath(env: BeamEnv, record: BeamRecord, manifestFile: string): string {
  const root = dirname(manifestFile);
  const expectedParent = resolve(env.beamDir, "returns", record.id);
  if (resolve(dirname(root)) !== expectedParent) {
    throw new CliError("return_tampered", `return manifest path escapes ${expectedParent}`);
  }
  const trustedRoot = assertPrivateBeamDir(
    env.beamDir,
    "returns",
    record.id,
    basename(root),
  );
  const expectedFile = resolve(trustedRoot, "manifest.json");
  if (resolve(manifestFile) !== expectedFile) {
    throw new CliError("return_tampered", `return manifest must be ${expectedFile}`);
  }
  const stat = lstatSync(expectedFile, { throwIfNoEntry: false });
  if (stat === undefined || stat.isSymbolicLink() || !stat.isFile()) {
    throw new CliError("return_tampered", `return manifest ${expectedFile} is not a real file`);
  }
  return expectedFile;
}
function readManifestBytes(manifestFile: string): Buffer {
  const descriptor = openSync(manifestFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
      throw new CliError(
        "return_tampered",
        `return manifest ${manifestFile} exceeds ${MAX_MANIFEST_BYTES} bytes`,
      );
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    let reads = 0;
    while (offset < bytes.length) {
      if (reads === MAX_MANIFEST_READS) {
        throw new CliError(
          "return_tampered",
          `return manifest ${manifestFile} read did not settle`,
        );
      }
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) {
        throw new CliError("return_tampered", `return manifest ${manifestFile} was truncated`);
      }
      offset += count;
      reads += 1;
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function parseReturnManifest(
  bytes: Buffer,
  manifestFile: string,
  record: BeamRecord,
): ReturnManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return invalidManifest(manifestFile, `invalid JSON (${reason})`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidManifest(manifestFile, "expected an object");
  }
  const fields = value as Record<string, unknown>;
  const fingerprint = parseFingerprint(fields.fingerprint, manifestFile);
  const excludes = parseExcludes(fields.excludes, manifestFile);
  const digest = fields.baseWorkspaceDigest;
  if (digest !== null && (typeof digest !== "string" || !isDigest(digest))) {
    return invalidManifest(manifestFile, "baseWorkspaceDigest is invalid");
  }
  if (
    fields.version !== 1 ||
    fields.recordId !== record.id ||
    fields.localCwd !== record.localCwd ||
    fields.remoteCwd !== record.remoteCwd ||
    typeof fields.mirrorDeletes !== "boolean" ||
    typeof fields.createdAt !== "string"
  ) {
    return invalidManifest(manifestFile, "identity or option fields do not match the handoff");
  }
  return {
    version: 1,
    recordId: record.id,
    localCwd: record.localCwd,
    remoteCwd: record.remoteCwd,
    fingerprint,
    baseWorkspaceDigest: digest,
    excludes,
    mirrorDeletes: fields.mirrorDeletes,
    createdAt: fields.createdAt,
  };
}

function parseFingerprint(value: unknown, manifestFile: string): WorkspaceReturnFingerprint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidManifest(manifestFile, "fingerprint is not an object");
  }
  const fields = value as Record<string, unknown>;
  if (typeof fields.digest !== "string" || !isDigest(fields.digest)) {
    return invalidManifest(manifestFile, "fingerprint digest is invalid");
  }
  if (!Number.isSafeInteger(fields.entries) || (fields.entries as number) < 1) {
    return invalidManifest(manifestFile, "fingerprint entry count is invalid");
  }
  return { digest: fields.digest, entries: fields.entries as number };
}

function parseExcludes(value: unknown, manifestFile: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_EXCLUDES) {
    return invalidManifest(manifestFile, `exclude list exceeds ${MAX_EXCLUDES} entries`);
  }
  const excludes: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.includes("\0")) {
      return invalidManifest(manifestFile, "exclude list contains an invalid entry");
    }
    excludes.push(entry);
  }
  return excludes;
}

function invalidManifest(manifestFile: string, reason: string): never {
  throw new CliError("return_tampered", `return manifest ${manifestFile} is invalid: ${reason}`);
}

function isDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function sameFingerprint(
  left: WorkspaceReturnFingerprint,
  right: WorkspaceReturnFingerprint,
): boolean {
  return left.digest === right.digest && left.entries === right.entries;
}

function assertWorkspaceDirectory(workspace: string): void {
  const stat = lstatSync(workspace, { throwIfNoEntry: false });
  if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new CliError("return_tampered", `return workspace ${workspace} is not a real directory`);
  }
}

function assertLocalWorkspaceIdentity(record: BeamRecord): void {
  if (record.localCwdId === undefined) {
    throw new CliError(
      "legacy_handoff",
      `handoff ${record.id} has no local workspace identity; inspect its staged return manually`,
    );
  }
  const current = statSync(record.localCwd, { bigint: true });
  if (
    current.dev.toString() !== record.localCwdId.dev ||
    current.ino.toString() !== record.localCwdId.ino
  ) {
    throw new CliError(
      "local_workspace_replaced",
      `${record.localCwd} is not the physical workspace that handoff ${record.id} shipped`,
    );
  }
}

async function assertLocalWorkspaceAtBase(
  record: BeamRecord,
  manifest: ReturnManifest,
): Promise<void> {
  assertLocalWorkspaceIdentity(record);
  if (record.wtGit !== undefined) {
    await prepareWorktreeGitReturn(record.localCwd, record.id, record.wtGit);
  }
  const base = manifest.baseWorkspaceDigest;
  if (base === null || record.workspaceDigest !== base) {
    throw new CliError(
      "legacy_handoff",
      `handoff ${record.id} has no matching ship-time workspace digest; inspect the stage manually`,
    );
  }
  const current = await stageWorkspaceShip(record.localCwd, manifest.excludes, false);
  try {
    const digest = stagedWorkspaceTreeFingerprint(current.dir).digest;
    if (digest !== base) {
      throw new CliError(
        "local_workspace_changed",
        `${record.localCwd} changed after beam up; refusing to overwrite concurrent local work`,
        { expectedDigest: base, actualDigest: digest },
      );
    }
  } finally {
    current.dispose();
  }
}

function integrationArgv(
  source: string,
  manifest: ReturnManifest,
  mode: "preview" | "apply",
): string[] {
  const argv = [
    "rsync",
    "-a",
    "--checksum",
    "--omit-dir-times",
    "--no-owner",
    "--no-group",
  ];
  if (mode === "preview") argv.push("--dry-run", "--itemize-changes");
  if (manifest.mirrorDeletes) argv.push("--delete");
  argv.push(
    ...manifest.excludes.map((exclude) => `--exclude=${exclude}`),
    "--",
    `${source.replace(/\/+$/, "")}/`,
    `${manifest.localCwd.replace(/\/+$/, "")}/`,
  );
  return argv;
}

async function integrationPreview(source: string, manifest: ReturnManifest): Promise<string[]> {
  const result = await run(integrationArgv(source, manifest, "preview"), {
    maxOutputBytes: MAX_PREVIEW_BYTES,
  });
  if (result.code !== 0) {
    throw new CliError(
      "integration_preview_failed",
      `rsync could not preview the verified return: ` +
        `${result.stderr.trim() || `exit ${result.code}`}`,
    );
  }
  const lines = result.stdout.split("\n").filter((line) => line !== "");
  if (lines.length > MAX_PREVIEW_LINES) {
    throw new CliError(
      "integration_preview_too_large",
      `return preview exceeds ${MAX_PREVIEW_LINES} changed paths; inspect the stage manually`,
    );
  }
  return lines;
}

async function integrationApply(source: string, manifest: ReturnManifest): Promise<void> {
  await runChecked(integrationArgv(source, manifest, "apply"), {
    maxOutputBytes: MAX_PREVIEW_BYTES,
  });
}

function printPreview(changes: string[], mirrorDeletes: boolean): void {
  console.log(
    `return preview: ${changes.length} change(s)` +
      `${mirrorDeletes ? " with deletions" : ""}`,
  );
  const shown = changes.slice(0, MAX_DISPLAY_LINES);
  for (const change of shown) console.log(`  ${change}`);
  if (changes.length > shown.length) {
    console.log(
      `  ... ${changes.length - shown.length} more change(s); ` +
        `use --json for the full list`,
    );
  }
}

async function confirmApply(): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await terminal.question("Apply this verified return? [y/N] "))
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    terminal.close();
  }
}

function markIntegrated(env: BeamEnv, record: BeamRecord, manifestFile: string): void {
  const receipt = record.returnReceipt;
  if (receipt === undefined || receipt.manifestFile !== manifestFile) {
    throw new CliError("return_changed", "a newer beam down replaced this return receipt");
  }
  updateRecord(env, record.id, {
    returnReceipt: { ...receipt, integratedAt: new Date().toISOString() },
  });
}
