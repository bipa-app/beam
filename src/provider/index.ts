import type { TargetSpec } from "../config.ts";
import { createTransport } from "../transport/index.ts";
import { AgentSandboxProvider } from "./agent-sandbox.ts";
import { StaticProvider } from "./static.ts";
import { BoxProvider } from "./box.ts";
import { DaytonaProvider } from "./daytona.ts";
import { E2bProvider } from "./e2b.ts";
import { ModalProvider } from "./modal.ts";
import { unreachable } from "../util/invariant.ts";
import type { SandboxProvider } from "./types.ts";

export type { ProviderCheckReport, SandboxProvider, SandboxRef, SandboxState } from "./types.ts";
export { AgentSandboxProvider, DEFAULT_CONTAINER } from "./agent-sandbox.ts";
export { StaticProvider } from "./static.ts";

export { BoxProvider } from "./box.ts";
export { DaytonaProvider } from "./daytona.ts";
export { E2bProvider } from "./e2b.ts";
export { ModalProvider } from "./modal.ts";
export function createProvider(spec: TargetSpec): SandboxProvider {
  switch (spec.type) {
    case "ssh":
    case "local":
      return new StaticProvider(createTransport(spec));
    case "box":
      return new BoxProvider(spec);
    case "daytona":
      return new DaytonaProvider(spec);
    case "e2b":
      return new E2bProvider(spec);
    case "modal":
      return new ModalProvider(spec);
    case "agent-sandbox":
      return new AgentSandboxProvider(spec);
    default:
      return unreachable(spec, "target type");
  }
}
