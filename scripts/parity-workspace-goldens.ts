import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config.ts";
import type { Transport } from "../src/transport/types.ts";
import {
  BEAM_GITPTR_EXCLUDE,
  BEAM_OWNER_FILE,
  BEAM_RESERVED_DIR,
  BEAM_RESERVED_EXCLUDE,
  GIT_METADATA_EXCLUDE,
  assertContainedWorkspace,
  assertPurgeablePath,
  establishContainedWorkspace,
  formatBytes,
  gatherExcludes,
  publishWorkspaceUploadStage,
  purgeOwnedWorkspaceContents,
  releaseOwnedWorkspace,
  remoteWorkspaceName,
  remoteWorkspaceTreeFingerprint,
  remoteWorkspaceUploadStagePresent,
  removeWorkspaceUploadStage,
  stagedWorkspaceTreeFingerprint,
  workspaceOwnerContent,
  workspaceReturnFingerprint,
  workspaceUploadStagePath,
} from "../src/workspace.ts";
import {
  SHIPPED_REFS_FILE,
  SHIPPED_STASH_LOG_FILE,
  collectedGitTreeFingerprint,
  gitPayloadPath,
  gitPointerBytes,
  gitPointerTempName,
  installRemoteGitPointer,
  isGitDirAtCwd,
  isGitWorktree,
  isLinkedWorktree,
  reconcileGitPointerTemp,
  remoteGitEntryKind,
  remoteGitPointerState,
  remoteGitTreeFingerprint,
  returnObjectPinRef,
  returnQbase,
  returnRefBase,
  returnReflogPinRef,
  returnReflogRef,
  returnValueRef,
  workspaceGitEntryKind,
} from "../src/workspace-git.ts";

const OWNER = "beam-workspace-v1 record-1 0123456789abcdef0123456789abcdef";
const GENERATION = "0123456789abcdef";
const DIGEST = "a".repeat(64);

export async function workspaceGolden() {
  return {
    local: workspaceLocalGolden(),
    scripts: [
      ...(await containmentScriptGolden()),
      ...(await uploadScriptGolden()),
      ...(await remoteGitScriptGolden()),
    ],
    gitNames: gitNameGolden(),
    errors: await workspaceErrorGolden(),
  };
}

function workspaceLocalGolden() {
  const root = mkdtempSync(join(tmpdir(), "beam-parity-workspace-"));
  try {
    const fixture = createWorkspaceFixture(root);
    return {
      constants: {
        reservedDir: BEAM_RESERVED_DIR,
        ownerFile: BEAM_OWNER_FILE,
        reservedExclude: BEAM_RESERVED_EXCLUDE,
        gitMetadataExclude: GIT_METADATA_EXCLUDE,
        gitPointerExclude: BEAM_GITPTR_EXCLUDE,
      },
      names: ["/work/plain", "/work/space name", "/", "/work/ångström"].map((input) => ({
        input,
        output: remoteWorkspaceName(input),
      })),
      owner: workspaceOwnerContent("record-1", "0123456789abcdef0123456789abcdef"),
      excludes: gatherExcludes(fixture.workspace, fixture.config),
      bytes: [0, 999, 1024, 1536, 1024 ** 2, 5.25 * 1024 ** 3].map((input) => ({
        input,
        output: formatBytes(input),
      })),
      tree: stagedWorkspaceTreeFingerprint(fixture.workspace),
      returned: workspaceReturnFingerprint(fixture.workspace),
      collectedGit: collectedGitTreeFingerprint(fixture.collectedGit),
      gitLayouts: gitLayoutGolden(root),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createWorkspaceFixture(root: string): {
  workspace: string;
  collectedGit: string;
  config: Config;
} {
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "nested"), { recursive: true });
  writeFileSync(join(workspace, "a file.txt"), "alpha\n");
  writeFileSync(join(workspace, "nested", "β.txt"), "beta\n");
  symlinkSync("nested/β.txt", join(workspace, "link"));
  chmodSync(join(workspace, "nested"), 0o750);
  chmodSync(join(workspace, "a file.txt"), 0o640);
  chmodSync(join(workspace, "nested", "β.txt"), 0o600);
  writeFileSync(join(workspace, ".beamignore"), "# comment\n/node_modules\n\n *.tmp \n");

  const collectedGit = join(root, "collected-git");
  mkdirSync(join(collectedGit, "objects"), { recursive: true });
  writeFileSync(join(collectedGit, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(collectedGit, "objects", "pack"), "pack-bytes\n");
  const config: Config = { targets: {}, excludes: ["/dist", "node_modules"] };
  return { workspace, collectedGit, config };
}

function gitLayoutGolden(root: string) {
  const plain = join(root, "plain");
  const standard = join(root, "standard");
  const linked = join(root, "linked");
  const unsupported = join(root, "unsupported");
  const bare = join(root, "bare");
  for (const dir of [plain, standard, linked, unsupported, bare]) mkdirSync(dir);
  mkdirSync(join(standard, ".git"));
  writeFileSync(join(linked, ".git"), "gitdir: ../common\n");
  symlinkSync("../common", join(unsupported, ".git"));
  writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(bare, "objects"));
  mkdirSync(join(bare, "refs"));
  return [plain, standard, linked, unsupported, bare].map((dir) => ({
    label: dir.slice(dir.lastIndexOf("/") + 1),
    kind: workspaceGitEntryKind(dir),
    worktree: isGitWorktree(dir),
    linked: isLinkedWorktree(dir),
    gitDir: isGitDirAtCwd(dir),
  }));
}

async function containmentScriptGolden() {
  const scripts: Array<{ label: string; output: string }> = [];
  scripts.push({
    label: "establish-create",
    output: await checkedScript("/srv/beam/workspace", (transport) =>
      establishContainedWorkspace(
        transport,
        "/srv/beam",
        { name: "workspace" },
        { content: OWNER, adopt: "create" },
      )),
  });
  scripts.push({
    label: "establish-verify",
    output: await checkedScript("/srv/beam/workspace", (transport) =>
      establishContainedWorkspace(
        transport,
        "/srv/beam",
        { path: "/srv/beam/workspace" },
        { content: OWNER, adopt: "verify" },
      )),
  });
  scripts.push({
    label: "assert-contained",
    output: await checkedScript("/srv/beam/workspace", (transport) =>
      assertContainedWorkspace(transport, "/srv/beam", "/srv/beam/workspace", { owner: OWNER })),
  });
  scripts.push({
    label: "assert-contained-missing",
    output: await checkedScript("__beam_ws_absent__", (transport) =>
      assertContainedWorkspace(transport, "/srv/beam", "/srv/beam/workspace", {
        allowMissing: true,
        owner: OWNER,
      })),
  });
  scripts.push({
    label: "purge-owned",
    output: await checkedScript("__beam_ws_purged__", (transport) =>
      purgeOwnedWorkspaceContents(transport, "/srv/beam/workspace", OWNER)),
  });
  scripts.push({
    label: "purge-owned-converged",
    output: await checkedScript("__beam_ws_absent__", (transport) =>
      purgeOwnedWorkspaceContents(transport, "/srv/beam/workspace", OWNER, {
        acceptConverged: true,
      })),
  });
  scripts.push({
    label: "release-owned",
    output: await checkedScript("__beam_ws_released__", (transport) =>
      releaseOwnedWorkspace(transport, "/srv/beam/workspace", OWNER)),
  });
  return scripts;
}

async function uploadScriptGolden() {
  const scripts: Array<{ label: string; output: string }> = [];
  scripts.push({
    label: "workspace-tree-fingerprint",
    output: await checkedScript(`noise\n__beam_ws_fp_v1__ ${DIGEST} 7`, (transport) =>
      remoteWorkspaceTreeFingerprint(transport, "/srv/beam/workspace")),
  });
  scripts.push({
    label: "publish-upload-stage",
    output: await checkedScript("", (transport) =>
      publishWorkspaceUploadStage(transport, "/srv/beam/workspace", GENERATION, OWNER)),
  });
  for (const state of ["present", "absent"] as const) {
    scripts.push({
      label: `upload-stage-${state}`,
      output: await checkedScript(`__beam_upload_stage_v1__ ${state}`, (transport) =>
        remoteWorkspaceUploadStagePresent(
          transport,
          "/srv/beam/workspace",
          GENERATION,
          OWNER,
        )),
    });
  }
  scripts.push({
    label: "remove-upload-stage",
    output: await checkedScript("", (transport) =>
      removeWorkspaceUploadStage(transport, "/srv/beam/workspace", GENERATION, OWNER)),
  });
  return scripts;
}

async function remoteGitScriptGolden() {
  const scripts: Array<{ label: string; output: string }> = [];
  scripts.push({
    label: "remote-git-entry-kind",
    output: await checkedScript("profile\ndirectory", (transport) =>
      remoteGitEntryKind(transport, "/srv/beam/workspace", OWNER)),
  });
  scripts.push({
    label: "remote-git-tree-fingerprint",
    output: await checkedScript(`__beam_git_fp_v1__ ${DIGEST} 9`, (transport) =>
      remoteGitTreeFingerprint(
        transport,
        "/srv/beam/workspace",
        gitPayloadPath(GENERATION),
        OWNER,
      )),
  });
  scripts.push({
    label: "remote-git-pointer-state",
    output: await checkedScript("git ours\npayload 1", (transport) =>
      remoteGitPointerState(transport, "/srv/beam/workspace", GENERATION, OWNER)),
  });
  scripts.push({
    label: "reconcile-git-pointer",
    output: await checkedScript("", (transport) =>
      reconcileGitPointerTemp(transport, "/srv/beam/workspace", GENERATION, OWNER)),
  });
  scripts.push({
    label: "install-git-pointer",
    output: await checkedScript("", (transport) =>
      installRemoteGitPointer(transport, "/srv/beam/workspace", GENERATION, OWNER)),
  });
  return scripts;
}

function gitNameGolden() {
  return {
    shippedRefsFile: SHIPPED_REFS_FILE,
    shippedStashLogFile: SHIPPED_STASH_LOG_FILE,
    qbase: returnQbase("record-1", DIGEST),
    refBase: returnRefBase("record-1"),
    value: returnValueRef("record-1", DIGEST, "values", "refs/heads/feature/a"),
    reflog: returnReflogRef("record-1", DIGEST, "refs/heads/main", "raw\nreflog\n"),
    reflogPin: returnReflogPinRef("record-1", DIGEST, "b".repeat(40)),
    objectPin: returnObjectPinRef("record-1", DIGEST, "c".repeat(40)),
    payload: gitPayloadPath(GENERATION),
    pointer: gitPointerBytes(GENERATION),
    pointerTemp: gitPointerTempName(GENERATION),
  };
}

async function workspaceErrorGolden() {
  return {
    owner: syncError(() => workspaceOwnerContent("record-1", "bad")),
    purge: syncError(() => assertPurgeablePath("/")),
    upload: syncError(() => workspaceUploadStagePath("../bad")),
    gitPayload: syncError(() => gitPayloadPath("bad")),
    remoteGit: await asyncError((transport) =>
      remoteGitTreeFingerprint(transport, "/srv/beam/workspace", "../bad", OWNER)),
  };
}

async function checkedScript<T>(
  output: string,
  invoke: (transport: Transport) => Promise<T>,
): Promise<string> {
  const calls: string[] = [];
  const transport = {
    async execChecked(command: string): Promise<string> {
      calls.push(command);
      return output;
    },
  } as unknown as Transport;
  await invoke(transport);
  if (calls.length !== 1) {
    throw new Error(`workspace golden made ${calls.length} checked calls, expected one`);
  }
  return calls[0]!;
}

function syncError(invoke: () => unknown): string {
  try {
    invoke();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("workspace error golden unexpectedly succeeded");
}

async function asyncError(invoke: (transport: Transport) => Promise<unknown>): Promise<string> {
  try {
    await invoke({} as Transport);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("workspace async error golden unexpectedly succeeded");
}
