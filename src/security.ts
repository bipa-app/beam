import type { Transport } from "./transport/types.ts";

/**
 * Privilege posture of a target. beam mirrors the user's whole working tree
 * (secrets included) and then lets an agent execute on the target, so the
 * transport credential defines the blast radius. These probes detect the
 * configurations that silently widen it:
 *
 *  - logging in as root: the agent and the purge path own the machine;
 *  - passwordless sudo: the agent can escalate to root at will;
 *  - a workspace root outside the login user's home: the mirrored tree
 *    (secrets included) may be readable by other users on a shared box;
 *  - a mounted Kubernetes ServiceAccount token: the agent can call the
 *    cluster API with whatever that ServiceAccount is bound to;
 *  - a mounted Docker socket: the agent can drive the daemon, which is
 *    root-equivalent on the host.
 *
 * Probes warn, never block: shared boxes and containers legitimately differ,
 * and the operator may have compensating controls beam cannot see.
 */
export interface PrivilegeReport {
  user: string;
  warnings: string[];
}

export async function probePrivilege(t: Transport, rootAbs: string): Promise<PrivilegeReport> {
  const user = (await t.exec("whoami")).stdout.trim();
  const warnings: string[] = [];

  if (user === "root") {
    warnings.push(
      "target user is root — the agent and beam's purge own the whole machine; " +
        "create a dedicated unprivileged user (README: Least-privilege server setup)",
    );
  } else {
    const sudo = await t.exec("sudo -n true 2>/dev/null");
    if (sudo.code === 0) {
      warnings.push(
        "target user has passwordless sudo — the beamed agent can escalate to root; " +
          "remove it from sudoers (or require a password)",
      );
    }
  }

  // Outside-home exposure only matters when other human users exist on the
  // box — and that is observable, not a property of the target type: count
  // passwd entries with a human uid (>= 1000, below the nobody range). An
  // unanswerable probe counts as shared — fail toward the warning.
  const home = (await t.exec('printf %s "$HOME"')).stdout.trim();
  if (home !== "" && !rootAbs.startsWith(home + "/") && rootAbs !== home) {
    const passwd = await t.exec("getent passwd 2>/dev/null || cat /etc/passwd 2>/dev/null");
    const humans =
      passwd.code === 0
        ? passwd.stdout.split("\n").filter((line) => {
            const uid = Number(line.split(":")[2]);
            return Number.isInteger(uid) && uid >= 1000 && uid < 60000;
          }).length
        : 2; // unprovable: assume shared
    if (humans > 1) {
      warnings.push(
        `workspace root ${rootAbs} is outside the target user's home — on a shared box ` +
          "other users may read the mirrored tree (secrets included); prefer ~/beam",
      );
    }
  }

  // Cheap sandbox-posture probes: each is a root-equivalent (or
  // cluster-reaching) capability driven by plain filesystem access.
  const saToken = await t.exec("test -e /var/run/secrets/kubernetes.io/serviceaccount/token");
  if (saToken.code === 0) {
    warnings.push(
      "a Kubernetes ServiceAccount token is mounted at /var/run/secrets/kubernetes.io/serviceaccount — " +
        "the beamed agent can call the cluster API as that ServiceAccount; " +
        "set automountServiceAccountToken: false in the sandbox template",
    );
  }
  const dockerSock = await t.exec("test -S /var/run/docker.sock");
  if (dockerSock.code === 0) {
    warnings.push(
      "the Docker socket is mounted at /var/run/docker.sock — the beamed agent can drive the daemon " +
        "(root-equivalent); remove the mount from the sandbox template",
    );
  }

  return { user, warnings };
}
