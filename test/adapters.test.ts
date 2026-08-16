import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

  test("locate finds wrapped absolute-cwd sessions despite a header path alias", async () => {
    const home = fixtureHome();
    const cwd = "/private/tmp/beam-live";
    const dir = join(home, ".omp", "agent", "sessions", "--private-tmp-beam-live--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-01-03T00-00-00-000Z_live.jsonl"),
      OMP_HEADER("/tmp/beam-live"),
    );

    const found = await new OmpAdapter().locate(cwd, home);
    expect(found?.id).toBe("live");
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

  test("locate skips a newer foreign transcript in the slug dir", async () => {
    const home = fixtureHome();
    const cwd = join(home, "work", "app");
    const dir = join(home, ".omp", "agent", "sessions", "-work-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_mine.jsonl"), OMP_HEADER(cwd));
    writeFileSync(join(dir, "2026-01-02T00-00-00-000Z_foreign.jsonl"), OMP_HEADER("/elsewhere/app"));
    utimesSync(join(dir, "2026-01-01T00-00-00-000Z_mine.jsonl"), new Date(1000), new Date(1000));

    const found = await new OmpAdapter().locate(cwd, home);
    expect(found?.id).toBe("mine");
  });

  test("locate skips a corrupt newest transcript and takes the older valid one", async () => {
    const home = fixtureHome();
    const cwd = join(home, "work", "app");
    const dir = join(home, ".omp", "agent", "sessions", "-work-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_ok.jsonl"), OMP_HEADER(cwd));
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
      OMP_HEADER("/private/tmp/beam-live"),
    );

    const found = await new OmpAdapter().locate(cwd, home);
    expect(found?.id).toBe("alias");
  });

  test("locate fallback digs past newer non-matching files in a foreign-named dir", async () => {
    const home = fixtureHome();
    const cwd = "/somewhere/outside/home";
    const dir = join(home, ".omp", "agent", "sessions", "opaque-dir-name");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_x1.jsonl"), OMP_HEADER(cwd));
    writeFileSync(join(dir, "2026-01-02T00-00-00-000Z_other.jsonl"), OMP_HEADER("/other/ws"));
    writeFileSync(join(dir, "2026-01-03T00-00-00-000Z_junk.jsonl"), "corrupt\n");
    utimesSync(join(dir, "2026-01-01T00-00-00-000Z_x1.jsonl"), new Date(1000), new Date(1000));

    const found = await new OmpAdapter().locate(cwd, home);
    expect(found?.id).toBe("x1");
  });

  test("locate honors sessionRef among validated matches", async () => {
    const home = fixtureHome();
    const cwd = join(home, "work", "app");
    const dir = join(home, ".omp", "agent", "sessions", "-work-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_aaa.jsonl"), OMP_HEADER(cwd));
    writeFileSync(join(dir, "2026-01-02T00-00-00-000Z_bbb.jsonl"), OMP_HEADER(cwd));
    utimesSync(join(dir, "2026-01-01T00-00-00-000Z_aaa.jsonl"), new Date(1000), new Date(1000));

    const found = await new OmpAdapter().locate(cwd, home, "aaa");
    expect(found?.id).toBe("aaa");
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

  test("locate never ships a slug-colliding neighbor's transcript", async () => {
    const home = fixtureHome();
    // /private/tmp/a/b and /private/tmp/a-b collapse to the same wrapped-dash slug.
    const dir = join(home, ".pi", "agent", "sessions", "--private-tmp-a-b--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_ours.jsonl"), OMP_HEADER("/private/tmp/a/b"));
    writeFileSync(
      join(dir, "2026-01-02T00-00-00-000Z_neighbor.jsonl"),
      OMP_HEADER("/private/tmp/a-b"),
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

describe("pi-family collect: the transcript comes off the target, never local scratch", () => {
  function ompFixture() {
    const home = fixtureHome();
    const cwd = join(home, "w");
    mkdirSync(cwd, { recursive: true });
    const store = join(home, ".omp", "agent", "sessions", "-w");
    mkdirSync(store, { recursive: true });
    const file = join(store, "2026-01-01T00-00-00-000Z_abc-123.jsonl");
    writeFileSync(file, OMP_HEADER(cwd));
    return { home, cwd, store, file, t: new LocalTransport(home), remoteCwd: join(home, "remote-ws") };
  }

  test("collect fetches the grown remote transcript; pre-existing local scratch never wins", async () => {
    const f = ompFixture();
    // Stale scratch in the local workspace — the old handoff's leftovers.
    mkdirSync(join(f.cwd, ".beam"), { recursive: true });
    writeFileSync(join(f.cwd, ".beam", "session.jsonl"), `{"type":"session","cwd":"/old"}\nSTALE-SCRATCH\n`);
    // The genuine grown transcript lives on the target.
    mkdirSync(join(f.remoteCwd, ".beam"), { recursive: true });
    writeFileSync(
      join(f.remoteCwd, ".beam", "session.jsonl"),
      OMP_HEADER(f.remoteCwd) + `{"type":"message","from":"remote-agent"}\n`,
    );

    const adapter = new OmpAdapter();
    const session = (await adapter.locate(f.cwd, f.home))!;
    await adapter.collect(f.t, session, f.cwd, f.remoteCwd);

    const store = readFileSync(f.file, "utf8");
    expect(store).toContain('"from":"remote-agent"');
    expect(store).not.toContain("STALE-SCRATCH");
    expect(JSON.parse(store.split("\n")[1]!).cwd).toBe(f.cwd); // header restored
    // previous store copy backed up
    expect(readdirSync(f.store).some((n) => n.includes(".bak-"))).toBe(true);
  });

  test("collect refuses a transcript that does not belong to this handoff and leaves the store untouched", async () => {
    const f = ompFixture();
    mkdirSync(join(f.remoteCwd, ".beam"), { recursive: true });
    writeFileSync(join(f.remoteCwd, ".beam", "session.jsonl"), OMP_HEADER("/some/other/handoff"));

    const adapter = new OmpAdapter();
    const session = (await adapter.locate(f.cwd, f.home))!;
    const before = readFileSync(f.file, "utf8");
    await expect(adapter.collect(f.t, session, f.cwd, f.remoteCwd)).rejects.toThrow(/foreign session/);
    expect(readFileSync(f.file, "utf8")).toBe(before);
    expect(readdirSync(f.store).some((n) => n.includes(".bak-"))).toBe(false); // refused before touching it
  });

  test("collect fails loudly when the remote transcript is gone — local scratch is no substitute", async () => {
    const f = ompFixture();
    mkdirSync(join(f.cwd, ".beam"), { recursive: true });
    writeFileSync(join(f.cwd, ".beam", "session.jsonl"), OMP_HEADER(f.remoteCwd));

    const adapter = new OmpAdapter();
    const session = (await adapter.locate(f.cwd, f.home))!;
    await expect(adapter.collect(f.t, session, f.cwd, f.remoteCwd)).rejects.toThrow(/not found/);
  });

  test("install resets the reserved remote area: a reused workspace's stale artifacts cannot be re-imported", async () => {
    const f = ompFixture();
    // Leftovers from a previous handoff on a --no-purge reused workspace.
    mkdirSync(join(f.remoteCwd, ".beam", "session"), { recursive: true });
    writeFileSync(join(f.remoteCwd, ".beam", "session", "stale.txt"), "old artifacts\n");

    const adapter = new OmpAdapter();
    const session = (await adapter.locate(f.cwd, f.home))!;
    await adapter.install(f.t, session, f.remoteCwd);

    expect(existsSync(join(f.remoteCwd, ".beam", "session"))).toBe(false); // stale dir wiped
    const shipped = readFileSync(join(f.remoteCwd, ".beam", "session.jsonl"), "utf8");
    expect(JSON.parse(shipped.split("\n")[1]!).cwd).toBe(f.remoteCwd);
  });

  test("pi install wipes its private session dir wholesale — --continue must see exactly one session", async () => {
    const home = fixtureHome();
    const cwd = join(home, "w");
    mkdirSync(cwd, { recursive: true });
    const store = join(home, ".pi", "agent", "sessions", `-${cwd}-`.replaceAll("/", "-") + "-");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "2026-01-01T00-00-00-000Z_pi9.jsonl"), OMP_HEADER(cwd));
    const t = new LocalTransport(home);
    const remoteCwd = join(home, "remote-ws");
    mkdirSync(join(remoteCwd, ".beam", "pi-sessions", "session"), { recursive: true });
    writeFileSync(join(remoteCwd, ".beam", "pi-sessions", "extra.jsonl"), "{}\n");
    writeFileSync(join(remoteCwd, ".beam", "pi-sessions", "session", "stale.txt"), "old\n");

    const adapter = new PiAdapter();
    const session = (await adapter.locate(cwd, home))!;
    await adapter.install(t, session, remoteCwd);

    expect(readdirSync(join(remoteCwd, ".beam", "pi-sessions"))).toEqual(["session.jsonl"]);
  });
});

describe("pi-family install: `.beam` is never followed as a symlink", () => {
  // A reused (--no-purge) workspace comes back with whatever the remote
  // agent left in `.beam` — including `.beam` itself swapped for a symlink
  // to a tree the agent wants beam to destroy or overwrite on its behalf.
  function symlinkedBeamFixture(tool: "omp" | "pi") {
    const home = fixtureHome();
    const cwd = join(home, "w");
    mkdirSync(cwd, { recursive: true });
    const store = join(
      home,
      tool === "omp" ? join(".omp", "agent", "sessions", "-w") : join(".pi", "agent", "sessions", `-${cwd}-`.replaceAll("/", "-") + "-"),
    );
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "2026-01-01T00-00-00-000Z_s1.jsonl"), OMP_HEADER(cwd));

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
    expect(readFileSync(join(sentinel, "session", "victim.txt"), "utf8")).toBe("victim artifacts\n");
    expect(readFileSync(join(sentinel, "pi-sessions", "victim.jsonl"), "utf8")).toBe("victim pi session\n");
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
