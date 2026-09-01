//! Goal: keep every Rust herdr command byte-exact with TypeScript.
//!
//! Method: compare the Rust command corpus with the committed golden produced
//! by driving the TypeScript `HerdrRuntime` through a recording transport.

use std::path::Path;

use beam::runtime::herdr::herdr_script_golden;

fn golden() -> serde_json::Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../parity/goldens/herdr-runtime.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

#[test]
fn generated_commands_match_typescript_golden() {
    let golden = golden();
    let expected = golden["scripts"]
        .as_array()
        .expect("herdr script corpus is an array");
    let actual = herdr_script_golden();
    assert_eq!(actual.len(), expected.len());
    for ((label, output), expected) in actual.into_iter().zip(expected) {
        assert_eq!(label, expected["label"]);
        assert_eq!(output, expected["output"]);
    }
}
