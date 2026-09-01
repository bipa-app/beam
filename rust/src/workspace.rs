//! Workspace: local mirror staging plus owner-bound remote transactions.
//!
//! The remote shell generators keep every check and effect in one held-cwd
//! invocation. Local staging is quarantined and fingerprinted before bytes
//! cross a transport.

use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::util::shell::{shq, shq_remote_path};

mod containment;
mod fingerprint;
mod staging;
mod upload;

pub use containment::{
    ContainedWorkspace, OwnerAdoption, PurgeResult, ReleaseResult, assert_contained_workspace,
    establish_contained_workspace, purge_owned_workspace_contents, release_owned_workspace,
};
pub use fingerprint::{
    WorkspaceFingerprint, remote_workspace_tree_fingerprint, staged_workspace_tree_fingerprint,
    workspace_return_fingerprint,
};
pub use staging::{
    ReturnManifest, ReturnStage, ReturnUnchangedOptions, StageReturnOptions, StagedWorkspaceReturn,
    StagedWorkspaceShip, assert_no_local_reserved_collision, assert_ship_size_bounded,
    assert_workspace_return_unchanged, create_return_stage, ensure_git_exclude, gather_excludes,
    git_summary, remote_workspace_return_fingerprint, stage_workspace_return, stage_workspace_ship,
    write_return_stage_manifest,
};
pub use upload::{
    publish_workspace_upload_stage, remote_workspace_upload_stage_present,
    remove_workspace_upload_stage, workspace_upload_stage_path,
};

pub const BEAM_RESERVED_DIR: &str = ".beam";
pub const BEAM_OWNER_FILE: &str = "owner";
pub const BEAM_RESERVED_EXCLUDE: &str = "/.[bB][eE][aA][mM]";
pub const GIT_METADATA_EXCLUDE: &str = ".[gG][iI][tT]";
pub const BEAM_GITPTR_EXCLUDE: &str = "/.[bB][eE][aA][mM]-gitptr-*";

pub fn workspace_script_golden() -> Result<Vec<(&'static str, String)>, WorkspaceError> {
    let mut scripts = containment::containment_script_golden();
    scripts.push(fingerprint::fingerprint_script_golden());
    scripts.extend(upload::upload_script_golden()?);
    Ok(scripts)
}

pub fn remote_workspace_name(local_cwd: &str) -> String {
    let digest = hex::encode(Sha256::digest(local_cwd.as_bytes()));
    let base = Path::new(local_cwd)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let safe: String = base
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let safe = if safe.is_empty() { "workspace" } else { &safe };
    format!("{safe}-{}", &digest[..10])
}

pub fn workspace_owner_content(
    record_id: &str,
    workspace_token: &str,
) -> Result<String, WorkspaceError> {
    let valid = workspace_token.len() == 32
        && workspace_token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'));
    if !valid {
        return Err(WorkspaceError::message(format!(
            "beam: invalid workspace ownership token for {record_id}"
        )));
    }
    Ok(format!("beam-workspace-v1 {record_id} {workspace_token}"))
}

pub fn format_bytes(bytes: u64) -> String {
    const KIB: u64 = 1024;
    const MIB: u64 = KIB * 1024;
    const GIB: u64 = MIB * 1024;
    if bytes >= GIB {
        return format_bytes_unit(bytes, GIB, "GiB");
    }
    if bytes >= MIB {
        return format_bytes_unit(bytes, MIB, "MiB");
    }
    if bytes >= KIB {
        return format_bytes_unit(bytes, KIB, "KiB");
    }
    format!("{bytes} B")
}

fn format_bytes_unit(bytes: u64, unit: u64, label: &str) -> String {
    let tenths = ((bytes as f64 / unit as f64) * 10.0).round() / 10.0;
    format!("{tenths:.1} {label}")
}

pub fn assert_purgeable_path(remote_cwd: &str) -> Result<(), WorkspaceError> {
    let segments: Vec<&str> = remote_cwd
        .strip_prefix('/')
        .unwrap_or("")
        .split('/')
        .collect();
    let invalid_segment = segments
        .iter()
        .any(|segment| segment.is_empty() || matches!(*segment, "." | ".."));
    if !remote_cwd.starts_with('/') {
        return Err(suspicious_path(remote_cwd));
    }
    if remote_cwd.len() < 8 {
        return Err(suspicious_path(remote_cwd));
    }
    if remote_cwd.contains(['\r', '\n', '\0']) {
        return Err(suspicious_path(remote_cwd));
    }
    if segments.len() < 2 {
        return Err(suspicious_path(remote_cwd));
    }
    if invalid_segment {
        return Err(suspicious_path(remote_cwd));
    }
    Ok(())
}

fn suspicious_path(remote_cwd: &str) -> WorkspaceError {
    WorkspaceError::message(format!("refusing to purge suspicious path: {remote_cwd}"))
}

pub fn enter_workspace_script(remote_cwd: &str) -> String {
    let expected = shq_remote_path(remote_cwd);
    [
        format!(
            "cd -P -- {expected} || {{ echo {} >&2; exit 62; }}",
            shq(&format!("beam: cannot enter workspace {remote_cwd}"))
        ),
        "__beam_actual=$(/bin/pwd -P)".to_owned(),
        format!(
            "if [ \"$__beam_actual\" != {expected} ]; then echo {} >&2; exit 62; fi",
            shq(&format!(
                "beam: workspace path no longer resolves to {remote_cwd}"
            ))
        ),
    ]
    .join("\n")
}

pub fn owner_guard_script(owner: &str) -> String {
    let refuse =
        r#"echo "beam: the workspace is not owned by this handoff — refusing" >&2; exit 52"#;
    [
        "(".to_owned(),
        format!("  __beam_og_root=$(/bin/pwd -P) || {{ {refuse}; }}"),
        format!(
            "  if [ -L ./{BEAM_RESERVED_DIR} ] || [ ! -d ./{BEAM_RESERVED_DIR} ]; then \
             {refuse}; fi"
        ),
        format!("  cd -P -- ./{BEAM_RESERVED_DIR} 2>/dev/null || {{ {refuse}; }}"),
        format!(
            "  if [ \"$(/bin/pwd -P)\" != \"$__beam_og_root/{BEAM_RESERVED_DIR}\" ]; then \
             {refuse}; fi"
        ),
        format!("  if [ -L {BEAM_OWNER_FILE} ] || [ ! -f {BEAM_OWNER_FILE} ]; then {refuse}; fi"),
        format!(
            "  if [ \"$(cat {BEAM_OWNER_FILE} 2>/dev/null)\" != {} ]; then {refuse}; fi",
            shq(owner)
        ),
        ") || exit $?".to_owned(),
    ]
    .join("\n")
}

pub fn owned_destination_blocks(
    owner: &str,
    relative_from_root: &[&str],
    create: bool,
) -> Result<Vec<String>, OwnedDestinationError> {
    if relative_from_root.is_empty() {
        return Ok(vec![owner_guard_script(owner)]);
    }
    if relative_from_root[0] != BEAM_RESERVED_DIR {
        return Err(OwnedDestinationError(format!(
            "beam: an owned nested destination must live under {BEAM_RESERVED_DIR}/ — got {}",
            relative_from_root.join("/")
        )));
    }
    validate_owned_components(relative_from_root)?;
    let mut blocks = Vec::with_capacity(relative_from_root.len());
    blocks.push(owned_first_block(owner));
    for segment in &relative_from_root[1..] {
        blocks.push(owned_child_block(segment, create));
    }
    Ok(blocks)
}

pub fn owned_destination_script(
    owner: &str,
    relative_from_root: &[&str],
    create: bool,
) -> Result<String, OwnedDestinationError> {
    Ok(owned_destination_blocks(owner, relative_from_root, create)?.join("\n"))
}

fn validate_owned_components(components: &[&str]) -> Result<(), OwnedDestinationError> {
    for segment in components {
        let invalid = segment.is_empty()
            || *segment == "."
            || *segment == ".."
            || segment.contains('/')
            || segment.contains(['\r', '\n', '\0']);
        if invalid {
            let rendered =
                serde_json::to_string(segment).expect("a Rust string always serializes as JSON");
            return Err(OwnedDestinationError(format!(
                "beam: invalid owned destination component: {rendered}"
            )));
        }
    }
    Ok(())
}

fn owned_first_block(owner: &str) -> String {
    let refuse =
        r#"echo "beam: the workspace is not owned by this handoff — refusing" >&2; exit 52"#;
    [
        format!("__beam_od_prefix=$(/bin/pwd -P) || {{ {refuse}; }}"),
        format!(
            "if [ -L ./{BEAM_RESERVED_DIR} ] || [ ! -d ./{BEAM_RESERVED_DIR} ]; then \
             {refuse}; fi"
        ),
        format!("cd -P -- ./{BEAM_RESERVED_DIR} 2>/dev/null || {{ {refuse}; }}"),
        format!("__beam_od_prefix=\"$__beam_od_prefix\"/{BEAM_RESERVED_DIR}"),
        format!("if [ \"$(/bin/pwd -P)\" != \"$__beam_od_prefix\" ]; then {refuse}; fi"),
        format!("if [ -L {BEAM_OWNER_FILE} ] || [ ! -f {BEAM_OWNER_FILE} ]; then {refuse}; fi"),
        format!(
            "if [ \"$(cat {BEAM_OWNER_FILE} 2>/dev/null)\" != {} ]; then {refuse}; fi",
            shq(owner)
        ),
    ]
    .join("\n")
}

fn owned_child_block(segment: &str, create: bool) -> String {
    let quoted = shq(segment);
    let link = format!(
        "echo {} >&2; exit 61",
        shq(&format!(
            "beam: {segment} is a symlink — refusing the owned transfer"
        ))
    );
    let prepare = if create {
        format!(
            "__beam_od_new=0; if [ ! -e {quoted} ]; then mkdir -- {quoted} || {{ echo {} >&2; \
             exit 66; }}; __beam_od_new=1; fi",
            shq(&format!("beam: cannot create {segment}"))
        )
    } else {
        format!(
            "if [ ! -e {quoted} ]; then echo {} >&2; exit 67; fi",
            shq(&format!(
                "beam: {segment} is missing under the owned workspace — refusing"
            ))
        )
    };
    let mut lines = vec![
        format!("if [ -L {quoted} ]; then {link}; fi"),
        prepare,
        format!("if [ -L {quoted} ] || [ ! -d {quoted} ]; then {link}; fi"),
        format!("cd -P -- {quoted} 2>/dev/null || {{ {link}; }}"),
        format!("__beam_od_prefix=\"$__beam_od_prefix\"/{quoted}"),
        format!(
            "if [ \"$(/bin/pwd -P)\" != \"$__beam_od_prefix\" ]; then echo {} >&2; \
             exit 66; fi",
            shq(&format!(
                "beam: {segment} no longer resolves inside the owned workspace — refusing"
            ))
        ),
    ];
    if create {
        lines.push(owned_mode_block(segment));
    }
    lines.join("\n")
}

fn owned_mode_block(segment: &str) -> String {
    format!(
        "if [ \"$__beam_od_new\" = 1 ]; then chmod 700 . || {{ echo {} >&2; exit 66; }}; \
         [ -n \"$(find . -prune -perm 700)\" ] || {{ echo {} >&2; exit 66; }}; fi",
        shq(&format!("beam: cannot set the mode of {segment}")),
        shq(&format!("beam: the mode of {segment} did not verify"))
    )
}

#[derive(Debug)]
pub struct OwnedDestinationError(String);

impl Display for OwnedDestinationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for OwnedDestinationError {}

#[derive(Debug)]
pub struct WorkspaceError {
    message: String,
    source: Option<Box<dyn Error + Send + Sync>>,
}

impl WorkspaceError {
    pub(crate) fn message(message: String) -> Self {
        Self {
            message,
            source: None,
        }
    }

    pub(crate) fn caused_by<E>(message: String, source: E) -> Self
    where
        E: Error + Send + Sync + 'static,
    {
        Self {
            message,
            source: Some(Box::new(source)),
        }
    }
}

impl Display for WorkspaceError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for WorkspaceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source
            .as_deref()
            .map(|source| source as &(dyn Error + 'static))
    }
}

impl From<std::io::Error> for WorkspaceError {
    fn from(source: std::io::Error) -> Self {
        Self::caused_by(source.to_string(), source)
    }
}

impl From<crate::transport::TransportError> for WorkspaceError {
    fn from(source: crate::transport::TransportError) -> Self {
        Self::caused_by(source.to_string(), source)
    }
}

impl From<crate::util::shell::RunError> for WorkspaceError {
    fn from(source: crate::util::shell::RunError) -> Self {
        Self::caused_by(source.to_string(), source)
    }
}

impl From<crate::util::private_dir::PrivateDirError> for WorkspaceError {
    fn from(source: crate::util::private_dir::PrivateDirError) -> Self {
        Self::caused_by(source.to_string(), source)
    }
}

impl From<OwnedDestinationError> for WorkspaceError {
    fn from(source: OwnedDestinationError) -> Self {
        Self::caused_by(source.to_string(), source)
    }
}
