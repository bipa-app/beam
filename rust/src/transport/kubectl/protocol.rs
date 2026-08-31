//! Pure kubectl transport protocol: path pinning and mirror-license metadata.

use sha2::{Digest, Sha256};

use crate::transport::{OwnedWorkspace, TransportError};
use crate::util::shell::shq;
use crate::workspace::{owned_destination_script, owner_guard_script};

pub const SYNC_MARKER_VERSION: &str = "beam kubectl sync v1";
const SYNC_MARKER_DIRS: [&str; 3] = [".beam", "transport", "kubectl-synced"];

pub struct SyncMarker {
    /// Normalized destination this license is keyed to.
    pub dest: String,
    /// Root whose reserved directory holds the marker.
    pub root: String,
    /// Marker path relative to the root.
    pub rel: String,
    /// Single-component marker basename.
    pub file: String,
    /// Exact expected marker bytes.
    pub content: String,
}

#[derive(Clone, Copy)]
pub enum MarkerWalkMode {
    Create,
    Probe,
    Invalidate,
}

pub fn sync_marker_for(remote_dir: &str) -> SyncMarker {
    let dest = if remote_dir == "~" {
        "~".to_owned()
    } else if let Some(relative) = remote_dir.strip_prefix("~/") {
        format!("~{}", normalize_posix(&format!("/{relative}")))
    } else {
        normalize_posix(remote_dir)
    };
    let root = if let Some(index) = dest.find("/.beam/") {
        dest[..index].to_owned()
    } else if let Some(root) = dest.strip_suffix("/.beam") {
        root.to_owned()
    } else {
        dest.clone()
    };
    let mut hasher = Sha256::new();
    hasher.update(dest.as_bytes());
    let digest = hex::encode(hasher.finalize());
    let key = &digest[..32];
    SyncMarker {
        dest: dest.clone(),
        root,
        rel: format!("{}/{key}.v1", SYNC_MARKER_DIRS.join("/")),
        file: format!("{key}.v1"),
        content: format!("{SYNC_MARKER_VERSION} {dest}"),
    }
}

pub fn marker_walk_blocks(mode: MarkerWalkMode) -> Vec<String> {
    let mut blocks = Vec::with_capacity(SYNC_MARKER_DIRS.len() + 1);
    blocks.push("__beam_mprefix=$(/bin/pwd -P) || exit 66".to_owned());
    for directory in SYNC_MARKER_DIRS {
        let quoted = shq(directory);
        let link = format!(
            "echo {} >&2; exit 62",
            shq(&format!(
                "beam: {directory} is a symlink — refusing to touch transport metadata through it"
            ))
        );
        let absent = match mode {
            MarkerWalkMode::Create => format!(
                "mkdir -- {quoted} || {{ echo {} >&2; exit 63; }}; __beam_mk_new=1",
                shq(&format!("beam: cannot create {directory}"))
            ),
            MarkerWalkMode::Probe => "exit 61".to_owned(),
            MarkerWalkMode::Invalidate => "exit 0".to_owned(),
        };
        blocks.push(marker_walk_block(mode, directory, &quoted, &link, &absent));
    }
    blocks
}

fn marker_walk_block(
    mode: MarkerWalkMode,
    directory: &str,
    quoted: &str,
    link: &str,
    absent: &str,
) -> String {
    let mut lines = vec![
        format!("if [ -L {quoted} ]; then {link}; fi"),
        "__beam_mk_new=0".to_owned(),
        format!("if [ ! -e {quoted} ]; then {absent}; fi"),
        format!("if [ -L {quoted} ] || [ ! -d {quoted} ]; then {link}; fi"),
        format!("cd -P -- {quoted} 2>/dev/null || {{ {link}; }}"),
        format!("__beam_mprefix=\"$__beam_mprefix\"/{quoted}"),
        format!(
            "if [ \"$(/bin/pwd -P)\" != \"$__beam_mprefix\" ]; then echo {} >&2; \
             exit 66; fi",
            shq(&format!(
                "beam: {directory} no longer resolves inside its workspace \
                 — refusing to touch transport metadata"
            ))
        ),
    ];
    if let MarkerWalkMode::Create = mode {
        lines.push(format!(
            "if [ \"$__beam_mk_new\" = 1 ]; then chmod 700 . || {{ echo {} >&2; \
             exit 63; }}; [ -n \"$(find . -prune -perm 700)\" ] || {{ echo {} >&2; \
             exit 63; }}; fi",
            shq(&format!("beam: cannot set the mode of {directory}")),
            shq(&format!("beam: the mode of {directory} did not verify"))
        ));
    }
    lines.join("\n")
}

pub fn pin_remote_dir_script(remote_dir: &str, create: bool) -> Result<String, TransportError> {
    let setup = remote_path_setup(remote_dir)?;
    let refuse_link = format!(
        "echo {} >&2; exit 61",
        shq(&format!(
            "beam: refusing to sync through symlinked path: {remote_dir}"
        ))
    );
    let refuse_physical = format!(
        "echo {} >&2; exit 66",
        shq(&format!(
            "beam: remote sync path no longer resolves to its pinned physical directory: \
             {remote_dir}"
        ))
    );
    if !create {
        return Ok(pin_existing_script(&setup, &refuse_link, &refuse_physical));
    }
    pin_create_script(remote_dir, &setup, &refuse_link, &refuse_physical)
}

fn pin_existing_script(setup: &str, refuse_link: &str, refuse_physical: &str) -> String {
    [
        setup.to_owned(),
        format!("if [ -L \"$__beam_expected\" ]; then {refuse_link}; fi"),
        format!("cd -P -- \"$__beam_expected\" 2>/dev/null || {{ {refuse_physical}; }}"),
        format!("__beam_actual=$(/bin/pwd -P) || {{ {refuse_physical}; }}"),
        format!("if [ \"$__beam_actual\" != \"$__beam_expected\" ]; then {refuse_physical}; fi"),
    ]
    .join("\n")
}

fn pin_create_script(
    remote_dir: &str,
    setup: &str,
    refuse_link: &str,
    refuse_physical: &str,
) -> Result<String, TransportError> {
    let home_relative = remote_dir == "~" || remote_dir.starts_with("~/");
    let normalized = if remote_dir == "~" {
        String::new()
    } else if let Some(relative) = remote_dir.strip_prefix("~/") {
        normalize_posix(&format!("/{relative}"))[1..].to_owned()
    } else {
        normalize_posix(remote_dir)[1..].to_owned()
    };
    let segments = normalized
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.is_empty() {
        return Err(TransportError::message(format!(
            "beam: refusing to use remote sync root: {remote_dir}"
        )));
    }
    let start = if home_relative {
        format!("cd -P -- \"$__beam_home\" 2>/dev/null || {{ {refuse_physical}; }}")
    } else {
        format!("cd -P -- / 2>/dev/null || {{ {refuse_physical}; }}")
    };
    let prefix = if home_relative {
        "__beam_prefix=\"$__beam_home\""
    } else {
        "__beam_prefix="
    };
    let mut lines = vec![setup.to_owned(), start, prefix.to_owned()];
    for segment in segments {
        lines.extend(pin_create_segment(segment, refuse_link, refuse_physical));
    }
    Ok(lines.join("\n"))
}

fn pin_create_segment(segment: &str, refuse_link: &str, refuse_physical: &str) -> [String; 7] {
    let quoted = shq(segment);
    [
        format!("if [ -L {quoted} ]; then {refuse_link}; fi"),
        format!("if [ ! -e {quoted} ]; then mkdir -- {quoted} || {{ {refuse_physical}; }}; fi"),
        format!("if [ -L {quoted} ] || [ ! -d {quoted} ]; then {refuse_link}; fi"),
        format!("cd -P -- {quoted} 2>/dev/null || {{ {refuse_physical}; }}"),
        format!("__beam_prefix=\"$__beam_prefix\"/{quoted}"),
        format!("__beam_actual=$(/bin/pwd -P) || {{ {refuse_physical}; }}"),
        format!("if [ \"$__beam_actual\" != \"$__beam_prefix\" ]; then {refuse_physical}; fi"),
    ]
}

pub fn remote_path_setup(remote_dir: &str) -> Result<String, TransportError> {
    if remote_dir.contains(['\0', '\n', '\r']) {
        let rendered = serde_json::to_string(remote_dir)
            .expect("a Rust string always serializes as valid JSON");
        return Err(TransportError::message(format!(
            "beam: remote sync path is not a single pathname: {rendered}"
        )));
    }
    if remote_dir == "~" || remote_dir.starts_with("~/") {
        let suffix = if remote_dir == "~" {
            String::new()
        } else {
            normalize_posix(&format!("/{}", &remote_dir[2..]))
        };
        return Ok(format!(
            "__beam_home=$(cd -P -- \"$HOME\" 2>/dev/null && /bin/pwd -P) || {{ echo {} >&2; \
             exit 65; }}\n__beam_expected=\"$__beam_home\"{}",
            shq("beam: cannot pin remote HOME"),
            shq(&suffix)
        ));
    }
    if !remote_dir.starts_with('/') {
        return Err(TransportError::message(format!(
            "beam: remote sync path must be absolute or home-relative: {remote_dir}"
        )));
    }
    Ok(format!(
        "__beam_expected={}",
        shq(&normalize_posix(remote_dir))
    ))
}

pub(super) fn owned_rel_from_root(
    remote_dir: &str,
    owned: OwnedWorkspace<'_>,
) -> Result<Vec<String>, TransportError> {
    let marker = sync_marker_for(remote_dir);
    let owned_root = sync_marker_for(owned.root).dest;
    if owned_root != marker.root {
        return Err(TransportError::message(format!(
            "beam: destination {remote_dir} is not the owned workspace {} or a beam-reserved \
             path inside it — refusing the owned transfer",
            owned.root
        )));
    }
    if marker.dest == owned_root {
        return Ok(Vec::new());
    }
    Ok(marker.dest[owned_root.len() + 1..]
        .split('/')
        .map(str::to_owned)
        .collect())
}

pub(super) fn owned_root_guard_script(
    remote_dir: &str,
    owned: OwnedWorkspace<'_>,
) -> Result<String, TransportError> {
    owned_rel_from_root(remote_dir, owned)?;
    Ok(format!(
        "{}\n{}",
        pin_remote_dir_script(&sync_marker_for(owned.root).dest, false)?,
        owner_guard_script(owned.owner_bytes)
    ))
}

pub(super) fn owned_dest_prelude(
    remote_dir: &str,
    owned: OwnedWorkspace<'_>,
    create: bool,
) -> Result<String, TransportError> {
    let relative = owned_rel_from_root(remote_dir, owned)?;
    let relative_refs = relative.iter().map(String::as_str).collect::<Vec<_>>();
    let owned_root = sync_marker_for(owned.root).dest;
    let destination = owned_destination_script(owned.owner_bytes, &relative_refs, create)
        .map_err(|error| TransportError::message(error.to_string()))?;
    Ok(format!(
        "{}\n{destination}",
        pin_remote_dir_script(&owned_root, false)?
    ))
}

pub(super) fn owned_marker_shell(
    marker: &SyncMarker,
    owned: OwnedWorkspace<'_>,
) -> Result<String, TransportError> {
    owned_rel_from_root(&marker.dest, owned)?;
    let destination = owned_destination_script(owned.owner_bytes, &SYNC_MARKER_DIRS, true)
        .map_err(|error| TransportError::message(error.to_string()))?;
    Ok(format!(
        "{}\n{destination}",
        pin_remote_dir_script(&marker.root, false)?
    ))
}

fn normalize_posix(path: &str) -> String {
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|prior| *prior != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push(part);
                }
            }
            segment => parts.push(segment),
        }
    }
    let mut normalized = if absolute {
        format!("/{}", parts.join("/"))
    } else {
        parts.join("/")
    };
    if normalized.is_empty() {
        normalized = if absolute { "/" } else { "." }.to_owned();
    }
    if trailing && normalized != "/" && normalized != "." {
        normalized.push('/');
    }
    normalized
}
