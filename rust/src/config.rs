//! Target configuration, transliterated from `src/config.ts`. The serde
//! shapes are the persisted contract — `config.json` written by the
//! TypeScript beam must load identically here.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::env::BeamEnv;

/// A remote (or local, for testing) place beam can ship workspaces to.
/// Serialized with the `type` discriminant inlined, matching the TS
/// discriminated-union JSON (`{"type":"box",...}`).
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TargetSpec {
    Box(BoxTargetSpec),
    E2b(E2bTargetSpec),
    Modal(ModalTargetSpec),
    Daytona(DaytonaTargetSpec),
    Ssh(SshTargetSpec),
    Local(LocalTargetSpec),
    #[serde(rename = "agent-sandbox")]
    AgentSandbox(AgentSandboxTargetSpec),
}

/// A disposable VM provisioned through the box.ascii.dev CLI.
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BoxTargetSpec {
    /// Remote directory that holds shipped workspaces. Default: ~/beam.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// Box machine size. Omit for the account default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_type: Option<String>,
    /// Box environment carrying the user's configured credentials and setup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    /// Automatic stop in seconds. Omit to keep the Box running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<u64>,
}

/// An E2B sandbox reached through an SSH-ready custom template.
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct E2bTargetSpec {
    /// E2B template id or alias with Beam's SSH startup contract.
    pub template: String,
    /// Remote SSH user created by the template. Default: user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// Active lifetime before E2B auto-pauses the sandbox. Default: 86400.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
    /// Remote directory that holds shipped workspaces. Default: ~/beam.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
}

/// A Modal Sandbox backed by a durable Modal Volume mounted at /root.
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModalTargetSpec {
    /// Deployed Modal App that owns named sandboxes. Default: beam.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    /// OCI image containing the chosen coding harness. Default: debian:bookworm-slim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// Compute lifetime before Beam recreates it around the Volume. Default: 86400.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
    /// Remote directory that holds shipped workspaces. Default: ~/beam.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
}

/// A Daytona sandbox provisioned through the authenticated Daytona CLI.
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DaytonaTargetSpec {
    /// Snapshot used for new sandboxes. Omit for Daytona's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<String>,
    /// Daytona target region, such as us or eu.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Remote directory that holds shipped workspaces. Default: ~/beam.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SshTargetSpec {
    /// ssh destination: host alias from ~/.ssh/config, user@host, etc.
    pub host: String,
    /// Remote directory that holds shipped workspaces. Default: ~/beam.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// Extra rsync flags (default: -a -z).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rsync_flags: Option<Vec<String>>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalTargetSpec {
    /// Local directory acting as the "remote" root.
    pub root: String,
    /// Directory acting as the remote home (session stores land under it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rsync_flags: Option<Vec<String>>,
}

/// A GKE Agent Sandbox target reached over `kubectl exec`.
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentSandboxTargetSpec {
    /// kubectl context name — pinned on every call.
    pub context: String,
    /// Namespace holding this user's SandboxClaims.
    pub namespace: String,
    /// SandboxTemplate each handoff's claim instantiates.
    pub template: String,
    /// Explicit kubeconfig path holding ONLY the least-privilege credential.
    pub kubeconfig: String,
    /// Container to exec into (default: "sandbox").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    /// Directory inside the sandbox holding shipped workspaces. Default: ~/beam.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_target: Option<String>,
    #[serde(default)]
    pub targets: BTreeMap<String, TargetSpec>,
    /// rsync exclude patterns applied to every ship (merged with .beamignore).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excludes: Option<Vec<String>>,
}

pub const DEFAULT_ROOT: &str = "~/beam";

/// The workspace root a spec ships under. Every workspace operation proves
/// physical containment under this root, so it is the single authority a
/// record's spec snapshot binds through.
pub fn target_root(spec: &TargetSpec) -> &str {
    let root = match spec {
        TargetSpec::Box(s) => &s.root,
        TargetSpec::E2b(s) => &s.root,
        TargetSpec::Modal(s) => &s.root,
        TargetSpec::Daytona(s) => &s.root,
        TargetSpec::Ssh(s) => &s.root,
        TargetSpec::AgentSandbox(s) => &s.root,
        TargetSpec::Local(s) => return &s.root,
    };
    root.as_deref().unwrap_or(DEFAULT_ROOT)
}

pub fn config_path(env: &BeamEnv) -> PathBuf {
    env.beam_dir.join("config.json")
}

/// Load config.json, tolerating a missing file as an empty target set. The
/// TS implementation also repairs a non-object `targets`; serde already
/// fails closed on a malformed shape, which is the stronger contract.
pub fn load_config(env: &BeamEnv) -> std::io::Result<Config> {
    let path = config_path(env);
    if !path.exists() {
        return Ok(Config::default());
    }
    let text = std::fs::read_to_string(&path)?;
    serde_json::from_str(&text)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err.to_string()))
}

/// Resolve a target by name, falling back to default / sole target.
pub fn resolve_target<'c>(
    config: &'c Config,
    name: Option<&str>,
) -> Result<(&'c str, &'c TargetSpec), ResolveTargetError> {
    if let Some(name) = name {
        return config
            .targets
            .get_key_value(name)
            .map(|(k, v)| (k.as_str(), v))
            .ok_or_else(|| ResolveTargetError::UnknownName(name.to_owned()));
    }
    if let Some(default) = &config.default_target {
        return config
            .targets
            .get_key_value(default)
            .map(|(k, v)| (k.as_str(), v))
            .ok_or_else(|| ResolveTargetError::UnknownName(default.clone()));
    }
    if config.targets.len() == 1 {
        let (k, v) = config.targets.iter().next().expect("one target");
        return Ok((k.as_str(), v));
    }
    Err(ResolveTargetError::NoTarget)
}

#[derive(PartialEq, Debug)]
pub enum ResolveTargetError {
    UnknownName(String),
    NoTarget,
}

impl std::fmt::Display for ResolveTargetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResolveTargetError::UnknownName(name) => {
                write!(
                    f,
                    "unknown target {name:?} — list configured targets with `beam targets`"
                )
            }
            ResolveTargetError::NoTarget => {
                write!(
                    f,
                    "no target configured — run `beam init` or `beam target add`"
                )
            }
        }
    }
}

impl std::error::Error for ResolveTargetError {}

/// Render the config as the TS `writeConfig` does: 2-space JSON + newline.
pub fn render_config(config: &Config) -> String {
    serde_json::to_string_pretty(config).expect("config serializes") + "\n"
}
