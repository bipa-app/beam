/**
 * Goal: the shell seam's safety contracts — `shq`/`shjoin`/`shqRemotePath`
 * survive hostile content through a real bash, `run` enforces its per-stream
 * output cap loudly (no deadlock, no unbounded buffering), and HerdrRuntime
 * drives the four-step start sequence, maps pane-list outcomes to
 * three-valued liveness, and interrupts/destroys only with proof, failing
 * closed on anything it cannot classify.
 *
 * Method: quoting round-trips execute through real `bash -c`; cap behavior
 * uses exact-size and overflowing writers; herdr verdicts run against
 * scripted Transport doubles replaying JSON envelopes byte-shaped after the
 * real herdr 0.8.0 binary's output.
 */
import { describe, expect, test } from "bun:test";
import { HerdrRuntime } from "../src/runtime/herdr.ts";
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

describe("herdr runtime", () => {
  // The socket-path scheme every emitted herdr command must carry,
  // duplicated here LITERALLY so the suite pins the exact bytes the
  // runtime ships to a remote shell (see the HerdrRuntime doc for why the
  // socket leaves herdr's HOME-derived default): uid-scoped tmp dir prep —
  // created 0700, ownership-verified fail-closed — then the env pair
  // binding the invocation to the session's own socket.
  const PREP =
    'dir="${TMPDIR:-/tmp}/herdr-$(id -u)"; mkdir -p -m 700 "$dir" && [ -O "$dir" ] || ' +
    '{ echo "beam: herdr socket dir $dir is not owned by uid $(id -u); remove it and retry"' +
    " >&2; exit 1; }";

  function sockEnv(name: string): string {
    return `HERDR_SESSION='${name}' HERDR_SOCKET_PATH="$dir/${name}.sock"`;
  }

  // JSON fixtures below are byte-shaped after real herdr 0.8.0 output
  // (probed via a throwaway HOME with HERDR_SOCKET_PATH set): success
  // envelopes on stdout, error envelopes
  // {"id":...,"error":{"code":...,"message":...}} on stderr with exit 1.
  // Registry payloads (`session delete`) keep HOME-derived paths — only
  // the socket moves under the override.
  function paneListJson(paneIds: string[]): string {
    const panes = paneIds.map((id) => ({
      agent_status: "unknown",
      cwd: "/workspace",
      focused: true,
      foreground_cwd: "/workspace",
      pane_id: id,
      revision: 0,
      scroll: { max_offset_from_bottom: 0, offset_from_bottom: 0, viewport_rows: 24 },
      tab_id: "w1:t1",
      terminal_id: "term_65944d0fd52561",
      workspace_id: "w1",
    }));
    return JSON.stringify({ id: "cli:pane:list", result: { panes, type: "pane_list" } });
  }

  function workspaceCreatedJson(paneId: string): string {
    return JSON.stringify({
      id: "cli:workspace:create",
      result: {
        root_pane: {
          agent_status: "unknown",
          cwd: "/workspace",
          focused: true,
          foreground_cwd: "/workspace",
          pane_id: paneId,
          revision: 0,
          scroll: { max_offset_from_bottom: 0, offset_from_bottom: 0, viewport_rows: 24 },
          tab_id: "w1:t1",
          terminal_id: "term_65944d0fd52561",
          workspace_id: "w1",
        },
        tab: {
          agent_status: "unknown",
          focused: true,
          label: "1",
          number: 1,
          pane_count: 1,
          tab_id: "w1:t1",
          workspace_id: "w1",
        },
        type: "workspace_created",
        workspace: {
          active_tab_id: "w1:t1",
          agent_status: "unknown",
          focused: true,
          label: "work",
          number: 1,
          pane_count: 1,
          tab_count: 1,
          workspace_id: "w1",
        },
      },
    });
  }

  function sessionInfo(name: string): object {
    const dir = `/home/agent/.config/herdr/sessions/${name}`;
    return {
      default: false,
      name,
      running: false,
      session_dir: dir,
      socket_path: `${dir}/herdr.sock`,
    };
  }

  function serverNotRunningJson(name: string): string {
    const sock = `/tmp/herdr-501/${name}.sock`;
    const message =
      `no herdr server is running at ${sock}; run \`herdr\` to start or attach it`;
    return JSON.stringify({
      id: "cli:pane:list",
      error: { code: "server_not_running", message },
    });
  }

  /**
   * `server stop` with no server answering: exit 1 with a PLAIN-TEXT
   * diagnostic on stderr — no JSON envelope, no machine-readable code
   * (verified on herdr 0.8.0 with HERDR_SOCKET_PATH set).
   */
  function serverStopFailedText(name: string): string {
    return (
      `server is not running or cannot be reached at /tmp/herdr-501/${name}.sock: ` +
      "No such file or directory (os error 2)"
    );
  }

  function deletedJson(name: string): string {
    return JSON.stringify({ deleted: true, session: sessionInfo(name) });
  }

  /**
   * A transport double whose execChecked() replays a script of stdout
   * payloads — the happy-path seam start() and peek() drive. An
   * out-of-order or extra call throws, pinning the exact sequence.
   */
  function checked(script: Array<{ match: string; stdout: string }>) {
    const calls: string[] = [];
    const transport = {
      label: "checked",
      execChecked: async (command: string) => {
        calls.push(command);
        const step = script.shift();
        if (!step) throw new Error(`unscripted execChecked: ${command}`);
        if (!command.includes(step.match)) {
          throw new Error(`expected a "${step.match}" command, got: ${command}`);
        }
        return step.stdout;
      },
    } as unknown as Transport;
    return { transport, calls };
  }

  /**
   * A transport double whose exec() replays a script of exit codes and
   * output, and whose every destructive surface (sync, execChecked) trips
   * the call log — proving the runtime issues no destructive follow-on
   * transport call once liveness is unknown or termination unproven.
   */
  type Step = { match: string; code: number; stdout?: string; stderr?: string };
  function scripted(script: Step[]) {
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
        return { code: step.code, stdout: step.stdout ?? "", stderr: step.stderr ?? "" };
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

  test("start issues the four-step sequence and threads the parsed pane id", async () => {
    const { transport, calls } = checked([
      { match: "printf", stdout: "" },
      { match: "herdr server", stdout: "" },
      { match: "workspace create", stdout: workspaceCreatedJson("w1:p1") },
      { match: "pane run", stdout: "" },
    ]);
    await new HerdrRuntime(transport).start("beam-test", "/workspace", ["omp", "--resume", "s"]);
    expect(calls).toHaveLength(4);

    // Step 1: the start script lands via printf+shq (a heredoc delimiter
    // could collide with a multiline kickoff arg), keeping the exact
    // exit-marker convention down.ts and status parsing rely on.
    const script =
      `${shjoin(["omp", "--resume", "s"])}; code=$?; echo; ` +
      'echo "[beam] agent exited ($code) - shell below"';
    expect(calls[0]).toBe(
      `mkdir -p ${shq("/workspace/.beam")} && printf '%s\\n' ${shq(script)} ` +
      `> ${shq("/workspace/.beam/agent-start.sh")}`,
    );

    // Step 2: ensure-server prepares the socket dir FIRST (same script),
    // probes via pane list (exit-code-meaningful even with no server) with
    // the session's socket pinned, boot is bounded, exhaustion is loud and
    // actionable.
    expect(calls[1]!.split("\n")[0]).toBe(PREP);
    expect(calls[1]).toContain(
      `if ! ${sockEnv("beam-test")} herdr pane list >/dev/null 2>&1; then`,
    );
    expect(calls[1]).toContain(
      `nohup env ${sockEnv("beam-test")} herdr server >/dev/null 2>&1 &`,
    );
    expect(calls[1]).toContain('if [ "$tries" -ge 50 ]; then');
    expect(calls[1]).toContain("sleep 0.2");
    expect(calls[1]).toContain(
      "beam: herdr server for session beam-test did not answer after 50 probes (10s)",
    );

    // Step 3: herdr 0.8.0 rejects --json here — JSON is the default output.
    expect(calls[2]).toBe(
      `${PREP}; ${sockEnv("beam-test")} herdr workspace create --cwd '/workspace' --no-focus`,
    );
    expect(calls[2]).not.toContain("--json");

    // Step 4: the typed line is quote-free inside, so it parses identically
    // under any pane default shell; the pane id came from step 3's JSON.
    expect(calls[3]).toBe(
      `${PREP}; ${sockEnv("beam-test")} herdr pane run 'w1:p1' 'bash .beam/agent-start.sh'`,
    );

    // No login shell anywhere: `bash -lc` resets PATH on sandbox pods.
    for (const call of calls) expect(call).not.toContain("bash -lc");
  });

  test("start aborts before pane run when the created workspace has no pane id", async () => {
    const { transport, calls } = checked([
      { match: "printf", stdout: "" },
      { match: "herdr server", stdout: "" },
      { match: "workspace create", stdout: "not json at all" },
    ]);
    const runtime = new HerdrRuntime(transport);
    await expect(runtime.start("beam-test", "/workspace", ["omp"])).rejects.toThrow();
    expect(calls).toHaveLength(3); // never typed into an unresolved pane
  });

  test("alive: exit 0 maps pane count — one pane is alive, zero is absent", async () => {
    const one = scripted([{ match: "pane list", code: 0, stdout: paneListJson(["w1:p1"]) }]);
    expect(await new HerdrRuntime(one.transport).alive("s")).toBe(true);
    expect(one.calls).toEqual([`${PREP}; ${sockEnv("s")} herdr pane list`]);

    const zero = scripted([{ match: "pane list", code: 0, stdout: paneListJson([]) }]);
    expect(await new HerdrRuntime(zero.transport).alive("s")).toBe(false);
  });

  test("alive: a dead server is proven absence — its panes died with it", async () => {
    const { transport } = scripted([
      { match: "pane list", code: 1, stderr: serverNotRunningJson("s") },
    ]);
    expect(await new HerdrRuntime(transport).alive("s")).toBe(false);
  });

  test("alive: a nonzero exit with a non-absence diagnostic fails closed", async () => {
    const { transport, calls } = scripted([
      { match: "pane list", code: 1, stderr: "error connecting to herdr.sock (Permission denied)" },
    ]);
    await expect(new HerdrRuntime(transport).alive("s")).rejects.toThrow(
      /cannot determine.*Permission denied/,
    );
    expect(calls).toEqual([expect.stringContaining("pane list")]);
  });

  test.each([127, 255])("alive: exit %i is unknown liveness and throws," +
    " not 'absent'", async (code) => {
    const { transport, calls } = scripted([{ match: "pane list", code, stderr: "boom" }]);
    await expect(new HerdrRuntime(transport).alive("s")).rejects.toThrow(
      `cannot determine whether herdr session s is alive (pane list exited ${code}): boom`,
    );
    expect(calls).toEqual([expect.stringContaining("pane list")]);
  });

  test("alive: exit 0 with an unparseable envelope throws, never guesses", async () => {
    const { transport } = scripted([{ match: "pane list", code: 0, stdout: "not json" }]);
    await expect(new HerdrRuntime(transport).alive("s")).rejects.toThrow();
  });

  test("kill: a clean stop-then-delete is two calls and no re-probe", async () => {
    // `server stop` is the one stop that honors HERDR_SOCKET_PATH
    // (`session stop <name>` resolves the socket from the HOME-derived
    // registry, which never learns the override); success prints nothing.
    const { transport, calls } = scripted([
      { match: "server stop", code: 0, stdout: "" },
      { match: "session delete", code: 0, stdout: deletedJson("s") },
    ]);
    await new HerdrRuntime(transport).kill("s");
    expect(calls).toEqual([
      `${PREP}; ${sockEnv("s")} herdr server stop`,
      `${PREP}; ${sockEnv("s")} herdr session delete 's' --json`,
    ]);
  });

  test("kill: a failed stop of a separately-proven-dead server still deletes", async () => {
    const { transport, calls } = scripted([
      { match: "server stop", code: 1, stderr: serverStopFailedText("s") },
      { match: "pane list", code: 1, stderr: serverNotRunningJson("s") },
      { match: "session delete", code: 0, stdout: deletedJson("s") },
    ]);
    await new HerdrRuntime(transport).kill("s");
    expect(calls).toHaveLength(3);
  });

  test("kill: a delete refused by a just-died server is idempotent", async () => {
    const { transport, calls } = scripted([
      { match: "server stop", code: 0, stdout: "" },
      { match: "session delete", code: 1, stderr: serverNotRunningJson("s") },
    ]);
    await new HerdrRuntime(transport).kill("s");
    expect(calls).toHaveLength(2); // ids are never reused; leftover state is fine
  });

  test("kill: a failed stop of a still-alive session throws before delete", async () => {
    const { transport, calls } = scripted([
      { match: "server stop", code: 1, stderr: "denied" },
      { match: "pane list", code: 0, stdout: paneListJson(["w1:p1"]) },
    ]);
    await expect(new HerdrRuntime(transport).kill("s")).rejects.toThrow(
      "herdr kill of s failed and the session is still alive (stop exited 1): denied",
    );
    expect(calls).toHaveLength(2); // no delete issued against a live session
    expect(calls.filter((c) => c.startsWith("DESTRUCTIVE"))).toEqual([]);
  });

  test.each([127, 255])(
    "kill: exit %i with an unanswerable re-probe surfaces the unknown, never proceeds",
    async (code) => {
      const { transport, calls } = scripted([
        { match: "server stop", code, stderr: "transport broke" },
        { match: "pane list", code, stderr: "transport broke" },
      ]);
      await expect(new HerdrRuntime(transport).kill("s")).rejects.toThrow(
        `cannot determine whether herdr session s is alive (pane list exited ${code})`,
      );
      // Exactly the two herdr probes — no destructive follow-on transport call.
      expect(calls).toEqual([
        expect.stringContaining("server stop"),
        expect.stringContaining("pane list"),
      ]);
    },
  );

  test("kill: a failed delete of a still-alive session throws", async () => {
    const { transport, calls } = scripted([
      { match: "server stop", code: 0, stdout: "" },
      { match: "session delete", code: 1, stderr: "denied" },
      { match: "pane list", code: 0, stdout: paneListJson(["w1:p1"]) },
    ]);
    await expect(new HerdrRuntime(transport).kill("s")).rejects.toThrow(
      "herdr kill of s failed and the session is still alive (delete exited 1): denied",
    );
    expect(calls.filter((c) => c.startsWith("DESTRUCTIVE"))).toEqual([]);
  });

  test("interrupt: resolves the pane and sends ctrl+c through it", async () => {
    const { transport, calls } = scripted([
      { match: "pane list", code: 0, stdout: paneListJson(["w1:p1"]) },
      { match: "send-keys", code: 0 },
    ]);
    await new HerdrRuntime(transport).interrupt("s");
    expect(calls).toEqual([
      `${PREP}; ${sockEnv("s")} herdr pane list`,
      `${PREP}; ${sockEnv("s")} herdr pane send-keys 'w1:p1' ctrl+c`,
    ]);
  });

  test("interrupt: losing the race to a session that already died is tolerated", async () => {
    const { transport, calls } = scripted([
      { match: "pane list", code: 0, stdout: paneListJson(["w1:p1"]) },
      { match: "send-keys", code: 1, stderr: "can't find pane" },
      { match: "pane list", code: 1, stderr: serverNotRunningJson("s") },
    ]);
    await new HerdrRuntime(transport).interrupt("s");
    expect(calls).toHaveLength(3);
  });

  test("interrupt: an unresolvable pane in a proven-absent session is tolerated", async () => {
    const { transport, calls } = scripted([
      { match: "pane list", code: 0, stdout: paneListJson([]) },
      { match: "pane list", code: 0, stdout: paneListJson([]) },
    ]);
    await new HerdrRuntime(transport).interrupt("s");
    expect(calls).toHaveLength(2);
  });

  test("interrupt: an unresolvable pane in a still-alive session throws", async () => {
    const { transport, calls } = scripted([
      { match: "pane list", code: 1, stderr: "denied" },
      { match: "pane list", code: 0, stdout: paneListJson(["w1:p1"]) },
    ]);
    await expect(new HerdrRuntime(transport).interrupt("s")).rejects.toThrow(
      "herdr interrupt of s failed: cannot resolve pane (denied)",
    );
    expect(calls.filter((c) => c.startsWith("DESTRUCTIVE"))).toEqual([]);
  });

  test("interrupt: a failed send to a still-alive session throws", async () => {
    const { transport } = scripted([
      { match: "pane list", code: 0, stdout: paneListJson(["w1:p1"]) },
      { match: "send-keys", code: 1, stderr: "denied" },
      { match: "pane list", code: 0, stdout: paneListJson(["w1:p1"]) },
    ]);
    await expect(new HerdrRuntime(transport).interrupt("s")).rejects.toThrow(
      "herdr interrupt of s failed (exit 1): denied",
    );
  });

  test("interrupt: a broken transport surfaces instead of passing silently", async () => {
    const { transport, calls } = scripted([
      { match: "pane list", code: 0, stdout: paneListJson(["w1:p1"]) },
      { match: "send-keys", code: 255, stderr: "ssh: connect refused" },
      { match: "pane list", code: 255, stderr: "ssh: connect refused" },
    ]);
    await expect(new HerdrRuntime(transport).interrupt("s")).rejects.toThrow(
      "cannot determine whether herdr session s is alive",
    );
    expect(calls.filter((c) => c.startsWith("DESTRUCTIVE"))).toEqual([]);
  });

  test("peek reads the visible screen and returns the last non-blank lines", async () => {
    // `--source visible` is the capture-pane equivalent: recent/-unwrapped
    // are empty until output scrolls and never include alt-screen TUI rows.
    const screen = "omp> thinking\n\n   \n[beam] agent exited (0) - shell below\nbash-5.2$";
    const all = checked([
      { match: "pane list", stdout: paneListJson(["w1:p1"]) },
      { match: "pane read", stdout: screen },
    ]);
    expect(await new HerdrRuntime(all.transport).peek("s")).toBe(
      "omp> thinking\n[beam] agent exited (0) - shell below\nbash-5.2$",
    );
    expect(all.calls[1]).toBe(
      `${PREP}; ${sockEnv("s")} herdr pane read 'w1:p1' --source visible --lines 12 --format text`,
    );

    const tail = checked([
      { match: "pane list", stdout: paneListJson(["w1:p1"]) },
      { match: "pane read", stdout: screen },
    ]);
    expect(await new HerdrRuntime(tail.transport).peek("s", 2)).toBe(
      "[beam] agent exited (0) - shell below\nbash-5.2$",
    );
    expect(tail.calls[1]).toContain("--lines 2");
  });

  test("peek of a session with no panes throws instead of reading nothing", async () => {
    const { transport, calls } = checked([
      { match: "pane list", stdout: paneListJson([]) },
    ]);
    await expect(new HerdrRuntime(transport).peek("s")).rejects.toThrow(
      "herdr session s has no panes",
    );
    expect(calls).toHaveLength(1);
  });

  test("attachCommand is one fish-safe bash -c payload binding attach to the socket", () => {
    const transport = { label: "unused" } as unknown as Transport;
    const command = new HerdrRuntime(transport).attachCommand("beam-x");
    expect(command).toBe(
      `bash -c '${PREP}; HERDR_SESSION=beam-x HERDR_SOCKET_PATH="$dir/beam-x.sock" ` +
        "exec herdr session attach beam-x'",
    );
    // fish hands a single-quoted string to bash literally, EXCEPT that \'
    // and \\ escape — so the payload must smuggle no nested single quotes
    // and no backslashes at all.
    const payload = command.slice("bash -c '".length, -1);
    expect(payload).not.toContain("'");
    expect(payload).not.toContain("\\");
  });
});
