import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OMP_WORKSPACE_SESSION,
  OmpAdapter,
  PI_WORKSPACE_SESSION,
  PiAdapter,
} from "../src/session/pi-family.ts";
import type { SessionAdapter } from "../src/session/types.ts";
import { LocalTransport } from "../src/transport/local.ts";
import { assertPurgeablePath, ensureGitExclude, gatherExcludes, remoteWorkspaceName } from "../src/workspace.ts";

const HAVE_RSYNC = Bun.which("rsync") !== null;

describe("workspace helpers", () => {
  test("remoteWorkspaceName keeps the basename readable but never collides across paths", () => {
    const a = remoteWorkspaceName("/home/x/work/app");
    const b = remoteWorkspaceName("/home/x/other/app");
    expect(a).toStartWith("app-");
    expect(b).toStartWith("app-");
    expect(a).not.toBe(b);
  });

  test("gatherExcludes leads with reserved metadata, then config and `.git`, then .beamignore", () => {
    const dir = mkdtempSync(join(tmpdir(), "beam-ws-"));
    writeFileSync(join(dir, ".beamignore"), "# build output\ntarget/\n\nnode_modules/\n");
    const excludes = gatherExcludes(dir, { targets: {}, excludes: [".DS_Store"] });
    expect(excludes).toEqual(["/.beam", ".DS_Store", ".git", "target/", "node_modules/"]);
  });

  test("no user pattern can dislodge the reserved exclude — hostile config/.beamignore still lead with /.beam", () => {
    const dir = mkdtempSync(join(tmpdir(), "beam-ws-"));
    writeFileSync(join(dir, ".beamignore"), ".beam/\nsession.jsonl\n");
    const excludes = gatherExcludes(dir, { targets: {}, excludes: ["*", "*.jsonl"] });
    expect(excludes[0]).toBe("/.beam");
  });

  test("gatherExcludes appends `.git` for plain, linked, and standard workspaces", () => {
    const plain = mkdtempSync(join(tmpdir(), "beam-ws-"));
    expect(gatherExcludes(plain, { targets: {} })).toEqual(["/.beam", ".git"]);

    const linked = mkdtempSync(join(tmpdir(), "beam-ws-"));
    writeFileSync(join(linked, ".git"), "gitdir: /abs/common/worktrees/x\n");
    expect(gatherExcludes(linked, { targets: {} })).toEqual(["/.beam", ".git"]);

    const standard = mkdtempSync(join(tmpdir(), "beam-ws-"));
    mkdirSync(join(standard, ".git"));
    expect(gatherExcludes(standard, { targets: {}, excludes: [".DS_Store"] })).toEqual([
      "/.beam",
      ".DS_Store",
      ".git",
    ]);
  });

  test("ensureGitExclude appends .beam/ once and only inside git repos", () => {
    const plain = mkdtempSync(join(tmpdir(), "beam-ws-"));
    ensureGitExclude(plain); // no .git — must not create one
    expect(existsSync(join(plain, ".git"))).toBe(false);

    const repo = mkdtempSync(join(tmpdir(), "beam-ws-"));
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    ensureGitExclude(repo);
    ensureGitExclude(repo);
    const content = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(content.split("\n").filter((l) => l === ".beam/").length).toBe(1);
  });

  test("assertPurgeablePath refuses paths an rm -rf must never see", () => {
    const bads = [
      "/",
      "/etc",
      "short",
      "/a/../..",
      "no-slashes",
      "relative/deep/enough/path", // not absolute
      "/single-segment-abcdef", // no workspace root above it
      "/data/bipa/ws/", // not normalized: trailing slash
      "/data//bipa/ws", // not normalized: empty segment
      "/data/bipa/./ws", // not normalized: dot segment
      "/data/bipa/ws\n/etc", // not a single line
    ];
    for (const bad of bads) {
      expect(() => assertPurgeablePath(bad)).toThrow(/refusing to purge/);
    }
    expect(() => assertPurgeablePath("/home/user/beam/app-1234abcd")).not.toThrow();
    expect(() => assertPurgeablePath("/data/bipa/main-0123456789")).not.toThrow();
  });
});

describe.skipIf(!HAVE_RSYNC)("local transport sync semantics", () => {
  test("syncUp honors excludes and mirrors deletions; syncDown keeps local extras by default", async () => {
    const home = mkdtempSync(join(tmpdir(), "beam-tr-"));
    const t = new LocalTransport(home);
    const local = join(home, "src-dir");
    const remote = "~/dest-dir";
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "keep.txt"), "keep");
    writeFileSync(join(local, "secret.env"), "nope");

    await t.syncUp(local, remote, { excludes: ["secret.env"] });
    expect(existsSync(join(home, "dest-dir", "keep.txt"))).toBe(true);
    expect(existsSync(join(home, "dest-dir", "secret.env"))).toBe(false);

    // a file that disappears locally disappears remotely on the next mirrored ship
    writeFileSync(join(home, "dest-dir", "stale.txt"), "old");
    await t.syncUp(local, remote, { delete: true });
    expect(existsSync(join(home, "dest-dir", "stale.txt"))).toBe(false);

    // syncDown without delete must never remove local-only files
    writeFileSync(join(local, "local-only.txt"), "mine");
    writeFileSync(join(home, "dest-dir", "made-remotely.txt"), "theirs");
    await t.syncDown(remote, local, {});
    expect(readFileSync(join(local, "made-remotely.txt"), "utf8")).toBe("theirs");
    expect(existsSync(join(local, "local-only.txt"))).toBe(true);
  });

  test("~ paths resolve against the transport home, and exec sees that HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "beam-tr-"));
    const t = new LocalTransport(home);
    await t.sendFile(Bun.fileURLToPath(import.meta.url), "~/nested/dir/copy.ts");
    expect(existsSync(join(home, "nested", "dir", "copy.ts"))).toBe(true);
    expect(await t.exists("~/nested/dir/copy.ts")).toBe(true);
    expect(await t.execChecked("echo $HOME")).toBe(home);
  });

  test("syncDown with gathered excludes can never replace a linked worktree's .git pointer", async () => {
    const home = mkdtempSync(join(tmpdir(), "beam-tr-"));
    const t = new LocalTransport(home);
    const local = join(home, "wt");
    mkdirSync(local);
    const pointer = "gitdir: /abs/common/worktrees/wt\n";
    writeFileSync(join(local, ".git"), pointer);
    const remote = join(home, "remote-ws");
    mkdirSync(join(remote, ".git"), { recursive: true });
    writeFileSync(join(remote, ".git", "config"), "[core]\n");
    writeFileSync(join(remote, "work.txt"), "done remotely\n");

    // Even a mirrored sync back (--delete) must leave the pointer file alone.
    await t.syncDown(remote, local, { excludes: gatherExcludes(local, { targets: {} }), delete: true });
    expect(lstatSync(join(local, ".git")).isFile()).toBe(true);
    expect(readFileSync(join(local, ".git"), "utf8")).toBe(pointer);
    expect(readFileSync(join(local, "work.txt"), "utf8")).toBe("done remotely\n");
  });

  test("syncDown never imports a `.git` the sandbox created in a plain workspace", async () => {
    const home = mkdtempSync(join(tmpdir(), "beam-tr-"));
    const t = new LocalTransport(home);
    const local = join(home, "plain");
    const remote = join(home, "remote-plain");
    mkdirSync(local);
    mkdirSync(join(remote, ".git", "hooks"), { recursive: true });
    writeFileSync(join(remote, ".git", "config"), "[core]\nfsmonitor = hostile\n");
    writeFileSync(join(remote, ".git", "hooks", "post-checkout"), "#!/bin/sh\nexit 99\n");
    writeFileSync(join(remote, "work.txt"), "done remotely\n");

    await t.syncDown(remote, local, { excludes: gatherExcludes(local, { targets: {} }), delete: true });

    expect(existsSync(join(local, ".git"))).toBe(false);
    expect(readFileSync(join(local, "work.txt"), "utf8")).toBe("done remotely\n");
  });

  test("linked-worktree ships exclude nested .git entries too (submodules travel as plain trees)", async () => {
    const home = mkdtempSync(join(tmpdir(), "beam-tr-"));
    const t = new LocalTransport(home);
    const local = join(home, "wt");
    mkdirSync(join(local, "vendor", "sub"), { recursive: true });
    writeFileSync(join(local, ".git"), "gitdir: /abs/common/worktrees/wt\n");
    writeFileSync(join(local, "vendor", "sub", ".git"), "gitdir: ../../.git/modules/sub\n");
    writeFileSync(join(local, "vendor", "sub", "code.txt"), "sub content\n");

    await t.syncUp(local, "~/dest-wt", { excludes: gatherExcludes(local, { targets: {} }) });
    expect(existsSync(join(home, "dest-wt", ".git"))).toBe(false);
    expect(existsSync(join(home, "dest-wt", "vendor", "sub", ".git"))).toBe(false);
    expect(readFileSync(join(home, "dest-wt", "vendor", "sub", "code.txt"), "utf8")).toBe("sub content\n");
  });
});

/**
 * Beam-reserved session data must be immune to user/global excludes: the
 * transcript and artifacts travel over explicit per-path transfers, never
 * the filtered workspace mirror. Each hostile pattern below would suppress
 * `.beam` content on a plain rsync mirror — the round trip must still
 * return the exact grown transcript and the remote-created artifacts, and
 * pre-existing local `.beam` scratch must never be read as returned state.
 */
describe.skipIf(!HAVE_RSYNC)("reserved session data survives hostile excludes", () => {
  const HOSTILE_PATTERNS = [".beam/", "session.jsonl", "pi-sessions", "*.jsonl", "*"];

  async function roundTrip(
    makeAdapter: () => SessionAdapter,
    workspaceSession: string,
    storeDirOf: (localHome: string, workDir: string) => string,
  ) {
    for (const pattern of HOSTILE_PATTERNS) {
      const localHome = mkdtempSync(join(tmpdir(), "beam-rsv-home-"));
      const remoteHome = mkdtempSync(join(tmpdir(), "beam-rsv-rhome-"));
      const workDir = join(localHome, "work", "app");
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "code.txt"), "code\n");

      const storeDir = storeDirOf(localHome, workDir);
      mkdirSync(storeDir, { recursive: true });
      const storeFile = join(storeDir, "2026-01-01T00-00-00-000Z_sess-1.jsonl");
      writeFileSync(
        storeFile,
        `{"type":"session","version":3,"id":"sess-1","timestamp":"t","cwd":"${workDir}"}\n` +
          `{"type":"message","id":"m1","text":"local work"}\n`,
      );

      // Stale scratch from an earlier handoff (both family layouts): must
      // neither ship out nor be imported as returned state.
      const staleTranscript = `{"type":"session","cwd":"/somewhere/else"}\n{"type":"message","text":"STALE-SCRATCH"}\n`;
      mkdirSync(join(workDir, ".beam", "pi-sessions"), { recursive: true });
      writeFileSync(join(workDir, ".beam", "session.jsonl"), staleTranscript);
      writeFileSync(join(workDir, ".beam", "pi-sessions", "session.jsonl"), staleTranscript);

      const t = new LocalTransport(remoteHome);
      const remoteCwd = join(remoteHome, "beam-root", "ws");
      const excludes = gatherExcludes(workDir, { targets: {}, excludes: [pattern] });
      await t.syncUp(workDir, remoteCwd, { excludes, delete: true });
      expect(existsSync(join(remoteCwd, ".beam"))).toBe(false); // scratch stayed home

      const adapter = makeAdapter();
      const session = await adapter.locate(workDir, localHome);
      if (!session) throw new Error("fixture session not located");
      expect(session.artifactsDir).toBeUndefined(); // none existed at locate time
      await adapter.install(t, session, remoteCwd);

      // The remote agent grows the transcript and CREATES an artifacts dir.
      appendFileSync(
        join(remoteCwd, workspaceSession),
        `{"type":"message","from":"remote-agent","text":"grown ${pattern}"}\n`,
      );
      const remoteArtifacts = join(remoteCwd, workspaceSession.slice(0, -".jsonl".length));
      mkdirSync(remoteArtifacts, { recursive: true });
      writeFileSync(join(remoteArtifacts, "blob.txt"), "made remotely\n");

      // beam down: filtered mirror back, then explicit collection.
      await t.syncDown(remoteCwd, workDir, { excludes });
      await adapter.collect(t, session, workDir, remoteCwd);

      const store = readFileSync(storeFile, "utf8");
      expect(JSON.parse(store.split("\n")[0]!).cwd).toBe(workDir); // header restored
      expect(store).toContain(`grown ${pattern}`); // the exact grown transcript
      expect(store).toContain("local work");
      expect(store).not.toContain("STALE-SCRATCH"); // stale scratch never wins

      // Remote-created artifacts were imported next to the store file and
      // stay resolvable after the remote purge.
      const localArtifacts = join(storeDir, "2026-01-01T00-00-00-000Z_sess-1");
      expect(readFileSync(join(localArtifacts, "blob.txt"), "utf8")).toBe("made remotely\n");
      rmSync(remoteCwd, { recursive: true, force: true }); // the purge
      const relocated = (await adapter.locate(workDir, localHome))!;
      expect(relocated.artifactsDir).toBe(localArtifacts);
    }
  }

  test("omp: every hostile pattern still returns the exact grown transcript and artifacts", async () => {
    await roundTrip(
      () => new OmpAdapter(),
      OMP_WORKSPACE_SESSION,
      (localHome) => join(localHome, ".omp", "agent", "sessions", "-work-app"),
    );
  });

  test("pi: every hostile pattern still returns the exact grown transcript and artifacts", async () => {
    await roundTrip(
      () => new PiAdapter(),
      PI_WORKSPACE_SESSION,
      (localHome, workDir) =>
        join(localHome, ".pi", "agent", "sessions", `-${workDir}-`.replaceAll("/", "-") + "-"),
    );
  });
});
