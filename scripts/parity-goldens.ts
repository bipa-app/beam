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

function main(): void {
  const check = process.argv.slice(2).includes("--check");
  const goldens = new Map<string, string>([
    ["shell-quoting.json", serialize(quotingGolden())],
    ["digest.json", serialize(digestGolden())],
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

main();
