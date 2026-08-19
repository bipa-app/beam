/**
 * Goal: prove every hard rule in scripts/check-style.ts fails closed with the
 * exact file:line and rule id, and that its syntax-aware exemptions (template
 * fixture content, JSDoc gutters, describe callbacks) never leak onto code.
 *
 * Method: feed synthetic in-memory sources to the exported analyzeSource and
 * boundary-test each rule (100/101 columns, 70/71-line functions, gated
 * timeouts, cycles); walk a throwaway temp tree for collectSourceFiles and
 * runCheck, and spawn the CLI once to prove an invalid root exits nonzero.
 * The only repo file read is AGENTS.md, to pin its documented gated-rule
 * list to the exported RULE_IDS registry.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeSource,
  collectSourceFiles,
  formatViolation,
  RULE_IDS,
  runCheck,
  type StyleViolation,
} from "../scripts/check-style.ts";

/** Violations of one rule for a synthetic source analyzed under `fileName`. */
function ruleHits(fileName: string, source: string, rule: string): StyleViolation[] {
  return analyzeSource(fileName, source).filter((v) => v.rule === rule);
}

/** Shorthand for fixtures that do not need a test-file name. */
function found(source: string, rule: string): StyleViolation[] {
  return ruleHits("fixture.ts", source, rule);
}

/** A function declaration spanning exactly `lines` source lines. */
function fnOfLines(lines: number): string {
  const body = Array.from({ length: lines - 2 }, (_, i) => `  const v${i} = ${i};`);
  return ["function f(): void {", ...body, "}"].join("\n");
}

/** Registration fixtures must really bind bun:test names — spelling alone is inert. */
const BUN_IMPORT = 'import { describe, it, test } from "bun:test";';

describe("line-length", () => {
  test("100 columns pass, 101 fail with exact file:line and rule", () => {
    const ok = "// " + "x".repeat(97);
    expect(found(ok, "line-length")).toEqual([]);
    const hits = found(`const a = 1;\n// ${"x".repeat(98)}\n`, "line-length");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(2);
    expect(formatViolation(hits[0]!)).toContain("fixture.ts:2 [line-length]");
  });

  test("lines inside template literals are fixture data and exempt", () => {
    const src = ["const s = `", "x".repeat(140), "   " + "y".repeat(120), "`;"].join("\n");
    expect(found(src, "line-length")).toEqual([]);
    expect(found(src, "indent")).toEqual([]);
  });
});

describe("literal content exemption", () => {
  test("code after a closing delimiter is still checked for tabs and width", () => {
    const tpl = ["const s = `", "fixture", "`;\tconst hidden = 1;"].join("\n");
    const tabs = found(tpl, "no-tabs");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.line).toBe(3);
    const closing = "const s = `" + "x".repeat(100) + "`;";
    expect(found(closing, "line-length")).toHaveLength(1);
  });

  test("delimiters are code: only multi-line literal interiors escape the width cap", () => {
    expect(found('const s = "' + "x".repeat(100) + '";', "line-length")).toHaveLength(1);
    expect(found('const s = "' + "x".repeat(87) + '";', "line-length")).toEqual([]);
  });

  test("regex literals are code end to end — never width- or tab-exempt", () => {
    expect(found("const r = /" + "x".repeat(100) + "/;", "line-length")).toHaveLength(1);
    expect(found("const r = /a\tb/;", "no-tabs")).toHaveLength(1);
  });

  test("closing-line leading whitespace is template content and stays indent-exempt", () => {
    const tpl = ["const s = `", "content", "   `;"].join("\n");
    expect(found(tpl, "indent")).toEqual([]);
  });
});

describe("display columns", () => {
  test("East Asian wide characters count two columns", () => {
    expect(found("// " + "漢".repeat(48), "line-length")).toEqual([]);
    const hits = found("// " + "漢".repeat(49), "line-length");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain("101 columns");
  });

  test("emoji count two columns and combining marks count zero", () => {
    expect(found("// " + "😀".repeat(48), "line-length")).toEqual([]);
    expect(found("// " + "😀".repeat(49), "line-length")).toHaveLength(1);
    expect(found("// " + "e\u0301".repeat(97), "line-length")).toEqual([]);
    expect(found("// " + "e\u0301".repeat(98), "line-length")).toHaveLength(1);
  });

  test("CRLF endings and a leading BOM add no columns and break no rules", () => {
    const src = "const a = 1;\r\n// " + "x".repeat(97) + "\r\nconst b = 2;\r\n";
    expect(found(src, "line-length")).toEqual([]);
    expect(found(src, "indent")).toEqual([]);
    expect(found("\ufeffconst a = 1;\n", "indent")).toEqual([]);
    expect(found("\ufeff// " + "x".repeat(97), "line-length")).toEqual([]);
  });
});

describe("func-length", () => {
  test("a 70-line function passes, 71 fails at its declaration line", () => {
    expect(found(fnOfLines(70), "func-length")).toEqual([]);
    const hits = found(fnOfLines(71), "func-length");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(1);
  });

  test("bun:test describe callbacks are registration and exempt; test bodies are not", () => {
    const filler = "  const a = 1;\n".repeat(75);
    const suite = `${BUN_IMPORT}\ndescribe("s", () => {\n${filler}});`;
    expect(found(suite, "func-length")).toEqual([]);
    const gated = `${BUN_IMPORT}\ndescribe.skipIf(false)("s", () => {\n${filler}});`;
    expect(found(gated, "func-length")).toEqual([]);
    const body = `${BUN_IMPORT}\ntest("t", () => {\n${filler}});`;
    expect(found(body, "func-length")).toHaveLength(1);
  });

  test("aliased describe stays exempt; unimported or local describe does not", () => {
    const filler = "  const a = 1;\n".repeat(75);
    const aliased = 'import { describe as suite } from "bun:test";';
    expect(found(`${aliased}\nsuite("s", () => {\n${filler}});`, "func-length")).toEqual([]);
    expect(found(`describe("s", () => {\n${filler}});`, "func-length")).toHaveLength(1);
    const local = [
      "function describe(name: string, fn: () => void): void { fn(); }",
      `describe("s", () => {\n${filler}});`,
    ].join("\n");
    const hits = found(local, "func-length");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(2);
  });
});

describe("no-recursion", () => {
  test("direct self-call is flagged at the call site", () => {
    const src = [
      "function fact(n: number): number {",
      "  if (n <= 1) { return 1; }",
      "  return n * fact(n - 1);",
      "}",
    ].join("\n");
    const hits = found(src, "no-recursion");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(3);
  });

  test("a const-bound arrow and a method calling itself via this are flagged", () => {
    expect(found("const loop = (): void => { loop(); };", "no-recursion")).toHaveLength(1);
    const method = "class C {\n  m(): void {\n    this.m();\n  }\n}";
    expect(found(method, "no-recursion")).toHaveLength(1);
  });

  test("recursion through immutable aliases is flagged, single and multi-hop", () => {
    const single = "function loop(): void { const again = loop; again(); }";
    expect(found(single, "no-recursion")).toHaveLength(1);
    const multi = "function f(): void { const a = f; const b = a; b(); }";
    expect(found(multi, "no-recursion")).toHaveLength(1);
  });

  test("an unresolvable alias cycle is guarded and stays clean", () => {
    const src = ["function f(): void {", "  const a = b;", "  const b = a;", "  a();", "}"].join(
      "\n",
    );
    expect(found(src, "no-recursion")).toEqual([]);
  });

  test("self-invocation through .call and .apply is flagged", () => {
    expect(found("function f(): void { f.call(null); }", "no-recursion")).toHaveLength(1);
    expect(found("function f(): void { f.apply(null, []); }", "no-recursion")).toHaveLength(1);
  });

  test("private, bracket, and static method self-calls are flagged", () => {
    expect(found("class C { #m(): void { this.#m(); } }", "no-recursion")).toHaveLength(1);
    expect(found('class C { m(): void { this["m"](); } }', "no-recursion")).toHaveLength(1);
    expect(found("class C { static s(): void { C.s(); } }", "no-recursion")).toHaveLength(1);
    expect(found("class C { static s(): void { this.s(); } }", "no-recursion")).toHaveLength(1);
  });

  test("accessor self-reads and self-writes are flagged", () => {
    const getter = "class C { get value(): number { return this.value; } }";
    expect(found(getter, "no-recursion")).toHaveLength(1);
    const setter = "class C { set value(v: number) { this.value = v; } }";
    expect(found(setter, "no-recursion")).toHaveLength(1);
  });

  test("mutual method and mutual accessor cycles report every member", () => {
    const methods = "class C {\n  a(): void { this.b(); }\n  b(): void { this.a(); }\n}";
    expect(found(methods, "no-recursion")).toHaveLength(2);
    const accessors = [
      "class C {",
      "  get a(): number { return this.b; }",
      "  get b(): number { return this.a; }",
      "}",
    ].join("\n");
    expect(found(accessors, "no-recursion")).toHaveLength(2);
  });

  test("mutual recursion is reported as a cycle at both declarations", () => {
    const src = [
      "function a(): void { b(); }",
      "function b(): void { a(); }",
    ].join("\n");
    const hits = found(src, "no-recursion");
    expect(hits).toHaveLength(2);
    expect(hits.map((v) => v.line)).toEqual([1, 2]);
    expect(hits[0]!.message).toContain("a -> b");
  });

  test("multi-hop cycles through aliases and nested closures report every member", () => {
    const viaAlias = [
      "function a(): void { mid(); }",
      "const mid = (): void => { hop(); };",
      "const hop = a;",
    ].join("\n");
    expect(found(viaAlias, "no-recursion")).toHaveLength(2);
    const viaClosure = [
      "function a(): void {",
      "  const inner = (): void => { b(); };",
      "  inner();",
      "}",
      "function b(): void { a(); }",
    ].join("\n");
    expect(found(viaClosure, "no-recursion")).toHaveLength(3);
  });

  test("a three-hop method cycle is reported; an acyclic chain is not", () => {
    const cycle = [
      "class C {",
      "  a(): void { this.b(); }",
      "  b(): void { this.c(); }",
      "  c(): void { this.a(); }",
      "}",
    ].join("\n");
    expect(found(cycle, "no-recursion")).toHaveLength(3);
    const chain = [
      "function a(): void { b(); }",
      "function b(): void { c(); }",
      "function c(): void {}",
    ].join("\n");
    expect(found(chain, "no-recursion")).toEqual([]);
  });

  test("a shadowing parameter suppresses the bare-name match", () => {
    const src = [
      "function f(): void {",
      "  const g = (f: () => void): void => { f(); };",
      "  g(() => {});",
      "}",
    ].join("\n");
    expect(found(src, "no-recursion")).toEqual([]);
  });

  test("block, catch, and destructuring shadowing suppress self-matches", () => {
    const block = "function f(): void { { const f = (): void => {}; f(); } }";
    expect(found(block, "no-recursion")).toEqual([]);
    const caught = "function f(): void { try { return; } catch (f) { f(); } }";
    expect(found(caught, "no-recursion")).toEqual([]);
    const destructured = "function f(): void { const { f } = globalThis as never; f(); }";
    expect(found(destructured, "no-recursion")).toEqual([]);
  });

  test("same-named helpers in disjoint scopes never merge into a cycle", () => {
    const src = [
      "function outerOne(): void {",
      "  function a(): void { b(); }",
      "  function b(): void {}",
      "  a();",
      "}",
      "function outerTwo(): void {",
      "  function a(): void {}",
      "  function b(): void { a(); }",
      "  b();",
      "}",
    ].join("\n");
    expect(found(src, "no-recursion")).toEqual([]);
    const crossKind = [
      "function run(): void { helper(); }",
      "function helper(): void {}",
      "class C { helper(): void { run(); } }",
    ].join("\n");
    expect(found(crossKind, "no-recursion")).toEqual([]);
  });

  test("mutable aliases and deferred callbacks produce no edges", () => {
    expect(found("function f(): void { let g = f; g(); }", "no-recursion")).toEqual([]);
    const timer = "function retry(): void { setTimeout(() => retry(), 10); }";
    expect(found(timer, "no-recursion")).toEqual([]);
  });
});

describe("no-nested-ternary", () => {
  test("nesting in any branch is flagged; a single ternary is fine", () => {
    expect(found("const x = a ? 1 : 2;", "no-nested-ternary")).toEqual([]);
    expect(found("const x = a ? (b ? 1 : 2) : 3;", "no-nested-ternary")).toHaveLength(1);
    expect(found("const x = a ? 1 : b ? 2 : 3;", "no-nested-ternary")).toHaveLength(1);
  });
});

describe("if-braces", () => {
  test("multiline unbraced if body fails; single-line and braced pass", () => {
    expect(found("if (cond)\n  act();", "if-braces")).toHaveLength(1);
    expect(found("if (cond) act();", "if-braces")).toEqual([]);
    expect(found("if (cond) {\n  act();\n}", "if-braces")).toEqual([]);
  });

  test("multiline unbraced else fails; else-if is banned in every form", () => {
    expect(found("if (c) { a(); } else\n  b();", "if-braces")).toHaveLength(1);
    const chain = "if (c) {\n  a();\n} else if (d) {\n  b();\n}";
    expect(found(chain, "if-braces")).toHaveLength(1);
    expect(found("if (c) { a(); } else if (d) { b(); }", "if-braces")).toHaveLength(1);
    const doubled = "if (c) {\n  a();\n} else if (d) {\n  b();\n} else if (e) {\n  z();\n}";
    expect(found(doubled, "if-braces")).toHaveLength(2);
    const nested = "if (c) {\n  a();\n} else {\n  if (d) {\n    b();\n  }\n}";
    expect(found(nested, "if-braces")).toEqual([]);
  });
});

describe("indentation", () => {
  test("odd indent fails, even passes, tabs are their own violation", () => {
    expect(found("const f = (): number => {\n   return 1;\n};", "indent")).toHaveLength(1);
    expect(found("function g(): void {\n  if (x) {\n    y();\n  }\n}", "indent")).toEqual([]);
    expect(found("\tconst a = 1;", "no-tabs")).toHaveLength(1);
  });

  test("JSDoc gutters and template interiors are exempt", () => {
    const doc = ["/**", " * Documented.", " */", "const a = 1;"].join("\n");
    expect(found(doc, "indent")).toEqual([]);
    const tpl = ["const s = `", "\tcontent", "   odd", "`;"].join("\n");
    expect(found(tpl, "no-tabs")).toEqual([]);
    expect(found(tpl, "indent")).toEqual([]);
  });

  test("control and non-ASCII leading whitespace are rejected as indentation", () => {
    const nbsp = found("function f(): void {\n\u00a0return;\n}", "indent");
    expect(nbsp).toHaveLength(1);
    expect(nbsp[0]!.line).toBe(2);
    expect(nbsp[0]!.message).toContain("U+00A0");
    expect(found("function g(): void {\n\u000breturn;\n}", "indent")).toHaveLength(1);
  });
});

describe("no-any and no-ts-escape", () => {
  test("any in annotations and casts fails; the word in strings/comments passes", () => {
    expect(found("const a: any = 1;", "no-any")).toHaveLength(1);
    expect(found("const b = c as any;", "no-any")).toHaveLength(1);
    expect(found('const s = "any"; // any day now', "no-any")).toEqual([]);
  });

  test("suppression directives in comments fail, in string data they pass", () => {
    expect(found("// @ts-ignore\nconst x = 1;", "no-ts-escape")).toHaveLength(1);
    expect(found("// @ts-expect-error\nconst x = 1;", "no-ts-escape")).toHaveLength(1);
    expect(found("/* @ts-nocheck */\nconst x = 1;", "no-ts-escape")).toHaveLength(1);
    expect(found('const s = "// @ts-ignore";', "no-ts-escape")).toEqual([]);
  });
});

describe("no-empty-catch and no-or-zero", () => {
  test("an empty catch fails even with only a comment inside", () => {
    expect(found("try {\n  a();\n} catch {}", "no-empty-catch")).toHaveLength(1);
    expect(found("try {\n  a();\n} catch { /* meh */ }", "no-empty-catch")).toHaveLength(1);
  });

  test("vacuous statements do not rescue an empty catch", () => {
    expect(found("try { a(); } catch { ; }", "no-empty-catch")).toHaveLength(1);
    expect(found("try { a(); } catch { skip: ; }", "no-empty-catch")).toHaveLength(1);
    expect(found("try { a(); } catch { {} }", "no-empty-catch")).toHaveLength(1);
    expect(found("try { a(); } catch { out: { ; } }", "no-empty-catch")).toHaveLength(1);
    expect(found("try { a(); } catch { { {} ; } }", "no-empty-catch")).toHaveLength(1);
  });

  test("substantive throw, log, and cleanup statements pass", () => {
    expect(found("try { a(); } catch (e) { throw e; }", "no-empty-catch")).toEqual([]);
    expect(found("try {\n  a();\n} catch (e) {\n  log(e);\n}", "no-empty-catch")).toEqual([]);
    expect(found("try { a(); } catch { cleanup(); }", "no-empty-catch")).toEqual([]);
    expect(found("try { a(); } catch { { rollback(); } }", "no-empty-catch")).toEqual([]);
  });

  test("or-zero coercion fails in every spelling; real bitwise or passes", () => {
    expect(found("const i = x | 0;", "no-or-zero")).toHaveLength(1);
    expect(found("const j = 0 | x;", "no-or-zero")).toHaveLength(1);
    expect(found("y |= 0;", "no-or-zero")).toHaveLength(1);
    expect(found("const k = flags | MASK;", "no-or-zero")).toEqual([]);
  });

  test("parenthesized, signed, and non-decimal zero spellings still fail", () => {
    expect(found("const a = value | (0);", "no-or-zero")).toHaveLength(1);
    expect(found("const b = (0) | value;", "no-or-zero")).toHaveLength(1);
    expect(found("value |= +0;", "no-or-zero")).toHaveLength(1);
    expect(found("const c = value | -0;", "no-or-zero")).toHaveLength(1);
    expect(found("const d = value | 0x0;", "no-or-zero")).toHaveLength(1);
    expect(found("const e = value | 0b0;", "no-or-zero")).toHaveLength(1);
    expect(found("const f = value | 0.0;", "no-or-zero")).toHaveLength(1);
    expect(found("const g = value | 0e5;", "no-or-zero")).toHaveLength(1);
    expect(found("const h = value | -(+(0));", "no-or-zero")).toHaveLength(1);
  });

  test("bigint zero and nonzero operands stay legal", () => {
    expect(found("const p = big | 0n;", "no-or-zero")).toEqual([]);
    expect(found("const q = big | -0n;", "no-or-zero")).toEqual([]);
    expect(found("const r = value | (1);", "no-or-zero")).toEqual([]);
    expect(found("const s = value | -1;", "no-or-zero")).toEqual([]);
  });
});

describe("test-doc", () => {
  test("a *.test.ts without a leading JSDoc fails at its first registration", () => {
    const src = `${BUN_IMPORT}\ntest("t", () => {});`;
    const hits = ruleHits("sample.test.ts", src, "test-doc");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(2);
  });

  test("a first-content Goal+Method JSDoc satisfies it; line comments do not", () => {
    const doc = [
      "/** Goal: X. Method: Y. */",
      BUN_IMPORT,
      'describe("s", () => {',
      '  test("t", () => {});',
      "});",
    ].join("\n");
    expect(ruleHits("s.test.ts", doc, "test-doc")).toEqual([]);
    const lineDoc = [
      "// just a note",
      BUN_IMPORT,
      'describe("s", () => {',
      '  test("t", () => {});',
      "});",
    ].join("\n");
    expect(ruleHits("s.test.ts", lineDoc, "test-doc")).toHaveLength(1);
  });

  test("a JSDoc after other content fails — the doc must open the file", () => {
    const late = [
      BUN_IMPORT,
      "const unrelated = 1;",
      "/** Goal: X. Method: Y. */",
      'test("t", () => {});',
    ].join("\n");
    const hits = ruleHits("late.test.ts", late, "test-doc");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(4);
  });

  test("missing or empty Goal/Method sections fail; a shebang may precede", () => {
    const goalOnly = ["/** Goal: something. */", BUN_IMPORT, 'test("t", () => {});'].join("\n");
    expect(ruleHits("g.test.ts", goalOnly, "test-doc")).toHaveLength(1);
    const emptyGoal = [
      "/**",
      " * Goal:",
      " * Method: run it.",
      " */",
      BUN_IMPORT,
      'test("t", () => {});',
    ].join("\n");
    expect(ruleHits("e.test.ts", emptyGoal, "test-doc")).toHaveLength(1);
    const license = ["/** Copyright (c) Beam. */", BUN_IMPORT, 'test("t", () => {});'].join("\n");
    expect(ruleHits("l.test.ts", license, "test-doc")).toHaveLength(1);
    const shebang = [
      "#!/usr/bin/env bun",
      "/** Goal: X. Method: Y. */",
      BUN_IMPORT,
      'test("t", () => {});',
    ].join("\n");
    expect(ruleHits("sh.test.ts", shebang, "test-doc")).toEqual([]);
  });

  test("todo registrations without callbacks still demand the doc", () => {
    const todoOnly = `${BUN_IMPORT}\ntest.todo("later");`;
    expect(ruleHits("todo.test.ts", todoOnly, "test-doc")).toHaveLength(1);
  });

  test("files without bun:test registrations and non-test files are exempt", () => {
    expect(ruleHits("u.test.ts", "const a = 1;", "test-doc")).toEqual([]);
    expect(ruleHits("u.test.ts", 'test("t", () => {});', "test-doc")).toEqual([]);
    expect(found(`${BUN_IMPORT}\ntest("t", () => {});`, "test-doc")).toEqual([]);
  });
});

describe("test-timeout", () => {
  const gate = 'const HAVE_DEPS = Bun.which("herdr") !== null && Bun.which("git") !== null;';

  test("a gated describe requires numeric timeouts on its tests", () => {
    const src = [
      BUN_IMPORT,
      gate,
      'describe.skipIf(!HAVE_DEPS)("remote", () => {',
      '  test("does work", async () => {',
      "    await run();",
      "  });",
      "});",
    ].join("\n");
    const hits = found(src, "test-timeout");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(4);
  });

  test("numeric and object timeouts satisfy the gate", () => {
    const src = [
      BUN_IMPORT,
      gate,
      'describe.skipIf(!HAVE_DEPS)("remote", () => {',
      '  test("a", async () => {}, 30_000);',
      '  it("b", async () => {}, { timeout: 5_000 });',
      "});",
    ].join("\n");
    expect(found(src, "test-timeout")).toEqual([]);
  });

  test("a directly gated test.skipIf needs its own timeout", () => {
    const direct = [
      BUN_IMPORT,
      'test.skipIf(Bun.which("rsync") === null)("s", async () => {});',
    ].join("\n");
    expect(found(direct, "test-timeout")).toHaveLength(1);
    const timed = [
      BUN_IMPORT,
      'test.skipIf(Bun.which("rsync") === null)("s", async () => {}, 10_000);',
    ].join("\n");
    expect(found(timed, "test-timeout")).toEqual([]);
  });

  test("only external-binary gates require timeouts", () => {
    const src = [
      BUN_IMPORT,
      'const IS_CI = process.env.CI === "1";',
      'describe.skipIf(IS_CI)("suite", () => {',
      '  test("t", () => {});',
      "});",
      'test("plain unit", () => {});',
    ].join("\n");
    expect(found(src, "test-timeout")).toEqual([]);
  });

  test("registration is binding-aware: aliases and namespaces gate too", () => {
    const aliased = [
      'import { describe as suite, test as check } from "bun:test";',
      'suite.skipIf(Bun.which("git") === null)("s", () => {',
      '  check("x", async () => {});',
      "});",
    ].join("\n");
    expect(found(aliased, "test-timeout")).toHaveLength(1);
    const namespaced = [
      'import * as bt from "bun:test";',
      'bt.test.skipIf(Bun.which("git") === null)("x", async () => {});',
    ].join("\n");
    expect(found(namespaced, "test-timeout")).toHaveLength(1);
    const constAlias = [
      BUN_IMPORT,
      "const check = test;",
      'check.skipIf(Bun.which("git") === null)("x", async () => {});',
    ].join("\n");
    expect(found(constAlias, "test-timeout")).toHaveLength(1);
    const element = [
      BUN_IMPORT,
      'test["skipIf"](Bun.which("git") === null)("x", async () => {});',
    ].join("\n");
    expect(found(element, "test-timeout")).toHaveLength(1);
  });

  test("unimported or shadowed spellings never demand timeouts", () => {
    const bare = 'test.skipIf(Bun.which("rsync") === null)("s", async () => {});';
    expect(found(bare, "test-timeout")).toEqual([]);
    const shadowed = [
      BUN_IMPORT,
      "function wrap(test: never): void {",
      '  test.skipIf(Bun.which("git") === null)("x", async () => {});',
      "}",
    ].join("\n");
    expect(found(shadowed, "test-timeout")).toEqual([]);
  });

  test("gates resolve through consts in the AST and reject fakes", () => {
    const twoHop = [
      BUN_IMPORT,
      'const BIN = Bun.which /* probe */ ("git");',
      "const MISSING = BIN === null;",
      'test.skipIf(MISSING)("x", async () => {});',
    ].join("\n");
    expect(found(twoHop, "test-timeout")).toHaveLength(1);
    const eachData = `${BUN_IMPORT}\ntest.each(["Bun.which("])("x %s", async () => {});`;
    expect(found(eachData, "test-timeout")).toEqual([]);
    const inString = [
      BUN_IMPORT,
      'test.skipIf(process.env.X === "Bun.which(")("x", async () => {});',
    ].join("\n");
    expect(found(inString, "test-timeout")).toEqual([]);
    const shadowedBun = [
      BUN_IMPORT,
      "const Bun = { which: (name: string): string => name };",
      'test.skipIf(Bun.which("git") === null)("x", async () => {});',
    ].join("\n");
    expect(found(shadowedBun, "test-timeout")).toEqual([]);
    const spellings = [
      BUN_IMPORT,
      'test.skipIf(Bun?.which("git") === null)("a", async () => {});',
      'test.skipIf(Bun["which"]("git") === null)("b", async () => {});',
    ].join("\n");
    expect(found(spellings, "test-timeout")).toHaveLength(2);
  });

  test("timeout spellings: shorthand, quoted, parenthesized, transitive const", () => {
    const src = [
      BUN_IMPORT,
      "const timeout = 1_000;",
      "const BASE = 30_000;",
      "const T = BASE;",
      gate,
      'describe.skipIf(!HAVE_DEPS)("remote", () => {',
      '  test("a", async () => {}, { timeout });',
      '  it("b", async () => {}, { "timeout": 5_000 });',
      '  test("c", async () => {}, (30_000));',
      '  it("d", async () => {}, T);',
      "});",
    ].join("\n");
    expect(found(src, "test-timeout")).toEqual([]);
  });

  test("a file-local numeric const satisfies the gate, inline and as options", () => {
    const src = [
      BUN_IMPORT,
      "const ROUND_TRIP_TIMEOUT_MS = 30_000;",
      gate,
      'describe.skipIf(!HAVE_DEPS)("remote", () => {',
      '  test("a", async () => {}, ROUND_TRIP_TIMEOUT_MS);',
      '  it("b", async () => {}, { timeout: ROUND_TRIP_TIMEOUT_MS });',
      "});",
    ].join("\n");
    expect(found(src, "test-timeout")).toEqual([]);
  });

  test("mutable or computed timeout bindings are refused", () => {
    const mutable = [
      BUN_IMPORT,
      "let T = 30_000;",
      gate,
      'describe.skipIf(!HAVE_DEPS)("remote", () => {',
      '  test("a", async () => {}, T);',
      "});",
    ].join("\n");
    expect(found(mutable, "test-timeout")).toHaveLength(1);
    const computed = [
      BUN_IMPORT,
      "const T = 30 * 1000;",
      gate,
      'describe.skipIf(!HAVE_DEPS)("remote", () => {',
      '  test("a", async () => {}, T);',
      "});",
    ].join("\n");
    expect(found(computed, "test-timeout")).toHaveLength(1);
  });

  test("alias cycles, non-finite literals, and shadowed values are refused", () => {
    const src = [
      BUN_IMPORT,
      "const A: number = B;",
      "const B: number = A;",
      gate,
      'describe.skipIf(!HAVE_DEPS)("remote", () => {',
      '  test("a", async () => {}, A);',
      '  test("b", async () => {}, 1e999);',
      "});",
    ].join("\n");
    expect(found(src, "test-timeout")).toHaveLength(2);
    const shadowedAtUse = [
      BUN_IMPORT,
      "const T = 1_000;",
      gate,
      'describe.skipIf(!HAVE_DEPS)("remote", () => {',
      "  let T = 5;",
      '  test("a", async () => {}, T);',
      "});",
    ].join("\n");
    expect(found(shadowedAtUse, "test-timeout")).toHaveLength(1);
  });

  test("an unrelated same-named binding elsewhere no longer disqualifies", () => {
    const src = [
      BUN_IMPORT,
      "const T = 1_000;",
      "function elsewhere(x: number): number {",
      "  const T = x * 2;",
      "  return T;",
      "}",
      gate,
      'test.skipIf(!HAVE_DEPS)("a", async () => {}, T);',
    ].join("\n");
    expect(found(src, "test-timeout")).toEqual([]);
  });

  test("gated todo registrations without callbacks need no timeout", () => {
    const src = [
      BUN_IMPORT,
      gate,
      'describe.skipIf(!HAVE_DEPS)("remote", () => {',
      '  test.todo("later");',
      "});",
    ].join("\n");
    expect(found(src, "test-timeout")).toEqual([]);
  });
});

describe("collectSourceFiles and runCheck", () => {
  test("walks src/test/scripts completely — no subdirectory allowlists", () => {
    const root = mkdtempSync(join(tmpdir(), "beam-style-"));
    mkdirSync(join(root, "src", "node_modules"), { recursive: true });
    mkdirSync(join(root, "src", ".planning"), { recursive: true });
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "src", "ok.ts"), "const a = 1;\n");
    writeFileSync(join(root, "src", "bad.ts"), "\tconst b = 2;\n");
    writeFileSync(join(root, "src", "node_modules", "dep.ts"), "\tconst c = 3;\n");
    writeFileSync(join(root, "src", ".planning", "note.ts"), "\tconst d = 4;\n");
    writeFileSync(join(root, "src", "readme.md"), "not typescript\n");
    writeFileSync(join(root, "test", "t.ts"), "const t = 1;\n");
    expect(collectSourceFiles(root)).toEqual([
      join(root, "src", ".planning", "note.ts"),
      join(root, "src", "bad.ts"),
      join(root, "src", "node_modules", "dep.ts"),
      join(root, "src", "ok.ts"),
      join(root, "test", "t.ts"),
    ]);
    const hits = runCheck(root).map((v) => `${v.file} ${v.rule}`);
    expect(hits.sort()).toEqual([
      `${join("src", ".planning", "note.ts")} no-tabs`,
      `${join("src", "bad.ts")} no-tabs`,
      `${join("src", "node_modules", "dep.ts")} no-tabs`,
    ]);
  });

  test("a missing root, a file root, and a root with no source roots all throw", () => {
    const root = mkdtempSync(join(tmpdir(), "beam-style-"));
    expect(() => collectSourceFiles(join(root, "missing"))).toThrow("does not exist");
    const filePath = join(root, "file.txt");
    writeFileSync(filePath, "not a directory\n");
    expect(() => collectSourceFiles(filePath)).toThrow("not a directory");
    expect(() => collectSourceFiles(root)).toThrow("no src/test/scripts");
  });

  test("the CLI exits nonzero on an invalid root", async () => {
    const script = join(import.meta.dir, "..", "scripts", "check-style.ts");
    const root = mkdtempSync(join(tmpdir(), "beam-style-"));
    const proc = Bun.spawn([process.execPath, script, join(root, "missing")], {
      cwd: join(import.meta.dir, ".."),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(code).toBe(1);
    expect(stderr).toContain("does not exist");
  });
});

describe("rule registry", () => {
  test("AGENTS.md documents exactly the implemented gated rule ids, in order", () => {
    const md = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
    const subset = md.match(/rule ids ((?:`[a-z-]+`(?:,\s+)?)+) — and the rest/);
    expect(subset).not.toBeNull();
    const documented = [...(subset?.[1] ?? "").matchAll(/`([a-z-]+)`/g)].map((m) => m[1] ?? "");
    expect(documented).toEqual([...RULE_IDS]);
  });
});
