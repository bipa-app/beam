/**
 * Goal: the ssh transport's safety contracts — a config-sourced host can
 * never become option-shaped argv; `exists()` disambiguates the failure
 * classes ssh multiplexes onto one exit channel (true only on exit 0,
 * false only on exit 1, throw on ssh's own failures, so a transient blip
 * can never be read as "absent" and erase the only copy of remote
 * artifacts); rsync argv pins the proved remote directory and refuses a
 * swapped workspace without touching the target; and session collection
 * aborts cleanly on a mid-sync transport outage.
 *
 * Method: stub `ssh`/`scp`/`rsync` scripts on a temp PATH log argv and
 * drive the remote side with bash, while the collection tests run REAL
 * rsync through `collectSessionReturn` against mkdtemp fixture homes;
 * every test states an explicit 30s real-process timeout and rsync-
 * dependent cases use `test.skipIf`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
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
import { dirname, join } from "node:path";
import { OmpAdapter } from "../src/session/pi-family.ts";
import { collectSessionReturn } from "../src/session/collect-txn.ts";
import type { BeamEnv } from "../src/env.ts";
import { addRecord, loadState, type BeamRecord } from "../src/state.ts";
import { shq } from "../src/util/shell.ts";
import { SshTransport } from "../src/transport/ssh.ts";

const HAVE_RSYNC = Bun.which("rsync") !== null;

// Explicit real-process budget for every test in this file: each one spawns
// external processes — scripted ssh/scp/rsync shells, bash remote-side
// programs, or real rsync in the collection tests. 30s matches the repo's
// established local-transfer class (e2e.test.ts); nothing here is heavier.
const PROCESS_TIMEOUT_MS = 30_000;

/**
 * The host is config-sourced and becomes a positional argument to
 * ssh/rsync/scp. Constructing the transport is the LAST moment before a
 * hostile value could become argv, so the boundary pair lives here: a real
 * destination behaves exactly as before, an option-shaped one never
 * reaches a process at all.
 */
describe("ssh host construction boundary", () => {
  test("a valid destination constructs with the unchanged argv shape", () => {
    const t = new SshTransport("user@sandbox.example");
    expect(t.label).toBe("ssh user@sandbox.example");
    expect(t.interactiveArgv("true")).toEqual([
      "ssh", "-t", "user@sandbox.example", "--", "bash", "-lc", shq("true"),
    ]);
  });

  test("an empty host is refused with a beam-branded remedy", () => {
    expect(() => new SshTransport("")).toThrow(/beam: ssh host is empty/);
  });

  test("a '-'-prefixed host is refused as option injection before any argv exists", () => {
    expect(() => new SshTransport("-oProxyCommand=touch owned")).toThrow(
      /beam: ssh host .* would be read as an ssh option/,
    );
  });
});

/**
 * ssh multiplexes two failure classes onto one exit code channel: the remote
 * command's own status, and 255 for ssh's OWN failure (DNS, auth, a dropped
 * connection). `exists()` answers authorize skipping collection steps and,
 * further up `beam down`, the remote purge — so an outage that surfaced as
 * "false" would let a transient network blip erase the only copy of remote
 * artifacts. These tests script the `ssh` binary itself to pin the
 * classification: true ONLY on exit 0, false ONLY on exit 1, throw on
 * anything else.
 */

function writeScript(path: string, lines: string[]): void {
  writeFileSync(path, lines.join("\n") + "\n");
  chmodSync(path, 0o755);
}

describe("ssh exists classification (scripted ssh on PATH)", () => {
  let ctrl: string;
  let savedPath: string | undefined;

  beforeAll(() => {
    savedPath = process.env.PATH;
    const binDir = mkdtempSync(join(tmpdir(), "beam-sshc-bin-"));
    ctrl = mkdtempSync(join(tmpdir(), "beam-sshc-ctrl-"));
    // A canned ssh: exit status and streams come from control files, so each
    // test pins exactly what the transport saw on the wire.
    writeScript(join(binDir, "ssh"), [
      "#!/bin/sh",
      `code=$(cat "${ctrl}/code")`,
      `[ -f "${ctrl}/stdout" ] && cat "${ctrl}/stdout"`,
      `[ -f "${ctrl}/stderr" ] && cat "${ctrl}/stderr" >&2`,
      'exit "$code"',
    ]);
    process.env.PATH = `${binDir}:${process.env.PATH}`;
  });

  afterAll(() => {
    process.env.PATH = savedPath;
  });

  test("exit 0 is the only true", async () => {
    writeFileSync(join(ctrl, "code"), "0");
    const t = new SshTransport("sandbox");
    expect(await t.exists("/ws/file")).toBe(true);
  }, PROCESS_TIMEOUT_MS);

  test("exit 1 is the only false — even with login-shell noise on stderr", async () => {
    writeFileSync(join(ctrl, "code"), "1");
    writeFileSync(join(ctrl, "stderr"), "motd: welcome back\n");
    const t = new SshTransport("sandbox");
    expect(await t.exists("/ws/absent")).toBe(false);
  }, PROCESS_TIMEOUT_MS);

  test(
    "exit 255 (ssh's own failure) throws with the probe and stderr context — never an absent file",
    async () => {
      writeFileSync(join(ctrl, "code"), "255");
      writeFileSync(
        join(ctrl, "stderr"),
        "ssh: connect to host sandbox port 22: Connection timed out\n",
      );
      const t = new SshTransport("sandbox");
      let err: Error | undefined;
      try {
        await t.exists("/ws/artifacts");
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/existence probe did not answer \(255\)/);
      expect(err!.message).toContain("test -e '/ws/artifacts'");
      expect(err!.message).toContain("Connection timed out");
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "exit 2 (test usage error / shell failure) throws too — any non-1 nonzero is not a remote no",
    async () => {
      writeFileSync(join(ctrl, "code"), "2");
      writeFileSync(join(ctrl, "stderr"), "bash: line 1: test: unexpected operator\n");
      const t = new SshTransport("sandbox");
      let err: Error | undefined;
      try {
        await t.exists("/ws/file");
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/existence probe did not answer \(2\)/);
      expect(err!.message).toContain("unexpected operator");
    },
    PROCESS_TIMEOUT_MS,
  );
});

/**
 * pi-family collection uses one guarded rsync of the whole reserved `.beam`
 * tree. A transport outage must abort before the local session store changes;
 * cmdDown can purge only after collect resolves.
 */
describe("pi collection aborts on a scripted transport outage during the guarded sync", () => {
  let savedPath: string | undefined;
  let remoteCwd: string;
  let outageFile: string;
  let sessionFile: string;
  let localCwd: string;

  const adapter = new OmpAdapter();
  const grownBody = '{"type":"message","text":"grown on the remote"}';

  function fixture(tag: string): void {
    const binDir = mkdtempSync(join(tmpdir(), `beam-ssh-${tag}-bin-`));
    const ctrl = mkdtempSync(join(tmpdir(), `beam-ssh-${tag}-ctrl-`));
    outageFile = join(ctrl, "outage");

    // The "remote" workspace is a plain local dir; the scripted ssh executes
    // commands against it exactly like sshd would (re-parse and run), EXCEPT
    // the artifact-dir probe, which fails with the code in the outage file.
    remoteCwd = realpathSync(mkdtempSync(join(tmpdir(), `beam-ssh-${tag}-remote-`)));
    mkdirSync(join(remoteCwd, ".beam", "session"), { recursive: true });
    writeFileSync(
      join(remoteCwd, ".beam", "session.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "sess_1", cwd: remoteCwd })}\n` +
        `${grownBody}\n`,
    );
    writeFileSync(join(remoteCwd, ".beam", "session", "artifact.txt"), "artifact-payload\n");

    const storeDir = mkdtempSync(join(tmpdir(), `beam-ssh-${tag}-store-`));
    sessionFile = join(storeDir, "sess_1.jsonl");
    writeFileSync(sessionFile, '{"type":"session","version":3,"cwd":"/old"}\nstale\n');
    localCwd = mkdtempSync(join(tmpdir(), `beam-ssh-${tag}-local-`));

    writeScript(join(binDir, "ssh"), [
      "#!/bin/sh",
      "# scripted ssh: fail rsync's remote --server process on demand;",
      "# otherwise drop the destination and re-parse like sshd.",
      "shift",
      '[ "$1" = "--" ] && shift',
      'case "$*" in',
      '  *"--server"*)',
      `    if [ -f "${outageFile}" ]; then`,
      `      code=$(cat "${outageFile}")`,
      '      if [ "$code" = 255 ]; then',
      '        echo "ssh: connect to host sandbox port 22: Connection timed out" >&2',
      "      else",
      '        echo "remote shell failed before rsync started" >&2',
      "      fi",
      '      exit "$code"',
      "    fi",
      "    ;;",
      "esac",
      'exec sh -c "$*"',
    ]);
    writeScript(join(binDir, "scp"), [
      "#!/bin/sh",
      "# scripted scp: strip flags and host: prefixes, copy locally.",
      "set -e",
      'src=""; dst=""',
      'for a in "$@"; do',
      '  case "$a" in',
      "    -*) ;;",
      '    *) if [ -z "$src" ]; then src="${a#*:}"; else dst="${a#*:}"; fi ;;',
      "  esac",
      "done",
      'exec cp "$src" "$dst"',
    ]);
    process.env.PATH = `${binDir}:${process.env.PATH}`;
  }

  beforeAll(() => {
    savedPath = process.env.PATH;
  });

  afterAll(() => {
    process.env.PATH = savedPath;
  });

  /** The collect transaction the engine runs for this fixture's handoff. */
  function makeTxn(): { env: BeamEnv; record: BeamRecord } {
    const env: BeamEnv = {
      home: dirname(sessionFile),
      beamDir: mkdtempSync(join(tmpdir(), "beam-ssh-state-")),
    };
    const record: BeamRecord = {
      id: "r1",
      target: "t",
      tool: "omp",
      sessionId: "sess_1",
      sessionFile,
      localCwd,
      remoteCwd,
      tmux: "-",
      status: "up",
      createdAt: "t",
      updatedAt: "t",
    };
    addRecord(env, record);
    return { env, record };
  }

  test(
    "a transient 255 aborts collection before local or remote session state changes",
    async () => {
      fixture("t255");
      writeFileSync(outageFile, "255");

      const { env, record } = makeTxn();
      let err: Error | undefined;
      try {
        await collectSessionReturn(env, record, adapter, new SshTransport("sandbox"));
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/command failed .*rsync/);

      // Collection stages the whole reserved tree first. A failed transfer
      // cannot partly replace or back up the local transcript.
      expect(readFileSync(sessionFile, "utf8")).toBe(
        '{"type":"session","version":3,"cwd":"/old"}\nstale\n',
      );
      const backups = Array.from(new Bun.Glob("sess_1.jsonl.bak-*").scanSync(dirname(sessionFile)));
      expect(backups).toHaveLength(0);
      // No dead transaction either: a failed stage journals no receipt.
      expect(loadState(env).records[0]!.collect).toBeUndefined();

      // The only remote copy remains fully recoverable for a retry.
      expect(existsSync(join(remoteCwd, ".beam", "session.jsonl"))).toBe(true);
      expect(readFileSync(join(remoteCwd, ".beam", "session", "artifact.txt"), "utf8")).toBe(
        "artifact-payload\n",
      );
    },
    PROCESS_TIMEOUT_MS,
  );

  test("a remote shell failure aborts the same guarded transfer", async () => {
    fixture("t2");
    writeFileSync(outageFile, "2");

    const { env, record } = makeTxn();
    let err: Error | undefined;
    try {
      await collectSessionReturn(env, record, adapter, new SshTransport("sandbox"));
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/command failed .*rsync/);
    expect(readFileSync(sessionFile, "utf8")).toContain('"cwd":"/old"');
    expect(readFileSync(join(remoteCwd, ".beam", "session", "artifact.txt"), "utf8")).toBe(
      "artifact-payload\n",
    );
  }, PROCESS_TIMEOUT_MS);

  test.skipIf(!HAVE_RSYNC)(
    "control: the healthy guarded sync stages transcript and artifacts into the durable return",
    async () => {
      fixture("ok");
      const { env, record } = makeTxn();
      const before = readFileSync(sessionFile, "utf8");
      const out = await collectSessionReturn(env, record, adapter, new SshTransport("sandbox"));
      expect(out.hint).toBe(`omp --resume ${shq(join(out.returnDir, "session.jsonl"))}`);
      expect(readFileSync(join(out.returnDir, "session.jsonl"), "utf8")).toContain(
        "grown on the remote",
      );
      expect(readFileSync(join(out.returnDir, "artifacts", "artifact.txt"), "utf8")).toBe(
        "artifact-payload\n",
      );
      // The harness store was never touched.
      expect(readFileSync(sessionFile, "utf8")).toBe(before);
    },

    PROCESS_TIMEOUT_MS,
  );
});

describe("ssh rsync pins the proved remote directory in the transfer process", () => {
  let savedPath: string | undefined;
  let binDir: string;
  let argvLog: string;
  let sshLog: string;

  beforeAll(() => {
    savedPath = process.env.PATH;
    binDir = mkdtempSync(join(tmpdir(), "beam-ssh-rsync-bin-"));
    argvLog = join(binDir, "rsync-argv");
    sshLog = join(binDir, "ssh-called");
    writeScript(join(binDir, "rsync"), [
      "#!/bin/sh",
      `: > "${argvLog}"`,
      `for a in "$@"; do printf '%s\\n' "$a" >> "${argvLog}"; done`,
    ]);
    // syncUp/syncDown must not run a separate guard connection before
    // rsync. The proof belongs in rsync's own remote command.
    writeScript(join(binDir, "ssh"), [
      "#!/bin/sh",
      `touch "${sshLog}"`,
      "exit 99",
    ]);
    process.env.PATH = `${binDir}:${process.env.PATH}`;
  });

  afterAll(() => {
    process.env.PATH = savedPath;
  });

  function capturedArgv(): string[] {
    return readFileSync(argvLog, "utf8").trim().split("\n");
  }

  function expectPinned(program: string, remoteDir: string): void {
    const match =
      /^--rsync-path=exec 3<&0; printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| bash -s --$/.exec(
        program,
      );
    expect(match).not.toBeNull();
    const script = Buffer.from(match![1]!, "base64").toString("utf8");
    expect(script).toContain(remoteDir);
    // Segment-by-segment no-follow walk: relative descent from a pinned
    // cwd, physical identity re-proven after every hop, and NEVER an
    // absolute `mkdir -p` before the proof (the old P1 window).
    expect(script).toContain("for __beam_seg in");
    expect(script).toContain('cd -- "./$__beam_seg"');
    expect(script).toContain('pwd -P');
    expect(script).not.toContain("mkdir -p");
    expect(script).toContain('exec rsync "$@" <&3');
  }

  test("syncUp guards, enters, and pins the destination in rsync's SSH operation", async () => {
    const local = mkdtempSync(join(tmpdir(), "beam-ssh-rsync-up-"));
    const remote = "/srv/beam/workspace";
    await new SshTransport("sandbox").syncUp(local, remote);

    const argv = capturedArgv();
    expect(argv.at(-1)).toBe("sandbox:./");
    expectPinned(argv.find((a) => a.startsWith("--rsync-path="))!, remote);
    expect(existsSync(sshLog)).toBe(false);
  }, PROCESS_TIMEOUT_MS);

  test(
    "syncDown pins the source and never opens the recorded path from a second connection",
    async () => {
      const local = join(mkdtempSync(join(tmpdir(), "beam-ssh-rsync-down-")), "copy");
      const remote = "/srv/beam/workspace";
      await new SshTransport("sandbox").syncDown(remote, local);

      const argv = capturedArgv();
      expect(argv.at(-2)).toBe("sandbox:./");
      expectPinned(argv.find((a) => a.startsWith("--rsync-path="))!, remote);
      expect(existsSync(sshLog)).toBe(false);
    },
    PROCESS_TIMEOUT_MS,
  );
});


/**
 * Execute the exact remote side of the pinned transfer — the --rsync-path
 * program with rsync's server args appended, run through a non-login shell
 * like sshd does — against a real filesystem. The adversarial cases
 * interpose a workspace symlink swap AFTER the up-flow precheck would have
 * passed (the swap already sits at the path when the transfer starts) and
 * prove the walk fails WITHOUT creating or writing anything through the
 * link: the old absolute `mkdir -p` mutated the symlink target before any
 * proof ran.
 */
describe(
  "ssh pinned walk refuses a swapped workspace without touching the target (executed remote side)",
  () => {
    let binDir: string;
    let rsyncLog: string;

    beforeAll(() => {
      binDir = mkdtempSync(join(tmpdir(), "beam-ssh-walk-bin-"));
      rsyncLog = join(binDir, "rsync-cwd");
      writeScript(join(binDir, "rsync"), ["#!/bin/sh", `pwd -P > "${rsyncLog}"`]);
    });

    function rsyncPathProgram(remoteDir: string, create: boolean): string {
      const t = new SshTransport("unused") as unknown as {
        pinnedRsyncPath(remoteDir: string, create: boolean): string;
      };
      return t.pinnedRsyncPath(remoteDir, create);
    }

    /** Run the program string exactly as sshd would: one shell line, non-login. */
    async function remoteSide(program: string): Promise<{ code: number; stderr: string }> {
      const proc = Bun.spawn(["bash", "-c", `${program} --server .`], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        stdin: Buffer.from(""),
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      return { code, stderr: await new Response(proc.stderr as ReadableStream).text() };
    }

    test(
      "a workspace swapped for an outside symlink fails before any mutation — " +
        "mkdir never crosses the link",
      async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-ssh-walk-")));
        const outside = join(base, "outside");
        mkdirSync(outside);
        writeFileSync(join(outside, "sentinel.txt"), "untouched\n");
        const ws = join(base, "root", "ws");
        mkdirSync(join(base, "root"), { recursive: true });
        symlinkSync(outside, ws);

        const { code, stderr } = await remoteSide(
          rsyncPathProgram(join(ws, ".beam-git-next"), true),
        );
        expect(code).toBe(61);
        expect(stderr).toContain("refusing to sync through symlinked path");
        // The P1 regression: the old walk `mkdir -p`ed the unverified absolute
        // target first, creating `.beam-git-next` INSIDE the outside directory
        // before any check failed.
        expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
        expect(existsSync(rsyncLog)).toBe(false); // rsync never ran
      },
      PROCESS_TIMEOUT_MS,
    );

    test("a dangling symlink at the leaf never creates its target", async () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-ssh-walk-")));
      const ws = join(base, "root", "ws");
      mkdirSync(ws, { recursive: true });
      const never = join(base, "never-created");
      symlinkSync(never, join(ws, ".git"));

      const { code } = await remoteSide(rsyncPathProgram(join(ws, ".git"), true));
      expect(code).toBe(61);
      expect(existsSync(never)).toBe(false); // old mkdir -p resolved the link and created this
      expect(existsSync(rsyncLog)).toBe(false);
    }, PROCESS_TIMEOUT_MS);

    test(
      "the healthy walk creates nested components and execs rsync pinned inside " +
        "the exact directory",
      async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "beam-ssh-walk-")));
        const ws = join(base, "root", "ws");
        mkdirSync(ws, { recursive: true });
        const nested = join(ws, ".beam", "session");

        const { code } = await remoteSide(rsyncPathProgram(nested, true));
        expect(code).toBe(0);
        expect(readFileSync(rsyncLog, "utf8").trim()).toBe(nested);
        rmSync(rsyncLog);
      },
      PROCESS_TIMEOUT_MS,
    );
  },
);
