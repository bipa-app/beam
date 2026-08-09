# In-session integrations

Run beam from *inside* your coding agent instead of quitting first. All
integrations shell out to the `beam` CLI, so install it once (`bun link` in
this repo) and configure a target (`beam init`, `beam doctor`).

## omp / pi — `/beam` slash command

One extension file serves both harnesses (omp is built on pi; the file uses
only the shared extension surface and feature-detects the rest):

```bash
# omp
mkdir -p ~/.omp/agent/extensions
ln -s "$(pwd)/integrations/omp/beam.ts" ~/.omp/agent/extensions/beam.ts

# pi
pi install "$(pwd)/integrations/omp/beam.ts"
```

Then, inside a session:

```
/beam up -m "keep going: finish the migration and run the tests"
/beam status
/beam down
```

`/beam up` waits for the agent to go idle (so the transcript on disk is
complete), ships workspace + session, then switches the local window to a
fresh session so the shipped transcript stops growing here. Watching happens
outside the TUI: `beam attach`.

## Claude Code — `/beam-up` command

```bash
mkdir -p ~/.claude/commands
cp integrations/claude/commands/beam-up.md ~/.claude/commands/
```

Inside Claude Code: `/beam-up finish the API migration and run the tests`.
The command instructs Claude to run `beam up --tool claude` and to remind you
to exit the local session afterwards.

## Codex — `/beam-up` prompt

```bash
mkdir -p ~/.codex/prompts
cp integrations/codex/prompts/beam-up.md ~/.codex/prompts/
```

## Why the CLI stays the engine

The integrations are deliberately thin: session detection, mirroring, resume,
purge, and state all live in the beam CLI where they are tested. A harness
integration is just "run beam in the right cwd at the right moment" — which
is also what keeps one extension file portable across omp and pi.
