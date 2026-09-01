//! Goal: prove the Rust herdr runtime preserves start, observation, and
//! termination safety before command orchestration moves from TypeScript.
//!
//! Method: scripted and local transports pin three-valued liveness,
//! read-once credentials, and every race refusal; one optional real-herdr
//! round trip proves the generated commands against the installed binary.

use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use beam::runtime::herdr::{HerdrRuntime, PreparedRuntimeEnvironment, RuntimeStartOptions};
use beam::transport::local::LocalTransport;
use beam::transport::{ExecResult, SyncOptions, Transport, TransportFuture};
use tempfile::tempdir;

const LIVE_PEEK_PROBES_MAX: u8 = 50;
const LIVE_PEEK_INTERVAL: Duration = Duration::from_millis(200);

enum Step {
    Exec {
        expected: &'static str,
        result: ExecResult,
    },
    Checked {
        expected: &'static str,
        output: String,
    },
}

struct ScriptedTransport {
    steps: RefCell<VecDeque<Step>>,
    calls: RefCell<Vec<String>>,
}

impl ScriptedTransport {
    fn new(steps: Vec<Step>) -> Self {
        Self {
            steps: RefCell::new(steps.into()),
            calls: RefCell::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls.borrow().clone()
    }

    fn assert_drained(&self) {
        assert!(
            self.steps.borrow().is_empty(),
            "scripted transport has unused steps"
        );
    }

    fn take(&self, command: &str) -> Step {
        self.calls.borrow_mut().push(command.to_owned());
        self.steps
            .borrow_mut()
            .pop_front()
            .expect("scripted transport call")
    }
}

impl Transport for ScriptedTransport {
    fn label(&self) -> &str {
        "scripted-herdr"
    }

    fn exec<'a>(&'a self, command: &'a str) -> TransportFuture<'a, ExecResult> {
        Box::pin(async move {
            match self.take(command) {
                Step::Exec { expected, result } => {
                    assert!(
                        command.contains(expected),
                        "expected {expected:?}: {command}"
                    );
                    Ok(result)
                }
                Step::Checked { expected, .. } => {
                    panic!("expected checked call containing {expected:?}, got exec: {command}")
                }
            }
        })
    }

    fn exec_checked<'a>(&'a self, command: &'a str) -> TransportFuture<'a, String> {
        Box::pin(async move {
            match self.take(command) {
                Step::Checked { expected, output } => {
                    assert!(
                        command.contains(expected),
                        "expected {expected:?}: {command}"
                    );
                    Ok(output)
                }
                Step::Exec { expected, .. } => {
                    panic!("expected exec call containing {expected:?}, got checked: {command}")
                }
            }
        })
    }

    fn sync_up<'a>(
        &'a self,
        _local_dir: &'a Path,
        _remote_dir: &'a str,
        _options: SyncOptions<'a>,
    ) -> TransportFuture<'a, ()> {
        Box::pin(async { panic!("herdr runtime must not sync up") })
    }

    fn sync_down<'a>(
        &'a self,
        _remote_dir: &'a str,
        _local_dir: &'a Path,
        _options: SyncOptions<'a>,
    ) -> TransportFuture<'a, ()> {
        Box::pin(async { panic!("herdr runtime must not sync down") })
    }

    fn exists<'a>(&'a self, _remote_path: &'a str) -> TransportFuture<'a, bool> {
        Box::pin(async { panic!("herdr runtime must not probe files") })
    }

    fn interactive_argv(&self, _command: &str) -> Vec<String> {
        panic!("herdr runtime test does not attach interactively")
    }
}

fn exec_step(
    expected: &'static str,
    code: i32,
    stdout: impl Into<String>,
    stderr: impl Into<String>,
) -> Step {
    Step::Exec {
        expected,
        result: ExecResult {
            code,
            stdout: stdout.into(),
            stderr: stderr.into(),
        },
    }
}

fn checked_step(expected: &'static str, output: impl Into<String>) -> Step {
    Step::Checked {
        expected,
        output: output.into(),
    }
}

fn pane_list_json(pane_ids: &[&str]) -> String {
    let panes: Vec<serde_json::Value> = pane_ids
        .iter()
        .map(|pane_id| serde_json::json!({ "pane_id": pane_id }))
        .collect();
    serde_json::json!({
        "id": "cli:pane:list",
        "result": { "panes": panes, "type": "pane_list" }
    })
    .to_string()
}
fn workspace_created_json(pane_id: &str) -> String {
    serde_json::json!({
        "id": "cli:workspace:create",
        "result": { "root_pane": { "pane_id": pane_id }, "type": "workspace_created" }
    })
    .to_string()
}

fn server_not_running_json() -> String {
    serde_json::json!({
        "id": "cli:pane:list",
        "error": { "code": "server_not_running", "message": "no server" }
    })
    .to_string()
}

#[tokio::test(flavor = "current_thread")]
async fn start_stops_before_typing_when_workspace_identity_is_unknown() {
    let transport = ScriptedTransport::new(vec![
        checked_step("printf", ""),
        checked_step("herdr server", ""),
        checked_step("workspace create", "not json at all"),
        exec_step("server stop", 0, "", ""),
        exec_step("session delete", 0, "", ""),
    ]);
    let runtime = HerdrRuntime::new(&transport);
    let error = runtime
        .start("beam-test", "/workspace", &["omp".to_owned()])
        .await
        .expect_err("unparseable workspace must fail");
    assert_eq!(
        error.to_string(),
        "runtime start failed and was cleaned up; retry beam up"
    );
    assert!(error.is_retryable_start());
    assert_eq!(transport.calls().len(), 5);
    assert!(
        transport
            .calls()
            .iter()
            .all(|call| !call.contains("pane run"))
    );
    transport.assert_drained();
}

#[tokio::test(flavor = "current_thread")]
async fn prepared_environment_is_consumed_on_success_and_discarded_on_failure() {
    let prepared = PreparedRuntimeEnvironment {
        path: "/workspace/.beam/runtime-environment/environment".to_owned(),
        cwd_abs: "/workspace".to_owned(),
        owner: "beam-workspace-v1 record 0123456789abcdef0123456789abcdef".to_owned(),
    };
    let success = ScriptedTransport::new(vec![
        checked_step("runtime credential environment is missing", ""),
        checked_step("herdr server", ""),
        checked_step("workspace create", workspace_created_json("w1:p1")),
        checked_step("pane run", ""),
        checked_step("coding client did not consume", ""),
    ]);
    HerdrRuntime::new(&success)
        .start_with_options(
            "beam-test",
            "/workspace",
            &["omp".to_owned()],
            RuntimeStartOptions {
                prepared_environment: Some(&prepared),
                ..RuntimeStartOptions::default()
            },
        )
        .await
        .expect("start with prepared environment");
    assert_eq!(success.calls().len(), 5);
    assert!(success.calls()[4].contains("while [ -e"));
    success.assert_drained();

    let failure = ScriptedTransport::new(vec![
        checked_step("runtime credential environment is missing", ""),
        checked_step("herdr server", ""),
        checked_step("workspace create", "not json"),
        exec_step("server stop", 0, "", ""),
        exec_step("session delete", 0, "", ""),
        checked_step("rm -f -- environment", ""),
    ]);
    let error = HerdrRuntime::new(&failure)
        .start_with_options(
            "beam-test",
            "/workspace",
            &["omp".to_owned()],
            RuntimeStartOptions {
                prepared_environment: Some(&prepared),
                ..RuntimeStartOptions::default()
            },
        )
        .await
        .expect_err("failed start must clean up");
    assert!(error.is_retryable_start());
    assert_eq!(failure.calls().len(), 6);
    assert!(failure.calls()[5].contains("runtime credentials still exist"));
    assert!(
        failure
            .calls()
            .iter()
            .all(|call| !call.contains("LLM_PROXY_SESSION_TOKEN"))
    );
    failure.assert_drained();
}

#[tokio::test(flavor = "current_thread")]
async fn runtime_environment_is_private_bounded_and_guardedly_discarded() {
    let temporary = tempdir().expect("temporary transport home");
    let workspace = temporary.path().join("workspace");
    fs::create_dir_all(workspace.join(".beam")).expect("owned workspace");
    let owner = "beam-workspace-v1 record 0123456789abcdef0123456789abcdef";
    fs::write(workspace.join(".beam/owner"), owner).expect("owner marker");
    let transport = LocalTransport::new(temporary.path()).expect("local transport");
    let runtime = HerdrRuntime::new(&transport);
    let environment = BTreeMap::from([
        (
            "LLM_PROXY_SESSION_TOKEN".to_owned(),
            "private 'token'".to_owned(),
        ),
        (
            "CLAUDE_CODE_OAUTH_TOKEN".to_owned(),
            "oauth-token".to_owned(),
        ),
    ]);
    let cwd_abs = workspace.to_str().expect("utf-8 workspace");
    let prepared = runtime
        .prepare_environment(cwd_abs, &environment, Some(owner))
        .await
        .expect("stage environment")
        .expect("non-empty environment");
    let staged = workspace.join(".beam/runtime-environment/environment");
    assert_eq!(
        fs::read_to_string(&staged).expect("staged environment"),
        concat!(
            "CLAUDE_CODE_OAUTH_TOKEN='oauth-token'\n",
            r#"LLM_PROXY_SESSION_TOKEN='private '\''token'\'''"#,
            "\n"
        )
    );
    let mode = fs::metadata(&staged)
        .expect("staged metadata")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600);
    runtime
        .discard_environment(Some(&prepared))
        .await
        .expect("guarded discard");
    assert!(!staged.exists());

    let disallowed = BTreeMap::from([("PATH".to_owned(), "secret".to_owned())]);
    let error = runtime
        .prepare_environment(cwd_abs, &disallowed, Some(owner))
        .await
        .expect_err("unapproved name must fail");
    assert!(error.to_string().contains("is not allowed"));
    let oversized = BTreeMap::from([("LLM_PROXY_SESSION_TOKEN".to_owned(), "x".repeat(64 * 1024))]);
    let error = runtime
        .prepare_environment(cwd_abs, &oversized, Some(owner))
        .await
        .expect_err("oversized environment must fail");
    assert!(error.to_string().contains("exceeds 65536 bytes"));
}

#[tokio::test(flavor = "current_thread")]
async fn alive_returns_only_proven_presence_or_absence() {
    let present = ScriptedTransport::new(vec![exec_step(
        "pane list",
        0,
        pane_list_json(&["w1:p1"]),
        "",
    )]);
    assert!(
        HerdrRuntime::new(&present)
            .alive("s")
            .await
            .expect("present")
    );
    let absent = ScriptedTransport::new(vec![exec_step("pane list", 0, pane_list_json(&[]), "")]);
    assert!(!HerdrRuntime::new(&absent).alive("s").await.expect("absent"));
    let dead = ScriptedTransport::new(vec![exec_step(
        "pane list",
        1,
        "",
        server_not_running_json(),
    )]);
    assert!(!HerdrRuntime::new(&dead).alive("s").await.expect("dead"));

    let malformed = ScriptedTransport::new(vec![exec_step("pane list", 0, "not json", "")]);
    let malformed_error = HerdrRuntime::new(&malformed)
        .alive("s")
        .await
        .expect_err("malformed success must stay unknown");
    assert!(malformed_error.to_string().contains("unparseable output"));
    let denied = ScriptedTransport::new(vec![exec_step("pane list", 255, "", "permission denied")]);
    let denied_error = HerdrRuntime::new(&denied)
        .alive("s")
        .await
        .expect_err("transport failure must stay unknown");
    assert_eq!(
        denied_error.to_string(),
        "cannot determine whether herdr session s is alive (pane list exited 255): permission denied"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn kill_allows_only_separately_proven_absence() {
    let dead_after_stop = ScriptedTransport::new(vec![
        exec_step("server stop", 1, "", "not running"),
        exec_step("pane list", 1, "", server_not_running_json()),
        exec_step("session delete", 0, "", ""),
    ]);
    HerdrRuntime::new(&dead_after_stop)
        .kill("s")
        .await
        .expect("proven-dead stop is idempotent");
    assert_eq!(dead_after_stop.calls().len(), 3);

    let delete_race = ScriptedTransport::new(vec![
        exec_step("server stop", 0, "", ""),
        exec_step("session delete", 1, "", server_not_running_json()),
    ]);
    HerdrRuntime::new(&delete_race)
        .kill("s")
        .await
        .expect("server-down delete is idempotent");
    assert_eq!(delete_race.calls().len(), 2);

    let absent_after_delete = ScriptedTransport::new(vec![
        exec_step("server stop", 0, "", ""),
        exec_step("session delete", 1, "", "denied"),
        exec_step("pane list", 0, pane_list_json(&[]), ""),
    ]);
    HerdrRuntime::new(&absent_after_delete)
        .kill("s")
        .await
        .expect("separately absent delete is idempotent");
    absent_after_delete.assert_drained();
}

#[tokio::test(flavor = "current_thread")]
async fn kill_refuses_live_or_unanswerable_sessions() {
    let alive = ScriptedTransport::new(vec![
        exec_step("server stop", 1, "", "denied"),
        exec_step("pane list", 0, pane_list_json(&["w1:p1"]), ""),
    ]);
    let alive_error = HerdrRuntime::new(&alive)
        .kill("s")
        .await
        .expect_err("live session must not be deleted");
    assert_eq!(
        alive_error.to_string(),
        "herdr kill of s failed and the session is still alive (stop exited 1): denied"
    );
    assert_eq!(alive.calls().len(), 2);

    let unknown = ScriptedTransport::new(vec![
        exec_step("server stop", 255, "", "transport broke"),
        exec_step("pane list", 255, "", "transport broke"),
    ]);
    let unknown_error = HerdrRuntime::new(&unknown)
        .kill("s")
        .await
        .expect_err("unknown liveness must stop cleanup");
    assert!(
        unknown_error
            .to_string()
            .contains("cannot determine whether")
    );
    assert_eq!(unknown.calls().len(), 2);

    let delete_live = ScriptedTransport::new(vec![
        exec_step("server stop", 0, "", ""),
        exec_step("session delete", 1, "", "denied"),
        exec_step("pane list", 0, pane_list_json(&["w1:p1"]), ""),
    ]);
    let delete_error = HerdrRuntime::new(&delete_live)
        .kill("s")
        .await
        .expect_err("failed delete of live session must surface");
    assert!(delete_error.to_string().contains("delete exited 1"));
}

#[tokio::test(flavor = "current_thread")]
async fn interrupt_tolerates_only_a_proven_exit_race() {
    let success = ScriptedTransport::new(vec![
        exec_step("pane list", 0, pane_list_json(&["w1:p1"]), ""),
        exec_step("send-keys", 0, "", ""),
    ]);
    HerdrRuntime::new(&success)
        .interrupt("s")
        .await
        .expect("interrupt succeeds");
    assert_eq!(success.calls().len(), 2);

    let died = ScriptedTransport::new(vec![
        exec_step("pane list", 0, pane_list_json(&["w1:p1"]), ""),
        exec_step("send-keys", 1, "", "missing pane"),
        exec_step("pane list", 1, "", server_not_running_json()),
    ]);
    HerdrRuntime::new(&died)
        .interrupt("s")
        .await
        .expect("proven exit race is idempotent");
    assert_eq!(died.calls().len(), 3);

    let no_pane = ScriptedTransport::new(vec![
        exec_step("pane list", 0, pane_list_json(&[]), ""),
        exec_step("pane list", 0, pane_list_json(&[]), ""),
    ]);
    HerdrRuntime::new(&no_pane)
        .interrupt("s")
        .await
        .expect("proven pane absence is idempotent");
}

#[tokio::test(flavor = "current_thread")]
async fn interrupt_refuses_unknown_or_live_failures() {
    let unresolved = ScriptedTransport::new(vec![
        exec_step("pane list", 1, "", "denied"),
        exec_step("pane list", 0, pane_list_json(&["w1:p1"]), ""),
    ]);
    let unresolved_error = HerdrRuntime::new(&unresolved)
        .interrupt("s")
        .await
        .expect_err("unresolved live pane must fail");
    assert_eq!(
        unresolved_error.to_string(),
        "herdr interrupt of s failed: cannot resolve pane (denied)"
    );

    let send_denied = ScriptedTransport::new(vec![
        exec_step("pane list", 0, pane_list_json(&["w1:p1"]), ""),
        exec_step("send-keys", 1, "", "denied"),
        exec_step("pane list", 0, pane_list_json(&["w1:p1"]), ""),
    ]);
    let send_error = HerdrRuntime::new(&send_denied)
        .interrupt("s")
        .await
        .expect_err("failed interrupt of live pane must surface");
    assert_eq!(
        send_error.to_string(),
        "herdr interrupt of s failed (exit 1): denied"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn peek_filters_blank_rows_and_refuses_missing_panes() {
    let visible = ScriptedTransport::new(vec![
        checked_step("pane list", pane_list_json(&["w1:p1"])),
        checked_step("pane read", "first\n\nsecond\nthird"),
    ]);
    let output = HerdrRuntime::new(&visible)
        .peek("s", 2)
        .await
        .expect("read visible pane");
    assert_eq!(output, "second\nthird");

    let zero = ScriptedTransport::new(vec![
        checked_step("pane list", pane_list_json(&["w1:p1"])),
        checked_step("pane read", "first\n\nsecond\nthird"),
    ]);
    let zero_output = HerdrRuntime::new(&zero)
        .peek("s", 0)
        .await
        .expect("JavaScript -0 slice parity");
    assert_eq!(zero_output, "first\nsecond\nthird");

    let crlf = ScriptedTransport::new(vec![
        checked_step("pane list", pane_list_json(&["w1:p1"])),
        checked_step("pane read", "first\r\n\r\nsecond\r\nthird"),
    ]);
    let crlf_output = HerdrRuntime::new(&crlf)
        .peek("s", 2)
        .await
        .expect("preserve rendered carriage returns");
    assert_eq!(crlf_output, "second\r\nthird");

    let missing = ScriptedTransport::new(vec![checked_step("pane list", pane_list_json(&[]))]);
    let missing_error = HerdrRuntime::new(&missing)
        .peek("s", 12)
        .await
        .expect_err("missing pane must fail");
    assert_eq!(missing_error.to_string(), "herdr session s has no panes");
}

#[test]
fn attach_payload_stays_fish_safe() {
    let transport = ScriptedTransport::new(Vec::new());
    let command = HerdrRuntime::new(&transport).attach_command("beam-x");
    let payload = command
        .strip_prefix("bash -c '")
        .and_then(|value| value.strip_suffix('\''))
        .expect("single fish-safe bash payload");
    assert!(!payload.contains('\''));
    assert!(!payload.contains('\\'));
}

#[tokio::test(flavor = "current_thread")]
async fn real_herdr_round_trip_starts_reads_and_kills_one_session() {
    if Command::new("herdr").arg("--version").output().is_err() {
        return;
    }
    let fixture = tempdir().expect("create herdr fixture");
    let remote_home = fixture.path().join("remote-home");
    let workspace = remote_home.join("workspace");
    std::fs::create_dir_all(&workspace).expect("create remote workspace");
    let transport = beam::transport::local::LocalTransport::new(&remote_home)
        .expect("construct local transport");
    let runtime = HerdrRuntime::new(&transport);
    let name = format!("beam-rust-runtime-{}", std::process::id());
    let cwd = workspace.to_str().expect("UTF-8 workspace path");
    let argv = vec![
        "bash".to_owned(),
        "-c".to_owned(),
        "printf 'beam-rust-runtime-ready\\n'; sleep 30".to_owned(),
    ];

    let outcome = async {
        runtime
            .start(&name, cwd, &argv)
            .await
            .map_err(|error| error.to_string())?;
        if !runtime
            .alive(&name)
            .await
            .map_err(|error| error.to_string())?
        {
            return Err("started herdr session has no pane".to_owned());
        }
        for attempt in 0..LIVE_PEEK_PROBES_MAX {
            let output = runtime
                .peek(&name, 12)
                .await
                .map_err(|error| error.to_string())?;
            if output.contains("beam-rust-runtime-ready") {
                return Ok(());
            }
            if attempt + 1 < LIVE_PEEK_PROBES_MAX {
                // Real external process boot has no readiness event to await.
                tokio::time::sleep(LIVE_PEEK_INTERVAL).await;
            }
        }
        Err("herdr pane never rendered the runtime marker".to_owned())
    }
    .await;
    runtime.kill(&name).await.expect("kill real herdr session");
    assert!(!runtime.alive(&name).await.expect("probe killed session"));
    match outcome {
        Ok(()) => {}
        Err(error) => panic!("real herdr round trip: {error}"),
    }
}
