//! Git workspace materialization and append-only return quarantine.
//!
//! A local worktree is converted to one standalone repository for shipment.
//! The return path authenticates the collected repository before importing
//! objects and publishing only `refs/beam/return/**` recovery refs.

use std::collections::BTreeMap;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fmt::{Display, Formatter};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use crate::transport::TransportError;
use crate::util::shell::{RunError, RunInput, RunOptions, RunResult, run, run_checked};
use crate::workspace::{BEAM_RESERVED_DIR, OwnedDestinationError, WorkspaceError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

mod materialize;
mod remote;
mod return_path;
mod tree;

pub use materialize::{MaterializedWorktreeGit, materialize_worktree_git};
pub use remote::{
    RemoteGitEntryKind, RemoteGitPointerState, install_remote_git_pointer,
    reconcile_git_pointer_temp, remote_git_entry_kind, remote_git_pointer_state,
    remote_git_tree_fingerprint,
};
pub use return_path::{
    CollectedWorktreeGitReturn, WorktreeGitReturn, WorktreeGitReturnRecord,
    collect_worktree_git_return, import_objects, import_worktree_git_return,
    prepare_worktree_git_return,
};
pub use tree::{GitTreeFingerprint, assert_no_collected_git_locks, collected_git_tree_fingerprint};

pub const SHIPPED_REFS_FILE: &str = "beam-shipped-refs";
pub const SHIPPED_STASH_LOG_FILE: &str = "beam-shipped-stash-log";
pub(crate) const REPOSITORY_ID_FILE: &str = "beam-repository-id";
pub(crate) const WORKTREE_ID_FILE: &str = "beam-worktree-id";
pub(crate) const MACHINE_LAYOUT_CONFIG: [&str; 6] = [
    "core.",
    "extensions.",
    "worktree.",
    "include.",
    "includeif.",
    "safe.",
];
pub(crate) const WORKTREE_SCOPED_REFS: [&str; 3] =
    ["refs/bisect/", "refs/worktree/", "refs/rewritten/"];

const GIT_REPO_SELECTION_ENV: [&str; 22] = [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_QUARANTINE_PATH",
    "GIT_REPLACE_REF_BASE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_INDEX_FILE",
    "GIT_INDEX_VERSION",
    "GIT_GRAFT_FILE",
    "GIT_SHALLOW_FILE",
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_TEMPLATE_DIR",
];

/// Ship-time filesystem identity of a Git directory: the inode number as a
/// decimal string. The device number is deliberately absent — APFS, btrfs
/// subvolumes, NFS, and overlay mounts assign `st_dev` at mount time, so a
/// reboot between `beam up` and `beam down` changed it and refused a valid
/// return (issue #17). The inode plus the create-only marker token is the
/// proof. Records written by older versions carry an extra `dev` field,
/// which serde ignores.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Debug)]
pub struct GitDirIdentity {
    pub ino: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WtGitShipInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub common_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_git_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub common_dir_id: Option<GitDirIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_git_dir_id: Option<GitDirIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub common_dir_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_git_dir_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shipped_refs_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shipped_stash_log_digest: Option<String>,
    pub generation: String,
}

#[derive(Clone, Copy)]
pub enum ReturnValueKind {
    Values,
    Deleted,
    RefTargets,
    RemoteBeam,
    SymbolicValues,
    SymbolicTargets,
    SymbolicDeleted,
}

impl ReturnValueKind {
    fn path(self) -> &'static str {
        match self {
            Self::Values => "values",
            Self::Deleted => "deleted",
            Self::RefTargets => "meta/ref-targets",
            Self::RemoteBeam => "meta/remote-beam",
            Self::SymbolicValues => "meta/symrefs/values",
            Self::SymbolicTargets => "meta/symrefs/targets",
            Self::SymbolicDeleted => "meta/symrefs/deleted",
        }
    }
}

pub fn sanitized_git_env() -> BTreeMap<String, String> {
    std::env::vars_os()
        .filter_map(|(name, value)| {
            let name = name.into_string().ok()?;
            if git_selection_environment(&name) {
                return None;
            }
            Some((name, value.to_string_lossy().into_owned()))
        })
        .collect()
}

pub fn return_qbase(record_id: &str, git_digest: &str) -> String {
    format!("{}/{git_digest}", return_ref_base(record_id))
}

pub fn return_value_ref(
    record_id: &str,
    git_digest: &str,
    kind: ReturnValueKind,
    source_ref: &str,
) -> String {
    return_value_ref_at_base(&return_qbase(record_id, git_digest), kind, source_ref)
}

pub fn return_ref_base(record_id: &str) -> String {
    format!("refs/beam/return/{record_id}")
}

pub fn worktree_git_return_key(
    record_id: &str,
    ship_info: Option<&WtGitShipInfo>,
) -> Result<String, WorkspaceGitError> {
    let generation = ship_info.map(|info| info.generation.as_str()).unwrap_or("");
    validate_generation(generation).map_err(|_| {
        WorkspaceGitError::message(format!(
            "beam: handoff {record_id} has no valid Git payload generation on record — refusing \
             to key its return"
        ))
    })?;
    Ok(format!("{record_id}-{generation}"))
}

pub fn git_payload_path(generation: &str) -> Result<String, WorkspaceGitError> {
    validate_generation(generation)?;
    Ok(format!("{BEAM_RESERVED_DIR}/git/{generation}"))
}

pub fn git_pointer_bytes(generation: &str) -> Result<String, WorkspaceGitError> {
    Ok(format!("gitdir: {}\n", git_payload_path(generation)?))
}

pub fn return_reflog_ref(
    record_id: &str,
    git_digest: &str,
    source_ref: &str,
    raw_reflog: &[u8],
) -> String {
    format!(
        "{}/meta/reflogs/{}/{}",
        return_qbase(record_id, git_digest),
        content_digest(source_ref.as_bytes()),
        content_digest(raw_reflog)
    )
}

pub fn return_reflog_pin_ref(record_id: &str, git_digest: &str, oid: &str) -> String {
    format!(
        "{}/meta/reflog-pins/{oid}",
        return_qbase(record_id, git_digest)
    )
}

pub fn return_object_pin_ref(record_id: &str, git_digest: &str, oid: &str) -> String {
    format!(
        "{}/meta/object-pins/{oid}",
        return_qbase(record_id, git_digest)
    )
}

pub fn is_linked_worktree(local_cwd: &Path) -> bool {
    fs::symlink_metadata(local_cwd.join(".git"))
        .is_ok_and(|metadata| metadata.file_type().is_file())
}

pub fn is_git_worktree(local_cwd: &Path) -> bool {
    fs::symlink_metadata(local_cwd.join(".git")).is_ok_and(|metadata| {
        let kind = metadata.file_type();
        kind.is_dir() || kind.is_file()
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceGitEntryKind {
    Absent,
    Directory,
    File,
    Unsupported,
}

pub fn workspace_git_entry_kind(local_cwd: &Path) -> WorkspaceGitEntryKind {
    let Ok(metadata) = fs::symlink_metadata(local_cwd.join(".git")) else {
        return WorkspaceGitEntryKind::Absent;
    };
    let kind = metadata.file_type();
    if kind.is_symlink() {
        return WorkspaceGitEntryKind::Unsupported;
    }
    if kind.is_dir() {
        return WorkspaceGitEntryKind::Directory;
    }
    if kind.is_file() {
        return WorkspaceGitEntryKind::File;
    }
    WorkspaceGitEntryKind::Unsupported
}

pub fn is_git_dir_at_cwd(local_cwd: &Path) -> bool {
    match workspace_git_entry_kind(local_cwd) {
        WorkspaceGitEntryKind::Absent => {}
        WorkspaceGitEntryKind::Directory
        | WorkspaceGitEntryKind::File
        | WorkspaceGitEntryKind::Unsupported => return false,
    }
    let Ok(head) = fs::symlink_metadata(local_cwd.join("HEAD")) else {
        return false;
    };
    if !head.file_type().is_file() || head.file_type().is_symlink() {
        return false;
    }
    fs::symlink_metadata(local_cwd.join("objects")).is_ok_and(|entry| entry.file_type().is_dir())
        && fs::symlink_metadata(local_cwd.join("refs"))
            .is_ok_and(|entry| entry.file_type().is_dir())
}

pub fn git_pointer_temp_name(generation: &str) -> Result<String, WorkspaceGitError> {
    validate_generation(generation)?;
    Ok(format!(".beam-gitptr-{generation}"))
}

pub fn workspace_git_script_golden() -> Result<Vec<(&'static str, String)>, WorkspaceGitError> {
    remote::remote_git_script_golden()
}

pub(crate) async fn run_git(
    argv: &[OsString],
    cwd: Option<&Path>,
    environment: Option<&BTreeMap<String, String>>,
) -> Result<RunResult, WorkspaceGitError> {
    let base = sanitized_git_env();
    let options = RunOptions {
        cwd,
        env: environment,
        base_env: Some(&base),
        ..RunOptions::default()
    };
    Ok(run(argv, &options).await?)
}

pub(crate) async fn run_git_checked(
    argv: &[OsString],
    cwd: Option<&Path>,
    environment: Option<&BTreeMap<String, String>>,
) -> Result<RunResult, WorkspaceGitError> {
    let base = sanitized_git_env();
    let options = RunOptions {
        cwd,
        env: environment,
        base_env: Some(&base),
        ..RunOptions::default()
    };
    Ok(run_checked(argv, &options).await?)
}

pub(crate) async fn run_git_checked_with_input(
    argv: &[OsString],
    cwd: Option<&Path>,
    environment: Option<&BTreeMap<String, String>>,
    input: RunInput<'_>,
) -> Result<RunResult, WorkspaceGitError> {
    let base = sanitized_git_env();
    let options = RunOptions {
        cwd,
        env: environment,
        base_env: Some(&base),
        input,
        ..RunOptions::default()
    };
    Ok(run_checked(argv, &options).await?)
}

pub(crate) fn dir_identity(path: &Path) -> Result<GitDirIdentity, WorkspaceGitError> {
    let metadata = fs::metadata(path)?;
    Ok(GitDirIdentity {
        ino: metadata.ino().to_string(),
    })
}

pub(crate) fn content_digest(content: &[u8]) -> String {
    hex::encode(Sha256::digest(content))
}

pub(crate) fn return_value_ref_at_base(
    qbase: &str,
    kind: ReturnValueKind,
    source_ref: &str,
) -> String {
    format!(
        "{qbase}/{}/{}/value",
        kind.path(),
        content_digest(source_ref.as_bytes())
    )
}

pub(crate) fn is_shippable_shared_ref(name: &str) -> bool {
    !name.starts_with("refs/beam/")
        && !WORKTREE_SCOPED_REFS
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

pub(crate) fn validate_generation(generation: &str) -> Result<(), WorkspaceGitError> {
    let valid = generation.len() == 16
        && generation
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'));
    if !valid {
        return Err(WorkspaceGitError::message(format!(
            "beam: invalid Git payload generation: {generation}"
        )));
    }
    Ok(())
}

fn git_selection_environment(name: &str) -> bool {
    if GIT_REPO_SELECTION_ENV.contains(&name) {
        return true;
    }
    if let Some(suffix) = name.strip_prefix("GIT_CONFIG_KEY_") {
        return !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit());
    }
    if let Some(suffix) = name.strip_prefix("GIT_CONFIG_VALUE_") {
        return !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit());
    }
    matches!(name, "GIT_DEFAULT_HASH" | "GIT_DEFAULT_REF_FORMAT")
}

pub(crate) fn path_text(path: &Path) -> Result<&str, WorkspaceGitError> {
    path.to_str().ok_or_else(|| {
        WorkspaceGitError::message(format!("beam: path is not valid UTF-8: {}", path.display()))
    })
}

pub(crate) fn os(value: impl AsRef<OsStr>) -> OsString {
    value.as_ref().to_owned()
}

#[derive(Debug)]
pub struct WorkspaceGitError {
    message: String,
    source: Option<Box<dyn Error + Send + Sync>>,
}

impl WorkspaceGitError {
    pub(crate) fn message(message: String) -> Self {
        Self {
            message,
            source: None,
        }
    }

    pub(crate) fn caused_by(message: String, source: impl Error + Send + Sync + 'static) -> Self {
        Self {
            message,
            source: Some(Box::new(source)),
        }
    }
}

impl Display for WorkspaceGitError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for WorkspaceGitError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source.as_deref().map(|source| source as &dyn Error)
    }
}

impl From<std::io::Error> for WorkspaceGitError {
    fn from(source: std::io::Error) -> Self {
        Self::caused_by(source.to_string(), source)
    }
}

impl From<RunError> for WorkspaceGitError {
    fn from(source: RunError) -> Self {
        Self::caused_by(source.to_string(), source)
    }
}

impl From<WorkspaceError> for WorkspaceGitError {
    fn from(source: WorkspaceError) -> Self {
        Self::caused_by(source.to_string(), source)
    }
}

impl From<TransportError> for WorkspaceGitError {
    fn from(source: TransportError) -> Self {
        Self::caused_by(source.to_string(), source)
    }
}

impl From<OwnedDestinationError> for WorkspaceGitError {
    fn from(source: OwnedDestinationError) -> Self {
        Self::caused_by(source.to_string(), source)
    }
}
