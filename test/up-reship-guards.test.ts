/**
 * Goal: re-ship lifecycle guards for linked-worktree handoffs:
 *  - a prior `up` handoff whose remote `.git` holds an in-progress
 *    operation (merge, rebase, sequencer) refuses the re-ship BEFORE the
 *    status drops back to `provisioning` and before any outbound byte —
 *    that remote operation state exists nowhere else, and the re-ship's
 *    delete-mirroring `.git` sync would erase it wholesale;
 *  - a reused `provisioning` record (the crash window between reservation
 *    and the ship) re-runs the LOCAL shippability guards before any remote
 *    interaction — provisioning included — so an unshippable retry can
 *    never create a scarce sandbox claim it then refuses to use, and a
 *    refused retry leaks no temp payload and persists no new identity;
 *  - remote git pointer landings are create-only and atomic, git-ship
 *    crash phases leave no half-published state, and a fresh up ships one
 *    coherent workspace snapshot.
 *
 * Method: real `cmdUp`/`cmdDown` over a LocalTransport against fixture
 * linked-worktree repositories and scripted remote states (in-progress
 * merge/sequencer files, hard links, symlinks) under mkdtemp BEAM_HOME
 * fixtures; suites are `describe.skipIf`-gated on git/rsync/herdr with
 * explicit per-test timeouts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { cmdUp } from "../src/commands/up.ts";
import { cmdDown } from "../src/commands/down.ts";
import { resolveEnv } from "../src/env.ts";
import { loadState, updateRecord, type BeamRecord } from "../src/state.ts";
import { LocalTransport } from "../src/transport/local.ts";
import type { SyncOptions } from "../src/transport/types.ts";
import { run, runChecked, shq } from "../src/util/shell.ts";
import {
  collectedGitTreeFingerprint,
  gitPayloadPath,
  gitPointerBytes,
  gitPointerTempName,
  installRemoteGitPointer,
  reconcileGitPointerTemp,
  materializeWorktreeGit,
  remoteGitEntryKind,
  remoteGitPointerState,
} from "../src/workspace-git.ts";
import {
  gatherExcludes,
  remoteWorkspaceName,
  stageWorkspaceShip,
  stagedWorkspaceTreeFingerprint,
  workspacePublishTestSeam,
} from "../src/workspace.ts";

const HERDR = Bun.which("herdr");
const HAVE_DEPS =
  Bun.which("git") !== null && Bun.which("rsync") !== null && HERDR !== null;

/**
 * The same uid-scoped socket path the runtime's emitted scripts compute
 * (`${TMPDIR:-/tmp}/herdr-<uid>/<name>.sock`) — probes and cleanups MUST
 * pin it via HERDR_SOCKET_PATH or they'd look for a fixture's server at
 * herdr's HOME-derived default and never see it. The dir is uid-global and
 * shared across fixtures; beam-<id> session names keep entries disjoint.
 */
function herdrSocketEnv(name: string): Record<string, string> {
  const dir = join(process.env.TMPDIR ?? "/tmp", `herdr-${process.getuid!()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { HERDR_SESSION: name, HERDR_SOCKET_PATH: join(dir, `${name}.sock`) };
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

async function git(cwd: string, ...args: string[]) {
  return runChecked(["git", "-C", cwd, ...args], { env: GIT_ENV });
}

/** A merge with `other` that must conflict — the in-progress operation stays. */
async function beginConflictMerge(cwd: string): Promise<void> {
  const merge = await run(["git", "-C", cwd, "merge", "other"], { env: GIT_ENV });
  expect(merge.code).not.toBe(0);
}

/** Temp dirs the materializer creates — must never outlive a refused up. */
function materializerTemps(): string[] {
  return readdirSync(tmpdir())
    .filter((n) => n.startsWith("beam-wtgit-"))
    .sort();
}

// Fixture trees are a few directories deep; the bound only trips on a
// runaway fixture, never on a legitimate workspace.
const MAX_MANIFEST_DEPTH = 32;

/** Every file under a directory, path -> bytes: proves zero remote mutation. */
function remoteManifest(root: string): Map<string, string> {
  const manifest = new Map<string, string>();
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth >= MAX_MANIFEST_DEPTH) throw new Error("fixture tree exceeds MAX_MANIFEST_DEPTH");
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) stack.push({ dir: p, depth: depth + 1 });
      else manifest.set(relative(root, p), readFileSync(p, "latin1"));
    }
  }
  return manifest;
}

interface IsolatedBeam {
  remoteRoot: string;
  savedCwd: string;
  savedEnv: Record<string, string | undefined>;
}

function isolatedBeam(tag: string): IsolatedBeam {
  const savedCwd = process.cwd();
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of ["BEAM_HOME", "BEAM_DIR", "XDG_CONFIG_HOME"]) savedEnv[k] = process.env[k];
  // herdr resolves its session REGISTRY from XDG_CONFIG_HOME before HOME;
  // the transport pins HOME only, so an ambient XDG value would escape
  // the fixture's remote home.
  delete process.env.XDG_CONFIG_HOME;
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
  return { remoteRoot, savedCwd, savedEnv };
}

function restoreBeam(iso: IsolatedBeam): void {
  process.chdir(iso.savedCwd);
  for (const [k, v] of Object.entries(iso.savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function theRecord(): BeamRecord {
  const { records } = loadState(resolveEnv());
  expect(records.length).toBe(1);
  return records[0]!;
}

interface WtFixture {
  base: string;
  wt: string;
  commonGit: string;
}

/**
 * Linked worktree on a CLEAN `main`, plus a sibling branch `other` with two
 * commits: `other~1` ("theirs") conflicts with main on conflict.txt, `other`
 * ("extra") is clean — a two-commit cherry-pick whose first step conflicts
 * leaves the multi-commit sequencer alive between steps.
 */
async function makeWtFixture(): Promise<WtFixture> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-reshipfix-")));
  const seed = join(base, "seed");
  mkdirSync(seed);
  await git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "conflict.txt"), "base\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-q", "-m", "base");
  await git(seed, "checkout", "-q", "-b", "other");
  writeFileSync(join(seed, "conflict.txt"), "theirs\n");
  await git(seed, "commit", "-q", "-am", "theirs");
  writeFileSync(join(seed, "extra.txt"), "clean addition\n");
  await git(seed, "add", "extra.txt");
  await git(seed, "commit", "-q", "-m", "extra");
  await git(seed, "checkout", "-q", "main");
  writeFileSync(join(seed, "conflict.txt"), "ours\n");
  await git(seed, "commit", "-q", "-am", "ours");
  const commonGit = join(base, "common.git");
  await runChecked(["git", "clone", "-q", "--bare", seed, commonGit], { env: GIT_ENV });
  rmSync(seed, { recursive: true, force: true });
  await git(commonGit, "remote", "set-url", "origin", "https://example.invalid/reship.git");
  const wt = join(base, "wt");
  await git(commonGit, "worktree", "add", "-q", wt, "main");
  return { base, wt, commonGit };
}

describe.skipIf(!HAVE_DEPS)("a reused `up` handoff always refuses re-ship — collect first", () => {
  /**
   * The refusal must be a pure read: record byte-identical (status still
   * `up`, `wtGit` untouched, not even `updatedAt` moved), remote workspace
   * — `.git`, files, and operation state included — byte-identical.
   */
  async function expectRefusedReship(remoteCwd: string): Promise<void> {
    const recordBytes = JSON.stringify(theRecord());
    const manifest = remoteManifest(remoteCwd);
    await expect(cmdUp(["--no-session"])).rejects.toThrow(
      /already up on sandbox and its agent is no longer running[\s\S]*beam down/,
    );
    expect(JSON.stringify(theRecord())).toBe(recordBytes);
    expect(remoteManifest(remoteCwd)).toEqual(manifest);
  }

  test(
    "completed unmarked remote work with a dead agent is never re-shipped over — beam down" +
      " recovers it",
    async () => {
      const iso = isolatedBeam("reship");
      try {
        const f = await makeWtFixture();
        process.chdir(f.wt);
        await cmdUp(["--no-session"]);
        const record = theRecord();
        expect(record.status).toBe("up");
        expect(record.wtGit).toBeDefined();
        const remoteCwd = record.remoteCwd;

        // The remote agent worked and exited: a commit and a file that
        // exist NOWHERE else. The old dead-agent path re-shipped the stale
        // local mirror and `.git` right over both.
        writeFileSync(join(remoteCwd, "remote-work.txt"), "only copy\n");
        await git(remoteCwd, "add", "remote-work.txt");
        await git(remoteCwd, "commit", "-qm", "remote work");
        const remoteTip = (await git(remoteCwd, "rev-parse", "main")).stdout.trim();
        expect(remoteTip).not.toBe((await git(f.wt, "rev-parse", "main")).stdout.trim());

        await expectRefusedReship(remoteCwd);
        // An in-progress remote operation changes nothing: still the same
        // refusal, still a pure read.
        await beginConflictMerge(remoteCwd);
        const payload = join(remoteCwd, gitPayloadPath(record.wtGit!.generation));
        expect(existsSync(join(payload, "MERGE_HEAD"))).toBe(true);
        await expectRefusedReship(remoteCwd);
        await git(remoteCwd, "merge", "--abort");
        await git(remoteCwd, "checkout", "-q", "--", "conflict.txt");
        // beam down brings the dead agent's work home without touching the
        // live worktree or checkout: the remote commit's objects land
        // additively, the remote tip is pinned under the return namespace,
        // and the returned files persist in beam's staged return.
        const localMainBefore = (await git(f.wt, "rev-parse", "main")).stdout.trim();
        await cmdDown([record.id]);
        expect((await git(f.wt, "rev-parse", "main")).stdout.trim()).toBe(localMainBefore);
        expect((await git(f.wt, "rev-parse", "HEAD")).stdout.trim()).toBe(localMainBefore);
        expect((await run(["git", "-C", f.wt, "cat-file", "-e", remoteTip])).code).toBe(0);
        expect(existsSync(join(f.wt, "remote-work.txt"))).toBe(false);
        const stagesDir = join(process.env.BEAM_DIR!, "returns", record.id);
        const stages = readdirSync(stagesDir).sort();
        expect(stages.length).toBe(1);
        const returned = join(stagesDir, stages[0]!, "workspace", "remote-work.txt");
        expect(readFileSync(returned, "utf8")).toBe("only copy\n");
      } finally {
        restoreBeam(iso);
      }
    },
    120_000,
  );
});

describe.skipIf(!HAVE_DEPS)(
  "reused provisioning record: local git guards precede any remote interaction",
  () => {
    let iso: IsolatedBeam;
    let f: WtFixture;
    let savedPath: string | undefined;

    beforeAll(async () => {
      iso = isolatedBeam("reprov");
      f = await makeWtFixture();
      savedPath = process.env.PATH;
    });
    afterAll(() => {
      if (savedPath !== undefined) process.env.PATH = savedPath;
      restoreBeam(iso);
    });

    /**
     * Remote manifest with the runtime's launcher script factored out —
     * the only remote artifact an in-place agent restart writes (asserted
     * present before it is dropped).
     */
    function manifestSansLauncher(dir: string): Map<string, string> {
      const m = remoteManifest(dir);
      expect(m.delete(".beam/agent-start.sh")).toBe(true);
      return m;
    }

    /**
     * Stop (checked) and delete a handoff's herdr session: the server
     * binds the uid-scoped socket, so the stop is `server stop` under
     * HERDR_SOCKET_PATH (`session stop` only reaches HOME-registry
     * sockets); the registry entry lives under the fixture remote home.
     */
    async function stopFixtureSession(remoteHome: string, session: string): Promise<void> {
      const env = { HOME: remoteHome, ...herdrSocketEnv(session) };
      await runChecked([HERDR!, "server", "stop"], { env });
      await run([HERDR!, "session", "delete", session, "--json"], { env });
    }

    test(
      "an in-progress local merge refuses the retry before provisioning or liveness, leaking" +
        " nothing",
      async () => {
        process.chdir(f.wt);
        await cmdUp(["--no-session"]);
        const shipped = theRecord();
        expect(shipped.status).toBe("up");
        const shippedWtGit = JSON.stringify(shipped.wtGit);

        // The crash window: a fresh up died after reserving — before (or
        // during) provisioning — leaving a reusable `provisioning` record.
        updateRecord(resolveEnv(), shipped.id, { status: "provisioning" });

        // A local operation begins before the retry…
        await beginConflictMerge(f.wt);

        // …and the first remote act after provisioning — the herdr liveness
        // probe — is booby-trapped with a shim that cannot answer. If the
        // retry reached ANY remote step (provision is inert on a static
        // target), it would die with the probe error, not the local guard's.
        const fakeBin = join(f.base, "fakebin");
        mkdirSync(fakeBin, { recursive: true });
        writeFileSync(join(fakeBin, "herdr"), "#!/bin/bash\nexit 42\n");
        chmodSync(join(fakeBin, "herdr"), 0o755);
        // macOS login shells run path_helper, which can demote fakeBin below
        // system dirs; the transport pins HOME at the target home, so a
        // profile there re-prepends fakeBin after path_helper has run.
        writeFileSync(
          join(dirname(iso.remoteRoot), ".bash_profile"),
          `export PATH=${shq(fakeBin)}:"$PATH"\n`,
        );
        process.env.PATH = `${fakeBin}:${process.env.PATH}`;

        const temps = materializerTemps();
        await expect(cmdUp(["--no-session"])).rejects.toThrow(
          /in-progress git operation \(MERGE_HEAD\)/,
        );

        const after = theRecord();
        expect(after.status).toBe("provisioning"); // the refusal advanced nothing
        expect(JSON.stringify(after.wtGit)).toBe(shippedWtGit); // persist stayed deferred
        expect(materializerTemps()).toEqual(temps); // temp payload cleaned in finally

        // Local recovery: finish the operation. The remote still holds the
        // COMPLETED prior ship's pointer while this record lost its journal
        // (a state no real crash produces — the journal clears only with the
        // final `up` write): the retry fails closed instead of adopting a
        // landing it cannot prove, and the remote stays byte-identical.
        await git(f.wt, "merge", "--abort");
        // Unplant the shim everywhere the transport resolves it: the retry
        // below must reach the REAL herdr for an answerable liveness probe.
        rmSync(join(fakeBin, "herdr"));
        process.env.PATH = savedPath!;
        await expect(cmdUp(["--no-session"])).rejects.toThrow(/cannot prove it landed/);
        expect(theRecord().status).toBe("provisioning");
      },
      60_000,
    );

    test(
      "the protection union is journaled BEFORE the first mirror byte — a crashed sync can never" +
        " strand an attempted exclude",
      async () => {
        const iso2 = isolatedBeam("exclunion");
        const savedPath2 = process.env.PATH;
        try {
          // Plain workspace: file A ships; the FIRST ship runs with the
          // default exclude set and completes.
          const ws = join(realpathSync(mkdtempSync(join(tmpdir(), "beam-exclunion-"))), "ws");
          mkdirSync(ws);
          writeFileSync(join(ws, "shipped.txt"), "A\n");
          process.chdir(ws);
          await cmdUp(["--no-session"]);
          const shipped = theRecord();
          expect(shipped.status).toBe("up");
          expect(shipped.syncedExcludes).not.toContain("newer.txt");

          // Between ships: a newer local file B, protected by a NEW exclude.
          writeFileSync(join(ws, "newer.txt"), "B — exists only locally\n");
          writeFileSync(join(ws, ".beamignore"), "newer.txt\n");

          // The retry crashes DURING the workspace mirror (scripted rsync):
          // under the old order the attempted exclude was journaled only
          // after a successful sync, so this crash + a .beamignore removal
          // would leave a later down free to mirror-delete B.
          updateRecord(resolveEnv(), shipped.id, { status: "provisioning" });
          const fakeBin = join(ws, "..", "fakebin");
          mkdirSync(fakeBin, { recursive: true });
          writeFileSync(join(fakeBin, "rsync"), "#!/bin/bash\nexit 23\n");
          chmodSync(join(fakeBin, "rsync"), 0o755);
          process.env.PATH = `${fakeBin}:${process.env.PATH}`;
          await expect(cmdUp(["--no-session"])).rejects.toThrow();

          // The union — prior protection plus the attempted exclude — is on
          // record even though no mirror completed; drift in .beamignore can
          // no longer unprotect B.
          const crashed = theRecord();
          expect(crashed.status).toBe("provisioning");
          expect(crashed.syncedExcludes).toContain("newer.txt");
          for (const prior of shipped.syncedExcludes ?? []) {
            expect(crashed.syncedExcludes).toContain(prior);
          }

          // The scripted rsync died during LOCAL staging — before the pending
          // journal, before any remote byte — so no journal exists and the
          // retry is a legitimate FRESH attempt. It completes, narrows the
          // journal to the finished upload's exact set, and B (excluded)
          // still never ships. (A post-journal crash fails closed instead —
          // covered by the lifecycle describe.)
          process.env.PATH = savedPath2!;
          await cmdUp(["--no-session"]);
          const finished = theRecord();
          expect(finished.status).toBe("up");
          expect(finished.syncedExcludes).toContain("newer.txt");
          expect(existsSync(join(finished.remoteCwd, "newer.txt"))).toBe(false); // B never shipped
          expect(readFileSync(join(finished.remoteCwd, "shipped.txt"), "utf8")).toBe("A\n");
        } finally {
          process.env.PATH = savedPath2;
          restoreBeam(iso2);
        }
      },
      60_000,
    );

    test(
      "a remote writer appearing after the ship can never race a sync — no lifecycle path" +
        " re-ships, everything stays byte-identical",
      async () => {
        const iso3 = isolatedBeam("nowriter");
        try {
          const f3 = await makeWtFixture();
          process.chdir(f3.wt);
          await cmdUp(["--no-session"]);
          const shipped = theRecord();
          const remoteCwd = shipped.remoteCwd;
          const payload = join(remoteCwd, gitPayloadPath(shipped.wtGit!.generation));
          const preWriterPayloadDigest = collectedGitTreeFingerprint(payload).digest;

          // A writer takes over AFTER the ship: an in-progress remote merge
          // (markers + workspace conflict state) plus a live-looking Git
          // lock. The old model probed quiescence and then re-shipped —
          // creating exactly the probe→sync window this writer would lose
          // to. No automatic re-ship exists now, on ANY path.
          await beginConflictMerge(remoteCwd);
          expect(existsSync(join(payload, "MERGE_HEAD"))).toBe(true);
          writeFileSync(join(remoteCwd, "conflict-scratch.txt"), "unique remote bytes\n");
          writeFileSync(join(payload, "index.lock"), "held by a live process\n");
          const manifest = remoteManifest(remoteCwd);

          // Retained `up` + dead agent, no resume argv: collect-first refusal.
          const recordBytes = JSON.stringify(theRecord());
          await expect(cmdUp(["--no-session"])).rejects.toThrow(/agent is no longer running/);
          expect(JSON.stringify(theRecord())).toBe(recordBytes);
          expect(remoteManifest(remoteCwd)).toEqual(manifest);

          // Retained `up` + dead agent + journaled resume argv: restart IN
          // PLACE — the ONLY remote delta is the runtime's launcher script
          // under beam's reserved scratch dir; not one workspace byte moves
          // (lock included).
          updateRecord(resolveEnv(), shipped.id, { resumeArgv: ["true"] });
          writeFileSync(join(f3.wt, "newer-local.txt"), "stays local\n");
          await cmdUp(["--no-session"]);
          expect(theRecord().status).toBe("up");
          expect(manifestSansLauncher(remoteCwd)).toEqual(manifest);
          // The pane drops into a shell after the agent exits (by design), so
          // the herdr session survives the fake agent — stop its per-session
          // server to simulate the dead agent the next leg needs.
          await stopFixtureSession(dirname(iso3.remoteRoot), shipped.runtimeSession);
          const manifestWithLauncher = remoteManifest(remoteCwd);

          // Provisioning retry with the pointer landed: the writer has since
          // mutated the payload (MERGE_HEAD, index), so the journaled
          // payload digest no longer matches the target — the retry REFUSES
          // rather than reconciling, and above all it never syncs.
          updateRecord(resolveEnv(), shipped.id, {
            status: "provisioning",
            shipPending: {
              workspaceDigest: "unused-by-landed-path",
              git: {
                shipInfo: shipped.wtGit!,
                payloadDigest: preWriterPayloadDigest,
                pointer: gitPointerBytes(shipped.wtGit!.generation),
              },
            },
            wtGit: undefined,
          });
          await expect(cmdUp(["--no-session"])).rejects.toThrow(
            /live Git lock|does not match its journal|cannot be proven complete/,
          );
          expect(remoteManifest(remoteCwd)).toEqual(manifestWithLauncher); // refusal moved nothing
        } finally {
          restoreBeam(iso3);
        }
      },
      120_000,
    );
  },
);

describe.skipIf(!HAVE_DEPS)("remote git pointer landing (create-only, atomic)", () => {
  const GEN = "ab".repeat(8);
  // Every test below is gated on external binaries via HAVE_DEPS, so each
  // states its deadline (Testing rules 3): these are LocalTransport unit
  // probes over tiny fixture trees — bun's default 5s budget, made explicit.
  const POINTER_TEST_TIMEOUT_MS = 5_000;

  test(
    "remoteGitEntryKind enumerates every excluded ASCII-case spelling under the pinned cwd",
    async () => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "beam-kind-")));
      const t = new LocalTransport(home);
      const ws = join(home, "ws");
      mkdirSync(ws);

      // Nothing excluded exists: a plain return may proceed.
      expect(await remoteGitEntryKind(t, ws)).toBe("absent");

      // A `.GIT` the mirror's case-folded exclude would skip (and a purge
      // would then erase) must never read as "absent".
      mkdirSync(join(ws, ".GIT"));
      expect(await remoteGitEntryKind(t, ws)).not.toBe("absent");
      rmSync(join(ws, ".GIT"), { recursive: true });

      // A case-respelled reserved dir is equally excluded — and equally
      // masked — so it refuses a plain return too. Beam's own exact `.beam`
      // does not.
      mkdirSync(join(ws, ".BEAM"));
      expect(await remoteGitEntryKind(t, ws)).not.toBe("absent");
      rmSync(join(ws, ".BEAM"), { recursive: true });
      mkdirSync(join(ws, ".beam"));
      expect(await remoteGitEntryKind(t, ws)).toBe("absent");

      // An exact real `.git` directory reads as Git metadata too.
      mkdirSync(join(ws, ".git"));
      expect(await remoteGitEntryKind(t, ws)).not.toBe("absent");

      // A swapped workspace fails the probe instead of forging "absent".
      const outside = join(home, "outside");
      mkdirSync(outside);
      const wsSwap = join(home, "ws-swap");
      symlinkSync(outside, wsSwap);
      await expect(remoteGitEntryKind(t, wsSwap)).rejects.toThrow(
        /no longer resolves|cannot enter/,
      );
    },
    POINTER_TEST_TIMEOUT_MS,
  );

  interface PayloadFixture {
    t: LocalTransport;
    ws: string;
    payload: string;
    home: string;
  }

  /** A unit workspace with a staged payload for GEN and the reserved dir. */
  function payloadFixture(tag: string): PayloadFixture {
    const home = realpathSync(mkdtempSync(join(tmpdir(), `beam-ptr-${tag}-`)));
    const t = new LocalTransport(home);
    const ws = join(home, "ws");
    const payload = join(ws, ".beam", "git", GEN);
    mkdirSync(payload, { recursive: true });
    writeFileSync(join(payload, "config"), "payload\n");
    return { t, ws, payload, home };
  }

  test(
    "the pointer lands create-only: exact bytes, regular file, temp cleaned, payload untouched",
    async () => {
      const { t, ws, payload } = payloadFixture("land");
      const before = await remoteGitPointerState(t, ws, GEN);
      expect(before).toEqual({ git: "absent", payloadPresent: true });

      await installRemoteGitPointer(t, ws, GEN);
      expect(readFileSync(join(ws, ".git"), "utf8")).toBe(gitPointerBytes(GEN));
      expect(lstatSync(join(ws, ".git")).isFile()).toBe(true);
      expect(readFileSync(join(payload, "config"), "utf8")).toBe("payload\n");
      // No pointer-staging temp survives any outcome.
      expect(readdirSync(join(ws, ".beam")).sort()).toEqual(["git"]);
      const after = await remoteGitPointerState(t, ws, GEN);
      expect(after).toEqual({ git: "ours", payloadPresent: true });
    },
    POINTER_TEST_TIMEOUT_MS,
  );

  test(
    "every raced .git shape refuses byte-intact — file, directory, and symlink are never written" +
      " through",
    async () => {
      const { t, ws, home } = payloadFixture("race");

      // Raced regular file: bytes survive, no overwrite.
      writeFileSync(join(ws, ".git"), "foreign file\n");
      await expect(installRemoteGitPointer(t, ws, GEN)).rejects.toThrow(/a \.git already exists/);
      expect(readFileSync(join(ws, ".git"), "utf8")).toBe("foreign file\n");
      rmSync(join(ws, ".git"));

      // Raced directory: link(2) cannot nest — the foreign dir stays empty.
      mkdirSync(join(ws, ".git"));
      await expect(installRemoteGitPointer(t, ws, GEN)).rejects.toThrow(/a \.git already exists/);
      expect(readdirSync(join(ws, ".git"))).toEqual([]);
      rmSync(join(ws, ".git"), { recursive: true });

      // Raced symlink to an outside directory: never followed, target stays
      // empty — the old directory-rename family nested into exactly this.
      const outside = join(home, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(ws, ".git"));
      await expect(installRemoteGitPointer(t, ws, GEN)).rejects.toThrow(/a \.git already exists/);
      expect(readdirSync(outside)).toEqual([]);
      expect(lstatSync(join(ws, ".git")).isSymbolicLink()).toBe(true);
    },
    POINTER_TEST_TIMEOUT_MS,
  );

  test(
    "a missing or symlinked payload refuses before .git is considered",
    async () => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "beam-ptr-nopayload-")));
      const t = new LocalTransport(home);
      const ws = join(home, "ws");
      mkdirSync(join(ws, ".beam", "git"), { recursive: true });
      await expect(installRemoteGitPointer(t, ws, GEN)).rejects.toThrow(
        /payload chain is swapped or missing/,
      );
      expect(existsSync(join(ws, ".git"))).toBe(false);

      const outside = join(home, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(ws, ".beam", "git", GEN));
      await expect(installRemoteGitPointer(t, ws, GEN)).rejects.toThrow(
        /payload chain is swapped or missing/,
      );
      expect(existsSync(join(ws, ".git"))).toBe(false);
      expect(readdirSync(outside)).toEqual([]);
    },
    POINTER_TEST_TIMEOUT_MS,
  );

  test(
    "an intermediate .beam/git swapped for a symlink refuses the publish — nothing lands through" +
      " the chain",
    async () => {
      const { t, ws, home } = payloadFixture("chainswap");
      // Swap the MIDDLE component: `.beam/git` now points at an outside
      // directory that even contains a valid-looking generation dir. The
      // leaf alone would pass an unpinned check; the component-wise descent
      // refuses at the swapped hop.
      const outside = join(home, "outside-git");
      mkdirSync(join(outside, GEN), { recursive: true });
      writeFileSync(join(outside, GEN, "config"), "outside payload\n");
      rmSync(join(ws, ".beam", "git"), { recursive: true });
      symlinkSync(outside, join(ws, ".beam", "git"));

      expect((await remoteGitPointerState(t, ws, GEN)).payloadPresent).toBe(false);
      await expect(installRemoteGitPointer(t, ws, GEN)).rejects.toThrow(
        /payload chain is swapped or missing/,
      );
      expect(existsSync(join(ws, ".git"))).toBe(false); // no pointer landed
      expect(readFileSync(join(outside, GEN, "config"), "utf8")).toBe("outside payload\n");
    },
    POINTER_TEST_TIMEOUT_MS,
  );

  test(
    "pointer state classifies foreign shapes exactly and fails on a swapped workspace",
    async () => {
      const { t, ws } = payloadFixture("state");
      writeFileSync(join(ws, ".git"), "gitdir: somewhere-else\n");
      expect((await remoteGitPointerState(t, ws, GEN)).git).toBe("foreign");
      rmSync(join(ws, ".git"));
      mkdirSync(join(ws, ".git"));
      expect((await remoteGitPointerState(t, ws, GEN)).git).toBe("foreign");
      rmSync(join(ws, ".git"), { recursive: true });
      symlinkSync(join(ws, ".beam"), join(ws, ".git"));
      expect((await remoteGitPointerState(t, ws, GEN)).git).toBe("foreign");

      const home2 = realpathSync(mkdtempSync(join(tmpdir(), "beam-ptr-swap-")));
      const outside = join(home2, "outside");
      mkdirSync(outside);
      const wsSwap = join(home2, "ws-swap");
      symlinkSync(outside, wsSwap);
      const t2 = new LocalTransport(home2);
      await expect(remoteGitPointerState(t2, wsSwap, GEN)).rejects.toThrow(
        /no longer resolves|cannot enter/,
      );
      await expect(installRemoteGitPointer(t2, wsSwap, GEN)).rejects.toThrow(
        /no longer resolves|cannot enter/,
      );
      expect(readdirSync(outside)).toEqual([]);
    },
    POINTER_TEST_TIMEOUT_MS,
  );

  test(
    "a crashed publish's exact journaled temp reconciles; a divergent occupant refuses byte-intact",
    async () => {
      const tmpName = gitPointerTempName(GEN);

      // Exactly our bytes at the journaled single-component name: the retry
      // (install itself, and the pre-proof reconcile) removes it and lands.
      const a = payloadFixture("tmpexact");
      writeFileSync(join(a.ws, tmpName), gitPointerBytes(GEN));
      await installRemoteGitPointer(a.t, a.ws, GEN);
      expect(readFileSync(join(a.ws, ".git"), "utf8")).toBe(gitPointerBytes(GEN));
      expect(existsSync(join(a.ws, tmpName))).toBe(false);

      // Divergent bytes: a collision that is NOT ours — refused, byte-intact.
      const b = payloadFixture("tmpdiv");
      writeFileSync(join(b.ws, tmpName), "evil bytes\n");
      await expect(installRemoteGitPointer(b.t, b.ws, GEN)).rejects.toThrow(
        /divergent pointer staging/,
      );
      expect(readFileSync(join(b.ws, tmpName), "utf8")).toBe("evil bytes\n");
      expect(existsSync(join(b.ws, ".git"))).toBe(false);
      await expect(reconcileGitPointerTemp(b.t, b.ws, GEN)).rejects.toThrow(
        /divergent pointer staging/,
      );
      expect(readFileSync(join(b.ws, tmpName), "utf8")).toBe("evil bytes\n");

      // A symlink occupying the name is never followed or unlinked.
      const c = payloadFixture("tmplink");
      const outside = join(c.home, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "victim.txt"), "outside data\n");
      symlinkSync(join(outside, "victim.txt"), join(c.ws, tmpName));
      await expect(installRemoteGitPointer(c.t, c.ws, GEN)).rejects.toThrow(
        /foreign entry occupies/,
      );
      expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("outside data\n");
      expect(lstatSync(join(c.ws, tmpName)).isSymbolicLink()).toBe(true);
      expect(existsSync(join(c.ws, ".git"))).toBe(false);

      // reconcile: exact temp is removed without publishing anything.
      const d = payloadFixture("tmprecon");
      writeFileSync(join(d.ws, tmpName), gitPointerBytes(GEN));
      await reconcileGitPointerTemp(d.t, d.ws, GEN);
      expect(existsSync(join(d.ws, tmpName))).toBe(false);
      expect(existsSync(join(d.ws, ".git"))).toBe(false);
      await reconcileGitPointerTemp(d.t, d.ws, GEN); // absent: idempotent no-op
    },
    POINTER_TEST_TIMEOUT_MS,
  );

  test(
    "a .beam replaced by a real foreign-owned dir after the proof seam refuses the owned publish" +
      " with zero writes",
    async () => {
      const OWNER = "beam-workspace-v1 r1 " + "cd".repeat(16);
      const FOREIGN = "beam-workspace-v1 other " + "11".repeat(16);

      // Owned happy path first: exact owner bytes inside the held .beam.
      const a = payloadFixture("ownok");
      writeFileSync(join(a.ws, ".beam", "owner"), `${OWNER}\n`);
      await installRemoteGitPointer(a.t, a.ws, GEN, OWNER);
      expect(readFileSync(join(a.ws, ".git"), "utf8")).toBe(gitPointerBytes(GEN));

      // The guard→use seam: the ENTIRE .beam replaced by a fresh REAL
      // directory (same path, same shape, even a plausible payload) whose
      // owner bytes are foreign. Type/path checks alone cannot tell it from
      // the claimed one — only the owner bytes can, and they are verified
      // while HOLDING the very inode the payload descent continues from.
      const b = payloadFixture("ownswap");
      rmSync(join(b.ws, ".beam"), { recursive: true });
      mkdirSync(join(b.ws, ".beam", "git", GEN), { recursive: true });
      writeFileSync(join(b.ws, ".beam", "owner"), `${FOREIGN}\n`);
      writeFileSync(join(b.ws, ".beam", "git", GEN, "config"), "foreign payload\n");
      await expect(installRemoteGitPointer(b.t, b.ws, GEN, OWNER)).rejects.toThrow(
        /not owned by this handoff/,
      );
      expect(existsSync(join(b.ws, ".git"))).toBe(false);
      expect(existsSync(join(b.ws, gitPointerTempName(GEN)))).toBe(false);
      expect(readFileSync(join(b.ws, ".beam", "owner"), "utf8")).toBe(`${FOREIGN}\n`);
      const foreignPayload = join(b.ws, ".beam", "git", GEN, "config");
      expect(readFileSync(foreignPayload, "utf8")).toBe("foreign payload\n");

      // Same seam, .beam swapped for a symlink to an outside tree carrying
      // the EXACT owner bytes: the held no-follow entry refuses before the
      // owner file is even readable through the link.
      const c = payloadFixture("ownlink");
      const outside = join(c.home, "outside-beam");
      mkdirSync(join(outside, "git", GEN), { recursive: true });
      writeFileSync(join(outside, "owner"), `${OWNER}\n`);
      rmSync(join(c.ws, ".beam"), { recursive: true });
      symlinkSync(outside, join(c.ws, ".beam"));
      await expect(installRemoteGitPointer(c.t, c.ws, GEN, OWNER)).rejects.toThrow(
        /not owned by this handoff/,
      );
      expect(existsSync(join(c.ws, ".git"))).toBe(false);
      expect(readdirSync(outside).sort()).toEqual(["git", "owner"]); // nothing written through
      expect(existsSync(join(outside, gitPointerTempName(GEN)))).toBe(false);
    },
    POINTER_TEST_TIMEOUT_MS,
  );
});

describe.skipIf(!HAVE_DEPS)(
  "git ship lifecycle: journaled generation, phase-exact recovery",
  () => {
    /**
     * Rebuild the EXACT pending journal the crashed attempt wrote, grounded
     * in what actually landed on the target: the journaled payload digest is
     * the fingerprint of the shipped payload bytes (a fresh local
     * materialize is NOT byte-stable — `git status` refreshes the index stat
     * cache — and a pending retry never rematerializes anyway).
     */
    function remotePending(
      remoteCwd: string,
      shipInfo: NonNullable<BeamRecord["wtGit"]>,
    ): NonNullable<BeamRecord["shipPending"]> {
      const payload = join(remoteCwd, gitPayloadPath(shipInfo.generation));
      return {
        workspaceDigest: "journaled-by-the-crashed-attempt",
        git: {
          shipInfo,
          payloadDigest: collectedGitTreeFingerprint(payload).digest,
          pointer: gitPointerBytes(shipInfo.generation),
        },
      };
    }

    test(
      "crash after the landing: index-only and config-only local drift finalize the EXACT prior" +
        " generation with zero re-ship",
      async () => {
        const iso = isolatedBeam("landpin");
        try {
          const f = await makeWtFixture();
          process.chdir(f.wt);
          await cmdUp(["--no-session"]);
          const shipped = theRecord();
          const rc = shipped.remoteCwd;
          const gen = shipped.wtGit!.generation;
          expect(readFileSync(join(rc, ".git"), "utf8")).toBe(gitPointerBytes(gen));

          // Crash window: pointer landed, status never flipped. Index-only
          // local drift afterwards is irrelevant — the retry pins the prior
          // generation and moves NOTHING.
          updateRecord(resolveEnv(), shipped.id, {
            status: "provisioning",
            shipPending: remotePending(rc, shipped.wtGit!),
            wtGit: undefined,
          });
          writeFileSync(join(f.wt, "code.txt"), "index-only drift\n");
          await git(f.wt, "add", "code.txt");
          const remoteBefore = remoteManifest(rc);
          await cmdUp(["--no-session"]);
          expect(theRecord().status).toBe("up");
          expect(theRecord().wtGit?.generation).toBe(gen);
          expect(theRecord().shipPending).toBeUndefined();
          expect(remoteManifest(rc)).toEqual(remoteBefore); // not one remote byte moved

          // Same for config-only drift.
          updateRecord(resolveEnv(), shipped.id, {
            status: "provisioning",
            shipPending: remotePending(rc, shipped.wtGit!),
            wtGit: undefined,
          });
          await git(f.wt, "config", "user.name", "someone-else");
          await cmdUp(["--no-session"]);
          expect(theRecord().status).toBe("up");
          expect(theRecord().wtGit?.generation).toBe(gen);
          expect(remoteManifest(rc)).toEqual(remoteBefore);
        } finally {
          restoreBeam(iso);
        }
      },
      120_000,
    );

    test(
      "crash before the landing: without transport proof the retry fails closed — the remote is" +
        " never re-synced",
      async () => {
        const iso = isolatedBeam("landresume");
        try {
          const f = await makeWtFixture();
          process.chdir(f.wt);
          await cmdUp(["--no-session"]);
          const shipped = theRecord();
          const rc = shipped.remoteCwd;

          // Nothing landed (pointer gone). The journal is intact, but the
          // local transport cannot PROVE the crashed attempt's uploads
          // completed (no licensed markers): fail closed BEFORE any sync —
          // local drift is never even consulted, because a pending retry
          // ships nothing local.
          const journaled = remotePending(rc, shipped.wtGit!);
          rmSync(join(rc, ".git"));
          writeFileSync(join(f.wt, "code.txt"), "drift\n");
          await git(f.wt, "add", "code.txt");
          updateRecord(resolveEnv(), shipped.id, {
            status: "provisioning",
            shipPending: journaled,
            wtGit: undefined,
          });
          const manifest = remoteManifest(rc);
          await expect(cmdUp(["--no-session"])).rejects.toThrow(/cannot be proven complete/);
          expect(theRecord().status).toBe("provisioning");
          expect(remoteManifest(rc)).toEqual(manifest); // untouched by the refusal

          // A foreign `.git` interposed before the retry refuses byte-intact
          // (provenance beats every proof gate).
          mkdirSync(join(rc, ".git"));
          writeFileSync(join(rc, ".git", "config"), "foreign\n");
          await expect(cmdUp(["--no-session"])).rejects.toThrow(/not its journaled ship/);
          expect(readFileSync(join(rc, ".git", "config"), "utf8")).toBe("foreign\n");
          expect(theRecord().status).toBe("provisioning");
        } finally {
          restoreBeam(iso);
        }
      },
      120_000,
    );

    test(
      "a fresh handoff never adopts a foreign deterministic dir — .beam and precious file stay" +
        " byte-intact",
      async () => {
        const iso = isolatedBeam("landowned");
        try {
          const ws = join(realpathSync(mkdtempSync(join(tmpdir(), "beam-landowned-"))), "ws");
          mkdirSync(ws);
          writeFileSync(join(ws, "code.txt"), "local\n");
          process.chdir(ws);
          const foreign = join(iso.remoteRoot, remoteWorkspaceName(ws));
          mkdirSync(join(foreign, ".beam"), { recursive: true });
          writeFileSync(
            join(foreign, ".beam", "owner"),
            "beam-workspace-v1 other 00000000000000000000000000000000\n",
          );
          writeFileSync(join(foreign, "precious.txt"), "not beam's\n");

          await expect(cmdUp(["--no-session"])).rejects.toThrow(/not owned by this handoff/);
          expect(readFileSync(join(foreign, "precious.txt"), "utf8")).toBe("not beam's\n");
          expect(readdirSync(foreign).sort()).toEqual([".beam", "precious.txt"]);

          // An emptied path is claimable; the claim plants this record's marker.
          rmSync(foreign, { recursive: true });
          mkdirSync(foreign);
          await cmdUp(["--no-session"]);
          const record = theRecord();
          expect(record.status).toBe("up");
          expect(readFileSync(join(foreign, ".beam", "owner"), "utf8")).toBe(
            `beam-workspace-v1 ${record.id} ${record.workspaceToken}\n`,
          );
          expect(readFileSync(join(foreign, "code.txt"), "utf8")).toBe("local\n");
        } finally {
          restoreBeam(iso);
        }
      },
      60_000,
    );

    test(
      "a local reserved-name collision — on disk in any case, or git-tracked — refuses before any" +
        " record or remote effect",
      async () => {
        const iso = isolatedBeam("collide");
        try {
          const f = await makeWtFixture();
          process.chdir(f.wt);

          mkdirSync(join(f.wt, ".BEAM"));
          await expect(cmdUp(["--no-session"])).rejects.toThrow(/reserves '\.beam'/);
          expect(loadState(resolveEnv()).records.length).toBe(0); // no reservation
          expect(existsSync(iso.remoteRoot)).toBe(false); // no remote effect
          rmSync(join(f.wt, ".BEAM"), { recursive: true });

          // A tracked `.beam` path would be re-created remotely by ordinary
          // git operations even when absent on disk — equally refused.
          const blob = (await git(f.wt, "rev-parse", "HEAD:conflict.txt")).stdout.trim();
          await runChecked(
            [
              "git", "-C", f.wt, "update-index", "--add",
              "--cacheinfo", "100644", blob, ".Beam/inner.txt",
            ],
            { env: GIT_ENV },
          );
          await expect(cmdUp(["--no-session"])).rejects.toThrow(/tracks '\.Beam\/inner\.txt'/);
          expect(loadState(resolveEnv()).records.length).toBe(0);
          expect(existsSync(iso.remoteRoot)).toBe(false);
        } finally {
          restoreBeam(iso);
        }
      },
      60_000,
    );
  },
);

describe.skipIf(!HAVE_DEPS)("git ship crash phases with a session enabled", () => {
  interface SessFixture {
    iso: IsolatedBeam;
    ws: string;
    sessionFile: string;
    artifactsDir: string;
    fakeBin: string;
    savedPath: string | undefined;
  }

  /**
   * Git workspace under BEAM_HOME with one omp session — transcript plus
   * the sibling artifacts tree real omp stores keep — and a fake omp
   * binary so the resume argv exits instantly inside the herdr pane.
   */
  async function makeSessionFixture(tag: string): Promise<SessFixture> {
    const iso = isolatedBeam(tag);
    const savedPath = process.env.PATH;
    const beamHome = process.env.BEAM_HOME!;
    const ws = join(beamHome, "work", "app");
    mkdirSync(ws, { recursive: true });
    await git(ws, "init", "-q", "-b", "main");
    writeFileSync(join(ws, "code.txt"), "v1\n");
    await git(ws, "add", ".");
    await git(ws, "commit", "-qm", "c1");
    const storeDir = join(beamHome, ".omp", "agent", "sessions", "-work-app");
    mkdirSync(storeDir, { recursive: true });
    const sessionFile = join(storeDir, "2026-08-01T10-00-00-000Z_sess-aaa.jsonl");
    writeFileSync(
      sessionFile,
      `{"type":"session","version":3,"id":"sess-aaa","timestamp":"t","cwd":"${ws}"}\n` +
        `{"type":"message","id":"m1","text":"local work"}\n`,
    );
    const artifactsDir = join(storeDir, "2026-08-01T10-00-00-000Z_sess-aaa");
    mkdirSync(artifactsDir);
    writeFileSync(join(artifactsDir, "blob.txt"), "artifact-v1\n");
    chmodSync(join(artifactsDir, "blob.txt"), 0o644);
    const fakeBin = join(beamHome, "fakebin");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, "omp"), "#!/bin/bash\nexit 0\n");
    chmodSync(join(fakeBin, "omp"), 0o755);
    const herdrPrefix = HERDR === null ? "" : `${dirname(HERDR)}:`;
    process.env.PATH =
      `${fakeBin}:${herdrPrefix}/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
    // LocalTransport execs through `bash -lc`, and a macOS login shell runs
    // path_helper, which reorders PATH so /etc/paths.d entries (Homebrew on
    // CI runners) jump ahead of fakeBin — a system-dir herdr would shadow a
    // fake one. The transport pins HOME at the target home, so a profile
    // there re-prepends fakeBin after path_helper has run, on every OS.
    writeFileSync(
      join(dirname(iso.remoteRoot), ".bash_profile"),
      `export PATH=${shq(fakeBin)}:"$PATH"\n`,
    );
    process.chdir(ws);
    return { iso, ws, sessionFile, artifactsDir, fakeBin, savedPath };
  }

  async function restoreSessionFixture(f: SessFixture): Promise<void> {
    // Best-effort: a test that started a REAL herdr session (or failed
    // mid-way) leaks its server on the uid-scoped socket — stop it there
    // (`session stop` never reaches the override socket) and delete every
    // recorded session's registry entry under the fixture's remote home.
    if (HERDR !== null) {
      const fixtureHome = dirname(f.iso.remoteRoot);
      for (const record of loadState(resolveEnv()).records) {
        const env = { HOME: fixtureHome, ...herdrSocketEnv(record.runtimeSession) };
        await run([HERDR, "server", "stop"], { env });
        await run([HERDR, "session", "delete", record.runtimeSession, "--json"], { env });
      }
    }
    process.env.PATH = f.savedPath;
    restoreBeam(f.iso);
  }

  /** Remote workspace manifest with Beam's reserved subtree factored out. */
  function userManifest(dir: string): Map<string, string> {
    const m = remoteManifest(dir);
    for (const key of [...m.keys()]) if (key === ".beam" || key.startsWith(".beam/")) m.delete(key);
    return m;
  }

  /**
   * Force the REAL crash-after-land window — nothing hand-built: run a
   * full sessioned up whose agent start fails (a broken herdr planted on
   * PATH; `pane list` still emits the machine-readable server_not_running
   * error so the retry's liveness probe answers instead of throwing),
   * leaving `starting` + the pending journal + its staged bundle exactly
   * as the crashed attempt wrote them, then demote the status to
   * `provisioning` — the same record shape a crash between the pointer
   * landing and the `up` flip leaves behind.
   */
  async function crashAfterLand(f: SessFixture): Promise<BeamRecord> {
    writeFileSync(
      join(f.fakeBin, "herdr"),
      `#!/bin/bash\n` +
        `if [ "$1" = "pane" ] && [ "$2" = "list" ]; then\n` +
        `  echo '{"id":"cli:pane:list","error":{"code":"server_not_running",` +
        `"message":"crash-lever"}}' >&2\n` +
        `fi\n` +
        `exit 1\n`,
    );
    chmodSync(join(f.fakeBin, "herdr"), 0o755);
    await expect(cmdUp([])).rejects.toThrow();
    const rec = theRecord();
    expect(rec.status).toBe("starting"); // install completed; the start crashed
    expect(rec.shipPending?.session?.stage).toBeDefined(); // journal + stage intact
    updateRecord(resolveEnv(), rec.id, { status: "provisioning" });
    return theRecord();
  }

  test(
    "crash after the landing installs the STAGED bundle — live transcript/artifact drift stays" +
      " local",
    async () => {
      const f = await makeSessionFixture("phasesess");
      try {
        const rec = await crashAfterLand(f);
        const rc = rec.remoteCwd;
        const gen = rec.shipPending!.git!.shipInfo.generation;
        const journaled = rec.shipPending!.session!;
        const stagedBytes = readFileSync(join(journaled.stage, "transcript.jsonl"), "utf8");
        expect(journaled.artifacts).not.toBeNull(); // the fixture ships artifacts

        // Recreate the pre-install window: the crashed attempt had already
        // published the session — remove it so the retry's session phase
        // does real work from the stage.
        rmSync(join(rc, ".beam", "session.jsonl"));
        rmSync(join(rc, ".beam", "session"), { recursive: true, force: true });

        // Live-store drift AFTER the journal: the transcript advances, an
        // artifact is replaced and chmodded, the workspace gains a file.
        // All of it is irrelevant — the retry ships the journaled stage.
        appendFileSync(f.sessionFile, `{"type":"message","id":"m2","text":"advanced locally"}\n`);
        writeFileSync(join(f.artifactsDir, "blob.txt"), "replaced locally\n");
        chmodSync(join(f.artifactsDir, "blob.txt"), 0o600);
        writeFileSync(join(f.ws, "newer-local.txt"), "stays local\n");

        const before = userManifest(rc);
        await cmdUp(["--no-start"]);
        expect(theRecord().status).toBe("up");
        expect(theRecord().shipPending).toBeUndefined();
        expect(theRecord().wtGit?.generation).toBe(gen);
        expect(userManifest(rc)).toEqual(before); // zero workspace/Git re-ship
        expect(existsSync(join(rc, "newer-local.txt"))).toBe(false);

        // The remote transcript is the STAGED (pre-drift) bundle — same
        // line count, header cwd rewritten to the remote workspace, the
        // locally appended line never shipped.
        const remote = readFileSync(join(rc, ".beam", "session.jsonl"), "utf8");
        expect(remote).toContain('"m1"');
        expect(remote).not.toContain("advanced locally");
        expect(remote.trimEnd().split("\n").length).toBe(stagedBytes.trimEnd().split("\n").length);
        // Staged (pre-drift) artifacts landed; the local replacement and
        // the local transcript append stayed local.
        const remoteBlob = join(rc, ".beam", "session", "blob.txt");
        expect(readFileSync(remoteBlob, "utf8")).toBe("artifact-v1\n");
        expect(readFileSync(join(f.artifactsDir, "blob.txt"), "utf8")).toBe("replaced locally\n");
        expect(readFileSync(f.sessionFile, "utf8")).toContain("advanced locally");
        // The completed ship reaped its bundle stage.
        expect(existsSync(join(resolveEnv().beamDir, "ship-stage", rec.id))).toBe(false);
      } finally {
        await restoreSessionFixture(f);
      }
    },
    120_000,
  );

  test(
    "a tampered staged bundle refuses the retry with zero remote writes — the record stays" +
      " provisioning",
    async () => {
      const f = await makeSessionFixture("phasetamper");
      try {
        const rec = await crashAfterLand(f);
        const rc = rec.remoteCwd;
        const stage = rec.shipPending!.session!.stage;
        appendFileSync(join(stage, "transcript.jsonl"), "x");

        const before = remoteManifest(rc);
        await expect(cmdUp(["--no-start"])).rejects.toThrow(
          /staged session bundle[\s\S]*beam kill/,
        );
        expect(theRecord().status).toBe("provisioning");
        expect(theRecord().shipPending).toEqual(rec.shipPending!); // journal untouched
        expect(remoteManifest(rc)).toEqual(before); // zero remote writes
        // Crash paths retain the stage.
        expect(existsSync(join(stage, "transcript.jsonl"))).toBe(true);
      } finally {
        await restoreSessionFixture(f);
      }
    },
    120_000,
  );

  test(
    "crash between the agent start and the up flip finalizes without re-shipping a byte",
    async () => {
      const f = await makeSessionFixture("phasestart");
      try {
        await cmdUp([]);
        const shipped = theRecord();
        const rc = shipped.remoteCwd;
        expect(shipped.status).toBe("up");
        expect(shipped.resumeArgv).toBeDefined(); // journaled with `starting`

        // The crash window: herdr ran (fake omp exited instantly), the
        // record still says `starting`. The retry finalizes — no mirror,
        // no payload, no session install, nothing.
        updateRecord(resolveEnv(), shipped.id, { status: "starting" });
        writeFileSync(join(f.ws, "newer-local.txt"), "stays local\n");
        const before = remoteManifest(rc);
        await cmdUp([]);
        expect(theRecord().status).toBe("up");
        expect(remoteManifest(rc)).toEqual(before);
        expect(existsSync(join(rc, "newer-local.txt"))).toBe(false);
      } finally {
        await restoreSessionFixture(f);
      }
    },
    120_000,
  );
});

/**
 * Local Git-layout preflights on a FRESH up: unsupported `.git` entries
 * and bare repositories classify as "plain" (lstat sees neither file nor
 * directory; a bare repo has no `.git` at all), so without the preflight
 * the mirror would ship the workspace with its Git state stripped — or
 * raw-copy a bare repository's config/hooks/objects. Both refuse BEFORE
 * the target reservation: a refused workspace must not claim a (possibly
 * exclusive) target or pin a misleading "plain" layout that a repaired
 * retry would trip over. A fresh reservation still pins the detected
 * layout atomically, so a transient materialize failure can never strand
 * a record the retry refuses forever.
 */
describe.skipIf(!HAVE_DEPS)(
  "fresh up: local Git-layout preflights precede any remote effect",
  () => {
    test(
      "a symlinked .git refuses before the reservation — repair, then retry succeeds without kill",
      async () => {
        const iso = isolatedBeam("gitlink");
        try {
          const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-gitlink-")));
          const donor = join(base, "donor");
          mkdirSync(donor);
          await git(donor, "init", "-q");
          const ws = join(base, "ws");
          mkdirSync(ws);
          writeFileSync(join(ws, "code.txt"), "work\n");
          symlinkSync(join(donor, ".git"), join(ws, ".git"));
          process.chdir(ws);

          await expect(cmdUp(["--no-session"])).rejects.toThrow(
            /\.git is a symlink or special file/,
          );
          // No side effect anywhere: the target was never reserved (no
          // record, no exclusive claim), the target root was never created,
          // and the donor repository was never touched through the link.
          expect(loadState(resolveEnv()).records).toEqual([]);
          expect(existsSync(iso.remoteRoot)).toBe(false);
          expect(existsSync(join(donor, ".git", "HEAD"))).toBe(true);

          // Repair to a supported layout and retry: no beam kill needed, no
          // stale "plain" pin to trip over — the up simply ships.
          rmSync(join(ws, ".git"));
          await git(ws, "init", "-q");
          writeFileSync(join(ws, "tracked.txt"), "t\n");
          await git(ws, "add", "-A");
          await git(ws, "commit", "-qm", "init");
          await cmdUp(["--no-session"]);
          expect(theRecord().status).toBe("up");
          expect(theRecord().workspaceKind).toBe("git");
        } finally {
          restoreBeam(iso);
        }
      },
      60_000,
    );

    test(
      "a bare repository cwd refuses before the reservation with no side effect",
      async () => {
        const iso = isolatedBeam("bare");
        try {
          const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-bare-")));
          const bare = join(base, "repo.git");
          await runChecked(["git", "init", "-q", "--bare", bare], { env: GIT_ENV });
          process.chdir(bare);

          await expect(cmdUp(["--no-session"])).rejects.toThrow(/bare repository/);
          expect(loadState(resolveEnv()).records).toEqual([]);
          expect(existsSync(iso.remoteRoot)).toBe(false);
        } finally {
          restoreBeam(iso);
        }
      },
      60_000,
    );

    test(
      "a transient materialize failure on a FRESH up leaves a record the retry can finish",
      async () => {
        const iso = isolatedBeam("freshretry");
        try {
          const f = await makeWtFixture();
          process.chdir(f.wt);

          // Inject exactly one materialize failure: an in-progress local
          // merge fails the payload build before any remote effect.
          await beginConflictMerge(f.wt);
          await expect(cmdUp(["--no-session"])).rejects.toThrow(
            /in-progress git operation \(MERGE_HEAD\)/,
          );

          // The reservation pinned the layout atomically, BEFORE materialize:
          // the stranded record is not ambiguous and nothing remote happened.
          const stranded = theRecord();
          expect(stranded.status).toBe("provisioning");
          expect(stranded.workspaceKind).toBe("git");
          expect(existsSync(iso.remoteRoot)).toBe(false);

          // The SAME record retries to completion once the operation ends.
          await git(f.wt, "merge", "--abort");
          await cmdUp(["--no-session"]);
          const finished = theRecord();
          expect(finished.id).toBe(stranded.id);
          expect(finished.status).toBe("up");
        } finally {
          restoreBeam(iso);
        }
      },
      60_000,
    );
  },
);

/**
 * The workspace mirror must ship ONE coherent snapshot: a background
 * writer changing a multi-file pair mid-mirror used to land file A from
 * before the write and file B from after it — a torn state every
 * Git-level check waves through. The mirror now stages into a local
 * quarantine and double-pass fingerprints the source; drift refuses
 * before any remote byte moves.
 */
describe.skipIf(!HAVE_DEPS)("fresh up: the workspace mirror ships one coherent snapshot", () => {
  test(
    "a two-file write interposed during staging never ships a torn mirror",
    async () => {
      const iso4 = isolatedBeam("tornstage");
      const savedPath4 = process.env.PATH;
      try {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-torn-")));
        const ws = join(base, "ws");
        mkdirSync(ws);
        writeFileSync(join(ws, "a.txt"), "a v1\n");
        writeFileSync(join(ws, "b.txt"), "b v1\n");
        process.chdir(ws);

        // Interpose the writer with perfect timing: a scripted rsync runs
        // the real transfer, then (one-shot, keyed on the STAGING source —
        // the pinned-dir transports no longer expose the stage dest in argv)
        // rewrites BOTH files — exactly the window between the stage's
        // first pass and its checksum re-read. The size preflight's
        // --dry-run walk runs earlier over the same source and must NOT
        // consume the one-shot: it moves no bytes, so it is outside the
        // stage-coherence window this test targets.
        const realRsync = Bun.which("rsync")!;
        const binDir = join(base, "bin");
        mkdirSync(binDir);
        const flag = join(base, "fire-once");
        writeFileSync(flag, "1");
        writeFileSync(
          join(binDir, "rsync"),
          [
            "#!/bin/bash",
            `"${realRsync}" "$@"`,
            "rc=$?",
            `case "$*" in *--dry-run*) ;; *"${ws}"*) if [ -f "${flag}" ]; then rm -f "${flag}"; ` +
              `printf 'a v2\\n' > "${ws}/a.txt"; printf 'b v2\\n' > "${ws}/b.txt"; fi;; esac`,
            "exit $rc",
            "",
          ].join("\n"),
        );
        chmodSync(join(binDir, "rsync"), 0o755);
        process.env.PATH = `${binDir}:${process.env.PATH}`;

        await expect(cmdUp(["--no-session"])).rejects.toThrow(/changed while it was being staged/);
        const crashed = theRecord();
        expect(crashed.status).toBe("provisioning"); // refused before any remote byte
        // The workspace was established (holding only Beam's own reserved
        // dir with the ownership marker) but the torn pair never shipped.
        expect(readdirSync(crashed.remoteCwd)).toEqual([".beam"]);

        // Quiet again: the retry ships one coherent v2 pair.
        process.env.PATH = savedPath4!;
        await cmdUp(["--no-session"]);
        const finished = theRecord();
        expect(finished.status).toBe("up");
        expect(readFileSync(join(finished.remoteCwd, "a.txt"), "utf8")).toBe("a v2\n");
        expect(readFileSync(join(finished.remoteCwd, "b.txt"), "utf8")).toBe("b v2\n");
      } finally {
        process.env.PATH = savedPath4;
        restoreBeam(iso4);
      }
    },
    60_000,
  );
});

/**
 * The workspace mirror never syncs into the live root: it lands in the
 * owner-held reserved stage (`.beam/uploads/<digest>/workspace`) and one
 * owner-held shell publishes it CREATE-ONLY (mkdir / link(2) / symlink(2),
 * EEXIST accepted only as the exact staged entry). A foreign concurrent
 * file therefore survives byte-for-byte behind a refusal, a crashed
 * publish converges on retry, and a proven ship's retry is a pure
 * re-proof of the live root against the journaled digest.
 */
describe.skipIf(!HAVE_DEPS)(
  "plain workspace ship: reserved-stage upload, create-only publish",
  () => {
    /**
     * Plain (non-git) workspace: an executable, a nested 0750 tree, an empty
     * dir, a relative symlink.
     */
    function makePlainWs(tag: string): string {
      const ws = join(realpathSync(mkdtempSync(join(tmpdir(), `beam-${tag}-`))), "ws");
      mkdirSync(join(ws, "src"), { recursive: true });
      mkdirSync(join(ws, "empty"));
      writeFileSync(join(ws, "run.sh"), "#!/bin/sh\necho hi\n");
      chmodSync(join(ws, "run.sh"), 0o755);
      writeFileSync(join(ws, "src", "app.txt"), "v1\n");
      chmodSync(join(ws, "src", "app.txt"), 0o644);
      chmodSync(join(ws, "src"), 0o750);
      symlinkSync("src/app.txt", join(ws, "link"));
      return ws;
    }

    test(
      "a fresh ship lands byte-identical files, modes, and symlinks, and reaps its reserved stage",
      async () => {
        const iso = isolatedBeam("pubfresh");
        try {
          const ws = makePlainWs("pubfresh");
          process.chdir(ws);
          await cmdUp(["--no-session"]);
          const record = theRecord();
          expect(record.status).toBe("up");
          expect(record.workspaceKind).toBe("plain");
          expect(record.shipPending).toBeUndefined();
          const rc = record.remoteCwd;
          // Exact bytes.
          expect(readFileSync(join(rc, "run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
          expect(readFileSync(join(rc, "src", "app.txt"), "utf8")).toBe("v1\n");
          // Exact modes — the executable bit and the non-default dir mode.
          expect(lstatSync(join(rc, "run.sh")).mode & 0o777).toBe(0o755);
          expect(lstatSync(join(rc, "src", "app.txt")).mode & 0o777).toBe(0o644);
          expect(lstatSync(join(rc, "src")).mode & 0o777).toBe(0o750);
          expect(lstatSync(join(rc, "empty")).isDirectory()).toBe(true);
          // Exact relative symlink.
          expect(lstatSync(join(rc, "link")).isSymbolicLink()).toBe(true);
          expect(readlinkSync(join(rc, "link"))).toBe("src/app.txt");
          // The reserved stage was reaped after the proof: the published
          // files are single-linked again and the generation dir is gone.
          expect(lstatSync(join(rc, "run.sh")).nlink).toBe(1);
          expect(readdirSync(join(rc, ".beam", "uploads"))).toEqual([]);
        } finally {
          restoreBeam(iso);
        }
      },
      60_000,
    );

    test(
      "a foreign extra AND a same-name collision planted between establish and publish refuse" +
        " with zero overwrites",
      async () => {
        const iso = isolatedBeam("pubrace");
        try {
          const ws = makePlainWs("pubrace");
          process.chdir(ws);
          // The concurrent foreign writer lands AFTER the establish
          // emptiness proof and the stage landing, right before the publish:
          // one file beam never shipped, one same-name-different-bytes
          // collision with the staged run.sh.
          workspacePublishTestSeam.beforePublish = (remoteCwd) => {
            writeFileSync(join(remoteCwd, "evil.txt"), "foreign\n");
            writeFileSync(join(remoteCwd, "run.sh"), "not the local bytes\n");
          };
          try {
            await expect(cmdUp(["--no-session"])).rejects.toThrow(
              /run\.sh already exists in the live workspace with different content/,
            );
          } finally {
            workspacePublishTestSeam.beforePublish = undefined;
          }
          const record = theRecord();
          expect(record.status).toBe("provisioning");
          expect(record.shipPending?.workspaceInstalled).toBeUndefined();
          const rc = record.remoteCwd;
          // Both planted files survive byte-for-byte.
          expect(readFileSync(join(rc, "evil.txt"), "utf8")).toBe("foreign\n");
          expect(readFileSync(join(rc, "run.sh"), "utf8")).toBe("not the local bytes\n");

          // Same bytes but a different mode is STILL a collision: refused,
          // untouched (the exact-accept path demands bytes AND mode).
          rmSync(join(rc, "run.sh"));
          writeFileSync(join(rc, "run.sh"), "#!/bin/sh\necho hi\n");
          chmodSync(join(rc, "run.sh"), 0o644);
          await expect(cmdUp(["--no-session"])).rejects.toThrow(
            /run\.sh already exists in the live workspace with a different mode/,
          );
          expect(lstatSync(join(rc, "run.sh")).mode & 0o777).toBe(0o644);
          expect(readFileSync(join(rc, "evil.txt"), "utf8")).toBe("foreign\n");

          // Drop the collision: the retry publishes run.sh, but the foreign
          // extra still fails the strict stage-vs-live proof — byte-intact.
          rmSync(join(rc, "run.sh"));
          await expect(cmdUp(["--no-session"])).rejects.toThrow(/does not match the staged mirror/);
          expect(readFileSync(join(rc, "run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
          expect(readFileSync(join(rc, "evil.txt"), "utf8")).toBe("foreign\n");

          // Remove the foreign extra: the retry converges to `up` and reaps
          // the reserved stage.
          rmSync(join(rc, "evil.txt"));
          await cmdUp(["--no-session"]);
          expect(theRecord().status).toBe("up");
          expect(theRecord().shipPending).toBeUndefined();
          expect(readdirSync(join(rc, ".beam", "uploads"))).toEqual([]);
        } finally {
          restoreBeam(iso);
        }
      },
      120_000,
    );

    interface CrashedPublish {
      rc: string;
      stage: string;
      digest: string;
    }

    /**
     * Crash MID-publish: one staged file already landed (hardlinked, exactly
     * like the publish script lands it), then the attempt dies. The pending
     * journal and the reserved stage stay behind: run.sh made it, nothing
     * else did, and the record still says provisioning.
     */
    async function crashMidPublish(): Promise<CrashedPublish> {
      workspacePublishTestSeam.beforePublish = (remoteCwd) => {
        const gens = readdirSync(join(remoteCwd, ".beam", "uploads"));
        expect(gens.length).toBe(1);
        linkSync(
          join(remoteCwd, ".beam", "uploads", gens[0]!, "workspace", "run.sh"),
          join(remoteCwd, "run.sh"),
        );
        throw new Error("interposed crash mid-publish");
      };
      try {
        await expect(cmdUp(["--no-session"])).rejects.toThrow(/interposed crash mid-publish/);
      } finally {
        workspacePublishTestSeam.beforePublish = undefined;
      }
      const record = theRecord();
      expect(record.status).toBe("provisioning");
      expect(record.shipPending?.workspaceInstalled).toBeUndefined();
      const digest = record.shipPending!.workspaceDigest;
      const rc = record.remoteCwd;
      // Partial landing: run.sh made it, nothing else did.
      expect(readFileSync(join(rc, "run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
      expect(existsSync(join(rc, "src"))).toBe(false);
      expect(existsSync(join(rc, "link"))).toBe(false);
      return { rc, stage: join(rc, ".beam", "uploads", digest, "workspace"), digest };
    }

    /**
     * The live root equals the staged tree exactly — bytes, modes, symlink
     * target, the empty dir — and the reserved stage is reaped.
     */
    function expectPublishedTree(rc: string): void {
      expect(readFileSync(join(rc, "run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
      expect(lstatSync(join(rc, "run.sh")).mode & 0o777).toBe(0o755);
      expect(readFileSync(join(rc, "src", "app.txt"), "utf8")).toBe("v1\n");
      expect(lstatSync(join(rc, "src")).mode & 0o777).toBe(0o750);
      expect(lstatSync(join(rc, "src", "app.txt")).mode & 0o777).toBe(0o644);
      expect(readlinkSync(join(rc, "link"))).toBe("src/app.txt");
      expect(lstatSync(join(rc, "empty")).isDirectory()).toBe(true);
      expect(readdirSync(join(rc, ".beam", "uploads"))).toEqual([]);
    }

    test(
      "a crashed mid-publish attempt converges on retry; a reaped stage retries as a pure re-proof",
      async () => {
        const iso = isolatedBeam("pubcrash");
        try {
          const ws = makePlainWs("pubcrash");
          process.chdir(ws);
          const { rc, stage, digest } = await crashMidPublish();
          // Tamper the CONTENT of a never-published Beam-owned stage entry:
          // the retry's additive checksum re-sync must converge it back in
          // place before publishing (no mirrored deletion — the stage sync
          // stays kubectl-additive-compatible).
          writeFileSync(join(stage, "src", "app.txt"), "tampered stage\n");

          await cmdUp(["--no-session"]);
          const done = theRecord();
          expect(done.status).toBe("up");
          expect(done.shipPending).toBeUndefined();
          expectPublishedTree(rc);

          // A retry whose journal proved the install and whose stage is
          // reaped is a pure re-proof: not one remote byte moves.
          updateRecord(resolveEnv(), done.id, {
            status: "provisioning",
            shipPending: { workspaceDigest: digest, workspaceInstalled: true },
          });
          const manifest = remoteManifest(rc);
          await cmdUp(["--no-session"]);
          expect(theRecord().status).toBe("up");
          expect(theRecord().shipPending).toBeUndefined();
          expect(remoteManifest(rc)).toEqual(manifest);

          // The same journal against a TAMPERED live root fails closed with
          // the existing refusal wording — nothing is re-synced over it.
          updateRecord(resolveEnv(), done.id, {
            status: "provisioning",
            shipPending: { workspaceDigest: digest, workspaceInstalled: true },
          });
          appendFileSync(join(rc, "run.sh"), "drifted\n");
          await expect(cmdUp(["--no-session"])).rejects.toThrow(/cannot be proven complete/);
          expect(readFileSync(join(rc, "run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\ndrifted\n");
        } finally {
          restoreBeam(iso);
        }
      },
      120_000,
    );

    test(
      "every upload-side syncUp is additive (kubectl-compatible): no mirrored deletion," +
        " Beam-reserved destinations only",
      async () => {
        const iso = isolatedBeam("pubadd");
        const original = LocalTransport.prototype.syncUp;
        const calls: Array<{ remoteDir: string; del: boolean }> = [];
        LocalTransport.prototype.syncUp = async function (
          localDir: string,
          remoteDir: string,
          opts: SyncOptions = {},
        ): Promise<void> {
          calls.push({ remoteDir, del: opts.delete === true });
          return original.call(this, localDir, remoteDir, opts);
        };
        try {
          const ws = makePlainWs("pubadd");
          process.chdir(ws);
          await cmdUp(["--no-session"]);
          expect(theRecord().status).toBe("up");
          // Only TARGET-bound uploads matter for the transport contract:
          // stageWorkspaceShip's quarantine build is a local-to-local rsync
          // on the operator machine (always LocalTransport by construction)
          // and never crosses a remote transport.
          const remote = calls.filter((c) => c.remoteDir.startsWith(iso.remoteRoot));
          // The workspace mirror shipped (at least the stage sync ran) …
          expect(remote.length).toBeGreaterThan(0);
          // … every target-bound ship was additive — the kubectl tar
          // transport refuses `delete` before any remote mutation, so a
          // mirroring upload here would break that transport wholesale …
          expect(remote.filter((c) => c.del)).toEqual([]);
          // … and no upload targeted the live workspace root: everything
          // lands under Beam's reserved dir and publishes create-only.
          const rc = theRecord().remoteCwd;
          expect(remote.filter((c) => !c.remoteDir.startsWith(`${rc}/.beam/`))).toEqual([]);
        } finally {
          LocalTransport.prototype.syncUp = original;
          restoreBeam(iso);
        }
      },
      60_000,
    );
  },
);