import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModalTargetSpec } from "../config.ts";
import { SshTransport } from "../transport/ssh.ts";
import type { Transport } from "../transport/types.ts";
import { run } from "../util/shell.ts";
import {
  assertOwnerToken,
  bootstrapManagedLinux,
  ensureManagedSshIdentity,
  managedSshCheckLines,
  managedSshToolsReady,
  newOwnerToken,
  removeManagedSshIdentity,
} from "./managed-ssh.ts";
import type {
  ModalSandboxState,
  ProviderCheckReport,
  SandboxProvider,
  SandboxRef,
  SandboxState,
} from "./types.ts";

const MODAL_APP_DEFAULT = "beam";
const MODAL_BRIDGE_OUTPUT_PREFIX = "BEAM_MODAL_JSON:";
const MODAL_IMAGE_DEFAULT = "debian:bookworm-slim";
const MODAL_NAME_SHAPE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const MODAL_OUTPUT_BYTES_MAX = 1024 * 1024;
const MODAL_SANDBOX_ID_SHAPE = /^sb-[A-Za-z0-9_-]{6,128}$/;
const MODAL_SSH_KEY_SHA256_SHAPE = /^[a-f0-9]{64}$/;
const MODAL_TIMEOUT_SECONDS_DEFAULT = 24 * 60 * 60;
const MODAL_TIMEOUT_SECONDS_MAX = 24 * 60 * 60;
const MODAL_TUNNEL_HOST_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const RECORD_ID_SHAPE = /^[a-z0-9]{1,12}$/;

interface ModalConnection {
  host: string;
  port: number;
  sandboxId: string;
  volumeOwned: true;
}

const MODAL_BRIDGE_SOURCE = String.raw`
import io
import json
import modal

bridge = modal.App("beam-provider-bridge")
PREFIX = "BEAM_MODAL_JSON:"
MARKER_PATH = ".beam-owner"
MARKER_BYTES_MAX = 4096


def emit(value):
    print(PREFIX + json.dumps(value, separators=(",", ":")), flush=True)


def read_marker(volume):
    try:
        chunks = []
        size = 0
        for chunk in volume.read_file(MARKER_PATH):
            size += len(chunk)
            if size > MARKER_BYTES_MAX:
                raise RuntimeError("Modal Volume owner marker is oversized")
            chunks.append(chunk)
        return b"".join(chunks)
    except FileNotFoundError:
        return None


def ensure_volume(name, owner_token, allow_initialize):
    created = False
    try:
        modal.Volume.objects.create(name, version=2)
        created = True
    except modal.exception.AlreadyExistsError:
        pass
    volume = modal.Volume.from_name(name, version=2)
    volume.hydrate()
    expected = ("beam-modal-v1 " + owner_token + "\n").encode()
    marker = read_marker(volume)
    if marker is None:
        if not created and not allow_initialize:
            raise RuntimeError("Modal Volume lost its Beam owner marker")
        with volume.batch_upload() as batch:
            batch.put_file(io.BytesIO(expected), MARKER_PATH)
        marker = read_marker(volume)
    if marker != expected:
        raise RuntimeError("Modal Volume owner marker does not match this handoff")
    return volume


def verify_sandbox(sandbox, owner_token, record_id):
    tags = sandbox.get_tags()
    if tags.get("beam.owner") != owner_token:
        raise RuntimeError("Modal Sandbox owner tag does not match this handoff")
    if tags.get("beam.record") != record_id:
        raise RuntimeError("Modal Sandbox belongs to another Beam record")


def find_sandbox(app_name, sandbox_name, owner_token, record_id):
    try:
        sandbox = modal.Sandbox.from_name(app_name, sandbox_name)
    except modal.exception.NotFoundError:
        return None
    verify_sandbox(sandbox, owner_token, record_id)
    return sandbox


def sandbox_image(image_name):
    return (
        modal.Image.from_registry(image_name, add_python="3.12")
        .apt_install("openssh-server", "rsync", "curl", "ca-certificates", "coreutils")
    )


def create_sandbox(app_name, sandbox_name, owner_token, record_id, volume, public_key,
                   image_name, timeout_seconds):
    app = modal.App.lookup(app_name, create_if_missing=True)
    startup = """set -eu
mkdir -p /run/sshd /root/.ssh /etc/ssh/sshd_config.d
chmod 700 /root/.ssh
printf '%s\\n' "$BEAM_SSH_PUBLIC_KEY" > /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
cat > /etc/ssh/sshd_config.d/beam.conf <<'EOF'
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowAgentForwarding no
AllowTcpForwarding no
X11Forwarding no
EOF
rm -f /etc/ssh/ssh_host_*
ssh-keygen -A
exec /usr/sbin/sshd -D -e
"""
    sandbox = modal.Sandbox.create(
        "bash", "-lc", startup,
        app=app,
        name=sandbox_name,
        tags={"beam.owner": owner_token, "beam.record": record_id},
        image=sandbox_image(image_name),
        env={"BEAM_SSH_PUBLIC_KEY": public_key},
        timeout=timeout_seconds,
        volumes={"/root": volume},
        unencrypted_ports=[22],
        readiness_probe=modal.Probe.with_tcp(22),
    )
    try:
        sandbox.wait_until_ready(timeout=300)
        return sandbox
    except Exception:
        sandbox.terminate(wait=True)
        raise


def connection(sandbox):
    tunnel = sandbox.tunnels(timeout=50).get(22)
    if tunnel is None or tunnel.tcp_socket is None:
        raise RuntimeError("Modal did not publish the SSH TCP tunnel")
    host, port = tunnel.tcp_socket
    return {
        "host": host,
        "port": port,
        "sandboxId": sandbox.object_id,
        "volumeOwned": True,
    }


def ensure(app_name, sandbox_name, volume_name, owner_token, record_id, public_key,
           image_name, timeout_seconds, allow_initialize):
    volume = ensure_volume(volume_name, owner_token, allow_initialize)
    sandbox = find_sandbox(app_name, sandbox_name, owner_token, record_id)
    if sandbox is None:
        sandbox = create_sandbox(
            app_name, sandbox_name, owner_token, record_id, volume, public_key,
            image_name, timeout_seconds,
        )
    result = connection(sandbox)
    sandbox.detach()
    emit(result)


def destroy(app_name, sandbox_name, volume_name, owner_token, record_id,
            allow_unowned_cleanup):
    sandbox = find_sandbox(app_name, sandbox_name, owner_token, record_id)
    if sandbox is not None:
        sandbox.terminate(wait=True)
    try:
        volume = modal.Volume.from_name(volume_name, version=2)
        volume.hydrate()
    except modal.exception.NotFoundError:
        emit({"deleted": True})
        return
    expected = ("beam-modal-v1 " + owner_token + "\n").encode()
    marker = read_marker(volume)
    if marker is None and not allow_unowned_cleanup:
        raise RuntimeError("Modal Volume lost its Beam owner marker")
    if marker is not None and marker != expected:
        raise RuntimeError("Modal Volume owner marker does not match this handoff")
    modal.Volume.objects.delete(volume_name, allow_missing=True)
    emit({"deleted": True})


@bridge.local_entrypoint()
def main(op: str, app_name: str = "", sandbox_name: str = "", volume_name: str = "",
         owner_token: str = "", record_id: str = "", public_key: str = "",
         image_name: str = "", timeout_seconds: int = 86400,
         allow_initialize: str = "false", allow_unowned_cleanup: str = "false"):
    if op == "check":
        list(modal.Volume.objects.list(max_objects=1))
        emit({"ok": True})
        return
    if op == "ensure":
        ensure(
            app_name, sandbox_name, volume_name, owner_token, record_id, public_key,
            image_name, timeout_seconds, allow_initialize == "true",
        )
        return
    if op == "destroy":
        destroy(
            app_name, sandbox_name, volume_name, owner_token, record_id,
            allow_unowned_cleanup == "true",
        )
        return
    raise RuntimeError("unknown Beam Modal bridge operation: " + op)
`;

function modalNames(ref: SandboxRef, ownerToken: string): {
  sandboxName: string;
  volumeName: string;
} {
  if (!RECORD_ID_SHAPE.test(ref.id)) {
    throw new Error(`Modal cannot derive resource names from malformed record id ${ref.id}`);
  }
  return {
    sandboxName: `beam-${ref.id}-${ownerToken.slice(0, 12)}`,
    volumeName: `beam-${ref.id}-${ownerToken.slice(0, 32)}`,
  };
}

function parseConnection(value: Record<string, unknown>): ModalConnection {
  if (typeof value.sandboxId !== "string" || !MODAL_SANDBOX_ID_SHAPE.test(value.sandboxId)) {
    throw new Error("Modal bridge returned a malformed Sandbox id");
  }
  if (typeof value.host !== "string" || !MODAL_TUNNEL_HOST_SHAPE.test(value.host)) {
    throw new Error("Modal bridge returned a malformed TCP tunnel host");
  }
  if (!Number.isSafeInteger(value.port) || Number(value.port) <= 0 || Number(value.port) > 65535) {
    throw new Error("Modal bridge returned a malformed TCP tunnel port");
  }
  if (value.volumeOwned !== true) {
    throw new Error("Modal bridge did not verify the durable Volume owner marker");
  }
  return {
    host: value.host,
    port: Number(value.port),
    sandboxId: value.sandboxId,
    volumeOwned: true,
  };
}

/** Modal compute is replaceable; one owner-marked Volume is the durable sandbox. */
export class ModalProvider implements SandboxProvider {
  readonly label = "Modal";
  readonly reusesSandbox = false;
  private readonly appName: string;
  private readonly imageName: string;
  private readonly timeoutSeconds: number;

  constructor(
    private readonly spec: ModalTargetSpec,
    private readonly bin: string = "modal",
  ) {
    this.appName = spec.app ?? MODAL_APP_DEFAULT;
    this.imageName = spec.image ?? MODAL_IMAGE_DEFAULT;
    this.timeoutSeconds = spec.timeoutSeconds ?? MODAL_TIMEOUT_SECONDS_DEFAULT;
    if (!MODAL_NAME_SHAPE.test(this.appName)) throw new Error("modal target app name is invalid");
    if (this.imageName.trim() === "" || this.imageName.length > 512) {
      throw new Error("modal target image must be a non-empty OCI image reference");
    }
    if (!Number.isSafeInteger(this.timeoutSeconds) || this.timeoutSeconds <= 0) {
      throw new Error("modal target timeoutSeconds must be a positive integer");
    }
    if (this.timeoutSeconds > MODAL_TIMEOUT_SECONDS_MAX) {
      throw new Error("modal target timeoutSeconds exceeds Modal's 24-hour ceiling");
    }
  }

  sandboxState(ref: SandboxRef): ModalSandboxState {
    if (ref.sandbox === undefined) {
      const ownerToken = newOwnerToken();
      return { kind: "modal", ownerToken, ...modalNames(ref, ownerToken) };
    }
    if (ref.sandbox.kind !== "modal") {
      throw new Error(`handoff ${ref.id} stores another provider identity, not Modal state`);
    }
    const state = ref.sandbox;
    assertOwnerToken(state.ownerToken, "Modal");
    const expected = modalNames(ref, state.ownerToken);
    if (state.sandboxName !== expected.sandboxName || state.volumeName !== expected.volumeName) {
      throw new Error("Modal resource names do not match this handoff — state.json corrupted?");
    }
    if (state.sshKeySha256 !== undefined) this.assertKeySha256(state.sshKeySha256);
    if (state.volumeOwned !== undefined && state.volumeOwned !== true) {
      throw new Error("Modal Volume ownership receipt is malformed");
    }
    if (
      state.bootstrappedSandboxId !== undefined &&
      !MODAL_SANDBOX_ID_SHAPE.test(state.bootstrappedSandboxId)
    ) {
      throw new Error("Modal bootstrap receipt has a malformed Sandbox id");
    }
    return state;
  }

  async provision(
    ref: SandboxRef,
    persist?: (sandbox: SandboxState) => void,
  ): Promise<Transport> {
    let state = this.sandboxState(ref);
    if (ref.sandbox === undefined) {
      if (persist === undefined) {
        throw new Error("Modal provisioning needs a state journal callback");
      }
      ref.sandbox = state;
      persist(state);
    }
    const identity = await ensureManagedSshIdentity(
      "modal",
      state.ownerToken,
      state.sshKeySha256,
    );
    if (state.sshKeySha256 === undefined) {
      state = { ...state, sshKeySha256: identity.sha256 };
      this.persistState(ref, state, persist);
    }
    const connection = await this.ensureConnection(ref, state, identity.publicKey);
    if (state.volumeOwned !== true) {
      state = { ...state, volumeOwned: true };
      this.persistState(ref, state, persist);
    }
    const transport = this.transport(state, connection, identity.path);
    if (state.bootstrappedSandboxId !== connection.sandboxId) {
      await bootstrapManagedLinux(transport, { provider: "Modal", useSudo: false });
      state = { ...state, bootstrappedSandboxId: connection.sandboxId };
      this.persistState(ref, state, persist);
    }
    return transport;
  }

  async connect(ref?: SandboxRef): Promise<Transport> {
    if (ref === undefined) {
      throw new Error("no live Modal handoff for this target — run `beam up` first");
    }
    const state = this.sandboxState(ref);
    if (state.sshKeySha256 === undefined || state.volumeOwned !== true) {
      throw new Error(`handoff ${ref.id} has incomplete Modal state — run \`beam up\` to recover`);
    }
    const identity = await ensureManagedSshIdentity(
      "modal",
      state.ownerToken,
      state.sshKeySha256,
    );
    const connection = await this.ensureConnection(ref, state, identity.publicKey);
    const transport = this.transport(state, connection, identity.path);
    if (state.bootstrappedSandboxId !== connection.sandboxId) {
      await bootstrapManagedLinux(transport, { provider: "Modal", useSudo: false });
    }
    return transport;
  }

  async destroy(ref: SandboxRef): Promise<void> {
    const state = this.sandboxState(ref);
    await this.modalJson([
      "--op", "destroy",
      "--app-name", this.appName,
      "--sandbox-name", state.sandboxName,
      "--volume-name", state.volumeName,
      "--owner-token", state.ownerToken,
      "--record-id", ref.id,
      "--allow-unowned-cleanup", state.volumeOwned === true ? "false" : "true",
    ], "destroy owned Sandbox and Volume");
    removeManagedSshIdentity("modal", state.ownerToken);
  }

  async destroyAfterVerifiedCleanupWithoutConnection(ref: SandboxRef): Promise<void> {
    await this.destroy(ref);
  }

  async check(): Promise<ProviderCheckReport> {
    const modalExists = this.bin.includes("/")
      ? existsSync(this.bin)
      : Bun.which(this.bin) !== null;
    const lines = [
      `Modal CLI:          ${modalExists ? this.bin : "MISSING"}`,
      ...managedSshCheckLines(),
    ];
    if (!modalExists) {
      return {
        lines,
        fatal: "install Modal with `python -m pip install modal`, then authenticate",
      };
    }
    if (!managedSshToolsReady()) {
      return { lines, fatal: "install local ssh, rsync, and ssh-keygen for Modal" };
    }
    await this.modalJson(["--op", "check"], "verify account access");
    lines.push(
      "Modal account:       authenticated; token can manage Apps, Sandboxes, and Volumes",
    );
    return { lines };
  }

  private assertKeySha256(value: string): void {
    if (!MODAL_SSH_KEY_SHA256_SHAPE.test(value)) {
      throw new Error("Modal SSH key fingerprint is malformed — state.json corrupted?");
    }
  }

  private persistState(
    ref: SandboxRef,
    state: ModalSandboxState,
    persist?: (sandbox: SandboxState) => void,
  ): void {
    if (persist === undefined) {
      throw new Error("Modal learned durable state without a state journal callback");
    }
    ref.sandbox = state;
    persist(state);
  }

  private async ensureConnection(
    ref: SandboxRef,
    state: ModalSandboxState,
    publicKey: string,
  ): Promise<ModalConnection> {
    const value = await this.modalJson([
      "--op", "ensure",
      "--app-name", this.appName,
      "--sandbox-name", state.sandboxName,
      "--volume-name", state.volumeName,
      "--owner-token", state.ownerToken,
      "--record-id", ref.id,
      "--public-key", publicKey,
      "--image-name", this.imageName,
      "--timeout-seconds", String(this.timeoutSeconds),
      "--allow-initialize", state.volumeOwned === true ? "false" : "true",
    ], "ensure owned Sandbox and Volume");
    return parseConnection(value);
  }

  private transport(
    state: ModalSandboxState,
    connection: ModalConnection,
    identityPath: string,
  ): SshTransport {
    return new SshTransport(`root@${connection.host}`, {
      label: `Modal ${state.sandboxName}`,
      sshOptions: [
        "-p",
        String(connection.port),
        "-i",
        identityPath,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        `HostKeyAlias=modal-${connection.sandboxId}`,
      ],
    });
  }

  private async modalJson(args: string[], what: string): Promise<Record<string, unknown>> {
    const directory = mkdtempSync(join(tmpdir(), "beam-modal-bridge-"));
    const bridgePath = join(directory, "bridge.py");
    writeFileSync(bridgePath, MODAL_BRIDGE_SOURCE, { mode: 0o600 });
    try {
      const result = await run(
        [this.bin, "run", bridgePath, ...args],
        { maxOutputBytes: MODAL_OUTPUT_BYTES_MAX },
      );
      const lines = result.stdout.split("\n")
        .filter((line) => line.startsWith(MODAL_BRIDGE_OUTPUT_PREFIX));
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || "no diagnostic output";
        throw new Error(`Modal could not ${what} (${result.code}): ${detail}`);
      }
      if (lines.length !== 1) {
        throw new Error(`Modal returned ${lines.length} bridge results while trying to ${what}`);
      }
      const text = lines[0]!.slice(MODAL_BRIDGE_OUTPUT_PREFIX.length);
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        throw new Error(`Modal bridge returned malformed JSON while trying to ${what}`);
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Modal bridge returned non-object JSON while trying to ${what}`);
      }
      return value as Record<string, unknown>;
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }
}
