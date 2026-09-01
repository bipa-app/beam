use crate::transport::Transport;
use crate::util::shell::shq;

use super::{BEAM_RESERVED_DIR, WorkspaceError, enter_workspace_script, owned_destination_script};

const HEARTBEAT_ENTRY_COUNT: usize = 128;
const UPLOAD_STAGE_SENTINEL: &str = "__beam_upload_stage_v1__";

pub fn workspace_upload_stage_path(generation: &str) -> Result<String, WorkspaceError> {
    validate_generation(generation)?;
    Ok(format!(
        "{BEAM_RESERVED_DIR}/uploads/{generation}/workspace"
    ))
}

pub async fn publish_workspace_upload_stage(
    transport: &dyn Transport,
    remote_cwd: &str,
    generation: &str,
    owner: &str,
) -> Result<(), WorkspaceError> {
    let script = publish_workspace_upload_stage_script(remote_cwd, generation, owner)?;
    transport.exec_checked(&script).await?;
    Ok(())
}

pub async fn remote_workspace_upload_stage_present(
    transport: &dyn Transport,
    remote_cwd: &str,
    generation: &str,
    owner: &str,
) -> Result<bool, WorkspaceError> {
    let relative = workspace_upload_stage_path(generation)?;
    let components: Vec<&str> = relative.split('/').collect();
    let descent = owned_destination_script(owner, &components, false)?;
    let script = upload_present_script(remote_cwd, &descent);
    let output = transport.exec_checked(&script).await?;
    let last = last_nonempty_line(&output);
    match last {
        "__beam_upload_stage_v1__ present" => Ok(true),
        "__beam_upload_stage_v1__ absent" => Ok(false),
        unexpected => Err(WorkspaceError::message(format!(
            "beam: the upload-stage probe produced no result (got: {}) — refusing",
            if unexpected.is_empty() {
                "no output"
            } else {
                unexpected
            }
        ))),
    }
}

pub async fn remove_workspace_upload_stage(
    transport: &dyn Transport,
    remote_cwd: &str,
    generation: &str,
    owner: &str,
) -> Result<(), WorkspaceError> {
    let script = remove_workspace_upload_stage_script(remote_cwd, generation, owner)?;
    transport.exec_checked(&script).await?;
    Ok(())
}

pub(super) fn upload_script_golden() -> Result<Vec<(&'static str, String)>, WorkspaceError> {
    let remote_cwd = "/srv/beam/workspace";
    let generation = "0123456789abcdef";
    let owner = "beam-workspace-v1 record-1 0123456789abcdef0123456789abcdef";
    let relative = workspace_upload_stage_path(generation)?;
    let components: Vec<&str> = relative.split('/').collect();
    let descent = owned_destination_script(owner, &components, false)?;
    Ok(vec![
        (
            "publish-upload-stage",
            publish_workspace_upload_stage_script(remote_cwd, generation, owner)?,
        ),
        (
            "upload-stage-present",
            upload_present_script(remote_cwd, &descent),
        ),
        (
            "upload-stage-absent",
            upload_present_script(remote_cwd, &descent),
        ),
        (
            "remove-upload-stage",
            remove_workspace_upload_stage_script(remote_cwd, generation, owner)?,
        ),
    ])
}

fn publish_workspace_upload_stage_script(
    remote_cwd: &str,
    generation: &str,
    owner: &str,
) -> Result<String, WorkspaceError> {
    let relative = workspace_upload_stage_path(generation)?;
    let mut lines = vec!["set -u".to_owned(), enter_workspace_script(remote_cwd)];
    lines.extend(upload_probe_lines(owner, &relative)?);
    lines.extend(upload_shell_lines());
    lines.extend(upload_directory_pass_lines());
    lines.extend(upload_file_pass_lines());
    lines.extend(upload_link_pass_lines());
    Ok(lines.join("\n"))
}

fn remove_workspace_upload_stage_script(
    remote_cwd: &str,
    generation: &str,
    owner: &str,
) -> Result<String, WorkspaceError> {
    validate_generation(generation)?;
    let descent = owned_destination_script(owner, &[BEAM_RESERVED_DIR, "uploads"], false)?;
    let quoted_generation = shq(generation);
    Ok([
        "set -u".to_owned(),
        enter_workspace_script(remote_cwd),
        "__beam_ur_rc=0".to_owned(),
        "(".to_owned(),
        descent,
        format!(
            "if [ -L ./{quoted_generation} ]; then echo {} >&2; exit 61; fi",
            shq("beam: the reserved upload stage is a symlink — refusing its removal")
        ),
        format!("rm -rf -- ./{quoted_generation}"),
        ") || __beam_ur_rc=$?".to_owned(),
        "if [ \"$__beam_ur_rc\" != 0 ] && [ \"$__beam_ur_rc\" != 67 ]; then exit \
         \"$__beam_ur_rc\"; fi"
            .to_owned(),
    ]
    .join("\n"))
}

fn validate_generation(generation: &str) -> Result<(), WorkspaceError> {
    let mut bytes = generation.bytes();
    let first = bytes.next();
    let valid_first = first.is_some_and(|byte| byte.is_ascii_alphanumeric());
    let valid_tail =
        bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if !valid_first || !valid_tail {
        return Err(WorkspaceError::message(format!(
            "beam: invalid workspace upload generation: {generation:?}"
        )));
    }
    Ok(())
}

fn upload_probe_lines(owner: &str, relative: &str) -> Result<Vec<String>, WorkspaceError> {
    let components: Vec<&str> = relative.split('/').collect();
    Ok(vec![
        owned_destination_script(owner, &components, false)?,
        "__beam_pw_stage=$(/bin/pwd -P) || exit 66".to_owned(),
        "__beam_pw_odd=$(find . ! -type f ! -type d ! -type l -print | LC_ALL=C sort)".to_owned(),
        format!(
            "if [ -n \"$__beam_pw_odd\" ]; then printf '%s\\n' {} \"$__beam_pw_odd\" >&2; \
             exit 82; fi",
            shq(
                "beam: the staged workspace upload contains non-regular entries \
                 (device/fifo/socket) — refusing to publish it:"
            )
        ),
        "__beam_nl='*".to_owned(),
        "*'".to_owned(),
        format!(
            "if [ -n \"$(find . -name \"$__beam_nl\" -print)\" ] || [ -n \"$(find . -name \
             '*\\\\*' -print)\" ]; then echo {} >&2; exit 82; fi",
            shq(
                "beam: the staged workspace upload contains file names with newlines or \
                 backslashes — refusing to publish an unprovable tree"
            )
        ),
        format!(
            "cd {} || exit 66",
            components
                .iter()
                .map(|_| "..")
                .collect::<Vec<_>>()
                .join("/")
        ),
        format!(
            "if [ \"$(/bin/pwd -P)\" != \"$__beam_actual\" ]; then echo {} >&2; exit 66; fi",
            shq("beam: the workspace moved during the publish — refusing")
        ),
        format!("__beam_pw_root={}", shq(&format!("./{relative}"))),
    ])
}

fn upload_shell_lines() -> Vec<String> {
    [
        "__beam_pw_enter() {",
        "  __beam_pw_prefix=$(/bin/pwd -P) || exit 66",
        "  [ -z \"$1\" ] && return 0",
        "  __beam_pw_oifs=$IFS; IFS=/; set -f; set -- $1; set +f; IFS=$__beam_pw_oifs",
        "  for __beam_pw_c in \"$@\"; do",
        "    if [ -L \"./$__beam_pw_c\" ] || [ ! -d \"./$__beam_pw_c\" ]; then echo \"beam: \
         $__beam_pw_c is not a real directory in the live workspace — refusing the publish\" >&2; \
         exit 78; fi",
        "    cd -P -- \"./$__beam_pw_c\" 2>/dev/null || { echo \"beam: cannot enter \
         $__beam_pw_c in the live workspace — refusing the publish\" >&2; exit 78; }",
        "    __beam_pw_prefix=\"$__beam_pw_prefix/$__beam_pw_c\"",
        "    if [ \"$(/bin/pwd -P)\" != \"$__beam_pw_prefix\" ]; then echo \"beam: \
         $__beam_pw_c no longer resolves inside the live workspace — refusing the publish\" >&2; \
         exit 78; fi",
        "  done",
        "}",
        "__beam_pw_lsmode() { ls -ldn -- \"$1\" | cut -c1-10; }",
        "__beam_pw_perm() {",
        "  __beam_pw_pp=\"\"",
        "  case \"$1\" in (r??) __beam_pw_pp=r ;; (-??) ;; (*) exit 81 ;; esac",
        "  case \"$1\" in (?w?) __beam_pw_pp=\"${__beam_pw_pp}w\" ;; (?-?) ;; (*) exit 81 ;; \
         esac",
        "  case \"$1\" in (??x) __beam_pw_pp=\"${__beam_pw_pp}x\" ;; (??s) \
         __beam_pw_pp=\"${__beam_pw_pp}xs\" ;; (??S) __beam_pw_pp=\"${__beam_pw_pp}s\" ;; \
         (??t) __beam_pw_pp=\"${__beam_pw_pp}xt\" ;; (??T) \
         __beam_pw_pp=\"${__beam_pw_pp}t\" ;; (??-) ;; (*) exit 81 ;; esac",
        "  printf %s \"$__beam_pw_pp\"",
        "}",
        "__beam_pw_dirmode() {",
        "  __beam_pw_du=$(__beam_pw_perm \"$(printf %s \"$1\" | cut -c2-4)\") || exit 81",
        "  __beam_pw_dg=$(__beam_pw_perm \"$(printf %s \"$1\" | cut -c5-7)\") || exit 81",
        "  __beam_pw_do=$(__beam_pw_perm \"$(printf %s \"$1\" | cut -c8-10)\") || exit 81",
        "  printf \"u=%s,g=%s,o=%s\" \"$__beam_pw_du\" \"$__beam_pw_dg\" \"$__beam_pw_do\"",
        "}",
        "__beam_pw_tick() {",
        "  __beam_pw_progress=$((__beam_pw_progress + 1))",
        "  if [ $((__beam_pw_progress % 128)) -eq 0 ]; then",
        "    printf 'beam: workspace publish heartbeat %s %s\\n' \"$1\" \
         \"$__beam_pw_progress\" >&2",
        "  fi",
        "}",
    ]
    .map(str::to_owned)
    .to_vec()
}

fn upload_directory_pass_lines() -> Vec<String> {
    [
        "__beam_pw_progress=0",
        "find \"$__beam_pw_root\" -type d -print | LC_ALL=C sort | {",
        "  while IFS= read -r __beam_pw_p; do",
        "    [ \"$__beam_pw_p\" = \"$__beam_pw_root\" ] && continue",
        "    __beam_pw_r=${__beam_pw_p#\"$__beam_pw_root\"/}",
        "    (",
        "      case \"$__beam_pw_r\" in (*/*) __beam_pw_parent=${__beam_pw_r%/*} ;; (*) \
         __beam_pw_parent= ;; esac",
        "      __beam_pw_b=${__beam_pw_r##*/}",
        "      __beam_pw_m=$(__beam_pw_lsmode \"$__beam_pw_stage/$__beam_pw_r\")",
        "      case \"$__beam_pw_m\" in (d?????????) ;; (*) echo \"beam: staged entry \
         $__beam_pw_r is no longer a directory — refusing the publish\" >&2; exit 78 ;; esac",
        "      __beam_pw_sym=$(__beam_pw_dirmode \"$__beam_pw_m\") || { echo \"beam: \
         unsupported staged directory mode $__beam_pw_m on $__beam_pw_r — refusing the publish\" \
         >&2; exit 81; }",
        "      __beam_pw_enter \"$__beam_pw_parent\"",
        "      if mkdir -m \"$__beam_pw_sym\" -- \"./$__beam_pw_b\" 2>/dev/null; then :; elif [ \
         ! -L \"./$__beam_pw_b\" ] && [ -d \"./$__beam_pw_b\" ]; then :; else",
        "        echo \"beam: $__beam_pw_r already exists in the live workspace and is not a real \
         directory — refusing the publish (nothing was overwritten)\" >&2; exit 79",
        "      fi",
        "    ) || exit $?",
        "    __beam_pw_tick directories",
        "  done",
        "} || exit $?",
    ]
    .map(str::to_owned)
    .to_vec()
}

fn upload_file_pass_lines() -> Vec<String> {
    [
        "__beam_pw_progress=0",
        "find \"$__beam_pw_root\" -type f -print | {",
        "  while IFS= read -r __beam_pw_p; do",
        "    __beam_pw_r=${__beam_pw_p#\"$__beam_pw_root\"/}",
        "    (",
        "      case \"$__beam_pw_r\" in (*/*) __beam_pw_parent=${__beam_pw_r%/*} ;; (*) \
         __beam_pw_parent= ;; esac",
        "      __beam_pw_b=${__beam_pw_r##*/}",
        "      __beam_pw_enter \"$__beam_pw_parent\"",
        "      if ln -- \"$__beam_pw_stage/$__beam_pw_r\" \"./$__beam_pw_b\" 2>/dev/null; then \
         :; else",
        "        if [ ! -e \"./$__beam_pw_b\" ] && [ ! -L \"./$__beam_pw_b\" ]; then echo \
         \"beam: cannot hardlink $__beam_pw_r into the live workspace — refusing the publish\" \
         >&2; exit 78; fi",
        "        if [ -L \"./$__beam_pw_b\" ] || [ ! -f \"./$__beam_pw_b\" ]; then echo \"beam: \
         $__beam_pw_r already exists in the live workspace and is not a regular file — refusing \
         the publish (nothing was overwritten)\" >&2; exit 79; fi",
        "        cmp -s -- \"$__beam_pw_stage/$__beam_pw_r\" \"./$__beam_pw_b\" || { echo \
         \"beam: $__beam_pw_r already exists in the live workspace with different content — \
         refusing the publish (the existing file was left byte-intact)\" >&2; exit 79; }",
        "        __beam_pw_sm=$(__beam_pw_lsmode \"$__beam_pw_stage/$__beam_pw_r\")",
        "        case \"$__beam_pw_sm\" in (-?????????) ;; (*) echo \"beam: staged entry \
         $__beam_pw_r is no longer a regular file — refusing the publish\" >&2; exit 78 ;; esac",
        "        if [ \"$__beam_pw_sm\" != \"$(__beam_pw_lsmode \"./$__beam_pw_b\")\" ]; then \
         echo \"beam: $__beam_pw_r already exists in the live workspace with a different mode — \
         refusing the publish (nothing was overwritten)\" >&2; exit 79; fi",
        "      fi",
        "    ) || exit $?",
        "    __beam_pw_tick files",
        "  done",
        "} || exit $?",
    ]
    .map(str::to_owned)
    .to_vec()
}

fn upload_link_pass_lines() -> Vec<String> {
    [
        "__beam_pw_progress=0",
        "find \"$__beam_pw_root\" -type l -print | {",
        "  while IFS= read -r __beam_pw_p; do",
        "    __beam_pw_r=${__beam_pw_p#\"$__beam_pw_root\"/}",
        "    (",
        "      case \"$__beam_pw_r\" in (*/*) __beam_pw_parent=${__beam_pw_r%/*} ;; (*) \
         __beam_pw_parent= ;; esac",
        "      __beam_pw_b=${__beam_pw_r##*/}",
        "      __beam_pw_t=$(readlink -- \"$__beam_pw_stage/$__beam_pw_r\") || { echo \"beam: \
         cannot read the staged symlink $__beam_pw_r — refusing the publish\" >&2; exit 78; }",
        "      __beam_pw_enter \"$__beam_pw_parent\"",
        "      if ln -s -- \"$__beam_pw_t\" \"./$__beam_pw_b\" 2>/dev/null; then :; else",
        "        if [ ! -L \"./$__beam_pw_b\" ]; then echo \"beam: $__beam_pw_r already exists \
         in the live workspace and is not a symlink — refusing the publish (nothing was \
         overwritten)\" >&2; exit 79; fi",
        "        [ \"$(readlink -- \"./$__beam_pw_b\")\" = \"$__beam_pw_t\" ] || { echo \
         \"beam: $__beam_pw_r already exists in the live workspace with a different symlink \
         target — refusing the publish (nothing was overwritten)\" >&2; exit 79; }",
        "      fi",
        "    ) || exit $?",
        "    __beam_pw_tick links",
        "  done",
        "} || exit $?",
    ]
    .map(str::to_owned)
    .to_vec()
}

fn upload_present_script(remote_cwd: &str, descent: &str) -> String {
    [
        "set -u".to_owned(),
        enter_workspace_script(remote_cwd),
        "__beam_us_rc=0".to_owned(),
        "(".to_owned(),
        descent.to_owned(),
        ") >/dev/null 2>&1 || __beam_us_rc=$?".to_owned(),
        format!(
            "if [ \"$__beam_us_rc\" = 0 ]; then printf '%s present\\n' {};",
            shq(UPLOAD_STAGE_SENTINEL)
        ),
        format!(
            "elif [ \"$__beam_us_rc\" = 67 ]; then printf '%s absent\\n' {};",
            shq(UPLOAD_STAGE_SENTINEL)
        ),
        format!(
            "elif [ \"$__beam_us_rc\" = 52 ]; then echo {} >&2; exit 52;",
            shq("beam: the workspace is not owned by this handoff — refusing")
        ),
        format!(
            "else echo {} >&2; exit \"$__beam_us_rc\"; fi",
            shq("beam: the reserved upload stage cannot be proven — refusing")
        ),
    ]
    .join("\n")
}

fn last_nonempty_line(output: &str) -> &str {
    output
        .split('\n')
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or("")
}

const _: () = assert!(HEARTBEAT_ENTRY_COUNT == 128);
