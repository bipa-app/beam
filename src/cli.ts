#!/usr/bin/env bun
import { cmdDown, DOWN_HELP } from "./commands/down.ts";
import {
  cmdAttach,
  cmdDoctor,
  cmdInit,
  cmdKill,
  cmdLogin,
  cmdLs,
  cmdStatus,
  cmdTargets,
  KILL_HELP,
  LOGIN_HELP,
} from "./commands/misc.ts";
import { cmdUp, UP_HELP } from "./commands/up.ts";

const HELP = `beam — hand a live coding-agent session to a remote sandbox, and bring it back

usage: beam <command> [args]

  init              write a sample config (~/.beam/config.json)
  targets           list configured targets
  doctor [target]   verify a target: transport, tools, harnesses, credential posture
  login [target]    interactive harness login on a target (never copies credentials)
  up                ship workspace + session, resume the agent remotely
  ls                list handoffs
  status [id]       remote liveness + last pane output
  attach [id]       attach to the remote agent (ctrl+b q to detach)
  down [id]         stop remote agent, collect + verify + stage the return (workspace AND session; remote always retained)
  kill [id]         kill the agent (--purge explicitly abandons and erases all remote state)

run \`beam <command> --help\` (up, down, kill, login) for command options.

supported harnesses: omp, pi, Claude Code (claude), Codex (codex)
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "init":
      return cmdInit();
    case "targets":
      return cmdTargets();
    case "doctor":
      return cmdDoctor(rest);
    case "up":
      return cmdUp(rest);
    case "down":
      return cmdDown(rest);
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
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      if (rest[0] === "up") console.log(UP_HELP);
      if (rest[0] === "down") console.log(DOWN_HELP);
      if (rest[0] === "kill") console.log(KILL_HELP);
      if (rest[0] === "login") console.log(LOGIN_HELP);
      return;
    default:
      console.error(`unknown command "${command}"\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`beam: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
