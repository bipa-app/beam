import type { KubectlCoords } from "../transport/kubectl.ts";
import type { Transport } from "../transport/types.ts";

/**
 * Provider-owned coordinates persisted on a handoff record. They are the
 * ground truth for that handoff: `beam down` a year later must tear down
 * the claim it created, even if the config target moved to another cluster.
 */
export interface SandboxState extends KubectlCoords {
  /** SandboxClaim name — stable per handoff record (`beam-<record-id>`). */
  claim: string;
  /**
   * SandboxTemplate the claim must reference. Pinned at reservation so a
   * config edit can never re-aim the identity checks at another template.
   * Absent only on records persisted by older beams (backfilled on read
   * from the record's target snapshot).
   */
  template?: string;
  /**
   * metadata.uid of the SandboxClaim this record created (or adopted on a
   * verified reuse). Kubernetes names are reusable — delete + recreate
   * keeps the name, never the UID — so this is the claim's real identity:
   * every later command re-reads the claim and refuses one whose UID
   * differs, and the claim delete carries it as a precondition. Absent
   * until the first successful provision persists it.
   */
  uid?: string;
}

/** The slice of a handoff record a provider needs to find its sandbox. */
export interface SandboxRef {
  id: string;
  sandbox?: SandboxState;
}

export interface ProviderDoctorReport {
  /** Human-readable check lines for `beam doctor`. */
  lines: string[];
  /** Hard refusal: the transport credential is too powerful for beam. */
  fatal?: string;
}

/**
 * SandboxProvider: the lifecycle above a Transport — create the place a
 * handoff ships to, rebind to it later, tear it down. ssh/local targets are
 * the trivial provider (the machine already exists); agent-sandbox owns one
 * SandboxClaim per handoff record.
 */
export interface SandboxProvider {
  readonly label: string;
  /**
   * Repeated `beam up` for the same workspace reuses the live record and its
   * sandbox instead of creating a duplicate (one claim per record, and
   * per-user namespaces are quota'd to a single claim).
   */
  readonly reusesSandbox: boolean;
  /** Pure coordinates to persist on the record BEFORE provisioning starts. */
  sandboxState(ref: SandboxRef): SandboxState | undefined;
  /**
   * Create (or reuse) the sandbox; resolves when it accepts commands.
   * May enrich `ref.sandbox` with provider-learned identity (the created
   * SandboxClaim's UID). A provider that learns durable identity
   * mid-provision MUST publish it through `persist` the moment it is
   * verified — BEFORE any long wait — and the caller MUST persist that
   * state synchronously, so a crash or timeout during the wait still
   * leaves a record pinned to exactly the object this handoff created.
   */
  provision(ref: SandboxRef, persist?: (sandbox: SandboxState) => void): Promise<Transport>;
  /**
   * Bind to an already-provisioned sandbox, re-resolving anything ephemeral
   * (pod names). Throws an actionable error when it is gone; a missing `ref`
   * means no handoff exists yet for this target.
   */
  connect(ref?: SandboxRef): Promise<Transport>;
  /** Delete provider-owned resources (the claim). No-op for raw transports. */
  destroy(ref: SandboxRef): Promise<void>;
  /**
   * Finish a purge WITHOUT a connection — legal only after the caller has
   * verified BOTH owner-bound cleanup receipts (workspace emptied, session
   * traces cleaned) for this exact record, i.e. the only step a crash can
   * have lost is the claim delete or its terminal state write. Present
   * only on providers with a managed exact-UID resource lifecycle; this is
   * claim-identity convergence, NOT storage erasure — it never substitutes
   * for the connected cleanup. Semantics: a pinned UID is required;
   * absence converges; the exact pinned object is deleted under a
   * server-side UID precondition; a same-name replacement or any API/auth
   * failure throws and the record is retained. Static targets (ssh/local)
   * do not implement it: their unreachable purge always refuses.
   */
  destroyAfterVerifiedCleanupWithoutConnection?(ref: SandboxRef): Promise<void>;
  /** Provider-level checks for `beam doctor`, before any sandbox exists. */
  doctor(): Promise<ProviderDoctorReport>;
}
