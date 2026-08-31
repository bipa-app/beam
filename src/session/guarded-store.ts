import { randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSha256 } from "../util/digest.ts";
import { shq } from "../util/shell.ts";
import type { Transport } from "../transport/types.ts";

function safeSegments(segments: string[]): string[] {
  const unsafe = segments.some(
    (part) =>
      part === "" ||
      part === "." ||
      part === ".." ||
      part.includes("/") ||
      part.includes("\0") ||
      part.includes("\n"),
  );
  if (segments.length < 2 || unsafe) {
    throw new Error("beam: invalid harness session-store path");
  }
  return segments;
}

function enterHome(): string[] {
  return [
    "set -u",
    'cd -P -- "$HOME" || { echo "beam: cannot enter harness home" >&2; exit 61; }',
    "__uid=$(id -u) || exit 61",
  ];
}

/**
 * Walk the store chain one component at a time, pinning each level as the
 * shell's cwd: symlinks refuse, an escape from the parent refuses, and a
 * foreign-owned component refuses. Components beam creates are private
 * (0700) regardless of the remote umask; existing components keep their
 * mode — the final transcript is 0600 either way.
 */
function descend(segments: string[], create: boolean, absentIsSuccess = false): string[] {
  const lines: string[] = [];
  for (const segment of segments) {
    const q = shq(segment);
    const symlink = shq(`beam: harness store component is a symlink: ${segment}`);
    const notDir = shq(`beam: harness store component is not a directory: ${segment}`);
    const escaped = shq(`beam: harness store component escaped its parent: ${segment}`);
    const foreignOwner = shq(`beam: harness store component has a foreign owner: ${segment}`);
    lines.push(`if [ -L ${q} ]; then echo ${symlink} >&2; exit 62; fi`);
    if (create) lines.push(`mkdir -p -m 700 -- ${q} || exit 63`);
    if (absentIsSuccess) lines.push(`if [ ! -e ${q} ]; then exit 0; fi`);
    lines.push(`if [ ! -d ${q} ]; then echo ${notDir} >&2; exit 63; fi`);
    lines.push('parent_physical=$(/bin/pwd -P) || exit 63');
    lines.push(`cd -P -- ${q} || exit 63`);
    lines.push('child_physical=$(/bin/pwd -P) || exit 63');
    lines.push(
      `if [ "$child_physical" != "$parent_physical"/${q} ]; then` +
        ` echo ${escaped} >&2; exit 64; fi`,
    );
    lines.push(`__o=$(ls -ldn . | awk '{print $3}') || exit 63`);
    lines.push(`if [ "$__o" != "$__uid" ]; then echo ${foreignOwner} >&2; exit 64; fi`);
  }
  return lines;
}

/** Best-effort removal of exactly the stage/handle names one install owns. */
function installResidueLines(tmpQ: string, handleQ: string): string[] {
  return [
    `rm -f -- ${handleQ} ${tmpQ}/session.jsonl 2>/dev/null || true`,
    `rmdir -- ${tmpQ} 2>/dev/null || true`,
  ];
}

/**
 * The bind→verify→publish script one install runs inside the held
 * destination parent: every check verifies the bound handle's inode (never
 * a re-resolvable name), the publish is a create-only link, and every
 * failure path removes exactly the owned stage/handle names before exiting
 * with its own code.
 */
function installPublishScript(options: {
  dirs: string[];
  tmpQ: string;
  handleQ: string;
  fileQ: string;
  expectedSha256: string;
  dest: string;
}): string {
  const { dirs, tmpQ, handleQ, fileQ, expectedSha256, dest } = options;
  const stageNotDir = shq("beam: harness install stage is not a real directory");
  const stageNotPrivate = shq("beam: install stage is not private (0700)");
  const bindFailed = shq("beam: cannot bind the staged transcript");
  const handleNotFile = shq("beam: staged transcript is not a regular file");
  const noShaTool = shq("beam: no sha256 tool on the target");
  const shaChanged = shq("beam: staged transcript changed during install — refusing");
  const handleNotPrivate = shq("beam: staged transcript did not land private (0600)");
  const targetNotFile = shq("beam: harness transcript target is not a regular file");
  const existsDiffers = shq(
    `beam: remote transcript ${dest} already exists with different content — ` +
      "it may hold unsaved remote work; inspect and remove it manually, then retry",
  );
  const appeared = shq("beam: transcript target appeared concurrently — refusing to overwrite it");
  const publishedNotFile = shq("beam: published transcript is not a regular file");
  const publishedNotPrivate = shq("beam: published transcript is not private (0600)");
  return [
    ...enterHome(),
    ...descend(dirs, false),
    `__cleanup() { rm -f -- ${handleQ} ${tmpQ}/session.jsonl 2>/dev/null;` +
      ` rmdir -- ${tmpQ} 2>/dev/null; :; }`,
    `if [ -L ${tmpQ} ] || [ ! -d ${tmpQ} ]; then echo ${stageNotDir} >&2; __cleanup; exit 65; fi`,
    `chmod 700 ${tmpQ} || { __cleanup; exit 65; }`,
    `__dm=$(stat -c %a ${tmpQ} 2>/dev/null || stat -f %Lp ${tmpQ}) || { __cleanup; exit 65; }`,
    `if [ "$__dm" != 700 ]; then echo ${stageNotPrivate} >&2; __cleanup; exit 65; fi`,
    // Bind, then verify THE HANDLE's inode — never the swappable name.
    `ln -- ${tmpQ}/session.jsonl ${handleQ} || { echo ${bindFailed} >&2; __cleanup; exit 65; }`,
    `if [ -L ${handleQ} ] || [ ! -f ${handleQ} ]; then` +
      ` echo ${handleNotFile} >&2; __cleanup; exit 65; fi`,
    `__h=$(sha256sum < ${handleQ} 2>/dev/null) || __h=$(shasum -a 256 < ${handleQ})` +
      ` || { echo ${noShaTool} >&2; __cleanup; exit 65; }`,
    `__h=\${__h%% *}`,
    `if [ "$__h" != ${shq(expectedSha256)} ]; then echo ${shaChanged} >&2; __cleanup; exit 65; fi`,
    // The transcript is confidential: 0600 on the bound inode BEFORE it
    // is published, verified after.
    `chmod 600 ${handleQ} || { __cleanup; exit 65; }`,
    `__m=$(stat -c %a ${handleQ} 2>/dev/null || stat -f %Lp ${handleQ})` +
      ` || { __cleanup; exit 65; }`,
    `if [ "$__m" != 600 ]; then echo ${handleNotPrivate} >&2; __cleanup; exit 65; fi`,
    `if [ -L ${fileQ} ] || { [ -e ${fileQ} ] && [ ! -f ${fileQ} ]; }; then` +
      ` echo ${targetNotFile} >&2; __cleanup; exit 66; fi`,
    `if [ -e ${fileQ} ]; then`,
    `  if cmp -s -- ${handleQ} ${fileQ}; then` +
      ` chmod 600 ${fileQ} || { __cleanup; exit 66; }; __cleanup; exit 0; fi`,
    `  echo ${existsDiffers} >&2`,
    `  __cleanup`,
    `  exit 68`,
    `fi`,
    `ln -- ${handleQ} ${fileQ} || { echo ${appeared} >&2; __cleanup; exit 67; }`,
    `if [ -L ${fileQ} ] || [ ! -f ${fileQ} ]; then` +
      ` echo ${publishedNotFile} >&2; __cleanup; exit 67; fi`,
    `__m=$(stat -c %a ${fileQ} 2>/dev/null || stat -f %Lp ${fileQ}) || { __cleanup; exit 67; }`,
    `if [ "$__m" != 600 ]; then echo ${publishedNotPrivate} >&2; __cleanup; exit 67; fi`,
    ...installResidueLines(tmpQ, handleQ),
  ].join("\n");
}

function installPrepareScript(dirs: string[]): string {
  return [...enterHome(), ...descend(dirs, true)].join("\n");
}

function installResidueScript(dirs: string[], tmpQ: string, handleQ: string): string {
  return [
    ...enterHome(),
    ...descend(dirs, false, true),
    ...installResidueLines(tmpQ, handleQ),
  ].join("\n");
}

function collectProbeScript(dirs: string[], fileQ: string): string {
  const missing = shq("beam: remote harness transcript is missing or unsafe");
  return [
    ...enterHome(),
    ...descend(dirs, false),
    `if [ -L ${fileQ} ] || [ ! -f ${fileQ} ]; then echo ${missing} >&2; exit 66; fi`,
    `ls -lni -- ${fileQ} || exit 66`,
  ].join("\n");
}

function cleanupScript(dirs: string[], fileQ: string, removeLeafDirectory: boolean): string {
  const refuseDir = shq("beam: refusing to remove a directory as a transcript");
  return [
    ...enterHome(),
    ...descend(dirs, false, true),
    `if [ -d ${fileQ} ] && [ ! -L ${fileQ} ]; then echo ${refuseDir} >&2; exit 66; fi`,
    `rm -f -- ${fileQ} || exit 67`,
    ...(removeLeafDirectory && dirs.length > 0
      ? ["cd -P -- .. || exit 68", `rmdir -- ${shq(dirs.at(-1)!)} 2>/dev/null || true`]
      : []),
  ].join("\n");
}

/** Fixed generated-script corpus consumed by the side-by-side Rust port. */
export function guardedStoreScriptGolden() {
  const dirs = [".claude", "projects", "-tmp-work"];
  const fileQ = shq("session 'x'.jsonl");
  const tmpQ = shq(".beam-install-fixed");
  const handleQ = shq(".beam-install-fixed.h");
  return [
    { label: "install-prepare", output: installPrepareScript(dirs) },
    {
      label: "install-publish",
      output: installPublishScript({
        dirs,
        tmpQ,
        handleQ,
        fileQ,
        expectedSha256: "a".repeat(64),
        dest: "~/.claude/projects/-tmp-work/session 'x'.jsonl",
      }),
    },
    { label: "install-residue", output: installResidueScript(dirs, tmpQ, handleQ) },
    { label: "collect-probe", output: collectProbeScript(dirs, fileQ) },
    { label: "cleanup-file", output: cleanupScript(dirs, fileQ, false) },
    { label: "cleanup-leaf", output: cleanupScript(dirs, fileQ, true) },
  ];
}

/**
 * Install one local transcript without following any agent-controlled store
 * path, and without ever re-walking a textual absolute path.
 *
 * The upload lands in a unique temp directory INSIDE the held destination
 * parent, so after one pinned descent the stage and the destination are both
 * single components of the same held directory. The staged bytes are then
 * bound to a create-only hardlink HANDLE: the handle's inode — not any
 * re-resolvable name — is verified (regular file, exact expected sha256,
 * 0600) and published to the destination with a create-only link. A
 * concurrent swap of the stage can only make the verification refuse; it can
 * never redirect what gets hashed, linked, or removed. Cleanup removes
 * exactly the owned temp/handle names (rm -f + rmdir — never a recursive
 * delete of a re-resolved path).
 */
export async function installGuardedHomeFile(
  t: Transport,
  localFile: string,
  pathSegments: string[],
): Promise<string> {
  const segments = safeSegments(pathSegments);
  const dirs = segments.slice(0, -1);
  const file = segments.at(-1)!;
  const dest = `~/${segments.join("/")}`;
  const tag = randomBytes(9).toString("hex");
  const tmp = `.beam-install-${tag}`;
  const handle = `.beam-install-${tag}.h`;
  const tmpQ = shq(tmp);
  const handleQ = shq(handle);
  const fileQ = shq(file);
  const expected = fileSha256(localFile);
  const localStage = mkdtempSync(join(tmpdir(), "beam-harness-install-"));
  writeFileSync(join(localStage, "session.jsonl"), readFileSync(localFile));
  try {
    // Hold (and create, privately) the destination parent BEFORE the upload
    // so the temp lands inside it — never at a home-level path that a later
    // shell would have to re-walk textually.
    await t.execChecked(installPrepareScript(dirs));
    await t.syncUp(localStage, `~/${dirs.join("/")}/${tmp}`, { checksum: true });
    const script = installPublishScript({
      dirs,
      tmpQ,
      handleQ,
      fileQ,
      expectedSha256: expected,
      dest,
    });
    await t.execChecked(script);
  } catch (error) {
    // Best-effort removal of exactly our residue names; the store chain and
    // any published transcript stay untouched.
    await t.exec(installResidueScript(dirs, tmpQ, handleQ));
    throw error;
  } finally {
    rmSync(localStage, { recursive: true, force: true });
  }
  return dest;
}

/**
 * Collect one transcript with ZERO remote writes: re-prove the source in a
 * pinned walk, fetch the held store directory straight into a local private
 * (0700) candidate, then re-prove the source's identity line unchanged. A
 * replacement between the proofs refuses and the local candidate is
 * discarded — content stability across collections is the caller's outer
 * double-fetch.
 */
export async function collectGuardedHomeFile(
  t: Transport,
  pathSegments: string[],
): Promise<string> {
  const segments = safeSegments(pathSegments);
  const dirs = segments.slice(0, -1);
  const file = segments.at(-1)!;
  const fileQ = shq(file);
  const probe = collectProbeScript(dirs, fileQ);
  const localStage = mkdtempSync(join(tmpdir(), "beam-harness-return-"));
  try {
    const pre = await t.execChecked(probe);
    await t.syncDown(`~/${dirs.join("/")}`, localStage, { checksum: true });
    const post = await t.execChecked(probe);
    if (post !== pre) {
      throw new Error(
        `beam: remote transcript ${dest(segments)} changed identity during collection — ` +
          "retry beam down",
      );
    }
    const collected = join(localStage, file);
    let st;
    try {
      st = lstatSync(collected);
    } catch (err) {
      // Only outright absence is the "missing" refusal; a real I/O fault
      // (ENOTDIR, EIO, ...) propagates with its true cause.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      throw new Error("beam: collected harness transcript is missing");
    }
    if (!st.isFile()) throw new Error("beam: collected harness transcript is unsafe");
    return readFileSync(collected, "utf8");
  } finally {
    rmSync(localStage, { recursive: true, force: true });
  }
}

function dest(segments: string[]): string {
  return `~/${segments.join("/")}`;
}

/** Remove only the named transcript, relative to a physically pinned store. */
export async function cleanupGuardedHomeFile(
  t: Transport,
  pathSegments: string[],
  removeLeafDirectory = false,
): Promise<void> {
  const segments = safeSegments(pathSegments);
  const dirs = segments.slice(0, -1);
  const file = segments.at(-1)!;
  const fileQ = shq(file);
  await t.execChecked(cleanupScript(dirs, fileQ, removeLeafDirectory));
}
