import { fileSha256, treeSha256 } from "../util/digest.ts";
import type { LocalSession } from "./types.ts";

/**
 * The exact local session source a ship installs: tool + session identity +
 * bounded-streaming digests of the transcript and (when present) the
 * artifacts tree. Journaled on shipPending so a crashed attempt's retry can
 * refuse a locally mutated source BEFORE any staging, and folded into the
 * deterministic remote install-stage key.
 */
export interface SessionShipBundle {
  tool: LocalSession["tool"];
  id: string;
  transcriptSha256: string;
  /** Present iff the session ships an artifacts tree. */
  artifactsSha256?: string;
}

/** Digest-only snapshot of the live local session source (no copies). */
export function sessionShipBundle(session: LocalSession): SessionShipBundle {
  const bundle: SessionShipBundle = {
    tool: session.tool,
    id: session.id,
    transcriptSha256: fileSha256(session.file),
  };
  if (session.artifactsDir) bundle.artifactsSha256 = treeSha256(session.artifactsDir);
  return bundle;
}

/**
 * Deterministic remote install-stage key: one digest over the WHOLE bundle
 * (tool, session id, transcript digest, artifact presence/digest), so a
 * retry converges onto the same reserved `.beam/session-install/<key>` stage
 * only when it ships exactly the journaled source.
 */
export function sessionInstallKey(bundle: SessionShipBundle): string {
  return new Bun.CryptoHasher("sha256")
    .update(
      `beam-session-install-v1\0${bundle.tool}\0${bundle.id}\0${bundle.transcriptSha256}\0` +
        `${bundle.artifactsSha256 ?? "absent"}\0`,
    )
    .digest("hex");
}

