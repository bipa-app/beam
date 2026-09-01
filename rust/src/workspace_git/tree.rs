use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::util::digest::{MAX_TREE_DEPTH, file_sha256};

use super::WorkspaceGitError;

#[derive(Clone, PartialEq, Eq, Serialize, Debug)]
pub struct GitTreeFingerprint {
    pub digest: String,
    pub entries: usize,
}

struct WalkFrame {
    directory: PathBuf,
    label: String,
    entries: Vec<OsString>,
    next: usize,
}

pub fn assert_no_collected_git_locks(collected_git: &Path) -> Result<(), WorkspaceGitError> {
    let mut stack = vec![WalkFrame {
        directory: collected_git.to_path_buf(),
        label: "./.git".to_owned(),
        entries: directory_entries(collected_git)?,
        next: 0,
    }];
    while !stack.is_empty() {
        let Some((path, name)) = next_entry(&mut stack) else {
            continue;
        };
        if name.ends_with(".lock") {
            return Err(WorkspaceGitError::message(format!(
                "beam down: the collected Git quarantine contains a live lock ({}) — the \
                 collection raced a remote writer; refusing before any local effect (the remote \
                 is intact). Stop the remote writer and retry beam down",
                path.display()
            )));
        }
        if fs::symlink_metadata(&path)?.file_type().is_dir() {
            push_directory(&mut stack, path, String::new())?;
        }
    }
    Ok(())
}

pub fn collected_git_tree_fingerprint(
    collected_git: &Path,
) -> Result<GitTreeFingerprint, WorkspaceGitError> {
    let mut lines = vec![b"d ./.git".to_vec()];
    let mut stack = vec![WalkFrame {
        directory: collected_git.to_path_buf(),
        label: "./.git".to_owned(),
        entries: directory_entries(collected_git)?,
        next: 0,
    }];
    while !stack.is_empty() {
        let Some((path, name)) = next_entry(&mut stack) else {
            continue;
        };
        if name.contains('\n') || name.contains('\\') {
            let directory = path.parent().unwrap_or(collected_git);
            return Err(WorkspaceGitError::message(format!(
                "beam down: collected Git metadata contains an unprovable file name under {} — \
                 refusing",
                directory.display()
            )));
        }
        let metadata = fs::symlink_metadata(&path)?;
        let parent_label = stack
            .last()
            .map(|frame| frame.label.as_str())
            .unwrap_or("./.git");
        let label = format!("{parent_label}/{name}");
        if metadata.file_type().is_dir() {
            lines.push(format!("d {label}").into_bytes());
            push_directory(&mut stack, path, label)?;
        } else if metadata.file_type().is_file() {
            lines.push(format!("f {} {label}", file_sha256(&path)?).into_bytes());
        } else {
            return Err(WorkspaceGitError::message(format!(
                "beam down: collected Git metadata contains an unsafe filesystem entry: {}",
                path.display()
            )));
        }
    }
    lines.sort();
    let mut digest = Sha256::new();
    for line in &lines {
        digest.update(line);
        digest.update(b"\n");
    }
    Ok(GitTreeFingerprint {
        digest: hex::encode(digest.finalize()),
        entries: lines.len(),
    })
}

fn next_entry(stack: &mut Vec<WalkFrame>) -> Option<(PathBuf, String)> {
    loop {
        let frame = stack.last_mut()?;
        if frame.next >= frame.entries.len() {
            stack.pop();
            continue;
        }
        let entry = frame.entries[frame.next].clone();
        frame.next += 1;
        let name = entry.to_string_lossy().into_owned();
        return Some((frame.directory.join(entry), name));
    }
}

fn push_directory(
    stack: &mut Vec<WalkFrame>,
    directory: PathBuf,
    label: String,
) -> Result<(), WorkspaceGitError> {
    if stack.len() >= MAX_TREE_DEPTH {
        return Err(WorkspaceGitError::message(format!(
            "beam down: the collected Git quarantine nests more than {MAX_TREE_DEPTH} \
             directories — refusing to walk it"
        )));
    }
    stack.push(WalkFrame {
        entries: directory_entries(&directory)?,
        directory,
        label,
        next: 0,
    });
    Ok(())
}

fn directory_entries(directory: &Path) -> Result<Vec<OsString>, WorkspaceGitError> {
    Ok(fs::read_dir(directory)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<Result<Vec<_>, _>>()?)
}
