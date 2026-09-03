//! Goal: prove Box lifecycle parity, durable identity publication, and pinned
//! SSH behavior without using a paid provider account.
//!
//! Method: scripted box/ssh/rsync binaries keep VM state in a private fixture.
//! Tests drive real child processes through create, reconnect, resume, purge,
//! malformed output, and recovery edges with every process bounded by Beam.

use std::fs::{self, DirBuilder};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

use super::*;
use crate::transport::SyncOptions;
use crate::util::shell::shq;

const BOX_ID: &str = "bx_fixture1";
static FIXTURE_INDEX: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    bin: PathBuf,
    environment: BTreeMap<String, String>,
}

impl Fixture {
    fn new() -> Self {
        let index = FIXTURE_INDEX.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "beam-rust-box-provider-{}-{index}",
            std::process::id()
        ));
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
        let environment = BTreeMap::from([
            ("HOME".to_owned(), root.display().to_string()),
            ("LANG".to_owned(), "C".to_owned()),
            ("PATH".to_owned(), bin.display().to_string()),
        ]);
        let fixture = Self {
            root,
            bin,
            environment,
        };
        fixture.install_commands();
        fixture.reset("normal");
        fixture
    }

    fn install_commands(&self) {
        let root = shq(&self.root.display().to_string());
        self.script(
            "box",
            &format!(
                r#"fixture={root}
printf '%s\n' "$*" >> "$fixture/box.log"
mode=$(/bin/cat "$fixture/mode")
case "$1" in
  new)
    if [ "$mode" = malformed-json ]; then printf '%s\n' '{{not-json'; exit 0; fi
    if [ "$mode" = too-many-lines ]; then
      i=0
      while [ "$i" -lt 257 ]; do printf '%s\n' '{{"event":"progress"}}'; i=$((i + 1)); done
      exit 0
    fi
    printf '%s\n' '{{"event":"created","id":"{BOX_ID}","ttlSeconds":7200}}'
    /usr/bin/touch "$fixture/present"
    if [ "$mode" = persist-barrier ] && [ ! -f "$fixture/published" ]; then
      printf '%s\n' '{{"event":"error","error":"identity was not published"}}'
      exit 8
    fi
    if [ "$mode" = fail-after-created ]; then
      printf '%s\n' '{{"event":"error","error":"fixture failure","code":"fixture"}}'
      exit 9
    fi
    if [ "$mode" = conflicting-created ]; then
      printf '%s\n' '{{"event":"created","id":"bx_fixture2"}}'
      exit 0
    fi
    printf '%s' ready > "$fixture/state"
    if [ "$mode" = invalid-ip ]; then ip=not-an-ip; else ip=203.0.113.10; fi
    ready_id={BOX_ID}
    if [ "$mode" = mismatched-ready ]; then ready_id=bx_fixture2; fi
    printf '{{"event":"ready","id":"%s","state":"ready","ip":"%s"}}\n' "$ready_id" "$ip"
    ;;
  info)
    if [ ! -f "$fixture/present" ]; then
      printf '%s\n' '{{"event":"error","error":"not found","code":"not_found"}}'
      exit 1
    fi
    state=$(/bin/cat "$fixture/state")
    if [ -f "$fixture/ip" ]; then ip=$(/bin/cat "$fixture/ip"); else ip=203.0.113.10; fi
    info_id={BOX_ID}
    if [ "$mode" = mismatched-info ]; then info_id=bx_foreign; fi
    printf '{{"box":{{"id":"%s","state":"%s","ip":"%s"}}}}\n' "$info_id" "$state" "$ip"
    ;;
  resume)
    printf '%s' ready > "$fixture/state"
    printf '%s\n' '{{"event":"action","id":"{BOX_ID}","action":"resume"}}'
    ;;
  delete)
    /bin/rm -f "$fixture/present" "$fixture/state"
    printf '%s\n' '{{"event":"deleted","id":"{BOX_ID}"}}'
    ;;
  ssh)
    if [ "$mode" = ssh-fail ]; then printf '%s\n' 'ssh denied' >&2; exit 7; fi
    ;;
  limits)
    if [ "$mode" = account-fail ]; then exit 5; fi
    printf '%s\n' '{{"limits":{{"maxBoxes":1}}}}'
    ;;
  *)
    printf 'unexpected command: %s\n' "$1" >&2
    exit 2
    ;;
esac"#
            ),
        );
        self.script("ssh", &format!("printf '%s\\n' \"$*\" >> {root}/ssh.log"));
        self.script(
            "rsync",
            &format!("printf '%s\\n' \"$*\" >> {root}/rsync.log"),
        );
    }

    fn script(&self, name: &str, body: &str) {
        let path = self.bin.join(name);
        fs::write(&path, format!("#!/bin/sh\nset -eu\n{body}\n"))
            .unwrap_or_else(|error| panic!("write {}: {error}", path.display()));
        let mut permissions = fs::metadata(&path).expect("stat script").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).expect("chmod script");
    }

    fn reset(&self, mode: &str) {
        for name in [
            "box.log",
            "ssh.log",
            "rsync.log",
            "present",
            "published",
            "state",
            "ip",
        ] {
            let path = self.root.join(name);
            if let Err(error) = fs::remove_file(&path)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                panic!("remove {}: {error}", path.display());
            }
        }
        fs::write(self.root.join("mode"), mode).expect("write fixture mode");
    }

    fn provider(&self, spec: BoxTargetSpec) -> BoxProvider {
        let mut provider =
            BoxProvider::with_binary(spec, self.bin.join("box").display().to_string())
                .expect("construct Box provider");
        provider.command_environment = Some(self.environment.clone());
        provider
    }

    fn read(&self, name: &str) -> String {
        fs::read_to_string(self.root.join(name))
            .unwrap_or_else(|error| panic!("read {name}: {error}"))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root)
            .unwrap_or_else(|error| panic!("remove fixture {}: {error}", self.root.display()));
    }
}

fn spec() -> BoxTargetSpec {
    BoxTargetSpec {
        root: None,
        machine_type: None,
        environment: None,
        ttl_seconds: None,
    }
}

fn sandbox_reference(id: &str) -> SandboxRef {
    SandboxRef {
        id: id.to_owned(),
        sandbox: None,
    }
}

fn failure<T>(result: Result<T, ProviderError>) -> ProviderError {
    match result {
        Ok(_) => panic!("operation unexpectedly succeeded"),
        Err(error) => error,
    }
}

fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../parity/goldens/box-provider.json");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

#[test]
fn pure_provider_contract_matches_typescript_golden() {
    let expected = golden();
    let default = BoxProvider::new(spec()).expect("construct default provider");
    assert_eq!(default.label(), expected["provider"]["label"]);
    assert_eq!(
        default.reuses_sandbox(),
        expected["provider"]["reusesSandbox"]
    );
    assert_eq!(default.create_args(), ["new", "--no-auto-stop", "--json"]);
    assert_eq!(
        default.resume_args(BOX_ID),
        ["resume", BOX_ID, "--no-auto-stop", "--json"]
    );
    let explicit = BoxProvider::new(BoxTargetSpec {
        root: None,
        machine_type: Some("small".to_owned()),
        environment: Some("beam".to_owned()),
        ttl_seconds: Some(7200),
    })
    .expect("construct explicit provider");
    let expected_args = &expected["configurations"][1];
    assert_eq!(
        serde_json::json!(explicit.create_args()),
        expected_args["createArgs"]
    );
    assert_eq!(
        serde_json::json!(explicit.resume_args(BOX_ID)),
        expected_args["resumeArgs"]
    );
}

#[test]
fn validation_errors_match_typescript_golden() {
    let errors = golden()["errors"].clone();
    let cases = [
        (
            BoxTargetSpec {
                machine_type: Some("tiny".to_owned()),
                ..spec()
            },
            "invalidMachineType",
        ),
        (
            BoxTargetSpec {
                environment: Some(" ".to_owned()),
                ..spec()
            },
            "emptyEnvironment",
        ),
        (
            BoxTargetSpec {
                ttl_seconds: Some(0),
                ..spec()
            },
            "zeroTtl",
        ),
        (
            BoxTargetSpec {
                ttl_seconds: Some(BOX_TTL_SECONDS_MAX + 1),
                ..spec()
            },
            "excessiveTtl",
        ),
    ];
    for (target, label) in cases {
        let error = failure(BoxProvider::new(target));
        assert_eq!(error.to_string(), errors[label]);
    }
}

#[tokio::test(flavor = "current_thread")]
async fn publishes_created_identity_before_the_cli_continues() {
    let fixture = Fixture::new();
    fixture.reset("persist-barrier");
    let provider = fixture.provider(spec());
    let mut reference = sandbox_reference("fresh");
    let published = RefCell::new(Vec::new());
    let mut persist = |state| {
        published.borrow_mut().push(state);
        fs::write(fixture.root.join("published"), "yes")
            .map_err(|error| ProviderError::message(error.to_string()))?;
        Ok(())
    };
    let transport = provider
        .provision(&mut reference, Some(&mut persist))
        .await
        .expect("provision after synchronous identity publication");
    assert_eq!(transport.label(), format!("box {BOX_ID}"));
    assert_eq!(published.into_inner(), [box_state()]);
    assert_eq!(reference.sandbox, Some(box_state()));
}

#[tokio::test(flavor = "current_thread")]
async fn retains_published_identity_across_creation_and_journal_failures() {
    let fixture = Fixture::new();
    fixture.reset("fail-after-created");
    let provider = fixture.provider(spec());
    let mut reference = sandbox_reference("early");
    let mut published = Vec::new();
    let mut persist = |state| {
        published.push(state);
        Ok(())
    };
    let error = failure(provider.provision(&mut reference, Some(&mut persist)).await);
    assert!(
        error
            .to_string()
            .contains("Box creation failed (9): fixture failure")
    );
    assert_eq!(reference.sandbox, Some(box_state()));
    assert_eq!(published, [box_state()]);
    assert!(!fixture.root.join("ssh.log").exists());

    fixture.reset("normal");
    let provider = fixture.provider(spec());
    let mut reference = sandbox_reference("journal");
    let mut persist = |_state| Err(ProviderError::message("journal failed".to_owned()));
    let error = failure(provider.provision(&mut reference, Some(&mut persist)).await);
    assert_eq!(error.to_string(), "journal failed");
    assert_eq!(reference.sandbox, Some(box_state()));
    assert!(!fixture.root.join("ssh.log").exists());
}

#[tokio::test(flavor = "current_thread")]
async fn bootstraps_and_syncs_over_pinned_ssh_options() {
    let fixture = Fixture::new();
    let provider = fixture.provider(spec());
    let mut reference = sandbox_reference("pinned");
    let transport = provider
        .provision(&mut reference, None)
        .await
        .expect("provision Box");
    transport
        .sync_up(&fixture.root, "~/beam/fixture", SyncOptions::default())
        .await
        .expect("sync through Box transport");
    let box_log = fixture.read("box.log");
    assert!(box_log.contains("new --no-auto-stop --json"));
    assert!(box_log.contains(&format!("ssh {BOX_ID} -- true")));
    let ssh_log = fixture.read("ssh.log");
    assert!(ssh_log.contains(".ssh/ascii_box_ed25519"));
    assert!(ssh_log.contains("IdentitiesOnly=yes"));
    assert!(ssh_log.contains("BatchMode=yes"));
    assert!(ssh_log.contains("StrictHostKeyChecking=accept-new"));
    assert!(ssh_log.contains(&format!("HostKeyAlias={BOX_ID}")));
    assert!(ssh_log.contains("sha256sum -c -"));
    assert!(ssh_log.contains("/usr/local/bin/herdr"));
    let rsync_log = fixture.read("rsync.log");
    assert!(rsync_log.contains("--rsh="));
    assert!(rsync_log.contains(&format!("HostKeyAlias={BOX_ID}")));
    assert!(rsync_log.contains("user@203.0.113.10:./"));
}

#[tokio::test(flavor = "current_thread")]
async fn resumes_with_explicit_lifecycle_args_and_reresolves_the_ip() {
    let fixture = Fixture::new();
    let provider = fixture.provider(BoxTargetSpec {
        root: None,
        machine_type: Some("small".to_owned()),
        environment: Some("beam".to_owned()),
        ttl_seconds: Some(7200),
    });
    let mut reference = sandbox_reference("trial");
    provider
        .provision(&mut reference, None)
        .await
        .expect("provision trial Box");
    fs::write(fixture.root.join("state"), "stopped").expect("stop fixture Box");
    fs::write(fixture.root.join("ip"), "203.0.113.11").expect("change fixture IP");
    let transport = provider
        .connect(Some(&reference))
        .await
        .expect("resume Box");
    transport
        .exec("true")
        .await
        .expect("exercise re-resolved SSH address");
    let box_log = fixture.read("box.log");
    assert!(box_log.contains("new --type small --environment=beam --ttl 7200 --json"));
    assert!(box_log.contains(&format!("resume {BOX_ID} --ttl 7200 --json")));
    assert!(fixture.read("ssh.log").contains("user@203.0.113.11"));
}

#[tokio::test(flavor = "current_thread")]
async fn deletes_only_the_persisted_box_and_converges_on_absence() {
    let fixture = Fixture::new();
    let provider = fixture.provider(spec());
    let mut reference = sandbox_reference("purge");
    provider
        .provision(&mut reference, None)
        .await
        .expect("provision purge fixture");
    provider
        .destroy_after_verified_cleanup_without_connection(&reference)
        .expect("Box supports disconnected verified cleanup")
        .await
        .expect("delete persisted Box");
    assert!(!fixture.root.join("present").exists());
    provider
        .destroy(&reference)
        .await
        .expect("absence should converge");
    let box_log = fixture.read("box.log");
    let deletes = box_log
        .lines()
        .filter(|line| line.starts_with("delete "))
        .collect::<Vec<_>>();
    assert_eq!(deletes, [format!("delete {BOX_ID} --yes --json")]);
}

#[tokio::test(flavor = "current_thread")]
async fn rejects_malformed_or_conflicting_creation_output_after_publication() {
    for (mode, expected, published) in [
        ("malformed-json", "malformed JSON", false),
        ("invalid-ip", "no usable IPv4 address", true),
        ("conflicting-created", "two different ids", true),
        ("mismatched-ready", "did not match the id persisted", true),
        ("too-many-lines", "256-line per-stream cap", false),
    ] {
        let fixture = Fixture::new();
        fixture.reset(mode);
        let provider = fixture.provider(spec());
        let mut reference = sandbox_reference(mode);
        let error = failure(provider.provision(&mut reference, None).await);
        assert!(error.to_string().contains(expected), "{mode}: {error}");
        assert_eq!(reference.sandbox.is_some(), published, "{mode}");
        assert!(!fixture.root.join("ssh.log").exists(), "{mode}");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn rejects_foreign_state_and_mismatched_info_before_ssh() {
    let fixture = Fixture::new();
    let provider = fixture.provider(spec());
    let foreign = SandboxRef {
        id: "foreign".to_owned(),
        sandbox: Some(SandboxState::AgentSandbox(
            crate::provider::AgentSandboxState {
                claim: "beam-foreign".to_owned(),
                context: "ctx".to_owned(),
                namespace: "beam-user".to_owned(),
                container: "sandbox".to_owned(),
                kubeconfig: None,
                template: None,
                uid: None,
            },
        )),
    };
    let error = failure(provider.connect(Some(&foreign)).await);
    assert!(
        error
            .to_string()
            .contains("stores an Agent Sandbox identity")
    );
    assert!(!fixture.root.join("box.log").exists());

    fixture.reset("mismatched-info");
    fs::write(fixture.root.join("present"), "yes").expect("plant Box");
    fs::write(fixture.root.join("state"), "ready").expect("plant ready state");
    let persisted = SandboxRef {
        id: "persisted".to_owned(),
        sandbox: Some(box_state()),
    };
    let error = failure(provider.connect(Some(&persisted)).await);
    assert!(error.to_string().contains("while Beam requested"));
    assert!(!fixture.root.join("ssh.log").exists());
}

#[tokio::test(flavor = "current_thread")]
async fn check_reports_account_and_local_tool_failures() {
    let fixture = Fixture::new();
    let provider = fixture.provider(spec());
    let ready = provider.check().await.expect("check ready Box fixture");
    assert!(ready.fatal.is_none());
    assert!(
        ready
            .lines
            .contains(&"Box account: authenticated and able to read limits".to_owned())
    );

    fixture.reset("account-fail");
    let account = provider
        .check()
        .await
        .expect("check failed account fixture");
    assert!(
        account
            .fatal
            .as_deref()
            .is_some_and(|fatal| fatal.contains("box onboard"))
    );
    fs::remove_file(fixture.bin.join("rsync")).expect("remove rsync fixture");
    fixture.reset("normal");
    let tools = provider.check().await.expect("check missing tool fixture");
    assert_eq!(
        tools.fatal.as_deref(),
        Some("install local ssh and rsync before using a Box target")
    );
}

fn box_state() -> SandboxState {
    SandboxState::Managed(ManagedSandboxState::Box(BoxSandboxState {
        box_id: BOX_ID.to_owned(),
    }))
}
