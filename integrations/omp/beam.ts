/**
 * /beam — in-session handoff for omp and pi.
 *
 * Install (omp):  ln -s "$(pwd)/integrations/omp/beam.ts" ~/.omp/agent/extensions/beam.ts
 * Install (pi):   pi install /path/to/beam/integrations/omp/beam.ts
 *
 * Typing `/beam up -m "keep going"` inside a session waits for the agent to
 * go idle, ships this workspace + session with the beam CLI, then switches
 * the local window to a fresh session so the shipped transcript stops
 * growing here (no divergence). Requires `beam` on PATH (bun link).
 *
 * The structural types below mirror the small slice of ExtensionAPI this
 * file uses (see @oh-my-pi/pi-coding-agent for the real thing); keeping them
 * local makes the file a zero-dependency drop-in for both harnesses.
 */
import { execFile } from "node:child_process";

interface CommandContext {
  cwd: string;
  ui: { notify(message: string, level: "info" | "warning" | "error"): void };
  waitForIdle(): Promise<void>;
  /** Present in omp; feature-detected so older pi builds degrade gracefully. */
  newSession?(): Promise<unknown>;
}

interface BeamExtensionApi {
  registerCommand(
    name: string,
    command: {
      description: string;
      handler(args: string, ctx: CommandContext): Promise<void>;
    },
  ): void;
}

const SUBCOMMANDS = [
  "up", "down", "integrate", "ls", "status", "attach", "kill", "check", "targets",
];
const USAGE =
  `usage: /beam up [-m "kickoff"] | ls | status [id] | down [id] | ` +
  `integrate [id] | check`;

/** Split on whitespace, honoring double- and single-quoted phrases. */
function tokenize(input: string): string[] {
  const tokens = input.match(/"([^"]*)"|'([^']*)'|\S+/g) ?? [];
  return tokens.map((t) =>
    (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
      ? t.slice(1, -1)
      : t,
  );
}

function runBeam(argv: string[], cwd: string): Promise<{ code: number; output: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number; output: string }>();
  execFile("beam", argv, { cwd, timeout: 15 * 60_000 }, (error, stdout, stderr) => {
    const output = `${stdout}${stderr}`.trim();
    if (error && "code" in error && error.code === "ENOENT") {
      resolve({ code: 127, output: "beam CLI not found on PATH — install it (bun link in the beam repo)" });
      return;
    }
    resolve({ code: error ? 1 : 0, output });
  });
  return promise;
}

export default function beamExtension(pi: BeamExtensionApi) {
  pi.registerCommand("beam", {
    description: "Hand this session to a remote sandbox (beam up/down/status/ls)",
    handler: async (args, ctx) => {
      const argv = tokenize(args.trim());
      if (argv.length === 0) argv.push("up");
      if (!SUBCOMMANDS.includes(argv[0]!)) {
        ctx.ui.notify(USAGE, "warning");
        return;
      }
      if (argv[0] === "attach") {
        ctx.ui.notify("attach needs a real terminal — run `beam attach` outside the TUI", "warning");
        return;
      }

      // Let the in-flight turn finish so the transcript on disk is complete.
      await ctx.waitForIdle();
      ctx.ui.notify(`beam ${argv.join(" ")} — running…`, "info");
      const { code, output } = await runBeam(argv, ctx.cwd);
      const tail = output.split("\n").slice(-8).join("\n");
      if (code !== 0) {
        ctx.ui.notify(`beam failed:\n${tail}`, "error");
        return;
      }
      ctx.ui.notify(tail, "info");

      if (argv[0] === "up") {
        // Stop appending to the shipped transcript: hand this window a fresh
        // session. Older pi builds without newSession() just get the warning.
        if (typeof ctx.newSession === "function") {
          await ctx.newSession();
          ctx.ui.notify("Session beamed — this window is now a fresh session. Watch with: beam attach", "info");
        } else {
          ctx.ui.notify("Session beamed — exit this session now to avoid transcript divergence.", "warning");
        }
      }
    },
  });
}
