//! Shared OMP and Pi session adapter.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::session::claude::path_text;
use crate::session::ship_bundle::{session_install_key, session_ship_bundle};
use crate::session::{
    InstallOptions, InstalledSession, LocalSession, SessionAdapter, SessionError, SessionFuture,
    StagedReturn, ToolName,
};
use crate::transport::{OwnedWorkspace, SyncOptions, Transport};
use crate::util::digest::{TreeManifestEntry, file_sha256, tree_manifest};
use crate::util::shell::shq;
use crate::workspace::{enter_workspace_script, owner_guard_script};

pub const OMP_WORKSPACE_SESSION: &str = ".beam/session.jsonl";
pub const PI_WORKSPACE_SESSION: &str = ".beam/pi-sessions/session.jsonl";
const PI_WORKSPACE_SESSION_DIR: &str = ".beam/pi-sessions";
const MAX_SESSION_TREE_ENTRIES: usize = 65_536;
const HEADER_SCAN_BYTES: usize = 64 * 1024;
const SESSION_HEADER_SCAN_LINES: usize = 20;
const MAX_SESSION_REWRITE_LINES: usize = 10_000_000;
const FALLBACK_DIR_SCAN_COUNT: usize = 400;
const MAX_SESSION_DIRECTORY_ENTRIES: usize = 65_536;
const MAX_SESSION_STORE_DIRECTORIES: usize = 65_536;

#[derive(Clone, Copy)]
enum PiFamilyKind {
    Omp,
    Pi,
}

impl PiFamilyKind {
    fn tool(self) -> ToolName {
        match self {
            Self::Omp => ToolName::Omp,
            Self::Pi => ToolName::Pi,
        }
    }

    fn binary(self) -> &'static str {
        match self {
            Self::Omp => "omp",
            Self::Pi => "pi",
        }
    }

    fn login_argv(self) -> &'static [&'static str] {
        match self {
            Self::Omp => &["omp"],
            Self::Pi => &["pi"],
        }
    }

    fn remote_auth_probe(self) -> Option<&'static str> {
        match self {
            Self::Omp => None,
            Self::Pi => Some(r#"test -s "$HOME/.pi/agent/auth.json""#),
        }
    }

    fn store_segments(self) -> &'static [&'static str] {
        match self {
            Self::Omp => &[".omp", "agent", "sessions"],
            Self::Pi => &[".pi", "agent", "sessions"],
        }
    }

    fn workspace_session(self) -> &'static str {
        match self {
            Self::Omp => OMP_WORKSPACE_SESSION,
            Self::Pi => PI_WORKSPACE_SESSION,
        }
    }

    fn private_session_dir(self) -> Option<&'static str> {
        match self {
            Self::Omp => None,
            Self::Pi => Some(PI_WORKSPACE_SESSION_DIR),
        }
    }

    fn dir_candidates(self, cwd: &str, home: &str) -> Vec<String> {
        match self {
            Self::Omp => omp_dir_candidates(cwd, home),
            Self::Pi => vec![format!("-{cwd}-").replace('/', "-") + "-"],
        }
    }

    fn resume_argv(self, kickoff: Option<&str>) -> Vec<String> {
        let mut values = match self {
            Self::Omp => vec![
                "omp".to_owned(),
                "--resume".to_owned(),
                OMP_WORKSPACE_SESSION.to_owned(),
            ],
            Self::Pi => vec![
                "pi".to_owned(),
                "--session-dir".to_owned(),
                PI_WORKSPACE_SESSION_DIR.to_owned(),
                "--continue".to_owned(),
            ],
        };
        if let Some(kickoff) = kickoff {
            values.push(kickoff.to_owned());
        }
        values
    }

    fn local_resume_hint(
        self,
        return_dir: &Path,
        local_cwd: &Path,
    ) -> Result<String, SessionError> {
        match self {
            Self::Omp => Ok(format!(
                "omp --resume {}",
                shq(path_text(&return_dir.join("session.jsonl"), "OMP return")?)
            )),
            Self::Pi => Ok(format!(
                "cd {} && pi --session-dir {} --continue",
                shq(path_text(local_cwd, "Pi local workspace")?),
                shq(path_text(return_dir, "Pi return")?)
            )),
        }
    }
}

fn omp_dir_candidates(cwd: &str, home: &str) -> Vec<String> {
    let mut candidates = Vec::with_capacity(5);
    if let Some(relative) = cwd.strip_prefix(home) {
        candidates.push(relative.replace('/', "-"));
    }
    candidates.push(format!("-{cwd}-").replace('/', "-") + "-");
    let sha = hex::encode(Sha256::digest(cwd.as_bytes()));
    let basename = Path::new(cwd)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    for scope in ["home", "abs", "tmp"] {
        candidates.push(format!("{scope}-{basename}-{sha}"));
    }
    candidates
}

pub fn rewrite_session_header_cwd(jsonl: &str, new_cwd: &str) -> Result<String, SessionError> {
    let mut start = 0_usize;
    for _ in 0..MAX_SESSION_REWRITE_LINES {
        if start >= jsonl.len() {
            break;
        }
        let newline = jsonl[start..].find('\n');
        let end = newline.map_or(jsonl.len(), |offset| start + offset);
        let line = &jsonl[start..end];
        if line.contains("\"type\":\"session\"")
            && let Ok(mut parsed) = serde_json::from_str::<Value>(line)
            && parsed.get("type").and_then(Value::as_str) == Some("session")
        {
            let object = parsed
                .as_object_mut()
                .expect("a type=session JSON value is an object");
            object.insert("cwd".to_owned(), Value::String(new_cwd.to_owned()));
            let mut rewritten = String::new();
            rewritten.push_str(&jsonl[..start]);
            rewritten
                .push_str(&serde_json::to_string(&parsed).expect("a JSON value always serializes"));
            if newline.is_some() {
                rewritten.push('\n');
                rewritten.push_str(&jsonl[end + 1..]);
            }
            return Ok(rewritten);
        }
        let Some(_) = newline else {
            break;
        };
        start = end + 1;
    }
    Err(SessionError::message(
        "session header (type=session) not found in transcript".to_owned(),
    ))
}

struct SessionHeader {
    id: Option<String>,
    cwd: Option<String>,
}

fn header_of_text(text: &str) -> Option<SessionHeader> {
    for line in text.split('\n').take(SESSION_HEADER_SCAN_LINES) {
        if !line.contains("\"type\":\"session\"") {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if parsed.get("type").and_then(Value::as_str) != Some("session") {
            continue;
        }
        return Some(SessionHeader {
            id: parsed.get("id").and_then(Value::as_str).map(str::to_owned),
            cwd: parsed.get("cwd").and_then(Value::as_str).map(str::to_owned),
        });
    }
    None
}

fn rewrite_header_prefix(
    prefix: &[u8],
    new_cwd: &str,
) -> Result<(Vec<u8>, SessionHeader), SessionError> {
    let mut start = 0_usize;
    for _ in 0..SESSION_HEADER_SCAN_LINES {
        if start >= prefix.len() {
            break;
        }
        let newline = prefix[start..].iter().position(|byte| *byte == b'\n');
        let end = newline.map_or(prefix.len(), |offset| start + offset);
        let line = std::str::from_utf8(&prefix[start..end]).ok();
        let parsed = line
            .filter(|value| value.contains("\"type\":\"session\""))
            .and_then(|value| serde_json::from_str::<Value>(value).ok());
        if let Some(mut parsed) = parsed
            && parsed.get("type").and_then(Value::as_str) == Some("session")
        {
            let header = SessionHeader {
                id: parsed.get("id").and_then(Value::as_str).map(str::to_owned),
                cwd: parsed.get("cwd").and_then(Value::as_str).map(str::to_owned),
            };
            let object = parsed
                .as_object_mut()
                .expect("a type=session JSON value is an object");
            object.insert("cwd".to_owned(), Value::String(new_cwd.to_owned()));
            let mut rewritten = Vec::new();
            rewritten.extend_from_slice(&prefix[..start]);
            rewritten.extend_from_slice(
                &serde_json::to_vec(&parsed).expect("a JSON value always serializes"),
            );
            if newline.is_some() {
                rewritten.push(b'\n');
                rewritten.extend_from_slice(&prefix[end + 1..]);
            } else {
                rewritten.extend_from_slice(&prefix[end..]);
            }
            return Ok((rewritten, header));
        }
        let Some(_) = newline else {
            break;
        };
        start = end + 1;
    }
    Err(SessionError::message(
        "session header (type=session) not found in transcript".to_owned(),
    ))
}

fn rewrite_session_header_cwd_file(
    source: &Path,
    destination: &Path,
    new_cwd: &str,
) -> Result<SessionHeader, SessionError> {
    let mut input = File::open(source).map_err(|error| {
        SessionError::caused_by(
            format!("cannot open session transcript {}", source.display()),
            error,
        )
    })?;
    let mut prefix = Vec::with_capacity(HEADER_SCAN_BYTES);
    std::io::Read::by_ref(&mut input)
        .take(HEADER_SCAN_BYTES as u64)
        .read_to_end(&mut prefix)
        .map_err(|error| {
            SessionError::caused_by(
                format!("cannot read session transcript {}", source.display()),
                error,
            )
        })?;
    let (rewritten, header) = rewrite_header_prefix(&prefix, new_cwd)?;
    let mut output = File::create(destination).map_err(|error| {
        SessionError::caused_by(
            format!(
                "cannot create staged session transcript {}",
                destination.display()
            ),
            error,
        )
    })?;
    output.write_all(&rewritten).map_err(|error| {
        SessionError::caused_by("cannot write staged session transcript".to_owned(), error)
    })?;
    std::io::copy(&mut input, &mut output).map_err(|error| {
        SessionError::caused_by("cannot finish staged session transcript".to_owned(), error)
    })?;
    Ok(header)
}

fn session_id_of_file(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    Some(
        stem.rsplit_once('_')
            .map_or_else(|| stem.to_owned(), |(_, id)| id.to_owned()),
    )
}

fn read_header(file: &Path) -> Option<SessionHeader> {
    let source = File::open(file).ok()?;
    let mut bytes = Vec::with_capacity(HEADER_SCAN_BYTES);
    source
        .take(HEADER_SCAN_BYTES as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    header_of_text(&String::from_utf8_lossy(&bytes))
}

fn lexical_cwd(path: &str) -> String {
    for alias in ["/tmp", "/var", "/etc"] {
        if path == alias || path.starts_with(&format!("{alias}/")) {
            return format!("/private{path}");
        }
    }
    path.to_owned()
}

fn physical_cwd(path: &str) -> String {
    fs::canonicalize(path)
        .ok()
        .and_then(|value| value.to_str().map(str::to_owned))
        .unwrap_or_else(|| lexical_cwd(path))
}

fn newest_session_in(
    directory: &Path,
    cwd: &str,
    session_ref: Option<&str>,
) -> Result<Option<(PathBuf, std::time::SystemTime)>, SessionError> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(SessionError::caused_by(
                format!("cannot read session store {}", directory.display()),
                source,
            ));
        }
    };
    let cwd_physical = physical_cwd(cwd);
    let cwd_lexical = lexical_cwd(cwd);
    let mut best = None;
    let mut scanned = 0_usize;
    for entry in entries {
        scanned += 1;
        if scanned > MAX_SESSION_DIRECTORY_ENTRIES {
            return Err(SessionError::message(format!(
                "session directory exceeds {MAX_SESSION_DIRECTORY_ENTRIES} entries — narrow it \
                 before retrying"
            )));
        }
        let entry = entry.map_err(|source| {
            SessionError::caused_by(
                format!("cannot scan session store {}", directory.display()),
                source,
            )
        })?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !name.ends_with(".jsonl") {
            continue;
        }
        if session_ref.is_some_and(|reference| !name.contains(reference)) {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|value| value.modified())
            .map_err(|source| {
                SessionError::caused_by(
                    format!(
                        "cannot inspect session transcript {}",
                        entry.path().display()
                    ),
                    source,
                )
            })?;
        if best
            .as_ref()
            .is_some_and(|value: &(PathBuf, std::time::SystemTime)| modified <= value.1)
        {
            continue;
        }
        if !session_header_matches(&entry.path(), cwd, &cwd_physical, &cwd_lexical) {
            continue;
        }
        best = Some((entry.path(), modified));
    }
    Ok(best)
}
fn session_header_matches(file: &Path, cwd: &str, cwd_physical: &str, cwd_lexical: &str) -> bool {
    let Some(header) = read_header(file) else {
        return false;
    };
    if header.id != session_id_of_file(file) {
        return false;
    }
    let Some(recorded_cwd) = header.cwd else {
        return false;
    };
    recorded_cwd == cwd
        || physical_cwd(&recorded_cwd) == cwd_physical
        || lexical_cwd(&recorded_cwd) == cwd_lexical
}

fn assert_inert_session_tree(root: &Path) -> Result<(), SessionError> {
    let mut pending = vec![root.to_path_buf()];
    let mut walked = 0_usize;
    while let Some(entry) = pending.pop() {
        walked += 1;
        if walked > MAX_SESSION_TREE_ENTRIES {
            return Err(SessionError::message(format!(
                "remote session data holds over {MAX_SESSION_TREE_ENTRIES} entries — refusing"
            )));
        }
        let metadata = fs::symlink_metadata(&entry).map_err(|source| {
            SessionError::caused_by(
                format!("cannot inspect remote session data {}", entry.display()),
                source,
            )
        })?;
        if metadata.file_type().is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
            return Err(SessionError::message(format!(
                "remote session data contains an unsafe filesystem entry: {}",
                entry.display()
            )));
        }
        if metadata.is_dir() {
            let children_iter = fs::read_dir(&entry).map_err(|source| {
                SessionError::caused_by(
                    format!("cannot walk remote session data {}", entry.display()),
                    source,
                )
            })?;
            let mut children = Vec::new();
            for child in children_iter {
                if pending.len() + children.len() >= MAX_SESSION_TREE_ENTRIES - walked {
                    return Err(SessionError::message(format!(
                        "remote session data holds over {MAX_SESSION_TREE_ENTRIES} entries — \
                         refusing"
                    )));
                }
                let child = child.map_err(|source| {
                    SessionError::caused_by(
                        format!("cannot walk remote session data {}", entry.display()),
                        source,
                    )
                })?;
                children.push(child.path());
            }
            children.sort();
            children.reverse();
            pending.extend(children);
        }
    }
    Ok(())
}

struct InstallCommitOptions<'a> {
    workspace_session: &'a str,
    artifacts_destination: &'a str,
    stage_parent: &'a str,
    stage_name: &'a str,
    key: &'a str,
    manifest: &'a [TreeManifestEntry],
    has_artifacts: bool,
}

fn install_read_mode_script(quoted: &str) -> String {
    format!("__m=$(stat -c %a {quoted} 2>/dev/null || stat -f %Lp {quoted}) || exit 67")
}

fn install_mode_octal(mode: u32) -> String {
    format!("{:o}", mode & 0o7777)
}

fn install_differs_script(what: &str) -> String {
    let message = format!(
        "beam: remote {what} already exists with different content — it may hold unsaved remote \
         work; inspect and remove it manually, then retry beam up"
    );
    format!("echo {} >&2; exit 68", shq(&message))
}

fn install_guard_script(options: &InstallCommitOptions<'_>) -> Vec<String> {
    let beam = shq(".beam");
    let staged = shq(&format!("{}/session.jsonl", options.stage_name));
    vec![
        format!(
            "if [ -L {beam} ]; then echo {} >&2; exit 63; fi",
            shq("beam: .beam is a symlink — refusing session install")
        ),
        format!(
            "mkdir -p -- {beam} || {{ echo {} >&2; exit 63; }}",
            shq("beam: cannot create .beam")
        ),
        format!(
            "if [ -L {beam} ] || [ ! -d {beam} ]; then echo {} >&2; exit 64; fi",
            shq("beam: .beam is not a real directory")
        ),
        format!(
            "chmod 700 {beam} || {{ echo {} >&2; exit 64; }}",
            shq("beam: cannot secure .beam")
        ),
        install_read_mode_script(&beam),
        format!(
            "if [ \"$__m\" != 700 ]; then echo {} >&2; exit 64; fi",
            shq("beam: .beam is not private (0700)")
        ),
        format!(
            "if [ -L {} ] || [ -L {} ] || [ ! -d {} ]; then echo {} >&2; exit 65; fi",
            shq(options.stage_parent),
            shq(options.stage_name),
            shq(options.stage_name),
            shq("beam: session install stage is not a real directory")
        ),
        format!(
            "if [ -L {staged} ] || [ ! -f {staged} ]; then echo {} >&2; exit 65; fi",
            shq("beam: staged transcript is missing or unsafe")
        ),
        format!(
            "chmod 700 {} {} || {{ echo {} >&2; exit 65; }}",
            shq(options.stage_parent),
            shq(options.stage_name),
            shq("beam: cannot secure the install stage")
        ),
        install_read_mode_script(&shq(options.stage_name)),
        format!(
            "if [ \"$__m\" != 700 ]; then echo {} >&2; exit 65; fi",
            shq("beam: install stage is not private (0700)")
        ),
    ]
}

fn install_private_dir_script(
    private_session_dir: &str,
    workspace_session: &str,
    artifacts_destination: &str,
) -> Vec<String> {
    let directory = shq(private_session_dir);
    vec![
        format!(
            "if [ -L {directory} ]; then echo {} >&2; exit 63; fi",
            shq("beam: private session dir is a symlink — refusing")
        ),
        format!(
            "mkdir -p -- {directory} || {{ echo {} >&2; exit 66; }}",
            shq("beam: failed to create the private session dir")
        ),
        format!(
            "chmod 700 {directory} || {{ echo {} >&2; exit 66; }}",
            shq("beam: cannot secure the private session dir")
        ),
        install_read_mode_script(&directory),
        format!(
            "if [ \"$__m\" != 700 ]; then echo {} >&2; exit 66; fi",
            shq("beam: private session dir is not private (0700)")
        ),
        format!(
            "extra=$(find {directory} -mindepth 1 ! -path {} ! -path {} ! -path {} | head -n 1)",
            shq(workspace_session),
            shq(artifacts_destination),
            shq(&format!("{artifacts_destination}/*"))
        ),
        format!(
            "if [ -n \"$extra\" ]; then echo {} >&2; exit 68; fi",
            shq(&format!(
                "beam: private session dir {private_session_dir} holds unexpected entries — \
                 inspect and remove them manually, then retry beam up"
            ))
        ),
    ]
}

fn install_verify_artifacts_script<F>(manifest: &[TreeManifestEntry], fail: F) -> Vec<String>
where
    F: Fn(&str) -> String,
{
    let mut lines = vec![
        "__n=$(find \"$__dest_arts\" -mindepth 1 | wc -l | tr -d '[:space:]') || exit 67"
            .to_owned(),
        format!(
            "if [ \"$__n\" != {} ]; then {}; fi",
            manifest.len(),
            fail("unexpected extra entries")
        ),
    ];
    for entry in manifest {
        let destination = format!("\"$__dest_arts/\"{}", shq(&entry.path));
        let source = format!("\"$__stage_arts/\"{}", shq(&entry.path));
        if entry.kind == "link" {
            let target = entry
                .target
                .as_deref()
                .expect("tree manifests give every link a target");
            lines.push(format!(
                "if [ ! -L {destination} ] || [ \"$(readlink {destination})\" != {} ]; then {}; fi",
                shq(target),
                fail(&entry.path)
            ));
        } else if entry.kind == "dir" {
            lines.push(format!(
                "if [ -L {destination} ] || [ ! -d {destination} ]; then {}; fi",
                fail(&entry.path)
            ));
            lines.push(install_read_mode_script(&destination));
            lines.push(format!(
                "if [ \"$__m\" != {} ]; then {}; fi",
                install_mode_octal(
                    entry
                        .mode
                        .expect("tree manifests give every directory a mode")
                ),
                fail(&format!("{} (mode)", entry.path))
            ));
        } else {
            debug_assert_eq!(entry.kind, "file");
            lines.push(format!(
                "if [ -L {destination} ] || [ ! -f {destination} ]; then {}; fi",
                fail(&entry.path)
            ));
            lines.push(format!(
                "cmp -s -- {source} {destination} || {{ {}; }}",
                fail(&entry.path)
            ));
            lines.push(install_read_mode_script(&destination));
            lines.push(format!(
                "if [ \"$__m\" != {} ]; then {}; fi",
                install_mode_octal(entry.mode.expect("tree manifests give every file a mode")),
                fail(&format!("{} (mode)", entry.path))
            ));
        }
    }
    lines
}

fn install_verify_phase_script(options: &InstallCommitOptions<'_>) -> Vec<String> {
    let transcript = shq(options.workspace_session);
    let differs = |what: &str| {
        install_differs_script(&format!(
            "artifacts {} ({what})",
            options.artifacts_destination
        ))
    };
    let verify = install_verify_artifacts_script(options.manifest, differs);
    let mut lines = vec![
        format!(
            "if [ -L {transcript} ] || {{ [ -e {transcript} ] && [ ! -f {transcript} ]; }}; then \
             echo {} >&2; exit 66; fi",
            shq("beam: reserved transcript path is not a regular file")
        ),
        format!("if [ -e {transcript} ]; then"),
        format!(
            "  cmp -s -- {} {transcript} || {{ {}; }}",
            shq(&format!("{}/session.jsonl", options.stage_name)),
            install_differs_script(&format!("transcript {}", options.workspace_session))
        ),
        "fi".to_owned(),
        format!(
            "__stage_arts={}",
            shq(&format!("{}/artifacts", options.stage_name))
        ),
        format!("__dest_arts={}", shq(options.artifacts_destination)),
        "__sentinel=\"$__dest_arts/.beam-install-owner\"".to_owned(),
        format!(
            "__owner_line={}",
            shq(&format!("beam-artifacts-v1 {}", options.key))
        ),
        "__arts_done=0".to_owned(),
    ];
    if options.has_artifacts {
        lines.extend([
            format!(
                "if [ -L \"$__dest_arts\" ]; then echo {} >&2; exit 66; fi",
                shq("beam: reserved artifacts path is a symlink — refusing")
            ),
            "if [ -e \"$__dest_arts\" ]; then".to_owned(),
            format!(
                "  [ -d \"$__dest_arts\" ] || {{ echo {} >&2; exit 66; }}",
                shq("beam: reserved artifacts path is not a directory")
            ),
            "  if [ -f \"$__sentinel\" ] && [ \"$(cat \"$__sentinel\" 2>/dev/null)\" = \
             \"$__owner_line\" ]; then"
                .to_owned(),
            "    :".to_owned(),
            "  else".to_owned(),
        ]);
        lines.extend(verify.into_iter().map(|line| format!("    {line}")));
        lines.extend([
            "    __arts_done=1".to_owned(),
            "  fi".to_owned(),
            "fi".to_owned(),
        ]);
    } else {
        lines.push(format!(
            "if [ -e \"$__dest_arts\" ] || [ -L \"$__dest_arts\" ]; then {}; fi",
            differs("this ship carries none")
        ));
    }
    lines
}

fn install_publish_artifacts_script(
    manifest: &[TreeManifestEntry],
    artifacts_destination: &str,
) -> Vec<String> {
    let mut lines = Vec::with_capacity(manifest.len() * 5);
    for entry in manifest {
        let destination = format!("\"$__dest_arts/\"{}", shq(&entry.path));
        let source = format!("\"$__stage_arts/\"{}", shq(&entry.path));
        let conflict = install_differs_script(&format!(
            "artifacts {artifacts_destination} (conflicting entry {})",
            entry.path
        ));
        if entry.kind == "link" {
            let target = entry
                .target
                .as_deref()
                .expect("tree manifests give every link a target");
            lines.extend([
                format!(
                    "  if [ -L {destination} ]; then [ \"$(readlink {destination})\" = {} ] || {{ \
                     {conflict}; }};",
                    shq(target)
                ),
                format!("  elif [ -e {destination} ]; then {conflict};"),
                format!(
                    "  else ln -s -- {} {destination} || exit 67; fi",
                    shq(target)
                ),
            ]);
        } else if entry.kind == "dir" {
            lines.extend([
                format!("  if [ -L {destination} ]; then {conflict}; fi"),
                format!("  if [ ! -e {destination} ]; then mkdir -- {destination} || exit 67; fi"),
                format!("  [ -d {destination} ] || {{ {conflict}; }}"),
                format!(
                    "  chmod {} {destination} || exit 67",
                    install_mode_octal(
                        entry
                            .mode
                            .expect("tree manifests give every directory a mode")
                    )
                ),
            ]);
        } else {
            debug_assert_eq!(entry.kind, "file");
            lines.extend([
                format!("  if [ -L {destination} ]; then {conflict}; fi"),
                format!(
                    "  if [ ! -e {destination} ]; then ( set -C; cat {source} > {destination} ) \
                     2>/dev/null || exit 67; fi"
                ),
                format!("  [ -f {destination} ] || {{ {conflict}; }}"),
                format!("  cmp -s -- {source} {destination} || {{ {conflict}; }}"),
                format!(
                    "  chmod {} {destination} || exit 67",
                    install_mode_octal(entry.mode.expect("tree manifests give every file a mode"))
                ),
            ]);
        }
    }
    lines
}

fn install_artifacts_transaction_script(options: &InstallCommitOptions<'_>) -> Vec<String> {
    let differs = |what: &str| {
        install_differs_script(&format!(
            "artifacts {} ({what})",
            options.artifacts_destination
        ))
    };
    let verify = install_verify_artifacts_script(options.manifest, |what| {
        differs(&format!("post-publish verification: {what}"))
    });
    let mut lines = vec![
        "if [ \"$__arts_done\" != 1 ]; then".to_owned(),
        "  if [ ! -e \"$__dest_arts\" ]; then".to_owned(),
        format!(
            "    mkdir -- \"$__dest_arts\" || {{ echo {} >&2; exit 67; }}",
            shq("beam: artifacts destination appeared concurrently — refusing to overwrite it")
        ),
        format!(
            "    ( set -C; printf '%s\\n' \"$__owner_line\" > \"$__sentinel\" ) 2>/dev/null || \
             {{ echo {} >&2; exit 67; }}",
            shq("beam: failed to claim the artifacts destination")
        ),
        "  fi".to_owned(),
        "  chmod 700 \"$__dest_arts\" || exit 67".to_owned(),
        format!("  {}", install_read_mode_script("\"$__dest_arts\"")),
        format!(
            "  if [ \"$__m\" != 700 ]; then echo {} >&2; exit 67; fi",
            shq("beam: artifacts destination is not private (0700)")
        ),
    ];
    lines.extend(install_publish_artifacts_script(
        options.manifest,
        options.artifacts_destination,
    ));
    lines.push("  rm -f -- \"$__sentinel\"".to_owned());
    lines.extend(verify.into_iter().map(|line| format!("  {line}")));
    lines.push("fi".to_owned());
    lines
}

fn install_publish_phase_script(options: &InstallCommitOptions<'_>) -> Vec<String> {
    let transcript = shq(options.workspace_session);
    let mut lines = vec![
        format!("if [ ! -e {transcript} ]; then"),
        format!(
            "  ln -- {} {transcript} || {{ echo {} >&2; exit 67; }}",
            shq(&format!("{}/session.jsonl", options.stage_name)),
            shq("beam: transcript target appeared concurrently — refusing to overwrite it")
        ),
        "fi".to_owned(),
        format!(
            "chmod 600 {transcript} || {{ echo {} >&2; exit 67; }}",
            shq("beam: cannot secure the transcript")
        ),
        install_read_mode_script(&transcript),
        format!(
            "if [ \"$__m\" != 600 ]; then echo {} >&2; exit 67; fi",
            shq("beam: transcript did not land private (0600)")
        ),
    ];
    if options.has_artifacts {
        lines.extend(install_artifacts_transaction_script(options));
    }
    lines.push(format!("rm -rf -- {}", shq(options.stage_name)));
    lines.push(format!(
        "rmdir -- {} 2>/dev/null || true",
        shq(options.stage_parent)
    ));
    lines
}

fn install_local_stage(
    session: &LocalSession,
    remote_cwd: &str,
    install_key: Option<&str>,
) -> Result<(tempfile::TempDir, String), SessionError> {
    let local_stage = tempfile::Builder::new()
        .prefix("beam-session-stage-")
        .tempdir()
        .map_err(|source| {
            SessionError::caused_by(
                "cannot create private session install stage".to_owned(),
                source,
            )
        })?;
    let header = rewrite_session_header_cwd_file(
        &session.file,
        &local_stage.path().join("session.jsonl"),
        remote_cwd,
    )?;
    if header.id.as_deref() != Some(&session.id) {
        let recorded = header.id.as_deref().unwrap_or("(none)");
        return Err(SessionError::message(format!(
            "local transcript {} records session id {recorded}, not {} — refusing to ship a \
             mismatched session",
            session.file.display(),
            session.id
        )));
    }
    let key = match install_key {
        Some(value) => value.to_owned(),
        None => session_install_key(&session_ship_bundle(session)?),
    };
    let mut characters = key.chars();
    let valid_first = characters
        .next()
        .is_some_and(|value| value.is_ascii_alphanumeric());
    let valid_rest = characters.all(|value| value.is_ascii_alphanumeric() || ".-_".contains(value));
    if !valid_first || !valid_rest {
        return Err(SessionError::message(
            "beam: invalid session install key".to_owned(),
        ));
    }
    Ok((local_stage, key))
}

fn session_artifact_manifest(
    session: &LocalSession,
) -> Result<Vec<TreeManifestEntry>, SessionError> {
    let manifest = session
        .artifacts_dir
        .as_ref()
        .map(|path| tree_manifest(path))
        .transpose()
        .map_err(|source| {
            SessionError::caused_by("cannot manifest session artifacts".to_owned(), source)
        })?
        .unwrap_or_default();
    if manifest.len() > MAX_SESSION_TREE_ENTRIES {
        return Err(SessionError::message(format!(
            "session artifact tree exceeds {MAX_SESSION_TREE_ENTRIES} entries — reduce it before \
             retrying"
        )));
    }
    Ok(manifest)
}

struct PiFamilyAdapter {
    kind: PiFamilyKind,
}

fn validate_returned_header(
    kind: PiFamilyKind,
    header: &SessionHeader,
    session: &LocalSession,
    remote_cwd: &str,
) -> Result<(), SessionError> {
    if header.id.as_deref() != Some(&session.id) {
        let id = header.id.as_deref().unwrap_or("(none)");
        return Err(SessionError::message(format!(
            "remote transcript {remote_cwd}/{} records session id {id}, not this handoff's session \
             {} — refusing to import a foreign session",
            kind.workspace_session(),
            session.id
        )));
    }
    if header.cwd.as_deref() != Some(remote_cwd) {
        let cwd = header.cwd.as_deref().unwrap_or("(none)");
        return Err(SessionError::message(format!(
            "remote transcript {remote_cwd}/{} records cwd {cwd}, not this handoff's workspace \
             {remote_cwd} — refusing to import a foreign session",
            kind.workspace_session()
        )));
    }
    Ok(())
}

fn stage_returned_transcript(
    kind: PiFamilyKind,
    session: &LocalSession,
    local_cwd: &Path,
    remote_cwd: &str,
    stage_dir: &Path,
    collected_session: &Path,
) -> Result<String, SessionError> {
    let candidate = stage_dir.join(".session.jsonl.candidate");
    let local_cwd = path_text(local_cwd, "pi-family local workspace")?;
    let header = rewrite_session_header_cwd_file(collected_session, &candidate, local_cwd)?;
    if let Err(error) = validate_returned_header(kind, &header, session, remote_cwd) {
        let _remove_result = fs::remove_file(&candidate);
        return Err(error);
    }
    let staged = stage_dir.join("session.jsonl");
    fs::rename(&candidate, &staged).map_err(|source| {
        SessionError::caused_by(
            format!("cannot publish staged session return {}", staged.display()),
            source,
        )
    })?;
    file_sha256(collected_session).map_err(|source| {
        SessionError::caused_by("cannot hash returned session transcript".to_owned(), source)
    })
}

fn install_commit_script(
    kind: PiFamilyKind,
    remote_cwd: &str,
    owner: Option<&str>,
    options: &InstallCommitOptions<'_>,
) -> String {
    let mut lines = vec!["set -u".to_owned(), enter_workspace_script(remote_cwd)];
    if let Some(owner) = owner {
        lines.push(owner_guard_script(owner));
    }
    lines.extend(install_guard_script(options));
    if let Some(private_session_dir) = kind.private_session_dir() {
        lines.extend(install_private_dir_script(
            private_session_dir,
            options.workspace_session,
            options.artifacts_destination,
        ));
    }
    lines.extend(install_verify_phase_script(options));
    lines.extend(install_publish_phase_script(options));
    lines.join("\n")
}

/// Fixed generated-script corpus consumed by the side-by-side parity test.
pub fn pi_family_install_script_golden() -> Vec<(&'static str, String)> {
    let remote_cwd = "/srv/beam/work space";
    let key = "key-123";
    let manifest = vec![
        TreeManifestEntry {
            path: "latest".to_owned(),
            kind: "link".to_owned(),
            mode: None,
            target: Some("nested/blob 'one'".to_owned()),
        },
        TreeManifestEntry {
            path: "nested".to_owned(),
            kind: "dir".to_owned(),
            mode: Some(0o700),
            target: None,
        },
        TreeManifestEntry {
            path: "nested/blob 'one'".to_owned(),
            kind: "file".to_owned(),
            mode: Some(0o600),
            target: None,
        },
    ];
    let cases = [
        (PiFamilyKind::Omp, None, &[][..], false),
        (
            PiFamilyKind::Pi,
            Some("owner-'x"),
            manifest.as_slice(),
            true,
        ),
    ];
    cases
        .into_iter()
        .map(|(kind, owner, manifest, has_artifacts)| {
            let workspace_session = kind.workspace_session();
            let options = InstallCommitOptions {
                workspace_session,
                artifacts_destination: workspace_session
                    .strip_suffix(".jsonl")
                    .expect("pi-family session golden ends in .jsonl"),
                stage_parent: ".beam/session-install",
                stage_name: ".beam/session-install/key-123",
                key,
                manifest,
                has_artifacts,
            };
            let label = match kind {
                PiFamilyKind::Omp => "omp-no-artifacts",
                PiFamilyKind::Pi => "pi-artifact-tree-owner",
            };
            (
                label,
                install_commit_script(kind, remote_cwd, owner, &options),
            )
        })
        .collect()
}

impl PiFamilyAdapter {
    const fn new(kind: PiFamilyKind) -> Self {
        Self { kind }
    }

    fn locate_inner(
        &self,
        cwd: &Path,
        home: &Path,
        session_ref: Option<&str>,
    ) -> Result<Option<LocalSession>, SessionError> {
        let cwd_text = path_text(cwd, "pi-family workspace")?;
        let home_text = path_text(home, "pi-family home")?;
        let mut root = home.to_path_buf();
        for segment in self.kind.store_segments() {
            root.push(segment);
        }
        if !root.exists() {
            return Ok(None);
        }
        let mut best = None;
        let mut tried = HashSet::new();
        for name in self.kind.dir_candidates(cwd_text, home_text) {
            tried.insert(name.clone());
            let found = newest_session_in(&root.join(name), cwd_text, session_ref)?;
            if found.as_ref().is_some_and(|value| {
                best.as_ref()
                    .is_none_or(|current: &(PathBuf, std::time::SystemTime)| value.1 > current.1)
            }) {
                best = found;
            }
        }
        if best.is_none() {
            best = self.locate_fallback(&root, &tried, cwd_text, session_ref)?;
        }
        let Some((file, modified)) = best else {
            return Ok(None);
        };
        let id = session_id_of_file(&file).expect("a selected session has a UTF-8 JSONL filename");
        let artifacts = file.with_file_name(&id);
        Ok(Some(LocalSession {
            tool: self.kind.tool(),
            id,
            file,
            store_file: None,
            artifacts_dir: artifacts.exists().then_some(artifacts),
            modified,
        }))
    }

    fn locate_fallback(
        &self,
        root: &Path,
        tried: &HashSet<String>,
        cwd: &str,
        session_ref: Option<&str>,
    ) -> Result<Option<(PathBuf, std::time::SystemTime)>, SessionError> {
        let mut directories = Vec::new();
        let mut scanned = 0_usize;
        for entry in fs::read_dir(root).map_err(|source| {
            SessionError::caused_by(
                format!("cannot read session store {}", root.display()),
                source,
            )
        })? {
            scanned += 1;
            if scanned > MAX_SESSION_STORE_DIRECTORIES {
                return Err(SessionError::message(format!(
                    "session store exceeds {MAX_SESSION_STORE_DIRECTORIES} directories — narrow it \
                     before retrying"
                )));
            }
            let entry = entry.map_err(|source| {
                SessionError::caused_by(
                    format!("cannot scan session store {}", root.display()),
                    source,
                )
            })?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if tried.contains(&name) {
                continue;
            }
            let metadata = entry.metadata().map_err(|source| {
                SessionError::caused_by(
                    format!(
                        "cannot inspect session store path {}",
                        entry.path().display()
                    ),
                    source,
                )
            })?;
            if metadata.is_dir() {
                directories.push((
                    entry.path(),
                    metadata.modified().map_err(|source| {
                        SessionError::caused_by(
                            "cannot read session directory timestamp".to_owned(),
                            source,
                        )
                    })?,
                ));
            }
        }
        directories.sort_by_key(|directory| std::cmp::Reverse(directory.1));
        let mut best = None;
        for (directory, _) in directories.into_iter().take(FALLBACK_DIR_SCAN_COUNT) {
            let found = newest_session_in(&directory, cwd, session_ref)?;
            if found.as_ref().is_some_and(|value| {
                best.as_ref()
                    .is_none_or(|current: &(PathBuf, std::time::SystemTime)| value.1 > current.1)
            }) {
                best = found;
            }
        }
        Ok(best)
    }

    async fn install_inner(
        &self,
        transport: &dyn Transport,
        session: &LocalSession,
        remote_cwd: &str,
        options: InstallOptions<'_>,
    ) -> Result<InstalledSession, SessionError> {
        let (local_stage, key) = install_local_stage(session, remote_cwd, options.install_key)?;
        let workspace_session = self.kind.workspace_session();
        let artifacts_destination = workspace_session
            .strip_suffix(".jsonl")
            .expect("pi-family workspace sessions end in .jsonl");
        let stage_parent = ".beam/session-install";
        let stage_name = format!("{stage_parent}/{key}");
        let stage = format!("{remote_cwd}/{stage_name}");
        let owned = options.owner.map(|owner_bytes| OwnedWorkspace {
            root: remote_cwd,
            owner_bytes,
        });
        let sync = SyncOptions {
            checksum: true,
            owned,
            ..SyncOptions::default()
        };
        transport.sync_up(local_stage.path(), &stage, sync).await?;
        if let Some(artifacts) = &session.artifacts_dir {
            transport
                .sync_up(
                    artifacts,
                    &format!("{stage}/artifacts"),
                    SyncOptions {
                        checksum: true,
                        owned,
                        ..SyncOptions::default()
                    },
                )
                .await?;
        }
        let manifest = session_artifact_manifest(session)?;
        let commit_options = InstallCommitOptions {
            workspace_session,
            artifacts_destination,
            stage_parent,
            stage_name: &stage_name,
            key: &key,
            manifest: &manifest,
            has_artifacts: session.artifacts_dir.is_some(),
        };
        let commit = install_commit_script(self.kind, remote_cwd, options.owner, &commit_options);
        transport.exec_checked(&commit).await?;
        let mut notes = vec![format!(
            "session -> {workspace_session} (header cwd rewritten)"
        )];
        if session.artifacts_dir.is_some() {
            notes.push(format!("artifacts -> {artifacts_destination}/"));
        }
        Ok(InstalledSession {
            resume_argv: self.kind.resume_argv(options.kickoff),
            notes,
        })
    }

    async fn stage_return_inner(
        &self,
        transport: &dyn Transport,
        session: &LocalSession,
        local_cwd: &Path,
        remote_cwd: &str,
        stage_dir: &Path,
    ) -> Result<StagedReturn, SessionError> {
        let fetched = stage_dir.join(".beam-tree");
        transport
            .sync_down(
                &format!("{remote_cwd}/.beam"),
                &fetched,
                SyncOptions {
                    checksum: true,
                    ..SyncOptions::default()
                },
            )
            .await?;
        assert_inert_session_tree(&fetched)?;
        let workspace_session = self.kind.workspace_session();
        let session_relative = workspace_session
            .strip_prefix(".beam/")
            .expect("pi-family session lives under .beam");
        let collected_session = fetched.join(session_relative);
        let metadata = fs::symlink_metadata(&collected_session).map_err(|source| {
            if source.kind() == std::io::ErrorKind::NotFound {
                SessionError::message(format!(
                    "remote session {remote_cwd}/{workspace_session} not found — was the workspace \
                     shipped with a session?"
                ))
            } else {
                SessionError::caused_by(
                    "cannot inspect returned session transcript".to_owned(),
                    source,
                )
            }
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(SessionError::message(format!(
                "remote session {remote_cwd}/{workspace_session} not found — was the workspace \
                 shipped with a session?"
            )));
        }
        self.finish_stage_return(
            session,
            local_cwd,
            remote_cwd,
            stage_dir,
            &fetched,
            &collected_session,
        )
    }

    fn finish_stage_return(
        &self,
        session: &LocalSession,
        local_cwd: &Path,
        remote_cwd: &str,
        stage_dir: &Path,
        fetched: &Path,
        collected_session: &Path,
    ) -> Result<StagedReturn, SessionError> {
        let remote_session_sha256 = stage_returned_transcript(
            self.kind,
            session,
            local_cwd,
            remote_cwd,
            stage_dir,
            collected_session,
        )?;
        let artifacts_relative = self
            .kind
            .workspace_session()
            .strip_prefix(".beam/")
            .and_then(|value| value.strip_suffix(".jsonl"))
            .expect("pi-family artifacts path derives from its session path");
        let collected_artifacts = fetched.join(artifacts_relative);
        if collected_artifacts.exists() {
            fs::rename(&collected_artifacts, stage_dir.join("artifacts")).map_err(|source| {
                SessionError::caused_by(
                    "cannot stage returned session artifacts".to_owned(),
                    source,
                )
            })?;
        }
        fs::remove_dir_all(fetched).map_err(|source| {
            SessionError::caused_by(
                "cannot remove fetched reserved session tree".to_owned(),
                source,
            )
        })?;
        Ok(StagedReturn {
            hint: self.kind.local_resume_hint(stage_dir, local_cwd)?,
            remote_session_sha256,
        })
    }
}

impl SessionAdapter for PiFamilyAdapter {
    fn tool(&self) -> ToolName {
        self.kind.tool()
    }

    fn binary(&self) -> &'static str {
        self.kind.binary()
    }

    fn login_argv(&self) -> &'static [&'static str] {
        self.kind.login_argv()
    }

    fn remote_auth_probe(&self) -> Option<&'static str> {
        self.kind.remote_auth_probe()
    }

    fn locate<'a>(
        &'a self,
        cwd: &'a Path,
        home: &'a Path,
        session_ref: Option<&'a str>,
    ) -> SessionFuture<'a, Option<LocalSession>> {
        Box::pin(async move { self.locate_inner(cwd, home, session_ref) })
    }

    fn install<'a>(
        &'a self,
        transport: &'a dyn Transport,
        session: &'a LocalSession,
        remote_cwd: &'a str,
        options: InstallOptions<'a>,
    ) -> SessionFuture<'a, InstalledSession> {
        Box::pin(async move {
            self.install_inner(transport, session, remote_cwd, options)
                .await
        })
    }

    fn stage_return<'a>(
        &'a self,
        transport: &'a dyn Transport,
        session: &'a LocalSession,
        local_cwd: &'a Path,
        remote_cwd: &'a str,
        stage_dir: &'a Path,
    ) -> SessionFuture<'a, StagedReturn> {
        Box::pin(async move {
            self.stage_return_inner(transport, session, local_cwd, remote_cwd, stage_dir)
                .await
        })
    }

    fn cleanup_remote<'a>(
        &'a self,
        _transport: &'a dyn Transport,
        _session: &'a LocalSession,
        _remote_cwd: &'a str,
    ) -> SessionFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}

pub struct OmpAdapter(PiFamilyAdapter);

impl OmpAdapter {
    pub const fn new() -> Self {
        Self(PiFamilyAdapter::new(PiFamilyKind::Omp))
    }
}
impl Default for OmpAdapter {
    fn default() -> Self {
        Self::new()
    }
}

pub struct PiAdapter(PiFamilyAdapter);

impl PiAdapter {
    pub const fn new() -> Self {
        Self(PiFamilyAdapter::new(PiFamilyKind::Pi))
    }
}
impl Default for PiAdapter {
    fn default() -> Self {
        Self::new()
    }
}

macro_rules! delegate_adapter {
    ($adapter:ty) => {
        impl SessionAdapter for $adapter {
            fn tool(&self) -> ToolName {
                self.0.tool()
            }

            fn binary(&self) -> &'static str {
                self.0.binary()
            }

            fn login_argv(&self) -> &'static [&'static str] {
                self.0.login_argv()
            }

            fn remote_auth_probe(&self) -> Option<&'static str> {
                self.0.remote_auth_probe()
            }

            fn locate<'a>(
                &'a self,
                cwd: &'a Path,
                home: &'a Path,
                session_ref: Option<&'a str>,
            ) -> SessionFuture<'a, Option<LocalSession>> {
                self.0.locate(cwd, home, session_ref)
            }

            fn install<'a>(
                &'a self,
                transport: &'a dyn Transport,
                session: &'a LocalSession,
                remote_cwd: &'a str,
                options: InstallOptions<'a>,
            ) -> SessionFuture<'a, InstalledSession> {
                self.0.install(transport, session, remote_cwd, options)
            }

            fn stage_return<'a>(
                &'a self,
                transport: &'a dyn Transport,
                session: &'a LocalSession,
                local_cwd: &'a Path,
                remote_cwd: &'a str,
                stage_dir: &'a Path,
            ) -> SessionFuture<'a, StagedReturn> {
                self.0
                    .stage_return(transport, session, local_cwd, remote_cwd, stage_dir)
            }

            fn cleanup_remote<'a>(
                &'a self,
                transport: &'a dyn Transport,
                session: &'a LocalSession,
                remote_cwd: &'a str,
            ) -> SessionFuture<'a, ()> {
                self.0.cleanup_remote(transport, session, remote_cwd)
            }
        }
    };
}

delegate_adapter!(OmpAdapter);
delegate_adapter!(PiAdapter);
