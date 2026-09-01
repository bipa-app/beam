use crate::transport::Transport;
use crate::util::shell::{shq, shq_remote_path};

use super::{
    BEAM_OWNER_FILE, BEAM_RESERVED_DIR, WorkspaceError, assert_purgeable_path,
    enter_workspace_script,
};

const WS_ABSENT: &str = "__beam_ws_absent__";
const WS_PURGED: &str = "__beam_ws_purged__";
const WS_RELEASED: &str = "__beam_ws_released__";

#[derive(Clone, Copy)]
pub enum ContainedWorkspace<'a> {
    Name(&'a str),
    Path(&'a str),
}

#[derive(Clone, Copy)]
pub enum OwnerAdoption {
    Create,
    Verify,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PurgeResult {
    Purged,
    Absent,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReleaseResult {
    Released,
    Absent,
}

struct OwnerMode<'a> {
    content: &'a str,
    adoption: OwnerAdoption,
}

#[derive(Default)]
struct ContainmentMode<'a> {
    workspace: Option<ContainedWorkspace<'a>>,
    create: bool,
    allow_missing: bool,
    owner: Option<OwnerMode<'a>>,
}

pub async fn establish_contained_workspace(
    transport: &dyn Transport,
    root: &str,
    workspace: ContainedWorkspace<'_>,
    owner: &str,
    adoption: OwnerAdoption,
) -> Result<String, WorkspaceError> {
    match workspace {
        ContainedWorkspace::Name(name) => validate_workspace_name(name)?,
        ContainedWorkspace::Path(path) => assert_purgeable_path(path)?,
    }
    let script = establish_contained_workspace_script(root, workspace, owner, adoption);
    let result = run_containment(transport, &script).await?;
    assert_purgeable_path(&result)?;
    Ok(result)
}

pub async fn assert_contained_workspace(
    transport: &dyn Transport,
    root: &str,
    path: &str,
    allow_missing: bool,
    owner: Option<&str>,
) -> Result<bool, WorkspaceError> {
    assert_purgeable_path(path)?;
    let script = assert_contained_workspace_script(root, path, allow_missing, owner);
    let result = run_containment(transport, &script).await?;
    Ok(result != WS_ABSENT)
}

pub async fn purge_owned_workspace_contents(
    transport: &dyn Transport,
    remote_cwd: &str,
    owner: &str,
    accept_converged: bool,
) -> Result<PurgeResult, WorkspaceError> {
    assert_purgeable_path(remote_cwd)?;
    let script = purge_owned_workspace_script(remote_cwd, owner, accept_converged);
    let result = run_containment(transport, &script).await?;
    match result.as_str() {
        WS_ABSENT => Ok(PurgeResult::Absent),
        WS_PURGED => Ok(PurgeResult::Purged),
        unexpected => Err(WorkspaceError::message(format!(
            "beam: purge of {remote_cwd} produced no proof (got: {}) — refusing to continue",
            proof_detail(unexpected)
        ))),
    }
}

pub async fn release_owned_workspace(
    transport: &dyn Transport,
    remote_cwd: &str,
    owner: &str,
) -> Result<ReleaseResult, WorkspaceError> {
    assert_purgeable_path(remote_cwd)?;
    let script = release_owned_workspace_script(remote_cwd, owner);
    let result = run_containment(transport, &script).await?;
    match result.as_str() {
        WS_ABSENT => Ok(ReleaseResult::Absent),
        WS_RELEASED => Ok(ReleaseResult::Released),
        unexpected => Err(WorkspaceError::message(format!(
            "beam: release of {remote_cwd} produced no proof (got: {}) — refusing to continue",
            proof_detail(unexpected)
        ))),
    }
}

pub(super) fn containment_script_golden() -> Vec<(&'static str, String)> {
    let root = "/srv/beam";
    let path = "/srv/beam/workspace";
    let owner = "beam-workspace-v1 record-1 0123456789abcdef0123456789abcdef";
    vec![
        (
            "establish-create",
            establish_contained_workspace_script(
                root,
                ContainedWorkspace::Name("workspace"),
                owner,
                OwnerAdoption::Create,
            ),
        ),
        (
            "establish-verify",
            establish_contained_workspace_script(
                root,
                ContainedWorkspace::Path(path),
                owner,
                OwnerAdoption::Verify,
            ),
        ),
        (
            "assert-contained",
            assert_contained_workspace_script(root, path, false, Some(owner)),
        ),
        (
            "assert-contained-missing",
            assert_contained_workspace_script(root, path, true, Some(owner)),
        ),
        (
            "purge-owned",
            purge_owned_workspace_script(path, owner, false),
        ),
        (
            "purge-owned-converged",
            purge_owned_workspace_script(path, owner, true),
        ),
        ("release-owned", release_owned_workspace_script(path, owner)),
    ]
}

fn establish_contained_workspace_script(
    root: &str,
    workspace: ContainedWorkspace<'_>,
    owner: &str,
    adoption: OwnerAdoption,
) -> String {
    containment_script(
        root,
        &ContainmentMode {
            workspace: Some(workspace),
            create: true,
            owner: Some(OwnerMode {
                content: owner,
                adoption,
            }),
            ..ContainmentMode::default()
        },
    )
}

fn assert_contained_workspace_script(
    root: &str,
    path: &str,
    allow_missing: bool,
    owner: Option<&str>,
) -> String {
    containment_script(
        root,
        &ContainmentMode {
            workspace: Some(ContainedWorkspace::Path(path)),
            allow_missing,
            owner: owner.map(|content| OwnerMode {
                content,
                adoption: OwnerAdoption::Verify,
            }),
            ..ContainmentMode::default()
        },
    )
}

fn purge_owned_workspace_script(remote_cwd: &str, owner: &str, accept_converged: bool) -> String {
    let not_owned = purge_not_owned(remote_cwd);
    let mut lines = vec!["set -u".to_owned()];
    lines.push(purge_absence_line(remote_cwd, accept_converged, &not_owned));
    lines.push(enter_workspace_script(remote_cwd));
    lines.push("__bp_ws=\"$(/bin/pwd -P)\"".to_owned());
    if accept_converged {
        lines.extend(purge_converged_lines(owner));
    }
    lines.extend(purge_erase_lines(remote_cwd, owner, &not_owned));
    lines.push(format!("printf '%s\\n' {}", shq(WS_PURGED)));
    lines.join("\n")
}

fn release_owned_workspace_script(remote_cwd: &str, owner: &str) -> String {
    let not_owned = release_not_owned(remote_cwd);
    let (parent, base) = remote_cwd.rsplit_once('/').unwrap_or(("", remote_cwd));
    let parent = if parent.is_empty() { "/" } else { parent };
    let mut lines = release_script_prefix(remote_cwd, &not_owned);
    lines.extend(release_reserved_lines(owner, &not_owned));
    lines.push(format!(
        "if cd .. 2>/dev/null && [ \"$(/bin/pwd -P)\" = {} ]; then rmdir ./{} \
         2>/dev/null || true; fi",
        shq(parent),
        shq(base)
    ));
    lines.push(format!("printf '%s\\n' {}", shq(WS_RELEASED)));
    lines.join("\n")
}

fn validate_workspace_name(name: &str) -> Result<(), WorkspaceError> {
    let safe = !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'));
    if !safe || matches!(name, "." | "..") {
        return Err(WorkspaceError::message(format!(
            "invalid remote workspace name: {name}"
        )));
    }
    Ok(())
}

fn containment_script(root: &str, mode: &ContainmentMode<'_>) -> String {
    let mut lines = vec!["set -u".to_owned()];
    lines.extend(containment_root_lines(root, mode));
    lines.extend(containment_walk_lines());
    if mode.allow_missing {
        lines.push(format!(
            "if [ ! -e \"$__bw_ws\" ] && [ ! -L \"$__bw_ws\" ]; then printf '%s\\n' {}; \
             exit 0; fi",
            shq(WS_ABSENT)
        ));
    }
    if mode.create {
        lines.extend(containment_create_lines());
    } else {
        lines.extend(containment_resolve_lines());
    }
    if let Some(owner) = &mode.owner {
        lines.extend(containment_owner_lines(owner));
    }
    lines.push("printf '%s\\n' \"$__bw_wsp\"".to_owned());
    lines.join("\n")
}

fn containment_root_lines(root: &str, mode: &ContainmentMode<'_>) -> Vec<String> {
    let root_quoted = shq_remote_path(root);
    let mut lines = Vec::new();
    if mode.create {
        lines.push(format!(
            "mkdir -p -- {root_quoted} || {{ echo {} >&2; exit 40; }}",
            shq(&format!("beam: cannot create workspace root {root}"))
        ));
    }
    lines.extend([
        format!(
            "__bw_rootp=$(cd -- {root_quoted} 2>/dev/null && /bin/pwd -P) || {{ echo {} >&2; \
             exit 41; }}",
            shq(&format!(
                "beam: workspace root {root} does not resolve on the target"
            ))
        ),
        "case \"$__bw_rootp\" in /?*) ;; *) echo \"beam: refusing workspace root resolving to \
         '$__bw_rootp'\" >&2; exit 42 ;; esac"
            .to_owned(),
    ]);
    lines.extend(workspace_path_lines(root, mode));
    lines
}

fn workspace_path_lines(root: &str, mode: &ContainmentMode<'_>) -> Vec<String> {
    match mode.workspace.expect("workspace mode") {
        ContainedWorkspace::Name(name) => {
            vec![format!("__bw_ws=\"$__bw_rootp/\"{}", shq(name))]
        }
        ContainedWorkspace::Path(path) => vec![
            format!("__bw_ws={}", shq(path)),
            format!(
                "case \"$__bw_ws\" in \"$__bw_rootp\"/?*) ;; *) echo {}\" (root resolves to \
                 $__bw_rootp)\" >&2; exit 43 ;; esac",
                shq(&format!(
                    "beam: workspace {path} is not under the physical root of {root} — refusing \
                     (physical containment)"
                ))
            ),
        ],
    }
}

fn containment_walk_lines() -> Vec<String> {
    [
        "__bw_rel=\"${__bw_ws#\"$__bw_rootp\"/}\"",
        "__bw_p=\"$__bw_rootp\"",
        "__bw_ifs=\"${IFS-}\"; IFS=/; set -f",
        "for __bw_seg in $__bw_rel; do",
        "  case \"$__bw_seg\" in ''|.|..) echo \"beam: suspicious workspace path segment in \
         $__bw_ws\" >&2; exit 44 ;; esac",
        "  __bw_p=\"$__bw_p/$__bw_seg\"",
        "  if [ -L \"$__bw_p\" ]; then echo \"beam: refusing symlinked workspace path component: \
         $__bw_p (physical containment)\" >&2; exit 45; fi",
        "done",
        "set +f; IFS=\"$__bw_ifs\"",
    ]
    .map(str::to_owned)
    .to_vec()
}

fn containment_create_lines() -> Vec<String> {
    [
        "cd -P -- \"$__bw_rootp\" 2>/dev/null || { echo \"beam: cannot enter workspace root \
         $__bw_rootp\" >&2; exit 41; }",
        "if [ \"$(/bin/pwd -P)\" != \"$__bw_rootp\" ]; then echo \"beam: workspace root moved \
         during creation — refusing\" >&2; exit 41; fi",
        "__bw_p=\"$__bw_rootp\"",
        "__bw_ifs=\"${IFS-}\"; IFS=/; set -f",
        "set -- $__bw_rel",
        "set +f; IFS=\"$__bw_ifs\"",
        "for __bw_seg in \"$@\"; do",
        "  if [ -L \"./$__bw_seg\" ]; then echo \"beam: refusing to create through symlinked \
         workspace path component: $__bw_p/$__bw_seg (physical containment)\" >&2; exit 45; fi",
        "  if [ ! -e \"./$__bw_seg\" ]; then mkdir -- \"./$__bw_seg\" || { echo \"beam: cannot \
         create workspace $__bw_ws\" >&2; exit 46; }; fi",
        "  if [ -L \"./$__bw_seg\" ] || [ ! -d \"./$__bw_seg\" ]; then echo \"beam: workspace \
         path component is not a real directory: $__bw_p/$__bw_seg — refusing\" >&2; exit 45; fi",
        "  cd -P -- \"./$__bw_seg\" 2>/dev/null || { echo \"beam: cannot enter \
         $__bw_p/$__bw_seg\" >&2; exit 46; }",
        "  __bw_p=\"$__bw_p/$__bw_seg\"",
        "  if [ \"$(/bin/pwd -P)\" != \"$__bw_p\" ]; then echo \"beam: workspace path moved \
         during creation — refusing (physical containment)\" >&2; exit 45; fi",
        "done",
        "__bw_wsp=\"$__bw_p\"",
    ]
    .map(str::to_owned)
    .to_vec()
}

fn containment_resolve_lines() -> Vec<String> {
    [
        "if [ -L \"$__bw_ws\" ]; then echo \"beam: workspace is a symlink — refusing (physical \
         containment): $__bw_ws\" >&2; exit 45; fi",
        "if [ ! -e \"$__bw_ws\" ]; then echo \"beam: workspace missing on the target: $__bw_ws\" \
         >&2; exit 49; fi",
        "if [ ! -d \"$__bw_ws\" ]; then echo \"beam: workspace is not a directory: $__bw_ws\" \
         >&2; exit 50; fi",
        "__bw_wsp=$(cd -- \"$__bw_ws\" 2>/dev/null && /bin/pwd -P) || { echo \"beam: workspace \
         does not resolve: $__bw_ws\" >&2; exit 47; }",
        "if [ \"$__bw_wsp\" != \"$__bw_ws\" ]; then echo \"beam: workspace $__bw_ws physically \
         resolves to $__bw_wsp — path swapped or symlinked; refusing\" >&2; exit 48; fi",
    ]
    .map(str::to_owned)
    .to_vec()
}

fn containment_owner_lines(owner: &OwnerMode<'_>) -> Vec<String> {
    let mut lines = owner_proof_lines(owner.content);
    match owner.adoption {
        OwnerAdoption::Verify => lines.push("  [ -n \"$__bw_have\" ] || exit 91".to_owned()),
        OwnerAdoption::Create => lines.extend(owner_claim_lines()),
    }
    lines.extend([
        ")".to_owned(),
        "__bw_oc=$?".to_owned(),
        "if [ \"$__bw_oc\" = 91 ]; then echo \"beam: workspace $__bw_ws exists and is not \
         owned by this handoff — refusing with it untouched (purge or retire the handoff that owns \
         it, or move the directory aside)\" >&2; exit 52; fi"
            .to_owned(),
        "if [ \"$__bw_oc\" != 0 ]; then echo \"beam: cannot establish beam ownership of \
         $__bw_ws\" >&2; exit 53; fi"
            .to_owned(),
    ]);
    lines
}

fn owner_proof_lines(owner: &str) -> Vec<String> {
    vec![
        format!("__bw_owner={}", shq(owner)),
        "(".to_owned(),
        "  cd -P -- \"$__bw_wsp\" || exit 90".to_owned(),
        "  [ \"$(/bin/pwd -P)\" = \"$__bw_wsp\" ] || exit 90".to_owned(),
        "  __bw_have=\"\"".to_owned(),
        format!("  if [ ! -L ./{BEAM_RESERVED_DIR} ] && [ -d ./{BEAM_RESERVED_DIR} ]; then"),
        format!(
            "    if ( cd -P -- ./{BEAM_RESERVED_DIR} 2>/dev/null && [ \"$(/bin/pwd -P)\" = \
             \"$__bw_wsp/{BEAM_RESERVED_DIR}\" ] && [ ! -L ./{BEAM_OWNER_FILE} ] && [ -f \
             ./{BEAM_OWNER_FILE} ] && [ \"$(cat ./{BEAM_OWNER_FILE} 2>/dev/null)\" = \
             \"$__bw_owner\" ] ); then __bw_have=1; fi"
        ),
        "  fi".to_owned(),
        "  if [ -n \"$__bw_have\" ]; then".to_owned(),
        format!("    ( cd -P -- ./{BEAM_RESERVED_DIR} 2>/dev/null || exit 1"),
        format!("      [ \"$(/bin/pwd -P)\" = \"$__bw_wsp/{BEAM_RESERVED_DIR}\" ] || exit 1"),
        "      chmod 700 . 2>/dev/null || exit 1".to_owned(),
        format!("      chmod 600 ./{BEAM_OWNER_FILE} 2>/dev/null || exit 1"),
        "      [ -n \"$(find . -prune -perm 700)\" ] || exit 1".to_owned(),
        format!(
            "      [ -n \"$(find ./{BEAM_OWNER_FILE} -prune -perm 600)\" ] || exit 1 ) || \
             exit 93"
        ),
        "  fi".to_owned(),
    ]
}

fn owner_claim_lines() -> Vec<String> {
    [
        "  if [ -z \"$__bw_have\" ]; then",
        "    __bw_entries=\"$(ls -A . 2>/dev/null)\"",
        "    if [ -z \"$__bw_entries\" ]; then",
        "      mkdir ./.beam || exit 92",
        "    elif [ \"$__bw_entries\" = \".beam\" ] && [ ! -L ./.beam ] && [ -d ./.beam ] && \
         [ -z \"$(ls -A ./.beam 2>/dev/null)\" ]; then",
        "      :",
        "    else",
        "      exit 91",
        "    fi",
        "    if [ -L ./.beam ] || [ ! -d ./.beam ]; then exit 91; fi",
        "    cd -P -- ./.beam 2>/dev/null || exit 92",
        "    [ \"$(/bin/pwd -P)\" = \"$__bw_wsp/.beam\" ] || exit 91",
        "    chmod 700 . 2>/dev/null || exit 92",
        "    (set -C; printf '%s\\n' \"$__bw_owner\" > ./owner) 2>/dev/null || exit 92",
        "    [ ! -L ./owner ] && [ -f ./owner ] && [ \"$(cat ./owner)\" = \"$__bw_owner\" ] || \
         exit 91",
        "    chmod 600 ./owner 2>/dev/null || exit 92",
        "    [ -n \"$(find . -prune -perm 700)\" ] || exit 92",
        "    [ -n \"$(find ./owner -prune -perm 600)\" ] || exit 92",
        "  fi",
    ]
    .map(str::to_owned)
    .to_vec()
}

async fn run_containment(
    transport: &dyn Transport,
    script: &str,
) -> Result<String, WorkspaceError> {
    let output = transport.exec_checked(script).await?;
    Ok(output
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or("")
        .to_owned())
}

fn purge_not_owned(remote_cwd: &str) -> String {
    format!(
        "{{ echo {} >&2; exit 52; }}",
        shq(&format!(
            "beam: {remote_cwd} is not owned by this handoff — refusing to purge it (nothing was \
             deleted)"
        ))
    )
}

fn release_not_owned(remote_cwd: &str) -> String {
    format!(
        "{{ echo {} >&2; exit 52; }}",
        shq(&format!(
            "beam: {remote_cwd} is not owned by this handoff — refusing to release it (nothing \
             was deleted)"
        ))
    )
}

fn purge_absence_line(remote_cwd: &str, converged: bool, not_owned: &str) -> String {
    let quoted = shq_remote_path(remote_cwd);
    if converged {
        return format!(
            "if [ ! -e {quoted} ] && [ ! -L {quoted} ]; then printf '%s\\n' {}; exit 0; fi",
            shq(WS_ABSENT)
        );
    }
    format!("if [ ! -e {quoted} ] && [ ! -L {quoted} ]; then {not_owned}; fi")
}

fn purge_converged_lines(owner: &str) -> Vec<String> {
    vec![
        "__bp_entries=\"$(ls -A . 2>/dev/null)\"".to_owned(),
        format!(
            "if [ -z \"$__bp_entries\" ]; then printf '%s\\n' {}; exit 0; fi",
            shq(WS_PURGED)
        ),
        "if [ \"$__bp_entries\" = \".beam\" ] && [ ! -L ./.beam ] && [ -d ./.beam ]; then"
            .to_owned(),
        format!(
            "  if ( cd -P -- ./.beam 2>/dev/null && [ \"$(/bin/pwd -P)\" = \
             \"$__bp_ws/.beam\" ] && __bp_be=\"$(ls -A . 2>/dev/null)\" && {{ [ -z \
             \"$__bp_be\" ] || {{ [ \"$__bp_be\" = \"owner\" ] && [ ! -L ./owner ] && [ -f \
             ./owner ] && [ \"$(cat ./owner 2>/dev/null)\" = {} ]; }}; }} ); then printf \
             '%s\\n' {}; exit 0; fi",
            shq(owner),
            shq(WS_PURGED)
        ),
        "fi".to_owned(),
    ]
}

fn purge_erase_lines(remote_cwd: &str, owner: &str, not_owned: &str) -> Vec<String> {
    let end_state = format!(
        "{{ echo {} >&2; exit 51; }}",
        shq(&format!(
            "beam: the purge of {remote_cwd} cannot prove its emptied end state — refusing to \
             receipt it"
        ))
    );
    let mut lines = purge_owner_proof_lines(owner, not_owned);
    lines.extend(purge_content_erase_lines(owner, not_owned));
    lines.extend(purge_end_state_lines(owner, &end_state));
    lines
}

fn purge_owner_proof_lines(owner: &str, not_owned: &str) -> Vec<String> {
    vec![
        format!("if [ -L ./.beam ] || [ ! -d ./.beam ]; then {not_owned}; fi"),
        format!("cd -P -- ./.beam 2>/dev/null || {not_owned}"),
        format!("if [ \"$(/bin/pwd -P)\" != \"$__bp_ws/.beam\" ]; then {not_owned}; fi"),
        format!(
            "if [ -L ./owner ] || [ ! -f ./owner ] || [ \"$(cat ./owner 2>/dev/null)\" != {} ]; \
             then {not_owned}; fi",
            shq(owner)
        ),
        "cd .. || exit 51".to_owned(),
        "if [ \"$(/bin/pwd -P)\" != \"$__bp_ws\" ]; then echo 'beam: workspace moved during \
         the purge — refusing' >&2; exit 51; fi"
            .to_owned(),
    ]
}

fn purge_content_erase_lines(owner: &str, not_owned: &str) -> Vec<String> {
    vec![
        "find . -mindepth 1 -maxdepth 1 ! -name '.beam' -exec rm -rf -- {} + || { echo 'beam: \
         failed to erase workspace contents' >&2; exit 51; }"
            .to_owned(),
        format!("if [ -L ./.beam ] || [ ! -d ./.beam ]; then {not_owned}; fi"),
        format!("cd -P -- ./.beam 2>/dev/null || {not_owned}"),
        format!("if [ \"$(/bin/pwd -P)\" != \"$__bp_ws/.beam\" ]; then {not_owned}; fi"),
        format!(
            "if [ -L ./owner ] || [ ! -f ./owner ] || [ \"$(cat ./owner 2>/dev/null)\" != {} ]; \
             then {not_owned}; fi",
            shq(owner)
        ),
        "find . -mindepth 1 -maxdepth 1 ! -name 'owner' -exec rm -rf -- {} + || { echo 'beam: \
         failed to erase beam metadata' >&2; exit 51; }"
            .to_owned(),
    ]
}

fn purge_end_state_lines(owner: &str, end_state: &str) -> Vec<String> {
    vec![
        format!(
            "if [ \"$(ls -A . 2>/dev/null)\" != \"owner\" ] || [ -L ./owner ] || [ ! -f \
             ./owner ] || [ \"$(cat ./owner 2>/dev/null)\" != {} ]; then {end_state}; fi",
            shq(owner)
        ),
        "cd .. || exit 51".to_owned(),
        "if [ \"$(/bin/pwd -P)\" != \"$__bp_ws\" ]; then echo 'beam: workspace moved during \
         the purge — refusing' >&2; exit 51; fi"
            .to_owned(),
        format!("if [ \"$(ls -A . 2>/dev/null)\" != \".beam\" ]; then {end_state}; fi"),
    ]
}

fn release_script_prefix(remote_cwd: &str, not_owned: &str) -> Vec<String> {
    let quoted = shq_remote_path(remote_cwd);
    vec![
        "set -u".to_owned(),
        format!(
            "if [ ! -e {quoted} ] && [ ! -L {quoted} ]; then printf '%s\\n' {}; exit 0; fi",
            shq(WS_ABSENT)
        ),
        enter_workspace_script(remote_cwd),
        "__br_ws=\"$(/bin/pwd -P)\"".to_owned(),
        "__br_entries=\"$(ls -A . 2>/dev/null)\"".to_owned(),
        format!(
            "if [ -n \"$__br_entries\" ] && [ \"$__br_entries\" != \".beam\" ]; then \
             {not_owned}; fi"
        ),
    ]
}

fn release_reserved_lines(owner: &str, not_owned: &str) -> Vec<String> {
    vec![
        "if [ -n \"$__br_entries\" ]; then".to_owned(),
        format!("  if [ -L ./.beam ] || [ ! -d ./.beam ]; then {not_owned}; fi"),
        format!("  cd -P -- ./.beam 2>/dev/null || {not_owned}"),
        format!("  if [ \"$(/bin/pwd -P)\" != \"$__br_ws/.beam\" ]; then {not_owned}; fi"),
        "  __br_be=\"$(ls -A . 2>/dev/null)\"".to_owned(),
        format!("  if [ -n \"$__br_be\" ] && [ \"$__br_be\" != \"owner\" ]; then {not_owned}; fi"),
        "  if [ -n \"$__br_be\" ]; then".to_owned(),
        format!(
            "    if [ -L ./owner ] || [ ! -f ./owner ] || [ \"$(cat ./owner 2>/dev/null)\" != \
             {} ]; then {not_owned}; fi",
            shq(owner)
        ),
        "    rm -f ./owner || { echo 'beam: failed to release the owner marker' >&2; exit 51; }"
            .to_owned(),
        "  fi".to_owned(),
        "  cd .. || exit 51".to_owned(),
        "  if [ \"$(/bin/pwd -P)\" != \"$__br_ws\" ]; then echo 'beam: workspace moved during \
         the release — refusing' >&2; exit 51; fi"
            .to_owned(),
        "  rmdir ./.beam 2>/dev/null || true".to_owned(),
        "fi".to_owned(),
    ]
}

fn proof_detail(result: &str) -> &str {
    if result.is_empty() {
        "no output"
    } else {
        result
    }
}
