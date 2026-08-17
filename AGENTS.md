# AGENTS.md — beam

beam hands a live coding-agent session (omp, pi, Claude Code, Codex) to a remote
sandboxed server and brings it back. Read `docs/DESIGN.md` before structural
changes. These rules are mandatory for all contributions, human or agent.

## Architecture in one breath

Four seams, all small interfaces — extend by implementing, never by widening
callers:

- `src/session/` — **SessionAdapter**: locate a harness session for a cwd,
  install it on a target, produce the resume command, collect the grown
  transcript back. One adapter per harness.
- `src/provider/` — **SandboxProvider**: the lifecycle above a transport —
  provision/connect/destroy yielding a Transport. ssh/local are the trivial
  `StaticProvider`; `agent-sandbox` owns one SandboxClaim per handoff record
  (created if absent, pod re-resolved from the claim on every command,
  deleted only on the successful purge path).
- `src/transport/` — **Transport**: exec via `bash -lc`, sync up/down,
  send/fetch file. `ssh` is the production remote; `kubectl` reaches an
  Agent Sandbox pod (tar streams over exec, every argv pins
  context/namespace/kubeconfig); `local` is the hermetic test double and
  must stay behaviorally equivalent (same `~/` semantics).
- `src/runtime/` — where the remote agent process lives (herdr).

Commands (`src/commands/`) orchestrate the seams through the provider — no
target-type branching outside the seams — and own the handoff record
lifecycle (`up → down/killed`) in `src/state.ts`.

## Commands

```bash
bun test              # full suite, includes the live herdr round trip
bunx tsc --noEmit     # strict typecheck — zero errors, always
bun run style         # Tiger Style gate — limits and forbidden forms
bun src/cli.ts …      # run the CLI from source
```

All three gates must be green before any push. CI runs them on ubuntu AND
macos.

## TypeScript rules

1. **Zero runtime dependencies.** Bun builtins and `node:` modules only.
   Adding a dependency is an architecture decision, not a convenience.
2. **Strict TS is the floor**: no `any`, no `@ts-ignore`/`@ts-expect-error`
   in `src/`. Non-null `!` only where the invariant is provable on the
   adjacent lines (e.g. right after a length check).
3. **ESM with explicit `.ts` extensions**; `import type` for types
   (`verbatimModuleSyntax` enforces it).
4. **Prefer Bun natives** over shelling out or hand-rolling: `Bun.spawn`,
   `Bun.Glob`, `Bun.sleep`, `Bun.which`, `Bun.file`.
5. **No one-expression wrapper functions.** Inline it unless the name is a
   durable domain concept, has 3+ lockstep call sites, or names a non-obvious
   formula (`shq`, `claudeProjectSlug` qualify; `isEmpty(s)` does not).
6. **`Record` for small static tables; `Set`/`Map` for runtime collections.**
7. **`Promise.withResolvers()`** instead of the `new Promise(executor)` dance;
   for plain delays use `Bun.sleep`.
8. **Errors carry the fix**: throw `Error` with an actionable message
   (what failed, what to run instead). The CLI catches once at the top of
   `src/cli.ts` and exits 1 — no scattered `process.exit`.
9. **Child processes never fail silently**: use `runChecked` (stderr in the
   error) or explicitly inspect `code`.

## Security invariants (load-bearing — review like money code)

- Every string reaching a remote shell goes through `shq`/`shjoin`/
  `shqRemotePath` (`src/util/shell.ts`). Never interpolate raw input into a
  command. A leading `~/` must survive quoting — that is `shqRemotePath`'s
  whole job.
- `syncDown` must never delete local files unless the user passes `--delete`.
- Destructive remote operations (`kill --purge`) guard their paths before
  `rm -rf`.
- beam ships working trees as-is (secrets included, by design). Never widen
  what is shipped or where, silently.
- beam NEVER copies or ships harness credentials/auth state between machines.
  Authentication happens on the target through `beam login` (interactive over
  `ssh -t`); auth probes are best-effort detection, not a bypass.
- The transport credential is the blast radius. A new transport or sandbox
  provider MUST ship with least-privilege guidance (README) and `doctor`
  probes for its dangerous postures — an ssh transport probes root/sudo, a
  kubectl transport must refuse cluster-admin kubeconfigs, and so on.

## Testing rules

1. **Test behavior and contracts, not plumbing.** Every test defends an
   observable invariant that would fail on a plausible bug.
2. **Hermetic by construction**: point `BEAM_HOME`/`BEAM_DIR` at fixture
   directories. Touching the real `~/.omp`, `~/.claude`, `~/.codex`, or
   `~/.beam` in a test is a bug.
3. **No wall-clock timers in tests.** Await real signals. The one exception:
   bounded polling of a genuinely external process (the herdr e2e), justified
   with a comment.
4. **`describe.skipIf` for missing system deps** (herdr/rsync) — skip, never
   fail; CI installs them so nothing is skipped there.
5. **Never change a test's expectations to make it pass** — fix the code.
6. The e2e round trip (`test/e2e.test.ts`) is the merge gate: if it cannot
   prove up → remote work → down fidelity, the change does not ship.

## Beam Tiger Style (mandatory)

Adapted from TigerBeetle's `docs/TIGER_STYLE.md` (read 2026-08-09). Goal order
is safety, then performance, then developer experience. Every upstream rule
has exactly one disposition below — **adopt** (as written), **adapt** (with
the TypeScript/Bun reason), or **n/a** (with the reason). Rules already stated
above are cited, not repeated. `bun run style` gates the mechanical subset —
rule ids `line-length`, `func-length`, `no-recursion`, `no-nested-ternary`,
`if-braces`, `no-tabs`, `indent`, `no-any`, `no-ts-escape`, `no-empty-catch`,
`no-or-zero`, `test-doc`, `test-timeout` — and the rest is review law that
blocks a PR the same way.

Zero technical debt: a known showstopper is solved in design or in
implementation, never shipped. Simplicity is the hardest revision, not the
first draft.

### Safety

1. **Explicit control flow** — adopt. Simple and linear, with a minimum of
   abstractions. The four seams are the abstraction budget; a fifth needs a
   `docs/DESIGN.md` decision first.
2. **No recursion** — adopt, gated. Direct recursion is an error. Walk trees
   with an explicit stack and a depth bound, so the bound is visible.
3. **Bound everything** — adopt. Every loop, queue, retry, read, and remote
   script output has a named `MAX_*` ceiling declared next to its use, and
   exceeding it throws. A loop that cannot terminate says why in a comment.
4. **Explicit numeric width** — adapt. JS has one `number` (f64), so width
   cannot be declared — it must be validated: persisted and protocol integers
   pass `Number.isSafeInteger`, filesystem identity (device/inode) uses
   `bigint`, bytes use `Buffer`/`Uint8Array`, opaque ids stay strings. Never
   coerce between those shapes implicitly.
5. **Assertion density** — adapt. A CLI must not `assert`-crash at a user, so
   Beam's equivalent is a fail-closed `throw` carrying the fix (TypeScript
   rule 8) in the same places Tiger asserts: arguments, returns,
   pre/postconditions, invariants. Keep them **paired** — prove before the
   write and after the read (the fingerprint sandwiches in `docs/DESIGN.md`)
   — one condition per throw, never a compound one, and cover the negative
   space as well as the positive (Testing rules 1). A single-line `if` may
   state an implication, and a check that is blatantly true is fair
   documentation where the condition is critical and surprising. Checks are a
   safety net, not understanding: write the mental model into
   `docs/DESIGN.md` and the PR review guide first, and treat the e2e round
   trip as the last line of defense, never the first.
6. **Constant relationships** — adopt. Relations between module constants are
   checked at module scope; invariants a type can carry belong in the type.
7. **No allocation after init** — n/a as written: Bun is garbage-collected
   and cannot statically pre-allocate. Adapted mandate — bound allocation
   *size and rate*: anything that can reach gigabytes streams through one
   reused fixed buffer (`fileSha256`'s 1 MiB chunk), and every read whose
   size is tree-, agent-, or remote-controlled carries a `MAX_*` ceiling.
   Never buffer a transcript, manifest, or subprocess capture whole without
   one.
8. **Smallest scope, fewest live variables** — adopt, with rule 9's licensed
   exception: a phase parent legitimately holds the state its helpers compute.
9. **70 lines per function** — adopt, gated, test bodies included. Callbacks
   passed straight to `describe` are suite registration, not logic, and are
   exempt. Parents own branching and state-machine order; extracted phase
   helpers take one narrow options object and return a value instead of
   mutating the parent's.
10. **Strictest compiler** — adopt: `bunx tsc --noEmit` clean under `strict`
    plus `noUncheckedIndexedAccess`, and no `any`, `@ts-ignore`,
    `@ts-expect-error`, or `@ts-nocheck` anywhere (TypeScript rule 2). Gated.
11. **Run at your own pace** — adopt. Commands drive phases; nothing is
    triggered by remote output arriving. Polling an external process needs a
    stated deadline and an explicit numeric test timeout (Testing rules 3).
12. **Split compound conditions** — adopt, gated. One boolean per branch,
    positive invariants (`if (index < length)`), braces on every multi-line
    body, `else { if … }` instead of long `else if` chains, no nested
    ternaries.
13. **Handle every error** — adopt: `runChecked` or an explicit `code`
    inspection (TypeScript rule 9), no empty `catch`, and cleanup paths
    rethrow the original failure instead of masking it.
14. **Say why** — adopt. Comments carry rationale; structural rationale lands
    in `docs/DESIGN.md`.
15. **Pass options explicitly** — adopt. Never inherit a default that
    matters: `Bun.spawn` states stdio/cwd/env, every generated `ssh`,
    `rsync`, `tar`, `git`, and `kubectl` argv pins its flags, and every test
    gated on an external process states its timeout.

### Memory and state (upstream "cache invalidation")

1. **No duplicate state, no aliases** — adopt. One owner per mutable record.
   A function that computes new state returns it; the single caller assigns
   and persists. Never mutate a caller's object *and* persist separately.
2. **Pass large values by const pointer** — n/a: JS passes references, so
   there is no implicit copy to prevent. Adapted: no defensive deep copies of
   records or buffers either — take `subarray` views and keep one owner.
3. **In-place construction via out pointer** — n/a: no pointer stability or
   immovable types exist. Adapted: build an object once, in one place; never
   hand a partially initialized object to another function.
4. **Check close to use, in the smallest scope** (scope minimization itself is
   Safety 8) — adopt. Every remote effect re-proves containment and ownership
   immediately before acting, in the same remote shell that acts, closing the
   place-of-check to place-of-use gap.
5. **Simplest signature and return type** — adopt: prefer `void` over
   `boolean` over a value over an optional over a value-or-error union. Do
   not export dimensionality that callers must branch on.
6. **No suspension across asserted preconditions** — adapt. `await` is
   unavoidable in a network CLI, so the rule becomes: nothing proven before
   an `await` may be relied on after it. Re-prove it (probe/fingerprint
   pairs), and never let a fact cross a suspension unchecked.
7. **Buffer bleeds** — adapt. There is no manual padding to under-fill; the
   analogue is torn or partial I/O. Honor exact byte counts
   (`subarray(0, n)`), reject short or changed transfers, and never publish a
   buffer you did not fill.
8. **Pair acquire and release visually** — adopt: acquire, then its
   `try`/`finally` release, adjacent, with nothing between them.

### Performance

1. **Design-time thinking** — adopt. The performance sketch in
   `docs/DESIGN.md` is normative, not a note.
2. **Back-of-the-envelope sketch** — adopt, across network, disk, memory, and
   CPU with their bandwidth and latency. Any change that adds a control-plane
   round trip, a data transfer, a non-O(1) buffer, or a new `MAX_*` ceiling
   updates that sketch in the same PR.
3. **Slowest resource first, weighted by frequency** — adopt: network, then
   disk, then memory, then CPU. A new remote probe folds into an existing
   `exec` unless it needs its own failure boundary.
4. **Control plane vs data plane** — adopt: `exec`/`execChecked` is control,
   `syncUp`/`syncDown`/`sendFile`/`fetchFile` is data. Bulk bytes never ride
   the control plane, and a proof is one script per remote round trip.
5. **Batch** — adopt: `git update-ref --stdin`, `hash-object --stdin-paths`,
   `cat-file --batch-check`. Never one subprocess per ref, OID, or config
   key.
6. **Predictable CPU, large chunks** — adapt. Beam's CPU cost is subprocess
   spawns plus sha256 over transferred bytes, not in-process compute, so the
   rule becomes: minimize spawns per logical operation and keep hash loops
   allocation-free.
7. **Hot loops as standalone functions with primitive arguments** — n/a as
   written: a JIT'd, garbage-collected runtime has no register-caching or
   monomorphization concern to help. The transferable part is adopted — no
   redundant computation and no per-iteration allocation inside a loop.

### Developer experience

1. **Get the nouns and verbs right** — adopt.
2. **`snake_case`** — adapt: `camelCase` values and functions, `PascalCase`
   types, `kebab-case` file names. Ecosystem-native casing keeps Bun/Node
   APIs, JSON keys, and CLI output consistent; `snake_case` would fight all
   three. Everything the rules here do not name follows the conventions
   TypeScript, Bun, and this repo's `tsconfig.json` already imply.
3. **No abbreviations; long flags** — adopt. `source`/`destination`, never
   `src`/`dst`; every argv Beam generates uses long flags. Short flags are
   for humans typing, never for generated commands.
4. **Acronym capitalization** — adapt: acronyms are ordinary words in
   identifiers (`SshTransport`, `KubectlCoords`, `Uid`, `assertDnsLabel`),
   never split-cased (`SSHTransport`). TS identifiers compose acronyms with
   other words constantly; word casing keeps derived names readable and
   greppable, and it is already the convention in `src/`.
5. **Units and qualifiers last, descending significance** — adopt, in
   camelCase: `latencyMsMax`, `timeoutMs`, `bytesMax`.
6. **Infuse names with meaning** — adopt: name the role (`shipStage`,
   `quarantine`), not the type.
7. **Symmetric related names** — adapt: prefer symmetric pairs that line up,
   but never pad or abbreviate a name to match a sibling's length.
8. **Prefix a single-use helper with its caller** — adopt, so the call
   history reads from the name.
9. **Callbacks last** — adopt; they are invoked last.
10. **Order for top-down reading** — adopt: the exported entry point first,
    helpers below it in call order, types beside their use. Where no order is
    genuinely right, sort alphabetically and let the naming carry it.
11. **No overloaded terms** — adopt: `target` is a configured beam target, a
    copy sink is `destination`, and `record` is a `BeamRecord` — never a loop
    variable.
12. **Names that work in prose** — adopt: prefer nouns that can be pasted
    into a doc or a PR without rephrasing.
13. **Options object for mixable or nullable arguments** — adopt: two
    same-typed parameters, or any optional/nullable one, becomes one named
    options object. Singleton dependencies (transport, runtime, adapter) stay
    positional, ordered general before specific.
14. **Descriptive commit messages** — adopt; see Git & PR workflow. Not
    automated: CI cannot inspect squash intent, so this stays review law.
15. **Say how** — adopt (say *why* is Safety 14): every test file opens with a
    comment stating the goal and the method before the first `describe`.
16. **Comments are sentences** — adopt: space after `//`, capital letter,
    full stop (or a colon when they introduce what follows). Trailing
    end-of-line comments may stay bare phrases.

### Numbers

1. **Index, count, and size are distinct** — adopt: encode the kind in the
   name (`Index`, `Count`, `Bytes`, `Ms`) and never pass one where another is
   meant. Index to count adds one; count to size multiplies by the unit.
2. **Show division and rounding intent** — adopt: `Math.floor`, `Math.ceil`,
   or `Math.trunc` (or `bigint` division) at every site where an integer is
   meant. No bare `/`, no `| 0`.
3. **Formatter** — adapt: a formatter would be a dependency
   (Dependencies 1), so `bun run style` enforces the mechanical rules
   deterministically instead. No file is exempt: the only exemption is
   syntax-aware — spans inside string and template literals, where generated
   fixture content lives — never a per-file ignore, which would hide real
   violations.
4. **Indentation** — adapt: 2 spaces, the ecosystem default already used
   everywhere here. Re-indenting to 4 would rewrite every line and destroy
   `git blame` for no safety gain. Tabs and odd indentation are gated errors.
5. **100 columns, hard** — adopt, gated, no exceptions: wrap prose, error
   text, and generated shell fragments like any other code.
6. **Braces unless the statement fits on one line** — adopt, gated
   (Safety 12).

### Dependencies and tooling

1. **Zero dependencies** — adopt (TypeScript rule 1). System binaries (ssh,
   rsync, tar, herdr, git, kubectl) are probed prerequisites, not
   dependencies: `doctor` detects a missing one and names what to install.
2. **One small standardized toolbox** — adopt: Bun and `tsc`, one subprocess
   primitive (`run`/`runChecked` in `src/util/shell.ts`), one style checker.
   No second exec helper, no formatter, no linter, no test framework beyond
   `bun test`.
3. **Scripts in the primary language** — adopt: `scripts/*.ts` run by Bun,
   never `scripts/*.sh`. Two n/a exceptions, both because a runtime cannot be
   assumed to exist: `docs/own-sandbox-bootstrap.sh` (a VM startup script
   that installs the toolchain a typed replacement would need) and the POSIX
   shell Beam generates for the target (the remote's runtime is exactly what
   Beam must not assume). Both stay `sh`, and every string in them goes
   through `shq`/`shjoin`/`shqRemotePath` (Security invariants).

## Git & PR workflow

- **Never create merge commits. Rebase to sync** (`git fetch && git rebase
  origin/main`), **squash-merge to land** (the `main` ruleset enforces
  squash-only through PRs).
- Conventional-commit subjects (`feat(scope):`, `fix:`, `test:`, `docs:`,
  `ci:`) with a 2–5 line body saying WHAT and WHY — the diff already shows
  the how.
- Branch commits stay atomic (one reviewable unit each); the squash flattens
  them on main, the PR preserves them for review.
- PR descriptions have four sections: **Summary**, **Key decisions**,
  **Review guide** (entry point → how far the change reaches and where it
  stops → which state machine it touches and how), **Test plan** with real
  commands.
- CI green on both OSes before merge. Fix what you broke; never mute a check.

## Prose

Docs, PR text, and messages follow Orwell: short words, active voice, cut
every word that does nothing.
