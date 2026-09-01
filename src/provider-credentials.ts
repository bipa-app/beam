import type { ToolName } from "./session/index.ts";
import { run, type RunResult } from "./util/shell.ts";

/** Provider identities understood by the current coding-client adapters. */
type ProviderId = "anthropic" | "openai";

/** Environment delivered only to the remote coding-client process. */
export type ProviderCredentialEnvironment = Readonly<Record<string, string>>;

interface DirectoryAccount {
  providerId: string;
  authMaterialKind: string;
  state: string;
  sanctionCurrent: boolean;
}

/** A credential lookup is advisory and must never hold sandbox provisioning indefinitely. */
const LLM_PROXY_TIMEOUT_MS = 5_000;
/** The directory is metadata-only; a larger response is invalid for a handoff preflight. */
const LLM_PROXY_OUTPUT_BYTES_MAX = 1024 * 1024;

function parseDirectoryAccounts(stdout: string): DirectoryAccount[] {
  const value: unknown = JSON.parse(stdout);
  if (typeof value !== "object" || value === null) {
    throw new Error("account directory is not an object");
  }
  if (!("accounts" in value)) throw new Error("account directory has no accounts field");
  const accounts = value.accounts;
  if (!Array.isArray(accounts)) throw new Error("account directory has no accounts array");

  const parsed: DirectoryAccount[] = [];
  for (const account of accounts) {
    if (typeof account !== "object" || account === null) {
      throw new Error("account directory contains a non-object entry");
    }
    if (
      !("provider_id" in account) ||
      !("auth_material_kind" in account) ||
      !("state" in account) ||
      !("sanction_current" in account)
    ) {
      throw new Error("account directory entry is missing provider metadata");
    }
    const providerId = account.provider_id;
    const authMaterialKind = account.auth_material_kind;
    const state = account.state;
    const sanctionCurrent = account.sanction_current;
    if (
      typeof providerId !== "string" ||
      typeof authMaterialKind !== "string" ||
      typeof state !== "string" ||
      typeof sanctionCurrent !== "boolean"
    ) {
      throw new Error("account directory entry is missing provider metadata");
    }
    parsed.push({ providerId, authMaterialKind, state, sanctionCurrent });
  }
  return parsed;
}

async function runProxyCommand(args: string[]): Promise<RunResult | undefined> {
  try {
    return await run(["llm-proxy", ...args], {
      maxOutputBytes: LLM_PROXY_OUTPUT_BYTES_MAX,
      timeoutMs: LLM_PROXY_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
}

async function eligibleProviderAccounts(
  tool: ToolName,
  provider: ProviderId,
): Promise<DirectoryAccount[] | undefined> {
  const directory = await runProxyCommand(["accounts"]);
  if (directory === undefined) {
    console.warn(
      `warning: llm-proxy accounts is unreachable; continuing ${tool} handoff ` +
        "with local credentials",
    );
    return undefined;
  }
  if (directory.code !== 0) {
    console.warn(
      `warning: llm-proxy accounts failed; continuing ${tool} handoff with local credentials`,
    );
    return undefined;
  }

  let accounts: DirectoryAccount[];
  try {
    accounts = parseDirectoryAccounts(directory.stdout);
  } catch {
    console.warn(
      `warning: llm-proxy accounts returned invalid data; continuing ${tool} handoff ` +
        "with local credentials",
    );
    return undefined;
  }
  return accounts.filter(
    (account) =>
      account.providerId === provider &&
      account.state === "active" &&
      account.sanctionCurrent,
  );
}

async function openProviderEnrollment(provider: ProviderId): Promise<void> {
  const enrollment = await runProxyCommand(["enroll", provider]);
  if (enrollment === undefined || enrollment.code !== 0) {
    console.warn(
      `warning: llm-proxy enroll ${provider} failed; continuing with local credentials`,
    );
  }
}

async function readSessionToken(tool: ToolName): Promise<string | undefined> {
  const credential = await runProxyCommand(["credential"]);
  if (credential === undefined) {
    console.warn(
      `warning: llm-proxy credential is unavailable; continuing ${tool} handoff ` +
        "with local credentials",
    );
    return undefined;
  }
  const token = credential.stdout.trim();
  if (credential.code !== 0 || token === "") {
    console.warn(
      `warning: llm-proxy credential failed; continuing ${tool} handoff with local credentials`,
    );
    return undefined;
  }
  return token;
}

/**
 * Resolve best-effort proxy credentials before `beam up` reserves or provisions
 * a sandbox. Unknown-provider harnesses keep their existing local-auth path.
 */
export async function resolveProviderCredentialEnvironment(
  tool: ToolName | undefined,
): Promise<ProviderCredentialEnvironment> {
  let provider: ProviderId | undefined;
  if (tool === "claude") provider = "anthropic";
  if (tool === "codex") provider = "openai";
  if (provider === undefined || tool === undefined) return {};

  const eligible = await eligibleProviderAccounts(tool, provider);
  if (eligible === undefined) return {};
  if (eligible.length === 0) {
    await openProviderEnrollment(provider);
    return {};
  }

  const token = await readSessionToken(tool);
  if (token === undefined) return {};
  const environment: Record<string, string> = { LLM_PROXY_SESSION_TOKEN: token };
  if (
    tool === "claude" &&
    eligible.some((account) => account.authMaterialKind === "access_token")
  ) {
    environment.CLAUDE_CODE_OAUTH_TOKEN = token;
  }
  return environment;
}
