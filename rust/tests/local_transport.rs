//! Goal: prove the local transport is a behaviorally equivalent hermetic
//! double for shell execution and rsync data movement: isolated HOME,
//! trailing-slash mirrors, no-follow creation, and owner-bound transfers.
//!
//! Method: run real bash and rsync processes against unique temporary homes,
//! use hostile path names, plant symlink and ownership attacks, and inspect
//! every destination after success or refusal. External waits are bounded.

use std::error::Error;
use std::fs::{self, DirBuilder};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use beam::transport::local::{LocalTransport, create_walk_blocks};
use beam::transport::{OwnedWorkspace, SyncOptions, Transport};
use beam::util::shell::{RunOptions, run, shq};
use tokio::time::timeout;

const TEST_TIMEOUT: Duration = Duration::from_secs(10);
static FIXTURE_INDEX: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let index = FIXTURE_INDEX.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("beam-rust-local-{}-{index}", std::process::id()));
        let mut builder = DirBuilder::new();
        builder.mode(0o700);
        builder
            .create(&root)
            .unwrap_or_else(|error| panic!("create fixture {}: {error}", root.display()));
        let root = root
            .canonicalize()
            .unwrap_or_else(|error| panic!("canonicalize fixture {}: {error}", root.display()));
        Self { root }
    }

    fn metachar_home(&self) -> PathBuf {
        let home = self.root.join("ha rd 'quo$te` );&|");
        fs::create_dir(&home)
            .unwrap_or_else(|error| panic!("create home {}: {error}", home.display()));
        home
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap_or_else(|error| {
            panic!("remove fixture {}: {error}", self.root.display());
        });
    }
}

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    timeout(TEST_TIMEOUT, future)
        .await
        .expect("external local transport process exceeded 10 seconds")
}

fn have_rsync() -> bool {
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join("rsync"))
            .any(|candidate| candidate.is_file())
    })
}

#[tokio::test(flavor = "current_thread")]
async fn isolates_exec_and_interactive_home_with_hostile_paths() {
    let fixture = Fixture::new();
    let home = fixture.metachar_home();
    let local = LocalTransport::new(&home).expect("construct local transport");
    let transport: &dyn Transport = &local;
    assert_eq!(
        transport.label(),
        format!("local (home={})", home.display())
    );
    let output = bounded(transport.exec_checked(
        "mkdir -p \"$HOME/auth\" && printf token > \"$HOME/auth/value\" && printf %s \"$HOME\"",
    ))
    .await
    .expect("exec inside isolated home");
    assert_eq!(output, home.to_string_lossy());
    assert_eq!(
        fs::read_to_string(home.join("auth/value")).expect("read target auth"),
        "token"
    );
    assert!(
        bounded(transport.exists("~/auth/value"))
            .await
            .expect("probe target file")
    );
    assert_eq!(
        transport.interactive_argv("printf %s \"$HOME\""),
        vec![
            "env".to_owned(),
            format!("HOME={}", home.display()),
            "bash".to_owned(),
            "-lc".to_owned(),
            "printf %s \"$HOME\"".to_owned(),
        ]
    );
    assert!(transport.sync_license("~/nested").is_none());
    assert_eq!(
        local.resolve("~/nested").expect("resolve tilde path"),
        home.join("nested")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn configured_home_symlink_keeps_lexical_home_and_resolves_physical_paths() {
    let fixture = Fixture::new();
    let physical = fixture.root.join("physical-home");
    let lexical = fixture.root.join("home-link");
    fs::create_dir(&physical).expect("create physical home");
    symlink(&physical, &lexical).expect("create configured home symlink");
    let transport = LocalTransport::new(&lexical).expect("construct through home symlink");

    assert_eq!(
        transport.label(),
        format!("local (home={})", lexical.display())
    );
    let output = bounded(transport.exec_checked("printf %s \"$HOME\""))
        .await
        .expect("exec through lexical home");
    assert_eq!(output, lexical.to_string_lossy());
    assert_eq!(
        transport.resolve("~/nested").expect("resolve tilde alias"),
        physical.join("nested")
    );
    let lexical_nested = lexical.join("nested");
    assert_eq!(
        transport
            .resolve(
                lexical_nested
                    .to_str()
                    .expect("fixture path is valid UTF-8"),
            )
            .expect("resolve absolute alias"),
        physical.join("nested")
    );
}

#[test]
fn missing_home_fails_at_construction_with_path_remedy_and_source() {
    let fixture = Fixture::new();
    let missing = fixture.root.join("missing");
    let error = match LocalTransport::new(&missing) {
        Ok(_) => panic!("missing home unexpectedly constructed a transport"),
        Err(error) => error,
    };
    assert!(error.to_string().contains(&format!(
        "beam: local transport home does not resolve: {}",
        missing.display()
    )));
    assert!(error.to_string().contains("create that directory"));
    assert!(error.source().is_some());
}

#[tokio::test(flavor = "current_thread")]
async fn exec_returns_nonzero_data_and_checked_context() {
    let fixture = Fixture::new();
    let transport = LocalTransport::new(&fixture.root).expect("construct local transport");
    let result = bounded(transport.exec("echo out; echo err >&2; exit 3"))
        .await
        .expect("nonzero target exit remains data");
    assert_eq!(result.code, 3);
    assert_eq!(result.stdout, "out\n");
    assert_eq!(result.stderr, "err\n");

    let error = bounded(transport.exec_checked("echo out; echo err >&2; exit 3"))
        .await
        .expect_err("checked exec must reject nonzero target exit");
    assert_eq!(
        error.to_string(),
        format!(
            "[local (home={})] command failed (3): echo out; echo err >&2; exit 3\nerr",
            fixture.root.display()
        )
    );
}

#[tokio::test(flavor = "current_thread")]
async fn sync_mirrors_deletes_excludes_and_preserves_local_extras_by_default() {
    if !have_rsync() {
        return;
    }
    let fixture = Fixture::new();
    let transport = LocalTransport::new(&fixture.root).expect("construct local transport");
    let source = fixture.root.join("source");
    fs::create_dir(&source).expect("create source");
    fs::write(source.join("keep.txt"), b"keep").expect("write kept file");
    fs::write(source.join("secret.env"), b"secret").expect("write excluded file");
    let excludes = vec!["secret.env".to_owned()];
    bounded(transport.sync_up(
        &source,
        "~/remote",
        SyncOptions {
            excludes: &excludes,
            checksum: true,
            ..SyncOptions::default()
        },
    ))
    .await
    .expect("initial upload");
    assert!(fixture.root.join("remote/keep.txt").exists());
    assert!(!fixture.root.join("remote/secret.env").exists());

    fs::write(fixture.root.join("remote/stale.txt"), b"stale").expect("write remote stale file");
    bounded(transport.sync_up(
        &source,
        "~/remote",
        SyncOptions {
            delete: true,
            license: true,
            ..SyncOptions::default()
        },
    ))
    .await
    .expect("mirrored upload");
    assert!(!fixture.root.join("remote/stale.txt").exists());

    let returned = fixture.root.join("returned");
    fs::create_dir(&returned).expect("create return destination");
    fs::write(returned.join("local-only.txt"), b"mine").expect("write local-only file");
    fs::write(fixture.root.join("remote/work.txt"), b"theirs").expect("write remote work");
    bounded(transport.sync_down("~/remote", &returned, SyncOptions::default()))
        .await
        .expect("additive download");
    assert_eq!(
        fs::read_to_string(returned.join("work.txt")).expect("read downloaded work"),
        "theirs"
    );
    assert!(returned.join("local-only.txt").exists());
    bounded(transport.sync_down(
        "~/remote",
        &returned,
        SyncOptions {
            delete: true,
            ..SyncOptions::default()
        },
    ))
    .await
    .expect("mirrored download");
    assert!(!returned.join("local-only.txt").exists());
}

#[tokio::test(flavor = "current_thread")]
async fn sync_up_refuses_a_symlinked_parent_without_outside_mutation() {
    if !have_rsync() {
        return;
    }
    let fixture = Fixture::new();
    let outside = fixture.root.join("outside");
    let source = fixture.root.join("source");
    fs::create_dir(&outside).expect("create outside directory");
    fs::create_dir(&source).expect("create source directory");
    fs::write(source.join("file.txt"), b"payload").expect("write source file");
    symlink(&outside, fixture.root.join("linked")).expect("create symlinked parent");
    let transport = LocalTransport::new(&fixture.root).expect("construct local transport");

    let error = bounded(transport.sync_up(&source, "~/linked/workspace", SyncOptions::default()))
        .await
        .expect_err("symlinked destination parent must be refused");
    assert!(error.to_string().contains("symlinked path component"));
    assert_eq!(
        fs::read_dir(&outside)
            .expect("read outside directory")
            .count(),
        0
    );
}

#[tokio::test(flavor = "current_thread")]
async fn owned_upload_verifies_owner_and_tightens_reserved_destinations() {
    if !have_rsync() {
        return;
    }
    let fixture = Fixture::new();
    let source = fixture.root.join("source");
    let workspace = fixture.root.join("workspace");
    let owner = "beam-workspace-v1 rec1 0123456789abcdef0123456789abcdef";
    fs::create_dir(&source).expect("create source");
    fs::write(source.join("config"), b"payload").expect("write source payload");
    fs::create_dir(&workspace).expect("create workspace");
    fs::create_dir(workspace.join(".beam")).expect("create reserved root");
    fs::write(workspace.join(".beam/owner"), format!("{owner}\n")).expect("write owner marker");
    let transport = LocalTransport::new(&fixture.root).expect("construct local transport");

    bounded(transport.sync_up(
        &source,
        "~/workspace/.beam/git/gen1",
        SyncOptions {
            owned: Some(OwnedWorkspace {
                root: "~/workspace",
                owner_bytes: owner,
            }),
            ..SyncOptions::default()
        },
    ))
    .await
    .expect("owned upload");
    let destination = workspace.join(".beam/git/gen1");
    assert_eq!(
        fs::read_to_string(destination.join("config")).expect("read owned payload"),
        "payload"
    );
    assert_eq!(
        fs::metadata(&destination)
            .expect("stat reserved destination")
            .permissions()
            .mode()
            & 0o777,
        0o700
    );

    let error = bounded(transport.sync_up(
        &source,
        "~/workspace/.beam/git/gen2",
        SyncOptions {
            owned: Some(OwnedWorkspace {
                root: "~/workspace",
                owner_bytes: "beam-workspace-v1 other 00000000000000000000000000000000",
            }),
            ..SyncOptions::default()
        },
    ))
    .await
    .expect_err("foreign owner must be refused");
    assert!(error.to_string().contains("not owned by this handoff"));
    assert!(!workspace.join(".beam/git/gen2").exists());
}

#[tokio::test(flavor = "current_thread")]
async fn owned_download_creates_local_bytes_only_after_the_owner_proof() {
    if !have_rsync() {
        return;
    }
    let fixture = Fixture::new();
    let workspace = fixture.root.join("workspace");
    let remote = workspace.join(".beam/session");
    let owner = "beam-workspace-v1 rec1 fedcba9876543210fedcba9876543210";
    fs::create_dir_all(&remote).expect("create owned remote directory");
    fs::write(workspace.join(".beam/owner"), format!("{owner}\n")).expect("write owner marker");
    fs::write(remote.join("session.jsonl"), b"grown\n").expect("write remote session");
    let transport = LocalTransport::new(&fixture.root).expect("construct local transport");
    let refused = fixture.root.join("refused-return");

    let error = bounded(transport.sync_down(
        "~/workspace/.beam/session",
        &refused,
        SyncOptions {
            owned: Some(OwnedWorkspace {
                root: "~/workspace",
                owner_bytes: "foreign",
            }),
            ..SyncOptions::default()
        },
    ))
    .await
    .expect_err("foreign owner download must fail");
    assert!(error.to_string().contains("not owned by this handoff"));
    assert!(!refused.exists());

    let returned = fixture.root.join("returned");
    bounded(transport.sync_down(
        "~/workspace/.beam/session",
        &returned,
        SyncOptions {
            owned: Some(OwnedWorkspace {
                root: "~/workspace",
                owner_bytes: owner,
            }),
            ..SyncOptions::default()
        },
    ))
    .await
    .expect("owned download");
    assert_eq!(
        fs::read_to_string(returned.join("session.jsonl")).expect("read returned session"),
        "grown\n"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn held_create_walk_rejects_a_parent_swapped_mid_descent() {
    let fixture = Fixture::new();
    let outside = fixture.root.join("outside");
    let target = fixture.root.join("tree/a/b");
    fs::create_dir(&outside).expect("create outside directory");
    let blocks = create_walk_blocks(&target).expect("generate create walk");
    let swap = format!(
        "mv {} {}\nln -s {} {}",
        shq(&fixture.root.join("tree/a").to_string_lossy()),
        shq(&fixture.root.join("tree/a-aside").to_string_lossy()),
        shq(&outside.to_string_lossy()),
        shq(&fixture.root.join("tree/a").to_string_lossy())
    );
    let script = blocks[..blocks.len() - 1]
        .iter()
        .chain([&swap, blocks.last().expect("walk has a last block")])
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    let result = bounded(run(&["bash", "-c", &script], &RunOptions::default()))
        .await
        .expect("run adversarial create walk");
    assert_ne!(result.code, 0);
    assert_eq!(
        fs::read_dir(&outside)
            .expect("read outside directory")
            .count(),
        0
    );
    assert!(fixture.root.join("tree/a-aside/b").exists());
}
