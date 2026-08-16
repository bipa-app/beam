import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdDown } from "../src/commands/down.ts";
import { cmdAttach, cmdKill, cmdLogin } from "../src/commands/misc.ts";
import { cmdUp } from "../src/commands/up.ts";
import type { AgentSandboxTargetSpec } from "../src/config.ts";
import { resolveEnv } from "../src/env.ts";
import { AgentSandboxProvider } from "../src/provider/agent-sandbox.ts";
import type { SandboxState } from "../src/provider/types.ts";
import { TmuxRuntime } from "../src/runtime/tmux.ts";
import { acquireOperationLock, loadState, updateRecord } from "../src/state.ts";
import { KubectlTransport } from "../src/transport/kubectl.ts";
import { remoteWorkspaceName } from "../src/workspace.ts";
import { run, shq } from "../src/util/shell.ts";

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
  const res = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", env: { ...process.env, HOME: podHome } });
  // exec-hook-pattern + exec-hook.sh: run a canned script AFTER a matching
  // command completes — simulates a pod-side agent racing between beam's
  // remote shells (e.g. swapping .beam for a symlink mid-ship).
  const hookPat = join(STATE, "exec-hook-pattern");
  if (existsSync(hookPat) && cmd.join(" ").includes(readFileSync(hookPat, "utf8").trim())) {
    spawnSync("bash", [join(STATE, "exec-hook.sh")], { stdio: "inherit", env: { ...process.env, HOME: podHome } });
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
  let resource = rest[1] || "";
  let name = rest[2] || "";
  const slash = resource.indexOf("/");
  if (slash > 0) { name = resource.slice(slash + 1); resource = resource.slice(0, slash); }
  const flagValue = (f) => existsSync(join(STATE, f)) ? readFileSync(join(STATE, f), "utf8").trim() : undefined;
  const present = existsSync(join(claims, name));
  if (resource.indexOf("sandboxclaims") === 0) {
    if (!present) die('Error from server (NotFound): sandboxclaims "' + name + '" not found');
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
      die('Error from server (NotFound): sandboxes "' + name + '" not found');
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
      die('Error from server (NotFound): pods "' + name + '" not found');
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
  writeFileSync(bin, `#!/bin/bash\nexec ${shq(process.execPath)} ${shq(join(state, "impl.mjs"))} "$@"\n`);
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

describe("agent-sandbox provider lifecycle", () => {
  test("provision creates one stable claim, waits Ready, resolves claim → Sandbox → pod; re-provision reuses without a second create", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    const t = await p.provision({ id: "abc123" });
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

    await p.provision({ id: "abc123" });
    expect(readdirSync(c.claims)).toEqual(["beam-abc123"]); // one claim, ever
    // create-if-absent: the second provision must go through get, not create
    // (the least-privilege role has no patch/update, and the fake's create
    // fails on AlreadyExists exactly like the real API).
    expect(c.argv().filter((a) => a.includes("create") && a.includes("-f")).length).toBe(1);
  });

  test("Ready timeout is a bounded, actionable error and keeps the claim so a retried up continues it", async () => {
    const c = makeCluster();
    c.flag("wait-fail");
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await expect(p.provision({ id: "x1" })).rejects.toThrow(/did not become Ready within[\s\S]*beam kill x1 --purge/);
    expect(existsSync(join(c.claims, "beam-x1"))).toBe(true);
  });

  test("the verified UID is published BEFORE the Ready wait — a timeout leaves it pinned, and the retry binds to exactly that claim", async () => {
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
    const stored = JSON.parse(readFileSync(join(c.claims, "beam-pin1"), "utf8")) as { metadata: { uid: string } };
    expect(published.length).toBe(1);
    expect(waitSeenAtPublish).toBe(false);
    expect(published[0]!.claim).toBe("beam-pin1");
    expect(published[0]!.uid).toBe(stored.metadata.uid);
    // A retry with the published state binds to that exact UID and finishes…
    rmSync(join(c.state, "wait-fail"));
    await p.provision({ id: "pin1", sandbox: published[0] });
    // …and refuses a same-name claim whose UID differs (replaced during the
    // outage) — the refusal the early publication exists to make possible.
    const replaced = JSON.parse(readFileSync(join(c.claims, "beam-pin1"), "utf8")) as { metadata: { uid: string } };
    replaced.metadata.uid = "replacement-uid";
    writeFileSync(join(c.claims, "beam-pin1"), JSON.stringify(replaced));
    await expect(p.provision({ id: "pin1", sandbox: published[0] })).rejects.toThrow(
      /is not the one this record created/,
    );
  });

  test("connect re-resolves the pod from the claim; a gone claim is an actionable error", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await p.provision({ id: "c1" });
    const t = await p.connect({ id: "c1" });
    expect(t.label).toContain("beam-c1");
    rmSync(join(c.claims, "beam-c1"));
    await expect(p.connect({ id: "c1" })).rejects.toThrow(/beam up/);
    await expect(p.connect(undefined)).rejects.toThrow(/no live sandbox/);
  });

  test("persisted coordinates matching the target snapshot are used; disagreeing ones fail closed before any kubectl runs", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await p.provision({ id: "r1" });
    // The exact coords `beam up` persisted (commands rebuild the provider
    // from the record's targetSpec snapshot, so legit flows always match).
    const good = p.sandboxState({ id: "r1" });
    const t = await p.connect({ id: "r1", sandbox: good });
    expect(t.label).toContain("beam-r1");

    // A record pointing at coordinates this target never produced means a
    // tampered or corrupted state.json — refuse without running kubectl.
    const argvBefore = c.argv().length;
    await expect(
      p.connect({ id: "r1", sandbox: { ...good, context: "recorded-ctx", namespace: "recorded-ns" } }),
    ).rejects.toThrow(/do not match the target snapshot/);
    await expect(p.connect({ id: "r1", sandbox: { ...good, kubeconfig: "/tmp/other" } })).rejects.toThrow(
      /do not match the target snapshot/,
    );
    expect(c.argv().length).toBe(argvBefore); // refused before any kubectl call
  });

  test("malformed persisted coordinates fail closed before argv interpolation", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    const good = p.sandboxState({ id: "r2" });
    await expect(p.connect({ id: "r2", sandbox: { ...good, namespace: "Bad_NS" } })).rejects.toThrow(/DNS label/);
    await expect(p.connect({ id: "r2", sandbox: { ...good, container: "-oyaml" } })).rejects.toThrow(/DNS label/);
    await expect(p.connect({ id: "r2", sandbox: { ...good, claim: "beam r2 $(boom)" } })).rejects.toThrow(
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

  test("destroy re-reads the claim and deletes it through the raw DeleteOptions API with a UID precondition; idempotent", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await p.provision({ id: "d9" });
    await p.destroy({ id: "d9" });
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
      del.some((a) => a === "/apis/extensions.agents.x-k8s.io/v1alpha1/namespaces/beam-luiz/sandboxclaims/beam-d9"),
    ).toBe(true);
    expect(del).not.toContain("--ignore-not-found");
    await p.destroy({ id: "d9" }); // already gone — must not throw
  });

  test("an overpowered credential (plain pod create) is refused before any claim is created", async () => {
    const c = makeCluster();
    c.perms({ ...LEAST_PRIV, "create pods beam-luiz": true });
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await expect(p.provision({ id: "p0" })).rejects.toThrow(/plain pods/);
    expect(readdirSync(c.claims)).toEqual([]);
    expect(c.argv().some((a) => a.includes("create") && a.includes("-f"))).toBe(false);
  });

  test("a transient can-i failure fails closed: provision refuses before any claim is created", async () => {
    const c = makeCluster();
    c.flag("can-i-fail");
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await expect(p.provision({ id: "p1" })).rejects.toThrow(/fails closed/);
    expect(readdirSync(c.claims)).toEqual([]);
  });

  test("claim reuse refuses a template mismatch instead of exec'ing into another workload", async () => {
    const c = makeCluster();
    await new AgentSandboxProvider(makeSpec(), c.bin).provision({ id: "tm1" });
    const other = new AgentSandboxProvider(makeSpec({ template: "other-template" }), c.bin);
    await expect(other.provision({ id: "tm1" })).rejects.toThrow(
      /references template beam-coding, not the configured other-template/,
    );
    expect(readdirSync(c.claims)).toEqual(["beam-tm1"]); // untouched
    expect(c.argv().some((a) => a.includes("exec"))).toBe(false);
    expect(c.argv().some((a) => a.includes("--raw"))).toBe(false); // never deleted either
  });

  test("warm-pool resolution: claim.status.sandbox.name and the pod-name annotation win over name identity", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await p.provision({ id: "w1" });
    c.flag("sandbox-name", "beam-w1-sbx");
    c.flag("pod-name", "warm-pod-42");
    const t = await p.connect({ id: "w1" });
    expect(t.label).toBe("k8s beam-luiz/warm-pod-42");
    const gets = c.argv().filter((a) => a.includes("get"));
    expect(gets.some((a) => a.includes("sandboxes.agents.x-k8s.io") && a.includes("beam-w1-sbx"))).toBe(true);
    expect(gets.some((a) => a.includes("pod") && a.includes("warm-pod-42"))).toBe(true);
  });

  test("an unpopulated claim status falls back to name identity through the whole chain", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await p.provision({ id: "f1" });
    c.flag("claim-status-empty");
    const t = await p.connect({ id: "f1" });
    expect(t.label).toBe("k8s beam-luiz/beam-f1");
  });

  test("a Sandbox owned by a different claim is an impostor — connect refuses it", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await p.provision({ id: "o1" });
    c.flag("sandbox-owner-bad");
    await expect(p.connect({ id: "o1" })).rejects.toThrow(/not owned by SandboxClaim beam-o1/);
  });

  test("a pod owned by a different Sandbox is an impostor — connect refuses it", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await p.provision({ id: "o2" });
    c.flag("pod-owner-bad");
    await expect(p.connect({ id: "o2" })).rejects.toThrow(/not owned by Sandbox beam-o2/);
  });

  test("a pod that is not Running is an actionable error, not an exec target", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await p.provision({ id: "o3" });
    c.flag("pod-phase", "Pending");
    await expect(p.connect({ id: "o3" })).rejects.toThrow(/is Pending, not Running/);
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
  });

  test("a workload-controller grant is refused before any claim is created", async () => {
    const c = makeCluster();
    c.perms({ ...LEAST_PRIV, "create deployments.apps beam-luiz": true });
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await expect(p.provision({ id: "e2" })).rejects.toThrow(/create Deployments/);
    expect(readdirSync(c.claims)).toEqual([]);
    expect(c.argv().some((a) => a.includes("create") && a.includes("-f"))).toBe(false);
  });

  test("a malformed API-returned sandbox name is refused before it can reach kubectl argv", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await p.provision({ id: "n1" });
    c.flag("sandbox-name", "evil;--kubeconfig=/tmp/x");
    await expect(p.connect({ id: "n1" })).rejects.toThrow(/sandbox name .* DNS subdomain/);
    expect(c.argv().some((a) => a.includes("evil;--kubeconfig=/tmp/x"))).toBe(false);
  });

  test("a malformed pod-name annotation is refused before it can reach kubectl argv", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await p.provision({ id: "n2" });
    c.flag("pod-name", "-oyaml");
    await expect(p.connect({ id: "n2" })).rejects.toThrow(/pod name .* DNS subdomain/);
    expect(c.argv().some((a) => a.includes("-oyaml"))).toBe(false);
  });

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
  });

  test("a persisted claim that is valid but not this record's beam-<id> fails closed before any kubectl runs", async () => {
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
  });

  test("losing the create race to an identical claim re-validates, reuses it, and adopts its UID", async () => {
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
    const t = await p.provision(ref);
    expect(t.label).toBe("k8s beam-luiz/beam-rc1");
    expect(ref.sandbox?.uid).toBe("raced-uid-1"); // the raced claim's identity is pinned
    expect(readdirSync(c.claims)).toEqual(["beam-rc1"]); // the raced claim, reused — never a duplicate
    // The race path re-read the claim (get → create-AlreadyExists → get)
    // and only then waited on it.
    const claimGets = c
      .argv()
      .filter((a) => a.includes("get") && a.includes("beam-rc1") && a.some((el) => el.includes("sandboxclaims")));
    expect(claimGets.length).toBeGreaterThanOrEqual(2);
    expect(c.argv().some((a) => a.includes("wait"))).toBe(true);
  });

  test("losing the create race to a foreign-template claim fails closed before wait — never exec'd or deleted", async () => {
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
      /references template other-template, not the configured beam-coding/,
    );
    expect(c.argv().some((a) => a.includes("wait"))).toBe(false); // never waited on the foreign claim
    expect(c.argv().some((a) => a.includes("exec"))).toBe(false); // never exec'd into it
    expect(c.argv().some((a) => a.includes("--raw"))).toBe(false); // never deleted it
  });

  test("losing the create race to an unlabeled claim fails closed the same way", async () => {
    const c = makeCluster();
    c.flag(
      "race-claim",
      JSON.stringify({ metadata: { uid: "raced-uid-3" }, spec: { sandboxTemplateRef: { name: "beam-coding" } } }),
    );
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await expect(p.provision({ id: "rc3" })).rejects.toThrow(/not managed by beam/);
    expect(c.argv().some((a) => a.includes("wait"))).toBe(false);
    expect(c.argv().some((a) => a.includes("exec"))).toBe(false);
  });

  test("provision pins the created claim's UID on the ref; the benign exact claim keeps working end to end", async () => {
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
  });

  test("a same-name claim with a foreign managed-by label refuses provision — no wait, no exec, no delete", async () => {
    const c = makeCluster();
    writeFileSync(
      join(c.claims, "beam-f9"),
      JSON.stringify({
        metadata: { uid: "foreign-uid", labels: { "app.kubernetes.io/managed-by": "someone-else" } },
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
  });

  test("a same-name claim missing the label entirely is refused the same way", async () => {
    const c = makeCluster();
    writeFileSync(
      join(c.claims, "beam-f8"),
      JSON.stringify({ metadata: { uid: "foreign-uid-2" }, spec: { sandboxTemplateRef: { name: "beam-coding" } } }),
    );
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    await expect(p.provision({ id: "f8" })).rejects.toThrow(/not managed by beam \(label .* is missing\)/);
    expect(existsSync(join(c.claims, "beam-f8"))).toBe(true);
  });

  test("a replaced claim (same name, new UID) is refused by connect and re-provision; destroy retires without touching it", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    const ref: { id: string; sandbox?: SandboxState } = { id: "z1" };
    await p.provision(ref);
    // Simulate out-of-band delete + recreate: same name, label, and
    // template — only the server-assigned UID differs.
    const stored = JSON.parse(readFileSync(join(c.claims, "beam-z1"), "utf8")) as { metadata: { uid: string } };
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
  });

  test("a delete raced by replacement is stopped by the UID precondition — never a fallback unconditional delete", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    const ref: { id: string; sandbox?: SandboxState } = { id: "z2" };
    await p.provision(ref);
    // The claim is swapped for a same-name/new-UID object immediately AFTER
    // destroy's identity read — the classic check-then-delete race window.
    c.flag("swap-uid-on-get");
    await p.destroy(ref); // must not throw: ours is gone, the record retires
    expect(existsSync(join(c.claims, "beam-z2"))).toBe(true); // the replacement survived
    expect(c.argv().filter((a) => a.includes("--raw")).length).toBe(1); // one pinned attempt, refused server-side
    expect(c.argv().some((a) => a.includes("delete") && !a.includes("--raw") && !a.includes("can-i"))).toBe(false);
  });

  test("a Sandbox owner entry with the right name but a different UID is an impostor chain — connect refuses", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    const ref: { id: string; sandbox?: SandboxState } = { id: "o4" };
    await p.provision(ref);
    c.flag("sandbox-owner-uid-bad");
    await expect(p.connect(ref)).rejects.toThrow(/not owned by SandboxClaim beam-o4/);
    expect(c.argv().some((a) => a.includes("exec"))).toBe(false);
  });

  test("a pod owner entry with the right Sandbox name but a different UID is an impostor chain — connect refuses", async () => {
    const c = makeCluster();
    const p = new AgentSandboxProvider(makeSpec(), c.bin);
    const ref: { id: string; sandbox?: SandboxState } = { id: "o5" };
    await p.provision(ref);
    c.flag("pod-owner-uid-bad");
    await expect(p.connect(ref)).rejects.toThrow(/not owned by Sandbox beam-o5/);
    expect(c.argv().some((a) => a.includes("exec"))).toBe(false);
  });

  test("each newly-forbidden grant is refused independently before any claim is created", async () => {
    for (const [grant, match] of [
      ["delete secrets beam-luiz", /delete Secrets/],
      ["deletecollection secrets beam-luiz", /deletecollection Secrets/],
      ["delete sandboxclaims.extensions.agents.x-k8s.io *", /delete SandboxClaims in ALL namespaces/],
    ] as const) {
      const c = makeCluster();
      c.perms({ ...LEAST_PRIV, [grant]: true });
      const p = new AgentSandboxProvider(makeSpec(), c.bin);
      await expect(p.provision({ id: "sd0" })).rejects.toThrow(match);
      expect(readdirSync(c.claims)).toEqual([]); // no claim was ever created
      expect(c.argv().some((a) => a.includes("create") && a.includes("-f"))).toBe(false);
    }
  });
});

describe("agent-sandbox doctor (least privilege)", () => {
  test("accepts the scoped beam-user credential and probes exec via --subresource, never pods/exec", async () => {
    const c = makeCluster();
    const report = await new AgentSandboxProvider(makeSpec(), c.bin).doctor();
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
    expect(c.argv().some((a) => a.includes("sandboxtemplates.extensions.agents.x-k8s.io/beam-coding"))).toBe(true);
  });

  test("rejects a credential that can create SandboxClaims across all namespaces", async () => {
    const c = makeCluster();
    c.perms({ ...LEAST_PRIV, "create sandboxclaims.extensions.agents.x-k8s.io *": true });
    const report = await new AgentSandboxProvider(makeSpec(), c.bin).doctor();
    expect(report.fatal).toMatch(/ALL namespaces/);
  });

  test("rejects a credential that can list SandboxClaims across all namespaces", async () => {
    const c = makeCluster();
    c.perms({ ...LEAST_PRIV, "list sandboxclaims.extensions.agents.x-k8s.io *": true });
    const report = await new AgentSandboxProvider(makeSpec(), c.bin).doctor();
    expect(report.fatal).toMatch(/ALL namespaces/);
  });

  test("rejects a credential that can read Secrets in the namespace", async () => {
    const c = makeCluster();
    c.perms({ ...LEAST_PRIV, "get secrets beam-luiz": true });
    const report = await new AgentSandboxProvider(makeSpec(), c.bin).doctor();
    expect(report.fatal).toMatch(/Secrets/);
  });

  test("reports missing namespace verbs instead of passing silently", async () => {
    const c = makeCluster();
    const perms = { ...LEAST_PRIV };
    delete perms["create pods/exec beam-luiz"];
    c.perms(perms);
    const report = await new AgentSandboxProvider(makeSpec(), c.bin).doctor();
    expect(report.fatal).toBeUndefined();
    expect(report.lines.join("\n")).toMatch(/MISSING.*exec into pods/);
  });

  test("a forbidden template read is reported as the exact missing narrow rule", async () => {
    const c = makeCluster();
    c.flag("template-forbidden");
    const report = await new AgentSandboxProvider(makeSpec(), c.bin).doctor();
    expect(report.fatal).toBeUndefined();
    expect(report.lines.join("\n")).toMatch(/sandboxtemplates\/beam-coding/);
  });

  test("rejects a credential that can create plain pods (bypasses the SandboxTemplate boundary)", async () => {
    const c = makeCluster();
    c.perms({ ...LEAST_PRIV, "create pods beam-luiz": true });
    const report = await new AgentSandboxProvider(makeSpec(), c.bin).doctor();
    expect(report.fatal).toMatch(/plain pods/);
  });

  test("one extra grant beyond the beam role is fatal — template, workload, and pod-mutation escapes", async () => {
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
      ["delete sandboxclaims.extensions.agents.x-k8s.io *", /delete SandboxClaims in ALL namespaces/],
    ];
    for (const [grant, match] of grants) {
      const c = makeCluster();
      c.perms({ ...LEAST_PRIV, [grant]: true });
      const report = await new AgentSandboxProvider(makeSpec(), c.bin).doctor();
      expect(report.fatal).toMatch(match);
    }
  }, 45_000); // 26 canned clusters × ~58 concurrent probes each

  test("fails closed when a boundary probe cannot be answered", async () => {
    const c = makeCluster();
    c.flag("can-i-fail");
    const report = await new AgentSandboxProvider(makeSpec(), c.bin).doctor();
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
    expect(t.interactiveArgv("tmux attach -t '=beam-p1'")).toEqual([
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
      "tmux attach -t '=beam-p1'",
    ]);
  });

  test("tar sync preserves contents both ways; sync-down never deletes local files by default", async () => {
    const c = makeCluster();
    const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-tar", c.bin);
    const local = join(c.state, "local-ws");
    mkdirSync(join(local, "src"), { recursive: true });
    writeFileSync(join(local, "hello.txt"), "hello\n");
    writeFileSync(join(local, "src", "deep.txt"), "deep\n");
    writeFileSync(join(local, "secret.env"), "nope\n");
    const remote = join(c.podHome, "data", "bipa", "ws"); // absolute root — no ~ assumption

    await t.syncUp(local, remote, { excludes: ["secret.env"], delete: true });
    expect(readFileSync(join(remote, "hello.txt"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(remote, "src", "deep.txt"), "utf8")).toBe("deep\n");
    expect(existsSync(join(remote, "secret.env"))).toBe(false);
    // a successful ship leaves the marker that licenses a mirrored sync-down
    expect(readFileSync(join(remote, ".beam", "kubectl-synced.v1"), "utf8")).toBe("beam kubectl sync v1");

    // a mirrored re-ship removes remote strays
    writeFileSync(join(remote, "stale.txt"), "old\n");
    await t.syncUp(local, remote, { excludes: ["secret.env"], delete: true });
    expect(existsSync(join(remote, "stale.txt"))).toBe(false);
    expect(existsSync(join(remote, "hello.txt"))).toBe(true);

    // remote work comes home; local-only files survive a default sync-down
    await t.execChecked(`printf theirs > ${shq(join(remote, "made-remotely.txt"))}`);
    writeFileSync(join(local, "local-only.txt"), "mine\n");
    await t.syncDown(remote, local, {});
    expect(readFileSync(join(local, "made-remotely.txt"), "utf8")).toBe("theirs");
    expect(existsSync(join(local, "local-only.txt"))).toBe(true);
    // the marker is transport bookkeeping — it must never land locally
    expect(existsSync(join(local, ".beam", "kubectl-synced.v1"))).toBe(false);

    // a mirrored sync-down prunes local strays but never excluded paths
    writeFileSync(join(local, "keep.env"), "x\n");
    await t.syncDown(remote, local, { delete: true, excludes: ["keep.env"] });
    expect(existsSync(join(local, "local-only.txt"))).toBe(false);
    expect(existsSync(join(local, "secret.env"))).toBe(false); // never shipped, so pruned
    expect(existsSync(join(local, "keep.env"))).toBe(true);
    expect(readFileSync(join(local, "hello.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(join(local, ".beam", "kubectl-synced.v1"))).toBe(false);
  });

  test("sync-up refuses suspicious destructive roots before the pod sees anything, and marks good ships", async () => {
    const c = makeCluster();
    const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-g", c.bin);
    const local = join(c.state, "local-ws");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "a.txt"), "a\n");

    const bads = [
      "/", // root
      "/data", // too short, one segment
      "relative/path", // not absolute
      "/one-segment-abc", // no workspace root above it
      "/data/bipa/../..", // not normalized
      `${join(c.podHome, "ws")}\n/tmp`, // not a single line
    ];
    for (const bad of bads) {
      await expect(t.syncUp(local, bad, { delete: true })).rejects.toThrow(/refusing to purge/);
    }
    expect(c.argv().length).toBe(0); // guard fired before any kubectl command ran

    const remote = join(c.podHome, "data", "ws-g");
    await t.syncUp(local, remote, { delete: true });
    expect(readFileSync(join(remote, ".beam", "kubectl-synced.v1"), "utf8")).toBe("beam kubectl sync v1");
  });

  test("mirrored sync-down without a genuine up marker refuses before touching local files", async () => {
    const c = makeCluster();
    const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-m", c.bin);
    const local = join(c.state, "local-ws");
    mkdirSync(join(local, "src"), { recursive: true });
    writeFileSync(join(local, "precious.txt"), "keep me\n");
    writeFileSync(join(local, "src", "deep.txt"), "deep\n");

    // a populated remote dir beam never shipped to: files but no marker
    const remote = join(c.podHome, "data", "ws-m");
    mkdirSync(remote, { recursive: true });
    writeFileSync(join(remote, "attacker.txt"), "planted\n");

    await expect(t.syncDown(remote, local, { delete: true })).rejects.toThrow(/refusing to mirror deletions/);
    expect(readFileSync(join(local, "precious.txt"), "utf8")).toBe("keep me\n"); // nothing deleted
    expect(readFileSync(join(local, "src", "deep.txt"), "utf8")).toBe("deep\n");
    expect(existsSync(join(local, "attacker.txt"))).toBe(false); // nothing landed either

    // The refusal came from the marker preflight — nothing was fetched:
    // the only exec is the `cat` probe, no tar stream ran.
    const execs = c.argv().filter((a) => a.includes("exec"));
    expect(execs.length).toBe(1);
    expect(execs[0]!.at(-1)!).toMatch(/(?:^|\n)cat .*kubectl-synced\.v1\n/);
    expect(c.argv().some((a) => a.some((el) => el.includes("tar -czf")))).toBe(false);

    // a forged marker with the wrong content is refused the same way
    mkdirSync(join(remote, ".beam"), { recursive: true });
    writeFileSync(join(remote, ".beam", "kubectl-synced.v1"), "not the marker");
    await expect(t.syncDown(remote, local, { delete: true })).rejects.toThrow(/refusing to mirror deletions/);
    expect(readFileSync(join(local, "precious.txt"), "utf8")).toBe("keep me\n");
    expect(existsSync(join(local, "attacker.txt"))).toBe(false);

    // without `delete` the same remote syncs down fine — non-destructive path
    await t.syncDown(remote, local, {});
    expect(readFileSync(join(local, "attacker.txt"), "utf8")).toBe("planted\n");
    expect(readFileSync(join(local, "precious.txt"), "utf8")).toBe("keep me\n");
    expect(existsSync(join(local, ".beam", "kubectl-synced.v1"))).toBe(false); // even a forged marker never lands
  });

  test("sync-down replaces a pre-existing outward symlink instead of writing through it", async () => {
    const c = makeCluster();
    const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-s", c.bin);
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
    expect(lstatSync(join(local, "escape")).isSymbolicLink()).toBe(false); // link replaced by a real dir
    expect(readFileSync(join(local, "escape", "payload.txt"), "utf8")).toBe("pwned\n");
  });

  test("a root-anchored exclude keeps its anchor on both legs — nested matches ship and survive a mirrored return", async () => {
    const c = makeCluster();
    const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-anch", c.bin);
    const local = join(c.state, "local-anch");
    mkdirSync(join(local, "build"), { recursive: true });
    mkdirSync(join(local, "src", "build"), { recursive: true });
    writeFileSync(join(local, "build", "root-artifact.o"), "root\n");
    writeFileSync(join(local, "src", "build", "nested-artifact.o"), "nested\n");
    writeFileSync(join(local, "src", "main.ts"), "main\n");
    const remote = join(c.podHome, "data", "ws-anch");

    await t.syncUp(local, remote, { excludes: ["/build"], delete: true });
    expect(existsSync(join(remote, "build"))).toBe(false); // anchored: the root dir is excluded
    expect(readFileSync(join(remote, "src", "build", "nested-artifact.o"), "utf8")).toBe("nested\n"); // nested ships

    // The same anchored pattern both filters AND protects the mirror leg:
    // /build survives --delete locally, nested src/build comes home intact
    // (the old tar translation widened /build to every depth on the fetch,
    // so --delete destroyed the nested copy).
    await t.syncDown(remote, local, { delete: true, excludes: ["/build"] });
    expect(readFileSync(join(local, "build", "root-artifact.o"), "utf8")).toBe("root\n");
    expect(readFileSync(join(local, "src", "build", "nested-artifact.o"), "utf8")).toBe("nested\n");
    expect(readFileSync(join(local, "src", "main.ts"), "utf8")).toBe("main\n");
  });

  test("a slash-carrying exclude keeps its rsync meaning on both legs", async () => {
    const c = makeCluster();
    const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-sl", c.bin);
    const local = join(c.state, "local-sl");
    mkdirSync(join(local, "build"), { recursive: true });
    mkdirSync(join(local, "src", "build"), { recursive: true });
    writeFileSync(join(local, "build", "root-artifact.o"), "root\n");
    writeFileSync(join(local, "src", "build", "nested-artifact.o"), "nested\n");
    const remote = join(c.podHome, "data", "ws-sl");

    await t.syncUp(local, remote, { excludes: ["src/build"], delete: true });
    expect(readFileSync(join(remote, "build", "root-artifact.o"), "utf8")).toBe("root\n"); // top-level build ships
    expect(existsSync(join(remote, "src", "build"))).toBe(false); // the slash pattern excluded the nested one

    await t.syncDown(remote, local, { delete: true, excludes: ["src/build"] });
    expect(readFileSync(join(local, "src", "build", "nested-artifact.o"), "utf8")).toBe("nested\n"); // protected from --delete
    expect(readFileSync(join(local, "build", "root-artifact.o"), "utf8")).toBe("root\n");
  });

  test("excluding .beam/ or the marker name never blocks a mirrored return — the license is probed remotely", async () => {
    const c = makeCluster();
    const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-x", c.bin);
    for (const [tag, exclude] of [
      ["beamdir", ".beam/"],
      ["marker", "kubectl-synced.v1"],
    ] as const) {
      const local = join(c.state, `local-${tag}`);
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, "hello.txt"), "hello\n");
      const remote = join(c.podHome, "data", `ws-${tag}`);

      await t.syncUp(local, remote, { excludes: [exclude], delete: true });
      // the marker is written by syncUp itself, past the content filters
      expect(readFileSync(join(remote, ".beam", "kubectl-synced.v1"), "utf8")).toBe("beam kubectl sync v1");

      await t.execChecked(`printf theirs > ${shq(join(remote, "made-remotely.txt"))}`);
      writeFileSync(join(local, "local-only.txt"), "mine\n");
      await t.syncDown(remote, local, { delete: true, excludes: [exclude] });
      expect(readFileSync(join(local, "made-remotely.txt"), "utf8")).toBe("theirs");
      expect(existsSync(join(local, "local-only.txt"))).toBe(false); // the mirror really ran
      expect(existsSync(join(local, ".beam", "kubectl-synced.v1"))).toBe(false); // marker still never lands
    }
  });

  test("staging trees are cleaned up on success, on refusal, and on a failed fetch", async () => {
    const c = makeCluster();
    const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-st", c.bin);
    const local = join(c.state, "local-st");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "a.txt"), "a\n");
    const remote = join(c.podHome, "data", "ws-st");
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("beam-syncup-") || n.startsWith("beam-syncdown-"));

    await t.syncUp(local, remote, { delete: true });
    await t.syncDown(remote, local, { delete: true });

    // refusal path: a foreign dir without the marker
    const foreign = join(c.podHome, "data", "ws-foreign");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "x.txt"), "x\n");
    await expect(t.syncDown(foreign, local, { delete: true })).rejects.toThrow(/refusing to mirror/);

    // failure path: the remote tar dies mid-fetch
    c.flag("exec-fail-pattern", "tar -czf");
    try {
      await expect(t.syncDown(remote, local, {})).rejects.toThrow();
    } finally {
      rmSync(join(c.state, "exec-fail-pattern"));
    }

    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("beam-syncup-") || n.startsWith("beam-syncdown-"));
    expect(after.filter((n) => !before.includes(n))).toEqual([]);
  });

  test("~ paths resolve against the pod's HOME through the exec channel", async () => {
    const c = makeCluster();
    const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-h", c.bin);
    writeFileSync(join(c.state, "payload.txt"), "payload\n");
    await t.sendFile(join(c.state, "payload.txt"), "~/nested/dir/copy.txt");
    expect(readFileSync(join(c.podHome, "nested", "dir", "copy.txt"), "utf8")).toBe("payload\n");
    expect(await t.exists("~/nested/dir/copy.txt")).toBe(true);
    expect(await t.exists("~/nope")).toBe(false);
    await t.fetchFile("~/nested/dir/copy.txt", join(c.state, "back", "copy.txt"));
    expect(readFileSync(join(c.state, "back", "copy.txt"), "utf8")).toBe("payload\n");
  });

  test("every syncUp attempt invalidates the marker first — a failed overlay after a successful ship leaves no license", async () => {
    const c = makeCluster();
    const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-inv", c.bin);
    const local = join(c.state, "local-inv");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "precious.txt"), "keep me\n");
    const remote = join(c.podHome, "data", "ws-inv");

    // First ship succeeds and earns the marker…
    await t.syncUp(local, remote, { delete: true });
    expect(readFileSync(join(remote, ".beam", "kubectl-synced.v1"), "utf8")).toBe("beam kubectl sync v1");
    // …and the FIRST remote action of that attempt was the invalidation
    // (behind the same-shell no-follow guard — the only thing allowed to
    // precede it, and it mutates nothing).
    const execs = c
      .argv()
      .filter((a) => a.includes("exec"))
      .map((a) => a.at(-1)!);
    expect(execs[0]).toMatch(/(?:^|\n)rm -f .*kubectl-synced\.v1\n/);

    // A second, NON-delete overlay dies mid-ship: the stale first-ship
    // marker must not survive it.
    writeFileSync(join(local, "extra.txt"), "more\n");
    c.flag("exec-fail-pattern", "tar -xzf");
    try {
      await expect(t.syncUp(local, remote, {})).rejects.toThrow();
    } finally {
      rmSync(join(c.state, "exec-fail-pattern"));
    }
    expect(existsSync(join(remote, ".beam", "kubectl-synced.v1"))).toBe(false);

    // So a mirrored return is refused before a single local byte changes.
    await t.execChecked(`printf planted > ${shq(join(remote, "attacker.txt"))}`);
    await expect(t.syncDown(remote, local, { delete: true })).rejects.toThrow(/refusing to mirror deletions/);
    expect(readFileSync(join(local, "precious.txt"), "utf8")).toBe("keep me\n");
    expect(existsSync(join(local, "attacker.txt"))).toBe(false);

    // A fresh successful ship re-earns the marker; the mirror works again.
    await t.syncUp(local, remote, {});
    expect(readFileSync(join(remote, ".beam", "kubectl-synced.v1"), "utf8")).toBe("beam kubectl sync v1");
    await t.syncDown(remote, local, { delete: true });
    expect(readFileSync(join(local, "attacker.txt"), "utf8")).toBe("planted"); // shipped before the overlay retry
  });

  test("a failed marker invalidation aborts the ship before anything ships — delete and non-delete alike", async () => {
    const c = makeCluster();
    const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-inv2", c.bin);
    const local = join(c.state, "local-inv2");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "a.txt"), "a\n");
    const remote = join(c.podHome, "data", "ws-inv2");
    c.flag("exec-fail-pattern", "rm -f");
    try {
      await expect(t.syncUp(local, remote, { delete: true })).rejects.toThrow();
      await expect(t.syncUp(local, remote, {})).rejects.toThrow();
    } finally {
      rmSync(join(c.state, "exec-fail-pattern"));
    }
    expect(existsSync(remote)).toBe(false); // nothing ever shipped
    expect(c.argv().filter((a) => a.includes("exec")).length).toBe(2); // only the two failed invalidations ran
  });

  test("marker invalidation refuses a symlinked .beam — nothing is deleted or written through it", async () => {
    const c = makeCluster();
    const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-symb", c.bin);
    const local = join(c.state, "local-symb");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "a.txt"), "a\n");

    // A reused workspace whose agent swapped .beam for an outward symlink.
    // The outside dir carries the marker's FIXED NAME: an unguarded
    // invalidation would rm it straight through the link.
    const outside = join(c.state, "outside-symb");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "kubectl-synced.v1"), "beam kubectl sync v1");
    const remote = join(c.podHome, "data", "ws-symb");
    mkdirSync(remote, { recursive: true });
    symlinkSync(outside, join(remote, ".beam"));

    // Mirrored and plain ships both refuse at the first remote action.
    await expect(t.syncUp(local, remote, { delete: true })).rejects.toThrow(/is a symlink/);
    await expect(t.syncUp(local, remote, {})).rejects.toThrow(/is a symlink/);

    // The outside file survived byte-for-byte, nothing new landed there,
    // the link itself is intact, and nothing ever shipped.
    expect(readdirSync(outside)).toEqual(["kubectl-synced.v1"]);
    expect(readFileSync(join(outside, "kubectl-synced.v1"), "utf8")).toBe("beam kubectl sync v1");
    expect(lstatSync(join(remote, ".beam")).isSymbolicLink()).toBe(true);
    expect(readdirSync(remote)).toEqual([".beam"]);
    expect(c.argv().filter((a) => a.includes("exec")).length).toBe(2); // only the two refused invalidations ran
  });

  test("a .beam swapped mid-ship fails the marker creation — no marker lands anywhere and no license survives", async () => {
    const c = makeCluster();
    const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-swap", c.bin);
    const local = join(c.state, "local-swap");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "precious.txt"), "keep me\n");

    const outside = join(c.state, "outside-swap");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "kubectl-synced.v1"), "sentinel — not a beam marker");
    const remote = join(c.podHome, "data", "ws-swap");

    // The pod agent swaps .beam for an outward symlink right after the tar
    // extraction — between the ship and the marker-creation shell.
    c.flag("exec-hook-pattern", "tar -xzf");
    writeFileSync(
      join(c.state, "exec-hook.sh"),
      `rm -rf ${shq(join(remote, ".beam"))}\nln -s ${shq(outside)} ${shq(join(remote, ".beam"))}\n`,
    );
    try {
      await expect(t.syncUp(local, remote, { delete: true })).rejects.toThrow(/is a symlink/);
    } finally {
      rmSync(join(c.state, "exec-hook-pattern"));
      rmSync(join(c.state, "exec-hook.sh"));
    }

    // The creation guard refused: the fixed-name outside file is unchanged
    // — the marker was NOT planted through the link.
    expect(readdirSync(outside)).toEqual(["kubectl-synced.v1"]);
    expect(readFileSync(join(outside, "kubectl-synced.v1"), "utf8")).toBe("sentinel — not a beam marker");

    // And the failed attempt left no valid license: a mirrored return
    // refuses before a single local byte changes.
    await expect(t.syncDown(remote, local, { delete: true })).rejects.toThrow(/refusing to mirror deletions/);
    expect(readFileSync(join(local, "precious.txt"), "utf8")).toBe("keep me\n");
  });

  test("sync-up refuses a symlinked destination in the same shell as its first remote action — nothing ships, no marker lands", async () => {
    const c = makeCluster();
    const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-cap", c.bin);
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

    // Mirrored and plain ships both refuse before a single byte moves.
    await expect(t.syncUp(local, remote, { delete: true })).rejects.toThrow(/symlinked path/);
    await expect(t.syncUp(local, remote, {})).rejects.toThrow(/symlinked path/);

    // The outside directory holds exactly its sentinel: nothing shipped,
    // nothing deleted, and no sync marker was planted through the link.
    expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
    expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe("untouched\n");
  });

  test("sync-down refuses a symlinked source before any local byte changes", async () => {
    const c = makeCluster();
    const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-cap2", c.bin);
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

  test("exec reports the real remote exit status — kubectl succeeds only after the trailer lands", async () => {
    const c = makeCluster();
    const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-rc", c.bin);

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
    await expect(t.execChecked("printf nope >&2; exit 7")).rejects.toThrow(/command failed \(7\)/);
  });

  test("kubectl/API failure is a thrown transport error, never a remote exit code", async () => {
    // A kubectl that dies before the remote shell ever runs — the classic
    // `unable to upgrade connection` API failure, local exit 1, which the
    // unwrapped transport used to hand back as a remote {code: 1}.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "beam-kubectl-apifail-")));
    const bin = join(dir, "kubectl");
    writeFileSync(
      bin,
      `#!/bin/bash\necho 'error: unable to upgrade connection: container not found ("sandbox")' >&2\nexit 1\n`,
    );
    chmodSync(bin, 0o755);
    const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-af", bin);

    // exec throws with kubectl's own stderr instead of returning {code: 1}…
    await expect(t.exec("tmux has-session -t '=beam-x'")).rejects.toThrow(/unable to upgrade connection/);
    // …so exists() can never read an unanswerable probe as "absent"…
    await expect(t.exists("/data/beam/ws")).rejects.toThrow(/kubectl exit 1/);
    // …and the tmux liveness probe aborts reused-up instead of reporting a
    // dead session (which would greenlight destructive follow-ons).
    const rt = new TmuxRuntime(t, "beam-af-sock");
    await expect(rt.alive("beam-x")).rejects.toThrow(/unable to upgrade connection/);
  });

  test("a truncated exec stream — kubectl exit 0 without the trailer — is a transport error", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "beam-kubectl-trunc-")));
    const bin = join(dir, "kubectl");
    writeFileSync(bin, `#!/bin/bash\nprintf 'partial output\\n'\nexit 0\n`);
    chmodSync(bin, 0o755);
    const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-tr", bin);
    await expect(t.exec("true")).rejects.toThrow(/trailer is missing or malformed/);
  });

  describe.skipIf(Bun.which("tmux") === null)("tmux liveness over kubectl exec", () => {
    test("a real has-session exit 1 means not-alive — the one code that legitimately says no", async () => {
      const c = makeCluster();
      const t = new KubectlTransport({ context: "ctx", namespace: "ns", container: "sandbox" }, "beam-tl", c.bin);
      // Private socket with no server: tmux itself answers has-session
      // with a genuine exit 1, which must come back as a calm `false`.
      const rt = new TmuxRuntime(t, `beam-test-rc-${Math.random().toString(36).slice(2, 10)}`);
      expect(await rt.alive("beam-nope")).toBe(false);
    });
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

  test("up --no-start then up reuses the record and the claim — no duplicates", async () => {
    await cmdUp(["--no-session", "--no-start"]);
    let records = loadState(resolveEnv()).records;
    expect(records.length).toBe(1);
    const id = records[0]!.id;
    expect(records[0]!.sandbox?.claim).toBe(`beam-${id}`);
    expect(records[0]!.sandbox?.container).toBe("sandbox");
    expect(readdirSync(c.claims)).toEqual([`beam-${id}`]);

    const wsDirs = readdirSync(join(c.podHome, "data", "bipa"));
    expect(wsDirs.length).toBe(1);
    expect(readFileSync(join(c.podHome, "data", "bipa", wsDirs[0]!, "hello.txt"), "utf8")).toBe("hello\n");

    await cmdUp(["--no-session", "--no-start"]);
    records = loadState(resolveEnv()).records;
    expect(records.length).toBe(1); // reused, not duplicated
    expect(records[0]!.id).toBe(id);
    expect(readdirSync(c.claims)).toEqual([`beam-${id}`]);
    expect(records[0]!.remoteCwd).toBe(join(c.podHome, "data", "bipa", wsDirs[0]!));
  });

  test("down --no-purge leaves the record reusable with its single claim", async () => {
    const record = loadState(resolveEnv()).records[0]!;
    await cmdDown([record.id, "--no-purge"]);
    expect(existsSync(join(c.claims, record.sandbox!.claim))).toBe(true);
    expect(loadState(resolveEnv()).records[0]!.status).toBe("up");

    await cmdUp(["--no-session", "--no-start"]);
    const records = loadState(resolveEnv()).records;
    expect(records.length).toBe(1);
    expect(records[0]!.id).toBe(record.id);
    expect(readdirSync(c.claims)).toEqual([record.sandbox!.claim]);
  });

  test("kill without purge leaves the record reusable with its single claim", async () => {
    const record = loadState(resolveEnv()).records[0]!;
    await cmdKill([record.id]);
    expect(existsSync(join(c.claims, record.sandbox!.claim))).toBe(true);
    expect(loadState(resolveEnv()).records[0]!.status).toBe("up");

    await cmdUp(["--no-session", "--no-start"]);
    const records = loadState(resolveEnv()).records;
    expect(records.length).toBe(1);
    expect(records[0]!.id).toBe(record.id);
    expect(readdirSync(c.claims)).toEqual([record.sandbox!.claim]);
  });

  test("down syncs back first and deletes the claim only on the successful purge path", async () => {
    const record = loadState(resolveEnv()).records[0]!;
    writeFileSync(join(record.remoteCwd, "made-remotely.txt"), "theirs\n");
    await cmdDown([record.id]);
    expect(readFileSync(join(workDir, "made-remotely.txt"), "utf8")).toBe("theirs\n");
    expect(existsSync(join(c.claims, record.sandbox!.claim))).toBe(false); // claim deleted
    expect(loadState(resolveEnv()).records[0]!.status).toBe("down");
    const del = c.argv().find((a) => a.includes("--raw") && a.some((el) => el.includes(record.sandbox!.claim)))!;
    expect(del).toContain("delete"); // the UID-preconditioned raw delete, nothing unconditional
  });

  test("a failed sync-back keeps the claim and the record stays up", async () => {
    await cmdUp(["--no-session", "--no-start"]);
    const record = loadState(resolveEnv()).records.find((r) => r.status === "up")!;
    c.flag("exec-fail-pattern", "tar -czf");
    try {
      await expect(cmdDown([record.id])).rejects.toThrow();
    } finally {
      rmSync(join(c.state, "exec-fail-pattern"));
    }
    expect(existsSync(join(c.claims, record.sandbox!.claim))).toBe(true); // claim preserved
    expect(loadState(resolveEnv()).records.find((r) => r.id === record.id)!.status).toBe("up");
    const dels = c
      .argv()
      .filter((a) => (a.includes("delete") || a.includes("--raw")) && a.some((el) => el.includes(record.sandbox!.claim)));
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

  test("up persists the claim UID; a replaced claim refuses down/attach/login/kill --purge/up with no exec, no delete", async () => {
    await cmdUp(["--no-session", "--no-start"]);
    const record = loadState(resolveEnv()).records[0]!;
    const claimFile = join(c.claims, record.sandbox!.claim);
    const stored = JSON.parse(readFileSync(claimFile, "utf8")) as { metadata: { uid: string } };
    // `beam up` persisted the created claim's server-assigned UID.
    expect(record.sandbox!.uid).toBe(stored.metadata.uid);

    // Out-of-band delete + recreate: same name/label/template, new UID.
    stored.metadata.uid = "replacement-uid";
    writeFileSync(claimFile, JSON.stringify(stored));

    const argvBefore = c.argv().length;
    await expect(cmdDown([record.id])).rejects.toThrow(/is not the one this record created/);
    await expect(cmdAttach([record.id])).rejects.toThrow(/is not the one this record created/);
    await expect(cmdLogin(["k8s", "--tool", "claude"])).rejects.toThrow(/is not the one this record created/);
    // kill --purge cannot prove the (shipped) workspace erasure through a
    // claim beam refuses to connect to — fail closed, record and claim intact.
    await expect(cmdKill([record.id, "--purge"])).rejects.toThrow(/refusing to delete the claim/);
    // Re-shipping through the record refuses the impostor instead of
    // adopting it (kept last: a refused up may re-journal `provisioning`).
    await expect(cmdUp(["--no-session", "--no-start"])).rejects.toThrow(/is not the one this record created/);

    const delta = c.argv().slice(argvBefore);
    expect(delta.some((a) => a.includes("exec"))).toBe(false); // nothing was ever exec'd
    expect(delta.some((a) => a.includes("--raw"))).toBe(false); // nothing was ever deleted
    expect(delta.some((a) => a.includes("delete") && !a.includes("can-i"))).toBe(false);
    expect(existsSync(claimFile)).toBe(true); // the replacement claim survived
    // The record never lied its way into a terminal state.
    expect(["down", "killed"]).not.toContain(loadState(resolveEnv()).records[0]!.status);
  });
});

describe("agent-sandbox target validation", () => {
  test("kubeconfig is required and must be non-empty — the ambient kubeconfig is never a fallback", () => {
    expect(() => new AgentSandboxProvider(makeSpec({ kubeconfig: "" }))).toThrow(/kubeconfig/);
    expect(() => new AgentSandboxProvider(makeSpec({ kubeconfig: "   " }))).toThrow(/kubeconfig/);
    const missing = { ...makeSpec() } as Record<string, unknown>;
    delete missing.kubeconfig;
    expect(() => new AgentSandboxProvider(missing as unknown as AgentSandboxTargetSpec)).toThrow(/kubeconfig/);
  });

  test("namespace and container must be DNS labels", () => {
    expect(() => new AgentSandboxProvider(makeSpec({ namespace: "Bad_NS" }))).toThrow(/DNS label/);
    expect(() => new AgentSandboxProvider(makeSpec({ namespace: "-leading" }))).toThrow(/DNS label/);
    expect(() => new AgentSandboxProvider(makeSpec({ container: "UPPER" }))).toThrow(/DNS label/);
  });

  test("template must be a DNS subdomain — a leading dash can never become a kubectl flag", () => {
    expect(() => new AgentSandboxProvider(makeSpec({ template: "-oyaml" }))).toThrow(/DNS subdomain/);
    expect(() => new AgentSandboxProvider(makeSpec({ template: "bad..dots" }))).toThrow(/DNS subdomain/);
    expect(() => new AgentSandboxProvider(makeSpec({ template: "ok.sub-domain.v1" }))).not.toThrow();
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
      JSON.stringify({ type: "session_meta", payload: { session_id: `cx${seq}`, cwd: workDir } }) + "\n",
    );
    await cmdUp(["--no-start", "--tool", "codex"]);
    return { remoteStore: join(c.podHome, ".codex", "sessions", "2026", "08", "15", name) };
  }

  test("down purge erases the workspace and the pod-home session store BEFORE the claim delete", async () => {
    const { remoteStore } = await upWithCodexSession();
    expect(existsSync(remoteStore)).toBe(true);
    const record = loadState(resolveEnv()).records.at(-1)!;
    const argvBefore = c.argv().length;
    await cmdDown([record.id]);
    // Claim deletion is never trusted as storage erasure: on a
    // persistent-home template both the workspace and the session store
    // would outlive the claim, so beam removes them itself.
    expect(existsSync(remoteStore)).toBe(false);
    expect(existsSync(record.remoteCwd)).toBe(false);
    expect(existsSync(join(c.claims, record.sandbox!.claim))).toBe(false);
    // Order is load-bearing: workspace rm ran while the sandbox still
    // existed — strictly before the claim DELETE.
    const delta = c.argv().slice(argvBefore).map((a) => a.join(" "));
    const rmIdx = delta.findIndex((a) => a.includes("rm -rf") && a.includes(record.remoteCwd));
    const delIdx = delta.findIndex((a) => a.includes("delete") && a.includes(record.sandbox!.claim));
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(rmIdx);
  });

  test("kill --purge erases the workspace and the session store before deleting the claim", async () => {
    const { remoteStore } = await upWithCodexSession();
    expect(existsSync(remoteStore)).toBe(true);
    const record = loadState(resolveEnv()).records.at(-1)!;
    await cmdKill([record.id, "--purge"]);
    expect(existsSync(remoteStore)).toBe(false);
    expect(existsSync(record.remoteCwd)).toBe(false);
    expect(existsSync(join(c.claims, record.sandbox!.claim))).toBe(false);
    expect(loadState(resolveEnv()).records.at(-1)!.status).toBe("killed");
  });
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

  test("a provision failure leaves a `provisioning` record that already carries the session identity", async () => {
    c.flag("wait-fail");
    try {
      await expect(cmdUp(["--no-start", "-m", "carry on"])).rejects.toThrow(/did not become Ready/);
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
  });

  test("a retried up resumes the provisioning record and finishes it — no duplicate record or claim", async () => {
    await cmdUp(["--no-start"]);
    const records = loadState(resolveEnv()).records;
    expect(records.length).toBe(1);
    const r = records[0]!;
    expect(r.status).toBe("up");
    expect(readdirSync(c.claims)).toEqual([`beam-${r.id}`]);
    expect(r.remoteCwd.startsWith(join(c.podHome, "data", "bipa"))).toBe(true); // resolved, persisted
    expect(r.remoteCwdResolved).toBe(true);
    // The retry reused the claim through the UID pin persisted by the failed
    // attempt — and the finished record still carries that exact identity.
    const stored = JSON.parse(readFileSync(join(c.claims, `beam-${r.id}`), "utf8")) as {
      metadata: { uid: string };
    };
    expect(r.sandbox?.uid).toBe(stored.metadata.uid);
  });

  test("config drift (root/context/namespace/socket) cannot redirect a reused handoff", async () => {
    const before = loadState(resolveEnv()).records[0]!;
    const driftedRoot = join(c.podHome, "data", "drifted");
    writeFileSync(
      join(beamDir, "config.json"),
      targetConfig({
        context: "other-ctx",
        namespace: "elsewhere",
        template: "other-template",
        root: driftedRoot,
        tmuxSocket: "drift",
      }),
    );
    const argvBefore = c.argv().length;
    // No --no-session: this record shipped sm-session, and clearing the
    // sole identity of a shipped record is refused — omitted args retain it.
    await cmdUp(["--no-start"]);
    const after = loadState(resolveEnv()).records[0]!;
    expect(after.id).toBe(before.id);
    expect(after.remoteCwd).toBe(before.remoteCwd); // snapshot root sticks
    expect(existsSync(driftedRoot)).toBe(false); // nothing shipped to the drifted root
    for (const argv of c.argv().slice(argvBefore)) {
      // every kubectl call stays pinned to the recorded coordinates
      expect(argv.join(" ")).not.toContain("elsewhere");
      expect(argv.join(" ")).not.toContain("other-ctx");
    }
  });

  test("a second workspace is refused while the target is held — no second record or claim", async () => {
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
    expect(readdirSync(c.claims)).toEqual([active.sandbox!.claim]);
  });

  test("agent→static drift cannot create a second record: the live claim keeps its target-wide hold", async () => {
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
      // agent-sandbox snapshot — nothing lands under the drifted local root.
      // Omitted session args: the shipped record retains sm-session
      // (--no-session would be a refused identity clear).
      await cmdUp(["--no-start"]);
      const after = loadState(resolveEnv()).records;
      expect(after.length).toBe(1);
      expect(after[0]!.id).toBe(active.id);
      expect(after[0]!.remoteCwd).toBe(active.remoteCwd);
      expect(existsSync(staticRoot)).toBe(false);
    } finally {
      writeFileSync(join(beamDir, "config.json"), targetConfig());
    }
  });

  test("an interrupted claim DELETE parks the record in `teardown`; the retry finalizes down without reconnecting", async () => {
    const record = loadState(resolveEnv()).records[0]!;
    c.flag("delete-fail");
    try {
      await expect(cmdDown([record.id])).rejects.toThrow();
    } finally {
      rmSync(join(c.state, "delete-fail"));
    }
    // Sync-back and remote cleanup succeeded; only the DELETE is ambiguous.
    expect(loadState(resolveEnv()).records[0]!.status).toBe("teardown");
    expect(existsSync(join(c.claims, record.sandbox!.claim))).toBe(true);

    // The DELETE had actually been acknowledged server-side (claim gone), so
    // any reconnect would fail — the retry must not attempt one.
    rmSync(join(c.claims, record.sandbox!.claim));
    const argvBefore = c.argv().length;
    await cmdDown([record.id]);
    expect(loadState(resolveEnv()).records[0]!.status).toBe("down");
    const delta = c.argv().slice(argvBefore);
    expect(delta.some((a) => a.includes("exec"))).toBe(false); // no connect, no sync
    // destroy re-reads ONLY the claim (its identity gate); it never walks
    // the pod chain, and a claim already gone needs no delete at all.
    expect(delta.some((a) => a.includes("get") && a.some((el) => el.includes("sandboxclaims")))).toBe(true);
    expect(delta.some((a) => a.includes("get") && (a.includes("pod") || a.includes("pods")))).toBe(false);
    expect(delta.some((a) => a.includes("--raw"))).toBe(false); // nothing left to delete
  });
});

describe("concurrent same-workspace up (two beam processes)", () => {
  test(
    "exactly one process owns the remote effects and the persisted session identity",
    async () => {
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

      const goFile = join(home, "go");
      const script = join(home, "up-child.ts");
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
          cwd: workDir,
          env: { ...process.env, BEAM_HOME: home, BEAM_DIR: beamDir, PATH: `${c.binDir}:${process.env.PATH}` },
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

      // Exactly one winner; the loser is refused promptly and actionably.
      expect([codeA, codeB].filter((x) => x === 0).length).toBe(1);
      expect([codeA, codeB].filter((x) => x === 3).length).toBe(1);
      expect(codeA === 0 ? errB : errA).toMatch(/already operating on handoff/);

      // One record, up, carrying the WINNER's session identity — the loser
      // never got far enough to overwrite it or ship anything.
      const winnerRef = (codeA === 0 ? outA : outB).match(/WON (race-[ab])/)?.[1];
      expect(winnerRef).toBeDefined();
      const records = loadState({ home, beamDir }).records;
      expect(records.length).toBe(1);
      expect(records[0]!.status).toBe("up");
      expect(records[0]!.sessionId).toBe(winnerRef!);
      expect(readdirSync(c.claims)).toEqual([`beam-${records[0]!.id}`]);
    },
    30_000,
  );
});

const START_SOCKET = `beam-start-${process.pid}`;

describe.skipIf(Bun.which("tmux") === null)("interrupted start (`starting` phase, canned kubectl)", () => {
  let c: Cluster;
  let home: string;
  let workDir: string;
  let storeDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  let savedCwd: string;

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
            tmuxSocket: START_SOCKET,
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
    await run(["tmux", "-L", START_SOCKET, "kill-server"]);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test(
    "a retry finding live tmux while `starting` finalizes the record: same session identity, nothing re-shipped",
    async () => {
      await cmdUp(["--no-start"]);
      const before = loadState(resolveEnv()).records[0]!;
      expect(before.status).toBe("up");
      expect(before.sessionId).toBe("st-session");

      // Recreate the crash window exactly: the previous up started the
      // agent's tmux session and died before flipping `up`.
      await run(["tmux", "-L", START_SOCKET, "new-session", "-d", "-s", before.tmux, "sleep 300"]);
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
      expect(existsSync(join(after.remoteCwd, "late-local.txt"))).toBe(false); // nothing re-shipped

      // With the record `up` and the agent still alive, a plain re-up keeps
      // refusing to clobber it.
      await expect(cmdUp([])).rejects.toThrow(/already has a live agent/);
    },
    30_000,
  );
});

describe("interrupted purge (`purging` phase, canned kubectl)", () => {
  let c: Cluster;
  let home: string;
  let workDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  let savedCwd: string;

  beforeAll(() => {
    savedCwd = process.cwd();
    for (const k of ["BEAM_HOME", "BEAM_DIR", "PATH"]) savedEnv[k] = process.env[k];
    c = makeCluster();
    home = realpathSync(mkdtempSync(join(tmpdir(), "beam-purge-home-")));
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

  test("a cleanup failure parks `purging` with the claim intact; the retry repeats cleanup and never re-collects", async () => {
    // Codex: the session store lives OUTSIDE the workspace, so its checked
    // cleanup is a distinct failure point after collection succeeded.
    const day = join(home, ".codex", "sessions", "2026", "08", "15");
    mkdirSync(day, { recursive: true });
    const storeName = "rollout-2026-08-15T10-00-px1.jsonl";
    const localStore = join(day, storeName);
    writeFileSync(
      localStore,
      JSON.stringify({ type: "session_meta", payload: { session_id: "px1", cwd: workDir } }) + "\n",
    );

    await cmdUp(["--no-start", "--tool", "codex"]);
    const record = loadState(resolveEnv()).records[0]!;
    const remoteStore = join(c.podHome, ".codex", "sessions", "2026", "08", "15", storeName);
    expect(existsSync(remoteStore)).toBe(true);
    writeFileSync(join(record.remoteCwd, "made-remotely.txt"), "theirs\n");

    // First down: sync + collect succeed, then the checked trace removal
    // dies (its exact command shape, nothing else).
    c.flag("exec-fail-pattern", 'rm -f "$HOME/.codex');
    try {
      await expect(cmdDown([record.id])).rejects.toThrow();
    } finally {
      rmSync(join(c.state, "exec-fail-pattern"));
    }
    expect(loadState(resolveEnv()).records[0]!.status).toBe("purging"); // journaled post-collection
    expect(readFileSync(join(workDir, "made-remotely.txt"), "utf8")).toBe("theirs\n"); // collection landed
    expect(existsSync(join(c.claims, record.sandbox!.claim))).toBe(true); // cleanup failed BEFORE the claim delete
    expect(existsSync(remoteStore)).toBe(true); // the trace really is what survived

    // Anything appearing remotely after collection must NOT come home on
    // the retry: the purging path never re-syncs or re-collects.
    writeFileSync(join(record.remoteCwd, "late-remote.txt"), "late\n");
    appendFileSync(remoteStore, '{"type":"late"}\n');

    await cmdDown([record.id]);
    expect(loadState(resolveEnv()).records[0]!.status).toBe("down");
    expect(existsSync(join(workDir, "late-remote.txt"))).toBe(false); // no re-sync
    expect(readFileSync(localStore, "utf8")).not.toContain('"type":"late"'); // no re-collect
    expect(existsSync(remoteStore)).toBe(false); // cleanup repeated and finished
    expect(existsSync(record.remoteCwd)).toBe(false); // workspace erased
    expect(existsSync(join(c.claims, record.sandbox!.claim))).toBe(false); // claim deleted last
  });
});

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

  test("kill --purge reaches the claim delete for a Ready-timeout record whose remote cwd never resolved", async () => {
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
    expect(existsSync(join(c.claims, record.sandbox!.claim))).toBe(true);

    const argvBefore = c.argv().length;
    await cmdKill([record.id, "--purge"]);
    expect(existsSync(join(c.claims, record.sandbox!.claim))).toBe(false); // destroy was reached
    expect(loadState(resolveEnv()).records[0]!.status).toBe("killed");
    // Nothing was ever shipped, so no rm ran — and the path guard never got
    // the chance to block the destroy.
    const delta = c.argv().slice(argvBefore).map((a) => a.join(" "));
    expect(delta.some((a) => a.includes("rm -rf"))).toBe(false);
  });

  test("kill without purge never promotes: down stays down, provisioning stays provisioning", async () => {
    // A fully-down'd handoff: the claim is gone and the record terminal.
    await cmdUp(["--no-session", "--no-start"]);
    const finished = loadState(resolveEnv()).records.at(-1)!;
    await cmdDown([finished.id]);
    expect(loadState(resolveEnv()).records.at(-1)!.status).toBe("down");
    await cmdKill([finished.id]); // sandbox gone; must not resurrect the record
    expect(loadState(resolveEnv()).records.at(-1)!.status).toBe("down");

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
    expect(loadState(resolveEnv()).records.find((r) => r.id === prov.id)!.status).toBe("provisioning");

    // …and remains abandonable afterwards.
    await cmdKill([prov.id, "--purge"]);
    expect(loadState(resolveEnv()).records.find((r) => r.id === prov.id)!.status).toBe("killed");
    expect(existsSync(join(c.claims, prov.sandbox!.claim))).toBe(false);
  });
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

  test("down and kill refuse promptly while another process operates on the record (up/down/kill races)", async () => {
    await cmdUp(["--no-session", "--no-start"]);
    const record = loadState(resolveEnv()).records[0]!;
    expect(record.status).toBe("up");
    // A live owner mid-remote-sequence — exactly what an in-flight `beam
    // up`, `beam down`, or `beam kill` looks like from a second process.
    const release = acquireOperationLock(resolveEnv(), record.id);
    try {
      await expect(cmdDown([record.id])).rejects.toThrow(/already operating on handoff/);
      await expect(cmdKill([record.id, "--purge"])).rejects.toThrow(/already operating on handoff/);
    } finally {
      release();
    }
    // The losers touched NOTHING: claim, workspace, and status all intact.
    expect(existsSync(join(c.claims, record.sandbox!.claim))).toBe(true);
    expect(existsSync(join(record.remoteCwd, "hello.txt"))).toBe(true);
    expect(loadState(resolveEnv()).records[0]!.status).toBe("up");
  });

  test("a `starting` record collects like up: the crash window between start and the up flip stays recoverable", async () => {
    const record = loadState(resolveEnv()).records[0]!;
    writeFileSync(join(record.remoteCwd, "made-remotely.txt"), "theirs\n");
    updateRecord(resolveEnv(), record.id, { status: "starting" });
    await cmdDown([record.id]);
    expect(readFileSync(join(workDir, "made-remotely.txt"), "utf8")).toBe("theirs\n");
    expect(loadState(resolveEnv()).records[0]!.status).toBe("down");
  });

  test("terminal records are monotonic: down no-ops without kubectl, kill --purge never resurrects", async () => {
    const record = loadState(resolveEnv()).records[0]!;
    expect(record.status).toBe("down");
    const argvBefore = c.argv().length;
    await cmdDown([record.id]); // no-op, not an error
    await cmdKill([record.id, "--purge"]); // must NOT flip down → killed
    expect(loadState(resolveEnv()).records[0]!.status).toBe("down");
    expect(c.argv().length).toBe(argvBefore); // no connect, no destroy — nothing remote at all
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
    expect(existsSync(join(c.claims, rec.sandbox!.claim))).toBe(true);
  });

  test("no-ref destructive kill refuses ambiguity across live handoffs; the exact id purges the right one", async () => {
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
    expect(existsSync(join(c.claims, prov.sandbox!.claim))).toBe(true);
    expect(existsSync(join(c.claims, up.sandbox!.claim))).toBe(true);

    // The exact id abandons exactly the failed handoff — the up survives.
    await cmdKill([prov.id, "--purge"]);
    expect(loadState(resolveEnv()).records.find((r) => r.id === prov.id)!.status).toBe("killed");
    expect(existsSync(join(c.claims, prov.sandbox!.claim))).toBe(false);
    expect(loadState(resolveEnv()).records.find((r) => r.id === up.id)!.status).toBe("up");
    expect(existsSync(join(c.claims, up.sandbox!.claim))).toBe(true);
  });

  test("kill --purge on a resolved but unreachable sandbox fails with record, claim, and workspace intact", async () => {
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
    expect(existsSync(join(c.claims, up.sandbox!.claim))).toBe(true);
    expect(existsSync(join(up.remoteCwd, "other.txt"))).toBe(true);
  });

  test("an interrupted destroy parks `killing`; the retry is destroy-only and terminal states hold", async () => {
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
    expect(existsSync(join(c.claims, up.sandbox!.claim))).toBe(true);

    // Mid-kill is owned by `kill --purge` alone — down and plain kill both
    // name the exact recovery.
    await expect(cmdDown([up.id])).rejects.toThrow(new RegExp(`beam kill ${up.id} --purge`));
    await expect(cmdKill([up.id])).rejects.toThrow(new RegExp(`beam kill ${up.id} --purge`));

    // The retry repeats the destroy ALONE: no reconnect, no re-clean.
    const argvBefore = c.argv().length;
    await cmdKill([up.id, "--purge"]);
    const delta = c.argv().slice(argvBefore).map((a) => a.join(" "));
    expect(delta.some((a) => a.includes("exec"))).toBe(false);
    // destroy re-reads ONLY the claim to re-verify identity before the
    // UID-preconditioned delete — never the pod chain.
    expect(delta.some((a) => a.includes("get pod") || a.includes("get sandboxes."))).toBe(false);
    expect(delta.some((a) => a.includes("delete --raw"))).toBe(true);
    expect(loadState(resolveEnv()).records.find((r) => r.id === up.id)!.status).toBe("killed");
    expect(existsSync(join(c.claims, up.sandbox!.claim))).toBe(false);
  });
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

  test("a path excluded at ship time survives `beam down --delete` after the exclude is dropped", async () => {
    await cmdUp(["--no-session", "--no-start"]);
    const record = loadState(resolveEnv()).records[0]!;
    // The completed ship journaled its effective exclude set…
    expect(record.syncedExcludes).toEqual(["/.beam", "secrets", ".git"]);
    // …and really did keep the directory home.
    expect(existsSync(join(record.remoteCwd, "secrets"))).toBe(false);
    expect(existsSync(join(record.remoteCwd, "hello.txt"))).toBe(true);

    // Config drift before the return leg: the exclude disappears.
    writeFileSync(join(beamDir, "config.json"), configWith([]));
    writeFileSync(join(record.remoteCwd, "made-remotely.txt"), "theirs\n");

    await cmdDown([record.id, "--delete"]);
    // The union of recorded + current excludes protected the never-shipped
    // path from the deletion mirror; real remote work still came home.
    expect(readFileSync(join(workDir, "secrets", "keys.txt"), "utf8")).toBe("shh\n");
    expect(readFileSync(join(workDir, "made-remotely.txt"), "utf8")).toBe("theirs\n");
    expect(loadState(resolveEnv()).records[0]!.status).toBe("down");
  });

  test("a failed re-ship never replaces the last known-good protection set", async () => {
    writeFileSync(join(beamDir, "config.json"), configWith(["secrets"]));
    process.chdir(otherDir);
    try {
      await cmdUp(["--no-session", "--no-start"]);
      const rec = loadState(resolveEnv()).records.at(-1)!;
      expect(rec.syncedExcludes).toEqual(["/.beam", "secrets", ".git"]);

      // Drift, then die mid-transfer on the retry: the failed attempt must
      // not swap in the drifted (weaker) exclude set.
      writeFileSync(join(beamDir, "config.json"), configWith([]));
      c.flag("exec-fail-pattern", "tar -xzf");
      try {
        await expect(cmdUp(["--no-session", "--no-start"])).rejects.toThrow();
      } finally {
        rmSync(join(c.state, "exec-fail-pattern"));
      }
      const after = loadState(resolveEnv()).records.find((r) => r.id === rec.id)!;
      expect(after.status).toBe("provisioning"); // the retry never completed
      expect(after.syncedExcludes).toEqual(["/.beam", "secrets", ".git"]); // protection set unchanged
    } finally {
      process.chdir(workDir);
    }
  });
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

  test("a pre-existing symlink at the deterministic workspace path fails the ship before any byte leaves", async () => {
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
  });

  test("a workspace swapped for a symlink after the ship refuses `beam down` — and collects again once restored", async () => {
    await cmdUp(["--no-session"]);
    const record = loadState(resolveEnv()).records.at(-1)!;
    expect(record.status).toBe("up");
    // The persisted cwd is the canonical physical path under the root.
    expect(record.remoteCwd).toBe(join(root, remoteWorkspaceName(workDir)));
    expect(readFileSync(join(record.remoteCwd, "hello.txt"), "utf8")).toBe("hello\n");

    // Swap: replace the proven workspace with a link to the outside dir.
    rmSync(record.remoteCwd, { recursive: true, force: true });
    symlinkSync(outside, record.remoteCwd);
    await expect(cmdDown([record.id])).rejects.toThrow(/symlink/);
    expectOutsideIntact(); // neither collected as the workspace nor purged
    expect(loadState(resolveEnv()).records.at(-1)!.status).toBe("up"); // refused before any state change

    // Restore a real directory at the exact canonical path: down collects
    // and purges normally.
    rmSync(record.remoteCwd);
    mkdirSync(record.remoteCwd, { recursive: true });
    writeFileSync(join(record.remoteCwd, "made-remotely.txt"), "theirs\n");
    await cmdDown([record.id]);
    expect(readFileSync(join(workDir, "made-remotely.txt"), "utf8")).toBe("theirs\n");
    expect(existsSync(record.remoteCwd)).toBe(false); // purged for real
    expect(loadState(resolveEnv()).records.at(-1)!.status).toBe("down");
    expectOutsideIntact();
  });

  test("a swapped workspace refuses `beam kill --purge` with the claim intact; the retry finishes once restored", async () => {
    await cmdUp(["--no-session"]);
    const record = loadState(resolveEnv()).records.at(-1)!;
    rmSync(record.remoteCwd, { recursive: true, force: true });
    symlinkSync(outside, record.remoteCwd);

    await expect(cmdKill([record.id, "--purge"])).rejects.toThrow(/symlink/);
    expectOutsideIntact();
    // An unproven erasure never reaches the claim delete.
    expect(existsSync(join(c.claims, record.sandbox!.claim))).toBe(true);
    expect(loadState(resolveEnv()).records.at(-1)!.status).toBe("up");

    // Removing the trap leaves a provably ABSENT workspace — erasure proof
    // enough for the idempotent retry to finish the kill.
    rmSync(record.remoteCwd);
    await cmdKill([record.id, "--purge"]);
    expect(loadState(resolveEnv()).records.at(-1)!.status).toBe("killed");
    expect(existsSync(join(c.claims, record.sandbox!.claim))).toBe(false);
    expectOutsideIntact();
  });
});