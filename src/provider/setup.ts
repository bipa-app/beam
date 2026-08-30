import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TargetSpec } from "../config.ts";
import { run } from "../util/shell.ts";

const SETUP_OUTPUT_BYTES_MAX = 1024 * 1024;
const JSON_NODES_MAX = 4096;
const RESOURCE_NAME = "beam-coding";
const BOX_ENVIRONMENT = "beam";

export type ManagedProviderName = "box" | "daytona" | "e2b" | "modal";
export type SetupStatus = "applied" | "needs_input" | "passed" | "planned";

export interface SetupAction {
  id: string;
  status: SetupStatus;
  description: string;
  command?: string;
}

export interface ProviderSetupPlan {
  provider: ManagedProviderName;
  image?: string;
  actions: SetupAction[];
}

function requiredTools(provider: ManagedProviderName): string[] {
  if (provider === "box") return ["box", "ssh", "rsync"];
  if (provider === "e2b") return ["e2b", "websocat", "ssh", "rsync", "ssh-keygen"];
  if (provider === "modal") return ["modal", "ssh", "rsync", "ssh-keygen"];
  return ["daytona", "ssh", "rsync"];
}

function installCommand(provider: ManagedProviderName): string {
  if (provider === "box") return "curl -fsSL https://box.ascii.dev/install | sh";
  if (provider === "e2b") return "npm install -g @e2b/cli";
  if (provider === "modal") return "curl -LsSf uvx.sh/modal/install.sh | sh";
  return "brew install daytonaio/cli/daytona";
}

async function inspectPrerequisites(provider: ManagedProviderName): Promise<SetupAction> {
  const missing = requiredTools(provider).filter((tool) => Bun.which(tool) === null);
  if (missing.length > 0) {
    return {
      id: "provider.prerequisites",
      status: "needs_input",
      description: `missing local tools: ${missing.join(", ")}`,
      command: installCommand(provider),
    };
  }
  if (provider === "e2b" && !process.env.E2B_API_KEY) {
    return {
      id: "provider.prerequisites",
      status: "needs_input",
      description: "E2B_API_KEY is not set for Beam's REST lifecycle",
      command: "e2b auth login  # then export E2B_API_KEY from the E2B dashboard",
    };
  }
  const argv = providerAuthArgv(provider);
  if (argv === undefined) return prerequisitePass(provider);
  const result = await run(argv, { maxOutputBytes: SETUP_OUTPUT_BYTES_MAX });
  if (result.code === 0) return prerequisitePass(provider);
  return {
    id: "provider.prerequisites",
    status: "needs_input",
    description: `${provider} is installed but not authenticated`,
    command: providerLoginCommand(provider),
  };
}

function prerequisitePass(provider: ManagedProviderName): SetupAction {
  return {
    id: "provider.prerequisites",
    status: "passed",
    description: `${provider} CLI, account, and local transport tools are ready`,
  };
}

function providerAuthArgv(provider: ManagedProviderName): string[] | undefined {
  if (provider === "box") return ["box", "limits", "--json"];
  if (provider === "modal") return ["modal", "token", "info"];
  if (provider === "daytona") return ["daytona", "list", "--limit", "1", "--format", "json"];
  return undefined;
}

function providerLoginCommand(provider: ManagedProviderName): string {
  if (provider === "box") return "box onboard";
  if (provider === "modal") return "modal setup";
  if (provider === "daytona") return "daytona login";
  return "e2b auth login";
}

function jsonHasNamedResource(text: string, name: string): boolean {
  const root = JSON.parse(text) as unknown;
  const stack: unknown[] = [root];
  let count = 0;
  while (stack.length > 0) {
    count++;
    if (count > JSON_NODES_MAX) throw new Error("provider resource list exceeded node ceiling");
    const value = stack.pop();
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (record.name === name || record.alias === name) return true;
    for (const child of Object.values(record)) stack.push(child);
  }
  return false;
}

async function inspectResource(provider: ManagedProviderName): Promise<SetupAction> {
  if (provider === "modal") {
    return {
      id: "provider.resource",
      status: "passed",
      description: "Modal creates the named App, Sandbox, and Volume lazily",
    };
  }
  const argv = resourceInspectArgv(provider);
  const result = await run(argv, { maxOutputBytes: SETUP_OUTPUT_BYTES_MAX });
  const name = provider === "box" ? BOX_ENVIRONMENT : RESOURCE_NAME;
  const exists = result.code === 0 && jsonHasNamedResource(result.stdout, name);
  return {
    id: "provider.resource",
    status: exists ? "passed" : "planned",
    description: exists ? `${name} already exists` : `create ${name} for Beam`,
    command: exists ? undefined : resourceApplyCommand(provider),
  };
}

function resourceInspectArgv(provider: ManagedProviderName): string[] {
  if (provider === "box") return ["box", "env", "list", "--json"];
  if (provider === "e2b") return ["e2b", "template", "list", "--format", "json"];
  return ["daytona", "snapshot", "list", "--format", "json"];
}

function resourceApplyArgv(provider: ManagedProviderName, image: string): string[] {
  if (provider === "box") return ["box", "env", "new", BOX_ENVIRONMENT, "--json"];
  if (provider === "daytona") {
    return ["daytona", "snapshot", "create", RESOURCE_NAME, "--image", image];
  }
  throw new Error(`resource argv for ${provider} requires a generated Dockerfile`);
}

function resourceApplyCommand(provider: ManagedProviderName): string {
  if (provider === "box") return "box env new beam --json";
  if (provider === "e2b") return "e2b template create beam-coding --dockerfile <generated>";
  return "daytona snapshot create beam-coding --image <immutable-image>";
}

/** Inspect setup without changing provider resources or Beam config. */
export async function inspectManagedProviderSetup(
  provider: ManagedProviderName,
  image?: string,
): Promise<ProviderSetupPlan> {
  const actions: SetupAction[] = [];
  const prerequisites = await inspectPrerequisites(provider);
  actions.push(prerequisites);
  if (provider !== "box") {
    actions.push({
      id: "image",
      status: image === undefined ? "needs_input" : "passed",
      description: image === undefined
        ? "this source build has no immutable Beam coding image digest"
        : `use immutable coding image ${image}`,
      ...(image === undefined
        ? { command: "export BEAM_CODING_IMAGE=ghcr.io/bipa-app/beam-coding@sha256:<digest>" }
        : {}),
    });
  }
  if (actions.some((action) => action.status === "needs_input")) {
    actions.push({
      id: "provider.resource",
      status: "needs_input",
      description: "resolve provider and image prerequisites first",
    });
  } else {
    actions.push(await inspectResource(provider));
  }
  return { provider, image, actions };
}

async function applyE2bTemplate(image: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "beam-e2b-template-"));
  const dockerfile = join(directory, "e2b.Dockerfile");
  try {
    writeFileSync(dockerfile, `FROM ${image}\n`, { mode: 0o600 });
    const argv = [
      "e2b", "template", "create", RESOURCE_NAME,
      "--dockerfile", dockerfile,
      "--cmd", "/usr/local/bin/beam-sandbox-start",
      "--ready-cmd", "test -f /tmp/beam-ready",
    ];
    const result = await run(argv, { maxOutputBytes: SETUP_OUTPUT_BYTES_MAX });
    if (result.code !== 0) throw new Error(`E2B template creation failed: ${result.stderr.trim()}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Apply the provider resource action, then prove it exists. */
export async function applyManagedProviderSetup(plan: ProviderSetupPlan): Promise<SetupAction> {
  const fresh = await inspectManagedProviderSetup(plan.provider, plan.image);
  const resource = fresh.actions.find((action) => action.id === "provider.resource");
  if (fresh.actions.some((action) => action.status === "needs_input") || !resource) {
    throw new Error("provider setup prerequisites changed; run `beam setup` again");
  }
  if (resource.status === "passed") return resource;
  if (plan.provider === "e2b") {
    if (!plan.image) throw new Error("E2B setup requires an immutable coding image");
    await applyE2bTemplate(plan.image);
  } else {
    const result = await run(resourceApplyArgv(plan.provider, plan.image ?? ""), {
      maxOutputBytes: SETUP_OUTPUT_BYTES_MAX,
    });
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new Error(`${plan.provider} resource creation failed: ${detail}`);
    }
  }
  const verified = await inspectResource(plan.provider);
  if (verified.status !== "passed") {
    throw new Error("provider resource was not visible after create");
  }
  return { ...verified, status: "applied" };
}

export function managedResourceName(provider: ManagedProviderName): string | undefined {
  if (provider === "box") return BOX_ENVIRONMENT;
  if (provider === "modal") return undefined;
  return RESOURCE_NAME;
}

export function managedTargetSpec(
  provider: ManagedProviderName,
  image?: string,
): TargetSpec {
  if (provider === "box") return { type: "box", environment: BOX_ENVIRONMENT };
  if (image === undefined) throw new Error(`${provider} setup requires an immutable coding image`);
  if (provider === "e2b") return { type: "e2b", template: RESOURCE_NAME };
  if (provider === "modal") return { type: "modal", image };
  return { type: "daytona", snapshot: RESOURCE_NAME };
}

export function managedTargetConfigState(
  current: TargetSpec,
  desired: TargetSpec,
): "conflict" | "needs_update" | "ready" {
  if (current.type !== desired.type) return "conflict";
  if (desired.type === "box" && current.type === "box") {
    if (current.environment === undefined) return "needs_update";
    return current.environment === desired.environment ? "ready" : "conflict";
  }
  if (desired.type === "e2b" && current.type === "e2b") {
    return current.template === desired.template ? "ready" : "conflict";
  }
  if (desired.type === "modal" && current.type === "modal") {
    if (current.image === undefined) return "needs_update";
    return current.image === desired.image ? "ready" : "conflict";
  }
  if (desired.type === "daytona" && current.type === "daytona") {
    if (current.snapshot === undefined) return "needs_update";
    return current.snapshot === desired.snapshot ? "ready" : "conflict";
  }
  return "conflict";
}

export function mergeManagedTargetSpec(current: TargetSpec, desired: TargetSpec): TargetSpec {
  if (managedTargetConfigState(current, desired) === "conflict") {
    throw new Error(`target ${current.type} conflicts with managed ${desired.type} setup`);
  }
  if (current.type === "box" && desired.type === "box") return { ...current, ...desired };
  if (current.type === "e2b" && desired.type === "e2b") return { ...current, ...desired };
  if (current.type === "modal" && desired.type === "modal") return { ...current, ...desired };
  if (current.type === "daytona" && desired.type === "daytona") {
    return { ...current, ...desired };
  }
  throw new Error("managed target types changed during config merge");
}
