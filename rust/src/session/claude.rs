//! Claude Code session adapter.

use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::Value;

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

const MAX_CLAUDE_STORE_ENTRIES: usize = 65_536;
const MAX_TRANSCRIPT_LINE_BYTES: usize = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_LINES: usize = 10_000_000;

pub struct ClaudeAdapter;

pub fn claude_project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|character| match character {
            '/' | '.' => '-',
            other => other,
        })
        .collect()
}

fn claude_store_path(remote_cwd: &str, session_id: &str) -> Vec<String> {
    vec![
        ".claude".to_owned(),
        "projects".to_owned(),
        claude_project_slug(remote_cwd),
        format!("{session_id}.jsonl"),
    ]
}

fn assert_claude_transcript(path: &Path, session_id: &str) -> Result<(), SessionError> {
    let source = File::open(path).map_err(|source| {
        SessionError::caused_by(
            format!("cannot open Claude transcript {}", path.display()),
            source,
        )
    })?;
    let mut reader = BufReader::new(source);
    let mut line = Vec::new();
    let mut saw_identity = false;
    let mut line_count = 0_usize;
    loop {
        line.clear();
        let mut limited = std::io::Read::take(&mut reader, (MAX_TRANSCRIPT_LINE_BYTES + 1) as u64);
        let count = limited.read_until(b'\n', &mut line).map_err(|source| {
            SessionError::caused_by(
                format!("cannot read Claude transcript {}", path.display()),
                source,
            )
        })?;
        if count == 0 {
            break;
        }
        line_count += 1;
        if line_count > MAX_TRANSCRIPT_LINES {
            return Err(SessionError::message(format!(
                "Claude transcript exceeds {MAX_TRANSCRIPT_LINES} lines — compact the session \
                 before retrying"
            )));
        }
        if count > MAX_TRANSCRIPT_LINE_BYTES {
            return Err(SessionError::message(format!(
                "Claude transcript line exceeds {MAX_TRANSCRIPT_LINE_BYTES} bytes — compact the \
                 session before retrying"
            )));
        }
        let text = std::str::from_utf8(&line).map_err(|source| {
            SessionError::caused_by(
                "remote Claude transcript is not valid UTF-8".to_owned(),
                source,
            )
        })?;
        if text.trim().is_empty() {
            continue;
        }
        let entry: Value = serde_json::from_str(text).map_err(|source| {
            SessionError::caused_by(
                "remote Claude transcript contains invalid JSONL".to_owned(),
                source,
            )
        })?;
        let Some(identity) = entry.get("sessionId") else {
            continue;
        };
        if identity.as_str() != Some(session_id) {
            return Err(SessionError::message(format!(
                "remote Claude transcript belongs to session {}, not {session_id}",
                display_json_value(identity)
            )));
        }
        saw_identity = true;
    }
    if !saw_identity {
        return Err(SessionError::message(format!(
            "remote Claude transcript does not prove session identity {session_id}"
        )));
    }
    Ok(())
}

fn display_json_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Array(_) => value.to_string(),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}
type ClaudeCandidate = (PathBuf, String, std::time::SystemTime);

fn newest_claude_session(
    directory: &Path,
    session_ref: Option<&str>,
) -> Result<Option<ClaudeCandidate>, SessionError> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(SessionError::caused_by(
                format!("cannot read Claude session store {}", directory.display()),
                source,
            ));
        }
    };
    let mut best = None;
    let mut scanned = 0_usize;
    for entry in entries {
        scanned += 1;
        if scanned > MAX_CLAUDE_STORE_ENTRIES {
            return Err(SessionError::message(format!(
                "Claude session store exceeds {MAX_CLAUDE_STORE_ENTRIES} entries — narrow it \
                 before retrying"
            )));
        }
        let entry = entry.map_err(|source| {
            SessionError::caused_by(
                format!("cannot scan Claude session store {}", directory.display()),
                source,
            )
        })?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(id) = name.strip_suffix(".jsonl") else {
            continue;
        };
        if session_ref.is_some_and(|reference| !id.starts_with(reference)) {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|value| value.modified())
            .map_err(|source| {
                SessionError::caused_by(
                    format!(
                        "cannot inspect Claude transcript {}",
                        entry.path().display()
                    ),
                    source,
                )
            })?;
        if best
            .as_ref()
            .is_none_or(|value: &ClaudeCandidate| modified > value.2)
        {
            best = Some((entry.path(), id.to_owned(), modified));
        }
    }
    Ok(best)
}

impl SessionAdapter for ClaudeAdapter {
    fn tool(&self) -> ToolName {
        ToolName::Claude
    }

    fn binary(&self) -> &'static str {
        "claude"
    }

    fn login_argv(&self) -> &'static [&'static str] {
        &["claude"]
    }

    fn remote_auth_probe(&self) -> Option<&'static str> {
        Some(r#"[ -f "$HOME/.claude/.credentials.json" ] || [ "$(uname)" = "Darwin" ]"#)
    }

    fn locate<'a>(
        &'a self,
        cwd: &'a Path,
        home: &'a Path,
        session_ref: Option<&'a str>,
    ) -> SessionFuture<'a, Option<LocalSession>> {
        Box::pin(async move {
            let cwd = path_text(cwd, "Claude workspace")?;
            let projects = home.join(".claude").join("projects");
            let primary = claude_project_slug(cwd);
            let legacy = primary.replace('_', "-");
            let slugs = if legacy == primary {
                vec![primary]
            } else {
                vec![primary, legacy]
            };
            let mut best = None;
            for slug in slugs {
                let found = newest_claude_session(&projects.join(slug), session_ref)?;
                if found.as_ref().is_some_and(|value| {
                    best.as_ref()
                        .is_none_or(|current: &ClaudeCandidate| value.2 > current.2)
                }) {
                    best = found;
                }
            }
            Ok(best.map(|(file, id, modified)| LocalSession {
                tool: ToolName::Claude,
                id,
                file,
                store_file: None,
                artifacts_dir: None,
                modified,
            }))
        })
    }

    fn install<'a>(
        &'a self,
        transport: &'a dyn Transport,
        session: &'a LocalSession,
        remote_cwd: &'a str,
        options: InstallOptions<'a>,
    ) -> SessionFuture<'a, InstalledSession> {
        Box::pin(async move {
            assert_claude_transcript(&session.file, &session.id)?;
            let path = claude_store_path(remote_cwd, &session.id);
            let references = path.iter().map(String::as_str).collect::<Vec<_>>();
            let remote_store =
                install_guarded_home_file(transport, &session.file, &references).await?;
            let mut resume_argv = vec![
                "claude".to_owned(),
                "--resume".to_owned(),
                session.id.clone(),
            ];
            if let Some(kickoff) = options.kickoff {
                resume_argv.push(kickoff.to_owned());
            }
            Ok(InstalledSession {
                resume_argv,
                notes: vec![format!("session -> {remote_store}")],
            })
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
            let path = claude_store_path(remote_cwd, &session.id);
            let references = path.iter().map(String::as_str).collect::<Vec<_>>();
            let returned = collect_guarded_home_file(transport, &references).await?;
            assert_claude_transcript(returned.path(), &session.id)?;
            let staged = stage_dir.join("session.jsonl");
            fs::copy(returned.path(), &staged).map_err(|source| {
                SessionError::caused_by(
                    format!("cannot write staged Claude return {}", staged.display()),
                    source,
                )
            })?;
            let hint = format!(
                "manual import (claude cannot resume an isolated path): cp {} {} && cd {} && \
                 claude --resume {} # replaces your local copy of this session; it was left \
                 untouched",
                shq(path_text(&staged, "Claude staged return")?),
                shq(path_text(&session.file, "Claude local transcript")?),
                shq(path_text(local_cwd, "Claude local workspace")?),
                shq(&session.id)
            );
            Ok(StagedReturn {
                hint,
                remote_session_sha256: file_sha256(returned.path()).map_err(|source| {
                    SessionError::caused_by(
                        "cannot hash returned Claude transcript".to_owned(),
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
        remote_cwd: &'a str,
    ) -> SessionFuture<'a, ()> {
        Box::pin(async move {
            let path = claude_store_path(remote_cwd, &session.id);
            let references = path.iter().map(String::as_str).collect::<Vec<_>>();
            cleanup_guarded_home_file(transport, &references, true).await
        })
    }
}

pub(crate) fn path_text<'a>(path: &'a Path, what: &str) -> Result<&'a str, SessionError> {
    path.to_str().ok_or_else(|| {
        SessionError::message(format!(
            "{what} path {} is not valid UTF-8 — Beam harness stores require UTF-8 paths",
            path.display()
        ))
    })
}
