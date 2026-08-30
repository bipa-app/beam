/**
 * Goal: prove the agent-sandbox seam end to end — provider lifecycle and
 * identity pinning, kubectl transport sync/exec boundaries, and the command
 * state machine — including every hostile refusal path (impostor ownership,
 * replaced UIDs, foreign claims, overpowered credentials, swapped workspaces).
 * Method: a canned kubectl binary (see FAKE_KUBECTL_IMPL below) simulates the
 * cluster against fixture state on disk, `exec` runs argv locally with HOME
 * pointed at a fake pod home, and BEAM_HOME/BEAM_DIR isolate all beam state —
 * so real tar/bash/herdr semantics are exercised hermetically, no cluster or
 * kubeconfig required.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdDown } from "../src/commands/down.ts";
import { cmdAttach, cmdKill, cmdLogin, cmdStatus } from "../src/commands/misc.ts";
import { cmdUp } from "../src/commands/up.ts";
import type { AgentSandboxTargetSpec } from "../src/config.ts";
import { resolveEnv } from "../src/env.ts";
import { AgentSandboxProvider } from "../src/provider/agent-sandbox.ts";
import type { AgentSandboxState, SandboxState } from "../src/provider/types.ts";
import { HerdrRuntime } from "../src/runtime/herdr.ts";
import { acquireOperationLock, loadState, updateRecord, type BeamRecord } from "../src/state.ts";
import { KubectlTransport, markerWalkBlocks, syncMarkerFor } from "../src/transport/kubectl.ts";
import {
  BEAM_GITPTR_EXCLUDE,
  BEAM_RESERVED_EXCLUDE,
  GIT_METADATA_EXCLUDE,
  ownedDestinationBlocks,
  remoteWorkspaceName,
  workspaceReturnFingerprint,
} from "../src/workspace.ts";
import { run, runChecked, shq } from "../src/util/shell.ts";

const PROCESS_TEST_TIMEOUT_MS = 30_000;
setDefaultTimeout(PROCESS_TEST_TIMEOUT_MS);

function agentSandboxState(state: SandboxState | undefined): AgentSandboxState {
  if (state === undefined || state.kind !== undefined) {
    throw new Error("test expected an Agent Sandbox identity");
  }
  return state;
}

/**
 * Canned kubectl: logs every argv verbatim, simulates claims as marker files
 * under STATE/claims (create fails on AlreadyExists, like the real API with
 * no patch verb), answers `auth can-i` from STATE/permissions.json, and runs
 * `exec` argv locally with HOME pointed at STATE/podhome — so tar streams,
 * `bash -lc`, and `~/` semantics are exercised for real without a cluster,
 * a kubeconfig, or the real ~/.beam.
 */
const FAKE_KUBECTL_IMPL = `
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const STATE = import.meta.dirname;
const args = process.argv.slice(2);
appendFileSync(join(STATE, "argv.log"), JSON.stringify(args) + "\\n");

const die = (msg) => {
  process.stderr.write(msg + "\\n");
  process.exit(1);
};

// exec: run the post-"--" argv locally against the fixture pod filesystem.
if (args.includes("exec") && args.includes("--")) {
  const cmd = args.slice(args.indexOf("--") + 1);
  const podHome = join(STATE, "podhome");
  mkdirSync(podHome, { recursive: true });
  const failFile = join(STATE, "exec-fail-pattern");
  if (existsSync(failFile) && cmd.join(" ").includes(readFileSync(failFile, "utf8").trim())) {
    die("canned exec failure");
  }
  // Lossy-stream chaos (the measured gVisor failure mode): a countdown
  // flag file "corrupt-stdout" / "corrupt-stdin" holding "<n> <pattern>"
  // makes the next n matching exec invocations silently drop the tail of
  // that stream — kubectl still exits 0, exactly like the real cluster.
  const chaosTake = (file) => {
    const p = join(STATE, file);
    if (!existsSync(p)) return false;
    const raw = readFileSync(p, "utf8").trim();
    const space = raw.indexOf(" ");
    const count = Number(raw.slice(0, space));
    const pattern = raw.slice(space + 1);
    if (!(count > 0) || !cmd.join(" ").includes(pattern)) return false;
    writeFileSync(p, String(count - 1) + " " + pattern);
    return true;
  };
  // Pin XDG so herdr's session REGISTRY (~/.config/herdr) lives inside the
  // fixture pod home; runtime SOCKETS live at the uid-scoped tmp dir under
  // unique beam-<id> names, so they never collide with the developer's
  // real herdr server (default session, distinct socket file).
  const podEnv = { ...process.env, HOME: podHome, XDG_CONFIG_HOME: join(podHome, ".config") };
  if (chaosTake("corrupt-stdin")) {
    const whole = readFileSync(0);
    const kept = whole.subarray(0, Math.max(0, whole.length - 4096));
    const res2 = spawnSync(cmd[0], cmd.slice(1), {
      stdio: ["pipe", "inherit", "inherit"],
      input: kept,
      env: podEnv,
    });
    process.exit(res2.status === null ? 1 : res2.status);
  }
  if (chaosTake("corrupt-stdout")) {
    const res2 = spawnSync(cmd[0], cmd.slice(1), {
      stdio: ["inherit", "pipe", "inherit"],
      env: podEnv,
      maxBuffer: 1024 * 1024 * 1024,
    });
    const out = res2.stdout || Buffer.alloc(0);
    process.stdout.write(out.subarray(0, Math.max(0, out.length - 4096)));
    process.exit(res2.status === null ? 1 : res2.status);
  }
  const res = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", env: podEnv });
  // exec-hook-pattern + exec-hook.sh: run a canned script AFTER a matching
  // command completes — simulates a pod-side agent racing between beam's
  // remote shells (e.g. swapping .beam for a symlink mid-ship).
  const hookPat = join(STATE, "exec-hook-pattern");
  if (existsSync(hookPat) && cmd.join(" ").includes(readFileSync(hookPat, "utf8").trim())) {
    spawnSync("bash", [join(STATE, "exec-hook.sh")], { stdio: "inherit", env: podEnv });
  }
  process.exit(res.status === null ? 1 : res.status);
}

// strip pinned global flags, remember the scope they set
const rest = [];
let ns = "";
let allNs = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--context" || a === "--kubeconfig") { i++; continue; }
  if (a === "--namespace" || a === "-n") { ns = args[i + 1] || ""; i++; continue; }
  if (a === "--all-namespaces" || a === "-A") { allNs = true; continue; }
  rest.push(a);
}
const claims = join(STATE, "claims");
mkdirSync(claims, { recursive: true });
const verb = rest[0];

if (verb === "create") {
  if (existsSync(join(STATE, "create-fail"))) die("Error from server: exceeded quota beam-single-handoff");
  const manifest = readFileSync(0, "utf8");
  const obj = JSON.parse(manifest);
  // race-claim: a concurrent creator wins between beam's get and its create —
  // the flag's manifest becomes the stored claim and create dies AlreadyExists.
  if (existsSync(join(STATE, "race-claim"))) {
    writeFileSync(join(claims, obj.metadata.name), readFileSync(join(STATE, "race-claim"), "utf8"));
    die('Error from server (AlreadyExists): sandboxclaims "' + obj.metadata.name + '" already exists');
  }
  if (existsSync(join(claims, obj.metadata.name))) {
    die('Error from server (AlreadyExists): sandboxclaims "' + obj.metadata.name + '" already exists');
  }
  // The API server assigns a fresh UID to every created object.
  obj.metadata.uid = "uid-" + Math.random().toString(36).slice(2, 10);
  writeFileSync(join(claims, obj.metadata.name), JSON.stringify(obj));
  if (rest.includes("-o") && rest[rest.indexOf("-o") + 1] === "json") {
    console.log(JSON.stringify(obj));
  } else {
    console.log("sandboxclaim.extensions.agents.x-k8s.io/" + obj.metadata.name + " created");
  }
  process.exit(0);
}

if (verb === "wait") {
  if (existsSync(join(STATE, "wait-fail"))) die("error: timed out waiting for the condition");
  if (existsSync(join(STATE, "wait-sleep"))) {
    spawnSync("sleep", [readFileSync(join(STATE, "wait-sleep"), "utf8").trim() || "1"]);
  }
  process.exit(0);
}

if (verb === "get") {
  // Kubeconfig exec-plugin failure: the tool dies before reaching the API
  // server, with a stderr that happens to contain "not found".
  if (existsSync(join(STATE, "get-auth-fail"))) {
    die("Unable to connect to the server: getting credentials: exec: executable credential-helper not found");
  }
  let resource = rest[1] || "";
  let name = rest[2] || "";
  const slash = resource.indexOf("/");
  if (slash > 0) { name = resource.slice(slash + 1); resource = resource.slice(0, slash); }
  const flagValue = (f) => existsSync(join(STATE, f)) ? readFileSync(join(STATE, f), "utf8").trim() : undefined;
  // kubectl's own NotFound suppression: exit 0, no output.
  const absent = () => {
    if (rest.indexOf("--ignore-not-found") >= 0) process.exit(0);
    die('Error from server (NotFound): "' + name + '" not found');
  };
  const present = existsSync(join(claims, name));
  if (resource.indexOf("sandboxclaims") === 0) {
    if (!present) absent();
    let stored = {};
    try { stored = JSON.parse(readFileSync(join(claims, name), "utf8")); } catch {}
    // swap-uid-on-get: the object is replaced immediately AFTER this read —
    // the caller sees the pre-swap object, later requests see the new UID
    // (the classic check-then-act race window).
    if (existsSync(join(STATE, "swap-uid-on-get")) && stored.metadata && stored.metadata.uid) {
      const next = JSON.parse(JSON.stringify(stored));
      next.metadata.uid = "swapped-" + stored.metadata.uid;
      writeFileSync(join(claims, name), JSON.stringify(next));
    }
    const status = existsSync(join(STATE, "claim-status-empty"))
      ? {}
      : { sandbox: { name: flagValue("sandbox-name") || name }, conditions: [{ type: "Ready", status: "True" }] };
    console.log(JSON.stringify({ ...stored, metadata: { ...(stored.metadata || {}), name: name }, status: status }));
    process.exit(0);
  }
  if (resource.indexOf("sandboxes") === 0) {
    if (!present && name !== flagValue("sandbox-name")) {
      absent();
    }
    const podAnn = flagValue("pod-name");
    // Real controllers stamp ownerReferences with the owning claim's UID.
    let claimUid;
    try { claimUid = JSON.parse(readFileSync(join(claims, name), "utf8")).metadata.uid; } catch {}
    let sbOwners = [];
    if (existsSync(join(STATE, "sandbox-owner-bad"))) {
      sbOwners = [{ kind: "SandboxClaim", name: "intruder", uid: "intruder-uid" }];
    } else if (existsSync(join(STATE, "sandbox-owner-uid-bad"))) {
      sbOwners = [{ kind: "SandboxClaim", name: name, uid: "not-the-claims-uid" }];
    } else if (claimUid) {
      sbOwners = [{ kind: "SandboxClaim", name: name, uid: claimUid }];
    }
    console.log(JSON.stringify({
      metadata: {
        name: name,
        uid: "sb-uid-" + name,
        annotations: podAnn ? { "agents.x-k8s.io/pod-name": podAnn } : {},
        ownerReferences: sbOwners,
      },
      status: {},
    }));
    process.exit(0);
  }
  if (resource === "pod" || resource === "pods") {
    const known = present || name === flagValue("pod-name") || name === flagValue("sandbox-name");
    if (!known || existsSync(join(STATE, "pod-missing"))) {
      absent();
    }
    // The pod's owner is the Sandbox object (fake uid "sb-uid-<sandbox>").
    const sbName = flagValue("sandbox-name") || name;
    let podOwners = [{ kind: "Sandbox", name: sbName, uid: "sb-uid-" + sbName }];
    if (existsSync(join(STATE, "pod-owner-bad"))) {
      podOwners = [{ kind: "Sandbox", name: "intruder", uid: "sb-uid-intruder" }];
    } else if (existsSync(join(STATE, "pod-owner-uid-bad"))) {
      podOwners = [{ kind: "Sandbox", name: sbName, uid: "intruder-uid" }];
    }
    console.log(JSON.stringify({
      metadata: { name: name, ownerReferences: podOwners },
      status: { phase: flagValue("pod-phase") || "Running" },
    }));
    process.exit(0);
  }
  if (resource.indexOf("sandboxtemplates") === 0) {
    if (existsSync(join(STATE, "template-forbidden"))) {
      die('Error from server (Forbidden): sandboxtemplates "' + name + '" is forbidden');
    }
    console.log("sandboxtemplate.extensions.agents.x-k8s.io/" + name);
    process.exit(0);
  }
  die("canned kubectl: unknown resource " + resource);
}

if (verb === "delete") {
  if (existsSync(join(STATE, "delete-fail"))) die("error: canned delete failure");
  const rawIdx = rest.indexOf("--raw");
  if (existsSync(join(STATE, "raw-delete-auth-fail")) && rest.indexOf("--raw") >= 0) {
    die("Unable to connect to the server: getting credentials: exec: executable credential-helper not found");
  }
  if (rawIdx >= 0) {
    // Raw DeleteOptions path: the body arrives on stdin via "-f -" and MUST
    // carry a UID precondition — an unconditional raw delete is a bug.
    const uri = rest[rawIdx + 1] || "";
    if (uri.indexOf("/apis/extensions.agents.x-k8s.io/v1alpha1/namespaces/") !== 0) {
      die("canned kubectl: unexpected raw delete uri " + uri);
    }
    const name = uri.split("/sandboxclaims/")[1];
    if (!name || name.indexOf("/") >= 0) die("canned kubectl: unexpected raw delete uri " + uri);
    let want;
    try { want = JSON.parse(readFileSync(0, "utf8")).preconditions.uid; } catch {}
    if (!want) die("canned kubectl: raw delete without a UID precondition");
    if (!existsSync(join(claims, name))) {
      die('Error from server (NotFound): sandboxclaims.extensions.agents.x-k8s.io "' + name + '" not found');
    }
    let cur = {};
    try { cur = JSON.parse(readFileSync(join(claims, name), "utf8")); } catch {}
    const curUid = cur.metadata && cur.metadata.uid;
    if (curUid !== want) {
      die('Error from server (Conflict): Precondition failed: UID in precondition: "' + want + '", UID in object meta: "' + curUid + '"');
    }
    rmSync(join(claims, name), { force: true });
    console.log('sandboxclaim.extensions.agents.x-k8s.io "' + name + '" deleted');
    process.exit(0);
  }
  rmSync(join(claims, rest[2] || ""), { force: true });
  process.exit(0);
}

if (verb === "auth") {
  if (existsSync(join(STATE, "can-i-fail"))) die("Unable to connect to the server: dial tcp: i/o timeout");
  const sub = rest.find((a) => a.indexOf("--subresource=") === 0);
  const key = rest[2] + " " + rest[3] + (sub ? "/" + sub.slice(14) : "") + " " + (allNs ? "*" : ns);
  const perms = JSON.parse(readFileSync(join(STATE, "permissions.json"), "utf8"));
  if (perms[key]) { console.log("yes"); process.exit(0); }
  console.log("no");
  process.exit(1);
}

die("canned kubectl: unhandled argv " + JSON.stringify(args));
`;

/** The exact verb set granted by the live beam-user Role, nothing more. */
const LEAST_PRIV: Record<string, boolean> = {
  "create sandboxclaims.extensions.agents.x-k8s.io beam-luiz": true,
  "get sandboxclaims.extensions.agents.x-k8s.io beam-luiz": true,
  "list sandboxclaims.extensions.agents.x-k8s.io beam-luiz": true,
  "watch sandboxclaims.extensions.agents.x-k8s.io beam-luiz": true,
  "delete sandboxclaims.extensions.agents.x-k8s.io beam-luiz": true,
  "get sandboxes.agents.x-k8s.io beam-luiz": true,
  "get pods beam-luiz": true,
  "create pods/exec beam-luiz": true,
};

interface Cluster {
  state: string;
  bin: string;
  binDir: string;
  podHome: string;
  claims: string;
  argv(): string[][];
  flag(name: string, content?: string): void;
  perms(perms: Record<string, boolean>): void;
}

function latestReturnWorkspace(beamDir: string, recordId: string): string {
  const parent = join(beamDir, "returns", recordId);
  const txn = readdirSync(parent).sort().at(-1);
  if (txn === undefined) throw new Error(`missing return stage for ${recordId}`);
  return join(parent, txn, "workspace");
}

function makeCluster(): Cluster {
  const state = realpathSync(mkdtempSync(join(tmpdir(), "beam-k8s-")));
  const binDir = join(state, "bin");
  const podHome = join(state, "podhome");
  const claims = join(state, "claims");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(podHome, { recursive: true });
  mkdirSync(claims, { recursive: true });
  writeFileSync(join(state, "impl.mjs"), FAKE_KUBECTL_IMPL);
  writeFileSync(join(state, "permissions.json"), JSON.stringify(LEAST_PRIV));
  const bin = join(binDir, "kubectl");
  // bash trampoline into the current bun binary: no PATH or loader guessing.
  writeFileSync(
    bin,
    `#!/bin/bash\nexec ${shq(process.execPath)} ${shq(join(state, "impl.mjs"))} "$@"\n`,
  );
  chmodSync(bin, 0o755);
  return {
    state,
    bin,
    binDir,
    podHome,
    claims,
    argv: () =>
      existsSync(join(state, "argv.log"))
        ? readFileSync(join(state, "argv.log"), "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as string[])
        : [],
    flag: (name, content = "") => writeFileSync(join(state, name), content),
    perms: (p) => writeFileSync(join(state, "permissions.json"), JSON.stringify(p)),
  };
}

function makeSpec(overrides: Partial<AgentSandboxTargetSpec> = {}): AgentSandboxTargetSpec {
  return {
    type: "agent-sandbox",
    context: "gke_test_ctx",
    namespace: "beam-luiz",
    template: "beam-coding",
    kubeconfig: "/kube/beam-user.kubeconfig",
    ...overrides,
  };
}

/** A KubectlTransport pinned to the canned cluster's test coordinates. */
function cannedTransport(session: string, bin: string): KubectlTransport {
  const coords = { context: "ctx", namespace: "ns", container: "sandbox" };
  return new KubectlTransport(coords, session, bin);
}

describe("agent-sandbox provider lifecycle", () => {
  test(
    "provision creates one stable claim, waits Ready, resolves claim → Sandbox → pod; " +
      "re-provision reuses without a second create",
    async () => {
      const c = makeCluster();
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      // The ref carries the pinned UID across calls, exactly like the record.
      const ref: { id: string; sandbox?: SandboxState } = { id: "abc123" };
      const t = await p.provision(ref);
      expect(t.label).toBe("k8s beam-luiz/beam-abc123");

      const manifest = JSON.parse(readFileSync(join(c.claims, "beam-abc123"), "utf8")) as {
        metadata: { name: string; namespace: string };
        spec: { sandboxTemplateRef: { name: string } };
      };
      expect(manifest.metadata.name).toBe("beam-abc123");
      expect(manifest.metadata.namespace).toBe("beam-luiz");
      expect(manifest.spec.sandboxTemplateRef.name).toBe("beam-coding");

      const log = c.argv();
      const create = log.find((a) => a.includes("create") && a.includes("-f"))!;
      expect(create).toContain("--context");
      expect(create).toContain("gke_test_ctx");
      expect(create).toContain("--namespace");
      expect(create).toContain("beam-luiz");
      const wait = log.find((a) => a.includes("wait"))!;
      expect(wait).toContain("--for=condition=Ready");
      expect(wait.some((a) => a.startsWith("--timeout="))).toBe(true);
      // resolution walked the chain, not a cached pod id
      expect(log.some((a) => a.includes("sandboxes.agents.x-k8s.io"))).toBe(true);
      expect(log.some((a) => a.includes("pod"))).toBe(true);

      await p.provision(ref);
      expect(readdirSync(c.claims)).toEqual(["beam-abc123"]); // one claim, ever
      // create-if-absent: the second provision must go through get, not create
      // (the least-privilege role has no patch/update, and the fake's create
      // fails on AlreadyExists exactly like the real API).
      expect(c.argv().filter((a) => a.includes("create") && a.includes("-f")).length).toBe(1);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  test(
    "Ready timeout is a bounded, actionable error and keeps the claim so a retried up continues it",
    async () => {
      const c = makeCluster();
      c.flag("wait-fail");
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      await expect(p.provision({ id: "x1" })).rejects.toThrow(
        /did not become Ready within[\s\S]*beam kill x1 --purge/,
      );
      expect(existsSync(join(c.claims, "beam-x1"))).toBe(true);
    },
  );

  test(
    "the verified UID is published BEFORE the Ready wait — a timeout leaves it pinned, and the " +
      "retry binds to exactly that claim",
    async () => {
      const c = makeCluster();
      c.flag("wait-fail");
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "pin1" };
      const published: SandboxState[] = [];
      let waitSeenAtPublish: boolean | undefined;
      await expect(
        p.provision(ref, (s) => {
          published.push(s);
          waitSeenAtPublish = c.argv().some((a) => a.includes("wait"));
        }),
      ).rejects.toThrow(/did not become Ready/);
      // The publication fired before kubectl wait ever ran, carrying the
      // server-assigned UID captured from the create response — a crash or
      // timeout during the (long) wait can no longer lose the pin.
      const stored = JSON.parse(readFileSync(join(c.claims, "beam-pin1"), "utf8")) as {
        metadata: { uid: string };
      };
      expect(published.length).toBe(1);
      expect(waitSeenAtPublish).toBe(false);
      expect(published[0]!.claim).toBe("beam-pin1");
      expect(published[0]!.uid).toBe(stored.metadata.uid);
      // A retry with the published state binds to that exact UID and finishes…
      rmSync(join(c.state, "wait-fail"));
      await p.provision({ id: "pin1", sandbox: published[0] });
      // …and refuses a same-name claim whose UID differs (replaced during the
      // outage) — the refusal the early publication exists to make possible.
      const replaced = JSON.parse(readFileSync(join(c.claims, "beam-pin1"), "utf8")) as {
        metadata: { uid: string };
      };
      replaced.metadata.uid = "replacement-uid";
      writeFileSync(join(c.claims, "beam-pin1"), JSON.stringify(replaced));
      await expect(p.provision({ id: "pin1", sandbox: published[0] })).rejects.toThrow(
        /is not the one this record created/,
      );
    },
    30000,
  );

  test(
    "connect re-resolves the pod from the claim; a gone claim is an actionable error",
    async () => {
      const c = makeCluster();
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "c1" };
      await p.provision(ref);
      const t = await p.connect(ref);
      expect(t.label).toContain("beam-c1");
      rmSync(join(c.claims, "beam-c1"));
      await expect(p.connect(ref)).rejects.toThrow(/beam up/);
      await expect(p.connect(undefined)).rejects.toThrow(/no live sandbox/);
    },
  );

  test(
    "persisted coordinates matching the target snapshot are used; disagreeing ones fail closed " +
      "before any kubectl runs",
    async () => {
      const c = makeCluster();
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "r1" };
      await p.provision(ref);
      // The exact coords `beam up` persisted — pinned UID included (commands
      // rebuild the provider from the record's targetSpec snapshot, so legit
      // flows always match).
      const good = agentSandboxState(ref.sandbox);
      const t = await p.connect({ id: "r1", sandbox: good });
      expect(t.label).toContain("beam-r1");

      // A record pointing at coordinates this target never produced means a
      // tampered or corrupted state.json — refuse without running kubectl.
      const argvBefore = c.argv().length;
      await expect(
        p.connect({
          id: "r1",
          sandbox: { ...good, context: "recorded-ctx", namespace: "recorded-ns" },
        }),
      ).rejects.toThrow(/do not match the target snapshot/);
      await expect(
        p.connect({ id: "r1", sandbox: { ...good, kubeconfig: "/tmp/other" } }),
      ).rejects.toThrow(
        /do not match the target snapshot/,
      );
      expect(c.argv().length).toBe(argvBefore); // refused before any kubectl call
    },
  );

  test("malformed persisted coordinates fail closed before argv interpolation", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    const good = p.sandboxState({ id: "r2" });
    await expect(
      p.connect({ id: "r2", sandbox: { ...good, namespace: "Bad_NS" } }),
    ).rejects.toThrow(/DNS label/);
    await expect(
      p.connect({ id: "r2", sandbox: { ...good, container: "-oyaml" } }),
    ).rejects.toThrow(/DNS label/);
    await expect(
      p.connect({ id: "r2", sandbox: { ...good, claim: "beam r2 $(boom)" } }),
    ).rejects.toThrow(
      /DNS subdomain/,
    );
    expect(c.argv().length).toBe(0); // nothing ever reached kubectl
  });

  test("sandboxState is pure: stable claim name per record, container defaults to sandbox", () => {
    const p = new AgentSandboxProvider(makeSpec(), "kubectl-never-spawned");
    expect(p.sandboxState({ id: "z9" })).toEqual({
      claim: "beam-z9",
      context: "gke_test_ctx",
      namespace: "beam-luiz",
      container: "sandbox",
      kubeconfig: "/kube/beam-user.kubeconfig",
      template: "beam-coding",
    });
  });

  test(
    "destroy re-reads the claim and deletes it through the raw DeleteOptions API with a UID " +
      "precondition; idempotent",
    async () => {
      const c = makeCluster();
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "d9" };
      await p.provision(ref);
      await p.destroy(ref);
      expect(existsSync(join(c.claims, "beam-d9"))).toBe(false);
      // kubectl's high-level delete has no precondition flag: the delete goes
      // through the raw DeleteOptions API — still pinned to context +
      // kubeconfig, namespace and name fused into the URI. (The fake dies on
      // any raw delete whose body lacks a UID precondition, so this passing
      // proves the precondition traveled.)
      const del = c.argv().find((a) => a.includes("delete") && !a.includes("can-i"))!;
      expect(del).toContain("--raw");
      expect(del).toContain("--context");
      expect(del).toContain("gke_test_ctx");
      expect(del).toContain("--kubeconfig");
      expect(
        del.some(
          (a) =>
            a ===
            "/apis/extensions.agents.x-k8s.io/v1alpha1" +
              "/namespaces/beam-luiz/sandboxclaims/beam-d9",
        ),
      ).toBe(true);
      expect(del).not.toContain("--ignore-not-found");
      await p.destroy(ref); // already gone — must not throw
    },
  );

  test(
    "an overpowered credential (plain pod create) is refused before any claim is created",
    async () => {
      const c = makeCluster();
      c.perms({ ...LEAST_PRIV, "create pods beam-luiz": true });
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      await expect(p.provision({ id: "p0" })).rejects.toThrow(/plain pods/);
      expect(readdirSync(c.claims)).toEqual([]);
      expect(c.argv().some((a) => a.includes("create") && a.includes("-f"))).toBe(false);
    },
  );

  test(
    "a transient can-i failure fails closed: provision refuses before any claim is created",
    async () => {
      const c = makeCluster();
      c.flag("can-i-fail");
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      await expect(p.provision({ id: "p1" })).rejects.toThrow(/fails closed/);
      expect(readdirSync(c.claims)).toEqual([]);
    },
  );

  test(
    "claim reuse refuses a template mismatch instead of exec'ing into another workload",
    async () => {
      const c = makeCluster();
      await new AgentSandboxProvider(makeSpec(), c.bin).provision({ id: "tm1" });
      const other = new AgentSandboxProvider(makeSpec({ template: "other-template" }), c.bin);
      await expect(other.provision({ id: "tm1" })).rejects.toThrow(
        /references template beam-coding, not the configured other-template/,
      );
      expect(readdirSync(c.claims)).toEqual(["beam-tm1"]); // untouched
      expect(c.argv().some((a) => a.includes("exec"))).toBe(false);
      expect(c.argv().some((a) => a.includes("--raw"))).toBe(false); // never deleted either
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  test(
    "warm-pool resolution: claim.status.sandbox.name and the pod-name annotation win over name " +
      "identity",
    async () => {
      const c = makeCluster();
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "w1" };
      await p.provision(ref);
      c.flag("sandbox-name", "beam-w1-sbx");
      c.flag("pod-name", "warm-pod-42");
      const t = await p.connect(ref);
      expect(t.label).toBe("k8s beam-luiz/warm-pod-42");
      const gets = c.argv().filter((a) => a.includes("get"));
      expect(
        gets.some((a) => a.includes("sandboxes.agents.x-k8s.io") && a.includes("beam-w1-sbx")),
      ).toBe(true);
      expect(gets.some((a) => a.includes("pod") && a.includes("warm-pod-42"))).toBe(true);
    },
  );

  test(
    "an unpopulated claim status falls back to name identity through the whole chain",
    async () => {
      const c = makeCluster();
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "f1" };
      await p.provision(ref);
      c.flag("claim-status-empty");
      const t = await p.connect(ref);
      expect(t.label).toBe("k8s beam-luiz/beam-f1");
    },
  );

  test("a Sandbox owned by a different claim is an impostor — connect refuses it", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    const ref: { id: string; sandbox?: SandboxState } = { id: "o1" };
    await p.provision(ref);
    c.flag("sandbox-owner-bad");
    await expect(p.connect(ref)).rejects.toThrow(/not owned by SandboxClaim beam-o1/);
  });

  test("a pod owned by a different Sandbox is an impostor — connect refuses it", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    const ref: { id: string; sandbox?: SandboxState } = { id: "o2" };
    await p.provision(ref);
    c.flag("pod-owner-bad");
    await expect(p.connect(ref)).rejects.toThrow(/not owned by Sandbox beam-o2/);
  });

  test("a pod that is not Running is an actionable error, not an exec target", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    const ref: { id: string; sandbox?: SandboxState } = { id: "o3" };
    await p.provision(ref);
    c.flag("pod-phase", "Pending");
    await expect(p.connect(ref)).rejects.toThrow(/is Pending, not Running/);
  });

  test("an ephemeral-container grant is refused before any claim is created", async () => {
    const c = makeCluster();
    c.perms({ ...LEAST_PRIV, "patch pods/ephemeralcontainers beam-luiz": true });
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await expect(p.provision({ id: "e0" })).rejects.toThrow(/ephemeral containers/);
    expect(readdirSync(c.claims)).toEqual([]);
    expect(c.argv().some((a) => a.includes("create") && a.includes("-f"))).toBe(false);
  });

  test("a Sandbox-mutation grant is refused before any claim is created", async () => {
    const c = makeCluster();
    c.perms({ ...LEAST_PRIV, "create sandboxes.agents.x-k8s.io beam-luiz": true });
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await expect(p.provision({ id: "e1" })).rejects.toThrow(/create Sandboxes/);
    expect(readdirSync(c.claims)).toEqual([]);
    expect(c.argv().some((a) => a.includes("create") && a.includes("-f"))).toBe(false);
  }, PROCESS_TEST_TIMEOUT_MS);

  test("a workload-controller grant is refused before any claim is created", async () => {
    const c = makeCluster();
    c.perms({ ...LEAST_PRIV, "create deployments.apps beam-luiz": true });
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await expect(p.provision({ id: "e2" })).rejects.toThrow(/create Deployments/);
    expect(readdirSync(c.claims)).toEqual([]);
    expect(c.argv().some((a) => a.includes("create") && a.includes("-f"))).toBe(false);
  });

  test(
    "a malformed API-returned sandbox name is refused before it can reach kubectl argv",
    async () => {
      const c = makeCluster();
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "n1" };
      await p.provision(ref);
      c.flag("sandbox-name", "evil;--kubeconfig=/tmp/x");
      await expect(p.connect(ref)).rejects.toThrow(/sandbox name .* DNS subdomain/);
      expect(c.argv().some((a) => a.includes("evil;--kubeconfig=/tmp/x"))).toBe(false);
    },
  );

  test("a malformed pod-name annotation is refused before it can reach kubectl argv", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    const ref: { id: string; sandbox?: SandboxState } = { id: "n2" };
    await p.provision(ref);
    c.flag("pod-name", "-oyaml");
    await expect(p.connect(ref)).rejects.toThrow(/pod name .* DNS subdomain/);
    expect(c.argv().some((a) => a.includes("-oyaml"))).toBe(false);
  });

  // Each loop iteration runs a full boundary sweep against a fresh cluster;
  // three sweeps exceed the 5s default on a busy machine.
  test("a Secret patch/update/watch grant is refused before any claim is created", async () => {
    for (const [grant, match] of [
      ["patch secrets beam-luiz", /patch Secrets/],
      ["update secrets beam-luiz", /update Secrets/],
      ["watch secrets beam-luiz", /watch Secrets/],
    ] as const) {
      const c = makeCluster();
      c.perms({ ...LEAST_PRIV, [grant]: true });
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      await expect(p.provision({ id: "s0" })).rejects.toThrow(match);
      expect(readdirSync(c.claims)).toEqual([]); // no claim was ever created
      expect(c.argv().some((a) => a.includes("create") && a.includes("-f"))).toBe(false);
    }
  }, 30000);

  test(
    "a persisted claim that is valid but not this record's beam-<id> fails closed before any " +
      "kubectl runs",
    async () => {
      const c = makeCluster();
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      await p.provision({ id: "b1" });
      const good = p.sandboxState({ id: "b1" });
      const argvBefore = c.argv().length;
      // "beam-b2" is a perfectly well-formed claim name — just another
      // record's: the persisted claim binds exactly to `beam-<record id>`.
      await expect(p.connect({ id: "b1", sandbox: { ...good, claim: "beam-b2" } })).rejects.toThrow(
        /do not match the target snapshot/,
      );
      expect(c.argv().length).toBe(argvBefore); // refused before any kubectl call
    },
  );

  test(
    "losing the create race fails closed — an unpinned record never adopts even an identical " +
      "raced claim",
    async () => {
      const c = makeCluster();
      c.flag(
        "race-claim",
        JSON.stringify({
          metadata: { labels: { "app.kubernetes.io/managed-by": "beam" }, uid: "raced-uid-1" },
          spec: { sandboxTemplateRef: { name: "beam-coding" } },
        }),
      );
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "rc1" };
      await expect(p.provision(ref)).rejects.toThrow(/never adopts a claim it did not create/);
      expect(ref.sandbox?.uid).toBeUndefined(); // no identity was pinned
      // The raced claim survives untouched and beam never acted on it.
      expect(readdirSync(c.claims)).toEqual(["beam-rc1"]);
      expect(c.argv().some((a) => a.includes("wait"))).toBe(false);
      expect(c.argv().some((a) => a.includes("exec"))).toBe(false);
      expect(c.argv().some((a) => a.includes("--raw"))).toBe(false);
      expect(c.argv().some((a) => a.includes("delete") && !a.includes("can-i"))).toBe(false);
    },
  );

  test("losing the create race to a foreign-template claim fails closed the same way", async () => {
    const c = makeCluster();
    c.flag(
      "race-claim",
      JSON.stringify({
        metadata: { labels: { "app.kubernetes.io/managed-by": "beam" }, uid: "raced-uid-2" },
        spec: { sandboxTemplateRef: { name: "other-template" } },
      }),
    );
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await expect(p.provision({ id: "rc2" })).rejects.toThrow(
      /never adopts a claim it did not create/,
    );
    expect(
      c.argv().some((a) => a.includes("wait")),
    ).toBe(false); // never waited on the foreign claim
    expect(c.argv().some((a) => a.includes("exec"))).toBe(false); // never exec'd into it
    expect(c.argv().some((a) => a.includes("--raw"))).toBe(false); // never deleted it
  });

  test("losing the create race to an unlabeled claim fails closed the same way", async () => {
    const c = makeCluster();
    c.flag(
      "race-claim",
      JSON.stringify({
        metadata: { uid: "raced-uid-3" },
        spec: { sandboxTemplateRef: { name: "beam-coding" } },
      }),
    );
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await expect(p.provision({ id: "rc3" })).rejects.toThrow(
      /never adopts a claim it did not create/,
    );
    expect(c.argv().some((a) => a.includes("wait"))).toBe(false);
    expect(c.argv().some((a) => a.includes("exec"))).toBe(false);
  });

  test(
    "P1 regression: a legacy record (no pinned UID) never adopts, execs, or deletes a matching " +
      "same-name claim",
    async () => {
      const c = makeCluster();
      // A beam-labeled claim on the configured template occupies the record's
      // name — exactly what a deleted-and-recreated replacement looks like.
      writeFileSync(
        join(c.claims, "beam-old1"),
        JSON.stringify({
          metadata: { labels: { "app.kubernetes.io/managed-by": "beam" }, uid: "replacement-uid" },
          spec: { sandboxTemplateRef: { name: "beam-coding" } },
        }),
      );
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      const claimBytes = readFileSync(join(c.claims, "beam-old1"), "utf8");
      // Legacy shape 1: the record predates persisted coordinates entirely.
      // Legacy shape 2: coordinates persisted, but no UID (the pre-pin era).
      const legacyRefs: Array<{ id: string; sandbox?: SandboxState }> = [
        { id: "old1" },
        { id: "old1", sandbox: p.sandboxState({ id: "old1" }) },
      ];
      for (const ref of legacyRefs) {
        await expect(p.connect(ref)).rejects.toThrow(/has no pinned claim UID/);
        await expect(p.provision(ref)).rejects.toThrow(/has no pinned claim UID/);
        await expect(p.destroy(ref)).rejects.toThrow(/has no pinned claim UID/);
        expect(ref.sandbox?.uid).toBeUndefined(); // nothing was adopted or pinned
      }
      // Zero exec/delete/mutation: the occupant is byte-identical, nothing
      // else was created, and no exec/wait/delete (raw or plain) was issued.
      expect(readFileSync(join(c.claims, "beam-old1"), "utf8")).toBe(claimBytes);
      expect(readdirSync(c.claims)).toEqual(["beam-old1"]);
      expect(c.argv().some((a) => a.includes("exec"))).toBe(false);
      expect(c.argv().some((a) => a.includes("wait"))).toBe(false);
      expect(c.argv().some((a) => a.includes("--raw"))).toBe(false);
      expect(c.argv().some((a) => a.includes("delete") && !a.includes("can-i"))).toBe(false);
      expect(c.argv().some((a) => a.includes("create") && a.includes("-f"))).toBe(false);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  test(
    "a legacy record still provisions when its claim is provably absent — and pins the new UID " +
      "immediately",
    async () => {
      const c = makeCluster();
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      // Coordinates persisted without a UID, claim name unoccupied: the one
      // act an unpinned record may perform is creating the absent claim.
      const ref: { id: string; sandbox?: SandboxState } = {
        id: "old3",
        sandbox: p.sandboxState({ id: "old3" }),
      };
      await p.provision(ref);
      const stored = JSON.parse(readFileSync(join(c.claims, "beam-old3"), "utf8")) as {
        metadata: { uid: string };
      };
      expect(ref.sandbox?.uid).toBe(stored.metadata.uid); // pinned from the create response
    },
  );

  test(
    "a legacy record whose name is held by a provably foreign claim retires on destroy without " +
      "touching it",
    async () => {
      const c = makeCluster();
      writeFileSync(
        join(c.claims, "beam-old2"),
        JSON.stringify({
          metadata: {
            labels: { "app.kubernetes.io/managed-by": "someone-else" },
            uid: "foreign-uid",
          },
          spec: { sandboxTemplateRef: { name: "beam-coding" } },
        }),
      );
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      await p.destroy(
        { id: "old2" },
      ); // provably another workload's: retire cleanly, delete nothing
      expect(existsSync(join(c.claims, "beam-old2"))).toBe(true);
      expect(c.argv().some((a) => a.includes("--raw"))).toBe(false);
      expect(c.argv().some((a) => a.includes("delete") && !a.includes("can-i"))).toBe(false);
    },
  );

  test(
    "provision pins the created claim's UID on the ref; the benign exact claim keeps working end " +
      "to end",
    async () => {
      const c = makeCluster();
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "u1" };
      await p.provision(ref);
      const stored = JSON.parse(readFileSync(join(c.claims, "beam-u1"), "utf8")) as {
        metadata: { uid: string; labels: Record<string, string> };
      };
      // The created manifest carries the managed-by label the identity gate
      // pins, and the ref got the server-assigned UID for the caller to persist.
      expect(stored.metadata.labels["app.kubernetes.io/managed-by"]).toBe("beam");
      expect(ref.sandbox?.uid).toBe(stored.metadata.uid);
      expect(ref.sandbox?.claim).toBe("beam-u1");
      expect(ref.sandbox?.template).toBe("beam-coding");
      // Exact name + label + template + UID: connect and re-provision both bind.
      const t = await p.connect(ref);
      expect(t.label).toBe("k8s beam-luiz/beam-u1");
      await p.provision(ref);
      expect(readdirSync(c.claims)).toEqual(["beam-u1"]);
    },
    30000,
  );

  test(
    "a same-name claim with a foreign managed-by label refuses provision — no wait, no exec, no " +
      "delete",
    async () => {
      const c = makeCluster();
      writeFileSync(
        join(c.claims, "beam-f9"),
        JSON.stringify({
          metadata: {
            uid: "foreign-uid",
            labels: { "app.kubernetes.io/managed-by": "someone-else" },
          },
          spec: { sandboxTemplateRef: { name: "beam-coding" } },
        }),
      );
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      await expect(p.provision({ id: "f9" })).rejects.toThrow(/not managed by beam/);
      expect(existsSync(join(c.claims, "beam-f9"))).toBe(true); // the foreign claim is untouched
      expect(c.argv().some((a) => a.includes("wait"))).toBe(false);
      expect(c.argv().some((a) => a.includes("exec"))).toBe(false);
      expect(c.argv().some((a) => a.includes("--raw"))).toBe(false);
      expect(c.argv().some((a) => a.includes("delete") && !a.includes("can-i"))).toBe(false);
    },
  );

  test("a same-name claim missing the label entirely is refused the same way", async () => {
    const c = makeCluster();
    writeFileSync(
      join(c.claims, "beam-f8"),
      JSON.stringify({
        metadata: { uid: "foreign-uid-2" },
        spec: { sandboxTemplateRef: { name: "beam-coding" } },
      }),
    );
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await expect(p.provision({ id: "f8" })).rejects.toThrow(
      /not managed by beam \(label .* is missing\)/,
    );
    expect(existsSync(join(c.claims, "beam-f8"))).toBe(true);
  });

  test(
    "a replaced claim (same name, new UID) is refused by connect and re-provision; destroy " +
      "retires without touching it",
    async () => {
      const c = makeCluster();
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "z1" };
      await p.provision(ref);
      // Simulate out-of-band delete + recreate: same name, label, and
      // template — only the server-assigned UID differs.
      const stored = JSON.parse(readFileSync(join(c.claims, "beam-z1"), "utf8")) as {
        metadata: { uid: string };
      };
      stored.metadata.uid = "replacement-uid";
      writeFileSync(join(c.claims, "beam-z1"), JSON.stringify(stored));
      const argvBefore = c.argv().length;
      await expect(p.connect(ref)).rejects.toThrow(/is not the one this record created/);
      // Refused at the claim read: the pod chain was never resolved, nothing
      // was exec'd.
      const delta = c.argv().slice(argvBefore);
      expect(delta.some((a) => a.includes("exec"))).toBe(false);
      expect(delta.some((a) => a.some((el) => el.includes("sandboxes.agents")))).toBe(false);
      // Re-provision refuses the impostor too — it would otherwise adopt it.
      await expect(p.provision(ref)).rejects.toThrow(/is not the one this record created/);
      // destroy: beam's claim is provably gone (live same-name object, other
      // UID) — retire cleanly, delete nothing.
      await p.destroy(ref);
      expect(existsSync(join(c.claims, "beam-z1"))).toBe(true); // impostor untouched
      expect(c.argv().some((a) => a.includes("--raw"))).toBe(false); // no delete was ever issued
    },
    30000,
  );

  test(
    "a delete raced by replacement is stopped by the UID precondition — never a fallback " +
      "unconditional delete",
    async () => {
      const c = makeCluster();
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "z2" };
      await p.provision(ref);
      // The claim is swapped for a same-name/new-UID object immediately AFTER
      // destroy's identity read — the classic check-then-delete race window.
      c.flag("swap-uid-on-get");
      await p.destroy(ref); // must not throw: ours is gone, the record retires
      expect(existsSync(join(c.claims, "beam-z2"))).toBe(true); // the replacement survived
      expect(
        c.argv().filter((a) => a.includes("--raw")).length,
      ).toBe(1); // one pinned attempt, refused server-side
      expect(
        c.argv().some((a) => a.includes("delete") && !a.includes("--raw") && !a.includes("can-i")),
      ).toBe(false);
    },
  );

  test(
    "P1 regression: a tool/auth failure saying 'not found' is never read as absence — lookup and " +
      "destroy throw, nothing retires",
    async () => {
      const c = makeCluster();
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "af1" };
      await p.provision(ref);
      // Kubeconfig exec-plugin failure: stderr contains "not found" but the
      // claim is alive. Absence is ONLY exit 0 + empty stdout.
      c.flag("get-auth-fail");
      await expect(p.connect(ref)).rejects.toThrow(/kubectl get .* failed/);
      await expect(p.destroy(ref)).rejects.toThrow(/kubectl get .* failed/);
      rmSync(join(c.state, "get-auth-fail"));
      expect(existsSync(join(c.claims, "beam-af1"))).toBe(true); // claim untouched
      expect(c.argv().some((a) => a.includes("--raw"))).toBe(false); // no delete was ever attempted
      // With the failure cleared, the same record still works — the errors
      // above were failures, not a false "already gone" retirement.
      await p.connect(ref);
      // True API absence still classifies as absent: kubectl's own
      // suppression (exit 0, empty stdout) — destroy retires cleanly.
      rmSync(join(c.claims, "beam-af1"));
      await p.destroy(ref);
    },
  );

  test(
    "P1 regression: a raw-delete transport failure saying 'not found' throws — never a silent " +
      "'already gone'",
    async () => {
      const c = makeCluster();
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "af2" };
      await p.provision(ref);
      c.flag("raw-delete-auth-fail");
      await expect(p.destroy(ref)).rejects.toThrow(/deleting SandboxClaim beam-af2 failed/);
      expect(
        existsSync(join(c.claims, "beam-af2")),
      ).toBe(true); // claim survived the failed teardown
      rmSync(join(c.state, "raw-delete-auth-fail"));
      await p.destroy(ref); // the genuine delete still works afterward
      expect(existsSync(join(c.claims, "beam-af2"))).toBe(false);
    },
  );

  test(
    "a Sandbox owner entry with the right name but a different UID is an impostor chain — " +
      "connect refuses",
    async () => {
      const c = makeCluster();
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "o4" };
      await p.provision(ref);
      c.flag("sandbox-owner-uid-bad");
      await expect(p.connect(ref)).rejects.toThrow(/not owned by SandboxClaim beam-o4/);
      expect(c.argv().some((a) => a.includes("exec"))).toBe(false);
    },
  );

  test(
    "a pod owner entry with the right Sandbox name but a different UID is an impostor chain — " +
      "connect refuses",
    async () => {
      const c = makeCluster();
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      const ref: { id: string; sandbox?: SandboxState } = { id: "o5" };
      await p.provision(ref);
      c.flag("pod-owner-uid-bad");
      await expect(p.connect(ref)).rejects.toThrow(/not owned by Sandbox beam-o5/);
      expect(c.argv().some((a) => a.includes("exec"))).toBe(false);
    },
  );

  // Three fresh-cluster boundary sweeps — over the 5s default under load.
  test(
    "each newly-forbidden grant is refused independently before any claim is created",
    async () => {
      for (const [grant, match] of [
        ["delete secrets beam-luiz", /delete Secrets/],
        ["deletecollection secrets beam-luiz", /deletecollection Secrets/],
        [
          "delete sandboxclaims.extensions.agents.x-k8s.io *",
          /delete SandboxClaims in ALL namespaces/,
        ],
      ] as const) {
        const c = makeCluster();
        c.perms({ ...LEAST_PRIV, [grant]: true });
        const p = new AgentSandboxProvider(makeSpec(), c.bin);
        await expect(p.provision({ id: "sd0" })).rejects.toThrow(match);
        expect(readdirSync(c.claims)).toEqual([]); // no claim was ever created
        expect(c.argv().some((a) => a.includes("create") && a.includes("-f"))).toBe(false);
      }
    },
    30000,
  );
});

describe("agent-sandbox check (least privilege)", () => {
  test(
    "accepts the scoped beam-user credential and probes exec via --subresource, never pods/exec",
    async () => {
      const c = makeCluster();
      const report = await new AgentSandboxProvider(makeSpec(), c.bin).check();
      expect(report.fatal).toBeUndefined();
      expect(report.lines.join("\n")).toMatch(/boundary:\s+ok/);
      expect(report.lines.join("\n")).toMatch(/rbac:\s+ok/);
      const canIs = c.argv().filter((a) => a.includes("can-i"));
      expect(canIs.some((a) => a.includes("--subresource=exec"))).toBe(true);
      expect(canIs.some((a) => a.includes("pods/exec"))).toBe(false);
      // The boundary sweep covers every escape hatch, not just claims/Secrets.
      for (const probe of [
        "patch",
        "update",
        "deletecollection",
        "--subresource=attach",
        "--subresource=portforward",
        "--subresource=token",
        "--subresource=ephemeralcontainers",
        "sandboxes.agents.x-k8s.io",
        "sandboxtemplates.extensions.agents.x-k8s.io",
        "deployments.apps",
        "statefulsets.apps",
        "daemonsets.apps",
        "replicasets.apps",
        "replicationcontrollers",
        "jobs.batch",
        "cronjobs.batch",
        "bind",
        "escalate",
        "impersonate",
      ]) {
        expect(canIs.some((a) => a.includes(probe))).toBe(true);
      }
      // Template presence is asked with resource/name fused into ONE argv — a
      // hostile name can never be parsed as a kubectl flag.
      expect(
        c.argv().some((a) => a.includes("sandboxtemplates.extensions.agents.x-k8s.io/beam-coding")),
      ).toBe(true);
    },
  );

  test("rejects a credential that can create SandboxClaims across all namespaces", async () => {
    const c = makeCluster();
    c.perms({ ...LEAST_PRIV, "create sandboxclaims.extensions.agents.x-k8s.io *": true });
    const report = await new AgentSandboxProvider(makeSpec(), c.bin).check();
    expect(report.fatal).toMatch(/ALL namespaces/);
  });

  test("rejects a credential that can list SandboxClaims across all namespaces", async () => {
    const c = makeCluster();
    c.perms({ ...LEAST_PRIV, "list sandboxclaims.extensions.agents.x-k8s.io *": true });
    const report = await new AgentSandboxProvider(makeSpec(), c.bin).check();
    expect(report.fatal).toMatch(/ALL namespaces/);
  });

  test("rejects a credential that can read Secrets in the namespace", async () => {
    const c = makeCluster();
    c.perms({ ...LEAST_PRIV, "get secrets beam-luiz": true });
    const report = await new AgentSandboxProvider(makeSpec(), c.bin).check();
    expect(report.fatal).toMatch(/Secrets/);
  });

  test("reports missing namespace verbs instead of passing silently", async () => {
    const c = makeCluster();
    const perms = { ...LEAST_PRIV };
    delete perms["create pods/exec beam-luiz"];
    c.perms(perms);
    const report = await new AgentSandboxProvider(makeSpec(), c.bin).check();
    expect(report.fatal).toBeUndefined();
    expect(report.lines.join("\n")).toMatch(/MISSING.*exec into pods/);
  });

  test("a forbidden template read is reported as the exact missing narrow rule", async () => {
    const c = makeCluster();
    c.flag("template-forbidden");
    const report = await new AgentSandboxProvider(makeSpec(), c.bin).check();
    expect(report.fatal).toBeUndefined();
    expect(report.lines.join("\n")).toMatch(/sandboxtemplates\/beam-coding/);
  });

  test(
    "rejects a credential that can create plain pods (bypasses the SandboxTemplate boundary)",
    async () => {
      const c = makeCluster();
      c.perms({ ...LEAST_PRIV, "create pods beam-luiz": true });
      const report = await new AgentSandboxProvider(makeSpec(), c.bin).check();
      expect(report.fatal).toMatch(/plain pods/);
    },
  );

  test(
    "one extra grant beyond the beam role is fatal — template, workload, and pod-mutation escapes",
    async () => {
      const grants: Array<[string, RegExp]> = [
        ["patch pods beam-luiz", /patch pods/],
        ["update pods beam-luiz", /update pods/],
        ["patch pods/ephemeralcontainers beam-luiz", /ephemeral containers/],
        ["update pods/ephemeralcontainers beam-luiz", /ephemeral containers/],
        ["create pods/portforward beam-luiz", /port-forward pods in namespace/],
        ["create sandboxes.agents.x-k8s.io beam-luiz", /create Sandboxes/],
        ["patch sandboxes.agents.x-k8s.io beam-luiz", /patch Sandboxes/],
        ["update sandboxes.agents.x-k8s.io beam-luiz", /update Sandboxes/],
        ["delete sandboxes.agents.x-k8s.io beam-luiz", /delete Sandboxes/],
        ["create sandboxtemplates.extensions.agents.x-k8s.io beam-luiz", /create SandboxTemplates/],
        ["patch sandboxtemplates.extensions.agents.x-k8s.io beam-luiz", /patch SandboxTemplates/],
        ["update sandboxtemplates.extensions.agents.x-k8s.io beam-luiz", /update SandboxTemplates/],
        ["delete sandboxtemplates.extensions.agents.x-k8s.io beam-luiz", /delete SandboxTemplates/],
        ["create deployments.apps beam-luiz", /create Deployments/],
        ["patch statefulsets.apps beam-luiz", /patch StatefulSets/],
        ["update daemonsets.apps beam-luiz", /update DaemonSets/],
        ["create replicasets.apps beam-luiz", /create ReplicaSets/],
        ["create replicationcontrollers beam-luiz", /create ReplicationControllers/],
        ["create jobs.batch beam-luiz", /create Jobs/],
        ["create cronjobs.batch beam-luiz", /create CronJobs/],
        ["patch secrets beam-luiz", /patch Secrets/],
        ["update secrets beam-luiz", /update Secrets/],
        ["watch secrets beam-luiz", /watch Secrets/],
        ["delete secrets beam-luiz", /delete Secrets/],
        ["deletecollection secrets beam-luiz", /deletecollection Secrets/],
        [
          "delete sandboxclaims.extensions.agents.x-k8s.io *",
          /delete SandboxClaims in ALL namespaces/,
        ],
      ];
      for (const [grant, match] of grants) {
        const c = makeCluster();
        c.perms({ ...LEAST_PRIV, [grant]: true });
        const report = await new AgentSandboxProvider(makeSpec(), c.bin).check();
        expect(report.fatal).toMatch(match);
      }
    },
    120_000, // 26 canned clusters × ~58 probes each — generous under a loaded machine
  );

  test("fails closed when a boundary probe cannot be answered", async () => {
    const c = makeCluster();
    c.flag("can-i-fail");
    const report = await new AgentSandboxProvider(makeSpec(), c.bin).check();
    expect(report.fatal).toMatch(/fails closed/);
  });
});

describe("kubectl transport", () => {
  test("interactive argv is exact: pinned flags, tty exec, container, non-login shell", () => {
    const t = new KubectlTransport(
      { context: "ctx1", namespace: "ns1", container: "sandbox", kubeconfig: "/kube/config" },
      "beam-p1",
      "/usr/local/bin/kubectl",
    );
    // The attach payload rides through verbatim — its byte shape (fish-safe
    // single bash -c string, socket-dir prep, HERDR_SOCKET_PATH pin) is
    // asserted in shell.test.ts; here it proves pass-through, unmangled.
    const attach = new HerdrRuntime(t).attachCommand("beam-p1");
    expect(t.interactiveArgv(attach)).toEqual([
      "/usr/local/bin/kubectl",
      "--context",
      "ctx1",
      "--namespace",
      "ns1",
      "--kubeconfig",
      "/kube/config",
      "exec",
      "-it",
      "beam-p1",
      "-c",
      "sandbox",
      "--",
      "bash",
      "-c",
      attach,
    ]);
  });

  test(
    "tar sync preserves contents both ways; sync-down never deletes local files by default",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-tar", c.bin);
      const local = join(c.state, "local-ws");
      mkdirSync(join(local, "src"), { recursive: true });
      writeFileSync(join(local, "hello.txt"), "hello\n");
      writeFileSync(join(local, "src", "deep.txt"), "deep\n");
      writeFileSync(join(local, "secret.env"), "nope\n");
      const remote = join(c.podHome, "data", "bipa", "ws"); // absolute root — no ~ assumption

      await t.syncUp(local, remote, { excludes: ["secret.env"], license: true });
      expect(readFileSync(join(remote, "hello.txt"), "utf8")).toBe("hello\n");
      expect(readFileSync(join(remote, "src", "deep.txt"), "utf8")).toBe("deep\n");
      expect(existsSync(join(remote, "secret.env"))).toBe(false);
      // a licensed ship leaves the out-of-tree marker that licenses a mirrored sync-down
      const marker = syncMarkerFor(remote);
      expect(marker.root).toBe(remote);
      expect(readFileSync(join(remote, marker.rel), "utf8")).toBe(marker.content);

      // a re-ship is ADDITIVE: mirrored deletion is refused outright before
      // any remote mutation, and a remote stray survives an overlay re-ship
      writeFileSync(join(remote, "stale.txt"), "old\n");
      await expect(
        t.syncUp(local, remote, { excludes: ["secret.env"], delete: true, license: true }),
      ).rejects.toThrow(/cannot mirror deletions/);
      await t.syncUp(local, remote, { excludes: ["secret.env"], license: true });
      expect(readFileSync(join(remote, "stale.txt"), "utf8")).toBe("old\n");
      expect(existsSync(join(remote, "hello.txt"))).toBe(true);

      // remote work comes home; local-only files survive a default sync-down
      await t.execChecked(`printf theirs > ${shq(join(remote, "made-remotely.txt"))}`);
      writeFileSync(join(local, "local-only.txt"), "mine\n");
      await t.syncDown(remote, local, { excludes: [BEAM_RESERVED_EXCLUDE] });
      expect(readFileSync(join(local, "made-remotely.txt"), "utf8")).toBe("theirs");
      expect(existsSync(join(local, "local-only.txt"))).toBe(true);
      // transport metadata lives under .beam, which every workspace return
      // excludes — nothing of it lands locally
      expect(existsSync(join(local, ".beam"))).toBe(false);

      // a mirrored sync-down prunes local strays but never excluded paths
      writeFileSync(join(local, "keep.env"), "x\n");
      await t.syncDown(
        remote,
        local,
        { delete: true, excludes: [BEAM_RESERVED_EXCLUDE, "keep.env"] },
      );
      expect(existsSync(join(local, "local-only.txt"))).toBe(false);
      expect(existsSync(join(local, "secret.env"))).toBe(false); // never shipped, so pruned
      expect(existsSync(join(local, "keep.env"))).toBe(true);
      expect(readFileSync(join(local, "hello.txt"), "utf8")).toBe("hello\n");
      expect(existsSync(join(local, ".beam"))).toBe(false);
    },
  );

  test(
    "sync-up refuses `delete` before any remote command runs, and licensed additive ships mark",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-g", c.bin);
      const local = join(c.state, "local-ws");
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "a.txt"), "a\n");
      const remote = join(c.podHome, "data", "ws-g");

      await expect(t.syncUp(local, remote, { delete: true })).rejects.toThrow(
        /cannot mirror deletions/,
      );
      expect(c.argv().length).toBe(0); // refused before any kubectl command ran

      await t.syncUp(local, remote, { license: true });
      const marker = syncMarkerFor(remote);
      expect(readFileSync(join(remote, marker.rel), "utf8")).toBe(marker.content);
    },
  );

  test(
    "a lossy download stream is retried until a verified archive lands — exact bytes arrive",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-chaos-d", c.bin);
      const seed = join(c.state, "seed-ws");
      const local = join(c.state, "local-ws");
      const remote = join(c.podHome, "data", "ws-chaos-d");
      mkdirSync(seed, { recursive: true });
      mkdirSync(local, { recursive: true });
      writeFileSync(join(seed, "work.txt"), "remote work\n");
      await t.syncUp(seed, remote, {});
      // Drop the tail of the next 5 archive downloads: past the old
      // 3-attempt ceiling, within the current budget — the sixth copy must
      // come back byte-verified and extract cleanly.
      c.flag("corrupt-stdout", "5 cat '/tmp/beam-syncdown-");
      await t.syncDown(remote, local, {});
      expect(readFileSync(join(local, "work.txt"), "utf8")).toBe("remote work\n");
    },
  );

  test("a persistently lossy download fails closed after the bounded attempts", async () => {
    const c = makeCluster();
    const t = cannedTransport("beam-chaos-dx", c.bin);
    const seed = join(c.state, "seed-ws");
    const local = join(c.state, "local-ws");
    const remote = join(c.podHome, "data", "ws-chaos-dx");
    mkdirSync(seed, { recursive: true });
    mkdirSync(local, { recursive: true });
    writeFileSync(join(seed, "work.txt"), "remote work\n");
    await t.syncUp(seed, remote, {});
    c.flag("corrupt-stdout", "99 cat '/tmp/beam-syncdown-");
    await expect(t.syncDown(remote, local, {})).rejects.toThrow(/6 verified downloads/);
    // A truncated stream never reaches extraction: nothing landed locally.
    expect(existsSync(join(local, "work.txt"))).toBe(false);
  });

  test(
    "a lossy upload stream is retried until the remote receipt verifies — then extraction runs",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-chaos-u", c.bin);
      const local = join(c.state, "local-ws");
      const remote = join(c.podHome, "data", "ws-chaos-u");
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "hello.txt"), "hello\n");
      c.flag("corrupt-stdin", "5 cat > '/tmp/beam-syncup-");
      await t.syncUp(local, remote, {});
      expect(readFileSync(join(remote, "hello.txt"), "utf8")).toBe("hello\n");
    },
  );

  test("a persistently lossy upload fails closed with the destination untouched", async () => {
    const c = makeCluster();
    const t = cannedTransport("beam-chaos-ux", c.bin);
    const local = join(c.state, "local-ws");
    const remote = join(c.podHome, "data", "ws-chaos-ux");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "hello.txt"), "hello\n");
    c.flag("corrupt-stdin", "99 cat > '/tmp/beam-syncup-");
    await expect(t.syncUp(local, remote, {})).rejects.toThrow(/6 verified uploads/);
    // Extraction only ever reads a verified archive: no truncated tree can
    // have been planted in the workspace.
    expect(existsSync(join(remote, "hello.txt"))).toBe(false);
  });

  test(
    "mirrored sync-down without a genuine up marker refuses before touching local files",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-m", c.bin);
      const local = join(c.state, "local-ws");
      mkdirSync(join(local, "src"), { recursive: true });
      writeFileSync(join(local, "precious.txt"), "keep me\n");
      writeFileSync(join(local, "src", "deep.txt"), "deep\n");

      // a populated remote dir beam never shipped to: files but no marker
      const remote = join(c.podHome, "data", "ws-m");
      mkdirSync(remote, { recursive: true });
      writeFileSync(join(remote, "attacker.txt"), "planted\n");

      await expect(t.syncDown(remote, local, { delete: true })).rejects.toThrow(
        /refusing to mirror deletions/,
      );
      expect(readFileSync(join(local, "precious.txt"), "utf8")).toBe(
        "keep me\n",
      ); // nothing deleted
      expect(readFileSync(join(local, "src", "deep.txt"), "utf8")).toBe("deep\n");
      expect(existsSync(join(local, "attacker.txt"))).toBe(false); // nothing landed either

      // The refusal came from the marker preflight — nothing was fetched:
      // the only exec is the probe (held-cwd walk + single-component cat),
      // no tar stream ran.
      const execs = c.argv().filter((a) => a.includes("exec"));
      expect(execs.length).toBe(1);
      expect(execs[0]!.at(-1)!).toMatch(/(?:^|\n)cat '[0-9a-f]{32}\.v1'\n/);
      expect(c.argv().some((a) => a.some((el) => el.includes("tar -czf")))).toBe(false);

      // a forged marker with the wrong content is refused the same way
      mkdirSync(join(remote, ".beam", "transport", "kubectl-synced"), { recursive: true });
      writeFileSync(join(remote, syncMarkerFor(remote).rel), "not the marker");
      await expect(t.syncDown(remote, local, { delete: true })).rejects.toThrow(
        /refusing to mirror deletions/,
      );
      expect(readFileSync(join(local, "precious.txt"), "utf8")).toBe("keep me\n");
      expect(existsSync(join(local, "attacker.txt"))).toBe(false);

      // without `delete` the same remote syncs down fine — non-destructive
      // path; the workspace return's reserved exclude keeps the whole .beam
      // (forged marker included) out of the local tree
      await t.syncDown(remote, local, { excludes: [BEAM_RESERVED_EXCLUDE] });
      expect(readFileSync(join(local, "attacker.txt"), "utf8")).toBe("planted\n");
      expect(readFileSync(join(local, "precious.txt"), "utf8")).toBe("keep me\n");
      expect(existsSync(join(local, ".beam"))).toBe(false);
    },
  );

  test(
    "sync-down replaces a pre-existing outward symlink instead of writing through it",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-s", c.bin);
      const outside = join(c.state, "outside");
      mkdirSync(outside, { recursive: true });
      const local = join(c.state, "local-ws");
      mkdirSync(local, { recursive: true });
      // an earlier hostile sync (or the agent itself) left a link escaping the workspace
      symlinkSync(outside, join(local, "escape"));

      const remote = join(c.podHome, "data", "ws-s");
      mkdirSync(join(remote, "escape"), { recursive: true });
      writeFileSync(join(remote, "escape", "payload.txt"), "pwned\n");

      await t.syncDown(remote, local, {});
      expect(readdirSync(outside)).toEqual([]); // nothing escaped the workspace
      expect(
        lstatSync(join(local, "escape")).isSymbolicLink(),
      ).toBe(false); // link replaced by a real dir
      expect(readFileSync(join(local, "escape", "payload.txt"), "utf8")).toBe("pwned\n");
    },
  );

  test(
    "a root-anchored exclude keeps its anchor on both legs — nested matches ship and survive a " +
      "mirrored return",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-anch", c.bin);
      const local = join(c.state, "local-anch");
      mkdirSync(join(local, "build"), { recursive: true });
      mkdirSync(join(local, "src", "build"), { recursive: true });
      writeFileSync(join(local, "build", "root-artifact.o"), "root\n");
      writeFileSync(join(local, "src", "build", "nested-artifact.o"), "nested\n");
      writeFileSync(join(local, "src", "main.ts"), "main\n");
      const remote = join(c.podHome, "data", "ws-anch");

      await t.syncUp(local, remote, { excludes: ["/build"], license: true });
      expect(existsSync(join(remote, "build"))).toBe(false); // anchored: the root dir is excluded
      expect(readFileSync(join(remote, "src", "build", "nested-artifact.o"), "utf8")).toBe(
        "nested\n",
      ); // nested ships

      // The same anchored pattern both filters AND protects the mirror leg:
      // /build survives --delete locally, nested src/build comes home intact
      // (the old tar translation widened /build to every depth on the fetch,
      // so --delete destroyed the nested copy).
      await t.syncDown(remote, local, { delete: true, excludes: ["/build"] });
      expect(readFileSync(join(local, "build", "root-artifact.o"), "utf8")).toBe("root\n");
      expect(readFileSync(join(local, "src", "build", "nested-artifact.o"), "utf8")).toBe(
        "nested\n",
      );
      expect(readFileSync(join(local, "src", "main.ts"), "utf8")).toBe("main\n");
    },
  );

  test("a slash-carrying exclude keeps its rsync meaning on both legs", async () => {
    const c = makeCluster();
    const t = cannedTransport("beam-sl", c.bin);
    const local = join(c.state, "local-sl");
    mkdirSync(join(local, "build"), { recursive: true });
    mkdirSync(join(local, "src", "build"), { recursive: true });
    writeFileSync(join(local, "build", "root-artifact.o"), "root\n");
    writeFileSync(join(local, "src", "build", "nested-artifact.o"), "nested\n");
    const remote = join(c.podHome, "data", "ws-sl");

    await t.syncUp(local, remote, { excludes: ["src/build"], license: true });
    expect(readFileSync(join(remote, "build", "root-artifact.o"), "utf8")).toBe(
      "root\n",
    ); // top-level build ships
    expect(
      existsSync(join(remote, "src", "build")),
    ).toBe(false); // the slash pattern excluded the nested one

    await t.syncDown(remote, local, { delete: true, excludes: ["src/build"] });
    expect(readFileSync(join(local, "src", "build", "nested-artifact.o"), "utf8")).toBe(
      "nested\n",
    ); // protected from --delete
    expect(readFileSync(join(local, "build", "root-artifact.o"), "utf8")).toBe("root\n");
  });

  test(
    "excluding .beam/ or the marker name never blocks a mirrored return — the license is probed " +
      "remotely",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-x", c.bin);
      for (const tag of ["beamdir", "marker"] as const) {
        const local = join(c.state, `local-${tag}`);
        mkdirSync(local, { recursive: true });
        writeFileSync(join(local, "hello.txt"), "hello\n");
        const remote = join(c.podHome, "data", `ws-${tag}`);
        const marker = syncMarkerFor(remote);
        // user patterns naming the reserved dir or the exact license file
        const exclude = tag === "beamdir" ? ".beam/" : marker.rel.split("/").at(-1)!;

        await t.syncUp(local, remote, { excludes: [exclude], license: true });
        // the license is written by syncUp itself, past the content filters
        expect(readFileSync(join(remote, marker.rel), "utf8")).toBe(marker.content);

        await t.execChecked(`printf theirs > ${shq(join(remote, "made-remotely.txt"))}`);
        writeFileSync(join(local, "local-only.txt"), "mine\n");
        await t.syncDown(
          remote,
          local,
          { delete: true, excludes: [BEAM_RESERVED_EXCLUDE, exclude] },
        );
        expect(readFileSync(join(local, "made-remotely.txt"), "utf8")).toBe("theirs");
        expect(existsSync(join(local, "local-only.txt"))).toBe(false); // the mirror really ran
        expect(existsSync(join(local, ".beam"))).toBe(false); // reserved metadata never lands
      }
    },
  );

  test("staging trees are cleaned up on success, on refusal, and on a failed fetch", async () => {
    const c = makeCluster();
    const t = cannedTransport("beam-st", c.bin);
    const local = join(c.state, "local-st");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "a.txt"), "a\n");
    const remote = join(c.podHome, "data", "ws-st");
    const before = readdirSync(tmpdir()).filter(
      (n) => n.startsWith("beam-syncup-") || n.startsWith("beam-syncdown-"),
    );

    await t.syncUp(local, remote, { license: true });
    await t.syncDown(remote, local, { delete: true });

    // refusal path: a foreign dir without the marker
    const foreign = join(c.podHome, "data", "ws-foreign");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "x.txt"), "x\n");
    await expect(t.syncDown(foreign, local, { delete: true })).rejects.toThrow(
      /refusing to mirror/,
    );

    // failure path: the remote tar dies mid-fetch
    c.flag("exec-fail-pattern", "tar -czf");
    try {
      await expect(t.syncDown(remote, local, {})).rejects.toThrow();
    } finally {
      rmSync(join(c.state, "exec-fail-pattern"));
    }

    const after = readdirSync(tmpdir()).filter(
      (n) => n.startsWith("beam-syncup-") || n.startsWith("beam-syncdown-"),
    );
    expect(after.filter((n) => !before.includes(n))).toEqual([]);
  });

  test("~ paths resolve against the pod's HOME through the exec channel", async () => {
    const c = makeCluster();
    const t = cannedTransport("beam-h", c.bin);
    await t.execChecked(
      'mkdir -p "$HOME/nested/dir" && printf payload > "$HOME/nested/dir/copy.txt"',
    );
    expect(readFileSync(join(c.podHome, "nested", "dir", "copy.txt"), "utf8")).toBe("payload");
    expect(await t.exists("~/nested/dir/copy.txt")).toBe(true);
    expect(await t.exists("~/nope")).toBe(false);
  });

  test(
    "every syncUp attempt invalidates the marker first — a failed overlay after a successful " +
      "ship leaves no license",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-inv", c.bin);
      const local = join(c.state, "local-inv");
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "precious.txt"), "keep me\n");
      const remote = join(c.podHome, "data", "ws-inv");

      // First ship succeeds and earns the license…
      await t.syncUp(local, remote, { license: true });
      const marker = syncMarkerFor(remote);
      expect(readFileSync(join(remote, marker.rel), "utf8")).toBe(marker.content);
      // …and the FIRST remote action of that attempt was the invalidation
      // (behind the same-shell no-follow guard — the only thing allowed to
      // precede it, and it mutates nothing).
      const execs = c
        .argv()
        .filter((a) => a.includes("exec"))
        .map((a) => a.at(-1)!);
      expect(execs[0]).toMatch(/(?:^|\n)rm -f -- '[0-9a-f]{32}\.v1'\n/);

      // A second, NON-delete overlay dies mid-ship: the stale first-ship
      // marker must not survive it.
      writeFileSync(join(local, "extra.txt"), "more\n");
      c.flag("exec-fail-pattern", "tar -xzf");
      try {
        await expect(t.syncUp(local, remote, {})).rejects.toThrow();
      } finally {
        rmSync(join(c.state, "exec-fail-pattern"));
      }
      expect(existsSync(join(remote, marker.rel))).toBe(false);

      // So a mirrored return is refused before a single local byte changes.
      await t.execChecked(`printf planted > ${shq(join(remote, "attacker.txt"))}`);
      await expect(t.syncDown(remote, local, { delete: true })).rejects.toThrow(
        /refusing to mirror deletions/,
      );
      expect(readFileSync(join(local, "precious.txt"), "utf8")).toBe("keep me\n");
      expect(existsSync(join(local, "attacker.txt"))).toBe(false);

      // A fresh successful licensed ship re-earns it; the mirror works again.
      await t.syncUp(local, remote, { license: true });
      expect(readFileSync(join(remote, marker.rel), "utf8")).toBe(marker.content);
      await t.syncDown(remote, local, { delete: true });
      expect(
        readFileSync(join(local, "attacker.txt"), "utf8"),
      ).toBe("planted"); // shipped before the overlay retry
    },
  );

  test(
    "syncLicense proves a landed licensed ship remotely — and never a forged, stale, or absent one",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-lic", c.bin);
      const local = join(c.state, "local-lic");
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "a.txt"), "a\n");
      const remote = join(c.podHome, "data", "ws-lic");

      // never shipped → no license (workspace absent entirely)
      expect(await t.syncLicense(remote)).toBe(false);

      // licensed ship → license proves it landed
      await t.syncUp(local, remote, { license: true });
      expect(await t.syncLicense(remote)).toBe(true);

      // another destination's license never vouches for this one
      expect(await t.syncLicense(join(c.podHome, "data", "ws-other"))).toBe(false);

      // forged content is not a license
      writeFileSync(join(remote, syncMarkerFor(remote).rel), "not the license");
      expect(await t.syncLicense(remote)).toBe(false);

      // an unlicensed overlay invalidates: the retry can no longer skip
      await t.syncUp(local, remote, { license: true });
      expect(await t.syncLicense(remote)).toBe(true);
      await t.syncUp(local, remote, {});
      expect(await t.syncLicense(remote)).toBe(false);
    },
  );

  test(
    "sync-up `delete` refuses with bytes intact — raced .git, excluded data, and beam state " +
      "survive; additive keeps extras",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-nd", c.bin);
      const local = join(c.state, "local-nd");
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "hello.txt"), "hello\n");

      // An owned workspace that grew remote-side state the mirror excludes:
      // a raced .git, an excluded secret, record-bound beam state, a stray.
      const remote = join(c.podHome, "data", "ws-nd");
      await t.syncUp(
        local,
        remote,
        { excludes: ["secret.env", GIT_METADATA_EXCLUDE], license: true },
      );
      mkdirSync(join(remote, ".git"), { recursive: true });
      writeFileSync(join(remote, ".git", "config"), "[core]\n");
      writeFileSync(join(remote, "secret.env"), "remote-secret\n");
      const ownerBytes = `beam-workspace-v1 own1 ${"a".repeat(32)}\n`;
      writeFileSync(join(remote, ".beam", "owner"), ownerBytes);
      writeFileSync(join(remote, "extra.txt"), "extra\n");

      // `delete` refuses BEFORE any remote mutation — not one kubectl call.
      const argvBefore = c.argv().length;
      await expect(
        t.syncUp(local, remote, {
          excludes: ["secret.env", GIT_METADATA_EXCLUDE],
          delete: true,
          license: true,
        }),
      ).rejects.toThrow(/cannot mirror deletions/);
      expect(c.argv().length).toBe(argvBefore);
      expect(readFileSync(join(remote, ".git", "config"), "utf8")).toBe("[core]\n");
      expect(readFileSync(join(remote, "secret.env"), "utf8")).toBe("remote-secret\n");
      expect(readFileSync(join(remote, ".beam", "owner"), "utf8")).toBe(ownerBytes);

      // The additive ship lands new bytes and keeps every extra byte-exact —
      // which is exactly what lets the up-level post-ship fingerprint refuse
      // a dirty reuse instead of silently erasing it.
      writeFileSync(join(local, "new.txt"), "new\n");
      await t.syncUp(
        local,
        remote,
        { excludes: ["secret.env", GIT_METADATA_EXCLUDE], license: true },
      );
      expect(readFileSync(join(remote, "new.txt"), "utf8")).toBe("new\n");
      expect(readFileSync(join(remote, ".git", "config"), "utf8")).toBe("[core]\n");
      expect(readFileSync(join(remote, "secret.env"), "utf8")).toBe("remote-secret\n");
      expect(readFileSync(join(remote, ".beam", "owner"), "utf8")).toBe(ownerBytes);
      expect(readFileSync(join(remote, "extra.txt"), "utf8")).toBe("extra\n");
    },
  );

  test(
    "owned transfers refuse a workspace swapped to a foreign owner — zero bytes copied or deleted",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-owned", c.bin);
      const local = join(c.state, "local-owned");
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "hello.txt"), "hello\n");
      const ws = join(c.podHome, "data", "ws-owned");
      const mine = `beam-workspace-v1 rec1 ${"a".repeat(32)}`;
      const owned = { root: ws, ownerBytes: mine };

      // The up flow establishes ownership before the first transfer; an
      // owned licensed ship then passes its in-shell proof.
      mkdirSync(join(ws, ".beam"), { recursive: true });
      writeFileSync(join(ws, ".beam", "owner"), `${mine}\n`);
      await t.syncUp(local, ws, { license: true, owned: { root: ws, ownerBytes: mine } });
      expect(readFileSync(join(ws, "hello.txt"), "utf8")).toBe("hello\n");

      // Remote work appears; then the REAL DIRECTORY is swapped for another
      // handoff's real workspace immediately before the next transfers.
      writeFileSync(join(ws, "made-remotely.txt"), "theirs\n");
      const aside = join(c.podHome, "data", "ws-owned-aside");
      renameSync(ws, aside);
      mkdirSync(join(ws, ".beam"), { recursive: true });
      writeFileSync(join(ws, ".beam", "owner"), `beam-workspace-v1 other ${"b".repeat(32)}\n`);
      writeFileSync(join(ws, "foreign-data.txt"), "foreign\n");
      const foreignBefore = workspaceReturnFingerprint(ws).digest;
      const localBefore = workspaceReturnFingerprint(local).digest;

      // syncUp refuses in its FIRST remote shell: not even the license
      // invalidation touches a foreign tree.
      await expect(t.syncUp(local, ws, { license: true, owned })).rejects.toThrow(
        /not owned by this handoff/,
      );
      expect(workspaceReturnFingerprint(ws).digest).toBe(foreignBefore); // foreign byte-identical

      // syncDown refuses in the same shell that would read the bytes: the
      // local tree never changes.
      await expect(t.syncDown(ws, local, { owned })).rejects.toThrow(/not owned by this handoff/);
      expect(workspaceReturnFingerprint(local).digest).toBe(localBefore);
      expect(workspaceReturnFingerprint(ws).digest).toBe(foreignBefore);

      // The set-aside original is intact, ownership marker included.
      expect(readFileSync(join(aside, "made-remotely.txt"), "utf8")).toBe("theirs\n");
      expect(readFileSync(join(aside, ".beam", "owner"), "utf8")).toBe(`${mine}\n`);

      // Restored, the same owned credentials work again — including a nested
      // payload dest below the owned root, both directions.
      rmSync(ws, { recursive: true, force: true });
      renameSync(aside, ws);
      const payloadSrc = join(c.state, "payload-owned");
      mkdirSync(payloadSrc, { recursive: true });
      writeFileSync(join(payloadSrc, "HEAD"), "ref: refs/heads/main\n");
      const payloadDest = `${ws}/.beam/git/gen1`;
      await t.syncUp(payloadSrc, payloadDest, { checksum: true, license: true, owned });
      const collected = join(c.state, "collected-owned");
      await t.syncDown(payloadDest, collected, { delete: true, checksum: true, owned });
      expect(workspaceReturnFingerprint(collected).digest).toBe(
        workspaceReturnFingerprint(payloadSrc).digest,
      );

      // A destination outside the owned root refuses locally, before any exec.
      await expect(
        t.syncUp(local, join(c.podHome, "data", "elsewhere"), { owned }),
      ).rejects.toThrow(/not the owned workspace/);
    },
  );

  test(
    "a marker-chain component swapped mid-walk redirects nothing — the held-cwd walk refuses " +
      "outside mutation",
    async () => {
      const c = makeCluster();
      const root = join(c.podHome, "data", "ws-walk");
      mkdirSync(root, { recursive: true });
      const outside = join(c.state, "outside-walk");
      mkdirSync(outside, { recursive: true });

      // Interleave an adversarial swap between the `transport` and
      // `kubectl-synced` component steps of the CREATE walk — the exact
      // window a raced pod process would hit. blocks: [init, .beam,
      // transport, kubectl-synced].
      const blocks = markerWalkBlocks("create");
      const swap = [
        `mv ${shq(join(root, ".beam", "transport"))} ` +
          `${shq(join(root, ".beam", "transport-aside"))}`,
        `ln -s ${shq(outside)} ${shq(join(root, ".beam", "transport"))}`,
      ].join("\n");
      const script = [
        blocks[0]!,
        blocks[1]!,
        blocks[2]!,
        swap,
        blocks[3]!,
        `printf '%s' pwned > marker.v1`,
      ].join("\n");
      const res = await run(["bash", "-c", script], { cwd: root });

      expect(res.code).not.toBe(0); // the physical reproof refused
      expect(readdirSync(outside)).toEqual([]); // zero mutation through the link
      // the relative mkdir landed INSIDE the held (renamed-aside) parent,
      // and the marker write never ran
      expect(existsSync(join(root, ".beam", "transport-aside", "kubectl-synced"))).toBe(true);
      expect(
        existsSync(join(root, ".beam", "transport-aside", "kubectl-synced", "marker.v1")),
      ).toBe(false);

      // a component pre-swapped to a symlink refuses at its no-follow check
      const again = await run(["bash", "-c", markerWalkBlocks("create").join("\n")], { cwd: root });
      expect(again.code).toBe(62);
      expect(readdirSync(outside)).toEqual([]);
    },
  );

  test(
    "owned marker shells are fused — a same-path replacement interposed mid-descent leaves every " +
      "license intact",
    async () => {
      const c = makeCluster();
      const root = join(c.podHome, "data", "ws-mfuse");
      const owner = `beam-workspace-v1 rec1 ${"a".repeat(32)}`;
      const marker = syncMarkerFor(root);
      mkdirSync(join(root, ".beam", "transport", "kubectl-synced"), { recursive: true });
      writeFileSync(join(root, ".beam", "owner"), `${owner}\n`);
      writeFileSync(join(root, marker.rel), "held-tree license");
      const aside = join(c.podHome, "data", "ws-mfuse-aside");

      // Adversary: replace the WHOLE workspace at the same path right after
      // the owner proof — the window the old root-guard-then-marker-walk
      // split left open. blocks: [.beam entry + owner proof, transport,
      // kubectl-synced].
      const blocks = ownedDestinationBlocks(owner, [".beam", "transport", "kubectl-synced"], {
        create: true,
      });
      const swap = [
        `mv ${shq(root)} ${shq(aside)}`,
        `mkdir -p ${shq(join(root, ".beam", "transport", "kubectl-synced"))}`,
        `printf '%s' ${shq("replacement license")} > ${shq(join(root, marker.rel))}`,
      ].join("\n");
      const script = [
        `cd ${shq(root)} || exit 9`,
        blocks[0]!,
        swap,
        ...blocks.slice(1),
        `rm -f -- ${shq(marker.file)}`,
      ].join("\n");
      const res = await run(["bash", "-c", script]);

      expect(res.code).toBe(66); // kernel-truth reproof refused mid-descent
      expect(readFileSync(join(root, marker.rel), "utf8")).toBe(
        "replacement license",
      ); // replacement untouched
      expect(readFileSync(join(aside, marker.rel), "utf8")).toBe(
        "held-tree license",
      ); // held tree untouched too
      expect(readFileSync(join(aside, ".beam", "owner"), "utf8")).toBe(`${owner}\n`);
    },
  );

  test(
    "a permissive umask never leaks reserved metadata modes — Beam-created dirs 0700, license 0600",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-mode", c.bin);
      const local = join(c.state, "local-mode");
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "hello.txt"), "hello\n");
      const modeOf = (p: string): number => statSync(p).mode & 0o777;

      const saved = process.umask(0o022); // the pod-side shells inherit this
      try {
        // Unowned licensed ship: the marker walk creates the whole chain.
        const ws = join(c.podHome, "data", "ws-mode");
        await t.syncUp(local, ws, { license: true });
        expect(modeOf(join(ws, ".beam"))).toBe(0o700);
        expect(modeOf(join(ws, ".beam", "transport"))).toBe(0o700);
        expect(modeOf(join(ws, ".beam", "transport", "kubectl-synced"))).toBe(0o700);
        expect(modeOf(join(ws, syncMarkerFor(ws).rel))).toBe(0o600);

        // Owned nested payload ship: the fused descent creates git/<gen>.
        const owner = `beam-workspace-v1 rec1 ${"a".repeat(32)}`;
        writeFileSync(join(ws, ".beam", "owner"), `${owner}\n`);
        const payloadSrc = join(c.state, "payload-mode");
        mkdirSync(payloadSrc, { recursive: true });
        writeFileSync(join(payloadSrc, "HEAD"), "ref\n");
        const payloadDest = `${ws}/.beam/git/gen1`;
        await t.syncUp(
          payloadSrc,
          payloadDest,
          { checksum: true, license: true, owned: { root: ws, ownerBytes: owner } },
        );
        expect(modeOf(join(ws, ".beam", "git"))).toBe(0o700);
        expect(modeOf(join(ws, ".beam", "git", "gen1"))).toBe(0o700);
        expect(modeOf(join(ws, syncMarkerFor(payloadDest).rel))).toBe(0o600);
      } finally {
        process.umask(saved);
      }
    },
  );

  test(
    "a nested Git payload round-trips byte-exact: license out-of-tree, digests hold with zero " +
      "carve-outs",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-pay", c.bin);
      const ws = join(c.podHome, "data", "ws-pay");
      const local = join(c.state, "local-pay");
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "hello.txt"), "hello\n");
      await t.syncUp(local, ws, { license: true });

      // A materialized Git payload: representative gitdir shape, exact bytes.
      const payloadSrc = join(c.state, "payload-src");
      mkdirSync(join(payloadSrc, "objects", "aa"), { recursive: true });
      mkdirSync(join(payloadSrc, "refs", "heads"), { recursive: true });
      writeFileSync(join(payloadSrc, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(payloadSrc, "config"), "[core]\n\trepositoryformatversion = 0\n");
      writeFileSync(join(payloadSrc, "objects", "aa", "0123deadbeef"), "object-bytes\n");
      writeFileSync(join(payloadSrc, "refs", "heads", "main"), "aa0123deadbeef\n");
      const sourceDigest = workspaceReturnFingerprint(payloadSrc).digest;

      const payloadDest = `${ws}/.beam/git/gen1`;
      await t.syncUp(payloadSrc, payloadDest, { checksum: true, license: true });

      // The shipped tree is byte-identical to the source — the mirror
      // license was NOT injected into it (it lives in the workspace's
      // reserved dir above), so local/remote/collected payload digests can
      // agree without carve-outs.
      expect(workspaceReturnFingerprint(join(ws, ".beam", "git", "gen1")).digest).toBe(
        sourceDigest,
      );
      const marker = syncMarkerFor(payloadDest);
      expect(marker.root).toBe(ws);
      expect(readFileSync(join(ws, marker.rel), "utf8")).toBe(marker.content);

      // Mirrored collection (exactly how beam down fetches the payload)
      // returns the identical tree, byte for byte.
      const collected = join(c.state, "collected-payload");
      await t.syncDown(payloadDest, collected, { delete: true, checksum: true });
      expect(workspaceReturnFingerprint(collected).digest).toBe(sourceDigest);

      // An additive workspace re-ship keeps both the payload and its license.
      await t.syncUp(local, ws, { license: true });
      expect(workspaceReturnFingerprint(join(ws, ".beam", "git", "gen1")).digest).toBe(
        sourceDigest,
      );
      expect(readFileSync(join(ws, marker.rel), "utf8")).toBe(marker.content);
    },
  );

  test(
    "a failed marker invalidation aborts the ship before anything ships — licensed and " +
      "unlicensed alike",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-inv2", c.bin);
      const local = join(c.state, "local-inv2");
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "a.txt"), "a\n");
      const remote = join(c.podHome, "data", "ws-inv2");
      c.flag("exec-fail-pattern", "rm -f");
      try {
        await expect(t.syncUp(local, remote, { license: true })).rejects.toThrow();
        await expect(t.syncUp(local, remote, {})).rejects.toThrow();
      } finally {
        rmSync(join(c.state, "exec-fail-pattern"));
      }
      expect(existsSync(remote)).toBe(false); // nothing ever shipped
      expect(
        c.argv().filter((a) => a.includes("exec")).length,
      ).toBe(2); // only the two failed invalidations ran
    },
  );

  test(
    "marker invalidation refuses a symlinked .beam — nothing is deleted or written through it",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-symb", c.bin);
      const local = join(c.state, "local-symb");
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "a.txt"), "a\n");

      // A reused workspace whose agent swapped .beam for an outward symlink.
      // The outside dir carries the license's EXACT keyed path: an unguarded
      // invalidation would rm it straight through the link.
      const outside = join(c.state, "outside-symb");
      const remote = join(c.podHome, "data", "ws-symb");
      const marker = syncMarkerFor(remote);
      const relInsideBeam = marker.rel.slice(".beam/".length);
      mkdirSync(join(outside, "transport", "kubectl-synced"), { recursive: true });
      writeFileSync(join(outside, relInsideBeam), "beam marker impostor");
      mkdirSync(remote, { recursive: true });
      symlinkSync(outside, join(remote, ".beam"));

      // Licensed and plain ships both refuse at the first remote action.
      await expect(t.syncUp(local, remote, { license: true })).rejects.toThrow(/is a symlink/);
      await expect(t.syncUp(local, remote, {})).rejects.toThrow(/is a symlink/);

      // The outside file survived byte-for-byte, nothing new landed there,
      // the link itself is intact, and nothing ever shipped.
      expect(readdirSync(outside)).toEqual(["transport"]);
      expect(readFileSync(join(outside, relInsideBeam), "utf8")).toBe("beam marker impostor");
      expect(lstatSync(join(remote, ".beam")).isSymbolicLink()).toBe(true);
      expect(readdirSync(remote)).toEqual([".beam"]);
      expect(
        c.argv().filter((a) => a.includes("exec")).length,
      ).toBe(2); // only the two refused invalidations ran
    },
  );

  test(
    "a .beam swapped mid-ship fails the marker creation — no marker lands anywhere and no " +
      "license survives",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-swap", c.bin);
      const local = join(c.state, "local-swap");
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "precious.txt"), "keep me\n");

      const outside = join(c.state, "outside-swap");
      const remote = join(c.podHome, "data", "ws-swap");
      const marker = syncMarkerFor(remote);
      const relInsideBeam = marker.rel.slice(".beam/".length);
      mkdirSync(join(outside, "transport", "kubectl-synced"), { recursive: true });
      writeFileSync(join(outside, relInsideBeam), "sentinel — not a beam marker");

      // The pod agent swaps .beam for an outward symlink right after the tar
      // extraction — between the ship and the marker-creation shell.
      c.flag("exec-hook-pattern", "tar -xzf");
      writeFileSync(
        join(c.state, "exec-hook.sh"),
        `rm -rf ${shq(join(remote, ".beam"))}\n` +
          `ln -s ${shq(outside)} ${shq(join(remote, ".beam"))}\n`,
      );
      try {
        await expect(t.syncUp(local, remote, { license: true })).rejects.toThrow(/is a symlink/);
      } finally {
        rmSync(join(c.state, "exec-hook-pattern"));
        rmSync(join(c.state, "exec-hook.sh"));
      }

      // The creation guard refused: the keyed outside file is unchanged
      // — the license was NOT planted through the link.
      expect(readdirSync(outside)).toEqual(["transport"]);
      expect(readFileSync(join(outside, relInsideBeam), "utf8")).toBe(
        "sentinel — not a beam marker",
      );

      // And the failed attempt left no valid license: a mirrored return
      // refuses before a single local byte changes.
      await expect(t.syncDown(remote, local, { delete: true })).rejects.toThrow(
        /refusing to mirror deletions/,
      );
      expect(readFileSync(join(local, "precious.txt"), "utf8")).toBe("keep me\n");
    },
  );

  test(
    "sync-up refuses a symlinked destination in the same shell as its first remote action — " +
      "nothing ships, no marker lands",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-cap", c.bin);
      const local = join(c.state, "local-cap");
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "payload.txt"), "payload\n");

      // The deterministic workspace path is pre-created as a symlink to a
      // writable directory OUTSIDE the root — the classic trap on a reusable
      // sandbox. tar -C would extract straight through it.
      const outside = join(c.state, "outside-cap");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "sentinel.txt"), "untouched\n");
      mkdirSync(join(c.podHome, "data", "bipa"), { recursive: true });
      const remote = join(c.podHome, "data", "bipa", "ws-cap");
      symlinkSync(outside, remote);

      // Licensed and plain ships both refuse before a single byte moves.
      await expect(t.syncUp(local, remote, { license: true })).rejects.toThrow(/symlinked path/);
      await expect(t.syncUp(local, remote, {})).rejects.toThrow(/symlinked path/);

      // The outside directory holds exactly its sentinel: nothing shipped,
      // nothing deleted, and no sync marker was planted through the link.
      expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
      expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe("untouched\n");
    },
  );

  test("sync-down refuses a symlinked source before any local byte changes", async () => {
    const c = makeCluster();
    const t = cannedTransport("beam-cap2", c.bin);
    const local = join(c.state, "local-cap2");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "precious.txt"), "keep me\n");

    const outside = join(c.state, "outside-cap2");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "foreign.txt"), "not yours\n");
    mkdirSync(join(c.podHome, "data", "bipa"), { recursive: true });
    const remote = join(c.podHome, "data", "bipa", "ws-cap2");
    symlinkSync(outside, remote);

    // Plain and mirrored returns both refuse: a swapped workspace must
    // never be read through, let alone mirrored with --delete.
    await expect(t.syncDown(remote, local, {})).rejects.toThrow(/symlinked path/);
    await expect(t.syncDown(remote, local, { delete: true })).rejects.toThrow();
    expect(readdirSync(local)).toEqual(["precious.txt"]); // nothing landed, nothing deleted
    expect(readFileSync(join(local, "precious.txt"), "utf8")).toBe("keep me\n");
  });

  test(
    "nested sync boundaries refuse a swapped workspace ancestor before reading or deleting " +
      "outside data",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-anc", c.bin);
      const local = join(c.state, "local-ancestor");
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "precious.txt"), "keep\n");

      const workspace = join(c.podHome, "data", "ws-ancestor");
      const oldWorkspace = `${workspace}-old`;
      const outside = join(c.state, "outside-ancestor");
      const nested = join(".beam", "stage");
      mkdirSync(join(workspace, nested), { recursive: true });
      writeFileSync(join(workspace, nested, "owned.txt"), "owned\n");
      mkdirSync(join(outside, nested), { recursive: true });
      writeFileSync(join(outside, nested, "foreign.txt"), "foreign\n");

      // The agent swaps the already-proven workspace between commands. The
      // nested stage/.beam/.git-style path has a real final directory, but an
      // ancestor now redirects it outside the pinned physical pathname.
      renameSync(workspace, oldWorkspace);
      symlinkSync(outside, workspace);
      const remoteNested = join(workspace, nested);

      await expect(t.syncDown(remoteNested, local, {})).rejects.toThrow(
        /pinned physical directory|symlinked path/,
      );
      expect(readdirSync(local)).toEqual(["precious.txt"]);
      expect(readFileSync(join(local, "precious.txt"), "utf8")).toBe("keep\n");

      await expect(t.syncUp(local, remoteNested, {})).rejects.toThrow(
        /pinned physical directory|symlinked path/,
      );
      expect(readFileSync(join(outside, nested, "foreign.txt"), "utf8")).toBe("foreign\n");
      expect(existsSync(join(outside, nested, "precious.txt"))).toBe(false);
    },
  );

  test(
    "exec reports the real remote exit status — kubectl succeeds only after the trailer lands",
    async () => {
      const c = makeCluster();
      const t = cannedTransport("beam-rc", c.bin);

      // Real remote failures keep their exit codes — never converted to throws.
      expect((await t.exec("exit 1")).code).toBe(1);
      const multi = await t.exec("printf out; printf err >&2; exit 3");
      expect(multi).toEqual({ code: 3, stdout: "out", stderr: "err" });
      // A bare `exit` cannot skip the trailer (the no-follow guards exit 61).
      expect((await t.exec("exit 61")).code).toBe(61);

      // stdout comes back byte-exact, trailing newline or not, trailer stripped.
      const nl = await t.exec("echo hi");
      expect(nl).toEqual({ code: 0, stdout: "hi\n", stderr: "" });
      const bare = await t.exec("printf '%s' 'no trailing newline'");
      expect(bare.stdout).toBe("no trailing newline");
      expect((await t.exec("true")).stdout).toBe("");
      expect(multi.stdout).not.toContain("__beam_rc");

      // execChecked still reports the ORIGINAL command on a remote failure.
      await expect(t.execChecked("printf nope >&2; exit 7")).rejects.toThrow(
        /command failed \(7\)/,
      );
    },
  );

  test("kubectl/API failure is a thrown transport error, never a remote exit code", async () => {
    // A kubectl that dies before the remote shell ever runs — the classic
    // `unable to upgrade connection` API failure, local exit 1, which the
    // unwrapped transport used to hand back as a remote {code: 1}.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "beam-kubectl-apifail-")));
    const bin = join(dir, "kubectl");
    writeFileSync(
      bin,
      `#!/bin/bash\n` +
        `echo 'error: unable to upgrade connection: container not found ("sandbox")' >&2\n` +
        `exit 1\n`,
    );
    chmodSync(bin, 0o755);
    const t = cannedTransport("beam-af", bin);

    // exec throws with kubectl's own stderr instead of returning {code: 1}…
    await expect(t.exec("HERDR_SESSION='beam-x' herdr pane list")).rejects.toThrow(
      /unable to upgrade connection/,
    );
    // …so exists() can never read an unanswerable probe as "absent"…
    await expect(t.exists("/data/beam/ws")).rejects.toThrow(/kubectl exit 1/);
    // …and the herdr liveness probe aborts reused-up instead of reporting a
    // dead session (which would greenlight destructive follow-ons).
    const rt = new HerdrRuntime(t);
    await expect(rt.alive("beam-x")).rejects.toThrow(/unable to upgrade connection/);
  });

  test(
    "a truncated exec stream — kubectl exit 0 without the trailer — is a transport error",
    async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "beam-kubectl-trunc-")));
      const bin = join(dir, "kubectl");
      writeFileSync(bin, `#!/bin/bash\nprintf 'partial output\\n'\nexit 0\n`);
      chmodSync(bin, 0o755);
      const t = cannedTransport("beam-tr", bin);
      await expect(t.exec("true")).rejects.toThrow(/trailer is missing or malformed/);
    },
  );

  test("trailer exit codes are one byte: 255 lands, bigger forms refuse", async () => {
    const c = makeCluster();
    const coords = { context: "ctx", namespace: "ns", container: "sandbox" };
    const t = new KubectlTransport(coords, "beam-rc255", c.bin);
    // Max valid: a real shell can report exactly 255 — it must land as-is.
    expect((await t.exec("exit 255")).code).toBe(255);

    // A fake kubectl that lifts the per-call nonce out of the wrapped
    // command and reports an impossible status: past the 0..255 byte
    // range, or too many digits for an exact JS integer. Both are forged
    // or corrupt streams and must refuse exactly like a missing trailer —
    // never come back as a trusted remote exit code.
    for (const forged of ["256", "99999999999999999999"]) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "beam-kubectl-forge-")));
      const bin = join(dir, "kubectl");
      writeFileSync(
        bin,
        `#!/bin/bash\nfor a in "$@"; do last="$a"; done\n` +
          `t=$(printf '%s' "$last" | grep -o '__beam_rc_[0-9a-f]*:' | head -n1)\n` +
          `printf '\\n%s${forged}\\n' "$t"\nexit 0\n`,
      );
      chmodSync(bin, 0o755);
      const ft = new KubectlTransport(coords, "beam-forge", bin);
      await expect(ft.exec("true")).rejects.toThrow(/trailer is missing or malformed/);
    }
  });

  describe.skipIf(Bun.which("herdr") === null)("herdr liveness over kubectl exec", () => {
    test(
      "a real server_not_running exit 1 means not-alive — the one refusal that says no",
      async () => {
        const c = makeCluster();
        const t = cannedTransport("beam-tl", c.bin);
        // Throwaway remote HOME with no server: herdr itself answers pane
        // list with a machine-readable server_not_running error and exit 1,
        // which must come back as a calm `false` (absence proven).
        const rt = new HerdrRuntime(t);
        expect(await rt.alive("beam-nope")).toBe(false);
      },
      30_000,
    );
  });
});

describe("agent-sandbox commands (canned kubectl on PATH)", () => {
  let c: Cluster;
  let home: string;
  let beamDir: string;
  let workDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  let savedCwd: string;

  beforeAll(() => {
    savedCwd = process.cwd();
    for (const k of ["BEAM_HOME", "BEAM_DIR", "PATH"]) savedEnv[k] = process.env[k];
    c = makeCluster();
    home = realpathSync(mkdtempSync(join(tmpdir(), "beam-k8s-home-")));
    beamDir = join(home, ".beam");
    workDir = join(home, "work", "app");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(beamDir, { recursive: true });
    writeFileSync(join(workDir, "hello.txt"), "hello\n");
    writeFileSync(
      join(beamDir, "config.json"),
      JSON.stringify({
        defaultTarget: "k8s",
        targets: {
          k8s: {
            type: "agent-sandbox",
            context: "gke_test_ctx",
            namespace: "beam-luiz",
            template: "beam-coding",
            kubeconfig: "/kube/beam-user.kubeconfig",
            root: join(c.podHome, "data", "bipa"),
          },
        },
      }),
    );
    process.env.PATH = `${c.binDir}:${process.env.PATH}`;
    process.env.BEAM_HOME = home;
    process.env.BEAM_DIR = beamDir;
    process.chdir(workDir);
  });

  afterAll(() => {
    process.chdir(savedCwd);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test(
    "up --no-start completes; a blind re-up refuses (completed handoffs collect first) " +
      "with no duplicate record or claim",
    async () => {
      await cmdUp(["--no-session", "--no-start"]);
      let records = loadState(resolveEnv()).records;
      expect(records.length).toBe(1);
      const id = records[0]!.id;
      expect(records[0]!.sandbox?.claim).toBe(`beam-${id}`);
      expect(records[0]!.sandbox?.container).toBe("sandbox");
      expect(readdirSync(c.claims)).toEqual([`beam-${id}`]);

      const wsDirs = readdirSync(join(c.podHome, "data", "bipa"));
      expect(wsDirs.length).toBe(1);
      expect(readFileSync(join(c.podHome, "data", "bipa", wsDirs[0]!, "hello.txt"), "utf8")).toBe(
        "hello\n",
      );

      // A completed up may hold remote-only work: a blind re-ship refuses
      // (collect with down, or retire with kill --purge) — and the refusal
      // creates nothing: same record, same claim, nothing duplicated.
      await expect(cmdUp(["--no-session", "--no-start"])).rejects.toThrow(/already up on k8s/);
      records = loadState(resolveEnv()).records;
      expect(records.length).toBe(1);
      expect(records[0]!.id).toBe(id);
      expect(readdirSync(c.claims)).toEqual([`beam-${id}`]);
      expect(records[0]!.remoteCwd).toBe(join(c.podHome, "data", "bipa", wsDirs[0]!));
    },
    30000,
  );

  test(
    "a default down retains the record; a re-up still refuses with the single record and claim " +
      "intact",
    async () => {
      const record = loadState(resolveEnv()).records[0]!;
      await cmdDown([record.id]);
      expect(existsSync(join(c.claims, agentSandboxState(record.sandbox).claim))).toBe(true);
      expect(loadState(resolveEnv()).records[0]!.status).toBe("up");

      await expect(cmdUp(["--no-session", "--no-start"])).rejects.toThrow(/already up on k8s/);
      const records = loadState(resolveEnv()).records;
      expect(records.length).toBe(1);
      expect(records[0]!.id).toBe(record.id);
      expect(readdirSync(c.claims)).toEqual([agentSandboxState(record.sandbox).claim]);
    },
  );

  test(
    "kill without purge keeps the record retained; a re-up refuses with the single claim intact",
    async () => {
      const record = loadState(resolveEnv()).records[0]!;
      await cmdKill([record.id]);
      expect(existsSync(join(c.claims, agentSandboxState(record.sandbox).claim))).toBe(true);
      expect(loadState(resolveEnv()).records[0]!.status).toBe("up");

      await expect(cmdUp(["--no-session", "--no-start"])).rejects.toThrow(/already up on k8s/);
      const records = loadState(resolveEnv()).records;
      expect(records.length).toBe(1);
      expect(records[0]!.id).toBe(record.id);
      expect(readdirSync(c.claims)).toEqual([agentSandboxState(record.sandbox).claim]);
    },
  );

  test("down stages the return and retains the claim for explicit kill", async () => {
    const record = loadState(resolveEnv()).records[0]!;
    writeFileSync(join(record.remoteCwd, "made-remotely.txt"), "theirs\n");
    await cmdDown([record.id]);
    expect(existsSync(join(workDir, "made-remotely.txt"))).toBe(false);
    expect(
      readFileSync(join(latestReturnWorkspace(beamDir, record.id), "made-remotely.txt"), "utf8"),
    ).toBe("theirs\n");
    expect(existsSync(join(c.claims, agentSandboxState(record.sandbox).claim))).toBe(true);
    expect(loadState(resolveEnv()).records[0]!.status).toBe("up");
    expect(
      c.argv().some(
        (a) =>
          a.includes("delete") &&
          a.some((el) => el.includes(agentSandboxState(record.sandbox).claim)),
      ),
    ).toBe(false);
  });

  test("a failed sync-back keeps the claim and the record stays up", async () => {
    const record = loadState(resolveEnv()).records.find((r) => r.status === "up")!;
    c.flag("exec-fail-pattern", "tar -czf");
    try {
      await expect(cmdDown([record.id])).rejects.toThrow();
    } finally {
      rmSync(join(c.state, "exec-fail-pattern"));
    }
    // The failed return preserves the claim.
    expect(
      existsSync(join(c.claims, agentSandboxState(record.sandbox).claim)),
    ).toBe(true);
    expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
    const dels = c
      .argv()
      .filter(
        (a) =>
          (a.includes("delete") || a.includes("--raw")) &&
          a.some((el) => el.includes(agentSandboxState(record.sandbox).claim)),
      );
    expect(dels.length).toBe(0); // no teardown after a failure
  });
});

describe("claim identity refusal across commands (canned kubectl on PATH)", () => {
  let c: Cluster;
  let home: string;
  let beamDir: string;
  let workDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  let savedCwd: string;

  beforeAll(() => {
    savedCwd = process.cwd();
    for (const k of ["BEAM_HOME", "BEAM_DIR", "PATH"]) savedEnv[k] = process.env[k];
    c = makeCluster();
    home = realpathSync(mkdtempSync(join(tmpdir(), "beam-k8s-idhome-")));
    beamDir = join(home, ".beam");
    workDir = join(home, "work", "app");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(beamDir, { recursive: true });
    writeFileSync(join(workDir, "hello.txt"), "hello\n");
    writeFileSync(
      join(beamDir, "config.json"),
      JSON.stringify({
        defaultTarget: "k8s",
        targets: {
          k8s: {
            type: "agent-sandbox",
            context: "gke_test_ctx",
            namespace: "beam-luiz",
            template: "beam-coding",
            kubeconfig: "/kube/beam-user.kubeconfig",
            root: join(c.podHome, "data", "bipa"),
          },
        },
      }),
    );
    process.env.PATH = `${c.binDir}:${process.env.PATH}`;
    process.env.BEAM_HOME = home;
    process.env.BEAM_DIR = beamDir;
    process.chdir(workDir);
  });

  afterAll(() => {
    process.chdir(savedCwd);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test(
    "up persists the claim UID; a replaced claim refuses down/attach/login/kill --purge/up with " +
      "no exec, no delete",
    async () => {
      await cmdUp(["--no-session", "--no-start"]);
      const record = loadState(resolveEnv()).records[0]!;
      const claimFile = join(c.claims, agentSandboxState(record.sandbox).claim);
      const stored = JSON.parse(readFileSync(claimFile, "utf8")) as { metadata: { uid: string } };
      // `beam up` persisted the created claim's server-assigned UID.
      expect(record.sandbox!.uid).toBe(stored.metadata.uid);

      // Out-of-band delete + recreate: same name/label/template, new UID.
      stored.metadata.uid = "replacement-uid";
      writeFileSync(claimFile, JSON.stringify(stored));

      const argvBefore = c.argv().length;
      await expect(cmdDown([record.id])).rejects.toThrow(/is not the one this record created/);
      await expect(cmdAttach([record.id])).rejects.toThrow(/is not the one this record created/);
      await expect(cmdLogin(["k8s", "--tool", "claude"])).rejects.toThrow(
        /is not the one this record created/,
      );
      // kill --purge cannot prove the (shipped) workspace erasure through a
      // claim beam refuses to connect to — fail closed, record and claim intact.
      await expect(cmdKill([record.id, "--purge"])).rejects.toThrow(/refusing to delete the claim/);
      // Re-shipping through the record refuses the impostor instead of
      // adopting it (kept last: a refused up may re-journal `provisioning`).
      await expect(cmdUp(["--no-session", "--no-start"])).rejects.toThrow(
        /is not the one this record created/,
      );

      const delta = c.argv().slice(argvBefore);
      expect(delta.some((a) => a.includes("exec"))).toBe(false); // nothing was ever exec'd
      expect(delta.some((a) => a.includes("--raw"))).toBe(false); // nothing was ever deleted
      expect(delta.some((a) => a.includes("delete") && !a.includes("can-i"))).toBe(false);
      expect(existsSync(claimFile)).toBe(true); // the replacement claim survived
      // The record never lied its way into a terminal state.
      expect(["down", "killed"]).not.toContain(loadState(resolveEnv()).records[0]!.status);
    },
    30000,
  );
});

describe("agent-sandbox target validation", () => {
  test(
    "kubeconfig is required and must be non-empty — the ambient kubeconfig is never a fallback",
    () => {
      expect(() => new AgentSandboxProvider(makeSpec({ kubeconfig: "" }))).toThrow(/kubeconfig/);
      expect(() => new AgentSandboxProvider(makeSpec({ kubeconfig: "   " }))).toThrow(/kubeconfig/);
      const missing = { ...makeSpec() } as Record<string, unknown>;
      delete missing.kubeconfig;
      expect(() => new AgentSandboxProvider(missing as unknown as AgentSandboxTargetSpec)).toThrow(
        /kubeconfig/,
      );
    },
  );

  test("namespace and container must be DNS labels", () => {
    expect(() => new AgentSandboxProvider(makeSpec({ namespace: "Bad_NS" }))).toThrow(/DNS label/);
    expect(() => new AgentSandboxProvider(makeSpec({ namespace: "-leading" }))).toThrow(
      /DNS label/,
    );
    expect(() => new AgentSandboxProvider(makeSpec({ container: "UPPER" }))).toThrow(/DNS label/);
  });

  test("template must be a DNS subdomain — a leading dash can never become a kubectl flag", () => {
    expect(() => new AgentSandboxProvider(makeSpec({ template: "-oyaml" }))).toThrow(
      /DNS subdomain/,
    );
    expect(() => new AgentSandboxProvider(makeSpec({ template: "bad..dots" }))).toThrow(
      /DNS subdomain/,
    );
    expect(
      () => new AgentSandboxProvider(makeSpec({ template: "ok.sub-domain.v1" })),
    ).not.toThrow();
  });
});

describe("agent-sandbox purge cleans the harness session store (persistent-home templates)", () => {
  let c: Cluster;
  let home: string;
  let workDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  let savedCwd: string;
  let seq = 0;

  beforeAll(() => {
    savedCwd = process.cwd();
    for (const k of ["BEAM_HOME", "BEAM_DIR", "PATH"]) savedEnv[k] = process.env[k];
    c = makeCluster();
    home = realpathSync(mkdtempSync(join(tmpdir(), "beam-k8s-codex-")));
    const beamDir = join(home, ".beam");
    workDir = join(home, "work", "app");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(beamDir, { recursive: true });
    writeFileSync(join(workDir, "hello.txt"), "hello\n");
    writeFileSync(
      join(beamDir, "config.json"),
      JSON.stringify({
        defaultTarget: "k8s",
        targets: {
          k8s: {
            type: "agent-sandbox",
            context: "gke_test_ctx",
            namespace: "beam-luiz",
            template: "beam-coding",
            kubeconfig: "/kube/beam-user.kubeconfig",
            root: join(c.podHome, "data", "bipa"),
          },
        },
      }),
    );
    process.env.PATH = `${c.binDir}:${process.env.PATH}`;
    process.env.BEAM_HOME = home;
    process.env.BEAM_DIR = beamDir;
    process.chdir(workDir);
  });

  afterAll(() => {
    process.chdir(savedCwd);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /**
   * Ship a codex session: its store rides OUTSIDE the workspace (under the
   * pod home), exactly the artifact that outlives claim deletion on a
   * persistent-home template — the case cleanupRemote exists for.
   */
  async function upWithCodexSession(): Promise<{ remoteStore: string }> {
    seq += 1;
    const day = join(home, ".codex", "sessions", "2026", "08", "15");
    mkdirSync(day, { recursive: true });
    const name = `rollout-2026-08-15T10-0${seq}-cx${seq}.jsonl`;
    writeFileSync(
      join(day, name),
      JSON.stringify({ type: "session_meta", payload: { session_id: `cx${seq}`, cwd: workDir } }) +
        "\n",
    );
    await cmdUp(["--no-start", "--tool", "codex"]);
    return { remoteStore: join(c.podHome, ".codex", "sessions", "2026", "08", "15", name) };
  }

  test("down stages the return but retains workspace, session store, and claim", async () => {
    const { remoteStore } = await upWithCodexSession();
    expect(existsSync(remoteStore)).toBe(true);
    const record = loadState(resolveEnv()).records.at(-1)!;
    const argvBefore = c.argv().length;
    await cmdDown([record.id]);
    expect(existsSync(remoteStore)).toBe(true);
    expect(existsSync(record.remoteCwd)).toBe(true);
    expect(existsSync(join(c.claims, agentSandboxState(record.sandbox).claim))).toBe(true);
    expect(loadState(resolveEnv()).records.at(-1)!.status).toBe("up");
    const delta = c.argv().slice(argvBefore).map((a) => a.join(" "));
    expect(delta.some((a) => a.includes("rm -rf") && a.includes(record.remoteCwd))).toBe(false);
    expect(
      delta.some(
        (a) =>
          a.includes("delete") &&
          a.includes(agentSandboxState(record.sandbox).claim),
      ),
    ).toBe(false);
    await cmdKill([record.id, "--purge"]);
    expect(loadState(resolveEnv()).records.at(-1)!.status).toBe("killed");
  }, 30000);

  test(
    "kill --purge erases the workspace and the session store before deleting the claim",
    async () => {
      const { remoteStore } = await upWithCodexSession();
      expect(existsSync(remoteStore)).toBe(true);
      const record = loadState(resolveEnv()).records.at(-1)!;
      await cmdKill([record.id, "--purge"]);
      expect(existsSync(remoteStore)).toBe(false);
      expect(existsSync(record.remoteCwd)).toBe(false);
      expect(existsSync(join(c.claims, agentSandboxState(record.sandbox).claim))).toBe(false);
      expect(loadState(resolveEnv()).records.at(-1)!.status).toBe("killed");
    },
    30000,
  );
});

describe("handoff state machine (canned kubectl on PATH)", () => {
  let c: Cluster;
  let home: string;
  let beamDir: string;
  let workDir: string;
  let otherDir: string;
  let kubeconfig: string;
  const savedEnv: Record<string, string | undefined> = {};
  let savedCwd: string;

  const targetConfig = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      defaultTarget: "k8s",
      targets: {
        k8s: {
          type: "agent-sandbox",
          context: "gke_test_ctx",
          namespace: "beam-luiz",
          template: "beam-coding",
          kubeconfig,
          root: join(c.podHome, "data", "bipa"),
          ...overrides,
        },
      },
    });

  beforeAll(() => {
    savedCwd = process.cwd();
    for (const k of ["BEAM_HOME", "BEAM_DIR", "PATH"]) savedEnv[k] = process.env[k];
    c = makeCluster();
    home = realpathSync(mkdtempSync(join(tmpdir(), "beam-sm-home-")));
    beamDir = join(home, ".beam");
    workDir = join(home, "work", "app");
    otherDir = join(home, "work", "other");
    kubeconfig = join(c.state, "kubeconfig");
    writeFileSync(kubeconfig, "beam-user-kubeconfig\n");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    mkdirSync(beamDir, { recursive: true });
    writeFileSync(join(workDir, "hello.txt"), "hello\n");
    writeFileSync(join(otherDir, "other.txt"), "other\n");

    // omp session fixture in the local store (dashed home-relative dir)
    const storeDir = join(home, ".omp", "agent", "sessions", "-work-app");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(
      join(storeDir, "2026-08-10T10-00-00-000Z_sm-session.jsonl"),
      `{"type":"session","version":3,"id":"sm-session","timestamp":"t","cwd":"${workDir}"}\n`,
    );

    writeFileSync(join(beamDir, "config.json"), targetConfig());
    process.env.PATH = `${c.binDir}:${process.env.PATH}`;
    process.env.BEAM_HOME = home;
    process.env.BEAM_DIR = beamDir;
    process.chdir(workDir);
  });

  afterAll(() => {
    process.chdir(savedCwd);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test(
    "a provision failure leaves a `provisioning` record that already carries the session identity",
    async () => {
      c.flag("wait-fail");
      try {
        await expect(cmdUp(["--no-start", "-m", "carry on"])).rejects.toThrow(
          /did not become Ready/,
        );
      } finally {
        rmSync(join(c.state, "wait-fail"));
      }
      const records = loadState(resolveEnv()).records;
      expect(records.length).toBe(1);
      const r = records[0]!;
      expect(r.status).toBe("provisioning");
      expect(r.tool).toBe("omp");
      expect(r.sessionId).toBe("sm-session");
      expect(r.sessionFile).toContain("sm-session.jsonl");
      expect(r.kickoff).toBe("carry on");
      expect(r.targetSpec).toMatchObject({ type: "agent-sandbox", namespace: "beam-luiz" });
      expect(r.sandbox?.claim).toBe(`beam-${r.id}`);
      expect(r.exclusiveTarget).toBe(true); // policy persisted: survives config drift
      expect(r.remoteCwdResolved).toBe(false); // pwd never ran — nothing shipped
      expect(existsSync(join(c.claims, `beam-${r.id}`))).toBe(true); // claim kept for the retry
      // The UID pin reached state.json BEFORE the failed Ready wait: every
      // later command — the retry included — binds to exactly this claim
      // object, never merely its (reusable) name.
      const stored = JSON.parse(readFileSync(join(c.claims, `beam-${r.id}`), "utf8")) as {
        metadata: { uid: string };
      };
      expect(r.sandbox?.uid).toBe(stored.metadata.uid);
    },
  );

  test(
    "a retried up resumes the provisioning record and finishes it — no duplicate record or claim",
    async () => {
      await cmdUp(["--no-start"]);
      const records = loadState(resolveEnv()).records;
      expect(records.length).toBe(1);
      const r = records[0]!;
      expect(r.status).toBe("up");
      expect(readdirSync(c.claims)).toEqual([`beam-${r.id}`]);
      expect(
        r.remoteCwd.startsWith(join(c.podHome, "data", "bipa")),
      ).toBe(true); // resolved, persisted
      expect(r.remoteCwdResolved).toBe(true);
      // The retry reused the claim through the UID pin persisted by the failed
      // attempt — and the finished record still carries that exact identity.
      const stored = JSON.parse(readFileSync(join(c.claims, `beam-${r.id}`), "utf8")) as {
        metadata: { uid: string };
      };
      expect(r.sandbox?.uid).toBe(stored.metadata.uid);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  test(
    "config drift (root/context/namespace/template) cannot redirect a reused handoff",
    async () => {
      const before = loadState(resolveEnv()).records[0]!;
      const driftedRoot = join(c.podHome, "data", "drifted");
      writeFileSync(
        join(beamDir, "config.json"),
        targetConfig({
          context: "other-ctx",
          namespace: "elsewhere",
          template: "other-template",
          root: driftedRoot,
        }),
      );
      const argvBefore = c.argv().length;
      // No --no-session: this record shipped sm-session, and clearing the
      // sole identity of a shipped record is refused — omitted args retain it.
      // A completed up refuses a blind re-ship — but the refusal flow itself
      // (provision reuse, connect, liveness) must run pinned to the RECORDED
      // coordinates, never the drifted config.
      await expect(cmdUp(["--no-start"])).rejects.toThrow(/already up on k8s/);
      const after = loadState(resolveEnv()).records[0]!;
      expect(after.id).toBe(before.id);
      expect(after.remoteCwd).toBe(before.remoteCwd); // snapshot root sticks
      expect(existsSync(driftedRoot)).toBe(false); // nothing shipped to the drifted root
      for (const argv of c.argv().slice(argvBefore)) {
        // every kubectl call stays pinned to the recorded coordinates
        expect(argv.join(" ")).not.toContain("elsewhere");
        expect(argv.join(" ")).not.toContain("other-ctx");
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  test(
    "a completed layout-change refusal runs before recreating a missing sandbox claim",
    async () => {
      if (loadState(resolveEnv()).records.length === 0) await cmdUp(["--no-start"]);
      const record = loadState(resolveEnv()).records[0]!;
      expect(record.wtGit).toBeUndefined();
      const claimPath = join(c.claims, agentSandboxState(record.sandbox).claim);
      const claimBytes = readFileSync(claimPath);
      rmSync(claimPath);
      await runChecked(["git", "-C", workDir, "init", "-q", "-b", "main"]);
      const argvBefore = c.argv().length;
      try {
        await expect(cmdUp(["--no-start"])).rejects.toThrow(
          /re-shipping across a Git layout change/,
        );
        expect(existsSync(claimPath)).toBe(false);
        expect(
          c
            .argv()
            .slice(argvBefore)
            .some((argv) => argv.includes("create") && argv.includes("-f")),
        ).toBe(false);
        const after = loadState(resolveEnv()).records[0]!;
        expect(after.status).toBe("up");
        expect(after.wtGit).toBeUndefined();
        expect(after.sandbox).toEqual(record.sandbox);
      } finally {
        rmSync(join(workDir, ".git"), { recursive: true, force: true });
        writeFileSync(claimPath, claimBytes);
        updateRecord(resolveEnv(), record.id, { sandbox: record.sandbox, status: "up" });
      }
    },
  );

  test(
    "a second workspace is refused while the target is held — no second record or claim",
    async () => {
      const active = loadState(resolveEnv()).records[0]!;
      process.chdir(otherDir);
      try {
        await expect(cmdUp(["--no-session", "--no-start"])).rejects.toThrow(
          new RegExp(`already held by handoff ${active.id}`),
        );
      } finally {
        process.chdir(workDir);
      }
      expect(loadState(resolveEnv()).records.length).toBe(1);
      expect(readdirSync(c.claims)).toEqual([agentSandboxState(active.sandbox).claim]);
    },
  );

  test(
    "agent→static drift cannot create a second record: the live claim keeps its target-wide hold",
    async () => {
      const active = loadState(resolveEnv()).records[0]!;
      const staticRoot = join(home, "static-root");
      writeFileSync(
        join(beamDir, "config.json"),
        JSON.stringify({
          defaultTarget: "k8s",
          targets: { k8s: { type: "local", root: staticRoot } },
        }),
      );
      try {
        // Another workspace: the drifted (non-exclusive) config must not slip
        // past the live agent-sandbox record's hold.
        process.chdir(otherDir);
        try {
          await expect(cmdUp(["--no-session", "--no-start"])).rejects.toThrow(
            new RegExp(`already held by handoff ${active.id}`),
          );
        } finally {
          process.chdir(workDir);
        }
        expect(loadState(resolveEnv()).records.length).toBe(1);

        // The owning workspace resumes its record, which stays bound to the
        // agent-sandbox snapshot — the re-ship refuses (completed handoffs
        // collect first), and nothing lands under the drifted local root.
        // Omitted session args: the shipped record retains sm-session
        // (--no-session would be a refused identity clear).
        await expect(cmdUp(["--no-start"])).rejects.toThrow(/already up on k8s/);
        const after = loadState(resolveEnv()).records;
        expect(after.length).toBe(1);
        expect(after[0]!.id).toBe(active.id);
        expect(after[0]!.remoteCwd).toBe(active.remoteCwd);
        expect(existsSync(staticRoot)).toBe(false);
      } finally {
        writeFileSync(join(beamDir, "config.json"), targetConfig());
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  test(
    "an interrupted claim DELETE parks kill in `killing`; kill --purge retries destroy only",
    async () => {
      const record = loadState(resolveEnv()).records[0]!;
      c.flag("delete-fail");
      try {
        await expect(cmdKill([record.id, "--purge"])).rejects.toThrow();
      } finally {
        rmSync(join(c.state, "delete-fail"));
      }
      expect(loadState(resolveEnv()).records[0]!.status).toBe("killing");
      expect(existsSync(join(c.claims, agentSandboxState(record.sandbox).claim))).toBe(true);

      // The DELETE had actually been acknowledged server-side (claim gone),
      // so the retry repeats provider destroy only and never reconnects.
      rmSync(join(c.claims, agentSandboxState(record.sandbox).claim));
      const argvBefore = c.argv().length;
      await cmdKill([record.id, "--purge"]);
      expect(loadState(resolveEnv()).records[0]!.status).toBe("killed");
      const delta = c.argv().slice(argvBefore);
      expect(delta.some((a) => a.includes("exec"))).toBe(false);
      expect(
        delta.some((a) => a.includes("get") && a.some((el) => el.includes("sandboxclaims"))),
      ).toBe(true);
      expect(
        delta.some((a) => a.includes("get") && (a.includes("pod") || a.includes("pods"))),
      ).toBe(false);
      expect(delta.some((a) => a.includes("--raw"))).toBe(false);
    },
  );

  test(
    "a legacy record without a spec snapshot: remote/destructive ops refuse with zero provider " +
      "effects; status labels it",
    async () => {
      // Hand-written by an older beam: no targetSpec. The config's "k8s"
      // entry may have been repointed at a different machine since, so no
      // command may connect to or destroy anything through it.
      const env = resolveEnv();
      const statePath = join(beamDir, "state.json");
      const state = JSON.parse(readFileSync(statePath, "utf8")) as { records: unknown[] };
      state.records.push({
        id: "legacy1",
        target: "k8s",
        localCwd: workDir,
        remoteCwd: join(c.podHome, "data", "bipa", "legacy-ws"),
        runtimeSession: "beam-legacy1",
        status: "up",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

      const argvBefore = c.argv().length;
      await expect(cmdDown(["legacy1"])).rejects.toThrow(/predates recorded target specs/);
      await expect(cmdKill(["legacy1", "--purge"])).rejects.toThrow(
        /predates recorded target specs/,
      );
      await expect(cmdAttach(["legacy1"])).rejects.toThrow(/predates recorded target specs/);
      await cmdStatus(["legacy1"]); // read-only: labels unresolved, never connects
      expect(c.argv().length).toBe(argvBefore); // zero transport/provider effects
      expect(
        loadState(env).records.find((r) => r.id === "legacy1")!.status,
      ).toBe("up"); // untouched
    },
  );
});

describe("concurrent same-workspace up (two beam processes)", () => {
  interface RaceUpFixture {
    c: Cluster;
    home: string;
    beamDir: string;
    workDir: string;
  }

  /** One canned cluster, one shared workspace, and two contender session identities. */
  function raceUpFixture(): RaceUpFixture {
    const c = makeCluster();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "beam-race-home-")));
    const beamDir = join(home, ".beam");
    const workDir = join(home, "work", "app");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(beamDir, { recursive: true });
    writeFileSync(join(workDir, "hello.txt"), "hello\n");
    // Two distinct local sessions: each contender ships its own identity,
    // so the surviving record tells us exactly whose effects won.
    const storeDir = join(home, ".omp", "agent", "sessions", "-work-app");
    mkdirSync(storeDir, { recursive: true });
    for (const ref of ["race-a", "race-b"]) {
      writeFileSync(
        join(storeDir, `2026-08-10T10-00-00-000Z_${ref}.jsonl`),
        `{"type":"session","version":3,"id":"${ref}","timestamp":"t","cwd":"${workDir}"}\n`,
      );
    }
    writeFileSync(
      join(beamDir, "config.json"),
      JSON.stringify({
        defaultTarget: "k8s",
        targets: {
          k8s: {
            type: "agent-sandbox",
            context: "gke_test_ctx",
            namespace: "beam-luiz",
            template: "beam-coding",
            kubeconfig: "/kube/beam-user.kubeconfig",
            root: join(c.podHome, "data", "bipa"),
          },
        },
      }),
    );
    // Hold the winner inside provisioning long enough that the loser's
    // attempt genuinely overlaps the winner's remote-effect window.
    c.flag("wait-sleep", "2");
    return { c, home, beamDir, workDir };
  }

  interface RaceUpOutcome {
    codeA: number;
    codeB: number;
    outA: string;
    outB: string;
    errA: string;
    errB: string;
  }

  /** Spawn both contenders against a spin barrier; collect exit codes and streams. */
  async function raceUpContenders(fx: RaceUpFixture): Promise<RaceUpOutcome> {
    const goFile = join(fx.home, "go");
    const script = join(fx.home, "up-child.ts");
    const upPath = join(import.meta.dirname, "..", "src", "commands", "up.ts");
    writeFileSync(
      script,
      `
import { existsSync } from "node:fs";
import { cmdUp } from ${JSON.stringify(upPath)};
const [goFile, sessionRef] = process.argv.slice(2);
// Spin barrier: released only after both contenders are running.
while (!existsSync(goFile)) {}
try {
  await cmdUp(["--no-start", "--session", sessionRef]);
  console.log("WON " + sessionRef);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(3);
}
`,
    );
    const spawnChild = (ref: string) =>
      Bun.spawn([process.execPath, script, goFile, ref], {
        cwd: fx.workDir,
        env: {
          ...process.env,
          BEAM_HOME: fx.home,
          BEAM_DIR: fx.beamDir,
          PATH: `${fx.c.binDir}:${process.env.PATH}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    const a = spawnChild("race-a");
    const b = spawnChild("race-b");
    writeFileSync(goFile, ""); // release the barrier
    const [codeA, codeB] = await Promise.all([a.exited, b.exited]);
    const [outA, outB, errA, errB] = await Promise.all([
      new Response(a.stdout).text(),
      new Response(b.stdout).text(),
      new Response(a.stderr).text(),
      new Response(b.stderr).text(),
    ]);
    return { codeA, codeB, outA, outB, errA, errB };
  }

  test(
    "exactly one process owns the remote effects and the persisted session identity",
    async () => {
      const fx = raceUpFixture();
      const r = await raceUpContenders(fx);

      // Exactly one winner; the loser is refused promptly and actionably.
      expect([r.codeA, r.codeB].filter((x) => x === 0).length).toBe(1);
      expect([r.codeA, r.codeB].filter((x) => x === 3).length).toBe(1);
      expect(r.codeA === 0 ? r.errB : r.errA).toMatch(/already operating on handoff/);

      // One record, up, carrying the WINNER's session identity — the loser
      // never got far enough to overwrite it or ship anything.
      const winnerRef = (r.codeA === 0 ? r.outA : r.outB).match(/WON (race-[ab])/)?.[1];
      expect(winnerRef).toBeDefined();
      const records = loadState({ home: fx.home, beamDir: fx.beamDir }).records;
      expect(records.length).toBe(1);
      expect(records[0]!.status).toBe("up");
      expect(records[0]!.sessionId).toBe(winnerRef!);
      expect(readdirSync(fx.c.claims)).toEqual([`beam-${records[0]!.id}`]);
    },
    30_000,
  );
});

/**
 * The same uid-scoped socket path the runtime's emitted scripts compute
 * (`${TMPDIR:-/tmp}/herdr-<uid>/<name>.sock`) — the planted server MUST
 * bind there or the retry's liveness probe would look for it at herdr's
 * HOME-derived default and never see it. The dir is uid-global and shared
 * across fixtures; beam-<id> session names keep entries disjoint.
 */
function herdrSocketEnv(name: string): Record<string, string> {
  const dir = join(process.env.TMPDIR ?? "/tmp", `herdr-${process.getuid!()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { HERDR_SESSION: name, HERDR_SOCKET_PATH: join(dir, `${name}.sock`) };
}

/**
 * Recreate the crash-window artifact for the interrupted-start suite: a REAL
 * herdr session named like beam's runtime session — registry under the
 * fixture pod HOME, socket at the uid-scoped path — holding one live pane:
 * exactly what a previous `up` leaves behind when it dies after starting
 * the agent but before flipping the record.
 */
async function startHerdrSession(podHome: string, name: string, cwdAbs: string): Promise<void> {
  const env = {
    HOME: podHome,
    XDG_CONFIG_HOME: join(podHome, ".config"),
    ...herdrSocketEnv(name),
  };
  await runChecked(["bash", "-c", "nohup herdr server >/dev/null 2>&1 &"], { env });
  let serverUp = false;
  for (let i = 0; i < 50 && !serverUp; i++) {
    serverUp = (await run(["herdr", "pane", "list"], { env })).code === 0;
    // Real external process boot: the herdr server is a live OS daemon with
    // no readiness event to await, so the probe is repolled on a real clock.
    if (!serverUp) await Bun.sleep(200);
  }
  if (!serverUp) throw new Error(`herdr server for ${name} never came up`);
  const created = await runChecked(
    ["herdr", "workspace", "create", "--cwd", cwdAbs, "--no-focus"],
    { env },
  );
  const parsed = JSON.parse(created.stdout) as { result: { root_pane: { pane_id: string } } };
  // Type a long-lived placeholder into the root pane's shell so the retry
  // finds a busy agent pane, not just the idle shell the workspace opens.
  await runChecked(
    ["herdr", "pane", "run", parsed.result.root_pane.pane_id, "bash -c 'sleep 300'"],
    { env },
  );
}

describe.skipIf(Bun.which("herdr") === null)(
  "interrupted start (`starting` phase, canned kubectl)",
  () => {
    let c: Cluster;
    let home: string;
    let workDir: string;
    let storeDir: string;
    const savedEnv: Record<string, string | undefined> = {};
    let savedCwd: string;
    let startedSession: string | undefined;

    beforeAll(() => {
      savedCwd = process.cwd();
      for (const k of ["BEAM_HOME", "BEAM_DIR", "PATH"]) savedEnv[k] = process.env[k];
      c = makeCluster();
      home = realpathSync(mkdtempSync(join(tmpdir(), "beam-start-home-")));
      const beamDir = join(home, ".beam");
      workDir = join(home, "work", "app");
      mkdirSync(workDir, { recursive: true });
      mkdirSync(beamDir, { recursive: true });
      writeFileSync(join(workDir, "hello.txt"), "hello\n");
      storeDir = join(home, ".omp", "agent", "sessions", "-work-app");
      mkdirSync(storeDir, { recursive: true });
      writeFileSync(
        join(storeDir, "2026-08-10T10-00-00-000Z_st-session.jsonl"),
        `{"type":"session","version":3,"id":"st-session","timestamp":"t","cwd":"${workDir}"}\n`,
      );
      writeFileSync(
        join(beamDir, "config.json"),
        JSON.stringify({
          defaultTarget: "k8s",
          targets: {
            k8s: {
              type: "agent-sandbox",
              context: "gke_test_ctx",
              namespace: "beam-luiz",
              template: "beam-coding",
              kubeconfig: "/kube/beam-user.kubeconfig",
              root: join(c.podHome, "data", "bipa"),
            },
          },
        }),
      );
      process.env.PATH = `${c.binDir}:${process.env.PATH}`;
      process.env.BEAM_HOME = home;
      process.env.BEAM_DIR = beamDir;
      process.chdir(workDir);
    });

    afterAll(async () => {
      process.chdir(savedCwd);
      if (startedSession !== undefined) {
        const env = {
          HOME: c.podHome,
          XDG_CONFIG_HOME: join(c.podHome, ".config"),
          ...herdrSocketEnv(startedSession),
        };
        // `server stop` reaches the uid-scoped socket; `session stop` only
        // resolves HOME-registry sockets and cannot see the planted server.
        await run(["herdr", "server", "stop"], { env });
        await run(["herdr", "session", "delete", startedSession, "--json"], { env });
      }
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    test(
      "a retry finding a live herdr pane while `starting` finalizes the record: same session " +
        "identity, nothing re-shipped",
      async () => {
        await cmdUp(["--no-start"]);
        const before = loadState(resolveEnv()).records[0]!;
        expect(before.status).toBe("up");
        expect(before.sessionId).toBe("st-session");

        // Recreate the crash window exactly: the previous up started the
        // agent's herdr session and died before flipping `up`.
        startedSession = before.runtimeSession;
        await startHerdrSession(c.podHome, before.runtimeSession, before.remoteCwd);
        updateRecord(resolveEnv(), before.id, { status: "starting" });

        // A newer local session would win auto-detection on the retry, and a
        // new local file would ride a re-ship — the finalize path must touch
        // neither.
        writeFileSync(
          join(storeDir, "2026-08-12T10-00-00-000Z_st-newer.jsonl"),
          `{"type":"session","version":3,"id":"st-newer","timestamp":"t","cwd":"${workDir}"}\n`,
        );
        writeFileSync(join(workDir, "late-local.txt"), "late\n");

        await cmdUp([]);
        const after = loadState(resolveEnv()).records[0]!;
        expect(after.status).toBe("up");
        expect(after.sessionId).toBe("st-session"); // identity never overwritten
        expect(
          existsSync(join(after.remoteCwd, "late-local.txt")),
        ).toBe(false); // nothing re-shipped

        // With the record `up` and the agent still alive, a plain re-up keeps
        // refusing to clobber it.
        await expect(cmdUp([])).rejects.toThrow(/already has a live agent/);
      },
      30_000,
    );
  },
);


describe("unresolved default-root abandon and kill promotion rules (canned kubectl)", () => {
  let c: Cluster;
  let home: string;
  let workDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  let savedCwd: string;

  beforeAll(() => {
    savedCwd = process.cwd();
    for (const k of ["BEAM_HOME", "BEAM_DIR", "PATH"]) savedEnv[k] = process.env[k];
    c = makeCluster();
    home = realpathSync(mkdtempSync(join(tmpdir(), "beam-abandon-home-")));
    const beamDir = join(home, ".beam");
    workDir = join(home, "work", "app");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(beamDir, { recursive: true });
    writeFileSync(join(workDir, "hello.txt"), "hello\n");
    // No `root`: candidate workspaces sit under the DEFAULT `~/beam`, which
    // stays a `~` path until a successful `pwd` resolves it.
    writeFileSync(
      join(beamDir, "config.json"),
      JSON.stringify({
        defaultTarget: "k8s",
        targets: {
          k8s: {
            type: "agent-sandbox",
            context: "gke_test_ctx",
            namespace: "beam-luiz",
            template: "beam-coding",
            kubeconfig: "/kube/beam-user.kubeconfig",
          },
        },
      }),
    );
    process.env.PATH = `${c.binDir}:${process.env.PATH}`;
    process.env.BEAM_HOME = home;
    process.env.BEAM_DIR = beamDir;
    process.chdir(workDir);
  });

  afterAll(() => {
    process.chdir(savedCwd);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test(
    "kill --purge reaches the claim delete for a Ready-timeout record whose remote cwd never " +
      "resolved",
    async () => {
      c.flag("wait-fail");
      try {
        await expect(cmdUp(["--no-session"])).rejects.toThrow(/did not become Ready/);
      } finally {
        rmSync(join(c.state, "wait-fail"));
      }
      const record = loadState(resolveEnv()).records[0]!;
      expect(record.status).toBe("provisioning");
      expect(record.remoteCwd.startsWith("~/beam/")).toBe(true); // still the unresolved candidate
      expect(record.remoteCwdResolved).toBe(false);
      expect(existsSync(join(c.claims, agentSandboxState(record.sandbox).claim))).toBe(true);

      const argvBefore = c.argv().length;
      c.flag("exec-fail-pattern", "herdr"); // a broken image must not block claim deletion
      try {
        await cmdKill([record.id, "--purge"]);
      } finally {
        rmSync(join(c.state, "exec-fail-pattern"));
      }
      // Provider destruction was reached despite the absent runtime.
      expect(
        existsSync(join(c.claims, agentSandboxState(record.sandbox).claim)),
      ).toBe(false);
      expect(loadState(resolveEnv()).records[0]!.status).toBe("killed");
      // Nothing was ever shipped, so no rm ran — and the path guard never got
      // the chance to block the destroy.
      const delta = c.argv().slice(argvBefore).map((a) => a.join(" "));
      expect(delta.some((a) => a.includes("rm -rf"))).toBe(false);
      expect(delta.some((a) => a.includes(" exec "))).toBe(false);
    },
  );

  test(
    "kill without purge never promotes: killed stays killed, provisioning stays provisioning",
    async () => {
      // A fully destroyed handoff is terminal.
      await cmdUp(["--no-session", "--no-start"]);
      const finished = loadState(resolveEnv()).records.at(-1)!;
      await cmdKill([finished.id, "--purge"]);
      expect(loadState(resolveEnv()).records.at(-1)!.status).toBe("killed");
      await cmdKill([finished.id]);
      expect(loadState(resolveEnv()).records.at(-1)!.status).toBe("killed");

      // A half-provisioned handoff stays incomplete under a plain kill…
      c.flag("wait-fail");
      try {
        await expect(cmdUp(["--no-session", "--no-start"])).rejects.toThrow(/did not become Ready/);
      } finally {
        rmSync(join(c.state, "wait-fail"));
      }
      const prov = loadState(resolveEnv()).records.at(-1)!;
      expect(prov.status).toBe("provisioning");
      await cmdKill([prov.id]);
      expect(
        loadState(resolveEnv()).records.find((r) => r.id === prov.id)!.status,
      ).toBe("provisioning");

      // …and remains abandonable afterwards.
      await cmdKill([prov.id, "--purge"]);
      expect(loadState(resolveEnv()).records.find((r) => r.id === prov.id)!.status).toBe("killed");
      expect(existsSync(join(c.claims, agentSandboxState(prov.sandbox).claim))).toBe(false);
    },
    30000,
  );
});

describe("down/kill operation ownership and phase matrix (canned kubectl)", () => {
  let c: Cluster;
  let home: string;
  let beamDir: string;
  let workDir: string;
  let otherDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  let savedCwd: string;

  beforeAll(() => {
    savedCwd = process.cwd();
    for (const k of ["BEAM_HOME", "BEAM_DIR", "PATH"]) savedEnv[k] = process.env[k];
    c = makeCluster();
    home = realpathSync(mkdtempSync(join(tmpdir(), "beam-matrix-home-")));
    beamDir = join(home, ".beam");
    workDir = join(home, "work", "app");
    otherDir = join(home, "work", "other");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    mkdirSync(beamDir, { recursive: true });
    writeFileSync(join(workDir, "hello.txt"), "hello\n");
    writeFileSync(join(otherDir, "other.txt"), "other\n");
    // Two targets on the same canned cluster so two handoffs can be live at
    // once (each agent-sandbox target is exclusive on its own).
    writeFileSync(
      join(beamDir, "config.json"),
      JSON.stringify({
        defaultTarget: "k8s",
        targets: {
          k8s: {
            type: "agent-sandbox",
            context: "gke_test_ctx",
            namespace: "beam-luiz",
            template: "beam-coding",
            kubeconfig: "/kube/beam-user.kubeconfig",
            root: join(c.podHome, "data", "bipa"),
          },
          k8s2: {
            type: "agent-sandbox",
            context: "gke_test_ctx",
            namespace: "beam-luiz",
            template: "beam-coding",
            kubeconfig: "/kube/beam-user.kubeconfig",
            root: join(c.podHome, "data", "second"),
          },
        },
      }),
    );
    process.env.PATH = `${c.binDir}:${process.env.PATH}`;
    process.env.BEAM_HOME = home;
    process.env.BEAM_DIR = beamDir;
    process.chdir(workDir);
  });

  afterAll(() => {
    process.chdir(savedCwd);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test(
    "down and kill refuse promptly while another process operates on the record (up/down/kill " +
      "races)",
    async () => {
      await cmdUp(["--no-session", "--no-start"]);
      const record = loadState(resolveEnv()).records[0]!;
      expect(record.status).toBe("up");
      // A live owner mid-remote-sequence — exactly what an in-flight `beam
      // up`, `beam down`, or `beam kill` looks like from a second process.
      const release = acquireOperationLock(resolveEnv(), record.id);
      try {
        await expect(cmdDown([record.id])).rejects.toThrow(/already operating on handoff/);
        await expect(cmdKill([record.id, "--purge"])).rejects.toThrow(
          /already operating on handoff/,
        );
      } finally {
        release();
      }
      // The losers touched NOTHING: claim, workspace, and status all intact.
      expect(existsSync(join(c.claims, agentSandboxState(record.sandbox).claim))).toBe(true);
      expect(existsSync(join(record.remoteCwd, "hello.txt"))).toBe(true);
      expect(loadState(resolveEnv()).records[0]!.status).toBe("up");
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  test("a `starting` record collects like up and remains collectible", async () => {
    const record = loadState(resolveEnv()).records[0]!;
    writeFileSync(join(record.remoteCwd, "made-remotely.txt"), "theirs\n");
    updateRecord(resolveEnv(), record.id, { status: "starting" });
    await cmdDown([record.id]);
    expect(existsSync(join(workDir, "made-remotely.txt"))).toBe(false);
    expect(
      readFileSync(join(latestReturnWorkspace(beamDir, record.id), "made-remotely.txt"), "utf8"),
    ).toBe("theirs\n");
    expect(loadState(resolveEnv()).records[0]!.status).toBe("up");
  });

  test("terminal killed records are monotonic and down no-ops", async () => {
    const record = loadState(resolveEnv()).records[0]!;
    await cmdKill([record.id, "--purge"]);
    expect(loadState(resolveEnv()).records[0]!.status).toBe("killed");
    const argvBefore = c.argv().length;
    await cmdDown([record.id]);
    await cmdKill([record.id, "--purge"]);
    expect(loadState(resolveEnv()).records[0]!.status).toBe("killed");
    expect(c.argv().length).toBe(argvBefore);
  });

  test("down on a provisioning record refuses: a partial ship is never collectable", async () => {
    c.flag("wait-fail");
    try {
      await expect(cmdUp(["--no-session", "--no-start"])).rejects.toThrow(/did not become Ready/);
    } finally {
      rmSync(join(c.state, "wait-fail"));
    }
    const rec = loadState(resolveEnv()).records.at(-1)!;
    expect(rec.status).toBe("provisioning");
    const argvBefore = c.argv().length;
    await expect(cmdDown([rec.id])).rejects.toThrow(/still provisioning/);
    await expect(cmdDown([rec.id])).rejects.toThrow(new RegExp(`beam kill ${rec.id} --purge`));
    // Refused BEFORE any remote effect: nothing synced, nothing collected,
    // nothing destroyed — and the claim stays for the retry/abandon.
    expect(c.argv().length).toBe(argvBefore);
    expect(loadState(resolveEnv()).records.at(-1)!.status).toBe("provisioning");
    expect(existsSync(join(c.claims, agentSandboxState(rec.sandbox).claim))).toBe(true);
  });

  test(
    "no-ref destructive kill refuses ambiguity across live handoffs; the exact id purges the " +
      "right one",
    async () => {
      // Second live handoff beside the provisioning one: an `up` on k8s2.
      process.chdir(otherDir);
      try {
        await cmdUp(["--no-session", "--no-start", "-t", "k8s2"]);
      } finally {
        process.chdir(workDir);
      }
      const records = loadState(resolveEnv()).records;
      const prov = records.find((r) => r.status === "provisioning")!;
      const up = records.find((r) => r.status === "up")!;

      await expect(cmdKill(["--purge"])).rejects.toThrow(/multiple live handoffs/);
      await expect(cmdKill(["--purge"])).rejects.toThrow(/beam kill <id> --purge/);
      // Nothing was selected, nothing was destroyed.
      expect(existsSync(join(c.claims, agentSandboxState(prov.sandbox).claim))).toBe(true);
      expect(existsSync(join(c.claims, agentSandboxState(up.sandbox).claim))).toBe(true);

      // The exact id abandons exactly the failed handoff — the up survives.
      await cmdKill([prov.id, "--purge"]);
      expect(loadState(resolveEnv()).records.find((r) => r.id === prov.id)!.status).toBe("killed");
      expect(existsSync(join(c.claims, agentSandboxState(prov.sandbox).claim))).toBe(false);
      expect(loadState(resolveEnv()).records.find((r) => r.id === up.id)!.status).toBe("up");
      expect(existsSync(join(c.claims, agentSandboxState(up.sandbox).claim))).toBe(true);
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  test(
    "kill --purge on a resolved but unreachable sandbox fails with record, claim, and workspace " +
      "intact",
    async () => {
      const up = loadState(resolveEnv()).records.find((r) => r.status === "up")!;
      expect(up.remoteCwdResolved).toBe(true);
      c.flag("pod-missing");
      try {
        await expect(cmdKill([up.id, "--purge"])).rejects.toThrow(/refusing to delete the claim/);
      } finally {
        rmSync(join(c.state, "pod-missing"));
      }
      // A persistent volume could still hold the workspace and transcript:
      // the claim must remain the recovery handle until erasure is PROVEN.
      expect(loadState(resolveEnv()).records.find((r) => r.id === up.id)!.status).toBe("up");
      expect(existsSync(join(c.claims, agentSandboxState(up.sandbox).claim))).toBe(true);
      expect(existsSync(join(up.remoteCwd, "other.txt"))).toBe(true);
    },
  );

  test(
    "kill --purge behind a broken credential helper refuses the same way — a tool failure is " +
      "never license to destroy",
    async () => {
      const up = loadState(resolveEnv()).records.find((r) => r.status === "up")!;
      expect(up.remoteCwdResolved).toBe(true);
      c.flag("get-auth-fail");
      try {
        await expect(cmdKill([up.id, "--purge"])).rejects.toThrow(/refusing to delete the claim/);
      } finally {
        rmSync(join(c.state, "get-auth-fail"));
      }
      // No provider can prove its destroy erases the data (persistent volumes
      // can outlive a claim): record, claim, and workspace all survive until
      // a CONNECTED purge proves the checked erasure.
      expect(loadState(resolveEnv()).records.find((r) => r.id === up.id)!.status).toBe("up");
      expect(existsSync(join(c.claims, agentSandboxState(up.sandbox).claim))).toBe(true);
      expect(existsSync(join(up.remoteCwd, "other.txt"))).toBe(true);
    },
  );

  test(
    "an interrupted destroy parks `killing`; the retry re-proves cleanup, finishes the destroy, " +
      "and terminal states hold",
    async () => {
      const up = loadState(resolveEnv()).records.find((r) => r.status === "up")!;
      c.flag("delete-fail");
      try {
        await expect(cmdKill([up.id, "--purge"])).rejects.toThrow(/canned delete failure/);
      } finally {
        rmSync(join(c.state, "delete-fail"));
      }
      // Checked erasure completed BEFORE the journal: the workspace is gone,
      // only the claim delete is pending.
      expect(loadState(resolveEnv()).records.find((r) => r.id === up.id)!.status).toBe("killing");
      expect(existsSync(up.remoteCwd)).toBe(false);
      expect(existsSync(join(c.claims, agentSandboxState(up.sandbox).claim))).toBe(true);

      // Mid-kill is owned by `kill --purge` alone — down and plain kill both
      // name the exact recovery.
      await expect(cmdDown([up.id])).rejects.toThrow(new RegExp(`beam kill ${up.id} --purge`));
      await expect(cmdKill([up.id])).rejects.toThrow(new RegExp(`beam kill ${up.id} --purge`));

      // A REACHABLE retry never skips current cleanup: it reconnects,
      // re-proves the owner-pinned erasure (idempotent — the journaled retry
      // accepts the already-erased root), and repeats the destroy pinned to
      // the claim identity with a UID precondition…
      const argvBefore = c.argv().length;
      await cmdKill([up.id, "--purge"]);
      // Exact argv elements: the owner-pinned erasure payload legitimately
      // contains `find … -delete` as TEXT; only the kubectl verb counts.
      const delta = c.argv().slice(argvBefore);
      expect(delta.some((a) => a.includes("delete") && a.includes("--raw"))).toBe(true);
      // …and never an unconditional delete.
      expect(
        delta.some((a) => a.includes("delete") && !a.includes("--raw") && !a.includes("can-i")),
      ).toBe(false);
      expect(loadState(resolveEnv()).records.find((r) => r.id === up.id)!.status).toBe("killed");
      expect(existsSync(join(c.claims, agentSandboxState(up.sandbox).claim))).toBe(false);
    },
  );
});

describe("outbound exclude drift protection (canned kubectl)", () => {
  let c: Cluster;
  let home: string;
  let beamDir: string;
  let workDir: string;
  let otherDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  let savedCwd: string;

  const configWith = (excludes: string[]) =>
    JSON.stringify({
      defaultTarget: "k8s",
      excludes,
      targets: {
        k8s: {
          type: "agent-sandbox",
          context: "gke_test_ctx",
          namespace: "beam-luiz",
          template: "beam-coding",
          kubeconfig: "/kube/beam-user.kubeconfig",
          root: join(c.podHome, "data", "bipa"),
        },
      },
    });

  beforeAll(() => {
    savedCwd = process.cwd();
    for (const k of ["BEAM_HOME", "BEAM_DIR", "PATH"]) savedEnv[k] = process.env[k];
    c = makeCluster();
    home = realpathSync(mkdtempSync(join(tmpdir(), "beam-drift-home-")));
    beamDir = join(home, ".beam");
    workDir = join(home, "work", "app");
    otherDir = join(home, "work", "other");
    mkdirSync(join(workDir, "secrets"), { recursive: true });
    mkdirSync(join(otherDir, "secrets"), { recursive: true });
    mkdirSync(beamDir, { recursive: true });
    writeFileSync(join(workDir, "hello.txt"), "hello\n");
    writeFileSync(join(workDir, "secrets", "keys.txt"), "shh\n");
    writeFileSync(join(otherDir, "other.txt"), "other\n");
    writeFileSync(join(otherDir, "secrets", "keys.txt"), "shh\n");
    writeFileSync(join(beamDir, "config.json"), configWith(["secrets"]));
    process.env.PATH = `${c.binDir}:${process.env.PATH}`;
    process.env.BEAM_HOME = home;
    process.env.BEAM_DIR = beamDir;
    process.chdir(workDir);
  });

  afterAll(() => {
    process.chdir(savedCwd);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test(
    "a path excluded at ship time survives `beam down --delete` after the exclude is dropped",
    async () => {
      await cmdUp(["--no-session", "--no-start"]);
      const record = loadState(resolveEnv()).records[0]!;
      // The completed ship journaled its effective exclude set…
      expect(record.syncedExcludes).toEqual(
        [BEAM_RESERVED_EXCLUDE, BEAM_GITPTR_EXCLUDE, "secrets", GIT_METADATA_EXCLUDE],
      );
      // …and really did keep the directory home.
      expect(existsSync(join(record.remoteCwd, "secrets"))).toBe(false);
      expect(existsSync(join(record.remoteCwd, "hello.txt"))).toBe(true);

      // Config drift before the return leg: the exclude disappears.
      writeFileSync(join(beamDir, "config.json"), configWith([]));
      writeFileSync(join(record.remoteCwd, "made-remotely.txt"), "theirs\n");

      await cmdDown([record.id, "--delete"]);
      // The union of recorded + current excludes protected the never-shipped
      // path inside the return stage; real remote work was staged.
      expect(readFileSync(join(workDir, "secrets", "keys.txt"), "utf8")).toBe("shh\n");
      expect(existsSync(join(workDir, "made-remotely.txt"))).toBe(false);
      const returned = latestReturnWorkspace(beamDir, record.id);
      expect(existsSync(join(returned, "secrets"))).toBe(false);
      expect(readFileSync(join(returned, "made-remotely.txt"), "utf8")).toBe("theirs\n");
      expect(loadState(resolveEnv()).records[0]!.status).toBe("up");
      await cmdKill([record.id, "--purge"]);
    },
    30000,
  );

  test("a refused re-ship never replaces the last known-good protection set", async () => {
    writeFileSync(join(beamDir, "config.json"), configWith(["secrets"]));
    process.chdir(otherDir);
    try {
      await cmdUp(["--no-session", "--no-start"]);
      const rec = loadState(resolveEnv()).records.at(-1)!;
      expect(rec.syncedExcludes).toEqual(
        [BEAM_RESERVED_EXCLUDE, BEAM_GITPTR_EXCLUDE, "secrets", GIT_METADATA_EXCLUDE],
      );

      // Drift the config, then attempt a blind re-ship: a completed handoff
      // refuses it outright (collect or retire first), so not a byte moves
      // and the journaled protection set stays exactly as shipped — the
      // drifted (weaker) exclude set can never be swapped in.
      writeFileSync(join(beamDir, "config.json"), configWith([]));
      await expect(cmdUp(["--no-session", "--no-start"])).rejects.toThrow(/already up on k8s/);
      const after = loadState(resolveEnv()).records.find((r) => r.id === rec.id)!;
      expect(after.status).toBe("up");
      expect(after.syncedExcludes).toEqual(
        [BEAM_RESERVED_EXCLUDE, BEAM_GITPTR_EXCLUDE, "secrets", GIT_METADATA_EXCLUDE],
      ); // protection set unchanged
    } finally {
      process.chdir(workDir);
    }
  }, 30000);
});

describe("physical workspace containment (canned kubectl)", () => {
  let c: Cluster;
  let home: string;
  let workDir: string;
  let root: string;
  let outside: string;
  const savedEnv: Record<string, string | undefined> = {};
  let savedCwd: string;

  beforeAll(() => {
    savedCwd = process.cwd();
    for (const k of ["BEAM_HOME", "BEAM_DIR", "PATH"]) savedEnv[k] = process.env[k];
    c = makeCluster();
    home = realpathSync(mkdtempSync(join(tmpdir(), "beam-contain-home-")));
    const beamDir = join(home, ".beam");
    workDir = join(home, "work", "app");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(beamDir, { recursive: true });
    writeFileSync(join(workDir, "hello.txt"), "hello\n");
    root = join(c.podHome, "data", "bipa");
    outside = join(c.state, "outside-target");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "sentinel.txt"), "untouched\n");
    writeFileSync(
      join(beamDir, "config.json"),
      JSON.stringify({
        defaultTarget: "k8s",
        targets: {
          k8s: {
            type: "agent-sandbox",
            context: "gke_test_ctx",
            namespace: "beam-luiz",
            template: "beam-coding",
            kubeconfig: "/kube/beam-user.kubeconfig",
            root,
          },
        },
      }),
    );
    process.env.PATH = `${c.binDir}:${process.env.PATH}`;
    process.env.BEAM_HOME = home;
    process.env.BEAM_DIR = beamDir;
    process.chdir(workDir);
  });

  afterAll(() => {
    process.chdir(savedCwd);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** The outside directory holds exactly its untouched sentinel. */
  function expectOutsideIntact(): void {
    expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
    expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe("untouched\n");
  }

  test(
    "a pre-existing symlink at the deterministic workspace path fails the ship before any byte " +
      "leaves",
    async () => {
      // The trap: the sandbox's deterministic workspace path already exists
      // as a symlink to a writable directory outside the root.
      const wsPath = join(root, remoteWorkspaceName(workDir));
      mkdirSync(root, { recursive: true });
      symlinkSync(outside, wsPath);

      await expect(cmdUp(["--no-session"])).rejects.toThrow(/symlink/);
      expectOutsideIntact(); // hello.txt never shipped through the link
      const record = loadState(resolveEnv()).records[0]!;
      expect(record.status).toBe("provisioning"); // failed before any ship
      expect(record.remoteCwdResolved).toBe(false); // no canonical cwd was ever persisted

      // Recovery: drop the trap and abandon the reservation.
      rmSync(wsPath);
      await cmdKill([record.id, "--purge"]);
      expect(loadState(resolveEnv()).records[0]!.status).toBe("killed");
    },
  );

  test(
    "a workspace swapped for a symlink after the ship refuses `beam down` — and collects again " +
      "once restored",
    async () => {
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.at(-1)!;
      expect(record.status).toBe("up");
      // The persisted cwd is the canonical physical path under the root.
      expect(record.remoteCwd).toBe(join(root, remoteWorkspaceName(workDir)));
      expect(readFileSync(join(record.remoteCwd, "hello.txt"), "utf8")).toBe("hello\n");

      // Swap: move the proven workspace aside and plant a link to the outside
      // dir at its canonical path.
      const aside = `${record.remoteCwd}-aside`;
      renameSync(record.remoteCwd, aside);
      symlinkSync(outside, record.remoteCwd);
      await expect(cmdDown([record.id])).rejects.toThrow(/symlink/);
      expectOutsideIntact(); // neither collected as the workspace nor purged
      expect(
        loadState(resolveEnv()).records.at(-1)!.status,
      ).toBe("up"); // refused before any state change

      // Restore the REAL workspace — owner marker and all — at the exact
      // canonical path: down stages it and retains the remote for explicit
      // kill. (A bare foreign directory would rightly refuse: ownership is
      // proven, never assumed.)
      rmSync(record.remoteCwd);
      renameSync(aside, record.remoteCwd);
      writeFileSync(join(record.remoteCwd, "made-remotely.txt"), "theirs\n");
      await cmdDown([record.id]);
      expect(existsSync(join(workDir, "made-remotely.txt"))).toBe(false);
      expect(
        readFileSync(
          join(latestReturnWorkspace(resolveEnv().beamDir, record.id), "made-remotely.txt"),
          "utf8",
        ),
      ).toBe("theirs\n");
      expect(existsSync(record.remoteCwd)).toBe(true);
      expect(loadState(resolveEnv()).records.at(-1)!.status).toBe("up");
      expectOutsideIntact();
      await cmdKill([record.id, "--purge"]);
    },
    30000,
  );

  test(
    "a swapped workspace refuses `beam kill --purge` with the claim intact; the retry finishes " +
      "once restored",
    async () => {
      await cmdUp(["--no-session"]);
      const record = loadState(resolveEnv()).records.at(-1)!;
      // Swap: move the proven workspace aside and plant a link in its place.
      const aside = `${record.remoteCwd}-aside`;
      renameSync(record.remoteCwd, aside);
      symlinkSync(outside, record.remoteCwd);

      // The owner-pinned purge refuses the swapped path byte-untouched — an
      // unproven erasure never reaches the claim delete. The purge intent was
      // already journaled, so the record parks mid-kill (`killing`).
      await expect(cmdKill([record.id, "--purge"])).rejects.toThrow(/refusing to purge|symlink/);
      expectOutsideIntact();
      expect(existsSync(join(c.claims, agentSandboxState(record.sandbox).claim))).toBe(true);
      expect(loadState(resolveEnv()).records.at(-1)!.status).toBe("killing");

      // Restore the real workspace at the canonical path: the journaled retry
      // proves the exact owner, erases, and finishes the destroy.
      rmSync(record.remoteCwd);
      renameSync(aside, record.remoteCwd);
      await cmdKill([record.id, "--purge"]);
      expect(loadState(resolveEnv()).records.at(-1)!.status).toBe("killed");
      expect(existsSync(join(c.claims, agentSandboxState(record.sandbox).claim))).toBe(false);
      expectOutsideIntact();
    },
    30000,
  );
});

describe("receipted no-connection destroy convergence (canned kubectl)", () => {
  let c: Cluster;
  let home: string;
  let beamDir: string;
  let workDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  let savedCwd: string;

  beforeAll(() => {
    savedCwd = process.cwd();
    for (const k of ["BEAM_HOME", "BEAM_DIR", "PATH"]) savedEnv[k] = process.env[k];
    c = makeCluster();
    home = realpathSync(mkdtempSync(join(tmpdir(), "beam-converge-home-")));
    beamDir = join(home, ".beam");
    workDir = join(home, "work", "app");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(beamDir, { recursive: true });
    writeFileSync(join(workDir, "hello.txt"), "hello\n");
    writeFileSync(
      join(beamDir, "config.json"),
      JSON.stringify({
        defaultTarget: "k8s",
        targets: {
          k8s: {
            type: "agent-sandbox",
            context: "gke_test_ctx",
            namespace: "beam-luiz",
            template: "beam-coding",
            kubeconfig: join(c.state, "kubeconfig"),
            root: join(c.podHome, "data", "bipa"),
          },
        },
      }),
    );
    process.env.PATH = `${c.binDir}:${process.env.PATH}`;
    process.env.BEAM_HOME = home;
    process.env.BEAM_DIR = beamDir;
    process.chdir(workDir);
  });

  afterAll(() => {
    process.chdir(savedCwd);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** Park a fresh handoff in `killing` with both receipts journaled (destroy interrupted). */
  async function parkReceiptedKill(): Promise<BeamRecord> {
    await cmdUp(["--no-session", "--no-start"]);
    const up = loadState(resolveEnv()).records.at(-1)!;
    c.flag("delete-fail");
    try {
      await expect(cmdKill([up.id, "--purge"])).rejects.toThrow(/canned delete failure/);
    } finally {
      rmSync(join(c.state, "delete-fail"));
    }
    const parked = loadState(resolveEnv()).records.find((r) => r.id === up.id)!;
    expect(parked.status).toBe("killing");
    expect(parked.killReceipt?.workspaceContentsPurged).toBe(true);
    expect(parked.killReceipt?.sessionTracesCleaned).toBe(true);
    return parked;
  }

  test(
    "crash between destroy and the terminal write: the receipted retry converges to killed " +
      "without a connection",
    async () => {
      const parked = await parkReceiptedKill();
      // Simulate the crash window where the destroy HAD succeeded but the
      // terminal `killed` was never written: the claim is gone out from
      // under a killing record whose receipts are complete.
      rmSync(join(c.claims, agentSandboxState(parked.sandbox).claim), { force: true });
      const argvBefore = c.argv().length;
      await cmdKill([parked.id, "--purge"]);
      expect(
        loadState(resolveEnv()).records.find((r) => r.id === parked.id)!.status,
      ).toBe("killed");
      const delta = c.argv().slice(argvBefore);
      expect(delta.some((a) => a.includes("exec"))).toBe(false); // converged without a connection
      expect(delta.some((a) => a.includes("--raw"))).toBe(false); // absence needed no delete
    },
    30000,
  );

  test(
    "the receipted no-connection retry retains on an API outage — convergence is proof, never a " +
      "guess",
    async () => {
      const parked = await parkReceiptedKill();
      c.flag("get-auth-fail");
      try {
        await expect(cmdKill([parked.id, "--purge"])).rejects.toThrow(/kubectl get .* failed/);
      } finally {
        rmSync(join(c.state, "get-auth-fail"));
      }
      expect(
        loadState(resolveEnv()).records.find((r) => r.id === parked.id)!.status,
      ).toBe("killing"); // retained
      // The failed API read leaves the claim intact.
      expect(
        existsSync(join(c.claims, agentSandboxState(parked.sandbox).claim)),
      ).toBe(true);
      // Once the API answers again, the connected retry finishes normally.
      await cmdKill([parked.id, "--purge"]);
      expect(
        loadState(resolveEnv()).records.find((r) => r.id === parked.id)!.status,
      ).toBe("killed");
      expect(existsSync(join(c.claims, agentSandboxState(parked.sandbox).claim))).toBe(false);
    },
    30000,
  );

  test(
    "the receipted no-connection retry refuses a same-name replacement — retained for a human",
    async () => {
      const parked = await parkReceiptedKill();
      // Out-of-band delete + recreate while beam was down: same name, label,
      // and template — only the server-assigned UID differs.
      const claimFile = join(c.claims, agentSandboxState(parked.sandbox).claim);
      const stored = JSON.parse(readFileSync(claimFile, "utf8")) as { metadata: { uid: string } };
      stored.metadata.uid = "replacement-uid-w";
      writeFileSync(claimFile, JSON.stringify(stored));
      const argvBefore = c.argv().length;
      await expect(cmdKill([parked.id, "--purge"])).rejects.toThrow(
        /refusing to finish the destroy/,
      );
      expect(
        loadState(resolveEnv()).records.find((r) => r.id === parked.id)!.status,
      ).toBe("killing"); // retained
      const after = JSON.parse(readFileSync(claimFile, "utf8")) as { metadata: { uid: string } };
      expect(after.metadata.uid).toBe("replacement-uid-w"); // the occupant survived untouched
      expect(
        c.argv().slice(argvBefore).some((a) => a.includes("--raw")),
      ).toBe(false); // no delete was issued
    },
    30000,
  );
});

describe("kubectl flows are mirror-free (canned kubectl on PATH)", () => {
  let c: Cluster;
  let home: string;
  let beamDir: string;
  let workDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  let savedCwd: string;

  beforeAll(() => {
    savedCwd = process.cwd();
    for (const k of ["BEAM_HOME", "BEAM_DIR", "PATH"]) savedEnv[k] = process.env[k];
    c = makeCluster();
    home = realpathSync(mkdtempSync(join(tmpdir(), "beam-k8s-nomirror-")));
    beamDir = join(home, ".beam");
    workDir = join(home, "work", "app");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(beamDir, { recursive: true });
    writeFileSync(join(workDir, "hello.txt"), "hello\n");
    writeFileSync(
      join(beamDir, "config.json"),
      JSON.stringify({
        defaultTarget: "k8s",
        targets: {
          k8s: {
            type: "agent-sandbox",
            context: "gke_test_ctx",
            namespace: "beam-luiz",
            template: "beam-coding",
            kubeconfig: "/kube/beam-user.kubeconfig",
            root: join(c.podHome, "data", "bipa"),
          },
        },
      }),
    );
    process.env.PATH = `${c.binDir}:${process.env.PATH}`;
    process.env.BEAM_HOME = home;
    process.env.BEAM_DIR = beamDir;
    process.chdir(workDir);
  });

  afterAll(() => {
    process.chdir(savedCwd);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test(
    "up + default down never issue a mirrored deletion, a license probe, or a destructive remote " +
      "command",
    async () => {
      await cmdUp(["--no-session", "--no-start"]);
      const record = loadState(resolveEnv()).records.at(-1)!;
      writeFileSync(join(record.remoteCwd, "made-remotely.txt"), "theirs\n");
      await cmdDown([record.id]);
      // the flow really moved bytes both ways (returns land in a verified
      // stage, never auto-published into the live local workspace)…
      expect(
        readFileSync(join(latestReturnWorkspace(beamDir, record.id), "made-remotely.txt"), "utf8"),
      ).toBe(
        "theirs\n",
      );

      // …with ZERO mirror machinery on the kubectl path: the upload stage
      // ship and the return collect are additive (`delete: false`), so no
      // license is ever earned (no marker write) or probed (the probe is the
      // only kubectl-visible signature of a `delete` syncDown, and a
      // `delete` syncUp throws before any exec), and nothing destructive
      // runs remotely on the retain path. The per-attempt license
      // INVALIDATION walk still appears — it deletes nothing but a stale
      // keyed marker of its own destination.
      const execs = c
        .argv()
        .filter((a) => a.includes("exec"))
        .map((a) => a.at(-1)!);
      expect(execs.length).toBeGreaterThan(0);
      expect(
        execs.some((s) => /(?:^|\n)cat '[0-9a-f]{32}\.v1'/.test(s)),
      ).toBe(false); // no mirror-license probe
      expect(
        execs.some((s) => /> '[0-9a-f]{32}\.v1'/.test(s)),
      ).toBe(false); // no mirror license earned
      expect(execs.some((s) => /find .* -delete/.test(s))).toBe(false); // no destination emptying
      // Beam-owned scratch (upload stages) is cleaned with rm -rf inside
      // owner-held shells — but nothing ever names the live root for it.
      const rootRe = new RegExp(
        `rm -rf[^\\n]*${record.remoteCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!/)`,
      );
      expect(execs.some((s) => rootRe.test(s))).toBe(false);
    },
    60000,
  );
});