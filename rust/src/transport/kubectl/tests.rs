//! Goal: prove kubectl protocol parity, failure classification, verified archive retries,
//! mirror licensing, and no-follow ownership guards without a Kubernetes cluster.
//!
//! Method: compare pure scripts with the TypeScript golden, then inject a fixture kubectl
//! executable that runs the container shell under an isolated HOME and can truncate exact
//! archive streams. Every async operation has a ten-second external deadline.

use std::collections::BTreeMap;
use std::fs;
use std::future::Future;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::time::timeout;

use super::{
    KubectlCoords, KubectlTransport, MarkerWalkMode, archive_receipt_script, marker_walk_blocks,
    parse_archive_receipt, pin_remote_dir_script, remote_path_setup, sync_marker_for,
};
use crate::transport::{OwnedWorkspace, SyncOptions, Transport};

const TEST_TIMEOUT: Duration = Duration::from_secs(10);

fn golden() -> Value {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../parity/goldens/kubectl-transport.json");
    serde_json::from_str(&fs::read_to_string(path).expect("read kubectl parity golden"))
        .expect("parse kubectl parity golden")
}

fn rendered<T>(result: Result<T, impl std::fmt::Display>) -> Result<T, String> {
    result.map_err(|error| error.to_string())
}

fn assert_string_case(case: &Value, actual: Result<String, String>) {
    if let Some(output) = case.get("output") {
        assert_eq!(actual.expect("golden case succeeds"), *output);
    } else {
        assert_eq!(actual.expect_err("golden case fails"), case["error"]);
    }
}

#[test]
fn pure_kubectl_protocol_matches_typescript_golden() {
    let golden = golden();
    assert_marker_cases(&golden);
    assert_path_cases(&golden);
    assert_marker_walk_cases(&golden);
    assert_receipt_cases(&golden);
}

fn assert_marker_cases(golden: &Value) {
    for case in golden["syncMarkerFor"].as_array().expect("marker cases") {
        let marker = sync_marker_for(case["input"].as_str().expect("marker input"));
        assert_eq!(
            json!({
                "dest": marker.dest,
                "root": marker.root,
                "rel": marker.rel,
                "file": marker.file,
                "content": marker.content,
            }),
            case["output"]
        );
    }
}

fn assert_path_cases(golden: &Value) {
    for case in golden["pathSetup"].as_array().expect("path setup cases") {
        let input = case["input"].as_str().expect("path setup input");
        assert_string_case(case, rendered(remote_path_setup(input)));
    }
    for case in golden["pinRemoteDir"].as_array().expect("pin cases") {
        let input = case["input"].as_str().expect("pin input");
        let create = case["create"].as_bool().expect("pin create");
        assert_string_case(case, rendered(pin_remote_dir_script(input, create)));
    }
}

fn assert_marker_walk_cases(golden: &Value) {
    for case in golden["markerWalkBlocks"]
        .as_array()
        .expect("marker walk cases")
    {
        let mode = match case["mode"].as_str().expect("marker mode") {
            "create" => MarkerWalkMode::Create,
            "probe" => MarkerWalkMode::Probe,
            "invalidate" => MarkerWalkMode::Invalidate,
            mode => panic!("unexpected marker mode {mode}"),
        };
        assert_eq!(json!(marker_walk_blocks(mode)), case["output"]);
    }
}

fn assert_receipt_cases(golden: &Value) {
    for case in golden["archiveReceiptScript"]
        .as_array()
        .expect("receipt script cases")
    {
        let input = case["input"].as_str().expect("receipt script input");
        assert_eq!(archive_receipt_script(input), case["output"]);
    }
    for case in golden["parseArchiveReceipt"]
        .as_array()
        .expect("receipt parse cases")
    {
        let result = parse_archive_receipt(case["input"].as_str().expect("receipt input"));
        if let Some(output) = case.get("output") {
            let receipt = result.expect("golden receipt succeeds");
            assert_eq!(
                json!({ "digest": receipt.digest, "bytes": receipt.bytes }),
                *output
            );
        } else {
            assert_eq!(
                result.err().expect("golden receipt fails").to_string(),
                case["error"]
            );
        }
    }
}

#[test]
fn interactive_argv_matches_typescript_golden() {
    for case in golden()["interactiveArgv"]
        .as_array()
        .expect("interactive argv cases")
    {
        let coords = &case["coords"];
        let transport = KubectlTransport::new(
            KubectlCoords {
                context: string(coords, "context"),
                namespace: string(coords, "namespace"),
                container: string(coords, "container"),
                kubeconfig: coords
                    .get("kubeconfig")
                    .map(|value| value.as_str().expect("kubeconfig string").to_owned()),
            },
            string(case, "pod"),
        );
        assert_eq!(transport.label(), case["transportLabel"]);
        assert_eq!(
            json!(transport.interactive_argv(&string(case, "command"))),
            case["output"]
        );
    }
}

fn string(value: &Value, key: &str) -> String {
    value[key].as_str().expect("golden string field").to_owned()
}

struct Fixture {
    _temporary: TempDir,
    home: PathBuf,
    source: PathBuf,
    download: PathBuf,
    control: PathBuf,
    upload_count: PathBuf,
    download_count: PathBuf,
    transport: KubectlTransport,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::Builder::new()
            .prefix("beam-kubectl-test-")
            .tempdir()
            .expect("create fixture root");
        let root = temporary.path();
        let home = root.join("remote-home");
        let source = root.join("source");
        let download = root.join("download");
        let bin = root.join("bin");
        fs::create_dir_all(&home).expect("create remote home");
        fs::create_dir(&source).expect("create source");
        fs::create_dir(&bin).expect("create fixture bin");
        let control = root.join("control");
        let upload_count = root.join("upload-count");
        let download_count = root.join("download-count");
        write_script(&bin.join("kubectl"), &kubectl_script());
        write_script(&bin.join("sha256sum"), &sha256sum_script());
        let mut environment = BTreeMap::new();
        environment.insert("HOME".to_owned(), home.display().to_string());
        environment.insert("BEAM_FAKE_HOME".to_owned(), home.display().to_string());
        environment.insert(
            "BEAM_FAKE_CONTROL".to_owned(),
            control.display().to_string(),
        );
        environment.insert(
            "BEAM_FAKE_UPLOAD".to_owned(),
            upload_count.display().to_string(),
        );
        environment.insert(
            "BEAM_FAKE_DOWNLOAD".to_owned(),
            download_count.display().to_string(),
        );
        environment.insert("PATH".to_owned(), fixture_path(&bin));
        let mut transport = KubectlTransport::new(
            KubectlCoords {
                context: "ctx".to_owned(),
                namespace: "ns".to_owned(),
                container: "sandbox".to_owned(),
                kubeconfig: Some("/tmp/kube config".to_owned()),
            },
            "pod-1",
        );
        transport.command_environment = Some(environment);
        Self {
            _temporary: temporary,
            home,
            source,
            download,
            control,
            upload_count,
            download_count,
            transport,
        }
    }

    fn remote(&self, relative: &str) -> PathBuf {
        self.home.join(relative)
    }

    fn mode(&self, mode: &str) {
        fs::write(&self.control, mode).expect("write fake kubectl mode");
    }

    fn truncate_uploads(&self, count: usize) {
        fs::write(&self.upload_count, count.to_string()).expect("set upload truncations");
    }

    fn truncate_downloads(&self, count: usize) {
        fs::write(&self.download_count, count.to_string()).expect("set download truncations");
    }
}

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    timeout(TEST_TIMEOUT, future)
        .await
        .expect("kubectl transport operation exceeded ten seconds")
}

#[tokio::test(flavor = "current_thread")]
async fn exec_trailer_preserves_remote_status_and_rejects_transport_failures() {
    let fixture = Fixture::new();
    let zero = bounded(fixture.transport.exec("printf 'no-newline'"))
        .await
        .expect("execute zero status");
    assert_eq!((zero.code, zero.stdout.as_str()), (0, "no-newline"));
    let guard = bounded(fixture.transport.exec("printf 'line\\n'; exit 61"))
        .await
        .expect("execute guard status");
    assert_eq!((guard.code, guard.stdout.as_str()), (61, "line\n"));
    let byte_max = bounded(fixture.transport.exec("exit 255"))
        .await
        .expect("execute maximum shell status");
    assert_eq!(byte_max.code, 255);
    fixture.mode("transport-fail");
    let transport_error = bounded(fixture.transport.exec("exit 1"))
        .await
        .expect_err("kubectl failure must not become remote status");
    assert!(
        transport_error
            .to_string()
            .contains("before the remote exit status")
    );
    fixture.mode("malformed");
    let malformed = bounded(fixture.transport.exec("true"))
        .await
        .expect_err("truncated trailer must fail closed");
    assert!(malformed.to_string().contains("missing or malformed"));
}

#[tokio::test(flavor = "current_thread")]
async fn existence_probe_distinguishes_remote_absence_from_kubectl_failure() {
    let fixture = Fixture::new();
    fs::write(fixture.remote("present"), b"present").expect("write remote fixture");
    assert!(
        bounded(fixture.transport.exists("~/present"))
            .await
            .expect("probe present path")
    );
    assert!(
        !bounded(fixture.transport.exists("~/absent"))
            .await
            .expect("probe absent path")
    );
    fixture.mode("transport-fail");
    let error = bounded(fixture.transport.exists("~/absent"))
        .await
        .expect_err("API failure must not look absent");
    assert!(error.to_string().contains("before the remote exit status"));
}

#[tokio::test(flavor = "current_thread")]
async fn additive_upload_filters_locally_and_licensed_download_mirrors_safely() {
    let fixture = Fixture::new();
    write_tree(&fixture.source);
    let remote = fixture.remote("workspace");
    fs::create_dir_all(remote.join("build")).expect("create remote protected tree");
    fs::write(remote.join("build/remote.txt"), b"protected").expect("write protected file");
    fs::write(remote.join("stale.txt"), b"stale").expect("write remote stale file");
    let excludes = vec!["/build".to_owned()];
    bounded(fixture.transport.sync_up(
        &fixture.source,
        "~/workspace",
        SyncOptions {
            excludes: &excludes,
            license: true,
            ..SyncOptions::default()
        },
    ))
    .await
    .expect("licensed additive upload");
    assert_eq!(
        fs::read(remote.join("keep.txt")).expect("read uploaded file"),
        b"keep"
    );
    assert!(remote.join("stale.txt").exists());
    assert!(!remote.join("build/local.txt").exists());
    assert_eq!(
        fs::read(remote.join("build/remote.txt")).expect("read protected"),
        b"protected"
    );
    assert!(
        bounded(
            fixture
                .transport
                .sync_license("~/workspace")
                .expect("license seam")
        )
        .await
        .expect("probe license")
    );
    mirror_download(&fixture, &remote, &excludes).await;
}

async fn mirror_download(fixture: &Fixture, remote: &Path, excludes: &[String]) {
    fs::remove_file(remote.join("stale.txt")).expect("remove remote stale file");
    fs::create_dir_all(fixture.download.join("build")).expect("create local protected tree");
    fs::write(fixture.download.join("build/local-only.txt"), b"local")
        .expect("write local protected file");
    fs::write(fixture.download.join("extra.txt"), b"extra").expect("write local extra file");
    bounded(fixture.transport.sync_down(
        "~/workspace",
        &fixture.download,
        SyncOptions {
            excludes,
            delete: true,
            checksum: true,
            ..SyncOptions::default()
        },
    ))
    .await
    .expect("licensed mirrored download");
    assert!(!fixture.download.join("extra.txt").exists());
    assert!(fixture.download.join("build/local-only.txt").exists());
    assert_eq!(
        fs::read(fixture.download.join("keep.txt")).expect("read downloaded file"),
        b"keep"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn mirror_guards_refuse_before_mutating_either_side() {
    let fixture = Fixture::new();
    fs::write(fixture.source.join("keep.txt"), b"keep").expect("write source");
    let upload_error = bounded(fixture.transport.sync_up(
        &fixture.source,
        "~/never-created",
        SyncOptions {
            delete: true,
            ..SyncOptions::default()
        },
    ))
    .await
    .expect_err("kubectl upload deletion must be refused");
    assert!(upload_error.to_string().contains("cannot mirror deletions"));
    assert!(!fixture.remote("never-created").exists());
    let remote = fixture.remote("unlicensed");
    fs::create_dir(&remote).expect("create unlicensed remote");
    fs::write(remote.join("remote.txt"), b"remote").expect("write remote file");
    fs::create_dir(&fixture.download).expect("create local destination");
    fs::write(fixture.download.join("local.txt"), b"local").expect("write local sentinel");
    let error = bounded(fixture.transport.sync_down(
        "~/unlicensed",
        &fixture.download,
        SyncOptions {
            delete: true,
            ..SyncOptions::default()
        },
    ))
    .await
    .expect_err("unlicensed mirror must be refused");
    assert!(error.to_string().contains("mirror license"));
    assert_eq!(
        fs::read(fixture.download.join("local.txt")).expect("read sentinel"),
        b"local"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn archive_streams_retry_truncation_before_exposing_bytes() {
    let fixture = Fixture::new();
    fs::write(fixture.source.join("payload.txt"), vec![b'x'; 32 * 1024]).expect("write payload");
    fixture.truncate_uploads(2);
    bounded(
        fixture
            .transport
            .sync_up(&fixture.source, "~/lossy", SyncOptions::default()),
    )
    .await
    .expect("upload retries land a verified archive");
    assert_eq!(
        fs::read_to_string(&fixture.upload_count).expect("read upload count"),
        "0"
    );
    assert_eq!(
        fs::read(fixture.remote("lossy/payload.txt"))
            .expect("read remote payload")
            .len(),
        32 * 1024
    );
    fixture.truncate_downloads(2);
    bounded(
        fixture
            .transport
            .sync_down("~/lossy", &fixture.download, SyncOptions::default()),
    )
    .await
    .expect("download retries land a verified archive");
    assert_eq!(
        fs::read_to_string(&fixture.download_count).expect("read download count"),
        "0"
    );
    assert_eq!(
        fs::read(fixture.download.join("payload.txt"))
            .expect("read local payload")
            .len(),
        32 * 1024
    );
}

#[tokio::test(flavor = "current_thread")]
async fn exhausted_upload_retries_leave_old_bytes_unextracted_and_unlicensed() {
    let fixture = Fixture::new();
    fs::write(fixture.source.join("payload.txt"), b"old").expect("write initial payload");
    bounded(fixture.transport.sync_up(
        &fixture.source,
        "~/bounded",
        SyncOptions {
            license: true,
            ..SyncOptions::default()
        },
    ))
    .await
    .expect("seed licensed destination");
    assert!(
        bounded(
            fixture
                .transport
                .sync_license("~/bounded")
                .expect("license seam")
        )
        .await
        .expect("probe seeded license")
    );
    fs::write(fixture.source.join("payload.txt"), b"new").expect("replace local payload");
    fixture.truncate_uploads(6);
    let error = bounded(fixture.transport.sync_up(
        &fixture.source,
        "~/bounded",
        SyncOptions {
            license: true,
            ..SyncOptions::default()
        },
    ))
    .await
    .expect_err("six truncated uploads must exhaust the retry bound");
    assert!(error.to_string().contains("failed 6 verified uploads"));
    assert_eq!(
        fs::read(fixture.remote("bounded/payload.txt")).expect("read retained remote payload"),
        b"old"
    );
    assert!(
        !bounded(
            fixture
                .transport
                .sync_license("~/bounded")
                .expect("license seam")
        )
        .await
        .expect("probe invalidated license")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn remote_symlinks_and_foreign_owned_workspaces_are_refused() {
    let fixture = Fixture::new();
    fs::write(fixture.source.join("payload.txt"), b"payload").expect("write payload");
    let outside = fixture.remote("outside");
    fs::create_dir(&outside).expect("create outside directory");
    symlink(&outside, fixture.remote("linked")).expect("create remote symlink");
    let link_error = bounded(fixture.transport.sync_up(
        &fixture.source,
        "~/linked",
        SyncOptions::default(),
    ))
    .await
    .expect_err("symlinked destination must fail");
    assert!(link_error.to_string().contains("symlinked path"));
    assert!(!outside.join("payload.txt").exists());
    let owned = fixture.remote("owned");
    fs::create_dir_all(owned.join(".beam")).expect("create owned metadata");
    fs::write(owned.join(".beam/owner"), "foreign-owner\n").expect("write foreign owner");
    let owner_error = bounded(fixture.transport.sync_up(
        &fixture.source,
        "~/owned/.beam/git/gen-1",
        SyncOptions {
            owned: Some(OwnedWorkspace {
                root: "~/owned",
                owner_bytes: "expected-owner",
            }),
            ..SyncOptions::default()
        },
    ))
    .await
    .expect_err("foreign owner must fail");
    assert!(
        owner_error
            .to_string()
            .contains("not owned by this handoff")
    );
    assert!(!owned.join(".beam/git/gen-1/payload.txt").exists());
}

#[tokio::test(flavor = "current_thread")]
async fn owned_reserved_upload_stays_bound_and_mode_tight() {
    let fixture = Fixture::new();
    fs::write(fixture.source.join("payload.txt"), b"payload").expect("write payload");
    let owner = "beam-workspace-v1 rec1 0123456789abcdef0123456789abcdef";
    let owned = fixture.remote("owned");
    fs::create_dir_all(owned.join(".beam")).expect("create owned metadata");
    fs::write(owned.join(".beam/owner"), format!("{owner}\n")).expect("write owner marker");
    bounded(fixture.transport.sync_up(
        &fixture.source,
        "~/owned/.beam/git/gen-1",
        SyncOptions {
            owned: Some(OwnedWorkspace {
                root: "~/owned",
                owner_bytes: owner,
            }),
            ..SyncOptions::default()
        },
    ))
    .await
    .expect("owned reserved upload");
    let destination = owned.join(".beam/git/gen-1");
    assert_eq!(
        fs::read(destination.join("payload.txt")).expect("read payload"),
        b"payload"
    );
    let mode = fs::metadata(destination)
        .expect("stat destination")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o700);
}

fn write_tree(source: &Path) {
    fs::write(source.join("keep.txt"), b"keep").expect("write kept source");
    fs::create_dir(source.join("build")).expect("create source build tree");
    fs::write(source.join("build/local.txt"), b"local-build").expect("write excluded source");
}

fn write_script(path: &Path, body: &str) {
    fs::write(path, format!("#!/usr/bin/env bash\nset -e\n{body}\n"))
        .expect("write fixture script");
    let mut permissions = fs::metadata(path)
        .expect("stat fixture script")
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).expect("make fixture script executable");
}

fn fixture_path(bin: &Path) -> String {
    let inherited = std::env::var("PATH").expect("test process has PATH");
    format!("{}:{inherited}", bin.display())
}

fn sha256sum_script() -> String {
    "if [ -x /usr/bin/sha256sum ]; then\n  exec /usr/bin/sha256sum \"$@\"\nfi\n\
     exec /usr/bin/shasum -a 256 \"$@\""
        .to_owned()
}

fn kubectl_script() -> String {
    let script = r#"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --context|--namespace|--kubeconfig) shift 2 ;;
    exec) shift; break ;;
    *) echo "unexpected kubectl global arg: $1" >&2; exit 90 ;;
  esac
done
case "${1-}" in -i|-it) shift ;; esac
pod=${1-}; shift
[ "${1-}" = "-c" ] || exit 91; shift
container=${1-}; shift
[ "${1-}" = "--" ] || exit 92; shift
[ "${1-}" = "bash" ] || exit 93; shift
[ "${1-}" = "-c" ] || exit 94; shift
command=${1-}
mode=$(cat "$BEAM_FAKE_CONTROL" 2>/dev/null || true)
if [ "$mode" = transport-fail ]; then echo "API server unavailable" >&2; exit 1; fi
if [ "$mode" = malformed ]; then printf 'partial-output'; exit 0; fi
case "$command" in
  "cat > "*beam-syncup-*)
    count=$(cat "$BEAM_FAKE_UPLOAD" 2>/dev/null || printf 0)
    if [ "$count" -gt 0 ]; then
      printf '%s' "$((count - 1))" > "$BEAM_FAKE_UPLOAD"
      head -c 16 | HOME="$BEAM_FAKE_HOME" bash -c "$command"
      exit 0
    fi
    ;;
  "cat "*beam-syncdown-*)
    count=$(cat "$BEAM_FAKE_DOWNLOAD" 2>/dev/null || printf 0)
    if [ "$count" -gt 0 ]; then
      printf '%s' "$((count - 1))" > "$BEAM_FAKE_DOWNLOAD"
      HOME="$BEAM_FAKE_HOME" bash -c "$command" | head -c 16
      exit 0
    fi
    ;;
esac
HOME="$BEAM_FAKE_HOME" bash -c "$command"
"#;
    script.trim().to_owned()
}
