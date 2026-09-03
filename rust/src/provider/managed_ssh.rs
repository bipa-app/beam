//! Shared key lifecycle, local prerequisite checks, and remote bootstrap for
//! managed providers whose data plane is `SshTransport`.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs::{self, Permissions};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::env::BeamEnv;
use crate::provider::ProviderError;
use crate::transport::Transport;
use crate::transport::ssh::SshTransport;
use crate::util::private_dir::ensure_private_beam_dir;
use crate::util::shell::{RunOptions, run, shq, which};

const HERDR_LINUX_X86_64_SHA256: &str =
    "b872ea7e40fa2cb17e857ac9b62b1bf26db7b403c622f5d2f3f5b35f6e9acd28";
const HERDR_LINUX_X86_64_URL: &str =
    "https://github.com/herdrdev/herdr/releases/download/v0.8.0/herdr-linux-x86_64";
const OWNER_TOKEN_BYTES: usize = 24;
const SSH_KEYGEN_OUTPUT_BYTES_MAX: usize = 16 * 1024;
const SSH_KEYGEN_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy)]
pub enum ManagedSshProvider {
    E2b,
    Modal,
}

impl ManagedSshProvider {
    fn name(self) -> &'static str {
        match self {
            Self::E2b => "e2b",
            Self::Modal => "modal",
        }
    }
}

#[derive(Debug)]
pub struct ManagedSshIdentity {
    pub path: PathBuf,
    pub public_key: String,
    pub sha256: String,
}

pub struct ManagedLinuxBootstrapOptions<'a> {
    pub provider: &'a str,
    pub use_sudo: bool,
}

pub fn new_owner_token() -> Result<String, ProviderError> {
    let mut bytes = [0_u8; OWNER_TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|source| {
        ProviderError::message(format!(
            "could not create managed sandbox owner token: {source}"
        ))
    })?;
    Ok(hex::encode(bytes))
}

pub fn assert_owner_token(value: &str, provider: &str) -> Result<(), ProviderError> {
    let valid = value.len() == OWNER_TOKEN_BYTES * 2
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if !valid {
        return Err(ProviderError::message(format!(
            "{provider} owner token is malformed — state.json tampered or corrupted?"
        )));
    }
    Ok(())
}

pub async fn ensure_managed_ssh_identity(
    provider: ManagedSshProvider,
    owner_token: &str,
    expected_sha256: Option<&str>,
) -> Result<ManagedSshIdentity, ProviderError> {
    ensure_managed_ssh_identity_in(
        provider,
        owner_token,
        expected_sha256,
        &BeamEnv::resolve(None, None),
        None,
    )
    .await
}

pub fn remove_managed_ssh_identity(
    provider: ManagedSshProvider,
    owner_token: &str,
) -> Result<(), ProviderError> {
    remove_managed_ssh_identity_in(provider, owner_token, &BeamEnv::resolve(None, None))
}

pub async fn bootstrap_managed_linux(
    transport: &SshTransport,
    options: ManagedLinuxBootstrapOptions<'_>,
) -> Result<(), ProviderError> {
    let script = managed_linux_bootstrap_script(options);
    transport.exec_checked(&script).await.map_err(|source| {
        ProviderError::caused_by("managed sandbox bootstrap failed".to_owned(), source)
    })?;
    Ok(())
}

pub fn managed_ssh_check_lines() -> Vec<String> {
    managed_ssh_check_lines_in(None)
}

pub fn managed_ssh_tools_ready() -> bool {
    managed_ssh_tools_ready_in(None)
}

fn identity_path(
    provider: ManagedSshProvider,
    owner_token: &str,
    environment: &BeamEnv,
) -> Result<PathBuf, ProviderError> {
    assert_owner_token(owner_token, provider.name())?;
    Ok(environment
        .beam_dir
        .join("keys")
        .join(format!("{}-{owner_token}.ed25519", provider.name())))
}

async fn ensure_managed_ssh_identity_in(
    provider: ManagedSshProvider,
    owner_token: &str,
    expected_sha256: Option<&str>,
    environment: &BeamEnv,
    command_environment: Option<&BTreeMap<String, String>>,
) -> Result<ManagedSshIdentity, ProviderError> {
    let path = identity_path(provider, owner_token, environment)?;
    let key_exists = match fs::symlink_metadata(&path) {
        Ok(_) => true,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => false,
        Err(source) => {
            return Err(ProviderError::caused_by(
                format!(
                    "could not inspect {} SSH identity at {}",
                    provider.name(),
                    path.display()
                ),
                source,
            ));
        }
    };
    if !key_exists {
        if expected_sha256.is_some() {
            return Err(ProviderError::message(format!(
                "{} SSH identity {} is missing — restore the key before connecting",
                provider.name(),
                path.display()
            )));
        }
        create_identity(provider, &path, environment, command_environment).await?;
    }
    tighten_private_key(provider, &path)?;
    let output = run_keygen(
        &["ssh-keygen", "-y", "-f", path.to_string_lossy().as_ref()],
        command_environment,
    )
    .await?;
    if output.code != 0 {
        return Err(keygen_exit_error(provider, &path, "read", &output));
    }
    let public_key = parse_public_key(provider, &output.stdout)?;
    let sha256 = hex::encode(Sha256::digest(public_key.as_bytes()));
    if expected_sha256.is_some_and(|expected| expected != sha256) {
        return Err(ProviderError::message(format!(
            "{} SSH identity at {} does not match this handoff — refusing",
            provider.name(),
            path.display()
        )));
    }
    Ok(ManagedSshIdentity {
        path,
        public_key,
        sha256,
    })
}

async fn create_identity(
    provider: ManagedSshProvider,
    path: &Path,
    environment: &BeamEnv,
    command_environment: Option<&BTreeMap<String, String>>,
) -> Result<(), ProviderError> {
    ensure_private_beam_dir(&environment.beam_dir, &["keys"]).map_err(|source| {
        ProviderError::caused_by(
            format!("could not prepare {} SSH key directory", provider.name()),
            source,
        )
    })?;
    let path_text = path.to_string_lossy();
    let output = run_keygen(
        &[
            "ssh-keygen",
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-f",
            &path_text,
        ],
        command_environment,
    )
    .await?;
    if output.code != 0 {
        return Err(keygen_exit_error(provider, path, "create", &output));
    }
    Ok(())
}

async fn run_keygen(
    argv: &[&str],
    command_environment: Option<&BTreeMap<String, String>>,
) -> Result<crate::util::shell::RunResult, ProviderError> {
    run(
        argv,
        &RunOptions {
            base_env: command_environment,
            max_output_bytes: SSH_KEYGEN_OUTPUT_BYTES_MAX,
            timeout: SSH_KEYGEN_TIMEOUT,
            ..RunOptions::default()
        },
    )
    .await
    .map_err(|source| ProviderError::caused_by("ssh-keygen failed".to_owned(), source))
}

fn keygen_exit_error(
    provider: ManagedSshProvider,
    path: &Path,
    operation: &str,
    output: &crate::util::shell::RunResult,
) -> ProviderError {
    let detail = if output.stderr.trim().is_empty() {
        output.stdout.trim()
    } else {
        output.stderr.trim()
    };
    ProviderError::message(format!(
        "could not {operation} {} SSH identity at {}: {detail}",
        provider.name(),
        path.display()
    ))
}

fn parse_public_key(provider: ManagedSshProvider, output: &str) -> Result<String, ProviderError> {
    let mut fields = output.split_whitespace();
    let algorithm = fields.next().unwrap_or_default();
    let body = fields.next().unwrap_or_default();
    let core = body.trim_end_matches('=');
    let padding_count = body.len() - core.len();
    let valid_body = !core.is_empty()
        && core
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
        && padding_count <= 3;
    if algorithm != "ssh-ed25519" || !valid_body {
        return Err(ProviderError::message(format!(
            "{} SSH identity produced a malformed Ed25519 public key",
            provider.name()
        )));
    }
    Ok(format!("{algorithm} {body}"))
}

fn tighten_private_key(provider: ManagedSshProvider, path: &Path) -> Result<(), ProviderError> {
    let metadata = fs::symlink_metadata(path).map_err(|source| {
        ProviderError::caused_by(
            format!(
                "could not inspect {} SSH identity at {}",
                provider.name(),
                path.display()
            ),
            source,
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ProviderError::message(format!(
            "{} SSH identity at {} is not a regular file — refusing",
            provider.name(),
            path.display()
        )));
    }
    if metadata.uid() != rustix::process::getuid().as_raw() {
        return Err(ProviderError::message(format!(
            "{} SSH identity at {} is not owned by the current user — refusing",
            provider.name(),
            path.display()
        )));
    }
    fs::set_permissions(path, Permissions::from_mode(0o600)).map_err(|source| {
        ProviderError::caused_by(
            format!(
                "could not protect {} SSH identity at {}",
                provider.name(),
                path.display()
            ),
            source,
        )
    })?;
    let protected = fs::symlink_metadata(path).map_err(|source| {
        ProviderError::caused_by(
            format!(
                "could not re-check {} SSH identity at {}",
                provider.name(),
                path.display()
            ),
            source,
        )
    })?;
    if protected.file_type().is_symlink() || !protected.is_file() {
        return Err(ProviderError::message(format!(
            "{} SSH identity at {} changed while protecting it — refusing",
            provider.name(),
            path.display()
        )));
    }
    if protected.uid() != rustix::process::getuid().as_raw() {
        return Err(ProviderError::message(format!(
            "{} SSH identity at {} changed owner while protecting it — refusing",
            provider.name(),
            path.display()
        )));
    }
    if protected.permissions().mode() & 0o777 != 0o600 {
        return Err(ProviderError::message(format!(
            "{} SSH identity at {} did not retain mode 0600 — refusing",
            provider.name(),
            path.display()
        )));
    }
    Ok(())
}

fn remove_managed_ssh_identity_in(
    provider: ManagedSshProvider,
    owner_token: &str,
    environment: &BeamEnv,
) -> Result<(), ProviderError> {
    let path = identity_path(provider, owner_token, environment)?;
    let mut public_path = OsString::from(path.as_os_str());
    public_path.push(".pub");
    remove_identity_file(provider, &path)?;
    remove_identity_file(provider, Path::new(&public_path))
}

fn remove_identity_file(provider: ManagedSshProvider, path: &Path) -> Result<(), ProviderError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(ProviderError::caused_by(
            format!(
                "could not remove {} SSH identity at {}",
                provider.name(),
                path.display()
            ),
            source,
        )),
    }
}

fn managed_linux_bootstrap_script(options: ManagedLinuxBootstrapOptions<'_>) -> String {
    let elevate = if options.use_sudo { "sudo " } else { "" };
    let packages = "rsync curl ca-certificates coreutils";
    [
        "set -eu".to_owned(),
        "if [ \"$(uname -m)\" != x86_64 ]; then".to_owned(),
        format!(
            "  echo {} >&2; exit 2",
            shq(&format!(
                "beam: {} requires an x86_64 sandbox",
                options.provider
            ))
        ),
        "fi".to_owned(),
        "if ! command -v rsync >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then"
            .to_owned(),
        format!(
            "  command -v apt-get >/dev/null 2>&1 || {{ echo {} >&2; exit 2; }}",
            shq(&format!(
                "beam: {} needs rsync and curl; no apt-get was found",
                options.provider
            ))
        ),
        format!("  {elevate}apt-get update -qq"),
        format!("  {elevate}apt-get install -y -qq {packages}"),
        "fi".to_owned(),
        "if ! command -v herdr >/dev/null 2>&1; then".to_owned(),
        "  __beam_herdr=\"$(mktemp)\"".to_owned(),
        format!(
            "  curl -fsSL -o \"$__beam_herdr\" {}",
            shq(HERDR_LINUX_X86_64_URL)
        ),
        format!(
            "  printf '%s  %s\\n' {} \"$__beam_herdr\" | sha256sum -c -",
            shq(HERDR_LINUX_X86_64_SHA256)
        ),
        format!("  {elevate}install -m 0755 \"$__beam_herdr\" /usr/local/bin/herdr"),
        "  rm -f \"$__beam_herdr\"".to_owned(),
        "fi".to_owned(),
        "command -v rsync >/dev/null && command -v herdr >/dev/null".to_owned(),
    ]
    .join("\n")
}

fn managed_ssh_check_lines_in(
    command_environment: Option<&BTreeMap<String, String>>,
) -> Vec<String> {
    ["ssh", "rsync", "ssh-keygen"]
        .into_iter()
        .map(|tool| {
            let found = which(tool, command_environment)
                .map_or_else(|| "MISSING".to_owned(), |path| path.display().to_string());
            format!("local {tool}:{}{found}", " ".repeat(11 - tool.len()))
        })
        .collect()
}

fn managed_ssh_tools_ready_in(command_environment: Option<&BTreeMap<String, String>>) -> bool {
    ["ssh", "rsync", "ssh-keygen"]
        .into_iter()
        .all(|tool| which(tool, command_environment).is_some())
}

#[cfg(test)]
mod tests;
