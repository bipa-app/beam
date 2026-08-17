/**
 * Goal: session-return collection never mutates the local harness store —
 * every return lands create-only under `<beamDir>/returns/<record>/<txn>/`
 * with the record's receipt pointing at it; the original transcript and
 * artifacts stay byte- and inode-identical no matter what the remote
 * returned or when the local harness wrote; and the identity, stability,
 * and idempotence proofs make the returned bytes trustworthy and complete.
 *
 * Method: drive the real `collectSessionReturn` over a LocalTransport
 * rooted in mkdtemp fixture homes whose staged "remote" transcripts and
 * artifact trees are prepared on disk; snapshot the store (bytes + inode)
 * across collection, re-prove receipts against fresh fetches, and check
 * returned modes, identity binding, and bounded streaming digests of large
 * returns. No real harness store (~/.omp, ~/.claude, ~/.codex) is touched.
 */
import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  symlinkSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSessionReturn } from "../src/session/collect-txn.ts";
import { fileSha256 } from "../src/util/digest.ts";
import { shq } from "../src/util/shell.ts";
import { ClaudeAdapter, claudeProjectSlug } from "../src/session/claude.ts";
import { CodexAdapter } from "../src/session/codex.ts";
import { OmpAdapter, PiAdapter } from "../src/session/pi-family.ts";
import type { BeamEnv } from "../src/env.ts";
import type { LocalSession, StagedReturn } from "../src/session/types.ts";
import type { Transport } from "../src/transport/types.ts";
import { addRecord, getRecord, loadState, type BeamRecord } from "../src/state.ts";
import { LocalTransport } from "../src/transport/local.ts";

const OMP_HEADER = (cwd: string, id = "abc-123") =>
  `{"type":"session","version":3,"id":"${id}",` +
  `"timestamp":"2026-01-01T00:00:00.000Z","cwd":"${cwd}"}\n` +
  `{"type":"message","id":"m1"}\n`;

function tempHome(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "beam-ctxn-")));
}

function makeRecord(
  env: BeamEnv,
  fields: Pick<
    BeamRecord,
    "tool" | "sessionId" | "sessionFile" | "localCwd" | "remoteCwd" | "artifactsDir"
  >,
): BeamRecord {
  const record: BeamRecord = {
    id: "r1",
    target: "t",
    tmux: "-",
    status: "up",
    createdAt: "t",
    updatedAt: "t",
    ...fields,
  };
  addRecord(env, record);
  return record;
}

/** omp: workspace-shipped transcript plus a remote-created artifacts tree. */
function ompFixture(opts: { localArtifacts?: boolean } = {}) {
  const home = tempHome();
  const env: BeamEnv = { home, beamDir: join(home, ".beam-state") };
  const cwd = join(home, "w");
  mkdirSync(cwd, { recursive: true });
  const store = join(home, ".omp", "agent", "sessions", "-w");
  mkdirSync(store, { recursive: true });
  const file = join(store, "2026-01-01T00-00-00-000Z_abc-123.jsonl");
  writeFileSync(file, OMP_HEADER(cwd));
  const artifactsDir = join(store, "2026-01-01T00-00-00-000Z_abc-123");
  if (opts.localArtifacts) {
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "old.txt"), "shipped artifact\n");
  }

  const remoteCwd = join(home, "remote-ws");
  mkdirSync(join(remoteCwd, ".beam", "session"), { recursive: true });
  writeFileSync(
    join(remoteCwd, ".beam", "session.jsonl"),
    OMP_HEADER(remoteCwd) + `{"type":"message","from":"remote-agent"}\n`,
  );
  writeFileSync(join(remoteCwd, ".beam", "session", "new.txt"), "made remotely\n");

  const record = makeRecord(env, {
    tool: "omp",
    sessionId: "abc-123",
    sessionFile: file,
    artifactsDir: opts.localArtifacts ? artifactsDir : undefined,
    localCwd: cwd,
    remoteCwd,
  });
  return { env, record, cwd, store, file, artifactsDir, remoteCwd, t: new LocalTransport(home) };
}

/** The store must be untouched: same bytes AND the same inode. */
function snapshotStore(file: string): { bytes: string; ino: number } {
  return { bytes: readFileSync(file, "utf8"), ino: lstatSync(file).ino };
}

function expectStoreUntouched(file: string, before: { bytes: string; ino: number }): void {
  expect(readFileSync(file, "utf8")).toBe(before.bytes);
  expect(lstatSync(file).ino).toBe(before.ino);
}

describe(
  "session returns land under beam's own storage; the harness store is never touched",
  () => {
    test(
      "omp: transcript + artifacts staged durably, store byte/inode-identical, " +
        "resume by returned path",
      async () => {
        const f = ompFixture({ localArtifacts: true });
        const before = snapshotStore(f.file);

        const out = await collectSessionReturn(f.env, f.record, new OmpAdapter(), f.t);
        expect(out.alreadyCollected).toBe(false);

        const receipt = loadState(f.env).records[0]!.collect!;
        expect(out.returnDir).toBe(receipt.returnDir);
        expect(receipt.returnDir.startsWith(join(f.env.beamDir, "returns", f.record.id))).toBe(
          true,
        );

        const returned = readFileSync(join(receipt.returnDir, "session.jsonl"), "utf8");
        expect(returned).toContain('"from":"remote-agent"');
        // header localized for local resume
        expect(JSON.parse(returned.split("\n")[0]!).cwd).toBe(f.cwd);
        expect(readFileSync(join(receipt.returnDir, "artifacts", "new.txt"), "utf8")).toBe(
          "made remotely\n",
        );
        expect(out.hint).toBe(`omp --resume ${shq(join(receipt.returnDir, "session.jsonl"))}`);

        // The harness store — transcript AND artifacts — was never touched.
        expectStoreUntouched(f.file, before);
        expect(readdirSync(f.artifactsDir)).toEqual(["old.txt"]);
        // no backups: nothing was replaced
        expect(readdirSync(f.store).filter((n) => n.includes(".bak"))).toEqual([]);
      },
    );

    test("pi: resume hint targets the returned session dir; store untouched", async () => {
      const home = tempHome();
      const env: BeamEnv = { home, beamDir: join(home, ".beam-state") };
      const cwd = join(home, "w");
      mkdirSync(cwd, { recursive: true });
      const store = join(home, ".pi", "agent", "sessions", "slug");
      mkdirSync(store, { recursive: true });
      const file = join(store, "2026-01-01T00-00-00-000Z_pi9.jsonl");
      writeFileSync(file, OMP_HEADER(cwd, "pi9"));
      const remoteCwd = join(home, "remote-ws");
      mkdirSync(join(remoteCwd, ".beam", "pi-sessions"), { recursive: true });
      writeFileSync(
        join(remoteCwd, ".beam", "pi-sessions", "session.jsonl"),
        OMP_HEADER(remoteCwd, "pi9") + `{"type":"message","from":"remote-agent"}\n`,
      );
      const record = makeRecord(env, {
        tool: "pi",
        sessionId: "pi9",
        sessionFile: file,
        localCwd: cwd,
        remoteCwd,
      });
      const before = snapshotStore(file);

      const out = await collectSessionReturn(
        env,
        record,
        new PiAdapter(),
        new LocalTransport(home),
      );
      expect(out.hint).toBe(`cd ${shq(cwd)} && pi --session-dir ${shq(out.returnDir)} --continue`);
      expect(readFileSync(join(out.returnDir, "session.jsonl"), "utf8")).toContain(
        '"from":"remote-agent"',
      );
      expectStoreUntouched(file, before);
    });

    test(
      "resume hints quote hostile paths: shell metacharacters ride as inert literals",
      async () => {
        // A legal-but-hostile HOME: spaces, $(), backticks, ;&|> — every path
        // derived from it (cwd, beam return dir) inherits the hostility, and a
        // copy-pasted hint must treat all of it as quoted literals.
        const home = realpathSync(
          mkdtempSync(join(tmpdir(), "beam-ctxn-h $(touch pwned) `x`;&|>-")),
        );
        const env: BeamEnv = { home, beamDir: join(home, ".beam-state") };
        const cwd = join(home, "w");
        mkdirSync(cwd, { recursive: true });
        const store = join(home, ".pi", "agent", "sessions", "slug");
        mkdirSync(store, { recursive: true });
        const file = join(store, "2026-01-01T00-00-00-000Z_pi9.jsonl");
        writeFileSync(file, OMP_HEADER(cwd, "pi9"));
        const remoteCwd = join(home, "remote-ws");
        mkdirSync(join(remoteCwd, ".beam", "pi-sessions"), { recursive: true });
        writeFileSync(
          join(remoteCwd, ".beam", "pi-sessions", "session.jsonl"),
          OMP_HEADER(remoteCwd, "pi9") + `{"type":"message","from":"remote-agent"}\n`,
        );
        const record = makeRecord(env, {
          tool: "pi",
          sessionId: "pi9",
          sessionFile: file,
          localCwd: cwd,
          remoteCwd,
        });

        const out = await collectSessionReturn(
          env,
          record,
          new PiAdapter(),
          new LocalTransport(home),
        );
        expect(out.hint).toBe(
          `cd ${shq(cwd)} && pi --session-dir ${shq(out.returnDir)} --continue`,
        );
        // Nothing along the pipeline interpolated the hostile names.
        expect(existsSync(join(home, "pwned"))).toBe(false);
        expect(existsSync("pwned")).toBe(false);
      },
    );

    test("claude: manual-import hint, live ~/.claude store untouched", async () => {
      const localHome = tempHome();
      const remoteHome = tempHome();
      const env: BeamEnv = { home: localHome, beamDir: join(localHome, ".beam-state") };
      const cwd = join(localHome, "w");
      mkdirSync(cwd, { recursive: true });
      const id = "11111111-2222-3333-4444-555555555555";
      const store = join(localHome, ".claude", "projects", claudeProjectSlug(cwd));
      mkdirSync(store, { recursive: true });
      const file = join(store, `${id}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: "user", sessionId: id, message: "local" })}\n`);
      const remoteCwd = join(remoteHome, "remote-ws");
      const remoteStore = join(remoteHome, ".claude", "projects", claudeProjectSlug(remoteCwd));
      mkdirSync(remoteStore, { recursive: true });
      const grown =
        `${JSON.stringify({ type: "user", sessionId: id, message: "local" })}\n` +
        `${JSON.stringify({ type: "assistant", sessionId: id, message: "grown remotely" })}\n`;
      writeFileSync(join(remoteStore, `${id}.jsonl`), grown);
      const record = makeRecord(env, {
        tool: "claude",
        sessionId: id,
        sessionFile: file,
        localCwd: cwd,
        remoteCwd,
      });
      const before = snapshotStore(file);

      const out = await collectSessionReturn(
        env,
        record,
        new ClaudeAdapter(),
        new LocalTransport(remoteHome),
      );
      // exact remote bytes
      expect(readFileSync(join(out.returnDir, "session.jsonl"), "utf8")).toBe(grown);
      expect(out.hint).toContain("manual import");
      expect(out.hint).toContain(`cp ${shq(join(out.returnDir, "session.jsonl"))} ${shq(file)}`);
      expect(out.hint).toContain(`claude --resume ${shq(id)}`);
      expectStoreUntouched(file, before);
    });

    test("codex: manual-import hint, live ~/.codex store untouched", async () => {
      const localHome = tempHome();
      const remoteHome = tempHome();
      const env: BeamEnv = { home: localHome, beamDir: join(localHome, ".beam-state") };
      const cwd = join(localHome, "w");
      mkdirSync(cwd, { recursive: true });
      const rollout = "rollout-2026-08-09T10-00-00-id-1.jsonl";
      const rel = join(".codex", "sessions", "2026", "08", "09", rollout);
      const file = join(localHome, rel);
      mkdirSync(join(localHome, ".codex", "sessions", "2026", "08", "09"), { recursive: true });
      const meta = { timestamp: "t", type: "session_meta", payload: { session_id: "id-1", cwd } };
      writeFileSync(file, `${JSON.stringify(meta)}\n`);
      const remoteFile = join(remoteHome, rel);
      mkdirSync(join(remoteHome, ".codex", "sessions", "2026", "08", "09"), { recursive: true });
      const grown = `${JSON.stringify(meta)}\n{"type":"message","text":"grown remotely"}\n`;
      writeFileSync(remoteFile, grown);
      const record = makeRecord(env, {
        tool: "codex",
        sessionId: "id-1",
        sessionFile: file,
        localCwd: cwd,
        remoteCwd: join(remoteHome, "remote-ws"),
      });
      const before = snapshotStore(file);

      const out = await collectSessionReturn(
        env,
        record,
        new CodexAdapter(),
        new LocalTransport(remoteHome),
      );
      expect(readFileSync(join(out.returnDir, "session.jsonl"), "utf8")).toBe(grown);
      expect(out.hint).toContain("manual import");
      expect(out.hint).toContain(`codex resume ${shq("id-1")}`);
      expectStoreUntouched(file, before);
    });
  },
);

/** stageReturn blocks until released — pins the mid-fetch mutation window deterministically. */
class GatedOmpAdapter extends OmpAdapter {
  constructor(
    private readonly started: () => void,
    private readonly gate: Promise<void>,
  ) {
    super();
  }

  override async stageReturn(
    t: Transport,
    session: LocalSession,
    localCwd: string,
    remoteCwd: string,
    stageDir: string,
  ): Promise<StagedReturn> {
    this.started();
    await this.gate;
    return super.stageReturn(t, session, localCwd, remoteCwd, stageDir);
  }
}

describe("a live local harness is a non-event: collection neither blocks on nor touches it", () => {
  test("the store grows mid-fetch; collection succeeds and both copies are complete", async () => {
    const f = ompFixture();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const startedP = new Promise<void>((r) => {
      started = r;
    });

    const inFlight = collectSessionReturn(f.env, f.record, new GatedOmpAdapter(started, gate), f.t);
    await startedP;
    appendFileSync(f.file, `{"type":"message","id":"local-work-mid-fetch"}\n`);
    const advanced = snapshotStore(f.file);
    release();

    const out = await inFlight;
    expect(out.alreadyCollected).toBe(false);
    expectStoreUntouched(f.file, advanced); // the local growth is untouched
    expect(readFileSync(join(out.returnDir, "session.jsonl"), "utf8")).toContain(
      '"from":"remote-agent"',
    );
  });
});

describe("identity binding: the returned transcript must prove this handoff's session", () => {
  test(
    "a same-cwd remote transcript with a different session id refuses; nothing is journaled",
    async () => {
      const f = ompFixture();
      writeFileSync(
        join(f.remoteCwd, ".beam", "session.jsonl"),
        OMP_HEADER(f.remoteCwd, "other-session") + `{"type":"message","from":"remote-agent"}\n`,
      );
      const before = snapshotStore(f.file);

      await expect(collectSessionReturn(f.env, f.record, new OmpAdapter(), f.t)).rejects.toThrow(
        /records session id other-session, not this handoff's session abc-123/,
      );
      expectStoreUntouched(f.file, before);
      expect(loadState(f.env).records[0]!.collect).toBeUndefined();
      // The failed transaction directory was removed — partials are never data.
      const parent = join(f.env.beamDir, "returns", f.record.id);
      expect(!existsSync(parent) || readdirSync(parent).length === 0).toBe(true);
    },
  );
});

/** A detached remote writer that appends between beam's two fetches. */
class FlappingRemoteAdapter extends OmpAdapter {
  private fetches = 0;
  constructor(private readonly remoteSession: string) {
    super();
  }

  override async stageReturn(
    t: Transport,
    session: LocalSession,
    localCwd: string,
    remoteCwd: string,
    stageDir: string,
  ): Promise<StagedReturn> {
    this.fetches++;
    if (this.fetches === 2) {
      appendFileSync(this.remoteSession, `{"type":"message","from":"detached-writer"}\n`);
    }
    return super.stageReturn(t, session, localCwd, remoteCwd, stageDir);
  }
}

describe(
  "remote stability proof: a return is only trusted when two consecutive fetches agree",
  () => {
    test(
      "a remote still being written refuses collection before anything is journaled",
      async () => {
        const f = ompFixture();
        const adapter = new FlappingRemoteAdapter(join(f.remoteCwd, ".beam", "session.jsonl"));
        const before = snapshotStore(f.file);

        await expect(collectSessionReturn(f.env, f.record, adapter, f.t)).rejects.toThrow(
          /changed between two consecutive fetches/,
        );
        expectStoreUntouched(f.file, before);
        expect(loadState(f.env).records[0]!.collect).toBeUndefined();
        const parent = join(f.env.beamDir, "returns", f.record.id);
        expect(!existsSync(parent) || readdirSync(parent).length === 0).toBe(true);
        // The remote — including the mid-fetch append — is fully intact.
        expect(readFileSync(join(f.remoteCwd, ".beam", "session.jsonl"), "utf8")).toContain(
          "detached-writer",
        );
      },
    );

    test("once the writer stops, the retry collects the settled remote", async () => {
      const f = ompFixture();
      const flapping = new FlappingRemoteAdapter(join(f.remoteCwd, ".beam", "session.jsonl"));
      await expect(collectSessionReturn(f.env, f.record, flapping, f.t)).rejects.toThrow(
        /two consecutive fetches/,
      );

      const out = await collectSessionReturn(
        f.env,
        getRecord(f.env, f.record.id),
        new OmpAdapter(),
        f.t,
      );
      expect(out.alreadyCollected).toBe(false);
      expect(readFileSync(join(out.returnDir, "session.jsonl"), "utf8")).toContain(
        "detached-writer",
      );
    });
  },
);

describe("idempotence and remote growth: the receipt is re-proven against a fresh fetch", () => {
  test("an unchanged remote verifies the durable return instead of duplicating it", async () => {
    const f = ompFixture();
    const adapter = new OmpAdapter();
    const first = await collectSessionReturn(f.env, f.record, adapter, f.t);

    const again = await collectSessionReturn(f.env, getRecord(f.env, f.record.id), adapter, f.t);
    expect(again.alreadyCollected).toBe(true);
    expect(again.returnDir).toBe(first.returnDir);
    expect(again.hint).toBe(first.hint);
    // Exactly one durable return on disk — the duplicate fetch was dropped.
    expect(readdirSync(join(f.env.beamDir, "returns", f.record.id))).toHaveLength(1);
  });

  test("a remote that grew lands as a NEW return; the old one is retained untouched", async () => {
    const f = ompFixture();
    const adapter = new OmpAdapter();
    const first = await collectSessionReturn(f.env, f.record, adapter, f.t);
    const firstBytes = readFileSync(join(first.returnDir, "session.jsonl"), "utf8");
    appendFileSync(
      join(f.remoteCwd, ".beam", "session.jsonl"),
      `{"type":"message","from":"remote-restart"}\n`,
    );
    const before = snapshotStore(f.file);

    const second = await collectSessionReturn(f.env, getRecord(f.env, f.record.id), adapter, f.t);
    expect(second.alreadyCollected).toBe(false);
    expect(second.returnDir).not.toBe(first.returnDir);
    expect(readFileSync(join(second.returnDir, "session.jsonl"), "utf8")).toContain(
      '"from":"remote-restart"',
    );
    // Old return retained byte-identical; receipt now points at the new one.
    expect(readFileSync(join(first.returnDir, "session.jsonl"), "utf8")).toBe(firstBytes);
    expect(loadState(f.env).records[0]!.collect!.returnDir).toBe(second.returnDir);
    expectStoreUntouched(f.file, before);
  });

  test("a damaged durable return is simply recollected", async () => {
    const f = ompFixture();
    const adapter = new OmpAdapter();
    const first = await collectSessionReturn(f.env, f.record, adapter, f.t);
    rmSync(first.returnDir, { recursive: true, force: true }); // user deleted the return

    const again = await collectSessionReturn(f.env, getRecord(f.env, f.record.id), adapter, f.t);
    expect(again.alreadyCollected).toBe(false);
    expect(again.returnDir).not.toBe(first.returnDir);
    expect(readFileSync(join(again.returnDir, "session.jsonl"), "utf8")).toContain(
      '"from":"remote-agent"',
    );
  });

  test("a faulted durable-return check propagates instead of recollecting", async () => {
    const f = ompFixture();
    const adapter = new OmpAdapter();
    const first = await collectSessionReturn(f.env, f.record, adapter, f.t);
    // Not absence — a real fault shape: the receipted return dir is now a
    // regular file, so reading through it hits ENOTDIR.
    rmSync(first.returnDir, { recursive: true, force: true });
    writeFileSync(first.returnDir, "clobbered\n");

    const record = getRecord(f.env, f.record.id);
    await expect(collectSessionReturn(f.env, record, adapter, f.t)).rejects.toThrow(/ENOTDIR/);
    // The fault journaled nothing: the receipt still points at the original
    // return instead of a recollection papering over the damage.
    expect(loadState(f.env).records[0]!.collect!.returnDir).toBe(first.returnDir);
  });

  test("a faulted artifacts manifest in the durable return propagates too", async () => {
    const f = ompFixture();
    const adapter = new OmpAdapter();
    const first = await collectSessionReturn(f.env, f.record, adapter, f.t);
    // session.jsonl stays receipt-identical; only the artifacts tree faults.
    const artifacts = join(first.returnDir, "artifacts");
    rmSync(artifacts, { recursive: true, force: true });
    writeFileSync(artifacts, "clobbered\n");

    const record = getRecord(f.env, f.record.id);
    await expect(collectSessionReturn(f.env, record, adapter, f.t)).rejects.toThrow(/ENOTDIR/);
    expect(loadState(f.env).records[0]!.collect!.returnDir).toBe(first.returnDir);
  });

  test(
    "a shared stage root (the workspace return's txn dir) hosts the session return",
    async () => {
      const f = ompFixture();
      const adapter = new OmpAdapter();
      const root = join(f.env.beamDir, "returns", f.record.id, "shared-txn");
      mkdirSync(root, { recursive: true });

      const out = await collectSessionReturn(f.env, f.record, adapter, f.t, root);
      expect(out.returnDir).toBe(join(root, "session"));
      expect(loadState(f.env).records[0]!.collect!.txn).toBe("shared-txn");

      // A later down (its own txn root) with an unchanged remote: the duplicate
      // session dir is dropped, the caller's root is left alone.
      const root2 = join(f.env.beamDir, "returns", f.record.id, "shared-txn-2");
      mkdirSync(root2, { recursive: true });
      const again = await collectSessionReturn(
        f.env,
        getRecord(f.env, f.record.id),
        adapter,
        f.t,
        root2,
      );
      expect(again.alreadyCollected).toBe(true);
      expect(again.returnDir).toBe(join(root, "session"));
      expect(existsSync(root2)).toBe(true); // caller's root untouched
      expect(existsSync(join(root2, "session"))).toBe(false); // duplicate dropped
    },
  );
});

describe("large returns hash through the bounded streaming digest", () => {
  test(
    "multi-chunk transcript and artifact digests are chunk-size-stable and verify on retry",
    async () => {
      const f = ompFixture();
      // Grow the remote transcript and an artifact well past one hash chunk.
      const bigLine = `{"type":"message","pad":"${"x".repeat(1 << 20)}"}`;
      appendFileSync(
        join(f.remoteCwd, ".beam", "session.jsonl"),
        `${bigLine}\n${bigLine}\n${bigLine}\n`,
      );
      writeFileSync(
        join(f.remoteCwd, ".beam", "session", "big.bin"),
        Buffer.alloc((1 << 21) + 12345, 7),
      );

      const out = await collectSessionReturn(f.env, f.record, new OmpAdapter(), f.t);
      const receipt = loadState(f.env).records[0]!.collect!;
      // The receipted digests equal a forced multi-chunk streaming hash of the
      // returned bytes — the digest is chunk-size-invariant.
      expect(receipt.session.sha256).toBe(fileSha256(join(out.returnDir, "session.jsonl"), 4096));
      const bigEntry = receipt.artifacts!.find((e) => e.path === "big.bin")!;
      if (bigEntry.kind !== "file") throw new Error("expected a file entry for big.bin");
      expect(bigEntry.sha256).toBe(fileSha256(join(out.returnDir, "artifacts", "big.bin"), 4096));

      // returnIntact streams the same digests: the unchanged-remote retry
      // verifies the durable multi-megabyte return instead of duplicating it.
      const again = await collectSessionReturn(
        f.env,
        getRecord(f.env, f.record.id),
        new OmpAdapter(),
        f.t,
      );
      expect(again.alreadyCollected).toBe(true);
    },
  );
});

describe("returned modes are identity; local return storage is private", () => {
  test("executable bit is preserved in the return and recorded in the receipt", async () => {
    const f = ompFixture();
    chmodSync(join(f.remoteCwd, ".beam", "session", "new.txt"), 0o755);

    const out = await collectSessionReturn(f.env, f.record, new OmpAdapter(), f.t);
    expect(lstatSync(join(out.returnDir, "artifacts", "new.txt")).mode & 0o777).toBe(0o755);
    const receipt = loadState(f.env).records[0]!.collect!;
    const entry = receipt.artifacts!.find((e) => e.path === "new.txt")!;
    if (entry.kind !== "file") throw new Error("expected a file entry");
    expect(entry.mode).toBe(0o755);
  });

  test("a chmod-only remote change between the two fetches refuses collection", async () => {
    const f = ompFixture();
    class ChmodFlapAdapter extends OmpAdapter {
      private fetches = 0;
      override async stageReturn(
        t: Transport,
        session: LocalSession,
        localCwd: string,
        remoteCwd: string,
        stageDir: string,
      ): Promise<StagedReturn> {
        this.fetches++;
        if (this.fetches === 2) {
          chmodSync(join(f.remoteCwd, ".beam", "session", "new.txt"), 0o755); // content untouched
        }
        return super.stageReturn(t, session, localCwd, remoteCwd, stageDir);
      }
    }

    await expect(
      collectSessionReturn(f.env, f.record, new ChmodFlapAdapter(), f.t),
    ).rejects.toThrow(/changed between two consecutive fetches/);
    expect(loadState(f.env).records[0]!.collect).toBeUndefined();
  });

  test(
    "a chmod'd durable return is damaged: the retry recollects instead of trusting it",
    async () => {
      const f = ompFixture();
      const adapter = new OmpAdapter();
      const first = await collectSessionReturn(f.env, f.record, adapter, f.t);
      chmodSync(join(first.returnDir, "session.jsonl"), 0o644); // mode drifted

      const again = await collectSessionReturn(f.env, getRecord(f.env, f.record.id), adapter, f.t);
      expect(again.alreadyCollected).toBe(false); // never verified against a damaged return
      expect(again.returnDir).not.toBe(first.returnDir);
    },
  );

  test("the return chain is private: 0700 directories, 0600 transcript", async () => {
    const f = ompFixture();
    const out = await collectSessionReturn(f.env, f.record, new OmpAdapter(), f.t);
    expect(lstatSync(join(out.returnDir, "session.jsonl")).mode & 0o777).toBe(0o600);
    for (
      let p = out.returnDir;
      p.length >= f.env.beamDir.length;
      p = p.slice(0, p.lastIndexOf("/"))
    ) {
      expect(lstatSync(p).mode & 0o077).toBe(0); // no group/other bits anywhere
    }
  });

  test("a symlinked component in the return chain refuses before anything is staged", async () => {
    const f = ompFixture();
    // Plant a symlink where the record's returns dir would live.
    const outside = join(f.env.beamDir, "outside");
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(f.env.beamDir, "returns"), { recursive: true });
    symlinkSync(outside, join(f.env.beamDir, "returns", f.record.id));

    await expect(collectSessionReturn(f.env, f.record, new OmpAdapter(), f.t)).rejects.toThrow(
      /symlink/,
    );
    expect(readdirSync(outside)).toEqual([]); // nothing written through the link
    expect(loadState(f.env).records[0]!.collect).toBeUndefined();
  });
});
