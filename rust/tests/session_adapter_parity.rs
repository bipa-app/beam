//! Goal: keep the Rust session-adapter contract byte-exact with TypeScript.
//!
//! Method: replay adapter metadata, Claude slugs, Pi-family header rewrites,
//! deterministic ship-bundle keys, and generated safety scripts from the
//! committed TypeScript golden.

use std::path::Path;

use beam::session::adapters;
use beam::session::claude::claude_project_slug;
use beam::session::guarded_store::guarded_store_script_golden;
use beam::session::pi_family::{pi_family_install_script_golden, rewrite_session_header_cwd};
use beam::session::ship_bundle::{SessionShipBundle, session_install_key};

fn golden() -> serde_json::Value {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../parity/goldens/session-adapters.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

#[test]
fn adapter_metadata_matches_typescript_golden() {
    let golden = golden();
    let expected = golden["adapters"]
        .as_array()
        .expect("adapter corpus is an array");
    let actual = adapters();
    assert_eq!(actual.len(), expected.len());
    for (adapter, expected) in actual.into_iter().zip(expected) {
        assert_eq!(adapter.tool().as_str(), expected["tool"]);
        assert_eq!(adapter.binary(), expected["binary"]);
        let login = adapter.login_argv().to_vec();
        let expected_login: Vec<String> = serde_json::from_value(expected["loginArgv"].clone())
            .expect("login argv is a string array");
        assert_eq!(login, expected_login);
        assert_eq!(
            adapter.remote_auth_probe(),
            expected["remoteAuthProbe"].as_str()
        );
    }
}

#[test]
fn claude_slugs_match_typescript_golden() {
    let golden = golden();
    for case in golden["slugs"].as_array().expect("slug corpus is an array") {
        let input = case["input"].as_str().expect("slug input is a string");
        let expected = case["output"].as_str().expect("slug output is a string");
        assert_eq!(claude_project_slug(input), expected, "slug {input:?}");
    }
}

#[test]
fn pi_header_rewrites_match_typescript_golden() {
    let golden = golden();
    for case in golden["rewrites"]
        .as_array()
        .expect("rewrite corpus is an array")
    {
        let input = case["input"].as_str().expect("rewrite input is a string");
        let cwd = case["cwd"].as_str().expect("rewrite cwd is a string");
        let actual = rewrite_session_header_cwd(input, cwd);
        if let Some(expected) = case["output"].as_str() {
            assert_eq!(actual.expect("rewrite should succeed"), expected);
        } else {
            let expected = case["error"].as_str().expect("rewrite error is a string");
            assert_eq!(
                actual.expect_err("rewrite should fail").to_string(),
                expected
            );
        }
    }
}

#[test]
fn install_keys_match_typescript_golden() {
    let golden = golden();
    for case in golden["installKeys"]
        .as_array()
        .expect("install-key corpus is an array")
    {
        let bundle: SessionShipBundle =
            serde_json::from_value(case["bundle"].clone()).expect("bundle is valid");
        let expected = case["output"].as_str().expect("install key is a string");
        assert_eq!(session_install_key(&bundle), expected);
    }
}

#[test]
fn guarded_store_scripts_match_typescript_golden() {
    let golden = golden();
    let expected = golden["guardedStoreScripts"]
        .as_array()
        .expect("guarded-store script corpus is an array");
    let actual = guarded_store_script_golden();
    assert_eq!(actual.len(), expected.len());
    for ((label, actual), expected) in actual.into_iter().zip(expected) {
        assert_eq!(label, expected["label"]);
        assert_eq!(actual, expected["output"]);
    }
}

#[test]
fn pi_family_install_scripts_match_typescript_golden() {
    let golden = golden();
    let expected = golden["piFamilyInstallScripts"]
        .as_array()
        .expect("pi-family install script corpus is an array");
    let actual = pi_family_install_script_golden();
    assert_eq!(actual.len(), expected.len());
    for ((label, actual), expected) in actual.into_iter().zip(expected) {
        assert_eq!(label, expected["label"]);
        assert_eq!(actual, expected["output"]);
    }
}
