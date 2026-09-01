use std::ffi::OsString;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use crate::transport::Transport;
use crate::util::digest::{MAX_TREE_DEPTH, file_sha256};
use crate::util::shell::shq;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::WorkspaceError;

const WS_FP_SENTINEL: &str = "__beam_ws_fp_v1__";

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct WorkspaceFingerprint {
    pub digest: String,
    pub entries: usize,
}

struct WalkFrame {
    directory: PathBuf,
    label: String,
    entries: Vec<OsString>,
    next: usize,
}

pub async fn remote_workspace_tree_fingerprint(
    transport: &dyn Transport,
    remote_cwd: &str,
) -> Result<WorkspaceFingerprint, WorkspaceError> {
    let script = remote_workspace_fingerprint_script(remote_cwd);
    let output = transport.exec_checked(&script).await?;
    let last = last_nonempty_line(&output);
    parse_remote_fingerprint(last)
}

pub(super) fn fingerprint_script_golden() -> (&'static str, String) {
    (
        "workspace-tree-fingerprint",
        remote_workspace_fingerprint_script("/srv/beam/workspace"),
    )
}

pub fn staged_workspace_tree_fingerprint(
    stage_dir: &Path,
) -> Result<WorkspaceFingerprint, WorkspaceError> {
    let mut records = vec![b"d .".to_vec()];
    walk_workspace(stage_dir, ".", &mut records, FingerprintKind::Ship)?;
    Ok(digest_records(records, b'\n'))
}

pub fn workspace_return_fingerprint(
    directory: &Path,
) -> Result<WorkspaceFingerprint, WorkspaceError> {
    let mut records = vec![b"d .".to_vec()];
    walk_workspace(directory, ".", &mut records, FingerprintKind::Return)?;
    Ok(digest_records(records, 0))
}

#[derive(Clone, Copy)]
enum FingerprintKind {
    Ship,
    Return,
}

fn walk_workspace(
    root: &Path,
    root_label: &str,
    records: &mut Vec<Vec<u8>>,
    kind: FingerprintKind,
) -> Result<(), WorkspaceError> {
    let mut stack = vec![walk_frame(root, root_label)?];
    while let Some(frame) = stack.last_mut() {
        if frame.next == frame.entries.len() {
            stack.pop();
            continue;
        }
        let entry = frame.entries[frame.next].clone();
        frame.next += 1;
        let name = entry
            .to_str()
            .ok_or_else(|| unprovable_name(&frame.directory, kind))?;
        validate_name(name, &frame.directory, kind)?;
        let path = frame.directory.join(&entry);
        let label = format!("{}/{name}", frame.label);
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.is_dir() {
            push_directory(&mut stack, records, path, label, metadata.mode(), kind)?;
        } else {
            push_non_directory(records, &path, &label, &metadata, kind)?;
        }
    }
    Ok(())
}

fn push_directory(
    stack: &mut Vec<WalkFrame>,
    records: &mut Vec<Vec<u8>>,
    path: PathBuf,
    label: String,
    mode: u32,
    kind: FingerprintKind,
) -> Result<(), WorkspaceError> {
    if stack.len() == MAX_TREE_DEPTH {
        let noun = match kind {
            FingerprintKind::Ship => "ship",
            FingerprintKind::Return => "return",
        };
        return Err(WorkspaceError::message(format!(
            "beam: the {noun} stage is deeper than {MAX_TREE_DEPTH} directories at {} — refusing \
             to walk a cyclic or runaway tree",
            path.display()
        )));
    }
    let record = match kind {
        FingerprintKind::Ship => format!("d {label}"),
        FingerprintKind::Return => format!("d {} {label}", mode_text(mode)),
    };
    records.push(record.into_bytes());
    stack.push(walk_frame(&path, &label)?);
    Ok(())
}

fn push_non_directory(
    records: &mut Vec<Vec<u8>>,
    path: &Path,
    label: &str,
    metadata: &fs::Metadata,
    kind: FingerprintKind,
) -> Result<(), WorkspaceError> {
    let record = if metadata.is_file() {
        let digest = file_sha256(path)?;
        match kind {
            FingerprintKind::Ship => format!("f {digest} {label}"),
            FingerprintKind::Return => {
                format!("f {} {digest} {label}", mode_text(metadata.mode()))
            }
        }
    } else if metadata.file_type().is_symlink() {
        let target = fs::read_link(path)?;
        let digest = hex::encode(Sha256::digest(target.as_os_str().as_bytes()));
        format!("l {digest} {label}")
    } else {
        match kind {
            FingerprintKind::Return => format!("s {label}"),
            FingerprintKind::Ship => {
                return Err(WorkspaceError::message(format!(
                    "beam: the ship stage contains an unsafe filesystem entry: {}",
                    path.display()
                )));
            }
        }
    };
    records.push(record.into_bytes());
    Ok(())
}

fn walk_frame(directory: &Path, label: &str) -> Result<WalkFrame, WorkspaceError> {
    let entries = fs::read_dir(directory)?
        .map(|entry| entry.map(|value| value.file_name()))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(WalkFrame {
        directory: directory.to_path_buf(),
        label: label.to_owned(),
        entries,
        next: 0,
    })
}

fn validate_name(
    name: &str,
    directory: &Path,
    kind: FingerprintKind,
) -> Result<(), WorkspaceError> {
    if !name.contains(['\n', '\\']) {
        return Ok(());
    }
    Err(unprovable_name(directory, kind))
}

fn unprovable_name(directory: &Path, kind: FingerprintKind) -> WorkspaceError {
    let noun = match kind {
        FingerprintKind::Ship => "ship",
        FingerprintKind::Return => "return",
    };
    WorkspaceError::message(format!(
        "beam: the {noun} stage contains an unprovable file name under {} — refusing",
        directory.display()
    ))
}

fn mode_text(mode: u32) -> String {
    format!("{:04o}", mode & 0o7777)
}

fn digest_records(mut records: Vec<Vec<u8>>, separator: u8) -> WorkspaceFingerprint {
    records.sort();
    let entries = records.len();
    let mut hasher = Sha256::new();
    for record in records {
        hasher.update(record);
        hasher.update([separator]);
    }
    WorkspaceFingerprint {
        digest: hex::encode(hasher.finalize()),
        entries,
    }
}

fn parse_remote_fingerprint(last: &str) -> Result<WorkspaceFingerprint, WorkspaceError> {
    let mut fields = last.split(' ');
    let sentinel = fields.next();
    let digest = fields.next();
    let entries = fields.next();
    let complete = fields.next().is_none();
    if sentinel != Some(WS_FP_SENTINEL) || !complete {
        return Err(missing_remote_proof(last));
    }
    let Some(digest) = digest.filter(|value| valid_digest(value)) else {
        return Err(missing_remote_proof(last));
    };
    let entries = entries
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| missing_remote_proof(last))?;
    Ok(WorkspaceFingerprint {
        digest: digest.to_owned(),
        entries,
    })
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn missing_remote_proof(last: &str) -> WorkspaceError {
    let detail = if last.is_empty() { "no output" } else { last };
    WorkspaceError::message(format!(
        "beam: the uploaded-workspace proof produced no result (got: {detail}) — refusing"
    ))
}

fn last_nonempty_line(output: &str) -> &str {
    output
        .split('\n')
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or("")
}

fn remote_workspace_fingerprint_script(remote_cwd: &str) -> String {
    let prune = "-path ./.beam -prune -o";
    [
        "set -u".to_owned(),
        super::enter_workspace_script(remote_cwd),
        format!(
            "__beam_odd=$(find . {prune} ! -type f ! -type d ! -type l -print | LC_ALL=C sort)"
        ),
        format!(
            "if [ -n \"$__beam_odd\" ]; then printf '%s\\n' {} \"$__beam_odd\" >&2; exit \
             82; fi",
            shq("beam: the shipped workspace contains non-regular entries \
                 (device/fifo/socket) — refusing to prove it:")
        ),
        "__beam_nl='*".to_owned(),
        "*'".to_owned(),
        format!(
            "if [ -n \"$(find . {prune} -name \"$__beam_nl\" -print)\" ] || [ -n \
             \"$(find . {prune} -name '*\\\\*' -print)\" ]; then echo {} >&2; exit 82; fi",
            shq(
                "beam: the shipped workspace contains file names with newlines or backslashes — \
                 refusing to prove an unprovable tree"
            )
        ),
        hash_tool_line(),
        format!(
            "__beam_manifest=$({{ find . {prune} -type d -print | sed 's/^/d /'; find . {prune} \
             -type f -exec $__beam_hash {{}} + | sed -n \
             's/^\\([0-9a-f]\\{{64\\}}\\)[ ][ *]\\(.*\\)$/f \\1 \\2/p'; find . {prune} -type l \
             -print | while IFS= read -r __beam_link; do printf 'l %s %s\\n' \"$(printf '%s' \
             \"$(readlink -- \"$__beam_link\")\" | $__beam_hash | awk '{{print $1}}')\" \
             \"$__beam_link\"; done; }} | LC_ALL=C sort)"
        ),
        format!("__beam_fc=$(find . {prune} -type f -print | wc -l)"),
        "__beam_fm=$(printf '%s\\n' \"$__beam_manifest\" | grep -c '^f ' || true)".to_owned(),
        "if [ \"$((__beam_fc))\" -ne \"$((__beam_fm))\" ]; then echo \"beam: the workspace \
         proof hashed $__beam_fm of $__beam_fc files — refusing an incomplete proof\" >&2; exit \
         81; fi"
            .to_owned(),
        "__beam_digest=$(printf '%s\\n' \"$__beam_manifest\" | $__beam_hash | awk '{print $1}')"
            .to_owned(),
        "__beam_total=$(printf '%s\\n' \"$__beam_manifest\" | wc -l)".to_owned(),
        format!(
            "printf '%s %s %s\\n' {} \"$__beam_digest\" \"$((__beam_total))\"",
            shq(WS_FP_SENTINEL)
        ),
    ]
    .join("\n")
}

fn hash_tool_line() -> String {
    format!(
        "if command -v sha256sum >/dev/null 2>&1; then __beam_hash=sha256sum; elif command -v \
         shasum >/dev/null 2>&1; then __beam_hash='shasum -a 256'; else echo {} >&2; exit 80; fi",
        shq(
            "beam: no sha256 tool (sha256sum or shasum) on the target — cannot prove the uploaded \
             workspace"
        )
    )
}
