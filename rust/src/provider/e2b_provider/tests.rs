//! Goal: prove E2B reservation recovery, identity checks, lifecycle, and SSH
//! construction without creating a paid sandbox.
//!
//! Method: an in-memory API fixture records the REST protocol while scripted
//! ssh/rsync/keygen commands exercise the real managed-key and transport seams.
//! One loopback request proves the production ureq header and path contract.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs::{self, DirBuilder};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;

use super::*;
use crate::transport::SyncOptions;

const SANDBOX_ID: &str = "sbx_fixture_001";
const TEMPLATE_ALIAS: &str = "beam-ssh";
const TEMPLATE_ID: &str = "tpl_fixture_001";
const OWNER_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";
const SSH_SHA256: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HTTP_REQUEST_BYTES_MAX: usize = 64 * 1024;
static FIXTURE_INDEX: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
struct ApiSandbox {
    alias: String,
    metadata: BTreeMap<String, String>,
    sandbox_id: String,
    template_id: String,
}

#[derive(Clone)]
struct ApiRequest {
    method: &'static str,
    path: String,
    body: Option<Value>,
}

struct ApiFixture {
    sandboxes: BTreeMap<String, ApiSandbox>,
    requests: Vec<ApiRequest>,
    create_count: usize,
    fail_create: bool,
    next_response: Option<E2bRawResponse>,
}

impl ApiFixture {
    fn new() -> Self {
        Self {
            sandboxes: BTreeMap::new(),
            requests: Vec::new(),
            create_count: 0,
            fail_create: false,
            next_response: None,
        }
    }

    fn respond(&mut self, path: &str, options: &E2bApiOptions<'_>) -> E2bRawResponse {
        self.requests.push(ApiRequest {
            method: method_name(options.method),
            path: path.to_owned(),
            body: options.body.clone(),
        });
        if let Some(response) = self.next_response.take() {
            return response;
        }
        match options.method {
            E2bMethod::Get => self.respond_get(path),
            E2bMethod::Post => self.respond_post(path, options.body.as_ref()),
            E2bMethod::Delete => self.respond_delete(path),
        }
    }

    fn respond_get(&self, path: &str) -> E2bRawResponse {
        if path.starts_with("/v2/sandboxes?") {
            let values = self
                .sandboxes
                .values()
                .map(ApiSandbox::inspect_value)
                .collect::<Vec<_>>();
            return raw_json(200, Value::Array(values));
        }
        let Some(id) = path.strip_prefix("/sandboxes/") else {
            return raw_json(404, json!({ "message": "unknown route" }));
        };
        self.sandboxes.get(id).map_or_else(
            || raw_json(404, json!({ "message": "not found" })),
            |sandbox| raw_json(200, sandbox.inspect_value()),
        )
    }

    fn respond_post(&mut self, path: &str, body: Option<&Value>) -> E2bRawResponse {
        if path == "/sandboxes" {
            return self.create_sandbox(body);
        }
        let id = path
            .strip_prefix("/sandboxes/")
            .and_then(|value| value.strip_suffix("/connect"));
        let Some(id) = id else {
            return raw_json(404, json!({ "message": "unknown route" }));
        };
        self.sandboxes.get(id).map_or_else(
            || raw_json(404, json!({ "message": "not found" })),
            |sandbox| raw_json(200, sandbox.connection_value()),
        )
    }

    fn create_sandbox(&mut self, body: Option<&Value>) -> E2bRawResponse {
        self.create_count += 1;
        if self.fail_create {
            return raw_json(503, json!({ "message": "fixture capacity" }));
        }
        let body = body
            .and_then(Value::as_object)
            .expect("create request should carry an object body");
        let metadata = body
            .get("metadata")
            .and_then(Value::as_object)
            .expect("create request should carry metadata")
            .iter()
            .map(|(key, value)| {
                (
                    key.clone(),
                    value
                        .as_str()
                        .expect("metadata value should be text")
                        .to_owned(),
                )
            })
            .collect();
        let sandbox = ApiSandbox {
            alias: TEMPLATE_ALIAS.to_owned(),
            metadata,
            sandbox_id: SANDBOX_ID.to_owned(),
            template_id: TEMPLATE_ID.to_owned(),
        };
        let response = sandbox.connection_value();
        self.sandboxes.insert(SANDBOX_ID.to_owned(), sandbox);
        raw_json(201, response)
    }

    fn respond_delete(&mut self, path: &str) -> E2bRawResponse {
        let Some(id) = path.strip_prefix("/sandboxes/") else {
            return raw_json(404, json!({ "message": "unknown route" }));
        };
        if self.sandboxes.remove(id).is_some() {
            return E2bRawResponse {
                status: 204,
                text: String::new(),
            };
        }
        raw_json(404, json!({ "message": "not found" }))
    }

    fn insert_owned(&mut self, record_id: &str, owner_token: &str) {
        self.sandboxes.insert(
            SANDBOX_ID.to_owned(),
            ApiSandbox {
                alias: TEMPLATE_ALIAS.to_owned(),
                metadata: BTreeMap::from([
                    ("beam.owner".to_owned(), owner_token.to_owned()),
                    ("beam.record".to_owned(), record_id.to_owned()),
                ]),
                sandbox_id: SANDBOX_ID.to_owned(),
                template_id: TEMPLATE_ID.to_owned(),
            },
        );
    }
}

impl ApiSandbox {
    fn connection_value(&self) -> Value {
        json!({
            "alias": self.alias,
            "clientID": "fixture",
            "envdVersion": "fixture",
            "sandboxID": self.sandbox_id,
            "templateID": self.template_id,
        })
    }

    fn inspect_value(&self) -> Value {
        json!({
            "alias": self.alias,
            "metadata": self.metadata,
            "sandboxID": self.sandbox_id,
            "state": "running",
            "templateID": self.template_id,
        })
    }
}

struct Fixture {
    root: PathBuf,
    bin: PathBuf,
    environment: BeamEnv,
    command_environment: BTreeMap<String, String>,
    api: Rc<RefCell<ApiFixture>>,
}

impl Fixture {
    fn new() -> Self {
        let index = FIXTURE_INDEX.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "beam-rust-e2b-provider-{}-{index}",
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
        let environment = BeamEnv {
            home: root.clone(),
            beam_dir: root.join("beam-state"),
        };
        let command_environment = BTreeMap::from([
            ("HOME".to_owned(), root.display().to_string()),
            ("LANG".to_owned(), "C".to_owned()),
            ("PATH".to_owned(), bin.display().to_string()),
        ]);
        let fixture = Self {
            root,
            bin,
            environment,
            command_environment,
            api: Rc::new(RefCell::new(ApiFixture::new())),
        };
        fixture.install_commands();
        fixture
    }

    fn install_commands(&self) {
        let root = crate::util::shell::shq(&self.root.display().to_string());
        self.script("ssh", &format!("printf '%s\\n' \"$*\" >> {root}/ssh.log"));
        self.script(
            "rsync",
            &format!("printf '%s\\n' \"$*\" >> {root}/rsync.log"),
        );
        self.script("websocat", "exit 0");
        self.script(
            "ssh-keygen",
            "if [ \"$1\" = -y ]; then\n  printf '%s\\n' 'ssh-ed25519 QUJDRA== fixture'\n  exit 0\nfi\npath=\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = -f ]; then path=$2; break; fi\n  shift\ndone\nprintf private > \"$path\"\nprintf public > \"$path.pub\"\n/bin/chmod 0644 \"$path\"",
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

    fn provider(&self, spec: E2bTargetSpec) -> E2bProvider {
        let api = Rc::clone(&self.api);
        let handler: Rc<E2bApiHandler> =
            Rc::new(move |path, options| Ok(api.borrow_mut().respond(path, options)));
        E2bProvider::with_options(
            spec,
            E2bProviderOptions {
                api_base_url: "https://fixture.invalid".to_owned(),
                api_key: Some("fixture-key".to_owned()),
                websocat_binary: self.bin.join("websocat").display().to_string(),
                environment: self.environment.clone(),
                command_environment: Some(self.command_environment.clone()),
                api_handler: Some(handler),
            },
        )
        .expect("construct E2B provider")
    }

    fn read(&self, name: &str) -> String {
        fs::read_to_string(self.root.join(name))
            .unwrap_or_else(|error| panic!("read {name}: {error}"))
    }

    fn key_path(&self, owner_token: &str) -> PathBuf {
        self.environment
            .beam_dir
            .join("keys")
            .join(format!("e2b-{owner_token}.ed25519"))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root)
            .unwrap_or_else(|error| panic!("remove fixture {}: {error}", self.root.display()));
    }
}

fn spec() -> E2bTargetSpec {
    E2bTargetSpec {
        template: TEMPLATE_ALIAS.to_owned(),
        user: None,
        timeout_seconds: None,
        root: None,
    }
}

fn reference(id: &str, state: Option<E2bSandboxState>) -> SandboxRef {
    SandboxRef {
        id: id.to_owned(),
        sandbox: state.map(|value| SandboxState::Managed(ManagedSandboxState::E2b(value))),
    }
}

fn state(
    owner_token: &str,
    sandbox_id: Option<&str>,
    ssh_key_sha256: Option<&str>,
) -> E2bSandboxState {
    E2bSandboxState {
        owner_token: owner_token.to_owned(),
        sandbox_id: sandbox_id.map(str::to_owned),
        ssh_key_sha256: ssh_key_sha256.map(str::to_owned),
    }
}

fn reference_state(reference: &SandboxRef) -> &E2bSandboxState {
    match reference.sandbox.as_ref() {
        Some(SandboxState::Managed(ManagedSandboxState::E2b(state))) => state,
        Some(SandboxState::Managed(ManagedSandboxState::Box(_)))
        | Some(SandboxState::Managed(ManagedSandboxState::Modal(_)))
        | Some(SandboxState::Managed(ManagedSandboxState::Daytona(_)))
        | Some(SandboxState::AgentSandbox(_))
        | None => panic!("test expected E2B state"),
    }
}

fn raw_json(status: u16, value: Value) -> E2bRawResponse {
    E2bRawResponse {
        status,
        text: value.to_string(),
    }
}

fn method_name(method: E2bMethod) -> &'static str {
    match method {
        E2bMethod::Get => "GET",
        E2bMethod::Post => "POST",
        E2bMethod::Delete => "DELETE",
    }
}

fn failure<T>(result: Result<T, ProviderError>) -> ProviderError {
    match result {
        Ok(_) => panic!("operation unexpectedly succeeded"),
        Err(error) => error,
    }
}

fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../parity/goldens/e2b-provider.json");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn assert_lifecycle_requests(
    fixture: &Fixture,
    provider: &E2bProvider,
    reference: &SandboxRef,
    state: &E2bSandboxState,
) {
    let api = fixture.api.borrow();
    assert_eq!(api.requests.len(), 7);
    let recovery_path = provider.recovery_path(reference, state);
    assert_eq!(api.requests[0].method, "GET");
    assert_eq!(api.requests[0].path, recovery_path);
    assert_eq!(api.requests[1].method, "POST");
    assert_eq!(api.requests[1].path, "/sandboxes");
    assert_eq!(
        api.requests[1].body,
        Some(provider.create_body(reference, state, "ssh-ed25519 QUJDRA=="))
    );
    assert_eq!(api.requests[2].method, "GET");
    assert_eq!(api.requests[2].path, format!("/sandboxes/{SANDBOX_ID}"));
    assert_eq!(api.requests[3].method, "POST");
    assert_eq!(
        api.requests[3].path,
        format!("/sandboxes/{SANDBOX_ID}/connect")
    );
    assert_eq!(api.requests[3].body, Some(json!({ "timeout": 7200 })));
    assert_eq!(api.requests[4].method, "GET");
    assert_eq!(api.requests[5].method, "DELETE");
    assert_eq!(api.requests[6].method, "GET");
}

#[test]
fn pure_protocol_contract_matches_typescript_golden() {
    let expected = golden();
    let fixture = Fixture::new();
    let provider = fixture.provider(E2bTargetSpec {
        template: TEMPLATE_ALIAS.to_owned(),
        user: Some("beam_user".to_owned()),
        timeout_seconds: Some(7200),
        root: None,
    });
    let owner_token = "a".repeat(48);
    let state = state(&owner_token, Some(SANDBOX_ID), Some(&"b".repeat(64)));
    let reference = reference("record /&?", Some(state.clone()));
    assert_eq!(provider.label(), expected["provider"]["label"]);
    assert_eq!(
        provider.reuses_sandbox(),
        expected["provider"]["reusesSandbox"]
    );
    assert_eq!(
        serde_json::to_value(provider.sandbox_state(&reference).expect("read state"))
            .expect("encode state"),
        expected["provider"]["sandboxState"]
    );
    assert_eq!(
        provider.timeout_seconds,
        expected["protocol"]["timeoutSeconds"]
    );
    assert_eq!(provider.user, expected["protocol"]["user"]);
    assert_eq!(
        provider.create_body(&reference, &state, "ssh-ed25519 AAAA"),
        expected["protocol"]["createBody"]
    );
    assert_eq!(
        provider.recovery_path(&reference, &state),
        expected["protocol"]["recoveryPath"]
    );
    let provider = E2bProvider::with_options(
        E2bTargetSpec {
            user: Some("beam_user".to_owned()),
            timeout_seconds: Some(7200),
            ..spec()
        },
        E2bProviderOptions {
            api_base_url: "https://fixture.invalid".to_owned(),
            api_key: Some("fixture-key".to_owned()),
            websocat_binary: "/tmp/web soc'at".to_owned(),
            environment: fixture.environment.clone(),
            command_environment: Some(fixture.command_environment.clone()),
            api_handler: None,
        },
    )
    .expect("construct quoting provider");
    assert_eq!(
        serde_json::json!(provider.ssh_options(SANDBOX_ID, Path::new("/tmp/key path"))),
        expected["protocol"]["sshOptions"]
    );
}

#[test]
fn validation_errors_match_typescript_golden() {
    let errors = golden()["errors"].clone();
    let cases = [
        (
            E2bTargetSpec {
                template: String::new(),
                ..spec()
            },
            "emptyTemplate",
        ),
        (
            E2bTargetSpec {
                template: "é".repeat(129),
                ..spec()
            },
            "unicodeTemplateTooLong",
        ),
        (
            E2bTargetSpec {
                user: Some("Root".to_owned()),
                ..spec()
            },
            "invalidUser",
        ),
        (
            E2bTargetSpec {
                timeout_seconds: Some(0),
                ..spec()
            },
            "zeroTimeout",
        ),
        (
            E2bTargetSpec {
                timeout_seconds: Some(E2B_TIMEOUT_SECONDS_MAX + 1),
                ..spec()
            },
            "excessiveTimeout",
        ),
    ];
    for (target, label) in cases {
        assert_eq!(failure(E2bProvider::new(target)).to_string(), errors[label]);
    }
    E2bProvider::new(E2bTargetSpec {
        template: "é".repeat(128),
        ..spec()
    })
    .expect("128 UTF-16 code units should match TypeScript validation");
    let provider = E2bProvider::new(spec()).expect("construct E2B provider");
    let states = [
        (state("bad", None, None), "malformedOwner"),
        (
            state(OWNER_TOKEN, Some("../foreign"), None),
            "malformedSandboxId",
        ),
        (
            state(OWNER_TOKEN, None, Some("short")),
            "malformedFingerprint",
        ),
    ];
    for (sandbox, label) in states {
        let reference = reference("rec1", Some(sandbox));
        assert_eq!(
            failure(provider.sandbox_state(&reference)).to_string(),
            errors[label]
        );
    }
    let foreign = SandboxRef {
        id: "rec1".to_owned(),
        sandbox: Some(SandboxState::Managed(ManagedSandboxState::Box(
            crate::provider::BoxSandboxState {
                box_id: "bx_fixture1".to_owned(),
            },
        ))),
    };
    assert_eq!(
        failure(provider.sandbox_state(&foreign)).to_string(),
        errors["foreignPersistedKind"]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn journals_reservation_and_key_before_failed_creation() {
    let fixture = Fixture::new();
    fixture.api.borrow_mut().fail_create = true;
    let provider = fixture.provider(spec());
    let mut reference = reference("early", None);
    let mut published = Vec::new();
    let mut persist = |sandbox| {
        published.push(sandbox);
        Ok(())
    };
    let error = failure(provider.provision(&mut reference, Some(&mut persist)).await);
    assert!(error.to_string().contains("fixture capacity"));
    let state = reference_state(&reference);
    assert!(state.sandbox_id.is_none());
    assert!(state.ssh_key_sha256.as_deref().is_some_and(valid_sha256));
    assert_eq!(published.len(), 2);
    assert!(!fixture.root.join("ssh.log").exists());
}

#[tokio::test(flavor = "current_thread")]
async fn creates_connects_bootstraps_syncs_and_deletes_exact_sandbox() {
    let fixture = Fixture::new();
    let provider = fixture.provider(E2bTargetSpec {
        timeout_seconds: Some(7200),
        ..spec()
    });
    let mut reference = reference("record /&?", None);
    let mut published = Vec::new();
    let mut persist = |sandbox| {
        published.push(sandbox);
        Ok(())
    };
    let transport = provider
        .provision(&mut reference, Some(&mut persist))
        .await
        .expect("provision E2B sandbox");
    transport
        .sync_up(&fixture.root, "~/beam/fixture", SyncOptions::default())
        .await
        .expect("sync through E2B transport");
    let state = reference_state(&reference);
    assert_eq!(state.sandbox_id.as_deref(), Some(SANDBOX_ID));
    assert_eq!(published.len(), 3);
    assert_eq!(transport.label(), format!("E2B {SANDBOX_ID}"));
    let ssh_log = fixture.read("ssh.log");
    assert!(ssh_log.contains(&format!("HostKeyAlias=e2b-{SANDBOX_ID}")));
    assert!(ssh_log.contains("ProxyCommand="));
    assert!(ssh_log.contains("wss://8081-%h.e2b.app"));
    assert!(ssh_log.contains("sha256sum -c -"));
    assert!(
        fixture
            .read("rsync.log")
            .contains(&format!("user@{SANDBOX_ID}:./"))
    );
    let key_path = fixture.key_path(&state.owner_token);
    assert!(key_path.exists());
    provider
        .destroy(&reference)
        .await
        .expect("destroy E2B sandbox");
    assert!(fixture.api.borrow().sandboxes.is_empty());
    assert!(!key_path.exists());
    provider
        .destroy(&reference)
        .await
        .expect("repeat E2B destroy");
    assert_lifecycle_requests(&fixture, &provider, &reference, state);
}

#[tokio::test(flavor = "current_thread")]
async fn recovers_one_owner_labelled_sandbox_without_creating_duplicate() {
    let fixture = Fixture::new();
    fixture
        .api
        .borrow_mut()
        .insert_owned("recover", OWNER_TOKEN);
    let provider = fixture.provider(spec());
    let mut reference = reference("recover", Some(state(OWNER_TOKEN, None, None)));
    let mut published = Vec::new();
    let mut persist = |sandbox| {
        published.push(sandbox);
        Ok(())
    };
    provider
        .provision(&mut reference, Some(&mut persist))
        .await
        .expect("recover reserved E2B sandbox");
    assert_eq!(
        reference_state(&reference).sandbox_id.as_deref(),
        Some(SANDBOX_ID)
    );
    assert_eq!(fixture.api.borrow().create_count, 0);
    assert_eq!(published.len(), 2);
}

#[tokio::test(flavor = "current_thread")]
async fn retains_created_identity_when_the_journal_rejects_it() {
    let fixture = Fixture::new();
    let provider = fixture.provider(spec());
    let mut reference = reference("journal", None);
    let calls = RefCell::new(0_usize);
    let mut persist = |_sandbox| {
        *calls.borrow_mut() += 1;
        if *calls.borrow() == 3 {
            return Err(ProviderError::message("journal failed".to_owned()));
        }
        Ok(())
    };
    let error = failure(provider.provision(&mut reference, Some(&mut persist)).await);
    assert_eq!(error.to_string(), "journal failed");
    assert_eq!(
        reference_state(&reference).sandbox_id.as_deref(),
        Some(SANDBOX_ID)
    );
    assert_eq!(fixture.api.borrow().create_count, 1);
    provider
        .provision(&mut reference, None)
        .await
        .expect("retry uses retained sandbox id");
    assert_eq!(fixture.api.borrow().create_count, 1);
}

#[tokio::test(flavor = "current_thread")]
async fn refuses_foreign_metadata_and_ambiguous_recovery() {
    let fixture = Fixture::new();
    fixture
        .api
        .borrow_mut()
        .insert_owned("foreign", &"0".repeat(48));
    let provider = fixture.provider(spec());
    let foreign_reference = reference(
        "foreign",
        Some(state(OWNER_TOKEN, Some(SANDBOX_ID), Some(SSH_SHA256))),
    );
    let error = failure(provider.destroy(&foreign_reference).await);
    assert!(
        error
            .to_string()
            .contains("does not carry this handoff's owner token")
    );
    assert!(fixture.api.borrow().sandboxes.contains_key(SANDBOX_ID));

    fixture.api.borrow_mut().sandboxes.clear();
    fixture
        .api
        .borrow_mut()
        .insert_owned("ambiguous", OWNER_TOKEN);
    let mut second = fixture
        .api
        .borrow()
        .sandboxes
        .get(SANDBOX_ID)
        .expect("first sandbox")
        .clone();
    second.sandbox_id = "sbx_fixture_002".to_owned();
    fixture
        .api
        .borrow_mut()
        .sandboxes
        .insert(second.sandbox_id.clone(), second);
    let mut reference = reference("ambiguous", Some(state(OWNER_TOKEN, None, None)));
    let mut persist = |_sandbox| Ok(());
    let error = failure(provider.provision(&mut reference, Some(&mut persist)).await);
    assert!(error.to_string().contains("matched several sandboxes"));
    assert_eq!(fixture.api.borrow().create_count, 0);
}

#[tokio::test(flavor = "current_thread")]
async fn rejects_malformed_and_oversized_api_responses() {
    let fixture = Fixture::new();
    let provider = fixture.provider(spec());
    fixture.api.borrow_mut().next_response = Some(E2bRawResponse {
        status: 200,
        text: "{not-json".to_owned(),
    });
    let error = failure(provider.check().await);
    assert!(error.to_string().contains("malformed JSON"));

    fixture.api.borrow_mut().next_response = Some(E2bRawResponse {
        status: 200,
        text: "x".repeat(E2B_OUTPUT_BYTES_MAX + 1),
    });
    let error = failure(provider.check().await);
    assert_eq!(
        error.to_string(),
        format!("E2B API response exceeded {E2B_OUTPUT_BYTES_MAX} bytes")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn check_reports_credentials_tools_and_account_access() {
    let fixture = Fixture::new();
    let report = fixture
        .provider(spec())
        .check()
        .await
        .expect("check E2B account");
    assert!(report.fatal.is_none());
    assert!(
        report
            .lines
            .contains(&"E2B account:     authenticated; key can manage team sandboxes".to_owned())
    );

    let missing_key =
        provider_with_overrides(&fixture, Some(" "), fixture.command_environment.clone());
    let report = missing_key.check().await.expect("report missing key");
    assert_eq!(
        report.fatal.as_deref(),
        Some("set E2B_API_KEY before using an E2B target")
    );

    let missing_tools = provider_with_overrides(
        &fixture,
        Some("fixture-key"),
        BTreeMap::from([(
            "PATH".to_owned(),
            fixture.root.join("empty").display().to_string(),
        )]),
    );
    let report = missing_tools.check().await.expect("report missing tools");
    assert_eq!(
        report.fatal.as_deref(),
        Some("install local ssh, rsync, ssh-keygen, and websocat")
    );
}

#[test]
fn production_http_path_sends_required_headers() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback fixture");
    let address = listener.local_addr().expect("read loopback address");
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept E2B request");
        let mut request = Vec::new();
        let mut chunk = [0_u8; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let count = stream.read(&mut chunk).expect("read E2B request");
            assert!(count > 0, "request ended before its headers");
            request.extend_from_slice(&chunk[..count]);
            assert!(request.len() <= HTTP_REQUEST_BYTES_MAX);
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]")
            .expect("write E2B response");
        String::from_utf8(request).expect("request should be UTF-8")
    });
    let fixture = Fixture::new();
    let provider = E2bProvider::with_options(
        spec(),
        E2bProviderOptions {
            api_base_url: format!("http://{address}"),
            api_key: Some("fixture-key".to_owned()),
            websocat_binary: fixture.bin.join("websocat").display().to_string(),
            environment: fixture.environment.clone(),
            command_environment: Some(fixture.command_environment.clone()),
            api_handler: None,
        },
    )
    .expect("construct HTTP provider");
    let report = provider.check_inner().expect("call loopback E2B endpoint");
    assert!(report.fatal.is_none());
    let request = server.join().expect("join loopback E2B server");
    assert!(request.starts_with("GET /v2/sandboxes?state=running%2Cpaused&limit=1 HTTP/1.1\r\n"));
    assert!(
        request
            .to_ascii_lowercase()
            .contains("x-api-key: fixture-key\r\n")
    );
    assert!(
        request
            .to_ascii_lowercase()
            .contains("content-type: application/json\r\n")
    );
}

fn provider_with_overrides(
    fixture: &Fixture,
    api_key: Option<&str>,
    command_environment: BTreeMap<String, String>,
) -> E2bProvider {
    let api = Rc::clone(&fixture.api);
    E2bProvider::with_options(
        spec(),
        E2bProviderOptions {
            api_base_url: "https://fixture.invalid".to_owned(),
            api_key: api_key.map(str::to_owned),
            websocat_binary: "missing-websocat".to_owned(),
            environment: fixture.environment.clone(),
            command_environment: Some(command_environment),
            api_handler: Some(Rc::new(move |path, options| {
                Ok(api.borrow_mut().respond(path, options))
            })),
        },
    )
    .expect("construct override provider")
}
