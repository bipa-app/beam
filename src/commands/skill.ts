import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { CliError } from "../cli-output.ts";
import { resolveEnv } from "../env.ts";
import type { ToolName } from "../session/index.ts";
import { BEAM_SKILL, BEAM_SKILL_OWNER } from "../skill-content.ts";

const SKILL_BYTES_MAX = 128 * 1024;
const TOOLS: ToolName[] = ["omp", "pi", "claude", "codex"];

type SkillScope = "project" | "user";
export type SkillState = "current" | "foreign" | "missing" | "owned" | "unsafe";
type SkillStatus = "absent" | "conflict" | "installed" | "removed" | "unchanged" | "updated";

export interface SkillInspection {
  path: string;
  state: SkillState;
  tool: ToolName;
}

export interface SkillChange {
  path: string;
  status: SkillStatus;
  tool: ToolName;
}

export interface SkillCommandResult {
  action: "install" | "remove";
  scope: SkillScope;
  changes: SkillChange[];
}

function skillPath(tool: ToolName, scope: SkillScope, home: string): string {
  const root = scope === "user" ? home : process.cwd();
  const directories: Record<ToolName, string[]> =
    scope === "user"
      ? {
          omp: [".omp", "agent", "skills"],
          pi: [".pi", "agent", "skills"],
          claude: [".claude", "skills"],
          codex: [".codex", "skills"],
        }
      : {
          omp: [".omp", "skills"],
          pi: [".pi", "skills"],
          claude: [".claude", "skills"],
          codex: [".agents", "skills"],
        };
  return join(root, ...directories[tool], "beam", "SKILL.md");
}

function selectedTools(value: string, scope: SkillScope, home: string): ToolName[] {
  if (value === "all") return [...TOOLS];
  if (TOOLS.includes(value as ToolName)) return [value as ToolName];
  if (value !== "auto") {
    throw new CliError("invalid_arguments", `unsupported skill tool ${JSON.stringify(value)}`);
  }
  const selected = TOOLS.filter((tool) => {
    const binaryPresent = Bun.which(tool) !== null;
    return binaryPresent || existsSync(skillPath(tool, scope, home));
  });
  if (selected.length === 0) {
    throw new CliError(
      "skill_host_not_found",
      "no supported harness was found; pass `--tool <tool>` or `--tool all`",
    );
  }
  return selected;
}

function inspectSkill(tool: ToolName, scope: SkillScope, home: string): SkillInspection {
  const path = skillPath(tool, scope, home);
  const directory = dirname(path);
  if (existsSync(directory)) {
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      return { path, state: "unsafe", tool };
    }
  }
  if (!existsSync(path)) return { path, state: "missing", tool };
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SKILL_BYTES_MAX) {
    return { path, state: "unsafe", tool };
  }
  const content = readFileSync(path, "utf8");
  if (content === BEAM_SKILL) return { path, state: "current", tool };
  const state = content.includes(BEAM_SKILL_OWNER) ? "owned" : "foreign";
  return { path, state, tool };
}

/** Read-only state for every detected or previously installed Beam skill. */
export function inspectBeamSkills(home: string): SkillInspection[] {
  const tools = TOOLS.filter((tool) => {
    return Bun.which(tool) !== null || existsSync(skillPath(tool, "user", home));
  });
  return tools.map((tool) => inspectSkill(tool, "user", home));
}

function writeSkillAtomic(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const suffix = randomBytes(8).toString("hex");
  const temporary = `${path}.beam-${process.pid}-${suffix}`;
  try {
    writeFileSync(temporary, BEAM_SKILL, { flag: "wx", mode: 0o644 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function skillConflict(
  action: "install" | "remove",
  scope: SkillScope,
  inspections: SkillInspection[],
): never {
  const changes = inspections.map((inspection): SkillChange => ({
    path: inspection.path,
    status: inspection.state === "unsafe" || inspection.state === "foreign"
      ? "conflict"
      : "unchanged",
    tool: inspection.tool,
  }));
  throw new CliError(
    "skill_conflict",
    "a Beam skill path is foreign or unsafe; no files were changed",
    { action, scope, changes },
  );
}

function installSkills(
  scope: SkillScope,
  inspections: SkillInspection[],
  home: string,
  replace: boolean,
): SkillChange[] {
  const conflict = inspections.some((item) => item.state === "unsafe");
  const foreign = inspections.some((item) => item.state === "foreign");
  if (conflict || (foreign && !replace)) skillConflict("install", scope, inspections);
  return inspections.map((inspection): SkillChange => {
    if (inspection.state === "current") {
      return { path: inspection.path, status: "unchanged", tool: inspection.tool };
    }
    const latest = inspectSkill(inspection.tool, scope, home);
    if (latest.state !== inspection.state) skillConflict("install", scope, [latest]);
    writeSkillAtomic(inspection.path);
    const status = inspection.state === "missing" ? "installed" : "updated";
    return { path: inspection.path, status, tool: inspection.tool };
  });
}

function removeSkills(
  scope: SkillScope,
  inspections: SkillInspection[],
  home: string,
): SkillChange[] {
  if (inspections.some((item) => item.state === "unsafe" || item.state === "foreign")) {
    skillConflict("remove", scope, inspections);
  }
  return inspections.map((inspection): SkillChange => {
    if (inspection.state === "missing") {
      return { path: inspection.path, status: "absent", tool: inspection.tool };
    }
    const latest = inspectSkill(inspection.tool, scope, home);
    if (latest.state !== inspection.state) skillConflict("remove", scope, [latest]);
    rmSync(inspection.path);
    return { path: inspection.path, status: "removed", tool: inspection.tool };
  });
}

/** Install or remove the version-matched Beam agent skill. */
export async function cmdSkill(args: string[]): Promise<SkillCommandResult> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      replace: { type: "boolean", default: false },
      scope: { type: "string", default: "user" },
      tool: { type: "string", default: "auto" },
    },
    allowPositionals: true,
    strict: true,
  });
  const action = positionals[0];
  if (positionals.length !== 1 || (action !== "install" && action !== "remove")) {
    throw new CliError("invalid_arguments", "usage: beam skill <install|remove> [options]");
  }
  if (values.scope !== "user" && values.scope !== "project") {
    throw new CliError("invalid_arguments", "--scope must be user or project");
  }
  if (action === "remove" && values.replace) {
    throw new CliError("invalid_arguments", "--replace is valid only with skill install");
  }
  const scope = values.scope;
  const home = resolveEnv().home;
  const tools = selectedTools(values.tool, scope, home);
  const inspections = tools.map((tool) => inspectSkill(tool, scope, home));
  const changes =
    action === "install"
      ? installSkills(scope, inspections, home, values.replace)
      : removeSkills(scope, inspections, home);
  for (const change of changes) console.log(`${change.tool}: ${change.status} ${change.path}`);
  return { action, scope, changes };
}
