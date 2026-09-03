#!/usr/bin/env bun
import {
  commandHelpData,
  commandHelpText,
  rootHelpText,
  topicHelpData,
  topicHelpText,
} from "./command-docs.ts";
import { cmdDown } from "./commands/down.ts";
import { cmdIntegrate } from "./commands/integrate.ts";
import {
  cmdAttach,
  cmdCheck,
  cmdInit,
  cmdKill,
  cmdLogin,
  cmdLs,
  cmdStatus,
  cmdTargets,
} from "./commands/misc.ts";
import { cmdSetup } from "./commands/setup.ts";
import { cmdUp } from "./commands/up.ts";
import { cmdSkill } from "./commands/skill.ts";
import { CliError, runJsonCommand } from "./cli-output.ts";
import { installSignalLockRelease } from "./state.ts";
import { beamVersion, beamVersionLine } from "./version.ts";

interface CliInvocation {
  command: string;
  json: boolean;
  rest: string[];
}

function parseInvocation(argv: string[]): CliInvocation {
  const args: string[] = [];
  let json = false;
  let optionsEnded = false;
  for (const arg of argv) {
    if (arg === "--") optionsEnded = true;
    if (!optionsEnded && arg === "--json") {
      json = true;
      continue;
    }
    args.push(arg);
  }
  const command = args.shift() ?? "help";
  return { command, json, rest: args };
}

function assertHeadless(command: string, json: boolean): void {
  if (!json) return;
  if (command !== "attach" && command !== "login") return;
  throw new CliError(
    "interactive_required",
    `beam ${command} requires a terminal and cannot run with --json`,
    { nextCommand: `beam ${command}` },
  );
}

async function dispatch(invocation: CliInvocation): Promise<unknown> {
  const { command, json, rest } = invocation;
  assertHeadless(command, json);
  switch (command) {
    case "init":
      return cmdInit();
    case "targets":
      return cmdTargets();
    case "check":
      return cmdCheck(rest);
    case "skill":
      return cmdSkill(rest);
    case "setup":
      return cmdSetup(rest);
    case "up":
      return cmdUp(rest);
    case "down":
      return cmdDown(rest);
    case "integrate":
      return cmdIntegrate(rest, { json });
    case "login":
      return cmdLogin(rest);
    case "ls":
    case "list":
      return cmdLs();
    case "status":
      return cmdStatus(rest);
    case "attach":
      return cmdAttach(rest);
    case "kill":
      return cmdKill(rest);
    case "docs": {
      const topic = rest[0];
      if (json) return topicHelpData(topic);
      console.log(topicHelpText(topic));
      return undefined;
    }
    case "help":
    case "--help":
    case "-h": {
      const requested = rest[0];
      if (json) return commandHelpData(requested);
      console.log(requested ? commandHelpText(requested) : rootHelpText());
      return undefined;
    }
    case "version":
    case "--version":
    case "-V": {
      const identity = await beamVersion();
      if (json) return identity;
      console.log(beamVersionLine(identity));
      return undefined;
    }
    default:
      throw new CliError("unknown_command", `unknown command "${command}"`, {
        nextCommand: "beam help",
      });
  }
}

async function main(): Promise<void> {
  installSignalLockRelease();
  const invocation = parseInvocation(process.argv.slice(2));
  if (invocation.json) {
    process.exitCode = await runJsonCommand(invocation.command, () => dispatch(invocation));
    return;
  }
  try {
    await dispatch(invocation);
  } catch (error) {
    console.error(`beam: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

await main();
