# beam

Hand a live coding-agent session to a remote sandboxed server — and bring it
back. Supports **omp**, **pi**, **Claude Code**, and **Codex** sessions.

The use case: *you need to turn off your computer, but you want the agent to
continue working on what you're doing.*

```
laptop                                sandbox server (any ssh box)
──────                                ───────────────────────────
beam up -m "keep going"   ─────────►  workspace mirrored (rsync)
                                      session transcript installed
                                      agent resumed in detached tmux
        (laptop off)                  … agent keeps working …
beam attach / beam status ─────────►  watch or steer from anywhere
beam down                 ◄─────────  agent stopped, workspace synced back,
                                      grown transcript re-imported locally
omp --resume …                        continue exactly where the agent left off
```

Everything moves: the dirty tree, untracked files, `.git`, `.env` — and the
literal session transcript. Nothing is summarized or lossy.

## Install

```bash
git clone https://github.com/bipa-app/beam && cd beam
bun install
bun link        # exposes `beam`
```

Requirements — local: [Bun](https://bun.sh), rsync, ssh. Server: sshd, rsync,
tmux, and the harness you use (`omp` / `pi` / `claude` / `codex`) installed.
Authenticate each harness **on the target** with `beam login` — beam never
copies credentials between machines.

### Least-privilege server setup

The ssh user you give beam **is the blast radius**: the mirrored tree
(secrets included) lands in its home, and the agent executes as it. Never
point beam at `root` or a sudo-capable login on a machine you care about.
`beam doctor` and `beam up` probe for the dangerous postures (root login,
passwordless sudo, workspace outside the user's home) and warn.

```bash
# on the server, once, as an admin — a dedicated, unprivileged user:
sudo adduser --disabled-password --gecos "" beam-agent
sudo -u beam-agent mkdir -p /home/beam-agent/.ssh
cat ~/.ssh/id_ed25519.pub | sudo -u beam-agent tee -a /home/beam-agent/.ssh/authorized_keys
# do NOT add beam-agent to the sudo group.
```

Needs docker? Membership in the `docker` group is root-equivalent on that
host — use rootless docker, or accept that this target must be a disposable
VM dedicated to beam. Managed sandbox providers (Daytona, E2B, Modal, …)
enforce this boundary for you; that is a real argument for them.

## Quickstart

```bash
beam init                      # writes ~/.beam/config.json
$EDITOR ~/.beam/config.json    # point "host" at any ssh destination
beam doctor                    # verifies ssh, rsync, tmux, harnesses
beam login --tool omp          # authenticate the harness ON the target (one-time)

cd ~/work/my-project           # the project you're working on
# …quit your omp/claude/codex session…
beam up -m "continue the task: finish the API migration and run the tests"
# laptop off. later, from anywhere:
beam status                    # last lines of the remote pane
beam attach                    # full TUI over ssh (ctrl-b d to detach)
# when you're back:
beam down                      # stop remote agent, sync back, re-import session
omp --resume <printed path>    # continue locally with everything it did
```

## Commands

| Command | What it does |
|---|---|
| `beam init` | write a sample config |
| `beam targets` | list configured targets |
| `beam doctor [target]` | verify ssh/rsync/tmux/harness on a target |
| `beam login [target]` | interactive harness login on the target over `ssh -t` (`--tool` to pick; credentials never travel) |
| `beam up` | ship workspace + session, resume the agent remotely (`-m` kickoff prompt, `--tool`, `--session`, `--target`, `--no-start`, `--no-session`, `--no-delete`, `-v`) |
| `beam ls` | list handoffs |
| `beam status [id]` | remote liveness + a glimpse of the pane |
| `beam attach [id]` | attach to the remote agent's tmux |
| `beam down [id]` | stop remote agent, sync workspace back, re-import the transcript, purge the remote copy (`--no-purge` keeps it; `--keep-remote` snapshots while it keeps running) |
| `beam kill [id]` | kill the remote agent (`--purge` also deletes the remote workspace) |

### In-session: `/beam` from inside your agent

Instead of quitting the harness first, install the thin integrations under
[`integrations/`](integrations/README.md): a `/beam` slash-command extension
for **omp**/**pi**, a `/beam-up` command for **Claude Code**, and a prompt for
**Codex**. They shell out to this CLI, wait for the agent to go idle, ship,
and (omp/pi) switch the local window to a fresh session so the shipped
transcript stops growing locally.

## Configuration

`~/.beam/config.json`:

```json
{
  "defaultTarget": "sandbox",
  "targets": {
    "sandbox": { "type": "ssh", "host": "my-sandbox", "root": "~/beam" },
    "loopback": { "type": "local", "root": "/tmp/beam-root" }
  },
  "excludes": [".DS_Store"]
}
```

- `host` is any ssh destination — `~/.ssh/config` aliases, `user@host`, jump
  hosts and keys all work unchanged. The server needs no daemon: **ssh is the
  API**.
- A `.beamignore` in the project root adds rsync exclude patterns for that
  project. Shipping from macOS to Linux? Exclude build artifacts — they don't
  cross OS/arch:

```
# .beamignore
target/
node_modules/
```

## How it works

- The workspace is mirrored with rsync (delta transfer — re-ships are cheap).
- omp sessions ship *inside* the workspace at `.beam/session.jsonl` with the
  transcript's recorded cwd rewritten to the remote path, so resume needs no
  prompts — and the growing transcript rides the normal sync back on
  `beam down` (your previous local copy is backed up first). Claude Code and
  Codex sessions are placed into their `~/.claude` / `~/.codex` stores on the
  server and fetched back explicitly.
- The agent runs in a detached tmux session; it survives ssh drops, and when
  it exits the pane drops to a shell so you can inspect what happened.

See [docs/DESIGN.md](docs/DESIGN.md) for the full architecture.

## Extending

Three seams, all small interfaces:

- **New harness** → implement `SessionAdapter`
  (`src/session/types.ts`): locate the session for a cwd, install it on the
  target, produce the resume command, collect the grown transcript back.
- **New sandbox provider** (docker exec, k8s, E2B/Fly/Modal, …) → implement
  `Transport` (`src/transport/types.ts`): exec, sync up/down, send/fetch file.
- **New process manager** → the tmux runtime (`src/runtime/tmux.ts`) is the
  template: start/alive/peek/interrupt/kill/attach.

## Security

`beam up` copies your working directory **as-is** — including `.env` files and
any secrets in the tree — to the target, and the harness on the target runs
with whatever credentials it is logged in with. Only beam to servers you trust
like your own laptop. `beam down` purges the remote workspace and any session
files beam installed by default, so nothing lingers after the work is home
(`--no-purge` opts out).

## Development

```bash
bun test          # unit + full up/down round trip over the local transport
bunx tsc --noEmit # typecheck
```

MIT.
