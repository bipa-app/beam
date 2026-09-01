//! Goal: prove workspace effects stay physically contained and owner-bound.
//!
//! Method: drive the real local transport shell against temporary paths, swap
//! symlinks and ownership markers adversarially, and inspect bytes after each
//! accepted or refused transaction.

use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};

use beam::transport::local::LocalTransport;
use beam::workspace::{
    ContainedWorkspace, OwnerAdoption, PurgeResult, ReleaseResult, assert_contained_workspace,
    establish_contained_workspace, publish_workspace_upload_stage, purge_owned_workspace_contents,
    release_owned_workspace, remote_workspace_upload_stage_present, remove_workspace_upload_stage,
    workspace_owner_content, workspace_upload_stage_path,
};

const TOKEN: &str = "0123456789abcdef0123456789abcdef";

#[tokio::test(flavor = "current_thread")]
async fn containment_refuses_symlink_swaps_and_foreign_owners() {
    let fixture = WorkspaceFixture::new();
    let workspace = fixture.establish().await;
    fs::write(workspace.join("keep.txt"), "keep\n").expect("write workspace fixture");
    fs::write(workspace.join(".beam/owner"), "foreign\n").expect("replace owner marker");
    let error =
        purge_owned_workspace_contents(&fixture.transport, path(&workspace), &fixture.owner, false)
            .await
            .expect_err("foreign workspace is not purged");
    assert!(error.to_string().contains("not owned by this handoff"));
    assert_eq!(
        fs::read_to_string(workspace.join("keep.txt")).expect("read retained file"),
        "keep\n"
    );
    let parked = fixture.root.join("parked");
    fs::rename(&workspace, &parked).expect("park real workspace");
    symlink(&parked, &workspace).expect("swap workspace for symlink");
    let error = assert_contained_workspace(
        &fixture.transport,
        path(&fixture.root),
        path(&workspace),
        false,
        None,
    )
    .await
    .expect_err("symlinked workspace is rejected");
    assert!(error.to_string().contains("symlink"));
    assert_eq!(
        fs::read_to_string(parked.join("keep.txt")).expect("read parked file"),
        "keep\n"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn purge_then_release_converges_without_widening_deletion() {
    let fixture = WorkspaceFixture::new();
    let workspace = fixture.establish().await;
    fs::create_dir(workspace.join("nested")).expect("create workspace directory");
    fs::write(workspace.join("nested/data.txt"), "data\n").expect("write workspace data");
    let purged =
        purge_owned_workspace_contents(&fixture.transport, path(&workspace), &fixture.owner, false)
            .await
            .expect("purge owned workspace");
    assert_eq!(purged, PurgeResult::Purged);
    assert!(workspace.join(".beam/owner").is_file());
    assert!(!workspace.join("nested").exists());
    let released = release_owned_workspace(&fixture.transport, path(&workspace), &fixture.owner)
        .await
        .expect("release empty owned workspace");
    assert_eq!(released, ReleaseResult::Released);
    assert!(!workspace.exists());
    let converged =
        purge_owned_workspace_contents(&fixture.transport, path(&workspace), &fixture.owner, true)
            .await
            .expect("converged purge accepts absence");
    assert_eq!(converged, PurgeResult::Absent);
}

#[tokio::test(flavor = "current_thread")]
async fn upload_publication_never_overwrites_live_bytes() {
    let fixture = WorkspaceFixture::new();
    let workspace = fixture.establish().await;
    fs::write(workspace.join("collision.txt"), "live\n").expect("write live collision");
    let generation = "0123456789abcdef";
    let stage = create_upload_stage(&workspace, generation);
    fs::write(stage.join("collision.txt"), "staged\n").expect("write staged collision");
    assert!(
        remote_workspace_upload_stage_present(
            &fixture.transport,
            path(&workspace),
            generation,
            &fixture.owner,
        )
        .await
        .expect("probe upload stage")
    );
    let error = publish_workspace_upload_stage(
        &fixture.transport,
        path(&workspace),
        generation,
        &fixture.owner,
    )
    .await
    .expect_err("different live content is not overwritten");
    assert!(error.to_string().contains("different content"));
    assert_eq!(
        fs::read_to_string(workspace.join("collision.txt")).expect("read live collision"),
        "live\n"
    );
    remove_workspace_upload_stage(
        &fixture.transport,
        path(&workspace),
        generation,
        &fixture.owner,
    )
    .await
    .expect("remove refused upload stage");
    assert!(!stage.exists());
}

fn create_upload_stage(workspace: &Path, generation: &str) -> PathBuf {
    let relative = workspace_upload_stage_path(generation).expect("valid upload generation");
    let stage = workspace.join(relative);
    fs::create_dir_all(&stage).expect("create upload stage");
    for directory in [
        workspace.join(".beam/uploads"),
        workspace.join(".beam/uploads").join(generation),
        stage.clone(),
    ] {
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .expect("tighten upload stage directory");
    }
    stage
}

struct WorkspaceFixture {
    _temporary: tempfile::TempDir,
    root: PathBuf,
    transport: LocalTransport,
    owner: String,
}

impl WorkspaceFixture {
    fn new() -> Self {
        let temporary = tempfile::Builder::new()
            .prefix("beam-rust-workspace-")
            .tempdir()
            .expect("create workspace fixture root");
        let root = fs::canonicalize(temporary.path()).expect("resolve fixture root physically");
        let transport = LocalTransport::new(&root).expect("create local transport");
        let owner = workspace_owner_content("record-1", TOKEN).expect("valid owner");
        Self {
            _temporary: temporary,
            root,
            transport,
            owner,
        }
    }

    async fn establish(&self) -> PathBuf {
        let workspace = establish_contained_workspace(
            &self.transport,
            path(&self.root),
            ContainedWorkspace::Name("workspace"),
            &self.owner,
            OwnerAdoption::Create,
        )
        .await
        .expect("establish contained workspace");
        PathBuf::from(workspace)
    }
}

fn path(path: &Path) -> &str {
    path.to_str().expect("fixture path is UTF-8")
}
