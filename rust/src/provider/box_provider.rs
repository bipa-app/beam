//! Managed box.ascii.dev lifecycle over Beam's pinned SSH transport.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::time::sleep;

use crate::config::BoxTargetSpec;
use crate::provider::managed_ssh::{ManagedLinuxBootstrapOptions, bootstrap_managed_linux};
use crate::provider::{
    BoxSandboxState, ManagedSandboxState, ProviderCheckReport, ProviderError, ProviderFuture,
    SandboxPersist, SandboxProvider, SandboxRef, SandboxState, TransportHandle,
};
use crate::transport::ssh::{SshTransport, SshTransportOptions};
use crate::util::shell::{RunOptions, RunResult, run, which};

const BOX_COMMAND_TIMEOUT: Duration = Duration::from_secs(300);
const BOX_OUTPUT_BYTES_MAX: usize = 1024 * 1024;
const BOX_OUTPUT_LINES_MAX: usize = 256;
const BOX_READY_ATTEMPTS_MAX: u64 = 300;
const BOX_READY_POLL_MS: u64 = 1_000;
const BOX_TTL_SECONDS_MAX: u64 = 30 * 24 * 60 * 60;

struct BoxConnection {
    id: String,
    ip: String,
}

struct NewProgress<'a> {
    reference: &'a mut SandboxRef,
    persist: Option<&'a mut SandboxPersist<'a>>,
    created: Option<BoxSandboxState>,
    ready: Option<BoxConnection>,
    error: Option<String>,
    line_error: Option<ProviderError>,
}

#[derive(Debug)]
struct BoxCliError {
    message: String,
    box_code: Option<String>,
    source: Option<Box<dyn Error + Send + Sync>>,
}

impl Display for BoxCliError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for BoxCliError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source
            .as_deref()
            .map(|source| source as &(dyn Error + 'static))
    }
}

pub struct BoxProvider {
    spec: BoxTargetSpec,
    binary: String,
    #[cfg(test)]
    command_environment: Option<BTreeMap<String, String>>,
}

impl BoxProvider {
    pub fn new(spec: BoxTargetSpec) -> Result<Self, ProviderError> {
        Self::with_binary(spec, "box".to_owned())
    }

    fn with_binary(spec: BoxTargetSpec, binary: String) -> Result<Self, ProviderError> {
        if let Some(machine_type) = spec.machine_type.as_deref()
            && !matches!(machine_type, "small" | "default" | "large")
        {
            return Err(ProviderError::message(format!(
                "box target machineType is invalid: {}",
                json_string(machine_type)
            )));
        }
        if spec
            .environment
            .as_ref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err(ProviderError::message(
                "box target environment cannot be empty".to_owned(),
            ));
        }
        if spec.ttl_seconds == Some(0) {
            return Err(ProviderError::message(
                "box target ttlSeconds must be a positive integer, got 0".to_owned(),
            ));
        }
        if spec
            .ttl_seconds
            .is_some_and(|seconds| seconds > BOX_TTL_SECONDS_MAX)
        {
            return Err(ProviderError::message(format!(
                "box target ttlSeconds exceeds Box's 30-day ceiling: {}",
                spec.ttl_seconds.unwrap_or_default()
            )));
        }
        Ok(Self {
            spec,
            binary,
            #[cfg(test)]
            command_environment: None,
        })
    }

    fn typed_sandbox_state(
        &self,
        reference: &SandboxRef,
    ) -> Result<Option<BoxSandboxState>, ProviderError> {
        let Some(persisted) = reference.sandbox.as_ref() else {
            return Ok(None);
        };
        let SandboxState::Managed(ManagedSandboxState::Box(state)) = persisted else {
            return Err(ProviderError::message(format!(
                "handoff {} stores an Agent Sandbox identity but its target snapshot is box — \
                 state.json tampered or corrupted?",
                reference.id
            )));
        };
        assert_box_id(&Value::String(state.box_id.clone()), "persisted box id")?;
        Ok(Some(state.clone()))
    }

    async fn provision_inner<'a>(
        &'a self,
        reference: &'a mut SandboxRef,
        persist: Option<&'a mut SandboxPersist<'a>>,
    ) -> Result<TransportHandle, ProviderError> {
        if self.typed_sandbox_state(reference)?.is_some() {
            return self.connect_inner(Some(reference)).await;
        }
        let connection = self.create(reference, persist).await?;
        let transport = self.transport(connection).await?;
        bootstrap_managed_linux(
            &transport,
            ManagedLinuxBootstrapOptions {
                provider: "Box",
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
                "no live Box for this target — run `beam up` to provision one first".to_owned(),
            )
        })?;
        let state = self.typed_sandbox_state(reference)?.ok_or_else(|| {
            ProviderError::message(format!(
                "handoff {} has no persisted Box id — provisioning did not reach creation; \
                 run `beam up` to retry",
                reference.id
            ))
        })?;
        let connection = self.wait_ready(&state).await?;
        Ok(Rc::new(self.transport(connection).await?))
    }

    async fn destroy_inner(&self, reference: &SandboxRef) -> Result<(), ProviderError> {
        let Some(state) = self.typed_sandbox_state(reference)? else {
            return Ok(());
        };
        if self
            .ignore_absent(
                self.box_json(
                    &["info", &state.box_id, "--json"],
                    &format!("inspect {}", state.box_id),
                )
                .await,
            )?
            .is_none()
        {
            return Ok(());
        }
        self.ignore_absent(
            self.box_json(
                &["delete", &state.box_id, "--yes", "--json"],
                &format!("delete {}", state.box_id),
            )
            .await,
        )?;
        Ok(())
    }

    async fn check_inner(&self) -> Result<ProviderCheckReport, ProviderError> {
        let box_exists = if self.binary.contains('/') {
            Path::new(&self.binary).exists()
        } else {
            which(&self.binary, self.command_environment()).is_some()
        };
        let mut lines = vec![format!(
            "Box CLI:     {}",
            if box_exists { &self.binary } else { "MISSING" }
        )];
        lines.push(format!("local ssh:   {}", self.tool_path("ssh")));
        lines.push(format!("local rsync: {}", self.tool_path("rsync")));
        if !box_exists {
            return Ok(ProviderCheckReport {
                lines,
                fatal: Some(
                    "install Box with `curl -fsSL https://box.ascii.dev/install | sh`, then run \
                     `box onboard`"
                        .to_owned(),
                ),
            });
        }
        let status = self.run_box(&["limits", "--json"], None).await?;
        if status.code != 0 {
            return Ok(ProviderCheckReport {
                lines,
                fatal: Some(
                    "Box is not ready — run `box onboard`, then retry `beam check`".to_owned(),
                ),
            });
        }
        lines.push("Box account: authenticated and able to read limits".to_owned());
        if self.tool_missing("ssh") || self.tool_missing("rsync") {
            return Ok(ProviderCheckReport {
                lines,
                fatal: Some("install local ssh and rsync before using a Box target".to_owned()),
            });
        }
        Ok(ProviderCheckReport { lines, fatal: None })
    }

    fn create_args(&self) -> Vec<String> {
        let mut arguments = vec!["new".to_owned()];
        if let Some(machine_type) = self.spec.machine_type.as_ref() {
            arguments.extend(["--type".to_owned(), machine_type.clone()]);
        }
        if let Some(environment) = self.spec.environment.as_ref() {
            arguments.push(format!("--environment={environment}"));
        }
        self.push_lifecycle_args(&mut arguments);
        arguments.push("--json".to_owned());
        arguments
    }

    fn resume_args(&self, box_id: &str) -> Vec<String> {
        let mut arguments = vec!["resume".to_owned(), box_id.to_owned()];
        self.push_lifecycle_args(&mut arguments);
        arguments.push("--json".to_owned());
        arguments
    }

    fn push_lifecycle_args(&self, arguments: &mut Vec<String>) {
        match self.spec.ttl_seconds {
            Some(seconds) => arguments.extend(["--ttl".to_owned(), seconds.to_string()]),
            None => arguments.push("--no-auto-stop".to_owned()),
        }
    }

    async fn create<'a>(
        &'a self,
        reference: &'a mut SandboxRef,
        persist: Option<&'a mut SandboxPersist<'a>>,
    ) -> Result<BoxConnection, ProviderError> {
        let progress = RefCell::new(NewProgress {
            reference,
            persist,
            created: None,
            ready: None,
            error: None,
            line_error: None,
        });
        let arguments = self.create_args();
        println!("sandbox: provisioning a Box…");
        let run_result = {
            let observer = |line: &str| {
                let handled = {
                    let mut current = progress.borrow_mut();
                    handle_new_line(&mut current, line)
                };
                match handled {
                    Ok(()) => Ok(()),
                    Err(error) => {
                        progress.borrow_mut().line_error = Some(error);
                        Err("Box provisioning output was rejected".to_owned())
                    }
                }
            };
            self.run_box(&arguments, Some(&observer)).await
        };
        let progress = progress.into_inner();
        if let Some(error) = progress.line_error {
            return Err(error);
        }
        let result = run_result?;
        finish_create(progress, result)
    }

    async fn box_json<S>(
        &self,
        arguments: &[S],
        what: &str,
    ) -> Result<Map<String, Value>, BoxCliError>
    where
        S: AsRef<str>,
    {
        let result = self
            .run_box(arguments, None)
            .await
            .map_err(|error| BoxCliError {
                message: error.to_string(),
                box_code: None,
                source: Some(Box::new(error)),
            })?;
        let mut line_count = 0;
        let mut last_line = None;
        for line in result
            .stdout
            .trim()
            .split('\n')
            .filter(|line| !line.is_empty())
        {
            line_count += 1;
            if line_count > BOX_OUTPUT_LINES_MAX {
                return Err(BoxCliError::message(format!(
                    "Box CLI output exceeded {BOX_OUTPUT_LINES_MAX} lines while trying to {what}"
                )));
            }
            last_line = Some(line);
        }
        let value = match last_line {
            Some(line) => Some(parse_json_record(line, what).map_err(BoxCliError::from_provider)?),
            None => None,
        };
        if result.code != 0 {
            return Err(box_exit_error(result, value.as_ref(), what));
        }
        value.ok_or_else(|| {
            BoxCliError::message(format!("Box CLI returned no JSON while trying to {what}"))
        })
    }

    async fn box_info(&self, state: &BoxSandboxState) -> Result<Map<String, Value>, ProviderError> {
        let mut value = self
            .box_json(
                &["info", &state.box_id, "--json"],
                &format!("inspect {}", state.box_id),
            )
            .await
            .map_err(provider_box_error)?;
        let record = match value.remove("box") {
            Some(Value::Object(record)) => record,
            None
            | Some(Value::Null)
            | Some(Value::Bool(_))
            | Some(Value::Number(_))
            | Some(Value::String(_))
            | Some(Value::Array(_)) => {
                return Err(ProviderError::message(format!(
                    "Box CLI returned no box object while inspecting {}",
                    state.box_id
                )));
            }
        };
        let id = assert_box_id(record.get("id").unwrap_or(&Value::Null), "info id")?;
        if id != state.box_id {
            return Err(ProviderError::message(format!(
                "Box CLI returned {id} while Beam requested {} — refusing",
                state.box_id
            )));
        }
        Ok(record)
    }

    async fn wait_ready(&self, state: &BoxSandboxState) -> Result<BoxConnection, ProviderError> {
        let mut resumed = false;
        for attempt in 1..=BOX_READY_ATTEMPTS_MAX {
            let record = self.box_info(state).await?;
            let current = record
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("(unreadable)");
            if matches!(current, "ready" | "idle" | "running") {
                return parse_connection(&record, "box info");
            }
            if current == "stopped" && !resumed {
                println!("sandbox: resuming Box {}…", state.box_id);
                let resume_arguments = self.resume_args(&state.box_id);
                self.box_json(&resume_arguments, &format!("resume {}", state.box_id))
                    .await
                    .map_err(provider_box_error)?;
                resumed = true;
            } else if current == "error" {
                return Err(ProviderError::message(format!(
                    "Box {} is in error state — inspect it with `box info`",
                    state.box_id
                )));
            }
            if attempt < BOX_READY_ATTEMPTS_MAX {
                sleep(Duration::from_millis(BOX_READY_POLL_MS)).await;
            }
        }
        Err(ProviderError::message(format!(
            "Box {} did not become ready after {}ms",
            state.box_id,
            BOX_READY_ATTEMPTS_MAX * BOX_READY_POLL_MS
        )))
    }

    async fn transport(&self, connection: BoxConnection) -> Result<SshTransport, ProviderError> {
        let authorization = self
            .run_box(&["ssh", &connection.id, "--", "true"], None)
            .await?;
        if authorization.code != 0 {
            let detail = output_detail(&authorization);
            return Err(ProviderError::message(format!(
                "Box {} SSH setup failed: {detail}",
                connection.id
            )));
        }
        let identity = self.home_dir().join(".ssh").join("ascii_box_ed25519");
        let transport = SshTransport::with_options(
            format!("user@{}", connection.ip),
            SshTransportOptions {
                rsync_flags: None,
                label: Some(format!("box {}", connection.id)),
                ssh_options: vec![
                    "-i".to_owned(),
                    identity.display().to_string(),
                    "-o".to_owned(),
                    "IdentitiesOnly=yes".to_owned(),
                    "-o".to_owned(),
                    "BatchMode=yes".to_owned(),
                    "-o".to_owned(),
                    "StrictHostKeyChecking=accept-new".to_owned(),
                    "-o".to_owned(),
                    format!("HostKeyAlias={}", connection.id),
                ],
            },
        )
        .map_err(|source| {
            ProviderError::caused_by("could not construct Box SSH transport".to_owned(), source)
        })?;
        #[cfg(test)]
        let mut transport = transport;
        #[cfg(test)]
        if let Some(environment) = self.command_environment.clone() {
            transport.set_command_environment(environment);
        }
        Ok(transport)
    }

    async fn run_box<S>(
        &self,
        arguments: &[S],
        observer: Option<&crate::util::shell::OutputLineObserver<'_>>,
    ) -> Result<RunResult, ProviderError>
    where
        S: AsRef<str>,
    {
        let mut argv = Vec::with_capacity(arguments.len() + 1);
        argv.push(self.binary.as_str());
        argv.extend(arguments.iter().map(AsRef::as_ref));
        run(
            &argv,
            &RunOptions {
                base_env: self.command_environment(),
                max_output_bytes: BOX_OUTPUT_BYTES_MAX,
                max_output_lines: observer.map(|_| BOX_OUTPUT_LINES_MAX),
                stdout_line_observer: observer,
                timeout: BOX_COMMAND_TIMEOUT,
                ..RunOptions::default()
            },
        )
        .await
        .map_err(|source| {
            let message = source.to_string();
            ProviderError::caused_by(message, source)
        })
    }

    fn ignore_absent<T>(&self, result: Result<T, BoxCliError>) -> Result<Option<T>, ProviderError> {
        match result {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.box_code.as_deref() == Some("not_found") => Ok(None),
            Err(error) => Err(provider_box_error(error)),
        }
    }

    fn tool_path(&self, tool: &str) -> String {
        which(tool, self.command_environment())
            .map_or_else(|| "MISSING".to_owned(), |path| path.display().to_string())
    }

    fn tool_missing(&self, tool: &str) -> bool {
        which(tool, self.command_environment()).is_none()
    }

    fn home_dir(&self) -> PathBuf {
        #[cfg(test)]
        if let Some(home) = self
            .command_environment
            .as_ref()
            .and_then(|environment| environment.get("HOME"))
        {
            return PathBuf::from(home);
        }
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"))
    }

    fn command_environment(&self) -> Option<&BTreeMap<String, String>> {
        #[cfg(test)]
        {
            self.command_environment.as_ref()
        }
        #[cfg(not(test))]
        {
            None
        }
    }
}

impl SandboxProvider for BoxProvider {
    fn label(&self) -> &str {
        "box.ascii.dev"
    }

    fn reuses_sandbox(&self) -> bool {
        false
    }

    fn sandbox_state(&self, reference: &SandboxRef) -> Result<Option<SandboxState>, ProviderError> {
        Ok(self
            .typed_sandbox_state(reference)?
            .map(|state| SandboxState::Managed(ManagedSandboxState::Box(state))))
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
        Box::pin(self.check_inner())
    }
}

fn parse_json_record(text: &str, what: &str) -> Result<Map<String, Value>, ProviderError> {
    let value: Value = serde_json::from_str(text).map_err(|_| {
        ProviderError::message(format!(
            "Box CLI returned malformed JSON for {what}: {text}"
        ))
    })?;
    value.as_object().cloned().ok_or_else(|| {
        ProviderError::message(format!("Box CLI returned non-object JSON for {what}"))
    })
}

fn assert_box_id(value: &Value, what: &str) -> Result<String, ProviderError> {
    let Some(id) = value.as_str() else {
        return Err(ProviderError::message(format!(
            "Box CLI returned malformed {what}: {value}"
        )));
    };
    let valid = id.strip_prefix("bx_").is_some_and(|tail| {
        !tail.is_empty()
            && tail.len() <= 120
            && tail
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    });
    if !valid {
        return Err(ProviderError::message(format!(
            "Box CLI returned malformed {what}: {value}"
        )));
    }
    Ok(id.to_owned())
}

fn parse_connection(
    value: &Map<String, Value>,
    what: &str,
) -> Result<BoxConnection, ProviderError> {
    let id = assert_box_id(
        value.get("id").unwrap_or(&Value::Null),
        &format!("{what} id"),
    )?;
    let ip = value
        .get("ip")
        .and_then(Value::as_str)
        .filter(|address| address.parse::<Ipv4Addr>().is_ok())
        .ok_or_else(|| {
            ProviderError::message(format!(
                "Box CLI returned no usable IPv4 address for {id} during {what}"
            ))
        })?;
    Ok(BoxConnection {
        id,
        ip: ip.to_owned(),
    })
}

fn handle_new_line(progress: &mut NewProgress<'_>, line: &str) -> Result<(), ProviderError> {
    let value = parse_json_record(line, "box new")?;
    if value.get("event").and_then(Value::as_str) == Some("error") {
        progress.error = Some(
            value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or(line)
                .to_owned(),
        );
        return Ok(());
    }
    if value.get("event").and_then(Value::as_str) == Some("created") {
        let next = BoxSandboxState {
            box_id: assert_box_id(value.get("id").unwrap_or(&Value::Null), "created id")?,
        };
        if progress
            .created
            .as_ref()
            .is_some_and(|created| created.box_id != next.box_id)
        {
            return Err(ProviderError::message(
                "Box CLI reported two different ids for one creation".to_owned(),
            ));
        }
        if progress.created.is_none() {
            let state = SandboxState::Managed(ManagedSandboxState::Box(next.clone()));
            progress.created = Some(next);
            progress.reference.sandbox = Some(state.clone());
            if let Some(persist) = progress.persist.as_mut() {
                persist(state)?;
            }
        }
        return Ok(());
    }
    if value.get("event").and_then(Value::as_str) == Some("ready") {
        progress.ready = Some(parse_connection(&value, "ready event")?);
    }
    Ok(())
}

fn finish_create(
    progress: NewProgress<'_>,
    result: RunResult,
) -> Result<BoxConnection, ProviderError> {
    if result.code != 0 {
        let trial_fix = if result.stdout.contains("trial_auto_stop_required") {
            " Set `ttlSeconds: 7200` on the target while using the Box trial."
        } else {
            ""
        };
        let detail = progress.error.as_deref().unwrap_or(result.stderr.trim());
        return Err(ProviderError::message(format!(
            "Box creation failed ({}): {detail}.{trial_fix}",
            result.code
        )));
    }
    let created = progress.created.ok_or_else(|| {
        ProviderError::message(
            "Box creation exited successfully without both created and ready events".to_owned(),
        )
    })?;
    let ready = progress.ready.ok_or_else(|| {
        ProviderError::message(
            "Box creation exited successfully without both created and ready events".to_owned(),
        )
    })?;
    if created.box_id != ready.id {
        return Err(ProviderError::message(
            "Box ready event did not match the id persisted from its created event".to_owned(),
        ));
    }
    println!("sandbox: Box {} ready", ready.id);
    Ok(ready)
}

impl BoxCliError {
    fn message(message: String) -> Self {
        Self {
            message,
            box_code: None,
            source: None,
        }
    }

    fn from_provider(error: ProviderError) -> Self {
        let message = error.to_string();
        Self {
            message,
            box_code: None,
            source: Some(Box::new(error)),
        }
    }
}

fn box_exit_error(
    result: RunResult,
    value: Option<&Map<String, Value>>,
    what: &str,
) -> BoxCliError {
    let code = value
        .and_then(|record| record.get("code"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let detail = value
        .and_then(|record| record.get("error"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let captured = output_detail(&result);
            if captured.is_empty() {
                "no diagnostic output".to_owned()
            } else {
                captured.to_owned()
            }
        });
    BoxCliError {
        message: format!("Box CLI could not {what} ({}): {detail}", result.code),
        box_code: code,
        source: None,
    }
}

fn output_detail(result: &RunResult) -> &str {
    if result.stderr.trim().is_empty() {
        result.stdout.trim()
    } else {
        result.stderr.trim()
    }
}

fn provider_box_error(error: BoxCliError) -> ProviderError {
    let message = error.to_string();
    ProviderError::caused_by(message, error)
}

fn json_string(value: &str) -> String {
    Value::String(value.to_owned()).to_string()
}

#[cfg(test)]
mod tests;
