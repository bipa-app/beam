/**
 * Goal: The public installer selects and verifies the matching release binary
 * without damaging an existing Beam install when verification fails.
 *
 * Method: Run the real POSIX installer with fake uname and curl executables,
 * a local release fixture, and disposable HOME and install directories.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const INSTALLER = resolve(import.meta.dir, "../site/install");
const roots: string[] = [];
const BINARY_CONTENT = "#!/usr/bin/env sh\nexit 0\n";

const FAKE_UNAME = `#!/usr/bin/env sh
set -eu
case "\${1:-}" in
  -s) printf '%s\\n' "$BEAM_TEST_OS" ;;
  -m) printf '%s\\n' "$BEAM_TEST_ARCH" ;;
  *) exit 64 ;;
esac
`;

const FAKE_CURL = `#!/usr/bin/env sh
set -eu
ARGUMENT_COUNT_MAX=32
argument_count=0
output=""
url=""
while [ "$#" -gt 0 ]; do
  argument_count=$((argument_count + 1))
  if [ "$argument_count" -gt "$ARGUMENT_COUNT_MAX" ]; then
    echo "fake curl argument bound exceeded" >&2
    exit 64
  fi
  case "$1" in
    --output)
      output="$2"
      shift 2
      ;;
    https://*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
if [ -z "$output" ] || [ -z "$url" ]; then
  echo "fake curl did not receive output and URL" >&2
  exit 64
fi
asset="\${url##*/}"
cp "$BEAM_TEST_RELEASE/$asset" "$output"
`;

interface FixtureOptions {
  os: string;
  arch: string;
  asset: string;
  checksumValid: boolean;
}

interface InstallerFixture {
  binary: string;
  env: Record<string, string>;
  installDirectory: string;
}

interface InstallerResult {
  code: number;
  stdout: string;
  stderr: string;
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function fixture(options: FixtureOptions): InstallerFixture {
  const root = mkdtempSync(join(tmpdir(), "beam-install-"));
  roots.push(root);
  const binaryDirectory = join(root, "bin");
  const home = join(root, "home");
  const installDirectory = join(root, "installed");
  const release = join(root, "release");
  const temporary = join(root, "tmp");
  for (const directory of [binaryDirectory, home, installDirectory, release, temporary]) {
    mkdirSync(directory, { recursive: true });
  }
  writeExecutable(join(binaryDirectory, "uname"), FAKE_UNAME);
  writeExecutable(join(binaryDirectory, "curl"), FAKE_CURL);
  writeExecutable(join(release, options.asset), BINARY_CONTENT);
  const actualHash = createHash("sha256").update(BINARY_CONTENT).digest("hex");
  const checksum = options.checksumValid ? actualHash : "0".repeat(64);
  writeFileSync(join(release, "SHA256SUMS"), `${checksum}  ${options.asset}\n`);
  return {
    binary: join(installDirectory, "beam"),
    installDirectory,
    env: {
      ...process.env,
      BEAM_INSTALL_DIR: installDirectory,
      BEAM_TEST_ARCH: options.arch,
      BEAM_TEST_OS: options.os,
      BEAM_TEST_RELEASE: release,
      HOME: home,
      PATH: `${binaryDirectory}${delimiter}${process.env.PATH ?? ""}`,
      SHELL: "/bin/zsh",
      TMPDIR: temporary,
    },
  };
}

async function runInstaller(value: InstallerFixture): Promise<InstallerResult> {
  const child = Bun.spawn(["sh", INSTALLER], {
    cwd: value.installDirectory,
    env: value.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("public install script", () => {
  test.each([
    ["Darwin", "arm64", "beam-darwin-arm64"],
    ["Darwin", "x86_64", "beam-darwin-x64"],
    ["Linux", "aarch64", "beam-linux-arm64"],
    ["Linux", "amd64", "beam-linux-x64"],
  ])("installs the verified %s/%s release asset", async (os, arch, asset) => {
    const value = fixture({ os, arch, asset, checksumValid: true });
    const result = await runInstaller(value);
    expect(result.code).toBe(0);
    expect(readFileSync(value.binary, "utf8")).toBe(BINARY_CONTENT);
    expect(statSync(value.binary).mode & 0o777).toBe(0o755);
    expect(result.stdout).toContain(`Installed Beam to ${value.binary}`);
    const pathInstruction = `export PATH="${value.installDirectory}:$PATH"`;
    expect(result.stdout).toContain(pathInstruction);
    const profileInstruction = `printf '\\nexport PATH="${value.installDirectory}:$PATH"\\n'`;
    expect(result.stdout).toContain(profileInstruction);
  });

  test("a checksum mismatch leaves the existing binary unchanged", async () => {
    const value = fixture({
      os: "Darwin",
      arch: "arm64",
      asset: "beam-darwin-arm64",
      checksumValid: false,
    });
    writeExecutable(value.binary, "existing beam\n");
    const result = await runInstaller(value);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("checksum mismatch for beam-darwin-arm64");
    expect(readFileSync(value.binary, "utf8")).toBe("existing beam\n");
  });

  test("an unsupported platform fails before downloading", async () => {
    const value = fixture({
      os: "Plan9",
      arch: "amd64",
      asset: "beam-plan9-x64",
      checksumValid: true,
    });
    const result = await runInstaller(value);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unsupported operating system: Plan9");
  });
});
