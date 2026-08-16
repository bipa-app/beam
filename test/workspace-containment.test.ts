/**
 * Goal: physical containment, proven against a real filesystem: the
 * configured root canonicalizes, everything below it is no-follow
 * territory, and every destructive or data-bearing use re-proves the path
 * — a symlink planted at (or swapped into) the workspace path must refuse,
 * with the outside target untouched; ownership markers gate the two-phase
 * kill purge and the release of owned workspace contents.
 *
 * Method: the same containment scripts that run over ssh and kubectl are
 * executed through the LocalTransport against realpath-canonicalized
 * mkdtemp fixture trees (macOS tmpdir's /var → /private/var symlink is
 * itself the trusted root-level canonicalization case), planting and
 * swapping symlinks at the workspace path and inspecting what survives.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTransport } from "../src/transport/local.ts";
import {
  assertContainedWorkspace,
  establishContainedWorkspace,
  purgeOwnedWorkspaceContents,
  releaseOwnedWorkspace,
  workspaceOwnerContent,
} from "../src/workspace.ts";

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

/** A record-bound owner claim for fresh establishes in these tests. */
const OWNER = {
  content: workspaceOwnerContent("t0test", "ab".repeat(16)),
  adopt: "create" as const,
};
const OWNER_VERIFY = { content: OWNER.content, adopt: "verify" as const };

describe("physical workspace containment (local transport)", () => {
  test(
    "normal path: establish creates the canonical workspace; " +
      "Phase A empties to the receipted layout; Phase B releases",
    async () => {
      const home = makeHome();
      const t = new LocalTransport(home);
      const root = join(home, "beam-root"); // does not exist yet — establish creates it
      const ws = await establishContainedWorkspace(t, root, { name: "app-cafe012345" }, OWNER);
      expect(ws).toBe(join(root, "app-cafe012345"));
      expect(existsSync(ws)).toBe(true);

      expect(await assertContainedWorkspace(t, root, ws)).toBe(true);
      // Re-establishing a resolved record's canonical path is idempotent.
      expect(await establishContainedWorkspace(t, root, { path: ws }, OWNER_VERIFY)).toBe(ws);

      writeFileSync(join(ws, "f.txt"), "x\n");
      // Phase A empties the workspace EXCEPT the exact owner marker and
      // verifies exactly that end state in the same shell: the root holds
      // `.beam` alone, and `.beam` the exact-byte marker alone.
      expect(await purgeOwnedWorkspaceContents(t, ws, OWNER.content)).toBe("purged");
      expect(existsSync(ws)).toBe(true);
      expect(readdirSync(ws)).toEqual([".beam"]);
      expect(readdirSync(join(ws, ".beam"))).toEqual(["owner"]);
      expect(readFileSync(join(ws, ".beam", "owner"), "utf8")).toBe(`${OWNER.content}\n`);
      // Phase A's own postcondition re-converges on ANY attempt — the
      // surviving marker carries the owner proof, no receipt needed…
      expect(await purgeOwnedWorkspaceContents(t, ws, OWNER.content)).toBe("purged");
      // …and the receipted retry short-circuits through the same state.
      expect(
        await purgeOwnedWorkspaceContents(t, ws, OWNER.content, { acceptConverged: true }),
      ).toBe("purged");

      // Phase B (the caller holds the contents receipt) releases the marker
      // and best-effort removes the emptied dirs.
      expect(await releaseOwnedWorkspace(t, ws, OWNER.content)).toBe("released");
      expect(existsSync(ws)).toBe(false);
      // Released states converge ONLY for the receipted retry…
      expect(await releaseOwnedWorkspace(t, ws, OWNER.content)).toBe("absent");
      expect(
        await purgeOwnedWorkspaceContents(t, ws, OWNER.content, { acceptConverged: true }),
      ).toBe("absent");
      // …a receipt-less attempt refuses absence like a foreign path.
      await expect(purgeOwnedWorkspaceContents(t, ws, OWNER.content)).rejects.toThrow(
        /not owned by this handoff/,
      );
      expect(await assertContainedWorkspace(t, root, ws, { allowMissing: true })).toBe(false);
      // …but a strict recheck (pre-sync/install) fails closed on a missing tree.
      await expect(assertContainedWorkspace(t, root, ws)).rejects.toThrow(/missing/);
    },
  );

  test(
    "a `~` root resolves against the transport home into a canonical absolute path",
    async () => {
      const home = makeHome();
      const t = new LocalTransport(home);
      const ws = await establishContainedWorkspace(t, "~/beam", { name: "app-1234567890" }, OWNER);
      expect(ws).toBe(join(home, "beam", "app-1234567890"));
      expect(await assertContainedWorkspace(t, "~/beam", ws)).toBe(true);
      expect(await purgeOwnedWorkspaceContents(t, ws, OWNER.content)).toBe("purged");
      expect(readdirSync(ws)).toEqual([".beam"]);
      expect(await releaseOwnedWorkspace(t, ws, OWNER.content)).toBe("released");
      expect(existsSync(ws)).toBe(false);
    },
  );

  test(
    "a root that is itself a symlink canonicalizes safely — operations bind to the physical target",
    async () => {
      const home = makeHome();
      const t = new LocalTransport(home);
      const realRoot = join(home, "real-root");
      mkdirSync(realRoot, { recursive: true });
      const linkRoot = join(home, "link-root");
      symlinkSync(realRoot, linkRoot);

      // Root-level symlinks are trusted config: the workspace lands under the
      // PHYSICAL root and the canonical path is what gets persisted.
      const ws = await establishContainedWorkspace(t, linkRoot, { name: "app-abcdef1234" }, OWNER);
      expect(ws).toBe(join(realRoot, "app-abcdef1234"));
      // Every later operation still binds through the configured (symlinked)
      // root and re-proves the same physical containment.
      expect(await assertContainedWorkspace(t, linkRoot, ws)).toBe(true);
      expect(await purgeOwnedWorkspaceContents(t, ws, OWNER.content)).toBe("purged");
      expect(readdirSync(join(realRoot, "app-abcdef1234"))).toEqual([".beam"]);
    },
  );

  test(
    "a pre-existing workspace symlink to a writable outside directory " +
      "refuses before anything ships",
    async () => {
      const home = makeHome();
      const t = new LocalTransport(home);
      const root = join(home, "beam-root");
      mkdirSync(root, { recursive: true });
      const outside = makeOutside(home);
      const trap = join(root, "app-trap0000001");
      symlinkSync(outside, trap);

      // Establishment — the first thing `beam up` does with the path — refuses.
      await expect(
        establishContainedWorkspace(t, root, { name: "app-trap0000001" }, OWNER),
      ).rejects.toThrow(/symlink/);

      // Defense in depth: the transport's own sync guard refuses the hop too,
      // so even a caller that skipped establishment cannot ship through it.
      const src = join(home, "src");
      mkdirSync(src);
      writeFileSync(join(src, "leak.txt"), "leak\n");
      await expect(t.syncUp(src, trap)).rejects.toThrow(/symlinked path/);

      expectOutsideIntact(outside);
    },
  );

  test(
    "a path swap after establishment refuses recheck, sync, and purge — " +
      "the outside target survives",
    async () => {
      const home = makeHome();
      const t = new LocalTransport(home);
      const root = join(home, "beam-root");
      const ws = await establishContainedWorkspace(t, root, { name: "app-swap0000001" }, OWNER);
      const outside = makeOutside(home);

      rmSync(ws, { recursive: true });
      symlinkSync(outside, ws);

      await expect(assertContainedWorkspace(t, root, ws)).rejects.toThrow(/symlink/);
      // A swap is never "absent": allowMissing tolerates a finished purge, not a redirect.
      await expect(
        assertContainedWorkspace(t, root, ws, { allowMissing: true }),
      ).rejects.toThrow(/symlink/);
      await expect(purgeOwnedWorkspaceContents(t, ws, OWNER.content)).rejects.toThrow(
        /no longer resolves|cannot enter/,
      );

      const src = join(home, "src");
      mkdirSync(src);
      writeFileSync(join(src, "leak.txt"), "leak\n");
      await expect(t.syncUp(src, ws)).rejects.toThrow(/symlinked path/);
      const collect = join(home, "collect");
      await expect(t.syncDown(ws, collect)).rejects.toThrow(/symlinked path/);
      expect(existsSync(collect)).toBe(false); // refused before any local byte changed

      expectOutsideIntact(outside);
      expect(existsSync(join(outside, "leak.txt"))).toBe(false);
    },
  );

  test(
    "a swap to a sibling INSIDE the root is still refused — no-follow, not just containment",
    async () => {
      const home = makeHome();
      const t = new LocalTransport(home);
      const root = join(home, "beam-root");
      const wsA = await establishContainedWorkspace(t, root, { name: "app-aaaa000001" }, OWNER);
      const wsB = await establishContainedWorkspace(t, root, { name: "app-bbbb000001" }, OWNER);
      writeFileSync(join(wsB, "precious.txt"), "b's work\n");

      rmSync(wsA, { recursive: true });
      symlinkSync(wsB, wsA);

      // Physically contained, but a symlink nonetheless: operating through it
      // would silently collect or purge the WRONG workspace.
      await expect(assertContainedWorkspace(t, root, wsA)).rejects.toThrow(/symlink/);
      await expect(purgeOwnedWorkspaceContents(t, wsA, OWNER.content)).rejects.toThrow(
        /no longer resolves|cannot enter/,
      );
      expect(readFileSync(join(wsB, "precious.txt"), "utf8")).toBe("b's work\n");
    },
  );

  test("an existing path outside the physical root refuses recheck and purge", async () => {
    const home = makeHome();
    const t = new LocalTransport(home);
    const root = join(home, "beam-root");
    mkdirSync(root, { recursive: true });
    const elsewhere = join(home, "elsewhere", "deep-dir");
    mkdirSync(elsewhere, { recursive: true });

    await expect(assertContainedWorkspace(t, root, elsewhere)).rejects.toThrow(
      /not under the physical root/,
    );
    // The owned purge never trusts a bare path either: without this
    // record's marker, any directory — the root included — refuses.
    await expect(purgeOwnedWorkspaceContents(t, elsewhere, OWNER.content)).rejects.toThrow(
      /not owned by this handoff/,
    );
    await expect(purgeOwnedWorkspaceContents(t, root, OWNER.content)).rejects.toThrow(
      /not owned by this handoff/,
    );
    expect(existsSync(elsewhere)).toBe(true);
  });

  test("workspace names are validated before any remote command runs", async () => {
    const home = makeHome();
    const t = new LocalTransport(home);
    const root = join(home, "beam-root");
    for (const name of ["a/b", "..", ".", "", "a b"]) {
      await expect(establishContainedWorkspace(t, root, { name }, OWNER)).rejects.toThrow(
        /invalid remote workspace name/,
      );
    }
    expect(existsSync(root)).toBe(false); // nothing ran remotely
  });
});

/**
 * The two-phase kill purge. Phase A empties the workspace but leaves the
 * exact `.beam/owner` marker standing as the workspace's surviving
 * identity; Phase B releases the marker and runs ONLY under the caller's
 * persisted contents receipt. A journaled kill intent alone never
 * licenses reading absence or emptiness as "already erased": without the
 * receipt those states refuse exactly like a foreign path, so a same-path
 * empty replacement directory can never be silently accepted.
 */
describe("two-phase kill purge (local transport)", () => {
  test(
    "a same-path empty replacement with no marker and no receipt refuses — " +
      "the directory survives untouched",
    async () => {
      const home = makeHome();
      const t = new LocalTransport(home);
      const root = join(home, "beam-root");
      const ws = await establishContainedWorkspace(t, root, { name: "app-repl000001" }, OWNER);
      // Out-of-band swap: the claimed workspace vanished and a fresh empty
      // directory stands at the same path (storage swap, pod rebuild).
      rmSync(ws, { recursive: true });
      mkdirSync(ws, { recursive: true });
      await expect(purgeOwnedWorkspaceContents(t, ws, OWNER.content)).rejects.toThrow(
        /not owned by this handoff/,
      );
      expect(existsSync(ws)).toBe(true);
      expect(readdirSync(ws)).toEqual([]);
      // A provably ABSENT path refuses the receipt-less attempt the same way.
      rmSync(ws, { recursive: true });
      await expect(purgeOwnedWorkspaceContents(t, ws, OWNER.content)).rejects.toThrow(
        /not owned by this handoff/,
      );
    },
  );

  test(
    "crash mid-A: user content gone, marker intact — " +
      "the receipt-less retry re-proves the owner and converges",
    async () => {
      const home = makeHome();
      const t = new LocalTransport(home);
      const root = join(home, "beam-root");
      const ws = await establishContainedWorkspace(t, root, { name: "app-mida000001" }, OWNER);
      mkdirSync(join(ws, ".beam", "git"), { recursive: true });
      writeFileSync(join(ws, ".beam", "session.jsonl"), "{}\n");
      writeFileSync(join(ws, "f.txt"), "x\n");
      // Simulated crash mid-A, BEFORE the receipt: the user contents were
      // already erased, the reserved dir still holds metadata + the marker.
      rmSync(join(ws, "f.txt"));
      expect(await purgeOwnedWorkspaceContents(t, ws, OWNER.content)).toBe("purged");
      expect(readdirSync(ws)).toEqual([".beam"]);
      expect(readdirSync(join(ws, ".beam"))).toEqual(["owner"]);
      expect(readFileSync(join(ws, ".beam", "owner"), "utf8")).toBe(`${OWNER.content}\n`);
    },
  );

  test(
    "crash after the contents receipt, mid-B: " +
      "receipted Phase A accepts the unlinked marker; Phase B converges to released",
    async () => {
      const home = makeHome();
      const t = new LocalTransport(home);
      const root = join(home, "beam-root");
      const ws = await establishContainedWorkspace(t, root, { name: "app-midb000001" }, OWNER);
      expect(await purgeOwnedWorkspaceContents(t, ws, OWNER.content)).toBe("purged");
      // Mid-B crash simulation: the owner marker was unlinked but `.beam`
      // (and the root) still stand.
      rmSync(join(ws, ".beam", "owner"));
      // The receipted retry reads the layout as converged with zero effect…
      expect(
        await purgeOwnedWorkspaceContents(t, ws, OWNER.content, { acceptConverged: true }),
      ).toBe("purged");
      expect(readdirSync(ws)).toEqual([".beam"]);
      // …while the receipt-less attempt refuses it (no marker, no license).
      await expect(purgeOwnedWorkspaceContents(t, ws, OWNER.content)).rejects.toThrow(
        /not owned by this handoff/,
      );
      expect(await releaseOwnedWorkspace(t, ws, OWNER.content)).toBe("released");
      expect(existsSync(ws)).toBe(false);
    },
  );

  test(
    "Phase B refuses anything but the emptied layout — " +
      "foreign files and foreign owners survive byte-intact",
    async () => {
      const home = makeHome();
      const t = new LocalTransport(home);
      const root = join(home, "beam-root");
      const ws = await establishContainedWorkspace(t, root, { name: "app-forb000001" }, OWNER);
      // Extra content at the ROOT (Phase A never receipted this state).
      writeFileSync(join(ws, "foreign.txt"), "keep\n");
      await expect(releaseOwnedWorkspace(t, ws, OWNER.content)).rejects.toThrow(
        /not owned by this handoff/,
      );
      expect(readFileSync(join(ws, "foreign.txt"), "utf8")).toBe("keep\n");
      rmSync(join(ws, "foreign.txt"));
      // Extra content INSIDE the reserved dir refuses before the marker is
      // even considered.
      writeFileSync(join(ws, ".beam", "extra.txt"), "keep\n");
      await expect(releaseOwnedWorkspace(t, ws, OWNER.content)).rejects.toThrow(
        /not owned by this handoff/,
      );
      expect(readFileSync(join(ws, ".beam", "extra.txt"), "utf8")).toBe("keep\n");
      expect(readFileSync(join(ws, ".beam", "owner"), "utf8")).toBe(`${OWNER.content}\n`);
      rmSync(join(ws, ".beam", "extra.txt"));
      // A FOREIGN owner refuses: receipts license absence, never takeover.
      writeFileSync(
        join(ws, ".beam", "owner"),
        "beam-workspace-v1 other 00000000000000000000000000000000\n",
      );
      await expect(releaseOwnedWorkspace(t, ws, OWNER.content)).rejects.toThrow(
        /not owned by this handoff/,
      );
      expect(readFileSync(join(ws, ".beam", "owner"), "utf8")).toBe(
        "beam-workspace-v1 other 00000000000000000000000000000000\n",
      );
      // A `.beam` swapped for a symlink is never followed either.
      writeFileSync(join(ws, ".beam", "owner"), `${OWNER.content}\n`);
      const outside = makeOutside(home);
      writeFileSync(join(outside, "owner"), `${OWNER.content}\n`);
      rmSync(join(ws, ".beam"), { recursive: true });
      symlinkSync(outside, join(ws, ".beam"));
      await expect(releaseOwnedWorkspace(t, ws, OWNER.content)).rejects.toThrow(
        /not owned by this handoff/,
      );
      expect(readFileSync(join(outside, "owner"), "utf8")).toBe(`${OWNER.content}\n`);
      expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe("untouched\n");
    },
  );
});


/**
 * The nested-operation race: `establishContainedWorkspace` proved the
 * workspace, then the sandbox agent swaps it for a symlink BEFORE the next
 * nested create lands (`.beam-git-next` staging, `.git` landing). Every
 * nested operation must fail WITHOUT creating
 * or writing anything inside the symlink target — the old create path
 * `mkdir -p`ed the unverified absolute target first, mutating the outside
 * directory before any proof failed.
 */
describe(
  "nested create/write after a workspace swap fails without touching the symlink target",
  () => {
    async function swappedFixture() {
      const home = makeHome();
      const t = new LocalTransport(home);
      const root = join(home, "beam-root");
      const ws = await establishContainedWorkspace(t, root, { name: "app-swap0000002" }, OWNER);
      const outside = makeOutside(home);
      rmSync(ws, { recursive: true });
      symlinkSync(outside, ws);
      const src = join(home, "src");
      mkdirSync(src);
      writeFileSync(join(src, "leak.txt"), "leak\n");
      return { home, t, ws, outside, src };
    }

    test(
      "syncUp to a nested path under the swapped workspace refuses before creating the child",
      async () => {
        const { t, ws, outside, src } = await swappedFixture();
        // create=true used to `mkdir -p` the absolute target: `.beam-git-next`
        // appeared INSIDE the outside directory before the transfer refused.
        await expect(t.syncUp(src, join(ws, ".beam-git-next"), { delete: true })).rejects.toThrow(
          /symlinked path component/,
        );
        await expect(t.syncUp(src, join(ws, ".git"), { delete: true })).rejects.toThrow(
          /symlinked path component/,
        );
        expectOutsideIntact(outside);
      },
    );

    test(
      "syncDown of a nested path under the swapped workspace refuses before any local byte changes",
      async () => {
        const { home, t, ws, outside } = await swappedFixture();
        writeFileSync(join(outside, "sentinel.txt"), "untouched\n"); // still the only entry
        const collect = join(home, "collect");
        await expect(t.syncDown(join(ws, ".git"), collect)).rejects.toThrow(
          /symlinked path component/,
        );
        expect(existsSync(collect)).toBe(false);
        expectOutsideIntact(outside);
      },
    );

    test("a dangling leaf symlink never creates its target through a nested create", async () => {
      const home = makeHome();
      const t = new LocalTransport(home);
      const root = join(home, "beam-root");
      const ws = await establishContainedWorkspace(t, root, { name: "app-dangle00001" }, OWNER);
      const never = join(home, "never-created");
      symlinkSync(never, join(ws, ".beam-git-next"));
      const src = join(home, "src");
      mkdirSync(src);
      writeFileSync(join(src, "leak.txt"), "leak\n");

      await expect(t.syncUp(src, join(ws, ".beam-git-next"), { delete: true })).rejects.toThrow(
        /symlinked path component/,
      );
      expect(existsSync(never)).toBe(false); // the old mkdir -p resolved the link and created this
    });
  },
);

/**
 * Record-bound workspace ownership: a fresh establish claims ONLY an
 * absent/empty directory by planting `.beam/owner` create-only with the
 * record's token; an existing non-empty directory — foreign, legacy, or
 * another record's, `.beam` present or not — refuses with ZERO mutation,
 * and a resolved record's re-establish requires its exact marker bytes.
 */
describe("workspace ownership (local transport)", () => {
  test("fresh claim plants the exact owner marker; its own crashed claim re-verifies", async () => {
    const home = makeHome();
    const t = new LocalTransport(home);
    const root = join(home, "beam-root");
    const ws = await establishContainedWorkspace(t, root, { name: "app-own0000001" }, OWNER);
    expect(readFileSync(join(ws, ".beam", "owner"), "utf8")).toBe(`${OWNER.content}\n`);
    // Crashed-claim retry: same record, marker already present — converges.
    expect(await establishContainedWorkspace(t, root, { name: "app-own0000001" }, OWNER)).toBe(ws);
    // Crash between mkdir ws/.beam and the owner write: an empty `.beam`
    // is still claimable by the same record.
    const ws2 = join(root, "app-own0000002");
    mkdirSync(join(ws2, ".beam"), { recursive: true });
    expect(await establishContainedWorkspace(t, root, { name: "app-own0000002" }, OWNER)).toBe(ws2);
    expect(readFileSync(join(ws2, ".beam", "owner"), "utf8")).toBe(`${OWNER.content}\n`);
  });

  test(
    "a foreign deterministic dir — even with .beam and a precious file — refuses byte-intact",
    async () => {
      const home = makeHome();
      const t = new LocalTransport(home);
      const root = join(home, "beam-root");
      const foreign = join(root, "app-own0000003");
      mkdirSync(join(foreign, ".beam"), { recursive: true });
      writeFileSync(
        join(foreign, ".beam", "owner"),
        "beam-workspace-v1 other 00000000000000000000000000000000\n",
      );
      writeFileSync(join(foreign, "precious.txt"), "precious\n");

      await expect(
        establishContainedWorkspace(t, root, { name: "app-own0000003" }, OWNER),
      ).rejects.toThrow(/not owned by this handoff/);
      expect(readFileSync(join(foreign, "precious.txt"), "utf8")).toBe("precious\n");
      expect(readFileSync(join(foreign, ".beam", "owner"), "utf8")).toBe(
        "beam-workspace-v1 other 00000000000000000000000000000000\n",
      );
      expect(readdirSync(foreign).sort()).toEqual([".beam", "precious.txt"]);
    },
  );

  test(
    "non-empty dirs without any .beam, and case-variant .BEAM dirs, refuse untouched",
    async () => {
      const home = makeHome();
      const t = new LocalTransport(home);
      const root = join(home, "beam-root");
      const plain = join(root, "app-own0000004");
      mkdirSync(plain, { recursive: true });
      writeFileSync(join(plain, "data.txt"), "keep\n");
      await expect(
        establishContainedWorkspace(t, root, { name: "app-own0000004" }, OWNER),
      ).rejects.toThrow(/not owned by this handoff/);
      expect(readFileSync(join(plain, "data.txt"), "utf8")).toBe("keep\n");

      // A case-variant reserved dir: on a case-sensitive target it is a
      // foreign entry beside an absent `.beam`; on a case-insensitive host
      // it aliases `.beam` and carries a foreign token. Refuses either way
      // (the exact record-bound token is unforgeable).
      const cased = join(root, "app-own0000005");
      mkdirSync(join(cased, ".BEAM"), { recursive: true });
      writeFileSync(
        join(cased, ".BEAM", "owner"),
        "beam-workspace-v1 other 22222222222222222222222222222222\n",
      );
      await expect(
        establishContainedWorkspace(t, root, { name: "app-own0000005" }, OWNER),
      ).rejects.toThrow(/not owned by this handoff/);
      expect(readFileSync(join(cased, ".BEAM", "owner"), "utf8")).toBe(
        "beam-workspace-v1 other 22222222222222222222222222222222\n",
      );
    },
  );

  test(
    "a .beam swapped for a symlink refuses the purge — " +
      "the outside owner file survives byte-for-byte",
    async () => {
      const home = makeHome();
      const t = new LocalTransport(home);
      const root = join(home, "beam-root");
      const ws = await establishContainedWorkspace(t, root, { name: "app-own0000008" }, OWNER);
      writeFileSync(join(ws, "work.txt"), "contents\n");

      // The swap window: `.beam` replaced by a symlink whose target even
      // carries the EXACT owner bytes. The single-component pinned entry
      // (`lstat` + `cd -P` + physical-path equality) refuses instead of
      // deleting through the link.
      const outside = join(home, "outside-beam");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "owner"), `${OWNER.content}\n`);
      writeFileSync(join(outside, "victim.txt"), "outside data\n");
      rmSync(join(ws, ".beam"), { recursive: true });
      symlinkSync(outside, join(ws, ".beam"));

      await expect(purgeOwnedWorkspaceContents(t, ws, OWNER.content)).rejects.toThrow(
        /not owned by this handoff/,
      );
      expect(readFileSync(join(outside, "owner"), "utf8")).toBe(`${OWNER.content}\n`);
      expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("outside data\n");
      expect(readFileSync(join(ws, "work.txt"), "utf8")).toBe("contents\n"); // nothing deleted
    },
  );

  test(
    "a fresh claim over a lone symlinked .beam refuses — nothing is planted through the link",
    async () => {
      const home = makeHome();
      const t = new LocalTransport(home);
      const root = join(home, "beam-root");
      // The owner-plant seam: the workspace exists holding ONLY `.beam`,
      // but that entry is a symlink to an outside dir (empty, so a naive
      // emptiness check would happily claim it). The held single-component
      // descent lstats no-follow and refuses; the outside dir gains no
      // owner marker and loses nothing.
      const outside = makeOutside(home);
      const ws = join(root, "app-own0000009");
      mkdirSync(ws, { recursive: true });
      symlinkSync(outside, join(ws, ".beam"));
      await expect(
        establishContainedWorkspace(t, root, { name: "app-own0000009" }, OWNER),
      ).rejects.toThrow(/not owned by this handoff/);
      expectOutsideIntact(outside);
      expect(readdirSync(ws)).toEqual([".beam"]); // still just the untouched link
    },
  );

  test(
    "a permissive umask never leaks reserved metadata modes — " +
      "0700 dirs, 0600 owner, tightened on re-entry",
    async () => {
      const saved = process.umask(0o022);
      try {
        const home = makeHome();
        const t = new LocalTransport(home);
        const root = join(home, "beam-root");
        const ws = await establishContainedWorkspace(t, root, { name: "app-own0000010" }, OWNER);
        // Bootstrap: Beam-created reserved dir and marker are private
        // regardless of umask, verified in the establishing shell itself.
        expect(statSync(join(ws, ".beam")).mode & 0o777).toBe(0o700);
        expect(statSync(join(ws, ".beam", "owner")).mode & 0o777).toBe(0o600);

        // Owned nested creation (payload staging path): every Beam-created
        // reserved child is 0700 too.
        const src = join(home, "payload-src");
        mkdirSync(src);
        writeFileSync(join(src, "f.txt"), "x\n");
        const gen = "ab".repeat(8);
        await t.syncUp(src, join(ws, ".beam", "git", gen), {
          owned: { root: ws, ownerBytes: OWNER.content },
        });
        expect(statSync(join(ws, ".beam", "git")).mode & 0o777).toBe(0o700);
        expect(statSync(join(ws, ".beam", "git", gen)).mode & 0o777).toBe(0o700);

        // A loosened claim (chmod'd behind Beam's back) is demonstrably
        // Beam-owned — the next verify TIGHTENS it back before anything
        // secret lands.
        chmodSync(join(ws, ".beam"), 0o755);
        chmodSync(join(ws, ".beam", "owner"), 0o644);
        expect(await establishContainedWorkspace(t, root, { path: ws }, OWNER_VERIFY)).toBe(ws);
        expect(statSync(join(ws, ".beam")).mode & 0o777).toBe(0o700);
        expect(statSync(join(ws, ".beam", "owner")).mode & 0o777).toBe(0o600);
      } finally {
        process.umask(saved);
      }
    },
  );

  test(
    "a resolved record's re-establish requires the exact marker back and never writes",
    async () => {
      const home = makeHome();
      const t = new LocalTransport(home);
      const root = join(home, "beam-root");
      const ws = await establishContainedWorkspace(t, root, { name: "app-own0000006" }, OWNER);

      // Exact bytes verify.
      expect(await establishContainedWorkspace(t, root, { path: ws }, OWNER_VERIFY)).toBe(ws);

      // A replaced marker (foreign takeover) refuses every later operation.
      writeFileSync(
        join(ws, ".beam", "owner"),
        "beam-workspace-v1 attacker 11111111111111111111111111111111\n",
      );
      await expect(
        establishContainedWorkspace(t, root, { path: ws }, OWNER_VERIFY),
      ).rejects.toThrow(/not owned by this handoff/);
      // verify mode never rewrote the marker
      expect(readFileSync(join(ws, ".beam", "owner"), "utf8")).toBe(
        "beam-workspace-v1 attacker 11111111111111111111111111111111\n",
      );

      // A symlinked .beam or owner marker is never followed.
      const ws7 = await establishContainedWorkspace(t, root, { name: "app-own0000007" }, OWNER);
      rmSync(join(ws7, ".beam"), { recursive: true });
      const outside = makeOutside(home);
      symlinkSync(outside, join(ws7, ".beam"));
      await expect(
        establishContainedWorkspace(t, root, { path: ws7 }, OWNER_VERIFY),
      ).rejects.toThrow(/not owned by this handoff/);
      expectOutsideIntact(outside);
    },
  );
});
