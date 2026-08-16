/**
 * Goal: the shell seam's safety contracts — `shq`/`shjoin`/`shqRemotePath`
 * survive hostile content through a real bash, `run` enforces its per-stream
 * output cap loudly (no deadlock, no unbounded buffering), and TmuxRuntime
 * maps has-session/kill-session exits to alive/absent, failing closed on
 * anything it cannot classify.
 *
 * Method: quoting round-trips execute through real `bash -c`; cap behavior
 * uses exact-size and overflowing writers; tmux verdicts run against a
 * scripted Transport double returning canned exit codes and stderr.
 */
import { describe, expect, test } from "bun:test";
import { TmuxRuntime } from "../src/runtime/tmux.ts";
import type { Transport } from "../src/transport/types.ts";
import { run, shjoin, shq, shqRemotePath } from "../src/util/shell.ts";

describe("shell quoting", () => {
  test("shq survives hostile content through bash", async () => {
    const hostile = `a b'c"d$e\`f\\g;h&i|j\n$(reboot)`;
    const res = await run(["bash", "-c", `printf %s ${shq(hostile)}`]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(hostile);
  });

  test("shjoin preserves argv boundaries", async () => {
    const argv = ["printf", "%s|%s", "one two", "three'four"];
    const res = await run(["bash", "-c", shjoin(argv)]);
    expect(res.stdout).toBe("one two|three'four");
  });

  test("shqRemotePath expands ~ against HOME", async () => {
    const res = await run(["bash", "-c", `printf %s ${shqRemotePath("~/x y/$weird\`.txt")}`], {
      env: { HOME: "/fake/home" },
    });
    expect(res.stdout).toBe("/fake/home/x y/$weird`.txt");
  });

  test("shqRemotePath quotes absolute paths verbatim", async () => {
    const res = await run(["bash", "-c", `printf %s ${shqRemotePath("/a b/c'd")}`]);
    expect(res.stdout).toBe("/a b/c'd");
  });
});

describe("run output bounds", () => {
  const CAP = 8192;

  test("captures exactly cap-1 and cap bytes without failing", async () => {
    for (const bytes of [CAP - 1, CAP]) {
      const res = await run(["head", "-c", String(bytes), "/dev/zero"], { maxOutputBytes: CAP });
      expect(res.code).toBe(0);
      expect(res.stdout.length).toBe(bytes);
      expect(res.stderr).toBe("");
    }
  });

  test("cap+1 stdout bytes fail loudly with command, stream, and cap", async () => {
    await expect(
      run(["head", "-c", String(CAP + 1), "/dev/zero"], { maxOutputBytes: CAP }),
    ).rejects.toThrow(`exceeded the ${CAP}-byte per-stream cap on stdout: head`);
  });

  test("cap+1 stderr bytes fail loudly naming stderr", async () => {
    const script = `head -c ${CAP + 1} /dev/zero >&2`;
    await expect(run(["bash", "-c", script], { maxOutputBytes: CAP })).rejects.toThrow(
      `exceeded the ${CAP}-byte per-stream cap on stderr: bash`,
    );
  });

  test("stdout and stderr each get the full cap — the bound is per stream", async () => {
    const script = `head -c ${CAP} /dev/zero; head -c ${CAP} /dev/zero >&2`;
    const res = await run(["bash", "-c", script], { maxOutputBytes: CAP });
    expect(res.code).toBe(0);
    expect(res.stdout.length).toBe(CAP);
    expect(res.stderr.length).toBe(CAP);
  });

  test("simultaneous large stdout+stderr drains without pipe deadlock", async () => {
    // 1 MiB per stream — far past the OS pipe buffer on both streams at
    // once, which deadlocks any run() that awaits exit before draining.
    const bytes = 1_048_576;
    const script = `head -c ${bytes} /dev/zero & head -c ${bytes} /dev/zero >&2; wait`;
    const res = await run(["bash", "-c", script]);
    expect(res.code).toBe(0);
    expect(res.stdout.length).toBe(bytes);
    expect(res.stderr.length).toBe(bytes);
  });

  test("a hostile infinite writer is killed at the cap, not buffered", async () => {
    await expect(run(["yes"], { maxOutputBytes: CAP })).rejects.toThrow(
      `exceeded the ${CAP}-byte per-stream cap on stdout: yes`,
    );
  });

  test("both streams overflowing together rejects without hanging", async () => {
    const script = `head -c ${CAP * 4} /dev/zero & head -c ${CAP * 4} /dev/zero >&2; wait`;
    await expect(run(["bash", "-c", script], { maxOutputBytes: CAP })).rejects.toThrow(
      "per-stream cap on",
    );
  });

  test("rejects a non-positive or non-integer cap before spawning", async () => {
    await expect(run(["true"], { maxOutputBytes: 0 })).rejects.toThrow("positive integer");
    await expect(run(["true"], { maxOutputBytes: 1.5 })).rejects.toThrow("positive integer");
  });

  test("nonzero exit still returns code with both captured streams", async () => {
    const res = await run(["bash", "-c", "echo out; echo err >&2; exit 3"]);
    expect(res).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
  });
});

describe("tmux runtime", () => {
  test("starts the agent without a login shell resetting the target PATH", async () => {
    let command = "";
    const transport = {
      label: "test",
      execChecked: async (value: string) => {
        command = value;
        return "";
      },
    } as unknown as Transport;

    await new TmuxRuntime(transport).start("beam-test", "/workspace", ["omp", "--resume", "s"]);

    expect(command).toContain("bash -c");
    expect(command).not.toContain("bash -lc");
  });

  /**
   * A transport double whose exec() replays a script of exit codes and
   * whose every destructive surface (sync, execChecked) trips the call
   * log — proving the runtime issues no destructive follow-on transport
   * call once liveness is unknown or termination unproven.
   */
  function scripted(script: Array<{ match: string; code: number; stderr?: string }>) {
    const calls: string[] = [];
    const transport = {
      label: "scripted",
      exec: async (command: string) => {
        calls.push(command);
        const step = script.shift();
        if (!step) throw new Error(`unscripted exec: ${command}`);
        if (!command.includes(step.match)) {
          throw new Error(`expected a "${step.match}" command, got: ${command}`);
        }
        return { code: step.code, stdout: "", stderr: step.stderr ?? "" };
      },
      execChecked: async (command: string) => {
        calls.push(`DESTRUCTIVE execChecked: ${command}`);
        return "";
      },
      syncUp: async () => {
        calls.push("DESTRUCTIVE syncUp");
      },
      syncDown: async () => {
        calls.push("DESTRUCTIVE syncDown");
      },
    } as unknown as Transport;
    return { transport, calls };
  }

  test("alive: has-session exit 0 is alive, exit 1 is the documented absent result", async () => {
    const zero = scripted([{ match: "has-session", code: 0 }]);
    expect(await new TmuxRuntime(zero.transport).alive("s")).toBe(true);

    const one = scripted([{ match: "has-session", code: 1, stderr: "can't find session: =s" }]);
    expect(await new TmuxRuntime(one.transport).alive("s")).toBe(false);
  });

  test.each([127, 255])("alive: exit %i is unknown liveness and throws," +
    " not 'absent'", async (code) => {
    const { transport, calls } = scripted([{ match: "has-session", code, stderr: "boom" }]);
    await expect(new TmuxRuntime(transport).alive("s")).rejects.toThrow(
      `cannot determine whether tmux session s is alive (has-session exited ${code}): boom`,
    );
    expect(calls).toEqual([expect.stringContaining("has-session")]);
  });
  test("alive: exit 1 with a non-absence diagnostic is unknown and fails closed", async () => {
    const { transport, calls } = scripted([
      {
        match: "has-session",
        code: 1,
        stderr: "error connecting to /tmp/tmux.sock (Permission denied)",
      },
    ]);
    await expect(new TmuxRuntime(transport).alive("s")).rejects.toThrow(
      /cannot determine.*Permission denied/,
    );
    expect(calls).toEqual([expect.stringContaining("has-session")]);
  });


  test("kill: a clean kill-session is one call and no re-probe", async () => {
    const { transport, calls } = scripted([{ match: "kill-session", code: 0 }]);
    await new TmuxRuntime(transport).kill("s");
    expect(calls).toEqual([expect.stringContaining("kill-session")]);
  });

  test("kill: a failed kill of a separately-verified absent session is idempotent", async () => {
    const { transport, calls } = scripted([
      { match: "kill-session", code: 1, stderr: "can't find session: =s" },
      { match: "has-session", code: 1, stderr: "can't find session: =s" },
    ]);
    await new TmuxRuntime(transport).kill("s");
    expect(calls).toHaveLength(2);
  });

  test("kill: a failed kill of a still-alive session throws", async () => {
    const { transport, calls } = scripted([
      { match: "kill-session", code: 1, stderr: "denied" },
      { match: "has-session", code: 0 },
    ]);
    await expect(new TmuxRuntime(transport).kill("s")).rejects.toThrow(
      "tmux kill of s failed and the session is still alive (exit 1): denied",
    );
    expect(calls.filter((c) => c.startsWith("DESTRUCTIVE"))).toEqual([]);
  });

  test.each([127, 255])(
    "kill: exit %i with an unanswerable re-probe surfaces the unknown, never proceeds",
    async (code) => {
      const { transport, calls } = scripted([
        { match: "kill-session", code, stderr: "transport broke" },
        { match: "has-session", code, stderr: "transport broke" },
      ]);
      await expect(new TmuxRuntime(transport).kill("s")).rejects.toThrow(
        `cannot determine whether tmux session s is alive (has-session exited ${code})`,
      );
      // Exactly the two tmux probes — no destructive follow-on transport call.
      expect(calls).toEqual([
        expect.stringContaining("kill-session"),
        expect.stringContaining("has-session"),
      ]);
    },
  );

  test("interrupt: losing the race to an agent that already exited is tolerated", async () => {
    const { transport, calls } = scripted([
      { match: "send-keys", code: 1, stderr: "can't find pane" },
      { match: "has-session", code: 1, stderr: "can't find session: =s" },
    ]);
    await new TmuxRuntime(transport).interrupt("s");
    expect(calls).toHaveLength(2);
  });

  test("interrupt: a failed send to a still-alive session throws", async () => {
    const { transport } = scripted([
      { match: "send-keys", code: 1, stderr: "denied" },
      { match: "has-session", code: 0 },
    ]);
    await expect(new TmuxRuntime(transport).interrupt("s")).rejects.toThrow(
      "tmux interrupt of s failed (exit 1): denied",
    );
  });

  test("interrupt: a broken transport surfaces instead of passing silently", async () => {
    const { transport, calls } = scripted([
      { match: "send-keys", code: 255, stderr: "ssh: connect refused" },
      { match: "has-session", code: 255, stderr: "ssh: connect refused" },
    ]);
    await expect(new TmuxRuntime(transport).interrupt("s")).rejects.toThrow(
      "cannot determine whether tmux session s is alive",
    );
    expect(calls.filter((c) => c.startsWith("DESTRUCTIVE"))).toEqual([]);
  });

  // tmux resolves a colon-less PANE target as a pane/window name first,
  // where the `=` exact-match marker never matches ("can't find pane:
  // =name" on tmux 3.6a) — pane-scoped commands must target `=name:` to
  // force the exact-session parse, while session-scoped commands take the
  // bare `=name`.
  test("pane commands target '=name:', session commands '=name'", async () => {
    const { transport, calls } = scripted([
      { match: "send-keys", code: 0 },
      { match: "has-session", code: 0 },
      { match: "kill-session", code: 0 },
    ]);
    const runtime = new TmuxRuntime(transport);
    await runtime.interrupt("s");
    await runtime.alive("s");
    await runtime.kill("s");
    expect(calls[0]).toContain("send-keys -t '=s:'");
    expect(calls[1]).toContain("has-session -t '=s'");
    expect(calls[1]).not.toContain("'=s:'");
    expect(calls[2]).toContain("kill-session -t '=s'");
    expect(calls[2]).not.toContain("'=s:'");
  });

  test("peek captures through the exact-match pane target", async () => {
    let command = "";
    const transport = {
      label: "test",
      execChecked: async (value: string) => {
        command = value;
        return "";
      },
    } as unknown as Transport;
    await new TmuxRuntime(transport).peek("s");
    expect(command).toContain("capture-pane -p -t '=s:'");
  });
});
