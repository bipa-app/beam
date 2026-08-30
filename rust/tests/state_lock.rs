//! Goal: preserve Beam's local mutual-exclusion law: publish complete lock
//! bytes create-only, never reclaim a dead or unknown owner, and unlink only
//! after re-proving exact bytes plus dev/inode. Private storage must remain a
//! real uid-owned 0700 directory throughout.
//!
//! Method: exercise real files and hard links under unique temporary roots.
//! Tests pause between stage and publish, replace an owned inode with a
//! successor, plant live/dead/residue owners, and inspect the bytes left on
//! disk after every refusal.

use std::fs::{self, DirBuilder, OpenOptions, Permissions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use beam::state::{
    LockError, LockIdentity, acquire_operation_lock, acquire_state_lock, publish_staged_lock,
    release_lock, stage_lock,
};
use beam::util::private_dir::ensure_private_beam_dir;

static FIXTURE_INDEX: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let index = FIXTURE_INDEX.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("beam-rust-lock-{}-{index}", std::process::id()));
        let mut builder = DirBuilder::new();
        builder.mode(0o700);
        builder
            .create(&root)
            .unwrap_or_else(|error| panic!("create fixture {}: {error}", root.display()));
        Self { root }
    }

    fn beam_dir(&self) -> PathBuf {
        self.root.join("beam")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap_or_else(|error| {
            panic!("remove fixture {}: {error}", self.root.display());
        });
    }
}

fn expect_lock_error(result: Result<LockIdentity, LockError>, context: &str) -> LockError {
    match result {
        Ok(owned) => {
            release_lock(&owned).unwrap_or_else(|error| {
                panic!("release unexpectedly acquired lock for {context}: {error}");
            });
            panic!("{context}: lock acquisition unexpectedly succeeded");
        }
        Err(error) => error,
    }
}

fn write_new(path: &Path, bytes: &[u8]) {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .unwrap_or_else(|error| panic!("create {}: {error}", path.display()));
    file.write_all(bytes)
        .unwrap_or_else(|error| panic!("write {}: {error}", path.display()));
}

#[test]
fn creates_tightens_and_refuses_redirected_private_components() {
    let fixture = Fixture::new();
    let beam_dir = fixture.beam_dir();
    let nested = ensure_private_beam_dir(&beam_dir, &["returns", "r1"])
        .expect("create private Beam directory chain");
    for path in [beam_dir.clone(), beam_dir.join("returns"), nested.clone()] {
        let mode = fs::symlink_metadata(&path)
            .unwrap_or_else(|error| panic!("stat {}: {error}", path.display()))
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700, "private mode for {}", path.display());
    }

    fs::set_permissions(&nested, Permissions::from_mode(0o755)).expect("loosen fixture directory");
    ensure_private_beam_dir(&beam_dir, &["returns", "r1"]).expect("tighten an owned directory");
    assert_eq!(
        fs::metadata(&nested)
            .expect("stat tightened directory")
            .permissions()
            .mode()
            & 0o777,
        0o700
    );

    let target = fixture.root.join("target");
    fs::create_dir(&target).expect("create symlink target");
    let link = fixture.root.join("linked-beam");
    symlink(&target, &link).expect("create private-root symlink");
    let error =
        ensure_private_beam_dir(&link, &[]).expect_err("a private root symlink must be refused");
    assert!(error.to_string().contains("is a symlink"));

    let file = fixture.root.join("beam-file");
    fs::write(&file, b"not a directory").expect("create non-directory fixture");
    let error =
        ensure_private_beam_dir(&file, &[]).expect_err("a private root file must be refused");
    assert!(error.to_string().contains("is not a directory"));

    let error = ensure_private_beam_dir(&beam_dir, &["../escape"])
        .expect_err("a descendant segment must not escape its private root");
    assert!(error.to_string().contains("must be one path component"));
    assert!(!fixture.root.join("escape").exists());
}

#[tokio::test(flavor = "current_thread")]
async fn operation_locks_are_exclusive_releasable_and_record_scoped() {
    let fixture = Fixture::new();
    let beam_dir = fixture.beam_dir();
    let first = acquire_operation_lock(&beam_dir, "r1")
        .await
        .expect("acquire first operation lock");
    let error = expect_lock_error(
        acquire_operation_lock(&beam_dir, "r1").await,
        "same record contention",
    );
    assert!(
        error
            .to_string()
            .contains("already operating on handoff r1")
    );

    let other = acquire_operation_lock(&beam_dir, "r2")
        .await
        .expect("a different record should not contend");
    release_lock(&other).expect("release other record lock");
    release_lock(&first).expect("release first record lock");
    let reacquired = acquire_operation_lock(&beam_dir, "r1")
        .await
        .expect("released lock should be reacquirable");
    release_lock(&reacquired).expect("release reacquired lock");
}

#[tokio::test(flavor = "current_thread")]
async fn state_lock_wait_zero_refuses_a_live_owner_without_deleting_it() {
    let fixture = Fixture::new();
    let beam_dir = fixture.beam_dir();
    let first = acquire_state_lock(&beam_dir, Duration::ZERO)
        .await
        .expect("acquire first state lock");
    let bytes = fs::read(&first.path).expect("read first state lock");
    let error = expect_lock_error(
        acquire_state_lock(&beam_dir, Duration::ZERO).await,
        "state lock contention",
    );
    assert!(error.to_string().contains("holds the state lock"));
    assert_eq!(fs::read(&first.path).expect("re-read state lock"), bytes);
    release_lock(&first).expect("release state lock");
}

#[tokio::test(flavor = "current_thread")]
async fn dead_owner_locks_are_never_reclaimed_or_rewritten() {
    let fixture = Fixture::new();
    let beam_dir = fixture.beam_dir();
    ensure_private_beam_dir(&beam_dir, &[]).expect("create Beam directory");
    let lock_path = beam_dir.join("op-r1.lock");
    let dead_pid = 2_000_000_000_u32;

    for bytes in [
        dead_pid.to_string().into_bytes(),
        format!("{dead_pid} {}\n", "a".repeat(16)).into_bytes(),
    ] {
        write_new(&lock_path, &bytes);
        let error = expect_lock_error(acquire_operation_lock(&beam_dir, "r1").await, "dead owner");
        assert!(error.to_string().contains("no longer running"));
        assert!(error.to_string().contains("remove it manually"));
        assert_eq!(fs::read(&lock_path).expect("read refused lock"), bytes);
        fs::remove_file(&lock_path).expect("remove dead-owner fixture");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn residue_and_oversized_locks_fail_closed_and_stay_byte_exact() {
    let fixture = Fixture::new();
    let beam_dir = fixture.beam_dir();
    ensure_private_beam_dir(&beam_dir, &[]).expect("create Beam directory");
    let lock_path = beam_dir.join("op-r1.lock");
    let current_pid = std::process::id();
    let residues = vec![
        b"0".to_vec(),
        b"-1".to_vec(),
        b"not-a-pid".to_vec(),
        Vec::new(),
        format!("{current_pid} nonhex-nonce!!!\n").into_bytes(),
        vec![b'x'; 129],
    ];
    for bytes in residues {
        write_new(&lock_path, &bytes);
        let error = expect_lock_error(
            acquire_operation_lock(&beam_dir, "r1").await,
            "unrecognized lock residue",
        );
        assert!(error.to_string().contains("remove it manually"));
        assert_eq!(fs::read(&lock_path).expect("read residue lock"), bytes);
        fs::remove_file(&lock_path).expect("remove residue fixture");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn stage_is_invisible_until_atomic_publish_and_loser_cleans_up() {
    let fixture = Fixture::new();
    let beam_dir = fixture.beam_dir();
    ensure_private_beam_dir(&beam_dir, &[]).expect("create Beam directory");
    let lock_path = beam_dir.join("op-r1.lock");
    let staged = stage_lock(&lock_path).expect("stage unpublished lock");
    let stage_path = staged.stage_path.clone();
    assert!(!lock_path.exists());

    let contender = acquire_operation_lock(&beam_dir, "r1")
        .await
        .expect("contender should publish while first lock is staged");
    let bytes = fs::read(&lock_path).expect("read contender lock");
    let result = publish_staged_lock(staged).expect("publish should lose cleanly");
    assert!(result.is_none());
    assert_eq!(fs::read(&lock_path).expect("re-read contender lock"), bytes);
    assert!(!stage_path.exists());
    release_lock(&contender).expect("release contender lock");
}

#[tokio::test(flavor = "current_thread")]
async fn stale_release_never_unlinks_a_successor_inode() {
    let fixture = Fixture::new();
    let beam_dir = fixture.beam_dir();
    let first = acquire_operation_lock(&beam_dir, "r1")
        .await
        .expect("acquire first owner");
    fs::remove_file(&first.path).expect("simulate outside removal");
    let successor = acquire_operation_lock(&beam_dir, "r1")
        .await
        .expect("publish successor");
    let bytes = fs::read(&successor.path).expect("read successor");
    let inode = fs::metadata(&successor.path).expect("stat successor").ino();

    let error = release_lock(&first).expect_err("stale owner must lose release");
    assert!(error.to_string().contains("changed hands"));
    assert_eq!(fs::read(&successor.path).expect("re-read successor"), bytes);
    assert_eq!(
        fs::metadata(&successor.path)
            .expect("re-stat successor")
            .ino(),
        inode
    );
    release_lock(&successor).expect("release successor");
}

#[tokio::test(flavor = "current_thread")]
async fn operation_lock_rejects_path_shaping_record_ids() {
    let fixture = Fixture::new();
    let error = expect_lock_error(
        acquire_operation_lock(&fixture.beam_dir(), "../escape").await,
        "unsafe record id",
    );
    assert!(
        error
            .to_string()
            .contains("not safe for an operation lock path")
    );
    assert!(!fixture.root.join("escape.lock").exists());
}
