import type { Transport } from "../transport/types.ts";
import { run } from "../util/shell.ts";
import type { ProviderDoctorReport, SandboxProvider } from "./types.ts";

/**
 * The trivial provider for targets that already exist (ssh, local): the
 * transport is the sandbox. Nothing to provision, reuse, or destroy. Beam
 * reuses one active record per workspace because each pair shares a path.
 */
export class StaticProvider implements SandboxProvider {
  readonly label: string;
  readonly reusesSandbox = false;

  constructor(private readonly transport: Transport) {
    this.label = transport.label;
  }

  sandboxState(): undefined {
    return undefined;
  }

  async provision(): Promise<Transport> {
    return this.transport;
  }

  async connect(): Promise<Transport> {
    return this.transport;
  }

  async destroy(): Promise<void> {}

  async doctor(): Promise<ProviderDoctorReport> {
    const local = await run(["rsync", "--version"]);
    return { lines: [`local rsync:  ${local.code === 0 ? "ok" : "MISSING — install rsync"}`] };
  }
}
