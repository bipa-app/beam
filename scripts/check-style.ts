/**
 * Tiger Style gate for Beam. Hard checks only: no warning mode, no baselines,
 * no per-file ignores. Exit 0 iff every check passes on src/, test/, scripts/.
 *
 * Rules (rule id — meaning):
 *   line-length        lines are at most 100 display columns (Unicode-aware)
 *   func-length        function-likes span at most 70 lines (callbacks passed
 *                      directly to a bun:test describe registration are suite
 *                      grouping, not logic, and are exempt; test bodies count)
 *   no-recursion       a function never calls itself, directly (bare name or
 *                      this.method, reported at the call site) or through a
 *                      file-local cycle of bare-name calls (reported at each
 *                      participating function declaration)
 *   no-nested-ternary  a conditional expression never nests inside another
 *   if-braces          an if/else body that does not sit on the same line as
 *                      its keyword must be a braced block, and `else if` is
 *                      banned in favor of `else { if (...) { ... } }`
 *   no-tabs            no tab characters outside string/template content
 *   indent             leading whitespace is plain spaces, a multiple of 2;
 *                      control and non-ASCII whitespace never indent code
 *   no-any             the `any` type keyword is banned
 *   no-ts-escape       TypeScript suppression directives (the ts-ignore,
 *                      ts-expect-error, and ts-nocheck comments) are banned
 *   no-empty-catch     a catch block must contain a substantive statement —
 *                      empty statements, labels around them, and empty
 *                      nested blocks do not handle an error
 *   no-or-zero         `| 0` (and `|= 0`) integer coercion is banned for any
 *                      numeric spelling of zero, however parenthesized or
 *                      unary-signed (bigint `0n` stays legal)
 *   test-doc           *.test.ts files open with a JSDoc — the first content
 *                      after any BOM/shebang — stating nonempty Goal: and
 *                      Method: sections (enforced once the file registers
 *                      bun:test tests or suites)
 *   test-timeout       tests gated on external binaries (an if/skipIf gate
 *                      calling the global Bun.which, directly or through
 *                      lexically resolved const aliases) must carry an
 *                      explicit numeric timeout — a finite safe numeric
 *                      literal or a lexical immutable const alias, inline or
 *                      as { timeout: ... } (shorthand and quoted forms count)
 *
 * test/it/describe are recognized through their actual bun:test value
 * bindings — named import aliases, namespace members, and immutable const
 * aliases, plus .if/.skipIf/.todo/.skip-style modifier chains — never by
 * spelling, so local shadows neither register nor earn exemptions.
 *
 * Generated fixture content is exempted syntax-aware only: the CONTENT spans
 * of string and template literals — never their delimiters, never regexes —
 * are exempt from line-length, no-tabs, and indent, so code sharing a line
 * with a literal (a closing-line suffix, say) is still checked. Columns are
 * display columns: CR counts 0, combining marks and format characters count
 * 0, East Asian wide and emoji-presentation code points count 2, all else 1.
 * Comment interiors are exempt from the indent check so JSDoc `*` gutters
 * stay legal.
 *
 * Usage: bun scripts/check-style.ts [rootDir] — rootDir must be a directory
 * holding at least one of src/, test/, scripts/; anything else exits 1.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Every hard-gated rule id. The AGENTS.md "mechanical subset" list must match
 * this registry exactly — test/check-style.test.ts compares the two — and
 * `violate` only accepts members, so an undocumented rule cannot ship.
 */
export const RULE_IDS = [
  "line-length",
  "func-length",
  "no-recursion",
  "no-nested-ternary",
  "if-braces",
  "no-tabs",
  "indent",
  "no-any",
  "no-ts-escape",
  "no-empty-catch",
  "no-or-zero",
  "test-doc",
  "test-timeout",
] as const;

type RuleId = (typeof RULE_IDS)[number];

export interface StyleViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

interface Ctx {
  readonly sf: ts.SourceFile;
  readonly file: string;
  readonly text: string;
  readonly out: StyleViolation[];
}

type FunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

/** test/it register tests; describe registers suites. */
type RegistrationKind = "test" | "describe";

/** A bun:test value binding: a registration function or the module namespace. */
type BunTestKind = RegistrationKind | "namespace";

const MAX_LINE_COLUMNS = 100;
const MAX_FUNCTION_LINES = 70;
const SOURCE_ROOTS = ["src", "test", "scripts"];
const TS_ESCAPE = /@ts-(?:ignore|expect-error|nocheck)/g;
const BUN_TEST_MODULE = "bun:test";

/** Chainable bun:test registration modifiers; only .if/.skipIf arguments are gates. */
const REGISTRATION_MODIFIERS: Record<string, true> = {
  concurrent: true,
  each: true,
  failing: true,
  if: true,
  only: true,
  skip: true,
  skipIf: true,
  todo: true,
  todoIf: true,
};

const LITERAL_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
]);

/**
 * Display-column metric, dependency-free. WIDE_POINT is the East Asian
 * wide/fullwidth block table (wcwidth's ranges) plus default-emoji-
 * presentation pictographs; ZERO_WIDTH_POINT is CR, combining marks, format
 * characters (ZWJ, BOM), and remaining control characters, none of which
 * advance the column. Everything else — tabs included, they are already
 * violations outside fixture content — is one column.
 */
const WIDE_POINT = new RegExp(
  "[\\u{1100}-\\u{115F}\\u{2E80}-\\u{303E}\\u{3041}-\\u{33FF}" +
    "\\u{3400}-\\u{4DBF}\\u{4E00}-\\u{9FFF}\\u{A000}-\\u{A4CF}" +
    "\\u{AC00}-\\u{D7A3}\\u{F900}-\\u{FAFF}\\u{FE30}-\\u{FE4F}" +
    "\\u{FF00}-\\u{FF60}\\u{FFE0}-\\u{FFE6}\\u{20000}-\\u{3FFFD}]" +
    "|\\p{Emoji_Presentation}",
  "u",
);
const ZERO_WIDTH_POINT = /[\r\p{M}\p{Cf}\u0000-\u001f\u007f-\u009f]/u;
/** ECMAScript-visible whitespace a line may start with; only plain spaces indent code. */
const LEADING_WHITESPACE = /^[\p{White_Space}\p{Cc}\ufeff]*/u;

/** Depth-first visit without recursion — the checker obeys its own no-recursion rule. */
function forEachNode(root: ts.Node, visit: (node: ts.Node) => void): void {
  const stack: ts.Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    visit(node);
    node.forEachChild((child) => {
      stack.push(child);
    });
  }
}

function violate(ctx: Ctx, pos: number, rule: RuleId, message: string): void {
  const line = ctx.sf.getLineAndCharacterOfPosition(pos).line + 1;
  ctx.out.push({ file: ctx.file, line, rule, message });
}

function insideSpan(spans: Span[], pos: number): boolean {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid];
    if (span === undefined) break;
    if (pos < span.start) {
      hi = mid - 1;
      continue;
    }
    if (pos >= span.end) {
      lo = mid + 1;
      continue;
    }
    return true;
  }
  return false;
}

interface LiteralSpans {
  /** Every literal token, regexes included — the comment-scanner resync set. */
  readonly all: Span[];
  /** String/template CONTENT interiors only — the fixture-exemption set. */
  readonly exempt: Span[];
}

/**
 * Spans of string/template/regex tokens as the PARSER saw them. The exempt
 * set trims each token to its content interior: delimiters are code, code
 * after a closing delimiter is code, and a regex is code end to end.
 */
function collectLiteralSpans(sf: ts.SourceFile): LiteralSpans {
  const all: Span[] = [];
  const exempt: Span[] = [];
  forEachNode(sf, (node) => {
    if (!LITERAL_KINDS.has(node.kind)) return;
    const start = node.getStart(sf);
    all.push({ start, end: node.end });
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) return;
    const opensSubstitution =
      node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle;
    const closerChars = opensSubstitution ? 2 : 1;
    exempt.push({ start: start + 1, end: Math.max(start + 1, node.end - closerChars) });
  });
  const byStart = (a: Span, b: Span): number => a.start - b.start;
  all.sort(byStart);
  exempt.sort(byStart);
  return { all, exempt };
}

/**
 * Comment spans, found with the scanner but resynchronized at every literal
 * token the parser recognized: template/string/regex CONTENT can never open a
 * fake comment, so a suppression directive inside a fixture string stays data.
 */
function collectCommentSpans(text: string, literals: Span[]): Span[] {
  const variant = ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, variant, text);
  const out: Span[] = [];
  let next = 0;
  while (true) {
    const kind = scanner.scan();
    if (kind === ts.SyntaxKind.EndOfFileToken) break;
    const start = scanner.getTokenStart();
    while (next < literals.length && literals[next]!.end <= start) next += 1;
    const literal = literals[next];
    if (literal !== undefined && start >= literal.start) {
      scanner.resetTokenState(literal.end);
      next += 1;
      continue;
    }
    const isComment =
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia;
    if (isComment) out.push({ start, end: scanner.getTokenEnd() });
  }
  return out;
}

function checkLineTabs(ctx: Ctx, line: string, lineStart: number, exempt: Span[]): void {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== "\t") continue;
    if (insideSpan(exempt, lineStart + i)) continue;
    violate(ctx, lineStart, "no-tabs", "tab character (indent with 2 spaces)");
    return;
  }
}

function checkLineIndent(ctx: Ctx, line: string, lineStart: number): void {
  let body = line;
  if (lineStart === 0) body = body.replace(/^\ufeff/, "");
  const match = LEADING_WHITESPACE.exec(body);
  const indent = match === null ? "" : match[0];
  const exotic = /[^ \t]/.exec(indent);
  if (exotic !== null) {
    const point = exotic[0].codePointAt(0) ?? 0;
    const hex = point.toString(16).toUpperCase().padStart(4, "0");
    violate(ctx, lineStart, "indent", `U+${hex} in indentation (indent with 2 spaces)`);
    return;
  }
  if (indent.length === body.length) return;
  if (indent.includes("\t")) return;
  if (indent.length % 2 === 1) {
    violate(ctx, lineStart, "indent", `${indent.length}-space indent is not a multiple of 2`);
  }
}

/** The normative display width of one code point — see the metric comment on WIDE_POINT. */
function codePointWidth(point: string): number {
  if (ZERO_WIDTH_POINT.test(point)) return 0;
  if (WIDE_POINT.test(point)) return 2;
  return 1;
}

function checkLineWidth(ctx: Ctx, line: string, lineStart: number, exempt: Span[]): void {
  let columns = 0;
  let offset = 0;
  let overflowIsCode = false;
  for (const point of line) {
    columns += codePointWidth(point);
    if (columns > MAX_LINE_COLUMNS) {
      if (!insideSpan(exempt, lineStart + offset)) overflowIsCode = true;
    }
    offset += point.length;
  }
  if (overflowIsCode) {
    const msg = `line is ${columns} columns (max ${MAX_LINE_COLUMNS})`;
    violate(ctx, lineStart, "line-length", msg);
  }
}

function checkLines(ctx: Ctx, exempt: Span[], comments: Span[]): void {
  const starts = ctx.sf.getLineStarts();
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]!;
    const rawEnd = i + 1 < starts.length ? starts[i + 1]! : ctx.text.length;
    const line = ctx.text.slice(start, rawEnd).replace(/[\n\r\u2028\u2029]+$/, "");
    checkLineWidth(ctx, line, start, exempt);
    checkLineTabs(ctx, line, start, exempt);
    if (insideSpan(exempt, start)) continue;
    if (insideSpan(comments, start)) continue;
    checkLineIndent(ctx, line, start);
  }
}

function checkTsEscapes(ctx: Ctx, comments: Span[]): void {
  for (const span of comments) {
    const body = ctx.text.slice(span.start, span.end);
    for (const hit of body.matchAll(TS_ESCAPE)) {
      violate(ctx, span.start + (hit.index ?? 0), "no-ts-escape", `${hit[0]} is banned`);
    }
  }
}

function asFunctionNode(node: ts.Node): FunctionNode | undefined {
  switch (node.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.Constructor:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor: {
      const fn = node as FunctionNode;
      return fn.body === undefined ? undefined : fn;
    }
    default:
      return undefined;
  }
}

/** Suite-registration callbacks (`describe(...)`) group tests; they are not logic. */
function isDescribeCallback(fn: FunctionNode): boolean {
  const parent = fn.parent;
  if (!ts.isCallExpression(parent)) return false;
  const reg = registrationOf(parent);
  return reg !== undefined && reg.kind === "describe" && reg.callback === fn;
}

function checkFunctionLength(ctx: Ctx, fn: FunctionNode): void {
  if (isDescribeCallback(fn)) return;
  const startLine = ctx.sf.getLineAndCharacterOfPosition(fn.getStart(ctx.sf)).line;
  const endLine = ctx.sf.getLineAndCharacterOfPosition(fn.end).line;
  const lines = endLine - startLine + 1;
  if (lines > MAX_FUNCTION_LINES) {
    const msg = `function spans ${lines} lines (max ${MAX_FUNCTION_LINES})`;
    violate(ctx, fn.getStart(ctx.sf), "func-length", msg);
  }
}

function checkNestedTernary(ctx: Ctx, node: ts.ConditionalExpression): void {
  for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
    if (ts.isConditionalExpression(p)) {
      violate(ctx, node.getStart(ctx.sf), "no-nested-ternary", "ternary nested inside a ternary");
      return;
    }
  }
}

function checkIfBraces(ctx: Ctx, node: ts.IfStatement): void {
  const lineOf = (pos: number): number => ctx.sf.getLineAndCharacterOfPosition(pos).line;
  const thenStmt = node.thenStatement;
  if (!ts.isBlock(thenStmt) && lineOf(thenStmt.end) !== lineOf(node.getStart(ctx.sf))) {
    violate(ctx, thenStmt.getStart(ctx.sf), "if-braces", "multiline if body must be braced");
  }
  const elseStmt = node.elseStatement;
  if (elseStmt === undefined || ts.isBlock(elseStmt)) return;
  if (ts.isIfStatement(elseStmt)) {
    const msg = "`else if` is banned; use `else { if (...) { ... } }`";
    violate(ctx, elseStmt.getStart(ctx.sf), "if-braces", msg);
    return;
  }
  const elseKeyword = node.getChildren(ctx.sf).find((c) => c.kind === ts.SyntaxKind.ElseKeyword);
  const anchor = elseKeyword === undefined ? node.getStart(ctx.sf) : elseKeyword.getStart(ctx.sf);
  if (lineOf(elseStmt.end) !== lineOf(anchor)) {
    violate(ctx, elseStmt.getStart(ctx.sf), "if-braces", "multiline else body must be braced");
  }
}

/**
 * A catch handles an error only when some statement does real work: empty
 * statements, labels around them, and structurally empty nested blocks are
 * vacuous. Walked with an explicit stack — no-recursion binds us too.
 */
function hasSubstantiveStatement(block: ts.Block): boolean {
  const stack: ts.Statement[] = [...block.statements];
  while (stack.length > 0) {
    const stmt = stack.pop();
    if (stmt === undefined) break;
    if (ts.isEmptyStatement(stmt)) continue;
    if (ts.isBlock(stmt)) {
      stack.push(...stmt.statements);
      continue;
    }
    if (ts.isLabeledStatement(stmt)) {
      stack.push(stmt.statement);
      continue;
    }
    return true;
  }
  return false;
}

function checkEmptyCatch(ctx: Ctx, node: ts.CatchClause): void {
  if (hasSubstantiveStatement(node.block)) return;
  violate(ctx, node.getStart(ctx.sf), "no-empty-catch", "empty catch block swallows errors");
}

/** Strip parentheses and unary +/- down to the core operand: `+(-(0x0))` -> `0x0`. */
function unwrapSignedOperand(expr: ts.Expression): ts.Expression {
  let node: ts.Expression = expr;
  // Terminates: every step descends into a strictly smaller subexpression.
  while (true) {
    if (ts.isParenthesizedExpression(node)) {
      node = node.expression;
      continue;
    }
    if (!ts.isPrefixUnaryExpression(node)) return node;
    if (node.operator !== ts.SyntaxKind.PlusToken && node.operator !== ts.SyntaxKind.MinusToken) {
      return node;
    }
    node = node.operand;
  }
}

function checkOrZero(ctx: Ctx, node: ts.BinaryExpression): void {
  const op = node.operatorToken.kind;
  if (op !== ts.SyntaxKind.BarToken && op !== ts.SyntaxKind.BarEqualsToken) return;
  const zero = (e: ts.Expression): boolean => {
    const core = unwrapSignedOperand(e);
    return ts.isNumericLiteral(core) && Number(core.text) === 0;
  };
  if (!zero(node.right) && !zero(node.left)) return;
  const msg = "`| 0` integer coercion is banned (use Math.trunc or Math.floor)";
  violate(ctx, node.getStart(ctx.sf), "no-or-zero", msg);
}

/*
 * no-recursion — binding-identity analysis. Every function node is a graph
 * vertex of its own, so two same-named helpers in disjoint scopes can never
 * merge into a synthetic cycle. Names resolve through the lexical scope
 * chain (parameters, blocks, catch clauses, and destructuring all shadow),
 * const aliases are followed with a cycle guard, and `this`/class member
 * uses resolve to the concrete method or accessor where statically known.
 */

type MemberAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

/** How a member is used; getters answer reads and calls, setters answer writes. */
type MemberUse = "call" | "value" | "read" | "write";

type ValueTarget =
  | { readonly kind: "fn"; readonly fn: FunctionNode }
  | { readonly kind: "class"; readonly cls: ts.ClassLikeDeclaration };

/** What a declaration makes of a name: a known target, an alias to chase, or opaque. */
type BindingSeed =
  | ValueTarget
  | { readonly kind: "alias"; readonly expr: ts.Expression }
  | { readonly kind: "import"; readonly module: string; readonly imported: string }
  | { readonly kind: "opaque" };

const OPAQUE: BindingSeed = { kind: "opaque" };

function unwrapParens(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

function isMemberAccess(node: ts.Node): node is MemberAccess {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

/** Does a binding name (possibly a nested destructuring pattern) introduce `name`? */
function patternBinds(pattern: ts.BindingName, name: string): boolean {
  const stack: ts.BindingName[] = [pattern];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    if (ts.isIdentifier(cur)) {
      if (cur.text === name) return true;
      continue;
    }
    for (const element of cur.elements) {
      if (ts.isBindingElement(element)) stack.push(element.name);
    }
  }
  return false;
}

/** Classify `const name = init`: a function, a class, or an alias carrying the value. */
function initSeed(decl: ts.VariableDeclaration): BindingSeed {
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list)) return OPAQUE;
  if ((list.flags & ts.NodeFlags.Const) === 0) return OPAQUE;
  if (decl.initializer === undefined) return OPAQUE;
  const value = unwrapParens(decl.initializer);
  if (ts.isArrowFunction(value)) return { kind: "fn", fn: value };
  if (ts.isFunctionExpression(value)) return { kind: "fn", fn: value };
  if (ts.isClassExpression(value)) return { kind: "class", cls: value };
  return { kind: "alias", expr: value };
}

/** The binding `name` gains from a var/let/const declaration list, if any. */
function listSeed(list: ts.VariableDeclarationList, name: string): BindingSeed | undefined {
  for (const decl of list.declarations) {
    if (!patternBinds(decl.name, name)) continue;
    if (ts.isIdentifier(decl.name)) return initSeed(decl);
    return OPAQUE;
  }
  return undefined;
}

/** The specifier inside an import clause that binds `name`, if any. */
function namedImportSeed(
  clause: ts.ImportClause,
  name: string,
  from: string,
): BindingSeed | undefined {
  if (clause.name?.text === name) return { kind: "import", module: from, imported: "default" };
  const bindings = clause.namedBindings;
  if (bindings === undefined) return undefined;
  if (ts.isNamespaceImport(bindings)) {
    if (bindings.name.text === name) return { kind: "import", module: from, imported: "*" };
    return undefined;
  }
  for (const specifier of bindings.elements) {
    if (specifier.name.text !== name) continue;
    if (specifier.isTypeOnly) return OPAQUE;
    const imported = specifier.propertyName?.text ?? specifier.name.text;
    return { kind: "import", module: from, imported };
  }
  return undefined;
}

/** The binding an import statement gives `name`: its origin module and exported name. */
function importSeed(stmt: ts.Statement, name: string): BindingSeed | undefined {
  if (ts.isImportEqualsDeclaration(stmt)) {
    return stmt.name.text === name ? OPAQUE : undefined;
  }
  if (!ts.isImportDeclaration(stmt)) return undefined;
  const clause = stmt.importClause;
  if (clause === undefined) return undefined;
  if (!ts.isStringLiteral(stmt.moduleSpecifier)) return undefined;
  const named = namedImportSeed(clause, name, stmt.moduleSpecifier.text);
  if (named === undefined) return undefined;
  return clause.isTypeOnly ? OPAQUE : named;
}

/** The binding `name` gains if `stmt` declares it in the surrounding scope. */
function statementSeed(stmt: ts.Statement, name: string): BindingSeed | undefined {
  if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
    if (stmt.body === undefined) return OPAQUE;
    return { kind: "fn", fn: stmt };
  }
  if (ts.isClassDeclaration(stmt) && stmt.name?.text === name) return { kind: "class", cls: stmt };
  if (ts.isVariableStatement(stmt)) return listSeed(stmt.declarationList, name);
  if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) {
    return importSeed(stmt, name);
  }
  if (ts.isEnumDeclaration(stmt) && stmt.name.text === name) return OPAQUE;
  if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name) && stmt.name.text === name) {
    return OPAQUE;
  }
  return undefined;
}

/** Parameter shadowing plus a named function expression's self-binding. */
function functionScopeSeed(fn: FunctionNode, name: string): BindingSeed | undefined {
  for (const param of fn.parameters) {
    if (patternBinds(param.name, name)) return OPAQUE;
  }
  if (ts.isFunctionExpression(fn) && fn.name?.text === name) return { kind: "fn", fn };
  return undefined;
}

/** The statement list a block-like scope owns, if `node` is one. */
function scopeStatements(node: ts.Node): readonly ts.Statement[] | undefined {
  if (ts.isBlock(node)) return node.statements;
  if (ts.isSourceFile(node)) return node.statements;
  if (ts.isModuleBlock(node)) return node.statements;
  if (ts.isCaseBlock(node)) return node.clauses.flatMap((clause) => [...clause.statements]);
  return undefined;
}

function isForLike(
  node: ts.Node,
): node is ts.ForStatement | ts.ForInStatement | ts.ForOfStatement {
  if (ts.isForStatement(node)) return true;
  if (ts.isForInStatement(node)) return true;
  return ts.isForOfStatement(node);
}

/** The binding `name` resolves to if `node` is a scope that declares it. */
function scopeSeed(node: ts.Node, name: string): BindingSeed | undefined {
  const fn = asFunctionNode(node);
  if (fn !== undefined) return functionScopeSeed(fn, name);
  if (ts.isCatchClause(node)) {
    const decl = node.variableDeclaration;
    if (decl !== undefined && patternBinds(decl.name, name)) return OPAQUE;
    return undefined;
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    if (node.name?.text === name) return { kind: "class", cls: node };
    return undefined;
  }
  if (isForLike(node)) {
    const init = node.initializer;
    if (init !== undefined && ts.isVariableDeclarationList(init)) return listSeed(init, name);
    return undefined;
  }
  const statements = scopeStatements(node);
  if (statements === undefined) return undefined;
  for (const stmt of statements) {
    const seed = statementSeed(stmt, name);
    if (seed !== undefined) return seed;
  }
  return undefined;
}

/** Resolve `name` from `use` outward through the lexical scope chain. */
function resolveName(use: ts.Node, name: string): BindingSeed | undefined {
  for (let p: ts.Node | undefined = use.parent; p !== undefined; p = p.parent) {
    const seed = scopeSeed(p, name);
    if (seed !== undefined) return seed;
  }
  return undefined;
}

interface ThisCtx {
  readonly cls: ts.ClassLikeDeclaration;
  readonly isStatic: boolean;
}

function hasStaticModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  if (modifiers === undefined) return false;
  return modifiers.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
}

function classCtxOf(node: ts.Node, isStatic: boolean): ThisCtx | undefined {
  if (ts.isClassDeclaration(node)) return { cls: node, isStatic };
  if (ts.isClassExpression(node)) return { cls: node, isStatic };
  return undefined;
}

/** The class `this` refers to at `node`, tracked through arrows only. */
function thisContext(node: ts.Node): ThisCtx | undefined {
  for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
    if (ts.isClassStaticBlockDeclaration(p)) return classCtxOf(p.parent, true);
    if (ts.isPropertyDeclaration(p)) return classCtxOf(p.parent, hasStaticModifier(p));
    const fn = asFunctionNode(p);
    if (fn === undefined) continue;
    if (ts.isArrowFunction(fn)) continue;
    if (ts.isFunctionDeclaration(fn)) return undefined;
    if (ts.isFunctionExpression(fn)) return undefined;
    return classCtxOf(fn.parent, hasStaticModifier(fn));
  }
  return undefined;
}

interface MemberKey {
  readonly text: string;
  readonly isPrivate: boolean;
}

/** The statically known member name of an access (computed names stay unknown). */
function memberKey(expr: MemberAccess): MemberKey | undefined {
  if (ts.isPropertyAccessExpression(expr)) {
    return { text: expr.name.text, isPrivate: ts.isPrivateIdentifier(expr.name) };
  }
  const argument = unwrapParens(expr.argumentExpression);
  if (ts.isStringLiteralLike(argument)) return { text: argument.text, isPrivate: false };
  return undefined;
}

/** The key a class member declares, if statically known. */
function declaredKey(name: ts.PropertyName | undefined): MemberKey | undefined {
  if (name === undefined) return undefined;
  if (ts.isPrivateIdentifier(name)) return { text: name.text, isPrivate: true };
  if (ts.isComputedPropertyName(name)) return undefined;
  return { text: name.text, isPrivate: false };
}

/** The function a member declaration contributes for a given use, if any. */
function memberFunction(member: ts.ClassElement, use: MemberUse): FunctionNode | undefined {
  if (ts.isGetAccessorDeclaration(member)) {
    if (use === "write") return undefined;
    if (use === "value") return undefined;
    return member.body === undefined ? undefined : member;
  }
  if (ts.isSetAccessorDeclaration(member)) {
    if (use !== "write") return undefined;
    return member.body === undefined ? undefined : member;
  }
  if (use === "read") return undefined;
  if (use === "write") return undefined;
  if (ts.isMethodDeclaration(member)) return member.body === undefined ? undefined : member;
  if (ts.isPropertyDeclaration(member) && member.initializer !== undefined) {
    const value = unwrapParens(member.initializer);
    if (ts.isArrowFunction(value)) return value;
    if (ts.isFunctionExpression(value)) return value;
  }
  return undefined;
}

/** The class member function `key` resolves to on the instance or static side. */
function memberTarget(
  cls: ts.ClassLikeDeclaration,
  key: MemberKey,
  wantStatic: boolean,
  use: MemberUse,
): FunctionNode | undefined {
  for (const member of cls.members) {
    const declared = declaredKey(member.name);
    if (declared === undefined) continue;
    if (declared.text !== key.text) continue;
    if (declared.isPrivate !== key.isPrivate) continue;
    if (hasStaticModifier(member) !== wantStatic) continue;
    const fn = memberFunction(member, use);
    if (fn !== undefined) return fn;
  }
  return undefined;
}

/** Follow const aliases from an identifier to a class declaration, cycle-guarded. */
function resolveClassBinding(start: ts.Identifier): ts.ClassLikeDeclaration | undefined {
  const visited = new Set<ts.Node>();
  let cur: ts.Expression = start;
  while (!visited.has(cur)) {
    visited.add(cur);
    if (ts.isClassExpression(cur)) return cur;
    if (!ts.isIdentifier(cur)) return undefined;
    const seed = resolveName(cur, cur.text);
    if (seed === undefined) return undefined;
    if (seed.kind === "class") return seed.cls;
    if (seed.kind !== "alias") return undefined;
    cur = unwrapParens(seed.expr);
  }
  return undefined;
}

/** The function a `this.x` / `Class.x` member access resolves to, if statically known. */
function memberAccessTarget(access: MemberAccess, use: MemberUse): FunctionNode | undefined {
  const key = memberKey(access);
  if (key === undefined) return undefined;
  const base = unwrapParens(access.expression);
  if (base.kind === ts.SyntaxKind.ThisKeyword) {
    const ctx = thisContext(access);
    if (ctx === undefined) return undefined;
    return memberTarget(ctx.cls, key, ctx.isStatic, use);
  }
  if (!ts.isIdentifier(base)) return undefined;
  const cls = resolveClassBinding(base);
  if (cls === undefined) return undefined;
  return memberTarget(cls, key, true, use);
}

/**
 * Resolve an expression to a known function or class through const aliases,
 * cycle-guarded. A "call" downgrades to "value" across an alias hop: the
 * accessor fired when the alias was declared, not where the alias is called.
 */
function resolveValue(expr: ts.Expression, use: MemberUse): ValueTarget | undefined {
  const visited = new Set<ts.Node>();
  let mode = use;
  let cur = unwrapParens(expr);
  while (!visited.has(cur)) {
    visited.add(cur);
    if (ts.isArrowFunction(cur)) return { kind: "fn", fn: cur };
    if (ts.isFunctionExpression(cur)) return { kind: "fn", fn: cur };
    if (ts.isClassExpression(cur)) return { kind: "class", cls: cur };
    if (isMemberAccess(cur)) {
      const fn = memberAccessTarget(cur, mode);
      return fn === undefined ? undefined : { kind: "fn", fn };
    }
    if (!ts.isIdentifier(cur)) return undefined;
    const seed = resolveName(cur, cur.text);
    if (seed === undefined) return undefined;
    if (seed.kind === "fn") return seed;
    if (seed.kind === "class") return seed;
    if (seed.kind !== "alias") return undefined;
    if (mode === "call") mode = "value";
    cur = unwrapParens(seed.expr);
  }
  return undefined;
}

/** `f.call(...)` / `f.apply(...)`: the function `f` resolves to, if statically known. */
function callApplyTarget(callee: MemberAccess): FunctionNode | undefined {
  const key = memberKey(callee);
  if (key === undefined) return undefined;
  if (key.isPrivate) return undefined;
  if (key.text !== "call" && key.text !== "apply") return undefined;
  const inner = unwrapParens(callee.expression);
  if (isMemberAccess(inner)) return memberAccessTarget(inner, "value");
  const target = resolveValue(inner, "value");
  if (target === undefined) return undefined;
  return target.kind === "fn" ? target.fn : undefined;
}

/** The statically known function a call invokes: direct, alias, member, or .call/.apply. */
function callTarget(call: ts.CallExpression): FunctionNode | undefined {
  const callee = unwrapParens(call.expression);
  if (isMemberAccess(callee)) {
    const invoked = callApplyTarget(callee);
    if (invoked !== undefined) return invoked;
    return memberAccessTarget(callee, "call");
  }
  const target = resolveValue(callee, "call");
  if (target === undefined) return undefined;
  return target.kind === "fn" ? target.fn : undefined;
}

function isIncDec(op: ts.SyntaxKind): boolean {
  if (op === ts.SyntaxKind.PlusPlusToken) return true;
  return op === ts.SyntaxKind.MinusMinusToken;
}

/** Whether a member access reads, writes, or both (compound assignment, ++/--). */
function accessUses(node: MemberAccess): MemberUse[] {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    const op = parent.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsToken) return ["write"];
    if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
      return ["read", "write"];
    }
  }
  if (ts.isPrefixUnaryExpression(parent) && isIncDec(parent.operator)) return ["read", "write"];
  if (ts.isPostfixUnaryExpression(parent) && isIncDec(parent.operator)) return ["read", "write"];
  return ["read"];
}

interface AccessorHit {
  readonly fn: FunctionNode;
  readonly action: "reads" | "writes";
}

/** Accessor invocations implied by a property read or write, where statically known. */
function accessorHits(access: MemberAccess): AccessorHit[] {
  const parent = access.parent;
  if (ts.isCallExpression(parent) && parent.expression === access) return [];
  if (ts.isDeleteExpression(parent)) return [];
  const hits: AccessorHit[] = [];
  for (const use of accessUses(access)) {
    const fn = memberAccessTarget(access, use);
    if (fn === undefined) continue;
    hits.push({ fn, action: use === "read" ? "reads" : "writes" });
  }
  return hits;
}

type CallGraph = Map<FunctionNode, Set<FunctionNode>>;

function addEdge(edges: CallGraph, source: FunctionNode, target: FunctionNode): void {
  const targets = edges.get(source) ?? new Set<FunctionNode>();
  targets.add(target);
  edges.set(source, targets);
}

/** The nearest enclosing executable function scope, if any. */
function enclosingFn(node: ts.Node): FunctionNode | undefined {
  for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
    const fn = asFunctionNode(p);
    if (fn !== undefined) return fn;
  }
  return undefined;
}

function nameText(name: ts.PropertyName): string {
  if (ts.isComputedPropertyName(name)) return "(computed)";
  return name.text;
}

/** A stable human name for a function identity in recursion messages. */
function displayName(fn: FunctionNode): string {
  if (ts.isConstructorDeclaration(fn)) return "constructor";
  if (ts.isGetAccessorDeclaration(fn)) return `get ${nameText(fn.name)}`;
  if (ts.isSetAccessorDeclaration(fn)) return `set ${nameText(fn.name)}`;
  if (ts.isMethodDeclaration(fn)) return nameText(fn.name);
  if (!ts.isArrowFunction(fn) && fn.name !== undefined) return fn.name.text;
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyDeclaration(parent)) return nameText(parent.name);
  return "(anonymous)";
}

/** Record one resolved call/access edge, flagging self-edges at the use site. */
function recordRecursionEdge(
  ctx: Ctx,
  edges: CallGraph,
  site: ts.Node,
  target: FunctionNode,
  action: string,
): void {
  const source = enclosingFn(site);
  if (source === undefined) return;
  if (source !== target) {
    addEdge(edges, source, target);
    return;
  }
  const msg = `"${displayName(target)}" ${action} itself directly`;
  violate(ctx, site.getStart(ctx.sf), "no-recursion", msg);
}

/** Resolve every call and member access into the file-local recursion graph. */
function buildRecursionGraph(
  ctx: Ctx,
  calls: readonly ts.CallExpression[],
  accesses: readonly MemberAccess[],
): CallGraph {
  const edges: CallGraph = new Map();
  for (const call of calls) {
    const target = callTarget(call);
    if (target === undefined) continue;
    recordRecursionEdge(ctx, edges, call, target, "calls");
  }
  for (const access of accesses) {
    for (const hit of accessorHits(access)) {
      recordRecursionEdge(ctx, edges, access, hit.fn, hit.action);
    }
  }
  return edges;
}

/** Function identities reachable from `start` by one or more edges (iterative BFS). */
function reachableFrom(start: FunctionNode, edges: CallGraph): Set<FunctionNode> {
  const seen = new Set<FunctionNode>();
  const queue: FunctionNode[] = [...(edges.get(start) ?? [])];
  while (queue.length > 0) {
    const cur = queue.pop();
    if (cur === undefined || seen.has(cur)) continue;
    seen.add(cur);
    for (const next of edges.get(cur) ?? []) queue.push(next);
  }
  return seen;
}

/** Indirect recursion: cycles of length >= 2 among function identities. */
function checkRecursionCycles(ctx: Ctx, edges: CallGraph): void {
  const reach = new Map<FunctionNode, Set<FunctionNode>>();
  for (const node of edges.keys()) reach.set(node, reachableFrom(node, edges));
  for (const [node, r] of reach) {
    if (!r.has(node)) continue;
    const members = [...r].filter((m) => reach.get(m)?.has(node) === true);
    if (members.length < 2) continue;
    const names = members.map(displayName).sort();
    const msg = `"${displayName(node)}" is in a recursion cycle (${names.join(" -> ")})`;
    violate(ctx, node.getStart(ctx.sf), "no-recursion", msg);
  }
}

/**
 * Follow lexical const aliases from an expression to its terminal value
 * expression, cycle-guarded. Non-const bindings, shadows, and alias cycles
 * stop the walk at the identifier itself, which callers must refuse — fail
 * closed for timeouts, "not a probe / not a registration" for gates.
 */
function followConstAliases(expr: ts.Expression): ts.Expression {
  const visited = new Set<ts.Node>();
  let cur = unwrapParens(expr);
  while (!visited.has(cur)) {
    visited.add(cur);
    if (!ts.isIdentifier(cur)) return cur;
    const seed = resolveName(cur, cur.text);
    if (seed === undefined || seed.kind !== "alias") return cur;
    cur = unwrapParens(seed.expr);
  }
  return cur;
}

/** test/it register tests; describe registers suites; other exports never register. */
function canonicalBunKind(name: string): RegistrationKind | undefined {
  if (name === "test" || name === "it") return "test";
  if (name === "describe") return "describe";
  return undefined;
}

/**
 * Resolve an expression to the bun:test binding it denotes: a direct import,
 * an immutable const alias, or one namespace member hop (`bt.test`). Anything
 * not bottoming out at an actual value import from bun:test is refused, so a
 * shadowed test/it/describe never registers and never earns exemptions.
 */
function bunKindOfExpression(expr: ts.Expression): BunTestKind | undefined {
  let terminal = followConstAliases(expr);
  let member: string | undefined;
  if (isMemberAccess(terminal)) {
    const key = memberKey(terminal);
    if (key === undefined || key.isPrivate) return undefined;
    member = key.text;
    terminal = followConstAliases(terminal.expression);
  }
  if (!ts.isIdentifier(terminal)) return undefined;
  const seed = resolveName(terminal, terminal.text);
  if (seed === undefined || seed.kind !== "import") return undefined;
  if (seed.module !== BUN_TEST_MODULE) return undefined;
  if (seed.imported === "*") {
    return member === undefined ? "namespace" : canonicalBunKind(member);
  }
  return member === undefined ? canonicalBunKind(seed.imported) : undefined;
}

interface CalleeChain {
  readonly kind: RegistrationKind;
  readonly gates: readonly ts.Expression[];
}

/**
 * Classify a registration callee: a bun:test test/it/describe binding — or a
 * bun:test namespace member — followed only by known modifier links, e.g.
 * test.skipIf(cond), suite["todoIf"](c), bt.describe.each(rows). The gates
 * are the arguments of .if/.skipIf links only: .each rows and other modifier
 * arguments are data, never gates. Anything else is not a registration.
 */
function classifyCallee(expr: ts.Expression): CalleeChain | undefined {
  const gates: ts.Expression[] = [];
  const members: string[] = [];
  let cur: ts.Expression = expr;
  // Terminates: every step descends into a strictly smaller subexpression.
  while (true) {
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isCallExpression(cur)) {
      const callee = unwrapParens(cur.expression);
      if (!isMemberAccess(callee)) return undefined;
      const key = memberKey(callee);
      if (key === undefined || key.isPrivate) return undefined;
      if (key.text === "if" || key.text === "skipIf") gates.push(...cur.arguments);
      cur = cur.expression;
      continue;
    }
    if (isMemberAccess(cur)) {
      const key = memberKey(cur);
      if (key === undefined || key.isPrivate) return undefined;
      members.push(key.text);
      cur = cur.expression;
      continue;
    }
    break;
  }
  if (!ts.isIdentifier(cur)) return undefined;
  const base = bunKindOfExpression(cur);
  if (base === undefined) return undefined;
  members.reverse();
  let kind: RegistrationKind | undefined = undefined;
  if (base === "namespace") {
    const first = members.shift();
    kind = first === undefined ? undefined : canonicalBunKind(first);
  } else {
    kind = base;
  }
  if (kind === undefined) return undefined;
  for (const member of members) {
    if (REGISTRATION_MODIFIERS[member] !== true) return undefined;
  }
  return { kind, gates };
}

/** A call whose result is invoked or member-accessed is a link, not a registration. */
function isChainLink(call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  // Terminates: every step ascends toward the source file root.
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.expression === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return true;
  return ts.isElementAccessExpression(parent) && parent.expression === node;
}

interface Registration {
  readonly kind: RegistrationKind;
  readonly callback: FunctionNode | undefined;
  readonly gates: readonly ts.Expression[];
}

/**
 * A test/it/describe registration call, resolved through actual bun:test
 * bindings. The call must head its modifier chain — `test.skipIf(c)` alone is
 * a link, not a registration — and the callback is argument 1 when present,
 * so test.todo("later") still registers for test-doc with no body to time.
 */
function registrationOf(call: ts.CallExpression): Registration | undefined {
  if (isChainLink(call)) return undefined;
  const chain = classifyCallee(call.expression);
  if (chain === undefined) return undefined;
  const second = call.arguments.length > 1 ? call.arguments[1] : undefined;
  const callback = second === undefined ? undefined : asFunctionNode(second);
  return { kind: chain.kind, callback, gates: chain.gates };
}

/**
 * Does this callee resolve to the runtime global Bun.which? The access may be
 * optional/bracket-spelled and reached through const aliases, but a lexically
 * shadowed `Bun` is not the runtime global and never counts.
 */
function isBunWhichCallee(expr: ts.Expression): boolean {
  const terminal = followConstAliases(expr);
  if (!isMemberAccess(terminal)) return false;
  const key = memberKey(terminal);
  if (key === undefined || key.isPrivate || key.text !== "which") return false;
  const object = followConstAliases(terminal.expression);
  if (!ts.isIdentifier(object) || object.text !== "Bun") return false;
  return resolveName(object, object.text) === undefined;
}

/** Is this identifier a value read (not the name slot of an access or property)? */
function isValueReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name !== id;
  if (ts.isPropertyAssignment(parent)) return parent.name !== id;
  return true;
}

/**
 * True when a gate expression consults an external binary: it contains — in
 * the AST, so string/template content never matches — a call to the global
 * Bun.which, reached directly or through lexically resolved immutable const
 * initializers, followed transitively with a visited-set cycle guard.
 */
function gateConsultsExternal(gate: ts.Expression): boolean {
  const visited = new Set<ts.Node>();
  const work: ts.Node[] = [gate];
  let found = false;
  while (work.length > 0 && !found) {
    const root = work.pop();
    if (root === undefined) break;
    forEachNode(root, (node) => {
      if (found) return;
      if (ts.isCallExpression(node) && isBunWhichCallee(node.expression)) {
        found = true;
        return;
      }
      if (!ts.isIdentifier(node) || !isValueReference(node)) return;
      const seed = resolveName(node, node.text);
      if (seed === undefined || seed.kind !== "alias") return;
      if (visited.has(seed.expr)) return;
      visited.add(seed.expr);
      work.push(seed.expr);
    });
  }
  return found;
}

/** Is this call registered under a describe whose if/skipIf gate probes Bun.which? */
function inGatedDescribe(call: ts.CallExpression): boolean {
  for (let p: ts.Node | undefined = call.parent; p !== undefined; p = p.parent) {
    const fn = asFunctionNode(p);
    if (fn === undefined) continue;
    const parent = fn.parent;
    if (!ts.isCallExpression(parent)) continue;
    const reg = registrationOf(parent);
    if (reg === undefined || reg.kind !== "describe") continue;
    if (reg.callback !== fn) continue;
    if (reg.gates.some(gateConsultsExternal)) return true;
  }
  return false;
}

/**
 * A timeout value is an inline finite safe numeric literal, or a lexical
 * immutable const alias resolving transitively to one. Mutable, computed,
 * shadowed, imported, and non-finite spellings are refused — fail closed.
 */
function timeoutValueOk(expr: ts.Expression): boolean {
  const terminal = followConstAliases(expr);
  if (!ts.isNumericLiteral(terminal)) return false;
  return Number.isSafeInteger(Number(terminal.text));
}

/** { timeout: v }, { "timeout": v }, and shorthand { timeout } with a valid value. */
function timeoutPropertyOk(property: ts.ObjectLiteralElementLike): boolean {
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name.text === "timeout" && timeoutValueOk(property.name);
  }
  if (!ts.isPropertyAssignment(property)) return false;
  const name = property.name;
  const isTimeout =
    (ts.isIdentifier(name) && name.text === "timeout") ||
    (ts.isStringLiteral(name) && name.text === "timeout");
  return isTimeout && timeoutValueOk(property.initializer);
}

/** The options object must be inline — an aliased object's fields stay mutable. */
function hasNumericTimeout(call: ts.CallExpression): boolean {
  const arg = call.arguments[2];
  if (arg === undefined) return false;
  if (timeoutValueOk(arg)) return true;
  const options = unwrapParens(arg);
  if (!ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some(timeoutPropertyOk);
}

function checkTestTimeout(ctx: Ctx, call: ts.CallExpression): void {
  const reg = registrationOf(call);
  if (reg === undefined || reg.kind !== "test") return;
  if (reg.callback === undefined) return;
  const gated = reg.gates.some(gateConsultsExternal) || inGatedDescribe(call);
  if (!gated || hasNumericTimeout(call)) return;
  const msg = "external-process-gated test needs an explicit numeric timeout";
  violate(ctx, call.getStart(ctx.sf), "test-timeout", msg);
}

/** The first content position after an optional BOM and an optional shebang line. */
function contentStart(text: string): number {
  let pos = 0;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;
  if (text.startsWith("#!", pos)) {
    const lineEnd = text.indexOf("\n", pos);
    pos = lineEnd < 0 ? text.length : lineEnd + 1;
  }
  while (pos < text.length && /\s/.test(text.charAt(pos))) pos += 1;
  return pos;
}

/**
 * Nonempty prose after `marker` inside a JSDoc body, up to the next section
 * marker or the closing delimiter. Leading `*` gutters are not prose.
 */
function docSectionNonempty(body: string, marker: string): boolean {
  const at = body.indexOf(marker);
  if (at < 0) return false;
  const from = at + marker.length;
  let end = body.length - 2;
  for (const boundary of ["Goal:", "Method:"]) {
    const next = body.indexOf(boundary, from);
    if (next >= 0 && next < end) end = next;
  }
  const prose = body.slice(from, Math.max(from, end)).replace(/^\s*\*/gm, "");
  return /\S/.test(prose);
}

/**
 * *.test.ts files must OPEN with the goal+method doc: the first content after
 * an optional BOM/shebang is a JSDoc whose Goal: and Method: sections are
 * nonempty. Enforced only when the file registers bun:test tests or suites —
 * todo/skip registrations without callbacks still count.
 */
function checkTestDoc(ctx: Ctx, comments: Span[]): void {
  if (!ctx.file.endsWith(".test.ts")) return;
  let firstReg: number | undefined;
  forEachNode(ctx.sf, (node) => {
    if (!ts.isCallExpression(node) || registrationOf(node) === undefined) return;
    const start = node.getStart(ctx.sf);
    if (firstReg === undefined || start < firstReg) firstReg = start;
  });
  if (firstReg === undefined) return;
  const opening = comments.find((span) => span.start === contentStart(ctx.text));
  const body = opening === undefined ? "" : ctx.text.slice(opening.start, opening.end);
  if (body.startsWith("/**")) {
    if (docSectionNonempty(body, "Goal:") && docSectionNonempty(body, "Method:")) return;
  }
  const msg = "test file must open with a JSDoc stating nonempty Goal: and Method: sections";
  violate(ctx, firstReg, "test-doc", msg);
}

function dispatchNode(ctx: Ctx, node: ts.Node): void {
  if (node.kind === ts.SyntaxKind.AnyKeyword) {
    violate(ctx, node.getStart(ctx.sf), "no-any", "the `any` type is banned");
    return;
  }
  if (ts.isConditionalExpression(node)) {
    checkNestedTernary(ctx, node);
    return;
  }
  if (ts.isIfStatement(node)) {
    checkIfBraces(ctx, node);
    return;
  }
  if (ts.isCatchClause(node)) {
    checkEmptyCatch(ctx, node);
    return;
  }
  if (ts.isBinaryExpression(node)) {
    checkOrZero(ctx, node);
    return;
  }
  if (ts.isCallExpression(node)) {
    checkTestTimeout(ctx, node);
    return;
  }
  const fn = asFunctionNode(node);
  if (fn !== undefined) checkFunctionLength(ctx, fn);
}

function checkAst(ctx: Ctx): void {
  const calls: ts.CallExpression[] = [];
  const accesses: MemberAccess[] = [];
  forEachNode(ctx.sf, (node) => {
    dispatchNode(ctx, node);
    if (ts.isCallExpression(node)) calls.push(node);
    if (isMemberAccess(node)) accesses.push(node);
  });
  checkRecursionCycles(ctx, buildRecursionGraph(ctx, calls, accesses));
}

/** Analyze one source text. Exported for tests; the CLI feeds it real files. */
export function analyzeSource(fileName: string, text: string): StyleViolation[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const ctx: Ctx = { sf, file: fileName, text, out: [] };
  const literals = collectLiteralSpans(sf);
  const comments = collectCommentSpans(text, literals.all);
  checkLines(ctx, literals.exempt, comments);
  checkTsEscapes(ctx, comments);
  checkTestDoc(ctx, comments);
  checkAst(ctx);
  return ctx.out.sort((a, b) => a.line - b.line);
}

/**
 * Every .ts file under src/, test/, scripts/ — the roots are the complete
 * scope, with no subdirectory allowlists: whatever a root reaches is checked.
 * Fails closed: a missing or non-directory rootDir, a non-directory source
 * root, or a rootDir holding no source root at all is an error — never an
 * empty (vacuously clean) result.
 */
export function collectSourceFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) {
    throw new Error(`${rootDir} does not exist — pass the beam repo root`);
  }
  if (!statSync(rootDir).isDirectory()) {
    throw new Error(`${rootDir} is not a directory — pass the beam repo root`);
  }
  const files: string[] = [];
  const stack: string[] = [];
  for (const root of SOURCE_ROOTS) {
    const dir = join(rootDir, root);
    if (!existsSync(dir)) continue;
    if (!statSync(dir).isDirectory()) {
      throw new Error(`${dir} must be a directory for the style gate to scan it`);
    }
    stack.push(dir);
  }
  if (stack.length === 0) {
    throw new Error(`no ${SOURCE_ROOTS.join("/")} under ${rootDir} — pass the beam repo root`);
  }
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".ts")) files.push(path);
    }
  }
  return files.sort();
}

export function runCheck(rootDir: string): StyleViolation[] {
  const violations: StyleViolation[] = [];
  for (const file of collectSourceFiles(rootDir)) {
    violations.push(...analyzeSource(relative(rootDir, file), readFileSync(file, "utf8")));
  }
  return violations;
}

export function formatViolation(v: StyleViolation): string {
  return `${v.file}:${v.line} [${v.rule}] ${v.message}`;
}

if (import.meta.main) {
  try {
    const violations = runCheck(process.argv[2] ?? ".");
    for (const v of violations) console.log(formatViolation(v));
    if (violations.length > 0) {
      console.error(`check-style: ${violations.length} hard violation(s)`);
      process.exit(1);
    }
    console.error("check-style: clean");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`check-style: ${message}`);
    process.exit(1);
  }
}
