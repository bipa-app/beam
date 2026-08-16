import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTransport } from "../src/transport/local.ts";
import {
  assertContainedWorkspace,
  establishContainedWorkspace,
  purgeContainedWorkspace,
} from "../src/workspace.ts";

/**
 * Physical containment, proven against a real filesystem through the local
 * transport (the same scripts run over ssh and kubectl): the configured
 * root canonicalizes, everything below it is no-follow territory, and every
 * destructive or data-bearing use re-proves the path — a symlink planted at
 * (or swapped into) the workspace path must refuse, with the outside target
 * untouched.
 */

function makeHome(): string {
  // realpath: macOS tmpdir lives behind the /var → /private/var symlink,
  // which is exactly the trusted root-level canonicalization case.
  return realpathSync(mkdtempSync(join(tmpdir(), "beam-contain-")));
}

function makeOutside(home: string): string {
  const outside = join(home, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "sentinel.txt"), "untouched\n");
  return outside;
}

/** The outside directory holds exactly its untouched sentinel. */
function expectOutsideIntact(outside: string): void {
  expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
  expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe("untouched\n");
}

describe("physical workspace containment (local transport)", () => {
  test("normal path: establish creates the canonical workspace; recheck passes; purge erases and retries see absent", async () => {
    const home = makeHome();
    const t = new LocalTransport(home);
    const root = join(home, "beam-root"); // does not exist yet — establish creates it
    const ws = await establishContainedWorkspace(t, root, { name: "app-cafe012345" });
    expect(ws).toBe(join(root, "app-cafe012345"));
    expect(existsSync(ws)).toBe(true);

    expect(await assertContainedWorkspace(t, root, ws)).toBe(true);
    // Re-establishing a resolved record's canonical path is idempotent.
    expect(await establishContainedWorkspace(t, root, { path: ws })).toBe(ws);

    writeFileSync(join(ws, "f.txt"), "x\n");
    expect(await purgeContainedWorkspace(t, root, ws)).toBe("purged");
    expect(existsSync(ws)).toBe(false);
    // Idempotent retries: a provably absent workspace is a finished purge…
    expect(await purgeContainedWorkspace(t, root, ws)).toBe("absent");
    expect(await assertContainedWorkspace(t, root, ws, { allowMissing: true })).toBe(false);
    // …but a strict recheck (pre-sync/install) fails closed on a missing tree.
    await expect(assertContainedWorkspace(t, root, ws)).rejects.toThrow(/missing/);
  });

  test("a `~` root resolves against the transport home into a canonical absolute path", async () => {
    const home = makeHome();
    const t = new LocalTransport(home);
    const ws = await establishContainedWorkspace(t, "~/beam", { name: "app-1234567890" });
    expect(ws).toBe(join(home, "beam", "app-1234567890"));
    expect(await assertContainedWorkspace(t, "~/beam", ws)).toBe(true);
    expect(await purgeContainedWorkspace(t, "~/beam", ws)).toBe("purged");
  });

  test("a root that is itself a symlink canonicalizes safely — operations bind to the physical target", async () => {
    const home = makeHome();
    const t = new LocalTransport(home);
    const realRoot = join(home, "real-root");
    mkdirSync(realRoot, { recursive: true });
    const linkRoot = join(home, "link-root");
    symlinkSync(realRoot, linkRoot);

    // Root-level symlinks are trusted config: the workspace lands under the
    // PHYSICAL root and the canonical path is what gets persisted.
    const ws = await establishContainedWorkspace(t, linkRoot, { name: "app-abcdef1234" });
    expect(ws).toBe(join(realRoot, "app-abcdef1234"));
    // Every later operation still binds through the configured (symlinked)
    // root and re-proves the same physical containment.
    expect(await assertContainedWorkspace(t, linkRoot, ws)).toBe(true);
    expect(await purgeContainedWorkspace(t, linkRoot, ws)).toBe("purged");
    expect(existsSync(join(realRoot, "app-abcdef1234"))).toBe(false);
  });

  test("a pre-existing workspace symlink to a writable outside directory refuses before anything ships", async () => {
    const home = makeHome();
    const t = new LocalTransport(home);
    const root = join(home, "beam-root");
    mkdirSync(root, { recursive: true });
    const outside = makeOutside(home);
    const trap = join(root, "app-trap0000001");
    symlinkSync(outside, trap);

    // Establishment — the first thing `beam up` does with the path — refuses.
    await expect(establishContainedWorkspace(t, root, { name: "app-trap0000001" })).rejects.toThrow(/symlink/);

    // Defense in depth: the transport's own sync guard refuses the hop too,
    // so even a caller that skipped establishment cannot ship through it.
    const src = join(home, "src");
    mkdirSync(src);
    writeFileSync(join(src, "leak.txt"), "leak\n");
    await expect(t.syncUp(src, trap)).rejects.toThrow(/symlinked path/);

    expectOutsideIntact(outside);
  });

  test("a path swap after establishment refuses recheck, sync, and purge — the outside target survives", async () => {
    const home = makeHome();
    const t = new LocalTransport(home);
    const root = join(home, "beam-root");
    const ws = await establishContainedWorkspace(t, root, { name: "app-swap0000001" });
    const outside = makeOutside(home);

    rmSync(ws, { recursive: true });
    symlinkSync(outside, ws);

    await expect(assertContainedWorkspace(t, root, ws)).rejects.toThrow(/symlink/);
    // A swap is never "absent": allowMissing tolerates a finished purge, not a redirect.
    await expect(assertContainedWorkspace(t, root, ws, { allowMissing: true })).rejects.toThrow(/symlink/);
    await expect(purgeContainedWorkspace(t, root, ws)).rejects.toThrow(/symlink/);

    const src = join(home, "src");
    mkdirSync(src);
    writeFileSync(join(src, "leak.txt"), "leak\n");
    await expect(t.syncUp(src, ws)).rejects.toThrow(/symlinked path/);
    const collect = join(home, "collect");
    await expect(t.syncDown(ws, collect)).rejects.toThrow(/symlinked path/);
    expect(existsSync(collect)).toBe(false); // refused before any local byte changed

    expectOutsideIntact(outside);
    expect(existsSync(join(outside, "leak.txt"))).toBe(false);
  });

  test("a swap to a sibling INSIDE the root is still refused — no-follow, not just containment", async () => {
    const home = makeHome();
    const t = new LocalTransport(home);
    const root = join(home, "beam-root");
    const wsA = await establishContainedWorkspace(t, root, { name: "app-aaaa000001" });
    const wsB = await establishContainedWorkspace(t, root, { name: "app-bbbb000001" });
    writeFileSync(join(wsB, "precious.txt"), "b's work\n");

    rmSync(wsA, { recursive: true });
    symlinkSync(wsB, wsA);

    // Physically contained, but a symlink nonetheless: operating through it
    // would silently collect or purge the WRONG workspace.
    await expect(assertContainedWorkspace(t, root, wsA)).rejects.toThrow(/symlink/);
    await expect(purgeContainedWorkspace(t, root, wsA)).rejects.toThrow(/symlink/);
    expect(readFileSync(join(wsB, "precious.txt"), "utf8")).toBe("b's work\n");
  });

  test("an existing path outside the physical root refuses recheck and purge", async () => {
    const home = makeHome();
    const t = new LocalTransport(home);
    const root = join(home, "beam-root");
    mkdirSync(root, { recursive: true });
    const elsewhere = join(home, "elsewhere", "deep-dir");
    mkdirSync(elsewhere, { recursive: true });

    await expect(assertContainedWorkspace(t, root, elsewhere)).rejects.toThrow(/not under the physical root/);
    await expect(purgeContainedWorkspace(t, root, elsewhere)).rejects.toThrow(/not under the physical root/);
    // The root itself is never a workspace — a purge of the root must refuse.
    await expect(purgeContainedWorkspace(t, root, root)).rejects.toThrow(/not under the physical root/);
    expect(existsSync(elsewhere)).toBe(true);
  });

  test("workspace names are validated before any remote command runs", async () => {
    const home = makeHome();
    const t = new LocalTransport(home);
    const root = join(home, "beam-root");
    for (const name of ["a/b", "..", ".", "", "a b"]) {
      await expect(establishContainedWorkspace(t, root, { name })).rejects.toThrow(/invalid remote workspace name/);
    }
    expect(existsSync(root)).toBe(false); // nothing ran remotely
  });
});
