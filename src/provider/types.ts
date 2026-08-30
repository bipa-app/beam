import type { KubectlCoords } from "../transport/kubectl.ts";
import type { Transport } from "../transport/types.ts";

/**
 * Agent Sandbox coordinates keep their original undiscriminated shape so
 * persisted records from older Beam releases remain readable. A `kind`
 * field therefore identifies other provider-owned resources, never this
 * state.
 */
export interface AgentSandboxState extends KubectlCoords {
  kind?: never;
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

/** Fields managed-provider records can never use from legacy Agent Sandbox state. */
interface ManagedSandboxState {
  claim?: never;
  template?: never;
  uid?: never;
  context?: never;
  namespace?: never;
  container?: never;
  kubeconfig?: never;
}

/** The opaque Box id is the durable identity of one provider-owned VM. */
export interface BoxSandboxState extends ManagedSandboxState {
  kind: "box";
  boxId: string;
}

/** E2B identity survives a crash before the API returns the sandbox id. */
export interface E2bSandboxState extends ManagedSandboxState {
  kind: "e2b";
  ownerToken: string;
  sandboxId?: string;
  sshKeySha256?: string;
}

/** Modal replaces its 24-hour compute around one durable named Volume. */
export interface ModalSandboxState extends ManagedSandboxState {
  kind: "modal";
  ownerToken: string;
  sandboxName: string;
  volumeName: string;
  sshKeySha256?: string;
  /** Set only after the Volume's exact owner marker has been written and read back. */
  volumeOwned?: true;
  /** Ephemeral compute id whose image Beam has bootstrapped with herdr. */
  bootstrappedSandboxId?: string;
}

/** Daytona identity starts with an owned name and pins the returned id. */
export interface DaytonaSandboxState extends ManagedSandboxState {
  kind: "daytona";
  ownerToken: string;
  sandboxName: string;
  sandboxId?: string;
}

export type SandboxState =
  | AgentSandboxState
  | BoxSandboxState
  | E2bSandboxState
  | ModalSandboxState
  | DaytonaSandboxState;

/** The slice of a handoff record a provider needs to find its sandbox. */
export interface SandboxRef {
  id: string;
  sandbox?: SandboxState;
}

export interface ProviderCheckReport {
  /** Human-readable lines for `beam check`. */
  lines: string[];
  /** Hard refusal: the transport credential is too powerful for beam. */
  fatal?: string;
}

/**
 * SandboxProvider: the lifecycle above a Transport — create the place a
 * handoff ships to, rebind to it later, tear it down. SSH/local targets are
 * the trivial provider because the machine already exists. Managed
 * providers own either a SandboxClaim or a Box VM per handoff record.
 */
export interface SandboxProvider {
  readonly label: string;
  /**
   * Whether all active workspaces on this named target share one sandbox.
   * When false, repeated `beam up` still reuses the same workspace record,
   * but a different workspace may provision another provider resource.
   */
  readonly reusesSandbox: boolean;
  /** Durable identity to persist before a long provisioning wait, when already known. */
  sandboxState(ref: SandboxRef): SandboxState | undefined;
  /**
   * Create (or reuse) the sandbox; resolves when it accepts commands.
   * A provider that learns durable identity mid-provision MUST publish it
   * through `persist` the moment it is verified — BEFORE any long wait —
   * and the caller MUST persist that state synchronously, so a crash or
   * timeout during the wait still leaves a record pinned to exactly the
   * object this handoff created.
   */
  provision(ref: SandboxRef, persist?: (sandbox: SandboxState) => void): Promise<Transport>;
  /**
   * Bind to an already-provisioned sandbox, re-resolving anything ephemeral
   * (pod names or Box IPs). Throws an actionable error when it is gone; a
   * missing `ref` means no handoff exists yet for this target.
   */
  connect(ref?: SandboxRef): Promise<Transport>;
  /** Delete the provider-owned resource. No-op for raw transports. */
  destroy(ref: SandboxRef): Promise<void>;
  /**
   * Finish a purge WITHOUT a connection — legal only after the caller has
   * verified BOTH owner-bound cleanup receipts (workspace emptied and
   * session traces cleaned) for this exact record, so the only step a crash
   * can have lost is provider deletion or its terminal state write. Present
   * only on providers with a managed durable-identity lifecycle; this is
   * resource-identity convergence, NOT storage erasure. A pinned provider
   * identity is required; absence converges; only that exact resource is
   * deleted. A replacement or any API/auth failure throws and retains the
   * record. Static targets (ssh/local) do not implement it: their
   * unreachable purge always refuses.
   */
  destroyAfterVerifiedCleanupWithoutConnection?(ref: SandboxRef): Promise<void>;
  /** Provider-level checks for `beam check`, before any sandbox exists. */
  check(): Promise<ProviderCheckReport>;
}
