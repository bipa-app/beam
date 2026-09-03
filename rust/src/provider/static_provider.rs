//! Provider for targets that already exist: local and SSH transports.

use std::ffi::{OsStr, OsString};
use std::rc::Rc;

use crate::config::{LocalTargetSpec, SshTargetSpec};
use crate::provider::{
    ProviderCheckReport, ProviderError, ProviderFuture, SandboxPersist, SandboxProvider,
    SandboxRef, SandboxState, TransportHandle,
};
use crate::transport::local::LocalTransport;
use crate::transport::ssh::{SshTransport, SshTransportOptions};
use crate::util::shell::{RunOptions, run};

/// The transport is the sandbox: there is no provider resource to manage.
pub struct StaticProvider {
    transport: TransportHandle,
    rsync_program: OsString,
}

impl StaticProvider {
    pub fn new(transport: TransportHandle) -> Self {
        Self::with_rsync_program(transport, "rsync")
    }

    /// Build the static provider selected by a local target.
    pub fn from_local_target(spec: &LocalTargetSpec) -> Result<Self, ProviderError> {
        let transport = match (&spec.home, &spec.rsync_flags) {
            (None, None) => LocalTransport::system_default(),
            (Some(home), flags) => LocalTransport::with_rsync_flags(
                home,
                flags.clone().unwrap_or_else(|| vec!["-a".to_owned()]),
            ),
            (None, Some(flags)) => {
                let home = std::env::home_dir().ok_or_else(|| {
                    ProviderError::message(
                        "beam: cannot determine the local transport home — set HOME".to_owned(),
                    )
                })?;
                LocalTransport::with_rsync_flags(home, flags.clone())
            }
        }
        .map_err(|source| ProviderError::caused_by(source.to_string(), source))?;
        Ok(Self::new(Rc::new(transport)))
    }

    /// Build the static provider selected by an SSH target.
    pub fn from_ssh_target(spec: &SshTargetSpec) -> Result<Self, ProviderError> {
        let transport = SshTransport::with_options(
            spec.host.clone(),
            SshTransportOptions {
                rsync_flags: spec.rsync_flags.clone(),
                ..SshTransportOptions::default()
            },
        )
        .map_err(|source| ProviderError::caused_by(source.to_string(), source))?;
        Ok(Self::new(Rc::new(transport)))
    }

    /// Override the probe program for hermetic provider checks.
    pub fn with_rsync_program(
        transport: TransportHandle,
        rsync_program: impl Into<OsString>,
    ) -> Self {
        Self {
            transport,
            rsync_program: rsync_program.into(),
        }
    }
}

impl SandboxProvider for StaticProvider {
    fn label(&self) -> &str {
        self.transport.label()
    }

    fn reuses_sandbox(&self) -> bool {
        false
    }

    fn sandbox_state(
        &self,
        _reference: &SandboxRef,
    ) -> Result<Option<SandboxState>, ProviderError> {
        Ok(None)
    }

    fn provision<'a>(
        &'a self,
        _reference: &'a mut SandboxRef,
        _persist: Option<&'a mut SandboxPersist<'a>>,
    ) -> ProviderFuture<'a, TransportHandle> {
        let transport = Rc::clone(&self.transport);
        Box::pin(async move { Ok(transport) })
    }

    fn connect<'a>(
        &'a self,
        _reference: Option<&'a SandboxRef>,
    ) -> ProviderFuture<'a, TransportHandle> {
        let transport = Rc::clone(&self.transport);
        Box::pin(async move { Ok(transport) })
    }

    fn destroy<'a>(&'a self, _reference: &'a SandboxRef) -> ProviderFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn check(&self) -> ProviderFuture<'_, ProviderCheckReport> {
        Box::pin(async move {
            let argv = [self.rsync_program.as_os_str(), OsStr::new("--version")];
            let available = match run(&argv, &RunOptions::default()).await {
                Ok(result) => result.code == 0,
                Err(_) => false,
            };
            let status = if available {
                "ok"
            } else {
                "MISSING — install rsync"
            };
            Ok(ProviderCheckReport {
                lines: vec![format!("local rsync:  {status}")],
                fatal: None,
            })
        })
    }
}
