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
/** Official v1alpha1 annotation on a Sandbox naming its pod (differs from the sandbox name for warm-pool pods). */
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
  if (value.length > 253 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(value)) {
    throw new Error(
      `agent-sandbox ${what} ${JSON.stringify(value)} is not a DNS subdomain ` +
        `(lowercase alphanumerics, '-' and '.', each segment starting/ending alphanumeric, max 253 chars)`,
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
 * no safe conditional flag.
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
    if (persisted.template !== undefined) assertDnsSubdomain(persisted.template, "persisted template");
    // The UID never reaches argv (equality checks and a JSON-encoded delete
    // precondition only), but a persisted value must still look like one.
    if (persisted.uid !== undefined && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(persisted.uid)) {
      throw new Error(`persisted claim UID for record ${ref.id} is malformed — state.json tampered or corrupted?`);
    }
    const drift = (["claim", "context", "namespace", "container", "kubeconfig", "template"] as const).filter((k) =>
      k === "template"
        ? persisted.template !== undefined && persisted.template !== derived.template
        : persisted[k] !== derived[k],
    );
    if (drift.length > 0) {
      throw new Error(
        `persisted sandbox coordinates for record ${ref.id} do not match the target snapshot ` +
          `(${drift.map((k) => `${k}: ${JSON.stringify(persisted[k])} != ${JSON.stringify(derived[k])}`).join(", ")}) — ` +
          `refusing to run kubectl against coordinates this target did not produce (state.json tampered or corrupted?)`,
      );
    }
    // Older records lack the persisted template — backfill from the snapshot
    // (the identity checks need one; the drift check above pins everything
    // else, so it is the same value `beam up` would have persisted).
    return persisted.template === undefined ? { ...persisted, template: derived.template } : persisted;
  }

  /**
   * A claim beam is about to act on — reuse, wait on, exec through — must
   * be EXACTLY the one this record and target created: same name
   * (`beam-<record id>`), beam's managed-by label, the configured template,
   * and — once the record has pinned it — the same metadata.uid. Names are
   * cheap (delete + recreate keeps the name, never the UID), so the UID is
   * the identity; label and template guard records that predate the pin.
   * Returns the verified UID so callers pin follow-up operations to it.
   *
   * Refusals never point remediation at the mismatched claim: recommending
   * `beam kill <id> --purge` is safe because destroy() runs this same
   * identity gate and retires the record WITHOUT touching an object beam
   * cannot prove it created.
   */
  private verifyClaim(coords: SandboxState, recordId: string, claim: Record<string, unknown>): string {
    const id = claimIdentity(claim);
    const inspect = `kubectl --context ${coords.context} -n ${coords.namespace} get ${CLAIM} ${coords.claim} -o yaml`;
    if (id.name !== coords.claim) {
      throw new Error(
        `SandboxClaim lookup for ${coords.claim} returned an object named ` +
          `${id.name !== undefined ? JSON.stringify(id.name) : "(unreadable)"} — refusing to trust it; inspect: ${inspect}`,
      );
    }
    if (id.uid === undefined) {
      throw new Error(
        `SandboxClaim ${coords.claim} has no readable metadata.uid — refusing to act on an object whose ` +
          `identity cannot be pinned; inspect: ${inspect}`,
      );
    }
    if (coords.uid !== undefined && id.uid !== coords.uid) {
      throw new Error(
        `SandboxClaim ${coords.claim} exists but its UID ${id.uid} is not the one this record created ` +
          `(${coords.uid}) — the original claim is gone and its name was re-used by something else. beam never ` +
          `execs into or deletes a claim it did not create. Retire the record with \`beam kill ${recordId} --purge\` ` +
          `(identity-gated: the same-name claim is left untouched); inspect: ${inspect}`,
      );
    }
    if (id.managedBy !== MANAGED_BY_VALUE) {
      throw new Error(
        `SandboxClaim ${coords.claim} exists but is not managed by beam (label ${MANAGED_BY_KEY} is ` +
          `${id.managedBy !== undefined ? JSON.stringify(id.managedBy) : "missing"}) — another workload owns that ` +
          `name. beam never execs into or deletes it. Retire the record with \`beam kill ${recordId} --purge\` ` +
          `(identity-gated: the foreign claim is left untouched); inspect: ${inspect}`,
      );
    }
    const template = coords.template ?? this.spec.template;
    if (id.template !== template) {
      throw new Error(
        `SandboxClaim ${coords.claim} is beam-managed but references template ` +
          `${id.template ?? "(unreadable)"}, not the configured ${template} — refusing to act on another ` +
          `template's workload. Fix the target's \`template\` if this claim is really this record's; inspect: ${inspect}`,
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

  /** `kubectl get -o json`; undefined on NotFound, throws on other failures. */
  private async getJson(
    coords: SandboxState,
    resource: string,
    name: string,
  ): Promise<Record<string, unknown> | undefined> {
    const res = await run([...this.ns(coords), "get", resource, name, "-o", "json"]);
    if (res.code === 0) return JSON.parse(res.stdout) as Record<string, unknown>;
    if (/\bnot ?found\b/i.test(res.stderr)) return undefined;
    throw new Error(`kubectl get ${resource}/${name} failed (${res.code}): ${res.stderr.trim()}`);
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
    const claim = await this.getJson(coords, CLAIM, coords.claim);
    if (!claim) {
      throw new Error(
        `sandbox is gone: SandboxClaim ${coords.claim} not found in namespace ${coords.namespace} — ` +
          `run \`beam up\` for a fresh handoff`,
      );
    }
    const claimUid = this.verifyClaim(coords, recordId, claim);
    const claimStatus = (claim.status ?? {}) as Record<string, unknown>;
    const claimSandbox = (claimStatus.sandbox ?? {}) as Record<string, unknown>;
    const sandboxName =
      typeof claimSandbox.name === "string" && claimSandbox.name !== "" ? claimSandbox.name : coords.claim;
    // API-returned names are strictly less trusted than configured ones:
    // they came out of cluster objects. Validate before they become argv.
    assertDnsSubdomain(sandboxName, "sandbox name (from claim status)");
    const sandbox = await this.getJson(coords, SANDBOX, sandboxName);
    if (!sandbox) {
      throw new Error(
        `Sandbox ${sandboxName} for claim ${coords.claim} not found — inspect: ` +
          `kubectl --context ${coords.context} -n ${coords.namespace} describe ${CLAIM} ${coords.claim}`,
      );
    }
    const sandboxMeta = (sandbox.metadata ?? {}) as Record<string, unknown>;
    const sandboxUid = typeof sandboxMeta.uid === "string" && sandboxMeta.uid !== "" ? sandboxMeta.uid : undefined;
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
      !sandboxOwners.some((o) => o.kind === "SandboxClaim" && o.name === coords.claim && o.uid === claimUid)
    ) {
      throw new Error(
        `Sandbox ${sandboxName} is not owned by SandboxClaim ${coords.claim} (uid ${claimUid}) — refusing to ` +
          `exec into a sandbox this handoff does not own; inspect: ` +
          `kubectl --context ${coords.context} -n ${coords.namespace} get ${SANDBOX} ${sandboxName} -o yaml`,
      );
    }
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
          `Sandbox ${sandboxName} has no readable metadata.uid — cannot verify the pod's owner chain; inspect: ` +
            `kubectl --context ${coords.context} -n ${coords.namespace} get ${SANDBOX} ${sandboxName} -o yaml`,
        );
      }
      if (!podOwners.some((o) => o.kind === "Sandbox" && o.name === sandboxName && o.uid === sandboxUid)) {
        throw new Error(
          `pod ${podName} is not owned by Sandbox ${sandboxName} (uid ${sandboxUid}) — refusing to exec into ` +
            `a pod this handoff does not own; inspect: ` +
            `kubectl --context ${coords.context} -n ${coords.namespace} get pod ${podName} -o yaml`,
        );
      }
    }
    const podStatus = (pod.status ?? {}) as Record<string, unknown>;
    if (podStatus.phase !== "Running") {
      throw new Error(
        `pod ${podName} for claim ${coords.claim} is ${typeof podStatus.phase === "string" ? podStatus.phase : "in an unknown phase"}, ` +
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
      // created — name, managed-by label, template, and (once persisted)
      // UID (see verifyClaim).
      uid = this.verifyClaim(coords, ref.id, current);
      console.log(`sandbox: reusing claim ${coords.claim} (namespace ${coords.namespace}, uid ${uid})`);
    } else {
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
        `sandbox: creating claim ${coords.claim} (template ${this.spec.template}, namespace ${coords.namespace})`,
      );
      // `-o json` echoes the created object, so the server-assigned UID is
      // captured from the SAME request that created it — no read-back race.
      const created = await run([...this.ns(coords), "create", "-f", "-", "-o", "json"], { stdinText: manifest });
      if (created.code === 0) {
        let createdObj: Record<string, unknown>;
        try {
          createdObj = JSON.parse(created.stdout) as Record<string, unknown>;
        } catch {
          throw new Error(
            `creating SandboxClaim ${coords.claim} succeeded but the created object could not be parsed — ` +
              `refusing to continue without its UID`,
          );
        }
        const identity = claimIdentity(createdObj);
        if (identity.name !== coords.claim || identity.uid === undefined) {
          throw new Error(
            `creating SandboxClaim ${coords.claim} returned an object beam cannot identify ` +
              `(name ${identity.name ?? "(unreadable)"}, uid ${identity.uid ?? "(unreadable)"}) — refusing to continue`,
          );
        }
        uid = identity.uid;
      } else {
        if (!/already ?exists/i.test(created.stderr)) {
          throw new Error(`creating SandboxClaim ${coords.claim} failed (${created.code}): ${created.stderr.trim()}`);
        }
        // A concurrent creator won the race between beam's get and this
        // create. That claim is reused ONLY after a re-read proves it is
        // exactly the claim this record and target would have created —
        // beam-labeled, on the configured template, and (when this record
        // already pinned a UID) that exact object. A raced claim failing
        // any of those is another workload, and waiting on (or exec'ing
        // into) it would hand the session to that workload.
        const raced = await this.getJson(coords, CLAIM, coords.claim);
        if (!raced) {
          throw new Error(
            `SandboxClaim ${coords.claim} reported AlreadyExists on create but is gone on re-read — ` +
              `a concurrent process is racing record ${ref.id}; retry \`beam up\`, or abandon the record ` +
              `with \`beam kill ${ref.id} --purge\``,
          );
        }
        uid = this.verifyClaim(coords, ref.id, raced);
        console.log(`sandbox: reusing claim ${coords.claim} (created concurrently, namespace ${coords.namespace})`);
      }
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
    console.log(`sandbox: waiting for Ready (cold boot can take ~15 min, ceiling ${READY_TIMEOUT})…`);
    const waited = await run([
      ...this.ns(pinned),
      "wait",
      "--for=condition=Ready",
      `${CLAIM}/${pinned.claim}`,
      `--timeout=${READY_TIMEOUT}`,
    ]);
    if (waited.code !== 0) {
      // The claim stays: the record already points at it, so a retried
      // `beam up` continues this boot and `beam kill <id> --purge` abandons it.
      throw new Error(
        `sandbox claim ${pinned.claim} did not become Ready within ${READY_TIMEOUT}: ` +
          `${(waited.stderr || waited.stdout).trim()}\n` +
          `  inspect: kubectl --context ${pinned.context} -n ${pinned.namespace} describe ${CLAIM} ${pinned.claim}\n` +
          `  retry:   beam up (continues this claim) · abandon: beam kill ${ref.id} --purge`,
      );
    }
    // resolvePod re-reads and re-verifies the claim — now WITH the UID pin —
    // so a claim replaced during the (long) Ready wait is caught before exec.
    const pod = await this.resolvePod(pinned, ref.id);
    console.log(`sandbox: pod ${pod} ready`);
    return new KubectlTransport(pinned, pod, this.bin);
  }

  async connect(ref?: SandboxRef): Promise<Transport> {
    if (!ref) {
      throw new Error(
        "no live sandbox for this target — run `beam up` (or `beam up --no-start`) to provision one first",
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
   * leaves the occupant untouched; an ambiguous mismatch fails closed.
   */
  async destroy(ref: SandboxRef): Promise<void> {
    const coords = this.sandboxState(ref);
    const current = await this.getJson(coords, CLAIM, coords.claim);
    if (!current) {
      console.log(`sandbox: claim ${coords.claim} already gone (nothing to delete)`);
      return;
    }
    const id = claimIdentity(current);
    const inspect = `kubectl --context ${coords.context} -n ${coords.namespace} get ${CLAIM} ${coords.claim} -o yaml`;
    const template = coords.template ?? this.spec.template;
    if (id.name !== coords.claim || id.uid === undefined) {
      throw new Error(
        `SandboxClaim lookup for ${coords.claim} returned an object beam cannot identify — ` +
          `refusing to delete anything; inspect: ${inspect}`,
      );
    }
    if (coords.uid !== undefined && id.uid !== coords.uid) {
      console.log(
        `sandbox: claim ${coords.claim} was replaced (uid ${id.uid}; this record created ${coords.uid}) — ` +
          `the claim this record created is already gone; leaving the same-name claim untouched`,
      );
      return;
    }
    if (id.managedBy !== MANAGED_BY_VALUE) {
      if (coords.uid !== undefined) {
        // Our own UID without beam's label: someone mutated the object.
        // Deleting on a tampered identity is guessing — fail closed.
        throw new Error(
          `SandboxClaim ${coords.claim} matches this record's UID but no longer carries the ` +
            `${MANAGED_BY_KEY}=${MANAGED_BY_VALUE} label — tampered; refusing to delete it; inspect: ${inspect}`,
        );
      }
      console.log(
        `sandbox: claim ${coords.claim} is not managed by beam (label ${MANAGED_BY_KEY} missing or foreign) — ` +
          `no beam created it, so nothing of record ${ref.id}'s remains; leaving it untouched`,
      );
      return;
    }
    if (id.template !== template) {
      throw new Error(
        `SandboxClaim ${coords.claim} is beam-managed but references template ${id.template ?? "(unreadable)"}, ` +
          `not the configured ${template} — refusing to delete a claim this record did not produce as ` +
          `configured. Fix the target's \`template\` if it is really this record's; inspect: ${inspect}`,
      );
    }
    // Every check above ran against ONE observed object — pin the delete to
    // exactly that object. Namespace and claim name are DNS-validated long
    // before they can reach the URI; the UID travels in a JSON body, never
    // argv. `-f -` supplies the DeleteOptions body on stdin.
    const path = `/apis/${CLAIM_API_VERSION}/namespaces/${coords.namespace}/sandboxclaims/${coords.claim}`;
    const res = await run([...this.global(coords), "delete", "--raw", path, "-f", "-"], {
      stdinText: JSON.stringify({ kind: "DeleteOptions", apiVersion: "v1", preconditions: { uid: id.uid } }),
    });
    if (res.code === 0) {
      console.log(`sandbox: claim ${coords.claim} deleted (uid ${id.uid})`);
      return;
    }
    if (/\bnot ?found\b/i.test(res.stderr)) {
      console.log(`sandbox: claim ${coords.claim} already gone (nothing to delete)`);
      return;
    }
    if (/precondition|conflict/i.test(res.stderr)) {
      console.log(
        `sandbox: claim ${coords.claim} was deleted and re-created mid-delete (UID precondition refused) — ` +
          `the claim this record created is gone; leaving the replacement untouched`,
      );
      return;
    }
    throw new Error(`deleting SandboxClaim ${coords.claim} failed (${res.code}): ${res.stderr.trim()}`);
  }

  /**
   * `kubectl auth can-i`: yes/no by stdout; anything else is a cluster or
   * credential error worth surfacing verbatim.
   */
  private async canI(check: string[], scope: "namespace" | "all"): Promise<{ allowed: boolean; error?: string }> {
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
    const ns = this.spec.namespace;
    const forbidden: Array<[string, string[], "namespace" | "all"]> = [
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
      [`deletecollection Secrets in namespace ${ns} (bulk Secret deletion is not a beam verb)`, ["deletecollection", "secrets"], "namespace"],
      [
        `create plain pods in namespace ${ns} (a raw pod spec picks its own image, mounts, and privileges — bypassing the SandboxTemplate boundary)`,
        ["create", "pods"],
        "namespace",
      ],
      [`attach to pods in namespace ${ns}`, ["create", "pods", "--subresource=attach"], "namespace"],
      ["exec into pods in ALL namespaces", ["create", "pods", "--subresource=exec"], "all"],
      ["port-forward pods in ALL namespaces", ["create", "pods", "--subresource=portforward"], "all"],
      [`mint ServiceAccount tokens in namespace ${ns}`, ["create", "serviceaccounts", "--subresource=token"], "namespace"],
      [`bind RBAC Roles in namespace ${ns}`, ["bind", "roles.rbac.authorization.k8s.io"], "namespace"],
      [`escalate RBAC Roles in namespace ${ns}`, ["escalate", "roles.rbac.authorization.k8s.io"], "namespace"],
      ["bind ClusterRoles", ["bind", "clusterroles.rbac.authorization.k8s.io"], "all"],
      ["escalate ClusterRoles", ["escalate", "clusterroles.rbac.authorization.k8s.io"], "all"],
      ["impersonate users", ["impersonate", "users"], "all"],
      ["impersonate groups", ["impersonate", "groups"], "all"],
      [`impersonate ServiceAccounts in namespace ${ns}`, ["impersonate", "serviceaccounts"], "namespace"],
    ];
    // Every path that runs an attacker-chosen pod spec — or rewrites the
    // approved one — bypasses the SandboxTemplate boundary the same way a
    // raw pod create would. Sandboxes carry their own pod spec; templates
    // shape every future sandbox; ephemeral containers and pod patch/update
    // mutate the live one; workload controllers launch pods transitively.
    forbidden.push(
      [
        `patch pods in namespace ${ns} (image is a mutable pod field — a patch swaps the template's pinned image on a live pod)`,
        ["patch", "pods"],
        "namespace",
      ],
      [`update pods in namespace ${ns}`, ["update", "pods"], "namespace"],
      [
        `inject ephemeral containers into pods in namespace ${ns} (an ephemeral container picks its own image, command, and privileges — bypassing the SandboxTemplate boundary)`,
        ["patch", "pods", "--subresource=ephemeralcontainers"],
        "namespace",
      ],
      [
        `update ephemeral containers on pods in namespace ${ns}`,
        ["update", "pods", "--subresource=ephemeralcontainers"],
        "namespace",
      ],
      [
        `port-forward pods in namespace ${ns} (beam's transport is exec-only — port-forward is not a beam verb)`,
        ["create", "pods", "--subresource=portforward"],
        "namespace",
      ],
    );
    for (const verb of ["create", "patch", "update", "delete"] as const) {
      forbidden.push(
        [
          `${verb} Sandboxes in namespace ${ns} (an arbitrary Sandbox carries its own pod spec — bypassing the SandboxTemplate boundary)`,
          [verb, SANDBOX],
          "namespace",
        ],
        [
          `${verb} SandboxTemplates in namespace ${ns} (rewriting the approved template changes every sandbox built from it)`,
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
        forbidden.push([
          `${verb} ${kind} in namespace ${ns} (a workload controller launches arbitrary pod specs — bypassing the SandboxTemplate boundary)`,
          [verb, resource],
          "namespace",
        ]);
      }
    }
    // ~50 probes, each one SelfSubjectAccessReview — run them concurrently,
    // then report deterministically in list order.
    const probes = await Promise.all(
      forbidden.map(async ([what, check, scope]) => ({ what, check, probe: await this.canI(check, scope) })),
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

  async doctor(): Promise<ProviderDoctorReport> {
    const lines: string[] = [];
    // An explicit path is taken as-is; a bare name must resolve on PATH.
    const found = this.bin.includes("/") ? this.bin : Bun.which(this.bin);
    if (!found) return { lines, fatal: `kubectl not found (looked for \`${this.bin}\`) — install kubectl` };
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
        : `rbac:         MISSING ${missing.join(", ")} in namespace ${this.spec.namespace} — apply the beam RBAC bundle`,
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
    lines.push(
      tpl.code === 0
        ? `template:     ${this.spec.template} present`
        : /forbidden/i.test(tpl.stderr)
          ? `template:     cannot verify — credential lacks \`get\` on sandboxtemplates/${this.spec.template}; ` +
            `ask the operator to add that resourceName-scoped rule`
          : `template:     MISSING — ${tpl.stderr.trim()}`,
    );
    return { lines };
  }
}
