//! Transport: how Beam reaches a target's filesystem and shell.
//!
//! Async methods return boxed futures because the four runtime-selected
//! transport implementations must stay behind one dyn-compatible seam. Rust
//! 1.98 still excludes `async fn` and opaque futures from dyn-compatible
//! traits; spelling the allocation here avoids an `async-trait` dependency.

use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::Path;
use std::pin::Pin;

use crate::util::shell::{RunError, RunResult};

pub mod local;
pub mod ssh;

/// Target process exit code and captured output.
pub type ExecResult = RunResult;
/// Dyn-compatible async result used by every transport method.
pub type TransportFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, TransportError>> + 'a>>;

#[derive(Clone, Copy)]
/// Record-bound proof required by transfers inside a live workspace.
pub struct OwnedWorkspace<'a> {
    /// Workspace root to pin before reading its owner marker.
    pub root: &'a str,
    /// Exact `.beam/owner` content, without its trailing newline.
    pub owner_bytes: &'a str,
}

#[derive(Default)]
pub struct SyncOptions<'a> {
    /// Rsync-compatible patterns protected from transfer and mirrored deletion.
    pub excludes: &'a [String],
    /// Mirror deletions. Uploads require exact exclude-protected deletion.
    pub delete: bool,
    /// Compare contents instead of relying on size and modification time.
    pub checksum: bool,
    /// Inherit terminal output instead of capturing rsync output.
    pub verbose: bool,
    /// Earn a completed-upload mirror license where a transport needs one.
    pub license: bool,
    /// Pin this root and verify its owner in the shell that moves bytes.
    pub owned: Option<OwnedWorkspace<'a>>,
}

pub trait Transport {
    /// Human-readable target, such as `local (home=/tmp/target)`.
    fn label(&self) -> &str;

    /// Nonzero target exits are data. Delivery failures remain errors.
    fn exec<'a>(&'a self, command: &'a str) -> TransportFuture<'a, ExecResult>;

    /// Reject a nonzero target exit and return trimmed stdout on success.
    fn exec_checked<'a>(&'a self, command: &'a str) -> TransportFuture<'a, String>;

    /// Recursively sync a local directory to the target with trailing-slash semantics.
    fn sync_up<'a>(
        &'a self,
        local_dir: &'a Path,
        remote_dir: &'a str,
        options: SyncOptions<'a>,
    ) -> TransportFuture<'a, ()>;

    /// Recursively sync a target directory into a local directory.
    fn sync_down<'a>(
        &'a self,
        remote_dir: &'a str,
        local_dir: &'a Path,
        options: SyncOptions<'a>,
    ) -> TransportFuture<'a, ()>;

    /// Return whether a target path exists.
    fn exists<'a>(&'a self, remote_path: &'a str) -> TransportFuture<'a, bool>;

    /// Probe a completed-upload mirror license for this exact destination.
    fn sync_license<'a>(&'a self, _remote_dir: &'a str) -> Option<TransportFuture<'a, bool>> {
        None
    }

    /// Build argv for a target command that inherits the caller's terminal.
    fn interactive_argv(&self, command: &str) -> Vec<String>;
}

pub(crate) fn checked_exec_result(
    label: &str,
    command: &str,
    result: ExecResult,
) -> Result<String, TransportError> {
    if result.code != 0 {
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
        return Err(TransportError::message(format!(
            "[{label}] command failed ({}): {command}{suffix}",
            result.code
        )));
    }
    Ok(result.stdout.trim().to_owned())
}

#[derive(Debug)]
pub struct TransportError {
    message: String,
    source: Option<Box<dyn Error + Send + Sync>>,
}

impl TransportError {
    pub(crate) fn message(message: String) -> Self {
        Self {
            message,
            source: None,
        }
    }

    pub(crate) fn caused_by<E>(message: String, source: E) -> Self
    where
        E: Error + Send + Sync + 'static,
    {
        Self {
            message,
            source: Some(Box::new(source)),
        }
    }
}

impl Display for TransportError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for TransportError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source
            .as_deref()
            .map(|source| source as &(dyn Error + 'static))
    }
}

impl From<RunError> for TransportError {
    fn from(source: RunError) -> Self {
        Self::caused_by(source.to_string(), source)
    }
}
