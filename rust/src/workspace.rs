//! Workspace shell fragments required by the transport seam.
//!
//! The full workspace state machine ports later. These generators land with
//! the first transport because every data-plane implementation must use the
//! same owner-bound, held-directory descent before moving bytes.

use std::fmt::{Display, Formatter};

use crate::util::shell::{shq, shq_remote_path};

pub const BEAM_RESERVED_DIR: &str = ".beam";
pub const BEAM_OWNER_FILE: &str = "owner";

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
