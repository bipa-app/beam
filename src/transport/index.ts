import type { LocalTargetSpec, SshTargetSpec } from "../config.ts";
import { LocalTransport } from "./local.ts";
import { SshTransport } from "./ssh.ts";
import type { Transport } from "./types.ts";
import { unreachable } from "../util/invariant.ts";

export type { ExecResult, SyncOptions, Transport } from "./types.ts";
export { LocalTransport } from "./local.ts";
export { SshTransport } from "./ssh.ts";
export { KubectlTransport, type KubectlCoords } from "./kubectl.ts";

/**
 * Transports for targets that already exist. Provisioned targets
 * (agent-sandbox) build theirs through their SandboxProvider, which must
 * resolve a live pod first.
 */
export function createTransport(spec: SshTargetSpec | LocalTargetSpec): Transport {
  switch (spec.type) {
    case "ssh":
      return new SshTransport(spec.host, spec.rsyncFlags);
    case "local":
      return new LocalTransport(spec.home, spec.rsyncFlags);
    default:
      return unreachable(spec, "transport target type");
  }
}
