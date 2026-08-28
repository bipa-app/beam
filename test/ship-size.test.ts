/**
 * Goal: contracts of the `beam up` ship-size preflight:
 *  - the measured size honors the exact outbound rsync patterns, so an
 *    excluded build dir (the whole point of the guard) never counts;
 *  - an oversized mirror refuses with the byte total, the largest
 *    first-level entries, and both escapes (.beamignore, --allow-large);
 *  - a mirror within the ceiling passes and reports its size;
 *  - an unmeasurable mirror (broken rsync) warns and passes — the guard
 *    is advisory, and the ship itself still fails closed downstream.
 *
 * Method: real `assertShipSizeBounded` (rsync --dry-run --stats + du)
 * against throwaway fixture trees with a tiny test ceiling — no remote,
 * no beam state. rsync-gated via describe.skipIf.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertShipSizeBounded, formatBytes } from "../src/workspace.ts";

const HAVE_RSYNC = Bun.which("rsync") !== null;

// Explicit real-process budget: two local rsync dry-run walks plus one du
// over tiny fixture trees — the same cost class up-guards budgets at 30s.
const PREFLIGHT_TIMEOUT_MS = 30_000;

/** A workspace with 64 KiB of source and 256 KiB of build artifacts. */
function fixtureWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "beam-shipsize-fixture-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "target"));
  writeFileSync(join(dir, "src", "main.ts"), Buffer.alloc(64 * 1024, "a"));
  writeFileSync(join(dir, "target", "debug.bin"), Buffer.alloc(256 * 1024, "b"));
  return dir;
}

describe.skipIf(!HAVE_RSYNC)("up ship-size preflight", () => {
  test(
    "excluded patterns never count toward the ceiling",
    async () => {
      const dir = fixtureWorkspace();
      try {
        // 128 KiB ceiling: only passes when /target's 256 KiB is filtered out.
        const bytes = await assertShipSizeBounded(dir, ["/target"], { bytesMax: 128 * 1024 });
        expect(bytes).toBeGreaterThanOrEqual(64 * 1024);
        expect(bytes).toBeLessThan(128 * 1024);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    PREFLIGHT_TIMEOUT_MS,
  );

  test(
    "a broken rsync fails open: undefined, no refusal",
    async () => {
      const dir = fixtureWorkspace();
      const fakeBin = join(dir, "..", `beam-shipsize-fakebin-${Date.now()}`);
      const savedPath = process.env.PATH;
      try {
        mkdirSync(fakeBin, { recursive: true });
        writeFileSync(join(fakeBin, "rsync"), "#!/bin/bash\nexit 23\n");
        chmodSync(join(fakeBin, "rsync"), 0o755);
        process.env.PATH = `${fakeBin}:${process.env.PATH}`;
        const bytes = await assertShipSizeBounded(dir, [], { bytesMax: 1 });
        expect(bytes).toBeUndefined();
      } finally {
        process.env.PATH = savedPath;
        rmSync(fakeBin, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    },
    PREFLIGHT_TIMEOUT_MS,
  );

  test(
    "an oversized mirror refuses with the offenders and both escapes",
    async () => {
      const dir = fixtureWorkspace();
      try {
        const err = await assertShipSizeBounded(dir, [], { bytesMax: 128 * 1024 }).then(
          () => undefined,
          (e: unknown) => e as Error,
        );
        // The refusal names the totals, where the bytes live, and the fix.
        expect(err?.message).toMatch(/would ship 320\.0 KiB \(ceiling 128\.0 KiB\)/);
        expect(err?.message).toContain("largest entries: target");
        expect(err?.message).toContain(join(dir, ".beamignore"));
        expect(err?.message).toContain("--allow-large");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    PREFLIGHT_TIMEOUT_MS,
  );

  test(
    "a mirror within the ceiling returns its measured bytes",
    async () => {
      const dir = fixtureWorkspace();
      try {
        const bytes = await assertShipSizeBounded(dir, [], { bytesMax: 1024 * 1024 });
        expect(bytes).toBe(320 * 1024);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    PREFLIGHT_TIMEOUT_MS,
  );
});

describe("formatBytes", () => {
  test("binary units at each magnitude", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2 * 1024)).toBe("2.0 KiB");
    expect(formatBytes(320 * 1024)).toBe("320.0 KiB");
    expect(formatBytes(3 * 1024 ** 2 + 512 * 1024)).toBe("3.5 MiB");
    expect(formatBytes(39 * 1024 ** 3)).toBe("39.0 GiB");
  });
});
