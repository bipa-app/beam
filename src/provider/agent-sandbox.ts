import type { AgentSandboxTargetSpec } from "../config.ts";
import { KubectlTransport } from "../transport/kubectl.ts";
import type { Transport } from "../transport/types.ts";
import { run } from "../util/shell.ts";
import type { ProviderDoctorReport, SandboxProvider, SandboxRef, SandboxState } from "./types.ts";

export const DEFAULT_CONTAINER = "sandbox";
const CLAIM = "sandboxclaims.extensions.agents.x-k8s.io";
const SANDBOX = "sandboxes.agents.x-k8s.io";
const TEMPLATE = "sandboxtemplates.extensions.agents.x-k8s.io";
const CLAIM_API_VERSION = "extensions.agents.x-k8s.io/v1alpha1";
/**
 * Official v1alpha1 annotation on a Sandbox naming its pod (differs from the
 * sandbox name for warm-pool pods).
 */
const POD_NAME_ANNOTATION = "agents.x-k8s.io/pod-name";
/** Label beam stamps on every claim it creates; every reuse/exec/delete requires it. */
const MANAGED_BY_KEY = "app.kubernetes.io/managed-by";
const MANAGED_BY_VALUE = "beam";
/** Cold boot (node scale-up + image pull) runs ~15 min; ceiling per the platform runbook. */
const READY_TIMEOUT = "25m";

/**
 * Identifier validation (RFC 1123, the same shapes the Kubernetes API
 * enforces): these values are interpolated into kubectl argv and resource
 * names, so a malformed one must die here with a clear message instead of
 * becoming a flag or an unexpected resource downstream.
 */
function assertDnsLabel(value: string, what: string): void {
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error(
      `agent-sandbox ${what} ${JSON.stringify(value)} is not a DNS label ` +
        `(lowercase alphanumerics and '-', starting/ending alphanumeric, max 63 chars)`,
    );
  }
}

function assertDnsSubdomain(value: string, what: string): void {
  if (
    value.length > 253 ||
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(value)
  ) {
    throw new Error(
      `agent-sandbox ${what} ${JSON.stringify(value)} is not a DNS subdomain ` +
        `(lowercase alphanumerics, '-' and '.', each segment ` +
        `starting/ending alphanumeric, max 253 chars)`,
    );
  }
}

/** The identity fields every claim check binds on, extracted defensively. */
interface ClaimIdentity {
  name?: string;
  uid?: string;
  managedBy?: string;
  template?: string;
}

function claimIdentity(claim: Record<string, unknown>): ClaimIdentity {
  const meta = (claim.metadata ?? {}) as Record<string, unknown>;
  const labels = (meta.labels ?? {}) as Record<string, unknown>;
  const spec = (claim.spec ?? {}) as Record<string, unknown>;
  const tplRef = (spec.sandboxTemplateRef ?? {}) as Record<string, unknown>;
  const managedBy = labels[MANAGED_BY_KEY];
  return {
    name: typeof meta.name === "string" ? meta.name : undefined,
    uid: typeof meta.uid === "string" && meta.uid !== "" ? meta.uid : undefined,
    managedBy: typeof managedBy === "string" ? managedBy : undefined,
    template: typeof tplRef.name === "string" ? tplRef.name : undefined,
  };
}

/** One `kubectl auth can-i` probe: label, argv fragment, and namespace-vs-cluster scope. */
type CapabilityProbe = [string, string[], "namespace" | "all"];

/** The verified Sandbox hop of the claim → Sandbox → pod resolution chain. */
interface SandboxHop {
  sandboxName: string;
  sandboxUid?: string;
  podName: string;
}

/** Outcome of the destroy identity gate: delete the pinned object, or leave and log why. */
type DestroyDecision = { action: "delete"; uid: string } | { action: "leave"; message: string };

/**
 * Provider for GKE Agent Sandbox (kubernetes-sigs/agent-sandbox CRDs):
 * one namespaced SandboxClaim per handoff record, named `beam-<record-id>`.
 * The controller reconciles a Sandbox and pod for the claim; beam resolves
 * that chain fresh on every command — pods are ephemeral and never trusted
 * from stored state. Provisioning is create-if-absent (the least-privilege
 * role has no patch/update), so a crashed or repeated `beam up` continues
 * the same claim instead of duplicating it (per-user namespaces quota
 * claims to one).
 *
 * Claims bind by IDENTITY, not name: `beam up` persists the created claim's
 * metadata.uid on the record, and every later operation re-reads the claim
 * and requires the exact name, the `app.kubernetes.io/managed-by=beam`
 * label, the configured template, and that UID before any exec/wait/delete
 * (the claim → Sandbox → pod owner chain is verified by UID as well). A
 * same-name foreign, replaced, or recreated claim is never connected to
 * and never deleted — deletion itself carries a Kubernetes UID precondition
 * through the raw DeleteOptions API, since kubectl's high-level delete has
 * no safe conditional flag. A record with no pinned UID (it predates the
 * pin) authorizes NOTHING that already exists: it may only create a
 * provably absent claim and pin the UID that create returns — an existing
 * same-name claim fails it closed, with manual recovery.
 *
 * The kubeconfig is the blast radius: it must be explicit (never the
 * ambient one), and both `beam doctor` and provisioning refuse — fail
 * closed, before any claim is created — a credential holding any of the
 * enumerated escape capabilities probed by assertCredentialBoundary
 * (template-bypassing pod/workload/Sandbox mutation, Secret access, RBAC
 * escalation, impersonation, cluster-wide reach). A probe that cannot be
 * answered is refused the same way. It is a denylist of known escape
 * hatches, not proof of minimality — bind the published beam Role.
 */
export class AgentSandboxProvider implements SandboxProvider {
  readonly label: string;
  readonly reusesSandbox = true;

  constructor(
    private readonly spec: AgentSandboxTargetSpec,
    private readonly bin: string = "kubectl",
  ) {
    // Config is parsed JSON, so the type-level requirement is re-checked
    // here: an absent kubeconfig would silently fall back to the ambient
    // one, which is exactly the fat-credential path beam refuses.
    if (!spec.kubeconfig || spec.kubeconfig.trim() === "") {
      throw new Error(
        "agent-sandbox target needs an explicit `kubeconfig` (path to the least-privilege " +
          "beam-user credential) — beam never falls back to the ambient kubeconfig",
      );
    }
    assertDnsLabel(spec.namespace, "namespace");
    if (spec.container !== undefined) assertDnsLabel(spec.container, "container");
    assertDnsSubdomain(spec.template, "template");
    this.label = `agent-sandbox ${spec.namespace} @ ${spec.context}`;
  }

  sandboxState(ref: SandboxRef): SandboxState {
    const derived: SandboxState = {
      claim: `beam-${ref.id}`,
      context: this.spec.context,
      namespace: this.spec.namespace,
      container: this.spec.container ?? DEFAULT_CONTAINER,
      kubeconfig: this.spec.kubeconfig,
      template: this.spec.template,
    };
    // The record id is state.json content too: a tampered id must die here,
    // before `beam-<id>` can reach kubectl argv as a claim name.
    assertDnsSubdomain(derived.claim, "claim name (from the record id)");
    const persisted = ref.sandbox;
    // Legacy records predate persisted coordinates: derive them from the
    // target snapshot, exactly as `beam up` would have persisted them.
    if (!persisted) return derived;
    // Persisted coordinates come from state.json, which is hand-editable
    // and outlives config changes. Malformed names must die before argv
    // interpolation, and coordinates that disagree with this provider's own
    // snapshot mean the record was tampered with or corrupted — fail closed
    // rather than aim kubectl at a claim this target never produced. The
    // claim binds EXACTLY to `beam-<record id>`: a valid-looking foreign
    // claim name is still another record's sandbox, never this one's.
    // (Commands always rebuild the provider from the record's persisted
    // targetSpec, so every legitimate flow matches.)
    assertDnsSubdomain(persisted.claim, "persisted claim name");
    assertDnsLabel(persisted.namespace, "persisted namespace");
    assertDnsLabel(persisted.container, "persisted container");
    if (persisted.template !== undefined) {
      assertDnsSubdomain(persisted.template, "persisted template");
    }
    // The UID never reaches argv (equality checks and a JSON-encoded delete
    // precondition only), but a persisted value must still look like one.
    if (persisted.uid !== undefined && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(persisted.uid)) {
      throw new Error(
        `persisted claim UID for record ${ref.id} is malformed — ` +
          `state.json tampered or corrupted?`,
      );
    }
    const drift = (
      ["claim", "context", "namespace", "container", "kubeconfig", "template"] as const
    ).filter((k) =>
      k === "template"
        ? persisted.template !== undefined && persisted.template !== derived.template
        : persisted[k] !== derived[k],
    );
    if (drift.length > 0) {
      const details = drift
        .map((k) => `${k}: ${JSON.stringify(persisted[k])} != ${JSON.stringify(derived[k])}`)
        .join(", ");
      throw new Error(
        `persisted sandbox coordinates for record ${ref.id} do not match the target snapshot ` +
          `(${details}) — refusing to run kubectl against coordinates this target did not ` +
          `produce (state.json tampered or corrupted?)`,
      );
    }
    // Older records lack the persisted template — backfill from the snapshot
    // (the identity checks need one; the drift check above pins everything
    // else, so it is the same value `beam up` would have persisted).
    if (persisted.template === undefined) return { ...persisted, template: derived.template };
    return persisted;
  }

  /**
   * A claim beam is about to act on — reuse, wait on, exec through — must
   * be EXACTLY the one this record and target created: same name
   * (`beam-<record id>`), beam's managed-by label, the configured template,
   * and the record's pinned metadata.uid. Names are cheap (delete +
   * recreate keeps the name, never the UID), so the UID is the identity —
   * and a record that never pinned one cannot prove ANY existing claim is
   * its own, so it authorizes nothing (label and template only say "a beam
   * made this", never "THIS record made it"). Returns the verified UID so
   * callers pin follow-up operations to it.
   *
   * Refusals never point remediation at the mismatched claim: recommending
   * `beam kill <id> --purge` is safe because destroy() runs this same
   * identity gate — it retires the record only when it can prove
   * non-ownership, and otherwise fails closed toward manual recovery.
   */
  private verifyClaim(
    coords: SandboxState,
    recordId: string,
    claim: Record<string, unknown>,
  ): string {
    const id = claimIdentity(claim);
    const inspect =
      `kubectl --context ${coords.context} -n ${coords.namespace} ` +
      `get ${CLAIM} ${coords.claim} -o yaml`;
    if (id.name !== coords.claim) {
      const shown = id.name !== undefined ? JSON.stringify(id.name) : "(unreadable)";
      throw new Error(
        `SandboxClaim lookup for ${coords.claim} returned an object named ` +
          `${shown} — refusing to trust it; inspect: ${inspect}`,
      );
    }
    if (id.uid === undefined) {
      throw new Error(
        `SandboxClaim ${coords.claim} has no readable metadata.uid — refusing to act on an ` +
          `object whose identity cannot be pinned; inspect: ${inspect}`,
      );
    }
    if (coords.uid !== undefined && id.uid !== coords.uid) {
      throw new Error(
        `SandboxClaim ${coords.claim} exists but its UID ${id.uid} is not the one this ` +
          `record created (${coords.uid}) — the original claim is gone and its name was ` +
          `re-used by something else. beam never execs into or deletes a claim it did not ` +
          `create. Retire the record with \`beam kill ${recordId} --purge\` (identity-gated: ` +
          `the same-name claim is left untouched); inspect: ${inspect}`,
      );
    }
    if (id.managedBy !== MANAGED_BY_VALUE) {
      const shown = id.managedBy !== undefined ? JSON.stringify(id.managedBy) : "missing";
      throw new Error(
        `SandboxClaim ${coords.claim} exists but is not managed by beam (label ` +
          `${MANAGED_BY_KEY} is ${shown}) — another workload owns that name. beam never ` +
          `execs into or deletes it. Retire the record with \`beam kill ${recordId} ` +
          `--purge\` (identity-gated: the foreign claim is left untouched); inspect: ${inspect}`,
      );
    }
    const template = coords.template ?? this.spec.template;
    if (id.template !== template) {
      throw new Error(
        `SandboxClaim ${coords.claim} is beam-managed but references template ` +
          `${id.template ?? "(unreadable)"}, not the configured ${template} — refusing to ` +
          `act on another template's workload. Fix the target's \`template\` if this claim ` +
          `is really this record's; inspect: ${inspect}`,
      );
    }
    // No pinned UID = no identity to compare. The original claim may be
    // gone and its name re-used — even by another beam. Fail closed: the
    // only act an unpinned record may perform is creating a claim that
    // provably does not exist (the create branch in provision).
    if (coords.uid === undefined) {
      throw new Error(
        `record ${recordId} has no pinned claim UID, but SandboxClaim ${coords.claim} ` +
          `already exists — beam cannot prove that object is the one this record created ` +
          `(delete + recreate keeps the name, never the UID), so it will not exec into, ` +
          `wait on, or delete it. Inspect: ${inspect}. If the claim is yours and ` +
          `disposable, delete it manually: kubectl --context ${coords.context} ` +
          `--kubeconfig ${coords.kubeconfig} -n ${coords.namespace} delete ${CLAIM} ` +
          `${coords.claim} — once it is gone, \`beam kill ${recordId} --purge\` retires ` +
          `the record and \`beam up\` provisions a fresh, identity-pinned handoff`,
      );
    }
    return id.uid;
  }

  /** Global argv prefix: context and kubeconfig pinned, never ambient. */
  private global(coords: { context: string; kubeconfig?: string }): string[] {
    return [
      this.bin,
      "--context",
      coords.context,
      ...(coords.kubeconfig ? ["--kubeconfig", coords.kubeconfig] : []),
    ];
  }

  private ns(coords: SandboxState): string[] {
    return [...this.global(coords), "--namespace", coords.namespace];
  }

  /**
   * `kubectl get --ignore-not-found -o json`: absence is ONLY exit 0 with
   * empty stdout — kubectl's own NotFound suppression. stderr text NEVER
   * classifies absence: a kubeconfig exec-plugin failure ("exec: executable
   * credential-helper not found") also says "not found", and reading that
   * as "the object is gone" would let teardown retire a record whose claim
   * is alive. Any nonzero exit throws.
   */
  private async getJson(
    coords: SandboxState,
    resource: string,
    name: string,
  ): Promise<Record<string, unknown> | undefined> {
    const res = await run([
      ...this.ns(coords), "get", resource, name, "--ignore-not-found", "-o", "json",
    ]);
    if (res.code !== 0) {
      throw new Error(`kubectl get ${resource}/${name} failed (${res.code}): ${res.stderr.trim()}`);
    }
    if (res.stdout.trim() === "") return undefined;
    try {
      return JSON.parse(res.stdout) as Record<string, unknown>;
    } catch {
      const stderr = res.stderr.trim();
      throw new Error(
        `kubectl get ${resource}/${name} returned unparseable output — refusing to guess ` +
          `whether the object exists${stderr ? `; stderr: ${stderr}` : ""}`,
      );
    }
  }

  /**
   * Resolve the pod through the chain claim → Sandbox → pod using the
   * official v1alpha1 fields: `claim.status.sandbox.name` names the Sandbox,
   * and the Sandbox's `agents.x-k8s.io/pod-name` annotation names the pod
   * (warm pools hand out pre-created pods whose names differ from the
   * sandbox's). Name identity is the documented fallback while the
   * controller has not populated status yet. The claim itself is verified
   * first (verifyClaim: exact name, managed-by label, template, pinned
   * UID), and when the API returns ownerReferences the chain is verified BY
   * UID (Sandbox owned by this exact claim object, pod owned by that exact
   * Sandbox object) so a same-named impostor cannot redirect the exec; the
   * pod must also be Running. Never cached.
   */
  private async resolvePod(coords: SandboxState, recordId: string): Promise<string> {
    const hop = await this.resolveSandboxForClaim(coords, recordId);
    return await this.resolveRunningPod(coords, hop);
  }

  /** Chain hop 1: verified claim → its Sandbox object and the pod name it advertises. */
  private async resolveSandboxForClaim(
    coords: SandboxState,
    recordId: string,
  ): Promise<SandboxHop> {
    const claim = await this.getJson(coords, CLAIM, coords.claim);
    if (!claim) {
      throw new Error(
        `sandbox is gone: SandboxClaim ${coords.claim} not found in namespace ` +
          `${coords.namespace} — run \`beam up\` for a fresh handoff`,
      );
    }
    const claimUid = this.verifyClaim(coords, recordId, claim);
    const claimStatus = (claim.status ?? {}) as Record<string, unknown>;
    const claimSandbox = (claimStatus.sandbox ?? {}) as Record<string, unknown>;
    const sandboxName =
      typeof claimSandbox.name === "string" && claimSandbox.name !== ""
        ? claimSandbox.name
        : coords.claim;
    // API-returned names are strictly less trusted than configured ones:
    // they came out of cluster objects. Validate before they become argv.
    assertDnsSubdomain(sandboxName, "sandbox name (from claim status)");
    const sandbox = await this.getJson(coords, SANDBOX, sandboxName);
    if (!sandbox) {
      throw new Error(
        `Sandbox ${sandboxName} for claim ${coords.claim} not found — inspect: ` +
          `kubectl --context ${coords.context} -n ${coords.namespace} describe ` +
          `${CLAIM} ${coords.claim}`,
      );
    }
    const sandboxMeta = (sandbox.metadata ?? {}) as Record<string, unknown>;
    const sandboxUid =
      typeof sandboxMeta.uid === "string" && sandboxMeta.uid !== "" ? sandboxMeta.uid : undefined;
    const annotations = (sandboxMeta.annotations ?? {}) as Record<string, unknown>;
    const annotated = annotations[POD_NAME_ANNOTATION];
    const podName = typeof annotated === "string" && annotated !== "" ? annotated : sandboxName;
    assertDnsSubdomain(podName, "pod name (from the Sandbox pod-name annotation)");
    // Ownership: when the controller stamped ownerReferences, a Sandbox not
    // owned by THIS claim object — kind, name, AND uid — is an impostor. A
    // right-named owner entry carrying another UID is exactly the
    // recreated-claim case the UID pin exists to catch.
    const sandboxOwners = Array.isArray(sandboxMeta.ownerReferences)
      ? (sandboxMeta.ownerReferences as Array<Record<string, unknown>>)
      : [];
    if (
      sandboxOwners.length > 0 &&
      !sandboxOwners.some(
        (o) => o.kind === "SandboxClaim" && o.name === coords.claim && o.uid === claimUid,
      )
    ) {
      throw new Error(
        `Sandbox ${sandboxName} is not owned by SandboxClaim ${coords.claim} ` +
          `(uid ${claimUid}) — refusing to exec into a sandbox this handoff does not own; ` +
          `inspect: kubectl --context ${coords.context} -n ${coords.namespace} ` +
          `get ${SANDBOX} ${sandboxName} -o yaml`,
      );
    }
    return { sandboxName, sandboxUid, podName };
  }

  /** Chain hop 2: the advertised pod, owner-verified against the Sandbox, required Running. */
  private async resolveRunningPod(coords: SandboxState, hop: SandboxHop): Promise<string> {
    const { sandboxName, sandboxUid, podName } = hop;
    const pod = await this.getJson(coords, "pod", podName);
    if (!pod) {
      throw new Error(
        `pod ${podName} for claim ${coords.claim} not found (sandbox restarting?) — ` +
          `retry, or \`beam up\` to reprovision`,
      );
    }
    const podMeta = (pod.metadata ?? {}) as Record<string, unknown>;
    const podOwners = Array.isArray(podMeta.ownerReferences)
      ? (podMeta.ownerReferences as Array<Record<string, unknown>>)
      : [];
    if (podOwners.length > 0) {
      if (sandboxUid === undefined) {
        throw new Error(
          `Sandbox ${sandboxName} has no readable metadata.uid — cannot verify the pod's ` +
            `owner chain; inspect: kubectl --context ${coords.context} ` +
            `-n ${coords.namespace} get ${SANDBOX} ${sandboxName} -o yaml`,
        );
      }
      const ownsPod = podOwners.some(
        (o) => o.kind === "Sandbox" && o.name === sandboxName && o.uid === sandboxUid,
      );
      if (!ownsPod) {
        throw new Error(
          `pod ${podName} is not owned by Sandbox ${sandboxName} (uid ${sandboxUid}) — ` +
            `refusing to exec into a pod this handoff does not own; inspect: kubectl ` +
            `--context ${coords.context} -n ${coords.namespace} get pod ${podName} -o yaml`,
        );
      }
    }
    const podStatus = (pod.status ?? {}) as Record<string, unknown>;
    if (podStatus.phase !== "Running") {
      const phase = typeof podStatus.phase === "string" ? podStatus.phase : "in an unknown phase";
      throw new Error(
        `pod ${podName} for claim ${coords.claim} is ${phase}, ` +
          `not Running — retry once the sandbox settles, or \`beam up\` to reprovision`,
      );
    }
    return podName;
  }

  async provision(ref: SandboxRef, persist?: (sandbox: SandboxState) => void): Promise<Transport> {
    const coords = this.sandboxState(ref);
    // Boundary first, claim second: an overpowered or unprovable credential
    // is refused before anything is created in the cluster.
    console.log("sandbox: verifying credential boundary (kubectl auth can-i)…");
    await this.assertCredentialBoundary();
    // Create-if-absent, never `kubectl apply`: the least-privilege beam-user
    // role grants create/get/delete on claims but not patch/update, and
    // apply patches an existing object. Reuse is the get branch.
    const current = await this.getJson(coords, CLAIM, coords.claim);
    let uid: string;
    if (current) {
      // A reused claim must be exactly the one this record and target
      // created — name, managed-by label, template, AND the record's pinned
      // UID; a record that never pinned one cannot reuse anything that
      // exists (see verifyClaim).
      uid = this.verifyClaim(coords, ref.id, current);
      console.log(
        `sandbox: reusing claim ${coords.claim} (namespace ${coords.namespace}, uid ${uid})`,
      );
    } else {
      uid = await this.createClaimPinned(coords, ref.id);
    }
    // The verified identity is record state, and it must be durable BEFORE
    // the (up to 25 min) Ready wait: publish it to the caller NOW, so a
    // timeout or crash during the wait still leaves a record pinned to
    // exactly this claim object — every later command refuses a same-name
    // claim whose UID differs (deleted-and-recreated = someone else's
    // workload).
    const pinned: SandboxState = { ...coords, uid };
    ref.sandbox = pinned;
    persist?.(pinned);
    await this.waitForClaimReady(pinned, ref.id);
    // resolvePod re-reads and re-verifies the claim — now WITH the UID pin —
    // so a claim replaced during the (long) Ready wait is caught before exec.
    const pod = await this.resolvePod(pinned, ref.id);
    console.log(`sandbox: pod ${pod} ready`);
    return new KubectlTransport(pinned, pod, this.bin);
  }

  /**
   * Create branch of provision: runs only when the claim is provably
   * absent. `-o json` echoes the created object, so the server-assigned UID
   * is captured from the SAME request that created it — no read-back race.
   */
  private async createClaimPinned(coords: SandboxState, recordId: string): Promise<string> {
    if (coords.uid !== undefined) {
      throw new Error(
        `SandboxClaim ${coords.claim} with original UID ${coords.uid} is gone — refusing ` +
          `to create a replacement for handoff ${recordId}; the original sandbox may ` +
          `contain remote work that Beam can no longer recover`,
      );
    }
    const manifest = JSON.stringify({
      apiVersion: CLAIM_API_VERSION,
      kind: "SandboxClaim",
      metadata: {
        name: coords.claim,
        namespace: coords.namespace,
        labels: { [MANAGED_BY_KEY]: MANAGED_BY_VALUE },
      },
      spec: { sandboxTemplateRef: { name: this.spec.template } },
    });
    console.log(
      `sandbox: creating claim ${coords.claim} (template ${this.spec.template}, ` +
        `namespace ${coords.namespace})`,
    );
    const created = await run([...this.ns(coords), "create", "-f", "-", "-o", "json"], {
      stdinText: manifest,
    });
    if (created.code === 0) return this.pinnedUidFromCreate(coords, created.stdout);
    if (!/already ?exists/i.test(created.stderr)) {
      throw new Error(
        `creating SandboxClaim ${coords.claim} failed (${created.code}): ` +
          `${created.stderr.trim()}`,
      );
    }
    // The name sprang into existence between beam's absence check and
    // its create. This branch only runs for a record with no pinned UID
    // (a pinned record whose claim is gone refuses above, before the
    // create), so beam can never prove the raced object is its own —
    // and same-record races are excluded by the state lock, so whatever
    // created it is a foreign or duplicated actor. Never adopt it.
    throw new Error(
      `SandboxClaim ${coords.claim} was created by someone else between beam's absence ` +
        `check and its create — beam never adopts a claim it did not create. Inspect: ` +
        `kubectl --context ${coords.context} --kubeconfig ${coords.kubeconfig} ` +
        `-n ${coords.namespace} get ${CLAIM} ${coords.claim} -o yaml; if it is abandoned, ` +
        `delete it manually and retry \`beam up\`, or retire this record with ` +
        `\`beam kill ${recordId} --purge\` once the name is free`,
    );
  }

  /** The created claim's UID, pinned from the create's own `-o json` echo. */
  private pinnedUidFromCreate(coords: SandboxState, stdout: string): string {
    let createdObj: Record<string, unknown>;
    try {
      createdObj = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      throw new Error(
        `creating SandboxClaim ${coords.claim} succeeded but the created object could not ` +
          `be parsed — refusing to continue without its UID`,
      );
    }
    const identity = claimIdentity(createdObj);
    if (identity.name !== coords.claim || identity.uid === undefined) {
      throw new Error(
        `creating SandboxClaim ${coords.claim} returned an object beam cannot identify ` +
          `(name ${identity.name ?? "(unreadable)"}, uid ${identity.uid ?? "(unreadable)"}) — ` +
          `refusing to continue`,
      );
    }
    return identity.uid;
  }

  /**
   * Block until the claim reports Ready. On failure the claim stays: the
   * record already points at it, so a retried `beam up` continues this boot
   * and `beam kill <id> --purge` abandons it.
   */
  private async waitForClaimReady(pinned: SandboxState, recordId: string): Promise<void> {
    console.log(
      `sandbox: waiting for Ready (cold boot can take ~15 min, ceiling ${READY_TIMEOUT})…`,
    );
    const waited = await run([
      ...this.ns(pinned),
      "wait",
      "--for=condition=Ready",
      `${CLAIM}/${pinned.claim}`,
      `--timeout=${READY_TIMEOUT}`,
    ]);
    if (waited.code !== 0) {
      throw new Error(
        `sandbox claim ${pinned.claim} did not become Ready within ${READY_TIMEOUT}: ` +
          `${(waited.stderr || waited.stdout).trim()}\n` +
          `  inspect: kubectl --context ${pinned.context} -n ${pinned.namespace} ` +
          `describe ${CLAIM} ${pinned.claim}\n` +
          `  retry:   beam up (continues this claim) · abandon: beam kill ${recordId} --purge`,
      );
    }
  }

  async connect(ref?: SandboxRef): Promise<Transport> {
    if (!ref) {
      throw new Error(
        "no live sandbox for this target — run `beam up` (or `beam up --no-start`) " +
          "to provision one first",
      );
    }
    const coords = this.sandboxState(ref);
    return new KubectlTransport(coords, await this.resolvePod(coords, ref.id), this.bin);
  }

  /**
   * Delete the record's claim — and ONLY that exact object. The claim is
   * re-read and identity-checked first; the delete itself carries a
   * Kubernetes UID precondition (raw DeleteOptions — kubectl's high-level
   * delete has no conditional flag), so check-then-delete cannot race a
   * same-name replacement into destruction. A claim beam cannot prove it
   * created is NEVER deleted: when the record's pinned UID proves beam's
   * own claim is already gone (a live same-name object with another UID —
   * names are unique per namespace), destroy retires the record cleanly and
   * leaves the occupant untouched; an ambiguous mismatch fails closed. A
   * record with no pinned UID can prove nothing about a beam-labeled
   * occupant — the original may be gone and its name re-used — so it fails
   * closed toward manual recovery; only a provably foreign occupant
   * (another workload's label) retires the record, untouched.
   */
  async destroy(ref: SandboxRef): Promise<void> {
    const coords = this.sandboxState(ref);
    const current = await this.getJson(coords, CLAIM, coords.claim);
    if (!current) {
      console.log(`sandbox: claim ${coords.claim} already gone (nothing to delete)`);
      return;
    }
    const decision = this.destroyDecision(coords, ref.id, current);
    if (decision.action === "leave") {
      console.log(decision.message);
      return;
    }
    // Every check above ran against ONE observed object — pin the delete to
    // exactly that object.
    const outcome = await this.deleteClaimPinned(coords, decision.uid);
    if (outcome === "deleted") {
      console.log(`sandbox: claim ${coords.claim} deleted (uid ${decision.uid})`);
      return;
    }
    if (outcome === "already-gone") {
      console.log(`sandbox: claim ${coords.claim} already gone (nothing to delete)`);
      return;
    }
    console.log(
      `sandbox: claim ${coords.claim} was deleted and re-created mid-delete ` +
        `(UID precondition refused) — the claim this record created is gone; ` +
        `leaving the replacement untouched`,
    );
  }

  /**
   * The destroy identity gate, run against ONE observed claim object:
   * "delete" (this record provably created it — with the UID to pin the
   * delete to), or "leave" (the record's own claim is provably gone, or a
   * provably foreign occupant holds the name, and the object is not ours to
   * touch). Every ambiguous shape throws — fail closed toward manual
   * recovery.
   */
  private destroyDecision(
    coords: SandboxState,
    recordId: string,
    current: Record<string, unknown>,
  ): DestroyDecision {
    const id = claimIdentity(current);
    const inspect =
      `kubectl --context ${coords.context} -n ${coords.namespace} ` +
      `get ${CLAIM} ${coords.claim} -o yaml`;
    const template = coords.template ?? this.spec.template;
    if (id.name !== coords.claim || id.uid === undefined) {
      throw new Error(
        `SandboxClaim lookup for ${coords.claim} returned an object beam cannot identify — ` +
          `refusing to delete anything; inspect: ${inspect}`,
      );
    }
    if (coords.uid !== undefined && id.uid !== coords.uid) {
      return {
        action: "leave",
        message:
          `sandbox: claim ${coords.claim} was replaced (uid ${id.uid}; this record ` +
          `created ${coords.uid}) — the claim this record created is already gone; ` +
          `leaving the same-name claim untouched`,
      };
    }
    if (id.managedBy !== MANAGED_BY_VALUE) {
      if (coords.uid !== undefined) {
        // Our own UID without beam's label: someone mutated the object.
        // Deleting on a tampered identity is guessing — fail closed.
        throw new Error(
          `SandboxClaim ${coords.claim} matches this record's UID but no longer carries ` +
            `the ${MANAGED_BY_KEY}=${MANAGED_BY_VALUE} label — tampered; refusing to ` +
            `delete it; inspect: ${inspect}`,
        );
      }
      return {
        action: "leave",
        message:
          `sandbox: claim ${coords.claim} is not managed by beam (label ${MANAGED_BY_KEY} ` +
          `missing or foreign) — no beam created it, so nothing of record ${recordId}'s ` +
          `remains; leaving it untouched`,
      };
    }
    if (id.template !== template) {
      throw new Error(
        `SandboxClaim ${coords.claim} is beam-managed but references template ` +
          `${id.template ?? "(unreadable)"}, not the configured ${template} — refusing to ` +
          `delete a claim this record did not produce as configured. Fix the target's ` +
          `\`template\` if it is really this record's; inspect: ${inspect}`,
      );
    }
    // Beam-labeled, right template, but this record never pinned a UID:
    // it could be the record's own claim — or another beam's replacement
    // after the original died. Deleting on a guess could destroy someone
    // else's live handoff. Fail closed; the human decides.
    if (coords.uid === undefined) {
      throw new Error(
        `record ${recordId} has no pinned claim UID, but SandboxClaim ${coords.claim} ` +
          `exists — beam cannot prove it created that object, so it will not delete it. ` +
          `Inspect: ${inspect}. If the claim is yours and disposable, delete it manually: ` +
          `kubectl --context ${coords.context} --kubeconfig ${coords.kubeconfig} ` +
          `-n ${coords.namespace} delete ${CLAIM} ${coords.claim} — then re-run ` +
          `\`beam kill ${recordId} --purge\` to retire the record`,
      );
    }
    return { action: "delete", uid: id.uid };
  }

  /**
   * UID-preconditioned raw delete of the claim. Namespace and claim name
   * are DNS-validated long before they can reach the URI; the UID travels
   * in a JSON DeleteOptions body (`-f -` on stdin), never argv — kubectl's
   * high-level delete has no conditional flag. Every outcome is provable:
   * classification anchors on the API server's own error shape (`Error
   * from server (NotFound)`/`(Conflict)`), never a bare stderr substring —
   * tool and auth failures ("credential-helper not found") throw.
   */
  private async deleteClaimPinned(
    coords: SandboxState,
    uid: string,
  ): Promise<"deleted" | "already-gone" | "replaced"> {
    const path =
      `/apis/${CLAIM_API_VERSION}/namespaces/${coords.namespace}` +
      `/sandboxclaims/${coords.claim}`;
    const res = await run([...this.global(coords), "delete", "--raw", path, "-f", "-"], {
      stdinText: JSON.stringify({
        kind: "DeleteOptions",
        apiVersion: "v1",
        preconditions: { uid },
      }),
    });
    if (res.code === 0) return "deleted";
    if (/Error from server \(NotFound\)/i.test(res.stderr)) return "already-gone";
    if (/Error from server \(Conflict\)|Precondition failed/i.test(res.stderr)) return "replaced";
    throw new Error(
      `deleting SandboxClaim ${coords.claim} failed (${res.code}): ${res.stderr.trim()}`,
    );
  }

  /**
   * Finish a purge whose connected phase already completed: the caller has
   * owner-verified receipts that the workspace was emptied and the traces
   * cleaned, so the only step a crash can have lost is the claim delete or
   * its terminal state write. This is exact-UID lifecycle convergence, NOT
   * storage erasure — it acts only through the record's pinned identity
   * and converges only on provable outcomes: the claim being absent, or
   * the exact pinned object deleting under a server-side UID precondition.
   * A same-name replacement (different UID) or any API/auth failure throws
   * and the record is retained: finishing a kill must never touch — or
   * vouch for the absence of — an object this record cannot prove it
   * created.
   */
  async destroyAfterVerifiedCleanupWithoutConnection(ref: SandboxRef): Promise<void> {
    const coords = this.sandboxState(ref);
    if (coords.uid === undefined) {
      throw new Error(
        `record ${ref.id} has no pinned claim UID — beam cannot finish its destroy without ` +
          `a connection; retry \`beam kill ${ref.id} --purge\` once the target is reachable`,
      );
    }
    // getJson throws on any API/auth failure — the record stays retained.
    const current = await this.getJson(coords, CLAIM, coords.claim);
    if (!current) {
      console.log(
        `sandbox: claim ${coords.claim} already gone (the interrupted destroy had completed)`,
      );
      return;
    }
    const id = claimIdentity(current);
    if (id.uid !== coords.uid) {
      throw new Error(
        `SandboxClaim ${coords.claim} now carries UID ${id.uid ?? "(unreadable)"}, not ` +
          `this record's ${coords.uid} — the name was re-used while the sandbox was ` +
          `unreachable; refusing to finish the destroy against it. Inspect: kubectl ` +
          `--context ${coords.context} --kubeconfig ${coords.kubeconfig} ` +
          `-n ${coords.namespace} get ${CLAIM} ${coords.claim} -o yaml`,
      );
    }
    const outcome = await this.deleteClaimPinned(coords, coords.uid);
    if (outcome === "replaced") {
      throw new Error(
        `SandboxClaim ${coords.claim} was replaced while the destroy was finishing ` +
          `(UID precondition refused) — refusing to converge against an object this ` +
          `record did not create; retry \`beam kill ${ref.id} --purge\``,
      );
    }
    console.log(
      outcome === "deleted"
        ? `sandbox: claim ${coords.claim} deleted (uid ${coords.uid})`
        : `sandbox: claim ${coords.claim} already gone (the interrupted destroy had completed)`,
    );
  }

  /**
   * `kubectl auth can-i`: yes/no by stdout; anything else is a cluster or
   * credential error worth surfacing verbatim.
   */
  private async canI(
    check: string[],
    scope: "namespace" | "all",
  ): Promise<{ allowed: boolean; error?: string }> {
    const argv = [
      ...this.global(this.spec),
      "auth",
      "can-i",
      ...check,
      ...(scope === "all" ? ["--all-namespaces"] : ["--namespace", this.spec.namespace]),
    ];
    const res = await run(argv);
    const out = res.stdout.trim();
    if (out === "yes") return { allowed: true };
    if (out === "no") return { allowed: false };
    return { allowed: false, error: (res.stderr || out).trim() || `exit ${res.code}` };
  }

  /**
   * Fail-closed credential boundary, shared by provision() and doctor().
   * The kubeconfig in beam's hands is also in the beamed agent's blast
   * radius, so a credential holding any of the enumerated escape
   * capabilities is refused BEFORE a claim exists — and any probe that
   * cannot be answered (network flake, expired token) is refused too: an
   * unprovable credential is treated as an overpowered one. This is a
   * denylist of known template/secret/cluster escape hatches, not proof
   * the role is minimal — the paved path is binding the published beam
   * Role, not trimming an admin one until the probes pass.
   */
  private async assertCredentialBoundary(): Promise<void> {
    const forbidden: CapabilityProbe[] = [
      ...this.credentialEscapeProbes(),
      ...this.templateBypassProbes(),
    ];
    // ~50 probes, each one SelfSubjectAccessReview — run them concurrently,
    // then report deterministically in list order.
    const probes = await Promise.all(
      forbidden.map(async ([what, check, scope]) => ({
        what,
        check,
        probe: await this.canI(check, scope),
      })),
    );
    const wide: string[] = [];
    for (const { what, check, probe } of probes) {
      if (probe.error) {
        throw new Error(
          `cannot verify the credential boundary on context ${this.spec.context} ` +
            `(\`kubectl auth can-i ${check.join(" ")}\` failed: ${probe.error}) — ` +
            `beam fails closed: an unprovable credential is refused like an overpowered one`,
        );
      }
      if (probe.allowed) wide.push(what);
    }
    if (wide.length > 0) {
      throw new Error(
        `this credential can ${wide.join("; ")} — that is an admin credential, not a beam one, ` +
          `and the beamed agent (and anyone holding the kubeconfig) would inherit it. ` +
          `Bind the least-privilege beam-user ServiceAccount (claim lifecycle + pod exec in one ` +
          `namespace) and point \`kubeconfig\` at it.`,
      );
    }
  }

  /**
   * Escape hatches a beam credential must never hold: cluster-wide claim
   * reach, claim mutation, Secret access, raw pod paths, token minting,
   * RBAC escalation, and impersonation.
   */
  private credentialEscapeProbes(): CapabilityProbe[] {
    const ns = this.spec.namespace;
    return [
      ["create SandboxClaims in ALL namespaces", ["create", CLAIM], "all"],
      ["list SandboxClaims in ALL namespaces", ["list", CLAIM], "all"],
      // beam deletes claims in ITS namespace only — cluster-wide delete
      // reaches every other user's sandbox.
      ["delete SandboxClaims in ALL namespaces", ["delete", CLAIM], "all"],
      [`patch SandboxClaims in namespace ${ns}`, ["patch", CLAIM], "namespace"],
      [`update SandboxClaims in namespace ${ns}`, ["update", CLAIM], "namespace"],
      [`read Secrets in namespace ${ns}`, ["get", "secrets"], "namespace"],
      [`list Secrets in namespace ${ns}`, ["list", "secrets"], "namespace"],
      [`create Secrets in namespace ${ns}`, ["create", "secrets"], "namespace"],
      [`patch Secrets in namespace ${ns}`, ["patch", "secrets"], "namespace"],
      [`update Secrets in namespace ${ns}`, ["update", "secrets"], "namespace"],
      [`watch Secrets in namespace ${ns}`, ["watch", "secrets"], "namespace"],
      [`delete Secrets in namespace ${ns}`, ["delete", "secrets"], "namespace"],
      [
        `deletecollection Secrets in namespace ${ns} (bulk Secret deletion is not a beam verb)`,
        ["deletecollection", "secrets"],
        "namespace",
      ],
      [
        `create plain pods in namespace ${ns} (a raw pod spec picks its own image, mounts, ` +
          `and privileges — bypassing the SandboxTemplate boundary)`,
        ["create", "pods"],
        "namespace",
      ],
      [
        `attach to pods in namespace ${ns}`,
        ["create", "pods", "--subresource=attach"],
        "namespace",
      ],
      ["exec into pods in ALL namespaces", ["create", "pods", "--subresource=exec"], "all"],
      [
        "port-forward pods in ALL namespaces",
        ["create", "pods", "--subresource=portforward"],
        "all",
      ],
      [
        `mint ServiceAccount tokens in namespace ${ns}`,
        ["create", "serviceaccounts", "--subresource=token"],
        "namespace",
      ],
      [
        `bind RBAC Roles in namespace ${ns}`,
        ["bind", "roles.rbac.authorization.k8s.io"],
        "namespace",
      ],
      [
        `escalate RBAC Roles in namespace ${ns}`,
        ["escalate", "roles.rbac.authorization.k8s.io"],
        "namespace",
      ],
      ["bind ClusterRoles", ["bind", "clusterroles.rbac.authorization.k8s.io"], "all"],
      ["escalate ClusterRoles", ["escalate", "clusterroles.rbac.authorization.k8s.io"], "all"],
      ["impersonate users", ["impersonate", "users"], "all"],
      ["impersonate groups", ["impersonate", "groups"], "all"],
      [
        `impersonate ServiceAccounts in namespace ${ns}`,
        ["impersonate", "serviceaccounts"],
        "namespace",
      ],
    ];
  }

  /**
   * Every path that runs an attacker-chosen pod spec — or rewrites the
   * approved one — bypasses the SandboxTemplate boundary the same way a
   * raw pod create would. Sandboxes carry their own pod spec; templates
   * shape every future sandbox; ephemeral containers and pod patch/update
   * mutate the live one; workload controllers launch pods transitively.
   */
  private templateBypassProbes(): CapabilityProbe[] {
    const ns = this.spec.namespace;
    const probes: CapabilityProbe[] = [
      [
        `patch pods in namespace ${ns} (image is a mutable pod field — a patch swaps the ` +
          `template's pinned image on a live pod)`,
        ["patch", "pods"],
        "namespace",
      ],
      [`update pods in namespace ${ns}`, ["update", "pods"], "namespace"],
      [
        `inject ephemeral containers into pods in namespace ${ns} (an ephemeral container ` +
          `picks its own image, command, and privileges — bypassing the SandboxTemplate ` +
          `boundary)`,
        ["patch", "pods", "--subresource=ephemeralcontainers"],
        "namespace",
      ],
      [
        `update ephemeral containers on pods in namespace ${ns}`,
        ["update", "pods", "--subresource=ephemeralcontainers"],
        "namespace",
      ],
      [
        `port-forward pods in namespace ${ns} (beam's transport is exec-only — ` +
          `port-forward is not a beam verb)`,
        ["create", "pods", "--subresource=portforward"],
        "namespace",
      ],
    ];
    for (const verb of ["create", "patch", "update", "delete"] as const) {
      probes.push(
        [
          `${verb} Sandboxes in namespace ${ns} (an arbitrary Sandbox carries its own pod ` +
            `spec — bypassing the SandboxTemplate boundary)`,
          [verb, SANDBOX],
          "namespace",
        ],
        [
          `${verb} SandboxTemplates in namespace ${ns} (rewriting the approved template ` +
            `changes every sandbox built from it)`,
          [verb, TEMPLATE],
          "namespace",
        ],
      );
    }
    const workloads: Array<[string, string]> = [
      ["Deployments", "deployments.apps"],
      ["StatefulSets", "statefulsets.apps"],
      ["DaemonSets", "daemonsets.apps"],
      ["ReplicaSets", "replicasets.apps"],
      ["ReplicationControllers", "replicationcontrollers"],
      ["Jobs", "jobs.batch"],
      ["CronJobs", "cronjobs.batch"],
    ];
    for (const [kind, resource] of workloads) {
      for (const verb of ["create", "patch", "update"] as const) {
        probes.push([
          `${verb} ${kind} in namespace ${ns} (a workload controller launches arbitrary ` +
            `pod specs — bypassing the SandboxTemplate boundary)`,
          [verb, resource],
          "namespace",
        ]);
      }
    }
    return probes;
  }

  async doctor(): Promise<ProviderDoctorReport> {
    const lines: string[] = [];
    // An explicit path is taken as-is; a bare name must resolve on PATH.
    const found = this.bin.includes("/") ? this.bin : Bun.which(this.bin);
    if (!found) {
      return { lines, fatal: `kubectl not found (looked for \`${this.bin}\`) — install kubectl` };
    }
    lines.push(`kubectl:      ${found}`);

    // The same fail-closed boundary `beam up` enforces before creating a claim.
    try {
      await this.assertCredentialBoundary();
    } catch (err) {
      return { lines, fatal: err instanceof Error ? err.message : String(err) };
    }
    lines.push("boundary:     ok (none of the probed escape capabilities present)");

    // Every verb provision/connect actually use — nothing more. kubectl wait
    // is a get+list+watch under the hood, hence claim list/watch. Note the
    // exec probe spelling: kubectl >=1.36 answers `create pods/exec`
    // incorrectly; `create pods --subresource=exec` is the reliable form.
    const required: Array<[string, string[]]> = [
      ["create sandboxclaims", ["create", CLAIM]],
      ["get sandboxclaims", ["get", CLAIM]],
      ["list sandboxclaims", ["list", CLAIM]],
      ["watch sandboxclaims", ["watch", CLAIM]],
      ["delete sandboxclaims", ["delete", CLAIM]],
      ["get sandboxes", ["get", SANDBOX]],
      ["get pods", ["get", "pods"]],
      ["exec into pods", ["create", "pods", "--subresource=exec"]],
    ];
    const missing: string[] = [];
    for (const [what, check] of required) {
      if (!(await this.canI(check, "namespace")).allowed) missing.push(what);
    }
    lines.push(
      missing.length === 0
        ? `rbac:         ok (claim lifecycle + pod exec, namespace ${this.spec.namespace} only)`
        : `rbac:         MISSING ${missing.join(", ")} in namespace ${this.spec.namespace} — ` +
          `apply the beam RBAC bundle`,
    );

    // One argv carries resource AND name: even a hostile template string can
    // never be parsed as a kubectl flag (it is also validated as a DNS
    // subdomain in the constructor — belt and braces).
    const tpl = await run([
      ...this.global(this.spec),
      "--namespace",
      this.spec.namespace,
      "get",
      `${TEMPLATE}/${this.spec.template}`,
      "-o",
      "name",
    ]);
    let templateLine: string;
    if (tpl.code === 0) {
      templateLine = `template:     ${this.spec.template} present`;
    } else {
      const lacksGet = /forbidden/i.test(tpl.stderr);
      templateLine = lacksGet
        ? `template:     cannot verify — credential lacks \`get\` on ` +
          `sandboxtemplates/${this.spec.template}; ask the operator to add that ` +
          `resourceName-scoped rule`
        : `template:     MISSING — ${tpl.stderr.trim()}`;
    }
    lines.push(templateLine);
    return { lines };
  }
}
