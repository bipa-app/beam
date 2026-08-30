//! Parity-golden tests for seam 2a (env/config/cli-output/state surface):
//! the Rust port must reproduce the TypeScript decision outputs and the
//! `schemaVersion: 1` envelope byte-exactly. Method mirrors
//! tests/parity.rs — load parity/goldens/{config,cli-output,state}.json and
//! assert every recorded case against the ported function.

use std::path::Path;

use beam::cli_output::{CliMessage, failure_document, success_document};
use beam::config::{Config, TargetSpec, resolve_target, target_root};
use beam::state::{BeamRecord, ToolName, is_remote_cwd_resolved, plan_session_identity};
use serde_json::{Value, json};

fn golden(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../parity/goldens")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("read {}: {err}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("parse {}: {err}", path.display()))
}

fn spec_from_golden(value: &Value) -> TargetSpec {
    serde_json::from_value(value.clone()).expect("TargetSpec golden shape")
}

#[test]
fn target_root_matches_typescript_golden() {
    // The golden pins roots by corpus name; rebuild the same corpus here by
    // deserializing each spec literal the extractor used. The corpus names
    // and shapes must stay in lockstep with scripts/parity-goldens.ts.
    let cases = golden("config.json");
    let specs = corpus_specs();
    for case in cases["targetRoot"].as_array().expect("targetRoot array") {
        let name = case["name"].as_str().expect("name");
        let expected = case["root"].as_str().expect("root");
        let spec = specs.iter().find(|(n, _)| *n == name).unwrap_or_else(|| {
            panic!("corpus spec {name} missing from Rust corpus");
        });
        assert_eq!(target_root(&spec.1), expected, "target_root({name})");
    }
}

/// The TargetSpec corpus, mirroring TARGET_SPECS in
/// scripts/parity-goldens.ts as JSON literals deserialized through the same
/// serde contract — keeping both sides in one shape definition (the golden).
fn corpus_specs() -> Vec<(&'static str, TargetSpec)> {
    let raw: Vec<(&str, Value)> = vec![
        ("boxDefault", json!({"type":"box"})),
        (
            "boxFull",
            json!({"type":"box","root":"/srv/beam","machineType":"large","environment":"dev","ttlSeconds":7200}),
        ),
        ("e2b", json!({"type":"e2b","template":"beam-ssh"})),
        (
            "e2bFull",
            json!({"type":"e2b","template":"t","user":"agent","timeoutSeconds":3600,"root":"~/x"}),
        ),
        ("modal", json!({"type":"modal"})),
        (
            "modalFull",
            json!({"type":"modal","app":"a","image":"i","timeoutSeconds":10,"root":"/r"}),
        ),
        ("daytona", json!({"type":"daytona"})),
        (
            "daytonaFull",
            json!({"type":"daytona","snapshot":"snap","target":"eu","root":"~/d"}),
        ),
        ("ssh", json!({"type":"ssh","host":"user@example.com"})),
        (
            "sshFull",
            json!({"type":"ssh","host":"h","root":"/data","rsyncFlags":["-a","-z","--delete"]}),
        ),
        ("local", json!({"type":"local","root":"/tmp/local-root"})),
        (
            "localHome",
            json!({"type":"local","root":"/r","home":"/h","rsyncFlags":["-a"]}),
        ),
        (
            "agentSandbox",
            json!({"type":"agent-sandbox","context":"ctx","namespace":"beam-u","template":"beam-coding","kubeconfig":"/k/config"}),
        ),
        (
            "agentSandboxFull",
            json!({"type":"agent-sandbox","context":"c","namespace":"n","template":"t","kubeconfig":"/k","container":"sandbox","root":"/data/bipa"}),
        ),
    ];
    raw.into_iter()
        .map(|(n, v)| (n, spec_from_golden(&v)))
        .collect()
}

fn config_from(value: Value) -> Config {
    serde_json::from_value(value).expect("Config shape")
}

#[test]
fn resolve_target_matches_typescript_golden() {
    let cases = golden("config.json");
    let multi = config_from(json!({
        "defaultTarget": "ssh",
        "targets": {"box": {"type":"box"}, "ssh": {"type":"ssh","host":"user@example.com"}},
    }));
    let single =
        config_from(json!({"targets": {"only": {"type":"local","root":"/tmp/local-root"}}}));
    for case in cases["resolve"].as_array().expect("resolve array") {
        let label = case["label"].as_str().expect("label");
        let (config, name) = match label {
            "byName" => (&multi, Some("box")),
            "default" => (&multi, None),
            "soleTarget" => (&single, None),
            other => panic!("unknown resolve case {other}"),
        };
        let (resolved_name, spec) = resolve_target(config, name).expect("resolves");
        assert_eq!(
            resolved_name,
            case["name"].as_str().expect("name"),
            "{label}"
        );
        let expected_type = case["specType"].as_str().expect("specType");
        let actual_type = serde_json::to_value(spec).expect("spec json")["type"]
            .as_str()
            .expect("type tag")
            .to_owned();
        assert_eq!(actual_type, expected_type, "{label}");
    }
}

#[test]
fn cli_output_envelope_matches_typescript_golden() {
    let cases = golden("cli-output.json");
    for doc in cases["documents"].as_array().expect("documents array") {
        let label = doc["label"].as_str().expect("label");
        let expected = doc["document"].as_str().expect("document");
        let actual = match label {
            "success" => success_document(
                "probe",
                json!({"answer":42,"nested":{"list":[1,2]}}),
                &[
                    CliMessage::info("setup complete".to_owned()),
                    CliMessage::warning("careful now".to_owned()),
                ],
            ),
            "successNullData" => success_document("probe", Value::Null, &[]),
            "cliError" => failure_document(
                "probe",
                "bad_input",
                "the thing was wrong",
                Some(&json!({"field":"root"})),
                &[CliMessage::error("about to fail".to_owned())],
            ),
            "plainError" => failure_document("probe", "command_failed", "boom", None, &[]),
            "nonErrorThrow" => {
                failure_document("probe", "command_failed", "string failure", None, &[])
            }
            "nonzeroExitCode" => failure_document(
                "probe",
                "command_failed",
                "last word",
                None,
                &[CliMessage::info("last word".to_owned())],
            ),
            other => panic!("unknown cli-output case {other}"),
        };
        assert_eq!(actual, expected, "cli-output({label})");
    }
}

fn record(partial: Value) -> BeamRecord {
    let base = json!({
        "id": "abc123",
        "target": "ssh",
        "localCwd": "/local/work",
        "remoteCwd": "/remote/work",
        "runtimeSession": "beam-abc123",
        "status": "up",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z",
    });
    let mut merged = base.as_object().expect("base object").clone();
    for (k, v) in partial.as_object().expect("partial object") {
        merged.insert(k.clone(), v.clone());
    }
    serde_json::from_value(Value::Object(merged)).expect("BeamRecord shape")
}

#[test]
fn plan_session_identity_matches_typescript_golden() {
    let cases = golden("state.json");
    let with_session = record(json!({"tool":"omp","sessionId":"sess-1"}));
    let unresolved = record(json!({
        "tool":"omp","sessionId":"sess-1","remoteCwd":"~/beam/work","remoteCwdResolved":false,
    }));
    for case in cases["planSessionIdentity"].as_array().expect("plan array") {
        let label = case["label"].as_str().expect("label");
        let expected = &case["plan"];
        let actual = match label {
            "noStored" => plan_session_identity(&record(json!({})), None, false),
            "matchStored" => {
                plan_session_identity(&with_session, Some((ToolName::Omp, "sess-1")), true)
            }
            "driftRetain" => plan_session_identity(&with_session, None, false),
            "explicitSwitchResolved" => {
                plan_session_identity(&with_session, Some((ToolName::Pi, "sess-2")), true)
            }
            "explicitClearResolved" => plan_session_identity(&with_session, None, true),
            "explicitSwitchUnresolved" => {
                plan_session_identity(&unresolved, Some((ToolName::Pi, "sess-2")), true)
            }
            other => panic!("unknown plan case {other}"),
        };
        let actual_json = serde_json::to_value(&actual).expect("plan json");
        assert_eq!(&actual_json, expected, "plan_session_identity({label})");
    }
}

#[test]
fn is_remote_cwd_resolved_matches_typescript_golden() {
    let cases = golden("state.json");
    for case in cases["isRemoteCwdResolved"].as_array().expect("cwd array") {
        let label = case["label"].as_str().expect("label");
        let expected = case["resolved"].as_bool().expect("resolved");
        let record = match label {
            "absolutePath" => record(json!({"remoteCwd":"/abs"})),
            "tildeUnresolved" => record(json!({"remoteCwd":"~/rel"})),
            "tildeResolvedFlag" => record(json!({"remoteCwd":"~/rel","remoteCwdResolved":true})),
            "absoluteResolvedFalse" => {
                record(json!({"remoteCwd":"/abs","remoteCwdResolved":false}))
            }
            other => panic!("unknown cwd case {other}"),
        };
        assert_eq!(
            is_remote_cwd_resolved(&record),
            expected,
            "is_remote_cwd_resolved({label})"
        );
    }
}
