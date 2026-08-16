import type { TargetSpec } from "../config.ts";
import { createTransport } from "../transport/index.ts";
import { AgentSandboxProvider } from "./agent-sandbox.ts";
import { StaticProvider } from "./static.ts";
import type { SandboxProvider } from "./types.ts";

export type { ProviderDoctorReport, SandboxProvider, SandboxRef, SandboxState } from "./types.ts";
export { AgentSandboxProvider, DEFAULT_CONTAINER } from "./agent-sandbox.ts";
export { StaticProvider } from "./static.ts";

export function createProvider(spec: TargetSpec): SandboxProvider {
  switch (spec.type) {
    case "ssh":
    case "local":
      return new StaticProvider(createTransport(spec));
    case "agent-sandbox":
      return new AgentSandboxProvider(spec);
  }
}
