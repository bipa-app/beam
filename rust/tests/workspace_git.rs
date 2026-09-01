//! Goal: prove the Rust Git seam ships linked worktrees and returns remote Git
//! state without mutating the local checkout or its live refs.
//!
//! Method: build real repositories, materialize them, exercise hostile source
//! changes and operation state, then collect a local-transport return through
//! the same authenticated quarantine path used by remote transports.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use beam::transport::local::LocalTransport;
use beam::util::shell::{RunOptions, run_checked};
use beam::workspace::{BEAM_RESERVED_DIR, workspace_owner_content};
use beam::workspace_git::{
    ReturnValueKind, WorktreeGitReturnRecord, collect_worktree_git_return,
    materialize_worktree_git, return_value_ref,
};

const OWNER_TOKEN: &str = "0123456789abcdef0123456789abcdef";

#[tokio::test(flavor = "current_thread")]
async fn linked_worktree_materialization_preserves_state_and_detects_drift() {
    let fixture = GitFixture::linked().await;
    fs::write(fixture.worktree.join("staged.txt"), "staged\n").expect("write staged file");
    git(&fixture.worktree, &["add", "staged.txt"]).await;
    fs::write(fixture.worktree.join("tracked.txt"), "unstaged\n").expect("write unstaged change");
    let materialized = materialize_worktree_git(&fixture.worktree)
        .await
        .expect("materialize linked worktree");
    assert!(materialized.ship_info.worktree_git_dir.is_some());
    assert!(materialized.ship_info.common_dir_id.is_some());
    assert!(materialized.ship_info.worktree_git_dir_id.is_some());
    assert_materialized_state(&materialized.git_dir).await;
    materialized
        .assert_source_unchanged()
        .await
        .expect("unchanged source still matches ship fingerprint");
    git(&fixture.worktree, &["config", "beam.drift", "changed"]).await;
    let error = materialized
        .assert_source_unchanged()
        .await
        .expect_err("source config drift is rejected");
    assert!(
        error
            .to_string()
            .contains("changed since Beam materialized"),
        "{error}"
    );
    materialized.cleanup().expect("clean materialized payload");
}

async fn assert_materialized_state(git_dir: &Path) {
    let branch = git_dir_arg(git_dir, &["symbolic-ref", "HEAD"]);
    let branch = checked(&branch).await;
    assert_eq!(branch.trim(), "refs/heads/feature");
    let index = git_dir_arg(git_dir, &["ls-files", "--stage"]);
    let index = checked(&index).await;
    assert!(index.contains("staged.txt"));
    assert!(git_dir.join("beam-shipped-refs").is_file());
    assert!(git_dir.join("beam-shipped-stash-log").is_file());
}

#[tokio::test(flavor = "current_thread")]
async fn materialization_refuses_sparse_and_in_progress_sources() {
    let fixture = GitFixture::standard().await;
    fs::write(fixture.worktree.join("other.txt"), "other\n").expect("write other branch file");
    git(&fixture.worktree, &["add", "other.txt"]).await;
    git(&fixture.worktree, &["commit", "-m", "other"]).await;
    git(&fixture.worktree, &["checkout", "-b", "conflict"]).await;
    fs::write(fixture.worktree.join("tracked.txt"), "conflict\n").expect("write conflict branch");
    git(&fixture.worktree, &["commit", "-am", "conflict"]).await;
    git(&fixture.worktree, &["checkout", "main"]).await;
    fs::write(fixture.worktree.join("tracked.txt"), "main\n").expect("write main branch");
    git(&fixture.worktree, &["commit", "-am", "main"]).await;
    let merge = git_result(&fixture.worktree, &["merge", "conflict"]).await;
    assert_ne!(merge.code, 0);
    let error = materialize_error(&fixture.worktree).await;
    assert!(
        error.to_string().contains("in-progress git operation"),
        "{error}"
    );
    git(&fixture.worktree, &["merge", "--abort"]).await;
    git(&fixture.worktree, &["sparse-checkout", "init", "--cone"]).await;
    let error = materialize_error(&fixture.worktree).await;
    assert!(error.to_string().contains("sparse-checkout"), "{error}");
}

async fn materialize_error(worktree: &Path) -> beam::workspace_git::WorkspaceGitError {
    match materialize_worktree_git(worktree).await {
        Ok(materialized) => {
            materialized
                .cleanup()
                .expect("clean unexpectedly accepted payload");
            panic!("materialization unexpectedly accepted hostile source");
        }
        Err(error) => error,
    }
}

#[tokio::test(flavor = "current_thread")]
async fn remote_return_is_append_only_and_leaves_live_checkout_untouched() {
    let fixture = GitFixture::standard().await;
    let local_head = git(&fixture.worktree, &["rev-parse", "HEAD"]).await;
    let materialized = materialize_worktree_git(&fixture.worktree)
        .await
        .expect("materialize source repository");
    let generation = materialized.ship_info.generation.clone();
    let ship_info = materialized.ship_info.clone();
    let remote = fixture.root.path().join("remote-workspace");
    install_remote_fixture(&remote, &materialized.git_dir, &generation, "record-1");
    let remote = fs::canonicalize(remote).expect("resolve remote workspace physically");
    materialized.cleanup().expect("clean materialized payload");
    fs::write(remote.join("tracked.txt"), "remote commit\n").expect("write remote change");
    git(&remote, &["add", "tracked.txt"]).await;
    git(&remote, &["commit", "-m", "remote"]).await;
    let remote_head = git(&remote, &["rev-parse", "HEAD"]).await;
    let transport = LocalTransport::new(fixture.root.path()).expect("create local transport");
    let record = WorktreeGitReturnRecord {
        id: "record-1",
        local_cwd: &fixture.worktree,
        remote_cwd: remote.to_str().expect("remote path is UTF-8"),
        wt_git: Some(&ship_info),
        workspace_token: Some(OWNER_TOKEN),
    };
    let collected = collect_worktree_git_return(&transport, record)
        .await
        .expect("collect authenticated remote Git state");
    let returned = collected.apply().await.expect("publish quarantine refs");
    collected
        .assert_remote_git_unchanged(Some("during the return test"))
        .await
        .expect("remote repository stayed stable");
    assert!(returned.qbase.starts_with("refs/beam/return/record-1-"));
    let digest = returned
        .qbase
        .rsplit('/')
        .next()
        .expect("quarantine base has digest");
    let quarantined_ref = return_value_ref(
        &format!("record-1-{generation}"),
        digest,
        ReturnValueKind::Values,
        "refs/heads/main",
    );
    let quarantined_tip = git(&fixture.worktree, &["rev-parse", &quarantined_ref]).await;
    assert_eq!(quarantined_tip.trim(), remote_head.trim());
    assert_eq!(
        git(&fixture.worktree, &["rev-parse", "HEAD"]).await,
        local_head
    );
    assert_eq!(
        fs::read_to_string(fixture.worktree.join("tracked.txt")).expect("read local file"),
        "initial\n"
    );
    collected.dispose().expect("dispose collected quarantine");
}

fn install_remote_fixture(remote: &Path, git_dir: &Path, generation: &str, record_id: &str) {
    fs::create_dir_all(remote.join(BEAM_RESERVED_DIR)).expect("create remote Beam dir");
    fs::write(remote.join("tracked.txt"), "initial\n").expect("write remote workspace");
    fs::write(
        remote.join(BEAM_RESERVED_DIR).join("owner"),
        format!(
            "{}\n",
            workspace_owner_content(record_id, OWNER_TOKEN).expect("valid owner")
        ),
    )
    .expect("write remote owner");
    fs::set_permissions(
        remote.join(BEAM_RESERVED_DIR),
        fs::Permissions::from_mode(0o700),
    )
    .expect("tighten remote Beam dir");
    let payload = remote.join(BEAM_RESERVED_DIR).join("git").join(generation);
    copy_tree(git_dir, &payload);
    fs::write(
        remote.join(".git"),
        format!("gitdir: .beam/git/{generation}\n"),
    )
    .expect("write remote Git pointer");
}

fn copy_tree(source: &Path, destination: &Path) {
    fs::create_dir_all(destination).expect("create copy destination");
    let mut stack = vec![(source.to_path_buf(), destination.to_path_buf())];
    while let Some((source_dir, destination_dir)) = stack.pop() {
        for entry in fs::read_dir(&source_dir).expect("read copy source") {
            let entry = entry.expect("read copy entry");
            let target = destination_dir.join(entry.file_name());
            let kind = entry.file_type().expect("read copy entry type");
            if kind.is_dir() {
                fs::create_dir(&target).expect("create copied directory");
                stack.push((entry.path(), target));
            } else if kind.is_file() {
                fs::copy(entry.path(), target).expect("copy file");
            } else {
                panic!("unexpected Git payload entry: {}", entry.path().display());
            }
        }
    }
}

struct GitFixture {
    root: tempfile::TempDir,
    worktree: PathBuf,
}

impl GitFixture {
    async fn standard() -> Self {
        let root = tempfile::Builder::new()
            .prefix("beam-rust-git-")
            .tempdir()
            .expect("create Git fixture root");
        let worktree = root.path().join("repo");
        git_at_root(root.path(), &["init", "-b", "main", path(&worktree)]).await;
        initialize_commit(&worktree).await;
        Self { root, worktree }
    }

    async fn linked() -> Self {
        let root = tempfile::Builder::new()
            .prefix("beam-rust-linked-")
            .tempdir()
            .expect("create linked fixture root");
        let main = root.path().join("main");
        let worktree = root.path().join("linked");
        git_at_root(root.path(), &["init", "-b", "main", path(&main)]).await;
        initialize_commit(&main).await;
        git(
            &main,
            &["worktree", "add", "-b", "feature", path(&worktree)],
        )
        .await;
        Self { root, worktree }
    }
}

async fn initialize_commit(worktree: &Path) {
    git(worktree, &["config", "user.name", "Beam Test"]).await;
    git(worktree, &["config", "user.email", "beam@test.invalid"]).await;
    fs::write(worktree.join("tracked.txt"), "initial\n").expect("write tracked file");
    git(worktree, &["add", "tracked.txt"]).await;
    git(worktree, &["commit", "-m", "initial"]).await;
}

async fn git(cwd: &Path, arguments: &[&str]) -> String {
    let result = git_result(cwd, arguments).await;
    assert_eq!(result.code, 0, "git failed: {}", result.stderr);
    result.stdout.trim().to_owned()
}

async fn git_result(cwd: &Path, arguments: &[&str]) -> beam::util::shell::RunResult {
    let mut argv = vec![os("git"), os("-C"), cwd.as_os_str().to_owned()];
    argv.extend(arguments.iter().map(os));
    beam::util::shell::run(&argv, &RunOptions::default())
        .await
        .expect("run git")
}

async fn git_at_root(cwd: &Path, arguments: &[&str]) -> String {
    let mut argv = vec![os("git")];
    argv.extend(arguments.iter().map(os));
    checked_with_cwd(&argv, cwd).await
}

async fn checked(argv: &[OsString]) -> String {
    run_checked(argv, &RunOptions::default())
        .await
        .expect("run checked command")
        .stdout
}

async fn checked_with_cwd(argv: &[OsString], cwd: &Path) -> String {
    run_checked(
        argv,
        &RunOptions {
            cwd: Some(cwd),
            ..RunOptions::default()
        },
    )
    .await
    .expect("run checked command")
    .stdout
}

fn git_dir_arg(git_dir: &Path, arguments: &[&str]) -> Vec<OsString> {
    let mut argv = vec![os("git"), os("--git-dir"), git_dir.as_os_str().to_owned()];
    argv.extend(arguments.iter().map(os));
    argv
}

fn path(path: &Path) -> &str {
    path.to_str().expect("fixture path is UTF-8")
}

fn os(value: impl AsRef<OsStr>) -> OsString {
    value.as_ref().to_owned()
}
