import type { Transport } from "./transport/types.ts";

/**
 * Privilege posture of a target. beam mirrors the user's whole working tree
 * (secrets included) and then lets an agent execute on the target, so the
 * transport credential defines the blast radius. These probes detect the
 * three configurations that silently widen it:
 *
 *  - logging in as root: the agent and the purge path own the machine;
 *  - passwordless sudo: the agent can escalate to root at will;
 *  - a workspace root outside the login user's home: the mirrored tree
 *    (secrets included) may be readable by other users on a shared box.
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

  const home = (await t.exec('printf %s "$HOME"')).stdout.trim();
  if (home !== "" && !rootAbs.startsWith(home + "/") && rootAbs !== home) {
    warnings.push(
      `workspace root ${rootAbs} is outside the target user's home — on a shared box ` +
        "other users may read the mirrored tree (secrets included); prefer ~/beam",
    );
  }

  return { user, warnings };
}
