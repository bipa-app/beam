use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::future::Future;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use serde::Serialize;

use super::return_path::{index_content, index_semantic_digest};
use super::{
    GitDirIdentity, MACHINE_LAYOUT_CONFIG, REPOSITORY_ID_FILE, SHIPPED_REFS_FILE,
    SHIPPED_STASH_LOG_FILE, WORKTREE_ID_FILE, WorkspaceGitError, WtGitShipInfo, content_digest,
    dir_identity, is_shippable_shared_ref, os, path_text, run_git, run_git_checked,
};

const MAX_LOOSE_REF_ENTRIES: usize = 1_000_000;
const OP_STATE_MARKERS: [&str; 7] = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
];

pub struct MaterializedWorktreeGit {
    temporary: tempfile::TempDir,
    repo_dir: PathBuf,
    pub git_dir: PathBuf,
    pub ship_info: WtGitShipInfo,
    source: SourceIdentity,
}

impl MaterializedWorktreeGit {
    pub async fn assert_source_unchanged(&self) -> Result<(), WorkspaceGitError> {
        materialize_assert_source_unchanged(&self.source, &self.repo_dir).await
    }

    pub fn cleanup(self) -> Result<(), WorkspaceGitError> {
        self.temporary.close().map_err(WorkspaceGitError::from)
    }
}

#[derive(Clone)]
struct SourceRef {
    name: String,
    sha: String,
    symbolic_target: Option<String>,
}

#[derive(Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum HeadState {
    Attached { reference: String, commit: String },
    Unborn { reference: String },
    Detached { commit: String },
}

impl HeadState {
    fn reference(&self) -> Option<&str> {
        match self {
            Self::Attached { reference, .. } | Self::Unborn { reference } => Some(reference),
            Self::Detached { .. } => None,
        }
    }

    fn commit(&self) -> Option<&str> {
        match self {
            Self::Attached { commit, .. } | Self::Detached { commit } => Some(commit),
            Self::Unborn { .. } => None,
        }
    }

    fn descriptor(&self) -> String {
        match self {
            Self::Attached { reference, commit } => format!("attached {reference} {commit}"),
            Self::Unborn { reference } => format!("unborn {reference}"),
            Self::Detached { commit } => format!("detached {commit}"),
        }
    }
}

struct MaterializeSourceSnapshot {
    identity: SourceIdentity,
    common_dir_token: String,
    worktree_git_dir_token: String,
    head: HeadState,
    refs: Vec<SourceRef>,
    stash_log: Option<Vec<u8>>,
    shipped_stash: Vec<String>,
    config: Vec<(String, String)>,
}

struct SourceIdentity {
    local_cwd: PathBuf,
    common_dir: PathBuf,
    worktree_git_dir: PathBuf,
    fingerprint: SourceGitFingerprint,
}

#[derive(Serialize, PartialEq)]
struct SourceGitFingerprint {
    value: String,
    semantic: String,
    common_dir_id: GitDirIdentity,
    worktree_git_dir_id: GitDirIdentity,
}

struct PortableGitSemantic {
    semantic: String,
    index_digest: String,
    config_raw: String,
}

pub fn materialize_worktree_git(
    local_cwd: &Path,
) -> Pin<Box<dyn Future<Output = Result<MaterializedWorktreeGit, WorkspaceGitError>> + '_>> {
    // This phase carries several subprocess buffers. Heap the state machine so a
    // debug build cannot exhaust a caller's small worker-thread stack.
    Box::pin(materialize_worktree_git_boxed(local_cwd))
}

async fn materialize_worktree_git_boxed(
    local_cwd: &Path,
) -> Result<MaterializedWorktreeGit, WorkspaceGitError> {
    assert_no_sparse_layout(local_cwd, "beam up").await?;
    assert_no_operation_in_progress(local_cwd, "beam up").await?;
    assert_files_ref_storage(local_cwd, "beam up").await?;
    assert_no_history_boundary(local_cwd, "beam up").await?;
    let live_index = git_path(local_cwd, "index").await?;
    if live_index.try_exists()?
        && index_content(local_cwd, Some(&live_index), None, None)
            .await?
            .tree
            .is_none()
    {
        return Err(WorkspaceGitError::message(
            "beam up: the Git index has unmerged entries without a supported operation state — \
             resolve or reset them before handoff"
                .to_owned(),
        ));
    }
    let temporary = tempfile::Builder::new().prefix("beam-wtgit-").tempdir()?;
    let repo_dir = temporary.path().join("repo");
    let git_dir = repo_dir.join(".git");
    let result =
        materialize_worktree_git_inner(local_cwd, &repo_dir, &git_dir, temporary.path()).await;
    match result {
        Ok((source, ship_info)) => Ok(MaterializedWorktreeGit {
            temporary,
            repo_dir,
            git_dir,
            ship_info,
            source,
        }),
        Err(error) => {
            drop(temporary);
            Err(error)
        }
    }
}

async fn materialize_worktree_git_inner(
    local_cwd: &Path,
    repo_dir: &Path,
    git_dir: &Path,
    temporary_root: &Path,
) -> Result<(SourceIdentity, WtGitShipInfo), WorkspaceGitError> {
    let snapshot = materialize_source_snapshot(local_cwd).await?;
    materialize_clone_payload(local_cwd, temporary_root, repo_dir, git_dir).await?;
    materialize_mirror_refs(
        repo_dir,
        &snapshot.refs,
        &snapshot.shipped_stash,
        &snapshot.head,
    )
    .await?;
    materialize_ship_index(local_cwd, repo_dir, git_dir, &snapshot.head).await?;
    materialize_install_config(
        repo_dir,
        git_dir,
        &snapshot.identity.common_dir,
        &snapshot.config,
    )
    .await?;
    let shipped_refs = materialize_seal_payload(
        git_dir,
        &snapshot.refs,
        &snapshot.shipped_stash,
        snapshot.stash_log.as_deref(),
    )?;
    materialize_prove_payload_complete(repo_dir, &snapshot.refs).await?;
    materialize_assert_source_unchanged(&snapshot.identity, repo_dir).await?;
    let mut generation_bytes = [0_u8; 8];
    getrandom::fill(&mut generation_bytes)
        .map_err(|source| WorkspaceGitError::message(format!("getrandom failed: {source}")))?;
    let ship_info = WtGitShipInfo {
        head: snapshot.head.commit().map(str::to_owned),
        branch: snapshot.head.reference().map(str::to_owned),
        common_dir: path_text(&snapshot.identity.common_dir)?.to_owned(),
        worktree_git_dir: Some(path_text(&snapshot.identity.worktree_git_dir)?.to_owned()),
        common_dir_id: Some(snapshot.identity.fingerprint.common_dir_id.clone()),
        worktree_git_dir_id: Some(snapshot.identity.fingerprint.worktree_git_dir_id.clone()),
        common_dir_token: Some(snapshot.common_dir_token),
        worktree_git_dir_token: Some(snapshot.worktree_git_dir_token),
        shipped_refs_digest: Some(content_digest(shipped_refs.as_bytes())),
        shipped_stash_log_digest: Some(content_digest(
            snapshot.stash_log.as_deref().unwrap_or_default(),
        )),
        generation: hex::encode(generation_bytes),
    };
    Ok((snapshot.identity, ship_info))
}

async fn materialize_source_snapshot(
    local_cwd: &Path,
) -> Result<MaterializeSourceSnapshot, WorkspaceGitError> {
    let common_dir = resolve_git_output(
        local_cwd,
        &run_git_checked(
            &git_args(local_cwd, &["rev-parse", "--git-common-dir"]),
            None,
            None,
        )
        .await?
        .stdout,
    );
    let worktree_git_dir = resolve_git_output(
        local_cwd,
        &run_git_checked(
            &git_args(local_cwd, &["rev-parse", "--absolute-git-dir"]),
            None,
            None,
        )
        .await?
        .stdout,
    );
    let common_dir_token = ensure_git_identity_token(&common_dir, REPOSITORY_ID_FILE)?;
    let worktree_git_dir_token = ensure_git_identity_token(&worktree_git_dir, WORKTREE_ID_FILE)?;
    let fingerprint = source_git_fingerprint(local_cwd, &common_dir, &worktree_git_dir).await?;
    let head = head_state(local_cwd, "beam up", None).await?;
    let refs = list_refs_with(local_cwd, &[])
        .await?
        .into_iter()
        .filter(|reference| is_shippable_shared_ref(&reference.name))
        .collect::<Vec<_>>();
    let stash_tip = refs
        .iter()
        .find(|reference| reference.name == "refs/stash" && reference.symbolic_target.is_none())
        .map(|reference| reference.sha.clone());
    let stash_path = git_path(local_cwd, "logs/refs/stash").await?;
    let stash_log = if stash_tip.is_some() && stash_path.try_exists()? {
        Some(fs::read(stash_path)?)
    } else {
        None
    };
    let shipped_stash = stash_tip
        .as_deref()
        .map(|tip| stash_stack(tip, stash_log.as_deref()))
        .unwrap_or_default();
    let config_raw = run_git_checked(
        &git_args(local_cwd, &["config", "--local", "--null", "--list"]),
        None,
        None,
    )
    .await?
    .stdout;
    Ok(MaterializeSourceSnapshot {
        identity: SourceIdentity {
            local_cwd: local_cwd.to_path_buf(),
            common_dir,
            worktree_git_dir,
            fingerprint,
        },
        common_dir_token,
        worktree_git_dir_token,
        head,
        refs,
        stash_log,
        shipped_stash,
        config: parse_nul_config(&config_raw),
    })
}

async fn materialize_clone_payload(
    local_cwd: &Path,
    temporary_root: &Path,
    repo_dir: &Path,
    git_dir: &Path,
) -> Result<(), WorkspaceGitError> {
    let empty_template = temporary_root.join("template");
    fs::create_dir(&empty_template)?;
    if fs::read_dir(&empty_template)?.next().is_some() {
        return Err(WorkspaceGitError::message(
            "beam up: the Git payload template staging directory is not empty — refusing to clone \
             through it"
                .to_owned(),
        ));
    }
    run_git_checked(
        &[
            os("git"),
            os("clone"),
            os("--quiet"),
            os("--no-hardlinks"),
            os("--no-checkout"),
            os("--dissociate"),
            os(format!("--template={}", path_text(&empty_template)?)),
            local_cwd.as_os_str().to_owned(),
            repo_dir.as_os_str().to_owned(),
        ],
        None,
        None,
    )
    .await?;
    let hooks = git_dir.join("hooks");
    let payload_hooks = if hooks.try_exists()? {
        fs::read_dir(&hooks)?
            .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
            .collect::<Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };
    if !payload_hooks.is_empty() {
        return Err(WorkspaceGitError::message(format!(
            "beam up: the Git payload unexpectedly contains hooks ({}) — refusing to ship \
             executable hook content to the sandbox",
            payload_hooks.join(", ")
        )));
    }
    run_git_checked(
        &git_args(repo_dir, &["remote", "remove", "origin"]),
        None,
        None,
    )
    .await?;
    let config = run_git_checked(
        &git_args(repo_dir, &["config", "--local", "--null", "--list"]),
        None,
        None,
    )
    .await?
    .stdout;
    let keys = parse_nul_config(&config)
        .into_iter()
        .map(|(key, _)| key)
        .collect::<BTreeSet<_>>();
    for key in keys {
        if key.starts_with("core.") || key.starts_with("extensions.") {
            continue;
        }
        run_git_checked(
            &git_args_owned(repo_dir, &["config", "--local", "--unset-all", &key]),
            None,
            None,
        )
        .await?;
    }
    Ok(())
}

async fn materialize_mirror_refs(
    repo_dir: &Path,
    refs: &[SourceRef],
    shipped_stash: &[String],
    head: &HeadState,
) -> Result<(), WorkspaceGitError> {
    for reference in refs
        .iter()
        .filter(|reference| reference.symbolic_target.is_none())
    {
        run_git_checked(
            &git_args_owned(
                repo_dir,
                &["update-ref", "--no-deref", &reference.name, &reference.sha],
            ),
            None,
            None,
        )
        .await?;
    }
    for reference in refs
        .iter()
        .filter(|reference| reference.symbolic_target.is_some())
    {
        let target = reference.symbolic_target.as_deref().unwrap_or_default();
        run_git_checked(
            &git_args_owned(repo_dir, &["symbolic-ref", &reference.name, target]),
            None,
            None,
        )
        .await?;
    }
    let mut shipped_oids = refs
        .iter()
        .filter(|reference| reference.symbolic_target.is_none())
        .map(|reference| reference.sha.clone())
        .chain(shipped_stash.iter().cloned())
        .collect::<BTreeSet<_>>();
    for (index, oid) in shipped_oids.iter().enumerate() {
        run_git_checked(
            &git_args_owned(
                repo_dir,
                &[
                    "update-ref",
                    "--no-deref",
                    &format!("refs/beam/shipped/{index:08}"),
                    oid,
                ],
            ),
            None,
            None,
        )
        .await?;
    }
    shipped_oids.clear();
    match head {
        HeadState::Attached { reference, .. } | HeadState::Unborn { reference } => {
            run_git_checked(
                &git_args_owned(repo_dir, &["symbolic-ref", "HEAD", reference]),
                None,
                None,
            )
            .await?;
        }
        HeadState::Detached { commit } => {
            run_git_checked(
                &git_args_owned(repo_dir, &["update-ref", "--no-deref", "HEAD", commit]),
                None,
                None,
            )
            .await?;
        }
    }
    Ok(())
}

async fn materialize_ship_index(
    local_cwd: &Path,
    repo_dir: &Path,
    git_dir: &Path,
    head: &HeadState,
) -> Result<(), WorkspaceGitError> {
    let source_index = git_path(local_cwd, "index").await?;
    if source_index.try_exists()? {
        let parent = source_index.parent().ok_or_else(|| {
            WorkspaceGitError::message("beam: Git index has no parent directory".to_owned())
        })?;
        for entry in fs::read_dir(parent)? {
            let entry = entry?;
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with("sharedindex.")
            {
                fs::copy(entry.path(), git_dir.join(entry.file_name()))?;
            }
        }
        fs::copy(&source_index, git_dir.join("index"))?;
        for arguments in [
            &["update-index", "--no-split-index"][..],
            &["update-index", "--no-untracked-cache"][..],
        ] {
            run_git_checked(&git_args(repo_dir, arguments), None, None).await?;
        }
        drop(
            run_git(
                &git_args(repo_dir, &["update-index", "--no-fsmonitor"]),
                None,
                None,
            )
            .await?,
        );
        for entry in fs::read_dir(git_dir)? {
            let entry = entry?;
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with("sharedindex.")
            {
                fs::remove_file(entry.path())?;
            }
        }
    } else {
        let seed = head.commit().unwrap_or("--empty");
        run_git_checked(&git_args_owned(repo_dir, &["read-tree", seed]), None, None).await?;
    }
    Ok(())
}

async fn materialize_install_config(
    repo_dir: &Path,
    git_dir: &Path,
    common_dir: &Path,
    source_config: &[(String, String)],
) -> Result<(), WorkspaceGitError> {
    for (key, value) in outbound_config(source_config) {
        run_git_checked(
            &git_args_owned(repo_dir, &["config", "--local", "--add", key, value]),
            None,
            None,
        )
        .await?;
    }
    let source_exclude = common_dir.join("info/exclude");
    let mut exclude = if source_exclude.try_exists()? {
        fs::read_to_string(source_exclude)?
    } else {
        String::new()
    };
    if !exclude.lines().any(|line| line.trim() == ".beam/") {
        if !exclude.is_empty() && !exclude.ends_with('\n') {
            exclude.push('\n');
        }
        exclude.push_str(".beam/\n");
    }
    fs::create_dir_all(git_dir.join("info"))?;
    fs::write(git_dir.join("info/exclude"), exclude)?;
    Ok(())
}

fn materialize_seal_payload(
    git_dir: &Path,
    refs: &[SourceRef],
    shipped_stash: &[String],
    stash_log: Option<&[u8]>,
) -> Result<String, WorkspaceGitError> {
    let mut shipped = String::new();
    for reference in refs {
        let target = reference
            .symbolic_target
            .as_deref()
            .map(|target| format!(" {target}"))
            .unwrap_or_default();
        shipped.push_str(&format!("{} {}{target}\n", reference.sha, reference.name));
    }
    for (index, sha) in shipped_stash.iter().enumerate().skip(1) {
        shipped.push_str(&format!("{sha} refs/stash@{{{index}}}\n"));
    }
    fs::write(git_dir.join(SHIPPED_REFS_FILE), &shipped)?;
    fs::write(
        git_dir.join(SHIPPED_STASH_LOG_FILE),
        stash_log.unwrap_or_default(),
    )?;
    let logs = git_dir.join("logs");
    if logs.try_exists()? {
        fs::remove_dir_all(&logs)?;
    }
    let fetch_head = git_dir.join("FETCH_HEAD");
    if fetch_head.try_exists()? {
        fs::remove_file(fetch_head)?;
    }
    if let Some(stash_log) = stash_log {
        fs::create_dir_all(git_dir.join("logs/refs"))?;
        fs::write(git_dir.join("logs/refs/stash"), stash_log)?;
    }
    Ok(shipped)
}

async fn materialize_prove_payload_complete(
    repo_dir: &Path,
    refs: &[SourceRef],
) -> Result<(), WorkspaceGitError> {
    let result = run_git(
        &git_args(
            repo_dir,
            &[
                "--no-replace-objects",
                "fsck",
                "--full",
                "--cache",
                "--no-dangling",
            ],
        ),
        None,
        None,
    )
    .await?;
    if result.code == 0 {
        return Ok(());
    }
    let dangling = refs
        .iter()
        .filter(|reference| {
            reference.symbolic_target.is_some() && reference.sha.bytes().all(|byte| byte == b'0')
        })
        .map(|reference| reference.name.as_str())
        .collect::<BTreeSet<_>>();
    let stderr = result
        .stderr
        .lines()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let tolerable = !stderr.is_empty()
        && result.stdout.trim().is_empty()
        && stderr
            .iter()
            .all(|line| dangling_pointer_error(line, &dangling));
    if tolerable {
        return Ok(());
    }
    let detail = if result.stderr.is_empty() {
        result.stdout.trim()
    } else {
        result.stderr.trim()
    };
    let suffix = if detail.is_empty() {
        String::new()
    } else {
        format!("\n{detail}")
    };
    Err(WorkspaceGitError::message(format!(
        "command failed ({}): git{suffix}",
        result.code
    )))
}

async fn materialize_assert_source_unchanged(
    source: &SourceIdentity,
    repo_dir: &Path,
) -> Result<(), WorkspaceGitError> {
    let current = source_git_fingerprint(
        &source.local_cwd,
        &source.common_dir,
        &source.worktree_git_dir,
    )
    .await?;
    let payload = portable_git_semantic(repo_dir).await?;
    if current.value != source.fingerprint.value {
        return Err(WorkspaceGitError::message(
            "beam up: the local Git HEAD, index, refs, config, operation state, layout, or \
             repository identity changed since Beam materialized the handoff — refusing to ship \
             a torn Git snapshot; retry beam up"
                .to_owned(),
        ));
    }
    if payload.semantic != source.fingerprint.semantic {
        return Err(WorkspaceGitError::message(
            "beam up: the completed Git payload does not match the source snapshot — refusing to \
             ship a mixed or torn repository"
                .to_owned(),
        ));
    }
    Ok(())
}

async fn source_git_fingerprint(
    local_cwd: &Path,
    common_dir: &Path,
    worktree_git_dir: &Path,
) -> Result<SourceGitFingerprint, WorkspaceGitError> {
    assert_no_sparse_layout(local_cwd, "beam up").await?;
    assert_no_operation_in_progress(local_cwd, "beam up").await?;
    assert_files_ref_storage(local_cwd, "beam up").await?;
    assert_no_history_boundary(local_cwd, "beam up").await?;
    let current_common = resolve_git_output(
        local_cwd,
        &run_git_checked(
            &git_args(local_cwd, &["rev-parse", "--git-common-dir"]),
            None,
            None,
        )
        .await?
        .stdout,
    );
    let current_worktree = resolve_git_output(
        local_cwd,
        &run_git_checked(
            &git_args(local_cwd, &["rev-parse", "--absolute-git-dir"]),
            None,
            None,
        )
        .await?
        .stdout,
    );
    if safe_realpath(&current_common) != safe_realpath(common_dir)
        || safe_realpath(&current_worktree) != safe_realpath(worktree_git_dir)
    {
        return Err(WorkspaceGitError::message(
            "beam up: the source repository layout changed while Beam prepared the Git handoff"
                .to_owned(),
        ));
    }
    let semantic = portable_git_semantic(local_cwd).await?;
    let common_dir_id = dir_identity(&current_common)?;
    let worktree_git_dir_id = dir_identity(&current_worktree)?;
    let value = serde_json::to_string(&serde_json::json!({
        "semantic": semantic.semantic,
        "indexDigest": semantic.index_digest,
        "config": content_digest(semantic.config_raw.as_bytes()),
        "commonDir": path_text(&safe_realpath(&current_common))?,
        "worktreeGitDir": path_text(&safe_realpath(&current_worktree))?,
        "commonDirId": common_dir_id,
        "worktreeGitDirId": worktree_git_dir_id,
        "commonDirToken": read_git_identity_token(common_dir, REPOSITORY_ID_FILE)?,
        "worktreeGitDirToken": read_git_identity_token(worktree_git_dir, WORKTREE_ID_FILE)?,
    }))
    .map_err(|source| WorkspaceGitError::caused_by(source.to_string(), source))?;
    Ok(SourceGitFingerprint {
        value,
        semantic: semantic.semantic,
        common_dir_id,
        worktree_git_dir_id,
    })
}

async fn portable_git_semantic(local_cwd: &Path) -> Result<PortableGitSemantic, WorkspaceGitError> {
    let refs = list_refs_with(local_cwd, &[])
        .await?
        .into_iter()
        .filter(|reference| is_shippable_shared_ref(&reference.name))
        .map(|reference| {
            serde_json::json!([reference.name, reference.sha, reference.symbolic_target])
        })
        .collect::<Vec<_>>();
    let stash_path = git_path(local_cwd, "logs/refs/stash").await?;
    let stash = if stash_path.try_exists()? {
        fs::read(stash_path)?
    } else {
        Vec::new()
    };
    let config_raw = run_git_checked(
        &git_args(local_cwd, &["config", "--local", "--null", "--list"]),
        None,
        None,
    )
    .await?
    .stdout;
    let index = index_content(local_cwd, None, None, None).await?;
    let index_entries = index_semantic_digest(local_cwd, None, None, None).await?;
    let config_entries = parse_nul_config(&config_raw);
    let config = outbound_config(&config_entries);
    let semantic = serde_json::to_string(&serde_json::json!({
        "head": head_state(local_cwd, "beam up", None).await?.descriptor(),
        "indexTree": index.tree,
        "indexEntries": index_entries,
        "refs": refs,
        "stashLog": content_digest(&stash),
        "config": config,
    }))
    .map_err(|source| WorkspaceGitError::caused_by(source.to_string(), source))?;
    Ok(PortableGitSemantic {
        semantic,
        index_digest: index.digest,
        config_raw,
    })
}

async fn assert_no_sparse_layout(local_cwd: &Path, when: &str) -> Result<(), WorkspaceGitError> {
    let sparse = run_git(
        &git_args(
            local_cwd,
            &["config", "--get", "--type=bool", "core.sparseCheckout"],
        ),
        None,
        None,
    )
    .await?;
    if sparse.code == 0 && sparse.stdout.trim() == "true" {
        return Err(WorkspaceGitError::message(format!(
            "{when}: this linked worktree uses sparse-checkout, an unsupported layout beam cannot \
             ship faithfully — run `git sparse-checkout disable` in {} (or hand off a full \
             checkout) and retry",
            local_cwd.display()
        )));
    }
    let tags = run_git_checked(&git_args(local_cwd, &["ls-files", "-t", "-z"]), None, None).await?;
    if tags.stdout.split('\0').any(|entry| entry.starts_with("S ")) {
        return Err(WorkspaceGitError::message(format!(
            "{when}: this linked worktree has skip-worktree entries, an unsupported layout beam \
             cannot ship faithfully — clear them (git ls-files -t | grep '^S '; git update-index \
             --no-skip-worktree <paths>) and retry"
        )));
    }
    Ok(())
}

async fn assert_files_ref_storage(local_cwd: &Path, when: &str) -> Result<(), WorkspaceGitError> {
    let storage = run_git(
        &git_args(local_cwd, &["config", "--get", "extensions.refstorage"]),
        None,
        None,
    )
    .await?;
    let value = storage.stdout.trim();
    if storage.code == 0 && !value.is_empty() && value != "files" {
        return Err(WorkspaceGitError::message(format!(
            "{when}: this repository uses non-default ref storage (extensions.refstorage={value}) \
             — only the files ref storage backend is supported"
        )));
    }
    Ok(())
}

async fn assert_no_operation_in_progress(
    local_cwd: &Path,
    when: &str,
) -> Result<(), WorkspaceGitError> {
    for marker in OP_STATE_MARKERS {
        if git_path(local_cwd, marker).await?.try_exists()? {
            return Err(WorkspaceGitError::message(format!(
                "{when}: the local worktree has an in-progress git operation ({marker}) — finish \
                 or abort it locally, then retry {when}"
            )));
        }
    }
    Ok(())
}

async fn assert_no_history_boundary(local_cwd: &Path, when: &str) -> Result<(), WorkspaceGitError> {
    let shallow = git_path(local_cwd, "shallow").await?;
    let common = resolve_git_output(
        local_cwd,
        &run_git_checked(
            &git_args(local_cwd, &["rev-parse", "--git-common-dir"]),
            None,
            None,
        )
        .await?
        .stdout,
    );
    for path in [shallow, common.join("info/grafts")] {
        if path.try_exists()? {
            return Err(WorkspaceGitError::message(format!(
                "{when}: Git history boundary {} is unsupported — refusing a handoff that may \
                 omit parent objects",
                path.display()
            )));
        }
    }
    Ok(())
}

async fn head_state(
    local_cwd: &Path,
    when: &str,
    prefix: Option<&[OsString]>,
) -> Result<HeadState, WorkspaceGitError> {
    let base = prefix
        .map(<[OsString]>::to_vec)
        .unwrap_or_else(|| git_args(local_cwd, &[]));
    let symbolic = run_git(
        &extend_args(&base, &["symbolic-ref", "--quiet", "HEAD"]),
        None,
        None,
    )
    .await?;
    let commit = run_git(
        &extend_args(&base, &["rev-parse", "--verify", "--quiet", "HEAD"]),
        None,
        None,
    )
    .await?;
    let reference = (symbolic.code == 0).then(|| symbolic.stdout.trim().to_owned());
    let commit = (commit.code == 0).then(|| commit.stdout.trim().to_owned());
    match (reference, commit) {
        (Some(reference), Some(commit)) => Ok(HeadState::Attached { reference, commit }),
        (Some(reference), None) => Ok(HeadState::Unborn { reference }),
        (None, Some(commit)) => Ok(HeadState::Detached { commit }),
        (None, None) => Err(WorkspaceGitError::message(format!(
            "{when}: {} has neither a symbolic nor a resolvable HEAD",
            local_cwd.display()
        ))),
    }
}

async fn list_refs_with(
    local_cwd: &Path,
    patterns: &[&str],
) -> Result<Vec<SourceRef>, WorkspaceGitError> {
    let mut arguments = git_args(
        local_cwd,
        &[
            "for-each-ref",
            "--format=%(objectname)%00%(symref)%00%(refname)",
        ],
    );
    arguments.extend(patterns.iter().map(os));
    let output = run_git_checked(&arguments, None, None).await?.stdout;
    let mut refs = BTreeMap::new();
    for line in output.lines().filter(|line| !line.is_empty()) {
        let fields = line.split('\0').collect::<Vec<_>>();
        if fields.len() < 3 || fields[0].is_empty() || fields[2].is_empty() {
            continue;
        }
        refs.insert(
            fields[2].to_owned(),
            SourceRef {
                name: fields[2].to_owned(),
                sha: fields[0].to_owned(),
                symbolic_target: (!fields[1].is_empty()).then(|| fields[1].to_owned()),
            },
        );
    }
    for symbolic in list_loose_symbolic_refs(local_cwd, patterns).await? {
        refs.insert(symbolic.name.clone(), symbolic);
    }
    Ok(refs.into_values().collect())
}

async fn list_loose_symbolic_refs(
    local_cwd: &Path,
    patterns: &[&str],
) -> Result<Vec<SourceRef>, WorkspaceGitError> {
    let common = resolve_git_output(
        local_cwd,
        &run_git_checked(
            &git_args(
                local_cwd,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            ),
            None,
            None,
        )
        .await?
        .stdout,
    );
    let worktree = resolve_git_output(
        local_cwd,
        &run_git_checked(
            &git_args(local_cwd, &["rev-parse", "--absolute-git-dir"]),
            None,
            None,
        )
        .await?
        .stdout,
    );
    let object_format = run_git_checked(
        &git_args(local_cwd, &["rev-parse", "--show-object-format"]),
        None,
        None,
    )
    .await?
    .stdout
    .trim()
    .to_owned();
    let zero = match object_format.as_str() {
        "sha1" => "0".repeat(40),
        "sha256" => "0".repeat(64),
        unsupported => {
            return Err(WorkspaceGitError::message(format!(
                "beam: unsupported Git object format while reading symbolic refs: {unsupported}"
            )));
        }
    };
    let roots = BTreeSet::from([common.join("refs"), worktree.join("refs")]);
    let mut refs = BTreeMap::new();
    for root in &roots {
        if !root.try_exists()? {
            continue;
        }
        for (file, reference) in enumerate_loose_ref_files(root)? {
            let raw = fs::read_to_string(file)?;
            let Some(target) = raw.strip_prefix("ref: ").map(str::trim_end) else {
                continue;
            };
            if !target.starts_with("refs/") || target.contains(['\r', '\n']) {
                return Err(WorkspaceGitError::message(format!(
                    "beam: malformed loose symbolic ref: {reference}"
                )));
            }
            if !ref_matches_patterns(&reference, patterns) {
                continue;
            }
            for candidate in [&reference, target] {
                let result = run_git(
                    &git_args_owned(local_cwd, &["check-ref-format", candidate]),
                    None,
                    None,
                )
                .await?;
                if result.code != 0 {
                    return Err(WorkspaceGitError::message(format!(
                        "beam: invalid loose symbolic ref name or target: {reference}"
                    )));
                }
            }
            let resolved = run_git(
                &git_args_owned(local_cwd, &["rev-parse", "--verify", "--quiet", &reference]),
                None,
                None,
            )
            .await?;
            let sha = if valid_oid(resolved.stdout.trim()) {
                resolved.stdout.trim().to_owned()
            } else {
                zero.clone()
            };
            refs.insert(
                reference.clone(),
                SourceRef {
                    name: reference,
                    sha,
                    symbolic_target: Some(target.to_owned()),
                },
            );
        }
    }
    Ok(refs.into_values().collect())
}

fn enumerate_loose_ref_files(
    refs_root: &Path,
) -> Result<Vec<(PathBuf, String)>, WorkspaceGitError> {
    let mut stack = Vec::new();
    let mut names = directory_names(refs_root)?;
    names.sort();
    for name in names.into_iter().rev() {
        stack.push((refs_root.join(&name), vec![name]));
    }
    let mut files = Vec::new();
    let mut visited = 0_usize;
    while let Some((file, parts)) = stack.pop() {
        visited += 1;
        if visited > MAX_LOOSE_REF_ENTRIES {
            return Err(WorkspaceGitError::message(format!(
                "beam: the Git refs tree at {} exceeds {MAX_LOOSE_REF_ENTRIES} entries — refusing \
                 to enumerate it",
                refs_root.display()
            )));
        }
        let metadata = fs::symlink_metadata(&file)?;
        if metadata.file_type().is_dir() {
            let mut children = directory_names(&file)?;
            children.sort();
            for child in children.into_iter().rev() {
                let mut child_parts = parts.clone();
                child_parts.push(child.clone());
                stack.push((file.join(child), child_parts));
            }
        } else if metadata.file_type().is_file() {
            files.push((file, format!("refs/{}", parts.join("/"))));
        } else {
            return Err(WorkspaceGitError::message(format!(
                "beam: Git refs contain an unsupported filesystem entry: {}",
                file.display()
            )));
        }
    }
    Ok(files)
}

pub(crate) async fn git_path(local_cwd: &Path, name: &str) -> Result<PathBuf, WorkspaceGitError> {
    let output = run_git_checked(
        &git_args_owned(local_cwd, &["rev-parse", "--git-path", name]),
        None,
        None,
    )
    .await?
    .stdout;
    Ok(resolve_git_output(local_cwd, &output))
}

fn ensure_git_identity_token(directory: &Path, name: &str) -> Result<String, WorkspaceGitError> {
    let path = directory.join(name);
    let mut token = [0_u8; 32];
    getrandom::fill(&mut token)
        .map_err(|source| WorkspaceGitError::message(format!("getrandom failed: {source}")))?;
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(mut file) => writeln!(file, "{}", hex::encode(token))?,
        Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(source) => return Err(source.into()),
    }
    let value = read_git_identity_token(directory, name)?.unwrap_or_default();
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(WorkspaceGitError::message(format!(
            "beam up: {} is not a valid Beam repository identity marker",
            path.display()
        )));
    }
    Ok(value)
}

pub(crate) fn read_git_identity_token(
    directory: &Path,
    name: &str,
) -> Result<Option<String>, WorkspaceGitError> {
    let path = directory.join(name);
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return Ok(None);
    };
    if !metadata.file_type().is_file() {
        return Ok(None);
    }
    let value = fs::read_to_string(path)?.trim().to_owned();
    let valid = value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'));
    Ok(valid.then_some(value))
}

fn parse_nul_config(raw: &str) -> Vec<(String, String)> {
    raw.split('\0')
        .filter(|chunk| !chunk.is_empty())
        .map(|chunk| {
            chunk
                .split_once('\n')
                .map(|(key, value)| (key.to_owned(), value.to_owned()))
                .unwrap_or_else(|| (chunk.to_owned(), "true".to_owned()))
        })
        .collect()
}

fn outbound_config(entries: &[(String, String)]) -> Vec<(&str, &str)> {
    let mut remote_urls: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (key, value) in entries {
        if let Some(name) = remote_key_name(key, ".url") {
            remote_urls.entry(name).or_default().push(value);
        }
    }
    let unusable = remote_urls
        .into_iter()
        .filter(|(_, values)| values.iter().all(|value| unshippable_url(value)))
        .map(|(name, _)| name)
        .collect::<BTreeSet<_>>();
    entries
        .iter()
        .filter(|(key, value)| portable_config_entry(key, value, &unusable))
        .filter(|(key, _)| {
            !MACHINE_LAYOUT_CONFIG
                .iter()
                .any(|prefix| key.starts_with(prefix))
        })
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect()
}

fn portable_config_entry(key: &str, value: &str, unusable: &BTreeSet<&str>) -> bool {
    if secret_bearing_config(key) {
        return false;
    }
    if let Some(remote) = remote_any_key_name(key)
        && unusable.contains(remote)
    {
        return false;
    }
    let lower = key.to_ascii_lowercase();
    if (lower.starts_with("remote.") && (lower.ends_with(".url") || lower.ends_with(".pushurl")))
        || (lower.starts_with("submodule.") && lower.ends_with(".url"))
    {
        return !unshippable_url(value);
    }
    if let Some(base) = url_rewrite_base(key) {
        return !unshippable_url(base) && !unshippable_url(value);
    }
    true
}

fn secret_bearing_config(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    ["credential", "http", "https", "sendemail", "imap", "lfs"]
        .iter()
        .any(|prefix| lower == *prefix || lower.starts_with(&format!("{prefix}.")))
        || (lower.starts_with("remote.")
            && (lower.ends_with(".proxy") || lower.ends_with(".proxycommand")))
}

fn unshippable_url(value: &str) -> bool {
    local_filesystem_path(value) || remote_helper_url(value) || credential_bearing_url(value)
}

fn local_filesystem_path(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    if value.starts_with("file://") {
        return true;
    }
    if explicit_url(value) {
        return false;
    }
    if value.starts_with('~') || Path::new(value).is_absolute() {
        return true;
    }
    if let Some(colon) = value.find(':')
        && colon > 0
        && !value[..colon].contains('/')
    {
        return false;
    }
    true
}

fn credential_bearing_url(value: &str) -> bool {
    if !explicit_url(value) {
        return false;
    }
    let Some((scheme, rest)) = value.split_once("://") else {
        return true;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let userinfo = authority
        .rsplit_once('@')
        .map(|(userinfo, _)| userinfo)
        .unwrap_or("");
    if userinfo.contains(':') {
        return true;
    }
    if matches!(scheme, "http" | "https") && !userinfo.is_empty() {
        return true;
    }
    let query = value.split_once('?').map(|(_, query)| query).unwrap_or("");
    query
        .split('&')
        .filter_map(|field| field.split_once('=').map(|(key, _)| key).or(Some(field)))
        .any(|key| {
            let lower = key.to_ascii_lowercase();
            [
                "token",
                "auth",
                "credential",
                "key",
                "pass",
                "secret",
                "signature",
            ]
            .iter()
            .any(|needle| lower.contains(needle))
        })
}

fn explicit_url(value: &str) -> bool {
    let Some((scheme, _)) = value.split_once("://") else {
        return false;
    };
    !scheme.is_empty()
        && scheme.bytes().enumerate().all(|(index, byte)| {
            if index == 0 {
                byte.is_ascii_alphabetic()
            } else {
                byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-')
            }
        })
}

fn remote_helper_url(value: &str) -> bool {
    let Some((transport, _)) = value.split_once("::") else {
        return false;
    };
    !transport.is_empty()
        && transport.bytes().enumerate().all(|(index, byte)| {
            if index == 0 {
                byte.is_ascii_alphabetic()
            } else {
                byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-')
            }
        })
}

fn remote_key_name<'a>(key: &'a str, suffix: &str) -> Option<&'a str> {
    let remainder = key.strip_prefix("remote.")?.strip_suffix(suffix)?;
    (!remainder.is_empty()).then_some(remainder)
}

fn remote_any_key_name(key: &str) -> Option<&str> {
    let remainder = key.strip_prefix("remote.")?;
    let (name, _) = remainder.split_once('.')?;
    (!name.is_empty()).then_some(name)
}

fn url_rewrite_base(key: &str) -> Option<&str> {
    let lower = key.to_ascii_lowercase();
    let suffix = if lower.ends_with(".insteadof") {
        ".insteadof"
    } else if lower.ends_with(".pushinsteadof") {
        ".pushinsteadof"
    } else {
        return None;
    };
    let base_end = key.len() - suffix.len();
    key.get(4..base_end).filter(|base| !base.is_empty())
}

fn stash_stack(tip: &str, raw: Option<&[u8]>) -> Vec<String> {
    let text = raw
        .map(|bytes| {
            bytes
                .iter()
                .map(|byte| char::from(*byte))
                .collect::<String>()
        })
        .unwrap_or_default();
    let mut positions = text
        .lines()
        .filter_map(|line| {
            let fields = line.split(' ').collect::<Vec<_>>();
            (fields.len() >= 3 && valid_oid(fields[0]) && valid_oid(fields[1]))
                .then(|| fields[1].to_owned())
        })
        .collect::<Vec<_>>();
    positions.reverse();
    if positions.first().map(String::as_str) != Some(tip) {
        positions.insert(0, tip.to_owned());
    }
    positions
}

fn dangling_pointer_error(line: &str, dangling: &BTreeSet<&str>) -> bool {
    let Some(rest) = line.strip_prefix("error: ") else {
        return false;
    };
    let Some((reference, pointer)) = rest.split_once(": invalid ") else {
        return false;
    };
    let valid_suffix = pointer
        .strip_prefix("sha1 pointer ")
        .or_else(|| pointer.strip_prefix("sha256 pointer "))
        .is_some_and(|oid| !oid.is_empty() && oid.bytes().all(|byte| byte == b'0'));
    valid_suffix && dangling.contains(reference)
}

fn ref_matches_patterns(reference: &str, patterns: &[&str]) -> bool {
    patterns.is_empty()
        || patterns.iter().any(|pattern| {
            let base = pattern.trim_end_matches('/');
            reference == *pattern || reference.starts_with(&format!("{base}/"))
        })
}

fn valid_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn resolve_git_output(local_cwd: &Path, output: &str) -> PathBuf {
    let value = Path::new(output.trim());
    if value.is_absolute() {
        value.to_path_buf()
    } else {
        local_cwd.join(value)
    }
}

fn safe_realpath(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(path))
                .unwrap_or_else(|_| path.to_path_buf())
        }
    })
}

fn directory_names(directory: &Path) -> Result<Vec<String>, WorkspaceGitError> {
    Ok(fs::read_dir(directory)?
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
        .collect::<Result<Vec<_>, _>>()?)
}

fn git_args(local_cwd: &Path, arguments: &[&str]) -> Vec<OsString> {
    let mut argv = vec![os("git"), os("-C"), local_cwd.as_os_str().to_owned()];
    argv.extend(arguments.iter().map(os));
    argv
}

fn git_args_owned(local_cwd: &Path, arguments: &[&str]) -> Vec<OsString> {
    git_args(local_cwd, arguments)
}

fn extend_args(prefix: &[OsString], arguments: &[&str]) -> Vec<OsString> {
    let mut argv = prefix.to_vec();
    argv.extend(arguments.iter().map(os));
    argv
}
