import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTransport } from "../src/transport/local.ts";
import { assertPurgeablePath, ensureGitExclude, gatherExcludes, remoteWorkspaceName } from "../src/workspace.ts";

const HAVE_RSYNC = Bun.which("rsync") !== null;

describe("workspace helpers", () => {
  test("remoteWorkspaceName keeps the basename readable but never collides across paths", () => {
    const a = remoteWorkspaceName("/home/x/work/app");
    const b = remoteWorkspaceName("/home/x/other/app");
    expect(a).toStartWith("app-");
    expect(b).toStartWith("app-");
    expect(a).not.toBe(b);
  });

  test("gatherExcludes merges config excludes with .beamignore, skipping comments", () => {
    const dir = mkdtempSync(join(tmpdir(), "beam-ws-"));
    writeFileSync(join(dir, ".beamignore"), "# build output\ntarget/\n\nnode_modules/\n");
    const excludes = gatherExcludes(dir, { targets: {}, excludes: [".DS_Store"] });
    expect(excludes).toEqual([".DS_Store", "target/", "node_modules/"]);
  });

  test("ensureGitExclude appends .beam/ once and only inside git repos", () => {
    const plain = mkdtempSync(join(tmpdir(), "beam-ws-"));
    ensureGitExclude(plain); // no .git — must not create one
    expect(existsSync(join(plain, ".git"))).toBe(false);

    const repo = mkdtempSync(join(tmpdir(), "beam-ws-"));
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    ensureGitExclude(repo);
    ensureGitExclude(repo);
    const content = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(content.split("\n").filter((l) => l === ".beam/").length).toBe(1);
  });

  test("assertPurgeablePath refuses paths an rm -rf must never see", () => {
    for (const bad of ["/", "/etc", "short", "/a/../..", "no-slashes"]) {
      expect(() => assertPurgeablePath(bad)).toThrow(/refusing to purge/);
    }
    expect(() => assertPurgeablePath("/home/user/beam/app-1234abcd")).not.toThrow();
  });
});

describe.skipIf(!HAVE_RSYNC)("local transport sync semantics", () => {
  test("syncUp honors excludes and mirrors deletions; syncDown keeps local extras by default", async () => {
    const home = mkdtempSync(join(tmpdir(), "beam-tr-"));
    const t = new LocalTransport(home);
    const local = join(home, "src-dir");
    const remote = "~/dest-dir";
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "keep.txt"), "keep");
    writeFileSync(join(local, "secret.env"), "nope");

    await t.syncUp(local, remote, { excludes: ["secret.env"] });
    expect(existsSync(join(home, "dest-dir", "keep.txt"))).toBe(true);
    expect(existsSync(join(home, "dest-dir", "secret.env"))).toBe(false);

    // a file that disappears locally disappears remotely on the next mirrored ship
    writeFileSync(join(home, "dest-dir", "stale.txt"), "old");
    await t.syncUp(local, remote, { delete: true });
    expect(existsSync(join(home, "dest-dir", "stale.txt"))).toBe(false);

    // syncDown without delete must never remove local-only files
    writeFileSync(join(local, "local-only.txt"), "mine");
    writeFileSync(join(home, "dest-dir", "made-remotely.txt"), "theirs");
    await t.syncDown(remote, local, {});
    expect(readFileSync(join(local, "made-remotely.txt"), "utf8")).toBe("theirs");
    expect(existsSync(join(local, "local-only.txt"))).toBe(true);
  });

  test("~ paths resolve against the transport home, and exec sees that HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "beam-tr-"));
    const t = new LocalTransport(home);
    await t.sendFile(Bun.fileURLToPath(import.meta.url), "~/nested/dir/copy.ts");
    expect(existsSync(join(home, "nested", "dir", "copy.ts"))).toBe(true);
    expect(await t.exists("~/nested/dir/copy.ts")).toBe(true);
    expect(await t.execChecked("echo $HOME")).toBe(home);
  });
});
