# Running beam against your own sandbox

beam's data plane is ssh. The question for self-hosted sandboxes is never
"how does beam reach it" — it is **who is allowed to, as which user, with
which privileges**. Hand-managed unix users answer that badly (the exact
danger `beam doctor` probes for). The patterns below move authorization to a
system built for it, ranked by how well they do that.

## 1. Dedicated VM + OS Login + IAP (recommended on GCP)

One disposable VM per user (or per team), no public IP, reached through an
IAM-gated tunnel. beam needs zero new code — the target is a plain ssh alias.

Why this answers the permissions question:

- **IAM owns who gets in.** `roles/compute.osLogin` grants ssh as an
  auto-managed per-person POSIX user **without sudo**; `osAdminLogin` is the
  explicit, auditable escalation. Revoking access is an IAM change, not a
  `deluser` on a box someone forgot about.
- **No public attack surface.** The VM has no external IP;
  Identity-Aware Proxy tunnels ssh after an IAM check
  (`roles/iap.tunnelResourceAccessor`), and every session is audit-logged.
- beam's privilege probes stay green by construction: you log in as a
  non-root user with no sudo, and the mirror lands in that user's home.

### Create the VM (admin, once)

```bash
PROJECT=your-project ZONE=southamerica-east1-a   # pick the zone next to you
gcloud compute instances create beam-sandbox \
  --project=$PROJECT --zone=$ZONE \
  --machine-type=e2-standard-8 \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=200GB \
  --no-address \
  --shielded-secure-boot \
  --metadata=enable-oslogin=TRUE \
  --metadata-from-file=startup-script=docs/own-sandbox-bootstrap.sh
```

Grant each beam user (NOT `osAdminLogin` unless they administer the VM):

```bash
gcloud projects add-iam-policy-binding $PROJECT \
  --member=user:dev@example.com --role=roles/compute.osLogin
gcloud projects add-iam-policy-binding $PROJECT \
  --member=user:dev@example.com --role=roles/iap.tunnelResourceAccessor
```

### Point beam at it (each user)

```sshconfig
# ~/.ssh/config
Host beam-sandbox
  User your_oslogin_username   # gcloud compute os-login describe-profile
  ProxyCommand gcloud compute start-iap-tunnel beam-sandbox %p \
    --listen-on-stdin --project=your-project --zone=southamerica-east1-a
```

```json
{ "defaultTarget": "sandbox",
  "targets": { "sandbox": { "type": "ssh", "host": "beam-sandbox" } } }
```

First login, as yourself: install bun + your harness in your own home
(`curl -fsSL https://bun.sh/install | bash`, then
`bun install -g @oh-my-pi/pi-coding-agent` or the harness you use), then
`beam login sandbox --tool omp` and `beam doctor sandbox` — expect
`privilege: ok`.

### Docker

The bootstrap script installs docker. Membership in the `docker` group is
root-equivalent on that VM — acceptable **because the VM is dedicated and
disposable**, but it is an admin decision: an `osAdminLogin` holder runs
`sudo usermod -aG docker <user>` per user who needs it. Do not do this on a
shared multi-team box.

### Cost hygiene

An e2-standard-8 costs real money while running. Stop it when idle
(`gcloud compute instances stop beam-sandbox`); files survive. Automating
start/stop around handoffs is exactly what the provider seam is for
(`type: "gce"` provider: start on `beam up`, stop on `beam down`).

### Optional: herdr as the agent runtime

[herdr](https://github.com/herdrdev/herdr) is a Rust daemon that owns agent
terminals: sessions survive disconnects and reboots, every pane is marked
**working / blocked / idle**, and a socket API exposes that state. Installed
on the sandbox, it is a strictly better home for beamed agents than raw
tmux — reattach into a dashboard of your handoffs instead of a bare pane,
and see at a glance whether the agent is stuck waiting for you. beam's
Runtime seam (`src/runtime/`) is where a first-class `herdr` runtime plugs
in; until then, herdr and beam's tmux sessions coexist fine on one VM.

## 2. In-cluster pod + Tailscale (when it must live in Kubernetes)

If the sandbox has to run inside an existing cluster, run a `beam-box`
Deployment (Ubuntu + sshd + tmux + rsync) and reach it over a mesh VPN
(e.g. a Tailscale sidecar) instead of the Kubernetes API:

- ssh remains the data plane → rsync delta, tmux attach, `beam login`, and
  the privilege probes all work unchanged;
- the tailnet ACL decides who can reach the pod — centrally managed,
  auditable, revocable;
- **kubectl stays a control-plane tool**: platform operators deploy/upgrade
  the pod; beam users never hold a kubeconfig at all.

gVisor (`runtimeClassName: gvisor`) hardens the pod if the node pool
supports it. Pin the pod to a PVC-backed `/home` so workspaces and harness
logins survive restarts.

## 3. kubectl as the transport (the `agent-sandbox` target)

Driving `kubectl exec` as beam's data plane ships as the `agent-sandbox`
target (GKE Agent Sandbox: one SandboxClaim per handoff, tar streams over
the exec channel). It is still the weakest option for *people*: every user
needs a kubeconfig, RBAC must be hand-scoped (the blast radius of a fat
kubeconfig is the whole cluster), there is no rsync delta, and long
interactive sessions ride the apiserver. Per this repo's security
invariants it ships with teeth: a dedicated per-user namespace, a
ServiceAccount scoped to claim lifecycle + pods/exec in that namespace
only, an explicit `kubeconfig` REQUIRED in the target config (the ambient
one is never used), and a fail-closed boundary check in both `beam doctor`
and `beam up` that REFUSES credentials holding known escape capabilities —
cluster-wide claim create/list/delete or exec access, port-forward
anywhere, Secret access of any kind
(get/list/watch/create/patch/update/delete/deletecollection), plain pod create,
pod patch/update, pods/attach,
ephemeral-container injection, Sandbox/SandboxTemplate mutation, workload
controller create/patch/update, token minting, RBAC bind/escalate,
impersonation — or whose capabilities cannot be verified at all (a
denylist of escape hatches, not proof of minimality). beam's purge erases the
shipped workspace and installed session files inside the pod before the
claim is deleted — claim deletion is never trusted as storage erasure.
Whether harness *logins* survive claim deletion is template-dependent
(ephemeral pod vs persistent home). See the README's configuration section
for the target JSON.

## Managed providers

When self-hosting is not worth the ops: the provider seam targets managed
sandboxes (box.ascii.dev, Daytona, E2B, Modal, GKE Agent Sandbox) where the
vendor enforces the boundary. See `docs/DESIGN.md`.
