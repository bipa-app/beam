import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveEnv } from "../env.ts";
import type { SshTransport } from "../transport/ssh.ts";
import { ensurePrivateBeamDir } from "../util/private-dir.ts";
import { run, shq } from "../util/shell.ts";

const HERDR_VERSION = "v0.8.0";
const HERDR_LINUX_X86_64_SHA256 =
  "b872ea7e40fa2cb17e857ac9b62b1bf26db7b403c622f5d2f3f5b35f6e9acd28";
const HERDR_LINUX_X86_64_URL =
  `https://github.com/herdrdev/herdr/releases/download/${HERDR_VERSION}/herdr-linux-x86_64`;
const OWNER_TOKEN_SHAPE = /^[a-f0-9]{48}$/;
const PUBLIC_KEY_SHAPE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}$/;
const SSH_KEYGEN_OUTPUT_BYTES_MAX = 16 * 1024;

export type ManagedSshProvider = "e2b" | "modal";

export interface ManagedSshIdentity {
  path: string;
  publicKey: string;
  sha256: string;
}

export function newOwnerToken(): string {
  return randomBytes(24).toString("hex");
}

export function assertOwnerToken(value: unknown, provider: string): string {
  if (typeof value !== "string" || !OWNER_TOKEN_SHAPE.test(value)) {
    throw new Error(
      `${provider} owner token is malformed — state.json tampered or corrupted?`,
    );
  }
  return value;
}

function identityPath(provider: ManagedSshProvider, ownerToken: string): string {
  assertOwnerToken(ownerToken, provider);
  return join(resolveEnv().beamDir, "keys", `${provider}-${ownerToken}.ed25519`);
}

export async function ensureManagedSshIdentity(
  provider: ManagedSshProvider,
  ownerToken: string,
  expectedSha256?: string,
): Promise<ManagedSshIdentity> {
  const path = identityPath(provider, ownerToken);
  if (!existsSync(path)) {
    if (expectedSha256 !== undefined) {
      throw new Error(
        `${provider} SSH identity ${path} is missing — restore the key before connecting`,
      );
    }
    const keyDir = join(resolveEnv().beamDir, "keys");
    ensurePrivateBeamDir(resolveEnv().beamDir);
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    chmodSync(keyDir, 0o700);
    const generated = await run(
      ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", path],
      { maxOutputBytes: SSH_KEYGEN_OUTPUT_BYTES_MAX },
    );
    if (generated.code !== 0) {
      const detail = generated.stderr.trim() || generated.stdout.trim();
      throw new Error(`could not create ${provider} SSH identity at ${path}: ${detail}`);
    }
  }
  chmodSync(path, 0o600);
  const derived = await run(
    ["ssh-keygen", "-y", "-f", path],
    { maxOutputBytes: SSH_KEYGEN_OUTPUT_BYTES_MAX },
  );
  if (derived.code !== 0) {
    const detail = derived.stderr.trim() || derived.stdout.trim();
    throw new Error(`could not read ${provider} SSH identity at ${path}: ${detail}`);
  }
  const fields = derived.stdout.trim().split(/\s+/);
  const publicKey = fields.length < 2 ? "" : `${fields[0]} ${fields[1]}`;
  if (!PUBLIC_KEY_SHAPE.test(publicKey)) {
    throw new Error(`${provider} SSH identity produced a malformed Ed25519 public key`);
  }
  const sha256 = createHash("sha256").update(publicKey).digest("hex");
  if (expectedSha256 !== undefined && expectedSha256 !== sha256) {
    throw new Error(
      `${provider} SSH identity at ${path} does not match this handoff — refusing`,
    );
  }
  return { path, publicKey, sha256 };
}

export function removeManagedSshIdentity(
  provider: ManagedSshProvider,
  ownerToken: string,
): void {
  const path = identityPath(provider, ownerToken);
  rmSync(path, { force: true });
  rmSync(`${path}.pub`, { force: true });
}

export async function bootstrapManagedLinux(
  transport: SshTransport,
  options: { provider: string; useSudo: boolean },
): Promise<void> {
  const elevate = options.useSudo ? "sudo " : "";
  const packages = "rsync curl ca-certificates coreutils";
  const script = [
    "set -eu",
    'if [ "$(uname -m)" != x86_64 ]; then',
    `  echo ${shq(`beam: ${options.provider} requires an x86_64 sandbox`)} >&2; exit 2`,
    "fi",
    "if ! command -v rsync >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then",
    `  command -v apt-get >/dev/null 2>&1 || { echo ${shq(
      `beam: ${options.provider} needs rsync and curl; no apt-get was found`,
    )} >&2; exit 2; }`,
    `  ${elevate}apt-get update -qq`,
    `  ${elevate}apt-get install -y -qq ${packages}`,
    "fi",
    "if ! command -v herdr >/dev/null 2>&1; then",
    '  __beam_herdr="$(mktemp)"',
    `  curl -fsSL -o "$__beam_herdr" ${shq(HERDR_LINUX_X86_64_URL)}`,
    `  printf '%s  %s\\n' ${shq(HERDR_LINUX_X86_64_SHA256)} "$__beam_herdr"` +
      " | sha256sum -c -",
    `  ${elevate}install -m 0755 "$__beam_herdr" /usr/local/bin/herdr`,
    '  rm -f "$__beam_herdr"',
    "fi",
    "command -v rsync >/dev/null && command -v herdr >/dev/null",
  ].join("\n");
  await transport.execChecked(script);
}

export function managedSshCheckLines(): string[] {
  return [
    `local ssh:        ${Bun.which("ssh") ?? "MISSING"}`,
    `local rsync:      ${Bun.which("rsync") ?? "MISSING"}`,
    `local ssh-keygen: ${Bun.which("ssh-keygen") ?? "MISSING"}`,
  ];
}

export function managedSshToolsReady(): boolean {
  return ["ssh", "rsync", "ssh-keygen"].every((tool) => Bun.which(tool) !== null);
}
