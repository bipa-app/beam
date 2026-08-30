import { parseArgs } from "node:util";
import { beamCodingImage } from "../coding-image.ts";
import { loadConfig, writeConfig, type Config } from "../config.ts";
import { CliError } from "../cli-output.ts";
import { resolveEnv, type BeamEnv } from "../env.ts";
import {
  applyManagedProviderSetup,
  inspectManagedProviderSetup,
  managedTargetConfigState,
  managedTargetSpec,
  mergeManagedTargetSpec,
  type ManagedProviderName,
  type ProviderSetupPlan,
  type SetupAction,
} from "../provider/setup.ts";

const PROVIDERS: ManagedProviderName[] = ["box", "e2b", "modal", "daytona"];

export interface SetupCommandResult {
  provider: ManagedProviderName;
  mode: "applied" | "plan";
  readyToApply: boolean;
  actions: SetupAction[];
}

function configAction(
  config: Config,
  provider: ManagedProviderName,
  image?: string,
): SetupAction {
  if (provider !== "box" && image === undefined) {
    return {
      id: "config.target",
      status: "needs_input",
      description: "config waits for an immutable coding image",
    };
  }
  const desired = managedTargetSpec(provider, image);
  const current = config.targets[provider];
  if (current === undefined) {
    return {
      id: "config.target",
      status: "planned",
      description: `add the ${provider} target without changing other targets`,
    };
  }
  const state = managedTargetConfigState(current, desired);
  if (state === "conflict") {
    return {
      id: "config.target",
      status: "needs_input",
      description: `target ${provider} exists with a different provider resource`,
      command: "edit ~/.beam/config.json or choose a different target name",
    };
  }
  return {
    id: "config.target",
    status: state === "ready" ? "passed" : "planned",
    description:
      state === "ready" ? `${provider} target is configured` : `complete ${provider} target`,
  };
}

function applyConfig(
  env: BeamEnv,
  provider: ManagedProviderName,
  image?: string,
): SetupAction {
  const config = loadConfig(env);
  const action = configAction(config, provider, image);
  if (action.status === "needs_input") {
    throw new Error("Beam config changed or conflicts with the setup plan");
  }
  if (action.status === "passed") return action;
  const desired = managedTargetSpec(provider, image);
  const current = config.targets[provider];
  config.targets[provider] =
    current === undefined ? desired : mergeManagedTargetSpec(current, desired);
  config.defaultTarget ??= provider;
  writeConfig(env, config);
  return { ...action, status: "applied" };
}

function printPlan(actions: SetupAction[]): void {
  for (const action of actions) {
    console.log(`${action.status.padEnd(11)} ${action.id}: ${action.description}`);
    if (action.command) console.log(`  run: ${action.command}`);
  }
}

function parseProvider(value: string | undefined): ManagedProviderName {
  if (value && PROVIDERS.includes(value as ManagedProviderName)) {
    return value as ManagedProviderName;
  }
  throw new CliError(
    "invalid_arguments",
    "usage: beam setup <box|e2b|modal|daytona> [--apply --yes]",
  );
}

async function setupPlan(provider: ManagedProviderName): Promise<{
  env: BeamEnv;
  plan: ProviderSetupPlan;
  actions: SetupAction[];
}> {
  const image = beamCodingImage();
  const env = resolveEnv();
  const plan = await inspectManagedProviderSetup(provider, image);
  const actions = [...plan.actions, configAction(loadConfig(env), provider, image)];
  return { env, plan, actions };
}

/** Plan provider setup by default; apply only after an explicit approval flag. */
export async function cmdSetup(args: string[]): Promise<SetupCommandResult> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      apply: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 1) parseProvider(undefined);
  const provider = parseProvider(positionals[0]);
  if (values.yes && !values.apply) {
    throw new CliError("invalid_arguments", "--yes requires --apply");
  }
  if (values.apply && !values.yes) {
    throw new CliError(
      "confirmation_required",
      "setup apply requires explicit approval",
      { nextCommand: `beam setup ${provider} --apply --yes --json` },
    );
  }
  const { env, plan, actions } = await setupPlan(provider);
  const readyToApply = !actions.some((action) => action.status === "needs_input");
  if (!values.apply) {
    printPlan(actions);
    return { provider, mode: "plan", readyToApply, actions };
  }
  if (!readyToApply) {
    throw new CliError(
      "setup_needs_input",
      "setup prerequisites need input; no resources or config were changed",
      { provider, actions },
    );
  }
  const resource = await applyManagedProviderSetup(plan);
  const config = applyConfig(env, provider, plan.image);
  const applied = actions.map((action) => {
    if (action.id === resource.id) return resource;
    if (action.id === config.id) return config;
    return action;
  });
  printPlan(applied);
  return { provider, mode: "applied", readyToApply: true, actions: applied };
}
