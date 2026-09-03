//! Provider-core parity tests: load the TypeScript provider golden, round-trip
//! every persisted sandbox identity, and exercise the static lifecycle through
//! one deterministic transport plus success/failure rsync probes.

use std::path::Path;
use std::rc::Rc;

use beam::config::{LocalTargetSpec, SshTargetSpec};
use beam::provider::{SandboxProvider, SandboxRef, SandboxState, StaticProvider};
use beam::state::BeamRecord;
use beam::transport::{ExecResult, SyncOptions, Transport, TransportFuture};
use serde_json::{Value, json};

fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../parity/goldens/provider-core.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("read {}: {err}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("parse {}: {err}", path.display()))
}

struct ProviderGoldenTransport;

impl Transport for ProviderGoldenTransport {
    fn label(&self) -> &str {
        "provider golden transport"
    }

    fn exec<'a>(&'a self, _command: &'a str) -> TransportFuture<'a, ExecResult> {
        Box::pin(async {
            Ok(ExecResult {
                code: 0,
                stdout: String::new(),
                stderr: String::new(),
            })
        })
    }

    fn exec_checked<'a>(&'a self, _command: &'a str) -> TransportFuture<'a, String> {
        Box::pin(async { Ok(String::new()) })
    }

    fn sync_up<'a>(
        &'a self,
        _local_dir: &'a Path,
        _remote_dir: &'a str,
        _options: SyncOptions<'a>,
    ) -> TransportFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn sync_down<'a>(
        &'a self,
        _remote_dir: &'a str,
        _local_dir: &'a Path,
        _options: SyncOptions<'a>,
    ) -> TransportFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn exists<'a>(&'a self, _remote_path: &'a str) -> TransportFuture<'a, bool> {
        Box::pin(async { Ok(false) })
    }

    fn interactive_argv(&self, _command: &str) -> Vec<String> {
        Vec::new()
    }
}

#[test]
fn sandbox_state_matches_typescript_golden() {
    let provider_golden = golden();
    let states = provider_golden["sandboxStates"]
        .as_object()
        .expect("sandboxStates object");
    for (name, expected) in states {
        let state: SandboxState = serde_json::from_value(expected.clone())
            .unwrap_or_else(|err| panic!("deserialize sandbox state {name}: {err}"));
        let actual = serde_json::to_value(&state)
            .unwrap_or_else(|err| panic!("serialize sandbox state {name}: {err}"));
        assert_eq!(&actual, expected, "sandbox state values {name}");
        let actual_bytes = serde_json::to_string_pretty(&state)
            .unwrap_or_else(|err| panic!("render sandbox state {name}: {err}"));
        let expected_bytes = serde_json::to_string_pretty(expected)
            .unwrap_or_else(|err| panic!("render sandbox golden {name}: {err}"));
        assert_eq!(actual_bytes, expected_bytes, "sandbox state bytes {name}");
    }
}

#[test]
fn beam_record_preserves_provider_identity() {
    let sandbox = golden()["sandboxStates"]["agentPinned"].clone();
    let value = json!({
        "id": "rec1",
        "target": "sandbox",
        "localCwd": "/local/work",
        "remoteCwd": "/remote/work",
        "runtimeSession": "beam-rec1",
        "status": "up",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z",
        "sandbox": sandbox,
    });
    let record: BeamRecord = serde_json::from_value(value).expect("BeamRecord with sandbox");
    let rendered = serde_json::to_value(record).expect("serialize BeamRecord with sandbox");
    assert_eq!(rendered["sandbox"], sandbox);
}

#[test]
fn modal_volume_ownership_rejects_false() {
    let invalid = json!({
        "kind": "modal",
        "ownerToken": "owner",
        "sandboxName": "sandbox",
        "volumeName": "volume",
        "volumeOwned": false,
    });
    let error = match serde_json::from_value::<SandboxState>(invalid) {
        Ok(_) => panic!("volumeOwned=false must be refused"),
        Err(error) => error,
    };
    assert!(
        error.to_string().contains("volumeOwned must be true"),
        "unexpected error: {error}"
    );
}

#[test]
fn static_factories_match_typescript_golden() {
    let expected = golden()["staticFactories"].clone();
    let ssh = StaticProvider::from_ssh_target(&SshTargetSpec {
        host: "sandbox.example".to_owned(),
        root: None,
        rsync_flags: Some(vec!["-a".to_owned()]),
    })
    .expect("SSH static provider");
    let local = StaticProvider::from_local_target(&LocalTargetSpec {
        root: "/beam".to_owned(),
        home: Some("/".to_owned()),
        rsync_flags: Some(vec!["-a".to_owned()]),
    })
    .expect("local static provider");
    assert_eq!(ssh.label(), expected["ssh"]["label"]);
    assert_eq!(ssh.reuses_sandbox(), expected["ssh"]["reusesSandbox"]);
    assert_eq!(local.label(), expected["local"]["label"]);
    assert_eq!(local.reuses_sandbox(), expected["local"]["reusesSandbox"]);
}

#[tokio::test(flavor = "current_thread")]
async fn static_provider_matches_typescript_golden() {
    let expected = golden()["staticProvider"].clone();
    let transport: Rc<dyn Transport> = Rc::new(ProviderGoldenTransport);
    let provider: Rc<dyn SandboxProvider> = Rc::new(StaticProvider::new(Rc::clone(&transport)));
    let mut reference = SandboxRef {
        id: "rec1".to_owned(),
        sandbox: None,
    };
    assert_eq!(provider.label(), expected["label"]);
    assert_eq!(provider.reuses_sandbox(), expected["reusesSandbox"]);
    let state = provider.sandbox_state(&reference).expect("static state");
    assert_eq!(
        serde_json::to_value(state).expect("state JSON"),
        Value::Null
    );

    let mut persist_calls = 0;
    let provisioned = {
        let mut persist = |_sandbox: SandboxState| {
            persist_calls += 1;
            Ok(())
        };
        provider
            .provision(&mut reference, Some(&mut persist))
            .await
            .expect("provision static target")
    };
    let connected = provider.connect(None).await.expect("connect static target");
    assert_eq!(
        Rc::ptr_eq(&provisioned, &transport),
        expected["provisionReturnsTransport"]
    );
    assert_eq!(
        Rc::ptr_eq(&connected, &transport),
        expected["connectReturnsTransport"]
    );
    assert_eq!(json!(persist_calls), expected["persistCalls"]);
    assert_eq!(
        provider
            .destroy_after_verified_cleanup_without_connection(&reference)
            .is_some(),
        expected["destroysWithoutConnection"]
            .as_bool()
            .expect("destroysWithoutConnection boolean")
    );
    provider
        .destroy(&reference)
        .await
        .expect("destroy is a no-op");

    let available = StaticProvider::with_rsync_program(Rc::clone(&transport), "/usr/bin/true")
        .check()
        .await
        .expect("successful rsync probe");
    let missing = StaticProvider::with_rsync_program(transport, "/usr/bin/false")
        .check()
        .await
        .expect("failed rsync probe");
    assert_eq!(
        serde_json::to_value(available).expect("report JSON"),
        expected["available"]
    );
    assert_eq!(
        serde_json::to_value(missing).expect("report JSON"),
        expected["missing"]
    );
}
