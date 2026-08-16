import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { OmpAdapter } from "../src/session/pi-family.ts";
import { SshTransport } from "../src/transport/ssh.ts";

const HAVE_RSYNC = Bun.which("rsync") !== null;

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
  });

  test("exit 1 is the only false — even with login-shell noise on stderr", async () => {
    writeFileSync(join(ctrl, "code"), "1");
    writeFileSync(join(ctrl, "stderr"), "motd: welcome back\n");
    const t = new SshTransport("sandbox");
    expect(await t.exists("/ws/absent")).toBe(false);
  });

  test("exit 255 (ssh's own failure) throws with the probe and stderr context — never an absent file", async () => {
    writeFileSync(join(ctrl, "code"), "255");
    writeFileSync(join(ctrl, "stderr"), "ssh: connect to host sandbox port 22: Connection timed out\n");
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
  });

  test("exit 2 (test usage error / shell failure) throws too — any non-1 nonzero is not a remote no", async () => {
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
  });
});

/**
 * The load-bearing consumer: pi-family collect() probes an OPTIONAL remote
 * artifacts dir right after the transcript fetch. Under the old
 * `code === 0` reading, a transient ssh outage (255) at that probe read as
 * "no artifacts", collect() returned success, and `beam down` proceeded to
 * purge the workspace — destroying the only copy. The probe must abort the
 * collection instead: cmdDown journals `purging` and runs purgeRemote
 * strictly AFTER adapter.collect() resolves (src/commands/down.ts), so a
 * throw here aborts the whole down with the remote untouched and retryable.
 */
describe("pi collection aborts on a scripted transient-255 at the artifact probe", () => {
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
    remoteCwd = mkdtempSync(join(tmpdir(), `beam-ssh-${tag}-remote-`));
    mkdirSync(join(remoteCwd, ".beam", "session"), { recursive: true });
    writeFileSync(
      join(remoteCwd, ".beam", "session.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, cwd: remoteCwd })}\n${grownBody}\n`,
    );
    writeFileSync(join(remoteCwd, ".beam", "session", "artifact.txt"), "artifact-payload\n");

    const storeDir = mkdtempSync(join(tmpdir(), `beam-ssh-${tag}-store-`));
    sessionFile = join(storeDir, "sess_1.jsonl");
    writeFileSync(sessionFile, '{"type":"session","version":3,"cwd":"/old"}\nstale\n');
    localCwd = mkdtempSync(join(tmpdir(), `beam-ssh-${tag}-local-`));

    const artifactsPath = `${remoteCwd}/.beam/session`;
    writeScript(join(binDir, "ssh"), [
      "#!/bin/sh",
      "# scripted ssh: drop the destination, then re-parse the remaining args",
      "# through a shell — exactly what sshd does with its command string.",
      "shift",
      '[ "$1" = "--" ] && shift',
      // The artifact probe quotes its path, so the shq'd wire string carries
      // `<path>'` — the transcript path continues with `.jsonl` and cannot
      // match. Only `test -e` on the artifacts dir hits the outage.
      'case "$*" in',
      `  *"${artifactsPath}'"*)`,
      `    if [ -f "${outageFile}" ]; then`,
      `      code=$(cat "${outageFile}")`,
      '      if [ "$code" = 255 ]; then',
      '        echo "ssh: connect to host sandbox port 22: Connection timed out" >&2',
      "      else",
      '        echo "bash: line 1: test: unexpected operator" >&2',
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

  function localSession() {
    return { tool: "omp" as const, id: "sess_1", file: sessionFile, artifactsDir: undefined, mtime: 0 };
  }

  test("transient 255 after the transcript fetch aborts collect; remote artifacts and workspace stay recoverable", async () => {
    fixture("t255");
    writeFileSync(outageFile, "255");

    let err: Error | undefined;
    try {
      await adapter.collect(new SshTransport("sandbox"), localSession(), localCwd, remoteCwd);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    // The outage surfaces as an outage — never as "no artifacts" (silent
    // success) and never as the absence error reserved for a missing
    // transcript.
    expect(err!.message).toMatch(/existence probe did not answer \(255\)/);
    expect(err!.message).toContain("Connection timed out");
    expect(err!.message).not.toContain("not found");

    // The failure fired at the POST-FETCH artifact probe: the transcript
    // already landed in the local store (header cwd restored) with the stale
    // copy backed up beside it — nothing was lost locally either.
    expect(readFileSync(sessionFile, "utf8")).toBe(
      `${JSON.stringify({ type: "session", version: 3, cwd: localCwd })}\n${grownBody}\n`,
    );
    const backups = Array.from(new Bun.Glob("sess_1.jsonl.bak-*").scanSync(dirname(sessionFile)));
    expect(backups.length).toBe(1);

    // The remote workspace is untouched and fully recoverable: transcript,
    // artifacts, payload all still there for the retried down. cmdDown only
    // journals `purging` and purges after collect() resolves, so this throw
    // aborts the down before any destructive remote step.
    expect(existsSync(join(remoteCwd, ".beam", "session.jsonl"))).toBe(true);
    expect(readFileSync(join(remoteCwd, ".beam", "session", "artifact.txt"), "utf8")).toBe("artifact-payload\n");
  });

  test("exit 2 at the artifact probe is classified as an outage too, not an absent dir", async () => {
    fixture("t2");
    writeFileSync(outageFile, "2");

    let err: Error | undefined;
    try {
      await adapter.collect(new SshTransport("sandbox"), localSession(), localCwd, remoteCwd);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/existence probe did not answer \(2\)/);
    // Remote artifacts survive for the retry.
    expect(readFileSync(join(remoteCwd, ".beam", "session", "artifact.txt"), "utf8")).toBe("artifact-payload\n");
  });

  test.skipIf(!HAVE_RSYNC)(
    "control: the same rig with a healthy transport collects the artifacts (probe answered 0 -> true)",
    async () => {
      fixture("ok");
      // No outage file: the probe reaches the real `test -e`, answers 0, and
      // the artifact sync (rsync over the same scripted ssh) runs.
      const hint = await adapter.collect(new SshTransport("sandbox"), localSession(), localCwd, remoteCwd);
      expect(hint).toContain(sessionFile);
      const localArtifacts = join(dirname(sessionFile), basename(sessionFile, ".jsonl"));
      expect(readFileSync(join(localArtifacts, "artifact.txt"), "utf8")).toBe("artifact-payload\n");
    },
  );
});
