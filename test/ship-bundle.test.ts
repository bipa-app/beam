/**
 * Goal: a session ship bundle's install key covers the WHOLE source identity
 * — transcript bytes, artifact file content, symlink target, entry kind, and
 * artifact presence each change the key, and an unchanged source converges
 * back to the same key (retries are deterministic).
 *
 * Method: build a real transcript+artifacts fixture on disk, mutate one
 * identity dimension at a time, and compare sessionInstallKey outputs; the
 * tree digest is also proved chunk-size-invariant.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BeamEnv } from "../src/env.ts";
import type { LocalSession } from "../src/session/types.ts";
import { sessionInstallKey, sessionShipBundle } from "../src/session/ship-bundle.ts";
import { treeSha256 } from "../src/util/digest.ts";

function fixture(withArtifacts = true) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "beam-bundle-")));
  const env: BeamEnv = { home, beamDir: join(home, ".beam") };
  const file = join(home, "sess_1.jsonl");
  writeFileSync(file, '{"type":"session","id":"sess-1"}\n');
  let artifactsDir: string | undefined;
  if (withArtifacts) {
    artifactsDir = join(home, "sess_1");
    mkdirSync(join(artifactsDir, "sub"), { recursive: true });
    writeFileSync(join(artifactsDir, "a.txt"), "alpha\n");
    symlinkSync("a.txt", join(artifactsDir, "ln"));
  }
  const session: LocalSession = { tool: "omp", id: "sess-1", file, artifactsDir, mtime: 0 };
  return { env, home, file, artifactsDir, session };
}

describe("session ship bundle: the install key covers the whole source identity", () => {
  test("transcript content, artifact content, link target, entry kind, and presence" +
    " each change the key", () => {
    const f = fixture();
    const base = sessionInstallKey(sessionShipBundle(f.session));

    // Transcript content changes the key; restoring it restores the key
    // (deterministic — a retry with the exact source converges).
    writeFileSync(f.file, '{"type":"session","id":"sess-1"}\n{"m":1}\n');
    expect(sessionInstallKey(sessionShipBundle(f.session))).not.toBe(base);
    writeFileSync(f.file, '{"type":"session","id":"sess-1"}\n');
    expect(sessionInstallKey(sessionShipBundle(f.session))).toBe(base);

    // Artifact file content.
    writeFileSync(join(f.artifactsDir!, "a.txt"), "beta\n");
    expect(sessionInstallKey(sessionShipBundle(f.session))).not.toBe(base);
    writeFileSync(join(f.artifactsDir!, "a.txt"), "alpha\n");
    expect(sessionInstallKey(sessionShipBundle(f.session))).toBe(base);

    // Symlink target.
    rmSync(join(f.artifactsDir!, "ln"));
    symlinkSync("sub", join(f.artifactsDir!, "ln"));
    const retargeted = sessionInstallKey(sessionShipBundle(f.session));
    expect(retargeted).not.toBe(base);

    // Entry KIND at the same path (regular file whose content equals the
    // old link target still differs — kind is part of identity).
    rmSync(join(f.artifactsDir!, "ln"));
    writeFileSync(join(f.artifactsDir!, "ln"), "a.txt");
    const rekinded = sessionInstallKey(sessionShipBundle(f.session));
    expect(rekinded).not.toBe(base);
    expect(rekinded).not.toBe(retargeted);

    // Artifact presence.
    expect(
      sessionInstallKey(sessionShipBundle({ ...f.session, artifactsDir: undefined })),
    ).not.toBe(base);
  });

  test("treeSha256 is chunk-size-invariant across multi-chunk files", () => {
    const f = fixture();
    writeFileSync(join(f.artifactsDir!, "big.bin"), Buffer.alloc((1 << 21) + 7, 3));
    expect(treeSha256(f.artifactsDir!, 4096)).toBe(treeSha256(f.artifactsDir!));
  });
});

