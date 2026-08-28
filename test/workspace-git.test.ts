/**
 * Goal: linked-worktree Git state ships and returns faithfully — the
 * bare-common layout's refs, config (travel vs stay-home keys), and
 * staged/unstaged/untracked state survive `beam up`, sibling worktrees
 * stay isolated, in-progress operations and sparse layouts refuse before
 * any remote effect, and `beam down` quarantines each collection under a
 * fingerprint-proven namespace that rejects identity drift, same-path
 * replacement, and unsupported collected layouts; `sanitizedGitEnv`
 * strips caller-injected GIT_* variables, digests stream with bounded
 * reads, and remote proof entry counts are bounded.
 *
 * Method: build REAL git repositories with the git binary (a bare common
 * dir plus two linked worktrees carrying staged-only blobs, staged
 * deletions, a staged binary, and sibling-only content), drive
 * `cmdUp`/`cmdDown` over a LocalTransport in mkdtemp BEAM_HOME fixtures,
 * and compare byte-level sha256 manifests of every file; suites are
 * `describe.skipIf`-gated on git/rsync with explicit timeouts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  chmodSync,
  cpSync,
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
import { dirname, join, resolve } from "node:path";
import { cmdUp } from "../src/commands/up.ts";
import { cmdDown } from "../src/commands/down.ts";
import { resolveEnv } from "../src/env.ts";
import { loadState, updateRecord, type BeamRecord } from "../src/state.ts";
import { LocalTransport } from "../src/transport/local.ts";
import type { SyncOptions, Transport } from "../src/transport/types.ts";
import { run, runChecked, shq } from "../src/util/shell.ts";
import { fileSha256 } from "../src/util/digest.ts";
import {
  importWorktreeGitReturn,
  bindReturnRepo,
  collectedGitTreeFingerprint,
  gitPayloadPath,
  importObjects,
  importObjectsTestSeam,
  isLinkedWorktree,
  isGitWorktree,
  materializeWorktreeGit,
  materializeTestSeam,
  prepareWorktreeGitReturn,
  returnObjectPinRef,
  remoteGitTreeFingerprint,
  returnQbase,
  returnReflogPinRef,
  returnReflogRef,
  returnValueRef,
  sanitizedGitEnv,
  pinIncomingCheckoutTestSeam,
  worktreeGitReturnKey,
  type ReturnValueKind,
  type WtGitShipInfo,
  SHIPPED_STASH_LOG_FILE,
} from "../src/workspace-git.ts";
import { gatherExcludes, remoteWorkspaceName } from "../src/workspace.ts";

const HAVE_DEPS = Bun.which("git") !== null && Bun.which("rsync") !== null;


/** A record's Git-return identity: everything the quarantine paths need. */
interface GitReturnRecord {
  id: string;
  remoteCwd: string;
  wtGit?: WtGitShipInfo;
}

/**
 * Collected-fingerprint namespace key of the record's CURRENT retained
 * remote payload. Valid for assertions after a SUCCESSFUL down: its final
 * remote proof pins collected == remote. Multi-attempt tests must capture
 * the digest per attempt (the remote may have moved between collections).
 */
function qdigestOf(record: GitReturnRecord): string {
  return collectedGitTreeFingerprint(payloadOf(record)).digest;
}

/**
 * Remote Git payload dir of the record's published generation — `.git` at
 * the workspace root is a gitdir pointer FILE, never a directory.
 */
function payloadOf(record: GitReturnRecord): string {
  return join(record.remoteCwd, gitPayloadPath(record.wtGit!.generation!));
}

/** This record's current per-collection quarantine namespace. */
function qbaseOf(record: GitReturnRecord): string {
  return returnQbase(worktreeGitReturnKey(record.id, record.wtGit), qdigestOf(record));
}

/** Quarantine value ref of `sourceRef` in the record's current collection namespace. */
function qval(record: GitReturnRecord, kind: ReturnValueKind, sourceRef: string): string {
  const key = worktreeGitReturnKey(record.id, record.wtGit);
  return returnValueRef(key, qdigestOf(record), kind, sourceRef);
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  // Auto-maintenance detaches from the fixture command that triggered it
  // and drops a transient .git/objects/maintenance.lock the byte-level
  // manifests here can catch mid-flight (observed on a slow macOS CI
  // runner). Fixture repos never need maintenance; pin it off wholesale.
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
  GIT_CONFIG_KEY_2: "gc.autoDetach",
  GIT_CONFIG_VALUE_2: "false",
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

/** Every regular file under `dir` — explicit stack, no recursion (Tiger Safety 2). */
const MAX_WALK_DIRS = 10_000;
function* walk(dir: string): Generator<string> {
  const stack: string[] = [dir];
  let visitedDirCount = 0;
  while (stack.length > 0) {
    visitedDirCount += 1;
    if (visitedDirCount > MAX_WALK_DIRS) {
      throw new Error(`walk: ${dir} holds more than ${MAX_WALK_DIRS} directories`);
    }
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const p = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (entry.isFile()) {
        yield p;
      }
    }
  }
}

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

  /**
   * Shipped Git metadata carries no trace of this machine's layout: no
   * sibling checkouts, no reflogs, no fetch state, no local paths.
   */
  function assertNoMachineLayout(gitDir: string, localBase: string): void {
    expect(existsSync(join(gitDir, "worktrees"))).toBe(false);
    expect(existsSync(join(gitDir, "logs"))).toBe(false);
    expect(existsSync(join(gitDir, "FETCH_HEAD"))).toBe(false);
    for (const file of walk(gitDir)) {
      expect(readFileSync(file).toString("utf8")).not.toContain(localBase);
    }
  }

  /**
   * Remotes/branch/user/custom config traveled — including the multi-line
   * and multi-valued entries — and machine-layout keys stayed home.
   */
  async function assertConfigTraveled(remote: string): Promise<void> {
    const origin = (await git(remote, "config", "remote.origin.url")).stdout.trim();
    expect(origin).toBe("https://example.invalid/beam.git");
    expect((await git(remote, "config", "user.name")).stdout.trim()).toBe("Repo User");
    const merge = (await git(remote, "config", "branch.main.merge")).stdout.trim();
    expect(merge).toBe("refs/heads/main");
    expect((await git(remote, "config", "beam.note")).stdout).toBe("line one\nline two\n");
    const multi = (await git(remote, "config", "--get-all", "beam.multi")).stdout;
    expect(multi).toBe("first\nsecond\n");
    // --local: CI runners set safe.directory in the GLOBAL config
    // (actions/checkout), and an unscoped lookup reads every scope — the
    // assertion is about what traveled in the shipped repo config only.
    expect((await run(["git", "-C", remote, "config", "--local", "core.hooksPath"])).code).not.toBe(
      0,
    );
    expect(
      (await run(["git", "-C", remote, "config", "--local", "safe.directory"])).code,
    ).not.toBe(0);
  }

  /**
   * Local file URLs and path-valued keys in every leak form, plus every
   * credential carrier: headers, helpers, URL userinfo, SMTP, token query
   * keys, and the `ext::` remote-helper escape hatch.
   */
  async function seedLeakyConfig(commonGit: string): Promise<void> {
    await git(commonGit, "config", "submodule.libs.url", "/abs/path/libs");
    await git(commonGit, "config", "submodule.net.url", "https://example.invalid/libs.git");
    await git(commonGit, "config", "url./Users/mirror/.insteadOf", "https://github.com/");
    await git(commonGit, "config", "url.https://mirror.example/.insteadOf", "/Users/base");
    await git(commonGit, "config", "url.https://a.example/.insteadOf", "https://b.example/");
    await git(commonGit, "config", "remote.rel.url", "sub/repo");
    await git(commonGit, "config", "remote.homey.url", "~/repos/x");
    await git(commonGit, "config", "remote.scp.url", "gh.example.invalid:me/repo.git");
    await git(
      commonGit,
      "config",
      "http.https://example.invalid.extraHeader",
      "Authorization: Bearer header-secret",
    );
    await git(commonGit, "config", "credential.helper", "!printf credential-secret");
    await git(
      commonGit,
      "config",
      "remote.auth.url",
      "https://oauth2:url-secret@example.invalid/private.git",
    );
    await git(
      commonGit,
      "config",
      "submodule.auth.url",
      "https://user:submodule-secret@example.invalid/lib.git",
    );
    await git(commonGit, "config", "sendemail.smtpPass", "smtp-secret");
    // Bare `token`/`private_token` query keys are credentials too — not
    // only the access_token spelling.
    await git(
      commonGit,
      "config",
      "remote.qtok.url",
      "https://example.invalid/q.git?token=query-secret-tok",
    );
    await git(
      commonGit,
      "config",
      "remote.qpriv.url",
      "https://example.invalid/q.git?private_token=query-secret-priv",
    );
    // Remote-helper syntax: `ext::` executes an arbitrary command and the
    // address is opaque free text — no helper form may ship.
    await git(
      commonGit,
      "config",
      "remote.evil.url",
      "ext::sh -c 'tool --token ext-cmd-secret /abs/ext/path'",
    );
  }

  test(
    "normal files plus the exact materialized index reassemble into an identical standalone repo",
    async () => {
      writeFileSync(join(f.wtA, "intent.txt"), "intent-to-add stays logical\n");
      await git(f.wtA, "add", "-N", "intent.txt");
      const sourceStatus = (await git(f.wtA, "status", "--porcelain=v1")).stdout;
      expect(sourceStatus).not.toBe(""); // the fixture is genuinely dirty

      const m = await materializeWorktreeGit(f.wtA);
      try {
        assertNoMachineLayout(m.gitDir, f.base);

        // Reassemble a simulated remote exactly like cmdUp does: workspace
        // mirror without .git, then the standalone .git with its exact index.
        const rhome = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtsim-")));
        const t = new LocalTransport(rhome);
        const remote = join(rhome, "ws");
        await t.syncUp(f.wtA, remote, {
          excludes: gatherExcludes(f.wtA, { targets: {} }),
          delete: true,
        });
        expect(existsSync(join(remote, ".git"))).toBe(false); // pointer stayed home
        await t.syncUp(m.gitDir, `${remote}/.git`, { delete: true });

        // Same HEAD, same attached branch, byte-identical status.
        expect((await git(remote, "rev-parse", "HEAD")).stdout.trim()).toBe(f.c2);
        expect((await git(remote, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
        expect((await git(remote, "status", "--porcelain=v1")).stdout).toBe(sourceStatus);

        // The staged-only blob and the staged binary survived byte-for-byte.
        expect((await git(remote, "show", ":staged-only.txt")).stdout).toBe("staged blob v1\n");
        expect((await git(remote, "rev-parse", ":bin.dat")).stdout).toBe(
          (await git(f.wtA, "rev-parse", ":bin.dat")).stdout,
        );
        expect((await git(remote, "ls-files", "--stage", "intent.txt")).stdout).not.toBe("");

        // Every shared ref mirrored; origin/HEAD stayed symbolic.
        expect((await git(remote, "rev-parse", "refs/heads/feature")).stdout.trim()).toBe(f.c1);
        expect((await git(remote, "rev-parse", "refs/tags/t1")).stdout.trim()).toBe(f.c2);
        const originMain = (await git(remote, "rev-parse", "refs/remotes/origin/main")).stdout;
        expect(originMain.trim()).toBe(f.c2);
        expect((await git(remote, "symbolic-ref", "refs/remotes/origin/HEAD")).stdout.trim()).toBe(
          "refs/remotes/origin/main",
        );

        await assertConfigTraveled(remote);

        // Sibling checkout content never traveled.
        expect(existsSync(join(remote, "sibling-only.txt"))).toBe(false);

        // .beam/ is invisible to remote git status.
        expect(readFileSync(join(remote, ".git", "info", "exclude"), "utf8")).toContain(".beam/");
        mkdirSync(join(remote, ".beam"), { recursive: true });
        writeFileSync(join(remote, ".beam", "session.jsonl"), "{}\n");
        expect((await git(remote, "status", "--porcelain=v1")).stdout).toBe(sourceStatus);
      } finally {
        m.cleanup();
        await git(f.wtA, "reset", "-q", "--", "intent.txt");
        rmSync(join(f.wtA, "intent.txt"), { force: true });
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

        const rhome = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtsim-")));
        const t = new LocalTransport(rhome);
        const remote = join(rhome, "ws");
        await t.syncUp(f.wtB, remote, {
          excludes: gatherExcludes(f.wtB, { targets: {} }),
          delete: true,
        });
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
  }, 30_000);

  test(
    "a common dir borrowing objects through alternates ships self-contained — no alternates " +
      "file, no donor path, staged status and history survive donor removal",
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
      await runChecked(["git", "clone", "-q", "--bare", "--shared", donor, commonGit], {
        env: GIT_ENV,
      });
      expect(readFileSync(join(commonGit, "objects", "info", "alternates"), "utf8")).toContain(
        donor,
      );

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
    "path and credential-bearing config stay home; safe network forms travel; " +
      "the ref snapshot rides the payload",
    async () => {
      const f2 = await makeFixture();
      const commonGit = join(f2.base, "common.git");
      await seedLeakyConfig(commonGit);

      const m = await materializeWorktreeGit(f2.wtA);
      try {
        const cfg = async (key: string) =>
          run(["git", "--git-dir", m.gitDir, "config", "--local", "--get-all", key]);
        expect((await cfg("submodule.libs.url")).code).not.toBe(0);
        const net = (await cfg("submodule.net.url")).stdout.trim();
        expect(net).toBe("https://example.invalid/libs.git");
        expect((await cfg("url./Users/mirror/.insteadOf")).code).not.toBe(0);
        expect((await cfg("url.https://mirror.example/.insteadOf")).code).not.toBe(0);
        const kept = (await cfg("url.https://a.example/.insteadOf")).stdout.trim();
        expect(kept).toBe("https://b.example/");
        // Bare-relative and home-relative remotes are local paths; scp-like
        // host:path is network and travels.
        expect((await cfg("remote.rel.url")).code).not.toBe(0);
        expect((await cfg("remote.homey.url")).code).not.toBe(0);
        expect((await cfg("remote.scp.url")).stdout.trim()).toBe("gh.example.invalid:me/repo.git");
        expect((await cfg("http.https://example.invalid.extraHeader")).code).not.toBe(0);
        expect((await cfg("credential.helper")).code).not.toBe(0);
        expect((await cfg("remote.auth.url")).code).not.toBe(0);
        expect((await cfg("submodule.auth.url")).code).not.toBe(0);
        expect((await cfg("sendemail.smtpPass")).code).not.toBe(0);
        expect((await cfg("remote.qtok.url")).code).not.toBe(0);
        expect((await cfg("remote.qpriv.url")).code).not.toBe(0);
        expect((await cfg("remote.evil.url")).code).not.toBe(0);
        // No shipped byte names the dropped local paths.
        for (const file of walk(m.gitDir)) {
          const text = readFileSync(file).toString("utf8");
          expect(text).not.toContain("/Users/mirror");
          expect(text).not.toContain("/Users/base");
          expect(text).not.toContain("/abs/path/libs");
          expect(text).not.toContain("~/repos/x");
          expect(text).not.toContain("header-secret");
          expect(text).not.toContain("credential-secret");
          expect(text).not.toContain("url-secret");
          expect(text).not.toContain("submodule-secret");
          expect(text).not.toContain("smtp-secret");
          expect(text).not.toContain("query-secret-tok");
          expect(text).not.toContain("query-secret-priv");
          expect(text).not.toContain("ext-cmd-secret");
          expect(text).not.toContain("/abs/ext/path");
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
    "replace, notes, custom refs and the full stash stack ship with local " +
      "semantics; beam bookkeeping and worktree internals stay home",
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
      await git(f3.wtA, "symbolic-ref", "refs/custom/dangling", "refs/heads/missing");
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
        expect((await pgit("symbolic-ref", "refs/custom/dangling")).stdout.trim()).toBe(
          "refs/heads/missing",
        );

        // The whole stash STACK travels — entries, order, and messages —
        // not merely the refs/stash tip.
        expect((await pgit("rev-parse", "refs/stash")).stdout.trim()).toBe(stash0);
        expect((await pgit("rev-parse", "stash@{1}")).stdout.trim()).toBe(stash1);
        const stashList = (await pgit("stash", "list")).stdout;
        expect(stashList.split("\n")[0]).toContain("s2");
        expect(stashList.split("\n")[1]).toContain("s1");

        // Beam bookkeeping and worktree-scoped refs stayed home.
        for (const ref of ["refs/beam/return/old/values/junk", "refs/worktree/private"]) {
          expect(
            (await run(["git", "--git-dir", m.gitDir, "rev-parse", "--verify", "-q", ref])).code,
          ).not.toBe(0);
        }

        // Every shipped shared ref is pinned in the snapshot — the stash
        // stack below the tip as refs/stash@{n} pseudo-entries — and the
        // stay-home refs are not.
        const snapshot = readFileSync(join(m.gitDir, "beam-shipped-refs"), "utf8");
        expect(snapshot).toContain(`${f3.c2} refs/replace/${f3.c1}`);
        expect(snapshot).toContain(`${notesSha} refs/notes/commits`);
        expect(snapshot).toContain(`${f3.c1} refs/custom/marker`);
        expect(snapshot).toContain(
          `${"0".repeat(40)} refs/custom/dangling refs/heads/missing`,
        );
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

  test("the final verifier rejects a payload mutated after construction", async () => {
    const f4 = await makeFixture();
    const m = await materializeWorktreeGit(f4.wtA);
    try {
      await git(m.gitDir, "config", "beam.payload-race", "mutated");
      await expect(m.assertSourceUnchanged()).rejects.toThrow(
        /completed Git payload does not match/,
      );
    } finally {
      m.cleanup();
    }
  }, 30_000);

  test(
    "a payload missing an object refuses to ship even when the source is untouched",
    async () => {
      const f5 = await makeFixture();
      const stagedOid = (await git(f5.wtA, "rev-parse", ":staged-only.txt")).stdout.trim();
      const before = materializerTemps();
      // Model the clone racing a source gc/repack: one object of the
      // finished payload is gone while every source fingerprint still
      // matches — only the payload's own completeness fsck can see it.
      materializeTestSeam.afterPayloadBuilt = (gitDir) => {
        const obj = join(gitDir, "objects", stagedOid.slice(0, 2), stagedOid.slice(2));
        if (!existsSync(obj)) {
          throw new Error(`fixture assumption broke: ${obj} is not a loose payload object`);
        }
        rmSync(obj);
      };
      try {
        await expect(materializeWorktreeGit(f5.wtA)).rejects.toThrow(/command failed/);
      } finally {
        materializeTestSeam.afterPayloadBuilt = undefined;
      }
      // Refused before any remote effect, with all temp state removed —
      // and the untouched source materializes cleanly on retry.
      expect(materializerTemps()).toEqual(before);
      (await materializeWorktreeGit(f5.wtA)).cleanup();
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

  test(
    "materialization failure aborts before any transport mutation and leaves no temp state",
    async () => {
      const badWt = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtbad-")));
      writeFileSync(join(badWt, ".git"), "gitdir: /nonexistent/common/worktrees/gone\n");
      writeFileSync(join(badWt, "work.txt"), "unshippable\n");
      process.chdir(badWt);

      const before = materializerTemps();
      await expect(cmdUp(["--no-session"])).rejects.toThrow();

      // Nothing remote happened AT ALL: the workspace root was never created.
      expect(existsSync(remoteRoot)).toBe(false);
      expect(materializerTemps()).toEqual(before);
    },
    30_000,
  );

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
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const gen = record.wtGit!.generation!;
      // The published `.git` is a REGULAR pointer file naming the payload
      // generation under the reserved dir — never a directory.
      expect(lstatSync(join(remoteCwd, ".git")).isFile()).toBe(true);
      expect(readFileSync(join(remoteCwd, ".git"), "utf8")).toBe(`gitdir: .beam/git/${gen}\n`);
      expect(lstatSync(join(remoteCwd, ".beam", "git", gen)).isDirectory()).toBe(true);
      expect((await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.c2);
      expect((await git(remoteCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await git(remoteCwd, "status", "--porcelain=v1")).stdout).toBe(sourceStatus);
      expect((await git(remoteCwd, "show", ":staged-only.txt")).stdout).toBe("staged blob v1\n");
      // Exact staged state traveled inside the generation payload.
      expect(readFileSync(join(payloadOf(record), "info", "exclude"), "utf8")).toContain(".beam/");
      // The local pointer file survived untouched.
      expect(lstatSync(join(localCwd, ".git")).isFile()).toBe(true);
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
  const tokenAt = (dir: string, name: string, fill: string): string => {
    const path = join(dir, name);
    if (!existsSync(path)) writeFileSync(path, `${fill.repeat(64)}\n`);
    return readFileSync(path, "utf8").trim();
  };
  return {
    ...(head.code === 0 ? { head: head.stdout.trim() } : {}),
    ...(branch.code === 0 ? { branch: branch.stdout.trim() } : {}),
    commonDir,
    worktreeGitDir,
    commonDirId: idOf(commonDir),
    worktreeGitDirId: idOf(worktreeGitDir),
    commonDirToken: tokenAt(commonDir, "beam-repository-id", "a"),
    worktreeGitDirToken: tokenAt(worktreeGitDir, "beam-worktree-id", "b"),
    generation: "ab".repeat(8),
  };
}

describe.skipIf(!HAVE_DEPS)("cmdUp refuses sparse linked-worktree layouts " +
  "before any remote effect", () => {
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

      expect(
        (await run(["git", "-C", f.wt, "rebase", "other"], { env: GIT_ENV })).code,
      ).not.toBe(0);
      await refuse("rebase-merge");
      await git(f.wt, "rebase", "--abort");

      expect(
        (await run(["git", "-C", f.wt, "rebase", "--apply", "other"], { env: GIT_ENV })).code,
      ).not.toBe(0);
      await refuse("rebase-apply");
      await git(f.wt, "rebase", "--abort");

      expect(
        (await run(["git", "-C", f.wt, "cherry-pick", "other"], { env: GIT_ENV })).code,
      ).not.toBe(0);
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
      expect(
        (await run(["git", "-C", f.wt, "cherry-pick", "other~1", "other"], { env: GIT_ENV })).code,
      ).not.toBe(0);
      writeFileSync(join(f.wt, "conflict.txt"), "resolved\n");
      await git(f.wt, "add", "conflict.txt");
      await git(f.wt, "commit", "-q", "--no-edit");
      expect(existsSync(await markerPath(f.wt, "CHERRY_PICK_HEAD"))).toBe(false);
      expect(existsSync(await markerPath(f.wt, "sequencer"))).toBe(true);

      await expect(materializeWorktreeGit(f.wt)).rejects.toThrow(
        /in-progress git operation \(sequencer\)/,
      );

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
  test(
    "an unmerged index without an operation marker refuses before materialization",
    async () => {
      const f = await makeReturnFixture();
      const base = (await git(f.wt, "rev-parse", "HEAD:conflict.txt")).stdout.trim();
      const ours = (
        await runChecked(["git", "-C", f.wt, "hash-object", "-w", "--stdin"], {
          stdinText: "ours\n",
        })
      ).stdout.trim();
      const theirs = (
        await runChecked(["git", "-C", f.wt, "hash-object", "-w", "--stdin"], {
          stdinText: "theirs\n",
        })
      ).stdout.trim();
      await runChecked(["git", "-C", f.wt, "update-index", "--index-info"], {
        stdinText:
          `100644 ${base} 1\tconflict.txt\n` +
          `100644 ${ours} 2\tconflict.txt\n` +
          `100644 ${theirs} 3\tconflict.txt\n`,
      });
      const status = (await git(f.wt, "status", "--porcelain=v1")).stdout;
      const before = materializerTemps();

      await expect(materializeWorktreeGit(f.wt)).rejects.toThrow(/index has unmerged entries/);
      expect((await git(f.wt, "status", "--porcelain=v1")).stdout).toBe(status);
      expect(materializerTemps()).toEqual(before);
    },
    30_000,
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
      await expect(cmdUp(["--no-session"])).rejects.toThrow(
        /in-progress git operation \(MERGE_HEAD\)/,
      );
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

  /**
   * Remote agent work: two stashes, a commit on main, a new branch, a tag,
   * and a freshly staged blob that exists nowhere but the index.
   */
  async function seedRemoteAgentWork(
    remoteCwd: string,
  ): Promise<{ rMain: string; stash0: string; stash1: string }> {
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
    return { rMain, stash0, stash1 };
  }

  /**
   * No local ref moves — ever. main keeps its local position, the remote
   * tip is quarantined, remote-created branches and tags are preserved
   * without being created locally, and the locally deleted branch is not
   * resurrected.
   */
  async function assertNoLocalRefMoves(
    localCwd: string,
    record: GitReturnRecord,
    localMain: string,
    remoteMain: string,
  ): Promise<void> {
    const verifyFails = async (ref: string) =>
      (await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", ref])).code;
    expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(localMain);
    const mainQ = qval(record, "values", "refs/heads/main");
    expect((await git(localCwd, "rev-parse", mainQ)).stdout.trim()).toBe(remoteMain);
    expect(await verifyFails("refs/heads/rbranch")).not.toBe(0);
    const rbranchQ = qval(record, "values", "refs/heads/rbranch");
    expect((await git(localCwd, "rev-parse", rbranchQ)).stdout.trim()).toBe(remoteMain);
    expect(await verifyFails("refs/tags/rtag")).not.toBe(0);
    const rtagQ = qval(record, "values", "refs/tags/rtag");
    expect((await git(localCwd, "rev-parse", rtagQ)).stdout.trim()).toBe(remoteMain);
    expect(await verifyFails("refs/heads/feature")).not.toBe(0);
  }

  test(
    "remote commits, tags, stash, staged blobs, index and HEAD come home as " +
      "quarantine pins; the local checkout never moves",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      expect(record.wtGit).toBeDefined();
      expect(record.wtGit!.commonDir).toBe(join(f.base, "common.git"));
      const remoteCwd = record.remoteCwd;

      const { rMain, stash0, stash1 } = await seedRemoteAgentWork(remoteCwd);

      // Locally: delete a branch the remote never touched — the return must
      // not resurrect its untouched remote mirror.
      await git(localCwd, "branch", "-D", "feature");
      const localHeadBefore = (await git(localCwd, "rev-parse", "HEAD")).stdout.trim();
      const localStatusBefore = (await git(localCwd, "status", "--porcelain=v1")).stdout;
      // Captured AFTER the status above settled any refresh: the down must
      // not write a single index byte (it runs no local status/refresh).
      const indexRel = (await git(localCwd, "rev-parse", "--git-path", "index")).stdout.trim();
      const localIndexPath = resolve(localCwd, indexRel);
      const localIndexBytesBefore = readFileSync(localIndexPath);

      await cmdDown([record.id, "--delete"]);

      await assertNoLocalRefMoves(localCwd, record, f.c2, rMain);

      // The local checkout is byte-identical: HEAD, the exact index bytes,
      // and the working tree exactly as they were before the down. Nothing
      // remote was staged into the live worktree's Git state.
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(localHeadBefore);
      expect(readFileSync(localIndexPath)).toEqual(localIndexBytesBefore);
      expect((await git(localCwd, "status", "--porcelain=v1")).stdout).toBe(localStatusBefore);
      expect((await run(["git", "-C", localCwd, "show", ":staged-remote.txt"])).code).not.toBe(0);

      // Every stash entry preserved under the deterministic meta/ subtree
      // of this collection's return namespace, top first.
      const qbase = qbaseOf(record);
      expect((await git(localCwd, "rev-parse", `${qbase}/meta/stash`)).stdout.trim()).toBe(stash0);
      expect((await git(localCwd, "rev-parse", `${qbase}/meta/stash-1`)).stdout.trim()).toBe(
        stash1,
      );
      // Quarantined values retain disjoint recovery pins: the remote tip
      // must outlive local ref churn and later explicit sandbox destruction.

      // The incoming state commit pins raw index bytes, the staged tree
      // and remote HEAD; everything survives an immediate prune.
      const stagedState = `${qbase}/meta/state:staged/staged-remote.txt`;
      expect((await git(localCwd, "show", stagedState)).stdout).toBe("remote staged blob\n");
      expect((await git(localCwd, "rev-parse", `${qbase}/meta/HEAD`)).stdout.trim()).toBe(rMain);
      await git(localCwd, "gc", "--prune=now");
      const mainPin = qval(record, "values", "refs/heads/main");
      expect((await git(localCwd, "cat-file", "-e", `${mainPin}^{commit}`)).code).toBe(0);
      expect((await git(localCwd, "show", stagedState)).stdout).toBe("remote staged blob\n");

      // Down retained the remote after the local return became durable; the
      // local linked-worktree pointer file remained byte-identical.
      expect(existsSync(remoteCwd)).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
      expect(lstatSync(join(localCwd, ".git")).isFile()).toBe(true);
    },
    60_000,
  );
  test(
    "ship-time baseline pins survive remote ref deletion, reflog expiry, and gc",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      const tree = (await git(localCwd, "rev-parse", "HEAD^{tree}")).stdout.trim();
      const baselineOnly = (
        await runChecked(["git", "-C", localCwd, "commit-tree", tree, "-m", "baseline only"], {
          env: GIT_ENV,
        })
      ).stdout.trim();
      const ref = "refs/tags/baseline-only";
      await git(localCwd, "update-ref", ref, baselineOnly);

      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      await git(record.remoteCwd, "update-ref", "-d", ref, baselineOnly);
      await git(record.remoteCwd, "reflog", "expire", "--expire=now", "--all");
      await git(record.remoteCwd, "gc", "--prune=now");

      await git(localCwd, "update-ref", "-d", ref, baselineOnly);
      await git(localCwd, "reflog", "expire", "--expire=now", "--all");
      await git(localCwd, "gc", "--prune=now");
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", baselineOnly])).code).not.toBe(0);

      await cmdDown([record.id]);
      const tomb = qval(record, "deleted", ref);
      expect((await git(localCwd, "rev-parse", tomb)).stdout.trim()).toBe(baselineOnly);
      await git(localCwd, "gc", "--prune=now");
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", baselineOnly])).code).toBe(0);
    },
    60_000,
  );

  test(
    "return rejects a shallow boundary that hides a missing remote-created parent",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      const localHead = (await git(localCwd, "rev-parse", "HEAD")).stdout.trim();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remote = record.remoteCwd;
      const tree = (await git(remote, "rev-parse", "HEAD^{tree}")).stdout.trim();
      const parent = (
        await runChecked(
          ["git", "-C", remote, "commit-tree", tree, "-p", "HEAD", "-m", "hidden parent"],
          { env: GIT_ENV },
        )
      ).stdout.trim();
      const child = (
        await runChecked(
          ["git", "-C", remote, "commit-tree", tree, "-p", parent, "-m", "shallow child"],
          { env: GIT_ENV },
        )
      ).stdout.trim();
      await git(remote, "update-ref", "refs/heads/main", child);
      writeFileSync(join(payloadOf(record), "shallow"), `${child}\n`);
      rmSync(join(payloadOf(record), "objects", parent.slice(0, 2), parent.slice(2)));

      await expect(cmdDown([record.id])).rejects.toThrow(/unsupported history boundary/);
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(localHead);
      expect(existsSync(join(payloadOf(record), "shallow"))).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
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
      const remoteConfig = join(payloadOf(record), "config");
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
      expect(existsSync(record.remoteCwd)).toBe(true);
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
        expect(
          (await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", ref])).code,
        ).not.toBe(0);
        const quarantined = qval(record, "values", ref);
        expect((await git(localCwd, "rev-parse", quarantined)).stdout.trim()).toBe(remoteTip);
      }
      expect((await git(localCwd, "show", "-s", "--format=%s", f.c2)).stdout.trim()).toBe("c2");
      expect(existsSync(remoteCwd)).toBe(true);
    },
    60_000,
  );

  test(
    "quarantine refs remain prefix-free across retries with ancestor and descendant source refs",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      const topic = "refs/heads/topic";
      const child = "refs/heads/topic/child";
      await git(localCwd, "update-ref", topic, f.c1);
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      const tree = (await git(localCwd, "rev-parse", `${f.c2}^{tree}`)).stdout.trim();
      const localTip = (
        await git(localCwd, "commit-tree", tree, "-p", f.c2, "-m", "local topic")
      ).stdout.trim();
      const remoteTip = (
        await git(remoteCwd, "commit-tree", tree, "-p", f.c2, "-m", "remote topic")
      ).stdout.trim();
      await git(localCwd, "update-ref", topic, localTip, f.c1);
      await git(remoteCwd, "update-ref", topic, remoteTip, f.c1);

      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);
      await importWorktreeGitReturn(new LocalTransport(iso.remoteHome), record);
      const ancestorQ = qval(record, "values", topic);
      expect((await git(localCwd, "rev-parse", ancestorQ)).stdout.trim()).toBe(remoteTip);

      await git(remoteCwd, "update-ref", "-d", topic, remoteTip);
      const remoteChild = (
        await git(remoteCwd, "commit-tree", tree, "-p", remoteTip, "-m", "remote child")
      ).stdout.trim();
      await git(remoteCwd, "update-ref", child, remoteChild);
      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);
      await importWorktreeGitReturn(new LocalTransport(iso.remoteHome), record);

      const descendantQ = qval(record, "values", child);
      expect((await git(localCwd, "rev-parse", ancestorQ)).stdout.trim()).toBe(remoteTip);
      expect((await git(localCwd, "rev-parse", descendantQ)).stdout.trim()).toBe(remoteChild);
      expect((await git(localCwd, "rev-parse", topic)).stdout.trim()).toBe(localTip);
      expect(
        (await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", child])).code,
      ).not.toBe(0);
    },
    60_000,
  );


  test(
    "remote worktree-private refs never overwrite independently created local values",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      const privateRef = "refs/worktree/private";
      await git(localCwd, "update-ref", privateRef, f.c1);
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const probe = await run(
        ["git", "-C", record.remoteCwd, "rev-parse", "--verify", "-q", privateRef],
      );
      expect(probe.code).not.toBe(0);
      await git(record.remoteCwd, "update-ref", privateRef, f.c2);

      await cmdDown([record.id]);

      expect((await git(localCwd, "rev-parse", privateRef)).stdout.trim()).toBe(f.c1);
      const quarantined = qval(record, "values", privateRef);
      expect((await git(localCwd, "rev-parse", quarantined)).stdout.trim()).toBe(f.c2);
    },
    60_000,
  );
  test(
    "changed and deleted symbolic refs stay local and return losslessly as " +
      "quarantined target names",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      const changed = "refs/remotes/origin/changed";
      const deleted = "refs/remotes/origin/deleted";
      const shippedTarget = "refs/remotes/origin/main";
      await git(localCwd, "symbolic-ref", changed, shippedTarget);
      await git(localCwd, "symbolic-ref", deleted, shippedTarget);

      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      // The snapshot/parser round-trip preserves the symbolic value domain,
      // not merely the object id that the target happened to resolve to.
      expect((await git(remoteCwd, "symbolic-ref", changed)).stdout.trim()).toBe(shippedTarget);
      expect((await git(remoteCwd, "symbolic-ref", deleted)).stdout.trim()).toBe(shippedTarget);

      const remoteTarget = "refs/heads/feature";
      await git(remoteCwd, "symbolic-ref", changed, remoteTarget);
      await git(remoteCwd, "symbolic-ref", "--delete", deleted);
      await cmdDown([record.id]);

      // Symbolic refs never enter object-id CAS: local semantics stay put.
      expect((await git(localCwd, "symbolic-ref", changed)).stdout.trim()).toBe(shippedTarget);
      expect((await git(localCwd, "symbolic-ref", deleted)).stdout.trim()).toBe(shippedTarget);

      const changedQ = qval(record, "meta/symrefs/values", changed);
      expect((await git(localCwd, "cat-file", "-p", changedQ)).stdout).toContain(
        `target ${remoteTarget}\n`,
      );
      const deletedQ = qval(record, "meta/symrefs/deleted", deleted);
      expect((await git(localCwd, "cat-file", "-p", deletedQ)).stdout).toContain(
        `target ${shippedTarget}\n`,
      );
      expect(existsSync(remoteCwd)).toBe(true);
    },
    60_000,
  );

  test(
    "dangling symbolic refs ship and return when a target disappears or the remote creates one",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      const alias = "refs/custom/tag-alias";
      const target = "refs/tags/t1";
      const remoteOnly = "refs/custom/remote-dangling";
      await git(localCwd, "symbolic-ref", alias, target);

      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      expect((await git(remoteCwd, "symbolic-ref", alias)).stdout.trim()).toBe(target);

      // The alias becomes dangling, and the sandbox creates another dangling
      // symref. Both are valid target-name state even though fsck cannot
      // resolve them as object refs.
      await git(remoteCwd, "update-ref", "-d", target);
      await git(remoteCwd, "symbolic-ref", remoteOnly, "refs/heads/never-created");
      await cmdDown([record.id]);

      // Local refs are never mutated by the down: the tag the remote
      // deleted still resolves to its ship-time value.
      expect((await git(localCwd, "rev-parse", target)).stdout.trim()).toBe(f.c2);
      expect((await git(localCwd, "symbolic-ref", alias)).stdout.trim()).toBe(target);
      const qref = qval(record, "meta/symrefs/values", remoteOnly);
      expect((await git(localCwd, "cat-file", "-p", qref)).stdout).toContain(
        "target refs/heads/never-created\n",
      );
      expect(existsSync(remoteCwd)).toBe(true);
    },
    60_000,
  );

  test(
    "conflicting local commits are never overwritten — remote result quarantined, " +
      "the returning worktree HEAD is preserved",
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

      // Local main kept the local commits; the remote result is quarantined.
      // The returning worktree's checkout is byte-identical — HEAD stays
      // attached to main at the local tip.
      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(lMain);
      const mainQ = qval(record, "values", "refs/heads/main");
      expect((await git(localCwd, "rev-parse", mainQ)).stdout.trim()).toBe(rMain);
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(lMain);
      // The remote HEAD commit stays recoverable under the return namespace.
      const metaHead = (await git(localCwd, "rev-parse", `${qbaseOf(record)}/meta/HEAD`)).stdout;
      expect(metaHead.trim()).toBe(rMain);
      // The remote's working tree never lands in the live worktree — it is
      // persisted in the return stage instead.
      expect(existsSync(join(localCwd, "remote-side.txt"))).toBe(false);
      // The verified return is durable while the remote stays collectible.
      expect(existsSync(remoteCwd)).toBe(true);
    },
    60_000,
  );

  test(
    "an import failure leaves the remote intact and retryable; a clean retry imports and retains",
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
      // down BEFORE any local git mutation.
      const objPath = join(payloadOf(record), "objects", rMain.slice(0, 2), rMain.slice(2));
      renameSync(objPath, `${objPath}.hidden`);
      await expect(cmdDown([record.id])).rejects.toThrow();

      // Remote fully intact and the record still collectable; local git
      // state untouched.
      expect(existsSync(join(remoteCwd, ".git"))).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(f.c2);
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");

      // Repair and retry: the down converges (nothing local moves, the
      // remote tip arrives as objects + quarantine pin) and retains it.
      renameSync(`${objPath}.hidden`, objPath);
      await cmdDown([record.id]);
      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(f.c2);
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.c2);
      const mainQ = qval(record, "values", "refs/heads/main");
      expect((await git(localCwd, "rev-parse", mainQ)).stdout.trim()).toBe(rMain);
      expect(existsSync(remoteCwd)).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
    },
    60_000,
  );

  test(
    "a collection without the ship-time snapshot aborts before importing or purging anything",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      rmSync(join(payloadOf(record), "beam-shipped-refs"), { force: true });
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const rMain = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();

      await expect(cmdDown([record.id])).rejects.toThrow(/no longer carries beam-shipped-refs/);

      // Missing authorization is fatal: no remote ref/object is imported,
      // local HEAD stays put, and the only remote copy remains retryable.
      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(f.mainSha);
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", rMain])).code).not.toBe(0);
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect(existsSync(remoteCwd)).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
    },
    60_000,
  );

  test(
    "a sibling worktree advancing the returned branch quarantines it and never " +
      "moves the returning worktree's HEAD",
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
      const mainQ = qval(record, "values", "refs/heads/main");
      expect((await git(localCwd, "rev-parse", mainQ)).stdout.trim()).toBe(rMain);

      // The returning worktree's HEAD did not move: still detached exactly
      // where it was before the down, NOT at the remote position.
      expect((await run(["git", "-C", localCwd, "symbolic-ref", "-q", "HEAD"])).code).not.toBe(0);
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.c2);

      // The remote HEAD commit stays recoverable under the return namespace.
      const metaHead = (await git(localCwd, "rev-parse", `${qbaseOf(record)}/meta/HEAD`)).stdout;
      expect(metaHead.trim()).toBe(rMain);

      // The sibling's view is fully intact.
      expect((await git(f.wtB, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await git(f.wtB, "rev-parse", "HEAD")).stdout.trim()).toBe(sMain);

      // The verified return is durable while the remote stays collectible.
      expect(existsSync(remoteCwd)).toBe(true);
    },
    60_000,
  );

  test(
    "remote tag and branch deletions stay local — both tombstoned durably under " +
      "the return namespace",
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

      // Nothing is deleted locally: the branch and the tag keep their
      // shipped values, and both deletions are tombstoned.
      expect((await git(localCwd, "rev-parse", "refs/heads/feature")).stdout.trim()).toBe(f.c1);
      expect((await git(localCwd, "rev-parse", "refs/tags/t1")).stdout.trim()).toBe(f.c2);
      // ...and the shipped tips survive as tombstones under the return namespace.
      const featureTomb = qval(record, "deleted", "refs/heads/feature");
      expect((await git(localCwd, "rev-parse", featureTomb)).stdout.trim()).toBe(f.c1);
      const tagTomb = qval(record, "deleted", "refs/tags/t1");
      expect((await git(localCwd, "rev-parse", tagTomb)).stdout.trim()).toBe(f.c2);

      // The remote copy remains available, and the tombstone independently
      // proves and recovers the remote deletion.
      expect(existsSync(remoteCwd)).toBe(true);
      await git(localCwd, "update-ref", "refs/heads/recovered-feature", featureTomb);
      const recovered = (await git(localCwd, "rev-parse", "refs/heads/recovered-feature")).stdout;
      expect(recovered.trim()).toBe(f.c1);
      expect((await git(localCwd, "cat-file", "-t", f.c1)).stdout.trim()).toBe("commit");
    },
    60_000,
  );

  test(
    "a remotely deleted branch that moved locally since the ship is kept — the " +
      "deletion is quarantined as a durable tombstone",
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
      // durably under the return namespace.
      const featureTomb = qval(record, "deleted", "refs/heads/feature");
      expect((await git(localCwd, "rev-parse", featureTomb)).stdout.trim()).toBe(f.c1);
      expect(existsSync(remoteCwd)).toBe(true);
    },
    60_000,
  );

  test(
    "a checked-out deletion and sibling-racy remote HEAD branch both stay local and recoverable",
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
      const mainTomb = qval(record, "deleted", "refs/heads/main");
      expect((await git(localCwd, "rev-parse", mainTomb)).stdout.trim()).toBe(f.c2);
      // The remote-created branch cannot be attached while sibling worktrees
      // can race to claim it. Keep local HEAD on main and preserve both the
      // remote branch and remote HEAD under the return namespace.
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.c2);
      const takeoverQ = qval(record, "values", "refs/heads/takeover");
      expect((await git(localCwd, "rev-parse", takeoverQ)).stdout.trim()).toBe(rHead);
      const metaHead = (await git(localCwd, "rev-parse", `${qbaseOf(record)}/meta/HEAD`)).stdout;
      expect(metaHead.trim()).toBe(rHead);
      expect(existsSync(remoteCwd)).toBe(true);
    },
    60_000,
  );

  test(
    "hostile remote-only refs cannot shadow tombstones or meta names — the return " +
      "subtrees stay disjoint",
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

      const qbase = qbaseOf(record);
      // Both tips of every would-be collision remain named, with their own
      // values: the tombstone AND the hostile ref, the quarantined remote
      // HEAD AND the hostile ref.
      const featureTomb = qval(record, "deleted", "refs/heads/feature");
      expect((await git(localCwd, "rev-parse", featureTomb)).stdout.trim()).toBe(f.c1);
      const hostileTombQ = qval(record, "values", "refs/deleted/heads/feature");
      expect((await git(localCwd, "rev-parse", hostileTombQ)).stdout.trim()).toBe(rMain);
      expect((await git(localCwd, "rev-parse", `${qbase}/meta/HEAD`)).stdout.trim()).toBe(rMain);
      const hostileMetaQ = qval(record, "values", "refs/HEAD/meta");
      expect((await git(localCwd, "rev-parse", hostileMetaQ)).stdout.trim()).toBe(f.c1);

      // Hostile namespaces never land as live refs. The sibling-racy
      // feature deletion remains local with its tombstone, main keeps the
      // local work, and every preserved tip is independently durable.
      for (const ref of ["refs/deleted/heads/feature", "refs/HEAD/meta"]) {
        expect(
          (await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", ref])).code,
        ).not.toBe(0);
      }
      expect((await git(localCwd, "rev-parse", "refs/heads/feature")).stdout.trim()).toBe(f.c1);
      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(lMain);
      expect(existsSync(remoteCwd)).toBe(true);
    },
    60_000,
  );

  /** Local shared refs beyond heads/tags/remotes, plus a two-entry stash. */
  async function seedLocalSharedRefsAndStash(
    localCwd: string,
    f: Fixture,
  ): Promise<{ replaceRef: string; localNotes: string; stash0: string; stash1: string }> {
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
    return { replaceRef, localNotes, stash0, stash1 };
  }

  test(
    "replace/notes/custom refs and the stash round-trip: untouched mirrors stay " +
      "silent, remote changes stay quarantined, the remote stash stack comes back " +
      "whole and ordered",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      const { replaceRef, localNotes, stash0, stash1 } =
        await seedLocalSharedRefsAndStash(localCwd, f);

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

      const qbase = qbaseOf(record);
      // The changed notes ref is NOT auto-applied — the local value is
      // untouched and the remote value waits in values/ quarantine.
      expect((await git(localCwd, "rev-parse", "refs/notes/commits")).stdout.trim()).toBe(
        localNotes,
      );
      const notesQ = qval(record, "values", "refs/notes/commits");
      expect((await git(localCwd, "rev-parse", notesQ)).stdout.trim()).toBe(rNotes);

      // Untouched mirrors are recognized by their snapshot pins and leave
      // no quarantine residue at all.
      expect((await git(localCwd, "rev-parse", replaceRef)).stdout.trim()).toBe(f.c2);
      expect((await git(localCwd, "rev-parse", "refs/custom/marker")).stdout.trim()).toBe(f.c1);
      for (const leftover of [
        qval(record, "values", `refs/replace/${f.c1}`),
        qval(record, "values", "refs/custom/marker"),
      ]) {
        expect(
          (await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", leftover])).code,
        ).not.toBe(0);
      }

      // The local stash is never merged into: still exactly two entries.
      // The remote's FINAL stack — new entry plus the shipped ones below
      // it, order intact — is preserved whole under meta/.
      expect((await git(localCwd, "rev-parse", "refs/stash")).stdout.trim()).toBe(stash0);
      expect((await git(localCwd, "rev-parse", `${qbase}/meta/stash`)).stdout.trim()).toBe(rStash0);
      expect((await git(localCwd, "rev-parse", `${qbase}/meta/stash-1`)).stdout.trim()).toBe(
        stash0,
      );
      expect((await git(localCwd, "rev-parse", `${qbase}/meta/stash-2`)).stdout.trim()).toBe(
        stash1,
      );
      expect(existsSync(remoteCwd)).toBe(true);
    },
    60_000,
  );

  test(
    "incoming index recovery hashes raw bytes with filters disabled",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      writeFileSync(join(record.remoteCwd, "filter-index.txt"), "remote staged bytes\n");
      await git(record.remoteCwd, "add", "filter-index.txt");

      const marker = join(f.base, "FILTER-RAN");
      const attrs = join(f.base, "hostile-attributes");
      const filter = join(f.base, "hostile-filter.sh");
      writeFileSync(attrs, "* filter=beam-hostile\n");
      writeFileSync(filter, `#!/bin/sh\ncat >/dev/null\nprintf FILTERED\n: > ${shq(marker)}\n`);
      chmodSync(filter, 0o755);
      await git(localCwd, "config", "core.attributesFile", attrs);
      await git(localCwd, "config", "filter.beam-hostile.clean", `${shq(filter)}`);
      await git(localCwd, "config", "filter.beam-hostile.required", "true");

      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);
      let normalized: Buffer | undefined;
      pinIncomingCheckoutTestSeam.beforeHash = (path) => {
        normalized = Buffer.from(readFileSync(path));
      };
      let returned;
      try {
        returned = await importWorktreeGitReturn(new LocalTransport(iso.remoteHome), record);
      } finally {
        pinIncomingCheckoutTestSeam.beforeHash = undefined;
      }
      expect(normalized).toBeDefined();
      const proc = Bun.spawn(
        ["git", "-C", localCwd, "cat-file", "blob", `${returned.qbase}/meta/state:index`],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...GIT_ENV } },
      );
      const stored = Buffer.from(await new Response(proc.stdout).arrayBuffer());
      expect(await proc.exited).toBe(0);
      expect(stored.equals(normalized!)).toBe(true);
      expect(existsSync(marker)).toBe(false);
    },
    60_000,
  );

  test(
    "copy-paste remediation shell-quotes every valid hostile remote ref literally",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteTip = (await git(record.remoteCwd, "rev-parse", "HEAD")).stdout.trim();
      const markers = Array.from({ length: 7 }, (_, n) => join(f.base, `PWNED-${n}`));
      const refs = [
        `refs/heads/dollar$(touch$IFS${markers[0]})`,
        `refs/heads/tick\`touch$IFS${markers[1]}\``,
        `refs/heads/semi;touch$IFS${markers[2]}`,
        `refs/heads/amp&touch$IFS${markers[3]}`,
        `refs/heads/pipe|touch$IFS${markers[4]}`,
        `refs/heads/redir>${markers[5]}`,
      ];
      for (const ref of refs) {
        expect((await run(["git", "check-ref-format", ref])).code).toBe(0);
        await git(record.remoteCwd, "update-ref", ref, remoteTip);
      }
      const headBranch = `refs/heads/head$(touch$IFS${markers[6]})`;
      expect((await run(["git", "check-ref-format", headBranch])).code).toBe(0);
      await git(record.remoteCwd, "symbolic-ref", "HEAD", headBranch);
      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);
      const returned = await importWorktreeGitReturn(new LocalTransport(iso.remoteHome), record);

      for (const ref of refs) {
        const note = returned.notes.find((line) => line.startsWith(`${ref}:`));
        expect(note).toBeDefined();
        const command = note!.split("adopt it after review with: ")[1];
        expect(command).toBeDefined();
        await runChecked(["bash", "-c", command!], { cwd: localCwd, env: GIT_ENV });
        expect((await git(localCwd, "rev-parse", "--verify", ref)).stdout.trim()).toBe(remoteTip);
      }
      const headNote = returned.notes.find((line) =>
        line.includes(`remote HEAD points at unborn ${headBranch}`),
      );
      expect(headNote).toBeDefined();
      const headCommand = /apply here with `([^`]+)`/.exec(headNote!)?.[1];
      expect(headCommand).toBeDefined();
      await runChecked(["bash", "-c", headCommand!], { cwd: localCwd, env: GIT_ENV });
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe(headBranch);
      for (const marker of markers) expect(existsSync(marker)).toBe(false);
    },
    60_000,
  );

  test(
    "each collection pins same refs, the full stash, symref targets, and remote " +
      "refs/beam roots through purge and gc",
    async () => {
      const f = await makeFixture();
      process.chdir(f.wtA);
      const localCwd = process.cwd();
      const tree = (await git(localCwd, "rev-parse", "HEAD^{tree}")).stdout.trim();
      const uniqueBranchTip = (
        await git(localCwd, "commit-tree", tree, "-p", f.c2, "-m", "same branch only")
      ).stdout.trim();
      const targetRef = "refs/heads/same-unique";
      await git(localCwd, "update-ref", targetRef, uniqueBranchTip);
      writeFileSync(join(localCwd, "tracked.txt"), "v1\nunchanged stash\n");
      await git(localCwd, "stash", "push", "-q", "-m", "same unique stash");
      const stashTip = (await git(localCwd, "rev-parse", "refs/stash")).stdout.trim();

      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const alias = "refs/custom/new-symbolic-alias";
      await git(record.remoteCwd, "symbolic-ref", alias, targetRef);
      const remoteTree = (await git(record.remoteCwd, "rev-parse", "HEAD^{tree}")).stdout.trim();
      const remoteBeamTip = (
        await git(record.remoteCwd, "commit-tree", remoteTree, "-p", f.c2, "-m", "remote beam only")
      ).stdout.trim();
      const remoteBeamRef = "refs/beam/remote-session-only";
      await git(record.remoteCwd, "update-ref", remoteBeamRef, remoteBeamTip);

      await git(localCwd, "update-ref", "-d", targetRef);
      await git(localCwd, "update-ref", "-d", "refs/stash");
      await git(localCwd, "reflog", "expire", "--expire=now", "--all");
      await git(localCwd, "gc", "--prune=now");
      expect(
        (await run(["git", "-C", localCwd, "cat-file", "-e", uniqueBranchTip])).code,
      ).not.toBe(0);
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", stashTip])).code).not.toBe(0);

      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);
      const returned = await importWorktreeGitReturn(new LocalTransport(iso.remoteHome), record);
      const directPin = qval(record, "meta/ref-targets", targetRef);
      const symrefPin = qval(record, "meta/symrefs/targets", alias);
      const beamPin = qval(record, "meta/remote-beam", remoteBeamRef);
      expect((await git(localCwd, "rev-parse", directPin)).stdout.trim()).toBe(uniqueBranchTip);
      expect((await git(localCwd, "rev-parse", symrefPin)).stdout.trim()).toBe(uniqueBranchTip);
      expect((await git(localCwd, "rev-parse", beamPin)).stdout.trim()).toBe(remoteBeamTip);
      const stashPin = (await git(localCwd, "rev-parse", `${returned.qbase}/meta/stash`)).stdout;
      expect(stashPin.trim()).toBe(stashTip);
      const manifest = (await git(localCwd, "cat-file", "blob", `${returned.qbase}/manifest`))
        .stdout;
      for (const pin of [directPin, symrefPin, beamPin, `${returned.qbase}/meta/stash`]) {
        expect(manifest).toContain(pin);
      }
      expect(manifest).toContain(`stash-target-pin 0 ${stashTip} ${returned.qbase}/meta/stash`);
      expect(
        (await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", remoteBeamRef])).code,
      ).not.toBe(0);

      rmSync(record.remoteCwd, { recursive: true, force: true });
      await git(localCwd, "reflog", "expire", "--expire=now", "--all");
      await git(localCwd, "gc", "--prune=now");
      for (const oid of [uniqueBranchTip, stashTip, remoteBeamTip]) {
        expect((await git(localCwd, "cat-file", "-e", oid)).code).toBe(0);
      }
    },
    120_000,
  );
});

describe.skipIf(!HAVE_DEPS)("cmdDown refuses Git repository identity drift before mutation", () => {
  let iso: IsolatedBeam;
  beforeAll(() => {
    iso = isolatedBeam("wtdrift");
  });
  afterAll(() => restoreBeam(iso));

  /**
   * Swap the checkout: move the shipped standard repo aside and put a
   * linked worktree of an UNRELATED repository at the exact recorded path.
   */
  async function swapInUnrelatedWorktree(
    base: string,
    localCwd: string,
  ): Promise<{ aside: string; unrelated: string }> {
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
    return { aside, unrelated };
  }

  test(
    "a standard checkout swapped for an unrelated linked worktree fails closed; " +
      "restoring it collects normally",
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
      expect(existsSync(join(payloadOf(record), "HEAD"))).toBe(true);

      // Remote agent work a collect would bring home — it must NOT move here.
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");

      const { aside, unrelated } = await swapInUnrelatedWorktree(base, localCwd);

      const recordBytes = JSON.stringify(record);
      const unrelatedBefore = dirManifest(unrelated);
      const swappedBefore = dirManifest(localCwd);
      const asideBefore = dirManifest(aside);
      const remoteBefore = dirManifest(remoteCwd);

      // The pinned common Git dir catches repository drift before staging,
      // session import, or Git mutation.
      await expect(cmdDown([record.id])).rejects.toThrow(/different repository/);

      // Byte/state intact everywhere: the unrelated repository (common dir
      // AND its worktree at the recorded path), the moved-aside original,
      // the remote workspace, and the record — no backup refs or status
      // transition.
      expect(dirManifest(unrelated)).toBe(unrelatedBefore);
      expect(dirManifest(localCwd)).toBe(swappedBefore);
      expect(dirManifest(aside)).toBe(asideBefore);
      expect(dirManifest(remoteCwd)).toBe(remoteBefore);
      expect((await git(unrelated, "for-each-ref", "refs/beam")).stdout).toBe("");
      const after = loadState(resolveEnv()).records.find((r) => r.id === record.id)!;
      expect(JSON.stringify(after)).toBe(recordBytes);
      expect(after.status).toBe("up");

      // Restore the shipped checkout: the quarantined Git return collects
      // normally — remote work home as objects and pins, the local
      // checkout untouched, remote retained, record still collectible.
      await git(unrelated, "worktree", "remove", "--force", localCwd);
      renameSync(aside, localCwd);
      await cmdDown([record.id]);
      expect(existsSync(join(localCwd, "remote-new.txt"))).toBe(false);
      const mainQ = qval(record, "values", "refs/heads/main");
      expect((await git(localCwd, "show", "-s", "--format=%s", mainQ)).stdout.trim()).toBe(
        "remote work",
      );
      expect(existsSync(remoteCwd)).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
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

describe.skipIf(!HAVE_DEPS)("cmdDown refuses same-path repository replacement " +
  "(identity, not pathname)", () => {
  let iso: IsolatedBeam;
  beforeAll(() => {
    iso = isolatedBeam("wtsamepath");
  });
  afterAll(() => restoreBeam(iso));

  /**
   * Replace the repository AT THE SAME PATHNAME: the impostor's common git
   * dir string- and realpath-compares equal to the shipped one — only the
   * device+inode identity can tell them apart.
   */
  async function replaceWithSamePathImpostor(base: string, localCwd: string): Promise<string> {
    const aside = join(base, "aside");
    renameSync(localCwd, aside);
    mkdirSync(localCwd);
    await git(localCwd, "init", "-q", "-b", "main");
    writeFileSync(join(localCwd, "tracked.txt"), "impostor checkout\n");
    await git(localCwd, "add", "-A");
    await git(localCwd, "commit", "-q", "-m", "impostor base");
    return aside;
  }

  /**
   * Reuse BOTH pathnames with an unrelated repository: a bare clone at the
   * exact common-dir path, a linked worktree at the exact checkout path —
   * every recorded pathname resolves, none is the shipped repo.
   */
  async function reuseBothPathnames(
    f: ReturnFixture,
    localCwd: string,
  ): Promise<{ commonAside: string; wtAside: string }> {
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
    return { commonAside, wtAside };
  }

  test(
    "a standard checkout replaced by another standard checkout at the exact pathname " +
      "fails closed; the original, renamed back, collects normally",
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

      const aside = await replaceWithSamePathImpostor(base, localCwd);

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
      // recorded path restores the shipped identity, and the down collects —
      // quarantine-only, so the local checkout stays put and the remote
      // commit arrives as a pinned value.
      rmSync(localCwd, { recursive: true, force: true });
      renameSync(aside, localCwd);
      await cmdDown([record.id]);
      expect((await git(localCwd, "show", "-s", "--format=%s", "HEAD")).stdout.trim()).toBe(
        "original base",
      );
      const mainQ = qval(record, "values", "refs/heads/main");
      expect((await git(localCwd, "show", "-s", "--format=%s", mainQ)).stdout.trim()).toBe(
        "remote work",
      );
      expect(existsSync(remoteCwd)).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
    },
    60_000,
  );

  test(
    "a linked worktree whose common-dir pathname is reused by an unrelated repository " +
      "fails closed; the original pair collects after moving back",
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

      const { commonAside, wtAside } = await reuseBothPathnames(f, localCwd);

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

      // Move the real pair back (inodes intact): the down collects normally
      // — the local checkout stays put, the remote commit is pinned.
      await git(f.commonGit, "worktree", "remove", "--force", localCwd);
      rmSync(f.commonGit, { recursive: true, force: true });
      renameSync(commonAside, f.commonGit);
      renameSync(wtAside, localCwd);
      await cmdDown([record.id]);
      const mainQ = qval(record, "values", "refs/heads/main");
      expect((await git(localCwd, "show", "-s", "--format=%s", mainQ)).stdout.trim()).toBe(
        "remote work",
      );
      expect(existsSync(remoteCwd)).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
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

      await expect(cmdDown([record.id])).rejects.toThrow(
        /carries no ship-time repository identity/,
      );

      expect(dirManifest(f.base)).toBe(localBefore);
      expect(dirManifest(remoteCwd)).toBe(remoteBefore);
      expect((await git(f.commonGit, "for-each-ref", "refs/beam")).stdout).toBe("");
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
    },
    60_000,
  );

  test(
    "a checkout replaced after remote collection starts is refused before the first " +
      "local Git mutation",
    async () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtcollect-race-")));
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
      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);

      const aside = join(base, "aside");
      let replacementBefore = "";
      let asideBefore = "";
      class SwapAfterCollectTransport extends LocalTransport {
        override async syncDown(remoteDir: string, localDir: string, opts = {}): Promise<void> {
          await super.syncDown(remoteDir, localDir, opts);
          renameSync(localCwd, aside);
          await new LocalTransport(iso.remoteHome).syncUp(aside, localCwd, { delete: true });
          // The copied impostor carries the prepared snapshot and identity
          // marker bytes; only the rechecked directory identity distinguishes it.
          replacementBefore = dirManifest(localCwd);
          asideBefore = dirManifest(aside);
        }
      }

      const remoteBefore = dirManifest(record.remoteCwd);
      await expect(
        importWorktreeGitReturn(new SwapAfterCollectTransport(iso.remoteHome), record),
      ).rejects.toThrow(/not the directory this handoff shipped from/);

      expect(dirManifest(localCwd)).toBe(replacementBefore);
      expect(dirManifest(aside)).toBe(asideBefore);
      expect(dirManifest(record.remoteCwd)).toBe(remoteBefore);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
    },
    60_000,
  );

});

describe.skipIf(!HAVE_DEPS)("cmdDown refuses unsupported collected repository " +
  "formats before mutation", () => {
  let iso: IsolatedBeam;
  beforeAll(() => {
    iso = isolatedBeam("wtformat");
  });
  afterAll(() => restoreBeam(iso));


  test(
    "a remote sparse-checkout (skip-worktree index) refuses with both sides intact; " +
      "disabling it converges",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // Remote work in a subdirectory, then a cone sparse-checkout that
      // drops it from the worktree and marks it skip-worktree in the index.
      // Importing that index would make the local checkout silently hide
      // the file while Git reports it unchanged.
      mkdirSync(join(remoteCwd, "sub"), { recursive: true });
      writeFileSync(join(remoteCwd, "sub", "inner.txt"), "made remotely\n");
      await git(remoteCwd, "add", "sub/inner.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const remoteSha = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();
      await git(remoteCwd, "sparse-checkout", "set");
      expect((await git(remoteCwd, "ls-files", "-t")).stdout).toContain("S sub/inner.txt");

      const remoteGitBefore = dirManifest(payloadOf(record));
      await expect(cmdDown([record.id])).rejects.toThrow(/skip-worktree/);

      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.mainSha);
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", remoteSha])).code).not.toBe(0);
      expect(dirManifest(payloadOf(record))).toBe(remoteGitBefore);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");

      // Disabling the sparse checkout restores a full index and worktree —
      // extensions.worktreeConfig stays set, which the format gate allows —
      // and the same record converges quarantine-only.
      await git(remoteCwd, "sparse-checkout", "disable");
      await cmdDown([record.id]);
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.mainSha);
      expect(
        (await git(localCwd, "rev-parse", qval(record, "values", "refs/heads/main"))).stdout.trim(),
      ).toBe(remoteSha);
      expect(existsSync(join(localCwd, "sub"))).toBe(false);
      expect(existsSync(remoteCwd)).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
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
    "an attached unborn repository ships with its staged text and binary content " +
      "and returns still unborn, index intact",
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
      expect(
        (await run(["git", "-C", remoteCwd, "rev-parse", "--verify", "-q", "HEAD"])).code,
      ).not.toBe(0);
      expect((await git(remoteCwd, "status", "--porcelain=v1")).stdout).toBe(localStatus);
      expect((await git(remoteCwd, "ls-files", "--stage")).stdout).toBe(localIndex);
      expect((await git(remoteCwd, "show", ":staged-only.txt")).stdout).toBe("staged v1\n");

      // Remote agent work that stays uncommitted: one more staged blob.
      writeFileSync(join(remoteCwd, "remote-staged.txt"), "remote staged\n");
      await git(remoteCwd, "add", "remote-staged.txt");

      await cmdDown([record.id]);

      // Still unborn, still attached to main; the LOCAL index and status
      // are byte-identical — the remote's final index is pinned under the
      // return namespace instead of being installed.
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect(
        (await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", "HEAD"])).code,
      ).not.toBe(0);
      expect((await git(localCwd, "status", "--porcelain=v1")).stdout).toBe(localStatus);
      expect((await git(localCwd, "ls-files", "--stage")).stdout).toBe(localIndex);
      expect((await run(["git", "-C", localCwd, "show", ":remote-staged.txt"])).code).not.toBe(0);
      expect((await git(localCwd, "show", ":staged-only.txt")).stdout).toBe("staged v1\n");
      const stagedQ = `${qbaseOf(record)}/meta/state:staged/remote-staged.txt`;
      expect((await git(localCwd, "show", stagedQ)).stdout).toBe("remote staged\n");
      expect(existsSync(remoteCwd)).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
    },
    60_000,
  );

  test(
    "the remote's first commit on a shipped unborn branch comes home as objects " +
      "and a quarantine pin; main stays unborn locally",
    async () => {
      const { base, localCwd } = await makeUnbornFixture();
      process.chdir(localCwd);
      await cmdUp(["--no-session"]);
      process.chdir(base);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      await git(remoteCwd, "commit", "-q", "-m", "first commit");
      const bornSha = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();
      const localStatus = (await git(localCwd, "status", "--porcelain=v1")).stdout;

      await cmdDown([record.id]);

      // main is NOT born locally — the branch ref never moves. The commit
      // is home as an object with a durable quarantine pin, and the local
      // checkout is byte-identical: still attached-unborn on main.
      expect(
        (await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", "refs/heads/main"])).code,
      ).not.toBe(0);
      expect(
        (await git(localCwd, "rev-parse", qval(record, "values", "refs/heads/main"))).stdout.trim(),
      ).toBe(bornSha);
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect(
        (await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", "HEAD"])).code,
      ).not.toBe(0);
      expect((await git(localCwd, "status", "--porcelain=v1")).stdout).toBe(localStatus);
      expect((await git(localCwd, "show", `${bornSha}:staged-only.txt`)).stdout).toBe(
        "staged v1\n",
      );
      expect(existsSync(remoteCwd)).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
    },
    60_000,
  );
});

describe("sanitizedGitEnv", () => {
  test("strips every repo/config/object/index selection variable — including indexed " +
    "config forms — and keeps everything else", () => {
    const stripped = [
      "GIT_DIR",
      "GIT_COMMON_DIR",
      "GIT_WORK_TREE",
      "GIT_NAMESPACE",
      "GIT_CEILING_DIRECTORIES",
      "GIT_DISCOVERY_ACROSS_FILESYSTEM",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_QUARANTINE_PATH",
      "GIT_REPLACE_REF_BASE",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_INDEX_FILE",
      "GIT_INDEX_VERSION",
      "GIT_GRAFT_FILE",
      "GIT_SHALLOW_FILE",
      "GIT_CONFIG",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_PARAMETERS",
      "GIT_TEMPLATE_DIR",
      "GIT_DEFAULT_HASH",
      "GIT_DEFAULT_REF_FORMAT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_CONFIG_KEY_37",
      "GIT_CONFIG_VALUE_37",
    ];
    const kept = ["BEAM_TEST_SURVIVES", "GIT_TRACE"]; // non-selection GIT_* passes through
    const saved: Record<string, string | undefined> = {};
    for (const name of [...stripped, ...kept]) saved[name] = process.env[name];
    try {
      for (const name of stripped) process.env[name] = "/attacker";
      process.env.BEAM_TEST_SURVIVES = "yes";
      process.env.GIT_TRACE = "0";
      const env = sanitizedGitEnv();
      for (const name of stripped) expect(env[name]).toBeUndefined();
      expect(env.BEAM_TEST_SURVIVES).toBe("yes");
      expect(env.GIT_TRACE).toBe("0");
      expect(env.PATH).toBe(process.env.PATH!);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

/*
 * ------------------------------------------------------------------------
 * P1 regressions: caller GIT_* environment must never retarget the repo
 * beam operates on or lend objects to verification of a collected repo.
 * ------------------------------------------------------------------------
 */

describe.skipIf(!HAVE_DEPS)(
  "caller Git environment cannot retarget workspace Git operations",
  () => {
  let iso: IsolatedBeam;
  beforeAll(() => {
    iso = isolatedBeam("wtgitenv");
  });
  afterAll(() => restoreBeam(iso));

  /** Unrelated repository a hostile caller points GIT_* variables at. */
  async function makeDecoy(base: string): Promise<{ dir: string; sha: string }> {
    const dir = join(base, "decoy");
    mkdirSync(dir);
    await git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "decoy.txt"), "attacker repo\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "decoy");
    return { dir, sha: (await git(dir, "rev-parse", "HEAD")).stdout.trim() };
  }

  test(
    "external GIT_DIR cannot make beam ship another repository",
    async () => {
      const f = await makeReturnFixture();
      const decoy = await makeDecoy(f.base);

      const saved = process.env.GIT_DIR;
      process.env.GIT_DIR = join(decoy.dir, ".git");
      let m;
      try {
        m = await materializeWorktreeGit(f.wt);
      } finally {
        if (saved === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = saved;
      }
      try {
        // The payload is the shipped worktree's repository, not the decoy's.
        const pgit = (...args: string[]) =>
          runChecked(["git", "--git-dir", m.gitDir, ...args], { env: GIT_ENV });
        expect((await pgit("rev-parse", "HEAD")).stdout.trim()).toBe(f.mainSha);
        expect((await pgit("symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
        expect(
          (await run(["git", "--git-dir", m.gitDir, "cat-file", "-e", decoy.sha])).code,
        ).not.toBe(0);
        const snapshot = readFileSync(join(m.gitDir, "beam-shipped-refs"), "utf8");
        expect(snapshot).toContain(`${f.mainSha} refs/heads/main`);
        expect(snapshot).not.toContain(decoy.sha);
      } finally {
        m.cleanup();
      }
    },
    30_000,
  );

  test(
    "a caller template directory cannot plant hooks in the payload — " +
      "the sentinel hook neither ships nor runs",
    async () => {
      const f = await makeReturnFixture();
      const template = join(f.base, "template");
      mkdirSync(join(template, "hooks"), { recursive: true });
      const marker = join(f.base, "hook-ran");
      writeFileSync(
        join(template, "hooks", "pre-commit"),
        `#!/bin/sh\ntouch ${shq(marker)}\nexit 0\n`,
        { mode: 0o755 },
      );

      const saved = process.env.GIT_TEMPLATE_DIR;
      process.env.GIT_TEMPLATE_DIR = template;
      let m;
      try {
        m = await materializeWorktreeGit(f.wt);
      } finally {
        if (saved === undefined) delete process.env.GIT_TEMPLATE_DIR;
        else process.env.GIT_TEMPLATE_DIR = saved;
      }
      try {
        // Nothing under hooks/ shipped — not even inert samples.
        const hooksDir = join(m.gitDir, "hooks");
        expect(existsSync(hooksDir) ? readdirSync(hooksDir) : []).toEqual([]);

        // A commit made through the reassembled remote payload runs no
        // sentinel: the hook never executed anywhere in the round trip.
        const rhome = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtsim-")));
        const t = new LocalTransport(rhome);
        const remote = join(rhome, "ws");
        await t.syncUp(f.wt, remote, {
          excludes: gatherExcludes(f.wt, { targets: {} }),
          delete: true,
        });
        await t.syncUp(m.gitDir, `${remote}/.git`, { delete: true });
        writeFileSync(join(remote, "hooked.txt"), "commit through the shipped payload\n");
        await git(remote, "add", "hooked.txt");
        await git(remote, "commit", "-q", "-m", "no hooks");
        expect(existsSync(marker)).toBe(false);
      } finally {
        m.cleanup();
      }
    },
    30_000,
  );

  test(
    "external GIT_DIR cannot retarget the import — " +
      "the return lands in the shipped repository, the decoy is untouched",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const remoteHead = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();

      const decoy = await makeDecoy(f.base);
      const decoyBefore = dirManifest(decoy.dir);

      const saved = process.env.GIT_DIR;
      process.env.GIT_DIR = join(decoy.dir, ".git");
      try {
        await cmdDown([record.id]);
      } finally {
        if (saved === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = saved;
      }

      // The remote work came home to the shipped repository — as objects
      // and quarantine pins; the live checkout and worktree never move…
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.mainSha);
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await git(localCwd, "cat-file", "-t", remoteHead)).stdout.trim()).toBe("commit");
      expect(
        (await git(localCwd, "rev-parse", qval(record, "values", "refs/heads/main"))).stdout.trim(),
      ).toBe(remoteHead);
      expect(existsSync(join(localCwd, "remote-new.txt"))).toBe(false);
      expect(existsSync(remoteCwd)).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
      // …and the decoy repository is byte-for-byte untouched.
      expect(dirManifest(decoy.dir)).toBe(decoyBefore);
      expect((await run(["git", "-C", decoy.dir, "cat-file", "-e", remoteHead])).code).not.toBe(0);
    },
    60_000,
  );

  test(
    "external GIT_OBJECT_DIRECTORY cannot lend a collected repository its missing objects — " +
      "the down fails before Git mutation",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const remoteHead = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();

      // Donor object store: a complete copy of the remote repository's
      // objects taken BEFORE corruption — exactly what a hostile caller
      // would lend to make verification pass.
      const donorObjects = join(f.base, "donor-objects");
      cpSync(join(payloadOf(record), "objects"), donorObjects, { recursive: true });

      // Corrupt the remote: the returning HEAD commit's loose object is gone.
      const objDir = join(payloadOf(record), "objects");
      const objPath = join(objDir, remoteHead.slice(0, 2), remoteHead.slice(2));
      expect(existsSync(objPath)).toBe(true);
      rmSync(objPath);

      const saved = process.env.GIT_OBJECT_DIRECTORY;
      process.env.GIT_OBJECT_DIRECTORY = donorObjects;
      try {
        await expect(cmdDown([record.id])).rejects.toThrow(/command failed/);
      } finally {
        if (saved === undefined) delete process.env.GIT_OBJECT_DIRECTORY;
        else process.env.GIT_OBJECT_DIRECTORY = saved;
      }

      // The failure landed BEFORE any local Git mutation: the
      // borrowed object never entered the local repository, HEAD/branch are
      // unmoved, no return quarantine refs exist, the remote Git state is
      // intact for recovery, and the record still says up.
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", remoteHead])).code).not.toBe(0);
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.mainSha);
      expect((await git(localCwd, "for-each-ref", "refs/beam/return")).stdout).toBe("");
      expect(existsSync(join(remoteCwd, ".git"))).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
    },
    60_000,
  );
});

describe.skipIf(!HAVE_DEPS)(
  "cmdDown remote reflog and dangling-object preservation (local transport)",
  () => {
  let iso: IsolatedBeam;
  beforeAll(() => {
    iso = isolatedBeam("wtreflog");
  });
  afterAll(() => restoreBeam(iso));

  test(
    "remote reflog-only commits survive local reflog expiry and gc --prune=now; " +
      "raw reflogs recover byte-exactly",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // Remote work only the reflog remembers: a commit with a unique
      // message, then a hard reset back — the commit is now reachable from
      // NOTHING but the remote HEAD and branch reflogs.
      writeFileSync(join(remoteCwd, "reflog-only.txt"), "remote reflog-only work\n");
      await git(remoteCwd, "add", "reflog-only.txt");
      await git(remoteCwd, "commit", "-q", "-m", "reflog-only secret 5d41402abc");
      const lost = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();
      await git(remoteCwd, "reset", "-q", "--hard", "HEAD~1");
      expect((await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.mainSha);

      // The exact raw bytes the return must preserve, read at the last
      // moment before the down collects them.
      const rawHeadLog = readFileSync(join(payloadOf(record), "logs", "HEAD"));
      const rawMainLog = readFileSync(join(payloadOf(record), "logs", "refs", "heads", "main"));

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.join(" "));
      };
      try {
        await cmdDown([record.id]);
      } finally {
        console.log = origLog;
      }
      expect(existsSync(remoteCwd)).toBe(true);

      const key = worktreeGitReturnKey(record.id, record.wtGit);
      const headLogRef = returnReflogRef(key, qdigestOf(record), "HEAD", rawHeadLog);
      const mainLogRef = returnReflogRef(key, qdigestOf(record), "refs/heads/main", rawMainLog);
      const pinRef = returnReflogPinRef(key, qdigestOf(record), lost);
      // The down reported the exact recovery refs in its notes.
      expect(logs.some((l) => l.includes(headLogRef))).toBe(true);
      expect(logs.some((l) => l.includes(mainLogRef))).toBe(true);
      expect(logs.some((l) => l.includes("reflog-pins"))).toBe(true);

      // Aggressive local GC: expire every reflog, prune everything
      // unreachable. Remote-only history must survive through the pins.
      await git(localCwd, "reflog", "expire", "--expire=now", "--all");
      await git(localCwd, "gc", "--prune=now");

      expect((await git(localCwd, "rev-parse", pinRef)).stdout.trim()).toBe(lost);
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", lost])).code).toBe(0);
      expect((await git(localCwd, "log", "-1", "--format=%s", lost)).stdout.trim()).toBe(
        "reflog-only secret 5d41402abc",
      );
      // Raw reflogs recover byte-for-byte from their digest-keyed blobs.
      expect((await git(localCwd, "cat-file", "blob", headLogRef)).stdout).toBe(
        rawHeadLog.toString(),
      );
      expect((await git(localCwd, "cat-file", "blob", mainLogRef)).stdout).toBe(
        rawMainLog.toString(),
      );
    },
    60_000,
  );

  test(
    "unreferenced remote objects survive without any reflog " +
      "(core.logAllRefUpdates=false, raw hash-object)",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // No reflogs at all: logging disabled before the only commit, so the
      // reset leaves the commit referenced by NOTHING in the collected dir.
      await git(remoteCwd, "config", "core.logAllRefUpdates", "false");
      writeFileSync(join(remoteCwd, "no-reflog.txt"), "no reflog work\n");
      await git(remoteCwd, "add", "no-reflog.txt");
      await git(remoteCwd, "commit", "-q", "-m", "no-reflog secret 7d793037a0");
      const lost = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();
      await git(remoteCwd, "reset", "-q", "--hard", "HEAD~1");
      expect(existsSync(join(payloadOf(record), "logs", "HEAD"))).toBe(false);
      // A raw object written by hand — referenced by nothing, ever.
      const orphanBlob = (
        await runChecked(["git", "-C", remoteCwd, "hash-object", "-w", "--stdin"], {
          env: GIT_ENV,
          stdinText: "orphan bytes\n",
        })
      ).stdout.trim();

      await cmdDown([record.id]);
      expect(existsSync(remoteCwd)).toBe(true);

      const key = worktreeGitReturnKey(record.id, record.wtGit);
      await git(localCwd, "reflog", "expire", "--expire=now", "--all");
      await git(localCwd, "gc", "--prune=now");

      const lostPin = returnObjectPinRef(key, qdigestOf(record), lost);
      expect((await git(localCwd, "rev-parse", lostPin)).stdout.trim()).toBe(lost);
      expect((await git(localCwd, "log", "-1", "--format=%s", lost)).stdout.trim()).toBe(
        "no-reflog secret 7d793037a0",
      );
      const orphanPin = returnObjectPinRef(key, qdigestOf(record), orphanBlob);
      expect((await git(localCwd, "cat-file", "blob", orphanPin)).stdout).toBe("orphan bytes\n");
    },
    60_000,
  );

  test(
    "a malformed remote reflog refuses the down before any local effect " +
      "and leaves the remote intact",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      writeFileSync(join(remoteCwd, "ok.txt"), "fine\n");
      await git(remoteCwd, "add", "ok.txt");
      await git(remoteCwd, "commit", "-q", "-m", "legit remote work");
      const remoteHead = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();

      // Hostile line: null object ids keep git's own lenient reflog
      // iteration (and fsck) quiet, while the strict return grammar
      // refuses — this exercises Beam's validator, not git's.
      const zeros = "0".repeat(remoteHead.length);
      appendFileSync(
        join(payloadOf(record), "logs", "HEAD"),
        `${zeros} ${zeros} not a valid ident or timestamp\n`,
      );

      await expect(cmdDown([record.id])).rejects.toThrow(/malformed remote reflog for HEAD/);

      // Fail-closed BEFORE local mutation: nothing under refs/beam/return,
      // no imported object, unmoved HEAD, remote intact, record still up.
      expect((await git(localCwd, "for-each-ref", "refs/beam/return")).stdout).toBe("");
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", remoteHead])).code).not.toBe(0);
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.mainSha);
      expect(existsSync(join(remoteCwd, ".git"))).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
    },
    60_000,
  );

  test(
    "objects referenced only by a worktree-scoped reflog survive expire and gc",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // A commit written with plumbing — no live ref ever points at it —
      // referenced only by a reflog for a worktree-scoped name. fsck treats
      // every reflog as a reachability root, so this object can never
      // appear unreachable; the reflog capture is its only durability.
      const tree = (await git(remoteCwd, "rev-parse", "HEAD^{tree}")).stdout.trim();
      const msg = "rewritten-only secret e38ad21474";
      const rewritten = (
        await runChecked(
          ["git", "-C", remoteCwd, "commit-tree", tree, "-p", "HEAD", "-m", msg],
          { env: GIT_ENV },
        )
      ).stdout.trim();
      const zeros = "0".repeat(rewritten.length);
      const rawLog =
        `${zeros} ${rewritten} beam <beam@beam.invalid> 1234567890 +0000\t` +
        `rebase: rewritten-only entry\n`;
      mkdirSync(join(payloadOf(record), "logs", "refs", "rewritten"), { recursive: true });
      writeFileSync(join(payloadOf(record), "logs", "refs", "rewritten", "pick"), rawLog);

      await cmdDown([record.id]);
      expect(existsSync(remoteCwd)).toBe(true);

      const key = worktreeGitReturnKey(record.id, record.wtGit);
      await git(localCwd, "reflog", "expire", "--expire=now", "--all");
      await git(localCwd, "gc", "--prune=now");

      const rewrittenPin = returnReflogPinRef(key, qdigestOf(record), rewritten);
      expect((await git(localCwd, "rev-parse", rewrittenPin)).stdout.trim()).toBe(rewritten);
      expect((await git(localCwd, "log", "-1", "--format=%s", rewritten)).stdout.trim()).toBe(
        "rewritten-only secret e38ad21474",
      );
      const logRef = returnReflogRef(key, qdigestOf(record), "refs/rewritten/pick", rawLog);
      expect((await git(localCwd, "cat-file", "blob", logRef)).stdout).toBe(rawLog);
    },
    60_000,
  );

  test(
    "an oversized hostile reflog refuses the down before any local effect",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // 100_001 grammar-valid entries: every line parses and no object
      // lookup can fail (null oids) — only the global line cap refuses.
      const zeros = "0".repeat((await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim().length);
      const line =
        `${zeros} ${zeros} beam <beam@beam.invalid> 1234567890 +0000\t` +
        `checkout: hostile flood\n`;
      mkdirSync(join(payloadOf(record), "logs"), { recursive: true });
      writeFileSync(join(payloadOf(record), "logs", "HEAD"), line.repeat(100_001));

      await expect(cmdDown([record.id])).rejects.toThrow(/exceed 100000 total entries/);
      expect((await git(localCwd, "for-each-ref", "refs/beam/return")).stdout).toBe("");
      expect(existsSync(join(remoteCwd, ".git"))).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
    },
    60_000,
  );
});

/*
 * ------------------------------------------------------------------------
 * Stable remote Git collection: foreign locks and racing writers
 *
 * `beam down` must never import a `.git` that mixes bytes from two remote
 * moments (a background/nohup writer that survived the tmux kill), and
 * must never race — or remove — a foreign Git lock.
 * ------------------------------------------------------------------------
 */

/**
 * LocalTransport delegate whose syncDown runs a hook AFTER the real
 * transfer — a deterministic stand-in for a background writer finishing a
 * mutation while the collection was in flight, or for a transfer that
 * delivered bytes the remote never held together. (A Transport test seam:
 * the delegating methods exist to satisfy the interface.)
 */
class HookedSyncDownTransport implements Transport {
  constructor(
    private readonly inner: LocalTransport,
    public afterSyncDown: (localDir: string) => Promise<void> | void = () => {},
  ) {}
  get label(): string {
    return this.inner.label;
  }
  exec(command: string) {
    return this.inner.exec(command);
  }
  /** Runs after every successful execChecked — lets a test land remote
   * mutations between specific pinned probes (call sites filter on the
   * fingerprint sentinel). */
  afterExecChecked: (command: string) => Promise<void> | void = () => {};
  async execChecked(command: string): Promise<string> {
    const out = await this.inner.execChecked(command);
    await this.afterExecChecked(command);
    return out;
  }
  syncUp(localDir: string, remoteDir: string, opts?: SyncOptions) {
    return this.inner.syncUp(localDir, remoteDir, opts);
  }
  async syncDown(remoteDir: string, localDir: string, opts?: SyncOptions): Promise<void> {
    await this.inner.syncDown(remoteDir, localDir, opts);
    await this.afterSyncDown(localDir);
  }
  exists(remotePath: string) {
    return this.inner.exists(remotePath);
  }
  interactiveArgv(command: string): string[] {
    return this.inner.interactiveArgv(command);
  }
}

describe.skipIf(!HAVE_DEPS)(
  "cmdDown refuses foreign remote Git locks and unstable collections",
  () => {
  let iso: IsolatedBeam;
  beforeAll(() => {
    iso = isolatedBeam("wtstable");
  });
  afterAll(() => restoreBeam(iso));

  test(
    "a pre-existing foreign index.lock refuses the down before any Git mutation, " +
      "and the cleared retry succeeds",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const remoteHead = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();

      // The foreign lock: a background writer's exclusion, live or dead.
      const lockPath = join(payloadOf(record), "index.lock");
      writeFileSync(lockPath, "held by a foreign process\n");
      const remoteBefore = dirManifest(payloadOf(record));
      const localIndexBefore = (await git(localCwd, "ls-files", "-s")).stdout;

      const err = await cmdDown([record.id]).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeDefined();
      expect(String(err)).toContain("command failed (79)");
      expect(String(err)).toContain("./index.lock");
      expect(String(err)).toMatch(/never removes a foreign lock/);

      // The lock is untouched, the remote Git tree is byte-identical, and
      // the local checkout saw no Git mutation.
      expect(readFileSync(lockPath, "utf8")).toBe("held by a foreign process\n");
      expect(dirManifest(payloadOf(record))).toBe(remoteBefore);
      expect(existsSync(remoteCwd)).toBe(true);
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.mainSha);
      expect((await git(localCwd, "ls-files", "-s")).stdout).toBe(localIndexBefore);
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", remoteHead])).code).not.toBe(0);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");

      // Clearing the lock makes the SAME record retryable: the now-stable
      // remote collects, imports, and remains available.
      rmSync(lockPath);
      await cmdDown([record.id]);
      // Quarantine-only convergence: local main never moves; the remote tip
      // arrives as objects with its value pinned under the return namespace.
      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(f.mainSha);
      const mainPin = qval(record, "values", "refs/heads/main");
      expect((await git(localCwd, "rev-parse", mainPin)).stdout.trim()).toBe(remoteHead);
      expect(existsSync(remoteCwd)).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
    },
    120_000,
  );

  test(
    "every foreign lock class refuses the import and is never removed: " +
      "HEAD, packed-refs, config, shallow, refs, objects, linked worktrees",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteGitDir = payloadOf(record);
      const t = new LocalTransport(iso.remoteHome);
      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);

      const locks = [
        "HEAD.lock",
        "packed-refs.lock",
        "config.lock",
        "shallow.lock",
        "refs/heads/main.lock",
        "objects/info/commit-graph.lock",
        "worktrees/w/HEAD.lock",
      ];
      for (const rel of locks) {
        const abs = join(remoteGitDir, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, "foreign\n");
        const err = await importWorktreeGitReturn(t, record).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(String(err)).toContain("command failed (79)");
        expect(String(err)).toContain(`./${rel}`);
        // Never removed — the foreign writer's exclusion stays intact.
        expect(readFileSync(abs, "utf8")).toBe("foreign\n");
        rmSync(abs);
      }
      rmSync(join(remoteGitDir, "worktrees"), { recursive: true, force: true });

      // With every lock cleared the same prepared return imports cleanly.
      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);
      await importWorktreeGitReturn(t, record);
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.mainSha);
    },
    120_000,
  );

  test(
    "a background writer racing the collection refuses with the remote intact, " +
      "and a stable retry succeeds",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const remoteHead = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();

      const t = new HookedSyncDownTransport(new LocalTransport(iso.remoteHome));
      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);
      const localRefsBefore = (await git(localCwd, "for-each-ref")).stdout;
      const localIndexBefore = (await git(localCwd, "ls-files", "-s")).stdout;

      // Three writer shapes, each landing AFTER the transfer read the tree
      // and BEFORE the post-collection proof: a ref update, a HEAD move,
      // and a raw metadata write.
      const writers: Array<() => Promise<void>> = [
        async () => {
          await git(remoteCwd, "update-ref", "refs/heads/rbranch", remoteHead);
        },
        async () => {
          await git(remoteCwd, "checkout", "-q", "--detach");
        },
        async () => {
          appendFileSync(join(payloadOf(record), "config"), "\n[beam]\n\tprobe = 1\n");
        },
      ];
      for (const writer of writers) {
        let remoteAfterWrite = "";
        t.afterSyncDown = async () => {
          await writer();
          remoteAfterWrite = dirManifest(payloadOf(record));
        };
        const err = await importWorktreeGitReturn(t, record).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(String(err)).toMatch(/changed while it was being collected/);
        // Beam rolled nothing back: the writer's effect
        // is exactly what remains remotely…
        expect(dirManifest(payloadOf(record))).toBe(remoteAfterWrite);
        // …and no local Git mutation happened before the refusal.
        expect((await git(localCwd, "for-each-ref")).stdout).toBe(localRefsBefore);
        expect((await git(localCwd, "ls-files", "-s")).stdout).toBe(localIndexBefore);
      }

      // The writers have gone quiet: the same record now collects one
      // stable snapshot and the import proceeds — quarantine-only, so the
      // remote-created branch is pinned, never created locally.
      t.afterSyncDown = () => {};
      await importWorktreeGitReturn(t, record);
      const probe = ["git", "-C", localCwd, "rev-parse", "--verify", "-q", "refs/heads/rbranch"];
      expect((await run(probe)).code).not.toBe(0);
      const rbranchPin = qval(record, "values", "refs/heads/rbranch");
      expect((await git(localCwd, "rev-parse", rbranchPin)).stdout.trim()).toBe(remoteHead);
    },
    120_000,
  );

  test(
    "a quarantine that stops matching the proven remote snapshot refuses " +
      "even when pre and post agree",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      const t = new HookedSyncDownTransport(new LocalTransport(iso.remoteHome), (localDir) => {
        // The transfer delivered bytes the remote never held together —
        // the valid-but-never-existent mix a torn recursive read produces.
        writeFileSync(join(localDir, "beam-injected"), "never existed remotely\n");
      });
      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);
      const remoteBefore = dirManifest(payloadOf(record));

      const err = await importWorktreeGitReturn(t, record).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(String(err)).toMatch(/does not match the proven remote snapshot/);
      expect(dirManifest(payloadOf(record))).toBe(remoteBefore);
      expect(existsSync(remoteCwd)).toBe(true);

      // An honest transfer of the same remote imports cleanly.
      t.afterSyncDown = () => {};
      await importWorktreeGitReturn(t, record);
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.mainSha);
    },
    120_000,
  );

  test(
    "a workspace path swapped for a symlink fails the pinned collection probe before any effect",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      const t = new LocalTransport(iso.remoteHome);
      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);

      const real = `${remoteCwd}.swapped-real`;
      renameSync(remoteCwd, real);
      symlinkSync(real, remoteCwd);
      try {
        const err = await importWorktreeGitReturn(t, record).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(String(err)).toContain("command failed (62)");
        expect(String(err)).toMatch(/no longer resolves/);
      } finally {
        rmSync(remoteCwd, { force: true });
        renameSync(real, remoteCwd);
      }

      // Restored, the same record imports cleanly.
      await importWorktreeGitReturn(t, record);
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.mainSha);
    },
    120_000,
  );

  test(
    "the direct Git-return wrapper detects a writer during local import " +
      "and preserves the late remote work",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const remoteHead = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();

      const t = new HookedSyncDownTransport(new LocalTransport(iso.remoteHome));
      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);

      // The surviving writer stays quiet through the collection proofs,
      // then lands a commit and ref update while the local import is busy:
      // the wrapper's final remote re-proof detects it.
      let fingerprints = 0;
      let lateSha = "";
      let remoteAfterLate = "";
      t.afterExecChecked = async (command) => {
        if (!command.includes("__beam_git_fp_v1__")) return;
        fingerprints += 1;
        if (fingerprints !== 2) return; // right after the post-collect proof passed
        const tree = (await git(remoteCwd, "rev-parse", "HEAD^{tree}")).stdout.trim();
        lateSha = (
          await runChecked(
            ["git", "-C", remoteCwd, "commit-tree", tree, "-p", remoteHead, "-m", "late work"],
            { env: GIT_ENV },
          )
        ).stdout.trim();
        await git(remoteCwd, "update-ref", "refs/heads/late", lateSha);
        remoteAfterLate = dirManifest(payloadOf(record));
      };
      const err = await importWorktreeGitReturn(t, record).then(
        () => undefined,
        (e: unknown) => e,
      );
      // pre + post + final all ran; the refusal came from the final proof.
      expect(fingerprints).toBeGreaterThanOrEqual(3);
      expect(String(err)).toMatch(/changed after it was collected/);
      expect(String(err)).toMatch(/publish a torn remote return/);
      // The late work survives byte-for-byte on the retained remote.
      expect(dirManifest(payloadOf(record))).toBe(remoteAfterLate);
      expect((await git(remoteCwd, "rev-parse", "refs/heads/late")).stdout.trim()).toBe(lateSha);

      // The retry converges: it collects the NEWER remote state, late ref
      // included — everything as objects plus quarantine pins, nothing
      // created or moved locally.
      t.afterExecChecked = () => {};
      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);
      await importWorktreeGitReturn(t, record);
      const probe = ["git", "-C", localCwd, "rev-parse", "--verify", "-q", "refs/heads/late"];
      expect((await run(probe)).code).not.toBe(0);
      expect(
        (await git(localCwd, "rev-parse", qval(record, "values", "refs/heads/late"))).stdout.trim(),
      ).toBe(lateSha);
      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(f.mainSha);
      expect(
        (await git(localCwd, "rev-parse", qval(record, "values", "refs/heads/main"))).stdout.trim(),
      ).toBe(remoteHead);
    },
    120_000,
  );

  test(
    "a remote HEAD retargeted to another unborn branch is preserved as a durable quarantine pin",
    async () => {
      // Fresh unborn repository: symbolic HEAD on main, no commit anywhere.
      const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-unbornhead-")));
      const wt = join(base, "wt");
      mkdirSync(wt);
      await git(wt, "init", "-q", "-b", "main");
      process.chdir(wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // The remote agent renames the unborn branch: still no OID anywhere —
      // the symbolic HEAD target is the ONLY carrier of this work.
      await git(remoteCwd, "symbolic-ref", "HEAD", "refs/heads/other");

      await cmdDown([record.id]);
      expect(existsSync(remoteCwd)).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");

      // The rename is never installed — the local symbolic HEAD is
      // untouched, while the exact remote symbolic target is durable in
      // quarantine.
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      const blob = (
        await git(localCwd, "cat-file", "blob", `${qbaseOf(record)}/meta/HEAD-symref`)
      ).stdout;
      expect(blob).toContain("target refs/heads/other");
    },
    120_000,
  );

  /** Ships a fixture whose tag `qt` diverged — remote A vs local L — with the
   *  return prepared and attempt 1's namespace key material captured. */
  async function makeQtDivergedReturn(): Promise<{
    localCwd: string;
    remoteCwd: string;
    record: BeamRecord;
    t: HookedSyncDownTransport;
    rkey: string;
    digestA: string;
    shaA: string;
    shaL: string;
    commitAt: (cwd: string, msg: string) => Promise<string>;
  }> {
    const f = await makeReturnFixture();
    process.chdir(f.wt);
    const localCwd = process.cwd();
    await cmdUp(["--no-session"]);
    const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
    const remoteCwd = record.remoteCwd;

    // Remote work A on a TAG (tags have no reflog, so the values pin is
    // A's only durable local root); local qt diverges so the return
    // quarantines instead of applying.
    const tree = (await git(remoteCwd, "rev-parse", "HEAD^{tree}")).stdout.trim();
    const commitAt = async (cwd: string, msg: string) =>
      (
        await runChecked(
          ["git", "-C", cwd, "commit-tree", tree, "-p", f.mainSha, "-m", msg],
          { env: GIT_ENV },
        )
      ).stdout.trim();
    const shaA = await commitAt(remoteCwd, "remote A");
    await git(remoteCwd, "update-ref", "refs/tags/qt", shaA);
    const shaL = await commitAt(localCwd, "local L");
    await git(localCwd, "update-ref", "refs/tags/qt", shaL);

    const t = new HookedSyncDownTransport(new LocalTransport(iso.remoteHome));
    await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);
    // The namespace key of attempt 1's collection — captured BEFORE the
    // writer moves the remote; assertions against it stay valid forever.
    const digestA = qdigestOf(record);
    const rkey = worktreeGitReturnKey(record.id, record.wtGit);
    return { localCwd, remoteCwd, record, t, rkey, digestA, shaA, shaL, commitAt };
  }

  test(
    "a retry after a failed final proof keeps BOTH collected values of a quarantined ref " +
      "reachable through gc",
    async () => {
      const { localCwd, remoteCwd, record, t, rkey, digestA, shaA, shaL, commitAt } =
        await makeQtDivergedReturn();
      const qtPin = (digest: string) => returnValueRef(rkey, digest, "values", "refs/tags/qt");
      const qtPinned = async (digest: string) =>
        (await git(localCwd, "rev-parse", qtPin(digest))).stdout.trim();

      // After the post-collect proof passes, the surviving writer moves the
      // tag to B and the remote prunes A — attempt 1 fails the FINAL proof
      // with A already pinned locally.
      let fingerprints = 0;
      let shaB = "";
      t.afterExecChecked = async (command) => {
        if (!command.includes("__beam_git_fp_v1__")) return;
        fingerprints += 1;
        if (fingerprints !== 2) return;
        shaB = await commitAt(remoteCwd, "remote B");
        await git(remoteCwd, "update-ref", "refs/tags/qt", shaB, shaA);
        await git(remoteCwd, "reflog", "expire", "--expire=now", "--all");
        await git(remoteCwd, "gc", "--prune=now");
        expect((await run(["git", "-C", remoteCwd, "cat-file", "-e", shaA])).code).not.toBe(0);
      };
      const err = await importWorktreeGitReturn(t, record).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(String(err)).toMatch(/changed after it was collected/);
      expect(await qtPinned(digestA)).toBe(shaA);

      // Retry collects B into its OWN namespace (a different collected
      // fingerprint): attempt 1's namespace remains untouched history, so
      // the earlier collection can never be orphaned or mistaken for the
      // latest — the manifest in each namespace states what it held.
      t.afterExecChecked = () => {};
      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);
      await importWorktreeGitReturn(t, record);
      expect((await git(localCwd, "rev-parse", "refs/tags/qt")).stdout.trim()).toBe(shaL);
      const digestB = qdigestOf(record);
      expect(digestB).not.toBe(digestA);
      expect(await qtPinned(digestB)).toBe(shaB);
      // Attempt 1's namespace still answers with A — append-only history.
      expect(await qtPinned(digestA)).toBe(shaA);
      // Each namespace's manifest maps the exact source ref to its state
      // RELATIVE TO SHIP (never to a prior collection) and to its pin —
      // the hash in the path is reversible without beam output. qt did
      // not exist at ship, so every collection of it classifies as `new`;
      // the pinned value is what distinguishes the namespaces.
      const manifestB = (
        await git(localCwd, "cat-file", "blob", `${returnQbase(rkey, digestB)}/manifest`)
      ).stdout;
      expect(manifestB).toContain(`collected-fingerprint ${digestB}`);
      expect(manifestB).toContain(
        `ref direct new ${shaB} refs/tags/qt pin ${qtPin(digestB)}`,
      );
      // Attempt 1's manifest is immutable history with the same
      // ship-relative classification, holding A.
      const manifestA = (
        await git(localCwd, "cat-file", "blob", `${returnQbase(rkey, digestA)}/manifest`)
      ).stdout;
      expect(manifestA).toContain(`ref direct new ${shaA} refs/tags/qt pin ${qtPin(digestA)}`);

      // The point of it all: after local reflog expiry + gc, BOTH collected
      // values are still objects in this repository.
      await git(localCwd, "reflog", "expire", "--expire=now", "--all");
      await git(localCwd, "gc", "--prune=now");
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", shaA])).code).toBe(0);
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", shaB])).code).toBe(0);
    },
    120_000,
  );

  /** Ships with cb/delb/xb, diverges everything remotely (S1), and runs down
   *  1 — proving namespace <digest1> pinned the diverged snapshot — then
   *  hands back the state the baseline-restore phase asserts against. */
  async function collectDivergedS1(): Promise<{
    f: ReturnFixture;
    localCwd: string;
    record: BeamRecord;
    remoteCwd: string;
    rkey: string;
    shaCb: string;
    shaXb: string;
    s1StashTip: string;
    digest1: string;
    qb1: string;
  }> {
    const f = await makeReturnFixture();
    process.chdir(f.wt);
    const localCwd = process.cwd();
    // Extra ship-time refs: cb reverts to baseline, delb is deleted then
    // restored, xb stays changed — Main's full stale-latest matrix.
    await git(f.wt, "branch", "cb");
    await git(f.wt, "branch", "delb");
    await git(f.wt, "branch", "xb");
    await cmdUp(["--no-session"]);
    const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
    const remoteCwd = record.remoteCwd;
    const rkey = worktreeGitReturnKey(record.id, record.wtGit);

    // Diverged remote state S1: cb moved, delb deleted, xb moved, a stash
    // pushed, HEAD detached.
    const tree = (await git(remoteCwd, "rev-parse", "HEAD^{tree}")).stdout.trim();
    const commitAt = async (msg: string) =>
      (
        await runChecked(
          ["git", "-C", remoteCwd, "commit-tree", tree, "-p", f.mainSha, "-m", msg],
          { env: GIT_ENV },
        )
      ).stdout.trim();
    const shaCb = await commitAt("cb diverged");
    const shaXb = await commitAt("xb diverged");
    await git(remoteCwd, "update-ref", "refs/heads/cb", shaCb);
    await git(remoteCwd, "update-ref", "refs/heads/xb", shaXb);
    await git(remoteCwd, "update-ref", "-d", "refs/heads/delb");
    writeFileSync(join(remoteCwd, "conflict.txt"), "ours\nstash me\n");
    await git(remoteCwd, "stash", "push", "-q", "-m", "s1");
    const s1StashTip = (await git(remoteCwd, "rev-parse", "refs/stash")).stdout.trim();
    await git(remoteCwd, "checkout", "-q", "--detach");
    const digest1 = qdigestOf(record);

    // Down 1 collects the diverged snapshot into namespace <digest1>.
    await cmdDown([record.id]);
    const qb1 = returnQbase(rkey, digest1);
    const s1Pinned = (await git(localCwd, "rev-parse", `${qb1}/meta/stash`)).stdout.trim();
    expect(s1Pinned).toBe(s1StashTip);
    expect((await git(localCwd, "rev-parse", `${qb1}/meta/HEAD`)).stdout.trim()).toBe(f.mainSha);
    const cbPin1 = returnValueRef(rkey, digest1, "values", "refs/heads/cb");
    expect((await git(localCwd, "rev-parse", cbPin1)).stdout.trim()).toBe(shaCb);
    const delbPin1 = returnValueRef(rkey, digest1, "deleted", "refs/heads/delb");
    expect((await git(localCwd, "rev-parse", delbPin1)).stdout.trim()).toBe(f.mainSha);
    return { f, localCwd, record, remoteCwd, rkey, shaCb, shaXb, s1StashTip, digest1, qb1 };
  }

  test(
    "a later collection restored to baseline gets its own namespace whose manifest reports " +
      "baseline — earlier diverged pins stay history, never latest",
    async () => {
      const { f, localCwd, record, remoteCwd, rkey, shaCb, shaXb, s1StashTip, digest1, qb1 } =
        await collectDivergedS1();
      const verifyCode = async (name: string) =>
        (await run(["git", "-C", localCwd, "rev-parse", "--verify", "-q", name])).code;

      // The remote writer restores the baseline for everything but xb:
      // cb back, delb recreated, stash dropped, HEAD reattached.
      await git(remoteCwd, "checkout", "-q", "main");
      await git(remoteCwd, "update-ref", "refs/heads/cb", f.mainSha, shaCb);
      await git(remoteCwd, "update-ref", "refs/heads/delb", f.mainSha);
      await git(remoteCwd, "stash", "clear");
      const digest2 = qdigestOf(record);
      expect(digest2).not.toBe(digest1);

      // Down 2 collects the restored snapshot into its OWN namespace.
      await cmdDown([record.id]);
      const qb2 = returnQbase(rkey, digest2);
      const manifest2 = (await git(localCwd, "cat-file", "blob", `${qb2}/manifest`)).stdout;
      // The manifest is the authority for "latest": entries restored to
      // the ship baseline are `same` with NO pin, the still-diverged xb
      // carries its pin, the stash is back at ship (none shipped, none
      // collected — `same`), HEAD is attached at the ship position.
      const xbPin = returnValueRef(rkey, digest2, "values", "refs/heads/xb");
      expect(manifest2).toContain(`collected-fingerprint ${digest2}`);
      expect(manifest2).toContain(`ref direct same ${f.mainSha} refs/heads/cb`);
      expect(manifest2).toContain(`ref direct same ${f.mainSha} refs/heads/delb`);
      expect(manifest2).toContain(`ref direct changed ${shaXb} refs/heads/xb pin ${xbPin}`);
      expect(manifest2).toContain("stash none same");
      expect(manifest2).toContain(`head attached ${f.mainSha} refs/heads/main`);
      expect(manifest2).not.toContain("head-pin");
      expect(manifest2).not.toContain("stash-pin");
      // The baseline namespace holds NO stale stash/HEAD/cb/delb pins…
      expect(await verifyCode(`${qb2}/meta/stash`)).not.toBe(0);
      expect(await verifyCode(`${qb2}/meta/HEAD`)).not.toBe(0);
      const cbPin2 = returnValueRef(rkey, digest2, "values", "refs/heads/cb");
      expect(await verifyCode(cbPin2)).not.toBe(0);
      // …while the diverged collection's namespace remains intact history.
      const s1After = (await git(localCwd, "rev-parse", `${qb1}/meta/stash`)).stdout.trim();
      expect(s1After).toBe(s1StashTip);
      const cbPin1 = returnValueRef(rkey, digest1, "values", "refs/heads/cb");
      expect((await git(localCwd, "rev-parse", cbPin1)).stdout.trim()).toBe(shaCb);
      const manifest1 = (await git(localCwd, "cat-file", "blob", `${qb1}/manifest`)).stdout;
      expect(manifest1).toContain(`ref direct changed ${shaCb} refs/heads/cb`);
      expect(manifest1).toContain("stash-pin");
    },
    120_000,
  );

  test(
    "a lock appearing after the pre-collection scan refuses at the post proof " +
      "with zero local import",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const remoteHead = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();

      const lockPath = join(payloadOf(record), "index.lock");
      const t = new HookedSyncDownTransport(new LocalTransport(iso.remoteHome), () => {
        // The writer takes its lock AFTER the pre-scan and the transfer,
        // BEFORE the post-collection proof: the boundary re-scan refuses.
        writeFileSync(lockPath, "late foreign writer\n");
      });
      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);
      const localRefsBefore = (await git(localCwd, "for-each-ref")).stdout;

      const err = await importWorktreeGitReturn(t, record).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(String(err)).toContain("command failed (79)");
      expect(String(err)).toContain("index.lock");
      // Zero local import: no refs written, no remote object entered the
      // local store, and the foreign lock is untouched.
      expect((await git(localCwd, "for-each-ref")).stdout).toBe(localRefsBefore);
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", remoteHead])).code).not.toBe(0);
      expect(readFileSync(lockPath, "utf8")).toBe("late foreign writer\n");

      // Cleared, the same record collects and imports.
      rmSync(lockPath);
      t.afterSyncDown = () => {};
      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);
      await importWorktreeGitReturn(t, record);
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", remoteHead])).code).toBe(0);
    },
    120_000,
  );

  test(
    "a lock that rode the transfer refuses on the pristine collected tree " +
      "even when the remote proofs agree",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;

      const t = new HookedSyncDownTransport(new LocalTransport(iso.remoteHome), (localDir) => {
        // A lock alive only DURING the transfer window: the remote scans
        // bracketing the hashes never see it, but the collected tree does.
        writeFileSync(join(localDir, "refs", "heads", "flap.lock"), "rode the transfer\n");
      });
      await prepareWorktreeGitReturn(localCwd, record.id, record.wtGit);
      const localRefsBefore = (await git(localCwd, "for-each-ref")).stdout;

      const err = await importWorktreeGitReturn(t, record).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(String(err)).toMatch(/collected Git quarantine contains a live lock/);
      expect(String(err)).toContain("flap.lock");
      expect((await git(localCwd, "for-each-ref")).stdout).toBe(localRefsBefore);

      // An honest transfer of the same stable remote imports cleanly.
      t.afterSyncDown = () => {};
      await importWorktreeGitReturn(t, record);
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.mainSha);
    },
    120_000,
  );

  test(
    "non-UTF8 stash reflog bytes ship and return byte-exact and stay reachable after gc",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();

      // A local stash whose reflog message carries bytes that are NOT
      // valid UTF-8 (0xE9, 0xFF): legal in git, corrupted by any utf8
      // decode/encode round trip.
      writeFileSync(join(f.wt, "conflict.txt"), "ours\nlocal stash material\n");
      await git(localCwd, "stash", "push", "-q", "-m", "s-local");
      const localLogPath = join(f.commonGit, "logs", "refs", "stash");
      const mangled = Buffer.from(
        readFileSync(localLogPath).toString("latin1").replace("s-local", "caf\xE9 m\xFFsg s-local"),
        "latin1",
      );
      writeFileSync(localLogPath, mangled);
      expect(mangled.equals(Buffer.from(mangled.toString("utf8"), "utf8"))).toBe(false);

      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      // OUTBOUND: the shipped payload carries the exact bytes, twice —
      // the live reflog and the pinned ship-time snapshot.
      const shippedLog = readFileSync(join(payloadOf(record), "logs", "refs", "stash"));
      expect(shippedLog.equals(mangled)).toBe(true);
      const pinnedLog = readFileSync(join(payloadOf(record), SHIPPED_STASH_LOG_FILE));
      expect(pinnedLog.equals(mangled)).toBe(true);

      // The remote diverges the stash on top of the non-UTF8 history.
      writeFileSync(join(remoteCwd, "conflict.txt"), "ours\nremote stash material\n");
      await git(remoteCwd, "stash", "push", "-q", "-m", "s-remote");
      const remoteTip = (await git(remoteCwd, "rev-parse", "refs/stash")).stdout.trim();
      const remoteRaw = readFileSync(join(payloadOf(record), "logs", "refs", "stash"));
      expect(remoteRaw.subarray(0, mangled.length).equals(mangled)).toBe(true);

      await cmdDown([record.id]);
      const rkey = worktreeGitReturnKey(record.id, record.wtGit);
      const digest = qdigestOf(record);
      const qb = returnQbase(rkey, digest);

      // RETURN: the quarantined raw-reflog blob is byte-exact — its ref is
      // keyed by the byte digest and points at the blob of the exact bytes.
      const h = new Bun.CryptoHasher("sha256");
      h.update(remoteRaw);
      const rawDigest = h.digest("hex");
      const expectedBlob = (
        await runChecked(["git", "-C", localCwd, "hash-object", "--stdin"], {
          stdinBytes: remoteRaw,
        })
      ).stdout.trim();
      const rawLogRef = `${qb}/meta/stash-reflogs/${rawDigest}`;
      expect((await git(localCwd, "rev-parse", rawLogRef)).stdout.trim()).toBe(expectedBlob);
      expect((await git(localCwd, "rev-parse", `${qb}/meta/stash`)).stdout.trim()).toBe(remoteTip);
      // The manifest's raw-reflog identity is the BYTE digest.
      const manifest = (await git(localCwd, "cat-file", "blob", `${qb}/manifest`)).stdout;
      expect(manifest).toContain(`stash changed ${remoteTip} ${rawDigest} 2`);

      // Aggressive local gc: the exact bytes stay reachable.
      await git(localCwd, "reflog", "expire", "--expire=now", "--all");
      await git(localCwd, "gc", "--prune=now");
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", expectedBlob])).code).toBe(0);
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", remoteTip])).code).toBe(0);
    },
    180_000,
  );
});


describe.skipIf(!HAVE_DEPS)(
  "cmdDown local return effects are inode-bound and identity-gated (local transport)",
  () => {
  let iso: IsolatedBeam;
  beforeAll(() => {
    iso = isolatedBeam("wtlock");
  });
  afterAll(() => restoreBeam(iso));

  test(
    "the bound transaction refuses a same-path replacement " +
      "and follows the proven inode after a rename",
    async () => {
      const f = await makeReturnFixture();
      const ship = await shipInfoFor(f.wt);
      const seed2 = join(f.base, "seed2");
      mkdirSync(seed2);
      await git(seed2, "init", "-q");
      writeFileSync(join(seed2, "x.txt"), "x\n");
      await git(seed2, "add", "-A");
      await git(seed2, "commit", "-q", "-m", "x");
      const collectedGit = join(seed2, ".git");
      const seedSha = (await git(seed2, "rev-parse", "HEAD")).stdout.trim();
      const savedCwd = process.cwd();

      // Same-path replacement BEFORE binding: a byte-identical copy passes
      // every pathname and token check, but not the inode proof taken
      // THROUGH the binding — and the replacement stays untouched.
      const moved = `${f.commonGit}.moved`;
      renameSync(f.commonGit, moved);
      cpSync(moved, f.commonGit, { recursive: true });
      const replacementBefore = dirManifest(f.commonGit);
      await expect(bindReturnRepo(f.wt, ship)).rejects.toThrow(
        /not the directory this handoff shipped from/,
      );
      expect(process.cwd()).toBe(savedCwd);
      expect(dirManifest(f.commonGit)).toBe(replacementBefore);
      rmSync(f.commonGit, { recursive: true, force: true });
      renameSync(moved, f.commonGit);

      // Rename AFTER binding: every bound-relative effect follows the
      // proven inode; a fresh replacement at the old path stays
      // byte-identical.
      const bound = await bindReturnRepo(f.wt, ship);
      try {
        renameSync(f.commonGit, moved);
        cpSync(moved, f.commonGit, { recursive: true });
        const replacementManifest = dirManifest(f.commonGit);
        importObjects(collectedGit, bound.commonPrefix);
        expect(dirManifest(f.commonGit)).toBe(replacementManifest);
        const movedObj = join(moved, "objects", seedSha.slice(0, 2), seedSha.slice(2));
        expect(existsSync(movedObj)).toBe(true);
      } finally {
        bound.restore();
      }
      expect(process.cwd()).toBe(savedCwd);
    },
    60_000,
  );

  test(
    "a branch force-checked-out in two worktrees is quarantined " +
      "and both checkout states are preserved",
    async () => {
      // The RETURNING worktree is deliberately listed LAST so a last-entry-
      // wins ownership map would call the branch local and CAS it under the
      // sibling checkout.
      const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-wtdup-")));
      const seed = join(base, "seed");
      mkdirSync(seed);
      await git(seed, "init", "-q", "-b", "main");
      writeFileSync(join(seed, "file.txt"), "base\n");
      await git(seed, "add", "-A");
      await git(seed, "commit", "-q", "-m", "base");
      const commonGit = join(base, "common.git");
      await runChecked(["git", "clone", "-q", "--bare", seed, commonGit], { env: GIT_ENV });
      rmSync(seed, { recursive: true, force: true });
      await git(commonGit, "remote", "set-url", "origin", "https://example.invalid/dup.git");
      const mainSha = (await git(commonGit, "rev-parse", "main")).stdout.trim();
      const wtDup = join(base, "wt-dup");
      await git(commonGit, "worktree", "add", "-q", wtDup, "main");
      const wt = join(base, "wt");
      await runChecked(["git", "-C", commonGit, "worktree", "add", "-q", "-f", wt, "main"], {
        env: GIT_ENV,
      });

      process.chdir(wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const rMain = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();
      const dupHead = readFileSync(join(commonGit, "worktrees", "wt-dup", "HEAD"), "utf8");

      await cmdDown([record.id]);

      // The shared branch never moved under the sibling checkout; the
      // remote advance stays reachable under the return namespace.
      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(mainSha);
      expect(
        (await git(localCwd, "rev-parse", qval(record, "values", "refs/heads/main"))).stdout.trim(),
      ).toBe(rMain);
      expect((await git(localCwd, "rev-parse", `${qbaseOf(record)}/meta/HEAD`)).stdout.trim()).toBe(
        rMain,
      );
      // Both checkout states preserved: the sibling byte-for-byte, the
      // returning worktree still attached at the pre-return position.
      expect(readFileSync(join(commonGit, "worktrees", "wt-dup", "HEAD"), "utf8")).toBe(dupHead);
      expect((await git(wtDup, "rev-parse", "HEAD")).stdout.trim()).toBe(mainSha);
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(mainSha);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
      expect(existsSync(remoteCwd)).toBe(true);
    },
    60_000,
  );

  test(
    "a plain-workspace record refuses the return when its path became a Git checkout",
    async () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-plainlegacy-")));
      const ws = join(base, "ws");
      mkdirSync(ws);
      writeFileSync(join(ws, "notes.txt"), "plain workspace\n");
      process.chdir(ws);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      expect(record.wtGit).toBeUndefined();
      const remoteCwd = record.remoteCwd;
      writeFileSync(join(remoteCwd, "remote.txt"), "made remotely\n");

      // The plain workspace is replaced by a STANDARD repository at the
      // same path: an identity-less record must refuse — the old behavior
      // treated anything non-linked as plain and mirrored old remote bytes
      // over the unrelated repo.
      process.chdir(base);
      rmSync(ws, { recursive: true, force: true });
      mkdirSync(ws);
      await git(ws, "init", "-q", "-b", "main");
      writeFileSync(join(ws, "unrelated.txt"), "unrelated repository\n");
      await git(ws, "add", "-A");
      await git(ws, "commit", "-q", "-m", "unrelated");
      const before = dirManifest(ws);

      await expect(cmdDown([record.id])).rejects.toThrow(/carries no Git identity/);
      expect(dirManifest(ws)).toBe(before);
      expect(existsSync(join(remoteCwd, "remote.txt"))).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
    },
    60_000,
  );

  test(
    "a worktree git dir re-parented mid-import cannot lend its new parent to common effects",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");

      // A decoy repository another parent could lend to `..` traversal.
      const decoy = join(f.base, "decoy.git");
      await runChecked(["git", "clone", "-q", "--bare", f.commonGit, decoy], { env: GIT_ENV });
      const decoyMain = (await git(decoy, "rev-parse", "refs/heads/main")).stdout.trim();
      const decoyObjects = dirManifest(join(decoy, "objects"));

      // Mid-import interposition (first common-phase ref transaction):
      // move the HELD worktree git dir under the decoy. Every later
      // transition must refuse — no effect may follow the new parent.
      const marker = join(f.base, "hook-fired");
      const wtGitDir = join(f.commonGit, "worktrees", "wt");
      const hookDir = join(f.commonGit, "hooks");
      mkdirSync(hookDir, { recursive: true });
      const hookPath = join(hookDir, "reference-transaction");
      writeFileSync(
        hookPath,
        `#!/bin/sh\n` +
          `input=$(cat)\n` +
          `case "$input" in\n` +
          `  *"refs/beam/return/"*)\n` +
          `    if [ ! -f ${shq(marker)} ]; then\n` +
          `      : > ${shq(marker)}\n` +
          `      mkdir -p ${shq(join(decoy, "worktrees"))}\n` +
          `      mv ${shq(wtGitDir)} ${shq(join(decoy, "worktrees", "wt"))}\n` +
          `    fi\n` +
          `    ;;\n` +
          `esac\n` +
          `exit 0\n`,
      );
      chmodSync(hookPath, 0o755);

      const movedGitDir = join(decoy, "worktrees", "wt");
      await expect(cmdDown([record.id])).rejects.toThrow();
      expect(existsSync(marker)).toBe(true);
      // The decoy never received a byte of checkout/ref/object state.
      expect((await git(decoy, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(decoyMain);
      expect((await git(decoy, "for-each-ref", "refs/beam")).stdout).toBe("");
      expect(dirManifest(join(decoy, "objects"))).toBe(decoyObjects);
      // The original repository's checkout state is untouched too.
      expect((await git(f.commonGit, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(
        f.mainSha,
      );
      expect(readFileSync(join(movedGitDir, "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
      expect(existsSync(join(remoteCwd, ".git"))).toBe(true);
      expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
    },
    120_000,
  );
});

describe.skipIf(!HAVE_DEPS)("importObjects concurrent additive publication", () => {
  /**
   * A source repository with a pack (repacked history) plus a spread of
   * loose objects, and an empty bare destination sharing nothing with it.
   */
  async function makeStores(): Promise<{
    collected: string;
    common: string;
    oids: string[];
    commit: string;
  }> {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-objrace-")));
    const seed = join(base, "seed");
    mkdirSync(seed);
    await git(seed, "init", "-q", "-b", "main");
    for (let i = 0; i < 40; i++) writeFileSync(join(seed, `f${i}.txt`), `packed content ${i}\n`);
    await git(seed, "add", "-A");
    await runChecked(["git", "-C", seed, "commit", "-q", "-m", "packed base"], { env: GIT_ENV });
    const commit = (await git(seed, "rev-parse", "HEAD")).stdout.trim();
    await git(seed, "repack", "-adq");
    const oids: string[] = [commit];
    for (let i = 0; i < 200; i++) {
      oids.push(
        (
          await runChecked(["git", "-C", seed, "hash-object", "-w", "--stdin"], {
            stdinText: `loose blob ${i}\n`,
          })
        ).stdout.trim(),
      );
    }
    const common = join(base, "common.git");
    await runChecked(["git", "init", "-q", "--bare", common], { env: GIT_ENV });
    return { collected: join(seed, ".git"), common, oids, commit };
  }

  /** Every temp the publisher stages is removed on every outcome. */
  function noTempResidue(objectsDir: string): boolean {
    // Explicit bounded stack (Tiger: no recursion): a Git objects tree is
    // two levels of fan-out, so the ceiling only trips on a fixture bug.
    const MAX_RESIDUE_WALK_DIRS = 10_000;
    const leftovers: string[] = [];
    const stack: string[] = [objectsDir];
    let visited = 0;
    while (stack.length > 0) {
      const dir = stack.pop()!;
      visited += 1;
      if (visited > MAX_RESIDUE_WALK_DIRS) {
        throw new Error(`noTempResidue walked more than ${MAX_RESIDUE_WALK_DIRS} directories`);
      }
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(p);
          continue;
        }
        if (entry.name.includes(".beam-tmp")) {
          leftovers.push(p);
        }
      }
    }
    return leftovers.length === 0;
  }

  test(
    "two whole-process concurrent imports into one shared object store leave every object " +
      "and pack valid, no partial, no temp residue",
    async () => {
      const { collected, common, oids, commit } = await makeStores();
      // Two real processes race the SAME import: every exists-check window
      // overlaps, so publications collide exactly like sibling record
      // downs sharing a common repository.
      const script = join(dirname(common), "import.ts");
      const srcPath = join(import.meta.dir, "..", "src", "workspace-git.ts");
      writeFileSync(
        script,
        `import { importObjects } from ${JSON.stringify(srcPath)};\n` +
          `importObjects(process.argv[2]!, process.argv[3]!);\n`,
      );
      const child = () =>
        Bun.spawn([process.execPath, script, collected, common], {
          stdout: "pipe",
          stderr: "pipe",
        });
      const [a, b] = [child(), child()];
      const [codeA, codeB] = await Promise.all([a.exited, b.exited]);
      const errA = await new Response(a.stderr as ReadableStream).text();
      const errB = await new Response(b.stderr as ReadableStream).text();
      // Identical content is the content-addressed winner on every raced
      // name: both imports converge, neither refuses.
      expect({ codeA, errA, codeB, errB }).toEqual({ codeA: 0, errA: "", codeB: 0, errB: "" });

      // The shared store is whole: every source object present and valid,
      // full integrity over packs and loose objects, no staged residue.
      for (const oid of oids) {
        expect((await run(["git", "--git-dir", common, "cat-file", "-e", oid])).code).toBe(0);
      }
      expect((await git(common, "cat-file", "-t", commit)).stdout.trim()).toBe("commit");
      await runChecked(["git", "--git-dir", common, "fsck", "--full", "--strict"], {
        env: GIT_ENV,
      });
      expect(noTempResidue(join(common, "objects"))).toBe(true);
    },
    120_000,
  );

  test(
    "a destination raced in after the existence check is never overwritten: " +
      "identical bytes converge, diverged bytes refuse intact",
    async () => {
      const { collected, common, commit } = await makeStores();

      // Diverged interposition: the exact partial-pack shape the fixed
      // temp name used to publish. The import must refuse and leave the
      // raced bytes byte-for-byte.
      const partial = Buffer.from("partial pack bytes a fixed-temp race used to publish");
      let interposed: string | undefined;
      importObjectsTestSeam.beforePublish = (dst: string) => {
        if (interposed !== undefined || !dst.endsWith(".pack")) return;
        interposed = dst;
        mkdirSync(dirname(dst), { recursive: true });
        writeFileSync(dst, partial);
      };
      try {
        expect(() => importObjects(collected, common)).toThrow(
          /already exists with different content/,
        );
      } finally {
        importObjectsTestSeam.beforePublish = undefined;
      }
      expect(interposed).toBeDefined();
      expect(readFileSync(interposed!)).toEqual(partial);
      expect(noTempResidue(join(common, "objects"))).toBe(true);

      // Identical interposition: the raced winner IS this import's own
      // content — the retry converges over it silently once the diverged
      // entry is repaired, and the store ends whole.
      rmSync(interposed!);
      const winners: string[] = [];
      importObjectsTestSeam.beforePublish = (dst: string) => {
        if (winners.length > 0) return;
        winners.push(dst);
        mkdirSync(dirname(dst), { recursive: true });
        const rel = dst.slice(join(common, "objects").length + 1);
        writeFileSync(dst, readFileSync(join(collected, "objects", rel)));
      };
      try {
        importObjects(collected, common);
      } finally {
        importObjectsTestSeam.beforePublish = undefined;
      }
      expect(winners.length).toBe(1);
      expect((await git(common, "cat-file", "-t", commit)).stdout.trim()).toBe("commit");
      await runChecked(["git", "--git-dir", common, "fsck", "--full", "--strict"], {
        env: GIT_ENV,
      });
      expect(noTempResidue(join(common, "objects"))).toBe(true);
    },
    60_000,
  );
});

/*
 * ------------------------------------------------------------------------
 * Staged workspace return: no wtGit down may mutate the local worktree
 * before the remote `.git` is proven present, stable, and bound to the
 * shipped repository. Destruction is a separate, explicit
 * `beam kill <id> --purge` abandonment after inspection/integration.
 * ------------------------------------------------------------------------
 */

describe.skipIf(!HAVE_DEPS)(
  "cmdDown stages the wtGit return without touching the local workspace (local transport)",
  () => {
  let iso: IsolatedBeam;
  beforeAll(() => {
    iso = isolatedBeam("wtstaged");
  });
  afterAll(() => restoreBeam(iso));

  const recordStatus = (id: string) =>
    loadState(resolveEnv()).records.find((r) => r.id === id)!.status;

  /** Persisted return-stage txn roots of one record, oldest first. */
  const returnStages = (recordId: string): string[] => {
    const dir = join(process.env.BEAM_DIR!, "returns", recordId);
    return existsSync(dir)
      ? readdirSync(dir)
          .sort()
          .map((n) => join(dir, n))
      : [];
  };

  /** Byte-level local state: worktree files plus the whole repository. */
  const localState = (localCwd: string, commonGit: string) => ({
    worktree: dirManifest(localCwd),
    git: dirManifest(commonGit),
  });

  test(
    "a remote whose .git was removed refuses --delete before any local or stage byte, " +
      "and the repaired retry converges",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      // Hostile workspace content beside the missing `.git`: under a
      // pre-staging flow the --delete mirror would already have landed it
      // (and erased local files) before the Git import could refuse.
      writeFileSync(join(remoteCwd, "hostile.txt"), "planted\n");
      const gitAside = join(f.base, "git-aside");
      renameSync(join(remoteCwd, ".git"), gitAside);

      const before = localState(localCwd, f.commonGit);
      const err = await cmdDown([record.id, "--delete"]).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(String(err)).toMatch(/remote \.git .* is missing/);
      // Local worktree AND repository byte-identical, no verified stage
      // was persisted, and the remote — hostile file included — is intact.
      expect(localState(localCwd, f.commonGit)).toEqual(before);
      expect(returnStages(record.id)).toEqual([]);
      expect(readFileSync(join(remoteCwd, "hostile.txt"), "utf8")).toBe("planted\n");
      expect(recordStatus(record.id)).toBe("up");

      // Repair: the shipped `.git` returns, and the retry converges — the
      // planted file rides home INTO THE STAGE; the live worktree is
      // never touched.
      renameSync(gitAside, join(remoteCwd, ".git"));
      await cmdDown([record.id, "--delete"]);
      expect(dirManifest(localCwd)).toBe(before.worktree);
      const stages = returnStages(record.id);
      expect(stages.length).toBe(1);
      expect(readFileSync(join(stages[0]!, "workspace", "hostile.txt"), "utf8")).toBe("planted\n");
      expect(existsSync(join(stages[0]!, "manifest.json"))).toBe(true);
      expect(existsSync(remoteCwd)).toBe(true);
      expect(recordStatus(record.id)).toBe("up");
    },
    120_000,
  );

  test(
    "a remote .git replaced by an unrelated valid repository refuses on the shipped " +
      "identity tokens with local intact",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      writeFileSync(join(remoteCwd, "hostile.txt"), "planted\n");
      const payloadAside = join(f.base, "payload-aside");
      renameSync(payloadOf(record), payloadAside);
      // An unrelated but perfectly VALID repository behind the original
      // record-bound `.git` pointer: it fingerprints stable, fscks clean,
      // and parses — only the pinned ship-time identity tokens distinguish
      // it from this handoff's repository.
      const alien = join(f.base, "alien");
      mkdirSync(alien);
      await git(alien, "init", "-q", "-b", "main");
      // CI runner git may detach background gc/maintenance after the
      // commit, leaving a transient *.lock the collect-side lockscan would
      // refuse on (exit 79) before the identity check under test runs —
      // disable it and sweep any leftover lock before installing the repo.
      await git(alien, "config", "gc.auto", "0");
      await git(alien, "config", "gc.autoDetach", "false");
      await git(alien, "config", "maintenance.auto", "false");
      writeFileSync(join(alien, "seed.txt"), "unrelated\n");
      await git(alien, "add", "-A");
      await git(alien, "commit", "-q", "-m", "unrelated");
      for (const file of walk(join(alien, ".git"))) {
        if (file.endsWith(".lock")) rmSync(file);
      }
      renameSync(join(alien, ".git"), payloadOf(record));

      const before = localState(localCwd, f.commonGit);
      const remoteBefore = dirManifest(remoteCwd);
      const err = await cmdDown([record.id, "--delete"]).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(String(err)).toMatch(/no longer carries beam-shipped-refs/);
      expect(localState(localCwd, f.commonGit)).toEqual(before);
      expect(returnStages(record.id)).toEqual([]);
      expect(dirManifest(remoteCwd)).toBe(remoteBefore);
      expect(recordStatus(record.id)).toBe("up");

      // Repair: the shipped payload returns behind the untouched `.git`
      // pointer; the retry converges.
      rmSync(payloadOf(record), { recursive: true, force: true });
      renameSync(payloadAside, payloadOf(record));
      await cmdDown([record.id, "--delete"]);
      expect(dirManifest(localCwd)).toBe(before.worktree);
      const stages = returnStages(record.id);
      expect(stages.length).toBe(1);
      expect(readFileSync(join(stages[0]!, "workspace", "hostile.txt"), "utf8")).toBe("planted\n");
      expect(existsSync(remoteCwd)).toBe(true);
      expect(recordStatus(record.id)).toBe("up");
    },
    120_000,
  );

  test(
    "a deleted-and-recreated remote workspace full of hostile files refuses --delete " +
      "with nothing collected",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      // The whole workspace is destroyed and recreated hostile: under a
      // pre-staging flow, `--delete` would mirror this nearly-empty tree
      // over the local worktree — erasing it — before the missing `.git`
      // could refuse anything.
      const saved = join(f.base, "ws-saved");
      renameSync(remoteCwd, saved);
      mkdirSync(remoteCwd);
      writeFileSync(join(remoteCwd, "hostile.txt"), "planted\n");
      mkdirSync(join(remoteCwd, "src"));
      writeFileSync(join(remoteCwd, "src", "evil.ts"), "export {};\n");

      const before = localState(localCwd, f.commonGit);
      const err = await cmdDown([record.id, "--delete"]).then(
        () => undefined,
        (e: unknown) => e,
      );
      // The recreated workspace carries no `.beam/owner`: the record-bound
      // ownership proof refuses before ANY collection — earlier and
      // stronger than the missing-pointer refusal it once reached.
      expect(String(err)).toMatch(/not owned by this handoff/);
      expect(localState(localCwd, f.commonGit)).toEqual(before);
      expect(returnStages(record.id)).toEqual([]);
      expect(readFileSync(join(remoteCwd, "hostile.txt"), "utf8")).toBe("planted\n");
      expect(recordStatus(record.id)).toBe("up");

      // Repair: the original workspace returns; the retry converges.
      rmSync(remoteCwd, { recursive: true, force: true });
      renameSync(saved, remoteCwd);
      await cmdDown([record.id, "--delete"]);
      expect(dirManifest(localCwd)).toBe(before.worktree);
      expect(existsSync(remoteCwd)).toBe(true);
      expect(recordStatus(record.id)).toBe("up");
    },
    120_000,
  );

  test(
    "an honest --delete return persists the exact remote tree in the stage " +
      "and leaves the live worktree byte-identical",
    async () => {
      const f = await makeReturnFixture();
      writeFileSync(join(f.wt, ".beamignore"), "secrets/\n");
      mkdirSync(join(f.wt, "secrets"));
      writeFileSync(join(f.wt, "secrets", "keys.txt"), "shh\n");
      writeFileSync(join(f.wt, "goes-away.txt"), "deleted remotely\n");
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      expect(existsSync(join(remoteCwd, "secrets"))).toBe(false); // excluded outbound

      rmSync(join(remoteCwd, "goes-away.txt"));
      writeFileSync(join(remoteCwd, "remote-new.txt"), "made remotely\n");
      await git(remoteCwd, "add", "remote-new.txt");
      await git(remoteCwd, "commit", "-q", "-m", "remote work");
      const rMain = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();

      const worktreeBefore = dirManifest(localCwd);
      await cmdDown([record.id, "--delete"]);

      // The live worktree and checkout are byte-identical: nothing arrived,
      // nothing was deleted, HEAD and main never moved.
      expect(dirManifest(localCwd)).toBe(worktreeBefore);
      expect(readFileSync(join(localCwd, "goes-away.txt"), "utf8")).toBe("deleted remotely\n");
      expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(f.mainSha);
      expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
      expect((await git(localCwd, "rev-parse", "HEAD")).stdout.trim()).toBe(f.mainSha);

      // The stage holds the exact remote tree: the new file present, the
      // remotely deleted file mirrored out (--delete), the receipt beside
      // it — and the remote commit's objects landed additively with the
      // remote tip pinned under the return namespace.
      const stages = returnStages(record.id);
      expect(stages.length).toBe(1);
      const stageWs = join(stages[0]!, "workspace");
      expect(readFileSync(join(stageWs, "remote-new.txt"), "utf8")).toBe("made remotely\n");
      expect(existsSync(join(stageWs, "goes-away.txt"))).toBe(false);
      expect(existsSync(join(stageWs, "secrets"))).toBe(false); // excluded namespace never staged
      expect(existsSync(join(stages[0]!, "manifest.json"))).toBe(true);
      expect((await run(["git", "-C", localCwd, "cat-file", "-e", rMain])).code).toBe(0);
      expect(
        (await git(localCwd, "rev-parse", qval(record, "values", "refs/heads/main"))).stdout.trim(),
      ).toBe(rMain);
      expect(existsSync(remoteCwd)).toBe(true);
      expect(recordStatus(record.id)).toBe("up");

      // The printed recovery path works: an explicit rsync from the stage
      // integrates the returned files, deletions included.
      await runChecked([
        "rsync",
        "-a",
        "--checksum",
        "--delete",
        "--exclude=/.beam",
        "--exclude=.git",
        "--exclude=secrets/",
        `${stageWs}/`,
        `${localCwd}/`,
      ]);
      expect(readFileSync(join(localCwd, "remote-new.txt"), "utf8")).toBe("made remotely\n");
      expect(existsSync(join(localCwd, "goes-away.txt"))).toBe(false);
      expect(readFileSync(join(localCwd, "secrets", "keys.txt"), "utf8")).toBe("shh\n");
    },
    120_000,
  );

  /**
   * Install a PATH rsync shim that, once, right after the real rsync whose
   * argv mentions `trigger` completes, runs `action` in a shell — a
   * deterministic stand-in for a detached/nohup child (remote writes) or a
   * concurrent local editor (local writes) racing the down at an exact
   * pipeline stage. `skipMatches` skips that many earlier trigger-matching
   * transfers first, so a test can land the write after a LATER pipeline
   * probe (the pre-stage, post-stage, and final proofs all use the same
   * probe directory prefix).
   */
  const withLateWriter = async (
    base: string,
    trigger: string,
    action: string,
    body: (marker: string) => Promise<void>,
    skipMatches = 0,
  ): Promise<void> => {
    const realRsync = Bun.which("rsync")!;
    const fakeBin = join(base, "late-bin");
    mkdirSync(fakeBin);
    const marker = join(base, "late-fired");
    const count = join(base, "late-count");
    writeFileSync(
      join(fakeBin, "rsync"),
      `#!/bin/sh\n` +
        `"$BEAM_REAL_RSYNC" "$@"\n` +
        `rc=$?\n` +
        `# rsync re-invokes itself as a --server child for local transfers;\n` +
        `# only the CLIENT invocation counts, so each logical transfer\n` +
        `# matches exactly once and skip counts stay stable.\n` +
        `case "$1" in --server*) exit "$rc" ;; esac\n` +
        `if [ "$rc" = "0" ] && [ ! -e "$BEAM_LATE_MARKER" ]; then\n` +
        `  for arg in "$@"; do\n` +
        `    case "$arg" in\n` +
        `      *"$BEAM_LATE_TRIGGER"*)\n` +
        `        n=0\n` +
        `        [ -e "$BEAM_LATE_COUNT" ] && n=$(cat "$BEAM_LATE_COUNT")\n` +
        `        n=$((n+1))\n` +
        `        printf '%s' "$n" > "$BEAM_LATE_COUNT"\n` +
        `        if [ "$n" -gt "$BEAM_LATE_SKIP" ]; then\n` +
        `          : > "$BEAM_LATE_MARKER"\n` +
        `          sh -c "$BEAM_LATE_ACTION"\n` +
        `        fi\n` +
        `        break\n` +
        `        ;;\n` +
        `    esac\n` +
        `  done\n` +
        `fi\n` +
        `exit "$rc"\n`,
    );
    chmodSync(join(fakeBin, "rsync"), 0o755);
    const savedPath = process.env.PATH;
    Object.assign(process.env, {
      PATH: `${fakeBin}:${savedPath}`,
      BEAM_REAL_RSYNC: realRsync,
      BEAM_LATE_MARKER: marker,
      BEAM_LATE_COUNT: count,
      BEAM_LATE_SKIP: String(skipMatches),
      BEAM_LATE_ACTION: action,
      BEAM_LATE_TRIGGER: trigger,
    });
    try {
      await body(marker);
    } finally {
      process.env.PATH = savedPath;
      for (const key of [
        "BEAM_REAL_RSYNC",
        "BEAM_LATE_MARKER",
        "BEAM_LATE_COUNT",
        "BEAM_LATE_SKIP",
        "BEAM_LATE_ACTION",
        "BEAM_LATE_TRIGGER",
      ]) {
        delete process.env[key];
      }
    }
  };

  test(
    "a racing LOCAL editor is untouched for a plain handoff; " +
      "the verified return is staged exactly and retained",
    async () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-plain-local-race-")));
      const localCwd = join(base, "workspace");
      mkdirSync(localCwd);
      writeFileSync(join(localCwd, "conflict.txt"), "shipped\n");
      process.chdir(localCwd);
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      writeFileSync(join(record.remoteCwd, "conflict.txt"), "remote change\n");
      writeFileSync(join(record.remoteCwd, "remote-work.txt"), "honest\n");

      const editLocal =
        `printf 'concurrent local edit\\n' > ${shq(join(localCwd, "conflict.txt"))} && ` +
        `printf 'brand new\\n' > ${shq(join(localCwd, "local-new.txt"))}`;
      await withLateWriter(base, ".beam/returns/", editLocal, async (marker) => {
        await cmdDown([record.id]);
        expect(existsSync(marker)).toBe(true);
        expect(readFileSync(join(localCwd, "conflict.txt"), "utf8")).toBe(
          "concurrent local edit\n",
        );
        expect(readFileSync(join(localCwd, "local-new.txt"), "utf8")).toBe("brand new\n");
        expect(existsSync(join(localCwd, "remote-work.txt"))).toBe(false);
        const stages = returnStages(record.id);
        expect(stages.length).toBe(1);
        expect(readFileSync(join(stages[0]!, "workspace", "conflict.txt"), "utf8")).toBe(
          "remote change\n",
        );
        expect(readFileSync(join(stages[0]!, "workspace", "remote-work.txt"), "utf8")).toBe(
          "honest\n",
        );
        expect(existsSync(join(stages[0]!, "workspace", "local-new.txt"))).toBe(false);
        expect(existsSync(record.remoteCwd)).toBe(true);
        expect(recordStatus(record.id)).toBe("up");
      });
    },
    120_000,
  );

  test(
    "a plain remote write right after syncDown invalidates the collection; " +
      "no stage or local byte survives, retry collects it",
    async () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-plain-stage-race-")));
      const localCwd = join(base, "workspace");
      mkdirSync(localCwd);
      writeFileSync(join(localCwd, "local.txt"), "untouched\n");
      process.chdir(localCwd);
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      writeFileSync(join(record.remoteCwd, "remote-work.txt"), "honest\n");
      const before = dirManifest(localCwd);
      const plantLate = `printf 'late work\\n' > ${shq(join(record.remoteCwd, "late-work.txt"))}`;

      await withLateWriter(base, ".beam/returns/", plantLate, async (marker) => {
        await expect(cmdDown([record.id])).rejects.toThrow(/changed while it was being staged/);
        expect(existsSync(marker)).toBe(true);
        expect(dirManifest(localCwd)).toBe(before);
        expect(returnStages(record.id)).toEqual([]);
        expect(readFileSync(join(record.remoteCwd, "late-work.txt"), "utf8")).toBe("late work\n");
        expect(recordStatus(record.id)).toBe("up");

        await cmdDown([record.id]);
        const stages = returnStages(record.id);
        expect(stages.length).toBe(1);
        expect(readFileSync(join(stages[0]!, "workspace", "late-work.txt"), "utf8")).toBe(
          "late work\n",
        );
        expect(dirManifest(localCwd)).toBe(before);
        expect(existsSync(record.remoteCwd)).toBe(true);
        expect(recordStatus(record.id)).toBe("up");
      });
    },
    120_000,
  );

  test(
    "a plain remote write after the pre-proof invalidates the stage; " +
      "retry collects the newer snapshot",
    async () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-plain-preproof-race-")));
      const localCwd = join(base, "workspace");
      mkdirSync(localCwd);
      writeFileSync(join(localCwd, "local.txt"), "untouched\n");
      process.chdir(localCwd);
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      writeFileSync(join(record.remoteCwd, "remote-work.txt"), "honest\n");
      const before = dirManifest(localCwd);
      const plantLate = `printf 'late work\\n' > ${shq(join(record.remoteCwd, "late-work.txt"))}`;

      // The shim fires after the pre-stage probe's rsync returns, so the
      // authoritative stage sees newer bytes than the pinned pre-proof.
      await withLateWriter(base, "beam-wsverify-", plantLate, async (marker) => {
        await expect(cmdDown([record.id])).rejects.toThrow(/changed while it was being staged/);
        expect(existsSync(marker)).toBe(true);
        expect(dirManifest(localCwd)).toBe(before);
        expect(returnStages(record.id)).toEqual([]);
        expect(readFileSync(join(record.remoteCwd, "late-work.txt"), "utf8")).toBe("late work\n");
        expect(recordStatus(record.id)).toBe("up");

        await cmdDown([record.id]);
        const stages = returnStages(record.id);
        expect(stages.length).toBe(1);
        expect(readFileSync(join(stages[0]!, "workspace", "remote-work.txt"), "utf8")).toBe(
          "honest\n",
        );
        expect(readFileSync(join(stages[0]!, "workspace", "late-work.txt"), "utf8")).toBe(
          "late work\n",
        );
        expect(dirManifest(localCwd)).toBe(before);
        expect(existsSync(record.remoteCwd)).toBe(true);
        expect(recordStatus(record.id)).toBe("up");
      });
    },
    120_000,
  );

  test(
    "a LOCAL edit racing the down is never touched: the down completes, " +
      "local stays byte-identical (edit included), the stage is exact",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      writeFileSync(join(remoteCwd, "remote-work.txt"), "honest\n");
      writeFileSync(join(remoteCwd, "conflict.txt"), "remote change\n");

      // The racing local editor lands mid-down, right after the staging
      // transfer: it edits a tracked file AND drops a new one.
      const editLocal =
        `printf 'concurrent local edit\\n' > ${shq(join(localCwd, "conflict.txt"))} && ` +
        `printf 'brand new\\n' > ${shq(join(localCwd, "local-new.txt"))}`;
      await withLateWriter(f.base, ".beam/returns/", editLocal, async (marker) => {
        await cmdDown([record.id]);
        expect(existsSync(marker)).toBe(true);
        // The racing edits are exactly where the user left them — the down
        // never reads or writes the live worktree.
        expect(readFileSync(join(localCwd, "conflict.txt"), "utf8")).toBe(
          "concurrent local edit\n",
        );
        expect(readFileSync(join(localCwd, "local-new.txt"), "utf8")).toBe("brand new\n");
        expect(existsSync(join(localCwd, "remote-work.txt"))).toBe(false);
        expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(f.mainSha);
        expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
        // The durable stage holds the exact remote tree, unpolluted by the
        // local race.
        const stages = returnStages(record.id);
        expect(stages.length).toBe(1);
        const stageWs = join(stages[0]!, "workspace");
        expect(readFileSync(join(stageWs, "remote-work.txt"), "utf8")).toBe("honest\n");
        expect(readFileSync(join(stageWs, "conflict.txt"), "utf8")).toBe("remote change\n");
        expect(existsSync(join(stageWs, "local-new.txt"))).toBe(false);
        expect(existsSync(join(stages[0]!, "manifest.json"))).toBe(true);
        // Remote retained, record still collectible.
        expect(readFileSync(join(remoteCwd, "remote-work.txt"), "utf8")).toBe("honest\n");
        expect(recordStatus(record.id)).toBe("up");
      });
    },
    120_000,
  );

  test(
    "a REMOTE file landed right after staging refuses with no stage persisted, " +
      "and the retry collects it",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      writeFileSync(join(remoteCwd, "remote-work.txt"), "honest\n");

      const before = localState(localCwd, f.commonGit);
      const plantLate = `printf 'late work\\n' > ${shq(join(remoteCwd, "late-work.txt"))}`;
      await withLateWriter(f.base, ".beam/returns/", plantLate, async (marker) => {
        // The staged-collection stability proof runs on EVERY down — a torn
        // or late-written staging is never trusted.
        const err = await cmdDown([record.id]).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(existsSync(marker)).toBe(true);
        expect(String(err)).toMatch(/changed while it was being staged/);
        // No local byte, no persisted stage; the late file survives
        // remotely.
        expect(localState(localCwd, f.commonGit)).toEqual(before);
        expect(returnStages(record.id)).toEqual([]);
        expect(readFileSync(join(remoteCwd, "late-work.txt"), "utf8")).toBe("late work\n");
        expect(recordStatus(record.id)).toBe("up");

        // The writer has gone quiet (marker present): the retry stages the
        // late file as ordinary returned content and finishes.
        await cmdDown([record.id]);
        expect(dirManifest(localCwd)).toBe(before.worktree);
        const stages = returnStages(record.id);
        expect(stages.length).toBe(1);
        expect(readFileSync(join(stages[0]!, "workspace", "late-work.txt"), "utf8")).toBe(
          "late work\n",
        );
        expect(readFileSync(join(stages[0]!, "workspace", "remote-work.txt"), "utf8")).toBe(
          "honest\n",
        );
        expect(existsSync(remoteCwd)).toBe(true);
        expect(recordStatus(record.id)).toBe("up");
      });
    },
    120_000,
  );

  test(
    "a git commit landing between the Git collection and the staging refuses in every mode — " +
      "never a torn worktree/Git pair",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;

      const before = localState(localCwd, f.commonGit);
      // The commit touches only `.git`: the workspace staging proof cannot
      // see it, so only the unconditional post-staging Git re-proof stands
      // between a coherent return and persisting a staged worktree over an
      // older Git snapshot.
      const commitLate =
        `git -C ${shq(remoteCwd)} -c user.name=t -c user.email=t@example.invalid ` +
        `commit -q --allow-empty -m late-commit`;
      await withLateWriter(f.base, ".beam/returns/", commitLate, async (marker) => {
        const err = await cmdDown([record.id]).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(existsSync(marker)).toBe(true);
        expect(String(err)).toMatch(
          /changed after it was collected, while the workspace was being staged/,
        );
        expect(localState(localCwd, f.commonGit)).toEqual(before);
        expect(returnStages(record.id)).toEqual([]);
        expect(recordStatus(record.id)).toBe("up");
        const lateSha = (await git(remoteCwd, "rev-parse", "HEAD")).stdout.trim();
        expect(lateSha).not.toBe(f.mainSha);

        // The retry collects both namespaces from one coherent moment:
        // main never moves, the late tip is quarantined, HEAD stays put.
        await cmdDown([record.id]);
        expect(dirManifest(localCwd)).toBe(before.worktree);
        expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(f.mainSha);
        expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
        const mainPin = qval(record, "values", "refs/heads/main");
        expect((await git(localCwd, "rev-parse", mainPin)).stdout.trim()).toBe(lateSha);
        expect((await run(["git", "-C", localCwd, "cat-file", "-e", lateSha])).code).toBe(0);
        expect(recordStatus(record.id)).toBe("up"); // retained
      });
    },
    120_000,
  );

  test(
    "a chmod-only remote change right after staging refuses the return — " +
      "permission modes are fingerprinted",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      writeFileSync(join(remoteCwd, "tool.sh"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(remoteCwd, "tool.sh"), 0o644);

      const before = localState(localCwd, f.commonGit);
      // Content stays byte-identical; ONLY the permission mode flips. A
      // content-only fingerprint would falsely bless a stage that omitted
      // the executable bit rsync -a should carry.
      const flipLate = `chmod 755 ${shq(join(remoteCwd, "tool.sh"))}`;
      await withLateWriter(f.base, ".beam/returns/", flipLate, async (marker) => {
        const err = await cmdDown([record.id]).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(existsSync(marker)).toBe(true);
        expect(String(err)).toMatch(/changed while it was being staged/);
        // No local byte, no persisted stage, remote intact and retryable.
        expect(localState(localCwd, f.commonGit)).toEqual(before);
        expect(returnStages(record.id)).toEqual([]);
        expect(statSync(join(remoteCwd, "tool.sh")).mode & 0o111).not.toBe(0);
        expect(recordStatus(record.id)).toBe("up");

        // The writer has gone quiet: the retry stages the executable bit as
        // ordinary returned state — mode preserved into the stage.
        await cmdDown([record.id]);
        expect(dirManifest(localCwd)).toBe(before.worktree);
        const stages = returnStages(record.id);
        expect(stages.length).toBe(1);
        const stagedTool = join(stages[0]!, "workspace", "tool.sh");
        expect(readFileSync(stagedTool, "utf8")).toBe("#!/bin/sh\nexit 0\n");
        expect(statSync(stagedTool).mode & 0o111).not.toBe(0);
        expect(existsSync(remoteCwd)).toBe(true);
        expect(recordStatus(record.id)).toBe("up");
      });
    },
    120_000,
  );


  test(
    "a default down never destroys: a file landed during the import survives retained " +
      "and the next down stages it",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      writeFileSync(join(remoteCwd, "remote-work.txt"), "honest\n");

      // A late writer after the FINAL workspace proof (probe 3 of 3:
      // pre-stage, post-stage, final pre-receipt) cannot be folded into the
      // sealed stage, but down is non-destructive: it completes, retains the
      // remote (late work included), and leaves the record collectible.
      const plantLate = `printf 'late work\\n' > ${shq(join(remoteCwd, "late-work.txt"))}`;
      const afterFinalProof = 2;
      await withLateWriter(f.base, "beam-wsverify-", plantLate, async (marker) => {
        await cmdDown([record.id]);
        expect(existsSync(marker)).toBe(true);
        const stages = returnStages(record.id);
        expect(stages.length).toBe(1);
        expect(readFileSync(join(stages[0]!, "workspace", "remote-work.txt"), "utf8")).toBe(
          "honest\n",
        );
        // landed after staging
        expect(existsSync(join(stages[0]!, "workspace", "late-work.txt"))).toBe(false);
        // retained
        expect(readFileSync(join(remoteCwd, "late-work.txt"), "utf8")).toBe("late work\n");
        expect(recordStatus(record.id)).toBe("up");

        // The next down stages the late work into a fresh txn — no byte
        // was ever at risk, and the remote is still retained.
        await cmdDown([record.id]);
        const after = returnStages(record.id);
        expect(after.length).toBe(2);
        expect(readFileSync(join(after[1]!, "workspace", "late-work.txt"), "utf8")).toBe(
          "late work\n",
        );
        expect(existsSync(remoteCwd)).toBe(true); // still retained
        expect(recordStatus(record.id)).toBe("up");
      }, afterFinalProof);
    },
    120_000,
  );

  test(
    "down preserves a remote in-progress operation as remote-only state and retains it",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      // A real in-progress merge on the target: its MERGE_HEAD/MERGE_MSG
      // cannot be reproduced locally by the non-destructive return. The
      // remote `.git` is a pointer FILE — resolve the physical git dir the
      // way git itself does.
      expect(
        (await run(["git", "-C", remoteCwd, "merge", "other"], { env: GIT_ENV })).code,
      ).not.toBe(0);
      const remoteGitDir = (await git(remoteCwd, "rev-parse", "--absolute-git-dir")).stdout.trim();
      expect(existsSync(join(remoteGitDir, "MERGE_HEAD"))).toBe(true);

      const before = localState(localCwd, f.commonGit);
      await cmdDown([record.id]);
      expect(returnStages(record.id).length).toBe(1);
      expect(existsSync(join(remoteGitDir, "MERGE_HEAD"))).toBe(true);
      expect(recordStatus(record.id)).toBe("up");
      expect(dirManifest(localCwd)).toBe(before.worktree);
      expect(existsSync(remoteCwd)).toBe(true);
    },
    120_000,
  );

  test(
    "a remote workspace write DURING the session fetch refuses before the trusted receipt; " +
      "the retained receipt dedupes and the retry captures it",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      // Manufacture the shipped-session state a sessionful up would have
      // left behind: a remote transcript under the reserved dir, and the
      // session identity on the record. The session fetch then runs for
      // real through the ordinary adapter.
      const sid = "sess-late-write";
      const header = JSON.stringify({ type: "session", version: 3, id: sid, cwd: remoteCwd });
      writeFileSync(
        join(remoteCwd, ".beam", "session.jsonl"),
        `${header}\n{"type":"message"}\n`,
      );
      updateRecord(resolveEnv(), record.id, {
        tool: "omp",
        sessionId: sid,
        sessionFile: join(f.base, "local-store.jsonl"),
      });
      writeFileSync(join(remoteCwd, "remote-work.txt"), "honest\n");

      const before = localState(localCwd, f.commonGit);
      // The workspace write lands right after the transcript fetch — after
      // every staging proof passed, in the window only the final
      // combined-snapshot proof closes.
      const plantLate = `printf 'late work\\n' > ${shq(join(remoteCwd, "late-work.txt"))}`;
      await withLateWriter(f.base, ".beam-tree", plantLate, async (marker) => {
        const err = await cmdDown([record.id]).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(existsSync(marker)).toBe(true);
        expect(String(err)).toMatch(/changed while the session was collected/);
        // Nothing trusted: local worktree AND repository byte-identical,
        // no manifest receipt — but the journaled session return survives
        // as durable retry evidence inside the retained txn root.
        expect(localState(localCwd, f.commonGit)).toEqual(before);
        const stages = returnStages(record.id);
        expect(stages.length).toBe(1);
        expect(existsSync(join(stages[0]!, "manifest.json"))).toBe(false);
        expect(existsSync(join(stages[0]!, "session", "session.jsonl"))).toBe(true);
        const receipt = loadState(resolveEnv()).records.find((r) => r.id === record.id)!.collect!;
        expect(receipt.returnDir).toBe(join(stages[0]!, "session"));
        expect(readFileSync(join(remoteCwd, "late-work.txt"), "utf8")).toBe("late work\n");
        expect(recordStatus(record.id)).toBe("up");

        // Settled retry: a NEW txn stages the late work under a manifest;
        // the intact session receipt dedupes onto the retained evidence.
        await cmdDown([record.id]);
        expect(dirManifest(localCwd)).toBe(before.worktree);
        const after = returnStages(record.id);
        expect(after.length).toBe(2);
        const fresh = after.find((s) => s !== stages[0]!)!;
        expect(existsSync(join(fresh, "manifest.json"))).toBe(true);
        expect(readFileSync(join(fresh, "workspace", "late-work.txt"), "utf8")).toBe("late work\n");
        const settled = loadState(resolveEnv()).records.find((r) => r.id === record.id)!;
        expect(settled.collect!.returnDir).toBe(receipt.returnDir);
        expect(recordStatus(record.id)).toBe("up");
      });
    },
    120_000,
  );

  test(
    "a remote ref mutation DURING the session fetch refuses on the final Git proof; " +
      "the retry collects the newer state",
    async () => {
      const f = await makeReturnFixture();
      process.chdir(f.wt);
      const localCwd = process.cwd();
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      const sid = "sess-late-ref";
      const header = JSON.stringify({ type: "session", version: 3, id: sid, cwd: remoteCwd });
      writeFileSync(
        join(remoteCwd, ".beam", "session.jsonl"),
        `${header}\n{"type":"message"}\n`,
      );
      updateRecord(resolveEnv(), record.id, {
        tool: "omp",
        sessionId: sid,
        sessionFile: join(f.base, "local-store.jsonl"),
      });

      const before = localState(localCwd, f.commonGit);
      // The mutation touches ONLY `.git`: the (git-excluding) workspace
      // fingerprint is blind to it — only the final Git proof stands
      // between it and a receipt certifying a Git state that no longer
      // exists remotely.
      const mutateRef = `git -C ${shq(remoteCwd)} update-ref refs/heads/late HEAD`;
      await withLateWriter(f.base, ".beam-tree", mutateRef, async (marker) => {
        const err = await cmdDown([record.id]).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(existsSync(marker)).toBe(true);
        expect(String(err)).toMatch(
          /Git repository changed after it was collected, while the session was collected/,
        );
        expect(localState(localCwd, f.commonGit)).toEqual(before);
        // The txn root survives as retry evidence (session receipt landed)
        // but carries no manifest — nothing trusted.
        const stages = returnStages(record.id);
        expect(stages.length).toBe(1);
        expect(existsSync(join(stages[0]!, "manifest.json"))).toBe(false);
        // The late ref survives byte-for-byte on the retained remote.
        expect((await git(remoteCwd, "rev-parse", "refs/heads/late")).stdout.trim()).toBe(
          f.mainSha,
        );
        expect(recordStatus(record.id)).toBe("up");

        // The retry collects the newer coherent state and finishes; the
        // local checkout is untouched throughout.
        await cmdDown([record.id]);
        expect(dirManifest(localCwd)).toBe(before.worktree);
        expect((await git(localCwd, "rev-parse", "refs/heads/main")).stdout.trim()).toBe(f.mainSha);
        expect((await git(localCwd, "symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
        expect(returnStages(record.id).length).toBe(2);
        expect(recordStatus(record.id)).toBe("up");
      });
    },
    120_000,
  );

  test(
    "a .git created remotely during the plain collection refuses before publishing — " +
      "never a silently Git-less return",
    async () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-plain-lategit-")));
      const localCwd = join(base, "workspace");
      mkdirSync(localCwd);
      writeFileSync(join(localCwd, "work.txt"), "local\n");
      process.chdir(localCwd);
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.find((r) => r.localCwd === localCwd)!;
      const remoteCwd = record.remoteCwd;
      writeFileSync(join(remoteCwd, "remote-work.txt"), "honest\n");

      const before = dirManifest(localCwd);
      // The repository appears right after the staging transfer: the
      // (git-excluding) workspace fingerprint is blind to it — only the
      // re-run plain-origin entry check stands before the receipt. A
      // return published past it would look complete while silently
      // omitting the repository.
      const initLate = `git init -q ${shq(remoteCwd)}`;
      await withLateWriter(base, ".beam/returns/", initLate, async (marker) => {
        const err = await cmdDown([record.id]).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(existsSync(marker)).toBe(true);
        expect(String(err)).toMatch(/now has remote Git metadata/);
        expect(String(err)).toMatch(/detected immediately before publishing the return/);
        expect(dirManifest(localCwd)).toBe(before);
        expect(returnStages(record.id)).toEqual([]);
        // The remote — repository included — is intact.
        expect(existsSync(join(remoteCwd, ".git"))).toBe(true);
        expect(readFileSync(join(remoteCwd, "remote-work.txt"), "utf8")).toBe("honest\n");
        expect(recordStatus(record.id)).toBe("up");

        // Recover or archive the repository remotely, then the retry
        // converges as an ordinary plain return.
        rmSync(join(remoteCwd, ".git"), { recursive: true, force: true });
        await cmdDown([record.id]);
        expect(dirManifest(localCwd)).toBe(before);
        const stages = returnStages(record.id);
        expect(stages.length).toBe(1);
        expect(readFileSync(join(stages[0]!, "workspace", "remote-work.txt"), "utf8")).toBe(
          "honest\n",
        );
        expect(recordStatus(record.id)).toBe("up");
      });
    },
    120_000,
  );
});

describe("fileSha256 streaming digest (bounded reads)", () => {
  test("multi-chunk reads around every boundary produce the exact whole-content digest", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "beam-digest-")));
    const wholeDigest = (content: Buffer): string => {
      const h = new Bun.CryptoHasher("sha256");
      h.update(content);
      return h.digest("hex");
    };
    // A tiny chunk forces MANY reads on small fixtures: the helper only
    // ever sees `chunk` bytes at a time (the bounded-buffer seam), yet the
    // digest must equal the whole-content hash at every boundary shape —
    // empty, under, exact, over, multiple, multiple-plus-tail.
    const chunk = 7;
    for (const size of [0, 1, chunk - 1, chunk, chunk + 1, chunk * 5, chunk * 5 + 3]) {
      const content = Buffer.alloc(size);
      for (let i = 0; i < size; i++) content[i] = i % 251;
      const p = join(dir, `f${size}`);
      writeFileSync(p, content);
      expect(fileSha256(p, chunk)).toBe(wholeDigest(content));
    }
    // Default 1 MiB chunk against a file LARGER than one chunk with a
    // ragged tail — the exact seam a whole-file read would OOM on for
    // multi-gigabyte packs.
    const big = Buffer.alloc((1 << 20) * 3 + 12345);
    for (let i = 0; i < big.length; i += 4096) big[i] = (i >> 12) % 251;
    const bigPath = join(dir, "big");
    writeFileSync(bigPath, big);
    expect(fileSha256(bigPath)).toBe(wholeDigest(big));
    // Invalid chunk sizes fail closed instead of looping or buffering.
    expect(() => fileSha256(bigPath, 0)).toThrow(/invalid chunk size/);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Proof-line transport double: remoteGitTreeFingerprint consumes one
 * execChecked() result, and counts past Number.MAX_SAFE_INTEGER cannot be
 * produced by a real hermetic tree — only a canned wire line reaches them.
 */
class CannedGitProofTransport implements Transport {
  readonly label = "canned-git-proof";
  constructor(private readonly proofLine: string) {}
  async exec(_command: string): Promise<{ code: number; stdout: string; stderr: string }> {
    throw new Error("not used by the fingerprint parser");
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

describe("remote Git proof entry-count bounds", () => {
  const DIGEST = "b".repeat(64);
  const proof = (count: string) =>
    remoteGitTreeFingerprint(
      new CannedGitProofTransport(`__beam_git_fp_v1__ ${DIGEST} ${count}`),
      "/ws",
      ".beam/git/gen1",
    );

  test("the largest exact integer count is accepted; the first inexact one refuses", async () => {
    // 2^53-1 — max valid: every count up to here round-trips exactly.
    const ok = await proof("9007199254740991");
    expect(ok).toEqual({ digest: DIGEST, entries: Number.MAX_SAFE_INTEGER });
    // 2^53 — the first digit run Number() silently rounds; a rounded
    // count could mask a mismatched payload, so the proof refuses.
    await expect(proof("9007199254740992")).rejects.toThrow(/produced no proof/);
    // Grossly oversized digit runs refuse the same way.
    await expect(proof("99999999999999999999999")).rejects.toThrow(/produced no proof/);
  });

  test("negative and non-numeric counts never match the proof format", async () => {
    await expect(proof("-1")).rejects.toThrow(/produced no proof/);
    await expect(proof("1e3")).rejects.toThrow(/produced no proof/);
  });
});
