//! Herdr-backed remote agent lifecycle.
//!
//! Every handoff owns one named server and one short, uid-scoped socket. The
//! runtime treats liveness as three-valued: presence and absence require
//! machine-readable proof; every unknown outcome fails closed.

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use serde::Deserialize;

use super::RuntimeError;
use crate::transport::{ExecResult, OwnedWorkspace, SyncOptions, Transport};
use crate::util::shell::{shjoin, shq};
use crate::workspace::{BEAM_RESERVED_DIR, owned_destination_blocks};

const SOCKET_DIR_PREP: &str = concat!(
    r#"dir="${TMPDIR:-/tmp}/herdr-$(id -u)"; mkdir -p -m 700 "$dir" "#,
    r#"&& [ -O "$dir" ] || { echo "beam: herdr socket dir $dir is not owned by uid "#,
    r#"$(id -u); remove it and retry" >&2; exit 1; }"#,
);
const SERVER_PROBES_MAX: u8 = 50;
const SERVER_PROBE_INTERVAL_SECONDS: &str = "0.2";
const _: () = assert!(SERVER_PROBES_MAX as u16 * 200 == 10_000);
const RUNTIME_ENVIRONMENT_BYTES_MAX: usize = 64 * 1024;
const RUNTIME_ENVIRONMENT_CONSUME_ATTEMPTS_MAX: u8 = 50;

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PreparedRuntimeEnvironment {
    pub path: String,
    pub cwd_abs: String,
    pub owner: String,
}

#[derive(Default)]
pub struct RuntimeStartOptions<'a> {
    pub environment: Option<&'a BTreeMap<String, String>>,
    pub prepared_environment: Option<&'a PreparedRuntimeEnvironment>,
    pub owner: Option<&'a str>,
}

#[derive(Deserialize)]
struct SuccessEnvelope<T> {
    result: T,
}

#[derive(Deserialize)]
struct PaneListResult {
    panes: Vec<Pane>,
}

#[derive(Deserialize)]
struct WorkspaceCreatedResult {
    root_pane: Pane,
}

#[derive(Deserialize)]
struct Pane {
    pane_id: String,
}

pub struct HerdrRuntime<'a> {
    transport: &'a dyn Transport,
}

impl<'a> HerdrRuntime<'a> {
    pub const fn new(transport: &'a dyn Transport) -> Self {
        Self { transport }
    }

    pub async fn prepare_environment(
        &self,
        cwd_abs: &str,
        environment: &BTreeMap<String, String>,
        owner: Option<&str>,
    ) -> Result<Option<PreparedRuntimeEnvironment>, RuntimeError> {
        let text = runtime_environment_text(environment)?;
        if text.is_empty() {
            return Ok(None);
        }
        let owner = owner.ok_or_else(|| {
            RuntimeError::message(
                "runtime environment delivery requires workspace ownership bytes".to_owned(),
            )
        })?;
        let temporary = tempfile::Builder::new()
            .prefix("beam-runtime-env-")
            .tempdir()?;
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700))?;
        let environment_file = temporary.path().join("environment");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&environment_file)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        let prepared = PreparedRuntimeEnvironment {
            path: format!("{cwd_abs}/.beam/runtime-environment/environment"),
            cwd_abs: cwd_abs.to_owned(),
            owner: owner.to_owned(),
        };
        let result = async {
            self.transport
                .sync_up(
                    temporary.path(),
                    &format!("{cwd_abs}/.beam/runtime-environment"),
                    SyncOptions {
                        checksum: true,
                        owned: Some(OwnedWorkspace {
                            root: cwd_abs,
                            owner_bytes: owner,
                        }),
                        ..SyncOptions::default()
                    },
                )
                .await?;
            self.transport
                .exec_checked(&environment_secure_script(&prepared)?)
                .await?;
            Ok::<(), RuntimeError>(())
        }
        .await;
        match result {
            Ok(()) => Ok(Some(prepared)),
            Err(error) => Err(self
                .error_after_environment_discard(Some(&prepared), error)
                .await),
        }
    }

    pub async fn discard_environment(
        &self,
        prepared: Option<&PreparedRuntimeEnvironment>,
    ) -> Result<(), RuntimeError> {
        let Some(prepared) = prepared else {
            return Ok(());
        };
        self.transport
            .exec_checked(&environment_discard_script(prepared)?)
            .await?;
        Ok(())
    }

    pub async fn start(
        &self,
        name: &str,
        cwd_abs: &str,
        argv: &[String],
    ) -> Result<(), RuntimeError> {
        self.start_with_options(name, cwd_abs, argv, RuntimeStartOptions::default())
            .await
    }

    pub async fn start_with_options(
        &self,
        name: &str,
        cwd_abs: &str,
        argv: &[String],
        options: RuntimeStartOptions<'_>,
    ) -> Result<(), RuntimeError> {
        if options.environment.is_some() && options.prepared_environment.is_some() {
            return Err(RuntimeError::message(
                "runtime start cannot stage and reuse an environment simultaneously".to_owned(),
            ));
        }
        let prepared = match options.prepared_environment {
            Some(prepared) => Some(prepared.clone()),
            None => {
                let empty = BTreeMap::new();
                self.prepare_environment(
                    cwd_abs,
                    options.environment.unwrap_or(&empty),
                    options.owner,
                )
                .await?
            }
        };
        self.start_prepared(name, cwd_abs, argv, prepared.as_ref())
            .await
    }

    async fn start_prepared(
        &self,
        name: &str,
        cwd_abs: &str,
        argv: &[String],
        prepared: Option<&PreparedRuntimeEnvironment>,
    ) -> Result<(), RuntimeError> {
        let mut workspace_created = false;
        let result = async {
            self.transport
                .exec_checked(&agent_start_upload_command(
                    cwd_abs,
                    argv,
                    prepared.map(|value| value.path.as_str()),
                ))
                .await?;
            self.transport
                .exec_checked(&ensure_server_script(name))
                .await?;
            let created = self
                .transport
                .exec_checked(&herdr_command(
                    name,
                    &format!("workspace create --cwd {} --no-focus", shq(cwd_abs)),
                ))
                .await?;
            workspace_created = true;
            let pane_id = parsed_root_pane(name, &created)?;
            self.transport
                .exec_checked(&herdr_command(
                    name,
                    &format!(
                        "pane run {} {}",
                        shq(&pane_id),
                        shq("bash .beam/agent-start.sh")
                    ),
                ))
                .await?;
            if let Some(prepared) = prepared {
                self.transport
                    .exec_checked(&environment_consume_script(&prepared.path))
                    .await?;
            }
            Ok::<(), RuntimeError>(())
        }
        .await;
        match result {
            Ok(()) => Ok(()),
            Err(error) => {
                self.start_error_after_cleanup(name, prepared, workspace_created, error)
                    .await
            }
        }
    }

    async fn start_error_after_cleanup(
        &self,
        name: &str,
        prepared: Option<&PreparedRuntimeEnvironment>,
        workspace_created: bool,
        error: RuntimeError,
    ) -> Result<(), RuntimeError> {
        let mut cleanup_errors = Vec::new();
        let kill_result = if workspace_created {
            self.kill(name).await
        } else {
            Ok(())
        };
        if let Err(cleanup) = kill_result {
            cleanup_errors.push(cleanup);
        }
        if let Err(cleanup) = self.discard_environment(prepared).await {
            cleanup_errors.push(cleanup);
        }
        if cleanup_errors.is_empty() {
            return Err(RuntimeError::retryable_start(error));
        }
        Err(runtime_cleanup_error(
            "runtime start failed without proven cleanup",
            error,
            cleanup_errors,
        ))
    }

    async fn error_after_environment_discard(
        &self,
        prepared: Option<&PreparedRuntimeEnvironment>,
        error: RuntimeError,
    ) -> RuntimeError {
        match self.discard_environment(prepared).await {
            Ok(()) => error,
            Err(cleanup) => runtime_cleanup_error(
                "runtime credential operation and guarded cleanup both failed",
                error,
                vec![cleanup],
            ),
        }
    }

    pub async fn alive(&self, name: &str) -> Result<bool, RuntimeError> {
        let result = self
            .transport
            .exec(&herdr_command(name, "pane list"))
            .await?;
        if result.code == 0 {
            return match pane_ids(&result.stdout) {
                Some(ids) => Ok(!ids.is_empty()),
                None => Err(RuntimeError::message(format!(
                    "cannot determine whether herdr session {name} is alive (pane list succeeded \
                     with unparseable output): {}",
                    detail(&result)
                ))),
            };
        }
        if proves_server_down(&result) {
            return Ok(false);
        }
        Err(RuntimeError::message(format!(
            "cannot determine whether herdr session {name} is alive (pane list exited {}): {}",
            result.code,
            detail(&result)
        )))
    }

    pub async fn peek(&self, name: &str, lines: usize) -> Result<String, RuntimeError> {
        let pane_id = self.root_pane(name).await?;
        let output = self
            .transport
            .exec_checked(&herdr_command(
                name,
                &format!(
                    "pane read {} --source visible --lines {lines} --format text",
                    shq(&pane_id)
                ),
            ))
            .await?;
        let rows: Vec<&str> = output
            .split('\n')
            .filter(|row| !row.trim().is_empty())
            .collect();
        let start = if lines == 0 {
            0
        } else {
            rows.len().saturating_sub(lines)
        };
        Ok(rows[start..].join("\n"))
    }

    pub async fn interrupt(&self, name: &str) -> Result<(), RuntimeError> {
        let list = self
            .transport
            .exec(&herdr_command(name, "pane list"))
            .await?;
        let pane_id = if list.code == 0 {
            pane_ids(&list.stdout).and_then(|ids| ids.into_iter().next())
        } else {
            None
        };
        let pane_id = match pane_id {
            Some(pane_id) => pane_id,
            None => {
                if !self.alive(name).await? {
                    return Ok(());
                }
                return Err(RuntimeError::message(format!(
                    "herdr interrupt of {name} failed: cannot resolve pane ({})",
                    detail(&list)
                )));
            }
        };
        let result = self
            .transport
            .exec(&herdr_command(
                name,
                &format!("pane send-keys {} ctrl+c", shq(&pane_id)),
            ))
            .await?;
        if result.code == 0 {
            return Ok(());
        }
        if !self.alive(name).await? {
            return Ok(());
        }
        Err(RuntimeError::message(format!(
            "herdr interrupt of {name} failed (exit {}): {}",
            result.code,
            detail(&result)
        )))
    }

    pub async fn kill(&self, name: &str) -> Result<(), RuntimeError> {
        let stop = self
            .transport
            .exec(&herdr_command(name, "server stop"))
            .await?;
        if stop.code != 0 && self.alive(name).await? {
            return Err(RuntimeError::message(format!(
                "herdr kill of {name} failed and the session is still alive (stop exited {}): {}",
                stop.code,
                detail(&stop)
            )));
        }
        let delete = self
            .transport
            .exec(&herdr_command(
                name,
                &format!("session delete {} --json", shq(name)),
            ))
            .await?;
        if delete.code == 0 || proves_server_down(&delete) {
            return Ok(());
        }
        if !self.alive(name).await? {
            return Ok(());
        }
        Err(RuntimeError::message(format!(
            "herdr kill of {name} failed and the session is still alive (delete exited {}): {}",
            delete.code,
            detail(&delete)
        )))
    }

    pub fn attach_command(&self, name: &str) -> String {
        attach_command_for(name)
    }

    async fn root_pane(&self, name: &str) -> Result<String, RuntimeError> {
        let output = self
            .transport
            .exec_checked(&herdr_command(name, "pane list"))
            .await?;
        match pane_ids(&output) {
            Some(ids) => match ids.into_iter().next() {
                Some(pane_id) => Ok(pane_id),
                None => Err(RuntimeError::message(format!(
                    "herdr session {name} has no panes"
                ))),
            },
            None => Err(RuntimeError::message(format!(
                "herdr pane list for {name} returned unparseable output"
            ))),
        }
    }
}

fn runtime_environment_text(
    environment: &BTreeMap<String, String>,
) -> Result<String, RuntimeError> {
    let mut assignments = Vec::with_capacity(environment.len());
    for (name, value) in environment {
        if !is_safe_environment_name(name) {
            return Err(RuntimeError::message(format!(
                "runtime environment variable has an unsafe name: {name}"
            )));
        }
        if name != "CLAUDE_CODE_OAUTH_TOKEN" && name != "LLM_PROXY_SESSION_TOKEN" {
            return Err(RuntimeError::message(format!(
                "runtime environment variable is not allowed: {name}"
            )));
        }
        if value.contains('\0') {
            return Err(RuntimeError::message(format!(
                "runtime environment variable {name} contains a null byte"
            )));
        }
        assignments.push(format!("{name}={}", shq(value)));
    }
    let text = if assignments.is_empty() {
        String::new()
    } else {
        format!("{}\n", assignments.join("\n"))
    };
    if text.len() > RUNTIME_ENVIRONMENT_BYTES_MAX {
        return Err(RuntimeError::message(format!(
            "runtime environment exceeds {RUNTIME_ENVIRONMENT_BYTES_MAX} bytes — refusing to \
             stage it"
        )));
    }
    Ok(text)
}

fn is_safe_environment_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    if !first.is_ascii_uppercase() {
        return false;
    }
    bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn environment_secure_script(
    prepared: &PreparedRuntimeEnvironment,
) -> Result<String, RuntimeError> {
    let refuse = r#"echo "beam: cannot secure runtime credentials" >&2; exit 69"#;
    let mut lines = vec![format!(
        "cd -P -- {} 2>/dev/null || {{ {refuse}; }}",
        shq(&prepared.cwd_abs)
    )];
    lines.extend(
        owned_destination_blocks(
            &prepared.owner,
            &[BEAM_RESERVED_DIR, "runtime-environment"],
            false,
        )
        .map_err(|error| RuntimeError::message(error.to_string()))?,
    );
    lines.extend([
        format!("[ ! -L environment ] && [ -f environment ] || {{ {refuse}; }}"),
        format!("chmod 600 environment || {{ {refuse}; }}"),
        format!(r#"[ -n "$(find environment -prune -type f -perm 600)" ] || {{ {refuse}; }}"#),
    ]);
    Ok(lines.join("\n"))
}

fn environment_discard_script(
    prepared: &PreparedRuntimeEnvironment,
) -> Result<String, RuntimeError> {
    let refuse = r#"echo "beam: cannot enter the runtime credential workspace" >&2; exit 68"#;
    let mut lines = vec![format!(
        "cd -P -- {} 2>/dev/null || {{ {refuse}; }}",
        shq(&prepared.cwd_abs)
    )];
    lines.extend(
        owned_destination_blocks(
            &prepared.owner,
            &[BEAM_RESERVED_DIR, "runtime-environment"],
            true,
        )
        .map_err(|error| RuntimeError::message(error.to_string()))?,
    );
    lines.push(
        r#"rm -f -- environment || { echo "beam: cannot remove runtime credentials" >&2; exit 68; }"#
            .to_owned(),
    );
    lines.push(
        r#"[ ! -e environment ] && [ ! -L environment ] || { echo "beam: runtime credentials still exist after cleanup" >&2; exit 68; }"#
            .to_owned(),
    );
    Ok(lines.join("\n"))
}

fn environment_consume_script(environment_file: &str) -> String {
    let quoted = shq(environment_file);
    [
        "attempts=0".to_owned(),
        format!("while [ -e {quoted} ] || [ -L {quoted} ]; do"),
        "  attempts=$((attempts + 1))".to_owned(),
        format!(r#"  if [ "$attempts" -ge {RUNTIME_ENVIRONMENT_CONSUME_ATTEMPTS_MAX} ]; then"#),
        r#"    echo "beam: coding client did not consume its runtime environment" >&2"#.to_owned(),
        "    exit 1".to_owned(),
        "  fi".to_owned(),
        "  sleep 0.1".to_owned(),
        "done".to_owned(),
    ]
    .join("\n")
}

fn parsed_root_pane(name: &str, created: &str) -> Result<String, RuntimeError> {
    match root_pane_id(created) {
        Some(pane_id) => Ok(pane_id),
        None => {
            let detail = if created.trim().is_empty() {
                "(no output)"
            } else {
                created.trim()
            };
            Err(RuntimeError::message(format!(
                "herdr workspace create for {name} returned no root pane id: {detail}"
            )))
        }
    }
}

fn runtime_cleanup_error(
    context: &str,
    original: RuntimeError,
    cleanup_errors: Vec<RuntimeError>,
) -> RuntimeError {
    let cleanup = cleanup_errors
        .into_iter()
        .map(|error| error.to_string())
        .collect::<Vec<_>>()
        .join("; ");
    RuntimeError::message(format!("{context}: {original}; cleanup failed: {cleanup}"))
}

fn detail(result: &ExecResult) -> &str {
    let text = if result.stderr.is_empty() {
        result.stdout.trim()
    } else {
        result.stderr.trim()
    };
    if text.is_empty() { "(no output)" } else { text }
}

fn proves_server_down(result: &ExecResult) -> bool {
    const CODE: &str = "\"code\":\"server_not_running\"";
    result.stderr.contains(CODE) || result.stdout.contains(CODE)
}

fn pane_ids(stdout: &str) -> Option<Vec<String>> {
    let envelope: SuccessEnvelope<PaneListResult> = serde_json::from_str(stdout).ok()?;
    let mut ids = Vec::with_capacity(envelope.result.panes.len());
    for pane in envelope.result.panes {
        if pane.pane_id.is_empty() {
            return None;
        }
        ids.push(pane.pane_id);
    }
    Some(ids)
}

fn root_pane_id(stdout: &str) -> Option<String> {
    let envelope: SuccessEnvelope<WorkspaceCreatedResult> = serde_json::from_str(stdout).ok()?;
    if envelope.result.root_pane.pane_id.is_empty() {
        return None;
    }
    Some(envelope.result.root_pane.pane_id)
}

fn sock_env(name: &str) -> String {
    format!(
        "HERDR_SESSION={} HERDR_SOCKET_PATH=\"$dir/{name}.sock\"",
        shq(name)
    )
}

fn herdr_command(name: &str, rest: &str) -> String {
    format!("{SOCKET_DIR_PREP}; {} herdr {rest}", sock_env(name))
}

fn ensure_server_script(name: &str) -> String {
    let env = sock_env(name);
    let probe = format!("{env} herdr pane list >/dev/null 2>&1");
    let spawn = format!("nohup env {env} herdr server >/dev/null 2>&1 &");
    [
        SOCKET_DIR_PREP.to_owned(),
        format!("if ! {probe}; then"),
        format!("  {spawn}"),
        "  tries=0".to_owned(),
        format!("  until {probe}; do"),
        "    tries=$((tries + 1))".to_owned(),
        format!("    if [ \"$tries\" -ge {SERVER_PROBES_MAX} ]; then"),
        format!(
            "      echo \"beam: herdr server for session {name} did not answer after 50 probes \
             (10s)\" >&2"
        ),
        "      exit 1".to_owned(),
        "    fi".to_owned(),
        format!("    sleep {SERVER_PROBE_INTERVAL_SECONDS}"),
        "  done".to_owned(),
        "fi".to_owned(),
    ]
    .join("\n")
}

fn agent_start_upload_command(
    cwd_abs: &str,
    argv: &[String],
    environment_file: Option<&str>,
) -> String {
    let script = agent_start_script(argv, environment_file);
    let beam_dir = format!("{cwd_abs}/.beam");
    format!(
        "mkdir -p {} && printf '%s\\n' {} > {}",
        shq(&beam_dir),
        shq(&script),
        shq(&format!("{beam_dir}/agent-start.sh"))
    )
}

fn agent_start_script(argv: &[String], environment_file: Option<&str>) -> String {
    let environment_prelude = match environment_file {
        None => String::new(),
        Some(environment_file) => [
            format!("__beam_env_file={}", shq(environment_file)),
            r#"[ -f "$__beam_env_file" ] || { echo "beam: runtime credential environment is missing" >&2; exit 66; }"#.to_owned(),
            "set -a".to_owned(),
            r#". "$__beam_env_file""#.to_owned(),
            "__beam_env_rc=$?".to_owned(),
            "set +a".to_owned(),
            r#"rm -f -- "$__beam_env_file" || { echo "beam: could not remove runtime credential environment" >&2; exit 67; }"#.to_owned(),
            r#"if [ -e "$__beam_env_file" ] || [ -L "$__beam_env_file" ]; then echo "beam: runtime credential environment still exists after removal" >&2; exit 67; fi"#.to_owned(),
            r#"[ "$__beam_env_rc" -eq 0 ] || exit "$__beam_env_rc""#.to_owned(),
            "unset __beam_env_file __beam_env_rc".to_owned(),
        ]
        .join("; ")
            + "; ",
    };
    let argv_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    format!(
        "{environment_prelude}{}; code=$?; echo; echo \"[beam] agent exited ($code) - shell below\"",
        shjoin(&argv_refs)
    )
}

fn attach_command_for(name: &str) -> String {
    let attach = format!(
        "HERDR_SESSION={name} HERDR_SOCKET_PATH=\"$dir/{name}.sock\" exec herdr session attach \
         {name}"
    );
    format!("bash -c '{SOCKET_DIR_PREP}; {attach}'")
}

/// Fixed generated-command corpus consumed by the side-by-side parity test.
pub fn herdr_script_golden() -> Vec<(&'static str, String)> {
    let name = "beam-parity";
    let cwd_abs = "/srv/beam/work space";
    let argv = vec![
        "omp".to_owned(),
        "--resume".to_owned(),
        "session 'x'".to_owned(),
    ];
    let pane_list = herdr_command(name, "pane list");
    let prepared = PreparedRuntimeEnvironment {
        path: format!("{cwd_abs}/.beam/runtime-environment/environment"),
        cwd_abs: cwd_abs.to_owned(),
        owner: "record=parity\nworkspace_token=owner\n".to_owned(),
    };
    vec![
        (
            "start-upload",
            agent_start_upload_command(cwd_abs, &argv, None),
        ),
        ("start-ensure-server", ensure_server_script(name)),
        (
            "start-workspace-create",
            herdr_command(
                name,
                &format!("workspace create --cwd {} --no-focus", shq(cwd_abs)),
            ),
        ),
        (
            "start-pane-run",
            herdr_command(name, "pane run 'w1:p1' 'bash .beam/agent-start.sh'"),
        ),
        (
            "environment-secure",
            environment_secure_script(&prepared)
                .expect("the fixed runtime environment destination is valid"),
        ),
        (
            "environment-start-upload",
            agent_start_upload_command(cwd_abs, &argv, Some(&prepared.path)),
        ),
        (
            "environment-start-ensure-server",
            ensure_server_script(name),
        ),
        (
            "environment-start-workspace-create",
            herdr_command(
                name,
                &format!("workspace create --cwd {} --no-focus", shq(cwd_abs)),
            ),
        ),
        (
            "environment-start-pane-run",
            herdr_command(name, "pane run 'w1:p1' 'bash .beam/agent-start.sh'"),
        ),
        (
            "environment-consume",
            environment_consume_script(&prepared.path),
        ),
        (
            "environment-discard",
            environment_discard_script(&prepared)
                .expect("the fixed runtime environment destination is valid"),
        ),
        ("alive-present-list", pane_list.clone()),
        ("alive-absent-list", pane_list.clone()),
        ("peek-pane-list", pane_list.clone()),
        (
            "peek-pane-read",
            herdr_command(
                name,
                "pane read 'w1:p1' --source visible --lines 2 --format text",
            ),
        ),
        ("interrupt-pane-list", pane_list),
        (
            "interrupt-send-keys",
            herdr_command(name, "pane send-keys 'w1:p1' ctrl+c"),
        ),
        ("kill-server-stop", herdr_command(name, "server stop")),
        (
            "kill-session-delete",
            herdr_command(name, "session delete 'beam-parity' --json"),
        ),
        ("attach-command", attach_command_for(name)),
    ]
}
