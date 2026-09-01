use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use crate::transport::{OwnedWorkspace, SyncOptions, Transport};
use crate::util::digest::{MAX_TREE_DEPTH, file_sha256};
use crate::util::shell::RunInput;
use crate::util::shell::shq;
use crate::workspace::workspace_owner_content;

use super::materialize::{git_path, read_git_identity_token};
use super::remote::{RemoteGitPointerKind, remote_git_pointer_state, remote_git_tree_fingerprint};
use super::tree::{GitTreeFingerprint, collected_git_tree_fingerprint};
use super::{
    GitDirIdentity, REPOSITORY_ID_FILE, ReturnValueKind, SHIPPED_REFS_FILE, SHIPPED_STASH_LOG_FILE,
    WORKTREE_ID_FILE, WorkspaceGitError, WtGitShipInfo, content_digest, dir_identity,
    git_payload_path, is_git_worktree, os, path_text, return_qbase, return_value_ref_at_base,
    run_git, run_git_checked, run_git_checked_with_input, worktree_git_return_key,
};

const MAX_REFLOG_ENUMERATED_FILES: usize = 65_536;
const MAX_REFLOG_FILES: usize = 4_096;
const MAX_REFLOG_TOTAL_BYTES: usize = 32 * 1024 * 1024;
const MAX_REFLOG_TOTAL_LINES: usize = 100_000;
const MAX_REFLOG_UNIQUE_OIDS: usize = 200_000;
const MAX_DANGLING_OBJECTS: usize = 200_000;
const MAX_STASH_REFLOG_LINES: usize = 4_096;
const OP_STATE_FILES: [&str; 20] = [
    "MERGE_HEAD",
    "MERGE_AUTOSTASH",
    "MERGE_MSG",
    "MERGE_MODE",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "ORIG_HEAD",
    "AUTO_MERGE",
    "REBASE_HEAD",
    "SQUASH_MSG",
    "BISECT_HEAD",
    "BISECT_LOG",
    "BISECT_START",
    "BISECT_EXPECTED_REV",
    "BISECT_NAMES",
    "BISECT_TERMS",
    "BISECT_RUN",
    "BISECT_FIRST_PARENT",
    "BISECT_ANCESTORS_OK",
    "sequencer",
];
const OP_STATE_DIRS: [&str; 3] = ["rebase-merge", "rebase-apply", "sequencer"];

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct IndexContent {
    pub tree: Option<String>,
    pub digest: String,
}

#[derive(Clone)]
struct SourceRef {
    name: String,
    sha: String,
    symbolic_target: Option<String>,
}

#[derive(Clone)]
struct ShippedRef {
    sha: String,
    symbolic_target: Option<String>,
}

struct CapturedReflog {
    source_ref: String,
    file: PathBuf,
    raw: Vec<u8>,
    publish_raw: bool,
}

struct CapturedReflogs {
    reflogs: Vec<CapturedReflog>,
    oids: BTreeSet<String>,
}

struct ValidatedCollection {
    captured_reflogs: CapturedReflogs,
    unreachable_objects: BTreeSet<String>,
    shipped: BTreeMap<String, ShippedRef>,
    shipped_stash_log: Vec<u8>,
    remote_refs: Vec<SourceRef>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct WorktreeGitReturn {
    pub qbase: String,
    pub quarantined: Vec<String>,
    pub notes: Vec<String>,
}

pub struct WorktreeGitReturnRecord<'a> {
    pub id: &'a str,
    pub local_cwd: &'a Path,
    pub remote_cwd: &'a str,
    pub wt_git: Option<&'a WtGitShipInfo>,
    pub workspace_token: Option<&'a str>,
}

pub struct CollectedWorktreeGitReturn<'a> {
    transport: &'a dyn Transport,
    temporary: tempfile::TempDir,
    collected: PathBuf,
    record_id: String,
    local_cwd: PathBuf,
    remote_cwd: String,
    ship_info: WtGitShipInfo,
    owner: String,
    payload_relative: String,
    pre_collect: GitTreeFingerprint,
    validated: ValidatedCollection,
}

impl CollectedWorktreeGitReturn<'_> {
    pub fn temp_root(&self) -> &Path {
        self.temporary.path()
    }

    pub async fn assert_local_prepared(&self) -> Result<(), WorkspaceGitError> {
        assert_worktree_identity(&self.local_cwd, Some(&self.ship_info)).await?;
        let bound = BoundReturnRepo::bind(&self.local_cwd, Some(&self.ship_info)).await?;
        bound.restore()
    }

    pub fn apply(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<WorktreeGitReturn, WorkspaceGitError>> + '_>> {
        // Return publication carries bounded reflog and ref batches. Heap the
        // state machine instead of consuming a caller's worker-thread stack.
        Box::pin(apply_collected_worktree_git(self))
    }

    pub async fn assert_remote_git_unchanged(
        &self,
        when: Option<&str>,
    ) -> Result<(), WorkspaceGitError> {
        assert_remote_git_still_collected(self, when).await
    }

    pub fn dispose(self) -> Result<(), WorkspaceGitError> {
        self.temporary.close().map_err(WorkspaceGitError::from)
    }
}

pub async fn prepare_worktree_git_return(
    local_cwd: &Path,
    _record_id: &str,
    ship_info: Option<&WtGitShipInfo>,
) -> Result<(), WorkspaceGitError> {
    assert_worktree_identity(local_cwd, ship_info).await
}

pub fn collect_worktree_git_return<'a>(
    transport: &'a dyn Transport,
    record: WorktreeGitReturnRecord<'a>,
) -> Pin<Box<dyn Future<Output = Result<CollectedWorktreeGitReturn<'a>, WorkspaceGitError>> + 'a>> {
    // Collection validates a complete quarantine before exposing it. Keep
    // that large state machine on the heap.
    Box::pin(collect_worktree_git_return_boxed(transport, record))
}

async fn collect_worktree_git_return_boxed<'a>(
    transport: &'a dyn Transport,
    record: WorktreeGitReturnRecord<'a>,
) -> Result<CollectedWorktreeGitReturn<'a>, WorkspaceGitError> {
    let ship_info = record.wt_git.cloned().ok_or_else(|| {
        WorkspaceGitError::message(format!(
            "beam: handoff {} has no valid Git payload generation on record — refusing to key its \
             return",
            record.id
        ))
    })?;
    let _return_key = worktree_git_return_key(record.id, Some(&ship_info))?;
    let payload_relative = git_payload_path(&ship_info.generation)?;
    let owner = record.workspace_token.ok_or_else(|| {
        WorkspaceGitError::message(format!(
            "beam down: handoff {} has no workspace ownership token on record — it cannot prove \
             the remote Git state is its own; retire it with beam kill {} --purge",
            record.id, record.id
        ))
    })?;
    let owner = workspace_owner_content(record.id, owner)?;
    let pre_collect = assert_collection_source_bound(
        transport,
        record.id,
        record.remote_cwd,
        &ship_info.generation,
        &payload_relative,
        &owner,
    )
    .await?;
    let temporary = tempfile::Builder::new().prefix("beam-wtret-").tempdir()?;
    let collected = temporary.path().join("collected.git");
    let remote_git = format!("{}/{}", record.remote_cwd, payload_relative);
    let collect_result = async {
        transport
            .sync_down(
                &remote_git,
                &collected,
                SyncOptions {
                    owned: Some(OwnedWorkspace {
                        root: record.remote_cwd,
                        owner_bytes: &owner,
                    }),
                    ..SyncOptions::default()
                },
            )
            .await?;
        assert_stable_collected_snapshot(
            transport,
            record.remote_cwd,
            &payload_relative,
            &ship_info.generation,
            &owner,
            &pre_collect,
            &collected,
        )
        .await?;
        validate_collected_git_return(
            &collected,
            record.local_cwd,
            temporary.path(),
            Some(&ship_info),
        )
        .await
    }
    .await;
    let validated = match collect_result {
        Ok(validated) => validated,
        Err(error) => {
            drop(temporary);
            return Err(error);
        }
    };
    Ok(CollectedWorktreeGitReturn {
        transport,
        temporary,
        collected,
        record_id: record.id.to_owned(),
        local_cwd: record.local_cwd.to_path_buf(),
        remote_cwd: record.remote_cwd.to_owned(),
        ship_info,
        owner,
        payload_relative,
        pre_collect,
        validated,
    })
}

pub fn import_worktree_git_return<'a>(
    transport: &'a dyn Transport,
    record: WorktreeGitReturnRecord<'a>,
) -> Pin<Box<dyn Future<Output = Result<WorktreeGitReturn, WorkspaceGitError>> + 'a>> {
    Box::pin(import_worktree_git_return_boxed(transport, record))
}

async fn import_worktree_git_return_boxed(
    transport: &dyn Transport,
    record: WorktreeGitReturnRecord<'_>,
) -> Result<WorktreeGitReturn, WorkspaceGitError> {
    let collected = collect_worktree_git_return(transport, record).await?;
    let result = async {
        let returned = collected.apply().await?;
        collected.assert_remote_git_unchanged(None).await?;
        Ok(returned)
    }
    .await;
    let dispose = collected.dispose();
    match (result, dispose) {
        (Ok(returned), Ok(())) => Ok(returned),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

pub fn import_objects(collected_git: &Path, common_dir: &Path) -> Result<(), WorkspaceGitError> {
    let source = collected_git.join("objects");
    let destination = common_dir.join("objects");
    for entry in fs::read_dir(&source)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let valid_name = name.len() == 2
            && name
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'));
        if !entry.file_type()?.is_dir() || !valid_name {
            continue;
        }
        for file in fs::read_dir(entry.path())? {
            let file = file?;
            let target = destination.join(&name).join(file.file_name());
            if target.try_exists()? {
                continue;
            }
            atomic_copy(&file.path(), &target)?;
        }
    }
    let pack = source.join("pack");
    if !pack.try_exists()? {
        return Ok(());
    }
    let files = fs::read_dir(&pack)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<Result<Vec<_>, _>>()?;
    for extension in [".pack", ".rev", ".idx"] {
        for file in files
            .iter()
            .filter(|file| file.to_string_lossy().ends_with(extension))
        {
            let target = destination.join("pack").join(file);
            if !target.try_exists()? {
                atomic_copy(&pack.join(file), &target)?;
            }
        }
    }
    Ok(())
}

pub fn assert_no_collected_git_locks(collected_git: &Path) -> Result<(), WorkspaceGitError> {
    super::tree::assert_no_collected_git_locks(collected_git)
}

pub(crate) async fn index_content(
    local_cwd: &Path,
    index_file: Option<&Path>,
    git_prefix: Option<&[OsString]>,
    git_cwd: Option<&Path>,
) -> Result<IndexContent, WorkspaceGitError> {
    let resolved = match index_file {
        Some(index) => index.to_path_buf(),
        None => git_path(local_cwd, "index").await?,
    };
    let environment = BTreeMap::from([(
        "GIT_INDEX_FILE".to_owned(),
        path_text(&resolved)?.to_owned(),
    )]);
    let prefix = git_prefix
        .map(<[OsString]>::to_vec)
        .unwrap_or_else(|| git_args(local_cwd, &[]));
    let tree = run_git(
        &extend_args(&prefix, &["write-tree"]),
        git_cwd,
        Some(&environment),
    )
    .await?;
    let bytes = if resolved.try_exists()? {
        fs::read(&resolved)?
    } else {
        Vec::new()
    };
    Ok(IndexContent {
        tree: (tree.code == 0).then(|| tree.stdout.trim().to_owned()),
        digest: content_digest(&bytes),
    })
}

pub(crate) async fn index_semantic_digest(
    local_cwd: &Path,
    index_file: Option<&Path>,
    git_prefix: Option<&[OsString]>,
    git_cwd: Option<&Path>,
) -> Result<String, WorkspaceGitError> {
    let resolved = match index_file {
        Some(index) => index.to_path_buf(),
        None => git_path(local_cwd, "index").await?,
    };
    let environment = BTreeMap::from([(
        "GIT_INDEX_FILE".to_owned(),
        path_text(&resolved)?.to_owned(),
    )]);
    let prefix = git_prefix
        .map(<[OsString]>::to_vec)
        .unwrap_or_else(|| git_args(local_cwd, &[]));
    let empty_tree = run_git_checked_with_input(
        &extend_args(&prefix, &["hash-object", "-t", "tree", "--stdin"]),
        git_cwd,
        None,
        RunInput::Text(""),
    )
    .await?
    .stdout
    .trim()
    .to_owned();
    let commands = [
        vec!["ls-files", "--stage", "-z"],
        vec!["ls-files", "-v", "-z"],
        vec!["ls-files", "--resolve-undo", "-z"],
        vec![
            "diff",
            "--cached",
            "--raw",
            "-z",
            "--no-ext-diff",
            "--ita-invisible-in-index",
            empty_tree.as_str(),
        ],
    ];
    let mut composite = Vec::new();
    for command in commands {
        let output = run_git_checked(&extend_args(&prefix, &command), git_cwd, Some(&environment))
            .await?
            .stdout;
        composite.extend_from_slice(output.as_bytes());
        composite.extend_from_slice(b"\0beam-index-view\0");
    }
    composite.truncate(composite.len().saturating_sub(b"\0beam-index-view\0".len()));
    Ok(content_digest(&composite))
}

async fn assert_worktree_identity(
    local_cwd: &Path,
    ship_info: Option<&WtGitShipInfo>,
) -> Result<(), WorkspaceGitError> {
    if !is_git_worktree(local_cwd) {
        return Err(WorkspaceGitError::message(format!(
            "beam down: {} is no longer the Git worktree this handoff shipped — restore the \
             checkout, or abandon the handoff with beam kill --purge",
            local_cwd.display()
        )));
    }
    let ship = complete_ship_identity(local_cwd, ship_info)?;
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
    if safe_realpath(Path::new(&ship.common_dir)) != safe_realpath(&common) {
        return Err(WorkspaceGitError::message(format!(
            "beam down: this worktree's common git dir changed since the ship ({} -> {}) — \
             refusing to import remote git state into a different repository",
            ship.common_dir,
            common.display()
        )));
    }
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
    assert_identity_pin(
        local_cwd,
        "common git dir",
        &common,
        ship.common_dir_id,
        REPOSITORY_ID_FILE,
        ship.common_dir_token,
    )?;
    assert_identity_pin(
        local_cwd,
        "worktree git dir",
        &worktree,
        ship.worktree_git_dir_id,
        WORKTREE_ID_FILE,
        ship.worktree_git_dir_token,
    )?;
    assert_no_sparse_layout(local_cwd, "beam down").await?;
    assert_files_ref_storage(local_cwd, "beam down").await
}

struct CompleteShipIdentity<'a> {
    common_dir: &'a str,
    common_dir_id: &'a GitDirIdentity,
    worktree_git_dir_id: &'a GitDirIdentity,
    common_dir_token: &'a str,
    worktree_git_dir_token: &'a str,
}

fn complete_ship_identity<'a>(
    local_cwd: &Path,
    ship_info: Option<&'a WtGitShipInfo>,
) -> Result<CompleteShipIdentity<'a>, WorkspaceGitError> {
    let Some(ship) = ship_info else {
        return Err(legacy_identity_error(local_cwd));
    };
    let (Some(_), Some(common_id), Some(worktree_id), Some(common_token), Some(worktree_token)) = (
        ship.worktree_git_dir.as_deref(),
        ship.common_dir_id.as_ref(),
        ship.worktree_git_dir_id.as_ref(),
        ship.common_dir_token.as_deref(),
        ship.worktree_git_dir_token.as_deref(),
    ) else {
        return Err(legacy_identity_error(local_cwd));
    };
    Ok(CompleteShipIdentity {
        common_dir: &ship.common_dir,
        common_dir_id: common_id,
        worktree_git_dir_id: worktree_id,
        common_dir_token: common_token,
        worktree_git_dir_token: worktree_token,
    })
}

fn legacy_identity_error(local_cwd: &Path) -> WorkspaceGitError {
    WorkspaceGitError::message(format!(
        "beam down: this handoff record carries no ship-time repository identity for {} (it was \
         shipped by an older beam) — cannot prove the checkout is still the repository that \
         shipped; refusing to import remote git state",
        local_cwd.display()
    ))
}

fn assert_identity_pin(
    local_cwd: &Path,
    what: &str,
    directory: &Path,
    shipped_id: &GitDirIdentity,
    marker: &str,
    shipped_token: &str,
) -> Result<(), WorkspaceGitError> {
    let current = dir_identity(directory)?;
    let token = read_git_identity_token(directory, marker)?;
    if current != *shipped_id || token.as_deref() != Some(shipped_token) {
        return Err(WorkspaceGitError::message(format!(
            "beam down: the {what} of {} ({}) is not the directory this handoff shipped from — \
             it was replaced since the ship; refusing to import remote git state into a \
             different repository",
            local_cwd.display(),
            directory.display()
        )));
    }
    Ok(())
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
    let result = run_git(
        &git_args(local_cwd, &["config", "--get", "extensions.refstorage"]),
        None,
        None,
    )
    .await?;
    let value = result.stdout.trim();
    if result.code == 0 && !value.is_empty() && value != "files" {
        return Err(WorkspaceGitError::message(format!(
            "{when}: this repository uses non-default ref storage (extensions.refstorage={value}) \
             — only the files ref storage backend is supported"
        )));
    }
    Ok(())
}

fn atomic_copy(source: &Path, destination: &Path) -> Result<(), WorkspaceGitError> {
    let parent = destination.parent().ok_or_else(|| {
        WorkspaceGitError::message("beam down: object destination has no parent".to_owned())
    })?;
    fs::create_dir_all(parent)?;
    let mut random = [0_u8; 8];
    getrandom::fill(&mut random)
        .map_err(|source| WorkspaceGitError::message(format!("getrandom failed: {source}")))?;
    let temporary = PathBuf::from(format!(
        "{}.beam-tmp-{}",
        path_text(destination)?,
        hex::encode(random)
    ));
    let result = (|| {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        fs::copy(source, &temporary)?;
        File::open(&temporary)?.sync_all()?;
        let source_digest = file_sha256(source)?;
        if file_sha256(&temporary)? != source_digest {
            return Err(WorkspaceGitError::message(format!(
                "beam down: the staged copy of {} does not match its source — refusing to publish \
                 it",
                source.display()
            )));
        }
        match fs::hard_link(&temporary, destination) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if file_sha256(destination)? != source_digest {
                    return Err(WorkspaceGitError::message(format!(
                        "beam down: {} already exists with different content — refusing to \
                         overwrite it; verify the repository (git fsck), remove or repair the \
                         entry, then retry beam down",
                        destination.display()
                    )));
                }
                Ok(())
            }
            Err(error) => Err(error.into()),
        }
    })();
    drop(fs::remove_file(temporary));
    result
}

async fn assert_collection_source_bound(
    transport: &dyn Transport,
    id: &str,
    remote_cwd: &str,
    generation: &str,
    payload_relative: &str,
    owner: &str,
) -> Result<GitTreeFingerprint, WorkspaceGitError> {
    let pointer = remote_git_pointer_state(transport, remote_cwd, generation, Some(owner)).await?;
    if pointer.git != RemoteGitPointerKind::Ours || !pointer.payload_present {
        let state = match pointer.git {
            RemoteGitPointerKind::Absent => "missing",
            RemoteGitPointerKind::Ours | RemoteGitPointerKind::Foreign => {
                "not this handoff's published pointer"
            }
        };
        let payload = if pointer.payload_present {
            ""
        } else {
            " and its Git payload is gone"
        };
        return Err(WorkspaceGitError::message(format!(
            "beam down: the remote .git of handoff {id} is {state}{payload} — the remote Git state \
             cannot be proven to be this ship's; refusing to collect it (the remote is untouched)"
        )));
    }
    remote_git_tree_fingerprint(transport, remote_cwd, payload_relative, Some(owner)).await
}

async fn assert_stable_collected_snapshot(
    transport: &dyn Transport,
    remote_cwd: &str,
    payload_relative: &str,
    generation: &str,
    owner: &str,
    before: &GitTreeFingerprint,
    collected: &Path,
) -> Result<(), WorkspaceGitError> {
    let after =
        remote_git_tree_fingerprint(transport, remote_cwd, payload_relative, Some(owner)).await?;
    let pointer = remote_git_pointer_state(transport, remote_cwd, generation, None).await?;
    if pointer.git != RemoteGitPointerKind::Ours || !pointer.payload_present {
        return Err(WorkspaceGitError::message(format!(
            "beam down: the remote .git pointer changed while its repository was being collected \
             (pointer {}, payload {}) — refusing to import a snapshot no longer bound to this \
             handoff; the remote is intact",
            pointer_kind(pointer.git),
            if pointer.payload_present {
                "present"
            } else {
                "missing"
            }
        )));
    }
    if after != *before {
        return Err(WorkspaceGitError::message(format!(
            "beam down: the remote Git repository changed while it was being collected \
             (fingerprint {} -> {}) — a background process is still writing to it. Refusing to \
             import a torn snapshot; the remote is intact. Stop the remote writer and retry beam \
             down",
            short(&before.digest),
            short(&after.digest)
        )));
    }
    assert_no_collected_git_locks(collected)?;
    let local = collected_git_tree_fingerprint(collected)?;
    if local != *before {
        return Err(WorkspaceGitError::message(format!(
            "beam down: the collected Git quarantine does not match the proven remote snapshot \
             (fingerprint {} != {}) — refusing to import bytes that never existed as one remote \
             state; the remote is intact. Retry beam down",
            short(&local.digest),
            short(&before.digest)
        )));
    }
    Ok(())
}

async fn validate_collected_git_return(
    collected: &Path,
    local_cwd: &Path,
    temporary_root: &Path,
    ship_info: Option<&WtGitShipInfo>,
) -> Result<ValidatedCollection, WorkspaceGitError> {
    neutralize_collected_git_dir(collected, local_cwd).await?;
    let unreachable_objects = fsck_collected_git(collected, temporary_root).await?;
    assert_no_sparse_collected_index(collected, local_cwd).await?;
    run_git_checked(
        &collected_git_args(
            collected,
            &[
                "--work-tree",
                path_text(local_cwd)?,
                "status",
                "--porcelain=v1",
                "--ignore-submodules=all",
                "--untracked-files=no",
            ],
        ),
        None,
        None,
    )
    .await?;
    let captured_reflogs = capture_remote_reflogs(collected).await?;
    let expected = ship_info
        .and_then(|info| info.shipped_refs_digest.as_deref())
        .ok_or_else(|| {
            WorkspaceGitError::message(
                "beam down: this handoff record has no pinned ship-time ref snapshot".to_owned(),
            )
        })?;
    let shipped = read_shipped_refs(collected, expected)?;
    let stash_file = collected.join(SHIPPED_STASH_LOG_FILE);
    let shipped_stash_log = if stash_file.try_exists()? {
        fs::read(stash_file)?
    } else {
        Vec::new()
    };
    let stash_digest = ship_info.and_then(|info| info.shipped_stash_log_digest.as_deref());
    if stash_digest != Some(content_digest(&shipped_stash_log).as_str()) {
        return Err(WorkspaceGitError::message(
            "beam down: the pinned ship-time stash reflog snapshot is missing or changed — \
             refusing"
                .to_owned(),
        ));
    }
    let remote_refs = list_collected_refs(collected).await?;
    Ok(ValidatedCollection {
        captured_reflogs,
        unreachable_objects,
        shipped,
        shipped_stash_log,
        remote_refs,
    })
}

async fn neutralize_collected_git_dir(
    collected: &Path,
    local_cwd: &Path,
) -> Result<(), WorkspaceGitError> {
    assert_inert_git_tree(collected)?;
    for path in [collected.join("shallow"), collected.join("info/grafts")] {
        if path.try_exists()? {
            return Err(WorkspaceGitError::message(format!(
                "beam down: collected Git metadata contains an unsupported history boundary: {}",
                path.display()
            )));
        }
    }
    let object_format = run_git_checked(
        &git_args(local_cwd, &["rev-parse", "--show-object-format"]),
        None,
        None,
    )
    .await?
    .stdout
    .trim()
    .to_owned();
    if !matches!(object_format.as_str(), "sha1" | "sha256") {
        return Err(WorkspaceGitError::message(format!(
            "beam down: unsupported local Git object format: {object_format}"
        )));
    }
    assert_supported_collected_repo_format(collected, &object_format).await?;
    for path in [
        collected.join("config"),
        collected.join("config.worktree"),
        collected.join("commondir"),
        collected.join("hooks"),
        collected.join("worktrees"),
        collected.join("objects/info/alternates"),
        collected.join("objects/info/http-alternates"),
    ] {
        remove_any(&path)?;
    }
    let extension = if object_format == "sha256" {
        "[extensions]\n\tobjectformat = sha256\n"
    } else {
        ""
    };
    let version = if object_format == "sha256" { "1" } else { "0" };
    fs::write(
        collected.join("config"),
        format!(
            "[core]\n\trepositoryformatversion = {version}\n\tbare = true\n\tfsmonitor = \
             false\n{extension}"
        ),
    )?;
    Ok(())
}

fn assert_inert_git_tree(directory: &Path) -> Result<(), WorkspaceGitError> {
    let mut stack = vec![(
        directory.to_path_buf(),
        directory_names(directory)?,
        0_usize,
    )];
    while let Some((current, names, next)) = stack.last_mut() {
        if *next >= names.len() {
            stack.pop();
            continue;
        }
        let path = current.join(&names[*next]);
        *next += 1;
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink()
            || (!metadata.file_type().is_dir() && !metadata.file_type().is_file())
        {
            return Err(WorkspaceGitError::message(format!(
                "beam down: collected Git metadata contains an unsafe filesystem entry: {}",
                path.display()
            )));
        }
        if metadata.file_type().is_dir() {
            if stack.len() >= MAX_TREE_DEPTH {
                return Err(WorkspaceGitError::message(format!(
                    "beam down: collected Git metadata nests deeper than {MAX_TREE_DEPTH} \
                     directories at {} — refusing",
                    path.display()
                )));
            }
            stack.push((path.clone(), directory_names(&path)?, 0));
        }
    }
    Ok(())
}

async fn assert_supported_collected_repo_format(
    collected: &Path,
    local_format: &str,
) -> Result<(), WorkspaceGitError> {
    if collected.join("reftable").try_exists()? {
        return Err(collected_format_error(
            collected,
            &format!(
                "carries a reftable ref database ({})",
                collected.join("reftable").display()
            ),
            local_format,
        ));
    }
    for name in ["refs", "refs/heads"] {
        let path = collected.join(name);
        if path.try_exists()? && !fs::symlink_metadata(&path)?.file_type().is_dir() {
            return Err(collected_format_error(
                collected,
                &format!(
                    "replaces \"{name}\" with a non-directory — the reftable-format stub of a \
                     migrated ref database"
                ),
                local_format,
            ));
        }
    }
    let config = collected.join("config");
    let entries = if config.try_exists()? {
        parse_nul_config(
            &run_git_checked(
                &[
                    os("git"),
                    os("config"),
                    os("--no-includes"),
                    os("--file"),
                    config.as_os_str().to_owned(),
                    os("--null"),
                    os("--list"),
                ],
                None,
                None,
            )
            .await?
            .stdout,
        )
    } else {
        Vec::new()
    };
    let mut object_format = "sha1";
    for (key, value) in &entries {
        if key == "core.repositoryformatversion" && !matches!(value.trim(), "0" | "1") {
            return Err(collected_format_error(
                collected,
                &format!(
                    "declares an unsupported repository format version ({})",
                    if value.trim().is_empty() {
                        "<empty>"
                    } else {
                        value.trim()
                    }
                ),
                local_format,
            ));
        }
        let Some(extension) = key.strip_prefix("extensions.") else {
            continue;
        };
        if !matches!(extension, "objectformat" | "refstorage" | "worktreeconfig") {
            return Err(collected_format_error(
                collected,
                &format!("enables a repository extension beam cannot parse ({key})"),
                local_format,
            ));
        }
        if extension == "refstorage" && value != "files" {
            return Err(collected_format_error(
                collected,
                &format!(
                    "uses \"{}\" ref storage (extensions.refStorage) instead of the files \
                     backend",
                    if value.is_empty() { "<empty>" } else { value }
                ),
                local_format,
            ));
        }
        if extension == "objectformat" {
            if !matches!(value.as_str(), "sha1" | "sha256") {
                return Err(collected_format_error(
                    collected,
                    &format!(
                        "declares an unknown object format ({})",
                        if value.is_empty() { "<empty>" } else { value }
                    ),
                    local_format,
                ));
            }
            object_format = value;
        }
    }
    if object_format != local_format {
        return Err(collected_format_error(
            collected,
            &format!(
                "stores {object_format} objects while the local repository stores {local_format}"
            ),
            local_format,
        ));
    }
    Ok(())
}

fn collected_format_error(_collected: &Path, why: &str, format: &str) -> WorkspaceGitError {
    WorkspaceGitError::message(format!(
        "beam down: the collected Git repository {why} — beam can only return the files ref \
         backend with a full {format} object store; refusing before any local change (the remote \
         is intact)"
    ))
}

async fn assert_no_sparse_collected_index(
    collected: &Path,
    local_cwd: &Path,
) -> Result<(), WorkspaceGitError> {
    let index = collected.join("index");
    if !index.try_exists()? {
        return Ok(());
    }
    let environment =
        BTreeMap::from([("GIT_INDEX_FILE".to_owned(), path_text(&index)?.to_owned())]);
    let output = run_git_checked(
        &collected_git_args(
            collected,
            &["--work-tree", path_text(local_cwd)?, "ls-files", "-t", "-z"],
        ),
        None,
        Some(&environment),
    )
    .await?
    .stdout;
    for entry in output.split('\0').filter(|entry| !entry.is_empty()) {
        let tag = entry.get(..2).unwrap_or("");
        if tag == "S " {
            return Err(WorkspaceGitError::message(format!(
                "beam down: the collected Git index marks \"{}\" skip-worktree (sparse checkout) \
                 — installing it would silently hide files in the returned checkout; sparse \
                 layouts do not round-trip (run `git sparse-checkout disable` or `git update-index \
                 --no-skip-worktree` on the target, then retry)",
                entry.get(2..).unwrap_or("")
            )));
        }
        if !matches!(tag, "H " | "M ") {
            return Err(WorkspaceGitError::message(format!(
                "beam down: the collected Git index contains an entry beam cannot classify \
                 ({entry:?}) — refusing"
            )));
        }
    }
    Ok(())
}

async fn fsck_collected_git(
    collected: &Path,
    temporary_root: &Path,
) -> Result<BTreeSet<String>, WorkspaceGitError> {
    let dangling = dangling_symbolic_ref_files(collected).await?;
    let mut parked = Vec::new();
    for (source, reference) in dangling {
        let target = temporary_root
            .join("dangling-symrefs")
            .join(reference.split('/').collect::<PathBuf>());
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&source, &target)?;
        parked.push((source, target));
    }
    let result = run_git_checked(
        &collected_git_args(
            collected,
            &[
                "--no-replace-objects",
                "fsck",
                "--cache",
                "--no-dangling",
                "--unreachable",
            ],
        ),
        None,
        None,
    )
    .await;
    for (source, target) in parked.into_iter().rev() {
        if let Some(parent) = source.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(target, source)?;
    }
    let output = result?;
    let mut unreachable = BTreeSet::new();
    for line in output
        .stdout
        .lines()
        .filter(|line| line.starts_with("unreachable "))
    {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 3 || !valid_oid(fields[2]) {
            return Err(WorkspaceGitError::message(format!(
                "beam down: unparseable fsck unreachable-object report ({line}) — refusing"
            )));
        }
        unreachable.insert(fields[2].to_owned());
        if unreachable.len() > MAX_DANGLING_OBJECTS {
            return Err(oversized_collection_error(
                &format!(
                    "the collected remote Git state carries more than {MAX_DANGLING_OBJECTS} \
                     unreferenced objects"
                ),
                "history",
            ));
        }
    }
    Ok(unreachable)
}

async fn dangling_symbolic_ref_files(
    collected: &Path,
) -> Result<Vec<(PathBuf, String)>, WorkspaceGitError> {
    let refs = collected.join("refs");
    if !refs.try_exists()? {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for (file, reference) in walk_regular_files(&refs, "refs")? {
        let raw = fs::read_to_string(&file)?;
        if !raw.starts_with("ref: ") {
            continue;
        }
        let probe = run_git(
            &collected_git_args(collected, &["rev-parse", "--verify", "--quiet", &reference]),
            None,
            None,
        )
        .await?;
        if probe.code != 0 {
            result.push((file, reference));
        }
    }
    Ok(result)
}

async fn capture_remote_reflogs(collected: &Path) -> Result<CapturedReflogs, WorkspaceGitError> {
    let object_format = run_git_checked(
        &collected_git_args(collected, &["rev-parse", "--show-object-format"]),
        None,
        None,
    )
    .await?
    .stdout
    .trim()
    .to_owned();
    let oid_length = match object_format.as_str() {
        "sha1" => 40,
        "sha256" => 64,
        unsupported => {
            return Err(WorkspaceGitError::message(format!(
                "beam down: unsupported collected Git object format: {unsupported}"
            )));
        }
    };
    let captured = validate_collected_reflogs(collected, oid_length)?;
    if !captured.oids.is_empty() {
        let input = format!(
            "{}\n",
            captured.oids.iter().cloned().collect::<Vec<_>>().join("\n")
        );
        let output = run_git_checked_with_input(
            &collected_git_args(
                collected,
                &["--no-replace-objects", "cat-file", "--batch-check"],
            ),
            None,
            None,
            RunInput::Text(&input),
        )
        .await?
        .stdout;
        for line in output.lines().filter(|line| !line.is_empty()) {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            let valid = fields.len() == 3
                && valid_oid(fields[0])
                && fields[1].bytes().all(|byte| byte.is_ascii_lowercase())
                && fields[2].bytes().all(|byte| byte.is_ascii_digit());
            if !valid {
                return Err(WorkspaceGitError::message(format!(
                    "beam down: a remote reflog references an object absent from the collected \
                     store ({}) — refusing to import; the remote is untouched",
                    fields.first().copied().unwrap_or("")
                )));
            }
        }
    }
    Ok(captured)
}

fn validate_collected_reflogs(
    collected: &Path,
    oid_length: usize,
) -> Result<CapturedReflogs, WorkspaceGitError> {
    let mut reflogs = Vec::new();
    let mut oids = BTreeSet::new();
    let mut total_bytes = 0_usize;
    let mut total_lines = 0_usize;
    for (source_ref, file) in enumerate_collected_reflogs(collected)? {
        if source_ref.starts_with("refs/beam/") {
            continue;
        }
        let raw = fs::read(&file)?;
        if raw.is_empty() {
            continue;
        }
        if reflogs.len() >= MAX_REFLOG_FILES {
            return Err(oversized_collection_error(
                &format!(
                    "the collected remote Git state carries more than {MAX_REFLOG_FILES} non-empty \
                     reflogs"
                ),
                "history",
            ));
        }
        total_bytes += raw.len();
        if total_bytes > MAX_REFLOG_TOTAL_BYTES {
            return Err(oversized_collection_error(
                &format!(
                    "the collected remote reflogs exceed {MAX_REFLOG_TOTAL_BYTES} total bytes"
                ),
                "history",
            ));
        }
        if !raw.ends_with(b"\n") {
            return Err(malformed_reflog_error(
                &source_ref,
                "missing trailing newline",
            ));
        }
        let lines = raw[..raw.len() - 1]
            .split(|byte| *byte == b'\n')
            .collect::<Vec<_>>();
        total_lines += lines.len();
        if total_lines > MAX_REFLOG_TOTAL_LINES {
            return Err(oversized_collection_error(
                &format!(
                    "the collected remote reflogs exceed {MAX_REFLOG_TOTAL_LINES} total entries"
                ),
                "history",
            ));
        }
        if source_ref == "refs/stash" && lines.len() > MAX_STASH_REFLOG_LINES {
            return Err(oversized_collection_error(
                &format!(
                    "the collected remote stash reflog exceeds {MAX_STASH_REFLOG_LINES} entries"
                ),
                "stash",
            ));
        }
        for (index, line) in lines.iter().enumerate() {
            let (old, new) = parse_reflog_line(line, oid_length).ok_or_else(|| {
                malformed_reflog_error(&source_ref, &format!("entry {}", index + 1))
            })?;
            for oid in [old, new] {
                if oid.bytes().all(|byte| byte == b'0') {
                    continue;
                }
                oids.insert(oid.to_owned());
                if oids.len() > MAX_REFLOG_UNIQUE_OIDS {
                    return Err(oversized_collection_error(
                        &format!(
                            "the collected remote reflogs reference more than \
                             {MAX_REFLOG_UNIQUE_OIDS} distinct objects"
                        ),
                        "history",
                    ));
                }
            }
        }
        reflogs.push(CapturedReflog {
            publish_raw: source_ref != "refs/stash",
            source_ref,
            file,
            raw,
        });
    }
    Ok(CapturedReflogs { reflogs, oids })
}

fn enumerate_collected_reflogs(
    collected: &Path,
) -> Result<Vec<(String, PathBuf)>, WorkspaceGitError> {
    let mut output = Vec::new();
    let head = collected.join("logs/HEAD");
    if let Ok(metadata) = fs::symlink_metadata(&head) {
        if !metadata.file_type().is_file() {
            return Err(WorkspaceGitError::message(
                "beam down: collected logs/HEAD is not a regular file — refusing to import; the \
                 remote is untouched"
                    .to_owned(),
            ));
        }
        output.push(("HEAD".to_owned(), head));
    }
    let root = collected.join("logs/refs");
    let Ok(metadata) = fs::symlink_metadata(&root) else {
        return Ok(output);
    };
    if !metadata.file_type().is_dir() {
        return Err(WorkspaceGitError::message(
            "beam down: collected logs/refs is not a directory — refusing to import; the remote \
             is untouched"
                .to_owned(),
        ));
    }
    for (file, reference) in walk_regular_files(&root, "refs")? {
        if output.len() >= MAX_REFLOG_ENUMERATED_FILES {
            return Err(oversized_collection_error(
                &format!(
                    "the collected remote Git state carries more than {MAX_REFLOG_ENUMERATED_FILES} \
                     reflog entries"
                ),
                "history",
            ));
        }
        output.push((reference, file));
    }
    Ok(output)
}

fn parse_reflog_line(line: &[u8], oid_length: usize) -> Option<(&str, &str)> {
    let first_space = line.iter().position(|byte| *byte == b' ')?;
    let second_space = line[first_space + 1..]
        .iter()
        .position(|byte| *byte == b' ')?
        + first_space
        + 1;
    let old = std::str::from_utf8(&line[..first_space]).ok()?;
    let new = std::str::from_utf8(&line[first_space + 1..second_space]).ok()?;
    if old.len() != oid_length || new.len() != oid_length {
        return None;
    }
    if !old.bytes().all(is_lower_hex) || !new.bytes().all(is_lower_hex) {
        return None;
    }
    let header = line[second_space + 1..]
        .split(|byte| *byte == b'\t')
        .next()?;
    let fields = header.rsplit(|byte| *byte == b' ').collect::<Vec<_>>();
    if fields.len() < 3 {
        return None;
    }
    let timezone = fields[0];
    let epoch = fields[1];
    let identity_length = header.len() - timezone.len() - epoch.len() - 2;
    let timezone_valid = timezone.len() == 5
        && matches!(timezone[0], b'+' | b'-')
        && timezone[1..].iter().all(u8::is_ascii_digit);
    if identity_length == 0 || !timezone_valid || !epoch.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some((old, new))
}

fn malformed_reflog_error(reference: &str, reason: &str) -> WorkspaceGitError {
    WorkspaceGitError::message(format!(
        "beam down: malformed remote reflog for {reference} ({reason}) — refusing to import; the \
         remote is untouched"
    ))
}

fn oversized_collection_error(what: &str, subject: &str) -> WorkspaceGitError {
    WorkspaceGitError::message(format!(
        "beam down: {what} — refusing before any local change; salvage the sandbox manually if \
         this {subject} is legitimate"
    ))
}

fn read_shipped_refs(
    collected: &Path,
    expected_digest: &str,
) -> Result<BTreeMap<String, ShippedRef>, WorkspaceGitError> {
    let file = collected.join(SHIPPED_REFS_FILE);
    if !file.try_exists()? {
        return Err(WorkspaceGitError::message(format!(
            "beam down: the remote Git state no longer carries {SHIPPED_REFS_FILE} — refusing to \
             trust a ref base"
        )));
    }
    let content = fs::read_to_string(&file)?;
    if content_digest(content.as_bytes()) != expected_digest {
        return Err(WorkspaceGitError::message(format!(
            "beam down: the remote modified {SHIPPED_REFS_FILE} — refusing to trust its ref \
             baseline"
        )));
    }
    let mut refs = BTreeMap::new();
    for line in content.lines() {
        let fields = line.split(' ').collect::<Vec<_>>();
        let valid = matches!(fields.len(), 2 | 3)
            && valid_oid(fields[0])
            && !fields[1].is_empty()
            && !refs.contains_key(fields[1]);
        if !valid {
            return Err(WorkspaceGitError::message(format!(
                "beam down: invalid entry in the pinned {SHIPPED_REFS_FILE}: {line}"
            )));
        }
        refs.insert(
            fields[1].to_owned(),
            ShippedRef {
                sha: fields[0].to_owned(),
                symbolic_target: fields.get(2).map(|target| (*target).to_owned()),
            },
        );
    }
    Ok(refs)
}

async fn list_collected_refs(collected: &Path) -> Result<Vec<SourceRef>, WorkspaceGitError> {
    let output = run_git_checked(
        &collected_git_args(
            collected,
            &[
                "for-each-ref",
                "--format=%(objectname)%00%(symref)%00%(refname)",
            ],
        ),
        None,
        None,
    )
    .await?
    .stdout;
    let mut refs = BTreeMap::new();
    for line in output.lines().filter(|line| !line.is_empty()) {
        let fields = line.split('\0').collect::<Vec<_>>();
        if fields.len() >= 3 && valid_oid(fields[0]) && !fields[2].is_empty() {
            refs.insert(
                fields[2].to_owned(),
                SourceRef {
                    name: fields[2].to_owned(),
                    sha: fields[0].to_owned(),
                    symbolic_target: (!fields[1].is_empty()).then(|| fields[1].to_owned()),
                },
            );
        }
    }
    let refs_root = collected.join("refs");
    if refs_root.try_exists()? {
        let format = run_git_checked(
            &collected_git_args(collected, &["rev-parse", "--show-object-format"]),
            None,
            None,
        )
        .await?
        .stdout;
        let zero = if format.trim() == "sha256" {
            "0".repeat(64)
        } else {
            "0".repeat(40)
        };
        for (file, reference) in walk_regular_files(&refs_root, "refs")? {
            let raw = fs::read_to_string(file)?;
            let Some(target) = raw.strip_prefix("ref: ").map(str::trim_end) else {
                continue;
            };
            let resolved = run_git(
                &collected_git_args(collected, &["rev-parse", "--verify", "--quiet", &reference]),
                None,
                None,
            )
            .await?;
            refs.insert(
                reference.clone(),
                SourceRef {
                    name: reference,
                    sha: if resolved.code == 0 {
                        resolved.stdout.trim().to_owned()
                    } else {
                        zero.clone()
                    },
                    symbolic_target: Some(target.to_owned()),
                },
            );
        }
    }
    Ok(refs.into_values().collect())
}

async fn assert_remote_git_still_collected(
    collected: &CollectedWorktreeGitReturn<'_>,
    when: Option<&str>,
) -> Result<(), WorkspaceGitError> {
    let window = when.unwrap_or("while the workspace was being staged");
    let before = remote_git_pointer_state(
        collected.transport,
        &collected.remote_cwd,
        &collected.ship_info.generation,
        None,
    )
    .await?;
    if before.git != RemoteGitPointerKind::Ours || !before.payload_present {
        return Err(pointer_changed_error(
            "after its repository was collected",
            window,
            &before,
        ));
    }
    let final_remote = remote_git_tree_fingerprint(
        collected.transport,
        &collected.remote_cwd,
        &collected.payload_relative,
        Some(&collected.owner),
    )
    .await?;
    let after = remote_git_pointer_state(
        collected.transport,
        &collected.remote_cwd,
        &collected.ship_info.generation,
        None,
    )
    .await?;
    if after.git != RemoteGitPointerKind::Ours || !after.payload_present {
        return Err(pointer_changed_error(
            "during its final repository proof",
            window,
            &after,
        ));
    }
    if final_remote != collected.pre_collect {
        return Err(WorkspaceGitError::message(format!(
            "beam down: the remote Git repository changed after it was collected, {window} \
             (fingerprint {} -> {}) — a background process is still writing to it. Refusing to \
             publish a torn remote return; the remote is intact, new work included. Retry beam \
             down to collect and import the newer state",
            short(&collected.pre_collect.digest),
            short(&final_remote.digest)
        )));
    }
    Ok(())
}

fn pointer_changed_error(
    phase: &str,
    window: &str,
    state: &super::remote::RemoteGitPointerState,
) -> WorkspaceGitError {
    WorkspaceGitError::message(format!(
        "beam down: the remote .git pointer changed {phase}, {window} (pointer {}, payload {}) — \
         refusing to publish a return no longer bound to this handoff; the remote is intact",
        pointer_kind(state.git),
        if state.payload_present {
            "present"
        } else {
            "missing"
        }
    ))
}

async fn apply_collected_worktree_git(
    collected: &CollectedWorktreeGitReturn<'_>,
) -> Result<WorktreeGitReturn, WorkspaceGitError> {
    assert_worktree_identity(&collected.local_cwd, Some(&collected.ship_info)).await?;
    let mut bound = BoundReturnRepo::bind(&collected.local_cwd, Some(&collected.ship_info)).await?;
    let result = apply_collected_bound(collected, &mut bound).await;
    let restore = bound.restore();
    match (result, restore) {
        (Ok(returned), Ok(())) => Ok(returned),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

async fn apply_collected_bound(
    collected: &CollectedWorktreeGitReturn<'_>,
    bound: &mut BoundReturnRepo,
) -> Result<WorktreeGitReturn, WorkspaceGitError> {
    let return_key = worktree_git_return_key(&collected.record_id, Some(&collected.ship_info))?;
    let qbase = return_qbase(&return_key, &collected.pre_collect.digest);
    let mut quarantined = Vec::new();
    let mut notes = Vec::new();
    bound.import_objects(&collected.collected)?;
    publish_captured_reflogs(
        bound,
        &qbase,
        &collected.validated.captured_reflogs,
        &collected.validated.unreachable_objects,
        &mut notes,
    )
    .await?;
    let head_symbolic = run_git(
        &collected_git_args(&collected.collected, &["symbolic-ref", "--quiet", "HEAD"]),
        None,
        None,
    )
    .await?;
    let head_sha = run_git(
        &collected_git_args(
            &collected.collected,
            &["rev-parse", "--verify", "--quiet", "HEAD"],
        ),
        None,
        None,
    )
    .await?;
    let remote_head = (head_sha.code == 0).then(|| head_sha.stdout.trim().to_owned());
    if let Some(remote_head) = &remote_head {
        bound
            .run_worktree_checked(&["cat-file", "-e", remote_head], None, RunInput::Ignore)
            .await?;
    }
    let head_branch = (head_symbolic.code == 0).then(|| head_symbolic.stdout.trim().to_owned());
    notes.push(
        apply_collected_index(
            bound,
            &qbase,
            &collected.local_cwd,
            collected.temporary.path(),
            &collected.collected,
            remote_head.as_deref(),
        )
        .await?,
    );
    let refs = apply_collected_remote_refs(
        bound,
        &qbase,
        &collected.validated.remote_refs,
        &collected.validated.shipped,
    )
    .await?;
    quarantined.extend(refs.0);
    notes.extend(refs.1);
    let remote_names = collected
        .validated
        .remote_refs
        .iter()
        .map(|reference| reference.name.clone())
        .collect::<BTreeSet<_>>();
    let deleted =
        apply_collected_deleted_refs(bound, &qbase, &collected.validated.shipped, &remote_names)
            .await?;
    quarantined.extend(deleted.0);
    notes.extend(deleted.1);
    let stash = apply_collected_stash(
        bound,
        &qbase,
        &collected.collected,
        &collected.validated.remote_refs,
        &collected.validated.shipped,
        &collected.validated.shipped_stash_log,
    )
    .await?;
    quarantined.extend(stash.quarantined.iter().cloned());
    notes.extend(stash.notes.iter().cloned());
    let head = apply_collected_head(
        bound,
        &qbase,
        collected.ship_info.branch.as_deref(),
        &collected.validated.shipped,
        head_branch.as_deref(),
        remote_head.as_deref(),
    )
    .await?;
    quarantined.extend(head.quarantined);
    notes.extend(head.notes);
    if let Some(note) = collected_operation_state_note(&collected.collected)? {
        notes.push(note);
    }
    notes.push(
        apply_collected_manifest(
            bound,
            CollectedManifest {
                qbase: &qbase,
                return_key: &return_key,
                digest: &collected.pre_collect.digest,
                remote_refs: &collected.validated.remote_refs,
                shipped: &collected.validated.shipped,
                remote_names: &remote_names,
                head_branch: head_branch.as_deref(),
                remote_head: remote_head.as_deref(),
                head_pin: head.pin.as_deref(),
                stash: &stash,
            },
        )
        .await?,
    );
    Ok(WorktreeGitReturn {
        qbase,
        quarantined,
        notes,
    })
}

struct BoundReturnRepo {
    local_cwd: PathBuf,
    worktree_git_dir: PathBuf,
    common_git_dir: PathBuf,
    identity: OwnedShipIdentity,
}

struct OwnedShipIdentity {
    common_id: GitDirIdentity,
    worktree_id: GitDirIdentity,
    common_token: String,
    worktree_token: String,
}

impl BoundReturnRepo {
    async fn bind(
        local_cwd: &Path,
        ship_info: Option<&WtGitShipInfo>,
    ) -> Result<Self, WorkspaceGitError> {
        let ship = complete_ship_identity(local_cwd, ship_info)?;
        let identity = OwnedShipIdentity {
            common_id: ship.common_dir_id.clone(),
            worktree_id: ship.worktree_git_dir_id.clone(),
            common_token: ship.common_dir_token.to_owned(),
            worktree_token: ship.worktree_git_dir_token.to_owned(),
        };
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
        let common_git_dir = resolve_git_output(
            local_cwd,
            &run_git_checked(
                &git_args(local_cwd, &["rev-parse", "--git-common-dir"]),
                None,
                None,
            )
            .await?
            .stdout,
        );
        let bound = Self {
            local_cwd: local_cwd.to_path_buf(),
            worktree_git_dir,
            common_git_dir,
            identity,
        };
        bound.prove_worktree()?;
        bound.prove_common()?;
        Ok(bound)
    }

    async fn run_worktree_checked(
        &mut self,
        arguments: &[&str],
        environment: Option<&BTreeMap<String, String>>,
        input: RunInput<'_>,
    ) -> Result<String, WorkspaceGitError> {
        self.prove_worktree()?;
        let mut argv = vec![
            os("git"),
            os("--git-dir"),
            os("."),
            os("--work-tree"),
            self.local_cwd.as_os_str().to_owned(),
        ];
        argv.extend(arguments.iter().map(os));
        Ok(
            run_git_checked_with_input(&argv, Some(&self.worktree_git_dir), environment, input)
                .await?
                .stdout,
        )
    }

    async fn run_worktree(
        &mut self,
        arguments: &[&str],
        environment: Option<&BTreeMap<String, String>>,
    ) -> Result<crate::util::shell::RunResult, WorkspaceGitError> {
        self.prove_worktree()?;
        let mut argv = vec![
            os("git"),
            os("--git-dir"),
            os("."),
            os("--work-tree"),
            self.local_cwd.as_os_str().to_owned(),
        ];
        argv.extend(arguments.iter().map(os));
        run_git(&argv, Some(&self.worktree_git_dir), environment).await
    }

    async fn run_common_checked(
        &mut self,
        arguments: &[&str],
        environment: Option<&BTreeMap<String, String>>,
        input: RunInput<'_>,
    ) -> Result<String, WorkspaceGitError> {
        self.prove_common()?;
        let mut argv = vec![os("git"), os("--git-dir"), os(".")];
        argv.extend(arguments.iter().map(os));
        Ok(
            run_git_checked_with_input(&argv, Some(&self.common_git_dir), environment, input)
                .await?
                .stdout,
        )
    }

    fn import_objects(&mut self, collected: &Path) -> Result<(), WorkspaceGitError> {
        self.prove_common()?;
        import_objects(collected, &self.common_git_dir)
    }

    fn prove_worktree(&self) -> Result<(), WorkspaceGitError> {
        prove_bound_identity(
            &self.local_cwd,
            "worktree git dir",
            &self.worktree_git_dir,
            &self.identity.worktree_id,
            WORKTREE_ID_FILE,
            &self.identity.worktree_token,
        )
    }

    fn prove_common(&self) -> Result<(), WorkspaceGitError> {
        prove_bound_identity(
            &self.local_cwd,
            "common git dir",
            &self.common_git_dir,
            &self.identity.common_id,
            REPOSITORY_ID_FILE,
            &self.identity.common_token,
        )
    }

    fn restore(self) -> Result<(), WorkspaceGitError> {
        self.prove_worktree()?;
        self.prove_common()
    }
}

fn prove_bound_identity(
    local_cwd: &Path,
    what: &str,
    path: &Path,
    shipped_id: &GitDirIdentity,
    marker: &str,
    token: &str,
) -> Result<(), WorkspaceGitError> {
    let current = dir_identity(path)?;
    let current_token = read_git_identity_token(path, marker)?;
    if current != *shipped_id || current_token.as_deref() != Some(token) {
        return Err(WorkspaceGitError::message(format!(
            "beam down: the {what} of {} is not the directory this handoff shipped from — it was \
             replaced or moved since the ship; refusing to touch git state through an unproven \
             directory",
            local_cwd.display()
        )));
    }
    Ok(())
}

async fn quarantine_text(
    bound: &mut BoundReturnRepo,
    reference: &str,
    content: &[u8],
) -> Result<(), WorkspaceGitError> {
    let blob = bound
        .run_common_checked(
            &["hash-object", "-w", "--stdin"],
            None,
            RunInput::Bytes(content),
        )
        .await?
        .trim()
        .to_owned();
    bound
        .run_common_checked(
            &["update-ref", "--no-deref", reference, &blob],
            None,
            RunInput::Ignore,
        )
        .await?;
    Ok(())
}

async fn publish_captured_reflogs(
    bound: &mut BoundReturnRepo,
    qbase: &str,
    captured: &CapturedReflogs,
    dangling: &BTreeSet<String>,
    notes: &mut Vec<String>,
) -> Result<(), WorkspaceGitError> {
    let raws = captured
        .reflogs
        .iter()
        .filter(|reflog| reflog.publish_raw)
        .collect::<Vec<_>>();
    let mut blob_by_file = BTreeMap::new();
    if !raws.is_empty() {
        let input = format!(
            "{}\n",
            raws.iter()
                .map(|reflog| path_text(&reflog.file))
                .collect::<Result<Vec<_>, _>>()?
                .join("\n")
        );
        let output = bound
            .run_common_checked(
                &["hash-object", "-w", "--no-filters", "--stdin-paths"],
                None,
                RunInput::Text(&input),
            )
            .await?;
        let ids = output
            .lines()
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>();
        if ids.len() != raws.len() {
            return Err(WorkspaceGitError::message(
                "beam down: reflog blob publication returned an unexpected object count — refusing"
                    .to_owned(),
            ));
        }
        for (reflog, oid) in raws.iter().zip(ids) {
            blob_by_file.insert(reflog.file.clone(), oid.to_owned());
        }
    }
    let mut updates = String::new();
    for oid in &captured.oids {
        updates.push_str(&format!(
            "option no-deref\nupdate {qbase}/meta/reflog-pins/{oid} {oid}\n"
        ));
    }
    for reflog in &raws {
        let qref = return_reflog_ref_at_base(qbase, &reflog.source_ref, &reflog.raw);
        updates.push_str(&format!(
            "option no-deref\nupdate {qref} {}\n",
            blob_by_file
                .get(&reflog.file)
                .expect("reflog blob id exists")
        ));
    }
    for oid in dangling {
        updates.push_str(&format!(
            "option no-deref\nupdate {qbase}/meta/object-pins/{oid} {oid}\n"
        ));
    }
    if !updates.is_empty() {
        bound
            .run_common_checked(&["update-ref", "--stdin"], None, RunInput::Text(&updates))
            .await?;
    }
    if raws.len() <= 16 {
        for reflog in raws {
            let qref = return_reflog_ref_at_base(qbase, &reflog.source_ref, &reflog.raw);
            notes.push(format!(
                "reflog for {}: exact remote reflog preserved at {qref} — inspect with: git \
                 cat-file blob {}",
                reflog.source_ref,
                shq(&qref)
            ));
        }
    } else {
        notes.push(format!(
            "{} remote reflogs preserved under {qbase}/meta/reflogs/ — list with: git \
             for-each-ref {}",
            raws.len(),
            shq(&format!("{qbase}/meta/reflogs"))
        ));
    }
    if !captured.oids.is_empty() {
        notes.push(format!(
            "{} reflog-referenced object(s) pinned under {qbase}/meta/reflog-pins/ — remote-only \
             history survives reflog expiry and git gc --prune=now",
            captured.oids.len()
        ));
    }
    if !dangling.is_empty() {
        notes.push(format!(
            "{} unreferenced remote object(s) pinned under {qbase}/meta/object-pins/ — remote \
             objects with no surviving reference survive reflog expiry and git gc --prune=now",
            dangling.len()
        ));
    }
    Ok(())
}

async fn apply_collected_index(
    bound: &mut BoundReturnRepo,
    qbase: &str,
    local_cwd: &Path,
    temporary_root: &Path,
    collected: &Path,
    remote_head: Option<&str>,
) -> Result<String, WorkspaceGitError> {
    let collected_index = collected.join("index");
    let incoming = temporary_root.join("incoming-index");
    if collected_index.try_exists()? {
        for entry in fs::read_dir(collected)? {
            let entry = entry?;
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with("sharedindex.")
            {
                fs::copy(entry.path(), temporary_root.join(entry.file_name()))?;
            }
        }
        fs::copy(collected_index, &incoming)?;
        let environment = index_environment(&incoming)?;
        bound
            .run_worktree_checked(
                &["update-index", "--no-split-index"],
                Some(&environment),
                RunInput::Ignore,
            )
            .await?;
        bound
            .run_worktree_checked(
                &["update-index", "--no-untracked-cache"],
                Some(&environment),
                RunInput::Ignore,
            )
            .await?;
        drop(
            bound
                .run_worktree(&["update-index", "--no-fsmonitor"], Some(&environment))
                .await?,
        );
    } else {
        let environment = index_environment(&incoming)?;
        bound
            .run_worktree_checked(
                &["read-tree", remote_head.unwrap_or("--empty")],
                Some(&environment),
                RunInput::Ignore,
            )
            .await?;
    }
    let prefix = vec![os("git"), os("--git-dir"), os(".")];
    bound.prove_common()?;
    let git_cwd = Some(bound.common_git_dir.as_path());
    let content = index_content(local_cwd, Some(&incoming), Some(&prefix), git_cwd).await?;
    let semantic =
        index_semantic_digest(local_cwd, Some(&incoming), Some(&prefix), git_cwd).await?;
    bound.prove_worktree()?;
    pin_incoming_checkout(
        bound,
        &format!("{qbase}/meta/state"),
        &incoming,
        &content,
        &semantic,
        remote_head,
    )
    .await?;
    Ok(format!(
        "remote index and HEAD preserved at {qbase}/meta/state — the local checkout is never \
         modified; inspect with: git cat-file commit {}",
        shq(&format!("{qbase}/meta/state"))
    ))
}

async fn pin_incoming_checkout(
    bound: &mut BoundReturnRepo,
    state_ref: &str,
    incoming_index: &Path,
    index: &IndexContent,
    index_semantic: &str,
    remote_head: Option<&str>,
) -> Result<(), WorkspaceGitError> {
    let index_blob = bound
        .run_common_checked(
            &[
                "hash-object",
                "-w",
                "--no-filters",
                path_text(incoming_index)?,
            ],
            None,
            RunInput::Ignore,
        )
        .await?
        .trim()
        .to_owned();
    let entries_tree = index_entry_objects_tree(bound, incoming_index).await?;
    let mut tree_lines = format!("100644 blob {index_blob}\tindex\n");
    if let Some(tree) = &index.tree {
        tree_lines.push_str(&format!("040000 tree {tree}\tstaged\n"));
    }
    if let Some(tree) = entries_tree {
        tree_lines.push_str(&format!("040000 tree {tree}\tentries\n"));
    }
    let metadata_tree = bound
        .run_common_checked(&["mktree"], None, RunInput::Text(&tree_lines))
        .await?
        .trim()
        .to_owned();
    let prior = bound
        .run_common_checked(
            &["rev-parse", "--verify", "--quiet", state_ref],
            None,
            RunInput::Ignore,
        )
        .await
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let mut parents = BTreeSet::new();
    if let Some(prior) = &prior {
        parents.insert(prior.clone());
    }
    if let Some(remote_head) = remote_head {
        parents.insert(remote_head.to_owned());
    }
    let mut message = format!("beam incoming checkout\n\nBeam-Incoming-Index-Blob: {index_blob}\n");
    if let Some(tree) = &index.tree {
        message.push_str(&format!("Beam-Incoming-Index-Tree: {tree}\n"));
    }
    message.push_str(&format!(
        "Beam-Incoming-Index-Digest: {}\nBeam-Incoming-Index-Semantic-Digest: \
         {index_semantic}\n",
        index.digest
    ));
    if let Some(remote_head) = remote_head {
        message.push_str(&format!("Beam-Incoming-Head: {remote_head}\n"));
    }
    let mut arguments = vec![
        "-c".to_owned(),
        "commit.gpgsign=false".to_owned(),
        "commit-tree".to_owned(),
        metadata_tree,
    ];
    for parent in parents {
        arguments.extend(["-p".to_owned(), parent]);
    }
    arguments.extend(["-m".to_owned(), message]);
    let environment = BTreeMap::from([
        ("GIT_AUTHOR_NAME".to_owned(), "beam".to_owned()),
        (
            "GIT_AUTHOR_EMAIL".to_owned(),
            "beam@beam.invalid".to_owned(),
        ),
        ("GIT_COMMITTER_NAME".to_owned(), "beam".to_owned()),
        (
            "GIT_COMMITTER_EMAIL".to_owned(),
            "beam@beam.invalid".to_owned(),
        ),
        (
            "GIT_AUTHOR_DATE".to_owned(),
            "2005-04-07T22:13:13 +0000".to_owned(),
        ),
        (
            "GIT_COMMITTER_DATE".to_owned(),
            "2005-04-07T22:13:13 +0000".to_owned(),
        ),
    ]);
    let arguments_ref = arguments.iter().map(String::as_str).collect::<Vec<_>>();
    let commit = bound
        .run_common_checked(&arguments_ref, Some(&environment), RunInput::Ignore)
        .await?
        .trim()
        .to_owned();
    bound
        .run_common_checked(
            &[
                "update-ref",
                "--no-deref",
                state_ref,
                &commit,
                prior.as_deref().unwrap_or(""),
            ],
            None,
            RunInput::Ignore,
        )
        .await?;
    Ok(())
}

async fn index_entry_objects_tree(
    bound: &mut BoundReturnRepo,
    index: &Path,
) -> Result<Option<String>, WorkspaceGitError> {
    let environment = index_environment(index)?;
    let output = bound
        .run_common_checked(
            &["ls-files", "--stage", "-z"],
            Some(&environment),
            RunInput::Ignore,
        )
        .await?;
    let mut entries = String::new();
    let mut count = 0_usize;
    for line in output.split('\0').filter(|line| !line.is_empty()) {
        let Some((metadata, _path)) = line.split_once('\t') else {
            continue;
        };
        let fields = metadata.split(' ').collect::<Vec<_>>();
        if fields.len() != 3 || fields[0].len() != 6 || !valid_oid(fields[1]) {
            continue;
        }
        if fields[1].bytes().all(|byte| byte == b'0') {
            continue;
        }
        let kind = if fields[0] == "160000" {
            "commit"
        } else {
            "blob"
        };
        entries.push_str(&format!(
            "{} {kind} {}\tentry-{count:08}\n",
            fields[0], fields[1]
        ));
        count += 1;
    }
    if entries.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        bound
            .run_common_checked(&["mktree"], None, RunInput::Text(&entries))
            .await?
            .trim()
            .to_owned(),
    ))
}

async fn apply_collected_remote_refs(
    bound: &mut BoundReturnRepo,
    qbase: &str,
    remote_refs: &[SourceRef],
    shipped: &BTreeMap<String, ShippedRef>,
) -> Result<(Vec<String>, Vec<String>), WorkspaceGitError> {
    let mut quarantined = Vec::new();
    let mut notes = Vec::new();
    for reference in remote_refs {
        if reference.name == "refs/stash" {
            continue;
        }
        let baseline = shipped.get(&reference.name);
        let target_pin = return_target_pin(qbase, reference);
        if let Some(pin) = &target_pin {
            bound
                .run_common_checked(
                    &["update-ref", "--no-deref", pin, &reference.sha],
                    None,
                    RunInput::Ignore,
                )
                .await?;
        }
        if let Some(target) = &reference.symbolic_target {
            let same = baseline.and_then(|value| value.symbolic_target.as_ref()) == Some(target);
            if !same {
                let qref = return_value_ref_at_base(
                    qbase,
                    ReturnValueKind::SymbolicValues,
                    &reference.name,
                );
                quarantine_text(
                    bound,
                    &qref,
                    format!(
                        "symbolic-ref {}\ntarget {target}\nresolved {}\n",
                        reference.name, reference.sha
                    )
                    .as_bytes(),
                )
                .await?;
                let target_note = target_pin
                    .as_ref()
                    .map(|pin| {
                        format!(
                            "; resolved object {} pinned at {pin}",
                            short(&reference.sha)
                        )
                    })
                    .unwrap_or_else(|| " (target is unborn)".to_owned());
                notes.push(format!(
                    "{}: remote symbolic target {target} preserved at {qref}{target_note}; inspect \
                     with: git cat-file -p {}",
                    reference.name,
                    shq(&qref)
                ));
                quarantined.push(reference.name.clone());
            }
            continue;
        }
        if reference.name.starts_with("refs/beam/") {
            continue;
        }
        let same = baseline
            .is_some_and(|value| value.symbolic_target.is_none() && value.sha == reference.sha);
        if same {
            continue;
        }
        let qref = return_value_ref_at_base(qbase, ReturnValueKind::Values, &reference.name);
        bound
            .run_common_checked(
                &["update-ref", "--no-deref", &qref, &reference.sha],
                None,
                RunInput::Ignore,
            )
            .await?;
        quarantined.push(reference.name.clone());
        notes.push(format!(
            "{}: remote value {} preserved at {qref} — the local ref is untouched; adopt it after \
             review with: git update-ref {} {}",
            reference.name,
            short(&reference.sha),
            shq(&reference.name),
            shq(&qref)
        ));
    }
    Ok((quarantined, notes))
}

async fn apply_collected_deleted_refs(
    bound: &mut BoundReturnRepo,
    qbase: &str,
    shipped: &BTreeMap<String, ShippedRef>,
    remote_names: &BTreeSet<String>,
) -> Result<(Vec<String>, Vec<String>), WorkspaceGitError> {
    let mut quarantined = Vec::new();
    let mut notes = Vec::new();
    for (reference, baseline) in shipped {
        if remote_names.contains(reference)
            || reference.starts_with("refs/beam/")
            || reference == "refs/stash"
            || reference.contains("@{")
        {
            continue;
        }
        if let Some(target) = &baseline.symbolic_target {
            let tomb = return_value_ref_at_base(qbase, ReturnValueKind::SymbolicDeleted, reference);
            quarantine_text(
                bound,
                &tomb,
                format!(
                    "deleted-symbolic-ref {reference}\ntarget {target}\nresolved {}\n",
                    baseline.sha
                )
                .as_bytes(),
            )
            .await?;
            notes.push(format!(
                "{reference}: symbolic ref deleted remotely — shipped target {target} preserved at \
                 {tomb}; the local ref is untouched"
            ));
        } else {
            let tomb = return_value_ref_at_base(qbase, ReturnValueKind::Deleted, reference);
            bound
                .run_common_checked(
                    &["update-ref", "--no-deref", &tomb, &baseline.sha],
                    None,
                    RunInput::Ignore,
                )
                .await?;
            notes.push(format!(
                "{reference}: deleted remotely — the local ref is untouched; shipped tip \
                 preserved at {tomb}; delete locally after review with: git update-ref -d {}",
                shq(reference)
            ));
        }
        quarantined.push(reference.clone());
    }
    Ok((quarantined, notes))
}

struct CollectedStashState {
    quarantined: Vec<String>,
    notes: Vec<String>,
    remote_stash: Vec<String>,
    remote_stash_log: Vec<u8>,
    untouched: bool,
    shipped_length: usize,
}

async fn apply_collected_stash(
    bound: &mut BoundReturnRepo,
    qbase: &str,
    collected: &Path,
    remote_refs: &[SourceRef],
    shipped: &BTreeMap<String, ShippedRef>,
    shipped_log: &[u8],
) -> Result<CollectedStashState, WorkspaceGitError> {
    let tip = remote_refs
        .iter()
        .find(|reference| reference.name == "refs/stash" && reference.symbolic_target.is_none())
        .map(|reference| reference.sha.as_str());
    let log_file = collected.join("logs/refs/stash");
    let remote_log = if log_file.try_exists()? {
        fs::read(log_file)?
    } else {
        Vec::new()
    };
    let remote = tip
        .map(|tip| stash_stack(tip, &remote_log))
        .unwrap_or_default();
    let mut shipped_stash = Vec::new();
    for index in 0_usize.. {
        let name = if index == 0 {
            "refs/stash".to_owned()
        } else {
            format!("refs/stash@{{{index}}}")
        };
        let Some(entry) = shipped.get(&name) else {
            break;
        };
        if entry.symbolic_target.is_some() {
            break;
        }
        shipped_stash.push(entry.sha.clone());
    }
    let untouched = remote_log == shipped_log && remote == shipped_stash;
    for (index, oid) in remote.iter().enumerate() {
        let pin = if index == 0 {
            format!("{qbase}/meta/stash")
        } else {
            format!("{qbase}/meta/stash-{index}")
        };
        bound
            .run_common_checked(
                &["update-ref", "--no-deref", &pin, oid],
                None,
                RunInput::Ignore,
            )
            .await?;
    }
    let mut quarantined = Vec::new();
    let mut notes = Vec::new();
    if !remote.is_empty() && !untouched {
        let reflog = format!("{qbase}/meta/stash-reflogs/{}", content_digest(&remote_log));
        quarantine_text(bound, &reflog, &remote_log).await?;
        quarantined.push("refs/stash".to_owned());
        notes.push(format!(
            "remote stash preserved at {qbase}/meta/stash with its raw reflog at {reflog} — apply \
             an entry with: git stash apply {}",
            shq(&format!("{qbase}/meta/stash"))
        ));
        if remote.len() > 1 {
            let plural = if remote.len() == 2 { "y" } else { "ies" };
            notes.push(format!(
                "{} older remote stash entr{plural} preserved at {qbase}/meta/stash-1..{}",
                remote.len() - 1,
                remote.len() - 1
            ));
        }
    }
    if remote.is_empty() && !shipped_stash.is_empty() {
        notes.push(
            "the remote consumed or dropped every shipped stash entry — the local stash still \
             holds them"
                .to_owned(),
        );
    }
    Ok(CollectedStashState {
        quarantined,
        notes,
        remote_stash: remote,
        remote_stash_log: remote_log,
        untouched,
        shipped_length: shipped_stash.len(),
    })
}

struct CollectedHeadState {
    pin: Option<String>,
    quarantined: Vec<String>,
    notes: Vec<String>,
}

async fn apply_collected_head(
    bound: &mut BoundReturnRepo,
    qbase: &str,
    shipped_branch: Option<&str>,
    shipped: &BTreeMap<String, ShippedRef>,
    head_branch: Option<&str>,
    remote_head: Option<&str>,
) -> Result<CollectedHeadState, WorkspaceGitError> {
    let mut pin = None;
    let mut quarantined = Vec::new();
    let mut notes = Vec::new();
    match (head_branch, remote_head) {
        (Some(branch), None) if Some(branch) != shipped_branch => {
            let reference = format!("{qbase}/meta/HEAD-symref");
            quarantine_text(
                bound,
                &reference,
                format!("symbolic-ref HEAD\ntarget {branch}\n").as_bytes(),
            )
            .await?;
            pin = Some(reference.clone());
            quarantined.push("HEAD".to_owned());
            notes.push(format!(
                "remote HEAD points at unborn {branch} — preserved at {reference} (git cat-file \
                 blob {}); apply here with `git symbolic-ref HEAD {}` if intended",
                shq(&reference),
                shq(branch)
            ));
        }
        (Some(branch), Some(sha)) => {
            let unchanged = Some(branch) == shipped_branch
                && shipped.get(branch).is_some_and(|entry| entry.sha == sha);
            if !unchanged {
                let reference = format!("{qbase}/meta/HEAD");
                bound
                    .run_common_checked(
                        &["update-ref", "--no-deref", &reference, sha],
                        None,
                        RunInput::Ignore,
                    )
                    .await?;
                pin = Some(reference.clone());
                quarantined.push("HEAD".to_owned());
                notes.push(format!(
                    "remote HEAD was attached to {branch} at {} — preserved at {reference}; the \
                     local HEAD is untouched",
                    short(sha)
                ));
            }
        }
        (None, Some(sha)) => {
            let reference = format!("{qbase}/meta/HEAD");
            bound
                .run_common_checked(
                    &["update-ref", "--no-deref", &reference, sha],
                    None,
                    RunInput::Ignore,
                )
                .await?;
            pin = Some(reference.clone());
            quarantined.push("HEAD".to_owned());
            notes.push(format!(
                "remote HEAD was detached at {} — preserved at {reference}; the local HEAD is \
                 untouched",
                short(sha)
            ));
        }
        (None, None) => {
            return Err(WorkspaceGitError::message(
                "beam down: the collected remote .git has neither a symbolic nor a resolvable \
                 HEAD"
                    .to_owned(),
            ));
        }
        (Some(_), None) => {}
    }
    Ok(CollectedHeadState {
        pin,
        quarantined,
        notes,
    })
}

fn collected_operation_state_note(collected: &Path) -> Result<Option<String>, WorkspaceGitError> {
    let mut markers = Vec::new();
    for name in OP_STATE_FILES.into_iter().chain(OP_STATE_DIRS) {
        if collected.join(name).try_exists()? {
            markers.push(name);
        }
    }
    Ok((!markers.is_empty()).then(|| {
        format!(
            "the remote has a git operation in progress ({}) — it stays remote-only; finish or \
             abort it on the remote (the automatic return never installs operation state locally)",
            markers.join(", ")
        )
    }))
}

struct CollectedManifest<'a> {
    qbase: &'a str,
    return_key: &'a str,
    digest: &'a str,
    remote_refs: &'a [SourceRef],
    shipped: &'a BTreeMap<String, ShippedRef>,
    remote_names: &'a BTreeSet<String>,
    head_branch: Option<&'a str>,
    remote_head: Option<&'a str>,
    head_pin: Option<&'a str>,
    stash: &'a CollectedStashState,
}

async fn apply_collected_manifest(
    bound: &mut BoundReturnRepo,
    manifest: CollectedManifest<'_>,
) -> Result<String, WorkspaceGitError> {
    let CollectedManifest {
        qbase,
        return_key,
        digest,
        remote_refs,
        shipped,
        remote_names,
        head_branch,
        remote_head,
        head_pin,
        stash,
    } = manifest;
    let mut lines = vec![
        "beam-return-manifest v1".to_owned(),
        format!("record {return_key}"),
        format!("collected-fingerprint {digest}"),
    ];
    lines.push(match (head_branch, remote_head) {
        (Some(branch), Some(sha)) => format!("head attached {sha} {branch}"),
        (Some(branch), None) => format!("head unborn {branch}"),
        (None, Some(sha)) => format!("head detached {sha}"),
        (None, None) => "head detached undefined".to_owned(),
    });
    if let Some(head_pin) = head_pin {
        lines.push(format!("head-pin {head_pin}"));
    }
    if stash.remote_stash.is_empty() {
        lines.push(format!(
            "stash none {}",
            if stash.shipped_length == 0 {
                "same"
            } else {
                "changed"
            }
        ));
    } else {
        lines.push(format!(
            "stash {} {} {} {}",
            if stash.untouched { "same" } else { "changed" },
            stash.remote_stash[0],
            content_digest(&stash.remote_stash_log),
            stash.remote_stash.len()
        ));
        lines.push(format!("stash-pin {qbase}/meta/stash"));
        for (index, sha) in stash.remote_stash.iter().enumerate() {
            let pin = if index == 0 {
                format!("{qbase}/meta/stash")
            } else {
                format!("{qbase}/meta/stash-{index}")
            };
            lines.push(format!("stash-target-pin {index} {sha} {pin}"));
        }
    }
    lines.extend(return_manifest_ref_lines(
        qbase,
        remote_refs,
        shipped,
        remote_names,
    ));
    let mut manifest = lines.join("\n");
    manifest.push('\n');
    quarantine_text(bound, &format!("{qbase}/manifest"), manifest.as_bytes()).await?;
    Ok(format!(
        "collection manifest: git cat-file blob {} — this namespace is keyed by the exact \
         collected Git fingerprint; any other refs/beam/return/{return_key}/<digest> namespaces \
         are earlier collections (history), never the latest state",
        shq(&format!("{qbase}/manifest"))
    ))
}

fn return_manifest_ref_lines(
    qbase: &str,
    remote_refs: &[SourceRef],
    shipped: &BTreeMap<String, ShippedRef>,
    remote_names: &BTreeSet<String>,
) -> Vec<String> {
    let mut lines = Vec::new();
    for reference in remote_refs
        .iter()
        .filter(|reference| reference.name != "refs/stash")
    {
        let baseline = shipped.get(&reference.name);
        let remote_beam = reference.name.starts_with("refs/beam/");
        let prefix = if remote_beam { "remote-beam-" } else { "" };
        let target_pin = return_target_pin(qbase, reference);
        if let Some(target) = &reference.symbolic_target {
            let relation = if baseline.is_none() {
                "new"
            } else if baseline.and_then(|entry| entry.symbolic_target.as_ref()) == Some(target) {
                "same"
            } else {
                "changed"
            };
            let metadata = if relation == "same" {
                String::new()
            } else {
                format!(
                    " pin {}",
                    return_value_ref_at_base(
                        qbase,
                        ReturnValueKind::SymbolicValues,
                        &reference.name
                    )
                )
            };
            let target_note = target_pin
                .map(|pin| format!(" target-pin {pin}"))
                .unwrap_or_else(|| " target-unborn".to_owned());
            lines.push(format!(
                "ref {prefix}symref {relation} {target} {}{metadata}{target_note}",
                reference.name
            ));
        } else {
            let relation = if baseline.is_none() {
                "new"
            } else if baseline
                .is_some_and(|entry| entry.symbolic_target.is_none() && entry.sha == reference.sha)
            {
                "same"
            } else {
                "changed"
            };
            let value_pin = if relation != "same" && !remote_beam {
                format!(
                    " pin {}",
                    return_value_ref_at_base(qbase, ReturnValueKind::Values, &reference.name)
                )
            } else {
                String::new()
            };
            lines.push(format!(
                "ref {prefix}direct {relation} {} {}{value_pin} target-pin {}",
                reference.sha,
                reference.name,
                target_pin.unwrap_or_default()
            ));
        }
    }
    for (reference, baseline) in shipped {
        if remote_names.contains(reference)
            || reference.starts_with("refs/beam/")
            || reference == "refs/stash"
            || reference.contains("@{")
        {
            continue;
        }
        if let Some(target) = &baseline.symbolic_target {
            lines.push(format!(
                "ref deleted-symref {target} {reference} pin {}",
                return_value_ref_at_base(qbase, ReturnValueKind::SymbolicDeleted, reference)
            ));
        } else {
            lines.push(format!(
                "ref deleted {} {reference} pin {}",
                baseline.sha,
                return_value_ref_at_base(qbase, ReturnValueKind::Deleted, reference)
            ));
        }
    }
    lines.sort();
    lines
}

fn return_target_pin(qbase: &str, reference: &SourceRef) -> Option<String> {
    if reference.sha.bytes().all(|byte| byte == b'0') {
        return None;
    }
    let kind = if reference.name.starts_with("refs/beam/") {
        ReturnValueKind::RemoteBeam
    } else if reference.symbolic_target.is_some() {
        ReturnValueKind::SymbolicTargets
    } else {
        ReturnValueKind::RefTargets
    };
    Some(return_value_ref_at_base(qbase, kind, &reference.name))
}

fn return_reflog_ref_at_base(qbase: &str, source_ref: &str, raw: &[u8]) -> String {
    format!(
        "{qbase}/meta/reflogs/{}/{}",
        content_digest(source_ref.as_bytes()),
        content_digest(raw)
    )
}

fn stash_stack(tip: &str, raw: &[u8]) -> Vec<String> {
    let mut stack = raw
        .split(|byte| *byte == b'\n')
        .filter_map(|line| {
            let first = line.iter().position(|byte| *byte == b' ')?;
            let second = line[first + 1..].iter().position(|byte| *byte == b' ')? + first + 1;
            let old = std::str::from_utf8(&line[..first]).ok()?;
            let new = std::str::from_utf8(&line[first + 1..second]).ok()?;
            (valid_oid(old) && valid_oid(new)).then(|| new.to_owned())
        })
        .collect::<Vec<_>>();
    stack.reverse();
    if stack.first().map(String::as_str) != Some(tip) {
        stack.insert(0, tip.to_owned());
    }
    stack
}

fn walk_regular_files(
    root: &Path,
    prefix: &str,
) -> Result<Vec<(PathBuf, String)>, WorkspaceGitError> {
    let mut stack = vec![(
        root.to_path_buf(),
        Vec::<String>::new(),
        directory_names(root)?,
        0_usize,
    )];
    let mut files = Vec::new();
    let mut visited = 0_usize;
    while let Some((directory, segments, names, next)) = stack.last_mut() {
        if *next >= names.len() {
            stack.pop();
            continue;
        }
        let name = names[*next].clone();
        *next += 1;
        visited += 1;
        if visited > MAX_REFLOG_ENUMERATED_FILES {
            return Err(oversized_collection_error(
                &format!(
                    "the collected remote Git state carries more than {MAX_REFLOG_ENUMERATED_FILES} \
                     reflog entries"
                ),
                "history",
            ));
        }
        if name.is_empty()
            || matches!(name.as_str(), "." | "..")
            || name.bytes().any(|byte| byte < 0x20 || byte == 0x7f)
        {
            return Err(WorkspaceGitError::message(format!(
                "beam down: collected reflog tree contains an invalid path segment \
                 ({prefix}/{}) — refusing",
                segments
                    .iter()
                    .chain(std::iter::once(&name))
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("/")
            )));
        }
        let path = directory.join(&name);
        let metadata = fs::symlink_metadata(&path)?;
        let mut child_segments = segments.clone();
        child_segments.push(name);
        if metadata.file_type().is_dir() {
            if stack.len() >= MAX_TREE_DEPTH {
                return Err(WorkspaceGitError::message(format!(
                    "beam down: collected reflog tree nests deeper than {MAX_TREE_DEPTH} \
                     directories ({prefix}/{}) — refusing",
                    child_segments.join("/")
                )));
            }
            stack.push((path.clone(), child_segments, directory_names(&path)?, 0));
        } else if metadata.file_type().is_file() {
            files.push((path, format!("{prefix}/{}", child_segments.join("/"))));
        } else {
            return Err(WorkspaceGitError::message(format!(
                "beam down: collected reflog tree contains an unsafe filesystem entry \
                 ({prefix}/{}) — refusing",
                child_segments.join("/")
            )));
        }
    }
    Ok(files)
}

fn directory_names(directory: &Path) -> Result<Vec<String>, WorkspaceGitError> {
    Ok(fs::read_dir(directory)?
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
        .collect::<Result<Vec<_>, _>>()?)
}

fn remove_any(path: &Path) -> Result<(), WorkspaceGitError> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn index_environment(index: &Path) -> Result<BTreeMap<String, String>, WorkspaceGitError> {
    Ok(BTreeMap::from([(
        "GIT_INDEX_FILE".to_owned(),
        path_text(index)?.to_owned(),
    )]))
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

fn resolve_git_output(local_cwd: &Path, output: &str) -> PathBuf {
    let value = Path::new(output.trim());
    if value.is_absolute() {
        value.to_path_buf()
    } else {
        local_cwd.join(value)
    }
}

fn safe_realpath(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn pointer_kind(kind: RemoteGitPointerKind) -> &'static str {
    match kind {
        RemoteGitPointerKind::Absent => "absent",
        RemoteGitPointerKind::Ours => "ours",
        RemoteGitPointerKind::Foreign => "foreign",
    }
}

fn short(digest: &str) -> &str {
    digest.get(..12).unwrap_or(digest)
}

fn valid_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(is_lower_hex)
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
}

fn git_args(local_cwd: &Path, arguments: &[&str]) -> Vec<OsString> {
    let mut argv = vec![os("git"), os("-C"), local_cwd.as_os_str().to_owned()];
    argv.extend(arguments.iter().map(os));
    argv
}

fn collected_git_args(collected: &Path, arguments: &[&str]) -> Vec<OsString> {
    let mut argv = vec![os("git"), os("--git-dir"), collected.as_os_str().to_owned()];
    argv.extend(arguments.iter().map(os));
    argv
}

fn extend_args(prefix: &[OsString], arguments: &[&str]) -> Vec<OsString> {
    let mut argv = prefix.to_vec();
    argv.extend(arguments.iter().map(os));
    argv
}
