//! Goal: prove SSH argv parity, fail-closed probes, and the same-process
//! no-follow and owner-bound rsync guard without requiring a live SSH server.
//!
//! Method: compare private shell generators with TypeScript goldens, inject a
//! fixture PATH containing scripted ssh/rsync binaries, and execute decoded
//! remote programs against adversarial local filesystems. Every process wait
//! is externally bounded to ten seconds.

use std::collections::BTreeMap;
use std::fs::{self, DirBuilder};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::Value;
use tokio::time::timeout;

use super::*;
use crate::transport::Transport;
use crate::util::shell::{RunInput, RunOptions, run, shq};

const TEST_TIMEOUT: Duration = Duration::from_secs(10);
static FIXTURE_INDEX: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    bin: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let index = FIXTURE_INDEX.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("beam-rust-ssh-{}-{index}", std::process::id()));
        let mut builder = DirBuilder::new();
        builder.mode(0o700);
        builder
            .create(&root)
            .unwrap_or_else(|error| panic!("create fixture {}: {error}", root.display()));
        let root = root
            .canonicalize()
            .unwrap_or_else(|error| panic!("canonicalize fixture {}: {error}", root.display()));
        let bin = root.join("bin");
        fs::create_dir(&bin).expect("create fixture bin");
        Self { root, bin }
    }

    fn environment(&self) -> BTreeMap<String, String> {
        BTreeMap::from([
            (
                "PATH".to_owned(),
                format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", self.bin.display()),
            ),
            ("HOME".to_owned(), self.root.display().to_string()),
            ("LANG".to_owned(), "C".to_owned()),
        ])
    }

    fn script(&self, name: &str, body: &str) {
        let path = self.bin.join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n"))
            .unwrap_or_else(|error| panic!("write {}: {error}", path.display()));
        let mut permissions = fs::metadata(&path)
            .expect("stat fixture script")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).expect("chmod fixture script");
    }

    fn transport(
        &self,
        host: &str,
        options: SshTransportOptions,
    ) -> Result<SshTransport, TransportError> {
        let mut transport = SshTransport::with_options(host, options)?;
        transport.command_environment = Some(self.environment());
        Ok(transport)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap_or_else(|error| {
            panic!("remove fixture {}: {error}", self.root.display());
        });
    }
}

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    timeout(TEST_TIMEOUT, future)
        .await
        .expect("external SSH transport process exceeded 10 seconds")
}

fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../parity/goldens/ssh-transport.json");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn string_array(value: &Value, label: &str) -> Vec<String> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("{label} is an array"))
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .unwrap_or_else(|| panic!("{label} entry is a string"))
                .to_owned()
        })
        .collect()
}

#[test]
fn constructor_and_interactive_argv_match_typescript_golden() {
    let golden = golden();
    let cases = golden["interactiveArgv"]
        .as_array()
        .expect("interactiveArgv corpus is an array");
    for case in cases {
        let options = &case["options"];
        let transport = SshTransport::with_options(
            case["host"].as_str().expect("host is a string"),
            SshTransportOptions {
                rsync_flags: options
                    .get("rsyncFlags")
                    .map(|value| string_array(value, "rsyncFlags")),
                ssh_options: options
                    .get("sshOptions")
                    .map_or_else(Vec::new, |value| string_array(value, "sshOptions")),
                label: options
                    .get("label")
                    .map(|value| value.as_str().expect("label is a string").to_owned()),
            },
        )
        .expect("construct golden SSH transport");
        let command = case["command"].as_str().expect("command is a string");
        assert_eq!(transport.label(), case["transportLabel"]);
        assert_eq!(
            transport.interactive_argv(command),
            string_array(&case["output"], "interactive output"),
            "interactive case {}",
            case["label"]
        );
    }
}

#[test]
fn invalid_hosts_match_typescript_errors() {
    let golden = golden();
    let cases = golden["errors"]
        .as_array()
        .expect("errors corpus is an array");
    for case in cases {
        let host = case["host"].as_str().expect("error host is a string");
        let error = match SshTransport::new(host) {
            Ok(_) => panic!("invalid host {host:?} constructed"),
            Err(error) => error,
        };
        assert_eq!(error.to_string(), case["error"]);
    }
}

#[test]
fn pinned_rsync_programs_match_typescript_golden() {
    let transport = SshTransport::new("unused").expect("construct parity transport");
    let golden = golden();
    let cases = golden["pinnedRsyncPath"]
        .as_array()
        .expect("pinnedRsyncPath corpus is an array");
    for case in cases {
        let owned = case.get("owned").map(|value| OwnedWorkspace {
            root: value["root"].as_str().expect("owned root is a string"),
            owner_bytes: value["ownerBytes"]
                .as_str()
                .expect("owned ownerBytes is a string"),
        });
        let actual = transport
            .pinned_rsync_path(
                case["remoteDir"].as_str().expect("remoteDir is a string"),
                case["create"].as_bool().expect("create is a boolean"),
                owned,
            )
            .expect("generate golden pinned rsync program");
        assert_eq!(actual, case["output"], "pinned case {}", case["label"]);
    }
}

#[tokio::test(flavor = "current_thread")]
async fn scripted_exec_preserves_argv_and_classifies_exists_fail_closed() {
    let fixture = Fixture::new();
    let argv_log = fixture.root.join("ssh-argv");
    let code = fixture.root.join("code");
    let stdout = fixture.root.join("stdout");
    let stderr = fixture.root.join("stderr");
    fixture.script(
        "ssh",
        &format!(
            ": > {log}; for arg in \"$@\"; do printf '%s\\n' \"$arg\" >> {log}; done\n\
             [ -f {stdout} ] && cat {stdout}\n[ -f {stderr} ] && cat {stderr} >&2\n\
             exit \"$(cat {code})\"",
            log = shq(&argv_log.display().to_string()),
            stdout = shq(&stdout.display().to_string()),
            stderr = shq(&stderr.display().to_string()),
            code = shq(&code.display().to_string()),
        ),
    );
    fs::write(&code, "0").expect("set ssh exit code");
    fs::write(&stdout, "remote output\n").expect("set ssh stdout");
    let transport = fixture
        .transport(
            "user@sandbox",
            SshTransportOptions {
                ssh_options: vec!["-p".to_owned(), "2222".to_owned()],
                ..SshTransportOptions::default()
            },
        )
        .expect("construct scripted transport");
    let dynamic: &dyn Transport = &transport;
    let command = "printf %s \"$HOME/it's\"";
    let output = bounded(dynamic.exec_checked(command))
        .await
        .expect("scripted checked exec");
    assert_eq!(output, "remote output");
    let captured = fs::read_to_string(&argv_log).expect("read ssh argv");
    let expected = format!("-p\n2222\nuser@sandbox\n--\nbash\n-lc\n{}\n", shq(command));
    assert_eq!(captured, expected);

    fs::write(&code, "1").expect("set absent exit code");
    fs::write(&stderr, "motd: welcome\n").expect("set ssh stderr");
    assert!(
        !bounded(dynamic.exists("/ws/absent"))
            .await
            .expect("absent path")
    );
    fs::write(&code, "255").expect("set outage exit code");
    fs::write(&stderr, "ssh: Connection timed out\n").expect("set outage stderr");
    let error = bounded(dynamic.exists("/ws/artifacts"))
        .await
        .expect_err("SSH outage must not mean absent");
    assert!(
        error
            .to_string()
            .contains("existence probe did not answer (255)")
    );
    assert!(error.to_string().contains("Connection timed out"));
}

#[tokio::test(flavor = "current_thread")]
async fn rsync_argv_carries_options_and_pins_the_transfer_process() {
    let fixture = Fixture::new();
    let argv_log = fixture.root.join("rsync-argv");
    fixture.script(
        "rsync",
        &format!(
            ": > {log}; for arg in \"$@\"; do printf '%s\\n' \"$arg\" >> {log}; done",
            log = shq(&argv_log.display().to_string()),
        ),
    );
    let local = fixture.root.join("local source");
    fs::create_dir(&local).expect("create local source");
    let transport = fixture
        .transport(
            "user@sandbox",
            SshTransportOptions {
                rsync_flags: Some(vec!["-a".to_owned()]),
                ssh_options: vec![
                    "-i".to_owned(),
                    "/tmp/key with space".to_owned(),
                    "-o".to_owned(),
                    "HostKeyAlias=sandbox-1".to_owned(),
                ],
                label: None,
            },
        )
        .expect("construct rsync transport");
    let excludes = vec!["target".to_owned(), "*.secret file".to_owned()];
    bounded(transport.sync_up(
        &local,
        "/srv/beam/workspace",
        SyncOptions {
            excludes: &excludes,
            delete: true,
            checksum: true,
            ..SyncOptions::default()
        },
    ))
    .await
    .expect("scripted rsync upload");
    let argv = fs::read_to_string(&argv_log).expect("read rsync argv");
    assert!(argv.contains("--delete\n--checksum\n--exclude=target\n"));
    assert!(argv.contains("--exclude=*.secret file\n--rsync-path=exec 3<&0;"));
    assert!(argv.contains("--rsh='ssh' '-i' '/tmp/key with space' '-o'"));
    assert!(argv.ends_with(&format!("{}/\nuser@sandbox:./\n", local.display())));
    assert!(transport.sync_license("/srv/beam/workspace").is_none());

    let destination = fixture.root.join("return/copy");
    bounded(transport.sync_down("/srv/beam/workspace", &destination, SyncOptions::default()))
        .await
        .expect("scripted rsync download");
    assert!(destination.is_dir());
    let down_argv = fs::read_to_string(&argv_log).expect("read download argv");
    assert!(down_argv.ends_with(&format!("user@sandbox:./\n{}/\n", destination.display())));
}

async fn remote_side(
    transport: &SshTransport,
    remote_dir: &str,
    create: bool,
    owned: Option<OwnedWorkspace<'_>>,
    environment: &BTreeMap<String, String>,
) -> ExecResult {
    let program = transport
        .pinned_rsync_path(remote_dir, create, owned)
        .expect("generate remote rsync program");
    let command = format!("{program} --server .");
    let options = RunOptions {
        base_env: Some(environment),
        input: RunInput::Bytes(&[]),
        ..RunOptions::default()
    };
    bounded(run(&["bash", "-c", &command], &options))
        .await
        .expect("execute remote rsync program")
}

#[tokio::test(flavor = "current_thread")]
async fn pinned_remote_program_refuses_symlinks_without_target_mutation() {
    let fixture = Fixture::new();
    let rsync_log = fixture.root.join("rsync-cwd");
    fixture.script(
        "rsync",
        &format!("pwd -P > {}", shq(&rsync_log.display().to_string())),
    );
    let outside = fixture.root.join("outside");
    fs::create_dir(&outside).expect("create outside directory");
    fs::write(outside.join("sentinel"), "untouched").expect("write outside sentinel");
    let workspace_parent = fixture.root.join("root");
    fs::create_dir(&workspace_parent).expect("create workspace parent");
    let workspace = workspace_parent.join("workspace");
    symlink(&outside, &workspace).expect("plant workspace symlink");
    let remote = workspace.join(".beam/session");
    let result = remote_side(
        &SshTransport::new("unused").expect("construct remote transport"),
        remote.to_str().expect("fixture path is UTF-8"),
        true,
        None,
        &fixture.environment(),
    )
    .await;
    assert_eq!(result.code, 61);
    assert!(
        result
            .stderr
            .contains("refusing to sync through symlinked path")
    );
    assert_eq!(fs::read_dir(&outside).expect("read outside").count(), 1);
    assert!(!rsync_log.exists());
}

#[tokio::test(flavor = "current_thread")]
async fn owned_remote_program_refuses_foreign_owner_then_tightens_exact_destination() {
    let fixture = Fixture::new();
    let rsync_log = fixture.root.join("rsync-cwd");
    fixture.script(
        "rsync",
        &format!("pwd -P > {}", shq(&rsync_log.display().to_string())),
    );
    let workspace = fixture.root.join("workspace");
    let reserved = workspace.join(".beam");
    fs::create_dir_all(&reserved).expect("create reserved root");
    fs::write(reserved.join("owner"), "foreign\n").expect("write foreign owner");
    let destination = reserved.join("session/omp");
    let remote = destination.to_str().expect("fixture path is UTF-8");
    let root = workspace.to_str().expect("fixture root is UTF-8");
    let expected_owner = "beam-workspace-v1 rec1 fingerprint";
    let transport = SshTransport::new("unused").expect("construct owned transport");
    let environment = fixture.environment();
    let refused = remote_side(
        &transport,
        remote,
        true,
        Some(OwnedWorkspace {
            root,
            owner_bytes: expected_owner,
        }),
        &environment,
    )
    .await;
    assert_eq!(refused.code, 52);
    assert!(!destination.exists());
    assert!(!rsync_log.exists());

    fs::write(reserved.join("owner"), format!("{expected_owner}\n")).expect("write exact owner");
    let accepted = remote_side(
        &transport,
        remote,
        true,
        Some(OwnedWorkspace {
            root,
            owner_bytes: expected_owner,
        }),
        &environment,
    )
    .await;
    assert_eq!(accepted.code, 0, "{}", accepted.stderr);
    assert_eq!(
        fs::read_to_string(&rsync_log)
            .expect("read rsync cwd")
            .trim(),
        remote
    );
    let mode = fs::metadata(&destination)
        .expect("stat owned destination")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o700);
}
