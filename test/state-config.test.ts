import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveTarget } from "../src/config.ts";
import type { BeamEnv } from "../src/env.ts";
import { addRecord, findRecord, updateRecord, type BeamRecord } from "../src/state.ts";

function tempEnv(): BeamEnv {
  const home = mkdtempSync(join(tmpdir(), "beam-state-"));
  return { home, beamDir: join(home, ".beam") };
}

function record(id: string, status: BeamRecord["status"], createdAt: string): BeamRecord {
  return {
    id,
    target: "sandbox",
    localCwd: "/w",
    remoteCwd: "/r",
    tmux: `beam-${id}`,
    status,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("handoff records", () => {
  test("findRecord resolves unique id prefixes and rejects ambiguous ones", () => {
    const env = tempEnv();
    addRecord(env, record("abc123", "up", "2026-01-01"));
    addRecord(env, record("abd456", "up", "2026-01-02"));

    expect(findRecord(env, "abc").id).toBe("abc123");
    expect(() => findRecord(env, "ab")).toThrow(/ambiguous/);
    expect(() => findRecord(env, "zzz")).toThrow(/no record/);
  });

  test("findRecord without a ref prefers the newest record still up", () => {
    const env = tempEnv();
    addRecord(env, record("old-up", "up", "2026-01-01"));
    addRecord(env, record("newer-down", "down", "2026-01-03"));
    expect(findRecord(env).id).toBe("old-up");
  });

  test("findRecord falls back to newest overall when nothing is up", () => {
    const env = tempEnv();
    addRecord(env, record("a1", "down", "2026-01-01"));
    addRecord(env, record("b2", "killed", "2026-01-02"));
    expect(findRecord(env).id).toBe("b2");
  });

  test("updateRecord patches status and bumps updatedAt", () => {
    const env = tempEnv();
    addRecord(env, record("abc123", "up", "2026-01-01"));
    const updated = updateRecord(env, "abc123", { status: "down" });
    expect(updated.status).toBe("down");
    expect(updated.updatedAt).not.toBe("2026-01-01");
    expect(findRecord(env, "abc123").status).toBe("down");
  });
});

describe("target resolution", () => {
  test("errors loudly with no targets", () => {
    expect(() => resolveTarget({ targets: {} })).toThrow(/beam init/);
  });

  test("falls back to the sole configured target", () => {
    const config = { targets: { only: { type: "local" as const, root: "/tmp/r" } } };
    expect(resolveTarget(config).name).toBe("only");
  });

  test("requires --target when several targets exist and no default is set", () => {
    const config = {
      targets: {
        a: { type: "local" as const, root: "/tmp/a" },
        b: { type: "local" as const, root: "/tmp/b" },
      },
    };
    expect(() => resolveTarget(config)).toThrow(/--target/);
    expect(resolveTarget(config, "b").name).toBe("b");
    expect(() => resolveTarget(config, "nope")).toThrow(/unknown target/);
  });

  test("loadConfig tolerates a missing file", () => {
    const env = tempEnv();
    mkdirSync(env.beamDir, { recursive: true });
    expect(loadConfig(env).targets).toEqual({});
    writeFileSync(join(env.beamDir, "config.json"), `{"defaultTarget":"x","targets":{"x":{"type":"local","root":"/r"}}}`);
    expect(resolveTarget(loadConfig(env)).name).toBe("x");
  });
});
