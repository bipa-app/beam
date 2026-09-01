/**
 * Goal: Beam's local provider preflight selects eligible Claude/Codex
 * capacity, opens enrollment only when needed, and degrades gracefully when
 * llm-proxy cannot answer.
 *
 * Method: put deterministic fake llm-proxy/Claude binaries on PATH, exercise
 * the resolver directly, then run real local-transport handoffs (including a
 * live herdr pane) to prove pre-provision order, fallback, and secret delivery.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdDown } from "../src/commands/down.ts";
import { cmdUp } from "../src/commands/up.ts";
import { resolveEnv } from "../src/env.ts";
import { claudeProjectSlug } from "../src/session/claude.ts";
import { loadState } from "../src/state.ts";
import { resolveProviderCredentialEnvironment } from "../src/provider-credentials.ts";
import { HerdrRuntime } from "../src/runtime/herdr.ts";
import { LocalTransport } from "../src/transport/local.ts";

const FAKE_LLM_PROXY = `#!/bin/bash
printf '%s %s\\n' "$1" "\${2:-}" >> "$LLM_PROXY_LOG"
if [ "$1" = "accounts" ] && [ "\${LLM_PROXY_ASSERT_PRE_PROVISION:-0}" = "1" ]; then
  if [ ! -e "$BEAM_DIR/state.json" ]; then
    printf '%s\n' 'unpinned-session' >> "$LLM_PROXY_LOG"
    exit 65
  fi
  case "$(cat "$BEAM_DIR/state.json")" in
    *'"remoteCwdResolved":false'*|*'"remoteCwdResolved": false'*) ;;
    *)
      printf '%s\n' 'late-provision' >> "$LLM_PROXY_LOG"
      exit 65
      ;;
  esac
fi
case "$LLM_PROXY_MODE:$1" in
  claude-ready:accounts)
    printf '%s' '{"accounts":[{"provider_id":"anthropic",'
    printf '%s' '"auth_material_kind":"access_token",'
    printf '%s\\n' '"state":"active","sanction_current":true}]}'
    ;;
  codex-ready:accounts)
    printf '%s' '{"accounts":[{"provider_id":"openai",'
    printf '%s' '"auth_material_kind":"api_key",'
    printf '%s\\n' '"state":"active","sanction_current":true}]}'
    ;;
  ineligible:accounts)
    printf '%s' '{"accounts":[{"provider_id":"anthropic",'
    printf '%s' '"auth_material_kind":"access_token","state":"paused",'
    printf '%s' '"sanction_current":true},{"provider_id":"anthropic",'
    printf '%s' '"auth_material_kind":"access_token","state":"active",'
    printf '%s\\n' '"sanction_current":false}]}'
    ;;
  no-account:accounts)
    printf '%s\\n' '{"accounts":[]}'
    ;;
  unreachable:accounts)
    exit 7
    ;;
  *:credential)
    printf '%s\\n' 'proxy-session-token'
    ;;
  *:enroll)
    ;;
  *)
    echo "unexpected llm-proxy invocation: $*" >&2
    exit 64
    ;;
esac
`;

const FAKE_CLAUDE = `#!/bin/bash
if [ "\${BEAM_CAPTURE_ENV:-0}" = "1" ]; then
  printf '%s\\n%s\\n' "$LLM_PROXY_SESSION_TOKEN" "$CLAUDE_CODE_OAUTH_TOKEN" \
    > provider-environment.txt
  sleep 300
fi
`;

const FAKE_CODEX = `#!/bin/bash
sleep 300
`;

const HAVE_RSYNC = Bun.which("rsync") !== null;
const HAVE_RUNTIME = HAVE_RSYNC && Bun.which("herdr") !== null;

let root: string;
let logFile: string;
let savedPath: string | undefined;
let savedMode: string | undefined;
let savedLog: string | undefined;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "beam-provider-credentials-"));
  logFile = join(root, "calls.log");
  const binary = join(root, "llm-proxy");
  writeFileSync(binary, FAKE_LLM_PROXY);
  chmodSync(binary, 0o755);
  writeFileSync(join(root, "claude"), FAKE_CLAUDE);
  chmodSync(join(root, "claude"), 0o755);
  writeFileSync(join(root, "codex"), FAKE_CODEX);
  chmodSync(join(root, "codex"), 0o755);
  savedPath = process.env.PATH;
  savedMode = process.env.LLM_PROXY_MODE;
  savedLog = process.env.LLM_PROXY_LOG;
  process.env.PATH = `${root}:${savedPath ?? ""}`;
  process.env.LLM_PROXY_LOG = logFile;
});

beforeEach(() => {
  writeFileSync(logFile, "");
});

afterAll(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (savedMode === undefined) delete process.env.LLM_PROXY_MODE;
  else process.env.LLM_PROXY_MODE = savedMode;
  if (savedLog === undefined) delete process.env.LLM_PROXY_LOG;
  else process.env.LLM_PROXY_LOG = savedLog;
  rmSync(root, { recursive: true, force: true });
});

interface UpFixtureResult {
  calls: string;
  state: string;
  status: string;
  warnings: string;
  remoteEnvironment: string;
  startScript: string;
  runtimeEnvironmentPresent: boolean;
}

interface UpFixture {
  root: string;
  localHome: string;
  beamDir: string;
  workDir: string;
}

function createUpFixture(): UpFixture {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "beam-provider-up-")));
  const localHome = join(fixture, "local-home");
  const remoteHome = join(fixture, "remote-home");
  const remoteRoot = join(remoteHome, "beam-root");
  const beamDir = join(localHome, ".beam");
  const workDir = join(localHome, "work");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(remoteHome, { recursive: true });
  mkdirSync(beamDir, { recursive: true });
  writeFileSync(join(workDir, "work.txt"), "local work\n");
  writeFileSync(
    join(beamDir, "config.json"),
    JSON.stringify({
      defaultTarget: "sandbox",
      targets: { sandbox: { type: "local", root: remoteRoot, home: remoteHome } },
    }),
  );
  const sessionDir = join(localHome, ".claude", "projects", claudeProjectSlug(workDir));
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "claude-session.jsonl"),
    `{"sessionId":"claude-session","cwd":${JSON.stringify(workDir)}}\n`,
  );
  return { root: fixture, localHome, beamDir, workDir };
}

async function captureRuntimeEnvironment(remoteCwd: string): Promise<{
  remoteEnvironment: string;
  startScript: string;
  runtimeEnvironmentPresent: boolean;
}> {
  const capture = join(remoteCwd, "provider-environment.txt");
  // A real herdr pane runs the fake Claude process externally; poll its
  // final environment write with the same bounded posture as e2e.test.ts.
  const deadline = Date.now() + 10_000;
  while (!existsSync(capture) && Date.now() < deadline) await Bun.sleep(100);
  if (!existsSync(capture)) throw new Error("remote Claude did not capture its environment");
  return {
    remoteEnvironment: readFileSync(capture, "utf8"),
    startScript: readFileSync(join(remoteCwd, ".beam", "agent-start.sh"), "utf8"),
    runtimeEnvironmentPresent: existsSync(
      join(remoteCwd, ".beam", "runtime-environment", "environment"),
    ),
  };
}

async function runUpFixture(mode: string, start: boolean): Promise<UpFixtureResult> {
  const fixture = createUpFixture();
  const { localHome, beamDir, workDir } = fixture;

  const savedCwd = process.cwd();
  const savedEnvironment: Record<string, string | undefined> = {};
  for (const name of [
    "BEAM_HOME",
    "BEAM_DIR",
    "BEAM_CAPTURE_ENV",
    "LLM_PROXY_MODE",
    "LLM_PROXY_ASSERT_PRE_PROVISION",
    "XDG_CONFIG_HOME",
  ]) {
    savedEnvironment[name] = process.env[name];
  }
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
  process.env.BEAM_HOME = localHome;
  process.env.BEAM_DIR = beamDir;
  process.env.LLM_PROXY_MODE = mode;
  process.env.LLM_PROXY_ASSERT_PRE_PROVISION = "1";
  if (start) process.env.BEAM_CAPTURE_ENV = "1";
  else delete process.env.BEAM_CAPTURE_ENV;
  delete process.env.XDG_CONFIG_HOME;
  process.chdir(workDir);
  try {
    await cmdUp(start ? ["--tool", "claude"] : ["--tool", "claude", "--no-start"]);
    const record = loadState(resolveEnv()).records[0];
    if (record === undefined) throw new Error("beam up did not reserve a handoff");
    const runtime = start
      ? await captureRuntimeEnvironment(record.remoteCwd)
      : { remoteEnvironment: "", startScript: "", runtimeEnvironmentPresent: false };
    const result = {
      calls: readFileSync(logFile, "utf8"),
      state: readFileSync(join(beamDir, "state.json"), "utf8"),
      status: record.status,
      warnings: warnings.join("\n"),
      ...runtime,
    };
    if (start) await cmdDown([]);
    return result;
  } finally {
    console.warn = originalWarn;
    process.chdir(savedCwd);
    for (const [name, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function runRetainedToolFixture(): Promise<string> {
  const fixture = createUpFixture();
  const { localHome, beamDir, workDir } = fixture;
  const remoteHome = join(fixture.root, "remote-home");
  const codexDir = join(localHome, ".codex", "sessions", "2026", "09", "01");
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    join(codexDir, "rollout-test-codex-session.jsonl"),
    `${JSON.stringify({
      type: "session_meta",
      payload: { session_id: "codex-session", cwd: workDir },
    })}\n`,
  );
  const remoteCodex = join(remoteHome, ".codex");
  mkdirSync(remoteCodex, { recursive: true });
  writeFileSync(join(remoteCodex, "auth.json"), "{}\n");

  const savedCwd = process.cwd();
  const names = [
    "BEAM_HOME",
    "BEAM_DIR",
    "BEAM_CAPTURE_ENV",
    "LLM_PROXY_MODE",
    "LLM_PROXY_ASSERT_PRE_PROVISION",
    "XDG_CONFIG_HOME",
  ];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.BEAM_HOME = localHome;
  process.env.BEAM_DIR = beamDir;
  process.env.LLM_PROXY_MODE = "codex-ready";
  process.env.LLM_PROXY_ASSERT_PRE_PROVISION = "1";
  delete process.env.BEAM_CAPTURE_ENV;
  delete process.env.XDG_CONFIG_HOME;
  process.chdir(workDir);
  try {
    await cmdUp(["--tool", "codex"]);
    const record = loadState(resolveEnv()).records[0];
    if (record === undefined) throw new Error("initial Codex handoff was not recorded");
    await new HerdrRuntime(new LocalTransport(remoteHome)).kill(record.runtimeSession);
    const claudeFile = join(
      localHome,
      ".claude",
      "projects",
      claudeProjectSlug(workDir),
      "claude-session.jsonl",
    );
    const future = new Date(Date.now() + 10_000);
    utimesSync(claudeFile, future, future);
    writeFileSync(logFile, "");
    process.env.LLM_PROXY_MODE = "claude-ready";
    process.env.LLM_PROXY_ASSERT_PRE_PROVISION = "0";
    await cmdUp([]);
    const calls = readFileSync(logFile, "utf8");
    await cmdDown([]);
    return calls;
  } finally {
    process.chdir(savedCwd);
    for (const name of names) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

describe("provider credential preflight", () => {
  test("Claude setup-token capacity returns both proxy and Claude environments", async () => {
    process.env.LLM_PROXY_MODE = "claude-ready";

    expect(await resolveProviderCredentialEnvironment("claude")).toEqual({
      LLM_PROXY_SESSION_TOKEN: "proxy-session-token",
      CLAUDE_CODE_OAUTH_TOKEN: "proxy-session-token",
    });
    expect(readFileSync(logFile, "utf8")).toBe("accounts \ncredential \n");
  });

  test("Codex capacity returns only the provider-independent proxy session", async () => {
    process.env.LLM_PROXY_MODE = "codex-ready";

    expect(await resolveProviderCredentialEnvironment("codex")).toEqual({
      LLM_PROXY_SESSION_TOKEN: "proxy-session-token",
    });
    expect(readFileSync(logFile, "utf8")).toBe("accounts \ncredential \n");
  });

  test("a missing provider account opens enrollment and does not request a token", async () => {
    process.env.LLM_PROXY_MODE = "no-account";

    expect(await resolveProviderCredentialEnvironment("claude")).toEqual({});
    expect(readFileSync(logFile, "utf8")).toBe("accounts \nenroll anthropic\n");
  });

  test("paused and withdrawn provider accounts open enrollment instead", async () => {
    process.env.LLM_PROXY_MODE = "ineligible";

    expect(await resolveProviderCredentialEnvironment("claude")).toEqual({});
    expect(readFileSync(logFile, "utf8")).toBe("accounts \nenroll anthropic\n");
  });

  test("an unreachable proxy warns and returns the local-credential fallback", async () => {
    process.env.LLM_PROXY_MODE = "unreachable";
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
    try {
      expect(await resolveProviderCredentialEnvironment("claude")).toEqual({});
    } finally {
      console.warn = original;
    }

    expect(warnings.join("\n")).toContain("llm-proxy accounts failed");
    expect(warnings.join("\n")).toContain("continuing claude handoff with local credentials");
    expect(readFileSync(logFile, "utf8")).toBe("accounts \n");
  });

  test("provider-agnostic harnesses keep their existing local credential path", async () => {
    process.env.LLM_PROXY_MODE = "claude-ready";

    expect(await resolveProviderCredentialEnvironment("omp")).toEqual({});
    expect(readFileSync(logFile, "utf8")).toBe("");
  });
});

describe.skipIf(!HAVE_RSYNC)("beam up provider credential integration", () => {
  test(
    "resolves accounts and a session token before target provisioning",
    async () => {
      const result = await runUpFixture("claude-ready", false);

      expect(result.status).toBe("up");
      expect(result.calls).toBe("accounts \ncredential \n");
      expect(result.calls).not.toContain("late-provision");
      expect(result.state).not.toContain("proxy-session-token");
    },
    30_000,
  );

  test(
    "opens provider enrollment before provisioning when no account is eligible",
    async () => {
      const result = await runUpFixture("no-account", false);

      expect(result.status).toBe("up");
      expect(result.calls).toBe("accounts \nenroll anthropic\n");
      expect(result.calls).not.toContain("credential");
      expect(result.calls).not.toContain("late-provision");
    },
    30_000,
  );

  test(
    "continues provisioning with local credentials when llm-proxy is unreachable",
    async () => {
      const result = await runUpFixture("unreachable", false);

      expect(result.status).toBe("up");
      expect(result.calls).toBe("accounts \n");
      expect(result.calls).not.toContain("late-provision");
      expect(result.warnings).toContain("llm-proxy accounts failed");
      expect(result.warnings).toContain("continuing claude handoff with local credentials");
    },
    30_000,
  );
});

describe.skipIf(!HAVE_RUNTIME)("beam up runtime credential delivery", () => {
  test(
    "launches Claude with proxy credentials without journaling or persisting the token",
    async () => {
      const result = await runUpFixture("claude-ready", true);

      expect(result.status).toBe("up");
      expect(result.remoteEnvironment).toBe("proxy-session-token\nproxy-session-token\n");
      expect(result.runtimeEnvironmentPresent).toBe(false);
      expect(result.startScript).not.toContain("proxy-session-token");
      expect(result.state).not.toContain("proxy-session-token");
    },
    30_000,
  );

  test(
    "uses a reused handoff's pinned tool instead of a newer auto-detected session",
    async () => {
      expect(await runRetainedToolFixture()).toBe("accounts \nenroll openai\n");
    },
    30_000,
  );
});
