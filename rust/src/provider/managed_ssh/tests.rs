//! Goal: prove managed SSH keys stay owner-bound and the remote bootstrap is
//! byte-exact with TypeScript without touching the user's real Beam state.
//!
//! Method: inject a private Beam directory and scripted ssh-keygen, exercise
//! creation/reconnect/removal and hostile local key entries, then compare the
//! generated bootstrap shell to the TypeScript golden.

use std::fs::{self, DirBuilder};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

use super::*;

const OWNER_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";
static FIXTURE_INDEX: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    bin: PathBuf,
    environment: BeamEnv,
    command_environment: BTreeMap<String, String>,
}

impl Fixture {
    fn new() -> Self {
        let index = FIXTURE_INDEX.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "beam-rust-managed-ssh-{}-{index}",
            std::process::id()
        ));
        let mut builder = DirBuilder::new();
        builder.mode(0o700);
        builder
            .create(&root)
            .unwrap_or_else(|error| panic!("create fixture {}: {error}", root.display()));
        let root = root
            .canonicalize()
            .unwrap_or_else(|error| panic!("canonicalize fixture {}: {error}", root.display()));
        let bin = root.join("bin");
        fs::create_dir(&bin).expect("create fixture bin");
        let environment = BeamEnv {
            home: root.clone(),
            beam_dir: root.join("beam-state"),
        };
        let command_environment = BTreeMap::from([
            ("HOME".to_owned(), root.display().to_string()),
            ("LANG".to_owned(), "C".to_owned()),
            ("PATH".to_owned(), bin.display().to_string()),
        ]);
        Self {
            root,
            bin,
            environment,
            command_environment,
        }
    }

    fn script(&self, name: &str, body: &str) {
        let path = self.bin.join(name);
        fs::write(&path, format!("#!/bin/sh\nset -eu\n{body}\n"))
            .unwrap_or_else(|error| panic!("write {}: {error}", path.display()));
        let mut permissions = fs::metadata(&path).expect("stat script").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).expect("chmod script");
    }

    fn install_keygen(&self) {
        self.script(
            "ssh-keygen",
            "if [ \"$1\" = -y ]; then\n  printf '%s\\n' 'ssh-ed25519 QUJDRA== fixture'\n  exit 0\nfi\npath=\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = -f ]; then path=$2; break; fi\n  shift\ndone\nprintf private > \"$path\"\nprintf public > \"$path.pub\"\n/bin/chmod 0644 \"$path\"",
        );
    }

    fn key_path(&self) -> PathBuf {
        self.environment
            .beam_dir
            .join("keys")
            .join(format!("e2b-{OWNER_TOKEN}.ed25519"))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root)
            .unwrap_or_else(|error| panic!("remove fixture {}: {error}", self.root.display()));
    }
}

fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../parity/goldens/box-provider.json");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

#[test]
fn owner_tokens_are_fixed_width_lowercase_hex() {
    let token = new_owner_token().expect("create owner token");
    assert_eq!(token.len(), OWNER_TOKEN_BYTES * 2);
    assert!(
        token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    );
    assert_owner_token(&token, "E2B").expect("generated owner token should validate");
    for invalid in [
        "",
        "ABCDEF",
        "g123456789abcdef0123456789abcdef0123456789abcdef",
    ] {
        let error = assert_owner_token(invalid, "E2B").expect_err("invalid token should fail");
        assert!(error.to_string().contains("E2B owner token is malformed"));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn creates_reuses_and_removes_one_private_identity() {
    let fixture = Fixture::new();
    fixture.install_keygen();
    let identity = ensure_managed_ssh_identity_in(
        ManagedSshProvider::E2b,
        OWNER_TOKEN,
        None,
        &fixture.environment,
        Some(&fixture.command_environment),
    )
    .await
    .expect("create managed identity");
    assert_eq!(identity.path, fixture.key_path());
    assert_eq!(identity.public_key, "ssh-ed25519 QUJDRA==");
    assert_eq!(identity.sha256.len(), 64);
    let mode = fs::metadata(&identity.path)
        .expect("stat private key")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600);

    ensure_managed_ssh_identity_in(
        ManagedSshProvider::E2b,
        OWNER_TOKEN,
        Some(&identity.sha256),
        &fixture.environment,
        Some(&fixture.command_environment),
    )
    .await
    .expect("reuse matching managed identity");
    remove_managed_ssh_identity_in(ManagedSshProvider::E2b, OWNER_TOKEN, &fixture.environment)
        .expect("remove managed identity");
    assert!(!identity.path.exists());
    assert!(!PathBuf::from(format!("{}.pub", identity.path.display())).exists());
}

#[tokio::test(flavor = "current_thread")]
async fn refuses_missing_mismatched_and_symlinked_identities() {
    let fixture = Fixture::new();
    fixture.install_keygen();
    let missing = ensure_managed_ssh_identity_in(
        ManagedSshProvider::E2b,
        OWNER_TOKEN,
        Some("missing"),
        &fixture.environment,
        Some(&fixture.command_environment),
    )
    .await
    .expect_err("a persisted fingerprint requires its private key");
    assert!(missing.to_string().contains("is missing — restore the key"));

    let created = ensure_managed_ssh_identity_in(
        ManagedSshProvider::E2b,
        OWNER_TOKEN,
        None,
        &fixture.environment,
        Some(&fixture.command_environment),
    )
    .await
    .expect("create identity for mismatch probe");
    let mismatch = ensure_managed_ssh_identity_in(
        ManagedSshProvider::E2b,
        OWNER_TOKEN,
        Some("different"),
        &fixture.environment,
        Some(&fixture.command_environment),
    )
    .await
    .expect_err("a different fingerprint should fail");
    assert!(mismatch.to_string().contains("does not match this handoff"));

    fs::remove_file(&created.path).expect("remove private key");
    symlink(&fixture.root, &created.path).expect("plant key symlink");
    let symlink_error = ensure_managed_ssh_identity_in(
        ManagedSshProvider::E2b,
        OWNER_TOKEN,
        None,
        &fixture.environment,
        Some(&fixture.command_environment),
    )
    .await
    .expect_err("a symlinked private key should fail closed");
    assert!(symlink_error.to_string().contains("is not a regular file"));
}

#[test]
fn prerequisite_checks_use_the_child_environment() {
    let fixture = Fixture::new();
    for tool in ["ssh", "rsync", "ssh-keygen"] {
        fixture.script(tool, "exit 0");
    }
    assert!(managed_ssh_tools_ready_in(Some(
        &fixture.command_environment
    )));
    assert_eq!(
        managed_ssh_check_lines_in(Some(&fixture.command_environment)),
        [
            format!("local ssh:        {}", fixture.bin.join("ssh").display()),
            format!("local rsync:      {}", fixture.bin.join("rsync").display()),
            format!(
                "local ssh-keygen: {}",
                fixture.bin.join("ssh-keygen").display()
            ),
        ]
    );
}

#[test]
fn bootstrap_script_matches_typescript_golden() {
    let script = managed_linux_bootstrap_script(ManagedLinuxBootstrapOptions {
        provider: "Box",
        use_sudo: true,
    });
    assert_eq!(script, golden()["bootstrapScript"]);
}
