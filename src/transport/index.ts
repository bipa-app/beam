import type { TargetSpec } from "../config.ts";
import { LocalTransport } from "./local.ts";
import { SshTransport } from "./ssh.ts";
import type { Transport } from "./types.ts";

export type { ExecResult, SyncOptions, Transport } from "./types.ts";
export { LocalTransport } from "./local.ts";
export { SshTransport } from "./ssh.ts";

export function createTransport(spec: TargetSpec): Transport {
  switch (spec.type) {
    case "ssh":
      return new SshTransport(spec.host, spec.rsyncFlags);
    case "local":
      return new LocalTransport(spec.home, spec.rsyncFlags);
  }
}
