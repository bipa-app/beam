//! Handoff record state surface, transliterated from `src/state.ts`. The
//! full BeamRecord has many fields owned by other seams (workspace-git,
//! provider, session); this module models only what the pure state-surface
//! functions read, and defers the rest to those seams' phases.

use serde::{Deserialize, Serialize};

use crate::config::TargetSpec;

/// Handoff lifecycle. `provisioning`, `starting`, and `killing` are
/// in-flight phases that still own remote resources; only `up` is a
/// completed live handoff. Terminal states (`down`, `killed`) are monotonic.
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum BeamStatus {
    Provisioning,
    Starting,
    Up,
    Killing,
    Down,
    Killed,
}

impl BeamStatus {
    /// Whether this status still owns remote resources (and hence the
    /// target reservation).
    pub fn is_active(self) -> bool {
        match self {
            BeamStatus::Provisioning
            | BeamStatus::Starting
            | BeamStatus::Up
            | BeamStatus::Killing => true,
            BeamStatus::Down | BeamStatus::Killed => false,
        }
    }
}

/// The four harnesses beam ships sessions for (`ToolName`).
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ToolName {
    Omp,
    Pi,
    Claude,
    Codex,
}

impl ToolName {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolName::Omp => "omp",
            ToolName::Pi => "pi",
            ToolName::Claude => "claude",
            ToolName::Codex => "codex",
        }
    }
}

/// The slice of BeamRecord the state-surface functions read. Serialized
/// with the full record's field names so a persisted state.json loads;
/// the many fields owned by other seams are tolerated on load and not
/// modeled here yet.
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BeamRecord {
    pub id: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<ToolName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub local_cwd: String,
    pub remote_cwd: String,
    pub runtime_session: String,
    pub status: BeamStatus,
    pub created_at: String,
    pub updated_at: String,
    /// True once the candidate remoteCwd was resolved on the target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_cwd_resolved: Option<bool>,
    /// Snapshot of the target spec this handoff was created against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_spec: Option<TargetSpec>,
}

/// Whether record.remoteCwd was actually resolved on the target. Absent on
/// older records, where the absolute/tilde path shape is the inference.
pub fn is_remote_cwd_resolved(record: &BeamRecord) -> bool {
    record
        .remote_cwd_resolved
        .unwrap_or_else(|| record.remote_cwd.starts_with('/'))
}

/// The spec a record's remote operations must bind through: its persisted
/// snapshot, never the mutable config. Records written before snapshots
/// existed are refused — the current config cannot prove where they live.
pub fn record_spec(record: &BeamRecord) -> Result<&TargetSpec, RecordSpecError> {
    record.target_spec.as_ref().ok_or_else(|| RecordSpecError {
        message: format!(
            "handoff {} predates recorded target specs, so target {:?} in the current config \
             cannot be proven to be the machine it shipped to — beam refuses to touch a remote \
             through it. Finish it manually on its original host (herdr session delete {}; \
             remove {} if unwanted), then delete its entry from state.json in the beam dir",
            record.id, record.target, record.runtime_session, record.remote_cwd
        ),
    })
}

#[derive(PartialEq, Debug)]
pub struct RecordSpecError {
    message: String,
}

impl std::fmt::Display for RecordSpecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RecordSpecError {}

/// What a re-ship through an existing record may do with its session
/// identity. Serialized with `kind` inlined plus variant fields, matching
/// the TS union's JSON (`{"kind":"retain","tool":"omp","sessionId":"s"}`).
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SessionIdentityPlan {
    Adopt,
    #[serde(rename_all = "camelCase")]
    Retain {
        tool: ToolName,
        session_id: String,
    },
    Refuse {
        reason: String,
    },
}

/// Decide the session identity a re-ship through an existing record uses.
/// The stored identity is the ONLY address of the transcript/agent beam may
/// already have installed remotely, so it is never silently replaced:
/// nothing stored or a matching request adopts; a drifted auto-detect
/// retains; an explicit switch/clear refuses on a resolved record but
/// adopts on one that provably never shipped.
pub fn plan_session_identity(
    record: &BeamRecord,
    requested: Option<(ToolName, &str)>,
    explicit: bool,
) -> SessionIdentityPlan {
    let (Some(stored_tool), Some(stored_id)) = (record.tool, record.session_id.as_deref()) else {
        return SessionIdentityPlan::Adopt;
    };
    if let Some((tool, id)) = requested
        && tool == stored_tool
        && id == stored_id
    {
        return SessionIdentityPlan::Adopt;
    }
    if !explicit {
        return SessionIdentityPlan::Retain {
            tool: stored_tool,
            session_id: stored_id.to_owned(),
        };
    }
    if !is_remote_cwd_resolved(record) {
        return SessionIdentityPlan::Adopt;
    }
    let stored = format!("{} {}", stored_tool.as_str(), stored_id);
    let reason = match requested {
        Some((tool, id)) => format!(
            "handoff {} already shipped session {} — refusing to replace it with {} {}: the \
             transcript beam installed remotely would be orphaned. beam down {} (or beam kill \
             {} --purge) first, or drop --tool/--session to keep the stored session",
            record.id,
            stored,
            tool.as_str(),
            id,
            record.id,
            record.id
        ),
        None => format!(
            "handoff {} already shipped session {} — --no-session would orphan the transcript \
             beam installed remotely. beam down {} (or beam kill {} --purge) first",
            record.id, stored, record.id, record.id
        ),
    };
    SessionIdentityPlan::Refuse { reason }
}
