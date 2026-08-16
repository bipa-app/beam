import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TargetSpec } from "../src/config.ts";
import type { BeamEnv } from "../src/env.ts";
import {
  acquireOperationLock,
  addRecord,
  findRecordForKill,
  findRecoverableHandoff,
  findRecoverableUp,
  getRecord,
  getRecordForUp,
  isRemoteCwdResolved,
  latestUpForTarget,
  loadState,
  planSessionIdentity,
  recordSpec,
  reserveTarget,
  updateRecord,
  type BeamRecord,
  type BeamStatus,
} from "../src/state.ts";
import { remoteWorkspaceName } from "../src/workspace.ts";

function tempEnv(): BeamEnv {
  const home = mkdtempSync(join(tmpdir(), "beam-state-machine-"));
  return { home, beamDir: join(home, ".beam") };
}

const SPEC_A: TargetSpec = { type: "local", root: "/tmp/root-a", tmuxSocket: "sock-a" };

function makeFor(target: string, localCwd: string, spec: TargetSpec = SPEC_A) {
  return (id: string): BeamRecord => {
    const now = new Date().toISOString();
    return {
      id,
      target,
      localCwd,
      // Production semantics: the remote path is a pure function of
      // (target root, localCwd) — records for the same pair SHARE it.
      remoteCwd: `${spec.root}/${remoteWorkspaceName(localCwd)}`,
      tmux: `beam-${id}`,
      status: "provisioning",
      createdAt: now,
      updatedAt: now,
      targetSpec: spec,
    };
  };
}

const AGENT_SPEC: TargetSpec = {
  type: "agent-sandbox",
  context: "ctx",
  namespace: "ns",
  template: "tpl",
  kubeconfig: "/kube/beam-user.kubeconfig",
};

/** A record shaped like `beam up` persists for an agent-sandbox target. */
function makeAgentFor(target: string, localCwd: string) {
  return (id: string): BeamRecord => ({
    ...makeFor(target, localCwd, AGENT_SPEC)(id),
    sandbox: { claim: `beam-${id}`, context: "ctx", namespace: "ns", container: "sandbox" },
    exclusiveTarget: true,
  });
}

describe("target reservation", () => {
  test("a new reservation is persisted as `provisioning` with the full spec snapshot before it returns", () => {
    const env = tempEnv();
    const { record, reused } = reserveTarget(env, {
      target: "k8s",
      localCwd: "/w1",
      exclusive: true,
      make: makeFor("k8s", "/w1"),
    });
    expect(reused).toBe(false);

    const persisted = loadState(env).records;
    expect(persisted.length).toBe(1);
    expect(persisted[0]!.id).toBe(record.id);
    expect(persisted[0]!.status).toBe("provisioning");
    expect(persisted[0]!.targetSpec).toEqual(SPEC_A);
    // atomic replacement leaves no temp litter behind
    expect(readdirSync(env.beamDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("the same workspace resumes its own provisioning or up record instead of creating a second one", () => {
    const env = tempEnv();
    const opts = { target: "k8s", localCwd: "/w1", exclusive: true, make: makeFor("k8s", "/w1") };
    const first = reserveTarget(env, opts);

    const again = reserveTarget(env, opts);
    expect(again.reused).toBe(true);
    expect(again.record.id).toBe(first.record.id);

    updateRecord(env, first.record.id, { status: "up" });
    const third = reserveTarget(env, opts);
    expect(third.reused).toBe(true);
    expect(third.record.id).toBe(first.record.id);
    expect(loadState(env).records.length).toBe(1);
  });

  test("another workspace is refused with the blocking id and creates no record", () => {
    const env = tempEnv();
    const { record } = reserveTarget(env, {
      target: "k8s",
      localCwd: "/w1",
      exclusive: true,
      make: makeFor("k8s", "/w1"),
    });

    for (const status of ["provisioning", "starting", "up", "purging", "teardown", "killing"] as BeamStatus[]) {
      updateRecord(env, record.id, { status });
      expect(() =>
        reserveTarget(env, { target: "k8s", localCwd: "/w2", exclusive: true, make: makeFor("k8s", "/w2") }),
      ).toThrow(new RegExp(`already held by handoff ${record.id}`));
    }
    expect(loadState(env).records.length).toBe(1);
  });

  test("a released target (down/killed) accepts a new reservation", () => {
    const env = tempEnv();
    const { record } = reserveTarget(env, {
      target: "k8s",
      localCwd: "/w1",
      exclusive: true,
      make: makeFor("k8s", "/w1"),
    });
    updateRecord(env, record.id, { status: "down" });

    const next = reserveTarget(env, {
      target: "k8s",
      localCwd: "/w2",
      exclusive: true,
      make: makeFor("k8s", "/w2"),
    });
    expect(next.reused).toBe(false);
    expect(loadState(env).records.length).toBe(2);
  });

  test("a workspace mid-teardown, mid-purge, or mid-kill is told to finish the right command instead of resuming", () => {
    const env = tempEnv();
    const { record } = reserveTarget(env, {
      target: "k8s",
      localCwd: "/w1",
      exclusive: true,
      make: makeFor("k8s", "/w1"),
    });
    for (const status of ["teardown", "purging"] as BeamStatus[]) {
      updateRecord(env, record.id, { status });
      expect(() =>
        reserveTarget(env, { target: "k8s", localCwd: "/w1", exclusive: true, make: makeFor("k8s", "/w1") }),
      ).toThrow(new RegExp(`beam down ${record.id}`));
    }
    updateRecord(env, record.id, { status: "killing" });
    expect(() =>
      reserveTarget(env, { target: "k8s", localCwd: "/w1", exclusive: true, make: makeFor("k8s", "/w1") }),
    ).toThrow(new RegExp(`beam kill ${record.id} --purge`));
  });

  test("a non-exclusive target reuses the same ACTIVE record for the same workspace — one owner per shared remote path", () => {
    const env = tempEnv();
    const opts = { target: "box", localCwd: "/w1", exclusive: false, make: makeFor("box", "/w1") };
    const a = reserveTarget(env, opts);
    // The remote path is derived from (root, localCwd): a second record for
    // the same pair would mirror into the SAME directory under a DIFFERENT
    // operation lock — reuse is mandatory in every resumable phase.
    for (const status of ["provisioning", "starting", "up"] as BeamStatus[]) {
      updateRecord(env, a.record.id, { status });
      const again = reserveTarget(env, opts);
      expect(again.reused).toBe(true);
      expect(again.record.id).toBe(a.record.id);
    }
    expect(loadState(env).records.length).toBe(1);
  });

  test("a non-exclusive target still hosts distinct workspaces concurrently", () => {
    const env = tempEnv();
    const a = reserveTarget(env, { target: "box", localCwd: "/w1", exclusive: false, make: makeFor("box", "/w1") });
    updateRecord(env, a.record.id, { status: "up" });
    const b = reserveTarget(env, { target: "box", localCwd: "/w2", exclusive: false, make: makeFor("box", "/w2") });
    expect(b.reused).toBe(false);
    expect(b.record.id).not.toBe(a.record.id);
    expect(b.record.remoteCwd).not.toBe(a.record.remoteCwd); // distinct cwd, distinct remote dir
    expect(loadState(env).records.length).toBe(2);
  });

  test("a released same-workspace record (down/killed) gets a fresh one on the next reservation", () => {
    const env = tempEnv();
    const opts = { target: "box", localCwd: "/w1", exclusive: false, make: makeFor("box", "/w1") };
    const a = reserveTarget(env, opts);
    updateRecord(env, a.record.id, { status: "killed" });
    const b = reserveTarget(env, opts);
    expect(b.reused).toBe(false);
    expect(b.record.id).not.toBe(a.record.id);
  });
});

describe("state lock", () => {
  test("a lock left by a dead process is reclaimed", () => {
    const env = tempEnv();
    mkdirSync(env.beamDir, { recursive: true });
    const deadPid = spawnSync("true").pid; // exited: its pid is dead by the time we use it
    writeFileSync(join(env.beamDir, "state.lock"), String(deadPid), { flag: "wx" });
    const { record } = reserveTarget(env, {
      target: "k8s",
      localCwd: "/w1",
      exclusive: true,
      make: makeFor("k8s", "/w1"),
    });
    expect(loadState(env).records[0]!.id).toBe(record.id);
    expect(existsSync(join(env.beamDir, "state.lock"))).toBe(false);
  });

  test("a lock owned by a live process is never deleted; the reservation fails actionably", () => {
    const env = tempEnv();
    mkdirSync(env.beamDir, { recursive: true });
    const lock = join(env.beamDir, "state.lock");
    writeFileSync(lock, String(process.pid), { flag: "wx" }); // this test process is alive
    // The bounded wait is the observable contract here: the reservation must
    // give up on a live holder instead of stealing its lock.
    expect(() =>
      reserveTarget(env, {
        target: "k8s",
        localCwd: "/w1",
        exclusive: true,
        make: makeFor("k8s", "/w1"),
        lockWaitMs: 60,
      }),
    ).toThrow(/holds the state lock/);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
    expect(loadState(env).records.length).toBe(0);
  });
});

describe("concurrent beam processes", () => {
  const CHILD = (statePath: string) => `
import { existsSync } from "node:fs";
import { reserveTarget } from ${JSON.stringify(statePath)};

const [beamDir, target, cwd, exclusive, goFile] = process.argv.slice(2);
// Spin barrier: the parent creates goFile only after every child is running,
// so the reservations genuinely race (bounded: the parent always creates it).
while (!existsSync(goFile)) {}
try {
  const { record } = reserveTarget(
    { home: "/", beamDir },
    {
      target,
      localCwd: cwd,
      exclusive: exclusive === "1",
      make: (id) => {
        const now = new Date().toISOString();
        return {
          id,
          target,
          localCwd: cwd,
          remoteCwd: "/beam/ws-" + cwd.replaceAll("/", "-"), // production: derived from cwd, not id
          tmux: "beam-" + id,
          status: "provisioning",
          createdAt: now,
          updatedAt: now,
        };
      },
    },
  );
  console.log(record.id);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(3);
}
`;

  async function race(env: BeamEnv, exclusive: boolean, n: number, cwdOf = (i: number) => `/w${i}`): Promise<number[]> {
    const statePath = join(import.meta.dirname, "..", "src", "state.ts");
    const script = join(env.home, "reserve-child.ts");
    writeFileSync(script, CHILD(statePath));
    const goFile = join(env.home, "go");
    const children = Array.from({ length: n }, (_, i) =>
      Bun.spawn(
        [process.execPath, script, env.beamDir, "k8s", cwdOf(i), exclusive ? "1" : "0", goFile],
        { stdout: "ignore", stderr: "ignore" },
      ),
    );
    writeFileSync(goFile, ""); // release the barrier
    return Promise.all(children.map((c) => c.exited));
  }

  test("an exclusive target hands out exactly one reservation across racing processes", async () => {
    const env = tempEnv();
    const codes = await race(env, true, 6);
    expect(codes.filter((c) => c === 0).length).toBe(1);
    expect(codes.filter((c) => c === 3).length).toBe(5);
    const state = loadState(env); // parses: no torn writes
    expect(state.records.length).toBe(1);
    expect(state.records[0]!.status).toBe("provisioning");
  });

  test("racing non-exclusive reservations lose no records", async () => {
    const env = tempEnv();
    const codes = await race(env, false, 6);
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    const ids = loadState(env).records.map((r) => r.id);
    expect(new Set(ids).size).toBe(6); // every write survived the race
  });

  test("racing same-workspace non-exclusive reservations converge on ONE record", async () => {
    const env = tempEnv();
    // All six contenders name the same (target, localCwd): the winner
    // creates the record, every loser must REUSE it — exactly one record,
    // no failures, never a second owner for the shared remote path.
    const codes = await race(env, false, 6, () => "/w-shared");
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    expect(loadState(env).records.length).toBe(1);
  });
});

describe("record spec snapshots and selection", () => {
  test("recordSpec prefers the snapshot; config edits cannot rebind the record", () => {
    const env = tempEnv();
    const { record } = reserveTarget(env, {
      target: "k8s",
      localCwd: "/w1",
      exclusive: true,
      make: makeFor("k8s", "/w1"),
    });
    const config = { targets: { k8s: { type: "local" as const, root: "/tmp/root-b", tmuxSocket: "sock-b" } } };
    expect(recordSpec(record, config)).toEqual(SPEC_A);
  });

  test("recordSpec falls back to the current config for old records without a snapshot", () => {
    const env = tempEnv();
    const { record } = reserveTarget(env, {
      target: "k8s",
      localCwd: "/w1",
      exclusive: true,
      make: (id) => {
        const bare = makeFor("k8s", "/w1")(id);
        delete bare.targetSpec; // a record written by an older beam
        return bare;
      },
    });
    const current: TargetSpec = { type: "local", root: "/tmp/root-b" };
    expect(recordSpec(record, { targets: { k8s: current } })).toEqual(current);
    expect(() => recordSpec(record, { targets: {} })).toThrow(/unknown target/);
  });

  test("latestUpForTarget ignores every in-flight phase", () => {
    const env = tempEnv();
    const { record } = reserveTarget(env, {
      target: "k8s",
      localCwd: "/w1",
      exclusive: true,
      make: makeFor("k8s", "/w1"),
    });
    expect(latestUpForTarget(env, "k8s")).toBeUndefined(); // provisioning
    for (const status of ["starting", "purging", "teardown", "killing"] as BeamStatus[]) {
      updateRecord(env, record.id, { status });
      expect(latestUpForTarget(env, "k8s")).toBeUndefined();
    }
    updateRecord(env, record.id, { status: "up" });
    expect(latestUpForTarget(env, "k8s")?.id).toBe(record.id);
  });

  test("getRecord returns the exact id and throws when it is gone — the post-lock re-read contract", () => {
    const env = tempEnv();
    const { record } = reserveTarget(env, {
      target: "k8s",
      localCwd: "/w1",
      exclusive: true,
      make: makeFor("k8s", "/w1"),
    });
    updateRecord(env, record.id, { status: "starting" });
    // The re-read observes the LATEST persisted state, not the caller's
    // pre-lock snapshot.
    expect(getRecord(env, record.id).status).toBe("starting");
    expect(() => getRecord(env, "nope42")).toThrow(/no record nope42/);
  });

  test("no-ref kill selection refuses ambiguity across active and in-flight records", () => {
    const env = tempEnv();
    const a = reserveTarget(env, { target: "k8s", localCwd: "/w1", exclusive: false, make: makeFor("k8s", "/w1") });
    updateRecord(env, a.record.id, { status: "up" });
    const b = reserveTarget(env, { target: "k8s", localCwd: "/w2", exclusive: false, make: makeFor("k8s", "/w2") });
    // One up + one in-flight provisioning: a recency default would purge a
    // different live handoff than the one that just failed — refuse, and
    // teach the exact destructive form.
    expect(() => findRecordForKill(env)).toThrow(/multiple live handoffs/);
    expect(() => findRecordForKill(env)).toThrow(/beam kill <id> --purge/);
    expect(() => findRecordForKill(env)).toThrow(new RegExp(a.record.id));
    expect(() => findRecordForKill(env)).toThrow(new RegExp(b.record.id));
    // An explicit ref is always honored.
    expect(findRecordForKill(env, b.record.id).id).toBe(b.record.id);
  });

  test("no-ref kill selection picks the single active record even when a terminal one is newer", () => {
    const env = tempEnv();
    const a = reserveTarget(env, { target: "k8s", localCwd: "/w1", exclusive: false, make: makeFor("k8s", "/w1") });
    updateRecord(env, a.record.id, { status: "starting" }); // in-flight: still owns remote resources
    const b = reserveTarget(env, { target: "k8s", localCwd: "/w2", exclusive: false, make: makeFor("k8s", "/w2") });
    updateRecord(env, b.record.id, { status: "down", createdAt: "2099-01-01T00:00:00.000Z" });
    expect(findRecordForKill(env).id).toBe(a.record.id);
  });

  test("no-ref kill selection falls back to recency when nothing is active", () => {
    const env = tempEnv();
    const a = reserveTarget(env, { target: "k8s", localCwd: "/w1", exclusive: false, make: makeFor("k8s", "/w1") });
    updateRecord(env, a.record.id, { status: "killed" });
    expect(findRecordForKill(env).id).toBe(a.record.id);
  });
});

describe("per-record operation lock", () => {
  test("exclusive per record, released for reacquisition, independent across records", () => {
    const env = tempEnv();
    const release = acquireOperationLock(env, "r1");
    expect(() => acquireOperationLock(env, "r1")).toThrow(/already operating on handoff r1/);
    acquireOperationLock(env, "r2")(); // a different record is not blocked
    release();
    acquireOperationLock(env, "r1")(); // reacquirable once released
  });

  test("a lock left by a dead process is reclaimed", () => {
    const env = tempEnv();
    mkdirSync(env.beamDir, { recursive: true });
    const deadPid = spawnSync("true").pid; // exited: its pid is dead by the time we use it
    writeFileSync(join(env.beamDir, "op-r1.lock"), String(deadPid), { flag: "wx" });
    const release = acquireOperationLock(env, "r1");
    release();
    expect(existsSync(join(env.beamDir, "op-r1.lock"))).toBe(false);
  });

  test("non-positive or garbage owners are reclaimed, never probed (kill(0)/kill(-n) hit process GROUPS)", () => {
    const env = tempEnv();
    mkdirSync(env.beamDir, { recursive: true });
    for (const junk of ["0", "-1", "not-a-pid", ""]) {
      writeFileSync(join(env.beamDir, "op-r1.lock"), junk, { flag: "wx" });
      acquireOperationLock(env, "r1")(); // reclaimed instead of deadlocking forever
    }
  });

  test("a live owner is refused promptly and actionably; its lock is never deleted", () => {
    const env = tempEnv();
    mkdirSync(env.beamDir, { recursive: true });
    const lock = join(env.beamDir, "op-r1.lock");
    writeFileSync(lock, String(process.pid), { flag: "wx" }); // this test process is alive
    expect(() => acquireOperationLock(env, "r1")).toThrow(
      new RegExp(`pid ${process.pid}.*handoff r1`),
    );
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
  });
});

describe("snapshot-derived target exclusivity (config drift)", () => {
  test("an active agent-sandbox record blocks a second workspace even after the target drifts to ssh/local", () => {
    const env = tempEnv();
    const { record } = reserveTarget(env, {
      target: "k8s",
      localCwd: "/w1",
      exclusive: true,
      make: makeAgentFor("k8s", "/w1"),
    });
    // Config drift: the current target is now ssh/local (non-exclusive),
    // but the live record still owns a claim — no second record, ever.
    expect(() =>
      reserveTarget(env, { target: "k8s", localCwd: "/w2", exclusive: false, make: makeFor("k8s", "/w2") }),
    ).toThrow(new RegExp(`already held by handoff ${record.id}`));
    expect(loadState(env).records.length).toBe(1);
  });

  test("the same workspace resumes its exclusive record under a drifted config instead of duplicating it", () => {
    const env = tempEnv();
    const first = reserveTarget(env, {
      target: "k8s",
      localCwd: "/w1",
      exclusive: true,
      make: makeAgentFor("k8s", "/w1"),
    });
    const again = reserveTarget(env, {
      target: "k8s",
      localCwd: "/w1",
      exclusive: false, // drifted config would allow a fresh record
      make: makeFor("k8s", "/w1"),
    });
    expect(again.reused).toBe(true);
    expect(again.record.id).toBe(first.record.id);
    expect(loadState(env).records.length).toBe(1);
  });

  test("older records without the persisted policy still hold via snapshot type, then sandbox coordinates", () => {
    const env = tempEnv();
    // Snapshot says agent-sandbox but the policy field predates this beam.
    const { record } = reserveTarget(env, {
      target: "k8s",
      localCwd: "/w1",
      exclusive: true,
      make: (id) => {
        const r = makeAgentFor("k8s", "/w1")(id);
        delete r.exclusiveTarget;
        return r;
      },
    });
    expect(() =>
      reserveTarget(env, { target: "k8s", localCwd: "/w2", exclusive: false, make: makeFor("k8s", "/w2") }),
    ).toThrow(new RegExp(`already held by handoff ${record.id}`));

    // No snapshot either: provisioned sandbox coordinates alone hold it.
    updateRecord(env, record.id, { status: "down" });
    const bare = reserveTarget(env, {
      target: "k8s",
      localCwd: "/w3",
      exclusive: true,
      make: (id) => {
        const r = makeAgentFor("k8s", "/w3")(id);
        delete r.exclusiveTarget;
        delete r.targetSpec;
        return r;
      },
    });
    expect(() =>
      reserveTarget(env, { target: "k8s", localCwd: "/w4", exclusive: false, make: makeFor("k8s", "/w4") }),
    ).toThrow(new RegExp(`already held by handoff ${bare.record.id}`));
  });

  test("a released exclusive record frees the target for non-exclusive reservations", () => {
    const env = tempEnv();
    const { record } = reserveTarget(env, {
      target: "k8s",
      localCwd: "/w1",
      exclusive: true,
      make: makeAgentFor("k8s", "/w1"),
    });
    updateRecord(env, record.id, { status: "down" });
    const next = reserveTarget(env, {
      target: "k8s",
      localCwd: "/w2",
      exclusive: false,
      make: makeFor("k8s", "/w2"),
    });
    expect(next.reused).toBe(false);
    expect(loadState(env).records.length).toBe(2);
  });
});

describe("remote cwd resolution tracking", () => {
  test("the persisted flag wins; legacy records infer from path shape", () => {
    const base = makeFor("k8s", "/w1")("x1"); // remoteCwd is absolute, no flag persisted
    expect(isRemoteCwdResolved({ ...base, remoteCwdResolved: true })).toBe(true);
    expect(isRemoteCwdResolved({ ...base, remoteCwdResolved: false })).toBe(false);
    // Legacy inference: an absolute path behaves like the old purge did; a
    // `~` candidate was provably never resolved — nothing shipped under it.
    expect(isRemoteCwdResolved(base)).toBe(true);
    expect(isRemoteCwdResolved({ ...base, remoteCwd: "~/beam/ws-x1" })).toBe(false);
  });
});

describe("post-lock re-bind for `beam up` (stale reservations never resurrect)", () => {
  test("a record that went terminal between reservation and lock is refused and stays terminal", () => {
    const env = tempEnv();
    const { record } = reserveTarget(env, { target: "t", localCwd: "/w", exclusive: false, make: makeFor("t", "/w") });

    // A concurrent `beam kill --purge` finishes while this up is between
    // its reservation and its operation lock.
    updateRecord(env, record.id, { status: "killed" });
    const release = acquireOperationLock(env, record.id);
    try {
      expect(() => getRecordForUp(env, record.id)).toThrow(/became killed/);
    } finally {
      release();
    }
    expect(getRecord(env, record.id).status).toBe("killed");

    updateRecord(env, record.id, { status: "down" });
    expect(() => getRecordForUp(env, record.id)).toThrow(/became down/);
    expect(getRecord(env, record.id).status).toBe("down");
  });

  test("teardown phases route to the command that owns their recovery instead of re-shipping", () => {
    const env = tempEnv();
    const { record } = reserveTarget(env, { target: "t", localCwd: "/w", exclusive: false, make: makeFor("t", "/w") });
    const cases: readonly [BeamStatus, RegExp][] = [
      ["purging", /beam down/],
      ["teardown", /beam down/],
      ["killing", /mid-kill/],
    ];
    for (const [status, pattern] of cases) {
      updateRecord(env, record.id, { status });
      expect(() => getRecordForUp(env, record.id)).toThrow(pattern);
      expect(getRecord(env, record.id).status).toBe(status);
    }
  });

  test("resumable phases return the fresh post-lock copy, not the reservation's", () => {
    const env = tempEnv();
    const { record } = reserveTarget(env, { target: "t", localCwd: "/w", exclusive: false, make: makeFor("t", "/w") });
    // The previous lock owner resolved the cwd and advanced the phase.
    updateRecord(env, record.id, { status: "starting", remoteCwd: "/resolved/ws", remoteCwdResolved: true });
    const fresh = getRecordForUp(env, record.id);
    expect(fresh.status).toBe("starting");
    expect(fresh.remoteCwd).toBe("/resolved/ws");
    expect(record.remoteCwd).not.toBe("/resolved/ws"); // the pre-lock copy really was stale
  });
});

describe("session identity across re-ships (planSessionIdentity)", () => {
  const base = makeFor("t", "/w")("aaaaaa");
  const shipped: BeamRecord = {
    ...base,
    tool: "omp",
    sessionId: "sess-1",
    sessionFile: "/store/sess-1.jsonl",
    remoteCwdResolved: true,
    status: "up",
  };

  test("a record without a stored identity adopts whatever this ship requests", () => {
    expect(planSessionIdentity(base, { tool: "omp", sessionId: "s" }, false).kind).toBe("adopt");
    expect(planSessionIdentity(base, { tool: "omp", sessionId: "s" }, true).kind).toBe("adopt");
    expect(planSessionIdentity(base, undefined, true).kind).toBe("adopt");
  });

  test("re-requesting the stored session adopts it (idempotent retry)", () => {
    expect(planSessionIdentity(shipped, { tool: "omp", sessionId: "sess-1" }, true).kind).toBe("adopt");
    expect(planSessionIdentity(shipped, { tool: "omp", sessionId: "sess-1" }, false).kind).toBe("adopt");
  });

  test("omitted args retain the stored identity even when auto-detection drifted to a newer session", () => {
    expect(planSessionIdentity(shipped, { tool: "omp", sessionId: "sess-2-newer" }, false)).toEqual({
      kind: "retain",
      tool: "omp",
      sessionId: "sess-1",
    });
  });

  test("an explicit switch over a shipped record is refused with teardown guidance", () => {
    const plan = planSessionIdentity(shipped, { tool: "codex", sessionId: "other" }, true);
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") {
      expect(plan.reason).toMatch(/already shipped session omp sess-1/);
      expect(plan.reason).toMatch(/beam down aaaaaa/);
    }
  });

  test("an explicit clear (--no-session) over a shipped record is refused", () => {
    const plan = planSessionIdentity(shipped, undefined, true);
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.reason).toMatch(/--no-session would orphan/);
  });

  test("a record that provably never shipped may carry new explicit intent — but omitted args still retain", () => {
    const unshipped: BeamRecord = {
      ...shipped,
      status: "provisioning",
      remoteCwd: "~/beam/ws",
      remoteCwdResolved: false,
    };
    expect(planSessionIdentity(unshipped, { tool: "codex", sessionId: "other" }, true).kind).toBe("adopt");
    expect(planSessionIdentity(unshipped, undefined, true).kind).toBe("adopt");
    expect(planSessionIdentity(unshipped, { tool: "codex", sessionId: "other" }, false).kind).toBe("retain");
  });
});

describe("target recovery through persisted snapshots (config removed/renamed)", () => {
  test("findRecoverableHandoff binds exactly: recorded name and workspace, nothing else", () => {
    const env = tempEnv();
    const { record } = reserveTarget(env, {
      target: "gone",
      localCwd: "/w",
      exclusive: false,
      make: makeFor("gone", "/w"),
    });
    expect(findRecoverableHandoff(env, "gone", "/w")?.id).toBe(record.id);
    expect(findRecoverableHandoff(env, undefined, "/w")?.id).toBe(record.id);
    expect(findRecoverableHandoff(env, "other", "/w")).toBeUndefined();
    expect(findRecoverableHandoff(env, "gone", "/elsewhere")).toBeUndefined();
  });

  test("terminal and snapshot-less records are never recovery candidates", () => {
    const env = tempEnv();
    const { record } = reserveTarget(env, {
      target: "gone",
      localCwd: "/w",
      exclusive: false,
      make: makeFor("gone", "/w"),
    });
    updateRecord(env, record.id, { status: "down" });
    expect(findRecoverableHandoff(env, "gone", "/w")).toBeUndefined();

    // A legacy record without a spec snapshot has nothing to bind through.
    const now = new Date().toISOString();
    addRecord(env, {
      id: "legacy",
      target: "old",
      localCwd: "/w",
      remoteCwd: "/r/ws",
      tmux: "beam-legacy",
      status: "up",
      createdAt: now,
      updatedAt: now,
    });
    expect(findRecoverableHandoff(env, "old", "/w")).toBeUndefined();
  });

  test("ambiguity is refused, never guessed", () => {
    const env = tempEnv();
    reserveTarget(env, { target: "a", localCwd: "/w", exclusive: false, make: makeFor("a", "/w") });
    reserveTarget(env, { target: "b", localCwd: "/w", exclusive: false, make: makeFor("b", "/w") });
    expect(() => findRecoverableHandoff(env, undefined, "/w")).toThrow(/--target/);
    expect(findRecoverableHandoff(env, "a", "/w")).toBeDefined();
  });

  test("findRecoverableUp recovers login only through a completed `up` handoff", () => {
    const env = tempEnv();
    const { record } = reserveTarget(env, {
      target: "gone",
      localCwd: "/w",
      exclusive: false,
      make: makeFor("gone", "/w"),
    });
    // In-flight phases have no dependable sandbox to log into.
    expect(findRecoverableUp(env, "gone")).toBeUndefined();
    updateRecord(env, record.id, { status: "up" });
    expect(findRecoverableUp(env, "gone")?.id).toBe(record.id);
    expect(findRecoverableUp(env, undefined)?.id).toBe(record.id);
    expect(findRecoverableUp(env, "other")).toBeUndefined();
  });

  test("findRecoverableUp refuses to guess between targets", () => {
    const env = tempEnv();
    const a = reserveTarget(env, { target: "a", localCwd: "/w1", exclusive: false, make: makeFor("a", "/w1") });
    const b = reserveTarget(env, { target: "b", localCwd: "/w2", exclusive: false, make: makeFor("b", "/w2") });
    updateRecord(env, a.record.id, { status: "up" });
    updateRecord(env, b.record.id, { status: "up" });
    expect(() => findRecoverableUp(env, undefined)).toThrow(/beam login <target>/);
    expect(findRecoverableUp(env, "b")?.id).toBe(b.record.id);
  });
});
