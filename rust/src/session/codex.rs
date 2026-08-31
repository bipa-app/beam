//! Codex CLI session adapter.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

use crate::session::claude::path_text;
use crate::session::guarded_store::{
    cleanup_guarded_home_file, collect_guarded_home_file, install_guarded_home_file,
};
use crate::session::{
    InstallOptions, InstalledSession, LocalSession, SessionAdapter, SessionError, SessionFuture,
    StagedReturn, ToolName,
};
use crate::transport::Transport;
use crate::util::digest::file_sha256;
use crate::util::shell::shq;

const CANDIDATE_SCAN_COUNT: usize = 400;
pub const HEADER_SCAN_BYTES: usize = 64 * 1024;
const MAX_CODEX_STORE_ENTRIES: usize = 65_536;
const MAX_CODEX_STORE_SEGMENTS: usize = 16;

pub struct CodexAdapter;

#[derive(Deserialize)]
struct SessionMeta {
    #[serde(rename = "type")]
    kind: Option<String>,
    payload: Option<SessionPayload>,
}

#[derive(Deserialize)]
struct SessionPayload {
    session_id: Option<String>,
    id: Option<String>,
    cwd: Option<String>,
}

fn read_header_line(file: &Path) -> Result<String, SessionError> {
    let source = File::open(file).map_err(|error| {
        SessionError::caused_by(
            format!("cannot open Codex transcript {}", file.display()),
            error,
        )
    })?;
    let mut bytes = Vec::with_capacity(HEADER_SCAN_BYTES);
    source
        .take(HEADER_SCAN_BYTES as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            SessionError::caused_by(
                format!("cannot read Codex transcript header {}", file.display()),
                error,
            )
        })?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(text.split('\n').next().unwrap_or("").to_owned())
}

fn parse_meta(text: &str) -> Result<SessionMeta, serde_json::Error> {
    let first_line = text.split('\n').next().unwrap_or("");
    serde_json::from_str(first_line)
}

fn assert_codex_transcript(
    text: &str,
    session_id: &str,
    expected_cwd: Option<&str>,
) -> Result<(), SessionError> {
    let meta = parse_meta(text).map_err(|source| {
        SessionError::caused_by(
            "remote Codex transcript contains invalid session metadata".to_owned(),
            source,
        )
    })?;
    let payload = meta.payload.as_ref();
    let identity = payload.and_then(|value| value.session_id.as_ref().or(value.id.as_ref()));
    if meta.kind.as_deref() != Some("session_meta")
        || identity.map(String::as_str) != Some(session_id)
    {
        return Err(SessionError::message(format!(
            "remote Codex transcript does not belong to session {session_id}"
        )));
    }
    if let Some(expected_cwd) = expected_cwd {
        let recorded = payload.and_then(|value| value.cwd.as_deref());
        if recorded != Some(expected_cwd) {
            return Err(SessionError::message(format!(
                "remote Codex transcript records cwd {}, not the shipped workspace {expected_cwd}",
                recorded.unwrap_or("(none)")
            )));
        }
    }
    Ok(())
}

fn codex_store_path(source: &Path) -> Result<Vec<String>, SessionError> {
    let mut found = false;
    let mut segments = Vec::new();
    for component in source.components() {
        match component {
            Component::Normal(value) => {
                let text = value.to_str().ok_or_else(|| {
                    SessionError::message(format!(
                        "Codex transcript path {} is not valid UTF-8",
                        source.display()
                    ))
                })?;
                if !found {
                    if text != ".codex" {
                        continue;
                    }
                    found = true;
                }
                segments.push(text.to_owned());
                if segments.len() > MAX_CODEX_STORE_SEGMENTS {
                    return Err(SessionError::message(format!(
                        "Codex transcript store path exceeds {MAX_CODEX_STORE_SEGMENTS} components"
                    )));
                }
            }
            Component::CurDir | Component::ParentDir => {
                if found {
                    return Err(SessionError::message(format!(
                        "Codex transcript path {} has an unsafe store component",
                        source.display()
                    )));
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                if found {
                    return Err(SessionError::message(format!(
                        "Codex transcript path {} has an unsafe store root",
                        source.display()
                    )));
                }
            }
        }
    }
    if !found || segments.len() < 2 {
        return Err(SessionError::message(format!(
            "Codex transcript {} is not inside a .codex store",
            source.display()
        )));
    }
    Ok(segments)
}

fn collect_rollout_files(
    root: &Path,
) -> Result<Vec<(PathBuf, std::time::SystemTime)>, SessionError> {
    let mut files = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 3_usize)];
    let mut walked = 0_usize;
    while let Some((directory, levels_remaining)) = pending.pop() {
        let metadata = match fs::metadata(&directory) {
            Ok(metadata) => metadata,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => continue,
            Err(source) => {
                return Err(SessionError::caused_by(
                    format!("cannot inspect Codex session path {}", directory.display()),
                    source,
                ));
            }
        };
        if !metadata.is_dir() {
            continue;
        }
        let entries = fs::read_dir(&directory).map_err(|source| {
            SessionError::caused_by(
                format!("cannot read Codex session path {}", directory.display()),
                source,
            )
        })?;
        for entry in entries {
            walked += 1;
            if walked > MAX_CODEX_STORE_ENTRIES {
                return Err(SessionError::message(format!(
                    "Codex session store exceeds {MAX_CODEX_STORE_ENTRIES} entries — narrow it \
                     before retrying"
                )));
            }
            let entry = entry.map_err(|source| {
                SessionError::caused_by(
                    format!("cannot scan Codex session path {}", directory.display()),
                    source,
                )
            })?;
            if levels_remaining > 0 {
                pending.push((entry.path(), levels_remaining - 1));
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|value| value.modified())
                .map_err(|source| {
                    SessionError::caused_by(
                        format!("cannot inspect Codex transcript {}", entry.path().display()),
                        source,
                    )
                })?;
            files.push((entry.path(), modified));
        }
    }
    files.sort_by_key(|file| std::cmp::Reverse(file.1));
    Ok(files)
}

impl SessionAdapter for CodexAdapter {
    fn tool(&self) -> ToolName {
        ToolName::Codex
    }

    fn binary(&self) -> &'static str {
        "codex"
    }

    fn login_argv(&self) -> &'static [&'static str] {
        &["codex", "login"]
    }

    fn remote_auth_probe(&self) -> Option<&'static str> {
        Some(r#"test -s "$HOME/.codex/auth.json""#)
    }

    fn locate<'a>(
        &'a self,
        cwd: &'a Path,
        home: &'a Path,
        session_ref: Option<&'a str>,
    ) -> SessionFuture<'a, Option<LocalSession>> {
        Box::pin(async move {
            let root = home.join(".codex").join("sessions");
            if !root.exists() {
                return Ok(None);
            }
            let cwd = path_text(cwd, "Codex workspace")?;
            for (file, modified) in collect_rollout_files(&root)?
                .into_iter()
                .take(CANDIDATE_SCAN_COUNT)
            {
                let header = read_header_line(&file)?;
                let Ok(meta) = parse_meta(&header) else {
                    continue;
                };
                let Some(payload) = meta.payload else {
                    continue;
                };
                if meta.kind.as_deref() != Some("session_meta") {
                    continue;
                }
                if payload.cwd.as_deref() != Some(cwd) {
                    continue;
                }
                let Some(id) = payload.session_id.or(payload.id) else {
                    continue;
                };
                if session_ref.is_some_and(|reference| !id.starts_with(reference)) {
                    continue;
                }
                return Ok(Some(LocalSession {
                    tool: ToolName::Codex,
                    id,
                    file,
                    store_file: None,
                    artifacts_dir: None,
                    modified,
                }));
            }
            Ok(None)
        })
    }

    fn install<'a>(
        &'a self,
        transport: &'a dyn Transport,
        session: &'a LocalSession,
        _remote_cwd: &'a str,
        options: InstallOptions<'a>,
    ) -> SessionFuture<'a, InstalledSession> {
        Box::pin(async move {
            let header = read_header_line(&session.file)?;
            assert_codex_transcript(&header, &session.id, None)?;
            let source = session.store_file.as_deref().unwrap_or(&session.file);
            let path = codex_store_path(source)?;
            let references = path.iter().map(String::as_str).collect::<Vec<_>>();
            let remote_store =
                install_guarded_home_file(transport, &session.file, &references).await?;
            let mut resume_argv = vec!["codex".to_owned(), "resume".to_owned(), session.id.clone()];
            if let Some(kickoff) = options.kickoff {
                resume_argv.push(kickoff.to_owned());
            }
            Ok(InstalledSession {
                resume_argv,
                notes: vec![
                    format!("session -> {remote_store}"),
                    "note: codex records the original cwd in session_meta; it resumes in the current \
                     directory"
                        .to_owned(),
                ],
            })
        })
    }

    fn stage_return<'a>(
        &'a self,
        transport: &'a dyn Transport,
        session: &'a LocalSession,
        local_cwd: &'a Path,
        _remote_cwd: &'a str,
        stage_dir: &'a Path,
    ) -> SessionFuture<'a, StagedReturn> {
        Box::pin(async move {
            let source = session.store_file.as_deref().unwrap_or(&session.file);
            let path = codex_store_path(source)?;
            let references = path.iter().map(String::as_str).collect::<Vec<_>>();
            let returned = collect_guarded_home_file(transport, &references).await?;
            let header = read_header_line(returned.path())?;
            let local_cwd = path_text(local_cwd, "Codex local workspace")?;
            assert_codex_transcript(&header, &session.id, Some(local_cwd))?;
            let staged = stage_dir.join("session.jsonl");
            fs::copy(returned.path(), &staged).map_err(|source| {
                SessionError::caused_by(
                    format!("cannot write staged Codex return {}", staged.display()),
                    source,
                )
            })?;
            let hint = format!(
                "manual import (codex cannot resume an isolated path): cp {} {} && codex resume {} \
                 # replaces your local copy of this session; it was left untouched",
                shq(path_text(&staged, "Codex staged return")?),
                shq(path_text(&session.file, "Codex local transcript")?),
                shq(&session.id)
            );
            Ok(StagedReturn {
                hint,
                remote_session_sha256: file_sha256(returned.path()).map_err(|source| {
                    SessionError::caused_by(
                        "cannot hash returned Codex transcript".to_owned(),
                        source,
                    )
                })?,
            })
        })
    }

    fn cleanup_remote<'a>(
        &'a self,
        transport: &'a dyn Transport,
        session: &'a LocalSession,
        _remote_cwd: &'a str,
    ) -> SessionFuture<'a, ()> {
        Box::pin(async move {
            let source = session.store_file.as_deref().unwrap_or(&session.file);
            let path = codex_store_path(source)?;
            let references = path.iter().map(String::as_str).collect::<Vec<_>>();
            cleanup_guarded_home_file(transport, &references, false).await
        })
    }
}
