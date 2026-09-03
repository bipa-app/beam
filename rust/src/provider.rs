//! SandboxProvider: the lifecycle above a transport.
//!
//! Providers are selected at runtime, so their async methods use one explicit
//! boxed future. Returned transports use `Rc`: Beam runs one current-thread
//! runtime, and a static target returns the same transport for every phase.

use std::error::Error;
use std::fmt::{Display, Formatter};
use std::pin::Pin;
use std::rc::Rc;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::transport::Transport;

mod box_provider;
mod managed_ssh;
mod static_provider;

pub use box_provider::BoxProvider;
pub use managed_ssh::{
    ManagedLinuxBootstrapOptions, ManagedSshIdentity, ManagedSshProvider, assert_owner_token,
    bootstrap_managed_linux, ensure_managed_ssh_identity, managed_ssh_check_lines,
    managed_ssh_tools_ready, new_owner_token, remove_managed_ssh_identity,
};
pub use static_provider::StaticProvider;

/// Dyn-compatible async result used by every provider lifecycle method.
pub type ProviderFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, ProviderError>> + 'a>>;
/// One transport selected by a runtime provider.
pub type TransportHandle = Rc<dyn Transport>;
/// Synchronous journal callback used before a provider enters a long wait.
pub type SandboxPersist<'a> = dyn FnMut(SandboxState) -> Result<(), ProviderError> + 'a;

/// Legacy Agent Sandbox state has no `kind` tag. Its coordinates remain the
/// identity inputs persisted by the TypeScript implementation.
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSandboxState {
    pub claim: String,
    pub context: String,
    pub namespace: String,
    pub container: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kubeconfig: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uid: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoxSandboxState {
    pub box_id: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct E2bSandboxState {
    pub owner_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_key_sha256: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct VolumeOwned;

impl Serialize for VolumeOwned {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_bool(true)
    }
}

impl<'de> Deserialize<'de> for VolumeOwned {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        if bool::deserialize(deserializer)? {
            return Ok(Self);
        }
        Err(serde::de::Error::custom(
            "volumeOwned must be true when present",
        ))
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModalSandboxState {
    pub owner_token: String,
    pub sandbox_name: String,
    pub volume_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_key_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume_owned: Option<VolumeOwned>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bootstrapped_sandbox_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaytonaSandboxState {
    pub owner_token: String,
    pub sandbox_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_id: Option<String>,
}

/// Provider-owned state variants with the TypeScript `kind` discriminant.
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ManagedSandboxState {
    Box(BoxSandboxState),
    E2b(E2bSandboxState),
    Modal(ModalSandboxState),
    Daytona(DaytonaSandboxState),
}

/// Persisted provider identity. Agent Sandbox stays untagged for compatibility;
/// every other provider carries `kind`.
#[derive(Clone, Serialize, PartialEq, Debug)]
#[serde(untagged)]
pub enum SandboxState {
    Managed(ManagedSandboxState),
    AgentSandbox(AgentSandboxState),
}

impl<'de> Deserialize<'de> for SandboxState {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let decoded: Result<Self, serde_json::Error> = if value.get("kind").is_some() {
            serde_json::from_value(value).map(Self::Managed)
        } else {
            serde_json::from_value(value).map(Self::AgentSandbox)
        };
        decoded.map_err(serde::de::Error::custom)
    }
}

/// The record slice a provider needs to locate its owned resource.
pub struct SandboxRef {
    pub id: String,
    pub sandbox: Option<SandboxState>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCheckReport {
    pub lines: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fatal: Option<String>,
}

/// Create, reconnect to, and destroy the sandbox above one transport.
pub trait SandboxProvider {
    /// Human-readable provider destination.
    fn label(&self) -> &str;

    /// Whether every workspace on this target shares one provider resource.
    fn reuses_sandbox(&self) -> bool;

    /// Return or derive the durable state this provider owns.
    fn sandbox_state(&self, reference: &SandboxRef) -> Result<Option<SandboxState>, ProviderError>;

    /// Create or reuse a resource and return a connected transport.
    fn provision<'a>(
        &'a self,
        reference: &'a mut SandboxRef,
        persist: Option<&'a mut SandboxPersist<'a>>,
    ) -> ProviderFuture<'a, TransportHandle>;

    /// Reconnect to a resource, re-resolving ephemeral coordinates.
    fn connect<'a>(
        &'a self,
        reference: Option<&'a SandboxRef>,
    ) -> ProviderFuture<'a, TransportHandle>;

    /// Delete the exact provider-owned resource. Static targets do nothing.
    fn destroy<'a>(&'a self, reference: &'a SandboxRef) -> ProviderFuture<'a, ()>;

    /// Finish provider deletion after both owner-bound cleanup receipts exist.
    fn destroy_after_verified_cleanup_without_connection<'a>(
        &'a self,
        _reference: &'a SandboxRef,
    ) -> Option<ProviderFuture<'a, ()>> {
        None
    }

    /// Run provider-level checks before a sandbox exists.
    fn check(&self) -> ProviderFuture<'_, ProviderCheckReport>;
}

#[derive(Debug)]
pub struct ProviderError {
    message: String,
    source: Option<Box<dyn Error + Send + Sync>>,
}

impl ProviderError {
    /// Build an actionable provider failure without an underlying error.
    pub fn message(message: String) -> Self {
        Self {
            message,
            source: None,
        }
    }

    /// Preserve an underlying API, process, or persistence error.
    pub fn caused_by<E>(message: String, source: E) -> Self
    where
        E: Error + Send + Sync + 'static,
    {
        Self {
            message,
            source: Some(Box::new(source)),
        }
    }
}

impl Display for ProviderError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for ProviderError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source
            .as_deref()
            .map(|source| source as &(dyn Error + 'static))
    }
}
