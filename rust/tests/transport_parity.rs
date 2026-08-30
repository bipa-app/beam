//! Goal: keep the Rust local transport's generated safety shell byte-exact
//! with the TypeScript implementation during the side-by-side port.
//!
//! Method: load the committed golden generated from `createWalkBlocks` and
//! `ownedDestinationBlocks`, replay every fixed input through Rust, and compare
//! each output block without normalization.

use std::path::Path;

use beam::transport::local::create_walk_blocks;
use beam::workspace::owned_destination_blocks;

fn golden() -> serde_json::Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../parity/goldens/local-transport.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

#[test]
fn create_walk_blocks_match_typescript_golden() {
    let golden = golden();
    let cases = golden["createWalkBlocks"]
        .as_array()
        .expect("createWalkBlocks corpus is an array");
    for case in cases {
        let input = case["input"].as_str().expect("walk input is a string");
        let expected: Vec<String> =
            serde_json::from_value(case["output"].clone()).expect("walk output is a string array");
        let actual = create_walk_blocks(Path::new(input)).expect("golden walk path is valid");
        assert_eq!(actual, expected, "create_walk_blocks({input:?})");
    }
}

#[test]
fn owned_destination_blocks_match_typescript_golden() {
    let golden = golden();
    let cases = golden["ownedDestinationBlocks"]
        .as_array()
        .expect("ownedDestinationBlocks corpus is an array");
    for case in cases {
        let owner = case["owner"].as_str().expect("owner is a string");
        let relative = case["relative"]
            .as_array()
            .expect("relative is an array")
            .iter()
            .map(|segment| segment.as_str().expect("relative segment is a string"))
            .collect::<Vec<_>>();
        let create = case["create"].as_bool().expect("create is a boolean");
        let expected: Vec<String> =
            serde_json::from_value(case["output"].clone()).expect("owned output is a string array");
        let actual = owned_destination_blocks(owner, &relative, create)
            .expect("golden owned destination is valid");
        assert_eq!(actual, expected, "owned case {}", case["label"]);
    }
}

#[test]
fn owned_destination_rejects_path_shaping_components() {
    for relative in [
        vec!["other"],
        vec![".beam", ""],
        vec![".beam", "."],
        vec![".beam", ".."],
        vec![".beam", "a/b"],
        vec![".beam", "line\nbreak"],
    ] {
        let error = owned_destination_blocks("owner", &relative, true)
            .expect_err("path-shaping component must be rejected");
        assert!(error.to_string().starts_with("beam:"));
    }
}
