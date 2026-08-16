import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cmdUp } from "../src/commands/up.ts";
import { cmdDown } from "../src/commands/down.ts";
import { resolveEnv } from "../src/env.ts";
import { loadState } from "../src/state.ts";
import { LocalTransport } from "../src/transport/local.ts";
import { run, runChecked, shq } from "../src/util/shell.ts";
import {
  backupRefBase,
  importWorktreeGitReturn,
  installedOpStateFile,
  isLinkedWorktree,
  isGitWorktree,
  materializeWorktreeGit,
  prepareWorktreeGitReturn,
  type WtGitShipInfo,
} from "../src/workspace-git.ts";
import { gatherExcludes, remoteWorkspaceName } from "../src/workspace.ts";

const HAVE_DEPS = Bun.which("git") !== null && Bun.which("rsync") !== null;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

async function git(cwd: string, ...args: string[]) {
  return runChecked(["git", "-C", cwd, ...args], { env: GIT_ENV });
}

/** Temp dirs the materializer creates — must never outlive a call. */
function materializerTemps(): string[] {
  return readdirSync(tmpdir())
    .filter((n) => n.startsWith("beam-wtgit-"))
    .sort();
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}

interface Fixture {
  base: string;
  wtA: string;
  wtB: string;
  c1: string;
  c2: string;
}

/**
 * Bare-common layout with two linked worktrees:
 *   common.git  (bare shared Git dir; sibling checkouts under worktrees/)
 *   wtA         linked, on `main`, with staged+unstaged+untracked state
 *               (including a staged-only blob and a staged binary file)
 *   wtB         linked, detached at c1, with a file wtA must never receive
 */
async function makeFixture(): Promise<Fixture> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtfix-")));
  const seed = join(base, "seed");
  mkdirSync(seed);
  await git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "tracked.txt"), "v1\n");
  writeFileSync(join(seed, "del.txt"), "delete me\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-q", "-m", "c1");
  const c1 = (await git(seed, "rev-parse", "HEAD")).stdout.trim();
  writeFileSync(join(seed, "second.txt"), "v2\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-q", "-m", "c2");
  const c2 = (await git(seed, "rev-parse", "HEAD")).stdout.trim();

  const commonGit = join(base, "common.git");
  await runChecked(["git", "clone", "-q", "--bare", seed, commonGit], { env: GIT_ENV });
  rmSync(seed, { recursive: true, force: true });

  // Config that must TRAVEL: remotes, branches, identity, custom keys —
  // including a multi-line value (NUL-safe parse) and a multi-valued key.
  await git(commonGit, "remote", "set-url", "origin", "https://example.invalid/beam.git");
  await git(commonGit, "update-ref", "refs/remotes/origin/main", c2);
  await git(commonGit, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  await git(commonGit, "branch", "feature", c1);
  await git(commonGit, "tag", "t1", c2);
  await git(commonGit, "config", "user.name", "Repo User");
  await git(commonGit, "config", "branch.main.remote", "origin");
  await git(commonGit, "config", "branch.main.merge", "refs/heads/main");
  await git(commonGit, "config", "beam.note", "line one\nline two");
  await git(commonGit, "config", "--add", "beam.multi", "first");
  await git(commonGit, "config", "--add", "beam.multi", "second");
  // Config that must STAY HOME: machine-layout keys carrying local paths.
  await git(commonGit, "config", "core.hooksPath", join(base, "hooks"));
  await git(commonGit, "config", "safe.directory", base);

  const wtA = join(base, "wtA");
  const wtB = join(base, "wtB");
  await git(commonGit, "worktree", "add", "-q", wtA, "main");
  await git(commonGit, "worktree", "add", "-q", "--detach", wtB, c1);

  // wtA dirty state: staged+unstaged on one file, a staged-only blob (the
  // staged content exists nowhere but the index), a staged deletion, a
  // staged binary file, and an untracked file.
  writeFileSync(join(wtA, "tracked.txt"), "v1\nstaged change\n");
  await git(wtA, "add", "tracked.txt");
  writeFileSync(join(wtA, "tracked.txt"), "v1\nstaged change\nunstaged tail\n");
  writeFileSync(join(wtA, "staged-only.txt"), "staged blob v1\n");
  await git(wtA, "add", "staged-only.txt");
  writeFileSync(join(wtA, "staged-only.txt"), "working v2\n");
  await git(wtA, "rm", "-q", "del.txt");
  writeFileSync(join(wtA, "bin.dat"), Buffer.from([0, 1, 2, 255, 0, 7]));
  await git(wtA, "add", "bin.dat");
  writeFileSync(join(wtA, "untracked.txt"), "not added\n");

  // Sibling-only content: must never travel with wtA's handoff.
  writeFileSync(join(wtB, "sibling-only.txt"), "private to wtB\n");

  return { base, wtA, wtB, c1, c2 };
}

describe("Git worktree detection", () => {
  test("linked and standard layouts are Git worktrees; only pointer files are linked", () => {
    const linked = mkdtempSync(join(tmpdir(), "beam-wt-"));
    writeFileSync(join(linked, ".git"), "gitdir: /somewhere/common/worktrees/x\n");
    expect(isLinkedWorktree(linked)).toBe(true);
    expect(isGitWorktree(linked)).toBe(true);

    const standard = mkdtempSync(join(tmpdir(), "beam-wt-"));
    mkdirSync(join(standard, ".git"));
    expect(isLinkedWorktree(standard)).toBe(false);
    expect(isGitWorktree(standard)).toBe(true);

    const plain = mkdtempSync(join(tmpdir(), "beam-wt-"));
    expect(isLinkedWorktree(plain)).toBe(false);
    expect(isGitWorktree(plain)).toBe(false);
  });
});

describe.skipIf(!HAVE_DEPS)("materializeWorktreeGit", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await makeFixture();
  }, 30_000);

  test(
    "normal files + materialized .git + patch reassemble into an identical standalone repo",
    async () => {
      const sourceStatus = (await git(f.wtA, "status", "--porcelain=v1")).stdout;
      expect(sourceStatus).not.toBe(""); // the fixture is genuinely dirty

      const m = await materializeWorktreeGit(f.wtA);
      try {
        // Shipped Git metadata carries no trace of this machine's layout:
        // no sibling checkouts, no reflogs, no fetch state, no local paths.
        expect(existsSync(join(m.gitDir, "worktrees"))).toBe(false);
        expect(existsSync(join(m.gitDir, "logs"))).toBe(false);
        expect(existsSync(join(m.gitDir, "FETCH_HEAD"))).toBe(false);
        for (const file of walk(m.gitDir)) {
          expect(readFileSync(file).toString("utf8")).not.toContain(f.base);
        }

        // Reassemble a simulated remote exactly like cmdUp does: workspace
        // mirror without .git, then the standalone .git, then the patch.
        const rhome = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtsim-")));
        const t = new LocalTransport(rhome);
        const remote = join(rhome, "ws");
        await t.syncUp(f.wtA, remote, { excludes: gatherExcludes(f.wtA, { targets: {} }), delete: true });
        expect(existsSync(join(remote, ".git"))).toBe(false); // pointer stayed home
        await t.syncUp(m.gitDir, `${remote}/.git`, { delete: true });
        expect(m.indexPatch).toBeDefined();
        await t.sendFile(m.indexPatch!, `${remote}/.beam/staged-index.patch`);
        await t.execChecked(`cd ${shq(remote)} && git apply --cached --binary .beam/staged-index.patch`);
        await t.exec(`rm -f ${shq(join(remote, ".beam", "staged-index.patch"))}`);

        // Same HEAD, same attached branch, byte-identical status.
        expect((await git(remote, "rev-parse", "HEAD")).stdout.trim()).toBe(f.c2);
        expect((await git(remote, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
        expect((await git(remote, "status", "--porcelain=v1")).stdout).toBe(sourceStatus);

        // The staged-only blob and the staged binary survived byte-for-byte.
        expect((await git(remote, "show", ":staged-only.txt")).stdout).toBe("staged blob v1\n");
        expect((await git(remote, "rev-parse", ":bin.dat")).stdout).toBe(
          (await git(f.wtA, "rev-parse", ":bin.dat")).stdout,
        );

        // Every shared ref mirrored; origin/HEAD stayed symbolic.
        expect((await git(remote, "rev-parse", "refs/heads/feature")).stdout.trim()).toBe(f.c1);
        expect((await git(remote, "rev-parse", "refs/tags/t1")).stdout.trim()).toBe(f.c2);
        expect((await git(remote, "rev-parse", "refs/remotes/origin/main")).stdout.trim()).toBe(f.c2);
        expect((await git(remote, "symbolic-ref", "refs/remotes/origin/HEAD")).stdout.trim()).toBe(
          "refs/remotes/origin/main",
        );

        // Remotes/branch/user/custom config traveled — including the
        // multi-line and multi-valued entries — and no clone-path origin
        // remains; machine-layout keys stayed home.
        expect((await git(remote, "config", "remote.origin.url")).stdout.trim()).toBe(
          "https://example.invalid/beam.git",
        );
        expect((await git(remote, "config", "user.name")).stdout.trim()).toBe("Repo User");
        expect((await git(remote, "config", "branch.main.merge")).stdout.trim()).toBe("refs/heads/main");
        expect((await git(remote, "config", "beam.note")).stdout).toBe("line one\nline two\n");
        expect((await git(remote, "config", "--get-all", "beam.multi")).stdout).toBe("first\nsecond\n");
        expect((await run(["git", "-C", remote, "config", "core.hooksPath"])).code).not.toBe(0);
        expect((await run(["git", "-C", remote, "config", "safe.directory"])).code).not.toBe(0);

        // Sibling checkout content never traveled.
        expect(existsSync(join(remote, "sibling-only.txt"))).toBe(false);

        // .beam/ is invisible to remote git status.
        expect(readFileSync(join(remote, ".git", "info", "exclude"), "utf8")).toContain(".beam/");
        mkdirSync(join(remote, ".beam"), { recursive: true });
        writeFileSync(join(remote, ".beam", "session.jsonl"), "{}\n");
        expect((await git(remote, "status", "--porcelain=v1")).stdout).toBe(sourceStatus);
      } finally {
        m.cleanup();
      }
      expect(existsSync(m.gitDir)).toBe(false);
    },
    30_000,
  );

  test(
    "detached HEAD travels as a detached SHA, not an invented branch",
    async () => {
      const m = await materializeWorktreeGit(f.wtB);
      try {
        expect(m.indexPatch).toBeUndefined(); // wtB index == HEAD

        const rhome = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtsim-")));
        const t = new LocalTransport(rhome);
        const remote = join(rhome, "ws");
        await t.syncUp(f.wtB, remote, { excludes: gatherExcludes(f.wtB, { targets: {} }), delete: true });
        await t.syncUp(m.gitDir, `${remote}/.git`, { delete: true });

        expect((await git(remote, "rev-parse", "HEAD")).stdout.trim()).toBe(f.c1);
        expect((await run(["git", "-C", remote, "symbolic-ref", "-q", "HEAD"])).code).not.toBe(0);
        expect((await git(remote, "status", "--porcelain=v1")).stdout).toBe(
          (await git(f.wtB, "status", "--porcelain=v1")).stdout,
        );
      } finally {
        m.cleanup();
      }
    },
    30_000,
  );

  test("a broken worktree pointer fails fatally and removes all temp state", async () => {
    const before = materializerTemps();
    const bad = mkdtempSync(join(tmpdir(), "beam-wtbad-"));
    writeFileSync(join(bad, ".git"), "gitdir: /nonexistent/common/worktrees/gone\n");
    expect(isLinkedWorktree(bad)).toBe(true);
    await expect(materializeWorktreeGit(bad)).rejects.toThrow();
    expect(materializerTemps()).toEqual(before);
  });

  test(
    "a common dir borrowing objects through alternates ships self-contained — no alternates file, no donor path, staged status and history survive donor removal",
    async () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtalt-")));
      const donor = join(base, "donor");
      mkdirSync(donor);
      await git(donor, "init", "-q", "-b", "main");
      writeFileSync(join(donor, "tracked.txt"), "v1\n");
      await git(donor, "add", "-A");
      await git(donor, "commit", "-q", "-m", "c1");
      const c1 = (await git(donor, "rev-parse", "HEAD")).stdout.trim();

      // `--shared` clone: the common dir owns (almost) no objects — history
      // is borrowed through objects/info/alternates, an absolute donor path.
      const commonGit = join(base, "common.git");
      await runChecked(["git", "clone", "-q", "--bare", "--shared", donor, commonGit], { env: GIT_ENV });
      expect(readFileSync(join(commonGit, "objects", "info", "alternates"), "utf8")).toContain(donor);

      const wt = join(base, "wt");
      await git(commonGit, "worktree", "add", "-q", wt, "main");
      writeFileSync(join(wt, "tracked.txt"), "v1\nstaged\n");
      await git(wt, "add", "tracked.txt");
      const sourceStatus = (await git(wt, "status", "--porcelain=v1")).stdout;
      expect(sourceStatus).not.toBe("");

      const m = await materializeWorktreeGit(wt);
      try {
        // The borrowing was absorbed (`clone --dissociate`): the staged
        // payload carries its full object closure and no local path.
        expect(existsSync(join(m.gitDir, "objects", "info", "alternates"))).toBe(false);
        for (const file of walk(m.gitDir)) {
          expect(readFileSync(file).toString("utf8")).not.toContain(donor);
        }

        // Remove the donor: the payload must not be leaning on it.
        rmSync(donor, { recursive: true, force: true });

        const rhome = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtsim-")));
        const t = new LocalTransport(rhome);
        const remote = join(rhome, "ws");
        await t.syncUp(wt, remote, { excludes: gatherExcludes(wt, { targets: {} }), delete: true });
        await t.syncUp(m.gitDir, `${remote}/.git`, { delete: true });
        expect(m.indexPatch).toBeDefined();
        await t.sendFile(m.indexPatch!, `${remote}/.beam/staged-index.patch`);
        await t.execChecked(`cd ${shq(remote)} && git apply --cached --binary .beam/staged-index.patch`);

        // Staged status and history both work with the donor gone.
        expect((await git(remote, "rev-parse", "HEAD")).stdout.trim()).toBe(c1);
        expect((await git(remote, "status", "--porcelain=v1")).stdout).toBe(sourceStatus);
        expect((await git(remote, "log", "--oneline")).stdout).toContain("c1");
        await git(remote, "fsck", "--full"); // complete closure — nothing borrowed
      } finally {
        m.cleanup();
      }
    },
    30_000,
  );

  test(
    "path-bearing config forms stay home; network forms travel; the shipped ref snapshot rides the payload",
    async () => {
      const f2 = await makeFixture();
      const commonGit = join(f2.base, "common.git");
      // Local file URLs and path-valued keys in every leak form.
      await git(commonGit, "config", "submodule.libs.url", "/abs/path/libs");
      await git(commonGit, "config", "submodule.net.url", "https://example.invalid/libs.git");
      await git(commonGit, "config", "url./Users/mirror/.insteadOf", "https://github.com/");
      await git(commonGit, "config", "url.https://mirror.example/.insteadOf", "/Users/base");
      await git(commonGit, "config", "url.https://a.example/.insteadOf", "https://b.example/");
      await git(commonGit, "config", "remote.rel.url", "sub/repo");
      await git(commonGit, "config", "remote.homey.url", "~/repos/x");
      await git(commonGit, "config", "remote.scp.url", "gh.example.invalid:me/repo.git");

      const m = await materializeWorktreeGit(f2.wtA);
      try {
        const cfg = async (key: string) => run(["git", "--git-dir", m.gitDir, "config", "--get-all", key]);
        expect((await cfg("submodule.libs.url")).code).not.toBe(0);
        expect((await cfg("submodule.net.url")).stdout.trim()).toBe("https://example.invalid/libs.git");
        expect((await cfg("url./Users/mirror/.insteadOf")).code).not.toBe(0);
        expect((await cfg("url.https://mirror.example/.insteadOf")).code).not.toBe(0);
        expect((await cfg("url.https://a.example/.insteadOf")).stdout.trim()).toBe("https://b.example/");
        // Bare-relative and home-relative remotes are local paths; scp-like
        // host:path is network and travels.
        expect((await cfg("remote.rel.url")).code).not.toBe(0);
        expect((await cfg("remote.homey.url")).code).not.toBe(0);
        expect((await cfg("remote.scp.url")).stdout.trim()).toBe("gh.example.invalid:me/repo.git");
        // No shipped byte names the dropped local paths.
        for (const file of walk(m.gitDir)) {
          const text = readFileSync(file).toString("utf8");
          expect(text).not.toContain("/Users/mirror");
          expect(text).not.toContain("/Users/base");
          expect(text).not.toContain("/abs/path/libs");
          expect(text).not.toContain("~/repos/x");
        }
        // The ship-time ref snapshot rides the payload and records main.
        const snapshot = readFileSync(join(m.gitDir, "beam-shipped-refs"), "utf8");
        expect(snapshot).toContain(`${f2.c2} refs/heads/main`);
        expect(snapshot).toContain(`${f2.c1} refs/heads/feature`);
      } finally {
        m.cleanup();
      }
    },
    30_000,
  );

  test(
    "replace, notes, custom refs and the full stash stack ship with local semantics; beam bookkeeping and worktree internals stay home",
    async () => {
      const f3 = await makeFixture();
      // Local Git semantics beyond heads/tags/remotes: a replacement that
      // rewrites c1's identity, a commit note, a custom ref namespace, and
      // a TWO-entry stash (order is stash semantics). Plus refs that must
      // never travel: beam's own bookkeeping and a worktree-scoped ref.
      await git(f3.wtA, "update-ref", `refs/replace/${f3.c1}`, f3.c2);
      await git(f3.wtA, "notes", "add", "-m", "shipped note", f3.c2);
      const notesSha = (await git(f3.wtA, "rev-parse", "refs/notes/commits")).stdout.trim();
      await git(f3.wtA, "update-ref", "refs/custom/marker", f3.c1);
      await git(f3.wtA, "update-ref", "refs/beam/return/old/values/junk", f3.c1);
      await git(f3.wtA, "update-ref", "refs/worktree/private", f3.c1);
      await git(f3.wtA, "stash", "push", "-q", "-m", "s1");
      writeFileSync(join(f3.wtA, "tracked.txt"), "v1\nsecond stash material\n");
      await git(f3.wtA, "stash", "push", "-q", "-m", "s2");
      const stash0 = (await git(f3.wtA, "rev-parse", "refs/stash")).stdout.trim();
      const stash1 = (await git(f3.wtA, "rev-parse", "stash@{1}")).stdout.trim();

      const m = await materializeWorktreeGit(f3.wtA);
      try {
        const pgit = async (...args: string[]) =>
          runChecked(["git", "--git-dir", m.gitDir, ...args], { env: GIT_ENV });
        // Ref values mirrored exactly — and replacement SEMANTICS are live:
        // the payload resolves c1 through the replace ref.
        expect((await pgit("rev-parse", `refs/replace/${f3.c1}`)).stdout.trim()).toBe(f3.c2);
        expect((await pgit("show", "-s", "--format=%s", f3.c1)).stdout.trim()).toBe("c2");
        expect((await pgit("rev-parse", "refs/notes/commits")).stdout.trim()).toBe(notesSha);
        expect((await pgit("notes", "show", f3.c2)).stdout.trim()).toBe("shipped note");
        expect((await pgit("rev-parse", "refs/custom/marker")).stdout.trim()).toBe(f3.c1);

        // The whole stash STACK travels — entries, order, and messages —
        // not merely the refs/stash tip.
        expect((await pgit("rev-parse", "refs/stash")).stdout.trim()).toBe(stash0);
        expect((await pgit("rev-parse", "stash@{1}")).stdout.trim()).toBe(stash1);
        const stashList = (await pgit("stash", "list")).stdout;
        expect(stashList.split("\n")[0]).toContain("s2");
        expect(stashList.split("\n")[1]).toContain("s1");

        // Beam bookkeeping and worktree-scoped refs stayed home.
        for (const ref of ["refs/beam/return/old/values/junk", "refs/worktree/private"]) {
          expect((await run(["git", "--git-dir", m.gitDir, "rev-parse", "--verify", "-q", ref])).code).not.toBe(0);
        }

        // Every shipped shared ref is pinned in the snapshot — the stash
        // stack below the tip as refs/stash@{n} pseudo-entries — and the
        // stay-home refs are not.
        const snapshot = readFileSync(join(m.gitDir, "beam-shipped-refs"), "utf8");
        expect(snapshot).toContain(`${f3.c2} refs/replace/${f3.c1}`);
        expect(snapshot).toContain(`${notesSha} refs/notes/commits`);
        expect(snapshot).toContain(`${f3.c1} refs/custom/marker`);
        expect(snapshot).toContain(`${stash0} refs/stash`);
        expect(snapshot).toContain(`${stash1} refs/stash@{1}`);
        expect(snapshot).not.toContain("refs/beam/");
        expect(snapshot).not.toContain("refs/worktree/");
      } finally {
        m.cleanup();
      }
    },
    30_000,
  );
});

describe.skipIf(!HAVE_DEPS)("cmdUp linked-worktree integration (local transport)", () => {
  let remoteRoot: string;
  const savedEnv: Record<string, string | undefined> = {};
  let savedCwd: string;

  beforeAll(() => {
    savedCwd = process.cwd();
    for (const k of ["BEAM_HOME", "BEAM_DIR"]) savedEnv[k] = process.env[k];

    const beamHome = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtup-home-")));
    const remoteHome = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtup-rhome-")));
    remoteRoot = join(remoteHome, "beam-root");
    const beamDir = join(beamHome, ".beam");
    mkdirSync(beamDir, { recursive: true });
    writeFileSync(
      join(beamDir, "config.json"),
      JSON.stringify({
        defaultTarget: "sandbox",
        targets: { sandbox: { type: "local", root: remoteRoot, home: remoteHome } },
      }),
    );
    process.env.BEAM_HOME = beamHome;
    process.env.BEAM_DIR = beamDir;
  });

  afterAll(() => {
    process.chdir(savedCwd);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("materialization failure aborts before any transport mutation and leaves no temp state", async () => {
    const badWt = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtbad-")));
    writeFileSync(join(badWt, ".git"), "gitdir: /nonexistent/common/worktrees/gone\n");
    writeFileSync(join(badWt, "work.txt"), "unshippable\n");
    process.chdir(badWt);

    const before = materializerTemps();
    await expect(cmdUp(["--no-session"])).rejects.toThrow();

    // Nothing remote happened AT ALL: the workspace root was never created.
    expect(existsSync(remoteRoot)).toBe(false);
    expect(materializerTemps()).toEqual(before);
  });

  test(
    "beam up ships a linked worktree as a self-contained repo and removes the shipped patch",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      const sourceStatus = (await git(localCwd, "status", "--porcelain=v1")).stdout;

      const before = materializerTemps();
      await cmdUp(["--no-session"]);
      expect(materializerTemps()).toEqual(before); // temp cleaned on success too

      const remoteCwd = join(remoteRoot, remoteWorkspaceName(localCwd));
      expect(lstatSync(join(remoteCwd, ".git")).isDirectory()).toBe(true);
      expect((await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.c2);
      expect((await git(remoteCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await git(remoteCwd, "status", "--porcelain=v1")).stdout).toBe(sourceStatus);
      expect((await git(remoteCwd, "show", ":staged-only.txt")).stdout).toBe("staged blob v1\n");
      // The staged patch was applied and removed; only its scratch dir stays,
      // and git never sees it.
      expect(existsSync(join(remoteCwd, ".beam", "staged-index.patch"))).toBe(false);
      expect(readFileSync(join(remoteCwd, ".git", "info", "exclude"), "utf8")).toContain(".beam/");
      // The local pointer file survived untouched.
      expect(lstatSync(join(localCwd, ".git")).isFile()).toBe(true);
    },
    60_000,
  );
});

/**
 * Remote-side fault injection: LocalTransport runs every remote command
 * through `bash -lc` with HOME pointed at the target home, so function
 * overrides in that home's `.bash_profile` fail exactly one REMOTE command
 * while every local git call (spawned directly, never through a login
 * shell) stays real.
 */
const REMOTE_APPLY_FAIL = `git() {
  for a in "$@"; do
    if [ "$a" = apply ]; then echo "canned git apply failure" >&2; return 65; fi
  done
  command git "$@"
}
`;
const REMOTE_RM_FAIL = `rm() {
  for a in "$@"; do
    case "$a" in *staged-index.patch*) echo "canned rm failure" >&2; return 66;; esac
  done
  command rm "$@"
}
`;

describe.skipIf(!HAVE_DEPS)("cmdUp staged-patch removal on every outcome (local transport)", () => {
  let remoteRoot: string;
  let remoteHome: string;
  const savedEnv: Record<string, string | undefined> = {};
  let savedCwd: string;

  beforeAll(() => {
    savedCwd = process.cwd();
    for (const k of ["BEAM_HOME", "BEAM_DIR"]) savedEnv[k] = process.env[k];

    const beamHome = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtfail-home-")));
    remoteHome = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtfail-rhome-")));
    remoteRoot = join(remoteHome, "beam-root");
    const beamDir = join(beamHome, ".beam");
    mkdirSync(beamDir, { recursive: true });
    writeFileSync(
      join(beamDir, "config.json"),
      JSON.stringify({
        defaultTarget: "sandbox",
        targets: { sandbox: { type: "local", root: remoteRoot, home: remoteHome } },
      }),
    );
    process.env.BEAM_HOME = beamHome;
    process.env.BEAM_DIR = beamDir;
  });

  afterAll(() => {
    process.chdir(savedCwd);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test(
    "a failed apply still removes the shipped patch and aborts before the handoff is up",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      writeFileSync(join(remoteHome, ".bash_profile"), REMOTE_APPLY_FAIL);
      try {
        await expect(cmdUp(["--no-session"])).rejects.toThrow(/canned git apply failure/);
      } finally {
        rmSync(join(remoteHome, ".bash_profile"), { force: true });
      }
      const remoteCwd = join(remoteRoot, remoteWorkspaceName(localCwd));
      // A staged-only blob exists nowhere but the patch: the failure path
      // must still have removed it from the retained remote workspace.
      expect(existsSync(join(remoteCwd, ".beam", "staged-index.patch"))).toBe(false);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      expect(record.status).toBe("provisioning"); // aborted before the agent/up flip
    },
    60_000,
  );

  test(
    "a cleanup that cannot be proven aborts the handoff even when the apply succeeded",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      writeFileSync(join(remoteHome, ".bash_profile"), REMOTE_RM_FAIL);
      try {
        await expect(cmdUp(["--no-session"])).rejects.toThrow(/canned rm failure/);
      } finally {
        rmSync(join(remoteHome, ".bash_profile"), { force: true });
      }
      const remoteCwd = join(remoteRoot, remoteWorkspaceName(localCwd));
      // The patch really is still there — exactly why the handoff must not
      // proceed to start an agent over it.
      expect(existsSync(join(remoteCwd, ".beam", "staged-index.patch"))).toBe(true);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      expect(record.status).toBe("provisioning");
    },
    60_000,
  );

  test(
    "a ship failure plus an unprovable cleanup surface together, naming the leftover path",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      writeFileSync(join(remoteHome, ".bash_profile"), REMOTE_APPLY_FAIL + REMOTE_RM_FAIL);
      let caught: unknown;
      try {
        await cmdUp(["--no-session"]);
      } catch (err) {
        caught = err;
      } finally {
        rmSync(join(remoteHome, ".bash_profile"), { force: true });
      }
      expect(caught).toBeInstanceOf(AggregateError);
      const agg = caught as AggregateError;
      expect(agg.errors.length).toBe(2);
      expect(String(agg.errors[0])).toContain("canned git apply failure");
      expect(String(agg.errors[1])).toContain("canned rm failure");
      expect(agg.message).toContain("staged-index.patch"); // the manual-recovery path is named
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      expect(record.status).toBe("provisioning");
    },
    60_000,
  );

  test(
    "an unwritable .beam aborts the landing, and the cleanup scope still proves nothing was left",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      const remoteCwd = join(remoteRoot, remoteWorkspaceName(localCwd));
      // A read-only remote `.beam` makes the guarded mv into it fail after
      // the sibling staging write succeeded; --no-delete keeps the mirror
      // from sweeping the empty dir away first.
      mkdirSync(join(remoteCwd, ".beam"), { recursive: true });
      chmodSync(join(remoteCwd, ".beam"), 0o555);
      try {
        await expect(cmdUp(["--no-session", "--no-delete"])).rejects.toThrow(/EACCES|permission denied/i);
      } finally {
        chmodSync(join(remoteCwd, ".beam"), 0o755);
      }
      expect(existsSync(join(remoteCwd, ".beam", "staged-index.patch"))).toBe(false);
      expect(existsSync(join(remoteCwd, ".beam-staged-index.patch"))).toBe(false); // sibling staging file cleaned too
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      expect(record.status).toBe("provisioning");
    },
    60_000,
  );

  test(
    "a .beam swapped for an outward symlink refuses the staged patch — the fixed-name outside file is untouched",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      const remoteCwd = join(remoteRoot, remoteWorkspaceName(localCwd));
      // A reused workspace whose agent swapped the reserved dir for a
      // symlink escaping the workspace. The outside dir carries the
      // patch's FIXED NAME: the old unguarded flow would have written,
      // applied, and rm'd straight through the link.
      const outside = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtbeam-out-")));
      writeFileSync(join(outside, "staged-index.patch"), "sentinel: not beam's\n");
      mkdirSync(remoteCwd, { recursive: true });
      symlinkSync(outside, join(remoteCwd, ".beam"));

      let caught: unknown;
      try {
        await cmdUp(["--no-session"]);
      } catch (err) {
        caught = err;
      }
      // Fail closed, both ways: the landing shell refused, and the cleanup
      // shell refused to prove removal through the same link.
      expect(caught).toBeInstanceOf(AggregateError);
      const agg = caught as AggregateError;
      expect(String(agg.errors[0])).toMatch(/is a symlink — refusing/);
      expect(String(agg.errors[1])).toMatch(/is a symlink — refusing/);

      // Nothing landed outside the workspace: the fixed-name file is
      // byte-identical, nothing new appeared, and the link was never
      // replaced or followed.
      expect(readdirSync(outside)).toEqual(["staged-index.patch"]);
      expect(readFileSync(join(outside, "staged-index.patch"), "utf8")).toBe("sentinel: not beam's\n");
      expect(lstatSync(join(remoteCwd, ".beam")).isSymbolicLink()).toBe(true);
      // The sibling staging file was still cleaned up — it sits outside
      // `.beam` and owes no proof through it.
      expect(existsSync(join(remoteCwd, ".beam-staged-index.patch"))).toBe(false);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      expect(record.status).toBe("provisioning");
    },
    60_000,
  );
});

/** Isolated BEAM_HOME/BEAM_DIR plus a local-transport target, per describe. */
interface IsolatedBeam {
  remoteRoot: string;
  remoteHome: string;
  savedCwd: string;
  savedEnv: Record<string, string | undefined>;
}

function isolatedBeam(tag: string): IsolatedBeam {
  const savedCwd = process.cwd();
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of ["BEAM_HOME", "BEAM_DIR"]) savedEnv[k] = process.env[k];
  const beamHome = realpathSync(mkdtempSync(join(tmpdir(), `beam-${tag}-home-`)));
  const remoteHome = realpathSync(mkdtempSync(join(tmpdir(), `beam-${tag}-rhome-`)));
  const remoteRoot = join(remoteHome, "beam-root");
  const beamDir = join(beamHome, ".beam");
  mkdirSync(beamDir, { recursive: true });
  writeFileSync(
    join(beamDir, "config.json"),
    JSON.stringify({
      defaultTarget: "sandbox",
      targets: { sandbox: { type: "local", root: remoteRoot, home: remoteHome } },
    }),
  );
  process.env.BEAM_HOME = beamHome;
  process.env.BEAM_DIR = beamDir;
  return { remoteRoot, remoteHome, savedCwd, savedEnv };
}

function restoreBeam(iso: IsolatedBeam): void {
  process.chdir(iso.savedCwd);
  for (const [k, v] of Object.entries(iso.savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

interface ReturnFixture {
  base: string;
  wt: string;
  commonGit: string;
  mainSha: string;
  otherSha: string;
}

/**
 * Minimal linked worktree with a CLEAN checkout on `main` plus a sibling
 * branch `other` whose tip conflicts with main on conflict.txt — fodder for
 * op-state (merge) and fail-closed return tests.
 */
async function makeReturnFixture(): Promise<ReturnFixture> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtretfix-")));
  const seed = join(base, "seed");
  mkdirSync(seed);
  await git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "conflict.txt"), "base\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-q", "-m", "base");
  await git(seed, "checkout", "-q", "-b", "other");
  writeFileSync(join(seed, "conflict.txt"), "theirs\n");
  await git(seed, "commit", "-q", "-am", "theirs");
  await git(seed, "checkout", "-q", "main");
  writeFileSync(join(seed, "conflict.txt"), "ours\n");
  await git(seed, "commit", "-q", "-am", "ours");
  const mainSha = (await git(seed, "rev-parse", "main")).stdout.trim();
  const otherSha = (await git(seed, "rev-parse", "other")).stdout.trim();
  const commonGit = join(base, "common.git");
  await runChecked(["git", "clone", "-q", "--bare", seed, commonGit], { env: GIT_ENV });
  rmSync(seed, { recursive: true, force: true });
  await git(commonGit, "remote", "set-url", "origin", "https://example.invalid/ret.git");
  const wt = join(base, "wt");
  await git(commonGit, "worktree", "add", "-q", wt, "main");
  return { base, wt, commonGit, mainSha, otherSha };
}

/**
 * Ship-time identity for a worktree, built exactly the way a fresh `beam up`
 * persists it: HEAD/branch when present, both git-dir pathnames, and the
 * device+inode identity of each dir as decimal strings.
 */
async function shipInfoFor(wt: string): Promise<WtGitShipInfo> {
  const commonDir = resolve(wt, (await git(wt, "rev-parse", "--git-common-dir")).stdout.trim());
  const worktreeGitDir = (await git(wt, "rev-parse", "--absolute-git-dir")).stdout.trim();
  const head = await run(["git", "-C", wt, "rev-parse", "--verify", "-q", "HEAD"]);
  const branch = await run(["git", "-C", wt, "symbolic-ref", "--quiet", "HEAD"]);
  const idOf = (p: string) => {
    const st = statSync(p, { bigint: true });
    return { dev: String(st.dev), ino: String(st.ino) };
  };
  return {
    ...(head.code === 0 ? { head: head.stdout.trim() } : {}),
    ...(branch.code === 0 ? { branch: branch.stdout.trim() } : {}),
    commonDir,
    worktreeGitDir,
    commonDirId: idOf(commonDir),
    worktreeGitDirId: idOf(worktreeGitDir),
  };
}

describe.skipIf(!HAVE_DEPS)("cmdUp refuses sparse linked-worktree layouts before any remote effect", () => {
  let iso: IsolatedBeam;
  beforeAll(() => {
    iso = isolatedBeam("wtsparse");
  });
  afterAll(() => restoreBeam(iso));

  test(
    "sparse-checkout fails the up before the workspace root exists",
    async () => {
      const f = await makeReturnFixture();
      await git(f.wt, "sparse-checkout", "set");
      process.chdir(f.wt);
      await expect(cmdUp(["--no-session"])).rejects.toThrow(/sparse-checkout/);
      expect(existsSync(iso.remoteRoot)).toBe(false);
    },
    30_000,
  );

  test(
    "skip-worktree entries fail the up before the workspace root exists",
    async () => {
      const f = await makeReturnFixture();
      await git(f.wt, "update-index", "--skip-worktree", "conflict.txt");
      process.chdir(f.wt);
      await expect(cmdUp(["--no-session"])).rejects.toThrow(/skip-worktree/);
      expect(existsSync(iso.remoteRoot)).toBe(false);
    },
    30_000,
  );
});

describe.skipIf(!HAVE_DEPS)("materializeWorktreeGit refuses in-progress operations", () => {
  /** Marker path in THIS worktree's git dir, exactly as production resolves it. */
  async function markerPath(wt: string, marker: string): Promise<string> {
    return resolve(wt, (await git(wt, "rev-parse", "--git-path", marker)).stdout.trim());
  }

  test(
    "every real operation refuses the up, and the worktree ships again once aborted",
    async () => {
      const f = await makeReturnFixture();
      const refuse = async (marker: string) =>
        expect(materializeWorktreeGit(f.wt)).rejects.toThrow(
          `beam up: the local worktree has an in-progress git operation (${marker}) — ` +
            `finish or abort it locally, then retry beam up`,
        );
      const before = materializerTemps();

      // Real states, created by the operations themselves; each cleanup is
      // the exact escape hatch the error message tells the user to run.
      expect((await run(["git", "-C", f.wt, "merge", "other"], { env: GIT_ENV })).code).not.toBe(0);
      await refuse("MERGE_HEAD");
      await git(f.wt, "merge", "--abort");

      expect((await run(["git", "-C", f.wt, "rebase", "other"], { env: GIT_ENV })).code).not.toBe(0);
      await refuse("rebase-merge");
      await git(f.wt, "rebase", "--abort");

      expect((await run(["git", "-C", f.wt, "rebase", "--apply", "other"], { env: GIT_ENV })).code).not.toBe(0);
      await refuse("rebase-apply");
      await git(f.wt, "rebase", "--abort");

      expect((await run(["git", "-C", f.wt, "cherry-pick", "other"], { env: GIT_ENV })).code).not.toBe(0);
      await refuse("CHERRY_PICK_HEAD");
      await git(f.wt, "cherry-pick", "--abort");

      await git(f.wt, "revert", "--no-commit", "HEAD"); // clean, but in progress until committed
      await refuse("REVERT_HEAD");
      await git(f.wt, "revert", "--abort");

      await git(f.wt, "bisect", "start");
      await refuse("BISECT_LOG");
      await git(f.wt, "bisect", "reset");

      // No refusal created temp state; a clean worktree materializes again.
      expect(materializerTemps()).toEqual(before);
      (await materializeWorktreeGit(f.wt)).cleanup();
    },
    60_000,
  );

  test(
    "a multi-commit sequencer run between steps — no CHERRY_PICK_HEAD — still refuses",
    async () => {
      const f = await makeReturnFixture();
      // Grow `other` by one clean commit so a two-commit pick has a remainder.
      const wtOther = join(f.base, "wtOther");
      await git(f.commonGit, "worktree", "add", "-q", wtOther, "other");
      writeFileSync(join(wtOther, "extra.txt"), "clean addition\n");
      await git(wtOther, "add", "extra.txt");
      await git(wtOther, "commit", "-q", "-m", "extra");
      await git(f.commonGit, "worktree", "remove", wtOther);

      // The first pick conflicts; resolving it with plain `git commit`
      // consumes CHERRY_PICK_HEAD while sequencer/todo still holds the
      // second pick — git itself reports "Cherry-pick currently in progress".
      expect((await run(["git", "-C", f.wt, "cherry-pick", "other~1", "other"], { env: GIT_ENV })).code).not.toBe(0);
      writeFileSync(join(f.wt, "conflict.txt"), "resolved\n");
      await git(f.wt, "add", "conflict.txt");
      await git(f.wt, "commit", "-q", "--no-edit");
      expect(existsSync(await markerPath(f.wt, "CHERRY_PICK_HEAD"))).toBe(false);
      expect(existsSync(await markerPath(f.wt, "sequencer"))).toBe(true);

      await expect(materializeWorktreeGit(f.wt)).rejects.toThrow(/in-progress git operation \(sequencer\)/);

      await git(f.wt, "cherry-pick", "--quit");
      (await materializeWorktreeGit(f.wt)).cleanup();
    },
    60_000,
  );

  test(
    "the detection boundary covers the full marker set, file or directory",
    async () => {
      const f = await makeReturnFixture();
      const markers: Array<[name: string, kind: "file" | "dir"]> = [
        ["MERGE_HEAD", "file"],
        ["CHERRY_PICK_HEAD", "file"],
        ["REVERT_HEAD", "file"],
        ["BISECT_LOG", "file"],
        ["rebase-merge", "dir"],
        ["rebase-apply", "dir"],
        ["sequencer", "dir"],
      ];
      for (const [marker, kind] of markers) {
        const p = await markerPath(f.wt, marker);
        if (kind === "dir") mkdirSync(p);
        else writeFileSync(p, "");
        try {
          await expect(materializeWorktreeGit(f.wt)).rejects.toThrow(
            new RegExp(`beam up: .*in-progress git operation \\(${marker}\\)`),
          );
        } finally {
          rmSync(p, { recursive: true, force: true });
        }
      }
      // Presence-based detection: with every marker gone, the same worktree ships.
      (await materializeWorktreeGit(f.wt)).cleanup();
    },
    60_000,
  );
});

describe.skipIf(!HAVE_DEPS)("cmdUp refuses in-progress operations before any remote effect", () => {
  let iso: IsolatedBeam;
  beforeAll(() => {
    iso = isolatedBeam("wtop");
  });
  afterAll(() => restoreBeam(iso));

  test(
    "an in-progress merge fails the up before the workspace root exists",
    async () => {
      const f = await makeReturnFixture();
      expect((await run(["git", "-C", f.wt, "merge", "other"], { env: GIT_ENV })).code).not.toBe(0);
      process.chdir(f.wt);
      const before = materializerTemps();
      await expect(cmdUp(["--no-session"])).rejects.toThrow(/in-progress git operation \(MERGE_HEAD\)/);
      // Failed before the payload existed and before anything remote
      // happened at all: the workspace root was never created.
      expect(materializerTemps()).toEqual(before);
      expect(existsSync(iso.remoteRoot)).toBe(false);
    },
    30_000,
  );
});

describe.skipIf(!HAVE_DEPS)("cmdDown linked-worktree git-state return (local transport)", () => {
  let iso: IsolatedBeam;
  beforeAll(() => {
    iso = isolatedBeam("wtdown");
  });
  afterAll(() => restoreBeam(iso));

  test(
    "remote commits, tags, stash, staged blobs, index and HEAD come home losslessly before the purge",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      expect(record.wtGit).toBeDefined();
      expect(record.wtGit!.commonDir).toBe(join(f.base, "common.git"));
      const remoteCwd = record.remoteCwd;

      // Remote agent work: two stashes, a commit on main, a new branch, a
      // tag, and a freshly staged blob that exists nowhere but the index.
      await git(remoteCwd, "stash", "push", "-q", "-m", "s1");
      writeFileSync(join(remoteCwd, "tracked.txt"), "stash-2 material\n");
      await git(remoteCwd, "stash", "push", "-q", "-m", "s2");
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const rMain = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();
      await git(remoteCwd, "branch", "rbranch", rMain);
      await git(remoteCwd, "tag", "rtag", rMain);
      writeFileSync(join(remoteCwd, "staged-remote.txt"), "remote staged blob\n");
      await git(remoteCwd, "add", "staged-remote.txt");
      const stash0 = (await git(remoteCwd, "rev-parse", "refs/stash")).stdout.trim();
      const stash1 = (await git(remoteCwd, "rev-parse", "stash@{1}")).stdout.trim();
      const remoteStatus = (await git(remoteCwd, "status", "--porcelain=v1")).stdout;

      // Locally: delete a branch the remote never touched — the return must
      // not resurrect its untouched remote mirror.
      await git(localCwd, "branch", "-D", "feature");

      // --delete: the stashes REMOVED staged-only files from the remote
      // working tree; only a mirrored return reproduces its exact file set
      // (and the byte-identical status asserted below).
      await cmdDown([record.id, "--delete"]);

      // Safe moves applied exactly; the deleted branch stayed deleted.
      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(rMain);
      expect((await git(localCwd, "rev-parse", "refs/heads/rbranch")).stdout.trim()).toBe(rMain);
      expect((await git(localCwd, "rev-parse", "refs/tags/rtag")).stdout.trim()).toBe(rMain);
      expect((await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", "refs/heads/feature"])).code).not.toBe(
        0,
      );

      // HEAD reattached to main; index + working tree reproduce the remote's
      // final state byte for byte, staged-only blob included.
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await git(localCwd, "status", "--porcelain=v1")).stdout).toBe(remoteStatus);
      expect((await git(localCwd, "show", ":staged-remote.txt")).stdout).toBe("remote staged blob\n");

      // Every stash entry preserved under the deterministic meta/ subtree
      // of the return namespace, top first.
      expect((await git(localCwd, "rev-parse", `refs/beam/return/${record.id}/meta/stash`)).stdout.trim()).toBe(stash0);
      expect((await git(localCwd, "rev-parse", `refs/beam/return/${record.id}/meta/stash-1`)).stdout.trim()).toBe(
        stash1,
      );
      // Cleanly applied refs leave no quarantine residue behind.
      expect(
        (
          await run([
            "git",
            "-C",
            localCwd,
            "rev-parse",
            "--verify",
            "-q",
            `refs/beam/return/${record.id}/values/heads/main`,
          ])
        )
          .code,
      ).not.toBe(0);

      // Durable pre-return snapshot: ONE commit whose parent is the
      // pre-down local HEAD and whose tree is the pre-down staged tree.
      expect((await git(localCwd, "rev-parse", `refs/beam/backup/${record.id}/state^1`)).stdout.trim()).toBe(f.c2);
      expect((await git(localCwd, "cat-file", "-t", `refs/beam/backup/${record.id}/state^{tree}`)).stdout.trim()).toBe(
        "tree",
      );

      // Remote purged only after all of the above became durable; the local
      // pointer file survived the round trip.
      expect(existsSync(remoteCwd)).toBe(false);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("down");
      expect(lstatSync(join(localCwd, ".git")).isFile()).toBe(true);
    },
    60_000,
  );


  test(
    "remote Git config is made inert before local Git opens the collected repository",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteConfig = join(record.remoteCwd, ".git", "config");
      const hostMarker = join(f.base, "remote-config-executed-on-host");

      // `git fsck --cache` executes core.fsmonitor through a shell when the
      // repository config is trusted. Plant it after all remote Git commands:
      // only beam down's local verifier can trigger this marker.
      writeFileSync(
        remoteConfig,
        `${readFileSync(remoteConfig, "utf8")}\n[core]\n\tfsmonitor = touch ${shq(hostMarker)}\n`,
      );

      await cmdDown([record.id]);
      expect(existsSync(hostMarker)).toBe(false);
      expect(existsSync(record.remoteCwd)).toBe(false);
    },
    60_000,
  );

  test(
    "remote-only ref namespaces are quarantined instead of changing local Git semantics",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      writeFileSync(join(remoteCwd, "replacement.txt"), "remote replacement\n");
      await git(remoteCwd, "add", "replacement.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote replacement");
      const remoteTip = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();
      const replaceRef = `refs/replace/${f.c2}`;
      const notesRef = "refs/notes/remote-only";
      await git(remoteCwd, "update-ref", replaceRef, remoteTip);
      await git(remoteCwd, "update-ref", notesRef, remoteTip);

      await cmdDown([record.id]);

      for (const ref of [replaceRef, notesRef]) {
        expect((await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", ref])).code).not.toBe(0);
        const quarantined = `refs/beam/return/${record.id}/values/${ref.replace(/^refs\//, "")}`;
        expect((await git(localCwd, "rev-parse", quarantined)).stdout.trim()).toBe(remoteTip);
      }
      expect((await git(localCwd, "show", "-s", "--format=%s", f.c2)).stdout.trim()).toBe("c2");
      expect(existsSync(remoteCwd)).toBe(false);
    },
    60_000,
  );

  test(
    "conflicting local commits are never overwritten — remote result quarantined, the returning worktree HEAD is preserved",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // Both sides move main: locally commit the dirty state, remotely
      // commit a new file.
      await git(localCwd, "add", "-A");
      await git(localCwd, "commit", "-q", "-m", "local work");
      const lMain = (await git(localCwd, "rev-parse", "HEAD")).stdout.trim();
      writeFileSync(join(remoteCwd, "remote-side.txt"), "remote work\n");
      await git(remoteCwd, "add", "remote-side.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const rMain = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();

      await cmdDown([record.id]);

      // Local main kept the local commits; the remote result is quarantined,
      // and the returning worktree HEAD stayed exactly where it was — an
      // unadopted branch must not drag HEAD to the remote position.
      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(lMain);
      expect((await git(localCwd, "rev-parse", `refs/beam/return/${record.id}/values/heads/main`)).stdout.trim()).toBe(
        rMain,
      );
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(lMain);
      // The remote HEAD commit stays recoverable under the return namespace.
      expect((await git(localCwd, "rev-parse", `refs/beam/return/${record.id}/meta/HEAD`)).stdout.trim()).toBe(rMain);
      // The remote's working tree still came home.
      expect(readFileSync(join(localCwd, "remote-side.txt"), "utf8")).toBe("remote work\n");
      // The pre-down local HEAD survives inside the durable snapshot commit.
      expect((await git(localCwd, "rev-parse", `refs/beam/backup/${record.id}/state^1`)).stdout.trim()).toBe(lMain);
      // Quarantine is lossless enough to purge: the remote is gone.
      expect(existsSync(remoteCwd)).toBe(false);
    },
    60_000,
  );

  test(
    "an import failure leaves the remote intact and retryable; purge happens only after a clean import",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const rMain = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();

      // Corrupt the remote object store: the collection fsck must fail the
      // down BEFORE any purge or local git mutation.
      const objPath = join(remoteCwd, ".git", "objects", rMain.slice(0, 2), rMain.slice(2));
      renameSync(objPath, `${objPath}.hidden`);
      await expect(cmdDown([record.id])).rejects.toThrow();

      // Remote fully intact and the record still collectable; local git
      // state untouched.
      expect(existsSync(join(remoteCwd, ".git"))).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(f.c2);
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");

      // Repair and retry: the down converges and only then purges.
      renameSync(`${objPath}.hidden`, objPath);
      await cmdDown([record.id]);
      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(rMain);
      expect(existsSync(remoteCwd)).toBe(false);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("down");
    },
    60_000,
  );

  test(
    "an in-progress remote merge returns whole and can be continued or aborted locally",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // Remote agent starts a merge that conflicts and leaves it in flight.
      const merge = await run(["git", "-C", remoteCwd, "merge", "other"], { env: GIT_ENV });
      expect(merge.code).not.toBe(0);
      const remoteMergeHead = (await git(remoteCwd, "rev-parse", "MERGE_HEAD")).stdout.trim();
      expect(remoteMergeHead).toBe(f.otherSha);
      const remoteStatus = (await git(remoteCwd, "status", "--porcelain=v1")).stdout;
      expect(remoteStatus).toContain("UU conflict.txt");

      await cmdDown([record.id]);

      // The merge state landed in THIS worktree's git dir: same MERGE_HEAD,
      // byte-identical conflict status, and the operation is actionable.
      expect((await git(localCwd, "rev-parse", "MERGE_HEAD")).stdout.trim()).toBe(f.otherSha);
      expect((await git(localCwd, "status", "--porcelain=v1")).stdout).toBe(remoteStatus);
      expect(existsSync(remoteCwd)).toBe(false);
      expect((await run(["git", "-C", localCwd, "merge", "--abort"])).code).toBe(0);
      expect((await git(localCwd, "status", "--porcelain=v1")).stdout).toBe("");
    },
    60_000,
  );

  test(
    "a local in-progress operation fails the down closed, before any local file or git mutation",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // The remote diverges; the local worktree grows its own operation.
      writeFileSync(join(remoteCwd, "conflict.txt"), "remote mutation\n");
      const mergeHeadPath = resolve(
        localCwd,
        (await runChecked(["git", "-C", localCwd, "rev-parse", "--git-path", "MERGE_HEAD"])).stdout.trim(),
      );
      writeFileSync(mergeHeadPath, `${f.otherSha}\n`);
      try {
        await expect(cmdDown([record.id])).rejects.toThrow(/in-progress git operation/);
      } finally {
        rmSync(mergeHeadPath, { force: true });
      }

      // Failed BEFORE the mirror: the local file kept its content, the
      // remote kept the workspace, and no backup refs were written.
      expect(readFileSync(join(localCwd, "conflict.txt"), "utf8")).toBe("ours\n");
      expect(existsSync(remoteCwd)).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
      expect(
        (await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", `refs/beam/backup/${record.id}/state`]))
          .code,
      ).not.toBe(0);
    },
    60_000,
  );

  test(
    "a collection without the ship-time snapshot applies nothing — every remote ref is quarantined instead",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      rmSync(join(remoteCwd, ".git", "beam-shipped-refs"), { force: true });
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const rMain = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();

      await cmdDown([record.id]);

      // Fail-closed application: main untouched, the remote value preserved
      // under the return namespace, and the returning worktree HEAD is
      // preserved on its pre-return branch instead of detaching.
      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(f.mainSha);
      expect((await git(localCwd, "rev-parse", `refs/beam/return/${record.id}/values/heads/main`)).stdout.trim()).toBe(
        rMain,
      );
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.mainSha);
      expect((await git(localCwd, "rev-parse", `refs/beam/return/${record.id}/meta/HEAD`)).stdout.trim()).toBe(rMain);
      expect(existsSync(remoteCwd)).toBe(false);
    },
    60_000,
  );

  test(
    "a sibling worktree advancing the returned branch quarantines it and never moves the returning worktree's HEAD",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // Remote agent commits on main.
      writeFileSync(join(remoteCwd, "remote-side.txt"), "remote work\n");
      await git(remoteCwd, "add", "remote-side.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const rMain = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();

      // Locally: release main from the returning worktree, check it out in
      // the SIBLING, and advance it there.
      await git(localCwd, "checkout", "-q", "--detach");
      await git(f.wtB, "checkout", "-q", "main");
      writeFileSync(join(f.wtB, "sibling.txt"), "sibling advance\n");
      await git(f.wtB, "add", "sibling.txt");
      await git(f.wtB, "commit", "-q", "-m", "sibling advance");
      const sMain = (await git(f.wtB, "rev-parse", "HEAD")).stdout.trim();

      await cmdDown([record.id]);

      // The sibling owns main: its advance is untouched and the remote
      // result is quarantined instead of applied.
      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(sMain);
      expect((await git(localCwd, "rev-parse", `refs/beam/return/${record.id}/values/heads/main`)).stdout.trim()).toBe(
        rMain,
      );

      // The returning worktree's HEAD did not move: still detached exactly
      // where it was before the down, NOT at the remote position.
      expect((await run(["git", "-C", localCwd, "symbolic-ref", "-q", "HEAD"])).code).not.toBe(0);
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.c2);

      // The remote HEAD commit stays recoverable under the return namespace.
      expect((await git(localCwd, "rev-parse", `refs/beam/return/${record.id}/meta/HEAD`)).stdout.trim()).toBe(rMain);

      // The sibling's view is fully intact.
      expect((await git(f.wtB, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await git(f.wtB, "rev-parse", "HEAD")).stdout.trim()).toBe(sMain);

      // Quarantine is lossless enough to purge: the remote is gone.
      expect(existsSync(remoteCwd)).toBe(false);
    },
    60_000,
  );

  test(
    "a branch and tag deleted remotely disappear locally under compare-and-swap; tombstones keep the deletion recoverable after the purge",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // Remote agent deletes a shipped branch and a shipped tag.
      await git(remoteCwd, "branch", "-D", "feature");
      await git(remoteCwd, "tag", "-d", "t1");

      await cmdDown([record.id]);

      // Both refs disappeared locally, exactly as the remote left them...
      expect((await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", "refs/heads/feature"])).code).not.toBe(
        0,
      );
      expect((await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", "refs/tags/t1"])).code).not.toBe(0);
      // ...and the shipped tips survive as tombstones under the return namespace.
      const featureTomb = `refs/beam/return/${record.id}/deleted/heads/feature`;
      expect((await git(localCwd, "rev-parse", featureTomb)).stdout.trim()).toBe(f.c1);
      expect((await git(localCwd, "rev-parse", `refs/beam/return/${record.id}/deleted/tags/t1`)).stdout.trim()).toBe(
        f.c2,
      );

      // The default purge already ran: the remote copy is gone, and the
      // tombstone alone recovers the deleted branch with its full history.
      expect(existsSync(remoteCwd)).toBe(false);
      await git(localCwd, "update-ref", "refs/heads/feature", featureTomb);
      expect((await git(localCwd, "rev-parse", "refs/heads/feature")).stdout.trim()).toBe(f.c1);
      expect((await git(localCwd, "cat-file", "-t", f.c1)).stdout.trim()).toBe("commit");
    },
    60_000,
  );

  test(
    "a remotely deleted branch that moved locally since the ship is kept — the deletion is quarantined as a durable tombstone",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // The remote deletes feature; locally feature moves after the ship.
      await git(remoteCwd, "branch", "-D", "feature");
      await git(localCwd, "update-ref", "refs/heads/feature", f.c2);

      await cmdDown([record.id]);

      // The local movement wins: the ref was neither deleted nor overwritten.
      expect((await git(localCwd, "rev-parse", "refs/heads/feature")).stdout.trim()).toBe(f.c2);
      // The remote deletion is not discarded: the shipped tip is tombstoned
      // durably under the return namespace, surviving the purge.
      expect(
        (await git(localCwd, "rev-parse", `refs/beam/return/${record.id}/deleted/heads/feature`)).stdout.trim(),
      ).toBe(f.c1);
      expect(existsSync(remoteCwd)).toBe(false);
    },
    60_000,
  );

  test(
    "deleting a branch a worktree has checked out is refused — kept locally with a tombstone while HEAD follows the remote",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // Remote agent moves to a new branch and deletes main — but main is
      // what the returning worktree has checked out.
      await git(remoteCwd, "checkout", "-q", "-b", "takeover");
      await git(remoteCwd, "branch", "-D", "main");
      const rHead = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();

      await cmdDown([record.id]);

      // main survives at its shipped position, the deletion tombstoned...
      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(f.c2);
      expect((await git(localCwd, "rev-parse", `refs/beam/return/${record.id}/deleted/heads/main`)).stdout.trim()).toBe(
        f.c2,
      );
      // ...and HEAD reattached to the branch the remote ended on.
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/takeover");
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(rHead);
      expect(existsSync(remoteCwd)).toBe(false);
    },
    60_000,
  );

  test(
    "hostile remote-only refs cannot shadow tombstones or meta names — the return subtrees stay disjoint",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // Local main moves after the ship, so the remote HEAD must be
      // quarantined (meta/HEAD gets written).
      await git(localCwd, "add", "-A");
      await git(localCwd, "commit", "-q", "-m", "local work");
      const lMain = (await git(localCwd, "rev-parse", "HEAD")).stdout.trim();

      // Remote: a real deletion of `feature` (deleted/heads/feature gets
      // written) plus HOSTILE remote-only refs crafted to collide with the
      // durable return names a flat layout would use — each pinned to a
      // DIFFERENT commit than the artifact it tries to shadow.
      writeFileSync(join(remoteCwd, "remote-side.txt"), "remote work\n");
      await git(remoteCwd, "add", "remote-side.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const rMain = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();
      await git(remoteCwd, "branch", "-D", "feature");
      await git(remoteCwd, "update-ref", "refs/deleted/heads/feature", rMain);
      await git(remoteCwd, "update-ref", "refs/HEAD/meta", f.c1);

      await cmdDown([record.id]);

      const qbase = `refs/beam/return/${record.id}`;
      // Both tips of every would-be collision remain named, with their own
      // values: the tombstone AND the hostile ref, the quarantined remote
      // HEAD AND the hostile ref.
      expect((await git(localCwd, "rev-parse", `${qbase}/deleted/heads/feature`)).stdout.trim()).toBe(f.c1);
      expect((await git(localCwd, "rev-parse", `${qbase}/values/deleted/heads/feature`)).stdout.trim()).toBe(rMain);
      expect((await git(localCwd, "rev-parse", `${qbase}/meta/HEAD`)).stdout.trim()).toBe(rMain);
      expect((await git(localCwd, "rev-parse", `${qbase}/values/HEAD/meta`)).stdout.trim()).toBe(f.c1);

      // The hostile namespaces never landed as live local refs, the real
      // deletion applied, main kept the local work, and the purge ran —
      // both preserved tips outlive the remote copy.
      for (const ref of ["refs/deleted/heads/feature", "refs/HEAD/meta"]) {
        expect((await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", ref])).code).not.toBe(0);
      }
      expect((await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", "refs/heads/feature"])).code).not.toBe(
        0,
      );
      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(lMain);
      expect(existsSync(remoteCwd)).toBe(false);
    },
    60_000,
  );

  test(
    "replace/notes/custom refs and the stash round-trip: untouched mirrors stay silent, remote changes stay quarantined, the remote stash stack comes back whole and ordered",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      // Local shared refs beyond heads/tags/remotes, plus a two-entry stash.
      const replaceRef = `refs/replace/${f.c1}`;
      await git(localCwd, "update-ref", replaceRef, f.c2);
      await git(localCwd, "notes", "add", "-m", "local note", f.c2);
      const localNotes = (await git(localCwd, "rev-parse", "refs/notes/commits")).stdout.trim();
      await git(localCwd, "update-ref", "refs/custom/marker", f.c1);
      await git(localCwd, "stash", "push", "-q", "-m", "s1");
      writeFileSync(join(localCwd, "tracked.txt"), "v1\nsecond stash material\n");
      await git(localCwd, "stash", "push", "-q", "-m", "s2");
      const stash0 = (await git(localCwd, "rev-parse", "refs/stash")).stdout.trim();
      const stash1 = (await git(localCwd, "rev-parse", "stash@{1}")).stdout.trim();

      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // Local stash semantics reached the sandbox: same stack, same order.
      const remoteList = (await git(remoteCwd, "stash", "list")).stdout;
      expect(remoteList.split("\n")[0]).toContain("s2");
      expect(remoteList.split("\n")[1]).toContain("s1");
      expect((await git(remoteCwd, "rev-parse", "stash@{1}")).stdout.trim()).toBe(stash1);

      // Remote work: a third stash entry on top and a moved notes ref;
      // replace and custom refs stay untouched.
      writeFileSync(join(remoteCwd, "tracked.txt"), "v1\nremote stash material\n");
      await git(remoteCwd, "stash", "push", "-q", "-m", "s3");
      const rStash0 = (await git(remoteCwd, "rev-parse", "refs/stash")).stdout.trim();
      await git(remoteCwd, "notes", "add", "-f", "-m", "remote note", f.c1);
      const rNotes = (await git(remoteCwd, "rev-parse", "refs/notes/commits")).stdout.trim();
      expect(rNotes).not.toBe(localNotes);

      await cmdDown([record.id, "--delete"]);

      const qbase = `refs/beam/return/${record.id}`;
      // The changed notes ref is NOT auto-applied — the local value is
      // untouched and the remote value waits in values/ quarantine.
      expect((await git(localCwd, "rev-parse", "refs/notes/commits")).stdout.trim()).toBe(localNotes);
      expect((await git(localCwd, "rev-parse", `${qbase}/values/notes/commits`)).stdout.trim()).toBe(rNotes);

      // Untouched mirrors are recognized by their snapshot pins and leave
      // no quarantine residue at all.
      expect((await git(localCwd, "rev-parse", replaceRef)).stdout.trim()).toBe(f.c2);
      expect((await git(localCwd, "rev-parse", "refs/custom/marker")).stdout.trim()).toBe(f.c1);
      for (const leftover of [`${qbase}/values/replace/${f.c1}`, `${qbase}/values/custom/marker`]) {
        expect((await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", leftover])).code).not.toBe(0);
      }

      // The local stash is never merged into: still exactly two entries.
      // The remote's FINAL stack — new entry plus the shipped ones below
      // it, order intact — is preserved whole under meta/.
      expect((await git(localCwd, "rev-parse", "refs/stash")).stdout.trim()).toBe(stash0);
      expect((await git(localCwd, "rev-parse", `${qbase}/meta/stash`)).stdout.trim()).toBe(rStash0);
      expect((await git(localCwd, "rev-parse", `${qbase}/meta/stash-1`)).stdout.trim()).toBe(stash0);
      expect((await git(localCwd, "rev-parse", `${qbase}/meta/stash-2`)).stdout.trim()).toBe(stash1);
      expect(existsSync(remoteCwd)).toBe(false);
    },
    60_000,
  );
});

describe.skipIf(!HAVE_DEPS)("prepareWorktreeGitReturn backup transaction", () => {
  test(
    "a write-tree failure leaves no snapshot ref behind",
    async () => {
      const f = await makeReturnFixture();
      // Synthesize unmerged index entries WITHOUT any op-state marker file:
      // write-tree fails while the in-progress-operation guard stays silent,
      // exercising the snapshot failure path in isolation.
      const baseBlob = (await git(f.wt, "rev-parse", "main~1:conflict.txt")).stdout.trim();
      const oursBlob = (await git(f.wt, "rev-parse", "main:conflict.txt")).stdout.trim();
      const theirsBlob = (await git(f.wt, "rev-parse", "other:conflict.txt")).stdout.trim();
      await runChecked(["git", "-C", f.wt, "update-index", "--index-info"], {
        env: GIT_ENV,
        stdinText:
          `0 0000000000000000000000000000000000000000\tconflict.txt\n` +
          `100644 ${baseBlob} 1\tconflict.txt\n` +
          `100644 ${oursBlob} 2\tconflict.txt\n` +
          `100644 ${theirsBlob} 3\tconflict.txt\n`,
      });
      await expect(prepareWorktreeGitReturn(f.wt, "wtprep1", await shipInfoFor(f.wt))).rejects.toThrow(
        /snapshot the local index/,
      );
      // The aborted preparation left NOTHING under the record's backup
      // namespace a retry could mistake for a snapshot.
      expect((await git(f.wt, "for-each-ref", backupRefBase("wtprep1"))).stdout).toBe("");
    },
    30_000,
  );

  test(
    "a clean preparation snapshots HEAD and staged tree in one commit; an unmoved retry accepts it; local movement refuses and never re-snapshots",
    async () => {
      const f = await makeReturnFixture();
      const info = await shipInfoFor(f.wt);
      const stateRef = `${backupRefBase("wtprep2")}/state`;
      await prepareWorktreeGitReturn(f.wt, "wtprep2", info);
      // ONE durable commit object: parent = pre-return HEAD, tree = the
      // staged tree — both pinned against gc by the ref itself.
      expect((await git(f.wt, "rev-parse", `${stateRef}^1`)).stdout.trim()).toBe(f.mainSha);
      expect((await git(f.wt, "rev-parse", `${stateRef}^{tree}`)).stdout.trim()).toBe(
        (await git(f.wt, "write-tree")).stdout.trim(),
      );
      const stateSha = (await git(f.wt, "rev-parse", stateRef)).stdout.trim();

      // An unmoved repeat accepts the original snapshot without re-taking it.
      await prepareWorktreeGitReturn(f.wt, "wtprep2", info);
      expect((await git(f.wt, "rev-parse", stateRef)).stdout.trim()).toBe(stateSha);

      // Local movement after the preparation refuses — the snapshot is never
      // replaced by the moved state it exists to protect.
      await git(f.wt, "commit", "-q", "--allow-empty", "-m", "moved");
      await expect(prepareWorktreeGitReturn(f.wt, "wtprep2", info)).rejects.toThrow(
        /local HEAD moved after this return was prepared/,
      );
      expect((await git(f.wt, "rev-parse", stateRef)).stdout.trim()).toBe(stateSha);
    },
    30_000,
  );

  test(
    "legacy or partial pre-existing backups fail closed without completing, overwriting, or adopting them",
    async () => {
      const f = await makeReturnFixture();
      const info = await shipInfoFor(f.wt);
      // Orphan legacy head ref (interrupted old-style preparation),
      // deliberately NOT at the current HEAD so any overwrite would be
      // detectable.
      const headRef = `${backupRefBase("wtprep3")}/head`;
      await git(f.wt, "update-ref", "--no-deref", headRef, f.otherSha);
      await expect(prepareWorktreeGitReturn(f.wt, "wtprep3", info)).rejects.toThrow(
        /partial or legacy pre-return backup/,
      );
      expect((await git(f.wt, "rev-parse", headRef)).stdout.trim()).toBe(f.otherSha);
      expect(
        (await run(["git", "-C", f.wt, "rev-parse", "--verify", "-q", `${backupRefBase("wtprep3")}/state`])).code,
      ).not.toBe(0);

      // The inverse orphan refuses the same way and stays untouched.
      const treeOnly = `${backupRefBase("wtprep4")}/index-tree`;
      const curTree = (await git(f.wt, "write-tree")).stdout.trim();
      await git(f.wt, "update-ref", "--no-deref", treeOnly, curTree);
      await expect(prepareWorktreeGitReturn(f.wt, "wtprep4", info)).rejects.toThrow(
        /partial or legacy pre-return backup/,
      );
      expect(
        (await run(["git", "-C", f.wt, "rev-parse", "--verify", "-q", `${backupRefBase("wtprep4")}/state`])).code,
      ).not.toBe(0);
      expect((await git(f.wt, "rev-parse", treeOnly)).stdout.trim()).toBe(curTree);

      // Even a COMPLETE legacy pair is refused, never silently adopted as
      // the snapshot: only the /state commit is trustworthy.
      await git(f.wt, "update-ref", "--no-deref", `${backupRefBase("wtprep5")}/head`, f.mainSha);
      await git(f.wt, "update-ref", "--no-deref", `${backupRefBase("wtprep5")}/index-tree`, curTree);
      await expect(prepareWorktreeGitReturn(f.wt, "wtprep5", info)).rejects.toThrow(
        /partial or legacy pre-return backup/,
      );
      expect(
        (await run(["git", "-C", f.wt, "rev-parse", "--verify", "-q", `${backupRefBase("wtprep5")}/state`])).code,
      ).not.toBe(0);
    },
    30_000,
  );
});

describe.skipIf(!HAVE_DEPS)("prepareWorktreeGitReturn retry operation guard", () => {
  test(
    "a retry with a pre-return snapshot still refuses local operations Beam did not install",
    async () => {
      const f = await makeReturnFixture();
      const info = await shipInfoFor(f.wt);
      await prepareWorktreeGitReturn(f.wt, "wtretry1", info);
      const stateRef = `${backupRefBase("wtretry1")}/state`;
      const stateSha = (await git(f.wt, "rev-parse", stateRef)).stdout.trim();

      // The user starts each kind of operation between a failed first down
      // and the retry; every one must refuse without touching a byte.
      const ops: Array<{ start: string[]; abort: string[] }> = [
        { start: ["merge", "other"], abort: ["merge", "--abort"] },
        { start: ["cherry-pick", "other"], abort: ["cherry-pick", "--abort"] },
        { start: ["rebase", "other"], abort: ["rebase", "--abort"] },
      ];
      for (const op of ops) {
        expect((await run(["git", "-C", f.wt, ...op.start], { env: GIT_ENV })).code).not.toBe(0);
        const before = (await git(f.wt, "status", "--porcelain=v1")).stdout;
        await expect(prepareWorktreeGitReturn(f.wt, "wtretry1", info)).rejects.toThrow(
          /in-progress git operation/,
        );
        // Byte-for-byte refusal: status is untouched, the snapshot was not
        // overwritten, and the operation stays abortable.
        expect((await git(f.wt, "status", "--porcelain=v1")).stdout).toBe(before);
        expect((await git(f.wt, "rev-parse", stateRef)).stdout.trim()).toBe(stateSha);
        await git(f.wt, ...op.abort);
      }

      // With the operations gone the retry is clean again.
      await prepareWorktreeGitReturn(f.wt, "wtretry1", info);
    },
    30_000,
  );
});

describe.skipIf(!HAVE_DEPS)("cmdDown linked-worktree return retries (local transport)", () => {
  let iso: IsolatedBeam;
  beforeAll(() => {
    iso = isolatedBeam("wtretry");
  });
  afterAll(() => restoreBeam(iso));

  test(
    "a down that failed after taking backups refuses a retry over a new local operation",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // Remote work, then a corrupted remote object: the first down takes
      // the pre-return backups and mirrors the workspace, but dies at the
      // collection fsck — before any local git mutation.
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const rMain = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();
      const objPath = join(remoteCwd, ".git", "objects", rMain.slice(0, 2), rMain.slice(2));
      renameSync(objPath, `${objPath}.hidden`);
      await expect(cmdDown([record.id])).rejects.toThrow();
      expect((await git(localCwd, "rev-parse", `${backupRefBase(record.id)}/state^1`)).stdout.trim()).toBe(f.mainSha);

      // The user starts their own merge before retrying.
      expect((await run(["git", "-C", localCwd, "merge", "other"], { env: GIT_ENV })).code).not.toBe(0);
      const mergeHeadPath = resolve(
        localCwd,
        (await git(localCwd, "rev-parse", "--git-path", "MERGE_HEAD")).stdout.trim(),
      );
      const mergeHeadBytes = readFileSync(mergeHeadPath, "utf8");
      const status = (await git(localCwd, "status", "--porcelain=v1")).stdout;

      // The retry refuses byte-for-byte: existing backups alone no longer
      // waive the operation guard.
      await expect(cmdDown([record.id])).rejects.toThrow(/in-progress git operation/);
      expect(readFileSync(mergeHeadPath, "utf8")).toBe(mergeHeadBytes);
      expect((await git(localCwd, "status", "--porcelain=v1")).stdout).toBe(status);
      expect((await git(localCwd, "rev-parse", `${backupRefBase(record.id)}/state^1`)).stdout.trim()).toBe(f.mainSha);
      expect(existsSync(join(remoteCwd, ".git"))).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");

      // Aborting the local operation (and repairing the remote) lets the
      // retry converge.
      await git(localCwd, "merge", "--abort");
      renameSync(`${objPath}.hidden`, objPath);
      await cmdDown([record.id]);
      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(rMain);
      expect(existsSync(remoteCwd)).toBe(false);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("down");
    },
    60_000,
  );

  test(
    "a partial import retry converges on Beam-installed operation state and refuses a diverged one",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // Remote agent leaves a conflicted merge in flight.
      expect((await run(["git", "-C", remoteCwd, "merge", "other"], { env: GIT_ENV })).code).not.toBe(0);
      const remoteStatus = (await git(remoteCwd, "status", "--porcelain=v1")).stdout;
      const remoteOrigHead = readFileSync(join(remoteCwd, ".git", "ORIG_HEAD"), "utf8");

      // Poison ORIG_HEAD with an object that does not exist: fsck ignores
      // pseudorefs, so the import dies at its explicit SHA check — AFTER
      // MERGE_HEAD was already installed locally (a genuine partial import).
      writeFileSync(join(remoteCwd, ".git", "ORIG_HEAD"), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n");
      await expect(cmdDown([record.id])).rejects.toThrow();

      // Beam-installed operation state plus its durable provenance manifest.
      const mergeHeadPath = resolve(
        localCwd,
        (await git(localCwd, "rev-parse", "--git-path", "MERGE_HEAD")).stdout.trim(),
      );
      expect(readFileSync(mergeHeadPath, "utf8").trim()).toBe(f.otherSha);
      const manifestPath = resolve(
        localCwd,
        (await git(localCwd, "rev-parse", "--git-path", installedOpStateFile(record.id))).stdout.trim(),
      );
      expect(existsSync(manifestPath)).toBe(true);
      const installedBytes = readFileSync(mergeHeadPath, "utf8");

      // Divergence refuses without clobber: op state that no longer matches
      // what Beam installed is the user's, not ours to overwrite.
      writeFileSync(mergeHeadPath, `${f.mainSha}\n`);
      await expect(cmdDown([record.id])).rejects.toThrow(/no longer matches the operation state/);
      expect(readFileSync(mergeHeadPath, "utf8")).toBe(`${f.mainSha}\n`);
      expect(existsSync(join(remoteCwd, ".git"))).toBe(true);

      // Back to exactly what Beam installed (and a repaired remote): the
      // retry recognizes its own partial install and converges.
      writeFileSync(mergeHeadPath, installedBytes);
      writeFileSync(join(remoteCwd, ".git", "ORIG_HEAD"), remoteOrigHead);
      await cmdDown([record.id]);
      expect(readFileSync(mergeHeadPath, "utf8").trim()).toBe(f.otherSha);
      expect((await git(localCwd, "status", "--porcelain=v1")).stdout).toBe(remoteStatus);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("down");
      expect(existsSync(remoteCwd)).toBe(false);

      // The returned operation is actionable.
      expect((await run(["git", "-C", localCwd, "merge", "--abort"])).code).toBe(0);
    },
    60_000,
  );

  test(
    "a partial install whose remote later aborted deletes exactly the stale Beam-installed markers and converges",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      const markerPath = async (name: string) =>
        resolve(localCwd, (await git(localCwd, "rev-parse", "--git-path", name)).stdout.trim());

      // Remote agent leaves a conflicted merge in flight; a poisoned
      // ORIG_HEAD makes the first down die mid-install — a genuine partial
      // install with MERGE_HEAD and MERGE_MSG already landed locally.
      expect((await run(["git", "-C", remoteCwd, "merge", "other"], { env: GIT_ENV })).code).not.toBe(0);
      const remoteOrigHead = readFileSync(join(remoteCwd, ".git", "ORIG_HEAD"), "utf8");
      writeFileSync(join(remoteCwd, ".git", "ORIG_HEAD"), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n");
      await expect(cmdDown([record.id])).rejects.toThrow();
      const mergeHeadPath = await markerPath("MERGE_HEAD");
      const mergeMsgPath = await markerPath("MERGE_MSG");
      expect(existsSync(mergeHeadPath)).toBe(true);
      expect(existsSync(mergeMsgPath)).toBe(true);

      // The remote finishes its side: the merge is aborted, so the
      // authoritative snapshot no longer carries any merge marker.
      writeFileSync(join(remoteCwd, ".git", "ORIG_HEAD"), remoteOrigHead);
      await git(remoteCwd, "merge", "--abort");
      const remoteStatus = (await git(remoteCwd, "status", "--porcelain=v1")).stdout;
      const remoteOrigHeadFinal = readFileSync(join(remoteCwd, ".git", "ORIG_HEAD"), "utf8");

      // The retry recognizes its own stale install, deletes it, and
      // converges local operation state exactly to the remote snapshot.
      await cmdDown([record.id]);
      expect(existsSync(mergeHeadPath)).toBe(false);
      expect(existsSync(mergeMsgPath)).toBe(false);
      expect(readFileSync(await markerPath("ORIG_HEAD"), "utf8")).toBe(remoteOrigHeadFinal);
      expect((await git(localCwd, "status", "--porcelain=v1")).stdout).toBe(remoteStatus);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("down");
      expect(existsSync(remoteCwd)).toBe(false);

      // The manifest was superseded atomically: it names what the LAST
      // attempt installed (ORIG_HEAD), never the deleted merge markers.
      const manifest = readFileSync(await markerPath(installedOpStateFile(record.id)), "utf8");
      expect(manifest).toMatch(/^[0-9a-f]{64} ORIG_HEAD$/m);
      expect(manifest).not.toContain(" MERGE_HEAD");
      expect(manifest).not.toContain(" MERGE_MSG");
    },
    60_000,
  );

  test(
    "a stale marker that diverged from the prior install refuses the delete with every marker byte-for-byte intact",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      const markerPath = async (name: string) =>
        resolve(localCwd, (await git(localCwd, "rev-parse", "--git-path", name)).stdout.trim());

      // Partial install (poisoned ORIG_HEAD), then the remote aborts: the
      // locally installed MERGE_HEAD and MERGE_MSG are now stale.
      expect((await run(["git", "-C", remoteCwd, "merge", "other"], { env: GIT_ENV })).code).not.toBe(0);
      const remoteOrigHead = readFileSync(join(remoteCwd, ".git", "ORIG_HEAD"), "utf8");
      writeFileSync(join(remoteCwd, ".git", "ORIG_HEAD"), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n");
      await expect(cmdDown([record.id])).rejects.toThrow();
      writeFileSync(join(remoteCwd, ".git", "ORIG_HEAD"), remoteOrigHead);
      await git(remoteCwd, "merge", "--abort");

      // The user edits MERGE_MSG — a non-marker op-state file the prepare
      // guard does not police. It is theirs now; the delete must refuse.
      const mergeHeadPath = await markerPath("MERGE_HEAD");
      const mergeMsgPath = await markerPath("MERGE_MSG");
      const installedMergeHead = readFileSync(mergeHeadPath, "utf8");
      const installedMergeMsg = readFileSync(mergeMsgPath, "utf8");
      writeFileSync(mergeMsgPath, `${installedMergeMsg}user note\n`);

      await expect(cmdDown([record.id])).rejects.toThrow(/remote no longer carries MERGE_MSG/);
      // Byte-for-byte refusal — including MERGE_HEAD, which matched its
      // recorded digest and sorts before MERGE_MSG: divergence anywhere
      // refuses BEFORE the first deletion.
      expect(readFileSync(mergeHeadPath, "utf8")).toBe(installedMergeHead);
      expect(readFileSync(mergeMsgPath, "utf8")).toBe(`${installedMergeMsg}user note\n`);
      expect(existsSync(join(remoteCwd, ".git"))).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");

      // Restoring exactly what Beam installed lets the retry converge.
      writeFileSync(mergeMsgPath, installedMergeMsg);
      await cmdDown([record.id]);
      expect(existsSync(mergeHeadPath)).toBe(false);
      expect(existsSync(mergeMsgPath)).toBe(false);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("down");
      expect(existsSync(remoteCwd)).toBe(false);
    },
    60_000,
  );

  test(
    "a down with no remote operation state publishes an empty manifest",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      await cmdDown([record.id]);
      const manifestPath = resolve(
        localCwd,
        (await git(localCwd, "rev-parse", "--git-path", installedOpStateFile(record.id))).stdout.trim(),
      );
      expect(existsSync(manifestPath)).toBe(true);
      expect(readFileSync(manifestPath, "utf8")).toBe("");
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("down");
    },
    60_000,
  );
});

describe.skipIf(!HAVE_DEPS)("importWorktreeGitReturn op-state reconciliation (local transport)", () => {
  let iso: IsolatedBeam;
  beforeAll(() => {
    iso = isolatedBeam("wtrecon");
  });
  afterAll(() => restoreBeam(iso));

  test(
    "an idempotent retry converges directory op-state, and a remote abort clears it under an empty manifest",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      const t = new LocalTransport(iso.remoteHome);
      const markerPath = async (name: string) =>
        resolve(localCwd, (await git(localCwd, "rev-parse", "--git-path", name)).stdout.trim());

      // Remote agent leaves a conflicted rebase in flight: op state here is
      // a DIRECTORY (rebase-merge) plus ORIG_HEAD.
      expect((await run(["git", "-C", remoteCwd, "rebase", "other"], { env: GIT_ENV })).code).not.toBe(0);
      expect(existsSync(join(remoteCwd, ".git", "rebase-merge"))).toBe(true);

      // First full import installs the rebase state and its manifest.
      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);
      const ret1 = await importWorktreeGitReturn(t, record);
      expect(ret1.notes.some((n) => n.includes("operation state restored"))).toBe(true);
      const rebaseDir = await markerPath("rebase-merge");
      const manifestPath = await markerPath(installedOpStateFile(record.id));
      expect(existsSync(rebaseDir)).toBe(true);
      expect(readFileSync(manifestPath, "utf8")).toMatch(/^[0-9a-f]{64} rebase-merge$/m);
      expect(readFileSync(manifestPath, "utf8")).toMatch(/^[0-9a-f]{64} ORIG_HEAD$/m);
      const manifest1 = readFileSync(manifestPath, "utf8");
      const status1 = (await git(localCwd, "status", "--porcelain=v1")).stdout;
      const rebaseState1 = dirManifest(rebaseDir);

      // Retry against an unchanged remote: byte-identical convergence — the
      // manifest, the installed directory, and the worktree do not drift.
      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);
      const ret2 = await importWorktreeGitReturn(t, record);
      expect(ret2.notes.some((n) => n.includes("operation state restored"))).toBe(true);
      expect(readFileSync(manifestPath, "utf8")).toBe(manifest1);
      expect(dirManifest(rebaseDir)).toBe(rebaseState1);
      expect((await git(localCwd, "status", "--porcelain=v1")).stdout).toBe(status1);

      // The remote aborts the rebase and drops every op-state entry: the
      // next retry deletes the stale Beam-installed directory and file and
      // publishes an EMPTY manifest — atomically superseding the prior one.
      await git(remoteCwd, "rebase", "--abort");
      rmSync(join(remoteCwd, ".git", "ORIG_HEAD"), { force: true });
      rmSync(join(remoteCwd, ".git", "AUTO_MERGE"), { force: true });
      rmSync(join(remoteCwd, ".git", "MERGE_MSG"), { force: true });
      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);
      const ret3 = await importWorktreeGitReturn(t, record);
      expect(ret3.notes.some((n) => n.includes("stale Beam-installed operation state cleared"))).toBe(true);
      expect(existsSync(rebaseDir)).toBe(false);
      expect(existsSync(await markerPath("ORIG_HEAD"))).toBe(false);
      expect(existsSync(manifestPath)).toBe(true);
      expect(readFileSync(manifestPath, "utf8")).toBe("");

      // Converged exactly to the remote snapshot: HEAD reattached to main
      // at the aborted position, and the worktree answers status cleanly.
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.mainSha);
      expect((await git(localCwd, "status", "--porcelain=v1")).stdout).toBe(
        (await git(remoteCwd, "status", "--porcelain=v1")).stdout,
      );
    },
    60_000,
  );
});

/** Byte-level manifest of every file under `dir`: sorted `relpath sha256` lines. */
function dirManifest(dir: string): string {
  const lines: string[] = [];
  for (const p of walk(dir)) {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(readFileSync(p));
    lines.push(`${p.slice(dir.length + 1)} ${hasher.digest("hex")}`);
  }
  return lines.sort().join("\n");
}

describe.skipIf(!HAVE_DEPS)("cmdDown refuses Git repository identity drift before mutation", () => {
  let iso: IsolatedBeam;
  beforeAll(() => {
    iso = isolatedBeam("wtdrift");
  });
  afterAll(() => restoreBeam(iso));

  test(
    "a standard checkout swapped for an unrelated linked worktree fails closed; restoring it collects normally",
    async () => {
      // Standard and linked layouts both ship through an isolated standalone
      // Git payload, with the source common-dir identity pinned on the record.
      const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtdrift-")));
      const localCwd = join(base, "work");
      mkdirSync(localCwd);
      await git(localCwd, "init", "-q", "-b", "main");
      writeFileSync(join(localCwd, "tracked.txt"), "standard checkout\n");
      await git(localCwd, "add", "-A");
      await git(localCwd, "commit", "-q", "-m", "standard base");

      process.chdir(localCwd);
      await cmdUp(["--no-session"]);
      process.chdir(base);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      expect(record.wtGit).toBeDefined();
      const remoteCwd = record.remoteCwd;
      expect(existsSync(join(remoteCwd, ".git", "HEAD"))).toBe(true);

      // Remote agent work a collect would bring home — it must NOT move here.
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");

      // Swap the checkout: move the shipped standard repo aside and put a
      // linked worktree of an UNRELATED repository at the exact recorded path.
      const aside = join(base, "aside");
      renameSync(localCwd, aside);
      const unrelated = join(base, "unrelated");
      mkdirSync(unrelated);
      await git(unrelated, "init", "-q", "-b", "main");
      writeFileSync(join(unrelated, "innocent.txt"), "unrelated repo\n");
      await git(unrelated, "add", "-A");
      await git(unrelated, "commit", "-q", "-m", "unrelated base");
      await git(unrelated, "branch", "drift");
      await git(unrelated, "worktree", "add", "-q", localCwd, "drift");
      expect(isLinkedWorktree(localCwd)).toBe(true);

      const recordBytes = JSON.stringify(record);
      const unrelatedBefore = dirManifest(unrelated);
      const swappedBefore = dirManifest(localCwd);
      const asideBefore = dirManifest(aside);
      const remoteBefore = dirManifest(remoteCwd);

      // The pinned common Git dir catches repository drift before backups,
      // syncDown, session import, Git mutation, or purge.
      await expect(cmdDown([record.id])).rejects.toThrow(/different repository/);

      // Byte/state intact everywhere: the unrelated repository (common dir
      // AND its worktree at the recorded path), the moved-aside original,
      // the remote workspace, and the record — no backup refs, no status
      // transition, no purge.
      expect(dirManifest(unrelated)).toBe(unrelatedBefore);
      expect(dirManifest(localCwd)).toBe(swappedBefore);
      expect(dirManifest(aside)).toBe(asideBefore);
      expect(dirManifest(remoteCwd)).toBe(remoteBefore);
      expect((await git(unrelated, "for-each-ref", "refs/beam")).stdout).toBe("");
      const after = loadState(resolveEnv()).records.find((r) => r.id === record.id)!;
      expect(JSON.stringify(after)).toBe(recordBytes);
      expect(after.status).toBe("up");

      // Restore the shipped checkout: the quarantined Git return collects
      // normally — remote work home, remote purged, record closed.
      await git(unrelated, "worktree", "remove", "--force", localCwd);
      renameSync(aside, localCwd);
      await cmdDown([record.id]);
      expect(readFileSync(join(localCwd, "remote-new.txt"), "utf8")).toBe("made remotely\n");
      expect((await git(localCwd, "show", "-s", "--format=%s", "HEAD")).stdout.trim()).toBe("remote work");
      expect(existsSync(remoteCwd)).toBe(false);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("down");
    },
    60_000,
  );
});

/*
 * ------------------------------------------------------------------------
 * P1 regressions: same-path repository replacement, post-preparation
 * HEAD/index movement, and unborn-repository handoffs.
 * ------------------------------------------------------------------------
 */

describe.skipIf(!HAVE_DEPS)("cmdDown refuses same-path repository replacement (identity, not pathname)", () => {
  let iso: IsolatedBeam;
  beforeAll(() => {
    iso = isolatedBeam("wtsamepath");
  });
  afterAll(() => restoreBeam(iso));

  test(
    "a standard checkout replaced by another standard checkout at the exact pathname fails closed; the original, renamed back, collects normally",
    async () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtsame-")));
      const localCwd = join(base, "work");
      mkdirSync(localCwd);
      await git(localCwd, "init", "-q", "-b", "main");
      writeFileSync(join(localCwd, "tracked.txt"), "original checkout\n");
      await git(localCwd, "add", "-A");
      await git(localCwd, "commit", "-q", "-m", "original base");

      process.chdir(localCwd);
      await cmdUp(["--no-session"]);
      process.chdir(base);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      expect(record.wtGit).toBeDefined();
      expect(record.wtGit!.commonDir).toBe(join(localCwd, ".git"));
      expect(record.wtGit!.worktreeGitDir).toBe(join(localCwd, ".git"));

      // Ship-time identity: device+inode of the (standard) git dir ride the
      // record as JSON STRINGS — number-typed values would round through
      // JSON floats and silently lose precision on 64-bit inodes.
      const gitDirStat = statSync(join(localCwd, ".git"), { bigint: true });
      const shipJson = JSON.stringify(record.wtGit);
      expect(shipJson).toContain(`"${gitDirStat.ino}"`);
      expect(shipJson).toContain(`"${gitDirStat.dev}"`);

      // Remote agent work a collect would bring home — it must NOT move into
      // the impostor.
      const remoteCwd = record.remoteCwd;
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");

      // Replace the repository AT THE SAME PATHNAME: the impostor's common
      // git dir string- and realpath-compares equal to the shipped one —
      // only the device+inode identity can tell them apart.
      const aside = join(base, "aside");
      renameSync(localCwd, aside);
      mkdirSync(localCwd);
      await git(localCwd, "init", "-q", "-b", "main");
      writeFileSync(join(localCwd, "tracked.txt"), "impostor checkout\n");
      await git(localCwd, "add", "-A");
      await git(localCwd, "commit", "-q", "-m", "impostor base");

      const recordBytes = JSON.stringify(record);
      const impostorBefore = dirManifest(localCwd);
      const asideBefore = dirManifest(aside);
      const remoteBefore = dirManifest(remoteCwd);

      await expect(cmdDown([record.id])).rejects.toThrow(/different repository/);

      // Refused before ANY effect: impostor, moved-aside original, and the
      // remote are byte-identical; no backup refs landed anywhere; the
      // record did not transition.
      expect(dirManifest(localCwd)).toBe(impostorBefore);
      expect(dirManifest(aside)).toBe(asideBefore);
      expect(dirManifest(remoteCwd)).toBe(remoteBefore);
      expect((await git(localCwd, "for-each-ref", "refs/beam")).stdout).toBe("");
      const after = loadState(resolveEnv()).records.find((r) => r.id === record.id)!;
      expect(JSON.stringify(after)).toBe(recordBytes);
      expect(after.status).toBe("up");

      // rename preserves inodes: moving the ORIGINAL repository back to the
      // recorded path restores the shipped identity, and the down collects.
      rmSync(localCwd, { recursive: true, force: true });
      renameSync(aside, localCwd);
      await cmdDown([record.id]);
      expect((await git(localCwd, "show", "-s", "--format=%s", "HEAD")).stdout.trim()).toBe("remote work");
      expect(existsSync(remoteCwd)).toBe(false);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("down");
    },
    60_000,
  );

  test(
    "a linked worktree whose common-dir pathname is reused by an unrelated repository fails closed; the original pair collects after moving back",
    async () => {
      const f = await makeReturnFixture();
      // This worktree's own git dir, resolved before any move: the second
      // identity the ship must pin alongside the common dir.
      const wtGitDir = resolve(f.wt, (await git(f.wt, "rev-parse", "--git-dir")).stdout.trim());

      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      process.chdir(f.base);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      expect(record.wtGit).toBeDefined();
      expect(record.wtGit!.commonDir).toBe(f.commonGit);
      expect(record.wtGit!.worktreeGitDir).toBe(wtGitDir);

      // BOTH identities ride the record as strings: the shared common dir
      // and the worktree-level git dir.
      const commonStat = statSync(f.commonGit, { bigint: true });
      const wtStat = statSync(wtGitDir, { bigint: true });
      const shipJson = JSON.stringify(record.wtGit);
      expect(shipJson).toContain(`"${commonStat.ino}"`);
      expect(shipJson).toContain(`"${wtStat.ino}"`);
      expect(shipJson).toContain(`"${commonStat.dev}"`);

      const remoteCwd = record.remoteCwd;
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");

      // Reuse BOTH pathnames with an unrelated repository: a bare clone at
      // the exact common-dir path, a linked worktree at the exact checkout
      // path — every recorded pathname resolves, none is the shipped repo.
      const commonAside = join(f.base, "common-aside.git");
      const wtAside = join(f.base, "wt-aside");
      renameSync(f.commonGit, commonAside);
      renameSync(localCwd, wtAside);
      const seed2 = join(f.base, "seed2");
      mkdirSync(seed2);
      await git(seed2, "init", "-q", "-b", "main");
      writeFileSync(join(seed2, "innocent.txt"), "unrelated repo\n");
      await git(seed2, "add", "-A");
      await git(seed2, "commit", "-q", "-m", "unrelated base");
      await runChecked(["git", "clone", "-q", "--bare", seed2, f.commonGit], { env: GIT_ENV });
      rmSync(seed2, { recursive: true, force: true });
      await git(f.commonGit, "worktree", "add", "-q", localCwd, "main");
      expect(isLinkedWorktree(localCwd)).toBe(true);

      const recordBytes = JSON.stringify(record);
      const impostorCommonBefore = dirManifest(f.commonGit);
      const impostorWtBefore = dirManifest(localCwd);
      const commonAsideBefore = dirManifest(commonAside);
      const wtAsideBefore = dirManifest(wtAside);
      const remoteBefore = dirManifest(remoteCwd);

      await expect(cmdDown([record.id])).rejects.toThrow(/different repository/);

      // Byte/state intact everywhere: the impostor pair, the moved-aside
      // originals, the remote workspace, and the record.
      expect(dirManifest(f.commonGit)).toBe(impostorCommonBefore);
      expect(dirManifest(localCwd)).toBe(impostorWtBefore);
      expect(dirManifest(commonAside)).toBe(commonAsideBefore);
      expect(dirManifest(wtAside)).toBe(wtAsideBefore);
      expect(dirManifest(remoteCwd)).toBe(remoteBefore);
      expect((await git(f.commonGit, "for-each-ref", "refs/beam")).stdout).toBe("");
      const after = loadState(resolveEnv()).records.find((r) => r.id === record.id)!;
      expect(JSON.stringify(after)).toBe(recordBytes);
      expect(after.status).toBe("up");

      // Move the real pair back (inodes intact): the down collects normally.
      await git(f.commonGit, "worktree", "remove", "--force", localCwd);
      rmSync(f.commonGit, { recursive: true, force: true });
      renameSync(commonAside, f.commonGit);
      renameSync(wtAside, localCwd);
      await cmdDown([record.id]);
      expect((await git(localCwd, "show", "-s", "--format=%s", "HEAD")).stdout.trim()).toBe("remote work");
      expect(existsSync(remoteCwd)).toBe(false);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("down");
    },
    60_000,
  );

  test(
    "a record lacking ship-time identity refuses the return before any mutation",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      process.chdir(f.base);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // Rewrite the record to the legacy WtGitShipInfo shape (head, branch,
      // commonDir — no device/inode identity), exactly what an older beam
      // persisted. Every pathname still matches perfectly; only the identity
      // is absent, and absent identity must never be treated as a match.
      const env = resolveEnv();
      const statePath = join(env.beamDir, "state.json");
      const state = JSON.parse(readFileSync(statePath, "utf8")) as {
        records: Array<{ id: string; wtGit?: unknown }>;
      };
      state.records.find((r) => r.id === record.id)!.wtGit = {
        head: f.mainSha,
        branch: "refs/heads/main",
        commonDir: f.commonGit,
      };
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

      const localBefore = dirManifest(f.base); // covers common.git AND the worktree
      const remoteBefore = dirManifest(remoteCwd);

      await expect(cmdDown([record.id])).rejects.toThrow(/carries no ship-time repository identity/);

      expect(dirManifest(f.base)).toBe(localBefore);
      expect(dirManifest(remoteCwd)).toBe(remoteBefore);
      expect((await git(f.commonGit, "for-each-ref", "refs/beam")).stdout).toBe("");
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
    },
    60_000,
  );
});

describe.skipIf(!HAVE_DEPS)("cmdDown refuses post-preparation local HEAD and index movement (local transport)", () => {
  let iso: IsolatedBeam;
  beforeAll(() => {
    iso = isolatedBeam("wtclob");
  });
  afterAll(() => restoreBeam(iso));

  test(
    "detached HEAD and index moved between a failed prepared down and its retry survive the refusal byte-for-byte",
    async () => {
      const f = await makeReturnFixture();
      await git(f.wt, "checkout", "-q", "--detach");
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // Remote work on the detached HEAD, then a hidden loose object: the
      // first down prepares (durable pre-return snapshot taken), mirrors the
      // workspace, and dies at the collection fsck — before any local git
      // mutation.
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const remoteSha = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();
      const objPath = join(remoteCwd, ".git", "objects", remoteSha.slice(0, 2), remoteSha.slice(2));
      renameSync(objPath, `${objPath}.hidden`);
      await expect(cmdDown([record.id])).rejects.toThrow();
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.mainSha);

      // Concurrent local work AFTER the snapshot: the user commits on the
      // detached HEAD and stages fresh content.
      writeFileSync(join(localCwd, "local-work.txt"), "concurrent local work\n");
      await git(localCwd, "add", "local-work.txt");
      await git(localCwd, "commit", "-q", "-m", "local work while beamed");
      const userSha = (await git(localCwd, "rev-parse", "HEAD")).stdout.trim();
      writeFileSync(join(localCwd, "staged-after-prep.txt"), "staged after preparation\n");
      await git(localCwd, "add", "staged-after-prep.txt");
      const stagedBlob = (await git(localCwd, "rev-parse", ":staged-after-prep.txt")).stdout.trim();

      // Remote repaired: the ONLY obstacle left is the local movement.
      renameSync(`${objPath}.hidden`, objPath);
      const statusBefore = (await git(localCwd, "status", "--porcelain=v1")).stdout;

      await expect(cmdDown([record.id])).rejects.toThrow(/local (HEAD moved|index changed) after this return was prepared/);

      // Byte-for-byte survival: the user's commit is still HEAD, the staged
      // blob is still staged, nothing transitioned, the remote is intact for
      // a later retry.
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(userSha);
      expect((await git(localCwd, "rev-parse", ":staged-after-prep.txt")).stdout.trim()).toBe(stagedBlob);
      expect((await git(localCwd, "status", "--porcelain=v1")).stdout).toBe(statusBefore);
      expect(existsSync(join(remoteCwd, ".git"))).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");

      // The user restores the snapshotted state — their work stays reachable
      // as objects — and the retry converges on the remote result.
      await git(localCwd, "reset", "-q", "--hard", f.mainSha);
      await cmdDown([record.id]);
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(remoteSha);
      expect(readFileSync(join(localCwd, "remote-new.txt"), "utf8")).toBe("made remotely\n");
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", userSha])).code).toBe(0);
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", stagedBlob])).code).toBe(0);
      expect(existsSync(remoteCwd)).toBe(false);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("down");
    },
    60_000,
  );

  test(
    "a retry accepts exactly the Beam-installed partial import and refuses local movement past it",
    async () => {
      const f = await makeReturnFixture();
      await git(f.wt, "checkout", "-q", "--detach");
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // Remote: a commit on the detached HEAD plus a staged-only blob, then
      // a poisoned MERGE_HEAD naming an object that does not exist. The first
      // down installs the remote HEAD and index locally, then dies at the
      // op-state SHA check — a genuine partial Beam install.
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const remoteSha = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();
      writeFileSync(join(remoteCwd, "staged-remote.txt"), "remote staged blob\n");
      await git(remoteCwd, "add", "staged-remote.txt");
      writeFileSync(join(remoteCwd, ".git", "MERGE_HEAD"), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n");
      await expect(cmdDown([record.id])).rejects.toThrow();
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(remoteSha);
      expect((await git(localCwd, "show", ":staged-remote.txt")).stdout).toBe("remote staged blob\n");

      // The user moves HEAD past the Beam-installed position before the
      // retry: that movement is theirs, never Beam's to overwrite.
      await git(localCwd, "commit", "-q", "-m", "local commit on top of the partial install");
      const userSha = (await git(localCwd, "rev-parse", "HEAD")).stdout.trim();
      rmSync(join(remoteCwd, ".git", "MERGE_HEAD"));
      const statusBefore = (await git(localCwd, "status", "--porcelain=v1")).stdout;

      await expect(cmdDown([record.id])).rejects.toThrow(/local HEAD moved after this return was prepared/);
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(userSha);
      expect((await git(localCwd, "status", "--porcelain=v1")).stdout).toBe(statusBefore);
      expect(existsSync(join(remoteCwd, ".git"))).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");

      // Back to exactly the state the prior import published as its own —
      // move detached HEAD by ref CAS so the index stays put and no reset
      // creates a new local ORIG_HEAD operation marker.
      await git(localCwd, "update-ref", "--no-deref", "HEAD", remoteSha, userSha);
      await cmdDown([record.id]);
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(remoteSha);
      expect((await git(localCwd, "show", ":staged-remote.txt")).stdout).toBe("remote staged blob\n");
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", userSha])).code).toBe(0);
      expect(existsSync(remoteCwd)).toBe(false);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("down");
    },
    60_000,
  );
});

describe.skipIf(!HAVE_DEPS)("unborn repository handoff round trip (local transport)", () => {
  let iso: IsolatedBeam;
  beforeAll(() => {
    iso = isolatedBeam("wtunborn");
  });
  afterAll(() => restoreBeam(iso));

  /**
   * Fresh attached-unborn checkout: staged text, a staged binary file, a
   * staged-only blob (index content that exists in NO working tree), and an
   * untracked file. Everything staged diffs against the empty tree.
   */
  async function makeUnbornFixture(): Promise<{ base: string; localCwd: string }> {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtunborn-")));
    const localCwd = join(base, "work");
    mkdirSync(localCwd);
    await git(localCwd, "init", "-q", "-b", "main");
    writeFileSync(join(localCwd, "a.txt"), "unborn text v1\n");
    writeFileSync(join(localCwd, "bin.dat"), Buffer.from([0, 1, 2, 255, 0, 7, 3]));
    await git(localCwd, "add", "a.txt", "bin.dat");
    writeFileSync(join(localCwd, "staged-only.txt"), "staged v1\n");
    await git(localCwd, "add", "staged-only.txt");
    writeFileSync(join(localCwd, "staged-only.txt"), "working v2\n");
    writeFileSync(join(localCwd, "untracked.txt"), "not added\n");
    return { base, localCwd };
  }

  test(
    "an attached unborn repository ships with its staged text and binary content and returns still unborn, index intact",
    async () => {
      const { base, localCwd } = await makeUnbornFixture();
      const localStatus = (await git(localCwd, "status", "--porcelain=v1")).stdout;
      const localIndex = (await git(localCwd, "ls-files", "--stage")).stdout;

      process.chdir(localCwd);
      await cmdUp(["--no-session"]);
      process.chdir(base);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      expect(record.wtGit).toBeDefined();
      // Unborn HEAD is representable: no ship-time commit, attached branch.
      expect(record.wtGit!.head).toBeUndefined();
      expect(record.wtGit!.branch).toBe("refs/heads/main");
      const remoteCwd = record.remoteCwd;

      // The remote is the same attached-unborn repository: HEAD on main with
      // no commit, and an index whose entries (mode+sha+path — binary bytes
      // included) match the local one exactly. The staged-only blob proves
      // the INDEX travelled: its staged content exists in neither working
      // tree.
      expect((await git(remoteCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await run(["git", "-C", remoteCwd, "rev-parse", "--verify", "-q", "HEAD"])).code).not.toBe(0);
      expect((await git(remoteCwd, "status", "--porcelain=v1")).stdout).toBe(localStatus);
      expect((await git(remoteCwd, "ls-files", "--stage")).stdout).toBe(localIndex);
      expect((await git(remoteCwd, "show", ":staged-only.txt")).stdout).toBe("staged v1\n");

      // Remote agent work that stays uncommitted: one more staged blob.
      writeFileSync(join(remoteCwd, "remote-staged.txt"), "remote staged\n");
      await git(remoteCwd, "add", "remote-staged.txt");
      const remoteStatus = (await git(remoteCwd, "status", "--porcelain=v1")).stdout;
      const remoteIndex = (await git(remoteCwd, "ls-files", "--stage")).stdout;

      await cmdDown([record.id]);

      // Still unborn, still attached to main; the returned index is the
      // remote's final one, binary entry and staged-only blob intact.
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", "HEAD"])).code).not.toBe(0);
      expect((await git(localCwd, "status", "--porcelain=v1")).stdout).toBe(remoteStatus);
      expect((await git(localCwd, "ls-files", "--stage")).stdout).toBe(remoteIndex);
      expect((await git(localCwd, "show", ":remote-staged.txt")).stdout).toBe("remote staged\n");
      expect((await git(localCwd, "show", ":staged-only.txt")).stdout).toBe("staged v1\n");
      expect(existsSync(remoteCwd)).toBe(false);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("down");
    },
    60_000,
  );

  test(
    "the remote's first commit on a shipped unborn branch comes home: main born locally, HEAD attached at it",
    async () => {
      const { base, localCwd } = await makeUnbornFixture();
      process.chdir(localCwd);
      await cmdUp(["--no-session"]);
      process.chdir(base);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      await git(remoteCwd, "commit", "-q", "-m", "first commit");
      const bornSha = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();
      const remoteStatus = (await git(remoteCwd, "status", "--porcelain=v1")).stdout;

      await cmdDown([record.id]);

      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(bornSha);
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(bornSha);
      expect((await git(localCwd, "status", "--porcelain=v1")).stdout).toBe(remoteStatus);
      expect((await git(localCwd, "show", "HEAD:staged-only.txt")).stdout).toBe("staged v1\n");
      expect(existsSync(remoteCwd)).toBe(false);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("down");
    },
    60_000,
  );
});
