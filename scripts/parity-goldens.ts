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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import type { ToolName } from "../src/session/types.ts";
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
  const treeDir = join(FIXTURES_DIR, "tree");
  const oneShotPath = join(FIXTURES_DIR, "tree", "one-shot.txt");
  const multiChunkPath = join(FIXTURES_DIR, "multi-chunk.txt");
  const oneShot = {
    bytes: ONE_SHOT_BYTES,
    sha256: fileSha256(oneShotPath),
  };
  const multiChunk = {
    size: MULTI_CHUNK_TEXT.length * 97,
    results: MULTI_CHUNK_SIZES.map((chunkBytes) => {
      return { chunkBytes, sha256: fileSha256(multiChunkPath, chunkBytes) };
    }),
  };
  return {
    oneShot,
    multiChunk,
    treeSha256: treeSha256(treeDir),
    treeManifest: treeManifest(treeDir),
  };
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

async function main(): Promise<void> {
  const check = process.argv.slice(2).includes("--check");
  const goldens = new Map<string, string>([
    ["shell-quoting.json", serialize(quotingGolden())],
    ["digest.json", serialize(digestGolden())],
    ["config.json", serialize(configGolden())],
    ["cli-output.json", serialize(await cliOutputGolden())],
    ["state.json", serialize(stateGolden())],
    ["local-transport.json", serialize(localTransportGolden())],
    ["ssh-transport.json", serialize(sshTransportGolden())],
    ["kubectl-transport.json", serialize(kubectlTransportGolden())],
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
    } catch {
      console.error(`missing golden ${name} — run bun scripts/parity-goldens.ts`);
      drifted = true;
      continue;
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
