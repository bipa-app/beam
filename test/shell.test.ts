import { describe, expect, test } from "bun:test";
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
