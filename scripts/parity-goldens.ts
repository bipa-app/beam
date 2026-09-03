/**
 * Parity-golden extractor for the Rust port (DESIGN.md: Rust port
 * (transition record)). Goal: pin the TypeScript implementation's
 * behavior as committed golden documents that the Rust port must
 * reproduce byte-exactly, so fidelity is a mechanical gate instead of
 * review discipline. Method: run the TS functions under port over
 * fixed, deterministic corpora and fixtures, and serialize the results
 * as canonical JSON (2-space indent, trailing newline).
 *
 * Determinism contract: every input here is a compile-time constant or
 * a committed fixture, and every covered function is a pure function of
 * its inputs — no clocks, nonces, $HOME, or ambient environment can
 * reach the output. A function that grows an environment input is
 * covered by passing the value explicitly, never by reading it here.
 *
 * Usage:
 *   bun scripts/parity-goldens.ts          rewrite parity/goldens/*.json
 *   bun scripts/parity-goldens.ts --check  regenerate in memory and
 *                                          refuse drift without writing
 *
 * Scope grows seam by seam as the port lands: a golden file ships in
 * the same PR as the Rust code it gates. Added goldens stay pure; a
 * seam that needs a clock or nonce injects it as a fixed corpus value.
 */

import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { fileSha256, treeManifest, treeSha256 } from "../src/util/digest.ts";
import { shq, shjoin, shqRemotePath } from "../src/util/shell.ts";
import { CliError, runJsonCommand } from "../src/cli-output.ts";
import { resolveTarget, targetRoot, type Config, type TargetSpec } from "../src/config.ts";
import {
  isRemoteCwdResolved,
  planSessionIdentity,
  type BeamRecord,
} from "../src/state.ts";
import { createProvider } from "../src/provider/index.ts";
import { StaticProvider } from "../src/provider/static.ts";
import type { SandboxState } from "../src/provider/types.ts";
import type { ToolName } from "../src/session/types.ts";
import { ADAPTERS } from "../src/session/index.ts";
import { claudeProjectSlug } from "../src/session/claude.ts";
import { guardedStoreScriptGolden } from "../src/session/guarded-store.ts";
import {
  piFamilyInstallScriptGolden,
  rewriteSessionHeaderCwd,
} from "../src/session/pi-family.ts";
import {
  sessionInstallKey,
  type SessionShipBundle,
} from "../src/session/ship-bundle.ts";
import { HerdrRuntime } from "../src/runtime/herdr.ts";
import type { ExecResult, Transport } from "../src/transport/types.ts";
import { createWalkBlocks } from "../src/transport/local.ts";
import { SshTransport, type SshTransportOptions } from "../src/transport/ssh.ts";
import {
  KubectlTransport,
  archiveReceiptScript,
  markerWalkBlocks,
  parseArchiveReceipt,
  pinRemoteDirScript,
  remotePathSetup,
  syncMarkerFor,
  type KubectlCoords,
} from "../src/transport/kubectl.ts";
import { ownedDestinationBlocks } from "../src/workspace.ts";
import { workspaceGolden } from "./parity-workspace-goldens.ts";

const GOLDENS_DIR = join(import.meta.dir, "..", "parity", "goldens");
const FIXTURES_DIR = join(import.meta.dir, "..", "parity", "fixtures");

/**
 * Hostile-string corpus for the shell-quoting seam. Every entry attacks
 * a quoting failure mode: empty and whitespace-only strings, quote
 * adjacency at both edges, backslash doubling, shell metacharacters,
 * variable/command substitution, glob and word-splitting bait,
 * newline/CR/tab, non-ASCII, and the tilde family that shqRemotePath
 * treats as syntax rather than data.
 */
const QUOTE_INPUTS: readonly string[] = [
  "",
  " ",
  "  ",
  "plain",
  "with space",
  "leading space",
  "trailing space ",
  "'",
  "''",
  "'quoted'",
  "it's",
  "a'b'c",
  "'edge",
  "edge'",
  '"',
  'say "hi" now',
  "\\",
  "\\\\",
  "back\\slash\\path",
  "\\'mixed",
  "$HOME",
  "${HOME}",
  "$(rm -rf /)",
  "`id`",
  "!history",
  "a|b",
  "a;b",
  "a&&b||c",
  "a>b<c",
  "*",
  "?.[x]!{y}",
  "brace,{exp,ansion}",
  "line\nbreak",
  "carriage\rreturn",
  "crlf\r\npair",
  "tab\there",
  "bell\achar",
  "unicode-é-日本語-🚀",
  "ø̈ combining",
  "-",
  "-rf",
  "--",
  "--exclude=*.log",
  "equals=sign",
  "#comment bait",
  "~notleading/tilde",
  "trailing~",
  "a~b",
];

/**
 * Inputs exercised through shqRemotePath: everything above (proving the
 * fallback to shq for ordinary paths) plus the tilde family it exists
 * for — exact "~", "~/", nested tilde paths, and tildes carrying every
 * double-quote escapable: backslash, dollar, double quote, backtick.
 */
const REMOTE_PATH_INPUTS: readonly string[] = [
  ...QUOTE_INPUTS,
  "~",
  "~/",
  "~/plain",
  "~/with space",
  "~/nested/deep/path",
  "~/it's",
  "~/quote'mid",
  "~/$HOME",
  "~/$(id)",
  "~/`id`",
  '~/has"double',
  "~/back\\slash",
  "~/all\\of\"$`them",
  "~/glob/*bait",
  "~/line\nbreak",
  "~~",
  "~root/looks-like-tilde-user",
];

const ONE_SHOT_BYTES = "Beam says: byte-exact or bust.\n";
const MULTI_CHUNK_SIZES = [1, 2, 3, 7, 64, 1024] as const;
const MULTI_CHUNK_TEXT = "The quick brown fox jumps over the lazy dog. 0123456789\n";

interface NamedOutput {
  readonly input: string;
  readonly output: string;
}

interface ArgvOutput {
  readonly argv: readonly string[];
  readonly output: string;
}

function quotingGolden() {
  const shqOutputs: NamedOutput[] = QUOTE_INPUTS.map((input) => {
    return { input, output: shq(input) };
  });
  const shqRemotePathOutputs: NamedOutput[] = REMOTE_PATH_INPUTS.map((input) => {
    return { input, output: shqRemotePath(input) };
  });
  const shjoinOutputs: ArgvOutput[] = [
    { argv: [], output: shjoin([]) },
    { argv: [""], output: shjoin([""]) },
    { argv: ["git", "update-ref", "--stdin"], output: shjoin(["git", "update-ref", "--stdin"]) },
    { argv: ["a b", "'c'", "$d", ""], output: shjoin(["a b", "'c'", "$d", ""]) },
  ];
  return { shq: shqOutputs, shqRemotePath: shqRemotePathOutputs, shjoin: shjoinOutputs };
}

function digestGolden() {
  let digestFailed = false;
  const fixtureStage = mkdtempSync(join(tmpdir(), "beam-parity-"));
  try {
    const treeDir = join(fixtureStage, "tree");
    const oneShotPath = join(FIXTURES_DIR, "tree", "one-shot.txt");
    const multiChunkPath = join(FIXTURES_DIR, "multi-chunk.txt");
    cpSync(join(FIXTURES_DIR, "tree"), treeDir, {
      recursive: true,
      verbatimSymlinks: true,
    });
    chmodSync(treeDir, 0o755);
    for (const path of ["empty-dir", "nested"]) {
      chmodSync(join(treeDir, path), 0o755);
    }
    chmodSync(join(treeDir, "alpha.txt"), 0o755);
    for (const path of [
      "empty-dir/.keep",
      "nested/beta.txt",
      "one-shot.txt",
      "😀.txt",
      ".txt",
    ]) {
      chmodSync(join(treeDir, path), 0o644);
    }
    const oneShotBytes = readFileSync(oneShotPath, "utf8");
    if (oneShotBytes !== ONE_SHOT_BYTES) {
      throw new Error(`one-shot fixture does not match ONE_SHOT_BYTES: ${oneShotPath}`);
    }
    const multiChunkBytes = readFileSync(multiChunkPath, "utf8");
    if (multiChunkBytes !== MULTI_CHUNK_TEXT.repeat(97)) {
      throw new Error(`multi-chunk fixture does not match MULTI_CHUNK_TEXT: ${multiChunkPath}`);
    }
    return {
      oneShot: { bytes: oneShotBytes, sha256: fileSha256(oneShotPath) },
      multiChunk: {
        size: Buffer.byteLength(multiChunkBytes),
        results: MULTI_CHUNK_SIZES.map((chunkBytes) => {
          return { chunkBytes, sha256: fileSha256(multiChunkPath, chunkBytes) };
        }),
      },
      treeSha256: treeSha256(treeDir),
      treeManifest: treeManifest(treeDir),
    };
  } catch (error) {
    digestFailed = true;
    throw error;
  } finally {
    try {
      rmSync(fixtureStage, { recursive: true, force: true });
    } catch (cleanupError) {
      if (!digestFailed) {
        throw cleanupError;
      }
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.error(`cannot clean parity fixture ${fixtureStage}: ${detail}`);
    }
  }
}

function serialize(golden: unknown): string {
  return JSON.stringify(golden, null, 2) + "\n";
}
/** Representative TargetSpec corpus: one per variant, with and without
 * the optional fields, exercising both the serde shape and targetRoot's
 * default-vs-override branch. */
const TARGET_SPECS: Record<string, TargetSpec> = {
  boxDefault: { type: "box" },
  boxFull: { type: "box", root: "/srv/beam", machineType: "large", environment: "dev",
    ttlSeconds: 7200,
  },
  e2b: { type: "e2b", template: "beam-ssh" },
  e2bFull: { type: "e2b", template: "t", user: "agent", timeoutSeconds: 3600, root: "~/x" },
  modal: { type: "modal" },
  modalFull: { type: "modal", app: "a", image: "i", timeoutSeconds: 10, root: "/r" },
  daytona: { type: "daytona" },
  daytonaFull: { type: "daytona", snapshot: "snap", target: "eu", root: "~/d" },
  ssh: { type: "ssh", host: "user@example.com" },
  sshFull: { type: "ssh", host: "h", root: "/data", rsyncFlags: ["-a", "-z", "--delete"] },
  local: { type: "local", root: "/tmp/local-root" },
  localHome: { type: "local", root: "/r", home: "/h", rsyncFlags: ["-a"] },
  agentSandbox: {
    type: "agent-sandbox",
    context: "ctx",
    namespace: "beam-u",
    template: "beam-coding",
    kubeconfig: "/k/config",
  },
  agentSandboxFull: {
    type: "agent-sandbox",
    context: "c",
    namespace: "n",
    template: "t",
    kubeconfig: "/k",
    container: "sandbox",
    root: "/data/bipa",
  },
};

function configGolden() {
  const targetRootOutputs = Object.entries(TARGET_SPECS).map(([name, spec]) => {
    return { name, root: targetRoot(spec) };
  });
  const multi: Config = {
    defaultTarget: "ssh",
    targets: { box: TARGET_SPECS.boxDefault!, ssh: TARGET_SPECS.ssh! },
  };
  const single: Config = { targets: { only: TARGET_SPECS.local! } };
  const resolveCases = [
    { label: "byName", config: multi, name: "box" },
    { label: "default", config: multi, name: undefined },
    { label: "soleTarget", config: single, name: undefined },
  ].map(({ label, config, name }) => {
    try {
      const resolved = resolveTarget(config, name);
      return { label, name: resolved.name, specType: resolved.spec.type };
    } catch (error) {
      return { label, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const resolveErrors = [
    { label: "unknownName", config: multi, name: "ghost" },
    { label: "noTargets", config: { targets: {} }, name: undefined },
  ].map(({ label, config, name }) => {
    try {
      resolveTarget(config, name);
      return { label, resolved: true };
    } catch (error) {
      return { label, error: error instanceof Error ? error.message : String(error) };
    }
  });
  return { targetRoot: targetRootOutputs, resolve: resolveCases, resolveErrors };
}

/** Drive runJsonCommand with mock commands and capture the single document
 * it writes to stdout. Determinism: the mock commands emit fixed messages
 * and data; the only ambient input runJsonCommand reads is process.exitCode,
 * which each mock sets explicitly. */
async function cliOutputGolden() {
  const documents: { label: string; exitCode: number; document: string }[] = [];
  const realLog = console.log;
  async function capture(label: string, runCommand: () => Promise<unknown>): Promise<void> {
    let document = "";
    console.log = (...values: unknown[]) => {
      document += values.map(String).join(" ");
    };
    let exitCode: number;
    try {
      exitCode = await runJsonCommand("probe", runCommand);
    } finally {
      console.log = realLog;
      process.exitCode = 0;
    }
    documents.push({ label, exitCode, document });
  }
  await capture("success", async () => {
    console.log("setup complete");
    console.warn("careful now");
    return { answer: 42, nested: { list: [1, 2] } };
  });
  await capture("successNullData", async () => undefined);
  await capture("cliError", async () => {
    console.error("about to fail");
    throw new CliError("bad_input", "the thing was wrong", { field: "root" });
  });
  await capture("plainError", async () => {
    throw new Error("boom");
  });
  await capture("nonErrorThrow", async () => {
    // eslint-disable-next-line no-throw-literal
    throw "string failure";
  });
  await capture("nonzeroExitCode", async () => {
    console.log("last word");
    process.exitCode = 3;
    return { ignored: true };
  });
  return { documents };
}

/** Minimal BeamRecord factory: planSessionIdentity and isRemoteCwdResolved
 * read only id/tool/sessionId/remoteCwd/remoteCwdResolved, so the corpus
 * fills the rest with fixed placeholders. */
function record(partial: Partial<BeamRecord>): BeamRecord {
  return {
    id: "abc123",
    target: "ssh",
    localCwd: "/local/work",
    remoteCwd: "/remote/work",
    runtimeSession: "beam-abc123",
    status: "up",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function stateGolden() {
  const withSession = record({ tool: "omp", sessionId: "sess-1" });
  const unresolved = record({
    tool: "omp",
    sessionId: "sess-1",
    remoteCwd: "~/beam/work",
    remoteCwdResolved: false,
  });
  const planCases: {
    label: string;
    record: BeamRecord;
    requested: { tool: ToolName; sessionId: string } | undefined;
    explicit: boolean;
  }[] = [
    { label: "noStored", record: record({}), requested: undefined, explicit: false },
    {
      label: "matchStored",
      record: withSession,
      requested: { tool: "omp", sessionId: "sess-1" },
      explicit: true,
    },
    { label: "driftRetain", record: withSession, requested: undefined, explicit: false },
    {
      label: "explicitSwitchResolved",
      record: withSession,
      requested: { tool: "pi", sessionId: "sess-2" },
      explicit: true,
    },
    { label: "explicitClearResolved", record: withSession, requested: undefined, explicit: true },
    {
      label: "explicitSwitchUnresolved",
      record: unresolved,
      requested: { tool: "pi", sessionId: "sess-2" },
      explicit: true,
    },
  ];
  const planOutputs = planCases.map(({ label, record: r, requested, explicit }) => {
    return { label, plan: planSessionIdentity(r, requested, explicit) };
  });
  const cwdResolved = [
    { label: "absolutePath", record: record({ remoteCwd: "/abs" }) },
    { label: "tildeUnresolved", record: record({ remoteCwd: "~/rel" }) },
    { label: "tildeResolvedFlag", record: record({ remoteCwd: "~/rel", remoteCwdResolved: true }) },
    { label: "absoluteResolvedFalse", record: record({
      remoteCwd: "/abs",
      remoteCwdResolved: false,
    }) },
  ].map(({ label, record: r }) => {
    return { label, resolved: isRemoteCwdResolved(r) };
  });
  return { planSessionIdentity: planOutputs, isRemoteCwdResolved: cwdResolved };
}

class ProviderGoldenTransport implements Transport {
  readonly label = "provider golden transport";

  async exec(): Promise<ExecResult> {
    return { code: 0, stdout: "", stderr: "" };
  }

  async execChecked(): Promise<string> {
    return "";
  }

  async syncUp(): Promise<void> {}

  async syncDown(): Promise<void> {}

  async exists(): Promise<boolean> {
    return false;
  }

  interactiveArgv(): string[] {
    return [];
  }
}

async function providerCoreGolden() {
  const sandboxStates = providerSandboxStates();
  const transport = new ProviderGoldenTransport();
  const provider = new StaticProvider(transport);
  const ref = { id: "rec1" };
  let persistCalls = 0;
  const provisioned = await provider.provision(ref, () => {
    persistCalls += 1;
  });
  const connected = await provider.connect(ref);
  await provider.destroy(ref);
  const sshProvider = createProvider({
    type: "ssh",
    host: "sandbox.example",
    rsyncFlags: ["-a"],
  });
  const localProvider = createProvider({
    type: "local",
    root: "/beam",
    home: "/",
    rsyncFlags: ["-a"],
  });
  const directory = mkdtempSync(join(tmpdir(), "beam-provider-golden-"));
  const rsync = join(directory, "rsync");
  const path = process.env.PATH;
  try {
    process.env.PATH = directory;
    writeFileSync(rsync, "#!/bin/sh\nexit 0\n");
    chmodSync(rsync, 0o755);
    const available = await provider.check();
    writeFileSync(rsync, "#!/bin/sh\nexit 127\n");
    const missing = await provider.check();
    return {
      sandboxStates,
      staticFactories: {
        ssh: {
          label: sshProvider.label,
          reusesSandbox: sshProvider.reusesSandbox,
        },
        local: {
          label: localProvider.label,
          reusesSandbox: localProvider.reusesSandbox,
        },
      },
      staticProvider: {
        label: provider.label,
        reusesSandbox: provider.reusesSandbox,
        sandboxState: provider.sandboxState(ref) ?? null,
        provisionReturnsTransport: provisioned === transport,
        connectReturnsTransport: connected === transport,
        persistCalls,
        destroysWithoutConnection:
          "destroyAfterVerifiedCleanupWithoutConnection" in provider,
        available,
        missing,
      },
    };
  } finally {
    if (path === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = path;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function providerSandboxStates(): Record<string, SandboxState> {
  return {
    agentLegacy: {
      claim: "beam-rec1",
      context: "ctx",
      namespace: "beam-user",
      container: "sandbox",
    },
    agentPinned: {
      claim: "beam-rec1",
      context: "ctx",
      namespace: "beam-user",
      container: "sandbox",
      kubeconfig: "/keys/beam",
      template: "beam-coding",
      uid: "claim-uid",
    },
    box: { kind: "box", boxId: "box-123" },
    e2bInitial: { kind: "e2b", ownerToken: "owner-e2b" },
    e2bPinned: {
      kind: "e2b",
      ownerToken: "owner-e2b",
      sandboxId: "sandbox-e2b",
      sshKeySha256: "a".repeat(64),
    },
    modalInitial: {
      kind: "modal",
      ownerToken: "owner-modal",
      sandboxName: "beam-rec1-owner",
      volumeName: "beam-rec1-owner",
    },
    modalPinned: {
      kind: "modal",
      ownerToken: "owner-modal",
      sandboxName: "beam-rec1-owner",
      volumeName: "beam-rec1-owner",
      sshKeySha256: "b".repeat(64),
      volumeOwned: true,
      bootstrappedSandboxId: "modal-sandbox",
    },
    daytonaInitial: {
      kind: "daytona",
      ownerToken: "owner-daytona",
      sandboxName: "beam-rec1-owner",
    },
    daytonaPinned: {
      kind: "daytona",
      ownerToken: "owner-daytona",
      sandboxName: "beam-rec1-owner",
      sandboxId: "daytona-sandbox",
    },
  };
}

const LOCAL_WALK_PATHS = [
  "/",
  "/tmp/beam/work",
  "/tmp/ha rd 'quo$te` );&|/leaf",
] as const;

function localTransportGolden() {
  const owner = "beam-workspace-v1 rec1 0123456789abcdef0123456789abcdef";
  const ownedCases = [
    { label: "root", relative: [], create: false },
    { label: "reservedRoot", relative: [".beam"], create: true },
    { label: "nestedCreate", relative: [".beam", "git", "gen 'quoted'"], create: true },
    { label: "nestedRead", relative: [".beam", "sessions", "omp"], create: false },
  ];
  return {
    createWalkBlocks: LOCAL_WALK_PATHS.map((input) => {
      return { input, output: createWalkBlocks(input) };
    }),
    ownedDestinationBlocks: ownedCases.map(({ label, relative, create }) => {
      const output = ownedDestinationBlocks(owner, relative, { create });
      return { label, owner, relative, create, output };
    }),
  };
}
interface SshPinnedCase {
  readonly label: string;
  readonly remoteDir: string;
  readonly create: boolean;
  readonly owned?: { readonly root: string; readonly ownerBytes: string };
}

function sshTransportGolden() {
  const ownerBytes = "beam-workspace-v1 rec1 0123456789abcdef0123456789abcdef";
  const pinnedCases: readonly SshPinnedCase[] = [
    { label: "absoluteCreate", remoteDir: "/srv/beam/workspace", create: true },
    { label: "tildeRead", remoteDir: "~/beam/ha rd 'quoted'", create: false },
    {
      label: "ownedRootRead",
      remoteDir: "/srv/beam/workspace",
      create: false,
      owned: { root: "/srv/beam/workspace", ownerBytes },
    },
    {
      label: "ownedNestedCreate",
      remoteDir: "~/beam/workspace/.beam/session/gen 'quoted'",
      create: true,
      owned: { root: "~/beam/workspace", ownerBytes },
    },
  ];
  const transport = new SshTransport("unused") as unknown as {
    pinnedRsyncPath(
      remoteDir: string,
      create: boolean,
      owned?: { root: string; ownerBytes: string },
    ): string;
  };
  const pinnedRsyncPath = pinnedCases.map((entry) => {
    const output = transport.pinnedRsyncPath(entry.remoteDir, entry.create, entry.owned);
    return { ...entry, output };
  });
  const interactiveInputs: {
    label: string;
    host: string;
    options: SshTransportOptions;
    command: string;
  }[] = [
    { label: "default", host: "user@sandbox.example", options: {}, command: "true" },
    {
      label: "providerOptions",
      host: "root@203.0.113.10",
      options: {
        label: "box box_123",
        rsyncFlags: ["-a"],
        sshOptions: ["-i", "/tmp/key with space", "-o", "HostKeyAlias=box_123"],
      },
      command: "printf %s \"$HOME/it's\"",
    },
  ];
  const interactiveArgv = interactiveInputs.map(({ label, host, options, command }) => {
    const candidate = new SshTransport(host, options);
    return { label, host, options, command, transportLabel: candidate.label,
      output: candidate.interactiveArgv(command),
    };
  });
  const errors = ["", "-oProxyCommand=touch owned"].map((host) => {
    try {
      new SshTransport(host);
      return { host, error: "" };
    } catch (error) {
      return { host, error: error instanceof Error ? error.message : String(error) };
    }
  });
  return { interactiveArgv, pinnedRsyncPath, errors };
}


const KUBECTL_PATHS = [
  "~",
  "~/",
  "~/beam/../work/",
  "/srv/beam/workspace",
  "/srv/beam/workspace/.beam/git/gen-1",
  "/srv/beam/workspace/.beam",
  "/ha rd/it's",
] as const;

function captureString(input: string, operation: () => string) {
  try {
    return { input, output: operation() };
  } catch (error) {
    return { input, error: error instanceof Error ? error.message : String(error) };
  }
}

function kubectlInteractiveGolden() {
  const inputs: {
    label: string;
    coords: KubectlCoords;
    pod: string;
    command: string;
  }[] = [
    {
      label: "defaultKubeconfig",
      coords: { context: "sandbox", namespace: "beam-user", container: "sandbox" },
      pod: "beam-abc",
      command: "printf %s \"$HOME/it's\"",
    },
    {
      label: "explicitKubeconfig",
      coords: {
        context: "ctx",
        namespace: "ns",
        container: "agent",
        kubeconfig: "/tmp/kube config",
      },
      pod: "pod-1",
      command: "true",
    },
  ];
  return inputs.map(({ label, coords, pod, command }) => {
    const transport = new KubectlTransport(coords, pod);
    return {
      label,
      coords,
      pod,
      command,
      transportLabel: transport.label,
      output: transport.interactiveArgv(command),
    };
  });
}

function kubectlReceiptGolden() {
  return [
    `${"a".repeat(64)} 0`,
    `  ${"b".repeat(64)}\t42\n`,
    `${"c".repeat(64)} 9007199254740992`,
    "not-a-receipt",
  ].map((input) => {
    try {
      return { input, output: parseArchiveReceipt(input) };
    } catch (error) {
      return { input, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function kubectlTransportGolden() {
  const interactiveArgv = kubectlInteractiveGolden();
  const pathSetup = [
    ...KUBECTL_PATHS,
    "relative/path",
    "line\nbreak",
  ].map((input) => captureString(input, () => remotePathSetup(input)));
  const pinRemoteDir = KUBECTL_PATHS.flatMap((input) => {
    return [false, true].map((create) => {
      const captured = captureString(input, () => pinRemoteDirScript(input, create));
      return { ...captured, create };
    });
  });
  const receipts = kubectlReceiptGolden();
  return {
    interactiveArgv,
    syncMarkerFor: KUBECTL_PATHS.map((input) => {
      return { input, output: syncMarkerFor(input) };
    }),
    pathSetup,
    pinRemoteDir,
    markerWalkBlocks: ["create", "probe", "invalidate"].map((mode) => {
      const typed = mode as "create" | "probe" | "invalidate";
      return { mode, output: markerWalkBlocks(typed) };
    }),
    archiveReceiptScript: ["/tmp/archive.tar.gz", "/tmp/it's archive"].map((input) => {
      return { input, output: archiveReceiptScript(input) };
    }),
    parseArchiveReceipt: receipts,
  };
}

function sessionHeaderRewriteGolden() {
  return [
    {
      input:
        '{"type":"title","v":1,"title":"t"}\n' +
        '{"type":"session","version":3,"id":"abc","timestamp":"2026-01-01","cwd":"/old"}\n' +
        '{"type":"message","id":"m1"}\n',
      cwd: "/remote/work space",
    },
    {
      input: '{"type":"session","id":"abc","cwd":"/old","extra":{"z":1}}\n',
      cwd: "/new",
    },
    {
      input:
        Array.from({ length: 20 }, (_, index) => {
          return `{"type":"message","id":"before-${index}"}\n`;
        }).join("") +
        '{"type":"session","id":"abc","cwd":"/old"}\n' +
        '{"type":"message","id":"after"}\n',
      cwd: "/after-twenty",
    },
    {
      input: '{"type":"session","id":"abc","cwd":\n',
      cwd: "/new",
    },
    {
      input: '{"type": "session", "id": "abc", "cwd": "/old"}\n',
      cwd: "/new",
    },
  ].map(({ input, cwd }) => {
    try {
      return { input, cwd, output: rewriteSessionHeaderCwd(input, cwd) };
    } catch (error) {
      return { input, cwd, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function sessionAdapterGolden() {
  const slugs = [
    "/Users/example/work/a.b_c",
    "/tmp/space here/.config",
    "/",
  ].map((input) => {
    return { input, output: claudeProjectSlug(input) };
  });
  const rewrites = sessionHeaderRewriteGolden();
  const bundles: SessionShipBundle[] = [
    {
      tool: "omp",
      id: "abc-123",
      transcriptSha256: "0".repeat(64),
    },
    {
      tool: "pi",
      id: "session with spaces",
      transcriptSha256: "a".repeat(64),
      artifactsSha256: "b".repeat(64),
    },
  ];
  return {
    adapters: ADAPTERS.map((adapter) => {
      return {
        tool: adapter.tool,
        binary: adapter.binary,
        loginArgv: adapter.loginArgv,
        remoteAuthProbe: adapter.remoteAuthProbe ?? null,
      };
    }),
    slugs,
    rewrites,
    installKeys: bundles.map((bundle) => {
      return { bundle, output: sessionInstallKey(bundle) };
    }),
    guardedStoreScripts: guardedStoreScriptGolden(),
    piFamilyInstallScripts: piFamilyInstallScriptGolden(),
  };
}

async function herdrRuntimeGolden() {
  const name = "beam-parity";
  const scripts = [
    ...(await herdrRuntimeGoldenStart(name)),
    ...(await herdrRuntimeGoldenEnvironment(name)),
    ...(await herdrRuntimeGoldenAlive(name)),
    ...(await herdrRuntimeGoldenPeek(name)),
    ...(await herdrRuntimeGoldenControl(name)),
  ];
  const unused = {} as unknown as Transport;
  scripts.push({
    label: "attach-command",
    output: new HerdrRuntime(unused).attachCommand(name),
  });
  return { scripts };
}

async function herdrRuntimeGoldenStart(name: string) {
  const transport = new HerdrGoldenTransport([
    { kind: "checked", output: "" },
    { kind: "checked", output: "" },
    { kind: "checked", output: herdrWorkspaceCreatedJson("w1:p1") },
    { kind: "checked", output: "" },
  ]);
  const runtime = new HerdrRuntime(transport as unknown as Transport);
  await runtime.start(name, "/srv/beam/work space", ["omp", "--resume", "session 'x'"]);
  const calls = transport.done();
  if (calls.length !== 4) {
    throw new Error(`herdr start golden made ${calls.length} calls, expected 4`);
  }
  return [
    { label: "start-upload", output: calls[0]! },
    { label: "start-ensure-server", output: calls[1]! },
    { label: "start-workspace-create", output: calls[2]! },
    { label: "start-pane-run", output: calls[3]! },
  ];
}

async function herdrRuntimeGoldenEnvironment(name: string) {
  const cwdAbs = "/srv/beam/work space";
  const owner = "record=parity\nworkspace_token=owner\n";
  const prepare = new HerdrGoldenTransport([{ kind: "checked", output: "" }]);
  const prepared = await new HerdrRuntime(prepare as unknown as Transport).prepareEnvironment(
    cwdAbs,
    { LLM_PROXY_SESSION_TOKEN: "token 'x'" },
    owner,
  );
  if (prepared === undefined) {
    throw new Error("herdr environment golden did not stage its environment");
  }
  const start = new HerdrGoldenTransport([
    { kind: "checked", output: "" },
    { kind: "checked", output: "" },
    { kind: "checked", output: herdrWorkspaceCreatedJson("w1:p1") },
    { kind: "checked", output: "" },
    { kind: "checked", output: "" },
  ]);
  await new HerdrRuntime(start as unknown as Transport).start(
    name,
    cwdAbs,
    ["omp", "--resume", "session 'x'"],
    { preparedEnvironment: prepared },
  );
  const discard = new HerdrGoldenTransport([{ kind: "checked", output: "" }]);
  await new HerdrRuntime(discard as unknown as Transport).discardEnvironment(prepared);
  const prepareCalls = prepare.done();
  const startCalls = start.done();
  const discardCalls = discard.done();
  const calls = [...prepareCalls, ...startCalls, ...discardCalls];
  if (calls.some((call) => call.includes("token 'x'"))) {
    throw new Error("herdr environment golden leaked credentials into a command");
  }
  return [
    { label: "environment-secure", output: prepareCalls[0]! },
    { label: "environment-start-upload", output: startCalls[0]! },
    { label: "environment-start-ensure-server", output: startCalls[1]! },
    { label: "environment-start-workspace-create", output: startCalls[2]! },
    { label: "environment-start-pane-run", output: startCalls[3]! },
    { label: "environment-consume", output: startCalls[4]! },
    { label: "environment-discard", output: discardCalls[0]! },
  ];
}

async function herdrRuntimeGoldenAlive(name: string) {
  const present = new HerdrGoldenTransport([
    { kind: "exec", result: { code: 0, stdout: herdrPaneListJson(["w1:p1"]), stderr: "" } },
  ]);
  const absent = new HerdrGoldenTransport([
    { kind: "exec", result: { code: 0, stdout: herdrPaneListJson([]), stderr: "" } },
  ]);
  const presentResult = await new HerdrRuntime(present as unknown as Transport).alive(name);
  const absentResult = await new HerdrRuntime(absent as unknown as Transport).alive(name);
  if (!presentResult || absentResult) {
    throw new Error("herdr alive golden did not classify pane presence");
  }
  return [
    { label: "alive-present-list", output: present.done()[0]! },
    { label: "alive-absent-list", output: absent.done()[0]! },
  ];
}

async function herdrRuntimeGoldenPeek(name: string) {
  const screen = "first\n\nsecond\nthird";
  const transport = new HerdrGoldenTransport([
    { kind: "checked", output: herdrPaneListJson(["w1:p1"]) },
    { kind: "checked", output: screen },
  ]);
  const output = await new HerdrRuntime(transport as unknown as Transport).peek(name, 2);
  if (output !== "second\nthird") {
    throw new Error(`herdr peek golden returned ${JSON.stringify(output)}`);
  }
  const calls = transport.done();
  if (calls.length !== 2) {
    throw new Error(`herdr peek golden made ${calls.length} calls, expected 2`);
  }
  return [
    { label: "peek-pane-list", output: calls[0]! },
    { label: "peek-pane-read", output: calls[1]! },
  ];
}

async function herdrRuntimeGoldenControl(name: string) {
  const interrupt = new HerdrGoldenTransport([
    { kind: "exec", result: { code: 0, stdout: herdrPaneListJson(["w1:p1"]), stderr: "" } },
    { kind: "exec", result: { code: 0, stdout: "", stderr: "" } },
  ]);
  await new HerdrRuntime(interrupt as unknown as Transport).interrupt(name);
  const kill = new HerdrGoldenTransport([
    { kind: "exec", result: { code: 0, stdout: "", stderr: "" } },
    { kind: "exec", result: { code: 0, stdout: "", stderr: "" } },
  ]);
  await new HerdrRuntime(kill as unknown as Transport).kill(name);
  const interruptCalls = interrupt.done();
  const killCalls = kill.done();
  if (interruptCalls.length !== 2 || killCalls.length !== 2) {
    throw new Error("herdr control golden did not make two calls per operation");
  }
  return [
    { label: "interrupt-pane-list", output: interruptCalls[0]! },
    { label: "interrupt-send-keys", output: interruptCalls[1]! },
    { label: "kill-server-stop", output: killCalls[0]! },
    { label: "kill-session-delete", output: killCalls[1]! },
  ];
}

function herdrPaneListJson(paneIds: readonly string[]): string {
  return JSON.stringify({
    id: "cli:pane:list",
    result: { panes: paneIds.map((pane_id) => ({ pane_id })), type: "pane_list" },
  });
}

function herdrWorkspaceCreatedJson(paneId: string): string {
  return JSON.stringify({
    id: "cli:workspace:create",
    result: { root_pane: { pane_id: paneId }, type: "workspace_created" },
  });
}

type HerdrGoldenStep =
  | { readonly kind: "exec"; readonly result: ExecResult }
  | { readonly kind: "checked"; readonly output: string };

class HerdrGoldenTransport {
  readonly calls: string[] = [];

  constructor(private readonly steps: HerdrGoldenStep[]) {}

  async exec(command: string): Promise<ExecResult> {
    const step = this.take(command);
    if (step.kind === "exec") {
      return step.result;
    }
    throw new Error(`expected checked herdr call, got exec: ${command}`);
  }

  async execChecked(command: string): Promise<string> {
    const step = this.take(command);
    if (step.kind === "checked") {
      return step.output;
    }
    throw new Error(`expected exec herdr call, got checked: ${command}`);
  }

  async syncUp(): Promise<void> {}

  done(): readonly string[] {
    if (this.steps.length !== 0) {
      throw new Error(`herdr golden left ${this.steps.length} scripted calls unused`);
    }
    return this.calls;
  }

  private take(command: string): HerdrGoldenStep {
    this.calls.push(command);
    const step = this.steps.shift();
    if (step === undefined) {
      throw new Error(`unscripted herdr golden call: ${command}`);
    }
    return step;
  }
}

async function main(): Promise<void> {
  const check = process.argv.slice(2).includes("--check");
  const goldens = new Map<string, string>([
    ["shell-quoting.json", serialize(quotingGolden())],
    ["digest.json", serialize(digestGolden())],
    ["config.json", serialize(configGolden())],
    ["cli-output.json", serialize(await cliOutputGolden())],
    ["state.json", serialize(stateGolden())],
    ["provider-core.json", serialize(await providerCoreGolden())],
    ["local-transport.json", serialize(localTransportGolden())],
    ["ssh-transport.json", serialize(sshTransportGolden())],
    ["kubectl-transport.json", serialize(kubectlTransportGolden())],
    ["herdr-runtime.json", serialize(await herdrRuntimeGolden())],
    ["workspace.json", serialize(await workspaceGolden())],
    ["session-adapters.json", serialize(sessionAdapterGolden())],
  ]);
  let drifted = false;
  for (const [name, rendered] of goldens) {
    const path = join(GOLDENS_DIR, name);
    if (!check) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, rendered);
      console.log(`wrote ${name}`);
      continue;
    }
    let current: string;
    try {
      current = readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error) {
        if ("code" in error) {
          if (error.code === "ENOENT") {
            console.error(`missing golden ${name} — run bun scripts/parity-goldens.ts`);
            drifted = true;
            continue;
          }
        }
      }
      throw new Error(`cannot read golden ${path}`, { cause: error });
    }
    if (current !== rendered) {
      console.error(`golden drift in ${name} — regenerate with bun scripts/parity-goldens.ts`);
      drifted = true;
    }
  }
  if (drifted) {
    process.exit(1);
  }
}

await main();
