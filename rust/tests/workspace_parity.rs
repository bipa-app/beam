//! Goal: keep the Rust workspace transaction byte-exact with TypeScript.
//!
//! Method: rebuild the fixed local fixture and compare every local result and
//! generated remote shell script with the committed TypeScript golden.

use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};

use beam::config::Config;
use beam::transport::local::LocalTransport;
use beam::workspace::{
    BEAM_GITPTR_EXCLUDE, BEAM_OWNER_FILE, BEAM_RESERVED_DIR, BEAM_RESERVED_EXCLUDE,
    GIT_METADATA_EXCLUDE, assert_purgeable_path, format_bytes, gather_excludes,
    remote_workspace_name, staged_workspace_tree_fingerprint, workspace_owner_content,
    workspace_return_fingerprint, workspace_script_golden, workspace_upload_stage_path,
};
use beam::workspace_git::{
    ReturnValueKind, SHIPPED_REFS_FILE, SHIPPED_STASH_LOG_FILE, collected_git_tree_fingerprint,
    git_payload_path, git_pointer_bytes, git_pointer_temp_name, is_git_dir_at_cwd, is_git_worktree,
    is_linked_worktree, remote_git_tree_fingerprint, return_object_pin_ref, return_qbase,
    return_ref_base, return_reflog_pin_ref, return_reflog_ref, return_value_ref,
    workspace_git_entry_kind, workspace_git_script_golden,
};

const GENERATION: &str = "0123456789abcdef";

fn golden() -> serde_json::Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../parity/goldens/workspace.json");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

#[test]
fn local_workspace_values_match_typescript_golden() {
    let golden = golden();
    let local = &golden["local"];
    let fixture = WorkspaceFixture::new();
    assert_constants_and_names(local, &fixture);
    assert_workspace_fingerprints(local, &fixture);
    assert_eq!(local["gitLayouts"], git_layouts(&fixture.root));
}

fn assert_constants_and_names(local: &serde_json::Value, fixture: &WorkspaceFixture) {
    assert_eq!(local["constants"]["reservedDir"], BEAM_RESERVED_DIR);
    assert_eq!(local["constants"]["ownerFile"], BEAM_OWNER_FILE);
    assert_eq!(local["constants"]["reservedExclude"], BEAM_RESERVED_EXCLUDE);
    assert_eq!(
        local["constants"]["gitMetadataExclude"],
        GIT_METADATA_EXCLUDE
    );
    assert_eq!(local["constants"]["gitPointerExclude"], BEAM_GITPTR_EXCLUDE);
    for case in local["names"].as_array().expect("names corpus is an array") {
        let input = case["input"].as_str().expect("name input is a string");
        assert_eq!(case["output"], remote_workspace_name(input));
    }
    assert_eq!(
        local["owner"],
        workspace_owner_content("record-1", "0123456789abcdef0123456789abcdef")
            .expect("owner fixture is valid")
    );
    let excludes = gather_excludes(
        &fixture.workspace,
        &Config {
            excludes: Some(vec!["/dist".to_owned(), "node_modules".to_owned()]),
            ..Config::default()
        },
    )
    .expect("fixture excludes are readable");
    assert_eq!(local["excludes"], serde_json::json!(excludes));
    for case in local["bytes"].as_array().expect("byte corpus is an array") {
        let input = case["input"].as_u64().expect("byte input is an integer");
        assert_eq!(case["output"], format_bytes(input));
    }
}

fn assert_workspace_fingerprints(local: &serde_json::Value, fixture: &WorkspaceFixture) {
    assert_eq!(
        local["tree"],
        serde_json::to_value(
            staged_workspace_tree_fingerprint(&fixture.workspace)
                .expect("fixture tree can be fingerprinted")
        )
        .expect("tree fingerprint serializes")
    );
    assert_eq!(
        local["returned"],
        serde_json::to_value(
            workspace_return_fingerprint(&fixture.workspace)
                .expect("fixture return can be fingerprinted")
        )
        .expect("return fingerprint serializes")
    );
    assert_eq!(
        local["collectedGit"],
        serde_json::to_value(
            collected_git_tree_fingerprint(&fixture.collected_git)
                .expect("collected Git fixture can be fingerprinted")
        )
        .expect("collected Git fingerprint serializes")
    );
}

#[test]
fn generated_workspace_scripts_match_typescript_golden() {
    let golden = golden();
    let expected = golden["scripts"]
        .as_array()
        .expect("workspace script corpus is an array");
    let actual = workspace_script_golden().expect("golden workspace inputs are valid");
    assert_eq!(actual.len(), 12);
    for ((label, output), expected) in actual.into_iter().zip(expected) {
        assert_eq!(label, expected["label"]);
        assert_eq!(output, expected["output"], "workspace script {label}");
    }
}

#[test]
fn generated_git_scripts_match_typescript_golden() {
    let golden = golden();
    let expected = golden["scripts"]
        .as_array()
        .expect("workspace script corpus is an array");
    let actual = workspace_git_script_golden().expect("golden Git inputs are valid");
    assert_eq!(actual.len(), 5);
    for ((label, output), expected) in actual.into_iter().zip(&expected[12..]) {
        assert_eq!(label, expected["label"]);
        assert_eq!(output, expected["output"], "Git script {label}");
    }
}

#[test]
fn workspace_errors_match_typescript_golden() {
    let errors = &golden()["errors"];
    assert_eq!(
        errors["owner"],
        workspace_owner_content("record-1", "bad")
            .expect_err("short owner token is rejected")
            .to_string()
    );
    assert_eq!(
        errors["purge"],
        assert_purgeable_path("/")
            .expect_err("root purge is rejected")
            .to_string()
    );
    assert_eq!(
        errors["upload"],
        workspace_upload_stage_path("../bad")
            .expect_err("unsafe upload generation is rejected")
            .to_string()
    );
}

#[test]
fn git_names_match_typescript_golden() {
    let golden = golden();
    let names = &golden["gitNames"];
    let digest = "a".repeat(64);
    assert_eq!(names["shippedRefsFile"], SHIPPED_REFS_FILE);
    assert_eq!(names["shippedStashLogFile"], SHIPPED_STASH_LOG_FILE);
    assert_eq!(names["qbase"], return_qbase("record-1", &digest));
    assert_eq!(names["refBase"], return_ref_base("record-1"));
    assert_git_value_names(names, &digest);
    assert_eq!(
        names["payload"],
        git_payload_path(GENERATION).expect("generation is valid")
    );
    assert_eq!(
        names["pointer"],
        git_pointer_bytes(GENERATION).expect("generation is valid")
    );
    assert_eq!(
        names["pointerTemp"],
        git_pointer_temp_name(GENERATION).expect("generation is valid")
    );
}

fn assert_git_value_names(names: &serde_json::Value, digest: &str) {
    assert_eq!(
        names["value"],
        return_value_ref(
            "record-1",
            digest,
            ReturnValueKind::Values,
            "refs/heads/feature/a",
        )
    );
    assert_eq!(
        names["reflog"],
        return_reflog_ref("record-1", digest, "refs/heads/main", b"raw\nreflog\n")
    );
    assert_eq!(
        names["reflogPin"],
        return_reflog_pin_ref("record-1", digest, &"b".repeat(40))
    );
    assert_eq!(
        names["objectPin"],
        return_object_pin_ref("record-1", digest, &"c".repeat(40))
    );
}

#[tokio::test(flavor = "current_thread")]
async fn git_errors_match_typescript_golden() {
    let root = tempfile::tempdir().expect("create transport home");
    let transport = LocalTransport::new(root.path()).expect("create local transport");
    let errors = &golden()["errors"];
    assert_eq!(
        errors["gitPayload"],
        git_payload_path("bad")
            .expect_err("bad generation is rejected")
            .to_string()
    );
    assert_eq!(
        errors["remoteGit"],
        remote_git_tree_fingerprint(&transport, "/srv/beam/workspace", "../bad", None)
            .await
            .expect_err("unsafe remote Git path is rejected")
            .to_string()
    );
}

struct WorkspaceFixture {
    root: PathBuf,
    _root: tempfile::TempDir,
    workspace: PathBuf,
    collected_git: PathBuf,
}

impl WorkspaceFixture {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("beam-parity-workspace-")
            .tempdir()
            .expect("create workspace fixture root");
        let workspace = root.path().join("workspace");
        create_workspace_fixture(&workspace);
        let collected_git = root.path().join("collected-git");
        create_collected_git_fixture(&collected_git);
        Self {
            root: root.path().to_path_buf(),
            _root: root,
            workspace,
            collected_git,
        }
    }
}

fn create_workspace_fixture(workspace: &Path) {
    let nested = workspace.join("nested");
    fs::create_dir_all(&nested).expect("create nested fixture directory");
    fs::write(workspace.join("a file.txt"), "alpha\n").expect("write fixture file");
    fs::write(nested.join("β.txt"), "beta\n").expect("write nested fixture file");
    symlink("nested/β.txt", workspace.join("link")).expect("create fixture symlink");
    fs::set_permissions(&nested, fs::Permissions::from_mode(0o750)).expect("set nested mode");
    fs::set_permissions(
        workspace.join("a file.txt"),
        fs::Permissions::from_mode(0o640),
    )
    .expect("set fixture file mode");
    fs::set_permissions(nested.join("β.txt"), fs::Permissions::from_mode(0o600))
        .expect("set nested fixture file mode");
    fs::write(
        workspace.join(".beamignore"),
        "# comment\n/node_modules\n\n *.tmp \n",
    )
    .expect("write fixture ignores");
}

fn create_collected_git_fixture(collected_git: &Path) {
    fs::create_dir_all(collected_git.join("objects"))
        .expect("create collected Git objects directory");
    fs::write(collected_git.join("HEAD"), "ref: refs/heads/main\n")
        .expect("write collected Git HEAD");
    fs::write(collected_git.join("objects/pack"), "pack-bytes\n")
        .expect("write collected Git object fixture");
}

fn git_layouts(root: &Path) -> serde_json::Value {
    let layouts =
        ["plain", "standard", "linked", "unsupported", "bare"].map(|name| root.join(name));
    for directory in &layouts {
        fs::create_dir(directory).expect("create Git layout fixture");
    }
    fs::create_dir(layouts[1].join(".git")).expect("create standard Git dir");
    fs::write(layouts[2].join(".git"), "gitdir: ../common\n").expect("write linked Git pointer");
    symlink("../common", layouts[3].join(".git")).expect("create unsupported Git symlink");
    fs::write(layouts[4].join("HEAD"), "ref: refs/heads/main\n").expect("write bare HEAD");
    fs::create_dir(layouts[4].join("objects")).expect("create bare objects");
    fs::create_dir(layouts[4].join("refs")).expect("create bare refs");
    serde_json::Value::Array(
        layouts
            .iter()
            .map(PathBuf::as_path)
            .map(git_layout_value)
            .collect(),
    )
}

fn git_layout_value(directory: &Path) -> serde_json::Value {
    serde_json::json!({
        "label": directory.file_name().expect("layout name").to_string_lossy(),
        "kind": workspace_git_entry_kind(directory),
        "worktree": is_git_worktree(directory),
        "linked": is_linked_worktree(directory),
        "gitDir": is_git_dir_at_cwd(directory),
    })
}
