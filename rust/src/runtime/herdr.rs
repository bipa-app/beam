//! Herdr-backed remote agent lifecycle.
//!
//! Every handoff owns one named server and one short, uid-scoped socket. The
//! runtime treats liveness as three-valued: presence and absence require
//! machine-readable proof; every unknown outcome fails closed.

use serde::Deserialize;

use super::RuntimeError;
use crate::transport::{ExecResult, Transport};
use crate::util::shell::{shjoin, shq};

const SOCKET_DIR_PREP: &str = concat!(
    r#"dir="${TMPDIR:-/tmp}/herdr-$(id -u)"; mkdir -p -m 700 "$dir" "#,
    r#"&& [ -O "$dir" ] || { echo "beam: herdr socket dir $dir is not owned by uid "#,
    r#"$(id -u); remove it and retry" >&2; exit 1; }"#,
);
const SERVER_PROBES_MAX: u8 = 50;
const SERVER_PROBE_INTERVAL_SECONDS: &str = "0.2";
const _: () = assert!(SERVER_PROBES_MAX as u16 * 200 == 10_000);

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

    pub async fn start(
        &self,
        name: &str,
        cwd_abs: &str,
        argv: &[String],
    ) -> Result<(), RuntimeError> {
        self.transport
            .exec_checked(&agent_start_upload_command(cwd_abs, argv))
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
        let pane_id = match root_pane_id(&created) {
            Some(pane_id) => pane_id,
            None => {
                let detail = if created.trim().is_empty() {
                    "(no output)"
                } else {
                    created.trim()
                };
                return Err(RuntimeError::message(format!(
                    "herdr workspace create for {name} returned no root pane id: {detail}"
                )));
            }
        };
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
        Ok(())
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

fn agent_start_upload_command(cwd_abs: &str, argv: &[String]) -> String {
    let argv_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    let script = format!(
        "{}; code=$?; echo; echo \"[beam] agent exited ($code) - shell below\"",
        shjoin(&argv_refs)
    );
    let beam_dir = format!("{cwd_abs}/.beam");
    format!(
        "mkdir -p {} && printf '%s\\n' {} > {}",
        shq(&beam_dir),
        shq(&script),
        shq(&format!("{beam_dir}/agent-start.sh"))
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
    vec![
        ("start-upload", agent_start_upload_command(cwd_abs, &argv)),
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
