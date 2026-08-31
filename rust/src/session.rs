//! Session adapters: locate one harness transcript, install it on a target,
//! and stage the grown transcript back under Beam-owned storage.
//!
//! Async methods return boxed futures for the same reason as `Transport`: the
//! runtime selects one of four implementations behind a dyn-compatible seam.

use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::str::FromStr;
use std::time::SystemTime;

use crate::transport::{Transport, TransportError};

pub mod claude;
pub mod codex;
pub mod guarded_store;
pub mod pi_family;
pub mod ship_bundle;

use claude::ClaudeAdapter;
use codex::CodexAdapter;
use pi_family::{OmpAdapter, PiAdapter};

pub type SessionFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, SessionError>> + 'a>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolName {
    Omp,
    Pi,
    Claude,
    Codex,
}

impl ToolName {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Omp => "omp",
            Self::Pi => "pi",
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

impl Display for ToolName {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for ToolName {
    type Err = SessionError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value == "omp" {
            return Ok(Self::Omp);
        }
        if value == "pi" {
            return Ok(Self::Pi);
        }
        if value == "claude" {
            return Ok(Self::Claude);
        }
        if value == "codex" {
            return Ok(Self::Codex);
        }
        Err(SessionError::message(format!(
            "unknown tool {value:?} — expected omp, pi, claude, or codex"
        )))
    }
}

pub struct LocalSession {
    pub tool: ToolName,
    pub id: String,
    pub file: PathBuf,
    pub store_file: Option<PathBuf>,
    pub artifacts_dir: Option<PathBuf>,
    pub modified: SystemTime,
}

pub struct InstalledSession {
    pub resume_argv: Vec<String>,
    pub notes: Vec<String>,
}

pub struct StagedReturn {
    pub hint: String,
    pub remote_session_sha256: String,
}

#[derive(Clone, Copy, Default)]
pub struct InstallOptions<'a> {
    pub kickoff: Option<&'a str>,
    pub install_key: Option<&'a str>,
    pub owner: Option<&'a str>,
}

pub trait SessionAdapter {
    fn tool(&self) -> ToolName;
    fn binary(&self) -> &'static str;
    fn login_argv(&self) -> &'static [&'static str];
    fn remote_auth_probe(&self) -> Option<&'static str>;

    fn locate<'a>(
        &'a self,
        cwd: &'a Path,
        home: &'a Path,
        session_ref: Option<&'a str>,
    ) -> SessionFuture<'a, Option<LocalSession>>;

    fn install<'a>(
        &'a self,
        transport: &'a dyn Transport,
        session: &'a LocalSession,
        remote_cwd: &'a str,
        options: InstallOptions<'a>,
    ) -> SessionFuture<'a, InstalledSession>;

    fn stage_return<'a>(
        &'a self,
        transport: &'a dyn Transport,
        session: &'a LocalSession,
        local_cwd: &'a Path,
        remote_cwd: &'a str,
        stage_dir: &'a Path,
    ) -> SessionFuture<'a, StagedReturn>;

    fn cleanup_remote<'a>(
        &'a self,
        transport: &'a dyn Transport,
        session: &'a LocalSession,
        remote_cwd: &'a str,
    ) -> SessionFuture<'a, ()>;
}

static OMP_ADAPTER: OmpAdapter = OmpAdapter::new();
static PI_ADAPTER: PiAdapter = PiAdapter::new();
static CLAUDE_ADAPTER: ClaudeAdapter = ClaudeAdapter;
static CODEX_ADAPTER: CodexAdapter = CodexAdapter;

pub fn adapters() -> [&'static dyn SessionAdapter; 4] {
    [&OMP_ADAPTER, &PI_ADAPTER, &CLAUDE_ADAPTER, &CODEX_ADAPTER]
}

pub fn adapter_for(tool: ToolName) -> &'static dyn SessionAdapter {
    match tool {
        ToolName::Omp => &OMP_ADAPTER,
        ToolName::Pi => &PI_ADAPTER,
        ToolName::Claude => &CLAUDE_ADAPTER,
        ToolName::Codex => &CODEX_ADAPTER,
    }
}

pub async fn detect_session(
    cwd: &Path,
    home: &Path,
    tool: Option<ToolName>,
    session_ref: Option<&str>,
) -> Result<LocalSession, SessionError> {
    let mut found = Vec::with_capacity(if tool.is_some() { 1 } else { 4 });
    if let Some(tool) = tool {
        if let Some(session) = adapter_for(tool).locate(cwd, home, session_ref).await? {
            found.push(session);
        }
    } else {
        for adapter in adapters() {
            if let Some(session) = adapter.locate(cwd, home, session_ref).await? {
                found.push(session);
            }
        }
    }
    found.sort_by_key(|session| std::cmp::Reverse(session.modified));
    if let Some(session) = found.into_iter().next() {
        return Ok(session);
    }
    let selected = tool.map_or_else(
        || "omp/pi/claude/codex".to_owned(),
        |value| value.to_string(),
    );
    let matching = session_ref.map_or_else(String::new, |value| format!(" matching {value:?}"));
    Err(SessionError::message(format!(
        "no {selected} session found for {}{matching} — run the harness here first, or pass \
         --tool/--session",
        cwd.display()
    )))
}

#[derive(Debug)]
pub struct SessionError {
    message: String,
    source: Option<Box<dyn Error + Send + Sync>>,
}

impl SessionError {
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

impl Display for SessionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for SessionError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source
            .as_deref()
            .map(|source| source as &(dyn Error + 'static))
    }
}

impl From<TransportError> for SessionError {
    fn from(source: TransportError) -> Self {
        Self::caused_by(source.to_string(), source)
    }
}
