//! Goal: prove all four Rust adapters locate, install, collect, and clean up
//! the same real filesystem shapes as their TypeScript counterparts.
//!
//! Method: build hermetic harness stores under temporary homes, drive installs
//! and returns through the real local transport, and inspect bytes, modes,
//! ownership guards, artifacts, and refusal behavior. External waits are bounded.

use std::fs::{self, DirBuilder};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use beam::session::{
    InstallOptions, LocalSession, SessionAdapter, ToolName, adapter_for, detect_session,
};
use beam::transport::local::LocalTransport;
use beam::util::digest::file_sha256;
use tokio::time::timeout;

const TEST_TIMEOUT: Duration = Duration::from_secs(10);

struct Fixture {
    _temporary: tempfile::TempDir,
    root: PathBuf,
    local_home: PathBuf,
    target_home: PathBuf,
    local_cwd: PathBuf,
    remote_cwd: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::Builder::new()
            .prefix("beam-rust-adapters-")
            .tempdir()
            .expect("create adapter fixture");
        let root = temporary
            .path()
            .canonicalize()
            .expect("canonicalize fixture");
        let local_home = private_dir(&root.join("local-home"));
        let target_home = private_dir(&root.join("target-home"));
        let local_cwd = private_dir(&local_home.join("work/project"));
        let remote_cwd = private_dir(&target_home.join("workspace"));
        Self {
            _temporary: temporary,
            root,
            local_home,
            target_home,
            local_cwd,
            remote_cwd,
        }
    }

    fn transport(&self) -> LocalTransport {
        LocalTransport::new(&self.target_home).expect("construct local transport")
    }
}

fn private_dir(path: &Path) -> PathBuf {
    let mut builder = DirBuilder::new();
    builder.recursive(true).mode(0o700);
    builder
        .create(path)
        .unwrap_or_else(|error| panic!("create {}: {error}", path.display()));
    path.to_path_buf()
}

fn have_rsync() -> bool {
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join("rsync"))
            .any(|candidate| candidate.is_file())
    })
}

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    timeout(TEST_TIMEOUT, future)
        .await
        .expect("session adapter process exceeded 10 seconds")
}

fn pi_transcript(cwd: &Path, id: &str) -> String {
    format!(
        "{{\"type\":\"title\",\"v\":1,\"title\":\"t\"}}\n\
         {{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\
         \"2026-01-01T00:00:00.000Z\",\"cwd\":{}}}\n\
         {{\"type\":\"message\",\"id\":\"m1\"}}\n",
        serde_json::to_string(cwd.to_str().expect("fixture cwd is UTF-8"))
            .expect("serialize fixture cwd")
    )
}

fn pi_transcript_with_raw_tail(cwd: &Path, id: &str, message: &str) -> Vec<u8> {
    let mut transcript = pi_transcript(cwd, id).into_bytes();
    transcript.extend_from_slice(message.as_bytes());
    transcript.extend_from_slice(&[0xff, 0xfe, b'\n']);
    transcript
}

fn local_session(tool: ToolName, id: &str, file: PathBuf) -> LocalSession {
    LocalSession {
        tool,
        id: id.to_owned(),
        file,
        store_file: None,
        artifacts_dir: None,
        modified: UNIX_EPOCH,
    }
}

#[tokio::test(flavor = "current_thread")]
async fn locates_each_harness_only_when_store_identity_matches() {
    let fixture = Fixture::new();
    let omp = plant_omp_session(&fixture, "omp-123");
    let pi = plant_pi_session(&fixture, "pi-123");
    let claude = plant_claude_session(&fixture, "claude-123");
    let codex = plant_codex_session(&fixture, "codex-123");
    for (tool, expected) in [
        (ToolName::Omp, omp),
        (ToolName::Pi, pi),
        (ToolName::Claude, claude),
        (ToolName::Codex, codex),
    ] {
        let found = adapter_for(tool)
            .locate(&fixture.local_cwd, &fixture.local_home, None)
            .await
            .expect("locate fixture session")
            .expect("fixture session exists");
        assert_eq!(found.id, expected);
        assert_eq!(found.tool, tool);
    }
    let error = match detect_session(
        &fixture.root.join("foreign"),
        &fixture.local_home,
        None,
        None,
    )
    .await
    {
        Ok(_) => panic!("foreign cwd unexpectedly found a session"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("run the harness here first"));
}

fn plant_omp_session(fixture: &Fixture, id: &str) -> String {
    let relative = fixture
        .local_cwd
        .strip_prefix(&fixture.local_home)
        .expect("cwd is inside home")
        .to_str()
        .expect("fixture path is UTF-8")
        .replace('/', "-");
    let directory = private_dir(
        &fixture
            .local_home
            .join(".omp/agent/sessions")
            .join(relative),
    );
    fs::write(
        directory.join(format!("2026_{id}.jsonl")),
        pi_transcript(&fixture.local_cwd, id),
    )
    .expect("write OMP session");
    id.to_owned()
}

fn plant_pi_session(fixture: &Fixture, id: &str) -> String {
    let cwd = fixture.local_cwd.to_str().expect("fixture path is UTF-8");
    let slug = format!("-{cwd}-").replace('/', "-") + "-";
    let directory = private_dir(&fixture.local_home.join(".pi/agent/sessions").join(slug));
    fs::write(
        directory.join(format!("2026_{id}.jsonl")),
        pi_transcript(&fixture.local_cwd, id),
    )
    .expect("write Pi session");
    id.to_owned()
}

fn plant_claude_session(fixture: &Fixture, id: &str) -> String {
    let cwd = fixture.local_cwd.to_str().expect("fixture path is UTF-8");
    let slug = beam::session::claude::claude_project_slug(cwd);
    let directory = private_dir(&fixture.local_home.join(".claude/projects").join(slug));
    fs::write(
        directory.join(format!("{id}.jsonl")),
        format!(
            "{{\"sessionId\":\"{id}\",\"cwd\":{}}}\n",
            serde_json::to_string(cwd).expect("serialize cwd")
        ),
    )
    .expect("write Claude session");
    id.to_owned()
}

fn plant_codex_session(fixture: &Fixture, id: &str) -> String {
    let directory = private_dir(&fixture.local_home.join(".codex/sessions/2026/08/30"));
    let cwd = fixture.local_cwd.to_str().expect("fixture path is UTF-8");
    fs::write(
        directory.join(format!("rollout-2026-08-30-{id}.jsonl")),
        format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{id}\",\"cwd\":{}}}}}\n",
            serde_json::to_string(cwd).expect("serialize cwd")
        ),
    )
    .expect("write Codex session");
    id.to_owned()
}

#[tokio::test(flavor = "current_thread")]
async fn omp_install_and_return_preserve_identity_artifacts_and_privacy() {
    if !have_rsync() {
        return;
    }
    let fixture = Fixture::new();
    let source = fixture.root.join("omp-source.jsonl");
    fs::write(&source, pi_transcript(&fixture.local_cwd, "omp-e2e")).expect("write source");
    let artifacts = private_dir(&fixture.root.join("artifacts"));
    fs::write(artifacts.join("note.txt"), "artifact\n").expect("write artifact");
    symlink("note.txt", artifacts.join("latest")).expect("link artifact");
    let beam = private_dir(&fixture.remote_cwd.join(".beam"));
    fs::write(beam.join("owner"), "owner-1\n").expect("write owner");
    let mut session = local_session(ToolName::Omp, "omp-e2e", source);
    session.artifacts_dir = Some(artifacts);
    let adapter = adapter_for(ToolName::Omp);
    let transport = fixture.transport();
    let installed = bounded(adapter.install(
        &transport,
        &session,
        fixture.remote_cwd.to_str().expect("remote cwd is UTF-8"),
        InstallOptions {
            kickoff: Some("continue now"),
            install_key: Some("fixed-key"),
            owner: Some("owner-1"),
        },
    ))
    .await
    .expect("install OMP session");
    assert_eq!(
        installed.resume_argv,
        ["omp", "--resume", ".beam/session.jsonl", "continue now"]
    );
    assert_installed_omp(&fixture);
    prepare_grown_omp_return(&fixture, &transport, adapter, &session).await;
    let stage = private_dir(&fixture.root.join("return"));
    let returned = bounded(adapter.stage_return(
        &transport,
        &session,
        &fixture.local_cwd,
        fixture.remote_cwd.to_str().expect("remote cwd is UTF-8"),
        &stage,
    ))
    .await
    .expect("stage OMP return");
    assert!(returned.hint.starts_with("omp --resume "));
    assert_eq!(
        returned.remote_session_sha256,
        file_sha256(&fixture.remote_cwd.join(".beam/session.jsonl"))
            .expect("hash returned OMP transcript")
    );
    assert!(
        fs::read_to_string(stage.join("session.jsonl"))
            .expect("read return")
            .contains(fixture.local_cwd.to_str().expect("local cwd is UTF-8"))
    );
    assert_eq!(
        fs::read_to_string(stage.join("artifacts/note.txt")).expect("read returned artifact"),
        "artifact\n"
    );
}
async fn prepare_grown_omp_return(
    fixture: &Fixture,
    transport: &LocalTransport,
    adapter: &dyn SessionAdapter,
    session: &LocalSession,
) {
    fs::remove_file(fixture.remote_cwd.join(".beam/session/latest"))
        .expect("remove remote artifact link before inert return");
    fs::write(
        fixture.remote_cwd.join(".beam/session.jsonl"),
        pi_transcript(&fixture.remote_cwd, "omp-e2e") + "{\"type\":\"message\",\"id\":\"grown\"}\n",
    )
    .expect("grow remote transcript");
    let reinstall = bounded(adapter.install(
        transport,
        session,
        fixture.remote_cwd.to_str().expect("remote cwd is UTF-8"),
        InstallOptions {
            kickoff: None,
            install_key: Some("fixed-key"),
            owner: Some("owner-1"),
        },
    ))
    .await;
    let error = match reinstall {
        Ok(_) => panic!("grown remote transcript was unexpectedly overwritten"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("unsaved remote work"));
    assert!(
        fs::read_to_string(fixture.remote_cwd.join(".beam/session.jsonl"))
            .expect("read preserved remote transcript")
            .contains("\"id\":\"grown\"")
    );
    fs::remove_dir_all(fixture.remote_cwd.join(".beam/session-install"))
        .expect("remove refused install stage before return");
}

fn assert_installed_omp(fixture: &Fixture) {
    let session = fixture.remote_cwd.join(".beam/session.jsonl");
    let text = fs::read_to_string(&session).expect("read installed transcript");
    assert!(text.contains(fixture.remote_cwd.to_str().expect("remote cwd is UTF-8")));
    assert_eq!(
        fs::metadata(&session)
            .expect("session metadata")
            .permissions()
            .mode()
            & 0o7777,
        0o600
    );
    assert_eq!(
        fs::read_to_string(fixture.remote_cwd.join(".beam/session/note.txt"))
            .expect("read artifact"),
        "artifact\n"
    );
    assert_eq!(
        fs::read_link(fixture.remote_cwd.join(".beam/session/latest")).expect("read link"),
        Path::new("note.txt")
    );
    assert!(!fixture.remote_cwd.join(".beam/session-install").exists());
}
#[tokio::test(flavor = "current_thread")]
async fn pi_install_and_return_use_one_private_deterministic_session() {
    if !have_rsync() {
        return;
    }
    let fixture = Fixture::new();
    let source = fixture.root.join("pi-source.jsonl");
    fs::write(
        &source,
        pi_transcript_with_raw_tail(&fixture.local_cwd, "pi-e2e", ""),
    )
    .expect("write source");
    let beam = private_dir(&fixture.remote_cwd.join(".beam"));
    fs::write(beam.join("owner"), "owner-2\n").expect("write owner");
    let session = local_session(ToolName::Pi, "pi-e2e", source);
    let adapter = adapter_for(ToolName::Pi);
    let transport = fixture.transport();
    let remote_cwd = fixture.remote_cwd.to_str().expect("remote cwd is UTF-8");
    let installed = bounded(adapter.install(
        &transport,
        &session,
        remote_cwd,
        InstallOptions {
            kickoff: None,
            install_key: Some("pi-key"),
            owner: Some("owner-2"),
        },
    ))
    .await
    .expect("install Pi session");
    assert_eq!(
        installed.resume_argv,
        ["pi", "--session-dir", ".beam/pi-sessions", "--continue"]
    );
    let remote_session = pi_install_assert_installed(&fixture);
    fs::write(
        &remote_session,
        pi_transcript_with_raw_tail(
            &fixture.remote_cwd,
            "pi-e2e",
            "{\"type\":\"message\",\"id\":\"grown\"}\n",
        ),
    )
    .expect("grow Pi transcript");
    let stage = private_dir(&fixture.root.join("pi-return"));
    let returned =
        bounded(adapter.stage_return(&transport, &session, &fixture.local_cwd, remote_cwd, &stage))
            .await
            .expect("stage Pi return");
    assert!(returned.hint.contains("pi --session-dir"));
    assert_eq!(
        returned.remote_session_sha256,
        file_sha256(&remote_session).expect("hash returned Pi transcript")
    );
    assert!(returned.hint.ends_with("--continue"));
    let staged = fs::read(stage.join("session.jsonl")).expect("read Pi return");
    assert!(
        staged
            .windows(12)
            .any(|window| window == b"\"id\":\"grown\"")
    );
    assert!(staged.ends_with(&[0xff, 0xfe, b'\n']));
}

fn pi_install_assert_installed(fixture: &Fixture) -> PathBuf {
    let remote_session = fixture.remote_cwd.join(".beam/pi-sessions/session.jsonl");
    assert!(remote_session.is_file());
    assert!(
        fs::read(&remote_session)
            .expect("read installed Pi transcript")
            .ends_with(&[0xff, 0xfe, b'\n'])
    );
    assert_eq!(
        fs::read_dir(remote_session.parent().expect("session has parent"))
            .expect("read private session dir")
            .count(),
        1
    );
    remote_session
}

#[tokio::test(flavor = "current_thread")]
async fn codex_install_refuses_store_parent_components() {
    let fixture = Fixture::new();
    let source = fixture.root.join("codex-unsafe-source.jsonl");
    let cwd = fixture.local_cwd.to_str().expect("local cwd is UTF-8");
    fs::write(&source, codex_text("codex-unsafe", cwd, "local")).expect("write Codex source");
    let mut session = local_session(ToolName::Codex, "codex-unsafe", source);
    session.store_file = Some(fixture.root.join(".codex/sessions/2026/08/../escape.jsonl"));
    let transport = fixture.transport();
    let result = bounded(adapter_for(ToolName::Codex).install(
        &transport,
        &session,
        "ignored",
        InstallOptions::default(),
    ))
    .await;
    let error = match result {
        Ok(_) => panic!("unsafe Codex store path was accepted"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("unsafe store component"));
}

#[tokio::test(flavor = "current_thread")]
async fn guarded_adapters_round_trip_without_touching_local_stores() {
    if !have_rsync() {
        return;
    }
    let fixture = Fixture::new();
    let transport = fixture.transport();
    round_trip_claude(&fixture, &transport).await;
    round_trip_codex(&fixture, &transport).await;
}

async fn round_trip_claude(fixture: &Fixture, transport: &LocalTransport) {
    let source = fixture.root.join("claude-source.jsonl");
    fs::write(
        &source,
        "{\"sessionId\":\"claude-e2e\",\"message\":\"local\"}\n",
    )
    .expect("write Claude source");
    let session = local_session(ToolName::Claude, "claude-e2e", source.clone());
    let adapter = adapter_for(ToolName::Claude);
    let remote_cwd = fixture.remote_cwd.to_str().expect("remote cwd is UTF-8");
    bounded(adapter.install(transport, &session, remote_cwd, InstallOptions::default()))
        .await
        .expect("install Claude session");
    let slug = beam::session::claude::claude_project_slug(remote_cwd);
    let remote = fixture
        .target_home
        .join(".claude/projects")
        .join(slug)
        .join("claude-e2e.jsonl");
    fs::write(
        &remote,
        "{\"sessionId\":\"claude-e2e\",\"message\":\"grown\"}\n",
    )
    .expect("grow Claude session");
    let stage = private_dir(&fixture.root.join("claude-return"));
    let returned =
        bounded(adapter.stage_return(transport, &session, &fixture.local_cwd, remote_cwd, &stage))
            .await
            .expect("return Claude session");
    assert!(returned.hint.contains("manual import"));
    assert_eq!(
        returned.remote_session_sha256,
        file_sha256(&remote).expect("hash returned Claude transcript")
    );
    assert_eq!(
        fs::read_to_string(&source).expect("read local source"),
        "{\"sessionId\":\"claude-e2e\",\"message\":\"local\"}\n"
    );
    assert!(
        fs::read_to_string(stage.join("session.jsonl"))
            .expect("read Claude return")
            .contains("grown")
    );
    bounded(adapter.cleanup_remote(transport, &session, remote_cwd))
        .await
        .expect("clean Claude remote");
    assert!(!remote.exists());
}

async fn round_trip_codex(fixture: &Fixture, transport: &LocalTransport) {
    let store = private_dir(&fixture.local_home.join(".codex/sessions/2026/08/30"));
    let source = store.join("rollout-codex-e2e.jsonl");
    let cwd = fixture.local_cwd.to_str().expect("local cwd is UTF-8");
    let local = codex_text("codex-e2e", cwd, "local");
    fs::write(&source, &local).expect("write Codex source");
    let session = local_session(ToolName::Codex, "codex-e2e", source.clone());
    let adapter = adapter_for(ToolName::Codex);
    bounded(adapter.install(transport, &session, "ignored", InstallOptions::default()))
        .await
        .expect("install Codex session");
    let remote = fixture
        .target_home
        .join(".codex/sessions/2026/08/30/rollout-codex-e2e.jsonl");
    fs::write(&remote, codex_text("codex-e2e", cwd, "grown")).expect("grow Codex session");
    let stage = private_dir(&fixture.root.join("codex-return"));
    let returned =
        bounded(adapter.stage_return(transport, &session, &fixture.local_cwd, "ignored", &stage))
            .await
            .expect("return Codex session");
    assert!(returned.hint.contains("manual import"));
    assert_eq!(
        returned.remote_session_sha256,
        file_sha256(&remote).expect("hash returned Codex transcript")
    );
    assert_eq!(
        fs::read_to_string(&source).expect("read local source"),
        local
    );
    assert!(
        fs::read_to_string(stage.join("session.jsonl"))
            .expect("read Codex return")
            .contains("grown")
    );
    bounded(adapter.cleanup_remote(transport, &session, "ignored"))
        .await
        .expect("clean Codex remote");
    assert!(!remote.exists());
}

fn codex_text(id: &str, cwd: &str, message: &str) -> String {
    format!(
        "{{\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{id}\",\"cwd\":{}}}}}\n\
         {{\"type\":\"message\",\"text\":\"{message}\"}}\n",
        serde_json::to_string(cwd).expect("serialize Codex cwd")
    )
}

#[tokio::test(flavor = "current_thread")]
async fn guarded_install_refuses_symlinked_store_without_outside_write() {
    if !have_rsync() {
        return;
    }
    let fixture = Fixture::new();
    let outside = private_dir(&fixture.root.join("outside"));
    symlink(&outside, fixture.target_home.join(".claude")).expect("plant store symlink");
    let source = fixture.root.join("claude-attack.jsonl");
    fs::write(&source, "{\"sessionId\":\"attack\"}\n").expect("write source");
    let session = local_session(ToolName::Claude, "attack", source);
    let transport = fixture.transport();
    let error = match bounded(adapter_for(ToolName::Claude).install(
        &transport,
        &session,
        "/target/workspace",
        InstallOptions::default(),
    ))
    .await
    {
        Ok(_) => panic!("symlinked store unexpectedly accepted an install"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("symlink"));
    assert!(
        fs::read_dir(&outside)
            .expect("read outside")
            .next()
            .is_none()
    );
}
