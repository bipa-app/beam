import { cliAccent } from "./cli-output.ts";

export interface CommandOptionDoc {
  flag: string;
  description: string;
}

export interface CommandDoc {
  summary: string;
  usage: string;
  interactive: boolean;
  options: CommandOptionDoc[];
}

export interface TopicDoc {
  summary: string;
  steps: string[];
  examples: string[];
  invariants: string[];
}

export const COMMAND_DOCS: Record<string, CommandDoc> = {
  init: {
    summary: "Create the Beam config without overwriting an existing file.",
    usage: "beam init",
    interactive: false,
    options: [],
  },
  check: {
    summary: "Verify local setup, provider access, and any live sandbox.",
    usage: "beam check [target] [--tool <tool>]",
    interactive: false,
    options: [
      { flag: "--tool <omp|pi|claude|codex>", description: "Require one remote harness." },
    ],
  },
  setup: {
    summary: "Plan or apply managed-provider setup.",
    usage: "beam setup <box|e2b|modal|daytona> [--apply --yes]",
    interactive: false,
    options: [
      { flag: "--apply", description: "Apply the displayed idempotent setup plan." },
      { flag: "--yes", description: "Approve all noninteractive plan actions." },
    ],
  },
  up: {
    summary: "Ship the current workspace and resume its coding-agent session remotely.",
    usage: "beam up [options]",
    interactive: false,
    options: [
      { flag: "--tool <tool>", description: "Use omp, pi, claude, or codex." },
      { flag: "--message <text>", description: "Send a kickoff message after resume." },
      { flag: "--session <id>", description: "Select an exact local harness session." },
      {
        flag: "--no-session",
        description: "Ship the workspace only: no session travels, no agent starts; " +
          "refuses --message.",
      },
      {
        flag: "--allow-large",
        description: "Ship a mirror past the 2 GiB ceiling; prefer excluding build " +
          "artifacts in .beamignore.",
      },
    ],
  },
  attach: {
    summary: "Attach to the remote agent. Detach with Ctrl+B then Q.",
    usage: "beam attach [id]",
    interactive: true,
    options: [],
  },
  down: {
    summary: "Collect remote work into a verified local return stage.",
    usage: "beam down [id] [--delete]",
    interactive: false,
    options: [
      { flag: "--delete", description: "Mirror remote deletions into the return stage." },
    ],
  },
  integrate: {
    summary: "Preview and apply a verified return stage to the local workspace.",
    usage: "beam integrate [id] [--yes]",
    interactive: false,
    options: [
      { flag: "--yes", description: "Apply after safety checks without prompting." },
    ],
  },
  kill: {
    summary: "Stop the remote agent; optionally erase its owned remote resources.",
    usage: "beam kill [id] [--purge]",
    interactive: false,
    options: [
      { flag: "--purge", description: "Erase the owned workspace, session, and sandbox." },
    ],
  },
  login: {
    summary: "Authenticate one harness interactively on a target.",
    usage: "beam login [target] --tool <tool>",
    interactive: true,
    options: [
      { flag: "--tool <omp|pi|claude|codex>", description: "Harness to authenticate." },
    ],
  },
  status: {
    summary: "Inspect one handoff and its remote agent when reachable.",
    usage: "beam status [id]",
    interactive: false,
    options: [],
  },
  ls: {
    summary: "List handoff records.",
    usage: "beam ls",
    interactive: false,
    options: [],
  },
  targets: {
    summary: "List configured targets.",
    usage: "beam targets",
    interactive: false,
    options: [],
  },
  skill: {
    summary: "Install or remove the version-matched Beam agent skill.",
    usage: "beam skill <install|remove> [--tool auto] [--scope user]",
    interactive: false,
    options: [
      { flag: "--tool <auto|all|omp|pi|claude|codex>", description: "Skill host." },
      { flag: "--scope <user|project>", description: "Installation scope." },
      { flag: "--replace", description: "Explicitly replace a foreign existing skill." },
    ],
  },
  docs: {
    summary: "Read the operational manual as text or structured JSON.",
    usage: "beam docs [agent|handoff|return|providers|recovery|security]",
    interactive: false,
    options: [],
  },
  help: {
    summary: "List commands or describe one command.",
    usage: "beam help [command]",
    interactive: false,
    options: [],
  },
};

export const TOPIC_DOCS: Record<string, TopicDoc> = {
  agent: {
    summary: "The shortest safe contract for an automated coding agent.",
    steps: [
      "Run `beam check --json`; stop on any failed check.",
      "Run `beam up --json --tool <tool> --message <goal>` from the project root.",
      "Use `beam status --json` to observe the handoff; `beam attach` is human-only.",
      "Run `beam down --json`, then `beam integrate --yes --json`.",
      "After successful integration, run `beam kill --purge --json`.",
    ],
    examples: [
      "beam check --json",
      "beam up --json --tool omp --message 'Run the requested checks and report results.'",
      "beam down --json",
      "beam integrate --yes --json",
    ],
    invariants: [
      "Never run a second fresh `beam up` for a live handoff; attach or inspect it.",
      "Never copy harness credentials. Authenticate on the target with `beam login`.",
      "Never purge before the return stage has been integrated or intentionally discarded.",
      "Quiesce local writers before `beam integrate`; it refuses drift observed before apply.",
    ],
  },
  handoff: {
    summary: "Ship a live coding-agent session to one configured target.",
    steps: [
      "Prepare a target with `beam setup <provider>` or `beam init`; " +
        "inspect `beam targets`.",
      "Run `beam check [target]`.",
      "Exit the local harness so its transcript is settled.",
      "Run `beam up --target <target> --tool <tool> --message <goal>`.",
      "Watch with `beam attach [id]`; detach with Ctrl+B then Q.",
    ],
    examples: [
      "beam up --target box --tool omp " +
        "--message 'Continue this task and run the gates.'",
    ],
    invariants: ["Beam ships the working tree as-is, including untracked files and secrets."],
  },
  return: {
    summary: "Collect remote work without overwriting local work, then integrate it safely.",
    steps: [
      "Run `beam down [id]`; this only stages remote work.",
      "Run `beam integrate [id]`; inspect its itemized preview.",
      "Confirm the integration, or use `--yes` in a headless caller.",
      "Run project checks locally.",
      "Run `beam kill [id] --purge` only after the return is settled.",
    ],
    examples: ["beam down", "beam integrate", "beam kill --purge"],
    invariants: ["Integration refuses local drift from the workspace that was shipped."],
  },
  providers: {
    summary: "Prepare a managed sandbox provider with an idempotent setup plan.",
    steps: [
      "Run `beam setup <provider> --json` to inspect the plan.",
      "Complete any reported interactive authentication step locally.",
      "Run `beam setup <provider> --apply --yes --json`.",
      "Run `beam check <target> --json`.",
    ],
    examples: ["beam setup box --json", "beam setup box --apply --yes --json"],
    invariants: ["Setup never overwrites a foreign resource or config entry silently."],
  },
  recovery: {
    summary: "Recover interrupted handoffs without duplicating or destroying work.",
    steps: [
      "Run `beam ls --json` and `beam status <id> --json`.",
      "If the handoff is live, use `beam attach <id>` rather than another fresh up.",
      "If shipping was interrupted, rerun the same `beam up`; Beam resumes its journal.",
      "If returning was interrupted, rerun `beam down <id>`.",
      "Read the exact refusal before using `beam kill <id> --purge`.",
    ],
    examples: ["beam status abc123 --json", "beam down abc123 --json"],
    invariants: ["Do not edit Beam state files to bypass an ownership or fingerprint refusal."],
  },
  security: {
    summary: "Credential, ownership, and deletion boundaries that must remain explicit.",
    steps: [
      "Use `beam check` to reject overpowered provider credentials.",
      "Authenticate harnesses on the remote target with `beam login`.",
      "Review excludes before shipping secrets that should not leave the machine.",
    ],
    examples: ["beam check box --json", "beam login box --tool omp"],
    invariants: [
      "The transport credential is the sandbox blast radius.",
      "Only `kill --purge` performs destructive remote cleanup.",
      "`down` never writes the live workspace; `integrate` deletes only when down had `--delete`.",
    ],
  },
};

export function commandHelpData(name?: string): CommandDoc | Record<string, CommandDoc> {
  if (!name) return COMMAND_DOCS;
  const command = COMMAND_DOCS[name];
  if (!command) throw new Error(`unknown command "${name}"`);
  return command;
}

export function topicHelpData(name?: string): TopicDoc | Record<string, TopicDoc> {
  if (!name) return TOPIC_DOCS;
  const topic = TOPIC_DOCS[name];
  if (!topic) throw new Error(`unknown docs topic "${name}"`);
  return topic;
}

export function rootHelpText(): string {
  const lines = [
    `${cliAccent("━━━")} beam ai`,
    "    your coding agent keeps moving",
    "",
    "Hand a live coding-agent session to a remote sandbox and bring it back.",
    "",
    "usage: beam [--json] <command> [options]",
    "",
    "first handoff:",
    "  beam setup box",
    "  box onboard                         # when the plan asks",
    "  beam setup box --apply --yes",
    "  beam check box",
    "  beam up --target box --tool omp --message 'Continue this task.'",
    "",
    "commands:",
  ];
  for (const [name, command] of Object.entries(COMMAND_DOCS)) {
    lines.push(`  ${name.padEnd(10)} ${command.summary}`);
  }
  lines.push("", "agent manual: beam docs agent --json");
  return lines.join("\n");
}

export function commandHelpText(name: string): string {
  const command = commandHelpData(name) as CommandDoc;
  const lines = [command.summary, "", `usage: ${command.usage}`];
  if (command.options.length > 0) {
    lines.push("", "options:");
    for (const option of command.options) {
      lines.push(`  ${option.flag}`);
      lines.push(`      ${option.description}`);
    }
  }
  if (command.interactive) lines.push("", "This command requires an interactive terminal.");
  return lines.join("\n");
}

export function topicHelpText(name?: string): string {
  if (name === undefined) {
    const lines = ["Beam operational topics:"];
    for (const [topic, doc] of Object.entries(TOPIC_DOCS)) {
      lines.push(`  ${topic.padEnd(10)} ${doc.summary}`);
    }
    return lines.join("\n");
  }
  const topic = topicHelpData(name) as TopicDoc;
  const lines = [topic.summary, "", "Steps:"];
  for (const [index, step] of topic.steps.entries()) lines.push(`${index + 1}. ${step}`);
  lines.push("", "Examples:");
  for (const example of topic.examples) lines.push(`  ${example}`);
  lines.push("", "Safety:");
  for (const invariant of topic.invariants) lines.push(`  - ${invariant}`);
  return lines.join("\n");
}
