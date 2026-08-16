/**
 * Goal: the local transport is a behaviorally equivalent hermetic double
 * of the remote transports — the configured home is the user's contract
 * with beam (an existing directory, however hostile its path, behaves
 * exactly as before; a missing one fails at construction with a
 * beam-branded remedy, never a raw ENOENT from deep inside realpath), and
 * every exec resolves `~` and $HOME against that home, never the caller's.
 *
 * Method: construct real LocalTransports against mkdtemp fixture homes —
 * including one whose path carries spaces and shell metacharacters — and
 * exec through real bash, asserting $HOME expansion and path handling
 * without touching the caller's real HOME.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTransport } from "../src/transport/local.ts";
import { run, shjoin } from "../src/util/shell.ts";

const CALLER_HOME = process.env.HOME!;

/** A home path with spaces and shell metacharacters, created on disk. */
function fixtureMetacharHome(): string {
  const home = join(mkdtempSync(join(tmpdir(), "beam-lh-")), "ha rd 'quo$te` );&|");
  mkdirSync(home, { recursive: true });
  return home;
}

/**
 * The home is config-sourced, so its existence is the user's contract with
 * beam, not an internal invariant: an existing directory must behave exactly
 * as before, a missing one must fail at construction with the path and the
 * remedy — never a raw filesystem error from deep inside realpath.
 */
describe("local transport home boundary", () => {
  test("an existing home constructs a working transport", async () => {
    const home = mkdtempSync(join(tmpdir(), "beam-lh-"));
    const t = new LocalTransport(home);
    expect(t.label).toBe(`local (home=${home})`);
    expect(await t.execChecked('printf %s "$HOME"')).toBe(home);
  });

  test("a missing home fails with a beam-branded remedy, not a raw ENOENT", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "beam-lh-")), "no-such-home");
    let thrown: unknown;
    try {
      new LocalTransport(missing);
    } catch (err) {
      thrown = err;
    }
    if (!(thrown instanceof Error)) throw new Error("expected the constructor to throw an Error");
    expect(thrown.message).toContain(`beam: local transport home does not resolve: ${missing}`);
    expect(thrown.message).toContain("create that directory");
    // The filesystem fault stays attached for diagnosis.
    const cause = thrown.cause;
    if (!(cause instanceof Error) || !("code" in cause)) {
      throw new Error("expected the original filesystem error as cause");
    }
    expect(cause.code).toBe("ENOENT");
  });
});

describe("local transport HOME isolation", () => {
  test("interactiveArgv pins the isolated HOME and preserves the target command verbatim", () => {
    const home = fixtureMetacharHome();
    const t = new LocalTransport(home);
    const command = "codex login --with-flag 'a b' \"$HOME/literal\"";
    // argv-safe env assignment: no quoting layer, metacharacters in the home
    // path survive byte-exact, and the command stays ONE untouched `bash -lc`
    // argument — same tty semantics as a bare bash spawn.
    expect(t.interactiveArgv(command)).toEqual(["env", `HOME=${home}`, "bash", "-lc", command]);
  });

  test("interactive argv executes with the isolated HOME, exactly like exec", async () => {
    for (const home of [mkdtempSync(join(tmpdir(), "beam-lh-")), fixtureMetacharHome()]) {
      expect(home).not.toBe(CALLER_HOME);
      const t = new LocalTransport(home);
      const viaExec = await t.execChecked('printf %s "$HOME"');
      // `beam login`/`beam attach` run this argv with interactive stdio; the
      // argv itself is identical either way, so a piped run proves the same
      // HOME contract while letting the test capture output.
      const viaInteractive = await run(t.interactiveArgv('printf %s "$HOME"'));
      expect(viaInteractive.code).toBe(0);
      expect(viaInteractive.stdout).toBe(home);
      expect(viaExec).toBe(home);
    }
  });

  test("beam login shape: a harness login writes and reads only the target home," +
    " never the caller's", async () => {
    const home = mkdtempSync(join(tmpdir(), "beam-lh-"));
    const t = new LocalTransport(home);
    // Unique per run so the caller-HOME assertion can never pass on a leftover.
    const storeDir = `.fakeharness-${crypto.randomUUID()}`;
    // A stub harness whose `login` behaves like codex/pi: auth lands under
    // $HOME and it reads its config from $HOME. Referenced by absolute path,
    // as cmdLogin resolves the harness binary via the target's PATH.
    const stub = join(home, "fakeharness");
    writeFileSync(
      stub,
      [
        "#!/bin/bash",
        "set -euo pipefail",
        '[ "$1" = "login" ]',
        `mkdir -p "$HOME/${storeDir}"`,
        `echo token > "$HOME/${storeDir}/auth.json"`,
        'cat "$HOME/login-config.txt"',
        "",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);
    writeFileSync(join(home, "login-config.txt"), "target-config");

    // The exact cmdLogin call shape: shjoin(loginArgv) through interactiveArgv.
    const loginArgv = [stub, "login"];
    const res = await run(t.interactiveArgv(shjoin(loginArgv)));
    expect(res.code).toBe(0);

    // Read side: the login saw only the target home's config.
    expect(res.stdout.trim()).toBe("target-config");
    // Write side: auth landed under the target home...
    expect(readFileSync(join(home, storeDir, "auth.json"), "utf8")).toBe("token\n");
    // ...and the caller's real HOME was never touched.
    expect(existsSync(join(CALLER_HOME, storeDir))).toBe(false);

    // The post-login auth probe cmdLogin runs sees the credential too.
    const probe = await t.exec(`test -s "$HOME/${storeDir}/auth.json"`);
    expect(probe.code).toBe(0);
  });

  test("interactive login into a metacharacter home lands auth in that home", async () => {
    const home = fixtureMetacharHome();
    const t = new LocalTransport(home);
    const storeDir = `.fakeharness-${crypto.randomUUID()}`;
    const script = `mkdir -p "$HOME/${storeDir}" && echo token > "$HOME/${storeDir}/auth.json"`;
    const res = await run(t.interactiveArgv(script));
    expect(res.code).toBe(0);
    expect(readFileSync(join(home, storeDir, "auth.json"), "utf8")).toBe("token\n");
    expect(existsSync(join(CALLER_HOME, storeDir))).toBe(false);
  });
});
