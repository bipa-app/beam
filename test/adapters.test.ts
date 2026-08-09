import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectSlug, ClaudeAdapter } from "../src/session/claude.ts";
import { CodexAdapter } from "../src/session/codex.ts";
import { OmpAdapter, PiAdapter, rewriteSessionHeaderCwd } from "../src/session/pi-family.ts";
import { LocalTransport } from "../src/transport/local.ts";

function fixtureHome(): string {
  return mkdtempSync(join(tmpdir(), "beam-home-"));
}

const OMP_HEADER = (cwd: string) =>
  `{"type":"title","v":1,"title":"t"}\n` +
  `{"type":"session","version":3,"id":"abc-123","timestamp":"2026-01-01T00:00:00.000Z","cwd":"${cwd}"}\n` +
  `{"type":"message","id":"m1"}\n`;

describe("omp adapter", () => {
  test("rewriteSessionHeaderCwd only touches the session header line", () => {
    const out = rewriteSessionHeaderCwd(OMP_HEADER("/old/path"), "/new/path");
    const lines = out.split("\n");
    expect(JSON.parse(lines[1]!).cwd).toBe("/new/path");
    expect(lines[0]).toBe(`{"type":"title","v":1,"title":"t"}`);
    expect(lines[2]).toBe(`{"type":"message","id":"m1"}`);
  });

  test("rewriteSessionHeaderCwd throws when no header exists", () => {
    expect(() => rewriteSessionHeaderCwd(`{"type":"message"}`, "/x")).toThrow(/header/);
  });

  test("locate finds newest session via dashed home-relative dir", async () => {
    const home = fixtureHome();
    const cwd = join(home, "work", "app");
    const dir = join(home, ".omp", "agent", "sessions", "-work-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_old.jsonl"), OMP_HEADER(cwd));
    writeFileSync(join(dir, "2026-01-02T00-00-00-000Z_new.jsonl"), OMP_HEADER(cwd));
    utimesSync(join(dir, "2026-01-01T00-00-00-000Z_old.jsonl"), new Date(1000), new Date(1000));

    const found = await new OmpAdapter().locate(cwd, home);
    expect(found?.id).toBe("new");
    expect(found?.file.endsWith("_new.jsonl")).toBe(true);
  });

  test("locate falls back to header-cwd scan for foreign dir names", async () => {
    const home = fixtureHome();
    const cwd = "/somewhere/outside/home";
    const dir = join(home, ".omp", "agent", "sessions", "opaque-dir-name");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_x1.jsonl"), OMP_HEADER(cwd));

    const found = await new OmpAdapter().locate(cwd, home);
    expect(found?.id).toBe("x1");
  });
});

describe("pi adapter", () => {
  test("locate finds sessions via the wrapped-dash absolute-cwd dir", async () => {
    const home = fixtureHome();
    const cwd = "/w/proj";
    const dir = join(home, ".pi", "agent", "sessions", "--w-proj--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_pi1.jsonl"), OMP_HEADER(cwd));

    const found = await new PiAdapter().locate(cwd, home);
    expect(found?.id).toBe("pi1");
  });

  test("install ships into a private session dir and resumes via --continue", async () => {
    const home = fixtureHome();
    const cwd = join(home, "w");
    const store = join(home, ".pi", "agent", "sessions", `-${cwd}-`.replaceAll("/", "-"));
    mkdirSync(store, { recursive: true });
    const file = join(store, "2026-01-01T00-00-00-000Z_pi2.jsonl");
    writeFileSync(file, OMP_HEADER(cwd));

    const adapter = new PiAdapter();
    const session = await adapter.locate(cwd, home);
    expect(session?.id).toBe("pi2");

    const remoteCwd = join(home, "remote-ws");
    const installed = await adapter.install(new LocalTransport(home), session!, remoteCwd, "go");
    expect(installed.resumeArgv).toEqual([
      "pi",
      "--session-dir",
      ".beam/pi-sessions",
      "--continue",
      "go",
    ]);
    const shipped = readFileSync(join(remoteCwd, ".beam", "pi-sessions", "session.jsonl"), "utf8");
    expect(JSON.parse(shipped.split("\n")[1]!).cwd).toBe(remoteCwd);
  });
});

describe("claude adapter", () => {
  test("slug replaces slashes and dots, keeps underscores", () => {
    expect(claudeProjectSlug("/Users/x/.bb/env_abc")).toBe("-Users-x--bb-env_abc");
  });

  test("locate checks legacy underscore-dashed slug too", async () => {
    const home = fixtureHome();
    const cwd = "/w/env_abc";
    const legacyDir = join(home, ".claude", "projects", "-w-env-abc");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "11111111-2222-3333-4444-555555555555.jsonl"), "{}\n");

    const found = await new ClaudeAdapter().locate(cwd, home);
    expect(found?.id).toBe("11111111-2222-3333-4444-555555555555");
  });

  test("cleanupRemote removes the installed transcript and its project dir", async () => {
    const home = fixtureHome();
    const remoteCwd = join(home, "remote-ws");
    const t = new LocalTransport(home);
    const session = {
      tool: "claude" as const,
      id: "11111111-2222-3333-4444-555555555555",
      file: join(home, "unused.jsonl"),
      mtime: 0,
    };
    writeFileSync(session.file, "{}\n");

    const adapter = new ClaudeAdapter();
    await adapter.install(t, session, remoteCwd);
    const installedDir = join(home, ".claude", "projects", claudeProjectSlug(remoteCwd));
    expect(existsSync(join(installedDir, `${session.id}.jsonl`))).toBe(true);

    await adapter.cleanupRemote(t, session, remoteCwd);
    expect(existsSync(join(installedDir, `${session.id}.jsonl`))).toBe(false);
    expect(existsSync(installedDir)).toBe(false);
  });
});

describe("codex adapter", () => {
  test("locate matches session_meta cwd and extracts the id", async () => {
    const home = fixtureHome();
    const cwd = "/w/project";
    const dir = join(home, ".codex", "sessions", "2026", "08", "09");
    mkdirSync(dir, { recursive: true });
    const meta = { timestamp: "t", type: "session_meta", payload: { session_id: "id-1", cwd } };
    writeFileSync(join(dir, "rollout-2026-08-09T10-00-00-id-1.jsonl"), JSON.stringify(meta) + "\n");
    const other = { timestamp: "t", type: "session_meta", payload: { session_id: "id-2", cwd: "/elsewhere" } };
    writeFileSync(join(dir, "rollout-2026-08-09T11-00-00-id-2.jsonl"), JSON.stringify(other) + "\n");

    const found = await new CodexAdapter().locate(cwd, home);
    expect(found?.id).toBe("id-1");
  });
});

describe("remote auth probes (credentials never travel; beam login is the fix)", () => {
  test("codex and pi probes flip on their auth files", async () => {
    const home = fixtureHome();
    const t = new LocalTransport(home);
    const codex = new CodexAdapter();
    const pi = new PiAdapter();

    expect((await t.exec(codex.remoteAuthProbe!)).code).not.toBe(0);
    expect((await t.exec(pi.remoteAuthProbe!)).code).not.toBe(0);

    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "{}");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "auth.json"), "{}");

    expect((await t.exec(codex.remoteAuthProbe!)).code).toBe(0);
    expect((await t.exec(pi.remoteAuthProbe!)).code).toBe(0);
  });

  test("claude probe trusts the credentials file, and the Keychain on macOS", async () => {
    const home = fixtureHome();
    const t = new LocalTransport(home);
    const probe = new ClaudeAdapter().remoteAuthProbe!;

    const withoutFile = (await t.exec(probe)).code;
    if (process.platform === "darwin") {
      expect(withoutFile).toBe(0); // Keychain-backed: indeterminate must pass
    } else {
      expect(withoutFile).not.toBe(0);
    }

    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
    expect((await t.exec(probe)).code).toBe(0);
  });

  test("omp has no probe but always has a login command", () => {
    const omp = new OmpAdapter();
    expect(omp.remoteAuthProbe).toBeUndefined();
    expect(omp.loginArgv).toEqual(["omp"]);
  });
});
