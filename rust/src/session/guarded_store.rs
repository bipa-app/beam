//! No-follow install, collection, and cleanup for harness transcripts that
//! live outside the workspace under the target home directory.

use std::fs;
use std::path::{Path, PathBuf};

use crate::session::{SessionError, SessionFuture};
use crate::transport::{SyncOptions, Transport};
use crate::util::digest::file_sha256;
use crate::util::shell::shq;

const MAX_HARNESS_STORE_SEGMENTS: usize = 16;

fn safe_segments<'a>(segments: &'a [&'a str]) -> Result<&'a [&'a str], SessionError> {
    let unsafe_segment = segments.iter().any(|part| {
        part.is_empty()
            || *part == "."
            || *part == ".."
            || part.contains('/')
            || part.contains('\0')
            || part.contains('\n')
    });
    if segments.len() < 2 || segments.len() > MAX_HARNESS_STORE_SEGMENTS || unsafe_segment {
        return Err(SessionError::message(
            "beam: invalid harness session-store path".to_owned(),
        ));
    }
    Ok(segments)
}

fn enter_home() -> Vec<String> {
    vec![
        "set -u".to_owned(),
        "cd -P -- \"$HOME\" || { echo \"beam: cannot enter harness home\" >&2; exit 61; }"
            .to_owned(),
        "__uid=$(id -u) || exit 61".to_owned(),
    ]
}

fn descend(segments: &[&str], create: bool, absent_is_success: bool) -> Vec<String> {
    let mut lines = Vec::with_capacity(segments.len() * 9);
    for segment in segments {
        let quoted = shq(segment);
        let symlink = shq(&format!(
            "beam: harness store component is a symlink: {segment}"
        ));
        let not_dir = shq(&format!(
            "beam: harness store component is not a directory: {segment}"
        ));
        let escaped = shq(&format!(
            "beam: harness store component escaped its parent: {segment}"
        ));
        let foreign_owner = shq(&format!(
            "beam: harness store component has a foreign owner: {segment}"
        ));
        lines.push(format!(
            "if [ -L {quoted} ]; then echo {symlink} >&2; exit 62; fi"
        ));
        if create {
            lines.push(format!("mkdir -p -m 700 -- {quoted} || exit 63"));
        }
        if absent_is_success {
            lines.push(format!("if [ ! -e {quoted} ]; then exit 0; fi"));
        }
        lines.push(format!(
            "if [ ! -d {quoted} ]; then echo {not_dir} >&2; exit 63; fi"
        ));
        lines.push("parent_physical=$(/bin/pwd -P) || exit 63".to_owned());
        lines.push(format!("cd -P -- {quoted} || exit 63"));
        lines.push("child_physical=$(/bin/pwd -P) || exit 63".to_owned());
        lines.push(format!(
            "if [ \"$child_physical\" != \"$parent_physical\"/{quoted} ]; then echo {escaped} \
             >&2; exit 64; fi"
        ));
        lines.push("__o=$(ls -ldn . | awk '{print $3}') || exit 63".to_owned());
        lines.push(format!(
            "if [ \"$__o\" != \"$__uid\" ]; then echo {foreign_owner} >&2; exit 64; fi"
        ));
    }
    lines
}

fn install_residue_lines(temporary: &str, handle: &str) -> Vec<String> {
    vec![
        format!("rm -f -- {handle} {temporary}/session.jsonl 2>/dev/null || true"),
        format!("rmdir -- {temporary} 2>/dev/null || true"),
    ]
}

struct InstallPublishOptions<'a> {
    dirs: &'a [&'a str],
    temporary: &'a str,
    handle: &'a str,
    file: &'a str,
    expected_sha256: &'a str,
    destination: &'a str,
}

fn install_publish_script(options: InstallPublishOptions<'_>) -> String {
    let mut lines = enter_home();
    lines.extend(descend(options.dirs, false, false));
    lines.extend(install_bind_stage_lines(&options));
    lines.extend(install_publish_target_lines(&options));
    lines.extend(install_residue_lines(options.temporary, options.handle));
    lines.join("\n")
}

fn install_bind_stage_lines(options: &InstallPublishOptions<'_>) -> Vec<String> {
    let stage_not_dir = shq("beam: harness install stage is not a real directory");
    let stage_not_private = shq("beam: install stage is not private (0700)");
    let bind_failed = shq("beam: cannot bind the staged transcript");
    let handle_not_file = shq("beam: staged transcript is not a regular file");
    let no_sha_tool = shq("beam: no sha256 tool on the target");
    let sha_changed = shq("beam: staged transcript changed during install — refusing");
    let handle_not_private = shq("beam: staged transcript did not land private (0600)");
    vec![
        format!(
            "__cleanup() {{ rm -f -- {} {}/session.jsonl 2>/dev/null; rmdir -- {} 2>/dev/null; :; }}",
            options.handle, options.temporary, options.temporary
        ),
        format!(
            "if [ -L {} ] || [ ! -d {} ]; then echo {stage_not_dir} >&2; __cleanup; exit 65; fi",
            options.temporary, options.temporary
        ),
        format!(
            "chmod 700 {} || {{ __cleanup; exit 65; }}",
            options.temporary
        ),
        format!(
            "__dm=$(stat -c %a {} 2>/dev/null || stat -f %Lp {}) || {{ __cleanup; exit 65; }}",
            options.temporary, options.temporary
        ),
        format!(
            "if [ \"$__dm\" != 700 ]; then echo {stage_not_private} >&2; __cleanup; exit 65; fi"
        ),
        format!(
            "ln -- {}/session.jsonl {} || {{ echo {bind_failed} >&2; __cleanup; exit 65; }}",
            options.temporary, options.handle
        ),
        format!(
            "if [ -L {} ] || [ ! -f {} ]; then echo {handle_not_file} >&2; __cleanup; exit 65; fi",
            options.handle, options.handle
        ),
        format!(
            "__h=$(sha256sum < {} 2>/dev/null) || __h=$(shasum -a 256 < {}) || {{ echo \
             {no_sha_tool} >&2; __cleanup; exit 65; }}",
            options.handle, options.handle
        ),
        "__h=${__h%% *}".to_owned(),
        format!(
            "if [ \"$__h\" != {} ]; then echo {sha_changed} >&2; __cleanup; exit 65; fi",
            shq(options.expected_sha256)
        ),
        format!("chmod 600 {} || {{ __cleanup; exit 65; }}", options.handle),
        format!(
            "__m=$(stat -c %a {} 2>/dev/null || stat -f %Lp {}) || {{ __cleanup; exit 65; }}",
            options.handle, options.handle
        ),
        format!(
            "if [ \"$__m\" != 600 ]; then echo {handle_not_private} >&2; __cleanup; exit 65; fi"
        ),
    ]
}

fn install_publish_target_lines(options: &InstallPublishOptions<'_>) -> Vec<String> {
    let target_not_file = shq("beam: harness transcript target is not a regular file");
    let exists_differs = shq(&format!(
        "beam: remote transcript {} already exists with different content — it may hold unsaved \
         remote work; inspect and remove it manually, then retry",
        options.destination
    ));
    let appeared = shq("beam: transcript target appeared concurrently — refusing to overwrite it");
    let published_not_file = shq("beam: published transcript is not a regular file");
    let published_not_private = shq("beam: published transcript is not private (0600)");
    vec![
        format!(
            "if [ -L {} ] || {{ [ -e {} ] && [ ! -f {} ]; }}; then echo {target_not_file} >&2; \
             __cleanup; exit 66; fi",
            options.file, options.file, options.file
        ),
        format!("if [ -e {} ]; then", options.file),
        format!(
            "  if cmp -s -- {} {}; then chmod 600 {} || {{ __cleanup; exit 66; }}; __cleanup; exit \
             0; fi",
            options.handle, options.file, options.file
        ),
        format!("  echo {exists_differs} >&2"),
        "  __cleanup".to_owned(),
        "  exit 68".to_owned(),
        "fi".to_owned(),
        format!(
            "ln -- {} {} || {{ echo {appeared} >&2; __cleanup; exit 67; }}",
            options.handle, options.file
        ),
        format!(
            "if [ -L {} ] || [ ! -f {} ]; then echo {published_not_file} >&2; __cleanup; exit 67; fi",
            options.file, options.file
        ),
        format!(
            "__m=$(stat -c %a {} 2>/dev/null || stat -f %Lp {}) || {{ __cleanup; exit 67; }}",
            options.file, options.file
        ),
        format!(
            "if [ \"$__m\" != 600 ]; then echo {published_not_private} >&2; __cleanup; exit 67; fi"
        ),
    ]
}

fn install_prepare_script(dirs: &[&str]) -> String {
    [enter_home(), descend(dirs, true, false)]
        .concat()
        .join("\n")
}

fn install_residue_script(dirs: &[&str], temporary: &str, handle: &str) -> String {
    let mut lines = enter_home();
    lines.extend(descend(dirs, false, true));
    lines.extend(install_residue_lines(temporary, handle));
    lines.join("\n")
}

fn collect_probe_script(dirs: &[&str], quoted_file: &str) -> String {
    let missing = shq("beam: remote harness transcript is missing or unsafe");
    let mut lines = enter_home();
    lines.extend(descend(dirs, false, false));
    lines.push(format!(
        "if [ -L {quoted_file} ] || [ ! -f {quoted_file} ]; then echo {missing} >&2; exit 66; fi"
    ));
    lines.push(format!("ls -lni -- {quoted_file} || exit 66"));
    lines.join("\n")
}

fn cleanup_script(dirs: &[&str], quoted_file: &str, remove_leaf_directory: bool) -> String {
    let refuse_dir = shq("beam: refusing to remove a directory as a transcript");
    let mut lines = enter_home();
    lines.extend(descend(dirs, false, true));
    lines.push(format!(
        "if [ -d {quoted_file} ] && [ ! -L {quoted_file} ]; then echo {refuse_dir} >&2; exit 66; fi"
    ));
    lines.push(format!("rm -f -- {quoted_file} || exit 67"));
    if remove_leaf_directory {
        let leaf = dirs
            .last()
            .expect("safe_segments guarantees a destination parent");
        lines.push("cd -P -- .. || exit 68".to_owned());
        lines.push(format!("rmdir -- {} 2>/dev/null || true", shq(leaf)));
    }
    lines.join("\n")
}

/// Fixed generated-script corpus consumed by the side-by-side parity test.
pub fn guarded_store_script_golden() -> Vec<(&'static str, String)> {
    let dirs = [".claude", "projects", "-tmp-work"];
    let file = shq("session 'x'.jsonl");
    let temporary = shq(".beam-install-fixed");
    let handle = shq(".beam-install-fixed.h");
    vec![
        ("install-prepare", install_prepare_script(&dirs)),
        (
            "install-publish",
            install_publish_script(InstallPublishOptions {
                dirs: &dirs,
                temporary: &temporary,
                handle: &handle,
                file: &file,
                expected_sha256: &"a".repeat(64),
                destination: "~/.claude/projects/-tmp-work/session 'x'.jsonl",
            }),
        ),
        (
            "install-residue",
            install_residue_script(&dirs, &temporary, &handle),
        ),
        ("collect-probe", collect_probe_script(&dirs, &file)),
        ("cleanup-file", cleanup_script(&dirs, &file, false)),
        ("cleanup-leaf", cleanup_script(&dirs, &file, true)),
    ]
}

struct GuardedInstall<'a> {
    dirs: &'a [&'a str],
    destination: String,
    temporary_name: String,
    temporary: String,
    handle: String,
    quoted_file: String,
    expected_sha256: String,
    local_stage: tempfile::TempDir,
}

fn prepare_guarded_install<'a>(
    local_file: &Path,
    segments: &'a [&'a str],
) -> Result<GuardedInstall<'a>, SessionError> {
    let (file, dirs) = segments
        .split_last()
        .expect("safe_segments requires at least two entries");
    let mut nonce = [0_u8; 9];
    getrandom::fill(&mut nonce).map_err(|source| {
        SessionError::message(format!(
            "could not generate harness install nonce: {source}"
        ))
    })?;
    let tag = hex::encode(nonce);
    let temporary_name = format!(".beam-install-{tag}");
    let local_stage = tempfile::Builder::new()
        .prefix("beam-harness-install-")
        .tempdir()
        .map_err(|source| {
            SessionError::caused_by(
                "cannot create private harness install stage".to_owned(),
                source,
            )
        })?;
    let staged_file = local_stage.path().join("session.jsonl");
    fs::copy(local_file, &staged_file).map_err(|source| {
        SessionError::caused_by(
            format!(
                "cannot stage transcript {} for install",
                local_file.display()
            ),
            source,
        )
    })?;
    let expected_sha256 = file_sha256(&staged_file).map_err(|source| {
        SessionError::caused_by(
            format!(
                "cannot hash transcript {} before install",
                local_file.display()
            ),
            source,
        )
    })?;
    Ok(GuardedInstall {
        dirs,
        destination: format!("~/{}", segments.join("/")),
        temporary: shq(&temporary_name),
        handle: shq(&format!(".beam-install-{tag}.h")),
        quoted_file: shq(file),
        expected_sha256,
        temporary_name,
        local_stage,
    })
}

async fn install_guarded_home_file_inner(
    transport: &dyn Transport,
    local_file: &Path,
    path_segments: &[&str],
) -> Result<String, SessionError> {
    let segments = safe_segments(path_segments)?;
    let install = prepare_guarded_install(local_file, segments)?;
    let prepare = install_prepare_script(install.dirs);
    let remote_stage = format!("~/{}/{}", install.dirs.join("/"), install.temporary_name);
    let result = async {
        transport.exec_checked(&prepare).await?;
        transport
            .sync_up(
                install.local_stage.path(),
                &remote_stage,
                SyncOptions {
                    checksum: true,
                    ..SyncOptions::default()
                },
            )
            .await?;
        let publish = install_publish_script(InstallPublishOptions {
            dirs: install.dirs,
            temporary: &install.temporary,
            handle: &install.handle,
            file: &install.quoted_file,
            expected_sha256: &install.expected_sha256,
            destination: &install.destination,
        });
        transport.exec_checked(&publish).await?;
        Ok::<(), SessionError>(())
    }
    .await;
    if let Err(error) = result {
        let cleanup = install_residue_script(install.dirs, &install.temporary, &install.handle);
        let _cleanup_result = transport.exec(&cleanup).await;
        return Err(error);
    }
    Ok(install.destination)
}

pub fn install_guarded_home_file<'a>(
    transport: &'a dyn Transport,
    local_file: &'a Path,
    path_segments: &'a [&'a str],
) -> SessionFuture<'a, String> {
    Box::pin(install_guarded_home_file_inner(
        transport,
        local_file,
        path_segments,
    ))
}

pub struct CollectedHomeFile {
    path: PathBuf,
    _stage: tempfile::TempDir,
}

impl CollectedHomeFile {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn validate_collected_transcript(path: &Path) -> Result<(), SessionError> {
    let metadata = fs::symlink_metadata(path).map_err(|source| {
        if source.kind() == std::io::ErrorKind::NotFound {
            SessionError::message("beam: collected harness transcript is missing".to_owned())
        } else {
            SessionError::caused_by(
                format!("cannot inspect collected transcript {}", path.display()),
                source,
            )
        }
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(SessionError::message(
            "beam: collected harness transcript is unsafe".to_owned(),
        ));
    }
    Ok(())
}

async fn collect_guarded_home_file_inner(
    transport: &dyn Transport,
    path_segments: &[&str],
) -> Result<CollectedHomeFile, SessionError> {
    let segments = safe_segments(path_segments)?;
    let (file, dirs) = segments
        .split_last()
        .expect("safe_segments requires at least two entries");
    let quoted_file = shq(file);
    let probe = collect_probe_script(dirs, &quoted_file);
    let local_stage = tempfile::Builder::new()
        .prefix("beam-harness-return-")
        .tempdir()
        .map_err(|source| {
            SessionError::caused_by(
                "cannot create private harness return stage".to_owned(),
                source,
            )
        })?;
    let before = transport.exec_checked(&probe).await?;
    transport
        .sync_down(
            &format!("~/{}", dirs.join("/")),
            local_stage.path(),
            SyncOptions {
                checksum: true,
                ..SyncOptions::default()
            },
        )
        .await?;
    let after = transport.exec_checked(&probe).await?;
    if after != before {
        return Err(SessionError::message(format!(
            "beam: remote transcript ~/{} changed identity during collection — retry beam down",
            segments.join("/")
        )));
    }
    let path = local_stage.path().join(file);
    validate_collected_transcript(&path)?;
    Ok(CollectedHomeFile {
        path,
        _stage: local_stage,
    })
}

pub fn collect_guarded_home_file<'a>(
    transport: &'a dyn Transport,
    path_segments: &'a [&'a str],
) -> SessionFuture<'a, CollectedHomeFile> {
    Box::pin(collect_guarded_home_file_inner(transport, path_segments))
}

pub fn cleanup_guarded_home_file<'a>(
    transport: &'a dyn Transport,
    path_segments: &'a [&'a str],
    remove_leaf_directory: bool,
) -> SessionFuture<'a, ()> {
    Box::pin(async move {
        let segments = safe_segments(path_segments)?;
        let (file, dirs) = segments
            .split_last()
            .expect("safe_segments requires at least two entries");
        let quoted_file = shq(file);
        let script = cleanup_script(dirs, &quoted_file, remove_leaf_directory);
        transport.exec_checked(&script).await?;
        Ok(())
    })
}
