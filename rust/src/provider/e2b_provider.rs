//! E2B REST lifecycle over Beam's managed SSH transport.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

use serde_json::{Map, Value, json};
use ureq::Agent;

use crate::config::E2bTargetSpec;
use crate::env::BeamEnv;
use crate::provider::managed_ssh::{
    ManagedLinuxBootstrapOptions, ManagedSshIdentity, ManagedSshProvider, bootstrap_managed_linux,
    ensure_managed_ssh_identity_in, managed_ssh_check_lines_in, managed_ssh_tools_ready_in,
    new_owner_token, remove_managed_ssh_identity_in,
};
use crate::provider::{
    E2bSandboxState, ManagedSandboxState, ProviderCheckReport, ProviderError, ProviderFuture,
    SandboxPersist, SandboxProvider, SandboxRef, SandboxState, TransportHandle,
};
use crate::transport::ssh::{SshTransport, SshTransportOptions};
use crate::util::shell::{shq, which};

const E2B_API_BASE: &str = "https://api.e2b.app";
const E2B_HTTP_TIMEOUT: Duration = Duration::from_secs(120);
const E2B_OUTPUT_BYTES_MAX: usize = 1024 * 1024;
const E2B_TIMEOUT_SECONDS_DEFAULT: u64 = 24 * 60 * 60;
const E2B_TIMEOUT_SECONDS_MAX: u64 = 30 * 24 * 60 * 60;

#[derive(Clone, Copy)]
enum E2bMethod {
    Get,
    Post,
    Delete,
}

struct E2bApiOptions<'a> {
    method: E2bMethod,
    expected_statuses: &'a [u16],
    what: String,
    body: Option<Value>,
}

struct E2bApiResult {
    status: u16,
    value: Option<Value>,
}

struct E2bRawResponse {
    status: u16,
    text: String,
}

#[cfg(test)]
type E2bApiHandler = dyn Fn(&str, &E2bApiOptions<'_>) -> Result<E2bRawResponse, ProviderError>;

struct E2bProviderOptions {
    api_base_url: String,
    api_key: Option<String>,
    websocat_binary: String,
    environment: BeamEnv,
    command_environment: Option<BTreeMap<String, String>>,
    #[cfg(test)]
    api_handler: Option<Rc<E2bApiHandler>>,
}

pub struct E2bProvider {
    spec: E2bTargetSpec,
    api_base_url: String,
    api_key: Option<String>,
    timeout_seconds: u64,
    user: String,
    websocat_binary: String,
    environment: BeamEnv,
    command_environment: Option<BTreeMap<String, String>>,
    agent: Agent,
    #[cfg(test)]
    api_handler: Option<Rc<E2bApiHandler>>,
}

impl E2bProvider {
    pub fn new(spec: E2bTargetSpec) -> Result<Self, ProviderError> {
        Self::with_options(
            spec,
            E2bProviderOptions {
                api_base_url: E2B_API_BASE.to_owned(),
                api_key: None,
                websocat_binary: "websocat".to_owned(),
                environment: BeamEnv::resolve(None, None),
                command_environment: None,
                #[cfg(test)]
                api_handler: None,
            },
        )
    }

    fn with_options(
        spec: E2bTargetSpec,
        options: E2bProviderOptions,
    ) -> Result<Self, ProviderError> {
        if spec.template.trim().is_empty() || spec.template.encode_utf16().count() > 128 {
            return Err(ProviderError::message(
                "e2b target template must be a non-empty id or alias of at most 128 bytes"
                    .to_owned(),
            ));
        }
        let user = spec.user.clone().unwrap_or_else(|| "user".to_owned());
        if !valid_user(&user) {
            return Err(ProviderError::message(format!(
                "e2b target user is invalid: {}",
                json_string(&user)
            )));
        }
        let timeout_seconds = spec.timeout_seconds.unwrap_or(E2B_TIMEOUT_SECONDS_DEFAULT);
        if timeout_seconds == 0 {
            return Err(ProviderError::message(
                "e2b target timeoutSeconds must be a positive integer".to_owned(),
            ));
        }
        if timeout_seconds > E2B_TIMEOUT_SECONDS_MAX {
            return Err(ProviderError::message(
                "e2b target timeoutSeconds exceeds Beam's 30-day ceiling".to_owned(),
            ));
        }
        let api_key = match options.api_key {
            Some(value) => (!value.trim().is_empty()).then_some(value),
            None => std::env::var("E2B_API_KEY")
                .ok()
                .filter(|value| !value.trim().is_empty()),
        };
        let agent: Agent = Agent::config_builder()
            .timeout_global(Some(E2B_HTTP_TIMEOUT))
            .http_status_as_error(false)
            .build()
            .into();
        Ok(Self {
            spec,
            api_base_url: options.api_base_url,
            api_key,
            timeout_seconds,
            user,
            websocat_binary: options.websocat_binary,
            environment: options.environment,
            command_environment: options.command_environment,
            #[cfg(test)]
            api_handler: options.api_handler,
            agent,
        })
    }

    fn typed_sandbox_state(
        &self,
        reference: &SandboxRef,
    ) -> Result<E2bSandboxState, ProviderError> {
        let state = match reference.sandbox.as_ref() {
            None => E2bSandboxState {
                owner_token: new_owner_token()?,
                sandbox_id: None,
                ssh_key_sha256: None,
            },
            Some(SandboxState::Managed(ManagedSandboxState::E2b(state))) => state.clone(),
            Some(SandboxState::Managed(ManagedSandboxState::Box(_)))
            | Some(SandboxState::Managed(ManagedSandboxState::Modal(_)))
            | Some(SandboxState::Managed(ManagedSandboxState::Daytona(_)))
            | Some(SandboxState::AgentSandbox(_)) => {
                return Err(ProviderError::message(format!(
                    "handoff {} stores another provider identity but its target snapshot is e2b",
                    reference.id
                )));
            }
        };
        crate::provider::assert_owner_token(&state.owner_token, "E2B")?;
        if let Some(id) = state.sandbox_id.as_deref() {
            assert_sandbox_id(Some(&Value::String(id.to_owned())), "persisted sandbox id")?;
        }
        if state
            .ssh_key_sha256
            .as_deref()
            .is_some_and(|value| !valid_sha256(value))
        {
            return Err(ProviderError::message(
                "E2B SSH key fingerprint is malformed — state.json corrupted?".to_owned(),
            ));
        }
        Ok(state)
    }

    async fn provision_inner<'a>(
        &'a self,
        reference: &'a mut SandboxRef,
        mut persist: Option<&'a mut SandboxPersist<'a>>,
    ) -> Result<TransportHandle, ProviderError> {
        let was_empty = reference.sandbox.is_none();
        let mut state = self.typed_sandbox_state(reference)?;
        if was_empty {
            persist_state(
                reference,
                &state,
                &mut persist,
                "E2B provisioning needs a state journal callback",
            )?;
        }
        let identity = self
            .ensure_identity(&state.owner_token, state.ssh_key_sha256.as_deref())
            .await?;
        if state.ssh_key_sha256.is_none() {
            state.ssh_key_sha256 = Some(identity.sha256.clone());
            persist_state(
                reference,
                &state,
                &mut persist,
                "E2B provisioning needs a state journal callback",
            )?;
        }
        state = self.ensure_sandbox(reference, state, &identity, &mut persist)?;
        let transport = self.connect_state(reference, &state, &identity.path)?;
        bootstrap_managed_linux(
            &transport,
            ManagedLinuxBootstrapOptions {
                provider: "E2B",
                use_sudo: true,
            },
        )
        .await?;
        Ok(Rc::new(transport))
    }

    async fn connect_inner(
        &self,
        reference: Option<&SandboxRef>,
    ) -> Result<TransportHandle, ProviderError> {
        let reference = reference.ok_or_else(|| {
            ProviderError::message(
                "no live E2B sandbox for this target — run `beam up` first".to_owned(),
            )
        })?;
        let state = self.typed_sandbox_state(reference)?;
        if state.sandbox_id.is_none() || state.ssh_key_sha256.is_none() {
            return Err(ProviderError::message(format!(
                "handoff {} has incomplete E2B provisioning state — run `beam up` to recover",
                reference.id
            )));
        }
        let identity = self
            .ensure_identity(&state.owner_token, state.ssh_key_sha256.as_deref())
            .await?;
        Ok(Rc::new(self.connect_state(
            reference,
            &state,
            &identity.path,
        )?))
    }

    async fn destroy_inner(&self, reference: &SandboxRef) -> Result<(), ProviderError> {
        let state = self.typed_sandbox_state(reference)?;
        let id = match state.sandbox_id.clone() {
            Some(id) => Some(id),
            None => self.recover_sandbox_id(reference, &state)?,
        };
        if let Some(id) = id {
            self.delete_sandbox(reference, &state, &id)?;
        }
        remove_managed_ssh_identity_in(
            ManagedSshProvider::E2b,
            &state.owner_token,
            &self.environment,
        )
    }

    fn delete_sandbox(
        &self,
        reference: &SandboxRef,
        state: &E2bSandboxState,
        id: &str,
    ) -> Result<(), ProviderError> {
        let Some(info) = self.get_sandbox(id)? else {
            return Ok(());
        };
        self.verify_sandbox(&info, reference, state, id)?;
        self.api(
            &format!("/sandboxes/{id}"),
            E2bApiOptions {
                method: E2bMethod::Delete,
                expected_statuses: &[204, 404],
                what: format!("delete sandbox {id}"),
                body: None,
            },
        )?;
        Ok(())
    }

    fn check_inner(&self) -> Result<ProviderCheckReport, ProviderError> {
        let api_key = self.api_key();
        let websocat_exists = self.websocat_exists();
        let mut lines = vec![
            format!(
                "E2B API key:     {}",
                if api_key.is_some() { "set" } else { "MISSING" }
            ),
            format!(
                "local websocat:  {}",
                if websocat_exists {
                    self.websocat_binary.as_str()
                } else {
                    "MISSING"
                }
            ),
        ];
        lines.extend(managed_ssh_check_lines_in(self.command_environment()));
        if api_key.is_none() {
            return Ok(ProviderCheckReport {
                lines,
                fatal: Some("set E2B_API_KEY before using an E2B target".to_owned()),
            });
        }
        if !managed_ssh_tools_ready_in(self.command_environment()) || !websocat_exists {
            return Ok(ProviderCheckReport {
                lines,
                fatal: Some("install local ssh, rsync, ssh-keygen, and websocat".to_owned()),
            });
        }
        self.api(
            "/v2/sandboxes?state=running%2Cpaused&limit=1",
            E2bApiOptions {
                method: E2bMethod::Get,
                expected_statuses: &[200],
                what: "verify account access".to_owned(),
                body: None,
            },
        )?;
        lines.push("E2B account:     authenticated; key can manage team sandboxes".to_owned());
        Ok(ProviderCheckReport { lines, fatal: None })
    }

    async fn ensure_identity(
        &self,
        owner_token: &str,
        expected_sha256: Option<&str>,
    ) -> Result<ManagedSshIdentity, ProviderError> {
        ensure_managed_ssh_identity_in(
            ManagedSshProvider::E2b,
            owner_token,
            expected_sha256,
            &self.environment,
            self.command_environment(),
        )
        .await
    }

    fn ensure_sandbox(
        &self,
        reference: &mut SandboxRef,
        mut state: E2bSandboxState,
        identity: &ManagedSshIdentity,
        persist: &mut Option<&mut SandboxPersist<'_>>,
    ) -> Result<E2bSandboxState, ProviderError> {
        let recovered = match state.sandbox_id.clone() {
            Some(id) => Some(id),
            None => self.recover_sandbox_id(reference, &state)?,
        };
        if let Some(id) = recovered {
            if state.sandbox_id.is_none() {
                state.sandbox_id = Some(id);
                persist_state(
                    reference,
                    &state,
                    persist,
                    "E2B learned durable identity without a state journal callback",
                )?;
            }
            return Ok(state);
        }
        let created = self.api(
            "/sandboxes",
            E2bApiOptions {
                method: E2bMethod::Post,
                expected_statuses: &[201],
                what: "create a sandbox".to_owned(),
                body: Some(self.create_body(reference, &state, &identity.public_key)),
            },
        )?;
        let record = as_record(created.value, "create a sandbox")?;
        let id = assert_sandbox_id(record.get("sandboxID"), "created sandbox id")?;
        self.verify_template(&record, &id)?;
        state.sandbox_id = Some(id);
        persist_state(
            reference,
            &state,
            persist,
            "E2B learned durable identity without a state journal callback",
        )?;
        Ok(state)
    }

    fn create_body(
        &self,
        reference: &SandboxRef,
        state: &E2bSandboxState,
        public_key: &str,
    ) -> Value {
        json!({
            "templateID": self.spec.template,
            "timeout": self.timeout_seconds,
            "autoPause": true,
            "autoPauseMemory": true,
            "autoResume": { "enabled": false },
            "network": { "allowPublicTraffic": true },
            "metadata": {
                "beam.owner": state.owner_token,
                "beam.record": reference.id,
            },
            "envVars": { "BEAM_SSH_PUBLIC_KEY": public_key },
        })
    }

    fn recover_sandbox_id(
        &self,
        reference: &SandboxRef,
        state: &E2bSandboxState,
    ) -> Result<Option<String>, ProviderError> {
        let result = self.api(
            &self.recovery_path(reference, state),
            E2bApiOptions {
                method: E2bMethod::Get,
                expected_statuses: &[200],
                what: "recover a reserved sandbox".to_owned(),
                body: None,
            },
        )?;
        let candidates = match result.value {
            Some(Value::Array(candidates)) => candidates,
            Some(Value::Null)
            | Some(Value::Bool(_))
            | Some(Value::Number(_))
            | Some(Value::String(_))
            | Some(Value::Object(_))
            | None => {
                return Err(ProviderError::message(
                    "E2B API returned non-array JSON while recovering a sandbox".to_owned(),
                ));
            }
        };
        if candidates.len() > 1 {
            return Err(ProviderError::message(format!(
                "E2B owner token for handoff {} matched several sandboxes",
                reference.id
            )));
        }
        let Some(candidate) = candidates.into_iter().next() else {
            return Ok(None);
        };
        let record = as_record(Some(candidate), "recover a reserved sandbox")?;
        let id = assert_sandbox_id(record.get("sandboxID"), "recovered sandbox id")?;
        self.verify_sandbox(&record, reference, state, &id)?;
        Ok(Some(id))
    }

    fn recovery_path(&self, reference: &SandboxRef, state: &E2bSandboxState) -> String {
        let metadata = format!(
            "beam.owner={}&beam.record={}",
            state.owner_token, reference.id
        );
        format!(
            "/v2/sandboxes?metadata={}&state=running%2Cpaused&limit=2",
            url_query_component(&metadata)
        )
    }

    fn get_sandbox(&self, id: &str) -> Result<Option<Map<String, Value>>, ProviderError> {
        let result = self.api(
            &format!("/sandboxes/{id}"),
            E2bApiOptions {
                method: E2bMethod::Get,
                expected_statuses: &[200, 404],
                what: format!("inspect sandbox {id}"),
                body: None,
            },
        )?;
        if result.status == 404 {
            return Ok(None);
        }
        as_record(result.value, &format!("inspect sandbox {id}")).map(Some)
    }

    fn verify_template(&self, record: &Map<String, Value>, id: &str) -> Result<(), ProviderError> {
        let matches = record.get("templateID").and_then(Value::as_str)
            == Some(self.spec.template.as_str())
            || record.get("alias").and_then(Value::as_str) == Some(self.spec.template.as_str());
        if !matches {
            return Err(ProviderError::message(format!(
                "E2B sandbox {id} does not use configured template {}",
                self.spec.template
            )));
        }
        Ok(())
    }

    fn verify_sandbox(
        &self,
        record: &Map<String, Value>,
        reference: &SandboxRef,
        state: &E2bSandboxState,
        expected_id: &str,
    ) -> Result<(), ProviderError> {
        let id = assert_sandbox_id(record.get("sandboxID"), "sandbox id")?;
        if id != expected_id {
            return Err(ProviderError::message(format!(
                "E2B returned sandbox {id} while Beam requested {expected_id}"
            )));
        }
        self.verify_template(record, &id)?;
        let metadata = record
            .get("metadata")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                ProviderError::message(format!(
                    "E2B API returned non-object JSON while trying to inspect metadata for {id}"
                ))
            })?;
        if metadata.get("beam.owner").and_then(Value::as_str) != Some(state.owner_token.as_str()) {
            return Err(ProviderError::message(format!(
                "E2B sandbox {id} does not carry this handoff's owner token"
            )));
        }
        if metadata.get("beam.record").and_then(Value::as_str) != Some(reference.id.as_str()) {
            return Err(ProviderError::message(format!(
                "E2B sandbox {id} belongs to another Beam record"
            )));
        }
        Ok(())
    }

    fn connect_state(
        &self,
        reference: &SandboxRef,
        state: &E2bSandboxState,
        identity_path: &Path,
    ) -> Result<SshTransport, ProviderError> {
        let id = state.sandbox_id.as_deref().ok_or_else(|| {
            ProviderError::message("E2B transport needs a persisted sandbox id".to_owned())
        })?;
        let info = self.get_sandbox(id)?.ok_or_else(|| {
            ProviderError::message(format!("E2B sandbox {id} is gone — run beam kill --purge"))
        })?;
        self.verify_sandbox(&info, reference, state, id)?;
        let result = self.api(
            &format!("/sandboxes/{id}/connect"),
            E2bApiOptions {
                method: E2bMethod::Post,
                expected_statuses: &[200, 201],
                what: format!("resume sandbox {id}"),
                body: Some(json!({ "timeout": self.timeout_seconds })),
            },
        )?;
        let record = as_record(result.value, &format!("resume sandbox {id}"))?;
        let connected_id = assert_sandbox_id(record.get("sandboxID"), "connected sandbox id")?;
        if connected_id != id {
            return Err(ProviderError::message(
                "E2B connect returned a different sandbox id".to_owned(),
            ));
        }
        self.verify_template(&record, &connected_id)?;
        self.ssh_transport(&connected_id, identity_path)
    }

    fn ssh_transport(&self, id: &str, identity_path: &Path) -> Result<SshTransport, ProviderError> {
        let transport = SshTransport::with_options(
            format!("{}@{id}", self.user),
            SshTransportOptions {
                rsync_flags: None,
                label: Some(format!("E2B {id}")),
                ssh_options: self.ssh_options(id, identity_path),
            },
        )
        .map_err(|source| {
            let message = source.to_string();
            ProviderError::caused_by(message, source)
        })?;
        #[cfg(test)]
        let mut transport = transport;
        #[cfg(test)]
        if let Some(environment) = self.command_environment.clone() {
            transport.set_command_environment(environment);
        }
        Ok(transport)
    }

    fn ssh_options(&self, id: &str, identity_path: &Path) -> Vec<String> {
        let proxy = format!(
            "{} --binary -B 65536 - wss://8081-%h.e2b.app",
            shq(&self.websocat_binary)
        );
        vec![
            "-i".to_owned(),
            identity_path.display().to_string(),
            "-o".to_owned(),
            "IdentitiesOnly=yes".to_owned(),
            "-o".to_owned(),
            "BatchMode=yes".to_owned(),
            "-o".to_owned(),
            "StrictHostKeyChecking=accept-new".to_owned(),
            "-o".to_owned(),
            format!("HostKeyAlias=e2b-{id}"),
            "-o".to_owned(),
            format!("ProxyCommand={proxy}"),
        ]
    }

    fn api(&self, path: &str, options: E2bApiOptions<'_>) -> Result<E2bApiResult, ProviderError> {
        let api_key = self
            .api_key()
            .ok_or_else(|| ProviderError::message("E2B_API_KEY is not set".to_owned()))?;
        let raw = self.request_raw(path, &options, api_key)?;
        if raw.text.len() > E2B_OUTPUT_BYTES_MAX {
            return Err(ProviderError::message(format!(
                "E2B API response exceeded {E2B_OUTPUT_BYTES_MAX} bytes"
            )));
        }
        let status = raw.status;
        let text = raw.text;
        let value = parse_json(&text, &options.what)?;
        if !options.expected_statuses.contains(&status) {
            let fallback = if text.is_empty() {
                format!("HTTP {status}")
            } else {
                text
            };
            return Err(ProviderError::message(format!(
                "E2B API could not {}: {}",
                options.what,
                error_detail(value.as_ref(), &fallback)
            )));
        }
        Ok(E2bApiResult { status, value })
    }

    fn request_raw(
        &self,
        path: &str,
        options: &E2bApiOptions<'_>,
        api_key: &str,
    ) -> Result<E2bRawResponse, ProviderError> {
        #[cfg(test)]
        if let Some(handler) = self.api_handler.as_ref() {
            return handler(path, options);
        }
        let url = format!("{}{}", self.api_base_url.trim_end_matches('/'), path);
        let response = self.send_request(&url, api_key, options.method, options.body.as_ref());
        let mut response = response.map_err(|source| {
            ProviderError::message(format!("E2B API could not {}: {source}", options.what))
        })?;
        let status = response.status().as_u16();
        let text = read_bounded_response(&mut response, &options.what)?;
        Ok(E2bRawResponse { status, text })
    }

    fn send_request(
        &self,
        url: &str,
        api_key: &str,
        method: E2bMethod,
        body: Option<&Value>,
    ) -> Result<ureq::http::Response<ureq::Body>, ureq::Error> {
        match method {
            E2bMethod::Get => self
                .agent
                .get(url)
                .header("Content-Type", "application/json")
                .header("X-API-Key", api_key)
                .call(),
            E2bMethod::Post => {
                let body = body.map_or_else(|| "null".to_owned(), Value::to_string);
                self.agent
                    .post(url)
                    .header("Content-Type", "application/json")
                    .header("X-API-Key", api_key)
                    .send(body)
            }
            E2bMethod::Delete => self
                .agent
                .delete(url)
                .header("Content-Type", "application/json")
                .header("X-API-Key", api_key)
                .call(),
        }
    }

    fn api_key(&self) -> Option<&str> {
        self.api_key.as_deref()
    }

    fn websocat_exists(&self) -> bool {
        if self.websocat_binary.contains('/') {
            return Path::new(&self.websocat_binary).exists();
        }
        which(&self.websocat_binary, self.command_environment()).is_some()
    }

    fn command_environment(&self) -> Option<&BTreeMap<String, String>> {
        self.command_environment.as_ref()
    }
}

impl SandboxProvider for E2bProvider {
    fn label(&self) -> &str {
        "E2B"
    }

    fn reuses_sandbox(&self) -> bool {
        false
    }

    fn sandbox_state(&self, reference: &SandboxRef) -> Result<Option<SandboxState>, ProviderError> {
        Ok(Some(SandboxState::Managed(ManagedSandboxState::E2b(
            self.typed_sandbox_state(reference)?,
        ))))
    }

    fn provision<'a>(
        &'a self,
        reference: &'a mut SandboxRef,
        persist: Option<&'a mut SandboxPersist<'a>>,
    ) -> ProviderFuture<'a, TransportHandle> {
        Box::pin(self.provision_inner(reference, persist))
    }

    fn connect<'a>(
        &'a self,
        reference: Option<&'a SandboxRef>,
    ) -> ProviderFuture<'a, TransportHandle> {
        Box::pin(self.connect_inner(reference))
    }

    fn destroy<'a>(&'a self, reference: &'a SandboxRef) -> ProviderFuture<'a, ()> {
        Box::pin(self.destroy_inner(reference))
    }

    fn destroy_after_verified_cleanup_without_connection<'a>(
        &'a self,
        reference: &'a SandboxRef,
    ) -> Option<ProviderFuture<'a, ()>> {
        Some(Box::pin(self.destroy_inner(reference)))
    }

    fn check(&self) -> ProviderFuture<'_, ProviderCheckReport> {
        Box::pin(async { self.check_inner() })
    }
}

fn persist_state(
    reference: &mut SandboxRef,
    state: &E2bSandboxState,
    persist: &mut Option<&mut SandboxPersist<'_>>,
    missing_message: &str,
) -> Result<(), ProviderError> {
    let callback = persist
        .as_deref_mut()
        .ok_or_else(|| ProviderError::message(missing_message.to_owned()))?;
    let persisted = SandboxState::Managed(ManagedSandboxState::E2b(state.clone()));
    reference.sandbox = Some(persisted.clone());
    callback(persisted)
}

fn read_bounded_response(
    response: &mut ureq::http::Response<ureq::Body>,
    what: &str,
) -> Result<String, ProviderError> {
    let mut bytes = Vec::with_capacity(8 * 1024);
    response
        .body_mut()
        .as_reader()
        .take((E2B_OUTPUT_BYTES_MAX + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|source| {
            ProviderError::message(format!(
                "E2B API could not read response while trying to {what}: {source}"
            ))
        })?;
    if bytes.len() > E2B_OUTPUT_BYTES_MAX {
        return Err(ProviderError::message(format!(
            "E2B API response exceeded {E2B_OUTPUT_BYTES_MAX} bytes"
        )));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn parse_json(text: &str, what: &str) -> Result<Option<Value>, ProviderError> {
    if text.is_empty() {
        return Ok(None);
    }
    serde_json::from_str(text).map(Some).map_err(|_| {
        ProviderError::message(format!(
            "E2B API returned malformed JSON while trying to {what}"
        ))
    })
}

fn as_record(value: Option<Value>, what: &str) -> Result<Map<String, Value>, ProviderError> {
    match value {
        Some(Value::Object(record)) => Ok(record),
        Some(Value::Null)
        | Some(Value::Bool(_))
        | Some(Value::Number(_))
        | Some(Value::String(_))
        | Some(Value::Array(_))
        | None => Err(ProviderError::message(format!(
            "E2B API returned non-object JSON while trying to {what}"
        ))),
    }
}

fn assert_sandbox_id(value: Option<&Value>, what: &str) -> Result<String, ProviderError> {
    let Some(Value::String(id)) = value else {
        return Err(ProviderError::message(format!(
            "E2B API returned malformed {what}: {}",
            json_value(value)
        )));
    };
    let valid = (6..=128).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    if !valid {
        return Err(ProviderError::message(format!(
            "E2B API returned malformed {what}: {}",
            json_value(value)
        )));
    }
    Ok(id.clone())
}

fn error_detail<'a>(value: Option<&'a Value>, fallback: &'a str) -> &'a str {
    value
        .and_then(Value::as_object)
        .and_then(|record| record.get("message"))
        .and_then(Value::as_str)
        .unwrap_or(fallback)
}

fn valid_user(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some(first) = bytes.first() else {
        return false;
    };
    let first_valid = first.is_ascii_lowercase() || *first == b'_';
    first_valid
        && bytes.len() <= 32
        && bytes.iter().skip(1).all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_' || *byte == b'-'
        })
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn url_query_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'*' | b'-' | b'.' | b'_') {
            encoded.push(char::from(byte));
        } else if byte == b' ' {
            encoded.push('+');
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    encoded
}

fn json_value(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), Value::to_string)
}

fn json_string(value: &str) -> String {
    Value::String(value.to_owned()).to_string()
}

#[cfg(test)]
mod tests;
