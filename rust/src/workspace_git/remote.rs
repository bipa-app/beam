use serde::Serialize;

use crate::transport::Transport;
use crate::util::shell::shq;
use crate::workspace::{
    BEAM_OWNER_FILE, BEAM_RESERVED_DIR, enter_workspace_script, owned_destination_script,
    owner_guard_script,
};

use super::tree::GitTreeFingerprint;
use super::{WorkspaceGitError, git_payload_path, git_pointer_bytes, git_pointer_temp_name};

const GIT_FP_SENTINEL: &str = "__beam_git_fp_v1__";

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum RemoteGitEntryKind {
    Absent,
    Directory,
    Other,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum RemoteGitPointerKind {
    Absent,
    Ours,
    Foreign,
}

#[derive(Clone, PartialEq, Eq, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGitPointerState {
    pub git: RemoteGitPointerKind,
    pub payload_present: bool,
}

pub async fn remote_git_entry_kind(
    transport: &dyn Transport,
    remote_cwd: &str,
    owner: Option<&str>,
) -> Result<RemoteGitEntryKind, WorkspaceGitError> {
    let script = remote_git_entry_kind_script(remote_cwd, owner);
    let output = transport.exec_checked(&script).await?;
    match last_nonempty_line(&output) {
        "absent" => Ok(RemoteGitEntryKind::Absent),
        "directory" => Ok(RemoteGitEntryKind::Directory),
        "other" => Ok(RemoteGitEntryKind::Other),
        kind => Err(WorkspaceGitError::message(format!(
            "beam: remote Git layout probe returned an invalid result: {kind:?}"
        ))),
    }
}

pub async fn remote_git_tree_fingerprint(
    transport: &dyn Transport,
    remote_cwd: &str,
    git_dir_relative: &str,
    owner: Option<&str>,
) -> Result<GitTreeFingerprint, WorkspaceGitError> {
    let script = remote_git_tree_fingerprint_script(remote_cwd, git_dir_relative, owner)?;
    let output = transport.exec_checked(&script).await?;
    parse_remote_git_fingerprint(last_nonempty_line(&output))
}

pub async fn remote_git_pointer_state(
    transport: &dyn Transport,
    remote_cwd: &str,
    generation: &str,
    owner: Option<&str>,
) -> Result<RemoteGitPointerState, WorkspaceGitError> {
    let script = remote_git_pointer_state_script(remote_cwd, generation, owner)?;
    let output = transport.exec_checked(&script).await?;
    let mut git = None;
    let mut payload = None;
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Some(value) = line.strip_prefix("git ") {
            git = match value {
                "absent" => Some(RemoteGitPointerKind::Absent),
                "ours" => Some(RemoteGitPointerKind::Ours),
                "foreign" => Some(RemoteGitPointerKind::Foreign),
                _unknown => None,
            };
        }
        if let Some(value) = line.strip_prefix("payload ") {
            payload = Some(value == "1");
        }
    }
    match (git, payload) {
        (Some(git), Some(payload_present)) => Ok(RemoteGitPointerState {
            git,
            payload_present,
        }),
        (_incomplete_git, _incomplete_payload) => Err(WorkspaceGitError::message(
            "beam: the remote git pointer probe returned an incomplete result — refusing"
                .to_owned(),
        )),
    }
}

pub async fn reconcile_git_pointer_temp(
    transport: &dyn Transport,
    remote_cwd: &str,
    generation: &str,
    owner: Option<&str>,
) -> Result<(), WorkspaceGitError> {
    let script = reconcile_git_pointer_temp_script(remote_cwd, generation, owner)?;
    transport.exec_checked(&script).await?;
    Ok(())
}

pub async fn install_remote_git_pointer(
    transport: &dyn Transport,
    remote_cwd: &str,
    generation: &str,
    owner: Option<&str>,
) -> Result<(), WorkspaceGitError> {
    let script = install_remote_git_pointer_script(remote_cwd, generation, owner)?;
    transport.exec_checked(&script).await?;
    Ok(())
}

pub(super) fn remote_git_script_golden() -> Result<Vec<(&'static str, String)>, WorkspaceGitError> {
    let cwd = "/srv/beam/workspace";
    let generation = "0123456789abcdef";
    let owner = "beam-workspace-v1 record-1 0123456789abcdef0123456789abcdef";
    Ok(vec![
        (
            "remote-git-entry-kind",
            remote_git_entry_kind_script(cwd, Some(owner)),
        ),
        (
            "remote-git-tree-fingerprint",
            remote_git_tree_fingerprint_script(cwd, &git_payload_path(generation)?, Some(owner))?,
        ),
        (
            "remote-git-pointer-state",
            remote_git_pointer_state_script(cwd, generation, Some(owner))?,
        ),
        (
            "reconcile-git-pointer",
            reconcile_git_pointer_temp_script(cwd, generation, Some(owner))?,
        ),
        (
            "install-git-pointer",
            install_remote_git_pointer_script(cwd, generation, Some(owner))?,
        ),
    ])
}

fn remote_git_entry_kind_script(remote_cwd: &str, owner: Option<&str>) -> String {
    let mut lines = vec![enter_workspace_script(remote_cwd)];
    if let Some(owner) = owner {
        lines.push(owner_guard_script(owner));
    }
    lines.extend(
        [
            "__beam_dir=0; __beam_other=0",
            "for __beam_entry in ./.[!.]*; do",
            "  if ! test -e \"$__beam_entry\" && ! test -L \"$__beam_entry\"; then continue; fi",
            "  __beam_name=${__beam_entry#./}",
            "  case \"$__beam_name\" in",
            "    .git) if test ! -L \"$__beam_entry\" && test -d \"$__beam_entry\"; then __beam_dir=1; else __beam_other=1; fi ;;&",
        ]
        .map(str::to_owned),
    );
    let last = lines.len() - 1;
    lines[last] = "    .git) if test ! -L \"$__beam_entry\" && test -d \"$__beam_entry\"; then __beam_dir=1; else __beam_other=1; fi ;;".to_owned();
    lines.extend(
        [
            "    .[gG][iI][tT]) __beam_other=1 ;;",
            "    .[bB][eE][aA][mM]) if test \"$__beam_name\" != .beam; then __beam_other=1; fi ;;",
            "  esac",
            "done",
            "if [ \"$__beam_other\" = 1 ]; then printf '%s\\n' other; elif [ \"$__beam_dir\" = 1 ]; then printf '%s\\n' directory; else printf '%s\\n' absent; fi",
        ]
        .map(str::to_owned),
    );
    lines.join("\n")
}

fn remote_git_tree_fingerprint_script(
    remote_cwd: &str,
    git_dir_relative: &str,
    owner: Option<&str>,
) -> Result<String, WorkspaceGitError> {
    let segments = validate_remote_git_path(git_dir_relative)?;
    if owner.is_some() && segments.first().copied() != Some(BEAM_RESERVED_DIR) {
        return Err(WorkspaceGitError::message(format!(
            "beam: an owned Git payload must live under {BEAM_RESERVED_DIR}/ — got \
             {git_dir_relative}"
        )));
    }
    let git_path = format!("{remote_cwd}/{git_dir_relative}");
    let mut lines = vec!["set -u".to_owned(), enter_workspace_script(remote_cwd)];
    lines.extend(remote_git_fingerprint_descent(
        &git_path,
        &segments,
        git_dir_relative,
        owner,
    ));
    lines.extend(remote_git_fingerprint_probe(&git_path));
    Ok(lines.join("\n"))
}

fn remote_git_fingerprint_descent(
    git_path: &str,
    segments: &[&str],
    git_dir_relative: &str,
    owner: Option<&str>,
) -> Vec<String> {
    let mut lines = vec!["__bg_root=\"$(/bin/pwd -P)\"".to_owned()];
    for (index, segment) in segments.iter().enumerate() {
        lines.push(format!(
            "if test -L ./{segment}; then echo {} >&2; exit 77; fi",
            shq(&format!(
                "beam: {git_path} is symlinked at {segment} — refusing to collect through it"
            ))
        ));
        lines.push(format!(
            "if test ! -e ./{segment}; then echo {} >&2; exit 78; fi",
            shq(&format!(
                "beam: {git_path} is missing on the target — the remote Git state is gone; \
                 refusing to collect a return that cannot be authenticated"
            ))
        ));
        lines.push(format!(
            "if test ! -d ./{segment}; then echo {} >&2; exit 77; fi",
            shq(&format!(
                "beam: {git_path} is not a directory on the target — refusing to collect it"
            ))
        ));
        lines.push(format!(
            "cd -P -- ./{segment} 2>/dev/null || {{ echo {} >&2; exit 77; }}",
            shq(&format!(
                "beam: cannot enter {git_path} — refusing to collect it"
            ))
        ));
        if index == 0
            && let Some(owner) = owner
        {
            lines.push(format!(
                "if [ -L {BEAM_OWNER_FILE} ] || [ ! -f {BEAM_OWNER_FILE} ] || [ \"$(cat \
                 {BEAM_OWNER_FILE} 2>/dev/null)\" != {} ]; then echo \"beam: the workspace is not \
                 owned by this handoff — refusing\" >&2; exit 52; fi",
                shq(owner)
            ));
        }
    }
    lines.push(format!(
        "if [ \"$(/bin/pwd -P)\" != \"$__bg_root/{git_dir_relative}\" ]; then echo {} >&2; \
         exit 77; fi",
        shq(&format!(
            "beam: {git_path} physically escapes the workspace — refusing to collect it"
        ))
    ));
    lines
}

fn remote_git_fingerprint_probe(git_path: &str) -> Vec<String> {
    let relabel = "sed \"s|^\\\\.|./.git|\"";
    let relabel_hashed = "sed \"s|^f \\\\([0-9a-f]*\\\\) \\\\.|f \\\\1 ./.git|\"";
    [
        "__beam_lockscan() {".to_owned(),
        "  __beam_locks=$(find . -name '*.lock' -print | LC_ALL=C sort)".to_owned(),
        "  if [ -n \"$__beam_locks\" ]; then".to_owned(),
        format!(
            "    printf '%s\\n' {} \"$__beam_locks\" {} >&2",
            shq(&format!(
                "beam: live Git lock file(s) under {git_path} — another process (a background \
                 or nohup job that survived the agent stop?) may still be mutating the \
                 repository:"
            )),
            shq(
                "beam never removes a foreign lock. Stop the remote writer (or remove a provably \
                 stale lock on the target yourself), then retry — the remote is intact."
            )
        ),
        "    exit 79".to_owned(),
        "  fi".to_owned(),
        "}".to_owned(),
        "__beam_lockscan".to_owned(),
        "__beam_odd=$(find . ! -type f ! -type d -print | LC_ALL=C sort)".to_owned(),
        format!(
            "if [ -n \"$__beam_odd\" ]; then printf '%s\\n' {} \"$__beam_odd\" >&2; exit 77; fi",
            shq(&format!(
                "beam: {git_path} contains non-regular entries (symlink/device/fifo/socket) — \
                 refusing to collect:"
            ))
        ),
        "__beam_nl='*".to_owned(),
        "*'".to_owned(),
        format!(
            "if [ -n \"$(find . -name \"$__beam_nl\" -print)\" ] || [ -n \"$(find . -name \
             '*\\\\*' -print)\" ]; then echo {} >&2; exit 77; fi",
            shq(&format!(
                "beam: {git_path} contains file names with newlines or backslashes — refusing \
                 to collect an unprovable tree"
            ))
        ),
        format!(
            "if command -v sha256sum >/dev/null 2>&1; then __beam_hash=sha256sum; elif command -v \
             shasum >/dev/null 2>&1; then __beam_hash='shasum -a 256'; else echo {} >&2; exit 80; fi",
            shq(
                "beam: no sha256 tool (sha256sum or shasum) on the target — cannot prove a stable \
                 Git collection"
            )
        ),
        format!(
            "__beam_manifest=$({{ find . -type d -print | {relabel} | sed 's/^/d /'; find . -type \
             f -exec $__beam_hash {{}} + | sed -n 's/^\\([0-9a-f]\\{{64\\}}\\)[ ][ \
             *]\\(.*\\)$/f \\1 \\2/p' | {relabel_hashed}; }} | LC_ALL=C sort)"
        ),
        "__beam_fc=$(find . -type f -print | wc -l)".to_owned(),
        "__beam_fm=$(printf '%s\\n' \"$__beam_manifest\" | grep -c '^f ')".to_owned(),
        "if [ \"$((__beam_fc))\" -ne \"$((__beam_fm))\" ]; then echo \"beam: the remote Git fingerprint hashed $__beam_fm of $__beam_fc files — refusing an incomplete proof\" >&2; exit 81; fi".to_owned(),
        "__beam_digest=$(printf '%s\\n' \"$__beam_manifest\" | $__beam_hash | awk '{print $1}')".to_owned(),
        "__beam_total=$(printf '%s\\n' \"$__beam_manifest\" | wc -l)".to_owned(),
        "__beam_lockscan".to_owned(),
        format!(
            "printf '%s %s %s\\n' {} \"$__beam_digest\" \"$((__beam_total))\"",
            shq(GIT_FP_SENTINEL)
        ),
    ]
    .to_vec()
}

fn held_payload_descent_script(
    generation: &str,
    owner: Option<&str>,
) -> Result<String, WorkspaceGitError> {
    let relative = git_payload_path(generation)?;
    let mut lines = vec!["__bg_root=\"$(/bin/pwd -P)\"".to_owned()];
    if let Some(owner) = owner {
        let segments: Vec<&str> = relative.split('/').collect();
        lines.push(owned_destination_script(owner, &segments, false)?);
    } else {
        for segment in relative.split('/') {
            lines.push(format!(
                "if [ -L ./{segment} ] || [ ! -d ./{segment} ]; then echo 'beam: the reserved \
                 Git payload chain is swapped or missing — refusing' >&2; exit 71; fi"
            ));
            lines.push(format!(
                "cd -P -- ./{segment} 2>/dev/null || {{ echo 'beam: cannot enter the reserved \
                 Git payload — refusing' >&2; exit 71; }}"
            ));
        }
    }
    lines.push(format!(
        "if [ \"$(/bin/pwd -P)\" != \"$__bg_root/{relative}\" ]; then echo 'beam: the \
         reserved Git payload chain physically escapes the workspace — refusing' >&2; exit 71; fi"
    ));
    Ok(lines.join("\n"))
}

fn remote_git_pointer_state_script(
    remote_cwd: &str,
    generation: &str,
    owner: Option<&str>,
) -> Result<String, WorkspaceGitError> {
    let pointer = git_pointer_bytes(generation)?;
    let held = held_payload_descent_script(generation, owner)?.replace('\n', "; ");
    Ok([
        "set -eu".to_owned(),
        enter_workspace_script(remote_cwd),
        "__beam_prc=0".to_owned(),
        format!("( {held} ) >/dev/null 2>&1 || __beam_prc=$?"),
        "if [ \"$__beam_prc\" = 52 ]; then echo 'beam: the workspace is not owned by this handoff — refusing' >&2; exit 52; fi".to_owned(),
        format!("__beam_ptr={}", shq(pointer.trim_end())),
        "if test -L ./.git; then printf 'git foreign\\n'; elif test -f ./.git; then if [ \"$(cat ./.git 2>/dev/null)\" = \"$__beam_ptr\" ]; then printf 'git ours\\n'; else printf 'git foreign\\n'; fi; elif test -e ./.git; then printf 'git foreign\\n'; else printf 'git absent\\n'; fi".to_owned(),
        "if [ \"$__beam_prc\" = 0 ]; then printf 'payload 1\\n'; else printf 'payload 0\\n'; fi".to_owned(),
    ]
    .join("\n"))
}

fn reconcile_git_pointer_temp_script(
    remote_cwd: &str,
    generation: &str,
    owner: Option<&str>,
) -> Result<String, WorkspaceGitError> {
    let temporary = git_pointer_temp_name(generation)?;
    let pointer = shq(git_pointer_bytes(generation)?.trim_end());
    let mut lines = vec!["set -eu".to_owned(), enter_workspace_script(remote_cwd)];
    if let Some(owner) = owner {
        lines.push(owner_guard_script(owner));
    }
    lines.push(format!(
        "if [ -L ./{temporary} ] || [ -d ./{temporary} ]; then echo 'beam: a foreign entry \
         occupies the pointer staging name {temporary} — refusing (workspace left for inspection)' \
         >&2; exit 78; fi"
    ));
    lines.push(format!(
        "if [ -e ./{temporary} ]; then if [ -f ./{temporary} ] && [ \"$(cat ./{temporary} \
         2>/dev/null)\" = {pointer} ]; then rm -f ./{temporary}; else echo 'beam: a divergent \
         pointer staging file {temporary} exists — refusing (workspace left for inspection)' \
         >&2; exit 78; fi; fi"
    ));
    Ok(lines.join("\n"))
}

fn install_remote_git_pointer_script(
    remote_cwd: &str,
    generation: &str,
    owner: Option<&str>,
) -> Result<String, WorkspaceGitError> {
    let pointer = git_pointer_bytes(generation)?;
    let payload = git_payload_path(generation)?;
    let hops = payload
        .split('/')
        .map(|_| "..")
        .collect::<Vec<_>>()
        .join("/");
    let temporary = git_pointer_temp_name(generation)?;
    let quoted_pointer = shq(pointer.trim_end());
    Ok([
        "set -eu".to_owned(),
        enter_workspace_script(remote_cwd),
        "test ! -e ./.git && test ! -L ./.git || { echo 'beam: a .git already exists in the remote workspace — refusing to touch it' >&2; exit 72; }".to_owned(),
        held_payload_descent_script(generation, owner)?,
        format!("cd {hops} || exit 71"),
        "if [ \"$(/bin/pwd -P)\" != \"$__bg_root\" ]; then echo 'beam: the workspace moved during the pointer publish — refusing' >&2; exit 71; fi".to_owned(),
        format!("if [ -L ./{temporary} ] || [ -d ./{temporary} ]; then echo 'beam: a foreign entry occupies the pointer staging name {temporary} — refusing (workspace left for inspection)' >&2; exit 78; fi"),
        format!("if [ -e ./{temporary} ]; then if [ -f ./{temporary} ] && [ \"$(cat ./{temporary} 2>/dev/null)\" = {quoted_pointer} ]; then rm -f ./{temporary}; else echo 'beam: a divergent pointer staging file {temporary} exists — refusing (workspace left for inspection)' >&2; exit 78; fi; fi"),
        format!("(set -C; printf 'gitdir: %s\\n' {} > ./{temporary}) 2>/dev/null || {{ echo 'beam: cannot stage the .git pointer' >&2; exit 74; }}", shq(&payload)),
        format!("__bg_tmp_cleanup() {{ if [ ! -L ./{temporary} ] && [ -f ./{temporary} ] && [ \"$(cat ./{temporary} 2>/dev/null)\" = {quoted_pointer} ]; then rm -f ./{temporary}; fi; }}"),
        "trap __bg_tmp_cleanup EXIT HUP INT TERM".to_owned(),
        format!("[ ! -L ./{temporary} ] && [ -f ./{temporary} ] && [ \"$(cat ./{temporary})\" = {quoted_pointer} ] || {{ echo 'beam: the staged pointer bytes did not verify — refusing' >&2; exit 74; }}"),
        format!("ln ./{temporary} ./.git 2>/dev/null || true"),
        format!("test ! -L ./.git && test -f ./.git && [ ./.git -ef ./{temporary} ] && [ \"$(cat ./.git)\" = {quoted_pointer} ] || {{ echo 'beam: the .git pointer landing did not publish this ship — refusing (workspace left for inspection)' >&2; exit 77; }}"),
        "__bg_tmp_cleanup".to_owned(),
        "trap - EXIT HUP INT TERM".to_owned(),
    ]
    .join("\n"))
}

fn validate_remote_git_path(path: &str) -> Result<Vec<&str>, WorkspaceGitError> {
    let allowed = path
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'/' | b'-'));
    let segments = path.split('/').collect::<Vec<_>>();
    let bad = segments
        .iter()
        .any(|segment| segment.is_empty() || matches!(*segment, "." | ".."));
    if !allowed || bad {
        return Err(WorkspaceGitError::message(format!(
            "beam: invalid remote Git payload path: {path}"
        )));
    }
    Ok(segments)
}

fn parse_remote_git_fingerprint(last: &str) -> Result<GitTreeFingerprint, WorkspaceGitError> {
    let fields = last.split_whitespace().collect::<Vec<_>>();
    let valid = fields.len() == 3
        && fields[0] == GIT_FP_SENTINEL
        && fields[1].len() == 64
        && fields[1]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'));
    if valid && let Ok(entries) = fields[2].parse::<usize>() {
        return Ok(GitTreeFingerprint {
            digest: fields[1].to_owned(),
            entries,
        });
    }
    Err(WorkspaceGitError::message(format!(
        "beam: the remote Git fingerprint probe produced no proof (got: {}) — refusing",
        if last.is_empty() { "no output" } else { last }
    )))
}

fn last_nonempty_line(output: &str) -> &str {
    output
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or("")
}
