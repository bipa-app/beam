import type { Transport } from "./transport/types.ts";
import { shq } from "./util/shell.ts";

/**
 * Fused remote probe protocol.
 *
 * beam's health probes (`beam check`, probePrivilege) used to issue one
 * transport exec per question, which made check O(n) round trips over a
 * real network. Each probe battery now ships as ONE shell script whose
 * answers come back as sentinel-prefixed records on stdout:
 *
 *   <sentinel> <key> <code> <bytes> <value>
 *   ...
 *   <sentinel> end <count>
 *
 * The stream is untrusted transport output: login-shell noise is ignored
 * (no sentinel prefix), everything else fails closed. A missing or short
 * trailer (truncation), a duplicate key, a value whose byte length
 * disagrees with its record, or an out-of-range number rejects the whole
 * result instead of degrading into a half-parsed report.
 */

/** One probe answer: the probe's exit code plus its captured stdout. */
export interface ProbeRecord {
  code: number;
  value: string;
}

/** Probe values are single paths, user names, or counters — never trees. */
export const PROBE_VALUE_MAX_BYTES = 4096;
/** Ceiling on records in one fused result (`beam check` emits about 10). */
export const PROBE_MAX_RECORDS = 64;
/** Ceiling on stdout lines scanned for records before rejecting. */
export const PROBE_MAX_OUTPUT_LINES = 10_000;

/** Sentinels are versioned internal constants, never user input. */
const SENTINEL_SHAPE = /^__[a-z0-9_]+__$/;

function assertSentinel(sentinel: string): void {
  if (!SENTINEL_SHAPE.test(sentinel)) {
    throw new Error(`beam: invalid probe sentinel: ${sentinel}`);
  }
}

/**
 * Script prelude: `set +e` undoes any login-profile errexit (failing
 * probes are the data, not errors), LC_ALL=C pins `${#var}` to bytes, and
 * `__beam_emit <key> <code> <value>` prints one length-checked record.
 */
export function probeScriptPrelude(sentinel: string): string[] {
  assertSentinel(sentinel);
  return [
    "set +e",
    "export LC_ALL=C",
    "__beam_n=0",
    "__beam_emit() {",
    "  printf '%s %s %s %s %s\\n' " + shq(sentinel) + ' "$1" "$2" "${#3}" "$3"',
    "  __beam_n=$((__beam_n+1))",
    "}",
  ];
}

/** Script trailer: declares the record count the parser must see. */
export function probeScriptTrailer(sentinel: string): string[] {
  assertSentinel(sentinel);
  return [`printf '%s end %s\\n' ${shq(sentinel)} "$__beam_n"`];
}

const RECORD_SHAPE = /^([a-z][a-z0-9._-]{0,31}) ([0-9]{1,3}) ([0-9]{1,4}) (.*)$/;
const TRAILER_SHAPE = /^end ([0-9]{1,3})$/;

function malformed(detail: string): Error {
  return new Error(`beam: malformed probe output (${detail}) — refusing`);
}

/**
 * Parse one fused probe result. Non-sentinel lines are tolerated (login
 * shells print banners); any sentinel line that is not a well-formed
 * record, and any structural inconsistency, fails the WHOLE parse.
 */
export function parseProbeRecords(sentinel: string, stdout: string): Map<string, ProbeRecord> {
  assertSentinel(sentinel);
  const lines = stdout.split("\n");
  if (lines.length > PROBE_MAX_OUTPUT_LINES) throw malformed("output exceeds the line ceiling");
  const records = new Map<string, ProbeRecord>();
  let declaredCount: number | undefined;
  for (const line of lines) {
    if (!line.startsWith(`${sentinel} `)) continue; // banner/rc-file noise
    if (declaredCount !== undefined) throw malformed("records after the end trailer");
    const rest = line.slice(sentinel.length + 1);
    const trailer = TRAILER_SHAPE.exec(rest);
    if (trailer !== null) {
      declaredCount = Number(trailer[1]);
      continue;
    }
    const m = RECORD_SHAPE.exec(rest);
    if (m === null) throw malformed(`unparseable record line: ${rest}`);
    const key = m[1] as string;
    const code = Number(m[2]);
    const bytes = Number(m[3]);
    const value = m[4] as string;
    if (!Number.isSafeInteger(code) || code < 0 || code > 255) {
      throw malformed(`exit code out of range for ${key}`);
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > PROBE_VALUE_MAX_BYTES) {
      throw malformed(`value size out of range for ${key}`);
    }
    if (Buffer.byteLength(value, "utf8") !== bytes) {
      throw malformed(`value length mismatch for ${key}`);
    }
    if (records.has(key)) throw malformed(`duplicate record: ${key}`);
    if (records.size >= PROBE_MAX_RECORDS) throw malformed("too many records");
    records.set(key, { code, value });
  }
  if (declaredCount === undefined) {
    throw malformed("missing end trailer — output may be truncated");
  }
  if (declaredCount !== records.size) {
    throw malformed(`trailer declares ${declaredCount} records, got ${records.size}`);
  }
  return records;
}

/** Fetch a required record; absence is malformed output (fail closed). */
export function requireProbeRecord(records: Map<string, ProbeRecord>, key: string): ProbeRecord {
  const rec = records.get(key);
  if (rec === undefined) throw malformed(`missing ${key} record`);
  return rec;
}

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

export const PRIVILEGE_SENTINEL = "__beam_privilege_v1__";

const PRIVILEGE_KEYS = ["user", "sudo", "home", "passwd", "satoken", "dockersock"] as const;

/** Human uid window: >= 1000, below the nobody range. */
const HUMAN_UID_MIN = 1000;
const HUMAN_UID_BELOW = 60000;

/** An unanswerable or malformed tenancy probe counts as a shared box. */
const ASSUMED_SHARED_HUMANS = 2;

/**
 * All privilege probes fused into one script. Every probe runs
 * unconditionally (they are all cheap and side-effect free); the CLIENT
 * decides which answers matter, so the record set stays fixed.
 */
function privilegeProbeScript(): string {
  const humanFilter =
    `awk -F: '$3 ~ /^[0-9]+$/ && $3 >= ${HUMAN_UID_MIN} && $3 < ${HUMAN_UID_BELOW}' | wc -l`;
  return [
    ...probeScriptPrelude(PRIVILEGE_SENTINEL),
    '__beam_v=$(whoami 2>/dev/null); __beam_emit user "$?" "$__beam_v"',
    '(sudo -n true) >/dev/null 2>&1; __beam_emit sudo "$?" ""',
    '__beam_emit home 0 "$HOME"',
    "__beam_v=$(getent passwd 2>/dev/null || cat /etc/passwd 2>/dev/null); __beam_rc=$?",
    `__beam_v=$(printf '%s\\n' "$__beam_v" | ${humanFilter})`,
    '__beam_emit passwd "$__beam_rc" "$__beam_v"',
    "(test -e /var/run/secrets/kubernetes.io/serviceaccount/token) >/dev/null 2>&1; " +
      '__beam_emit satoken "$?" ""',
    '(test -S /var/run/docker.sock) >/dev/null 2>&1; __beam_emit dockersock "$?" ""',
    ...probeScriptTrailer(PRIVILEGE_SENTINEL),
  ].join("\n");
}

/**
 * Parse the remote-computed human-user count. The probe fails toward the
 * warning: an unanswerable passwd (nonzero code) or a count that is not a
 * plain bounded integer counts as a shared box.
 */
function parseHumanCount(rec: ProbeRecord): number {
  if (rec.code !== 0) return ASSUMED_SHARED_HUMANS;
  const digits = rec.value.trim();
  if (!/^[0-9]{1,7}$/.test(digits)) return ASSUMED_SHARED_HUMANS;
  const count = Number(digits);
  return Number.isSafeInteger(count) ? count : ASSUMED_SHARED_HUMANS;
}

/** One transport exec, always — the probe count never varies. */
export async function probePrivilege(t: Transport, rootAbs: string): Promise<PrivilegeReport> {
  const res = await t.exec(privilegeProbeScript());
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    throw new Error(
      `beam: the privilege probe script failed (${res.code})` +
        `${detail ? `: ${detail}` : ""} — refusing`,
    );
  }
  const records = parseProbeRecords(PRIVILEGE_SENTINEL, res.stdout);
  if (records.size !== PRIVILEGE_KEYS.length) {
    throw malformed("unexpected privilege record set");
  }
  const rec = (key: (typeof PRIVILEGE_KEYS)[number]) => requireProbeRecord(records, key);

  const user = rec("user").value.trim();
  const warnings: string[] = [];

  if (user === "root") {
    warnings.push(
      "target user is root — the agent and beam's purge own the whole machine; " +
        "create a dedicated unprivileged user (README: Least-privilege server setup)",
    );
  } else {
    if (rec("sudo").code === 0) {
      warnings.push(
        "target user has passwordless sudo — the beamed agent can escalate to root; " +
          "remove it from sudoers (or require a password)",
      );
    }
  }

  // Outside-home exposure only matters when other human users exist on the
  // box — and that is observable, not a property of the target type: count
  // passwd entries with a human uid. An unanswerable probe counts as
  // shared — fail toward the warning.
  const home = rec("home").value.trim();
  if (home !== "" && !rootAbs.startsWith(home + "/") && rootAbs !== home) {
    if (parseHumanCount(rec("passwd")) > 1) {
      warnings.push(
        `workspace root ${rootAbs} is outside the target user's home — on a shared box ` +
          "other users may read the mirrored tree (secrets included); prefer ~/beam",
      );
    }
  }

  // Cheap sandbox-posture probes: each is a root-equivalent (or
  // cluster-reaching) capability driven by plain filesystem access.
  if (rec("satoken").code === 0) {
    warnings.push(
      "a Kubernetes ServiceAccount token is mounted at " +
        "/var/run/secrets/kubernetes.io/serviceaccount — " +
        "the beamed agent can call the cluster API as that ServiceAccount; " +
        "set automountServiceAccountToken: false in the sandbox template",
    );
  }
  if (rec("dockersock").code === 0) {
    warnings.push(
      "the Docker socket is mounted at /var/run/docker.sock — " +
        "the beamed agent can drive the daemon " +
        "(root-equivalent); remove the mount from the sandbox template",
    );
  }

  return { user, warnings };
}
