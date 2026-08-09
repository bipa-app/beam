import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectSlug, ClaudeAdapter } from "../src/session/claude.ts";
import { CodexAdapter } from "../src/session/codex.ts";
import { OmpAdapter, rewriteOmpHeaderCwd } from "../src/session/omp.ts";

function fixtureHome(): string {
  return mkdtempSync(join(tmpdir(), "beam-home-"));
}

const OMP_HEADER = (cwd: string) =>
  `{"type":"title","v":1,"title":"t"}\n` +
  `{"type":"session","version":3,"id":"abc-123","timestamp":"2026-01-01T00:00:00.000Z","cwd":"${cwd}"}\n` +
  `{"type":"message","id":"m1"}\n`;

describe("omp adapter", () => {
  test("rewriteOmpHeaderCwd only touches the session header line", () => {
    const out = rewriteOmpHeaderCwd(OMP_HEADER("/old/path"), "/new/path");
    const lines = out.split("\n");
    expect(JSON.parse(lines[1]!).cwd).toBe("/new/path");
    expect(lines[0]).toBe(`{"type":"title","v":1,"title":"t"}`);
    expect(lines[2]).toBe(`{"type":"message","id":"m1"}`);
  });

  test("rewriteOmpHeaderCwd throws when no header exists", () => {
    expect(() => rewriteOmpHeaderCwd(`{"type":"message"}`, "/x")).toThrow(/header/);
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
