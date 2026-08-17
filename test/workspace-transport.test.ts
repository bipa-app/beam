/**
 * Goal: prove the workspace-mirror contracts — exclude computation, the
 * reserved `.beam`/`.git` protection on both sync directions, survival of
 * reserved session data under hostile excludes, raced create-walk/descent
 * refusals, and the remote-proof entry-count bounds.
 * Method: real rsync and bash processes through LocalTransport against
 * mkdtemp fixtures, executed walk/descent shell programs, and a canned
 * proof-line transport double for the fingerprint parsers.
 */
import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
import type { LocalSession, SessionAdapter } from "../src/session/types.ts";
import { collectSessionReturn } from "../src/session/collect-txn.ts";
import type { BeamEnv } from "../src/env.ts";
import { addRecord, type BeamRecord } from "../src/state.ts";
import { createWalkBlocks, LocalTransport } from "../src/transport/local.ts";
import {
  assertPurgeablePath,
  BEAM_RESERVED_EXCLUDE,
  BEAM_GITPTR_EXCLUDE,
  ensureGitExclude,
  gatherExcludes,
  remoteWorkspaceTreeFingerprint,
  stageWorkspaceReturn,
  GIT_METADATA_EXCLUDE,
  ownedDestinationBlocks,
  remoteWorkspaceName,
} from "../src/workspace.ts";
import { run, shq } from "../src/util/shell.ts";
import type { ExecResult, SyncOptions, Transport } from "../src/transport/types.ts";

const HAVE_RSYNC = Bun.which("rsync") !== null;

// Explicit real-process budget for every process-spawning test below: real
// rsync mirrors/collects through the local transport and bash walk programs
// — the same cost class e2e.test.ts budgets at 30s. Pure in-process
// workspace-helper tests above keep the implicit timeout.
const PROCESS_TIMEOUT_MS = 30_000;

describe("workspace helpers", () => {
  test("remoteWorkspaceName keeps the basename readable but never collides across paths", () => {
    const a = remoteWorkspaceName("/home/x/work/app");
    const b = remoteWorkspaceName("/home/x/other/app");
    expect(a).toStartWith("app-");
    expect(b).toStartWith("app-");
    expect(a).not.toBe(b);
  });

  test(
    "gatherExcludes leads with the reserved root, then config and `.git`, then .beamignore",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "beam-ws-"));
      writeFileSync(join(dir, ".beamignore"), "# build output\ntarget/\n\nnode_modules/\n");
      const excludes = gatherExcludes(dir, { targets: {}, excludes: [".DS_Store"] });
      expect(excludes).toEqual([
        BEAM_RESERVED_EXCLUDE,
        BEAM_GITPTR_EXCLUDE,
        ".DS_Store",
        GIT_METADATA_EXCLUDE,
        "target/",
        "node_modules/",
      ]);
    },
  );

  test("no user pattern can dislodge the case-safe reserved exclude", () => {
    const dir = mkdtempSync(join(tmpdir(), "beam-ws-"));
    writeFileSync(join(dir, ".beamignore"), ".beam/\nsession.jsonl\n");
    const excludes = gatherExcludes(dir, { targets: {}, excludes: ["*", "*.jsonl"] });
    expect(excludes[0]).toBe(BEAM_RESERVED_EXCLUDE);
  });

  test("gatherExcludes appends `.git` for plain, linked, and standard workspaces", () => {
    const plain = mkdtempSync(join(tmpdir(), "beam-ws-"));
    expect(gatherExcludes(plain, { targets: {} })).toEqual([
      BEAM_RESERVED_EXCLUDE,
      BEAM_GITPTR_EXCLUDE,
      GIT_METADATA_EXCLUDE,
    ]);

    const linked = mkdtempSync(join(tmpdir(), "beam-ws-"));
    writeFileSync(join(linked, ".git"), "gitdir: /abs/common/worktrees/x\n");
    expect(gatherExcludes(linked, { targets: {} })).toEqual([
      BEAM_RESERVED_EXCLUDE,
      BEAM_GITPTR_EXCLUDE,
      GIT_METADATA_EXCLUDE,
    ]);

    const standard = mkdtempSync(join(tmpdir(), "beam-ws-"));
    mkdirSync(join(standard, ".git"));
    expect(gatherExcludes(standard, { targets: {}, excludes: [".DS_Store"] })).toEqual([
      BEAM_RESERVED_EXCLUDE,
      BEAM_GITPTR_EXCLUDE,
      ".DS_Store",
      GIT_METADATA_EXCLUDE,
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
    for (const bad of ["/", "/etc", "short", "/a/../..", "no-slashes", "/a//b", "a\nb"]) {
      expect(() => assertPurgeablePath(bad)).toThrow(/refusing to purge/);
    }
    expect(() => assertPurgeablePath("/home/user/beam/app-1234abcd")).not.toThrow();
  });
});

describe.skipIf(!HAVE_RSYNC)(
  "Beam metadata under .beam is protected on both mirror directions",
  () => {
    test(
      "the owner marker and Git payload generation survive an additive re-upload " +
        "and never return on syncDown",
      async () => {
        const home = mkdtempSync(join(tmpdir(), "beam-payload-"));
        const t = new LocalTransport(home);
        const local = join(home, "wt");
        mkdirSync(local);
        writeFileSync(join(local, "code.txt"), "local\n");
        const remote = join(home, "remote-ws");

        // Everything Beam owns on the target lives under the single reserved
        // root: the ownership marker and the shipped Git payload generation
        // (the crash-recovery state a retry must still find byte-for-byte).
        const gen = "ab".repeat(8);
        mkdirSync(join(remote, ".beam", "git", gen), { recursive: true });
        writeFileSync(
          join(remote, ".beam", "owner"),
          "beam-workspace-v1 rec 00000000000000000000000000000000\n",
        );
        writeFileSync(
          join(remote, ".beam", "git", gen, "config"),
          "the only copy of the remote .git\n",
        );
        writeFileSync(join(remote, ".git"), `gitdir: .beam/git/${gen}\n`);

        const excludes = gatherExcludes(local, { targets: {} });
        // The ordinary (additive) workspace upload: nothing under .beam — and
        // not the .git pointer — may be touched.
        await t.syncUp(local, remote, { excludes, checksum: true });
        expect(readFileSync(join(remote, "code.txt"), "utf8")).toBe("local\n");
        expect(readFileSync(join(remote, ".beam", "owner"), "utf8")).toContain("beam-workspace-v1");
        expect(readFileSync(join(remote, ".beam", "git", gen, "config"), "utf8")).toBe(
          "the only copy of the remote .git\n",
        );
        expect(readFileSync(join(remote, ".git"), "utf8")).toBe(`gitdir: .beam/git/${gen}\n`);

        // The way back: no Beam metadata may land in user state — not the
        // reserved root, not the payload, not the pointer.
        writeFileSync(join(remote, "work.txt"), "done remotely\n");
        await t.syncDown(remote, local, { excludes, delete: true });
        expect(readFileSync(join(local, "work.txt"), "utf8")).toBe("done remotely\n");
        expect(existsSync(join(local, ".beam"))).toBe(false);
        expect(existsSync(join(local, ".git"))).toBe(false);
      },
      PROCESS_TIMEOUT_MS,
    );

    test("case-respelled reserved dirs cannot alias onto a case-insensitive host", async () => {
      const home = mkdtempSync(join(tmpdir(), "beam-case-"));
      const t = new LocalTransport(home);
      const local = join(home, "wt");
      mkdirSync(local);
      const remote = join(home, "remote-ws");
      mkdirSync(remote);
      writeFileSync(join(remote, ".BEAM"), "respelling\n");
      writeFileSync(join(remote, ".GIT"), "respelling\n");

      await t.syncDown(remote, local, { excludes: gatherExcludes(local, { targets: {} }) });
      expect(existsSync(join(local, ".BEAM"))).toBe(false);
      expect(existsSync(join(local, ".GIT"))).toBe(false);
    }, PROCESS_TIMEOUT_MS);
  },
);


describe.skipIf(!HAVE_RSYNC)("local transport sync semantics", () => {
  test(
    "syncUp honors excludes and mirrors deletions; syncDown keeps local extras by default",
    async () => {
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
    },
    PROCESS_TIMEOUT_MS,
  );

  test("~ paths resolve against the transport home, and exec sees that HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "beam-tr-"));
    const t = new LocalTransport(home);
    await t.execChecked('mkdir -p "$HOME/nested/dir" && printf here > "$HOME/nested/dir/copy.ts"');
    expect(existsSync(join(home, "nested", "dir", "copy.ts"))).toBe(true);
    expect(await t.exists("~/nested/dir/copy.ts")).toBe(true);
    // Child processes see the home AS CONFIGURED (canonicalization is an
    // internal concern of path pins) — same contract local-transport.test.ts
    // pins byte-exact.
    expect(await t.execChecked("echo $HOME")).toBe(home);
  }, PROCESS_TIMEOUT_MS);

  test(
    "syncDown with gathered excludes can never replace a linked worktree's .git pointer",
    async () => {
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
      await t.syncDown(remote, local, {
        excludes: gatherExcludes(local, { targets: {} }),
        delete: true,
      });
      expect(lstatSync(join(local, ".git")).isFile()).toBe(true);
      expect(readFileSync(join(local, ".git"), "utf8")).toBe(pointer);
      expect(readFileSync(join(local, "work.txt"), "utf8")).toBe("done remotely\n");
    },
    PROCESS_TIMEOUT_MS,
  );

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

    await t.syncDown(remote, local, {
      excludes: gatherExcludes(local, { targets: {} }),
      delete: true,
    });

    expect(existsSync(join(local, ".git"))).toBe(false);
    expect(readFileSync(join(local, "work.txt"), "utf8")).toBe("done remotely\n");
  }, PROCESS_TIMEOUT_MS);

  test(
    "linked-worktree ships exclude nested .git entries too (submodules travel as plain trees)",
    async () => {
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
      expect(readFileSync(join(home, "dest-wt", "vendor", "sub", "code.txt"), "utf8")).toBe(
        "sub content\n",
      );
    },
    PROCESS_TIMEOUT_MS,
  );
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

  interface HostileFixture {
    readonly localHome: string;
    readonly workDir: string;
    readonly storeFile: string;
    readonly transport: LocalTransport;
    readonly remoteCwd: string;
    readonly excludes: string[];
  }

  /** One pattern's fixture: local store + stale `.beam` scratch, empty remote home. */
  function makeFixture(
    pattern: string,
    storeDirOf: (localHome: string, workDir: string) => string,
  ): HostileFixture {
    const localHome = realpathSync(mkdtempSync(join(tmpdir(), "beam-rsv-home-")));
    const remoteHome = realpathSync(mkdtempSync(join(tmpdir(), "beam-rsv-rhome-")));
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
    const staleTranscript =
      `{"type":"session","cwd":"/somewhere/else"}\n` +
      `{"type":"message","text":"STALE-SCRATCH"}\n`;
    mkdirSync(join(workDir, ".beam", "pi-sessions"), { recursive: true });
    writeFileSync(join(workDir, ".beam", "session.jsonl"), staleTranscript);
    writeFileSync(join(workDir, ".beam", "pi-sessions", "session.jsonl"), staleTranscript);

    const transport = new LocalTransport(remoteHome);
    const remoteCwd = join(remoteHome, "beam-root", "ws");
    const excludes = gatherExcludes(workDir, { targets: {}, excludes: [pattern] });
    return { localHome, workDir, storeFile, transport, remoteCwd, excludes };
  }

  /** beam down's collection: the durable return must carry the exact grown state. */
  async function expectDurableReturn(opts: {
    fx: HostileFixture;
    adapter: SessionAdapter;
    session: LocalSession;
    pattern: string;
  }): Promise<void> {
    const { fx, adapter, session, pattern } = opts;
    const env: BeamEnv = { home: fx.localHome, beamDir: join(fx.localHome, ".beam-state") };
    const record: BeamRecord = {
      id: "r1",
      target: "t",
      tool: session.tool,
      sessionId: session.id,
      sessionFile: session.file,
      artifactsDir: session.artifactsDir,
      localCwd: fx.workDir,
      remoteCwd: fx.remoteCwd,
      runtimeSession: "-",
      status: "up",
      createdAt: "t",
      updatedAt: "t",
    };
    addRecord(env, record);
    const before = readFileSync(fx.storeFile, "utf8");
    const out = await collectSessionReturn(env, record, adapter, fx.transport);

    const returned = readFileSync(join(out.returnDir, "session.jsonl"), "utf8");
    expect(JSON.parse(returned.split("\n")[0]!).cwd).toBe(fx.workDir); // header localized
    expect(returned).toContain(`grown ${pattern}`); // the exact grown transcript
    expect(returned).toContain("local work");
    expect(returned).not.toContain("STALE-SCRATCH"); // stale scratch never wins
    // The harness store was never touched.
    expect(readFileSync(fx.storeFile, "utf8")).toBe(before);

    // Remote-created artifacts came back inside the durable return and
    // survive the remote workspace disappearing.
    rmSync(fx.remoteCwd, { recursive: true, force: true }); // the purge
    expect(readFileSync(join(out.returnDir, "artifacts", "blob.txt"), "utf8")).toBe(
      "made remotely\n",
    );
  }

  async function roundTrip(
    makeAdapter: () => SessionAdapter,
    workspaceSession: string,
    storeDirOf: (localHome: string, workDir: string) => string,
  ) {
    for (const pattern of HOSTILE_PATTERNS) {
      const fx = makeFixture(pattern, storeDirOf);
      const { transport: t, workDir, remoteCwd, excludes } = fx;

      await t.syncUp(workDir, remoteCwd, { excludes, delete: true });
      expect(existsSync(join(remoteCwd, ".beam"))).toBe(false); // scratch stayed home

      const adapter = makeAdapter();
      const session = await adapter.locate(workDir, fx.localHome);
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
      await expectDurableReturn({ fx, adapter, session, pattern });
    }
  }

  test(
    "omp: every hostile pattern still returns the exact grown transcript and artifacts",
    async () => {
      await roundTrip(
        () => new OmpAdapter(),
        OMP_WORKSPACE_SESSION,
        (localHome) => join(localHome, ".omp", "agent", "sessions", "-work-app"),
      );
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "pi: every hostile pattern still returns the exact grown transcript and artifacts",
    async () => {
      await roundTrip(
        () => new PiAdapter(),
        PI_WORKSPACE_SESSION,
        (localHome, workDir) =>
          join(localHome, ".pi", "agent", "sessions", `-${workDir}-`.replaceAll("/", "-") + "-"),
      );
    },
    PROCESS_TIMEOUT_MS,
  );
});

describe("local transport held-cwd create walk", () => {
  test(
    "a parent swapped to a symlink mid-walk redirects nothing outside — the reproof refuses",
    async () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-walk-")));
      const outside = join(base, "outside");
      mkdirSync(outside, { recursive: true });
      const target = join(base, "tree", "a", "b");

      // Interleave an adversarial swap between the last two component steps
      // of the create walk — the exact window a raced process would hit.
      const blocks = createWalkBlocks(target);
      const swap = [
        `mv ${shq(join(base, "tree", "a"))} ${shq(join(base, "tree", "a-aside"))}`,
        `ln -s ${shq(outside)} ${shq(join(base, "tree", "a"))}`,
      ].join("\n");
      const script = [...blocks.slice(0, -1), swap, blocks.at(-1)!].join("\n");
      const res = await run(["bash", "-c", script]);

      expect(res.code).not.toBe(0); // physical reproof refused
      expect(readdirSync(outside)).toEqual([]); // zero mutation through the link
      // the relative mkdir landed INSIDE the held (renamed-aside) parent —
      // never through the symlink now sitting at the lexical path
      expect(existsSync(join(base, "tree", "a-aside", "b"))).toBe(true);
      expect(lstatSync(join(base, "tree", "a")).isSymbolicLink()).toBe(true);
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "syncUp refuses to create through a pre-existing symlinked parent — nothing lands outside",
    async () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-walk2-")));
      const outside = join(base, "outside");
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(base, "linked"));
      const src = join(base, "src");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "f.txt"), "x\n");

      const t = new LocalTransport(base);
      await expect(t.syncUp(src, join(base, "linked", "ws"))).rejects.toThrow(
        /symlinked path component|refusing/,
      );
      expect(readdirSync(outside)).toEqual([]); // nothing created through the link
    },
    PROCESS_TIMEOUT_MS,
  );
});

describe("fused owned-destination descent", () => {
  test(
    "a .beam replaced between the owner proof and the descent receives nothing — " +
      "the held-inode descent refuses",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "beam-fused-")));
      const owner = `beam-workspace-v1 rec1 ${"a".repeat(32)}`;
      mkdirSync(join(root, ".beam", "git"), { recursive: true });
      writeFileSync(join(root, ".beam", "owner"), `${owner}\n`);

      // Adversary: replace .beam with a fresh REAL directory right after the
      // owner proof — the exact window the old guard-then-rewalk split left
      // open. blocks: [enter .beam + verify owner, git step, gen1 step].
      const blocks = ownedDestinationBlocks(owner, [".beam", "git", "gen1"], { create: true });
      const swap = [
        `mv ${shq(join(root, ".beam"))} ${shq(join(root, ".beam-aside"))}`,
        `mkdir -p ${shq(join(root, ".beam", "git", "gen1"))}`,
      ].join("\n");
      const script = [
        `cd ${shq(root)} || exit 9`,
        blocks[0]!,
        swap,
        ...blocks.slice(1),
        `printf '%s' payload > f.bin`,
      ].join("\n");
      const res = await run(["bash", "-c", script]);

      expect(res.code).not.toBe(0); // the physical-prefix reproof refused
      // the replacement never received a byte…
      expect(readdirSync(join(root, ".beam", "git", "gen1"))).toEqual([]);
      // …and no payload landed in the held original (aside) tree either
      expect(existsSync(join(root, ".beam-aside", "git", "gen1", "f.bin"))).toBe(false);
      expect(existsSync(join(root, ".beam-aside", "git", "f.bin"))).toBe(false);
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "the un-raced descent verifies the owner once and ends holding the created destination",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "beam-fused2-")));
      const owner = `beam-workspace-v1 rec1 ${"b".repeat(32)}`;
      mkdirSync(join(root, ".beam"), { recursive: true });
      writeFileSync(join(root, ".beam", "owner"), `${owner}\n`);

      const script = [
        `cd ${shq(root)} || exit 9`,
        ...ownedDestinationBlocks(owner, [".beam", "git", "gen1"], { create: true }),
        `printf '%s' payload > f.bin`,
        `pwd -P`,
      ].join("\n");
      const res = await run(["bash", "-c", script]);
      expect(res.code).toBe(0);
      expect(res.stdout.trim()).toBe(join(root, ".beam", "git", "gen1"));
      expect(readFileSync(join(root, ".beam", "git", "gen1", "f.bin"), "utf8")).toBe("payload");

      // a foreign owner refuses before any descent
      const foreign = await run([
        "bash",
        "-c",
        [
          `cd ${shq(root)} || exit 9`,
          ...ownedDestinationBlocks(
            `beam-workspace-v1 other ${"c".repeat(32)}`,
            [".beam", "git", "gen2"],
            { create: true },
          ),
        ].join("\n"),
      ]);
      expect(foreign.code).toBe(52);
      expect(existsSync(join(root, ".beam", "git", "gen2"))).toBe(false);
    },
    PROCESS_TIMEOUT_MS,
  );
});

describe("workspace return staging", () => {
  test(
    "the collect is strictly additive — no mirrored deletion, no live-root license demand",
    async () => {
      // The ship publishes from a reserved stage and never earns a
      // live-root mirror license; a delete-licensed collect would demand
      // exactly that marker and refuse on marker transports. The stage is
      // fresh, so additive + the fingerprint sandwich is the whole proof.
      const home = realpathSync(mkdtempSync(join(tmpdir(), "beam-collect-")));
      const remote = join(home, "ws");
      mkdirSync(remote, { recursive: true });
      writeFileSync(join(remote, "work.txt"), "remote work\n");
      const stageDir = join(home, "stage");
      mkdirSync(stageDir);
      const seen: Array<{ delete?: boolean; checksum?: boolean }> = [];
      const t = new LocalTransport(home);
      const spy: typeof t.syncDown = async (remoteDir, localDir, opts = {}) => {
        seen.push({ delete: opts.delete, checksum: opts.checksum });
        return LocalTransport.prototype.syncDown.call(t, remoteDir, localDir, opts);
      };
      t.syncDown = spy;
      const staged = await stageWorkspaceReturn(t, remote, stageDir, {
        excludes: [],
        verbose: false,
      });
      expect(seen).toEqual([{ delete: false, checksum: true }]);
      expect(readFileSync(join(stageDir, "work.txt"), "utf8")).toBe("remote work\n");
      expect(staged.fingerprint.entries).toBeGreaterThan(0);
    },
    PROCESS_TIMEOUT_MS,
  );
});

/**
 * Proof-line transport double: the remote fingerprint parsers consume one
 * execChecked() result, and counts past Number.MAX_SAFE_INTEGER cannot be
 * produced by a real hermetic tree — only a canned wire line reaches them.
 */
class CannedProofTransport implements Transport {
  readonly label = "canned-proof";
  constructor(private readonly proofLine: string) {}
  async exec(_command: string): Promise<ExecResult> {
    throw new Error("not used by the fingerprint parsers");
  }
  async execChecked(_command: string): Promise<string> {
    return this.proofLine;
  }
  async syncUp(_l: string, _r: string, _o?: SyncOptions): Promise<void> {}
  async syncDown(_r: string, _l: string, _o?: SyncOptions): Promise<void> {}
  async exists(): Promise<boolean> {
    return false;
  }
  interactiveArgv(command: string): string[] {
    return ["true", command];
  }
}

describe("remote workspace proof entry-count bounds", () => {
  const DIGEST = "a".repeat(64);
  const proof = (count: string) =>
    remoteWorkspaceTreeFingerprint(
      new CannedProofTransport(`__beam_ws_fp_v1__ ${DIGEST} ${count}`),
      "/ws",
    );

  test("the largest exact integer count is accepted; the first inexact one refuses", async () => {
    // 2^53-1 — max valid: every count up to here round-trips exactly.
    const ok = await proof("9007199254740991");
    expect(ok).toEqual({ digest: DIGEST, entries: Number.MAX_SAFE_INTEGER });
    // 2^53 — the first digit run Number() silently rounds; a rounded
    // count could mask a mismatched tree, so the proof refuses.
    await expect(proof("9007199254740992")).rejects.toThrow(/produced no result/);
    // Grossly oversized digit runs refuse the same way.
    await expect(proof("99999999999999999999999")).rejects.toThrow(/produced no result/);
  });

  test("negative and non-numeric counts never match the proof format", async () => {
    await expect(proof("-1")).rejects.toThrow(/produced no result/);
    await expect(proof("1e3")).rejects.toThrow(/produced no result/);
  });
});
