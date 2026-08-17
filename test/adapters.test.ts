/**
 * Goal: prove every session adapter (omp, pi, claude, codex) locates the
 * right transcript, installs it create-only and idempotently, collects it
 * back without mutating local stores or following hostile symlinks, and
 * probes remote auth without shipping credentials.
 *
 * Method: real-filesystem fixtures under hermetic mkdtemp homes, driven
 * through LocalTransport; every refusal asserts both the thrown cause and
 * the byte-intact state it leaves behind.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectSlug, ClaudeAdapter } from "../src/session/claude.ts";
import { CodexAdapter, HEADER_SCAN_BYTES } from "../src/session/codex.ts";
import { OmpAdapter, PiAdapter, rewriteSessionHeaderCwd } from "../src/session/pi-family.ts";
import { LocalTransport } from "../src/transport/local.ts";
import type { SyncOptions } from "../src/transport/types.ts";
import { collectSessionReturn } from "../src/session/collect-txn.ts";
import { collectGuardedHomeFile } from "../src/session/guarded-store.ts";
import type { BeamEnv } from "../src/env.ts";
import { addRecord, loadState, type BeamRecord } from "../src/state.ts";
import { sessionInstallKey, sessionShipBundle } from "../src/session/ship-bundle.ts";

const PROCESS_TEST_TIMEOUT_MS = 30_000;
setDefaultTimeout(PROCESS_TEST_TIMEOUT_MS);

function fixtureHome(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "beam-home-")));
}

const OMP_HEADER = (cwd: string, id = "abc-123") =>
  `{"type":"title","v":1,"title":"t"}\n` +
  `{"type":"session","version":3,"id":"${id}",` +
  `"timestamp":"2026-01-01T00:00:00.000Z","cwd":"${cwd}"}\n` +
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
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_old.jsonl"), OMP_HEADER(cwd, "old"));
    writeFileSync(join(dir, "2026-01-02T00-00-00-000Z_new.jsonl"), OMP_HEADER(cwd, "new"));
    utimesSync(join(dir, "2026-01-01T00-00-00-000Z_old.jsonl"), new Date(1000), new Date(1000));

    const found = await new OmpAdapter().locate(cwd, home);
    expect(found?.id).toBe("new");
    expect(found?.file.endsWith("_new.jsonl")).toBe(true);
  });

  test("locate finds wrapped absolute-cwd sessions despite a header path alias", async () => {
    const home = fixtureHome();
    const cwd = "/private/tmp/beam-live";
    const dir = join(home, ".omp", "agent", "sessions", "--private-tmp-beam-live--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-01-03T00-00-00-000Z_live.jsonl"),
      OMP_HEADER("/tmp/beam-live", "live"),
    );

    const found = await new OmpAdapter().locate(cwd, home);
    expect(found?.id).toBe("live");
  });

  test("locate falls back to header-cwd scan for foreign dir names", async () => {
    const home = fixtureHome();
    const cwd = "/somewhere/outside/home";
    const dir = join(home, ".omp", "agent", "sessions", "opaque-dir-name");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_x1.jsonl"), OMP_HEADER(cwd, "x1"));

    const found = await new OmpAdapter().locate(cwd, home);
    expect(found?.id).toBe("x1");
  });

  test("locate skips a newer foreign transcript in the slug dir", async () => {
    const home = fixtureHome();
    const cwd = join(home, "work", "app");
    const dir = join(home, ".omp", "agent", "sessions", "-work-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_mine.jsonl"), OMP_HEADER(cwd, "mine"));
    writeFileSync(
      join(dir, "2026-01-02T00-00-00-000Z_foreign.jsonl"),
      OMP_HEADER("/elsewhere/app", "foreign"),
    );
    utimesSync(join(dir, "2026-01-01T00-00-00-000Z_mine.jsonl"), new Date(1000), new Date(1000));

    const found = await new OmpAdapter().locate(cwd, home);
    expect(found?.id).toBe("mine");
  });

  test("locate skips a corrupt newest transcript and takes the older valid one", async () => {
    const home = fixtureHome();
    const cwd = join(home, "work", "app");
    const dir = join(home, ".omp", "agent", "sessions", "-work-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_ok.jsonl"), OMP_HEADER(cwd, "ok"));
    writeFileSync(join(dir, "2026-01-02T00-00-00-000Z_bad.jsonl"), "not json\n{{{\n");
    utimesSync(join(dir, "2026-01-01T00-00-00-000Z_ok.jsonl"), new Date(1000), new Date(1000));

    const found = await new OmpAdapter().locate(cwd, home);
    expect(found?.id).toBe("ok");
  });

  test("locate accepts a /tmp-requested cwd against a /private/tmp header", async () => {
    const home = fixtureHome();
    const cwd = "/tmp/beam-live";
    const dir = join(home, ".omp", "agent", "sessions", "--tmp-beam-live--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-01-03T00-00-00-000Z_alias.jsonl"),
      OMP_HEADER("/private/tmp/beam-live", "alias"),
    );

    const found = await new OmpAdapter().locate(cwd, home);
    expect(found?.id).toBe("alias");
  });

  test("locate fallback digs past newer non-matching files in a foreign-named dir", async () => {
    const home = fixtureHome();
    const cwd = "/somewhere/outside/home";
    const dir = join(home, ".omp", "agent", "sessions", "opaque-dir-name");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_x1.jsonl"), OMP_HEADER(cwd, "x1"));
    writeFileSync(
      join(dir, "2026-01-02T00-00-00-000Z_other.jsonl"),
      OMP_HEADER("/other/ws", "other"),
    );
    writeFileSync(join(dir, "2026-01-03T00-00-00-000Z_junk.jsonl"), "corrupt\n");
    utimesSync(join(dir, "2026-01-01T00-00-00-000Z_x1.jsonl"), new Date(1000), new Date(1000));

    const found = await new OmpAdapter().locate(cwd, home);
    expect(found?.id).toBe("x1");
  });

  // Mirrors FALLBACK_DIR_SCAN_COUNT in src/session/pi-family.ts: the
  // fallback opens at most this many store dirs, newest-modified first.
  const FALLBACK_DIR_SCAN_COUNT = 400;

  test("locate fallback never opens store dirs beyond the scan cap", async () => {
    const home = fixtureHome();
    const cwd = "/somewhere/outside/home";
    const root = join(home, ".omp", "agent", "sessions");
    // A valid matching session sits in the OLDEST-modified store dir while
    // FALLBACK_DIR_SCAN_COUNT newer dirs fill the scan window: the dir is
    // sliced out before any file inside it is ever inspected.
    const beyond = join(root, "beyond-cap");
    mkdirSync(beyond, { recursive: true });
    const hidden = join(beyond, "2026-01-01T00-00-00-000Z_hidden.jsonl");
    writeFileSync(hidden, OMP_HEADER(cwd, "hidden"));
    utimesSync(beyond, new Date(1000), new Date(1000));
    // Freshly created decoys carry present-day mtimes, all newer than the
    // epoch-pinned beyond-cap dir.
    for (let i = 0; i < FALLBACK_DIR_SCAN_COUNT; i++) {
      mkdirSync(join(root, `decoy-${i}`));
    }

    expect(await new OmpAdapter().locate(cwd, home)).toBeUndefined();
  });

  test("locate fallback picks the newest in-cap match, not a newer beyond-cap one", async () => {
    const home = fixtureHome();
    const cwd = "/somewhere/outside/home";
    const root = join(home, ".omp", "agent", "sessions");
    // The beyond-cap dir holds the newest session FILE of all, but the dir
    // itself is the oldest-modified: the cap excludes it unopened, so it
    // can never outrank the in-cap matches.
    const beyond = join(root, "beyond-cap");
    mkdirSync(beyond, { recursive: true });
    const hidden = join(beyond, "2026-01-09T00-00-00-000Z_hidden.jsonl");
    writeFileSync(hidden, OMP_HEADER(cwd, "hidden"));
    utimesSync(hidden, new Date(9_000_000), new Date(9_000_000));
    utimesSync(beyond, new Date(1000), new Date(1000));
    for (let i = 0; i < FALLBACK_DIR_SCAN_COUNT - 2; i++) {
      mkdirSync(join(root, `decoy-${i}`));
    }
    // Two validated in-cap matches: the newer session file wins.
    const older = join(root, "in-cap-older");
    mkdirSync(older);
    const olderFile = join(older, "2026-01-02T00-00-00-000Z_older.jsonl");
    writeFileSync(olderFile, OMP_HEADER(cwd, "older"));
    utimesSync(olderFile, new Date(5_000_000), new Date(5_000_000));
    const newer = join(root, "in-cap-newer");
    mkdirSync(newer);
    const newerFile = join(newer, "2026-01-03T00-00-00-000Z_newer.jsonl");
    writeFileSync(newerFile, OMP_HEADER(cwd, "newer"));
    utimesSync(newerFile, new Date(6_000_000), new Date(6_000_000));

    const found = await new OmpAdapter().locate(cwd, home);
    expect(found?.id).toBe("newer");
  });

  test("locate honors sessionRef among validated matches", async () => {
    const home = fixtureHome();
    const cwd = join(home, "work", "app");
    const dir = join(home, ".omp", "agent", "sessions", "-work-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_aaa.jsonl"), OMP_HEADER(cwd, "aaa"));
    writeFileSync(join(dir, "2026-01-02T00-00-00-000Z_bbb.jsonl"), OMP_HEADER(cwd, "bbb"));
    utimesSync(join(dir, "2026-01-01T00-00-00-000Z_aaa.jsonl"), new Date(1000), new Date(1000));

    const found = await new OmpAdapter().locate(cwd, home, "aaa");
    expect(found?.id).toBe("aaa");
  });

  test(
    "locate skips a renamed transcript whose header id disagrees with its filename",
    async () => {
      const home = fixtureHome();
      const cwd = join(home, "work", "app");
      const dir = join(home, ".omp", "agent", "sessions", "-work-app");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_mine.jsonl"), OMP_HEADER(cwd, "mine"));
      // A newer transcript renamed (or planted) under a different filename id:
      // right cwd, wrong identity — filename alone is never proof.
      writeFileSync(
        join(dir, "2026-01-02T00-00-00-000Z_planted.jsonl"),
        OMP_HEADER(cwd, "someone-else"),
      );
      utimesSync(join(dir, "2026-01-01T00-00-00-000Z_mine.jsonl"), new Date(1000), new Date(1000));

      const found = await new OmpAdapter().locate(cwd, home);
      expect(found?.id).toBe("mine");
    },
  );
});

describe("pi adapter", () => {
  test("locate finds sessions via the wrapped-dash absolute-cwd dir", async () => {
    const home = fixtureHome();
    const cwd = "/w/proj";
    const dir = join(home, ".pi", "agent", "sessions", "--w-proj--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_pi1.jsonl"), OMP_HEADER(cwd, "pi1"));

    const found = await new PiAdapter().locate(cwd, home);
    expect(found?.id).toBe("pi1");
  });

  test("locate never ships a slug-colliding neighbor's transcript", async () => {
    const home = fixtureHome();
    // /private/tmp/a/b and /private/tmp/a-b collapse to the same wrapped-dash slug.
    const dir = join(home, ".pi", "agent", "sessions", "--private-tmp-a-b--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-01-01T00-00-00-000Z_ours.jsonl"),
      OMP_HEADER("/private/tmp/a/b", "ours"),
    );
    writeFileSync(
      join(dir, "2026-01-02T00-00-00-000Z_neighbor.jsonl"),
      OMP_HEADER("/private/tmp/a-b", "neighbor"),
    );
    mkdirSync(join(dir, "2026-01-01T00-00-00-000Z_ours"), { recursive: true });
    utimesSync(join(dir, "2026-01-01T00-00-00-000Z_ours.jsonl"), new Date(1000), new Date(1000));

    const adapter = new PiAdapter();
    const forNested = await adapter.locate("/private/tmp/a/b", home);
    expect(forNested?.id).toBe("ours");
    expect(forNested?.artifactsDir).toBe(join(dir, "2026-01-01T00-00-00-000Z_ours"));
    const forDashed = await adapter.locate("/private/tmp/a-b", home);
    expect(forDashed?.id).toBe("neighbor");
    // A cwd with no session anywhere never adopts the collision dir's files.
    expect(await adapter.locate("/private/tmp/other", home)).toBeUndefined();
  });

  test("install ships into a private session dir and resumes via --continue", async () => {
    const home = fixtureHome();
    const cwd = join(home, "w");
    const store = join(home, ".pi", "agent", "sessions", `-${cwd}-`.replaceAll("/", "-"));
    mkdirSync(store, { recursive: true });
    const file = join(store, "2026-01-01T00-00-00-000Z_pi2.jsonl");
    writeFileSync(file, OMP_HEADER(cwd, "pi2"));

    const adapter = new PiAdapter();
    const session = await adapter.locate(cwd, home);
    expect(session?.id).toBe("pi2");

    const remoteCwd = join(home, "remote-ws");
    const installed = await adapter.install(new LocalTransport(home), session!, remoteCwd, {
      kickoff: "go",
    });
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

describe("pi-family collect: the transcript comes off the target, never local scratch", () => {
  function ompFixture(opts: { localArtifacts?: boolean } = {}) {
    const home = fixtureHome();
    const env: BeamEnv = { home, beamDir: join(home, ".beam-state") };
    const cwd = join(home, "w");
    mkdirSync(cwd, { recursive: true });
    const store = join(home, ".omp", "agent", "sessions", "-w");
    mkdirSync(store, { recursive: true });
    const file = join(store, "2026-01-01T00-00-00-000Z_abc-123.jsonl");
    writeFileSync(file, OMP_HEADER(cwd));
    if (opts.localArtifacts) {
      // A sibling artifacts dir: locate() detects and install() ships it.
      const artifacts = join(store, "2026-01-01T00-00-00-000Z_abc-123");
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, "old.txt"), "shipped artifact\n");
    }
    const remoteCwd = join(home, "remote-ws");
    const record: BeamRecord = {
      id: "r1",
      target: "t",
      tool: "omp",
      sessionId: "abc-123",
      sessionFile: file,
      localCwd: cwd,
      remoteCwd,
      tmux: "-",
      status: "up",
      createdAt: "t",
      updatedAt: "t",
    };
    addRecord(env, record);
    return { home, env, record, cwd, store, file, t: new LocalTransport(home), remoteCwd };
  }

  test(
    "collect stages the grown remote transcript durably; local store and scratch are never touched",
    async () => {
      const f = ompFixture();
      // Stale scratch in the local workspace — the old handoff's leftovers.
      mkdirSync(join(f.cwd, ".beam"), { recursive: true });
      writeFileSync(
        join(f.cwd, ".beam", "session.jsonl"),
        `{"type":"session","cwd":"/old"}\nSTALE-SCRATCH\n`,
      );
      // The genuine grown transcript lives on the target.
      mkdirSync(join(f.remoteCwd, ".beam"), { recursive: true });
      writeFileSync(
        join(f.remoteCwd, ".beam", "session.jsonl"),
        OMP_HEADER(f.remoteCwd) + `{"type":"message","from":"remote-agent"}\n`,
      );
      const before = readFileSync(f.file, "utf8");

      const out = await collectSessionReturn(f.env, f.record, new OmpAdapter(), f.t);

      const returned = readFileSync(join(out.returnDir, "session.jsonl"), "utf8");
      expect(returned).toContain('"from":"remote-agent"');
      expect(returned).not.toContain("STALE-SCRATCH"); // stale scratch never wins
      expect(JSON.parse(returned.split("\n")[1]!).cwd).toBe(f.cwd); // header localized
      // The harness store was not touched — the return lives under beam's storage.
      expect(readFileSync(f.file, "utf8")).toBe(before);
      expect(out.returnDir.startsWith(join(f.env.beamDir, "returns", f.record.id))).toBe(true);
    },
  );

  test(
    "collect refuses a transcript that does not belong to this handoff and journals nothing",
    async () => {
      const f = ompFixture();
      mkdirSync(join(f.remoteCwd, ".beam"), { recursive: true });
      writeFileSync(join(f.remoteCwd, ".beam", "session.jsonl"), OMP_HEADER("/some/other/handoff"));

      const before = readFileSync(f.file, "utf8");
      await expect(collectSessionReturn(f.env, f.record, new OmpAdapter(), f.t)).rejects.toThrow(
        /foreign session/,
      );
      expect(readFileSync(f.file, "utf8")).toBe(before);
      expect(loadState(f.env).records[0]!.collect).toBeUndefined();
      // no partial return left behind
      const parent = join(f.env.beamDir, "returns", f.record.id);
      expect(!existsSync(parent) || readdirSync(parent).length === 0).toBe(true);
    },
  );

  test(
    "collect fails loudly when the remote transcript is gone — local scratch is no substitute",
    async () => {
      const f = ompFixture();
      mkdirSync(join(f.cwd, ".beam"), { recursive: true });
      writeFileSync(join(f.cwd, ".beam", "session.jsonl"), OMP_HEADER(f.remoteCwd));

      await expect(collectSessionReturn(f.env, f.record, new OmpAdapter(), f.t)).rejects.toThrow(
        /not found|No such file/,
      );
      expect(loadState(f.env).records[0]!.collect).toBeUndefined();
    },
  );

  test(
    "install refuses stale foreign artifacts in the reserved area instead of resetting them",
    async () => {
      const f = ompFixture();
      // Leftovers from a previous handoff on a retained (default-down) reused
      // workspace: they may be unsaved remote work — never wiped, never
      // silently adopted as this session's future return.
      mkdirSync(join(f.remoteCwd, ".beam", "session"), { recursive: true });
      writeFileSync(join(f.remoteCwd, ".beam", "session", "stale.txt"), "old artifacts\n");

      const adapter = new OmpAdapter();
      const session = (await adapter.locate(f.cwd, f.home))!;
      await expect(adapter.install(f.t, session, f.remoteCwd)).rejects.toThrow(
        /already exists with different content/,
      );

      expect(readFileSync(join(f.remoteCwd, ".beam", "session", "stale.txt"), "utf8")).toBe(
        "old artifacts\n",
      );
      // refused before publishing
      expect(existsSync(join(f.remoteCwd, ".beam", "session.jsonl"))).toBe(false);
    },
  );

  test(
    "pi install refuses unexpected entries in its private session dir — --continue must see " +
      "exactly one session",
    async () => {
      const home = fixtureHome();
      const cwd = join(home, "w");
      mkdirSync(cwd, { recursive: true });
      const store = join(home, ".pi", "agent", "sessions", `-${cwd}-`.replaceAll("/", "-") + "-");
      mkdirSync(store, { recursive: true });
      writeFileSync(join(store, "2026-01-01T00-00-00-000Z_pi9.jsonl"), OMP_HEADER(cwd, "pi9"));
      const t = new LocalTransport(home);
      const remoteCwd = join(home, "remote-ws");
      mkdirSync(join(remoteCwd, ".beam", "pi-sessions", "session"), { recursive: true });
      writeFileSync(join(remoteCwd, ".beam", "pi-sessions", "extra.jsonl"), "{}\n");
      writeFileSync(join(remoteCwd, ".beam", "pi-sessions", "session", "stale.txt"), "old\n");

      const adapter = new PiAdapter();
      const session = (await adapter.locate(cwd, home))!;
      await expect(adapter.install(t, session, remoteCwd)).rejects.toThrow(/unexpected entries/);

      // Everything left exactly where it was — recovery is the user's call.
      expect(readFileSync(join(remoteCwd, ".beam", "pi-sessions", "extra.jsonl"), "utf8")).toBe(
        "{}\n",
      );
      expect(
        readFileSync(join(remoteCwd, ".beam", "pi-sessions", "session", "stale.txt"), "utf8"),
      ).toBe("old\n");
    },
  );

  test(
    "omp install is idempotent create-only: exact retry accepts, a grown remote transcript " +
      "refuses intact",
    async () => {
      const f = ompFixture({ localArtifacts: true });
      const adapter = new OmpAdapter();
      const session = (await adapter.locate(f.cwd, f.home))!;
      await adapter.install(f.t, session, f.remoteCwd);
      const shipped = readFileSync(join(f.remoteCwd, ".beam", "session.jsonl"), "utf8");

      // Crash-after-install retry with nothing changed: exact accept, no reset.
      await adapter.install(f.t, session, f.remoteCwd);
      expect(readFileSync(join(f.remoteCwd, ".beam", "session.jsonl"), "utf8")).toBe(shipped);
      expect(readFileSync(join(f.remoteCwd, ".beam", "session", "old.txt"), "utf8")).toBe(
        "shipped artifact\n",
      );

      // The agent already ran and grew the transcript: a retry must refuse and
      // the grown bytes must survive untouched.
      appendFileSync(
        join(f.remoteCwd, ".beam", "session.jsonl"),
        `{"type":"message","from":"remote-agent"}\n`,
      );
      await expect(adapter.install(f.t, session, f.remoteCwd)).rejects.toThrow(
        /already exists with different content/,
      );
      expect(readFileSync(join(f.remoteCwd, ".beam", "session.jsonl"), "utf8")).toContain(
        '"from":"remote-agent"',
      );

      // Same for artifacts the remote agent added.
      // transcript back to exact
      writeFileSync(join(f.remoteCwd, ".beam", "session.jsonl"), shipped);
      writeFileSync(join(f.remoteCwd, ".beam", "session", "remote-new.txt"), "remote artifact\n");
      await expect(adapter.install(f.t, session, f.remoteCwd)).rejects.toThrow(
        /already exists with different content/,
      );
      expect(readFileSync(join(f.remoteCwd, ".beam", "session", "remote-new.txt"), "utf8")).toBe(
        "remote artifact\n",
      );
    },
  );

  test("pi install is idempotent create-only: exact retry accepts", async () => {
    const home = fixtureHome();
    const cwd = join(home, "w");
    mkdirSync(cwd, { recursive: true });
    const store = join(home, ".pi", "agent", "sessions", `-${cwd}-`.replaceAll("/", "-") + "-");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "2026-01-01T00-00-00-000Z_pi9.jsonl"), OMP_HEADER(cwd, "pi9"));
    const t = new LocalTransport(home);
    const remoteCwd = join(home, "remote-ws");

    const adapter = new PiAdapter();
    const session = (await adapter.locate(cwd, home))!;
    await adapter.install(t, session, remoteCwd);
    const shipped = readFileSync(join(remoteCwd, ".beam", "pi-sessions", "session.jsonl"), "utf8");

    await adapter.install(t, session, remoteCwd); // crash-after-install retry
    expect(readFileSync(join(remoteCwd, ".beam", "pi-sessions", "session.jsonl"), "utf8")).toBe(
      shipped,
    );
    expect(readdirSync(join(remoteCwd, ".beam", "pi-sessions"))).toEqual(["session.jsonl"]);
  });

  test(
    "guarded home-store install (claude) is idempotent create-only: exact retry accepts, growth " +
      "refuses intact",
    async () => {
      const home = fixtureHome();
      const remoteCwd = join(home, "remote-ws");
      const t = new LocalTransport(home);
      const id = "11111111-2222-3333-4444-555555555555";
      const local = join(home, "local.jsonl");
      writeFileSync(
        local,
        `${JSON.stringify({ type: "user", sessionId: id, message: "hello" })}\n`,
      );
      const session = { tool: "claude" as const, id, file: local, mtime: 0 };

      const adapter = new ClaudeAdapter();
      await adapter.install(t, session, remoteCwd);
      const installed = join(
        home,
        ".claude",
        "projects",
        claudeProjectSlug(remoteCwd),
        `${id}.jsonl`,
      );
      const shipped = readFileSync(installed, "utf8");

      await adapter.install(t, session, remoteCwd); // crash-after-install retry
      expect(readFileSync(installed, "utf8")).toBe(shipped);

      appendFileSync(
        installed,
        `${JSON.stringify({ type: "assistant", sessionId: id, message: "grown" })}\n`,
      );
      await expect(adapter.install(t, session, remoteCwd)).rejects.toThrow(
        /already exists with different content/,
      );
      expect(readFileSync(installed, "utf8")).toContain("grown"); // remote work intact
    },
  );

  test(
    "a crashed install's deterministic reserved stage resumes: retry converges the stage and " +
      "commits",
    async () => {
      const f = ompFixture({ localArtifacts: true });
      const adapter = new OmpAdapter();
      const session = (await adapter.locate(f.cwd, f.home))!;
      // A crashed earlier attempt left a PARTIAL stage under the reserved
      // deterministic bundle key (nothing reached the destinations).
      const key = sessionInstallKey(sessionShipBundle(session));
      const stage = join(f.remoteCwd, ".beam", "session-install", key);
      mkdirSync(stage, { recursive: true });
      writeFileSync(join(stage, "session.jsonl"), "partial garbage from a crashed upload\n");

      await adapter.install(f.t, session, f.remoteCwd);

      const shipped = readFileSync(join(f.remoteCwd, ".beam", "session.jsonl"), "utf8");
      expect(JSON.parse(shipped.split("\n")[1]!).cwd).toBe(f.remoteCwd);
      expect(shipped).not.toContain("partial garbage"); // converged, never trusted
      expect(readFileSync(join(f.remoteCwd, ".beam", "session", "old.txt"), "utf8")).toBe(
        "shipped artifact\n",
      );
      // The stage is cleaned only after the exact destination commit, and no
      // random top-level stage ever existed.
      expect(existsSync(join(f.remoteCwd, ".beam", "session-install"))).toBe(false);
      expect(readdirSync(f.remoteCwd).filter((n) => n.startsWith(".beam-stage-"))).toEqual([]);
    },
  );

  test(
    "install artifacts transaction: an owned partial resumes; a foreign or wrongly-claimed dest " +
      "refuses intact",
    async () => {
      const f = ompFixture({ localArtifacts: true });
      const adapter = new OmpAdapter();
      const session = (await adapter.locate(f.cwd, f.home))!;
      const key = sessionInstallKey(sessionShipBundle(session));
      const dest = join(f.remoteCwd, ".beam", "session");

      // (a) Foreign empty dest created before beam's mkdir: refuse, zero writes.
      mkdirSync(dest, { recursive: true });
      await expect(adapter.install(f.t, session, f.remoteCwd)).rejects.toThrow(
        /already exists with different content/,
      );
      expect(readdirSync(dest)).toEqual([]); // untouched
      // nothing published
      expect(existsSync(join(f.remoteCwd, ".beam", "session.jsonl"))).toBe(false);

      // (b) OUR crashed claim (exact sentinel + partial content): the retry
      // resumes create-only and finishes to the exact shipped tree.
      writeFileSync(join(dest, ".beam-install-owner"), `beam-artifacts-v1 ${key}\n`);
      const retried = await adapter.install(f.t, session, f.remoteCwd);
      expect(retried.resumeArgv[0]).toBe("omp");
      expect(readFileSync(join(dest, "old.txt"), "utf8")).toBe("shipped artifact\n");
      // sentinel retired after the exact commit
      expect(existsSync(join(dest, ".beam-install-owner"))).toBe(false);

      // (c) A wrong-key sentinel is a foreign claim: refuse with data retained.
      const f2 = ompFixture({ localArtifacts: true });
      const session2 = (await adapter.locate(f2.cwd, f2.home))!;
      const dest2 = join(f2.remoteCwd, ".beam", "session");
      mkdirSync(dest2, { recursive: true });
      writeFileSync(join(dest2, ".beam-install-owner"), "beam-artifacts-v1 someone-else\n");
      await expect(adapter.install(f.t, session2, f2.remoteCwd)).rejects.toThrow(
        /already exists with different content/,
      );
      expect(readFileSync(join(dest2, ".beam-install-owner"), "utf8")).toBe(
        "beam-artifacts-v1 someone-else\n",
      );
    },
  );

  test(
    "artifact modes ship exactly and the reserved area is private despite umask 022",
    async () => {
      const f = ompFixture({ localArtifacts: true });
      const artifacts = join(f.store, "2026-01-01T00-00-00-000Z_abc-123");
      writeFileSync(join(artifacts, "run.sh"), "#!/bin/sh\n");
      chmodSync(join(artifacts, "run.sh"), 0o755);
      mkdirSync(join(artifacts, "sub"));
      writeFileSync(join(artifacts, "sub", "inner.txt"), "x\n");
      chmodSync(join(artifacts, "sub"), 0o710);
      const adapter = new OmpAdapter();
      const session = (await adapter.locate(f.cwd, f.home))!;
      const prev = process.umask(0o022);
      try {
        await adapter.install(f.t, session, f.remoteCwd);
      } finally {
        process.umask(prev);
      }
      const mode = (p: string) => lstatSync(p).mode & 0o7777;
      const dest = join(f.remoteCwd, ".beam", "session");
      expect(mode(join(dest, "run.sh"))).toBe(0o755); // executable bit preserved
      expect(mode(join(dest, "sub"))).toBe(0o710); // restrictive dir bits preserved
      expect(readFileSync(join(dest, "sub", "inner.txt"), "utf8")).toBe("x\n");
      expect(mode(join(f.remoteCwd, ".beam", "session.jsonl"))).toBe(0o600); // transcript private
      expect(mode(join(f.remoteCwd, ".beam"))).toBe(0o700);
      expect(mode(dest)).toBe(0o700); // artifact root shields preserved child modes
    },
  );

  test(
    "chmod-only drift on a completed artifacts destination refuses; our exact sentinel " +
      "reconciles it",
    async () => {
      const f = ompFixture({ localArtifacts: true });
      const adapter = new OmpAdapter();
      const session = (await adapter.locate(f.cwd, f.home))!;
      const key = sessionInstallKey(sessionShipBundle(session));
      const dest = join(f.remoteCwd, ".beam", "session");
      const artifacts = join(f.store, "2026-01-01T00-00-00-000Z_abc-123");
      const shippedMode = lstatSync(join(artifacts, "old.txt")).mode & 0o7777;
      await adapter.install(f.t, session, f.remoteCwd);
      expect(lstatSync(join(dest, "old.txt")).mode & 0o7777).toBe(shippedMode);

      // Same bytes, drifted mode, no ownership: refuse with zero writes.
      chmodSync(join(dest, "old.txt"), 0o604);
      await expect(adapter.install(f.t, session, f.remoteCwd)).rejects.toThrow(
        /already exists with different content/,
      );
      expect(lstatSync(join(dest, "old.txt")).mode & 0o7777).toBe(0o604); // refusal never chmods

      // Under OUR exact sentinel the retry is an owned partial: it reconciles
      // the drifted mode back to the shipped one and completes.
      writeFileSync(join(dest, ".beam-install-owner"), `beam-artifacts-v1 ${key}\n`);
      await adapter.install(f.t, session, f.remoteCwd);
      expect(lstatSync(join(dest, "old.txt")).mode & 0o7777).toBe(shippedMode);
      expect(existsSync(join(dest, ".beam-install-owner"))).toBe(false);
    },
  );

  test("install verifies and pins the workspace owner in the commit shell", async () => {
    const f = ompFixture();
    const adapter = new OmpAdapter();
    const session = (await adapter.locate(f.cwd, f.home))!;
    const ownerBytes = "beam-workspace-v1 r1 0123456789abcdef0123456789abcdef";
    mkdirSync(join(f.remoteCwd, ".beam"), { recursive: true });
    writeFileSync(join(f.remoteCwd, ".beam", "owner"), ownerBytes);

    // Wrong owner bytes: the commit shell refuses before any effect.
    const wrongOwner = "beam-workspace-v1 rX ffffffffffffffffffffffffffffffff";
    await expect(
      adapter.install(f.t, session, f.remoteCwd, { owner: wrongOwner }),
    ).rejects.toThrow(/not owned by this handoff/);
    expect(existsSync(join(f.remoteCwd, ".beam", "session.jsonl"))).toBe(false);

    // Exact owner bytes: the install proceeds.
    await adapter.install(f.t, session, f.remoteCwd, { owner: ownerBytes });
    expect(readFileSync(join(f.remoteCwd, ".beam", "session.jsonl"), "utf8")).toContain(
      '"type":"session"',
    );
  });
});

describe("pi-family install: `.beam` is never followed as a symlink", () => {
  // A reused retained (default-down) workspace comes back with whatever the remote
  // agent left in `.beam` — including `.beam` itself swapped for a symlink
  // to a tree the agent wants beam to destroy or overwrite on its behalf.
  function symlinkedBeamFixture(tool: "omp" | "pi") {
    const home = fixtureHome();
    const cwd = join(home, "w");
    mkdirSync(cwd, { recursive: true });
    const store = join(
      home,
      tool === "omp"
        ? join(".omp", "agent", "sessions", "-w")
        : join(".pi", "agent", "sessions", `-${cwd}-`.replaceAll("/", "-") + "-"),
    );
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "2026-01-01T00-00-00-000Z_s1.jsonl"), OMP_HEADER(cwd, "s1"));

    // External sentinel tree laid out so the OLD direct `rm -rf`/write flow
    // would have destroyed it through the link.
    const sentinel = join(home, "sentinel");
    mkdirSync(join(sentinel, "session"), { recursive: true });
    mkdirSync(join(sentinel, "pi-sessions"), { recursive: true });
    writeFileSync(join(sentinel, "session.jsonl"), "victim transcript\n");
    writeFileSync(join(sentinel, "session", "victim.txt"), "victim artifacts\n");
    writeFileSync(join(sentinel, "pi-sessions", "victim.jsonl"), "victim pi session\n");

    const remoteCwd = join(home, "remote-ws");
    mkdirSync(remoteCwd, { recursive: true });
    symlinkSync(sentinel, join(remoteCwd, ".beam"));
    return { home, cwd, sentinel, remoteCwd, t: new LocalTransport(home) };
  }

  function expectSentinelIntact(sentinel: string): void {
    expect(readFileSync(join(sentinel, "session.jsonl"), "utf8")).toBe("victim transcript\n");
    expect(readFileSync(join(sentinel, "session", "victim.txt"), "utf8")).toBe(
      "victim artifacts\n",
    );
    expect(readFileSync(join(sentinel, "pi-sessions", "victim.jsonl"), "utf8")).toBe(
      "victim pi session\n",
    );
    expect(readdirSync(sentinel).sort()).toEqual(["pi-sessions", "session", "session.jsonl"]);
  }

  test("omp install refuses a symlinked .beam and leaves the external tree unchanged", async () => {
    const f = symlinkedBeamFixture("omp");
    const adapter = new OmpAdapter();
    const session = (await adapter.locate(f.cwd, f.home))!;

    await expect(adapter.install(f.t, session, f.remoteCwd)).rejects.toThrow(/symlink/);

    expectSentinelIntact(f.sentinel);
    // The link itself is untouched, and the failed install cleaned its stage.
    expect(lstatSync(join(f.remoteCwd, ".beam")).isSymbolicLink()).toBe(true);
    expect(readdirSync(f.remoteCwd).filter((n) => n.startsWith(".beam-stage-"))).toEqual([]);
  });

  test("pi install refuses a symlinked .beam and leaves the external tree unchanged", async () => {
    const f = symlinkedBeamFixture("pi");
    const adapter = new PiAdapter();
    const session = (await adapter.locate(f.cwd, f.home))!;

    await expect(adapter.install(f.t, session, f.remoteCwd)).rejects.toThrow(/symlink/);

    expectSentinelIntact(f.sentinel);
    expect(lstatSync(join(f.remoteCwd, ".beam")).isSymbolicLink()).toBe(true);
    expect(readdirSync(f.remoteCwd).filter((n) => n.startsWith(".beam-stage-"))).toEqual([]);
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
    writeFileSync(
      session.file,
      `${JSON.stringify({ type: "user", sessionId: session.id, message: "hello" })}\n`,
    );

    const adapter = new ClaudeAdapter();
    await adapter.install(t, session, remoteCwd);
    const installedDir = join(home, ".claude", "projects", claudeProjectSlug(remoteCwd));
    expect(existsSync(join(installedDir, `${session.id}.jsonl`))).toBe(true);

    await adapter.cleanupRemote(t, session, remoteCwd);
    expect(existsSync(join(installedDir, `${session.id}.jsonl`))).toBe(false);
    expect(existsSync(installedDir)).toBe(false);
  });

  test(
    "install lands the transcript 0600 under private beam-created store dirs with zero residue " +
      "(umask 022)",
    async () => {
      const home = fixtureHome();
      const remoteCwd = join(home, "remote-ws");
      const t = new LocalTransport(home);
      const id = "11111111-2222-3333-4444-555555555555";
      const session = { tool: "claude" as const, id, file: join(home, "src.jsonl"), mtime: 0 };
      writeFileSync(
        session.file,
        `${JSON.stringify({ type: "user", sessionId: id, message: "hello" })}\n`,
      );
      const prev = process.umask(0o022);
      try {
        await new ClaudeAdapter().install(t, session, remoteCwd);
      } finally {
        process.umask(prev);
      }
      const mode = (p: string) => lstatSync(p).mode & 0o7777;
      const slugDir = join(home, ".claude", "projects", claudeProjectSlug(remoteCwd));
      expect(readFileSync(join(slugDir, `${id}.jsonl`), "utf8")).toContain('"sessionId"');
      expect(mode(join(slugDir, `${id}.jsonl`))).toBe(0o600);
      expect(mode(slugDir)).toBe(0o700);
      expect(mode(join(home, ".claude", "projects"))).toBe(0o700);
      expect(mode(join(home, ".claude"))).toBe(0o700);
      // Zero residue: no temp/handle in the store dir, no home-level stage.
      expect(readdirSync(slugDir)).toEqual([`${id}.jsonl`]);
      expect(readdirSync(home).filter((n) => n.startsWith(".beam-"))).toEqual([]);
    },
  );

  test(
    "install refuses a differing existing transcript with zero residue; identical content is " +
      "tightened to 0600",
    async () => {
      const home = fixtureHome();
      const remoteCwd = join(home, "remote-ws");
      const t = new LocalTransport(home);
      const adapter = new ClaudeAdapter();
      const id = "11111111-2222-3333-4444-555555555555";
      const session = { tool: "claude" as const, id, file: join(home, "src.jsonl"), mtime: 0 };
      const body = `${JSON.stringify({ type: "user", sessionId: id, message: "hello" })}\n`;
      writeFileSync(session.file, body);
      const slugDir = join(home, ".claude", "projects", claudeProjectSlug(remoteCwd));
      mkdirSync(slugDir, { recursive: true });
      const destFile = join(slugDir, `${id}.jsonl`);

      writeFileSync(destFile, "unsaved remote work\n");
      await expect(adapter.install(t, session, remoteCwd)).rejects.toThrow(/different content/);
      expect(readFileSync(destFile, "utf8")).toBe("unsaved remote work\n");
      // refusal leaves no temp/handle residue
      expect(readdirSync(slugDir)).toEqual([`${id}.jsonl`]);

      writeFileSync(destFile, body);
      chmodSync(destFile, 0o644);
      await adapter.install(t, session, remoteCwd);
      expect(readFileSync(destFile, "utf8")).toBe(body);
      expect(lstatSync(destFile).mode & 0o7777).toBe(0o600); // accepted and tightened
      expect(readdirSync(slugDir)).toEqual([`${id}.jsonl`]);
    },
  );

  test(
    "collect fetches directly with zero remote writes and refuses a symlinked store file",
    async () => {
      const home = fixtureHome();
      const remoteCwd = join(home, "remote-ws");
      const t = new LocalTransport(home);
      const id = "11111111-2222-3333-4444-555555555555";
      const slugDir = join(home, ".claude", "projects", claudeProjectSlug(remoteCwd));
      mkdirSync(slugDir, { recursive: true });
      const destFile = join(slugDir, `${id}.jsonl`);
      const grown = `${JSON.stringify({ type: "user", sessionId: id, message: "grown" })}\n`;
      writeFileSync(destFile, grown);

      const namesBefore = readdirSync(slugDir).sort();
      const path = [".claude", "projects", claudeProjectSlug(remoteCwd), `${id}.jsonl`];
      const collected = await collectGuardedHomeFile(t, path);
      expect(collected).toBe(grown);
      expect(readdirSync(slugDir).sort()).toEqual(namesBefore); // zero remote writes
      expect(readdirSync(home).filter((n) => n.startsWith(".beam-"))).toEqual([]);

      // A symlinked source refuses through the pinned probe; the store and the
      // link stay untouched.
      rmSync(destFile);
      writeFileSync(join(home, "outside.jsonl"), "outside\n");
      symlinkSync(join(home, "outside.jsonl"), destFile);
      await expect(collectGuardedHomeFile(t, path)).rejects.toThrow(/missing or unsafe/);
      expect(lstatSync(destFile).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(home, "outside.jsonl"), "utf8")).toBe("outside\n");
    },
  );

  test(
    "collect labels only true absence as missing; a staging fault keeps its real cause",
    async () => {
      const home = fixtureHome();
      const remoteCwd = join(home, "remote-ws");
      const id = "11111111-2222-3333-4444-555555555555";
      const slugDir = join(home, ".claude", "projects", claudeProjectSlug(remoteCwd));
      mkdirSync(slugDir, { recursive: true });
      writeFileSync(join(slugDir, `${id}.jsonl`), "line\n");
      const path = [".claude", "projects", claudeProjectSlug(remoteCwd), `${id}.jsonl`];

      // Expected absence: the transcript never lands in the local stage — the
      // branded "missing" refusal, exactly as before.
      class DroppingTransport extends LocalTransport {
        override async syncDown(
          remoteDir: string,
          localDir: string,
          opts?: SyncOptions,
        ): Promise<void> {
          await super.syncDown(remoteDir, localDir, opts);
          rmSync(join(localDir, `${id}.jsonl`));
        }
      }
      await expect(collectGuardedHomeFile(new DroppingTransport(home), path)).rejects.toThrow(
        /transcript is missing/,
      );

      // A real fault: the private stage directory is clobbered into a regular
      // file, so the transcript lstat hits ENOTDIR — that cause must surface,
      // never a mislabeled "missing".
      class ClobberingTransport extends LocalTransport {
        override async syncDown(
          remoteDir: string,
          localDir: string,
          opts?: SyncOptions,
        ): Promise<void> {
          await super.syncDown(remoteDir, localDir, opts);
          rmSync(localDir, { recursive: true, force: true });
          writeFileSync(localDir, "not a directory\n");
        }
      }
      await expect(collectGuardedHomeFile(new ClobberingTransport(home), path)).rejects.toThrow(
        /ENOTDIR/,
      );
    },
  );
});

describe("codex adapter", () => {
  test("locate matches session_meta cwd and extracts the id", async () => {
    const home = fixtureHome();
    const cwd = "/w/project";
    const dir = join(home, ".codex", "sessions", "2026", "08", "09");
    mkdirSync(dir, { recursive: true });
    const meta = { timestamp: "t", type: "session_meta", payload: { session_id: "id-1", cwd } };
    writeFileSync(join(dir, "rollout-2026-08-09T10-00-00-id-1.jsonl"), JSON.stringify(meta) + "\n");
    const other = {
      timestamp: "t",
      type: "session_meta",
      payload: { session_id: "id-2", cwd: "/elsewhere" },
    };
    writeFileSync(
      join(dir, "rollout-2026-08-09T11-00-00-id-2.jsonl"),
      JSON.stringify(other) + "\n",
    );

    const found = await new CodexAdapter().locate(cwd, home);
    expect(found?.id).toBe("id-1");
  });

  test("locate identifies a transcript far larger than the header cap", async () => {
    const home = fixtureHome();
    const cwd = "/w/project";
    const dir = join(home, ".codex", "sessions", "2026", "08", "09");
    mkdirSync(dir, { recursive: true });
    const meta = { timestamp: "t", type: "session_meta", payload: { session_id: "id-big", cwd } };
    // Body several times the bounded-read cap: locate must extract cwd and id
    // from the capped header region alone, never buffering the whole file.
    const bodyLine = `${JSON.stringify({ type: "message", text: "x".repeat(1024) })}\n`;
    const body = bodyLine.repeat(Math.ceil((4 * HEADER_SCAN_BYTES) / bodyLine.length));
    const file = join(dir, "rollout-2026-08-09T12-00-00-id-big.jsonl");
    writeFileSync(file, `${JSON.stringify(meta)}\n${body}`);
    expect(statSync(file).size).toBeGreaterThan(4 * HEADER_SCAN_BYTES);

    const found = await new CodexAdapter().locate(cwd, home);
    expect(found?.id).toBe("id-big");
    expect(found?.file).toBe(file);
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
