# Beam AI

<p align="center">
  <img
    alt="Beam AI — your coding agent keeps moving"
    src="assets/beam-readme-hero.svg"
    width="960"
  >
</p>

Beam moves your live coding-agent session to a remote sandbox and brings it
back. The dirty working tree, Git state, and real **omp**, **pi**,
**Claude Code**, or **Codex** transcript travel as one verified unit. Your
agent keeps working after your laptop closes.

```text
laptop                              Box or another sandbox
──────                              ──────────────────────
beam up --message "keep going" ──► workspace + session resume
                                    agent keeps working
beam status / attach           ──► inspect or steer it
beam down                      ◄── verified return staged locally
beam integrate                     preview, confirm, apply
beam kill --purge                  erase the retained sandbox
```

## First handoff: Box

[Box](https://box.ascii.dev) is the default path. Each handoff gets its own
managed VM; no SSH server setup is required.

### 1. Install Beam and Box

The installer detects macOS/Linux and x64/arm64, verifies the release
checksum, and installs the self-contained binary to `~/.local/bin/beam`.
Bun is not required.

```bash
curl -fsSL https://beamai.sh/install | sh
curl -fsSL https://box.ascii.dev/install | sh
```

For a manual install, all four platform binaries and `SHA256SUMS` are on the
[latest release](https://github.com/bipa-app/beam/releases/latest).

### 2. Set up Box

`beam setup` plans first. It changes nothing until `--apply --yes`.

```bash
beam setup box
box onboard                         # only when the plan asks for it
beam setup box --apply --yes
beam check box
```

This creates the `beam` Box Environment and a Box target in
`~/.beam/config.json`. Re-running the apply command is safe.

### 3. Send the live session away

Exit the local agent first so its transcript is settled, then run Beam from the
project root:

```bash
cd ~/work/my-project
beam up --target box --tool omp \
  --message "Finish the migration, run the project gates, and report blockers."
```

Beam prints the handoff ID and watch commands. Your laptop can now go offline.

```bash
beam status                         # summary and recent agent output
beam attach                         # live terminal; Ctrl+B then Q detaches
```

Do not run a second fresh `beam up` for a live handoff. Use `status` or `attach`.

### 4. Bring the work back

```bash
beam down                           # collect; local workspace is untouched
beam integrate                      # itemized preview, then Apply? [y/N]
# run your project checks here
beam kill --purge                   # erase the retained Box only when settled
```

`beam down` stores a verified return under `~/.beam/returns`. `beam integrate`
refuses if that stage changed, the project directory was replaced, or the local
filtered tree changed after `beam up`. `--delete` on `beam down` returns remote
deletions; Beam still protects every excluded local path.
Quiesce local editors and generators before `beam integrate`; applying over a
live directory cannot be atomic.

For unattended callers:

```bash
beam down --json
beam integrate --yes --json
beam kill --purge --json
```

## Teach an agent to use Beam

Install Beam's version-matched skill into every detected harness:

```bash
beam skill install --tool auto --scope user
beam docs agent --json
```

Other forms:

```bash
beam skill install --tool all --scope project
beam skill remove --tool omp --scope user
beam help --json
beam help integrate --json
beam docs recovery --json
```

Beam never removes a foreign skill. Installation refuses to replace one unless
you pass the explicit \`--replace\` flag.

## Everyday commands

| Command | Result |
|---|---|
| `beam setup <provider>` | inspect an idempotent provider setup plan |
| `beam check [target]` | verify provider access, transport, tools, and safety posture |
| `beam up --target <name> --tool <tool> --message <goal>` | ship and resume |
| `beam ls` | list handoff records |
| `beam status [id]` | inspect one handoff |
| `beam attach [id]` | enter its live herdr terminal |
| `beam down [id]` | collect into a verified local stage; retain remote |
| `beam integrate [id]` | preview, re-prove, and apply the latest return |
| `beam kill [id] --purge` | explicitly erase owned remote state |
| `beam docs <topic>` | read agent, handoff, return, provider, recovery, or security docs |

`--json` is global and may appear before or after the command. It returns one
stable envelope for success and failure. Interactive `attach` and `login`
reject `--json` instead of hanging.

## Other managed providers

The same plan/apply flow supports E2B, Modal, and Daytona:

```bash
beam setup e2b --json
beam setup e2b --apply --yes --json
beam check e2b --json
```

| Provider | Local prerequisite | Resource Beam prepares |
|---|---|---|
| Box | `box`, then `box onboard` | `beam` Environment |
| E2B | `e2b`, `websocat`, `E2B_API_KEY` | `beam-coding` template |
| Modal | `modal`, then `modal token new` | target using the pinned coding image |
| Daytona | `daytona`, authenticated profile | `beam-coding` snapshot |

Image-backed setup for E2B, Modal, and Daytona pins the matching immutable
\`ghcr.io/bipa-app/beam-coding@sha256:…\` image. It contains sshd, rsync, Git,
herdr, and the four supported harnesses. A source checkout must set
\`BEAM_CODING_IMAGE\` to an immutable digest before applying that setup.

Setup never overwrites a conflicting resource or target. It prints the exact
login, install, or repair command when a prerequisite is missing.

## Harness login

Beam never copies harness credentials between machines. Authenticate on the
target:

```bash
beam login box --tool omp
```

Managed providers need a live handoff before `beam login` can connect. Box
users should prefer credentials and setup in the Box Environment so every new
VM starts ready.

## Raw SSH target

Any dedicated SSH server with `rsync`, `herdr`, Git, and the chosen harness can
be a target:

```json
{
  "defaultTarget": "devbox",
  "targets": {
    "devbox": {
      "type": "ssh",
      "host": "beam-agent@example.net",
      "root": "~/beam"
    }
  },
  "excludes": [".DS_Store", "/target", "/node_modules"]
}
```

Save it as `~/.beam/config.json`, then run:

```bash
beam check devbox
beam login devbox --tool codex
```

Use a dedicated unprivileged user. The SSH or provider credential is the blast
radius: Beam ships the working tree as-is, including untracked files and
secrets unless excluded. `beam check` warns about root, passwordless sudo,
Docker sockets, Kubernetes service-account tokens, and shared unsafe roots.

Self-hosting details: [docs/own-sandbox.md](docs/own-sandbox.md). The
`agent-sandbox` provider is for operators who already run a GKE Agent Sandbox
cluster; its least-privilege and identity-pinning design is in
[docs/DESIGN.md](docs/DESIGN.md).

## Build from source

```bash
git clone https://github.com/bipa-app/beam
cd beam
bun install --frozen-lockfile
bun link

bun run style
bunx tsc --noEmit
bun test
```

Architecture and safety invariants: [docs/DESIGN.md](docs/DESIGN.md).
Brand assets and usage rules: [docs/BRAND.md](docs/BRAND.md).
In-session slash-command integrations: [integrations/README.md](integrations/README.md).

MIT.
