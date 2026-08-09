# AGENTS.md — beam

beam hands a live coding-agent session (omp, Claude Code, Codex) to a remote
sandboxed server and brings it back. Read `docs/DESIGN.md` before structural
changes. These rules are mandatory for all contributions, human or agent.

## Architecture in one breath

Three seams, all small interfaces — extend by implementing, never by widening
callers:

- `src/session/` — **SessionAdapter**: locate a harness session for a cwd,
  install it on a target, produce the resume command, collect the grown
  transcript back. One adapter per harness.
- `src/transport/` — **Transport**: exec via `bash -lc`, sync up/down,
  send/fetch file. `ssh` is the production remote; `local` is the hermetic
  test double and must stay behaviorally equivalent (same `~/` semantics).
- `src/runtime/` — where the remote agent process lives (tmux).

Commands (`src/commands/`) orchestrate the seams and own the handoff record
lifecycle (`up → down/killed`) in `src/state.ts`.

## Commands

```bash
bun test              # full suite, includes the live tmux round trip
bunx tsc --noEmit     # strict typecheck — zero errors, always
bun src/cli.ts …      # run the CLI from source
```

Both must be green before any push. CI runs them on ubuntu AND macos.

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

## Testing rules

1. **Test behavior and contracts, not plumbing.** Every test defends an
   observable invariant that would fail on a plausible bug.
2. **Hermetic by construction**: point `BEAM_HOME`/`BEAM_DIR` at fixture
   directories. Touching the real `~/.omp`, `~/.claude`, `~/.codex`, or
   `~/.beam` in a test is a bug.
3. **No wall-clock timers in tests.** Await real signals. The one exception:
   bounded polling of a genuinely external process (the tmux e2e), justified
   with a comment.
4. **`describe.skipIf` for missing system deps** (tmux/rsync) — skip, never
   fail; CI installs them so nothing is skipped there.
5. **Never change a test's expectations to make it pass** — fix the code.
6. The e2e round trip (`test/e2e.test.ts`) is the merge gate: if it cannot
   prove up → remote work → down fidelity, the change does not ship.

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
