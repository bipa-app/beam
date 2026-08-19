/**
 * Goal: state-file and target-config boundary regressions — record lookup
 * and update semantics, target resolution errors, malformed `state.json`
 * shapes refused with a recovery path instead of being treated as empty,
 * the legacy `tmux` record key loading as `runtimeSession`, and runtime
 * discriminant checks that reject persisted target types no beam release
 * ever wrote.
 *
 * Method: exercise the pure config/state seams (`loadConfig`,
 * `resolveTarget`, `loadState`, `addRecord`/`findRecord`/`updateRecord`,
 * `createProvider`/`createTransport`) against fixture `BEAM_HOME`
 * directories built under mkdtemp — no real user state is read or written.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveTarget, type LocalTargetSpec, type TargetSpec } from "../src/config.ts";
import type { BeamEnv } from "../src/env.ts";
import { createProvider } from "../src/provider/index.ts";
import { addRecord, findRecord, loadState, updateRecord, type BeamRecord } from "../src/state.ts";
import { createTransport } from "../src/transport/index.ts";

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
    runtimeSession: `beam-${id}`,
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
    writeFileSync(
      join(env.beamDir, "config.json"),
      `{"defaultTarget":"x","targets":{"x":{"type":"local","root":"/r"}}}`,
    );
    expect(resolveTarget(loadConfig(env)).name).toBe("x");
  });
});

describe("state file read boundary", () => {
  function writeState(env: BeamEnv, bytes: string): void {
    mkdirSync(env.beamDir, { recursive: true });
    writeFileSync(join(env.beamDir, "state.json"), bytes);
  }

  test("a well-formed state file still loads", () => {
    const env = tempEnv();
    writeState(env, `{"records": []}`);
    expect(loadState(env).records).toEqual([]);
  });

  test("a records field that is not an array is refused with a recovery path", () => {
    const env = tempEnv();
    writeState(env, `{"records": "nope"}`);
    expect(() => loadState(env)).toThrow(/"records" is not an array/);
    expect(() => loadState(env)).toThrow(/restore it from a backup, or delete it/);
  });

  test("a top-level shape without a records object is refused, never treated as empty", () => {
    const env = tempEnv();
    for (const bytes of ["[]", "null", `"records"`, "42"]) {
      writeState(env, bytes);
      expect(() => loadState(env)).toThrow(/restore it from a backup, or delete it/);
    }
  });

  test("unparseable state bytes are refused with the same recovery path", () => {
    const env = tempEnv();
    writeState(env, `{"records": [`);
    expect(() => loadState(env)).toThrow(/not valid JSON/);
    expect(() => loadState(env)).toThrow(/restore it from a backup, or delete it/);
  });

  test("a legacy record persisted with the `tmux` key loads as runtimeSession", () => {
    const env = tempEnv();
    const legacy = {
      id: "legacy1",
      target: "sandbox",
      localCwd: "/w",
      remoteCwd: "/r",
      tmux: "beam-legacy1", // pre-herdr releases persisted the session under this key
      status: "up",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    };
    writeState(env, JSON.stringify({ records: [legacy] }));
    const loaded = loadState(env).records;
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.runtimeSession).toBe("beam-legacy1");
  });
});

describe("runtime discriminant boundaries", () => {
  test("createTransport refuses a persisted target type no beam release wrote", () => {
    const spec = { type: "teleport", root: "/r" } as unknown as LocalTargetSpec;
    expect(() => createTransport(spec)).toThrow(/beam \(invariant\)/);
    expect(() => createTransport(spec)).toThrow(/teleport/);
  });

  test("createProvider refuses an unknown target type instead of guessing a provider", () => {
    const spec = { type: "teleport", root: "/r" } as unknown as TargetSpec;
    expect(() => createProvider(spec)).toThrow(/beam \(invariant\)/);
    expect(() => createProvider(spec)).toThrow(/teleport/);
  });
});
